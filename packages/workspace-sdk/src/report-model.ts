import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { WorkspaceSkillAdapter } from './skill-adapter.js';
import { normalizeAbsolute, resolveWithinWorkspace } from './paths.js';

// Workspace artifacts are intentionally schema-flexible at this adapter boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;

const REPORT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const KNOWN_RELATION_TYPES = ['inner', 'left'] as const;
const RELATION_TYPES = new Set<string>(KNOWN_RELATION_TYPES);
const RELATION_ALIASES: Record<string, string> = {
  inner_join: 'inner',
  left_join: 'left',
};

function normalizeRelationType(value: string): string {
  const key = value.trim().toLowerCase();
  return RELATION_ALIASES[key] ?? key;
}
const KNOWN_CARDINALITIES = ['1:1', '1:n', 'n:1', 'n:n', 'unknown'] as const;
const CARDINALITIES = new Set<string>(KNOWN_CARDINALITIES);
const CALCULATION_KINDS = new Set(['aggregate', 'formula', 'comparison', 'window', 'merge']);
const CALCULATION_EXECUTION_HINTS = new Set(['auto', 'sql', 'script']);
const CALCULATION_AGGREGATIONS = new Set([
  'sum',
  'count',
  'count_distinct',
  'avg',
  'min',
  'max',
  'first',
  'last',
]);
const CALCULATION_WINDOWS = new Set([
  'row_number',
  'rank',
  'dense_rank',
  'running_sum',
  'moving_avg',
  'lag',
  'lead',
]);
const CALCULATION_COMPARISONS = new Set(['difference', 'rate', 'chain', 'yoy']);
const CALCULATION_MERGES = new Set(['add', 'subtract', 'multiply', 'divide', 'coalesce']);

function normalizeCardinality(value: string): string {
  return value.trim().toLowerCase();
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function modelHash(model: JsonRecord): string {
  const copy = structuredClone(model);
  delete copy.approval;
  delete copy.generated_at;
  return sha256(JSON.stringify(copy));
}

async function readJson(path: string): Promise<JsonRecord> {
  return JSON.parse(await readFile(path, 'utf8')) as JsonRecord;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listFiles(root, path)));
    } else if (
      entry.isFile() &&
      entry.name !== 'checksums.sha256' &&
      entry.name !== 'signature.ed25519'
    ) {
      result.push(relative(root, path).split('\\').join('/'));
    }
  }
  return result.sort();
}

async function resealChecksums(root: string): Promise<void> {
  const lines: string[] = [];
  for (const file of await listFiles(root)) {
    lines.push(`${sha256(await readFile(join(root, file)))}  ${file}`);
  }
  await writeFile(join(root, 'checksums.sha256'), `${lines.join('\n')}\n`, 'utf8');
}

function sourceKey(value: JsonRecord): string {
  return `${value.profile_id}/${value.database}/${value.table}`;
}

function fieldName(value: unknown): string {
  return typeof value === 'string' ? value : String((value as JsonRecord | null)?.name ?? '');
}

function physicalFieldName(value: JsonRecord): string {
  return String(value.physical?.name ?? value.name ?? '');
}

function physicalFieldLabel(value: JsonRecord): string {
  return String(
    value.semantic?.name ??
      value.semantic?.label ??
      value.physical?.comment ??
      value.physical?.name ??
      value.name ??
      '',
  );
}

function normalizeFilterComponent(value: unknown, valueType: string, defaultOperator: string): string {
  const component = String(value ?? '').trim();
  if (component === 'text') return defaultOperator === 'eq' ? 'text-exact' : 'text-contains';
  if (component === 'date_range_picker') return valueType === 'date_range' ? 'date-range-day' : 'datetime-range';
  return component || (valueType === 'string' ? 'text-contains' : 'datetime-range');
}

function readRule(value: JsonRecord): ReportModelRule {
  return {
    field: String(value.field ?? ''),
    operator: String(value.operator ?? ''),
    value: value.value ?? null,
    parameter: String(value.parameter ?? ''),
    source: String(value.source ?? ''),
    type: String(value.type ?? ''),
  };
}

function assertReportId(reportId: string): void {
  if (!REPORT_ID.test(reportId)) throw new ReportModelError('INVALID', '报表 ID 不合法');
}

/**
 * Parse a relationship endpoint that can be either:
 * - a dot-separated string: "t0.field_name"
 * - an object: { source: "t0", field: "field_name" }
 *
 * Returns the parsed source ID, field name, and a human-readable display string.
 */
function parseEndpoint(raw: unknown): { sourceId: string; field: string; normalized: string; display: string } {
  if (typeof raw === 'string' && raw.trim()) {
    const dot = raw.indexOf('.');
    return {
      sourceId: dot > 0 ? raw.slice(0, dot) : '',
      field: dot > 0 ? raw.slice(dot + 1) : '',
      normalized: raw.trim(),
      display: raw,
    };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const sourceId = String(obj.source ?? obj.sourceId ?? obj.source_id ?? obj.alias ?? '');
    const fieldName = String(obj.field ?? obj.fieldName ?? obj.field_name ?? '');
    return {
      sourceId,
      field: sourceId && fieldName ? fieldName : '',
      normalized: sourceId && fieldName ? `${sourceId}.${fieldName}` : JSON.stringify(raw),
      display: `${sourceId || '?'}.${fieldName || '?'} （对象格式：${JSON.stringify(raw)}）`,
    };
  }
  return { sourceId: '', field: '', normalized: String(raw ?? ''), display: JSON.stringify(raw ?? '(空)') };
}

function validateCalculationGraph(model: JsonRecord, sourceFields: Map<string, Set<string>>): string[] {
  const graph = model.calculation_graph;
  if (graph == null) return [];
  const errors: string[] = [];
  if (typeof graph !== 'object' || Array.isArray(graph)) return ['calculation_graph 必须是对象'];
  if (String(graph.version ?? '') !== '1') errors.push('calculation_graph.version 必须为 1');
  if (!Array.isArray(graph.nodes)) return [...errors, 'calculation_graph.nodes 必须是数组'];

  const nodes = graph.nodes as JsonRecord[];
  const nodeIds = new Set<string>();
  const metricIds = new Set<string>((model.metrics ?? []).map((metric: JsonRecord) => String(metric.id ?? '')));
  const queryOutputs = new Set<string>(
    (model.query_contracts ?? []).flatMap((query: JsonRecord) =>
      (query.output ?? query.output_contract ?? []).map((column: JsonRecord | string) =>
        String(typeof column === 'string' ? column : column.name ?? ''),
      ),
    ),
  );
  for (const node of nodes) {
    const id = String(node.id ?? '');
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id) || nodeIds.has(id)) {
      errors.push(`计算节点 id 缺失、非法或重复：${id || '?'}`);
    }
    nodeIds.add(id);
  }

  const knownDependencies = new Set([...nodeIds, ...metricIds, ...queryOutputs]);
  const edges = new Map<string, string[]>();
  for (const node of nodes) {
    const id = String(node.id ?? '');
    const kind = String(node.kind ?? '');
    const dependencies = Array.isArray(node.depends_on) ? node.depends_on.map(String) : [];
    edges.set(id, dependencies.filter((dependency) => nodeIds.has(dependency)));
    if (!String(node.label ?? '').trim()) errors.push(`计算节点 ${id || '?'} 缺少名称`);
    if (!CALCULATION_KINDS.has(kind)) errors.push(`计算节点 ${id || '?'} 类型不支持：${kind}`);
    if (!String(node.output_type ?? '').trim()) errors.push(`计算节点 ${id || '?'} 缺少输出类型`);
    const executionHint = String(node.execution_hint ?? 'auto');
    if (!CALCULATION_EXECUTION_HINTS.has(executionHint)) {
      errors.push(`计算节点 ${id || '?'} 的执行偏好不支持：${executionHint}`);
    }
    if (new Set(dependencies).size !== dependencies.length) {
      errors.push(`计算节点 ${id || '?'} 存在重复依赖`);
    }
    for (const dependency of dependencies) {
      if (!knownDependencies.has(dependency)) {
        errors.push(`计算节点 ${id || '?'} 引用了未知依赖：${dependency}`);
      }
    }
    if (kind === 'aggregate') {
      const source = String(node.source?.field ?? '');
      const endpoint = parseEndpoint(source);
      if (
        !endpoint.sourceId ||
        !endpoint.field ||
        !sourceFields.get(endpoint.sourceId)?.has(endpoint.field)
      ) {
        errors.push(`聚合节点 ${id || '?'} 的来源字段不在模型白名单中：${source || '?'}`);
      }
      if (!CALCULATION_AGGREGATIONS.has(String(node.source?.aggregation ?? ''))) {
        errors.push(`聚合节点 ${id || '?'} 的聚合方式不支持：${node.source?.aggregation ?? ''}`);
      }
    } else if (kind === 'formula') {
      if (!dependencies.length) errors.push(`公式节点 ${id || '?'} 至少需要一个依赖`);
      const expression = String(node.expression ?? '').trim();
      if (!expression) {
        errors.push(`公式节点 ${id || '?'} 缺少表达式`);
      } else {
        const references = new Set(
          [...expression.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!),
        );
        for (const reference of references) {
          if (!dependencies.includes(reference)) {
            errors.push(`公式节点 ${id || '?'} 的表达式引用未声明依赖：${reference}`);
          }
        }
        for (const dependency of dependencies) {
          if (!references.has(dependency)) {
            errors.push(`公式节点 ${id || '?'} 声明了未使用依赖：${dependency}`);
          }
        }
      }
    } else if (kind === 'comparison') {
      if (dependencies.length !== 1) errors.push(`对比节点 ${id || '?'} 必须且只能依赖一个指标`);
      if (!CALCULATION_COMPARISONS.has(String(node.comparison?.mode ?? ''))) {
        errors.push(`对比节点 ${id || '?'} 的对比方式不支持：${node.comparison?.mode ?? ''}`);
      }
      if (!Number.isInteger(Number(node.comparison?.offset)) || Number(node.comparison?.offset) < 1) {
        errors.push(`对比节点 ${id || '?'} 的偏移期数必须是正整数`);
      }
    } else if (kind === 'window') {
      if (dependencies.length !== 1) errors.push(`窗口节点 ${id || '?'} 必须且只能依赖一个指标`);
      if (!CALCULATION_WINDOWS.has(String(node.window?.function ?? ''))) {
        errors.push(`窗口节点 ${id || '?'} 的窗口函数不支持：${node.window?.function ?? ''}`);
      }
      for (const field of [
        ...(node.window?.partition_by ?? []),
        ...(node.window?.order_by ?? []),
      ].map(String)) {
        const endpoint = parseEndpoint(field.replace(/\s+(asc|desc)$/i, ''));
        if (
          !endpoint.sourceId ||
          !endpoint.field ||
          !sourceFields.get(endpoint.sourceId)?.has(endpoint.field)
        ) {
          errors.push(`窗口节点 ${id || '?'} 使用了模型外字段：${field}`);
        }
      }
    } else if (kind === 'merge') {
      if (dependencies.length < 2) errors.push(`合并节点 ${id || '?'} 至少需要两个依赖`);
      if (!CALCULATION_MERGES.has(String(node.merge?.operation ?? ''))) {
        errors.push(`合并节点 ${id || '?'} 的运算方式不支持：${node.merge?.operation ?? ''}`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    if (visiting.has(id)) {
      errors.push(`计算节点存在循环依赖：${[...path, id].join(' -> ')}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of edges.get(id) ?? []) visit(dependency, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of nodeIds) visit(id, []);
  return errors;
}

function calculationPlan(model: JsonRecord): JsonRecord {
  const nodes = Array.isArray(model.calculation_graph?.nodes) ? model.calculation_graph.nodes as JsonRecord[] : [];
  const byId = new Map(nodes.map((node) => [String(node.id), node]));
  const ordered: JsonRecord[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = byId.get(id); if (!node) return;
    for (const dependency of node.depends_on ?? []) visit(String(dependency));
    ordered.push(node);
  };
  for (const node of nodes) visit(String(node.id));
  return { version: '1', strategy: model.recommended_strategy, steps: ordered.map((node, index) => ({
    order: index + 1, id: node.id, kind: node.kind, dependencies: node.depends_on ?? [],
    execution: node.execution_hint === 'auto' || !node.execution_hint
      ? (node.kind === 'merge' || model.recommended_strategy === 'script' ? 'script' : 'sql')
      : node.execution_hint,
  })) };
}

function validateModel(model: JsonRecord): string[] {
  const errors: string[] = [];
  if (!model.report?.id || !model.report?.name) errors.push('模型缺少报表 id/name');
  const grainDescription = String(model.result_grain?.description ?? '').trim();
  const grainKeys = model.result_grain?.keys;
  const keylessSingleRow =
    Array.isArray(grainKeys) &&
    grainKeys.length === 0 &&
    /单行|单条|汇总为一行|single[\s_-]?row/i.test(grainDescription);
  if (
    !grainDescription ||
    !Array.isArray(grainKeys) ||
    (!grainKeys.length && !keylessSingleRow)
  ) {
    errors.push('模型必须明确结果粒度和稳定键；单行汇总可使用空 keys');
  }
  const sources = new Map<string, Set<string>>();
  for (const source of model.sources ?? []) {
    if (!source.id || sources.has(String(source.id))) errors.push('模型来源 id 缺失或重复');
    if (!source.profile_id || !source.database || !source.table || !source.alias) {
      errors.push(`来源 ${source.id ?? '?'} 缺少物理定位`);
    }
    const names = new Set<string>((source.fields ?? []).map(fieldName).filter(Boolean));
    if (!names.size) errors.push(`来源 ${source.id ?? '?'} 没有字段白名单`);
    sources.set(String(source.id), names);
    if (source.alias) sources.set(String(source.alias), names);
  }
  for (const relation of model.relationships ?? []) {
    const relationType = normalizeRelationType(String(relation.type ?? ''));
    if (!RELATION_TYPES.has(relationType)) {
      errors.push(`不支持的关联类型：${relation.type ?? ''}`);
    }
    const cardinality = normalizeCardinality(String(relation.cardinality ?? ''));
    if (!CARDINALITIES.has(cardinality)) {
      errors.push(`不支持的关系基数：${relation.cardinality ?? ''}`);
    }
    for (const endpoint of ['from', 'to'] as const) {
      const ep = parseEndpoint(relation[endpoint]);
      if (!ep.sourceId || !ep.field || !sources.get(ep.sourceId)?.has(ep.field)) {
        errors.push(`关联端点不在字段白名单中：${ep.display}`);
      }
    }
  }
  const strategy = String(model.recommended_strategy ?? '');
  if (!['sql', 'enrichment', 'group_queries', 'script'].includes(strategy)) {
    errors.push('recommended_strategy 必须是 sql|enrichment|group_queries|script');
  }
  if (!(model.query_contracts ?? []).length) errors.push('模型至少需要一个查询契约');
  const queryIds = new Set<string>();
  for (const query of model.query_contracts ?? []) {
    const queryId = String(query.id ?? '');
    if (!queryId || queryIds.has(queryId)) errors.push('查询契约 id 缺失或重复');
    queryIds.add(queryId);
    if (!(query.sources ?? []).length) errors.push(`查询契约 ${query.id ?? '?'} 没有来源`);
    if (!query.result_grain) errors.push(`查询契约 ${query.id ?? '?'} 缺少结果粒度`);
    if (!(query.output ?? []).length) errors.push(`查询契约 ${query.id ?? '?'} 没有输出契约`);
    const outputNames = new Set<string>();
    for (const column of query.output ?? []) {
      const name = String(typeof column === 'string' ? column : column.name ?? '').trim();
      if (!name || outputNames.has(name)) {
        errors.push(`查询契约 ${query.id ?? '?'} 的输出列缺失或重复`);
      }
      outputNames.add(name);
    }
    for (const source of query.sources ?? []) {
      const modelSource = (model.sources ?? []).find((item: JsonRecord) => sourceKey(item) === sourceKey(source));
      const allowed = new Set<string>((modelSource?.fields ?? []).map(fieldName));
      for (const field of source.fields ?? []) {
        if (!allowed.has(String(field))) {
          errors.push(`查询契约 ${query.id ?? '?'} 使用了模型外字段 ${source.database}.${source.table}.${field}`);
        }
      }
    }
  }
  errors.push(...validateCalculationGraph(model, sources));
  return errors;
}

async function locateModel(
  workspaceRoot: string,
  reportId: string,
): Promise<{ root: string; modelPath: string; modelsRoot: string }> {
  assertReportId(reportId);
  const adapter = new WorkspaceSkillAdapter(workspaceRoot);
  const modelsRoot = await adapter.resolveLogicalPath('report_models');
  const root = resolveWithinWorkspace(workspaceRoot, relative(normalizeAbsolute(workspaceRoot), join(modelsRoot, reportId)));
  return { root, modelPath: join(root, 'report-model.json'), modelsRoot };
}

async function readAllKnowledgeTables(workspaceRoot: string, sourceDir: unknown): Promise<JsonRecord[]> {
  if (typeof sourceDir !== 'string' || !sourceDir) return [];
  const workspace = normalizeAbsolute(workspaceRoot);
  const knowledge = resolve(sourceDir);
  if (knowledge !== workspace && !knowledge.startsWith(`${workspace}/`)) return [];
  const databaseRoot = join(knowledge, 'databases');
  const tables: JsonRecord[] = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const value = await readJson(child);
          if (value.physical?.table && Array.isArray(value.physical_fields)) tables.push(value);
        } catch {
          // One malformed catalog table must not hide the rest of the editable model.
        }
      }
    }
  }
  await visit(databaseRoot);
  return tables;
}

export interface EditableModelField {
  name: string;
  label: string;
  role: string;
  selected: boolean;
}

export interface EditableModelSource {
  id: string;
  profileId: string;
  database: string;
  table: string;
  alias: string;
  purpose: string;
  fields: EditableModelField[];
}

export interface EditableModelRelationship {
  from: string;
  to: string;
  type: string;
  cardinality: string;
  grain?: string | null;
  fanoutRisk?: boolean;
}

export interface ReportModelRule {
  field: string;
  operator: string;
  value: unknown;
  parameter: string;
  source: string;
  type: string;
}

export interface ReportModelMetric {
  id: string;
  label: string;
  entity: string;
  aggregation: string;
  sourceTable: string;
  sourceAlias: string;
  sourceField: string;
  dedupKey: string;
  condition: string | null;
  conditions: ReportModelRule[];
  evidence: string;
  confidence: string;
}

export type ReportModelCalculationKind =
  | 'aggregate'
  | 'formula'
  | 'comparison'
  | 'window'
  | 'merge';

export interface ReportModelCalculationNode {
  id: string;
  label: string;
  kind: ReportModelCalculationKind;
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
}

export interface ReportModelCalculationGraph {
  version: '1';
  nodes: ReportModelCalculationNode[];
  persisted: boolean;
}

export interface ReportModelFilter {
  id: string;
  label: string;
  valueType: string;
  operators: string[];
  defaultOperator: string;
  required: boolean;
  sqlBinding: {
    expression: string;
    clause: string;
    valueAdapter: string;
  };
  component: string;
}

export interface ReportModelTimeSemantics {
  status: string;
  alias: string;
  table: string;
  field: string;
  nativeType: string;
  required: boolean;
  description: string;
  parameterName: string;
}

export interface ReportModelQueryContract {
  id: string;
  purpose: string;
  entity: string;
  outputColumns: Array<{
    name: string;
    label: string;
    type: string;
    role: string;
    source: string;
    aggregation?: string;
    condition?: string | null;
    nullable?: boolean;
  }>;
  filters: ReportModelRule[];
}

/** One visible business field and its deterministic execution route. */
export interface ReportModelOutputField {
  id: string;
  label: string;
  kind: 'data' | 'metric' | 'calculation';
  route: 'query' | 'metric' | 'calculation_graph';
  queryId: string;
  /** The column name emitted by the query contract. */
  queryColumn: string;
  /** Resolved lineage for direct query outputs when it is determinable. */
  source: string;
  type: string;
  metricId: string;
  calculationNode: string;
}

export interface ReportModelDetail {
  reportId: string;
  reportName: string;
  status: 'approved' | 'draft' | 'invalid';
  revision: string;
  modelHash: string | null;
  strategy: string;
  resultGrain: { description: string; keys: string[] };
  sources: EditableModelSource[];
  relationships: EditableModelRelationship[];
  filters: ReportModelFilter[];
  metrics: ReportModelMetric[];
  calculationGraph: ReportModelCalculationGraph;
  outputFields: ReportModelOutputField[];
  timeSemantics: ReportModelTimeSemantics | null;
  queryContracts: ReportModelQueryContract[];
  errors: string[];
}

export class ReportModelError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID' | 'CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'ReportModelError';
  }
}

export async function readReportModel(
  workspaceRoot: string,
  reportId: string,
): Promise<ReportModelDetail> {
  const { root, modelPath } = await locateModel(workspaceRoot, reportId);
  let raw: string;
  try {
    raw = await readFile(modelPath, 'utf8');
  } catch {
    throw new ReportModelError('NOT_FOUND', `报表 ${reportId} 尚未生成模型`);
  }
  const model = JSON.parse(raw) as JsonRecord;
  const sourceLock: JsonRecord = await readJson(join(root, 'source.lock.json')).catch(
    () => ({} as JsonRecord),
  );
  const allTables = await readAllKnowledgeTables(workspaceRoot, sourceLock.knowledge?.source_dir);
  const compactTables = Array.isArray(sourceLock.tables) ? sourceLock.tables : [];
  const errors = validateModel(model);
  const currentHash = modelHash(model);
  const approved =
    errors.length === 0 &&
    !(model.open_questions ?? []).length &&
    model.approval?.status === 'approved' &&
    model.approval?.model_hash === currentHash;

  const sources = (model.sources ?? []).map((source: JsonRecord): EditableModelSource => {
    const selectedFields = (source.fields ?? []).map(
      (field: JsonRecord | string): { name: string; role: string } =>
        typeof field === 'string' ? { name: field, role: 'source' } : { name: fieldName(field), role: String((field as JsonRecord).role ?? 'source') },
    );
    const table =
      allTables.find((item) => sourceKey(item.physical ?? {}) === sourceKey(source)) ??
      compactTables.find((item: JsonRecord) => sourceKey(item.physical ?? {}) === sourceKey(source));
    const available = (table?.physical_fields ?? table?.fields ?? []) as JsonRecord[];
    return {
      id: String(source.id),
      profileId: String(source.profile_id),
      database: String(source.database),
      table: String(source.table),
      alias: String(source.alias),
      purpose: String(source.purpose ?? ''),
      fields: selectedFields
        .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))
        .map(({ name, role }: { name: string; role: string }) => {
          const known = available.find((field) => physicalFieldName(field) === name);
          return {
            name,
            label: known ? physicalFieldLabel(known) : name,
            role,
            selected: true,
          };
        }),
    };
  });
  const persistedCalculationNodes = Array.isArray(model.calculation_graph?.nodes)
    ? (model.calculation_graph.nodes as JsonRecord[])
    : null;
  const calculationNodes = persistedCalculationNodes ?? (model.metrics ?? []).map((metric: JsonRecord) => ({
    id: metric.id,
    label: metric.label ?? metric.id,
    kind: 'aggregate',
    output_type: metric.output_type ?? 'number',
    depends_on: [],
    source: {
      field:
        metric.aggregation === 'count_distinct' && metric.distinct_key
          ? metric.distinct_key
          : metric.source?.table_alias && metric.source?.field
            ? `${metric.source.table_alias}.${metric.source.field}`
            : metric.distinct_key ?? '',
      aggregation: metric.aggregation,
      condition: metric.condition ?? '',
    },
    execution_hint: 'auto',
    output: true,
    description: metric.evidence ?? '',
  }));

  // `source` / `distinct_key` are the canonical model lineage fields.
  const metrics: ReportModelMetric[] = (model.metrics ?? []).map((m: JsonRecord): ReportModelMetric => {
    const nestedSource = m.source && typeof m.source === 'object' ? m.source as JsonRecord : {};
    return {
      id: String(m.id ?? ''),
      label: String(m.label ?? m.id ?? ''),
      entity: String(m.entity ?? ''),
      aggregation: String(m.aggregation ?? ''),
      sourceTable: String(nestedSource.table ?? ''),
      sourceAlias: String(nestedSource.table_alias ?? nestedSource.alias ?? ''),
      sourceField: String(nestedSource.field ?? ''),
      dedupKey: String(m.distinct_key ?? ''),
      condition: m.condition ? String(m.condition) : null,
      conditions: Array.isArray(m.conditions) ? m.conditions.map(readRule) : [],
      evidence: String(m.evidence ?? ''),
      confidence: String(m.confidence ?? 'hypothesis'),
    };
  });
  const configuredOutputFields = Array.isArray(model.output_fields)
    ? model.output_fields as JsonRecord[]
    : [];
  const selectedFieldSources = new Map<string, string[]>();
  for (const source of sources) {
    for (const field of source.fields) {
      const candidates = selectedFieldSources.get(field.name) ?? [];
      candidates.push(`${source.alias}.${field.name}`);
      selectedFieldSources.set(field.name, candidates);
    }
  }
  const metricForColumn = (column: JsonRecord): ReportModelMetric | undefined => {
    const name = String(column.name ?? column.id ?? '');
    const label = String(column.label ?? name);
    return metrics.find((metric) => metric.id === name || metric.label === label);
  };
  const resolveColumnSource = (column: JsonRecord): string => {
    const explicit = String(column.source ?? '').trim();
    if (explicit) return explicit;
    const metric = metricForColumn(column);
    if (metric?.sourceAlias && metric.sourceField) return `${metric.sourceAlias}.${metric.sourceField}`;
    const name = String(column.name ?? column.id ?? '');
    const candidates = selectedFieldSources.get(name) ?? [];
    // Only infer an exact physical-name match when there is one unambiguous
    // selected source.  Joined tables can share column names such as `id`.
    return candidates.length === 1 ? candidates[0]! : '';
  };

  return {
    reportId: String(model.report?.id ?? reportId),
    reportName: String(model.report?.name ?? reportId),
    status: approved ? 'approved' : errors.length ? 'invalid' : 'draft',
    revision: sha256(raw),
    modelHash: approved ? currentHash : null,
    strategy: String(model.recommended_strategy ?? ''),
    resultGrain: {
      description: String(model.result_grain?.description ?? ''),
      keys: (model.result_grain?.keys ?? []).map(String),
    },
    sources,
    relationships: (model.relationships ?? []).map((relationship: JsonRecord) => {
      // Accept split-key format {from_source, from_field, to_source, to_field}
      const resolveEp = (key: string, srcKey: string, fldKey: string) => {
        if (relationship[key] != null) return relationship[key];
        const src = relationship[srcKey];
        const fld = relationship[fldKey];
        if (src != null || fld != null) return { alias: src, field: fld };
        return undefined;
      };
      return {
      from: parseEndpoint(resolveEp('from', 'from_source', 'from_field') ?? resolveEp('from', 'from_alias', 'from_field')).normalized,
      to: parseEndpoint(resolveEp('to', 'to_source', 'to_field') ?? resolveEp('to', 'to_alias', 'to_field')).normalized,
      type: normalizeRelationType(String(relationship.type ?? 'left')),
      cardinality: normalizeCardinality(String(relationship.cardinality ?? 'unknown')),
      grain: relationship.grain == null ? null : String(relationship.grain),
      fanoutRisk: Boolean(relationship.fanout_risk),
    };
    }),
    filters: (model.filters ?? []).map((f: JsonRecord): ReportModelFilter => ({
      id: String(f.id ?? ''),
      label: String(f.label ?? f.id ?? ''),
      valueType: String(f.value_type ?? ''),
      operators: Array.isArray(f.operators) ? f.operators.map(String) : [],
      defaultOperator: String(f.default_operator ?? ''),
      required: Boolean(f.required),
      sqlBinding: {
        expression: String(f.sql_binding?.expression ?? ''),
        clause: String(f.sql_binding?.clause ?? 'where'),
        valueAdapter: String(f.sql_binding?.value_adapter ?? 'direct'),
      },
      component: normalizeFilterComponent(f.component, String(f.value_type ?? ''), String(f.default_operator ?? '')),
    })),
    metrics,
    calculationGraph: {
      version: '1',
      persisted: persistedCalculationNodes !== null,
      nodes: calculationNodes.map((node: JsonRecord): ReportModelCalculationNode => ({
        id: String(node.id ?? ''),
        label: String(node.label ?? node.id ?? ''),
        kind: String(node.kind ?? 'formula') as ReportModelCalculationKind,
        outputType: String(node.output_type ?? 'number'),
        dependencies: Array.isArray(node.depends_on) ? node.depends_on.map(String) : [],
        expression: String(node.expression ?? ''),
        sourceField: String(node.source?.field ?? ''),
        aggregation: String(node.source?.aggregation ?? ''),
        condition: String(node.source?.condition ?? ''),
        comparisonMode: String(node.comparison?.mode ?? ''),
        comparisonOffset: Number(node.comparison?.offset ?? 1),
        windowFunction: String(node.window?.function ?? ''),
        partitionBy: Array.isArray(node.window?.partition_by)
          ? node.window.partition_by.map(String)
          : [],
        orderBy: Array.isArray(node.window?.order_by) ? node.window.order_by.map(String) : [],
        frame: String(node.window?.frame ?? ''),
        mergeOperation: String(node.merge?.operation ?? ''),
        joinKeys: Array.isArray(node.merge?.join_keys) ? node.merge.join_keys.map(String) : [],
        executionHint: String(node.execution_hint ?? 'auto') as 'auto' | 'sql' | 'script',
        output: node.output !== false,
        description: String(node.description ?? ''),
      })),
    },
    outputFields: (() => {
      if (configuredOutputFields.length) return configuredOutputFields.map((field) => {
        const queryId = String(field.query_id ?? '');
        const queryColumn = String(field.query_column ?? field.id ?? '');
        const contract = (model.query_contracts ?? []).find((item: JsonRecord) => String(item.id ?? '') === queryId);
        const columns = contract
          ? [
              ...((contract.output_contract ?? contract.output ?? []) as JsonRecord[]),
              ...(Array.isArray(contract.aggregations) ? contract.aggregations as JsonRecord[] : []),
            ]
          : [];
        const column = columns.find((item) => String(item.name ?? item.id ?? '') === queryColumn);
        return {
          id: String(field.id ?? ''), label: String(field.label ?? field.id ?? ''),
          kind: String(field.kind ?? 'data') as ReportModelOutputField['kind'],
          route: String(field.route ?? 'query') as ReportModelOutputField['route'],
          queryId,
          queryColumn,
          source: column ? resolveColumnSource(column) : '',
          type: String(field.type ?? column?.type ?? ''),
          metricId: String(field.metric_id ?? ''), calculationNode: String(field.calculation_node ?? ''),
        };
      });
      const seen = new Set<string>();
      return (model.query_contracts ?? []).flatMap((contract: JsonRecord) =>
        (contract.output_contract ?? contract.output ?? []).flatMap((column: JsonRecord | string) => {
          const item = typeof column === 'string' ? { name: column } : column;
          const id = String(item.name ?? item.id ?? '');
          if (!id || seen.has(id)) return [];
          seen.add(id);
          return [{ id, label: String(item.label ?? id), kind: 'data' as const, route: 'query' as const, queryId: String(contract.id ?? ''), queryColumn: id, source: resolveColumnSource(item), type: String(item.type ?? ''), metricId: '', calculationNode: '' }];
        }),
      );
    })(),
    timeSemantics: model.time_semantics && typeof model.time_semantics === 'object'
      ? {
          status: String(model.time_semantics.status ?? ''),
          alias: String(model.time_semantics.field?.alias ?? ''),
          table: String(model.time_semantics.field?.table ?? ''),
          field: String(model.time_semantics.field?.field ?? ''),
          nativeType: String(model.time_semantics.native_type ?? ''),
          required: Boolean(model.time_semantics.required),
          description: String(model.time_semantics.description ?? ''),
          parameterName: String(model.time_semantics.parameter_name ?? ''),
        }
      : null,
    queryContracts: (model.query_contracts ?? []).map((qc: JsonRecord): ReportModelQueryContract => {
      const queryId = String(qc.id ?? '');
      const columns = [
        ...((qc.output_contract ?? qc.output ?? []) as JsonRecord[]),
        ...(Array.isArray(qc.aggregations) ? qc.aggregations as JsonRecord[] : []),
      ];
      const seen = new Set<string>();
      return {
        id: queryId,
        purpose: String(qc.purpose ?? ''),
        entity: String(qc.entity ?? ''),
        outputColumns: columns.flatMap((col: JsonRecord) => {
          const name = String(col.name ?? col.id ?? '');
          if (!name || seen.has(name)) return [];
          seen.add(name);
          const outputField = configuredOutputFields.find(
            (field) =>
              String(field.query_id ?? '') === queryId &&
              String(field.query_column ?? field.id ?? '') === name,
          );
          const isDirectData = String(outputField?.kind ?? '') === 'data' || (model.result_grain?.keys ?? []).map(String).includes(name);
          return [{
            name,
            label: String(col.label ?? name),
            type: String(col.type ?? outputField?.type ?? ''),
            role: String(col.role ?? (isDirectData ? 'group_key' : 'metric')),
            source: resolveColumnSource(col),
            ...(col.aggregation ? { aggregation: String(col.aggregation) } : {}),
            ...(col.condition !== undefined ? { condition: col.condition ? String(col.condition) : null } : {}),
            ...(col.nullable !== undefined ? { nullable: Boolean(col.nullable) } : {}),
          }];
        }),
        filters: Array.isArray(qc.filters) ? qc.filters.map(readRule) : [],
      };
    }),
    errors,
  };
}

export interface ReportModelEdit {
  expectedRevision: string;
  reviewedBy: string;
  sources: Array<{ id: string; fields: Array<{ name: string; role?: string }> }>;
  relationships: EditableModelRelationship[];
  /** Full replacement of the structured calculation DAG. Omit to preserve the current graph. */
  calculationGraph?: {
    version: '1';
    nodes: ReportModelCalculationNode[];
  };
  /** Per-metric source field mapping edits: { id, sourceField, dedupKey, sourceAlias? } */
  metricEdits?: Array<{
    id: string;
    sourceField?: string;
    sourceAlias?: string;
    dedupKey?: string;
  }>;
  /** Filter configuration edits: add, update, or remove filters */
  filterEdits?: Array<{
    id: string;
    /** Set to true to delete this filter */
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
}

export async function writeReportModel(
  workspaceRoot: string,
  reportId: string,
  edit: ReportModelEdit,
): Promise<ReportModelDetail> {
  const { root, modelPath } = await locateModel(workspaceRoot, reportId);
  const raw = await readFile(modelPath, 'utf8').catch(() => null);
  if (raw == null) throw new ReportModelError('NOT_FOUND', `报表 ${reportId} 尚未生成模型`);
  if (sha256(raw) !== edit.expectedRevision) {
    throw new ReportModelError('CONFLICT', '模型已被其他任务更新，请刷新后重试');
  }
  const model = JSON.parse(raw) as JsonRecord;
  if (String(model.report?.id) !== reportId) {
    throw new ReportModelError('INVALID', '模型目录与模型内报表 ID 不一致');
  }
  const existingSources = new Map<string, JsonRecord>(
    (model.sources ?? []).map((source: JsonRecord) => [String(source.id), source]),
  );
  if (
    edit.sources.length !== existingSources.size ||
    edit.sources.some((source) => !existingSources.has(source.id))
  ) {
    throw new ReportModelError('INVALID', '只能调整当前模型表的字段，不能在此新增或删除来源表');
  }
  const sourceLock: JsonRecord = await readJson(join(root, 'source.lock.json')).catch(
    () => ({} as JsonRecord),
  );
  const allTables = await readAllKnowledgeTables(workspaceRoot, sourceLock.knowledge?.source_dir);
  const availableBySource = new Map<string, Set<string>>();
  for (const source of model.sources ?? []) {
    const table =
      allTables.find((item) => sourceKey(item.physical ?? {}) === sourceKey(source)) ??
      (Array.isArray(sourceLock.tables)
        ? sourceLock.tables.find((item: JsonRecord) => sourceKey(item.physical ?? {}) === sourceKey(source))
        : undefined);
    const names = new Set(
      ((table?.physical_fields ?? table?.fields ?? []) as JsonRecord[])
        .map(physicalFieldName)
        .filter(Boolean),
    );
    availableBySource.set(String(source.id), names);
  }
  for (const source of edit.sources) {
    const names = source.fields.map((field) => field.name.trim()).filter(Boolean);
    if (!names.length) throw new ReportModelError('INVALID', `来源 ${source.id} 至少保留一个字段`);
    if (new Set(names).size !== names.length) {
      throw new ReportModelError('INVALID', `来源 ${source.id} 存在重复字段`);
    }
    for (const name of names) {
      if (!availableBySource.get(source.id)?.has(name)) {
        throw new ReportModelError('INVALID', `字段不在知识库中：${source.id}.${name}`);
      }
    }
    existingSources.get(source.id)!.fields = source.fields.map((field) => ({
      name: field.name.trim(),
      role: field.role?.trim() || 'source',
    }));
  }
  const selectedBySource = new Map(
    [...existingSources].map(([id, source]) => [
      id,
      new Set<string>((source.fields ?? []).map(fieldName)),
    ]),
  );
  const selectedByAlias = new Map(
    [...existingSources.values()].map((source) => [
      String(source.alias),
      new Set<string>((source.fields ?? []).map(fieldName)),
    ]),
  );
  const relationKeys = new Set<string>();
  model.relationships = edit.relationships.map((relationship) => {
    if (!RELATION_TYPES.has(relationship.type)) {
      throw new ReportModelError('INVALID', `不支持的关联类型：${relationship.type}`);
    }
    if (!CARDINALITIES.has(relationship.cardinality)) {
      throw new ReportModelError('INVALID', `不支持的关系基数：${relationship.cardinality}`);
    }
    const epFrom = parseEndpoint(relationship.from);
    const epTo = parseEndpoint(relationship.to);
    if (!epFrom.sourceId || !epFrom.field || !selectedBySource.get(epFrom.sourceId)?.has(epFrom.field)) {
      throw new ReportModelError('INVALID', `关联端点不在已选字段中：${epFrom.display}`);
    }
    if (!epTo.sourceId || !epTo.field || !selectedBySource.get(epTo.sourceId)?.has(epTo.field)) {
      throw new ReportModelError('INVALID', `关联端点不在已选字段中：${epTo.display}`);
    }
    const key = `${epFrom.normalized}->${epTo.normalized}`;
    if (relationKeys.has(key)) throw new ReportModelError('INVALID', `重复关联：${key}`);
    relationKeys.add(key);
    return {
      from: epFrom.normalized,
      to: epTo.normalized,
      type: normalizeRelationType(relationship.type),
      cardinality: normalizeCardinality(relationship.cardinality),
      grain: relationship.grain ?? null,
      fanout_risk:
        relationship.fanoutRisk ??
        (relationship.cardinality === '1:n' || relationship.cardinality === 'n:n'),
    };
  });

  const selectedByPhysical = new Map(
    [...existingSources.values()].map((source) => [
      sourceKey(source),
      (source.fields ?? []).map(fieldName),
    ]),
  );
  for (const query of model.query_contracts ?? []) {
    for (const source of query.sources ?? []) {
      const selected = selectedByPhysical.get(sourceKey(source));
      if (selected) source.fields = selected;
    }
  }
  // Apply metric source field mapping edits.
  if (Array.isArray(edit.metricEdits) && edit.metricEdits.length) {
    const metrics = model.metrics ?? [];
    for (const medit of edit.metricEdits) {
      const metric = metrics.find((m: JsonRecord) => String(m.id) === medit.id);
      const sourceAlias = medit.sourceAlias?.trim();
      const sourceField = medit.sourceField?.trim();
      if ((sourceAlias && !sourceField) || (!sourceAlias && sourceField)) {
        throw new ReportModelError('INVALID', `指标 ${medit.id} 的来源别名和字段必须同时设置`);
      }
      if (sourceAlias && sourceField && !selectedByAlias.get(sourceAlias)?.has(sourceField)) {
        throw new ReportModelError(
          'INVALID',
          `指标 ${medit.id} 的来源字段不在模型白名单中：${sourceAlias}.${sourceField}`,
        );
      }
      if (medit.dedupKey) {
        const endpoint = parseEndpoint(medit.dedupKey);
        if (
          !endpoint.sourceId ||
          !endpoint.field ||
          !selectedByAlias.get(endpoint.sourceId)?.has(endpoint.field)
        ) {
          throw new ReportModelError(
            'INVALID',
            `指标 ${medit.id} 的去重键不在模型白名单中：${medit.dedupKey}`,
          );
        }
      }
      if (!metric) {
        let updated = false;
        const targetOutputs = (model.output_fields ?? []).filter(
          (field: JsonRecord) => String(field.id ?? '') === medit.id,
        );
        for (const contract of model.query_contracts ?? []) {
          for (const column of [
            ...(contract.output_contract ?? contract.output ?? []),
            ...(contract.aggregations ?? []),
          ]) {
            const columnName = String((column as JsonRecord).name ?? '');
            const isTarget = columnName === medit.id || targetOutputs.some(
              (field: JsonRecord) =>
                String(field.query_id ?? '') === String(contract.id ?? '') &&
                String(field.query_column ?? field.id ?? '') === columnName,
            );
            if (!isTarget) continue;
            if (sourceAlias && sourceField) {
              (column as JsonRecord).source = `${sourceAlias}.${sourceField}`;
              updated = true;
            }
          }
        }
        if (!updated) {
          throw new ReportModelError('INVALID', `模型中不存在可编辑指标或输出字段：${medit.id}`);
        }
        continue;
      }
      if (sourceAlias && sourceField) {
        metric.source = {
          ...(metric.source && typeof metric.source === 'object' ? metric.source : {}),
          table_alias: sourceAlias,
          field: sourceField,
        };
      }
      if (medit.dedupKey) metric.distinct_key = medit.dedupKey;
      // Update query_contract output columns to match
      const targetOutputs = (model.output_fields ?? []).filter(
        (field: JsonRecord) => String(field.id ?? '') === String(metric.id ?? ''),
      );
      for (const contract of model.query_contracts ?? []) {
        for (const col of [
          ...(contract.output_contract ?? contract.output ?? []),
          ...(contract.aggregations ?? []),
        ]) {
          const columnName = String((col as JsonRecord).name ?? '');
          const isTarget = columnName === String(metric.output_column ?? metric.id) || targetOutputs.some(
            (field: JsonRecord) =>
              String(field.query_id ?? '') === String(contract.id ?? '') &&
              String(field.query_column ?? field.id ?? '') === columnName,
          );
          if (isTarget) {
            if (medit.dedupKey) (col as JsonRecord).source = medit.dedupKey;
            if (medit.sourceField) {
              const from = (col as JsonRecord).condition
                ? String((col as JsonRecord).condition).replace(/^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\b/, `${sourceAlias}.${sourceField}`)
                : undefined;
              if (from) (col as JsonRecord).condition = from;
            }
          }
        }
      }
    }
  }

  // Apply filter configuration edits.
  if (Array.isArray(edit.filterEdits) && edit.filterEdits.length) {
    let filters = (model.filters ?? []) as JsonRecord[];
    const parameters = (model.parameters ?? []) as JsonRecord[];
    for (const fedit of edit.filterEdits) {
      if (fedit.delete) {
        filters = filters.filter((f: JsonRecord) => String(f.id) !== fedit.id);
        // Also remove from parameters
        const paramIdx = parameters.findIndex((p: JsonRecord) => String(p.id) === fedit.id);
        if (paramIdx >= 0) parameters.splice(paramIdx, 1);
        continue;
      }
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(fedit.id)) {
        throw new ReportModelError('INVALID', `筛选参数 ID 不合法：${fedit.id}`);
      }
      const existing = filters.find((filter) => String(filter.id) === fedit.id);
      const existingClause = String(existing?.sql_binding?.clause ?? 'where');
      const existingExpression = String(existing?.sql_binding?.expression ?? '');
      const clause = String(fedit.clause ?? existingClause);
      const expression = String(fedit.expression ?? existingExpression);
      const bindingChanged =
        clause !== existingClause || expression !== existingExpression || !existing;
      if (bindingChanged && !['where', 'having'].includes(clause)) {
        throw new ReportModelError('INVALID', `模型编辑器不支持新增或改写 ${clause} 筛选`);
      }
      if (bindingChanged && expression) {
        const match = expression.match(
          /^([A-Za-z][A-Za-z0-9_]*)\.(?:`([^`]+)`|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))$/,
        );
        const alias = match?.[1] ?? '';
        const field = match?.[2] ?? match?.[3] ?? match?.[4] ?? '';
        if (!alias || !field || !selectedByAlias.get(alias)?.has(field)) {
          throw new ReportModelError(
            'INVALID',
            `筛选 ${fedit.id} 的来源字段不在模型白名单中：${expression}`,
          );
        }
      }
      if (!expression && !existing) {
        throw new ReportModelError('INVALID', `新增筛选 ${fedit.id} 必须选择来源字段`);
      }
      const filterEntry: JsonRecord = existing ?? { id: fedit.id };
      if (fedit.label) filterEntry.label = fedit.label;
      if (fedit.valueType) filterEntry.value_type = fedit.valueType;
      if (fedit.operators) filterEntry.operators = fedit.operators;
      if (fedit.defaultOperator) filterEntry.default_operator = fedit.defaultOperator;
      if (fedit.required !== undefined) filterEntry.required = fedit.required;
      if (fedit.component) filterEntry.component = fedit.component;
      if (fedit.expression || fedit.clause || fedit.valueAdapter) {
        filterEntry.sql_binding = {
          ...(filterEntry.sql_binding ?? {}),
          ...(fedit.expression ? { expression: fedit.expression } : {}),
          ...(fedit.clause ? { clause: fedit.clause } : {}),
          ...(fedit.valueAdapter ? { value_adapter: fedit.valueAdapter } : {}),
        };
      }
      if (!existing) filters.push(filterEntry);

      // Sync to parameters
      const param = parameters.find((p: JsonRecord) => String(p.id) === fedit.id);
      if (param) {
        if (fedit.label) param.label = fedit.label;
        if (fedit.valueType) param.value_type = fedit.valueType;
        if (fedit.operators) param.operators = fedit.operators;
        if (fedit.defaultOperator) param.default_operator = fedit.defaultOperator;
        if (fedit.required !== undefined) param.required = fedit.required;
        if (fedit.component) param.component = fedit.component;
        if (fedit.expression || fedit.clause || fedit.valueAdapter) {
          param.sql_binding = {
            ...(param.sql_binding ?? {}),
            ...(fedit.expression ? { expression: fedit.expression } : {}),
            ...(fedit.clause ? { clause: fedit.clause } : {}),
            ...(fedit.valueAdapter ? { value_adapter: fedit.valueAdapter } : {}),
          };
        }
      } else if (!fedit.delete) {
        // Create new parameter for a new filter
        parameters.push({
          id: fedit.id,
          label: fedit.label ?? fedit.id,
          value_type: fedit.valueType ?? 'string',
          operators: fedit.operators ?? ['eq'],
          default_operator: fedit.defaultOperator ?? 'eq',
          required: fedit.required ?? false,
          component: fedit.component ?? 'text',
          sql_binding: {
            expression: fedit.expression ?? '',
            clause: fedit.clause ?? 'where',
            value_adapter: fedit.valueAdapter ?? 'direct',
          },
        });
      }
    }
    model.filters = filters;
    model.parameters = parameters;
  }

  if (edit.calculationGraph) {
    model.calculation_graph = {
      version: '1',
      nodes: edit.calculationGraph.nodes.map((node) => ({
        id: node.id.trim(),
        label: node.label.trim(),
        kind: node.kind,
        output_type: node.outputType.trim() || 'number',
        depends_on: node.dependencies.map((dependency) => dependency.trim()).filter(Boolean),
        ...(node.expression.trim() ? { expression: node.expression.trim() } : {}),
        ...(node.kind === 'aggregate'
          ? {
              source: {
                field: node.sourceField.trim(),
                aggregation: node.aggregation.trim(),
                ...(node.condition.trim() ? { condition: node.condition.trim() } : {}),
              },
            }
          : {}),
        ...(node.kind === 'comparison'
          ? {
              comparison: {
                mode: node.comparisonMode.trim(),
                offset: Number(node.comparisonOffset || 1),
              },
            }
          : {}),
        ...(node.kind === 'window'
          ? {
              window: {
                function: node.windowFunction.trim(),
                partition_by: node.partitionBy.map((field) => field.trim()).filter(Boolean),
                order_by: node.orderBy.map((field) => field.trim()).filter(Boolean),
                ...(node.frame.trim() ? { frame: node.frame.trim() } : {}),
              },
            }
          : {}),
        ...(node.kind === 'merge'
          ? {
              merge: {
                operation: node.mergeOperation.trim(),
                join_keys: node.joinKeys.map((field) => field.trim()).filter(Boolean),
              },
            }
          : {}),
        execution_hint: node.executionHint,
        output: Boolean(node.output),
        ...(node.description.trim() ? { description: node.description.trim() } : {}),
      })),
    };
    model.calculation_plan = calculationPlan(model);
    const existingCalculationOutputs = (model.output_fields ?? []).filter(
      (field: JsonRecord) => String(field.route ?? '') === 'calculation_graph',
    );
    const nodeOutputs = (model.calculation_graph.nodes ?? []).filter((node: JsonRecord) => node.output !== false);
    model.output_fields = [
      ...(model.output_fields ?? []).filter((field: JsonRecord) => String(field.route ?? '') !== 'calculation_graph'),
      ...nodeOutputs.map((node: JsonRecord) => {
        const existing = existingCalculationOutputs.find(
          (field: JsonRecord) => String(field.calculation_node ?? field.id ?? '') === String(node.id),
        );
        return {
          ...(existing ?? {}),
          id: String(existing?.id ?? node.id),
          label: String(node.label),
          kind: 'calculation',
          route: 'calculation_graph',
          calculation_node: String(node.id),
        };
      }),
    ];
  }
  // The Studio-owned model format has completed its migration to structured
  // lineage. Remove obsolete flat aliases whenever a model is resealed.
  for (const metric of model.metrics ?? []) {
    delete metric.source_alias;
    delete metric.source_field;
    delete metric.source_table;
    delete metric.dedup_key;
  }
  delete model.comparison;
  model.generated_at = new Date().toISOString();
  model.open_questions = [];
  model.approval = { status: 'draft' };
  const errors = validateModel(model);
  if (errors.length) throw new ReportModelError('INVALID', errors.join('；'));
  model.approval = {
    status: 'approved',
    reviewed_by: edit.reviewedBy.trim() || 'studio-user',
    approved_at: new Date().toISOString(),
    model_hash: modelHash(model),
  };

  const writeSourceLock = await readJson(join(root, 'source.lock.json'));
  writeSourceLock.model_hash = model.approval.model_hash;
  const knowledgeTables = await readAllKnowledgeTables(
    workspaceRoot,
    writeSourceLock.knowledge?.source_dir,
  );
  writeSourceLock.tables = (writeSourceLock.tables ?? []).map((table: JsonRecord) => {
    const selected = selectedByPhysical.get(sourceKey(table.physical ?? {}));
    if (!selected) return table;
    const allowed = new Set(selected);
    const knowledgeTable = knowledgeTables.find(
      (candidate) => sourceKey(candidate.physical ?? {}) === sourceKey(table.physical ?? {}),
    );
    const availableFields = knowledgeTable?.physical_fields ?? table.fields ?? [];
    return {
      ...(knowledgeTable
        ? {
            table_id: knowledgeTable.table_id,
            physical: knowledgeTable.physical,
            semantic: knowledgeTable.semantic,
            indexes: knowledgeTable.indexes ?? [],
            foreign_keys: knowledgeTable.foreign_keys ?? [],
            system_conditions: knowledgeTable.system_conditions ?? [],
            security: knowledgeTable.security ?? null,
          }
        : table),
      fields: availableFields.filter((field: JsonRecord) =>
        allowed.has(physicalFieldName(field)),
      ).map((field: JsonRecord) => ({
        physical: field.physical,
        semantic: field.semantic,
        filter: field.filter,
      })),
    };
  });
  const manifest = await readJson(join(root, 'model.manifest.json'));
  manifest.status = 'approved';
  manifest.model_hash = model.approval.model_hash;
  manifest.approved_by = model.approval.reviewed_by;
  manifest.approved_at = model.approval.approved_at;

  const adapter = new WorkspaceSkillAdapter(workspaceRoot);
  const plansRoot = await adapter.resolveLogicalPath('report_plans');
  const planPath = join(plansRoot, `${reportId}.json`);
  const originalPlan = await readFile(planPath, 'utf8').catch(() => null);
  if (originalPlan == null) {
    throw new ReportModelError('INVALID', `当前模型缺少报表计划：${reportId}.json`);
  }
  const backup = join(root, `.edit-backup-${Date.now()}`);
  await mkdir(backup, { recursive: true });
  const targets = ['report-model.json', 'source.lock.json', 'model.manifest.json', 'checksums.sha256'];
  try {
    for (const name of targets) {
      await writeFile(join(backup, name), await readFile(join(root, name)));
    }
    await writeJsonAtomic(modelPath, model);
    await writeJsonAtomic(join(root, 'source.lock.json'), writeSourceLock);
    await writeJsonAtomic(join(root, 'model.manifest.json'), manifest);
    await resealChecksums(root);

    const plan = JSON.parse(originalPlan) as JsonRecord;
    plan.report_model = {
      model_format_version: String(model.model_format_version ?? '1'),
      status: 'approved',
      model_hash: model.approval.model_hash,
      ref: relative(dirname(planPath), modelPath).split('\\').join('/'),
    };
    await writeJsonAtomic(planPath, plan);
  } catch (error) {
    for (const name of targets) {
      await writeFile(join(root, name), await readFile(join(backup, name))).catch(() => undefined);
    }
    await writeFile(planPath, originalPlan, 'utf8').catch(() => undefined);
    throw error;
  } finally {
    await rm(backup, { recursive: true, force: true });
  }
  return readReportModel(workspaceRoot, reportId);
}

export interface AvailableField {
  name: string;
  label: string;
  nativeType: string;
  nullable: boolean;
}

export async function readAvailableFields(
  workspaceRoot: string,
  reportId: string,
  sourceId: string,
): Promise<AvailableField[]> {
  const { root } = await locateModel(workspaceRoot, reportId);
  const model = await readJson(join(root, 'report-model.json'));
  const source = (model.sources ?? []).find((s: JsonRecord) => String(s.id) === sourceId);
  if (!source) throw new ReportModelError('NOT_FOUND', `模型中不存在来源：${sourceId}`);

  const sourceLock: JsonRecord = await readJson(join(root, 'source.lock.json')).catch(() => ({} as JsonRecord));
  const allTables = await readAllKnowledgeTables(workspaceRoot, sourceLock.knowledge?.source_dir);
  const compactTables = Array.isArray(sourceLock.tables) ? sourceLock.tables : [];
  const table =
    allTables.find((item) => sourceKey(item.physical ?? {}) === sourceKey(source)) ??
    compactTables.find((item: JsonRecord) => sourceKey(item.physical ?? {}) === sourceKey(source));
  const available = (table?.physical_fields ?? table?.fields ?? []) as JsonRecord[];
  const selected = new Set((source.fields ?? []).map((f: JsonRecord | string) => (typeof f === 'string' ? f : String((f as JsonRecord).name ?? ''))));

  return available
    .map((f) => ({
      name: physicalFieldName(f),
      label: physicalFieldLabel(f) || physicalFieldName(f),
      nativeType: String(f.physical?.native_type ?? f.physical?.type ?? ''),
      nullable: Boolean(f.physical?.nullable),
    }))
    .filter((f) => f.name && !selected.has(f.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}
