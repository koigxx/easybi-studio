import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { ok, fail, type ReportTestRecord } from '@easybi-studio/contracts';
import type { FastifyInstance } from 'fastify';
import type { RuntimeSupervisor } from '@easybi-studio/runtime-supervisor';
import type { ProjectService } from '../projects/service.js';
import type { ReportTestStore } from '../report-tests/store.js';

const EXCEL_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Runtime lifecycle + proxy + report-test records (plan §12.5, §15).
 *
 * The proxy preserves the Runtime's original response verbatim (status,
 * Content-Type, Content-Disposition, X-EasyBI-* headers, and the Excel binary
 * stream or HTTP-200 JSON error) — it never wraps the Studio envelope.
 */
export function registerRuntimeRoutes(
  app: FastifyInstance,
  service: ProjectService,
  supervisor: RuntimeSupervisor,
  tests: ReportTestStore,
): void {
  function project(id: string) {
    return service.get(id);
  }

  app.post<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/runtime/start',
    async (request, reply) => {
      const p = project(request.params.projectId);
      if (!p) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      try {
        const info = await supervisor.start(p.id, p.workspaceRoot);
        return ok(request.requestId, { runtime: info });
      } catch (err) {
        return reply
          .code(500)
          .send(fail(request.requestId, 'RUNTIME_START_FAILED', String((err as Error).message)));
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/runtime/stop',
    async (request, reply) => {
      const p = project(request.params.projectId);
      if (!p) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const stopped = supervisor.stop(p.id);
      return ok(request.requestId, { stopped });
    },
  );

  app.get<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/runtime/status',
    async (request, reply) => {
      const p = project(request.params.projectId);
      if (!p) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      return ok(request.requestId, {
        runtime: supervisor.status(p.id),
        logs: supervisor.logs(p.id).slice(-40),
      });
    },
  );

  // ---- Transparent proxy to the 3 Runtime APIs ----
  async function proxy(
    request: import('fastify').FastifyRequest<{ Params: { projectId: string } }>,
    reply: import('fastify').FastifyReply,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const p = project(request.params.projectId);
    if (!p) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
    const base = supervisor.baseUrl(p.id);
    if (!base) {
      return reply
        .code(409)
        .send(fail(request.requestId, 'RUNTIME_NOT_RUNNING', 'Runtime 未启动'));
    }
    const upstream = await fetch(`${base}${path}`, {
      method,
      ...(body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });

    // Preserve status + selected headers verbatim.
    reply.code(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) reply.header('content-type', ct);
    const cd = upstream.headers.get('content-disposition');
    if (cd) reply.header('content-disposition', cd);
    for (const [k, v] of upstream.headers.entries()) {
      if (k.toLowerCase().startsWith('x-easybi-')) reply.header(k, v);
    }

    if (ct && ct.includes(EXCEL_CT)) {
      // Stream the Excel binary without buffering the whole file.
      const nodeStream = Readable.fromWeb(upstream.body as never);
      return reply.send(nodeStream);
    }
    // JSON (including HTTP-200 business errors) — pass through verbatim.
    const text = await upstream.text();
    reply.header('content-type', ct ?? 'application/json');
    return reply.send(text);
  }

  app.get<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/runtime/api/v1/reports',
    (req, reply) => proxy(req, reply, 'GET', '/api/v1/reports'),
  );
  app.get<{ Params: { projectId: string; reportId: string } }>(
    '/api/easybi/projects/:projectId/runtime/api/v1/reports/:reportId/parameters',
    (req, reply) =>
      proxy(
        req as never,
        reply,
        'GET',
        `/api/v1/reports/${(req.params as { reportId: string }).reportId}/parameters`,
      ),
  );
  app.post<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/runtime/api/v1/exports',
    (req, reply) => proxy(req, reply, 'POST', '/api/v1/exports', req.body),
  );
  // Sync JSON data query (中文 表头 + 数据行) for the 测试页 preview.
  app.post<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/runtime/api/v1/queries',
    (req, reply) => proxy(req, reply, 'POST', '/api/v1/queries', req.body),
  );

  // ---- Report test records (Studio-side, reads generated Excel; no new Runtime API) ----
  app.get<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/report-tests',
    async (request, reply) => {
      const p = project(request.params.projectId);
      if (!p) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      return ok(request.requestId, { tests: tests.list(p.id) });
    },
  );

  app.get<{ Params: { projectId: string; testId: string } }>(
    '/api/easybi/projects/:projectId/report-tests/:testId',
    async (request, reply) => {
      const rec = tests.get(request.params.testId);
      if (!rec) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '测试记录不存在'));
      return ok(request.requestId, { test: rec });
    },
  );

  // Record a static-validation test (never a real export).
  app.post<{ Params: { projectId: string }; Body: { reportId?: string; reportVersion?: string; ok?: boolean; error?: string } }>(
    '/api/easybi/projects/:projectId/report-tests/static',
    async (request, reply) => {
      const p = project(request.params.projectId);
      if (!p) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const b = request.body ?? {};
      const rec: ReportTestRecord = {
        id: `rt_${randomUUID()}`,
        projectId: p.id,
        reportId: String(b.reportId ?? ''),
        testType: 'STATIC_VALIDATION',
        createdAt: new Date().toISOString(),
        ok: b.ok !== false,
        ...(b.reportVersion ? { reportVersion: b.reportVersion } : {}),
        ...(b.error ? { error: b.error } : {}),
      };
      tests.insert(rec);
      return reply.code(201).send(ok(request.requestId, { test: rec }));
    },
  );

  // Preview first N rows of a generated Excel output (reads the file; no DB query).
  app.get<{ Params: { projectId: string; testId: string }; Querystring: { rows?: string } }>(
    '/api/easybi/projects/:projectId/report-tests/:testId/preview',
    async (request, reply) => {
      const p = project(request.params.projectId);
      if (!p) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const rec = tests.get(request.params.testId);
      if (!rec || !rec.outputFile) {
        return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '无可预览的导出文件'));
      }
      const abs = join(p.workspaceRoot, rec.outputFile);
      try {
        await stat(abs);
      } catch {
        return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '导出文件已不存在'));
      }
      // Preview parsing is added when a real export exists; report metadata for now.
      return ok(request.requestId, {
        outputFile: rec.outputFile,
        rowCount: rec.rowCount ?? null,
        sheetCount: rec.sheetCount ?? null,
        note: '预览读取已生成的 Excel，不重复查询数据库',
      });
    },
  );
}
