import type { FastifyInstance } from 'fastify';
import { ok, fail } from '@easybi-studio/contracts';
import {
  readConfig,
  writeConfig,
  ConfigConflictError,
  ConfigNotFoundError,
  validateBuildConfigShape,
  RealMysqlAdapter,
  type MysqlAdapter,
  type MysqlProfileInput,
} from '@easybi-studio/config-sdk';
import { WorkspaceSkillAdapter } from '@easybi-studio/workspace-sdk';
import type { ProjectService } from '../projects/service.js';

const BUILD_CONFIG = 'config/easy-bi.json';
const RUNTIME_CONFIG = 'toolkit/config/runtime.json';

interface SaveBody {
  value?: unknown;
  expectedRevision?: string;
}

function resolveWorkspace(
  service: ProjectService,
  projectId: string,
): { workspaceRoot: string } | { error: string } {
  const project = service.get(projectId);
  if (!project) return { error: 'NOT_FOUND' };
  return { workspaceRoot: project.workspaceRoot };
}

/** Resolve the effective connection settings by applying the active environment. */
function resolveEffectiveProfile(rec: Record<string, unknown>): Record<string, unknown> {
  const envName = rec.active_environment;
  if (envName && typeof envName === 'string' && rec.environments && typeof rec.environments === 'object' && !Array.isArray(rec.environments)) {
    const envs = rec.environments as Record<string, unknown>;
    const env = envs[envName];
    if (env && typeof env === 'object' && !Array.isArray(env)) {
      const envRec = env as Record<string, unknown>;
      return {
        ...rec,
        password: envRec.password ?? rec.password,
        password_env: envRec.password_env ?? rec.password_env,
        settings: { ...(rec.settings as Record<string, unknown> ?? {}), ...(envRec.settings as Record<string, unknown> ?? {}) },
      };
    }
  }
  return rec;
}

/** Extract db profiles as adapter inputs without echoing secrets. */
function extractProfiles(value: unknown): Array<{ id: string; input: MysqlProfileInput }> {
  const out: Array<{ id: string; input: MysqlProfileInput }> = [];
  if (typeof value !== 'object' || value === null) return out;
  const conn = (value as Record<string, unknown>).connections;
  const profiles = (conn as Record<string, unknown> | undefined)?.database_profiles;
  if (!Array.isArray(profiles)) return out;
  for (const p of profiles) {
    if (typeof p !== 'object' || p === null) continue;
    const rec = resolveEffectiveProfile(p as Record<string, unknown>);
    const settings = (rec.settings as Record<string, unknown> | undefined) ?? {};
    out.push({
      id: String(rec.id ?? ''),
      input: {
        host: String(settings.host ?? ''),
        port: Number(settings.port ?? 0),
        username: String(settings.username ?? ''),
        databases: Array.isArray(settings.databases) ? (settings.databases as string[]) : [],
        ...(typeof rec.password === 'string' ? { password: rec.password } : {}),
        ...(typeof rec.password_env === 'string' ? { passwordEnv: rec.password_env } : {}),
        ...(typeof rec.connector_id === 'string' ? { engine: rec.connector_id } : {}),
      },
    });
  }
  return out;
}

export function registerConfigRoutes(
  app: FastifyInstance,
  service: ProjectService,
  injectedMysqlAdapter?: MysqlAdapter,
): void {
  // Real read-only adapter by default; tests inject a fake to avoid real connections.
  const mysql: MysqlAdapter = injectedMysqlAdapter ?? new RealMysqlAdapter();

  // Config help text (what each config section is for), sourced from the installed
  // skills' config-help.json via the manifest. Degrades to [] for older bundles.
  app.get<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/config-help',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      try {
        const adapter = new WorkspaceSkillAdapter(project.workspaceRoot);
        const docs = await adapter.readConfigHelp();
        return ok(request.requestId, { docs });
      } catch {
        return ok(request.requestId, { docs: [] });
      }
    },
  );

  async function handleGet(
    request: import('fastify').FastifyRequest<{ Params: { projectId: string } }>,
    reply: import('fastify').FastifyReply,
    relPath: string,
  ) {
    const resolved = resolveWorkspace(service, request.params.projectId);
    if ('error' in resolved) {
      return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
    }
    try {
      const cfg = await readConfig(resolved.workspaceRoot, relPath);
      return ok(request.requestId, { value: cfg.value, revision: cfg.revision });
    } catch (err) {
      if (err instanceof ConfigNotFoundError) {
        return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', err.message));
      }
      throw err;
    }
  }

  async function handlePut(
    request: import('fastify').FastifyRequest<{ Params: { projectId: string } }>,
    reply: import('fastify').FastifyReply,
    relPath: string,
  ) {
    const resolved = resolveWorkspace(service, request.params.projectId);
    if ('error' in resolved) {
      return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
    }
    const body = (request.body ?? {}) as SaveBody;
    if (body.value === undefined || typeof body.expectedRevision !== 'string') {
      return reply
        .code(400)
        .send(fail(request.requestId, 'VALIDATION_FAILED', '缺少 value 或 expectedRevision'));
    }
    try {
      const result = await writeConfig({
        workspaceRoot: resolved.workspaceRoot,
        relativePath: relPath,
        value: body.value,
        expectedRevision: body.expectedRevision,
      });
      return ok(request.requestId, { revision: result.revision, backedUp: Boolean(result.backupPath) });
    } catch (err) {
      if (err instanceof ConfigConflictError) {
        return reply.code(409).send(fail(request.requestId, 'CONFIG_CONFLICT', err.message));
      }
      if (err instanceof ConfigNotFoundError) {
        return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', err.message));
      }
      throw err;
    }
  }

  app.get<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/config/build',
    (req, reply) => handleGet(req, reply, BUILD_CONFIG),
  );
  app.put<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/config/build',
    (req, reply) => handlePut(req, reply, BUILD_CONFIG),
  );
  app.get<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/config/runtime',
    (req, reply) => handleGet(req, reply, RUNTIME_CONFIG),
  );
  app.put<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/config/runtime',
    (req, reply) => handlePut(req, reply, RUNTIME_CONFIG),
  );

  // Structural validation of the build config (no real DB).
  app.post<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/config/validate-build',
    async (request, reply) => {
      const resolved = resolveWorkspace(service, request.params.projectId);
      if ('error' in resolved) {
        return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      }
      try {
        const cfg = await readConfig(resolved.workspaceRoot, BUILD_CONFIG);
        const result = validateBuildConfigShape(cfg.value);
        return ok(request.requestId, result);
      } catch (err) {
        if (err instanceof ConfigNotFoundError) {
          return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', err.message));
        }
        throw err;
      }
    },
  );

  // Read-only MySQL connection test.
  // - With an inline `profile` in the body: test that single (possibly unsaved)
  //   form value without touching the config file.
  // - Without a body: test every database_profile currently saved in the config.
  app.post<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/config/test-mysql',
    async (request, reply) => {
      const resolved = resolveWorkspace(service, request.params.projectId);
      if ('error' in resolved) {
        return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      }
      const body = (request.body ?? {}) as { profile?: unknown };
      try {
        if (body.profile !== undefined) {
          const inline = parseInlineProfile(body.profile);
          if (!inline) {
            return reply
              .code(400)
              .send(fail(request.requestId, 'VALIDATION_FAILED', 'profile 结构无效'));
          }
          const result = await mysql.testConnection(inline.id, inline.input);
          return ok(request.requestId, { adapter: mysql.kind, results: [result] });
        }

        const cfg = await readConfig(resolved.workspaceRoot, BUILD_CONFIG);
        const profiles = extractProfiles(cfg.value);
        const results = [];
        for (const p of profiles) {
          results.push(await mysql.testConnection(p.id, p.input));
        }
        return ok(request.requestId, { adapter: mysql.kind, results });
      } catch (err) {
        if (err instanceof ConfigNotFoundError) {
          return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', err.message));
        }
        throw err;
      }
    },
  );
}

/** Parse an inline (unsaved) profile from the request body into an adapter input. */
function parseInlineProfile(
  value: unknown,
): { id: string; input: MysqlProfileInput } | null {
  if (typeof value !== 'object' || value === null) return null;
  const rec = resolveEffectiveProfile(value as Record<string, unknown>);
  const settings = (rec.settings as Record<string, unknown> | undefined) ?? rec;
  return {
    id: String(rec.id ?? ''),
    input: {
      host: String(settings.host ?? ''),
      port: Number(settings.port ?? 0),
      username: String(settings.username ?? ''),
      databases: Array.isArray(settings.databases) ? (settings.databases as string[]) : [],
      ...(typeof rec.password === 'string' ? { password: rec.password } : {}),
      ...(typeof rec.password_env === 'string' ? { passwordEnv: rec.password_env } : {}),
      ...(typeof rec.connector_id === 'string' ? { engine: rec.connector_id } : {}),
    },
  };
}
