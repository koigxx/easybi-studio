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
export type ReportFieldKind = 'data' | 'metric' | 'formula' | 'comparison' | 'window' | 'merge';
export const REPORT_FIELD_KINDS: ReportFieldKind[] = [
  'data',
  'metric',
  'formula',
  'comparison',
  'window',
  'merge',
];
export type MetricAggregation =
  | 'count'
  | 'count_distinct'
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'first'
  | 'last'
  | 'ratio';
export const METRIC_AGGREGATIONS: MetricAggregation[] = [
  'count',
  'count_distinct',
  'sum',
  'avg',
  'min',
  'max',
  'first',
  'last',
  'ratio',
];

/** Optional user-facing fallback binding. The legacy `field` mirror remains for Skill compatibility. */
export interface ReportFieldBindingDraft {
  mode: 'auto' | 'manual' | 'pending';
  field: string;
  profileId?: string;
  database?: string;
  table?: string;
}

export type MetricConditionOperator =
  | 'eq'
  | 'ne'
  | 'in'
  | 'not_in'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'is_null'
  | 'not_null';

export interface ReportMetricConditionDraft {
  field: string;
  operator: MetricConditionOperator;
  values?: string[];
}

/** Business-level metric details. These are intentionally free of SQL and table aliases. */
export interface ReportMetricDraft {
  aggregation?: MetricAggregation;
  sourceField?: string;
  distinctField?: string;
  conditions?: ReportMetricConditionDraft[];
}

export interface ReportFieldDraft {
  /** Stable field identity. Hidden in the ordinary editor and preserved across label changes. */
  id?: string;
  /** The human-editable display text (a plain string, or an object's label/field). */
  text: string;
  /** `data` is the backwards-compatible default. */
  kind?: ReportFieldKind;
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
  /** Optional structured physical binding used when AI needs an explicit fallback. */
  binding?: ReportFieldBindingDraft;
  /** Optional metric source, distinct key, and structured business conditions. */
  metric?: ReportMetricDraft;
  /** Optional filter presentation settings. Physical type/operator still default from knowledge. */
  filter?: { required?: boolean; operator?: string; multiple?: boolean; defaultValue?: unknown };
  /** Optional time interpretation override. `auto` keeps the create_time default policy. */
  time?: { role?: 'auto' | 'default_filter' | 'comparison'; granularity?: 'auto' | 'day' | 'month' | 'year' };
  /** Optional output-only formatting. Never participates in SQL or calculation semantics. */
  display?: { type?: string; format?: string; unit?: string; decimalPlaces?: number };
  /** Present when the original entry was an object; preserved on merge. */
  raw?: Record<string, unknown>;
}

export interface ReportRequirementDraft {
  id: string;
  name: string;
  /** Free-text business notes / metric definitions (口径). Optional. */
  description: string;
  requiredFields: ReportFieldDraft[];
  /** Plain-language result grain. Stable keys are optional technical fallbacks. */
  resultGrain?: { description: string; keys?: string[] };
  /** Optional inclusion/exclusion explanation used by modeling, never rendered as SQL. */
  scope?: { include?: string; exclude?: string };
  /** Optional report-level time preference; missing means automatic knowledge-driven selection. */
  timeSemantics?: {
    field?: string;
    granularity?: 'auto' | 'day' | 'month' | 'year';
    defaultFilter?: boolean;
  };
  /** Manual relationship fallback for knowledge bases without usable relationship evidence. */
  relationshipOverrides?: Array<{
    from: string;
    to: string;
    type: 'left' | 'inner';
    cardinality: '1:1' | 'n:1' | '1:n' | 'n:n';
    description?: string;
  }>;
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

function normalizeFieldKind(value: unknown): ReportFieldKind | undefined {
  const kind = String(value ?? '') as ReportFieldKind;
  return REPORT_FIELD_KINDS.includes(kind) ? kind : undefined;
}

function normalizeAggregation(value: unknown): MetricAggregation | undefined {
  const aggregation = String(value ?? '') as MetricAggregation;
  return METRIC_AGGREGATIONS.includes(aggregation) ? aggregation : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.map(String).map((item) => item.trim()).filter(Boolean);
  return result.length ? result : undefined;
}

function readBinding(rec: Record<string, unknown>): ReportFieldBindingDraft | undefined {
  if (!rec.binding && !rec.binding_mode) return undefined;
  const binding = asRecord(rec.binding);
  const field = String(binding.field ?? rec.field ?? rec.physical_field ?? '').trim();
  if (!field) return undefined;
  const mode = String(binding.mode ?? rec.binding_mode ?? 'manual');
  return {
    mode: mode === 'auto' || mode === 'pending' ? mode : 'manual',
    field,
    ...(typeof binding.profile_id === 'string' && binding.profile_id.trim()
      ? { profileId: binding.profile_id.trim() }
      : {}),
    ...(typeof binding.database === 'string' && binding.database.trim()
      ? { database: binding.database.trim() }
      : {}),
    ...(typeof binding.table === 'string' && binding.table.trim()
      ? { table: binding.table.trim() }
      : {}),
  };
}

function readMetric(rec: Record<string, unknown>): ReportMetricDraft | undefined {
  const metric = asRecord(rec.metric);
  const aggregation = normalizeAggregation(metric.aggregation ?? rec.aggregation);
  const sourceField = String(metric.source_field ?? rec.source_field ?? '').trim();
  const distinctField = String(metric.distinct_field ?? rec.distinct_field ?? '').trim();
  const conditions = Array.isArray(metric.conditions)
    ? metric.conditions
        .filter((value) => typeof value === 'object' && value !== null && !Array.isArray(value))
        .map((value) => {
          const condition = value as Record<string, unknown>;
          const field = String(condition.field ?? '').trim();
          const operator = String(condition.operator ?? '') as MetricConditionOperator;
          const allowed = ['eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'is_null', 'not_null'];
          if (!field || !allowed.includes(operator)) return null;
          const values = normalizeStringArray(condition.values);
          return { field, operator, ...(values ? { values } : {}) };
        })
        .filter((condition): condition is NonNullable<typeof condition> => condition !== null)
    : [];
  if (!aggregation && !sourceField && !distinctField && !conditions.length) return undefined;
  return {
    ...(aggregation ? { aggregation } : {}),
    ...(sourceField ? { sourceField } : {}),
    ...(distinctField ? { distinctField } : {}),
    ...(conditions.length ? { conditions } : {}),
  };
}

function readFilter(rec: Record<string, unknown>): ReportFieldDraft['filter'] | undefined {
  const filter = asRecord(rec.filter);
  const required = typeof filter.required === 'boolean' ? filter.required : undefined;
  const operator = typeof filter.operator === 'string' && filter.operator.trim()
    ? filter.operator.trim()
    : undefined;
  const multiple = typeof filter.multiple === 'boolean' ? filter.multiple : undefined;
  const defaultValue = filter.default_value ?? filter.defaultValue;
  if (required === undefined && !operator && multiple === undefined && defaultValue === undefined) return undefined;
  return {
    ...(required !== undefined ? { required } : {}),
    ...(operator ? { operator } : {}),
    ...(multiple !== undefined ? { multiple } : {}),
    ...(defaultValue !== undefined ? { defaultValue } : {}),
  };
}

function readTime(rec: Record<string, unknown>): ReportFieldDraft['time'] | undefined {
  const time = asRecord(rec.time);
  const role = String(time.role ?? '');
  const granularity = String(time.granularity ?? '');
  const validRole = ['auto', 'default_filter', 'comparison'].includes(role)
    ? (role as NonNullable<ReportFieldDraft['time']>['role'])
    : undefined;
  const validGranularity = ['auto', 'day', 'month', 'year'].includes(granularity)
    ? (granularity as NonNullable<ReportFieldDraft['time']>['granularity'])
    : undefined;
  return validRole || validGranularity
    ? { ...(validRole ? { role: validRole } : {}), ...(validGranularity ? { granularity: validGranularity } : {}) }
    : undefined;
}

function readDisplay(rec: Record<string, unknown>): ReportFieldDraft['display'] | undefined {
  const display = asRecord(rec.display);
  const type = typeof display.type === 'string' && display.type.trim() ? display.type.trim() : undefined;
  const format = typeof display.format === 'string' && display.format.trim() ? display.format.trim() : undefined;
  const unit = typeof display.unit === 'string' && display.unit.trim() ? display.unit.trim() : undefined;
  const decimalPlaces = Number.isInteger(display.decimal_places ?? display.decimalPlaces)
    ? Number(display.decimal_places ?? display.decimalPlaces)
    : undefined;
  return type || format || unit || decimalPlaces !== undefined
    ? { ...(type ? { type } : {}), ...(format ? { format } : {}), ...(unit ? { unit } : {}), ...(decimalPlaces !== undefined ? { decimalPlaces } : {}) }
    : undefined;
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
      id: typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : undefined,
      text,
      kind: normalizeFieldKind(rec.kind),
      roles: normalizeRoles(rec.roles),
      description: typeof rec.description === 'string' ? rec.description : '',
      aggregation: normalizeAggregation(rec.aggregation),
      binding: readBinding(rec),
      metric: readMetric(rec),
      filter: readFilter(rec),
      time: readTime(rec),
      display: readDisplay(rec),
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
  const metric = f.metric ?? {};
  const aggregation = f.aggregation ?? metric.aggregation;
  const binding = f.binding;
  const hasStructuredConfig =
    !!f.id ||
    !!f.kind ||
    !!binding ||
    !!f.metric ||
    !!f.filter ||
    !!f.time ||
    !!f.display;
  if (f.raw || hasStructuredConfig) {
    const out: Record<string, unknown> = { ...f.raw, label: text };
    if (f.id?.trim()) out.id = f.id.trim();
    else delete out.id;
    if (f.kind && f.kind !== 'data') out.kind = f.kind;
    else delete out.kind;
    if (roles.length) out.roles = roles;
    else delete out.roles;
    if (description) out.description = description;
    else delete out.description;
    if ((roles.includes('metric') || f.kind === 'metric') && aggregation) out.aggregation = aggregation;
    else delete out.aggregation;
    if (binding?.field.trim()) {
      out.field = binding.field.trim();
      out.binding_mode = binding.mode;
      out.binding = {
        mode: binding.mode,
        field: binding.field.trim(),
        ...(binding.profileId ? { profile_id: binding.profileId } : {}),
        ...(binding.database ? { database: binding.database } : {}),
        ...(binding.table ? { table: binding.table } : {}),
      };
    } else {
      delete out.binding;
      delete out.binding_mode;
      if (f.raw && typeof f.raw.field === 'string') out.field = f.raw.field;
    }
    const conditions = metric.conditions?.map((condition) => ({
      field: condition.field,
      operator: condition.operator,
      ...(condition.values?.length ? { values: condition.values } : {}),
    }));
    if (metric.sourceField || metric.distinctField || conditions?.length) {
      out.metric = {
        ...(metric.sourceField ? { source_field: metric.sourceField } : {}),
        ...(metric.distinctField ? { distinct_field: metric.distinctField } : {}),
        ...(conditions?.length ? { conditions } : {}),
      };
    } else delete out.metric;
    if (f.filter && Object.keys(f.filter).length) out.filter = f.filter;
    if (f.time && Object.keys(f.time).length) out.time = f.time;
    if (f.display && Object.keys(f.display).length) out.display = f.display;
    return out;
  }
  // No original object: only upgrade to an object when roles or a description
  // carry information beyond the plain field name.
  if (nonOutputRoles || meaningfulRoles.length || description) {
    const out: Record<string, unknown> = { label: text, roles };
    if (description) out.description = description;
    if (roles.includes('metric') && aggregation) out.aggregation = aggregation;
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

function readResultGrain(rec: Record<string, unknown>): ReportRequirementDraft['resultGrain'] | undefined {
  const grain = asRecord(rec.result_grain);
  const description = typeof grain.description === 'string' ? grain.description.trim() : '';
  const keys = normalizeStringArray(grain.keys);
  return description || keys ? { ...(description ? { description } : { description: '' }), ...(keys ? { keys } : {}) } : undefined;
}

function readScope(rec: Record<string, unknown>): ReportRequirementDraft['scope'] | undefined {
  const scope = asRecord(rec.scope);
  const include = typeof scope.include === 'string' && scope.include.trim() ? scope.include.trim() : undefined;
  const exclude = typeof scope.exclude === 'string' && scope.exclude.trim() ? scope.exclude.trim() : undefined;
  return include || exclude ? { ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) } : undefined;
}

function readTimeSemantics(rec: Record<string, unknown>): ReportRequirementDraft['timeSemantics'] | undefined {
  const time = asRecord(rec.time_semantics);
  const field = typeof time.field === 'string' && time.field.trim() ? time.field.trim() : undefined;
  const granularity = ['auto', 'day', 'month', 'year'].includes(String(time.granularity))
    ? (String(time.granularity) as NonNullable<ReportRequirementDraft['timeSemantics']>['granularity'])
    : undefined;
  const defaultFilter = typeof time.default_filter === 'boolean' ? time.default_filter : undefined;
  return field || granularity || defaultFilter !== undefined
    ? { ...(field ? { field } : {}), ...(granularity ? { granularity } : {}), ...(defaultFilter !== undefined ? { defaultFilter } : {}) }
    : undefined;
}

function readRelationshipOverrides(rec: Record<string, unknown>): ReportRequirementDraft['relationshipOverrides'] | undefined {
  if (!Array.isArray(rec.relationship_overrides)) return undefined;
  const result = rec.relationship_overrides
    .filter((value) => typeof value === 'object' && value !== null && !Array.isArray(value))
    .map((value) => {
      const relationship = value as Record<string, unknown>;
      const from = String(relationship.from ?? '').trim();
      const to = String(relationship.to ?? '').trim();
      const type = String(relationship.type ?? '').toLowerCase();
      const cardinality = String(relationship.cardinality ?? '').toLowerCase();
      if (!from || !to || !['left', 'inner'].includes(type) || !['1:1', 'n:1', '1:n', 'n:n'].includes(cardinality)) return null;
      const description = typeof relationship.description === 'string' && relationship.description.trim()
        ? relationship.description.trim()
        : undefined;
      return { from, to, type: type as 'left' | 'inner', cardinality: cardinality as '1:1' | 'n:1' | '1:n' | 'n:n', ...(description ? { description } : {}) };
    })
    .filter((relationship): relationship is NonNullable<typeof relationship> => relationship !== null);
  return result.length ? result : undefined;
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
      resultGrain: readResultGrain(rec),
      scope: readScope(rec),
      timeSemantics: readTimeSemantics(rec),
      relationshipOverrides: readRelationshipOverrides(rec),
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
  if (r.resultGrain?.description.trim() || r.resultGrain?.keys?.length) {
    req.result_grain = {
      ...(r.resultGrain.description.trim() ? { description: r.resultGrain.description.trim() } : {}),
      ...(r.resultGrain.keys?.map((key) => key.trim()).filter(Boolean).length
        ? { keys: r.resultGrain.keys.map((key) => key.trim()).filter(Boolean) }
        : {}),
    };
  }
  if (r.scope?.include?.trim() || r.scope?.exclude?.trim()) {
    req.scope = {
      ...(r.scope.include?.trim() ? { include: r.scope.include.trim() } : {}),
      ...(r.scope.exclude?.trim() ? { exclude: r.scope.exclude.trim() } : {}),
    };
  }
  if (r.timeSemantics?.field?.trim() || r.timeSemantics?.granularity || r.timeSemantics?.defaultFilter !== undefined) {
    req.time_semantics = {
      ...(r.timeSemantics.field?.trim() ? { field: r.timeSemantics.field.trim() } : {}),
      ...(r.timeSemantics.granularity ? { granularity: r.timeSemantics.granularity } : {}),
      ...(r.timeSemantics.defaultFilter !== undefined ? { default_filter: r.timeSemantics.defaultFilter } : {}),
    };
  }
  if (r.relationshipOverrides?.length) {
    req.relationship_overrides = r.relationshipOverrides.map((relationship) => ({
      from: relationship.from.trim(),
      to: relationship.to.trim(),
      type: relationship.type,
      cardinality: relationship.cardinality,
      ...(relationship.description?.trim() ? { description: relationship.description.trim() } : {}),
    }));
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
      : action === 'modify-report-model'
        ? '该报表已有当前模型。请在现有模型与知识库范围内理解用户的修改请求，只做定向修改，不得重新跑完整建模流程。'
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
  return f.binding?.field ?? (f.raw && typeof f.raw.field === 'string' ? f.raw.field : '');
}

/**
 * Set/clear the optional field binding. A non-empty binding becomes an object
 * entry ({ field, label }); clearing it reverts to a plain string (dropping any
 * other object keys, which are Studio-authored, not skill-critical).
 */
export function setFieldBinding(f: ReportFieldDraft, binding: string): ReportFieldDraft {
  const trimmed = binding.trim();
  if (!trimmed) {
    const { field: _legacyField, physical_field: _physicalField, binding: _binding, binding_mode: _mode, label: _label, ...remaining } = f.raw ?? {};
    const { binding: _draftBinding, raw: _draftRaw, ...base } = f;
    return {
      ...base,
      ...(Object.keys(remaining).length ? { raw: remaining } : {}),
    };
  }
  return {
    ...f,
    binding: f.binding ? { ...f.binding, mode: 'manual', field: trimmed } : undefined,
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

  // Reuse the canonical config reader so a standard export round-trips every
  // modern report-level and field-level structure instead of silently dropping it.
  const canonicalRequirements = rawReqs.map((value) => {
    const record = asRecord(value);
    return !Array.isArray(record.required_fields) && Array.isArray(record.fields)
      ? { ...record, required_fields: record.fields }
      : value;
  });
  const canonical = extractReportConfig({
    knowledge: { report_requirements: canonicalRequirements, report_scenarios: rawScenarios ?? [] },
  });
  const requirements: ReportRequirementDraft[] = canonical.requirements.map((requirement, index) => ({
    ...requirement,
    id: requirement.id.trim() || deriveReportId(requirement.name, index),
    requiredFields: requirement.requiredFields.map((field) =>
      field.roles.length ? field : toImportedFieldDraft(field.raw ?? field.text),
    ),
  }));
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
  const requirements = draft.requirements.map(requirementToConfig);
  const scenarios = draft.scenarios.map((s) => s.trim()).filter((s) => s.length > 0);
  return JSON.stringify({
    easybi_report_config_format: '1',
    exported_at: new Date().toISOString(),
    report_requirements: requirements,
    report_scenarios: scenarios,
  }, null, 2);
}

export function previewReportImport(
  current: ReportConfigDraft,
  imported: { requirements: ReportRequirementDraft[]; scenarios: string[] },
): { create: string[]; update: string[]; fields: number; metrics: number; scenarios: number } {
  const currentIds = new Set(current.requirements.map((item) => item.id));
  const create: string[] = [];
  const update: string[] = [];
  let fields = 0;
  let metrics = 0;
  for (const requirement of imported.requirements) {
    (currentIds.has(requirement.id) ? update : create).push(requirement.name || requirement.id);
    fields += requirement.requiredFields.length;
    metrics += requirement.requiredFields.filter((field) => field.kind === 'metric' || field.roles.includes('metric')).length;
  }
  return { create, update, fields, metrics, scenarios: imported.scenarios.length };
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
