import { createReadStream } from 'node:fs';
import { stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ok, fail, type ArtifactLevel } from '@easybi-studio/contracts';
import { computePrecheck, buildArtifact, ArtifactBuildError } from '@easybi-studio/artifact-exporter';
import type { ProjectService } from '../projects/service.js';

/** Publish center routes (plan §12.6). Only development artifacts are buildable. */
export function registerPublishRoutes(app: FastifyInstance, service: ProjectService): void {
  app.post<{ Params: { projectId: string }; Body: { level?: ArtifactLevel } }>(
    '/api/easybi/projects/:projectId/publish/plan',
    async (request, reply) => {
      const p = service.get(request.params.projectId);
      if (!p) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const level = request.body?.level ?? 'development';
      const precheck = await computePrecheck(p.workspaceRoot, level);
      return ok(request.requestId, { precheck });
    },
  );

  app.post<{
    Params: { projectId: string };
    Body: { level?: ArtifactLevel; version?: string; knowledgeVersion?: string; reportVersions?: Record<string, string> };
  }>('/api/easybi/projects/:projectId/publish/build', async (request, reply) => {
    const p = service.get(request.params.projectId);
    if (!p) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
    const body = request.body ?? {};
    const level = body.level ?? 'development';
    if (level !== 'development') {
      return reply
        .code(400)
        .send(fail(request.requestId, 'LEVEL_NOT_BUILDABLE', '第一版仅允许构建 development 制品'));
    }
    if (!body.version) {
      return reply.code(400).send(fail(request.requestId, 'VALIDATION_FAILED', '缺少 version'));
    }
    try {
      const record = await buildArtifact({
        workspaceRoot: p.workspaceRoot,
        projectId: p.id,
        level,
        version: body.version,
        now: new Date().toISOString(),
        ...(body.knowledgeVersion ? { knowledgeVersion: body.knowledgeVersion } : {}),
        ...(body.reportVersions ? { reportVersions: body.reportVersions } : {}),
      });
      return reply.code(201).send(ok(request.requestId, { artifact: record }));
    } catch (err) {
      if (err instanceof ArtifactBuildError) {
        const code = err.code === 'VERSION_EXISTS' ? 409 : 400;
        return reply.code(code).send(fail(request.requestId, err.code, err.message));
      }
      throw err;
    }
  });

  app.get<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/artifacts',
    async (request, reply) => {
      const p = service.get(request.params.projectId);
      if (!p) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const dir = join(p.workspaceRoot, 'outputs', 'artifacts');
      let files: string[] = [];
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith('.tar.gz'));
      } catch {
        files = [];
      }
      const artifacts = [];
      for (const f of files) {
        const s = await stat(join(dir, f));
        artifacts.push({ file: `outputs/artifacts/${f}`, sizeBytes: s.size });
      }
      return ok(request.requestId, { artifacts });
    },
  );

  // Download by project + filename (kept within outputs/artifacts).
  app.get<{ Params: { projectId: string; name: string } }>(
    '/api/easybi/projects/:projectId/artifacts/:name/download',
    async (request, reply) => {
      const p = service.get(request.params.projectId);
      if (!p) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const name = request.params.name;
      if (name.includes('/') || name.includes('..')) {
        return reply.code(400).send(fail(request.requestId, 'PATH_NOT_ALLOWED', '非法文件名'));
      }
      const abs = join(p.workspaceRoot, 'outputs', 'artifacts', name);
      try {
        await stat(abs);
      } catch {
        return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '制品不存在'));
      }
      reply.header('content-type', 'application/gzip');
      reply.header('content-disposition', `attachment; filename="${name}"`);
      return reply.send(createReadStream(abs));
    },
  );
}
