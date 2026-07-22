import type { FastifyInstance } from 'fastify';
import { ok, fail } from '@easybi-studio/contracts';
import { ProjectService, ProjectError } from './service.js';

interface RegisterBody {
  name?: string;
  workspaceRoot?: string;
  id?: string;
}

interface ValidateBody {
  workspaceRoot?: string;
}

function statusForCode(code: string): number {
  switch (code) {
    case 'VALIDATION_FAILED':
    case 'WORKSPACE_INVALID':
    case 'PATH_NOT_ALLOWED':
    case 'PATH_TRAVERSAL':
      return 400;
    case 'ALREADY_REGISTERED':
      return 409;
    case 'NOT_FOUND':
      return 404;
    default:
      return 500;
  }
}

export function registerProjectRoutes(app: FastifyInstance, service: ProjectService): void {
  app.get('/api/easybi/projects', async (request) => {
    return ok(request.requestId, { projects: service.list() });
  });

  app.post('/api/easybi/projects', async (request, reply) => {
    const body = (request.body ?? {}) as RegisterBody;
    if (!body.workspaceRoot) {
      return reply
        .code(400)
        .send(fail(request.requestId, 'VALIDATION_FAILED', '缺少 workspaceRoot'));
    }
    try {
      const project = await service.register({
        name: body.name ?? '',
        workspaceRoot: body.workspaceRoot,
        ...(body.id ? { id: body.id } : {}),
      });
      return reply.code(201).send(ok(request.requestId, { project }));
    } catch (err) {
      if (err instanceof ProjectError) {
        return reply
          .code(statusForCode(err.code))
          .send(fail(request.requestId, err.code, err.message));
      }
      throw err;
    }
  });

  app.get<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) {
        return reply
          .code(404)
          .send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      }
      return ok(request.requestId, { project });
    },
  );

  app.delete<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/registration',
    async (request, reply) => {
      const removed = service.removeRegistration(request.params.projectId);
      if (!removed) {
        return reply
          .code(404)
          .send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      }
      // Registration removed only; workspace files on disk are preserved.
      return ok(request.requestId, { removed: true, filesDeleted: false });
    },
  );

  app.post('/api/easybi/projects/validate-path', async (request, reply) => {
    const body = (request.body ?? {}) as ValidateBody;
    if (!body.workspaceRoot) {
      return reply
        .code(400)
        .send(fail(request.requestId, 'VALIDATION_FAILED', '缺少 workspaceRoot'));
    }
    try {
      const check = await service.validateWorkspacePath(body.workspaceRoot);
      return ok(request.requestId, { check });
    } catch (err) {
      if (err instanceof ProjectError) {
        return reply
          .code(statusForCode(err.code))
          .send(fail(request.requestId, err.code, err.message));
      }
      throw err;
    }
  });
}
