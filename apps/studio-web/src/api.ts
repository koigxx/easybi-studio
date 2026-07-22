/** Thin API client for the Studio management API (unified envelope). */

export interface Envelope<T> {
  success: boolean;
  requestId: string;
  data?: T;
  error?: { code: string; message: string };
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  if (!text) {
    // Empty body: surface a clear error instead of a raw JSON parse crash.
    throw new Error(`接口返回空响应（HTTP ${res.status}）：${url}。请确认 Studio Service 已启动并已配置 /api 代理。`);
  }

  let env: Envelope<T>;
  try {
    env = JSON.parse(text) as Envelope<T>;
  } catch {
    // Non-JSON body (e.g. an HTML page when the /api proxy is missing).
    const looksLikeHtml = text.trimStart().startsWith('<');
    throw new Error(
      looksLikeHtml
        ? `接口返回了 HTML 而非 JSON（HTTP ${res.status}）：${url}。通常是 /api 未代理到 Studio Service（请用 dev 端口 8931，或确认预览端口的代理配置）。`
        : `接口响应无法解析为 JSON（HTTP ${res.status}）：${url}`,
    );
  }

  if (!env.success) {
    throw new Error(env.error?.message ?? `请求失败（HTTP ${res.status}）：${url}`);
  }
  return env.data as T;
}

export interface Project {
  id: string;
  name: string;
  workspaceRoot: string;
  bundleVersion?: string;
}

export interface WorkflowStep {
  stage: string;
  done: boolean;
  label: string;
  blockedReason?: string;
}
export interface WorkflowState {
  current: string;
  currentLabel?: string;
  steps: WorkflowStep[];
  nextAction: string;
}

export interface DiagnosticItem {
  key: string;
  label: string;
  status: 'PASS' | 'WARNING' | 'FAIL' | 'NOT_CONFIGURED';
  message: string;
  actual?: string;
  expected?: string;
  blocking: boolean;
  suggestion?: string;
}
export interface DiagnosticRun {
  runId: string;
  items: DiagnosticItem[];
  overall: string;
}

export interface ConfigRead {
  value: unknown;
  revision: string;
}

export interface ConfigHelpSection {
  key: string;
  label: string;
  desc: string;
}
export interface ConfigHelpDoc {
  target: string; // 'build' | 'runtime'
  file: string;
  title: string;
  summary: string;
  sections: ConfigHelpSection[];
  skillId?: string;
}

export const api = {
  listProjects: () => call<{ projects: Project[] }>('GET', '/api/easybi/projects'),
  createWorkspace: (name: string, id?: string) =>
    call<{ project: Project; bootstrap: { ok: boolean; actions: Array<{ description: string }> } }>(
      'POST',
      '/api/easybi/projects/create',
      id ? { name, id } : { name },
    ),
  getWorkflow: (id: string) => call<WorkflowState>('GET', `/api/easybi/projects/${id}/workflow`),
  getConfigHelp: (id: string) =>
    call<{ docs: ConfigHelpDoc[] }>('GET', `/api/easybi/projects/${id}/config-help`),
  getBuildConfig: (id: string) =>
    call<ConfigRead>('GET', `/api/easybi/projects/${id}/config/build`),
  saveBuildConfig: (id: string, value: unknown, expectedRevision: string) =>
    call<{ revision: string }>('PUT', `/api/easybi/projects/${id}/config/build`, {
      value,
      expectedRevision,
    }),
  getRuntimeConfig: (id: string) =>
    call<ConfigRead>('GET', `/api/easybi/projects/${id}/config/runtime`),
  saveRuntimeConfig: (id: string, value: unknown, expectedRevision: string) =>
    call<{ revision: string }>('PUT', `/api/easybi/projects/${id}/config/runtime`, {
      value,
      expectedRevision,
    }),
  runDiagnostics: (id: string) =>
    call<DiagnosticRun>('POST', `/api/easybi/projects/${id}/diagnostics`),
  // Test a single (possibly unsaved) database profile without touching the config file.
  testMysql: (id: string, profile: unknown) =>
    call<MysqlTestResponse>('POST', `/api/easybi/projects/${id}/config/test-mysql`, { profile }),
};

export interface MysqlTestResult {
  profileId: string;
  reachable: boolean;
  visibleDatabases: string[];
  note: string;
  adapter: 'fake' | 'real';
}
export interface MysqlTestResponse {
  adapter: 'fake' | 'real';
  results: MysqlTestResult[];
}

// AI 交互本轮已移除（自行在 Claude Code 中运行）。将来接入 Innos AI 时，
// 在此处新增走 cloud-gateway 的调用，页面按需恢复对话 UI。

export interface KnowledgeState {
  scans: string[];
  drafts: string[];
  publishedVersions: string[];
  currentVersion: string | null;
  hotTables?: number;
  warmTables?: number;
  coldTables?: number;
  enumReviewStatus?: string;
  blockingIssues: number;
  notes: string[];
}

export interface ReportState {
  requirements: Array<{ id: string; name: string; fieldCount: number }>;
  plans: string[];
  reports: Array<{
    id: string;
    name?: string;
    version?: string;
    currentVersion?: string;
    status?: string;
    developmentOnly?: boolean;
    path?: string;
  }>;
  notes: string[];
}

export interface FileNode {
  path: string;
  name: string;
  kind: 'dir' | 'file';
  size?: number;
  textPreviewable?: boolean;
}
export interface FileTree {
  dir: string;
  entries: FileNode[];
}
export interface FileContent {
  path: string;
  size: number;
  content: string | null;
  reason?: string;
}

export type CatalogKind = 'draft' | 'version';
export type Tier = 'hot' | 'warm' | 'cold';

export interface CatalogSummary {
  kind: CatalogKind;
  id: string;
  status: string | null;
  system: { id?: string; name?: string; description?: string } | null;
  counts: { total: number; hot: number; warm: number; cold: number } | null;
  generatedAt: string | null;
  isCurrent?: boolean;
}
export interface CatalogList {
  drafts: CatalogSummary[];
  versions: CatalogSummary[];
  currentVersion: string | null;
  latestDraftId: string | null;
}
export interface TableOverview {
  tableId: string;
  profileId: string;
  database: string;
  table: string;
  tier: Tier;
  name: string | null;
  comment: string | null;
  estimatedRows: number | null;
  fieldCount: number | null;
  overrideSource: string | null;
}
export interface DatabaseGroup {
  profileId: string;
  database: string;
  tables: TableOverview[];
}
export interface CatalogOverview {
  kind: CatalogKind;
  id: string;
  status: string | null;
  system: CatalogSummary['system'];
  counts: CatalogSummary['counts'];
  databases: DatabaseGroup[];
}
export interface TableDetail {
  kind: CatalogKind;
  catalogId: string;
  tableId: string;
  tier: Tier;
  data: Record<string, unknown>;
  hasFields: boolean;
  revision?: string;
}
export interface FieldSemanticPatch {
  field: string;
  name?: string | null;
  description?: string | null;
  reportExposed?: boolean;
  filterEnabled?: boolean;
  filterRole?: string | null;
  defaultOperator?: string | null;
}
export interface TableSemanticPatch {
  name?: string | null;
  description?: string | null;
  domain?: string | null;
  fields?: FieldSemanticPatch[];
}
export interface CliResult {
  ok: boolean;
  json: unknown;
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface EnumValue {
  value: string;
  label: string;
  description?: string;
}
export interface EnumDictionary {
  name: string;
  values: EnumValue[];
  value_types?: string[];
  unknown_value_policy?: string;
  source?: string;
}
export interface EnumBinding {
  table_id: string;
  field: string;
  dictionary_name: string;
  // Enriched by the service GET for the Excel-like table (optional).
  profileId?: string;
  database?: string;
  table?: string;
  note?: string;
}
export interface EnumsDocument {
  schema_version?: string;
  dictionaries: EnumDictionary[];
  bindings: EnumBinding[];
}

export const workspaceApi = {
  getKnowledge: (id: string) => call<KnowledgeState>('GET', `/api/easybi/projects/${id}/knowledge`),
  getCatalogs: (id: string) =>
    call<CatalogList>('GET', `/api/easybi/projects/${id}/knowledge/catalogs`),
  getCatalog: (id: string, kind: CatalogKind, catalogId: string) =>
    call<CatalogOverview>(
      'GET',
      `/api/easybi/projects/${id}/knowledge/catalog?kind=${kind}&id=${encodeURIComponent(catalogId)}`,
    ),
  getCatalogTable: (id: string, kind: CatalogKind, catalogId: string, tableId: string) =>
    call<TableDetail>(
      'GET',
      `/api/easybi/projects/${id}/knowledge/catalog/table?kind=${kind}&id=${encodeURIComponent(
        catalogId,
      )}&tableId=${encodeURIComponent(tableId)}`,
    ),
  saveTableSemantics: (
    id: string,
    draftId: string,
    tableId: string,
    patch: TableSemanticPatch,
    expectedRevision: string,
  ) =>
    call<{ revision: string; backupPath: string; tier: Tier }>(
      'PUT',
      `/api/easybi/projects/${id}/knowledge/catalog/table`,
      { draftId, tableId, patch, expectedRevision },
    ),
  validateCatalog: (id: string, draftId: string) =>
    call<CliResult>('POST', `/api/easybi/projects/${id}/knowledge/validate`, { draftId }),
  promoteTable: (id: string, draftId: string, tableId: string, to: Tier, reason: string) =>
    call<CliResult>('POST', `/api/easybi/projects/${id}/knowledge/promote`, {
      draftId,
      tableId,
      to,
      reason,
    }),
  publishCatalog: (
    id: string,
    draftId: string,
    version: string,
    publishedBy: string,
    decision: string,
  ) =>
    call<CliResult>('POST', `/api/easybi/projects/${id}/knowledge/publish`, {
      draftId,
      version,
      publishedBy,
      decision,
    }),
  getEnums: (id: string, draftId: string) =>
    call<EnumsDocument>(
      'GET',
      `/api/easybi/projects/${id}/knowledge/enums?draftId=${encodeURIComponent(draftId)}`,
    ),
  initEnums: (id: string, draftId: string, limit?: number, timeoutMs?: number) =>
    call<CliResult>('POST', `/api/easybi/projects/${id}/knowledge/enums/init`, {
      draftId,
      limit,
      timeoutMs,
    }),
  saveEnums: (
    id: string,
    draftId: string,
    model: EnumsDocument,
    opts: { dryRun?: boolean; strict?: boolean } = {},
  ) =>
    call<CliResult>('PUT', `/api/easybi/projects/${id}/knowledge/enums`, {
      draftId,
      model,
      dryRun: opts.dryRun ?? false,
      strict: opts.strict ?? false,
    }),
  enumsExportUrl: (id: string, draftId: string) =>
    `/api/easybi/projects/${id}/knowledge/enums/export?draftId=${encodeURIComponent(draftId)}`,
  importEnumsExcel: (id: string, draftId: string, base64: string, dryRun: boolean) =>
    call<CliResult>('POST', `/api/easybi/projects/${id}/knowledge/enums/import`, {
      draftId,
      base64,
      dryRun,
    }),
  getReports: (id: string) => call<ReportState>('GET', `/api/easybi/projects/${id}/reports`),
  deleteReportPackage: (id: string, reportId: string, version: string) =>
    call<{ id: string; version: string; removedDir: boolean }>(
      'DELETE',
      `/api/easybi/projects/${id}/reports/package`,
      { id: reportId, version },
    ),
  // Report package editor (development-only).
  getPackageDetail: (id: string, reportId: string, version: string) =>
    call<ReportPackageDetail>(
      'GET',
      `/api/easybi/projects/${id}/reports/package/detail?id=${encodeURIComponent(reportId)}&version=${encodeURIComponent(version)}`,
    ),
  readPackageFile: (id: string, reportId: string, version: string, path: string) =>
    call<ReportPackageFileContent>(
      'GET',
      `/api/easybi/projects/${id}/reports/package/file?id=${encodeURIComponent(reportId)}&version=${encodeURIComponent(version)}&path=${encodeURIComponent(path)}`,
    ),
  writePackageFile: (id: string, reportId: string, version: string, path: string, content: string) =>
    call<{ path: string; generated: string[] }>(
      'PUT',
      `/api/easybi/projects/${id}/reports/package/file`,
      {
        id: reportId,
        version,
        path,
        content,
      },
    ),
  resealPackage: (id: string, reportId: string, version: string) =>
    call<ResealResult>('POST', `/api/easybi/projects/${id}/reports/package/reseal`, {
      id: reportId,
      version,
    }),
  listFiles: (id: string, dir = '') =>
    call<FileTree>('GET', `/api/easybi/projects/${id}/files?dir=${encodeURIComponent(dir)}`),
  readFile: (id: string, path: string) =>
    call<FileContent>('GET', `/api/easybi/projects/${id}/file?path=${encodeURIComponent(path)}`),
};

export interface ReportPackageFileEntry {
  path: string;
  editable: boolean;
  /** True for artifacts derived from another file (e.g. index.mjs from index.ts). */
  generated?: boolean;
}
export interface ReportPackageDetail {
  id: string;
  version: string;
  path: string;
  developmentOnly: boolean;
  editable: boolean;
  status: string;
  files: ReportPackageFileEntry[];
}
export interface ReportPackageFileContent {
  path: string;
  content: string;
  editable: boolean;
}
export interface ResealResult {
  resealed: boolean;
  errors: string[];
  warnings: string[];
}

export interface RuntimeInfo {
  projectId: string;
  pid: number;
  port: number;
  status: string;
}

export const runtimeApi = {
  start: (id: string) =>
    call<{ runtime: RuntimeInfo }>('POST', `/api/easybi/projects/${id}/runtime/start`),
  stop: (id: string) => call<{ stopped: boolean }>('POST', `/api/easybi/projects/${id}/runtime/stop`),
  status: (id: string) =>
    call<{ runtime: RuntimeInfo | null; logs: string[] }>(
      'GET',
      `/api/easybi/projects/${id}/runtime/status`,
    ),
  reports: (id: string) =>
    call<unknown>('GET', `/api/easybi/projects/${id}/runtime/api/v1/reports`),
  parameters: (id: string, reportId: string) =>
    call<unknown>(
      'GET',
      `/api/easybi/projects/${id}/runtime/api/v1/reports/${reportId}/parameters`,
    ),
  tests: (id: string) =>
    call<{ tests: Array<Record<string, unknown>> }>(
      'GET',
      `/api/easybi/projects/${id}/report-tests`,
    ),
  /**
   * 同步导出：直接命中 Runtime 代理。返回原始 Response —— Excel 走二进制下载，
   * JSON（HTTP 200 业务错误）由调用方解析展示。不套 call() 封装。
   */
  exportSync: (id: string, reportId: string, filters: Record<string, unknown>) =>
    fetch(`/api/easybi/projects/${id}/runtime/api/v1/exports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reportId, executionMode: 'sync', filters }),
    }),
  /**
   * 同步查询：返回中文表头 + 数据行 JSON（供测试页预览）。走 call() 封装，
   * 直接得到 { columns, rows, rowCount, truncated, ... } 数据。
   */
  query: (id: string, reportId: string, filters: Record<string, unknown>, limit?: number) =>
    call<QueryResult>('POST', `/api/easybi/projects/${id}/runtime/api/v1/queries`, {
      reportId,
      filters,
      ...(limit ? { limit } : {}),
    }),
};

export interface QueryColumn {
  id: string;
  label: string;
  description?: string;
}

export interface QueryResult {
  reportId: string;
  reportName: string;
  reportVersion: string;
  columns: QueryColumn[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  limit: number;
  queryDurationMs: number;
  totalDurationMs: number;
}

export interface ArtifactPrecheck {
  level: string;
  buildable: boolean;
  developmentOnly: boolean;
  items: Array<{ key: string; label: string; ok: boolean; detail: string }>;
  missing: string[];
}

export const publishApi = {
  plan: (id: string, level: string) =>
    call<{ precheck: ArtifactPrecheck }>('POST', `/api/easybi/projects/${id}/publish/plan`, { level }),
  build: (id: string, version: string) =>
    call<{ artifact: { file: string; sha256: string; sizeBytes: number; developmentOnly: boolean } }>(
      'POST',
      `/api/easybi/projects/${id}/publish/build`,
      { level: 'development', version },
    ),
  artifacts: (id: string) =>
    call<{ artifacts: Array<{ file: string; sizeBytes: number }> }>(
      'GET',
      `/api/easybi/projects/${id}/artifacts`,
    ),
};

// ── AI 对话（经 AgentBridge，Provider 可切：本机 Claude → Innos）──────────────
// 前端只认这些统一契约与 /api/easybi/* 端点，不认底层是 Claude 还是 Innos。
// 切换 Provider 是后端环境变量（EASYBI_AGENT_PROVIDER），前端无需改动。

export type AgentActionType =
  | 'initialize-knowledge'
  | 'continue-knowledge'
  | 'rescan-knowledge'
  | 'review-enums'
  | 'publish-knowledge'
  | 'create-report'
  | 'modify-report'
  | 'validate-report';

export type AgentTaskStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_FOR_USER'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELED';

/** Mirrors the contracts `Job` shape for type='agent' jobs. */
export interface AgentJob {
  id: string;
  projectId: string;
  type: string;
  status: AgentTaskStatus;
  agentProvider?: string;
  sessionId?: string;
  phase?: string;
  error?: string;
  checkpointId?: string;
  undoable?: boolean;
  createdAt?: string;
}

/**
 * Normalized job event delivered on the SSE stream (mirrors contracts JobEvent).
 * Pages consume only these; they never parse a provider's private protocol.
 */
export type JobEventType =
  | 'job_started'
  | 'phase_changed'
  | 'message_delta'
  | 'tool_started'
  | 'tool_finished'
  | 'waiting_for_user'
  | 'artifact_changed'
  | 'checkpoint_created'
  | 'change_summary_ready'
  | 'job_completed'
  | 'job_failed';

export interface JobEvent {
  type: JobEventType;
  jobId: string;
  at: string;
  payload?: Record<string, unknown>;
}

export interface AgentHealth {
  available: boolean;
  provider: string;
  version?: string;
  note?: string;
}

export const agentApi = {
  health: () => call<AgentHealth>('GET', '/api/easybi/agent-health'),

  /** Start an action; `prompt` is optional free text appended to the Skill template. */
  start: (projectId: string, action: AgentActionType, prompt?: string) =>
    call<{ job: AgentJob }>('POST', `/api/easybi/projects/${projectId}/agent-actions`, {
      action,
      ...(prompt ? { prompt } : {}),
    }),

  /** Resume a WAITING_FOR_USER task with the user's reply. */
  reply: (taskId: string, reply: string) =>
    call<{ accepted: boolean }>('POST', `/api/easybi/agent-tasks/${taskId}/messages`, { reply }),

  cancel: (taskId: string) =>
    call<{ canceled: boolean }>('POST', `/api/easybi/agent-tasks/${taskId}/cancel`),

  /** Stop the current turn but keep the conversation resumable. */
  interrupt: (taskId: string) =>
    call<{ interrupted: boolean }>('POST', `/api/easybi/agent-tasks/${taskId}/interrupt`),

  /** Delete a conversation from history (job + its event log). */
  delete: (taskId: string) =>
    call<{ deleted: boolean }>('DELETE', `/api/easybi/agent-tasks/${taskId}`),

  get: (taskId: string) =>
    call<{ job: AgentJob; events: JobEvent[] }>('GET', `/api/easybi/agent-tasks/${taskId}`),

  /** Reopen a past conversation (rebuilds server state so it can be continued). */
  reopen: (taskId: string) =>
    call<{ job: AgentJob; events: JobEvent[] }>('POST', `/api/easybi/agent-tasks/${taskId}/reopen`),

  list: (projectId?: string) =>
    call<{ jobs: AgentJob[] }>(
      'GET',
      `/api/easybi/agent-tasks${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),

  /**
   * SSE endpoint URL for streaming a job's events (consumed via EventSource).
   * `since` = events already rendered, so re-subscribing after a resumed turn
   * skips the prior turn's buffered events instead of replaying them.
   */
  eventsUrl: (jobId: string, since = 0) =>
    since > 0 ? `/api/easybi/jobs/${jobId}/events?since=${since}` : `/api/easybi/jobs/${jobId}/events`,
};

/** A configurable preset prompt (per workspace, initialized from skill defaults). */
export interface PromptPreset {
  action: string;
  label: string;
  hint: string;
  write: boolean;
  prompt: string;
  skillId?: string;
}

export interface PromptPresetsRead {
  presets: PromptPreset[];
  revision: string | null;
  source: 'config' | 'skill-defaults';
}

export const promptApi = {
  /** Get the workspace's preset prompts (configured, or skill defaults if none). */
  get: (projectId: string) =>
    call<PromptPresetsRead>('GET', `/api/easybi/projects/${projectId}/agent-prompts`),

  /** Save edited presets into config (revision optimistic-lock). */
  save: (projectId: string, presets: PromptPreset[], expectedRevision: string | null) =>
    call<{ presets: PromptPreset[]; revision: string }>(
      'PUT',
      `/api/easybi/projects/${projectId}/agent-prompts`,
      { presets, ...(expectedRevision ? { expectedRevision } : {}) },
    ),
};
