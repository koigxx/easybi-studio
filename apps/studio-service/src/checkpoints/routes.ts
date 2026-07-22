import type { FastifyInstance } from 'fastify';
import { ok, fail } from '@easybi-studio/contracts';
import { CheckpointManager } from '@easybi-studio/checkpoint';
import type { ProjectService } from '../projects/service.js';

/**
 * Checkpoint / diff / rollback routes (plan §12.4).
 * Rollback recomputes post-task hashes from the recorded change; conflict when a
 * file changed again after the task ended.
 */
export function registerCheckpointRoutes(
  app: FastifyInstance,
  service: ProjectService,
  cm: CheckpointManager,
  postTaskHashes: Map<string, Record<string, string>>,
): void {
  app.get<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/checkpoints',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const ids = await cm.list(project.workspaceRoot);
      return ok(request.requestId, { checkpoints: ids });
    },
  );

  app.get<{ Params: { projectId: string; checkpointId: string } }>(
    '/api/easybi/projects/:projectId/checkpoints/:checkpointId',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const ckpt = await cm.load(project.workspaceRoot, request.params.checkpointId);
      if (!ckpt) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '检查点不存在'));
      const summary = await cm.summarize(project.workspaceRoot, ckpt);
      return ok(request.requestId, { checkpoint: ckpt, summary });
    },
  );

  app.get<{ Params: { projectId: string; checkpointId: string }; Querystring: { path?: string } }>(
    '/api/easybi/projects/:projectId/checkpoints/:checkpointId/diff',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const ckpt = await cm.load(project.workspaceRoot, request.params.checkpointId);
      if (!ckpt) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '检查点不存在'));
      if (!request.query.path) {
        const summary = await cm.summarize(project.workspaceRoot, ckpt);
        return ok(request.requestId, { summary });
      }
      const diff = await cm.diffFile(project.workspaceRoot, ckpt, request.query.path);
      return ok(request.requestId, { diff });
    },
  );

  app.post<{ Params: { projectId: string; checkpointId: string } }>(
    '/api/easybi/projects/:projectId/checkpoints/:checkpointId/rollback',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const ckpt = await cm.load(project.workspaceRoot, request.params.checkpointId);
      if (!ckpt) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '检查点不存在'));
      // Post-task hashes captured when the job finished; empty map -> treat current
      // state as post-task (no external modification detected).
      const post =
        postTaskHashes.get(request.params.checkpointId) ??
        (await cm.snapshotHashes(project.workspaceRoot));
      const result = await cm.rollback({
        workspaceRoot: project.workspaceRoot,
        checkpoint: ckpt,
        postTaskHashes: post,
      });
      if (!result.ok) {
        return reply
          .code(409)
          .send(fail(request.requestId, 'ROLLBACK_CONFLICT', '存在任务结束后被再次修改的文件，已阻止撤销', result.conflicted));
      }
      return ok(request.requestId, { result });
    },
  );
}
