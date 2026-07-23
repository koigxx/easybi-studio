import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { ok, type AgentBridge } from '@easybi-studio/contracts';
import { openDatabase, type StudioDb } from './db/database.js';
import { ProjectService } from './projects/service.js';
import { registerProjectRoutes } from './projects/routes.js';
import { registerStateRoutes } from './projects/state-routes.js';
import { registerConfigRoutes } from './config/routes.js';
import type { MysqlAdapter } from '@easybi-studio/config-sdk';
import { registerJobRoutes } from './jobs/routes.js';
import { registerAgentPromptRoutes } from './agent/prompt-routes.js';
import { buildReportPhasePrompt } from './agent/prompts.js';
import { StagedReportWorkflow } from './reports/staged-workflow.js';
import { JobStore } from './jobs/store.js';
import { JobManager, type CheckpointHook } from '@easybi-studio/job-manager';
import { FakeAgentBridge, ClaudeCodeBridge, InnosAgentBridge } from '@easybi-studio/agent-bridge';
import { CheckpointManager } from '@easybi-studio/checkpoint';
import { registerCheckpointRoutes } from './checkpoints/routes.js';
import { registerWorkspaceStateRoutes } from './workspace/state-routes.js';
import { registerKnowledgeRoutes } from './knowledge/routes.js';
import { NodeSkillCliRunner, type SkillCliRunner } from './knowledge/skill-cli.js';
import { registerWatchRoutes, WatcherRegistry } from './workspace/watch-routes.js';
import { registerRuntimeRoutes } from './runtime/routes.js';
import { registerPublishRoutes } from './publish/routes.js';
import { ReportTestStore } from './report-tests/store.js';
import { RuntimeSupervisor } from '@easybi-studio/runtime-supervisor';
import { detectClaude, type ClaudeInfo } from './claude-detect.js';
import { loadConfig, type StudioConfig } from './config.js';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

export const STUDIO_SERVICE_VERSION = '0.1.0';
export const STUDIO_STAGE = 9;

export interface BuildAppOptions {
  logger?: boolean;
  dbFile?: string;
  allowedWorkspaceRoots: string[];
  db?: StudioDb;
  /** Studio config; a minimal default is derived when omitted (tests). */
  config?: Partial<StudioConfig>;
  /** Override Claude detection (tests). */
  claude?: ClaudeInfo;
  /** Inject an AgentBridge provider; defaults to FakeAgentBridge (stage 4). */
  agentBridge?: AgentBridge;
  /** Inject a MySQL adapter; defaults to the real read-only adapter (tests use fake). */
  mysqlAdapter?: MysqlAdapter;
  /** Inject a skill CLI runner; defaults to spawning node (tests inject a fake). */
  skillCliRunner?: SkillCliRunner;
}

export interface StudioApp {
  app: FastifyInstance;
  db: StudioDb;
  projects: ProjectService;
  jobs: JobManager;
}

function selectBridge(
  provider: string | undefined,
  claude: ClaudeInfo,
): FakeAgentBridge | ClaudeCodeBridge | InnosAgentBridge {
  if (provider === 'innos') return new InnosAgentBridge();
  if (provider === 'fake') return new FakeAgentBridge({ stepDelayMs: 0 });
  if (provider === 'claude') {
    if (!claude.path) {
      throw new Error(
        'EASYBI_AGENT_PROVIDER=claude 但未检测到 Claude Code CLI；请安装/登录 Claude Code 或改用 EASYBI_AGENT_PROVIDER=fake',
      );
    }
    return new ClaudeCodeBridge({ claudePath: claude.path });
  }
  // Local default: prefer real Claude when available, else offline Fake.
  if (claude.path) return new ClaudeCodeBridge({ claudePath: claude.path });
  return new FakeAgentBridge({ stepDelayMs: 0 });
}

function resolveConfig(options: BuildAppOptions): StudioConfig {
  // Base defaults (repo-relative paths, env overrides) come from loadConfig() so
  // the path-resolution logic lives in exactly one place (config.ts). Explicit
  // test/embed overrides in options.config / options.allowedWorkspaceRoots win.
  const base = loadConfig();
  const root = options.allowedWorkspaceRoots[0] ?? base.workspacesRoot;
  const dataDir = options.config?.dataDir ?? base.dataDir;
  return {
    host: options.config?.host ?? base.host,
    port: options.config?.port ?? base.port,
    workspacesRoot: options.config?.workspacesRoot ?? root,
    dataDir,
    dbFile: options.config?.dbFile ?? options.dbFile ?? join(dataDir, 'studio.db'),
    skillSourceType: options.config?.skillSourceType ?? base.skillSourceType,
    skillSourceDir: options.config?.skillSourceDir ?? base.skillSourceDir,
    ...(options.config?.skillSourceAuthTokenEnv
      ? { skillSourceAuthTokenEnv: options.config.skillSourceAuthTokenEnv }
      : {}),
  };
}

export function buildApp(options: BuildAppOptions): StudioApp {
  const app = Fastify({ logger: options.logger ?? false });
  const config = resolveConfig(options);
  const claude = options.claude ?? detectClaude();

  const db = options.db ?? openDatabase(options.dbFile ?? ':memory:');
  const projects = new ProjectService({
    db: db.raw,
    allowedWorkspaceRoots: options.allowedWorkspaceRoots,
  });

  // Job system: persist to SQLite and reconcile interrupted jobs on startup.
  const jobStore = new JobStore(db.raw);
  const stagedReportWorkflow = new StagedReportWorkflow();
  jobStore.reconcileOnStartup();

  // Provider selection (all providers share the frozen AgentBridge contract, so
  // deploying to an Agent platform later only swaps this line — pages unchanged):
  //   EASYBI_AGENT_PROVIDER=innos  -> InnosAgentBridge (reserved)
  //   EASYBI_AGENT_PROVIDER=fake   -> FakeAgentBridge (offline demo / tests)
  //   EASYBI_AGENT_PROVIDER=claude -> ClaudeCodeBridge (requires CLI)
  //   unset (local default)        -> real Claude when the CLI is detected,
  //                                   otherwise fall back to Fake.
  const provider = process.env.EASYBI_AGENT_PROVIDER;
  const bridge = options.agentBridge ?? selectBridge(provider, claude);

  // Checkpoint manager + hook: capture post-task hashes per checkpoint for rollback.
  const checkpointManager = new CheckpointManager();
  const postTaskHashes = new Map<string, Record<string, string>>();
  const checkpointHook: CheckpointHook = {
    async before({ projectId, workspaceRoot, jobId }) {
      const ckpt = await checkpointManager.create({ workspaceRoot, projectId, jobId });
      return ckpt.id;
    },
    async after({ workspaceRoot, checkpointId }) {
      postTaskHashes.set(checkpointId, await checkpointManager.snapshotHashes(workspaceRoot));
    },
  };

  const jobs = new JobManager({
    bridge,
    onJobChange: (job) => jobStore.upsert(job),
    checkpoint: checkpointHook,
    events: jobStore,
    buildReportPhasePrompt: (phase, context) => buildReportPhasePrompt(
      phase,
      context.userConfirmation,
      context.reportId,
      context.reportRevision,
      context.unitId,
      context.strategy,
    ),
    prepareInitialReport: (input) => stagedReportWorkflow.ensureCapabilities(input),
    prepareReportPhase: (input) => stagedReportWorkflow.prepare(input),
    completeReportPhase: (input) => stagedReportWorkflow.complete(input),
  });

  app.decorateRequest('requestId', '');
  app.addHook('onRequest', (request, _reply, done) => {
    request.requestId = `req_${randomUUID()}`;
    done();
  });

  app.get('/api/easybi/health', async (request) => {
    return ok(request.requestId, {
      status: 'ok',
      service: 'easybi-studio-service',
      version: STUDIO_SERVICE_VERSION,
      stage: STUDIO_STAGE,
    });
  });

  // Active AI provider health, so the front-end chat can show which provider is
  // wired (Claude locally, Innos later, or offline Fake) without knowing the
  // underlying protocol. Switching providers is env-only (EASYBI_AGENT_PROVIDER).
  app.get('/api/easybi/agent-health', async (request) => {
    return ok(request.requestId, await bridge.healthCheck());
  });

  registerProjectRoutes(app, projects);
  registerConfigRoutes(app, projects, options.mysqlAdapter);
  registerStateRoutes(app, projects, config, claude);
  registerJobRoutes(app, projects, jobs, jobStore);
  registerAgentPromptRoutes(app, projects);
  registerCheckpointRoutes(app, projects, checkpointManager, postTaskHashes);
  registerWorkspaceStateRoutes(app, projects, jobs);
  registerKnowledgeRoutes(app, projects, options.skillCliRunner ?? new NodeSkillCliRunner());

  const watchers = new WatcherRegistry();
  registerWatchRoutes(app, projects, watchers);

  const supervisor = new RuntimeSupervisor();
  const reportTests = new ReportTestStore(db.raw);
  registerRuntimeRoutes(app, projects, supervisor, reportTests);
  registerPublishRoutes(app, projects);

  app.addHook('onClose', (_instance, done) => {
    watchers.stopAll();
    supervisor.stopAll();
    if (!options.db) db.close();
    done();
  });

  return { app, db, projects, jobs };
}
