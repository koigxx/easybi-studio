import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ok, fail } from '@easybi-studio/contracts';
import { computeWorkflowState, checkWorkspaceStructure } from '@easybi-studio/workspace-sdk';
import { readBundleLock } from '@easybi-studio/skill-bundle-manager';
import { createOrOpenWorkspace } from '@easybi-studio/workspace-bootstrapper';
import { SkillVersionCache } from '@easybi-studio/skill-bundle-manager';
import { runDiagnostics } from '../diagnostics/engine.js';
import { resolveSkillSource } from '../skill-source/resolve.js';
import { ProjectError } from './service.js';
import type { ProjectService } from './service.js';
import type { StudioConfig } from '../config.js';

interface CreateWorkspaceBody {
  name?: string;
  id?: string;
}

export function registerStateRoutes(
  app: FastifyInstance,
  service: ProjectService,
  config: StudioConfig,
  claude: { path?: string; version?: string },
): void {
  // Create a brand-new workspace under the allowed root: make the directory,
  // install the configured Skill bundle (source -> cache -> workspace), write
  // the lock, bootstrap init, and register the project — all in one call.
  app.post('/api/easybi/projects/create', async (request, reply) => {
    const body = (request.body ?? {}) as CreateWorkspaceBody;
    if (!body.name || !body.name.trim()) {
      return reply.code(400).send(fail(request.requestId, 'VALIDATION_FAILED', '缺少工作区名称'));
    }
    try {
      const { project, result } = await service.createWorkspace(
        { name: body.name, ...(body.id ? { id: body.id } : {}) },
        async (workspaceRoot, id) => {
          const source = resolveSkillSource(config);
          const cache = new SkillVersionCache(join(config.dataDir, 'skill-cache'));
          return createOrOpenWorkspace({
            workspaceRoot,
            source,
            cache,
            bundleId: 'easybi',
            projectId: id,
            systemId: id,
            systemName: body.name!,
          });
        },
      );
      return reply.code(201).send(ok(request.requestId, { project, bootstrap: result.bootstrap }));
    } catch (err) {
      if (err instanceof ProjectError) {
        const status =
          err.code === 'ALREADY_REGISTERED' ? 409 : err.code === 'NOT_FOUND' ? 404 : 400;
        return reply.code(status).send(fail(request.requestId, err.code, err.message));
      }
      throw err;
    }
  });

  // Guided-flow state from disk facts.
  app.get<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/workflow',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const state = await computeWorkflowState(project.workspaceRoot);
      return ok(request.requestId, state);
    },
  );

  // Read-only project state (structure + lock summary).
  app.get<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/state',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const structure = await checkWorkspaceStructure(project.workspaceRoot);
      const lock = await readBundleLock(project.workspaceRoot);
      return ok(request.requestId, { structure, lock });
    },
  );

  // Skill status: source health + installed lock.
  app.get<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/skill-status',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const source = resolveSkillSource(config);
      const [health, lock] = await Promise.all([
        source.healthCheck(),
        readBundleLock(project.workspaceRoot),
      ]);
      return ok(request.requestId, { source: health, lock });
    },
  );

  // Bootstrap (init/check auto-selected). Idempotent; safe to call on open.
  app.post<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/bootstrap',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const source = resolveSkillSource(config);
      const cache = new SkillVersionCache(join(config.dataDir, 'skill-cache'));
      const result = await createOrOpenWorkspace({
        workspaceRoot: project.workspaceRoot,
        source,
        cache,
        bundleId: 'easybi',
        projectId: project.id,
        systemId: project.id,
        systemName: project.name,
      });
      return ok(request.requestId, result);
    },
  );

  // Diagnostics (whole environment; optional project scope).
  app.post<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/diagnostics',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const run = await runDiagnostics({
        skillSourceDir: config.skillSourceDir,
        cacheRoot: join(config.dataDir, 'skill-cache'),
        workspaceRoot: project.workspaceRoot,
        ...(claude.path ? { claudePath: claude.path } : {}),
        ...(claude.version ? { claudeVersion: claude.version } : {}),
      });
      return ok(request.requestId, run);
    },
  );

  // Global diagnostics without a project.
  app.post('/api/easybi/diagnostics', async (request) => {
    const run = await runDiagnostics({
      skillSourceDir: config.skillSourceDir,
      cacheRoot: join(config.dataDir, 'skill-cache'),
      ...(claude.path ? { claudePath: claude.path } : {}),
      ...(claude.version ? { claudeVersion: claude.version } : {}),
    });
    return ok(request.requestId, run);
  });
}
