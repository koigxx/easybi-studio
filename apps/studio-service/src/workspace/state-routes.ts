import type { FastifyInstance } from 'fastify';
import { ok, fail } from '@easybi-studio/contracts';
import {
  readKnowledgeState,
  readReportState,
  listWorkspaceDir,
  readWorkspaceFile,
  listCatalogs,
  readCatalogOverview,
  readTableDetail,
  writeTableSemantics,
  deleteReportPackage,
  readReportPackageDetail,
  readReportPackageFile,
  writeReportPackageFile,
  resealReportPackage,
  readReportModel,
  writeReportModel,
  readAvailableFields,
  WorkspaceSkillAdapter,
  CatalogConflictError,
  CatalogNotFoundError,
  ReportPackageError,
  ReportModelError,
  PathNotAllowedError,
  PathTraversalError,
  type CatalogKind,
  type TableSemanticPatch,
} from '@easybi-studio/workspace-sdk';

const REPORT_SKILL_ID = 'create-report-package';

function reportPackageErrorStatus(code: ReportPackageError['code']): number {
  return code === 'NOT_FOUND' ? 404 : code === 'PROTECTED' ? 409 : 400;
}
import type { ProjectService } from '../projects/service.js';
import type { JobManager } from '@easybi-studio/job-manager';

/** Knowledge & report status routes backed by disk facts (plan §10.3, §10.4). */
export function registerWorkspaceStateRoutes(
  app: FastifyInstance,
  service: ProjectService,
  jobs?: JobManager,
): void {
  app.get<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/knowledge',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const state = await readKnowledgeState(project.workspaceRoot);
      return ok(request.requestId, state);
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: { reportId?: string } }>(
    '/api/easybi/projects/:projectId/reports/model',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      if (!request.query.reportId) {
        return reply.code(400).send(fail(request.requestId, 'VALIDATION_FAILED', '缺少 reportId'));
      }
      try {
        return ok(request.requestId, await readReportModel(project.workspaceRoot, request.query.reportId));
      } catch (err) {
        if (err instanceof ReportModelError) {
          return reply
            .code(err.code === 'NOT_FOUND' ? 404 : err.code === 'CONFLICT' ? 409 : 400)
            .send(fail(request.requestId, `REPORT_MODEL_${err.code}`, err.message));
        }
        throw err;
      }
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { reportId?: string; sourceId?: string };
  }>(
    '/api/easybi/projects/:projectId/reports/model/fields',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      if (!request.query.reportId || !request.query.sourceId) {
        return reply.code(400).send(fail(request.requestId, 'VALIDATION_FAILED', '缺少 reportId / sourceId'));
      }
      try {
        return ok(
          request.requestId,
          await readAvailableFields(
            project.workspaceRoot,
            request.query.reportId,
            request.query.sourceId,
          ),
        );
      } catch (err) {
        if (err instanceof ReportModelError) {
          return reply
            .code(err.code === 'NOT_FOUND' ? 404 : 400)
            .send(fail(request.requestId, `REPORT_MODEL_${err.code}`, err.message));
        }
        throw err;
      }
    },
  );

  app.put<{
    Params: { projectId: string };
    Body: {
      reportId?: string;
      expectedRevision?: string;
      reviewedBy?: string;
      sources?: Array<{ id: string; fields: Array<{ name: string; role?: string }> }>;
      relationships?: Array<{
        from: string;
        to: string;
        type: string;
        cardinality: string;
        grain?: string | null;
        fanoutRisk?: boolean;
      }>;
      calculationGraph?: {
        version: '1';
        nodes: Array<{
          id: string;
          label: string;
          kind: 'aggregate' | 'formula' | 'comparison' | 'window' | 'merge';
          outputType: string;
          dependencies: string[];
          expression: string;
          sourceField: string;
          aggregation: string;
          condition: string;
          comparisonMode: string;
          comparisonOffset: number;
          windowFunction: string;
          partitionBy: string[];
          orderBy: string[];
          frame: string;
          mergeOperation: string;
          joinKeys: string[];
          executionHint: 'auto' | 'sql' | 'script';
          output: boolean;
          description: string;
        }>;
      };
      metricEdits?: Array<{
        id: string;
        sourceField?: string;
        sourceAlias?: string;
        dedupKey?: string;
      }>;
      filterEdits?: Array<{
        id: string;
        delete?: boolean;
        label?: string;
        valueType?: string;
        operators?: string[];
        defaultOperator?: string;
        required?: boolean;
        expression?: string;
        clause?: string;
        valueAdapter?: string;
        component?: string;
      }>;
    };
  }>('/api/easybi/projects/:projectId/reports/model', async (request, reply) => {
    const project = service.get(request.params.projectId);
    if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
    const active = jobs?.activeWriteJob(project.workspaceRoot);
    if (active) {
      return reply
        .code(409)
        .send(fail(request.requestId, 'WRITE_TASK_CONFLICT', `当前模型正在被任务 ${active.id} 使用，请等待任务结束后再编辑`));
    }
    const body = request.body ?? {};
    if (
      !body.reportId ||
      typeof body.expectedRevision !== 'string' ||
      !Array.isArray(body.sources) ||
      !Array.isArray(body.relationships)
    ) {
      return reply
        .code(400)
        .send(fail(request.requestId, 'VALIDATION_FAILED', '缺少 reportId / expectedRevision / sources / relationships'));
    }
    try {
      const reviewerHeader = request.headers['x-easybi-user'];
      const reviewedBy =
        body.reviewedBy?.trim() ||
        (Array.isArray(reviewerHeader) ? reviewerHeader[0] : reviewerHeader)?.trim() ||
        'studio-user';
      return ok(
        request.requestId,
        await writeReportModel(project.workspaceRoot, body.reportId, {
          expectedRevision: body.expectedRevision,
          reviewedBy,
          sources: body.sources,
          relationships: body.relationships,
          calculationGraph: body.calculationGraph,
          metricEdits: body.metricEdits,
          filterEdits: body.filterEdits,
        }),
      );
    } catch (err) {
      if (err instanceof ReportModelError) {
        return reply
          .code(err.code === 'NOT_FOUND' ? 404 : err.code === 'CONFLICT' ? 409 : 400)
          .send(fail(request.requestId, `REPORT_MODEL_${err.code}`, err.message));
      }
      throw err;
    }
  });

  app.get<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/reports',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const state = await readReportState(project.workspaceRoot);
      return ok(request.requestId, state);
    },
  );

  // Delete a development-only report package (dir + deregister). Published /
  // production packages are protected and rejected.
  app.delete<{ Params: { projectId: string }; Body: { id?: string; version?: string } }>(
    '/api/easybi/projects/:projectId/reports/package',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const { id, version } = request.body ?? {};
      if (!id || !version) {
        return reply.code(400).send(fail(request.requestId, 'VALIDATION_FAILED', '缺少 id 或 version'));
      }
      try {
        const result = await deleteReportPackage(project.workspaceRoot, id, version);
        return ok(request.requestId, result);
      } catch (err) {
        if (err instanceof ReportPackageError) {
          const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'PROTECTED' ? 409 : 400;
          return reply.code(status).send(fail(request.requestId, err.code, err.message));
        }
        if (err instanceof PathTraversalError || err instanceof PathNotAllowedError) {
          return reply.code(400).send(fail(request.requestId, 'PATH_NOT_ALLOWED', err.message));
        }
        throw err;
      }
    },
  );

  // Report package editor: file listing + manifest facts.
  app.get<{ Params: { projectId: string }; Querystring: { id?: string; version?: string } }>(
    '/api/easybi/projects/:projectId/reports/package/detail',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const { id, version } = request.query;
      if (!id || !version) {
        return reply.code(400).send(fail(request.requestId, 'VALIDATION_FAILED', '缺少 id 或 version'));
      }
      try {
        const detail = await readReportPackageDetail(project.workspaceRoot, id, version);
        return ok(request.requestId, detail);
      } catch (err) {
        if (err instanceof ReportPackageError) {
          return reply.code(reportPackageErrorStatus(err.code)).send(fail(request.requestId, err.code, err.message));
        }
        throw err;
      }
    },
  );

  // Read one package file's text content.
  app.get<{ Params: { projectId: string }; Querystring: { id?: string; version?: string; path?: string } }>(
    '/api/easybi/projects/:projectId/reports/package/file',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const { id, version, path } = request.query;
      if (!id || !version || !path) {
        return reply.code(400).send(fail(request.requestId, 'VALIDATION_FAILED', '缺少 id/version/path'));
      }
      try {
        const file = await readReportPackageFile(project.workspaceRoot, id, version, path);
        return ok(request.requestId, file);
      } catch (err) {
        if (err instanceof ReportPackageError) {
          return reply.code(reportPackageErrorStatus(err.code)).send(fail(request.requestId, err.code, err.message));
        }
        throw err;
      }
    },
  );

  // Write one package file (development-only, whitelisted). Does not reseal.
  app.put<{
    Params: { projectId: string };
    Body: { id?: string; version?: string; path?: string; content?: string };
  }>(
    '/api/easybi/projects/:projectId/reports/package/file',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const { id, version, path, content } = request.body ?? {};
      if (!id || !version || !path || typeof content !== 'string') {
        return reply.code(400).send(fail(request.requestId, 'VALIDATION_FAILED', '缺少 id/version/path/content'));
      }
      try {
        const result = await writeReportPackageFile(project.workspaceRoot, id, version, path, content);
        return ok(request.requestId, result);
      } catch (err) {
        if (err instanceof ReportPackageError) {
          return reply.code(reportPackageErrorStatus(err.code)).send(fail(request.requestId, err.code, err.message));
        }
        if (err instanceof PathTraversalError || err instanceof PathNotAllowedError) {
          return reply.code(400).send(fail(request.requestId, 'PATH_NOT_ALLOWED', err.message));
        }
        throw err;
      }
    },
  );

  // Reseal a development package after edits: recompute checksums + re-validate.
  app.post<{ Params: { projectId: string }; Body: { id?: string; version?: string } }>(
    '/api/easybi/projects/:projectId/reports/package/reseal',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const { id, version } = request.body ?? {};
      if (!id || !version) {
        return reply.code(400).send(fail(request.requestId, 'VALIDATION_FAILED', '缺少 id 或 version'));
      }
      try {
        // Resolve the report CLI via the manifest — never hardcode the deep path.
        const adapter = new WorkspaceSkillAdapter(project.workspaceRoot);
        const cliPath = await adapter.resolveCommand(REPORT_SKILL_ID, 'package_cli');
        const result = await resealReportPackage(project.workspaceRoot, id, version, cliPath);
        return ok(request.requestId, result);
      } catch (err) {
        if (err instanceof ReportPackageError) {
          return reply.code(reportPackageErrorStatus(err.code)).send(fail(request.requestId, err.code, err.message));
        }
        throw err;
      }
    },
  );

  // Knowledge catalogs: draft/version list with counts & status.
  app.get<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/knowledge/catalogs',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const list = await listCatalogs(project.workspaceRoot);
      return ok(request.requestId, list);
    },
  );

  // Knowledge catalog overview (grouped by database/tier, no field detail).
  app.get<{ Params: { projectId: string }; Querystring: { kind?: string; id?: string } }>(
    '/api/easybi/projects/:projectId/knowledge/catalog',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const kind = request.query.kind;
      const id = request.query.id;
      if ((kind !== 'draft' && kind !== 'version') || !id) {
        return reply
          .code(400)
          .send(fail(request.requestId, 'VALIDATION_FAILED', '缺少或非法的 kind/id'));
      }
      const overview = await readCatalogOverview(project.workspaceRoot, kind as CatalogKind, id);
      if (!overview) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '目录不存在'));
      return ok(request.requestId, overview);
    },
  );

  // Knowledge single-table detail (full JSON; cold tables have no fields).
  app.get<{
    Params: { projectId: string };
    Querystring: { kind?: string; id?: string; tableId?: string };
  }>('/api/easybi/projects/:projectId/knowledge/catalog/table', async (request, reply) => {
    const project = service.get(request.params.projectId);
    if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
    const { kind, id, tableId } = request.query;
    if ((kind !== 'draft' && kind !== 'version') || !id || !tableId) {
      return reply
        .code(400)
        .send(fail(request.requestId, 'VALIDATION_FAILED', '缺少或非法的 kind/id/tableId'));
    }
    const detail = await readTableDetail(project.workspaceRoot, kind as CatalogKind, id, tableId);
    if (!detail) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '表不存在'));
    return ok(request.requestId, detail);
  });

  // Write semantic edits to a DRAFT table (tier/publish go through the skill CLI).
  app.put<{
    Params: { projectId: string };
    Body: { draftId?: string; tableId?: string; patch?: TableSemanticPatch; expectedRevision?: string };
  }>('/api/easybi/projects/:projectId/knowledge/catalog/table', async (request, reply) => {
    const project = service.get(request.params.projectId);
    if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
    const body = request.body ?? {};
    if (!body.draftId || !body.tableId || !body.patch || typeof body.expectedRevision !== 'string') {
      return reply
        .code(400)
        .send(
          fail(request.requestId, 'VALIDATION_FAILED', '缺少 draftId / tableId / patch / expectedRevision'),
        );
    }
    try {
      const result = await writeTableSemantics({
        workspaceRoot: project.workspaceRoot,
        draftId: body.draftId,
        tableId: body.tableId,
        patch: body.patch,
        expectedRevision: body.expectedRevision,
      });
      return ok(request.requestId, result);
    } catch (err) {
      if (err instanceof CatalogConflictError) {
        return reply.code(409).send(fail(request.requestId, 'CATALOG_CONFLICT', err.message));
      }
      if (err instanceof CatalogNotFoundError) {
        return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', err.message));
      }
      throw err;
    }
  });

  // Read-only workspace file tree (one level). ?dir= workspace-relative dir.
  app.get<{ Params: { projectId: string }; Querystring: { dir?: string } }>(
    '/api/easybi/projects/:projectId/files',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      try {
        const tree = await listWorkspaceDir(project.workspaceRoot, request.query.dir ?? '');
        return ok(request.requestId, tree);
      } catch (err) {
        if (err instanceof PathTraversalError || err instanceof PathNotAllowedError) {
          return reply.code(400).send(fail(request.requestId, 'PATH_NOT_ALLOWED', err.message));
        }
        throw err;
      }
    },
  );

  // Read-only single file content (text only; binary/large returns null body).
  app.get<{ Params: { projectId: string }; Querystring: { path?: string } }>(
    '/api/easybi/projects/:projectId/file',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      if (!request.query.path) {
        return reply.code(400).send(fail(request.requestId, 'VALIDATION_FAILED', '缺少 path'));
      }
      try {
        const file = await readWorkspaceFile(project.workspaceRoot, request.query.path);
        return ok(request.requestId, file);
      } catch (err) {
        if (err instanceof PathTraversalError || err instanceof PathNotAllowedError) {
          return reply.code(400).send(fail(request.requestId, 'PATH_NOT_ALLOWED', err.message));
        }
        return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '文件不存在'));
      }
    },
  );
}
