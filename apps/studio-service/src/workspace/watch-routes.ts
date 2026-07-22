import type { FastifyInstance } from 'fastify';
import { fail } from '@easybi-studio/contracts';
import type { ProjectService } from '../projects/service.js';
import { WorkspaceWatcher } from './watcher.js';

/**
 * Per-project workspace watchers + an SSE stream of debounced change events.
 * The UI uses these only to trigger a re-fetch of computed state (plan §16).
 */
export class WatcherRegistry {
  private watchers = new Map<string, WorkspaceWatcher>();

  get(projectId: string, workspaceRoot: string): WorkspaceWatcher {
    let w = this.watchers.get(projectId);
    if (!w) {
      w = new WorkspaceWatcher(workspaceRoot);
      w.start();
      this.watchers.set(projectId, w);
    }
    return w;
  }

  stopAll(): void {
    for (const w of this.watchers.values()) w.stop();
    this.watchers.clear();
  }
}

export function registerWatchRoutes(
  app: FastifyInstance,
  service: ProjectService,
  registry: WatcherRegistry,
): void {
  app.get<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/watch',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) {
        return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      }
      const watcher = registry.get(project.id, project.workspaceRoot);
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      reply.raw.write(`event: ready\ndata: {}\n\n`);

      const listener = (payload: { path: string }): void => {
        reply.raw.write(`event: changed\n`);
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      watcher.on('changed', listener);
      request.raw.on('close', () => {
        watcher.off('changed', listener);
      });
      // Keep the response open; Fastify won't resolve until the socket closes.
      await new Promise<void>((resolve) => {
        request.raw.on('close', resolve);
      });
      return reply;
    },
  );
}
