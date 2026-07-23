import type { FastifyInstance } from 'fastify';
import { ok, fail, type AgentActionType } from '@easybi-studio/contracts';
import { JobManager, WriteTaskConflictError, JobActiveError } from '@easybi-studio/job-manager';
import type { ProjectService } from '../projects/service.js';
import type { JobStore } from './store.js';
import { buildActionPrompt } from '../agent/prompts.js';

interface AgentActionBody {
  action?: AgentActionType;
  prompt?: string;
  reportId?: string;
}

interface ReplyBody {
  reply?: string;
  intent?: 'chat' | 'confirm_model' | 'confirm_discovery' | 'approve_model';
  modelRevision?: string;
  modelHash?: string;
  confirmation?: Record<string, unknown>;
}

export function registerJobRoutes(
  app: FastifyInstance,
  service: ProjectService,
  jobs: JobManager,
  store: JobStore,
): void {
  // Start an agent action for a project.
  app.post<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/agent-actions',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const body = (request.body ?? {}) as AgentActionBody;
      if (!body.action) {
        return reply.code(400).send(fail(request.requestId, 'VALIDATION_FAILED', '缺少 action'));
      }
      if (body.action === 'free-chat' && !body.prompt?.trim()) {
        return reply.code(400).send(fail(request.requestId, 'VALIDATION_FAILED', '自由对话需要输入内容'));
      }
      if (
        (
          body.action === 'model-report' ||
          body.action === 'build-report-package' ||
          body.action === 'create-report' ||
          body.action === 'modify-report'
        ) &&
        !body.reportId?.trim()
      ) {
        return reply.code(400).send(fail(request.requestId, 'VALIDATION_FAILED', '分阶段报表任务缺少 reportId'));
      }
      try {
        // For free-chat the prompt is the user's verbatim message; for a preset
        // action it is the (possibly workspace-customized) full prompt that
        // replaces the built-in template.
        const promptText =
          body.action === 'free-chat'
            ? buildActionPrompt(body.action, { extra: body.prompt })
            : buildActionPrompt(body.action, { fullPrompt: body.prompt });
        const job = await jobs.startAgentJob({
          projectId: project.id,
          workspaceRoot: project.workspaceRoot,
          action: body.action,
          prompt: promptText,
          ...(body.reportId?.trim() ? { reportId: body.reportId.trim() } : {}),
        });
        return reply.code(201).send(ok(request.requestId, { job }));
      } catch (err) {
        if (err instanceof WriteTaskConflictError) {
          return reply.code(409).send(fail(request.requestId, err.code, err.message));
        }
        if (
          body.action === 'model-report' ||
          body.action === 'build-report-package' ||
          body.action === 'create-report' ||
          body.action === 'modify-report'
        ) {
          return reply.code(400).send(fail(request.requestId, 'REPORT_WORKFLOW_UNAVAILABLE', String((err as Error).message)));
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { taskId: string } }>(
    '/api/easybi/agent-tasks/:taskId',
    async (request, reply) => {
      const job = jobs.getJob(request.params.taskId);
      if (!job) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '任务不存在'));
      return ok(request.requestId, { job, events: jobs.getEvents(job.id), runs: store.listRuns(job.id) });
    },
  );

  // Reopen a past conversation (e.g. after a Studio restart) so it can be viewed
  // and continued. Rebuilds in-memory state from the persisted event log, using
  // the owning project's workspace root so a follow-up reply can --resume it.
  app.post<{ Params: { taskId: string } }>(
    '/api/easybi/agent-tasks/:taskId/reopen',
    async (request, reply) => {
      const persisted = jobs.getJob(request.params.taskId);
      if (!persisted) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '任务不存在'));
      const project = service.get(persisted.projectId);
      if (!project) {
        return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '任务所属项目不存在'));
      }
      const job = jobs.reopenJob(request.params.taskId, project.workspaceRoot);
      if (!job) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '任务不存在'));
      return ok(request.requestId, { job, events: jobs.getEvents(job.id), runs: store.listRuns(job.id) });
    },
  );

  app.post<{ Params: { taskId: string } }>(
    '/api/easybi/agent-tasks/:taskId/messages',
    async (request, reply) => {
      const body = (request.body ?? {}) as ReplyBody;
      if (typeof body.reply !== 'string') {
        return reply.code(400).send(fail(request.requestId, 'VALIDATION_FAILED', '缺少 reply'));
      }
      // If the job isn't in memory (Studio restarted since it ran), reopen it
      // from the persisted log first so the reply can resume the session.
      if (!jobs.getJob(request.params.taskId)) {
        return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '任务不存在'));
      }
      const persisted = jobs.getJob(request.params.taskId)!;
      const project = service.get(persisted.projectId);
      if (project) jobs.reopenJob(request.params.taskId, project.workspaceRoot);
      try {
        if (body.intent === 'confirm_model' || body.intent === 'confirm_discovery') {
          const reviewerHeader = request.headers['x-easybi-user'];
          const reviewedBy =
            (Array.isArray(reviewerHeader) ? reviewerHeader[0] : reviewerHeader)?.trim() ||
            'local-user';
          const run = await jobs.startFreshPhase({
            jobId: request.params.taskId,
            phase: 'MODELING',
            userMessage: body.reply,
            reviewedBy,
            ...(body.confirmation ? { modelConfirmation: body.confirmation } : {}),
            ...(body.modelRevision ? { modelRevision: body.modelRevision } : {}),
            ...(body.modelHash ? { modelHash: body.modelHash } : {}),
          });
          return ok(request.requestId, { accepted: true, run });
        }
        if (body.intent === 'approve_model') {
          const reviewerHeader = request.headers['x-easybi-user'];
          const reviewedBy = (Array.isArray(reviewerHeader) ? reviewerHeader[0] : reviewerHeader)?.trim() || 'local-user';
          const run = await jobs.startFreshPhase({
            jobId: request.params.taskId,
            phase: 'QUERY_COMPILATION',
            userMessage: body.reply,
            reviewedBy,
            ...(body.modelRevision ? { modelRevision: body.modelRevision } : {}),
            ...(body.modelHash ? { modelHash: body.modelHash } : {}),
          });
          return ok(request.requestId, { accepted: true, run });
        }
        await jobs.replyToJob(request.params.taskId, body.reply);
        return ok(request.requestId, { accepted: true });
      } catch (err) {
        return reply.code(400).send(fail(request.requestId, 'VALIDATION_FAILED', String((err as Error).message)));
      }
    },
  );

  app.post<{ Params: { taskId: string } }>(
    '/api/easybi/agent-tasks/:taskId/cancel',
    async (request, reply) => {
      try {
        await jobs.cancelJob(request.params.taskId);
        return ok(request.requestId, { canceled: true });
      } catch (err) {
        return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', String((err as Error).message)));
      }
    },
  );

  // Interrupt the CURRENT turn without ending the conversation: the turn stops
  // and the job settles to SUCCEEDED (resumable) so the user can keep chatting.
  app.post<{ Params: { taskId: string } }>(
    '/api/easybi/agent-tasks/:taskId/interrupt',
    async (request, reply) => {
      try {
        await jobs.interruptJob(request.params.taskId);
        return ok(request.requestId, { interrupted: true });
      } catch (err) {
        return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', String((err as Error).message)));
      }
    },
  );

  // Delete a conversation from history (job + its persisted event log). Refuses
  // an active job with 409; returns 404 if unknown.
  app.delete<{ Params: { taskId: string } }>(
    '/api/easybi/agent-tasks/:taskId',
    async (request, reply) => {
      try {
        const deleted = jobs.deleteJob(request.params.taskId);
        if (!deleted) {
          return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '任务不存在'));
        }
        return ok(request.requestId, { deleted: true });
      } catch (err) {
        if (err instanceof JobActiveError) {
          return reply.code(409).send(fail(request.requestId, err.code, err.message));
        }
        throw err;
      }
    },
  );

  // Task history (from SQLite so it survives restart).
  app.get<{ Querystring: { projectId?: string } }>(
    '/api/easybi/agent-tasks',
    async (request) => {
      return ok(request.requestId, { jobs: store.list(request.query.projectId) });
    },
  );

  // SSE event stream for a job (plan §12.7).
  app.get<{ Params: { jobId: string }; Querystring: { since?: string } }>(
    '/api/easybi/jobs/:jobId/events',
    async (request, reply) => {
      const job = jobs.getJob(request.params.jobId);
      if (!job) {
        return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '任务不存在'));
      }
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // `since` = number of events the client has already rendered, so a re-subscribe
      // after a resumed turn skips the prior turn's buffered events (incl. its
      // job_completed) and only streams the new turn.
      const sinceRaw = Number(request.query.since);
      const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
      const iter = jobs.subscribe(job.id, since);
      request.raw.on('close', () => {
        // consumer closed; iterator will be GC'd after stream ends
      });
      for await (const event of iter) {
        reply.raw.write(`event: ${event.type}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      reply.raw.end();
      return reply;
    },
  );
}
