// Pure helpers for editing report information inside config/easy-bi.json.
// Only knowledge.report_requirements and knowledge.report_scenarios are touched;
// every other field in the build config is preserved verbatim on merge.

/**
 * One required field. A field may be stored two ways in report_requirements:
 *   - a plain string (e.g. "运输订单号")
 *   - an object with a field binding (e.g. { field: "table.col", label: "运输订单号" })
 * We keep the original object (`raw`) so editing the display text round-trips
 * without dropping the `field` binding or other keys the skill may add.
 */
/** What a field is used for in the report. A field may play several roles. */
export type FieldRole = 'output' | 'filter' | 'group' | 'metric';
export const FIELD_ROLES: FieldRole[] = ['output', 'filter', 'group', 'metric'];
export type MetricAggregation = 'count' | 'count_distinct' | 'sum' | 'avg' | 'ratio';
export const METRIC_AGGREGATIONS: MetricAggregation[] = [
  'count',
  'count_distinct',
  'sum',
  'avg',
  'ratio',
];

export interface ReportFieldDraft {
  /** The human-editable display text (a plain string, or an object's label/field). */
  text: string;
  /** Roles this field plays. Empty/absent means output-only (backward compatible). */
  roles: FieldRole[];
  /**
   * Optional free-text field description / 口径, helping the AI understand what the
   * field means when generating the report package (e.g. 订单数总和 → "订单数量的总和").
   * Absent/empty means no description. Persisted only when non-empty.
   */
  description?: string;
  /** Optional metric aggregation. Used only when the metric role is selected. */
  aggregation?: MetricAggregation;
  /** Present when the original entry was an object; preserved on merge. */
  raw?: Record<string, unknown>;
}

export interface ReportRequirementDraft {
  id: string;
  name: string;
  /** Free-text business notes / metric definitions (口径). Optional. */
  description: string;
  requiredFields: ReportFieldDraft[];
  /** Comparison (环比/同比) configuration for this report. */
  comparison?: {
    enabled: boolean;
    modes: string[];
    period_param: string;
    lookback_months: number;
  };
}

export interface ReportConfigDraft {
  requirements: ReportRequirementDraft[];
  scenarios: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Normalize an unknown roles value to a clean FieldRole[] (dedup, valid only). */
function normalizeRoles(value: unknown): FieldRole[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<FieldRole>();
  for (const item of value) {
    const r = String(item) as FieldRole;
    if (FIELD_ROLES.includes(r)) seen.add(r);
  }
  return FIELD_ROLES.filter((r) => seen.has(r));
}

/** Read a required-field entry (string or object) into an editable draft. */
function toFieldDraft(entry: unknown): ReportFieldDraft {
  if (typeof entry === 'string') return { text: entry, roles: [], description: '' };
  if (typeof entry === 'object' && entry !== null) {
    const rec = entry as Record<string, unknown>;
    const text =
      typeof rec.label === 'string'
        ? rec.label
        : typeof rec.field === 'string'
          ? rec.field
          : typeof rec.name === 'string'
            ? rec.name
            : '';
    return {
      text,
      roles: normalizeRoles(rec.roles),
      description: typeof rec.description === 'string' ? rec.description : '',
      aggregation: METRIC_AGGREGATIONS.includes(rec.aggregation as MetricAggregation)
        ? (rec.aggregation as MetricAggregation)
        : undefined,
      raw: rec,
    };
  }
  return { text: '', roles: [], description: '' };
}

/**
 * Serialize a field draft back to the config, preserving object bindings.
 * A field stays a plain string only when it has no binding AND no non-default
 * roles; otherwise it becomes an object carrying `label` (+ `field`, `roles`).
 */
function fromFieldDraft(f: ReportFieldDraft): string | Record<string, unknown> {
  const text = f.text.trim();
  const roles = normalizeRoles(f.roles ?? []);
  const description = (f.description ?? '').trim();
  // "output-only" is the default; don't persist it to keep configs clean.
  const meaningfulRoles = roles.filter((r) => r !== 'output');
  const nonOutputRoles = roles.length > 0 && (roles.length > 1 || roles[0] !== 'output');
  if (f.raw) {
    const out: Record<string, unknown> = { ...f.raw, label: text };
    if (roles.length) out.roles = roles;
    else delete out.roles;
    if (description) out.description = description;
    else delete out.description;
    if (roles.includes('metric') && f.aggregation) out.aggregation = f.aggregation;
    else delete out.aggregation;
    return out;
  }
  // No original object: only upgrade to an object when roles or a description
  // carry information beyond the plain field name.
  if (nonOutputRoles || meaningfulRoles.length || description) {
    const out: Record<string, unknown> = { label: text, roles };
    if (description) out.description = description;
    if (roles.includes('metric') && f.aggregation) out.aggregation = f.aggregation;
    return out;
  }
  return text;
}

/** True when a field draft carries no usable content (drop on merge). */
function isEmptyField(f: ReportFieldDraft): boolean {
  if (f.text.trim().length > 0) return false;
  // Keep an object entry only if it still has a field binding.
  return !(f.raw && typeof f.raw.field === 'string' && f.raw.field.trim().length > 0);
}

/** Read report_requirements + report_scenarios out of a build config value. */
export function extractReportConfig(configValue: unknown): ReportConfigDraft {
  const knowledge = asRecord(asRecord(configValue).knowledge);

  const rawReqs = Array.isArray(knowledge.report_requirements) ? knowledge.report_requirements : [];
  const requirements: ReportRequirementDraft[] = rawReqs.map((r) => {
    const rec = asRecord(r);
    const fields = Array.isArray(rec.required_fields)
      ? rec.required_fields.map(toFieldDraft)
      : [];
    const comp = rec.comparison as Record<string, unknown> | undefined;
    return {
      id: String(rec.id ?? ''),
      name: String(rec.name ?? ''),
      description: typeof rec.description === 'string' ? rec.description : '',
      requiredFields: fields,
      ...(comp && typeof comp.enabled === 'boolean' ? {
        comparison: {
          enabled: Boolean(comp.enabled),
          modes: Array.isArray(comp.modes) ? comp.modes.map(String) : [],
          period_param: String(comp.period_param ?? ''),
          lookback_months: Number(comp.lookback_months ?? 1),
        },
      } : {}),
    };
  });

  const rawScenarios = Array.isArray(knowledge.report_scenarios) ? knowledge.report_scenarios : [];
  const scenarios = rawScenarios.map((s) => String(s));

  return { requirements, scenarios };
}

/** Serialize one requirement draft to its on-disk config object. */
function requirementToConfig(r: ReportRequirementDraft): Record<string, unknown> {
  const req: Record<string, unknown> = {
    id: r.id.trim(),
    name: r.name.trim(),
    required_fields: r.requiredFields.filter((f) => !isEmptyField(f)).map(fromFieldDraft),
  };
  const desc = (r.description ?? '').trim();
  if (desc) req.description = desc;
  if (r.comparison?.enabled) {
    req.comparison = {
      enabled: true,
      modes: r.comparison.modes,
      period_param: r.comparison.period_param,
      lookback_months: r.comparison.lookback_months,
    };
  }
  return req;
}

/**
 * Merge an edited draft back into the full build config value, preserving all
 * other keys and object identity of untouched branches. Empty field entries are
 * dropped; requirement order is preserved; object field bindings are retained.
 */
export function mergeReportConfig(configValue: unknown, draft: ReportConfigDraft): unknown {
  const root = { ...asRecord(configValue) };
  const knowledge = { ...asRecord(root.knowledge) };

  knowledge.report_requirements = draft.requirements.map(requirementToConfig);
  knowledge.report_scenarios = draft.scenarios.map((s) => s.trim()).filter((s) => s.length > 0);

  root.knowledge = knowledge;
  return root;
}

/**
 * Upsert a single requirement into the full build config, preserving every other
 * requirement and all other config branches. Matches an existing entry by its
 * (original) id — same id overwrites in place, a new id appends. Used by the
 * single-report editor so editing one report never rewrites the others.
 */
export function upsertRequirementIntoConfig(
  configValue: unknown,
  requirement: ReportRequirementDraft,
  originalId?: string,
): unknown {
  const root = { ...asRecord(configValue) };
  const knowledge = { ...asRecord(root.knowledge) };
  const existing = Array.isArray(knowledge.report_requirements)
    ? [...knowledge.report_requirements]
    : [];
  const matchId = (originalId ?? requirement.id).trim();
  const serialized = requirementToConfig(requirement);
  const index = existing.findIndex((r) => String(asRecord(r).id ?? '').trim() === matchId);
  if (index >= 0) existing[index] = serialized;
  else existing.push(serialized);
  knowledge.report_requirements = existing;
  root.knowledge = knowledge;
  return root;
}

/**
 * Append a one-report scope to either the modeling or package-generation preset.
 */
export function buildScopedReportPrompt(
  basePrompt: string,
  report: { id: string; name: string },
  action = 'model-report',
): string {
  const id = report.id.trim();
  const name = report.name.trim();
  const label = name && name !== id ? `${id}（${name}）` : id;
  const instruction =
    action === 'build-report-package'
      ? '只使用该报表已确认的当前模型生成报表包，不得重新建模、读取完整知识库或再次确认业务口径。'
      : '只执行基础建模，把不清晰事项整理为一次统一确认，不得提前生成 SQL、脚本或报表包。';
  const scope = `\n\n本次仅处理报表 ${label}，忽略 config 中的其它 report_requirements；${instruction}`;
  return `${basePrompt}${scope}`;
}

/** Helper for the editor: make a new empty field draft (output-only default). */
export function newField(): ReportFieldDraft {
  return { text: '', roles: [], description: '' };
}

/** Whether a field currently plays a given role (empty roles ⇒ output-only). */
export function hasRole(f: ReportFieldDraft, role: FieldRole): boolean {
  const roles = f.roles ?? [];
  if (role === 'output') return roles.length === 0 || roles.includes('output');
  return roles.includes(role);
}

/** Toggle a role on a field, returning a new draft. */
export function toggleRole(f: ReportFieldDraft, role: FieldRole): ReportFieldDraft {
  const current = f.roles ?? [];
  const set = new Set(current.length ? current : (['output'] as FieldRole[]));
  if (set.has(role)) set.delete(role);
  else set.add(role);
  // Never end up with an empty set — fall back to output-only.
  const roles = FIELD_ROLES.filter((r) => set.has(r));
  const nextRoles: FieldRole[] = roles.length ? roles : ['output'];
  return {
    ...f,
    roles: nextRoles,
    ...(nextRoles.includes('metric')
      ? { aggregation: f.aggregation ?? 'count_distinct' }
      : { aggregation: undefined }),
  };
}

/** Read the optional field binding (db.table.column) from a draft field. */
export function fieldBinding(f: ReportFieldDraft): string {
  return f.raw && typeof f.raw.field === 'string' ? f.raw.field : '';
}

/**
 * Set/clear the optional field binding. A non-empty binding becomes an object
 * entry ({ field, label }); clearing it reverts to a plain string (dropping any
 * other object keys, which are Studio-authored, not skill-critical).
 */
export function setFieldBinding(f: ReportFieldDraft, binding: string): ReportFieldDraft {
  const trimmed = binding.trim();
  const roles = f.roles ?? [];
  // Only carry `description` when it holds content, so callers comparing plain
  // (text, roles) drafts by value keep matching.
  const desc = (f.description ?? '').trim();
  const carry = {
    ...(desc ? { description: f.description } : {}),
    ...(f.aggregation ? { aggregation: f.aggregation } : {}),
  };
  if (!trimmed) return { text: f.text, roles, ...carry };
  return {
    text: f.text,
    roles,
    ...carry,
    raw: { ...(f.raw ?? {}), field: trimmed, label: f.text },
  };
}

/** Default roles applied to a plainly-imported field: output + filter (no group). */
const IMPORT_DEFAULT_ROLES: FieldRole[] = ['output', 'filter'];

/**
 * Derive a stable, filesystem-safe report id from a name when none is given.
 * ASCII names slugify directly; Chinese/other names fall back to `report-<n>`.
 */
function deriveReportId(name: string, index: number): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `report-${index + 1}`;
}

/** Read one imported field into a draft, defaulting roles to output+filter. */
function toImportedFieldDraft(entry: unknown): ReportFieldDraft {
  if (typeof entry === 'string') {
    return { text: entry, roles: [...IMPORT_DEFAULT_ROLES], description: '' };
  }
  if (typeof entry === 'object' && entry !== null) {
    const base = toFieldDraft(entry);
    // Honor explicit roles if provided; otherwise apply the import default.
    // (Description round-trips through toFieldDraft already.)
    return base.roles.length ? base : { ...base, roles: [...IMPORT_DEFAULT_ROLES] };
  }
  return { text: '', roles: [...IMPORT_DEFAULT_ROLES], description: '' };
}

/**
 * Parse a pasted/uploaded JSON payload into report requirements + scenarios.
 * The minimal shape is just a name + field names — ids are auto-derived and each
 * field defaults to the output+filter roles (never group). Accepts, in order:
 *   - a bare requirements array: [ { name, fields: ["甲","乙"] }, ... ]
 *   - an object: { report_requirements: [...], report_scenarios: [...] }
 *   - a full build config: { knowledge: { report_requirements, report_scenarios } }
 *   - a single requirement object: { name, fields }
 * Each requirement's fields may be under `fields` or `required_fields`, and a
 * field may be a plain string or an object { field, label, roles }. Throws a
 * Chinese error on malformed JSON or when no requirements can be found.
 */
export function parseImportedReports(text: string): {
  requirements: ReportRequirementDraft[];
  scenarios: string[];
} {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('导入内容为空');
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('不是合法的 JSON，请检查格式');
  }

  // Locate the requirements array and (optional) scenarios across the shapes.
  let rawReqs: unknown;
  let rawScenarios: unknown;
  if (Array.isArray(parsed)) {
    rawReqs = parsed;
  } else {
    const obj = asRecord(parsed);
    const knowledge = asRecord(obj.knowledge);
    if (Array.isArray(knowledge.report_requirements) || Array.isArray(knowledge.report_scenarios)) {
      rawReqs = knowledge.report_requirements;
      rawScenarios = knowledge.report_scenarios;
    } else if (
      Array.isArray(obj.report_requirements) ||
      Array.isArray(obj.report_scenarios)
    ) {
      rawReqs = obj.report_requirements;
      rawScenarios = obj.report_scenarios;
    } else if (
      obj.id !== undefined ||
      obj.name !== undefined ||
      obj.fields !== undefined ||
      obj.required_fields !== undefined
    ) {
      // A single requirement object.
      rawReqs = [obj];
    }
  }

  if (!Array.isArray(rawReqs)) {
    throw new Error(
      '未找到报表需求。最简格式：[{ "name": "报表名", "fields": ["字段一", "字段二"] }]',
    );
  }

  const requirements: ReportRequirementDraft[] = rawReqs.map((r, index) => {
    const rec = asRecord(r);
    // Fields may be under `fields` (simple) or `required_fields` (config shape).
    const rawFields = Array.isArray(rec.fields)
      ? rec.fields
      : Array.isArray(rec.required_fields)
        ? rec.required_fields
        : [];
    const name = String(rec.name ?? '');
    const id = String(rec.id ?? '').trim() || deriveReportId(name, index);
    return {
      id,
      name,
      description: typeof rec.description === 'string' ? rec.description : '',
      requiredFields: rawFields.map(toImportedFieldDraft),
    };
  });
  if (requirements.length === 0) throw new Error('导入的报表需求为空');

  const scenarios = Array.isArray(rawScenarios) ? rawScenarios.map((s) => String(s)) : [];
  return { requirements, scenarios };
}

/**
 * Apply imported requirements/scenarios onto an existing draft. In "merge" mode,
 * imported requirements replace same-id existing ones and new ids are appended;
 * scenarios are unioned. In "replace" mode the imported set wins outright.
 */
export function applyImport(
  draft: ReportConfigDraft,
  imported: { requirements: ReportRequirementDraft[]; scenarios: string[] },
  mode: 'merge' | 'replace',
): ReportConfigDraft {
  if (mode === 'replace') {
    return {
      requirements: imported.requirements,
      scenarios: imported.scenarios.length ? imported.scenarios : draft.scenarios,
    };
  }
  const byId = new Map<string, ReportRequirementDraft>();
  const order: string[] = [];
  const push = (r: ReportRequirementDraft): void => {
    const key = r.id.trim() || `__noid_${order.length}`;
    if (!byId.has(key)) order.push(key);
    byId.set(key, r);
  };
  for (const r of draft.requirements) push(r);
  for (const r of imported.requirements) push(r);
  const requirements = order.map((k) => byId.get(k)!);

  const scenarios = [...draft.scenarios];
  for (const s of imported.scenarios) {
    if (!scenarios.includes(s)) scenarios.push(s);
  }
  return { requirements, scenarios };
}

/** Serialize the current draft's report branch to pretty JSON for export/copy. */
export function exportReportsJson(draft: ReportConfigDraft): string {
  const requirements = draft.requirements.map((r) => {
    const req: Record<string, unknown> = {
      id: r.id.trim(),
      name: r.name.trim(),
      required_fields: r.requiredFields.filter((f) => !isEmptyField(f)).map(fromFieldDraft),
    };
    const desc = (r.description ?? '').trim();
    if (desc) req.description = desc;
    return req;
  });
  const scenarios = draft.scenarios.map((s) => s.trim()).filter((s) => s.length > 0);
  return JSON.stringify({ report_requirements: requirements, report_scenarios: scenarios }, null, 2);
}

/** Validate a single requirement draft; returns a Chinese error or null. */
export function validateRequirement(r: ReportRequirementDraft): string | null {
  const id = r.id.trim();
  const name = r.name.trim();
  if (!id) return '报表必须填写 ID';
  if (!name) return `报表「${id}」缺少名称`;
  // A field binding without a field name is invalid — the name is required.
  for (const f of r.requiredFields) {
    if (!f.text.trim() && fieldBinding(f)) {
      return `报表「${name}」有一个字段填写了绑定但缺少字段名`;
    }
  }
  return null;
}

/** Validate a draft; returns a Chinese error message or null when valid. */
export function validateReportConfig(draft: ReportConfigDraft): string | null {
  const ids = new Set<string>();
  for (const r of draft.requirements) {
    const single = validateRequirement(r);
    if (single) return single;
    const id = r.id.trim();
    if (ids.has(id)) return `报表 ID 重复：${id}`;
    ids.add(id);
  }
  return null;
}
