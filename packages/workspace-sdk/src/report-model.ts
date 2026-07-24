import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { WorkspaceSkillAdapter } from './skill-adapter.js';
import { normalizeAbsolute, resolveWithinWorkspace } from './paths.js';

// Workspace artifacts are intentionally schema-flexible at this adapter boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;

const REPORT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const KNOWN_RELATION_TYPES = ['inner', 'left', 'right', 'full', 'cross'] as const;
const RELATION_TYPES = new Set<string>(KNOWN_RELATION_TYPES);
const RELATION_ALIASES: Record<string, string> = {
  inner_join: 'inner',
  left_join: 'left',
  right_join: 'right',
  full_join: 'full',
  cross_join: 'cross',
};

function normalizeRelationType(value: string): string {
  const key = value.trim().toLowerCase();
  return RELATION_ALIASES[key] ?? key;
}
const KNOWN_CARDINALITIES = ['1:1', '1:n', 'n:1', 'n:n', 'unknown'] as const;
const CARDINALITIES = new Set<string>(KNOWN_CARDINALITIES);

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

function assertReportId(reportId: string): void {
  if (!REPORT_ID.test(reportId)) throw new ReportModelError('INVALID', '报表 ID 不合法');
}

function validateModel(model: JsonRecord): string[] {
  const errors: string[] = [];
  if (!model.report?.id || !model.report?.name) errors.push('模型缺少报表 id/name');
  if (!model.result_grain?.description || !(model.result_grain?.keys ?? []).length) {
    errors.push('模型必须明确结果粒度和稳定键');
  }
  const sources = new Map<string, Set<string>>();
  for (const source of model.sources ?? []) {
    if (!source.id || sources.has(String(source.id))) errors.push('模型来源 id 缺失或重复');
    const names = new Set<string>((source.fields ?? []).map(fieldName).filter(Boolean));
    if (!names.size) errors.push(`来源 ${source.id ?? '?'} 没有字段白名单`);
    sources.set(String(source.id), names);
  }
  for (const relation of model.relationships ?? []) {
    for (const endpoint of ['from', 'to'] as const) {
      const raw = String(relation[endpoint] ?? '');
      const split = raw.indexOf('.');
      const sourceId = split > 0 ? raw.slice(0, split) : '';
      const field = split > 0 ? raw.slice(split + 1) : '';
      if (!sourceId || !field || !sources.get(sourceId)?.has(field)) {
        errors.push(`关联端点不在字段白名单中：${raw || '(空)'}`);
      }
    }
  }
  const strategy = String(model.recommended_strategy ?? '');
  if (!['sql', 'enrichment', 'group_queries', 'script'].includes(strategy)) {
    errors.push('recommended_strategy 必须是 sql|enrichment|group_queries|script');
  }
  if (!(model.query_contracts ?? []).length) errors.push('模型至少需要一个查询契约');
  for (const query of model.query_contracts ?? []) {
    if (!(query.sources ?? []).length) errors.push(`查询契约 ${query.id ?? '?'} 没有来源`);
    if (!(query.output ?? []).length) errors.push(`查询契约 ${query.id ?? '?'} 没有输出契约`);
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

export interface ReportModelComparison {
  enabled: boolean;
  modes: string[];
  period_param: string;
  lookback_months: number;
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
  filters: JsonRecord[];
  metrics: JsonRecord[];
  comparison: ReportModelComparison | null;
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
    const selectedNames = new Set(selectedFields.map((f) => f.name));
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
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(({ name, role }) => {
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
    relationships: (model.relationships ?? []).map((relationship: JsonRecord) => ({
      from: String(relationship.from ?? ''),
      to: String(relationship.to ?? ''),
      type: normalizeRelationType(String(relationship.type ?? 'left')),
      cardinality: normalizeCardinality(String(relationship.cardinality ?? 'unknown')),
      grain: relationship.grain == null ? null : String(relationship.grain),
      fanoutRisk: Boolean(relationship.fanout_risk),
    })),
    filters: model.filters ?? [],
    metrics: model.metrics ?? [],
    comparison: model.comparison && typeof model.comparison === 'object'
      ? {
          enabled: Boolean(model.comparison.enabled),
          modes: Array.isArray(model.comparison.modes) ? model.comparison.modes.map(String) : [],
          period_param: String(model.comparison.period_param ?? ''),
          lookback_months: Number(model.comparison.lookback_months ?? 1),
        }
      : null,
    errors,
  };
}

export interface ReportModelEdit {
  expectedRevision: string;
  reviewedBy: string;
  sources: Array<{ id: string; fields: Array<{ name: string; role?: string }> }>;
  relationships: EditableModelRelationship[];
  comparison?: ReportModelComparison | null;
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
  const relationKeys = new Set<string>();
  model.relationships = edit.relationships.map((relationship) => {
    if (!RELATION_TYPES.has(relationship.type)) {
      throw new ReportModelError('INVALID', `不支持的关联类型：${relationship.type}`);
    }
    if (!CARDINALITIES.has(relationship.cardinality)) {
      throw new ReportModelError('INVALID', `不支持的关系基数：${relationship.cardinality}`);
    }
    for (const endpoint of [relationship.from, relationship.to]) {
      const split = endpoint.indexOf('.');
      const id = split > 0 ? endpoint.slice(0, split) : '';
      const field = split > 0 ? endpoint.slice(split + 1) : '';
      if (!selectedBySource.get(id)?.has(field)) {
        throw new ReportModelError('INVALID', `关联端点不在已选字段中：${endpoint}`);
      }
    }
    const key = `${relationship.from}->${relationship.to}`;
    if (relationKeys.has(key)) throw new ReportModelError('INVALID', `重复关联：${key}`);
    relationKeys.add(key);
    return {
      from: relationship.from,
      to: relationship.to,
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
  // Write comparison settings from the editor into the model.
  if (edit.comparison) {
    model.comparison = {
      enabled: Boolean(edit.comparison.enabled),
      modes: (edit.comparison.modes ?? []).map(String),
      period_param: String(edit.comparison.period_param ?? ''),
      lookback_months: Number(edit.comparison.lookback_months ?? 1),
    };
  } else if (edit.comparison === null) {
    delete model.comparison;
  }
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
