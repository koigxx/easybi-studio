import { randomUUID } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import {
  mkdir,
  readFile,
  stat,
  unlink,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ExcelJS from "exceljs";
import mysql from "mysql2";
import {
  FLAG_OPERATOR_SYMBOLS,
  hasSkeletonInjection,
  hasUnsafeSqlExpression,
  isBareQuotedColumnRef,
  isValidExistsSkeleton,
} from "./sql-guard.js";
import {
  runScriptIsolated,
  ScriptExecutionError,
  type ScriptQueryHandlers,
} from "./script-runtime.js";

type JsonRecord = Record<string, any>;

export class RuntimeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export type LoadedReport = {
  root: string;
  manifest: JsonRecord;
  fields: JsonRecord;
  parameters: JsonRecord;
  bindings: JsonRecord;
  knowledgeLock: JsonRecord;
  sql: string;
  script?: string | null;
  scriptQueries?: JsonRecord[];
  /** Optional per-field enum code→中文 map; absent in older packages. */
  enums?: JsonRecord | null;
};

export type TransformPipeline =
  | { mode: "identity" }
  | { mode: "row"; transformRow: (row: JsonRecord) => JsonRecord }
  | {
      mode: "group";
      groupKeys: string[];
      maxGroupRows: number;
      transformGroup: (
        rows: JsonRecord[],
        context: { groupKey: unknown[] },
      ) => JsonRecord | JsonRecord[];
    };

export type ExportRequest = {
  reportId: string;
  reportVersion?: string;
  filters?: Record<string, unknown>;
  context?: Record<string, unknown>;
  tenantId?: string | number;
  executionMode?: "sync" | "async";
};

type RuntimeContext = {
  workspace: string;
  config: JsonRecord;
};

async function readJson(path: string): Promise<JsonRecord> {
  return JSON.parse(await readFile(path, "utf8")) as JsonRecord;
}

function relativeToWorkspace(workspace: string, value: string): string {
  return resolve(workspace, value);
}

function latestVersion(entries: JsonRecord[]): JsonRecord {
  return [...entries].sort((left, right) =>
    String(right.version).localeCompare(String(left.version), undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  )[0]!;
}

export async function loadRuntimeContext(workspaceValue: string): Promise<RuntimeContext> {
  const workspace = resolve(workspaceValue);
  const config = await readJson(join(workspace, "toolkit", "config", "runtime.json"));
  return { workspace, config };
}

export async function listReports(workspaceValue: string): Promise<JsonRecord[]> {
  const workspace = resolve(workspaceValue);
  const index = await readJson(join(workspace, "reports", "index.json"));
  const reports = Array.isArray(index.reports) ? index.reports : [];
  const byId = new Map<string, JsonRecord[]>();
  for (const report of reports) {
    const id = String(report.id ?? "");
    if (!id) continue;
    byId.set(id, [...(byId.get(id) ?? []), report]);
  }
  const latest = [...byId.values()].map((versions) => latestVersion(versions));
  const result = await Promise.all(
    latest.map(async (report) => {
      const loaded = await loadReportPackage(
        workspace,
        String(report.id),
        String(report.version),
      );
      const manifest = loaded.manifest;
      return {
        id: report.id,
        name: report.name,
        version: report.version,
        description: manifest.description ?? "",
        category: manifest.category ?? "",
        status: report.status,
        developmentOnly: Boolean(report.development_only),
        executionPolicy: {
          supportedModes:
            manifest.execution_policy?.supported_modes ?? ["sync", "async"],
          defaultMode: manifest.execution_policy?.default_mode ?? "sync",
        },
      };
    }),
  );
  return result.sort((left, right) =>
    String(left.name).localeCompare(String(right.name), "zh-CN"),
  );
}

export async function loadReportPackage(
  workspaceValue: string,
  reportId: string,
  reportVersion?: string,
): Promise<LoadedReport> {
  const workspace = resolve(workspaceValue);
  const index = await readJson(join(workspace, "reports", "index.json"));
  const candidates = (index.reports ?? []).filter(
    (entry: JsonRecord) =>
      entry.id === reportId && (!reportVersion || entry.version === reportVersion),
  );
  if (!candidates.length) {
    throw new RuntimeError("REPORT_NOT_FOUND", `未找到报表：${reportId}`);
  }
  const entry = reportVersion ? candidates[0] : latestVersion(candidates);
  const root = join(workspace, "reports", String(entry.path));
  const manifest = await readJson(join(root, "report.manifest.json"));
  const packageFormat = String(manifest.report_package_format_version ?? "");
  if (packageFormat !== "2" && packageFormat !== "3") {
    throw new RuntimeError(
      "UNSUPPORTED_REPORT_PACKAGE_FORMAT",
      `Runtime 不支持报表包格式 ${packageFormat}`,
    );
  }
  const entrypoints = manifest.entrypoints ?? {};
  if (packageFormat === "3") {
    return {
      root,
      manifest,
      fields: await readJson(join(root, entrypoints.fields ?? "fields.json")),
      parameters: await readJson(join(root, entrypoints.parameters ?? "parameters.schema.json")),
      bindings: {},
      knowledgeLock: await readJson(join(root, entrypoints.knowledge_lock ?? "knowledge.lock.json")),
      sql: "",
      script: await readFile(join(root, entrypoints.script ?? "scripts/report.mjs"), "utf8"),
      scriptQueries: manifest.queries ?? [],
      enums: entrypoints.enums
        ? await readJson(join(root, String(entrypoints.enums))).catch(() => null)
        : null,
    };
  }
  return {
    root,
    manifest,
    fields: await readJson(join(root, entrypoints.fields ?? "fields.json")),
    parameters: await readJson(
      join(root, entrypoints.parameters ?? "parameters.schema.json"),
    ),
    bindings: await readJson(
      join(root, entrypoints.bindings ?? "queries/bindings.json"),
    ),
    knowledgeLock: await readJson(
      join(root, entrypoints.knowledge_lock ?? "knowledge.lock.json"),
    ),
    sql: await readFile(join(root, entrypoints.query ?? "queries/main.sql"), "utf8"),
    enums: entrypoints.enums
      ? await readJson(join(root, String(entrypoints.enums))).catch(() => null)
      : null,
  };
}

export async function getReportParameters(
  workspace: string,
  reportId: string,
  reportVersion?: string,
): Promise<JsonRecord> {
  const report = await loadReportPackage(workspace, reportId, reportVersion);
  return {
    reportId: report.manifest.id,
    reportName: report.manifest.name,
    reportVersion: report.manifest.version,
    parameters: (report.parameters.parameters ?? []).map((parameter: JsonRecord) => ({
      id: parameter.id,
      label: parameter.label,
      valueType: parameter.value_type,
      // Stable front-end data-type tag: string | number | datetime | date | enum |
      // boolean | datetime_range | date_range | number_range. Falls back to
      // value_type for older packages that predate the explicit tag.
      dataType: parameter.data_type ?? parameter.value_type,
      component: parameter.component,
      operators: parameter.operators,
      defaultOperator: parameter.default_operator,
      required: Boolean(parameter.required),
      // Enum filters: selectable {code, label} (code + 中文) options.
      enumOptions: parameter.enum_options ?? [],
    })),
    contextParameters: (report.manifest.context_bindings ?? []).map(
      (binding: JsonRecord) => ({
        id: binding.api_key,
        required: Boolean(binding.required),
        visible: false,
      }),
    ),
  };
}

/**
 * Runtime SQL dialect: identifier quote char + placeholder style. MySQL (`col`,
 * `?` placeholders) is the default so existing packages without sql_dialect keep
 * exact behavior; PostgreSQL uses "col" and $n placeholders via the pg driver.
 */
type RuntimeDialect = {
  id: "mysql" | "postgresql";
  quoteChar: string;
};

function runtimeDialect(engine: unknown): RuntimeDialect {
  const value = String(engine ?? "").toLowerCase();
  if (value === "postgresql" || value === "postgres" || value === "pg") {
    return { id: "postgresql", quoteChar: '"' };
  }
  return { id: "mysql", quoteChar: "`" };
}

function safeExpression(
  value: unknown,
  dialect: RuntimeDialect = { id: "mysql", quoteChar: "`" },
): string {
  const expression = String(value ?? "");
  const quote = dialect.quoteChar;
  // Allowed-char + banned-keyword checks are shared with the generation-time
  // guard (sql-guard.ts). The Runtime additionally requires the expression to
  // reference at least one dialect-quoted `alias.col`.
  const reference = new RegExp(
    `\\b[A-Za-z][A-Za-z0-9_]*\\.${quote}[A-Za-z0-9_$]+${quote}`,
  );
  if (hasUnsafeSqlExpression(expression, quote) || !reference.test(expression)) {
    throw new RuntimeError("INVALID_BINDING", `不安全的字段表达式：${expression}`);
  }
  return expression;
}

/**
 * Defense-in-depth check on an EXISTS-subquery skeleton. It's produced at
 * generation time from knowledge (never user input) and validated there too, but
 * the runtime re-asserts its shape before use: it must be a correlated
 * `EXISTS (SELECT 1 FROM … WHERE … AND ` prefix + `)` suffix, contain no string
 * literals / comments / statement terminators, and no nested SELECT. The user's
 * search value is bound separately as a `?`, so it can never reach this string.
 */
function assertSafeSubquerySkeleton(
  prefix: string,
  suffix: string,
  _dialect: RuntimeDialect,
): void {
  // Shape + injection checks are shared with the generation-time guard
  // (sql-guard.ts). The Runtime additionally bans any SELECT/DML/DDL/UNION
  // keyword beyond the single leading `SELECT 1`.
  if (!isValidExistsSkeleton(prefix, suffix)) {
    throw new RuntimeError("UNSAFE_SUBQUERY", "EXISTS 子查询骨架结构无效");
  }
  const afterFirstSelect = prefix.replace(/^EXISTS \(SELECT 1 FROM /, "");
  if (
    hasSkeletonInjection(prefix) ||
    /\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|CALL|LOAD|OUTFILE|UNION)\b/i.test(
      afterFirstSelect,
    )
  ) {
    throw new RuntimeError("UNSAFE_SUBQUERY", "EXISTS 子查询骨架包含非法内容");
  }
}

function normalizedFilter(
  value: unknown,
  defaultOperator: string,
): { operator: string; value: unknown } {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ("value" in value || "operator" in value)
  ) {
    const item = value as JsonRecord;
    return {
      operator: String(item.operator ?? defaultOperator),
      value: item.value,
    };
  }
  return { operator: defaultOperator, value };
}

/**
 * Emptiness for a user filter value, including the range/wrapper shapes the test
 * page sends: `{operator, value}` and `{from, to}`. A range is empty only when
 * BOTH bounds are missing (a one-sided range is a valid >=/<= filter).
 */
function isFilterEmpty(value: unknown): boolean {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as JsonRecord;
    if ("value" in record || "operator" in record) {
      return isFilterEmpty(record.value);
    }
    if ("from" in record || "to" in record) {
      return isEmpty(record.from) && isEmpty(record.to);
    }
  }
  return isEmpty(value);
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Parse the `from` bound of a period filter value (a `{from,to}` range, possibly
 * wrapped as `{operator,value:{from,to}}`) into a `YYYY-MM` month key. Returns
 * null when there is no usable lower bound.
 */
function periodFromMonth(value: unknown): string | null {
  let range = value;
  if (range && typeof range === "object" && !Array.isArray(range) && "value" in (range as JsonRecord)) {
    range = (range as JsonRecord).value;
  }
  if (!range || typeof range !== "object" || Array.isArray(range)) return null;
  const from = (range as JsonRecord).from;
  if (isEmpty(from)) return null;
  const match = String(from).match(/^(\d{4})-(\d{2})/);
  if (!match) return null;
  return `${match[1]}-${match[2]}`;
}

/** Shift a `YYYY-MM` month key back by N months, returning `YYYY-MM-01`. */
function shiftMonthsBack(monthKey: string, months: number): string {
  const [y, m] = monthKey.split("-").map((n) => Number(n));
  // Convert to a 0-based absolute month index, subtract, convert back — no Date
  // needed (Date.now/new Date are avoided; this is pure integer arithmetic).
  const total = y! * 12 + (m! - 1) - months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

/**
 * When a package declares comparison (环比/同比), widen the period filter's lower
 * bound backward so ONE query returns the current window plus the look-back
 * window(s) the group transform needs: chain looks back `lookback_months`,
 * yoy looks back 12 months (× nothing — same month last year). The upper bound
 * and every other filter are untouched. Returns a new filters object; the
 * original is not mutated. No-op when comparison is absent/disabled or the
 * period filter has no month lower bound.
 */
export function widenComparisonFilters(
  comparison: JsonRecord | undefined,
  filters: Record<string, unknown>,
): Record<string, unknown> {
  if (!comparison?.enabled) return filters;
  const periodParam = String(comparison.period_param ?? "");
  if (!periodParam) return filters;
  const raw = filters[periodParam];
  const fromMonth = periodFromMonth(raw);
  if (!fromMonth) return filters;
  const modes: string[] = Array.isArray(comparison.modes) ? comparison.modes.map(String) : [];
  const lookback = Number(comparison.lookback_months ?? 1);
  const candidates: string[] = [];
  if (modes.includes("chain")) candidates.push(shiftMonthsBack(fromMonth, lookback));
  if (modes.includes("yoy")) candidates.push(shiftMonthsBack(fromMonth, 12));
  if (!candidates.length) return filters;
  // Earliest widened bound wins (covers all look-back needs in one query).
  const widened = candidates.sort()[0]!;
  // Preserve the original wrapper shape ({from,to} or {operator,value:{from,to}}).
  const applyFrom = (value: unknown): unknown => {
    if (value && typeof value === "object" && !Array.isArray(value) && "value" in (value as JsonRecord)) {
      const rec = value as JsonRecord;
      return { ...rec, value: applyFrom(rec.value) };
    }
    const rec = (value ?? {}) as JsonRecord;
    return { ...rec, from: widened };
  };
  return { ...filters, [periodParam]: applyFrom(raw) };
}

function buildPredicate(
  expression: string,
  operator: string,
  value: unknown,
): { sql: string; values: unknown[] } {
  if (operator === "eq") return { sql: `${expression} = ?`, values: [value] };
  if (operator === "contains") {
    return { sql: `${expression} LIKE ? ESCAPE '\\\\'`, values: [`%${String(value).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`] };
  }
  if (operator === "in") {
    const values = Array.isArray(value) ? value : String(value).split(",").map((item) => item.trim()).filter(Boolean);
    if (!values.length) throw new RuntimeError("INVALID_FILTER", "in 查询值不能为空");
    return { sql: `${expression} IN (${values.map(() => "?").join(", ")})`, values };
  }
  if (operator === "between") {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const range = value as JsonRecord;
      if (!isEmpty(range.from) && !isEmpty(range.to)) {
        return {
          sql: `${expression} BETWEEN ? AND ?`,
          values: [range.from, range.to],
        };
      }
      if (!isEmpty(range.from)) {
        return { sql: `${expression} >= ?`, values: [range.from] };
      }
      if (!isEmpty(range.to)) {
        return { sql: `${expression} <= ?`, values: [range.to] };
      }
    }
    if (!Array.isArray(value) || value.length !== 2) {
      throw new RuntimeError(
        "INVALID_FILTER",
        "between 查询值必须是 [开始, 结束] 或 {from, to}",
      );
    }
    return { sql: `${expression} BETWEEN ? AND ?`, values: value };
  }
  if (operator === "gte") return { sql: `${expression} >= ?`, values: [value] };
  if (operator === "lte") return { sql: `${expression} <= ?`, values: [value] };
  throw new RuntimeError("INVALID_OPERATOR", `不支持的查询操作符：${operator}`);
}

/**
 * Coerce a boolean-flag filter value (the test page sends `true`/`false`, or the
 * strings `"true"`/`"false"` from a `<select>`) into a real boolean. Returns null
 * for anything unrecognised so the caller can skip the filter rather than guess.
 */
export function coerceFlagValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  return null;
}

/**
 * Build a boolean-flag WHERE predicate from a TRUTH descriptor — a numeric/status
 * column folded to 是/否 (e.g. `receipt_count > 0`). The column reference, the
 * comparison operator, and the threshold arrive as SEPARATE validated parts, so no
 * free-form comparison string ever exists: the expression must be a bare quoted
 * `alias.col`, the operator must be a known FLAG_OPERATOR key, and the threshold is
 * `Number()`-coerced and inlined only after passing `Number.isFinite`. 是 →
 * `(col op n)`, 否 → `NOT (col op n)`. No bound `?` — the predicate is fully
 * self-contained, so it works identically across MySQL/Postgres with no true/false
 * literal quirks. Throws INVALID_BINDING on any malformed part (defense in depth;
 * the generator validates the same shape).
 */
export function buildFlagPredicate(
  expression: string,
  operatorKey: string,
  threshold: unknown,
  truthy: boolean,
  quoteChar: string,
): string {
  if (!isBareQuotedColumnRef(expression, quoteChar)) {
    throw new RuntimeError("INVALID_BINDING", `布尔字段表达式必须是单个列引用：${expression}`);
  }
  const symbol = FLAG_OPERATOR_SYMBOLS[String(operatorKey)];
  if (!symbol) {
    throw new RuntimeError("INVALID_BINDING", `布尔字段不支持比较符：${operatorKey}`);
  }
  const n = Number(threshold);
  if (!Number.isFinite(n)) {
    throw new RuntimeError("INVALID_BINDING", `布尔字段阈值必须是数值：${threshold}`);
  }
  const core = `${expression.trim()} ${symbol} ${n}`;
  return truthy ? `(${core})` : `NOT (${core})`;
}

export function compileSql(
  templateValue: string,
  bindings: JsonRecord,
  filtersValue: Record<string, unknown> = {},
  contextValue: Record<string, unknown> = {},
  dialect: RuntimeDialect = { id: "mysql", quoteChar: "`" },
): { sql: string; values: unknown[] } {
  const parameters = new Map<string, JsonRecord>(
    (bindings.parameters ?? []).map((binding: JsonRecord) => [binding.id, binding]),
  );
  const wherePredicates: string[] = [];
  const havingPredicates: string[] = [];
  const valueTokens = new Map<string, unknown>();
  let valueTokenSequence = 0;
  const bindPredicateValues = (sql: string, values: unknown[]): string => {
    let index = 0;
    const bound = sql.replace(/\?/g, () => {
      const token = `__EASYBI_VALUE_${valueTokenSequence++}__`;
      valueTokens.set(token, values[index]);
      index += 1;
      return token;
    });
    if (index !== values.length) {
      throw new RuntimeError("INVALID_BINDING", "SQL 条件和值数量不一致");
    }
    return bound;
  };

  for (const key of Object.keys(filtersValue)) {
    if (!parameters.has(key)) {
      throw new RuntimeError("UNKNOWN_FILTER", `报表不支持筛选项：${key}`);
    }
  }
  for (const [id, binding] of parameters) {
    // post_transform filters are evaluated in memory AFTER the transform runs
    // (numeric computed fields), never in SQL. Skip them here — applyPostTransformFilters
    // handles them (including required/empty enforcement) against the output rows.
    if (binding.clause === "post_transform") continue;
    const raw = filtersValue[id];
    // Enforce required user filters (e.g. a mandatory create-time range). A range
    // object counts as empty when neither bound is provided.
    if (binding.required && isFilterEmpty(raw)) {
      throw new RuntimeError("MISSING_FILTER", `筛选项 ${id} 为必填项`);
    }
    if (isFilterEmpty(raw)) continue;
    // Boolean-flag filter (是/否 over a folded numeric/status column, e.g.
    // receipt_count > 0). The predicate is built structurally from the trusted
    // truth descriptor (column + operator key + threshold) — the user only chooses
    // the direction 是/否. No user text or bound value reaches SQL. `false` (筛"否")
    // is a real filter, not "empty", so it survives isFilterEmpty above.
    if (binding.value_type === "boolean") {
      const flag = coerceFlagValue(
        raw && typeof raw === "object" && !Array.isArray(raw) && "value" in (raw as JsonRecord)
          ? (raw as JsonRecord).value
          : raw,
      );
      if (flag === null) continue;
      if (binding.clause !== "where") {
        throw new RuntimeError("INVALID_BINDING", `布尔筛选项 ${id} 必须使用 where clause`);
      }
      wherePredicates.push(
        buildFlagPredicate(
          String(binding.expression ?? ""),
          String(binding.flag_operator ?? ""),
          binding.flag_threshold,
          flag,
          dialect.quoteChar,
        ),
      );
      continue;
    }
    const defaultOperator =
      binding.default_operator ??
      (binding.value_adapter === "contains"
        ? "contains"
        : binding.operators?.[0] ?? "eq");
    const normalized = normalizedFilter(raw, defaultOperator);
    if (!(binding.operators ?? []).includes(normalized.operator)) {
      throw new RuntimeError(
        "INVALID_OPERATOR",
        `筛选项 ${id} 不支持操作符 ${normalized.operator}`,
      );
    }
    if (isEmpty(normalized.value)) continue;
    const predicate = buildPredicate(
      safeExpression(binding.expression, dialect),
      normalized.operator,
      normalized.value,
    );
    if (!["where", "having", "exists_subquery"].includes(binding.clause)) {
      throw new RuntimeError(
        "INVALID_BINDING",
        `筛选项 ${id} 必须显式声明 where/having/exists_subquery clause`,
      );
    }
    if (binding.clause === "having") {
      havingPredicates.push(bindPredicateValues(predicate.sql, predicate.values));
    } else if (binding.clause === "exists_subquery") {
      // The subquery skeleton is trusted (built at generation time from
      // knowledge, never user input). We only wrap the value predicate — whose
      // value is still bound as a `?` — so no user text ever enters raw SQL.
      const prefix = String(binding.subquery_prefix ?? "");
      const suffix = String(binding.subquery_suffix ?? "");
      assertSafeSubquerySkeleton(prefix, suffix, dialect);
      const inner = bindPredicateValues(predicate.sql, predicate.values);
      wherePredicates.push(`${prefix}${inner}${suffix}`);
    } else {
      wherePredicates.push(bindPredicateValues(predicate.sql, predicate.values));
    }
  }
  for (const binding of bindings.context ?? []) {
    const raw = contextValue[binding.api_key];
    if (isEmpty(raw)) {
      if (binding.required) {
        throw new RuntimeError("MISSING_CONTEXT", `缺少上下文参数：${binding.api_key}`);
      }
      continue;
    }
    const predicate = buildPredicate(
      safeExpression(binding.expression, dialect),
      binding.operator ?? "eq",
      raw,
    );
    wherePredicates.push(bindPredicateValues(predicate.sql, predicate.values));
  }

  let template = templateValue;
  for (const binding of bindings.system ?? []) {
    const token = `:${String(binding.id)}`;
    const occurrences = template.split(token).length - 1;
    if (occurrences !== 1) {
      throw new RuntimeError(
        "INVALID_SYSTEM_BINDING",
        `固定条件 ${binding.id} 在 SQL 中必须且只能出现一次`,
      );
    }
    const valueToken = `__EASYBI_VALUE_${valueTokenSequence++}__`;
    valueTokens.set(valueToken, binding.value);
    template = template.replace(token, valueToken);
  }
  if (/:[A-Za-z_][A-Za-z0-9_]*/.test(template)) {
    throw new RuntimeError("UNKNOWN_SQL_BINDING", "SQL 中存在未声明的命名参数");
  }
  const markerCount = (template.match(/\/\*\s*EASYBI_FILTERS\s*\*\//gi) ?? []).length;
  if (markerCount !== 1) {
    throw new RuntimeError("INVALID_SQL_TEMPLATE", "SQL 必须且只能包含一个筛选占位标记");
  }
  const fragment = wherePredicates.length
    ? `AND ${wherePredicates.join("\n  AND ")}`
    : "";
  const havingMarkerCount = (
    template.match(/\/\*\s*EASYBI_HAVING_FILTERS\s*\*\//gi) ?? []
  ).length;
  if (havingPredicates.length && havingMarkerCount !== 1) {
    throw new RuntimeError(
      "INVALID_SQL_TEMPLATE",
      "HAVING 筛选必须且只能包含一个 HAVING 占位标记",
    );
  }
  const havingFragment = havingPredicates.length
    ? `AND ${havingPredicates.join("\n  AND ")}`
    : "";
  const compiledTemplate = template
      .replace(/\/\*\s*EASYBI_FILTERS\s*\*\//i, fragment)
      .replace(/\/\*\s*EASYBI_HAVING_FILTERS\s*\*\//i, havingFragment);
  const values: unknown[] = [];
  const sql = compiledTemplate.replace(/__EASYBI_VALUE_\d+__/g, (token) => {
    if (!valueTokens.has(token)) {
      throw new RuntimeError("INVALID_BINDING", `未知参数标记：${token}`);
    }
    values.push(valueTokens.get(token));
    return "?";
  });
  return {
    sql,
    values,
  };
}

/**
 * Append a `LIMIT n` to a compiled preview query so the DATABASE stops after n
 * rows instead of executing/sorting the full result set and streaming every row
 * until the client-side row cap kicks in (the previous behavior, which made
 * previewing a large table slow regardless of the small cap). `n` is a validated
 * integer bound (never user text), so it is inlined directly — no placeholder.
 * Only safe when the transform is 1:1 (row/identity) and no post_transform filter
 * is dropping output rows; callers gate on that. Strips a trailing `;` first so
 * the LIMIT lands after ORDER BY.
 */
function appendPreviewLimit(sql: string, limit: number): string {
  const trimmed = sql.replace(/\s*;\s*$/, "").replace(/\s+$/, "");
  return `${trimmed}\nLIMIT ${Math.trunc(limit)}`;
}

/** True when any active (non-empty) filter targets a post_transform binding, which
 * drops output rows AFTER the query — a SQL LIMIT would then under-fill the preview. */
function hasActivePostTransformFilter(
  bindings: JsonRecord,
  filtersValue: Record<string, unknown>,
): boolean {
  for (const binding of bindings.parameters ?? []) {
    if (binding.clause !== "post_transform") continue;
    if (!isFilterEmpty(filtersValue[binding.id])) return true;
  }
  return false;
}

/** Parse the two bounds of a numeric range filter value into finite numbers or
 * null. Accepts the shapes the test page sends: `{from,to}`, `{operator,value:{from,to}}`,
 * and a bare `[from, to]` array. A missing/blank bound → null (one-sided range). */
function numericRangeBounds(value: unknown): { from: number | null; to: number | null } {
  let range = value;
  if (
    range &&
    typeof range === "object" &&
    !Array.isArray(range) &&
    "value" in (range as JsonRecord)
  ) {
    range = (range as JsonRecord).value;
  }
  const toNum = (v: unknown): number | null => {
    if (isEmpty(v)) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  if (Array.isArray(range)) {
    return { from: toNum(range[0]), to: toNum(range[1]) };
  }
  if (range && typeof range === "object") {
    const rec = range as JsonRecord;
    return { from: toNum(rec.from), to: toNum(rec.to) };
  }
  return { from: null, to: null };
}

/**
 * Build an in-memory predicate for `post_transform` numeric-range filters
 * (numeric computed fields like 件数总和 / 环比变化量). These can't be filtered in SQL
 * because their value only exists after the TypeScript transform runs, so the
 * runtime keeps only OUTPUT rows whose computed value falls in the requested
 * range. Required post_transform filters are enforced here (empty ⇒ error).
 *
 * Returns a predicate `(outputRow) => boolean`. When no post_transform filter is
 * active the predicate always returns true (zero overhead beyond the check).
 * `outputRow` is keyed by field id — the transform's output, pre enum-translation.
 */
export function buildPostTransformFilter(
  bindings: JsonRecord,
  filtersValue: Record<string, unknown> = {},
): (outputRow: JsonRecord) => boolean {
  const active: Array<{ id: string; from: number | null; to: number | null }> = [];
  for (const binding of bindings.parameters ?? []) {
    if (binding.clause !== "post_transform") continue;
    const raw = filtersValue[binding.id];
    if (isFilterEmpty(raw)) {
      if (binding.required) {
        throw new RuntimeError("MISSING_FILTER", `筛选项 ${binding.id} 为必填项`);
      }
      continue;
    }
    const { from, to } = numericRangeBounds(raw);
    if (from === null && to === null) continue; // Both bounds unparseable → no filter.
    active.push({ id: binding.id, from, to });
  }
  if (!active.length) return () => true;
  return (outputRow: JsonRecord): boolean => {
    for (const filter of active) {
      const cell = outputRow[filter.id];
      const value = Number(cell);
      // A non-numeric / null computed value can't satisfy a numeric range.
      if (!Number.isFinite(value)) return false;
      if (filter.from !== null && value < filter.from) return false;
      if (filter.to !== null && value > filter.to) return false;
    }
    return true;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Enrichment (batch secondary-query + in-memory merge)
//
// An enrichment attaches columns from ANOTHER table without a SQL JOIN: the main
// query streams rows, we collect their join keys per batch, run one `WHERE key IN
// (…)` query against the lookup table, and merge the result back in memory. This
// removes the ONE many-to-one/one-to-many table that would otherwise force a
// GROUP_CONCAT + GROUP BY + MAX() over the whole query, while leaving n:1
// dimension tables as normal JOINs. See docs/design/enrichment-batch-lookup.md.
//
// The functions below are PURE (no I/O) so they can be unit-tested directly; the
// pipeline wiring that issues the second query lives in prepareSyncQuery/enrichBatched.
// ─────────────────────────────────────────────────────────────────────────────

/** One enrichment binding as emitted into bindings.json / manifest.enrichments[]. */
export type EnrichmentBinding = {
  id: string;
  sql_template: string;
  /** Where the join key comes from: the main query row, or another enrichment's output. */
  key_source: "main" | "enrichment";
  key_source_id?: string | null;
  main_key_field: string;
  lookup_key_alias: string;
  cardinality: "one" | "many";
  aggregate?: {
    kind: "group_concat" | "count" | "sum" | "max" | "min" | "first";
    distinct?: boolean;
    separator?: string;
  };
  select_ids: string[];
  on_missing?: "null" | "empty" | "zero";
};

/**
 * Order enrichments so every one runs AFTER the enrichment its key depends on
 * (key_source="enrichment"). Kahn's algorithm; throws on a cycle. Enrichments
 * whose key comes from the main query have no dependency and come first.
 */
export function topoSortEnrichments(enrichments: EnrichmentBinding[]): EnrichmentBinding[] {
  const byId = new Map(enrichments.map((e) => [e.id, e]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const e of enrichments) {
    indegree.set(e.id, 0);
    dependents.set(e.id, []);
  }
  for (const e of enrichments) {
    if (e.key_source === "enrichment" && e.key_source_id) {
      if (!byId.has(e.key_source_id)) {
        throw new RuntimeError(
          "INVALID_ENRICHMENT",
          `enrichment ${e.id} 依赖不存在的上游 ${e.key_source_id}`,
        );
      }
      indegree.set(e.id, (indegree.get(e.id) ?? 0) + 1);
      dependents.get(e.key_source_id)!.push(e.id);
    }
  }
  const queue = enrichments.filter((e) => (indegree.get(e.id) ?? 0) === 0).map((e) => e.id);
  const ordered: EnrichmentBinding[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    ordered.push(byId.get(id)!);
    for (const dep of dependents.get(id) ?? []) {
      const next = (indegree.get(dep) ?? 0) - 1;
      indegree.set(dep, next);
      if (next === 0) queue.push(dep);
    }
  }
  if (ordered.length !== enrichments.length) {
    throw new RuntimeError("INVALID_ENRICHMENT", "enrichment 依赖存在环");
  }
  return ordered;
}

/** Normalize a join key to a stable string key (null/undefined → null, no match). */
function enrichmentKeyText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

/** Fold multiple child rows sharing one key into a single value per the aggregate spec. */
export function aggregateMany(
  rows: JsonRecord[],
  selectId: string,
  lookupField: string,
  aggregate: NonNullable<EnrichmentBinding["aggregate"]>,
): unknown {
  const values = rows.map((r) => r[lookupField]);
  switch (aggregate.kind) {
    case "count":
      return values.length;
    case "first":
      return values.length ? values[0] : null;
    case "sum": {
      let sum = 0;
      for (const v of values) sum += Number(v ?? 0);
      return sum;
    }
    case "max":
    case "min": {
      const nums = values.map((v) => Number(v)).filter((n) => Number.isFinite(n));
      if (!nums.length) return null;
      return aggregate.kind === "max" ? Math.max(...nums) : Math.min(...nums);
    }
    case "group_concat":
    default: {
      let items = values
        .filter((v) => v !== null && v !== undefined && v !== "")
        .map((v) => String(v));
      if (aggregate.distinct) items = [...new Set(items)];
      return items.join(aggregate.separator ?? ",");
    }
  }
  // selectId kept in signature for symmetry / future per-select aggregates.
}

/**
 * Build a `keyText → merged select-values` map for one enrichment from its raw
 * lookup rows. `one`: first row per key (records a multi-hit key list for a
 * warning). `many`: all rows per key folded via aggregate. Pure.
 */
export function buildEnrichmentValueMap(
  binding: EnrichmentBinding,
  lookupRows: JsonRecord[],
  selectLookupFields: Record<string, string>,
): { values: Map<string, JsonRecord>; multiHitKeys: string[] } {
  const grouped = new Map<string, JsonRecord[]>();
  for (const row of lookupRows) {
    const key = enrichmentKeyText(row[binding.lookup_key_alias]);
    if (key === null) continue;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  const values = new Map<string, JsonRecord>();
  const multiHitKeys: string[] = [];
  for (const [key, childRows] of grouped) {
    const merged: JsonRecord = {};
    if (binding.cardinality === "many") {
      const aggregate = binding.aggregate ?? { kind: "group_concat" as const };
      for (const selectId of binding.select_ids) {
        merged[selectId] = aggregateMany(
          childRows,
          selectId,
          selectLookupFields[selectId] ?? selectId,
          aggregate,
        );
      }
    } else {
      if (childRows.length > 1) multiHitKeys.push(key);
      const first = childRows[0]!;
      for (const selectId of binding.select_ids) {
        merged[selectId] = first[selectLookupFields[selectId] ?? selectId] ?? null;
      }
    }
    values.set(key, merged);
  }
  return { values, multiHitKeys };
}

/** The value attached when a main row has no matching lookup row. */
function enrichmentMissingValue(binding: EnrichmentBinding, selectId: string): unknown {
  if (binding.cardinality === "many" && binding.aggregate?.kind === "count") return 0;
  switch (binding.on_missing) {
    case "empty":
      return "";
    case "zero":
      return 0;
    case "null":
    default:
      return null;
  }
}

/**
 * Attach one enrichment's select columns to every row of a batch, keyed by the
 * row's `main_key_field`. Mutates rows in place (the batch is transient). Returns
 * the set of collected keys (for the caller to know what to query) is NOT here —
 * key collection + the actual query happen in enrichBatched; this only merges.
 */
export function applyEnrichmentToBatch(
  batch: JsonRecord[],
  binding: EnrichmentBinding,
  valueMap: Map<string, JsonRecord>,
): void {
  for (const row of batch) {
    const key = enrichmentKeyText(row[binding.main_key_field]);
    const merged = key !== null ? valueMap.get(key) : undefined;
    for (const selectId of binding.select_ids) {
      row[selectId] =
        merged && selectId in merged ? merged[selectId] : enrichmentMissingValue(binding, selectId);
    }
  }
}

/** Distinct non-null join keys present in a batch for one enrichment. */
export function collectBatchKeys(batch: JsonRecord[], mainKeyField: string): unknown[] {
  const seen = new Set<string>();
  const keys: unknown[] = [];
  for (const row of batch) {
    const raw = row[mainKeyField];
    const key = enrichmentKeyText(raw);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    keys.push(raw);
  }
  return keys;
}

export function runControlQuery(connection: JsonRecord, sql: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    connection.query(sql, (error: Error | null) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}

async function resolveTransform(report: LoadedReport): Promise<TransformPipeline> {
  const mode = report.manifest.custom_logic?.mode;
  if (!["identity", "sql", "row", "group"].includes(mode)) {
    throw new RuntimeError(
      "INVALID_TRANSFORM",
      "v2 报表包必须显式声明 custom_logic.mode",
    );
  }
  if (mode === "identity" || mode === "sql") return { mode: "identity" };
  const relativePath = report.manifest.entrypoints?.transform;
  if (!relativePath || !String(relativePath).endsWith(".mjs")) {
    throw new RuntimeError(
      "TRANSFORM_NOT_COMPILED",
      "自定义 Transform 必须提供编译后的 .mjs 入口",
    );
  }
  const module = (await import(`${pathToFileURL(join(report.root, relativePath)).href}?v=${Date.now()}`)) as JsonRecord;
  if (mode === "group") {
    if (typeof module.transformGroup !== "function") {
      throw new RuntimeError(
        "INVALID_TRANSFORM",
        "分组 Transform 未导出 transformGroup 函数",
      );
    }
    const groupKeys = report.manifest.custom_logic?.group_keys ?? [];
    if (!Array.isArray(groupKeys) || groupKeys.length === 0) {
      throw new RuntimeError("INVALID_TRANSFORM", "分组 Transform 缺少 group_keys");
    }
    return {
      mode: "group",
      groupKeys,
      maxGroupRows: Number(
        report.manifest.custom_logic?.max_group_rows ?? 100000,
      ),
      transformGroup: module.transformGroup,
    };
  }
  if (typeof module.transformRow !== "function") {
    throw new RuntimeError("INVALID_TRANSFORM", "Transform 未导出 transformRow 函数");
  }
  return {
    mode: "row",
    transformRow: module.transformRow as (row: JsonRecord) => JsonRecord,
  };
}

/**
 * Resolve the effective connection settings for a database profile by applying the
 * active environment's overrides (host, port, username, password, databases).
 *
 * New format (backward-compatible):
 *   { id, connector_id, active_environment: "qa",
 *     environments: { qa: { password, settings: { host, port, username, databases } } } }
 * Old format (returned as-is):
 *   { id, connector_id, password, settings: { host, port, username, databases } }
 */
function resolveEffectiveProfile(profile: JsonRecord): JsonRecord {
  const envName = profile.active_environment;
  if (envName && profile.environments && typeof profile.environments === "object") {
    const env = (profile.environments as JsonRecord)[String(envName)];
    if (env && typeof env === "object" && !Array.isArray(env)) {
      const envRec = env as JsonRecord;
      return {
        ...profile,
        password: envRec.password ?? profile.password,
        password_env: envRec.password_env ?? profile.password_env,
        settings: { ...(profile.settings ?? {}), ...(envRec.settings ?? {}) },
      };
    }
  }
  return profile;
}

function connectionProfile(config: JsonRecord, report: LoadedReport): JsonRecord {
  const profileId = report.knowledgeLock.sources?.[0]?.profile_id;
  const profile = config.connections?.database_profiles?.find(
    (item: JsonRecord) => item.id === profileId,
  );
  if (!profile) {
    throw new RuntimeError("DATABASE_PROFILE_NOT_FOUND", `未找到数据库连接：${profileId}`);
  }
  return resolveEffectiveProfile(profile);
}

function profilePassword(profile: JsonRecord): string {
  const password =
    profile.password ??
    (profile.password_env ? process.env[String(profile.password_env)] : undefined);
  if (password === undefined) {
    throw new RuntimeError("DATABASE_PASSWORD_MISSING", `数据库 ${profile.id} 未配置密码`);
  }
  return String(password);
}

function connect(profile: JsonRecord, database: string): Promise<JsonRecord> {
  const password = profilePassword(profile);
  return new Promise((resolvePromise, rejectPromise) => {
    const connection = mysql.createConnection({
      host: profile.settings?.host,
      port: profile.settings?.port ?? 3306,
      user: profile.settings?.username,
      password,
      database,
      charset: "utf8mb4",
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      connectTimeout: 15_000,
    });
    connection.connect((error) => {
      if (error) rejectPromise(error);
      else resolvePromise(connection as unknown as JsonRecord);
    });
  });
}

function endConnection(connection: JsonRecord): Promise<void> {
  return new Promise((resolvePromise) => connection.end(() => resolvePromise()));
}

/**
 * A minimal read-only query adapter shared by the export flow. It hides each
 * engine's connect / read-only transaction / statement-timeout / row-streaming
 * differences so exportSync stays engine-neutral. MySQL keeps its exact previous
 * behavior (SET SESSION TRANSACTION READ ONLY + START TRANSACTION, per-query
 * timeout option, mysql2 streaming); PostgreSQL uses BEGIN TRANSACTION READ ONLY,
 * SET statement_timeout, $n placeholders and maps result.rows to the same shape.
 */
type QueryAdapter = {
  beginReadOnly(): Promise<void>;
  rows(
    sql: string,
    values: unknown[],
    queryTimeoutMs: number,
  ): Promise<AsyncIterable<JsonRecord>>;
  /**
   * Run a query and materialize ALL rows. Used for enrichment secondary queries,
   * whose result sets are small (bounded by the batch's distinct key count). Runs
   * on the same read-only transaction/connection as `rows`.
   */
  queryAll(
    sql: string,
    values: unknown[],
    queryTimeoutMs: number,
  ): Promise<JsonRecord[]>;
  rollback(): Promise<void>;
  close(): Promise<void>;
};

async function createMysqlAdapter(
  profile: JsonRecord,
  database: string,
): Promise<QueryAdapter> {
  const connection = await connect(profile, database);
  return {
    async beginReadOnly() {
      await runControlQuery(connection, "SET SESSION TRANSACTION READ ONLY");
      // 已通过上一条 SET 将会话事务设为只读；这里使用兼容代理/旧版 MySQL 的语法。
      await runControlQuery(connection, "START TRANSACTION");
    },
    async rows(sql, values, queryTimeoutMs) {
      const query = connection.query({
        sql,
        values,
        timeout: queryTimeoutMs,
        rowsAsArray: false,
      });
      return query.stream({ highWaterMark: 128 }) as AsyncIterable<JsonRecord>;
    },
    async queryAll(sql, values, queryTimeoutMs) {
      return new Promise<JsonRecord[]>((resolvePromise, rejectPromise) => {
        connection.query(
          { sql, values, timeout: queryTimeoutMs, rowsAsArray: false },
          (error: Error | null, result: unknown) => {
            if (error) rejectPromise(error);
            else resolvePromise((result as JsonRecord[]) ?? []);
          },
        );
      });
    },
    async rollback() {
      await runControlQuery(connection, "ROLLBACK");
    },
    async close() {
      await endConnection(connection);
    },
  };
}

/** Convert `?` positional placeholders to PostgreSQL's $1, $2, … form. */
function toDollarPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${(index += 1)}`);
}

async function createPostgresAdapter(
  profile: JsonRecord,
  database: string,
): Promise<QueryAdapter> {
  const password = profilePassword(profile);
  const moduleName = "pg";
  const imported = (await import(moduleName)) as JsonRecord;
  const PgClient = (imported.default ?? imported).Client;
  const client = new PgClient({
    host: profile.settings?.host,
    port: profile.settings?.port ?? 5432,
    user: profile.settings?.username,
    password,
    database,
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();
  return {
    async beginReadOnly() {
      await client.query("BEGIN TRANSACTION READ ONLY");
    },
    async rows(sql, values, queryTimeoutMs) {
      await client.query(
        `SET statement_timeout = ${Math.max(1, Math.floor(queryTimeoutMs))}`,
      );
      const result = await client.query(toDollarPlaceholders(sql), values);
      const rows = (result?.rows ?? []) as JsonRecord[];
      return (async function* () {
        for (const row of rows) yield row;
      })();
    },
    async queryAll(sql, values, queryTimeoutMs) {
      await client.query(
        `SET statement_timeout = ${Math.max(1, Math.floor(queryTimeoutMs))}`,
      );
      const result = await client.query(toDollarPlaceholders(sql), values);
      return (result?.rows ?? []) as JsonRecord[];
    },
    async rollback() {
      await client.query("ROLLBACK");
    },
    async close() {
      await client.end();
    },
  };
}

async function createQueryAdapter(
  dialect: RuntimeDialect,
  profile: JsonRecord,
  database: string,
): Promise<QueryAdapter> {
  return dialect.id === "postgresql"
    ? createPostgresAdapter(profile, database)
    : createMysqlAdapter(profile, database);
}

class AsyncRowQueue implements AsyncIterable<JsonRecord> {
  private readonly rows: JsonRecord[] = [];
  private readonly readers: Array<{
    resolve: (value: IteratorResult<JsonRecord>) => void;
    reject: (error: Error) => void;
  }> = [];
  private readonly writers: Array<() => void> = [];
  private ended = false;
  private failure: Error | null = null;

  constructor(private readonly capacity = 256) {}

  async push(row: JsonRecord): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.ended) throw new RuntimeError("SCRIPT_CANCELED", "脚本输出流已关闭");
    const reader = this.readers.shift();
    if (reader) {
      reader.resolve({ value: row, done: false });
      return;
    }
    while (this.rows.length >= this.capacity && !this.ended && !this.failure) {
      await new Promise<void>((resolvePromise) => this.writers.push(resolvePromise));
    }
    if (this.failure) throw this.failure;
    if (this.ended) throw new RuntimeError("SCRIPT_CANCELED", "脚本输出流已关闭");
    this.rows.push(row);
  }

  end(): void {
    this.ended = true;
    for (const reader of this.readers.splice(0)) reader.resolve({ value: undefined, done: true });
    for (const writer of this.writers.splice(0)) writer();
  }

  fail(error: Error): void {
    this.failure = error;
    for (const reader of this.readers.splice(0)) reader.reject(error);
    for (const writer of this.writers.splice(0)) writer();
  }

  [Symbol.asyncIterator](): AsyncIterator<JsonRecord> {
    return {
      next: async (): Promise<IteratorResult<JsonRecord>> => {
        if (this.rows.length) {
          const value = this.rows.shift()!;
          this.writers.shift()?.();
          return { value, done: false };
        }
        if (this.failure) throw this.failure;
        if (this.ended) return { value: undefined, done: true };
        return new Promise<IteratorResult<JsonRecord>>((resolvePromise, rejectPromise) => {
          this.readers.push({ resolve: resolvePromise, reject: rejectPromise });
        });
      },
      return: async (): Promise<IteratorResult<JsonRecord>> => {
        this.end();
        return { value: undefined, done: true };
      },
    };
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RuntimeError("REQUEST_CANCELED", "报表执行已取消");
}

async function createScriptRows(options: {
  workspace: string;
  report: LoadedReport;
  filters: JsonRecord;
  context: JsonRecord;
  policy: JsonRecord;
  signal?: AbortSignal;
  isPreview?: boolean;
  onBeginSheet?: (name: string) => void;
}): Promise<{
  rows: AsyncIterable<JsonRecord>;
  completion: Promise<JsonRecord>;
  cancel(): void;
  /** Shared state so the writer can check which sheet to write to. */
  sheetState: { currentName: string };
}> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  throwIfAborted(options.signal);
  const queue = new AsyncRowQueue(256);
  const appConfig = await readJson(join(options.workspace, "config", "easy-bi.json"));
  const activeAdapters = new Set<QueryAdapter>();
  controller.signal.addEventListener("abort", () => {
    for (const adapter of activeAdapters) void adapter.close().catch(() => undefined);
  }, { once: true });
  const queryById = new Map(
    (options.report.scriptQueries ?? []).map((query: JsonRecord) => [String(query.id), query]),
  );
  // Load per-query bindings (for filter compilation).
  const queryBindings = new Map<string, JsonRecord>();
  for (const [id, def] of queryById) {
    const bp = String((def as JsonRecord).bindings ?? "");
    if (bp) {
      queryBindings.set(id, await readJson(join(options.report.root, bp)).catch(() => ({})));
    }
  }

  const resolveQuery = async (
    id: string,
    expectedMode: string,
    filtersOverride?: JsonRecord,
  ): Promise<{
    definition: JsonRecord;
    sql: string;
    values: unknown[];
    profile: JsonRecord;
    dialect: RuntimeDialect;
  }> => {
    throwIfAborted(controller.signal);
    const definition = queryById.get(id);
    if (!definition) throw new RuntimeError("SCRIPT_QUERY_NOT_FOUND", `脚本查询不存在：${id}`);
    if (definition.mode !== expectedMode) {
      throw new RuntimeError(
        "SCRIPT_QUERY_MODE_MISMATCH",
        `脚本查询 ${id} 声明为 ${definition.mode}，不能通过 ${expectedMode} 调用`,
      );
    }
    const rawProfile = appConfig.connections?.database_profiles?.find(
      (candidate: JsonRecord) => candidate.id === definition.profile_id,
    );
    if (!rawProfile) throw new RuntimeError("DATABASE_PROFILE_NOT_FOUND", `未找到数据库连接：${definition.profile_id}`);
    const profile = resolveEffectiveProfile(rawProfile);
    const dialect = runtimeDialect(profile.connector_id ?? options.report.manifest.sql_dialect ?? "mysql");
    const sqlPath = String(definition.sql ?? "");
    if (!/^queries\/[a-z0-9_-]+\.sql$/.test(sqlPath)) {
      throw new RuntimeError("INVALID_SCRIPT_QUERY_PATH", `脚本查询路径无效：${sqlPath}`);
    }
    const template = await readFile(join(options.report.root, sqlPath), "utf8");
    const bindings = queryBindings.get(id) ?? {};
    const effectiveFilters = filtersOverride ?? options.filters ?? {};
    const compiled = compileSql(template, bindings, effectiveFilters, options.context, dialect);
    return {
      definition,
      sql: compiled.sql,
      values: compiled.values,
      profile,
      dialect,
    };
  };
  async function executeResolvedQuery(
    resolved: Awaited<ReturnType<typeof resolveQuery>>,
    extraValues: unknown[] = [],
  ): Promise<QueryAdapter> {
    const adapter = await createQueryAdapter(resolved.dialect, resolved.profile, String(resolved.definition.database));
    activeAdapters.add(adapter);
    await adapter.beginReadOnly();
    return adapter;
  }

  const handlers: ScriptQueryHandlers = {
    async queryStream(queryId, values) {
      // Keep the two script query APIs unambiguous at the IPC boundary:
      // queryStream(queryId, values) only accepts positional SQL values, while
      // filter records must use queryStreamWithFilters(queryId, filters).
      // This prevents a raw JavaScript spread error from obscuring a malformed
      // generated or hand-authored script.
      if (!Array.isArray(values)) {
        throw new RuntimeError(
          "SCRIPT_QUERY_VALUES_INVALID",
          `脚本查询 ${queryId} 的 values 必须是数组；筛选条件请使用 queryStreamWithFilters。`,
        );
      }
      const resolved = await resolveQuery(queryId, "stream");
      const adapter = await executeResolvedQuery(resolved);
      const allValues = [...resolved.values, ...values];
      const source = await adapter.rows(resolved.sql, allValues, Number(options.policy.query_timeout_seconds ?? 600) * 1000);
      return (async function* () {
        try {
          for await (const row of source) {
            throwIfAborted(controller.signal);
            yield row;
          }
          await adapter.rollback();
        } finally {
          activeAdapters.delete(adapter);
          await adapter.close().catch(() => undefined);
        }
      })();
    },
    /** Re-compile a query with different filter values, then stream. */
    async queryStreamWithFilters(queryId, filtersOverride) {
      const resolved = await resolveQuery(queryId, "stream", filtersOverride as JsonRecord);
      const adapter = await executeResolvedQuery(resolved);
      const source = await adapter.rows(resolved.sql, resolved.values, Number(options.policy.query_timeout_seconds ?? 600) * 1000);
      return (async function* () {
        try {
          for await (const row of source) {
            throwIfAborted(controller.signal);
            yield row;
          }
          await adapter.rollback();
        } finally {
          activeAdapters.delete(adapter);
          await adapter.close().catch(() => undefined);
        }
      })();
    },
    async loadIndex(queryId, values) {
      const resolved = await resolveQuery(queryId, "index");
      const adapter = await executeResolvedQuery(resolved);
      try {
        const rows = await adapter.queryAll(resolved.sql, [...resolved.values, ...values], Number(options.policy.query_timeout_seconds ?? 600) * 1000);
        await adapter.rollback();
        return rows;
      } finally {
        activeAdapters.delete(adapter);
        await adapter.close().catch(() => undefined);
      }
    },
    async batchLookup(queryId, keys, values) {
      const resolved = await resolveQuery(queryId, "batch");
      const placeholders = Array.from({ length: Math.max(1, keys.length) }, () => "?").join(", ");
      const sql = resolved.sql.replace(/\/\*\s*KEYS\s*\*\//, placeholders);
      const adapter = await executeResolvedQuery(resolved);
      try {
        const rows = await adapter.queryAll(sql, [...keys, ...resolved.values, ...values], Number(options.policy.query_timeout_seconds ?? 600) * 1000);
        await adapter.rollback();
        return rows;
      } finally {
        activeAdapters.delete(adapter);
        await adapter.close().catch(() => undefined);
      }
    },
  };
  const declaredBudget = options.report.manifest.resource_budget ?? {};
  const ceiling = options.policy.script_budget_ceiling ?? {};
  const effectiveBudget = Object.fromEntries(
    Object.entries(declaredBudget).map(([name, value]) => [
      name,
      ceiling[name] == null ? value : Math.min(Number(value), Number(ceiling[name])),
    ]),
  );
  const sheetState = { currentName: "数据" };
  const completion = runScriptIsolated({
    scriptPath: join(options.report.root, String(options.report.manifest.entrypoints?.script ?? "scripts/report.mjs")),
    filters: options.filters,
    context: options.context,
    budget: effectiveBudget,
    handlers,
    onEmit: (row) => queue.push(row),
    onBeginSheet: (name) => {
      sheetState.currentName = name;
      if (options.onBeginSheet) options.onBeginSheet(name);
    },
    isPreview: options.isPreview,
    signal: controller.signal,
  }).then(
    (result) => {
      queue.end();
      return result;
    },
    (error) => {
      const mapped = error instanceof ScriptExecutionError
        ? new RuntimeError(error.code, error.message)
        : error instanceof Error ? error : new Error(String(error));
      queue.fail(mapped);
      throw mapped;
    },
  ).finally(() => options.signal?.removeEventListener("abort", abort));
  return { rows: queue, completion, cancel: () => controller.abort(), sheetState };
}

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 160);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
}

function createSheet(
  workbook: JsonRecord,
  report: LoadedReport,
  sheetNumber: number,
  sheetName?: string,
): JsonRecord {
  const name = sheetName ?? (sheetNumber === 1 ? "数据" : `数据${sheetNumber}`);
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = (report.fields.fields ?? []).map((field: JsonRecord) => ({
    header: field.label,
    key: field.id,
    width: Math.min(40, Math.max(12, String(field.label).length * 2 + 4)),
    style: field.excel?.number_format
      ? { numFmt: field.excel.number_format }
      : undefined,
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).commit();
  return sheet;
}

export async function writeWorkbookRows(
  report: Pick<LoadedReport, "manifest" | "fields"> & { enums?: JsonRecord | null },
  rows: AsyncIterable<JsonRecord>,
  output: string,
  policy: JsonRecord,
  transform:
    | TransformPipeline
    | ((row: JsonRecord) => JsonRecord) = { mode: "identity" },
  startedAt = Date.now(),
  postFilter: (outputRow: JsonRecord) => boolean = () => true,
  sheetState?: { currentName: string },
): Promise<{ rowCount: number; sheetCount: number; fileBytes: number }> {
  // Per-field enum code→中文 map (empty when the package has no enums file).
  const enumByField: Record<string, Record<string, string>> =
    (report.enums?.byField as Record<string, Record<string, string>>) ?? {};
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: output,
    useStyles: true,
    useSharedStrings: false,
  }) as unknown as JsonRecord;
  let sheetNumber = 1;
  let rowInSheet = 0;
  let rowCount = 0;
  let activeSheetName = sheetState?.currentName ?? "数据";
  let sheet = createSheet(workbook, report as LoadedReport, sheetNumber, activeSheetName);
  const maxSheets = Number(policy.max_sheets_per_workbook ?? 3);
  const pipeline: TransformPipeline =
    typeof transform === "function"
      ? { mode: "row", transformRow: transform }
      : transform;
  const appendOutputRow = (transformed: JsonRecord): void => {
    if (Date.now() - startedAt > Number(policy.total_timeout_seconds ?? 900) * 1000) {
      throw new RuntimeError("TOTAL_TIMEOUT", "导出超过总时限");
    }
    // Post-transform range filter: drop rows whose computed value is out of range.
    if (!postFilter(transformed)) return;
    // Check for script-requested sheet switch.
    const requestedSheet = sheetState?.currentName ?? "数据";
    if (requestedSheet !== activeSheetName) {
      sheet.commit();
      sheetNumber += 1;
      if (sheetNumber > maxSheets) {
        throw new RuntimeError("SHEET_LIMIT_EXCEEDED", `数据超过最多 ${maxSheets} 个 Sheet 的容量`);
      }
      activeSheetName = requestedSheet;
      rowInSheet = 0;
      sheet = createSheet(workbook, report as LoadedReport, sheetNumber, activeSheetName);
    }
    // Auto-split on row overflow within the same sheet (keep the base name).
    if (rowInSheet >= Number(policy.max_rows_per_sheet ?? 1_048_575)) {
      if (sheetNumber >= maxSheets) {
        throw new RuntimeError("SHEET_LIMIT_EXCEEDED", `数据超过最多 ${maxSheets} 个 Sheet 的容量`);
      }
      sheet.commit();
      sheetNumber += 1;
      rowInSheet = 0;
      // Use numbered fallback for auto-split; script-controlled sheets don't auto-split.
      sheet = createSheet(workbook, report as LoadedReport, sheetNumber);
    }
    const outputRow: JsonRecord = {};
    for (const field of report.fields.fields ?? []) {
      const raw = transformed[field.id];
      const map = enumByField[field.id];
      if (
        map &&
        raw != null &&
        Object.prototype.hasOwnProperty.call(map, String(raw))
      ) {
        outputRow[field.id] = map[String(raw)];
      } else {
        outputRow[field.id] = raw;
      }
    }
    sheet.addRow(outputRow).commit();
    rowInSheet += 1;
    rowCount += 1;
  };
  try {
    if (pipeline.mode === "group") {
      let groupRows: JsonRecord[] = [];
      let groupKeyText: string | undefined;
      let groupKey: unknown[] = [];
      const flush = (): void => {
        if (!groupRows.length) return;
        const transformed = pipeline.transformGroup(groupRows, { groupKey });
        for (const row of Array.isArray(transformed) ? transformed : [transformed]) {
          appendOutputRow(row);
        }
        groupRows = [];
      };
      for await (const rawRow of rows) {
        const nextKey = pipeline.groupKeys.map((key) => rawRow[key]);
        const nextKeyText = JSON.stringify(nextKey);
        if (groupKeyText !== undefined && nextKeyText !== groupKeyText) {
          flush();
        }
        if (!groupRows.length) {
          groupKeyText = nextKeyText;
          groupKey = nextKey;
        }
        groupRows.push(rawRow);
        if (groupRows.length > pipeline.maxGroupRows) {
          throw new RuntimeError(
            "GROUP_ROW_LIMIT_EXCEEDED",
            `单个计算分组超过 ${pipeline.maxGroupRows} 行`,
          );
        }
      }
      flush();
    } else {
      for await (const rawRow of rows) {
        appendOutputRow(
          pipeline.mode === "row" ? pipeline.transformRow(rawRow) : rawRow,
        );
      }
    }
    sheet.commit();
    await workbook.commit();
    const file = await stat(output);
    if (file.size > Number(policy.max_file_bytes ?? 2_147_483_648)) {
      await unlink(output);
      throw new RuntimeError("FILE_LIMIT_EXCEEDED", "生成文件超过运行时大小限制");
    }
    return { rowCount, sheetCount: sheetNumber, fileBytes: file.size };
  } catch (error) {
    try {
      await workbook.commit();
    } catch {
      // 原始异常优先。
    }
    throw error;
  }
}

/**
 * Shared preamble for sync data access: load context + package, enforce the sync
 * policy and column cap, widen comparison filters, resolve the connection
 * profile / dialect, and compile the SQL. Used by both `exportSync` (writes an
 * Excel workbook) and `querySync` (returns rows as JSON) so the two paths run
 * exactly the same query, filters, and transform.
 */
async function prepareSyncQuery(
  workspaceValue: string,
  request: ExportRequest,
  options: { policy?: JsonRecord } = {},
): Promise<{
  workspace: string;
  config: JsonRecord;
  report: LoadedReport;
  policy: JsonRecord;
  source: JsonRecord;
  profile: JsonRecord;
  dialect: RuntimeDialect;
  compiled: { sql: string; values: unknown[] };
  transform: TransformPipeline | ((row: JsonRecord) => JsonRecord);
  postFilter: (outputRow: JsonRecord) => boolean;
  enrichments: EnrichmentBinding[];
  /** Compiled sibling grouped queries (group_queries), merged on merge_keys. */
  groupQueries: { mergeKeys: string[]; compiled: Array<{ id: string; sql: string; values: unknown[] }> } | null;
}> {
  const { workspace, config } = await loadRuntimeContext(workspaceValue);
  const report = await loadReportPackage(workspace, request.reportId, request.reportVersion);
  const policy = options.policy ?? config.execution_strategy?.sync;
  if (!policy?.enabled) throw new RuntimeError("SYNC_DISABLED", "同步查询/导出未启用");
  if ((report.fields.fields ?? []).length > policy.max_columns) {
    throw new RuntimeError("TOO_MANY_COLUMNS", "报表列数超过运行时限制");
  }
  // Enrichment (batch secondary-query) bindings, ordered so a chained enrichment
  // runs after the one it depends on. Only output-stage merge is supported, so a
  // group transform + enrichment is rejected (buffer/batch boundaries would cross).
  const enrichmentsRaw = (report.bindings.enrichments ?? []) as EnrichmentBinding[];
  const enrichments = enrichmentsRaw.length ? topoSortEnrichments(enrichmentsRaw) : [];
  if (enrichments.length && report.manifest.custom_logic?.mode === "group") {
    throw new RuntimeError(
      "ENRICHMENT_UNSUPPORTED",
      "分组(group)报表暂不支持 enrichment 二次查询合并",
    );
  }
  // Widen the period filter's lower bound backward for comparison (环比/同比) so a
  // single query also returns the look-back window(s) the group transform needs.
  const filters = widenComparisonFilters(
    report.manifest.comparison,
    request.filters ?? {},
  );
  const context = { ...(request.context ?? {}) };
  if (!isEmpty(request.tenantId) && isEmpty(context.tenantId)) {
    context.tenantId = request.tenantId;
  }
  const source = report.knowledgeLock.sources?.[0];
  const appConfig = await readJson(join(workspace, "config", "easy-bi.json"));
  const profile = connectionProfile(appConfig, report);
  // Engine comes from the package manifest (default mysql for older packages);
  // fall back to the resolved profile's connector_id when the manifest omits it.
  const dialect = runtimeDialect(
    report.manifest.sql_dialect ?? profile.connector_id ?? "mysql",
  );
  const compiled = compileSql(
    report.sql,
    report.bindings,
    filters,
    context,
    dialect,
  );
  // Multi-entity grouped queries: compile each sibling's SQL with the SAME filters
  // (the shared time range binds to each sibling's own time column) + context, so
  // the runtime can execute them and full-outer-merge on merge_keys. Mutually
  // exclusive with a group transform / enrichment (rejected at generation time; we
  // re-guard below for defense in depth).
  let groupQueries:
    | { mergeKeys: string[]; compiled: Array<{ id: string; sql: string; values: unknown[] }> }
    | null = null;
  const gqManifest = report.manifest.group_queries as JsonRecord | undefined;
  if (gqManifest?.queries?.length) {
    if (report.manifest.custom_logic?.mode === "group" || enrichments.length) {
      throw new RuntimeError(
        "GROUP_QUERIES_UNSUPPORTED",
        "group_queries 与内存分组 transform / enrichment 互斥",
      );
    }
    const compiledSiblings: Array<{ id: string; sql: string; values: unknown[] }> = [];
    for (const gq of gqManifest.queries as JsonRecord[]) {
      const siblingSql = await readFile(join(report.root, String(gq.sql)), "utf8");
      const siblingBindings = await readJson(join(report.root, String(gq.bindings)));
      compiledSiblings.push({
        id: String(gq.id),
        ...compileSql(siblingSql, siblingBindings, filters, context, dialect),
      });
    }
    groupQueries = {
      mergeKeys: (gqManifest.merge_keys ?? []).map(String),
      compiled: compiledSiblings,
    };
  }
  const transform = await resolveTransform(report);
  // Post-transform numeric-range filter (件数总和 …). Built from the SAME (widened)
  // filter values; enforces required post_transform filters. Applied in memory to
  // the transform's output rows by collectRows / writeWorkbookRows.
  const postFilter = buildPostTransformFilter(report.bindings, filters);
  return {
    workspace,
    config,
    report,
    policy,
    source,
    profile,
    dialect,
    compiled,
    transform,
    postFilter,
    enrichments,
    groupQueries,
  };
}

/**
 * Execute the main query + every sibling group query, then FULL-OUTER-merge their
 * result sets on `mergeKeys` into one row per distinct key tuple. Each query is a
 * standalone grouped SELECT (one row per key); a key present in some queries but
 * not others gets that query's metric columns left undefined (numeric counts read
 * as 0 downstream via the output mapping). Runs all queries on the SAME read-only
 * adapter/transaction. Returns rows in first-seen key order (main query first).
 *
 * This is the group_queries execution model: N independent grouped queries merged
 * by key — NOT a JOIN (avoids one-to-many fan-out) and NOT enrichment (which is a
 * main→lookup column attach). Output columns come from the package's merged
 * fields.json, so unfilled metrics simply render empty/0.
 */
/** Identity transform for group_queries output (merge already produced final rows). */
const identityTransform: TransformPipeline = { mode: "identity" };

/** Adapt an in-memory row array to the AsyncIterable the collector/writer expect. */
async function* arrayToAsyncIterable(rows: JsonRecord[]): AsyncIterable<JsonRecord> {
  for (const row of rows) yield row;
}

export async function runGroupQueriesMerged(
  adapter: Pick<QueryAdapter, "queryAll">,
  main: { sql: string; values: unknown[] },
  groupQueries: { mergeKeys: string[]; compiled: Array<{ id: string; sql: string; values: unknown[] }> },
  queryTimeoutMs: number,
  numericFieldIds: Set<string>,
  maxMergedGroups = 100000,
): Promise<JsonRecord[]> {
  if (!Number.isInteger(maxMergedGroups) || maxMergedGroups < 1) {
    throw new RuntimeError("INVALID_RUNTIME_POLICY", "max_merged_groups 必须是正整数");
  }
  const { mergeKeys } = groupQueries;
  const keyOf = (row: JsonRecord): string =>
    JSON.stringify(mergeKeys.map((k) => row[k] ?? null));
  const merged = new Map<string, JsonRecord>();
  const order: string[] = [];
  const mergeRows = (rows: JsonRecord[]): void => {
    for (const row of rows) {
      const key = keyOf(row);
      let target = merged.get(key);
      if (!target) {
        if (merged.size >= maxMergedGroups) {
          throw new RuntimeError(
            "GROUP_QUERY_LIMIT_EXCEEDED",
            `多查询分组结果超过上限 ${maxMergedGroups}，请缩小筛选范围或提高 max_merged_groups`,
          );
        }
        target = {};
        // Seed the merge-key columns so every merged row carries the dimension.
        for (const k of mergeKeys) target[k] = row[k] ?? null;
        merged.set(key, target);
        order.push(key);
      }
      // Copy every non-key column; later queries never overwrite the shared key.
      for (const [col, value] of Object.entries(row)) {
        if (mergeKeys.includes(col)) continue;
        target[col] = value;
      }
    }
  };
  // Main query first (defines the primary key order), then siblings.
  mergeRows(await adapter.queryAll(main.sql, main.values, queryTimeoutMs));
  for (const sibling of groupQueries.compiled) {
    mergeRows(await adapter.queryAll(sibling.sql, sibling.values, queryTimeoutMs));
  }
  // Full-outer semantics: a key missing from some query has no value for that
  // query's metrics. Default numeric metrics to 0 so a customer with no waybills
  // shows 0, not blank. Non-numeric missing columns stay null.
  const result = order.map((key) => merged.get(key)!);
  for (const row of result) {
    for (const id of numericFieldIds) {
      if (row[id] == null) row[id] = 0;
    }
  }
  return result;
}

/**
 * Wrap a main-query row stream so each row comes out with its enrichment columns
 * attached. Rows are processed in batches of `batchSize`: for each batch we run
 * every enrichment (in dependency order) as one `WHERE key IN (…)` query on the
 * SAME read-only adapter, build a key→value map, and merge into the batch rows.
 * The main row count is unchanged (many-cardinality folds child rows in memory),
 * so downstream LIMIT/truncation stay correct. Yields rows one at a time so the
 * collector keeps its streaming shape. Warnings (e.g. one-cardinality multi-hit)
 * are pushed onto `warningsSink`.
 */
export async function* enrichBatched(
  rows: AsyncIterable<JsonRecord>,
  enrichments: EnrichmentBinding[],
  adapter: Pick<QueryAdapter, "queryAll">,
  queryTimeoutMs: number,
  batchSize: number,
  warningsSink: string[],
): AsyncGenerator<JsonRecord> {
  // Map every enrichment's select id → its lookup source column (for aggregation).
  const selectLookupByEnrichment = new Map<string, Record<string, string>>();
  for (const e of enrichments) {
    // sql_template aliases each select column to its select id already, so the
    // lookup row is keyed by select id; identity map keeps buildEnrichmentValueMap general.
    selectLookupByEnrichment.set(e.id, Object.fromEntries(e.select_ids.map((id) => [id, id])));
  }

  const processBatch = async (batch: JsonRecord[]): Promise<void> => {
    for (const binding of enrichments) {
      const keys = collectBatchKeys(batch, binding.main_key_field);
      let valueMap = new Map<string, JsonRecord>();
      if (keys.length) {
        const sql = expandKeysPlaceholder(binding.sql_template, keys.length);
        const lookupRows = await adapter.queryAll(sql, keys, queryTimeoutMs);
        const built = buildEnrichmentValueMap(
          binding,
          lookupRows,
          selectLookupByEnrichment.get(binding.id) ?? {},
        );
        valueMap = built.values;
        if (built.multiHitKeys.length) {
          warningsSink.push(
            `enrichment ${binding.id}(cardinality=one) 有 ${built.multiHitKeys.length} 个键命中多行，已取第一条`,
          );
        }
      }
      applyEnrichmentToBatch(batch, binding, valueMap);
    }
  };

  let batch: JsonRecord[] = [];
  for await (const row of rows) {
    batch.push(row);
    if (batch.length >= batchSize) {
      await processBatch(batch);
      for (const r of batch) yield r;
      batch = [];
    }
  }
  if (batch.length) {
    await processBatch(batch);
    for (const r of batch) yield r;
  }
}

/** Expand the single `/* KEYS *​/` marker in an enrichment sql_template into
 * `?, ?, …` for `count` bound values. The template is built at generation time
 * from knowledge (never user input); only the count of placeholders is dynamic. */
function expandKeysPlaceholder(template: string, count: number): string {
  const placeholders = Array.from({ length: Math.max(1, count) }, () => "?").join(", ");
  return template.replace(/\/\*\s*KEYS\s*\*\//, placeholders);
}

/** Report output columns as {id, label, description?} — the 中文 headers a caller
 * (Studio 测试页预览) renders as table headers. Description is included when the
 * package field carries one. */
export function outputColumns(report: Pick<LoadedReport, "fields">): JsonRecord[] {
  return (report.fields.fields ?? []).map((field: JsonRecord) => ({
    id: field.id,
    label: field.label,
    ...(field.description ? { description: field.description } : {}),
  }));
}

/**
 * Collect transformed, enum-translated output rows into memory (instead of
 * streaming to a workbook), applying the same identity/row/group transform and
 * enum code→中文 mapping as `writeWorkbookRows`. Bounded by `maxRows`: once the
 * cap is reached collection stops and `truncated` is true. No pagination — the
 * caller scrolls the returned rows.
 */
export async function collectRows(
  report: Pick<LoadedReport, "manifest" | "fields"> & { enums?: JsonRecord | null },
  rows: AsyncIterable<JsonRecord>,
  transform: TransformPipeline | ((row: JsonRecord) => JsonRecord),
  options: {
    maxRows: number;
    startedAt: number;
    totalTimeoutSeconds: number;
    /** Post-transform numeric-range filter; rows failing it are dropped. */
    postFilter?: (outputRow: JsonRecord) => boolean;
  },
): Promise<{ rows: JsonRecord[]; rowCount: number; truncated: boolean }> {
  const enumByField: Record<string, Record<string, string>> =
    (report.enums?.byField as Record<string, Record<string, string>>) ?? {};
  const fields = report.fields.fields ?? [];
  const out: JsonRecord[] = [];
  const postFilter = options.postFilter ?? (() => true);
  let truncated = false;
  const pipeline: TransformPipeline =
    typeof transform === "function"
      ? { mode: "row", transformRow: transform }
      : transform;

  // Returns false once the row cap is hit, signalling callers to stop consuming.
  const appendOutputRow = (transformed: JsonRecord): boolean => {
    if (Date.now() - options.startedAt > options.totalTimeoutSeconds * 1000) {
      throw new RuntimeError("TOTAL_TIMEOUT", "查询超过总时限");
    }
    // Post-transform range filter: the computed value exists now, so drop the row
    // if it falls outside the requested range. Checked BEFORE the cap so filtered
    // rows don't consume the preview budget.
    if (!postFilter(transformed)) return true;
    if (out.length >= options.maxRows) {
      truncated = true;
      return false;
    }
    const row: JsonRecord = {};
    for (const field of fields) {
      const raw = transformed[field.id];
      const map = enumByField[field.id];
      row[field.id] =
        map && raw != null && Object.prototype.hasOwnProperty.call(map, String(raw))
          ? map[String(raw)]
          : raw;
    }
    out.push(row);
    return true;
  };

  if (pipeline.mode === "group") {
    let groupRows: JsonRecord[] = [];
    let groupKeyText: string | undefined;
    let groupKey: unknown[] = [];
    const flush = (): boolean => {
      if (!groupRows.length) return true;
      const transformed = pipeline.transformGroup(groupRows, { groupKey });
      groupRows = [];
      for (const row of Array.isArray(transformed) ? transformed : [transformed]) {
        if (!appendOutputRow(row)) return false;
      }
      return true;
    };
    for await (const rawRow of rows) {
      const nextKey = pipeline.groupKeys.map((key) => rawRow[key]);
      const nextKeyText = JSON.stringify(nextKey);
      if (groupKeyText !== undefined && nextKeyText !== groupKeyText) {
        if (!flush()) break;
      }
      if (!groupRows.length) {
        groupKeyText = nextKeyText;
        groupKey = nextKey;
      }
      groupRows.push(rawRow);
      if (groupRows.length > pipeline.maxGroupRows) {
        throw new RuntimeError(
          "GROUP_ROW_LIMIT_EXCEEDED",
          `单个计算分组超过 ${pipeline.maxGroupRows} 行`,
        );
      }
    }
    flush();
  } else {
    for await (const rawRow of rows) {
      const kept = appendOutputRow(
        pipeline.mode === "row" ? pipeline.transformRow(rawRow) : rawRow,
      );
      if (!kept) break;
    }
  }
  return { rows: out, rowCount: out.length, truncated };
}

async function queryScriptSync(
  workspaceValue: string,
  request: ExportRequest & { limit?: number },
  options: { policy?: JsonRecord; signal?: AbortSignal } = {},
): Promise<JsonRecord> {
  const startedAt = Date.now();
  const { workspace, config } = await loadRuntimeContext(workspaceValue);
  const report = await loadReportPackage(workspace, request.reportId, request.reportVersion);
  const policy = options.policy ?? config.execution_strategy?.sync;
  if (!policy?.enabled) throw new RuntimeError("SYNC_DISABLED", "同步查询/导出未启用");
  const policyMax = Number(policy.preview_max_rows ?? 1000);
  const requested = Number.isFinite(Number(request.limit)) ? Number(request.limit) : policyMax;
  const maxRows = Math.max(1, Math.min(policyMax, requested > 0 ? requested : policyMax));
  const context = { ...(request.context ?? {}) };
  if (!isEmpty(request.tenantId) && isEmpty(context.tenantId)) context.tenantId = request.tenantId;
  const execution = await createScriptRows({
    workspace,
    report,
    filters: request.filters ?? {},
    context,
    policy,
    signal: options.signal,
    isPreview: true,
  });
  const collected = await collectRows(report, execution.rows, identityTransform, {
    maxRows,
    startedAt,
    totalTimeoutSeconds: Math.min(
      Number(policy.total_timeout_seconds ?? 900),
      Number(report.manifest.resource_budget?.timeout_seconds ?? 300),
    ),
  });
  if (collected.truncated) {
    execution.cancel();
    await execution.completion.catch(() => undefined);
  } else {
    await execution.completion;
  }
  return {
    reportId: report.manifest.id,
    reportName: report.manifest.name,
    reportVersion: report.manifest.version,
    columns: outputColumns(report),
    rows: collected.rows,
    rowCount: collected.rowCount,
    truncated: collected.truncated,
    limit: maxRows,
    totalDurationMs: Date.now() - startedAt,
    executionModel: "isolated_script",
  };
}

async function exportScriptSync(
  workspaceValue: string,
  request: ExportRequest,
  options: { output?: string; policy?: JsonRecord; signal?: AbortSignal } = {},
): Promise<JsonRecord> {
  const startedAt = Date.now();
  const { workspace, config } = await loadRuntimeContext(workspaceValue);
  const report = await loadReportPackage(workspace, request.reportId, request.reportVersion);
  const policy = options.policy ?? config.execution_strategy?.sync;
  if (!policy?.enabled) throw new RuntimeError("SYNC_DISABLED", "同步查询/导出未启用");
  const outputDirectory = relativeToWorkspace(
    workspace,
    config.storage?.local_output_directory ?? "outputs/files",
  );
  await mkdir(outputDirectory, { recursive: true });
  const output = resolve(
    options.output ?? join(outputDirectory, safeFileName(`${report.manifest.name}_${timestamp()}.xlsx`)),
  );
  await mkdir(dirname(output), { recursive: true });
  const context = { ...(request.context ?? {}) };
  if (!isEmpty(request.tenantId) && isEmpty(context.tenantId)) context.tenantId = request.tenantId;
  const execution = await createScriptRows({
    workspace,
    report,
    filters: request.filters ?? {},
    context,
    policy,
    signal: options.signal,
    isPreview: false,
  });
  try {
    const written = await writeWorkbookRows(
      report,
      execution.rows,
      output,
      policy,
      identityTransform,
      startedAt,
      () => true,
      execution.sheetState,
    );
    const executionStats = await execution.completion;
    return {
      reportId: report.manifest.id,
      reportVersion: report.manifest.version,
      filePath: output,
      fileName: basename(output),
      rowCount: written.rowCount,
      sheetCount: written.sheetCount,
      fileBytes: written.fileBytes,
      totalDurationMs: Date.now() - startedAt,
      executionModel: "isolated_script",
      scriptStats: executionStats,
    };
  } catch (error) {
    execution.cancel();
    await execution.completion.catch(() => undefined);
    await unlink(output).catch(() => undefined);
    throw error;
  }
}

/**
 * Synchronous JSON query: runs the report's query/filters/transform exactly like
 * `exportSync` but returns the 中文 column headers and data rows as JSON instead
 * of a workbook. Row count is bounded (preview) — no pagination. Intended for the
 * Studio 测试页 data preview.
 */
export async function querySync(
  workspaceValue: string,
  request: ExportRequest & { limit?: number },
  options: { policy?: JsonRecord; signal?: AbortSignal } = {},
): Promise<JsonRecord> {
  const candidate = await loadReportPackage(workspaceValue, request.reportId, request.reportVersion);
  if (String(candidate.manifest.report_package_format_version) === "3") {
    return queryScriptSync(workspaceValue, request, options);
  }
  const startedAt = Date.now();
  const prepared = await prepareSyncQuery(workspaceValue, request, options);
  const { report, policy, source, profile, dialect, compiled, transform, postFilter, enrichments, groupQueries } =
    prepared;
  const warnings: string[] = [];
  // Preview cap: request.limit (bounded by the policy) or the policy default.
  const policyMax = Number(policy.preview_max_rows ?? 1000);
  const requested = Number.isFinite(Number(request.limit)) ? Number(request.limit) : policyMax;
  const maxRows = Math.max(1, Math.min(policyMax, requested > 0 ? requested : policyMax));
  // Push the preview cap into SQL so the DB stops early instead of scanning +
  // sorting the whole table. Only safe when the transform is 1:1 (row/identity —
  // a group transform collapses many rows into one, so a raw-row LIMIT would cut
  // groups) and no post_transform filter is dropping output rows after the query.
  // Fetch maxRows+1 so `truncated` still reflects that more rows exist.
  const isGroupTransform = typeof transform !== "function" && transform.mode === "group";
  // A LIMIT push is unsafe for group_queries too: the sibling merge needs every
  // group's full result to align on merge_keys, and a raw-row LIMIT would cut it.
  const canPushLimit =
    !isGroupTransform &&
    !groupQueries &&
    !hasActivePostTransformFilter(report.bindings, request.filters ?? {});
  if (canPushLimit) {
    compiled.sql = appendPreviewLimit(compiled.sql, maxRows + 1);
  }
  let adapter: QueryAdapter | undefined;
  let queryStartedAt = 0;
  try {
    adapter = await createQueryAdapter(dialect, profile, source.database);
    await adapter.beginReadOnly();
    queryStartedAt = Date.now();
    const queryTimeoutMs = Number(policy.query_timeout_seconds ?? 600) * 1000;
    // group_queries: execute main + siblings, full-outer-merge on merge_keys, then
    // feed the merged rows through the collector with an identity transform.
    let rowStream: AsyncIterable<JsonRecord>;
    if (groupQueries) {
      const numericFieldIds = new Set<string>(
        (report.fields.fields ?? [])
          .filter((f: JsonRecord) => f.value_type === "number")
          .map((f: JsonRecord) => String(f.id)),
      );
      const mergedRows = await runGroupQueriesMerged(
        adapter,
        compiled,
        groupQueries,
        queryTimeoutMs,
        numericFieldIds,
        Number(policy.max_merged_groups ?? 100000),
      );
      rowStream = arrayToAsyncIterable(mergedRows);
    } else {
      const rawStream = await adapter.rows(compiled.sql, compiled.values, queryTimeoutMs);
      // Attach enrichment columns (batch secondary-query + in-memory merge) before
      // the collector. Batch size follows the preview cap so one IN(…) covers it.
      rowStream = enrichments.length
        ? enrichBatched(rawStream, enrichments, adapter, queryTimeoutMs, maxRows + 1, warnings)
        : rawStream;
    }
    const collected = await collectRows(report, rowStream, groupQueries ? identityTransform : transform, {
      maxRows,
      startedAt,
      totalTimeoutSeconds: Number(policy.total_timeout_seconds ?? 900),
      postFilter,
    });
    await adapter.rollback();
    return {
      reportId: report.manifest.id,
      reportName: report.manifest.name,
      reportVersion: report.manifest.version,
      columns: outputColumns(report),
      rows: collected.rows,
      rowCount: collected.rowCount,
      truncated: collected.truncated,
      limit: maxRows,
      ...(warnings.length ? { warnings } : {}),
      queryDurationMs: queryStartedAt ? Date.now() - queryStartedAt : 0,
      totalDurationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (adapter) {
      try {
        await adapter.rollback();
      } catch {
        // 原始异常优先。
      }
    }
    throw error;
  } finally {
    if (adapter) await adapter.close();
  }
}

export async function exportSync(
  workspaceValue: string,
  request: ExportRequest,
  options: { output?: string; policy?: JsonRecord; signal?: AbortSignal } = {},
): Promise<JsonRecord> {
  const candidate = await loadReportPackage(workspaceValue, request.reportId, request.reportVersion);
  if (String(candidate.manifest.report_package_format_version) === "3") {
    return exportScriptSync(workspaceValue, request, options);
  }
  const startedAt = Date.now();
  const prepared = await prepareSyncQuery(workspaceValue, request, options);
  const { workspace, config, report, policy, source, profile, dialect, compiled, transform, postFilter, enrichments, groupQueries } =
    prepared;
  const enrichWarnings: string[] = [];
  const outputDirectory = relativeToWorkspace(
    workspace,
    config.storage?.local_output_directory ?? "outputs/files",
  );
  await mkdir(outputDirectory, { recursive: true });
  const output = resolve(
    options.output ??
      join(outputDirectory, safeFileName(`${report.manifest.name}_${timestamp()}.xlsx`)),
  );
  await mkdir(dirname(output), { recursive: true });
  let adapter: QueryAdapter | undefined;
  let queryStartedAt = 0;
  try {
    adapter = await createQueryAdapter(dialect, profile, source.database);
    await adapter.beginReadOnly();
    queryStartedAt = Date.now();
    const queryTimeoutMs = Number(policy.query_timeout_seconds ?? 600) * 1000;
    // group_queries: execute main + siblings, full-outer-merge on merge_keys, then
    // write the merged rows with an identity transform.
    let rowStream: AsyncIterable<JsonRecord>;
    if (groupQueries) {
      const numericFieldIds = new Set<string>(
        (report.fields.fields ?? [])
          .filter((f: JsonRecord) => f.value_type === "number")
          .map((f: JsonRecord) => String(f.id)),
      );
      const mergedRows = await runGroupQueriesMerged(
        adapter,
        compiled,
        groupQueries,
        queryTimeoutMs,
        numericFieldIds,
        Number(policy.max_merged_groups ?? 100000),
      );
      rowStream = arrayToAsyncIterable(mergedRows);
    } else {
      const rawStream = await adapter.rows(compiled.sql, compiled.values, queryTimeoutMs);
      // Enrichment: batch by a fixed export batch size (each batch = one IN(…) query
      // per enrichment). Main row count is unchanged, so sheet/row caps stay correct.
      rowStream = enrichments.length
        ? enrichBatched(
            rawStream,
            enrichments,
            adapter,
            queryTimeoutMs,
            Number(policy.enrichment_batch_size ?? 1000),
            enrichWarnings,
          )
        : rawStream;
    }
    const written = await writeWorkbookRows(
      report,
      rowStream,
      output,
      policy,
      groupQueries ? identityTransform : transform,
      startedAt,
      postFilter,
    );
    await adapter.rollback();
    return {
      reportId: report.manifest.id,
      reportVersion: report.manifest.version,
      filePath: output,
      fileName: basename(output),
      rowCount: written.rowCount,
      sheetCount: written.sheetCount,
      fileBytes: written.fileBytes,
      ...(enrichWarnings.length ? { warnings: enrichWarnings } : {}),
      queryDurationMs: queryStartedAt ? Date.now() - queryStartedAt : 0,
      totalDurationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (adapter) {
      try {
        await adapter.rollback();
      } catch {
        // 原始异常优先。
      }
    }
    try {
      await unlink(output);
    } catch {
      // 文件可能尚未创建。
    }
    throw error;
  } finally {
    if (adapter) await adapter.close();
  }
}

function jsonResponse(response: ServerResponse, body: JsonRecord): void {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function success(requestId: string, data: unknown): JsonRecord {
  return { success: true, requestId, data };
}

function failure(requestId: string, error: unknown): JsonRecord {
  if (error instanceof RuntimeError) {
    return {
      success: false,
      requestId,
      error: {
        code: error.code,
        message: error.message,
        retryable: false,
        details: error.details ?? [],
      },
    };
  }
  return {
    success: false,
    requestId,
    error: {
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      details: [],
    },
  };
}

async function readBody(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunkValue of request) {
    const chunk = Buffer.from(chunkValue);
    size += chunk.length;
    if (size > 1_048_576) throw new RuntimeError("REQUEST_TOO_LARGE", "请求体超过 1 MiB");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRecord;
  } catch {
    throw new RuntimeError("INVALID_JSON", "请求体不是有效 JSON");
  }
}

function businessHeaders(config: JsonRecord): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.auth?.type === "bearer" && config.auth?.token) {
    headers.authorization = `Bearer ${config.auth.token}`;
  }
  return headers;
}

async function callBusiness(
  integration: JsonRecord,
  operation: JsonRecord,
  body: JsonRecord,
  taskId?: string,
): Promise<JsonRecord> {
  const path = String(operation.path).replace("{taskId}", encodeURIComponent(taskId ?? ""));
  const response = await fetch(new URL(path, integration.base_url), {
    method: operation.method ?? "POST",
    headers: businessHeaders(integration),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(operation.timeout_seconds ?? 10) * 1000),
  });
  if (!response.ok) throw new RuntimeError("BUSINESS_API_ERROR", `业务接口返回 ${response.status}`);
  return (await response.json()) as JsonRecord;
}

function assertAsyncConfigured(config: JsonRecord): void {
  const oss = config.aliyun_oss;
  const business = config.business_task_integration;
  if (
    !oss?.enabled ||
    !oss.endpoint ||
    !oss.bucket ||
    !oss.access_key_id ||
    !oss.access_key_secret
  ) {
    throw new RuntimeError("OSS_PROFILE_UNAVAILABLE", "异步导出需要先配置阿里云 OSS");
  }
  if (!business?.enabled || !business.base_url) {
    throw new RuntimeError(
      "BUSINESS_TASK_PROFILE_UNAVAILABLE",
      "异步导出需要先配置业务任务接口",
    );
  }
}

function taskDatabase(workspace: string, config: JsonRecord): DatabaseSync {
  const path = relativeToWorkspace(workspace, config.storage?.sqlite_path ?? "data/easybi-runtime.db");
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_tasks (
      id TEXT PRIMARY KEY,
      business_task_id TEXT NOT NULL,
      request_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return database;
}

async function enqueueAsync(
  context: RuntimeContext,
  request: ExportRequest,
): Promise<JsonRecord> {
  assertAsyncConfigured(context.config);
  const database = taskDatabase(context.workspace, context.config);
  try {
    const queued = database
      .prepare("SELECT COUNT(*) AS count FROM runtime_tasks WHERE status IN ('QUEUED','RUNNING')")
      .get() as JsonRecord;
    if (Number(queued.count) >= Number(context.config.execution_strategy.async.max_queue_size)) {
      throw new RuntimeError("ASYNC_QUEUE_FULL", "异步任务队列已满");
    }
    const external = await callBusiness(
      context.config.business_task_integration,
      context.config.business_task_integration.create_task,
      {
        reportId: request.reportId,
        reportVersion: request.reportVersion ?? null,
        tenantId: request.tenantId ?? request.context?.tenantId ?? null,
        status: "PROCESSING",
      },
    );
    const businessTaskId = String(
      external.data?.taskId ?? external.taskId ?? external.id ?? "",
    );
    if (!businessTaskId) {
      throw new RuntimeError("BUSINESS_TASK_ID_MISSING", "创建任务接口未返回 taskId");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    database
      .prepare(
        "INSERT INTO runtime_tasks(id,business_task_id,request_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, businessTaskId, JSON.stringify(request), "QUEUED", now, now);
    return {
      executionMode: "async",
      runtimeTaskId: id,
      businessTaskId,
      status: "QUEUED",
      acceptedAt: now,
    };
  } finally {
    database.close();
  }
}

async function uploadOss(config: JsonRecord, filePath: string): Promise<string> {
  const moduleName = "ali-oss";
  const imported = (await import(moduleName)) as JsonRecord;
  const Client = imported.default ?? imported;
  const client = new Client({
    region: config.region || undefined,
    endpoint: config.endpoint,
    bucket: config.bucket,
    accessKeyId: config.access_key_id,
    accessKeySecret: config.access_key_secret,
  });
  const objectName = `${String(config.object_prefix ?? "easybi").replace(/\/+$/, "")}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${basename(filePath)}`;
  await client.put(objectName, filePath);
  if (config.url_mode === "public") {
    return `https://${config.bucket}.${String(config.endpoint).replace(/^https?:\/\//, "")}/${objectName}`;
  }
  return client.signatureUrl(objectName, {
    expires: Number(config.signed_url_expires_seconds ?? 86400),
  });
}

async function processOneTask(
  context: RuntimeContext,
  activeTasks: Map<string, AbortController>,
): Promise<boolean> {
  const database = taskDatabase(context.workspace, context.config);
  let task: JsonRecord | undefined;
  try {
    database.exec("BEGIN IMMEDIATE");
    task = database
      .prepare("SELECT * FROM runtime_tasks WHERE status = 'QUEUED' ORDER BY created_at LIMIT 1")
      .get() as JsonRecord | undefined;
    if (!task) {
      database.exec("COMMIT");
      return false;
    }
    database
      .prepare("UPDATE runtime_tasks SET status='RUNNING',attempts=attempts+1,updated_at=? WHERE id=?")
      .run(new Date().toISOString(), task.id);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    database.close();
  }

  const request = JSON.parse(task.request_json) as ExportRequest;
  const controller = new AbortController();
  activeTasks.set(String(task.id), controller);
  let generatedFile: string | undefined;
  try {
    const exported = await exportSync(context.workspace, request, {
      policy: {
        ...context.config.execution_strategy.sync,
        enabled: true,
        query_timeout_seconds:
          context.config.execution_strategy.async.query_timeout_seconds,
        total_timeout_seconds:
          context.config.execution_strategy.async.query_timeout_seconds + 300,
      },
      signal: controller.signal,
    });
    generatedFile = exported.filePath;
    const fileUrl = await uploadOss(context.config.aliyun_oss, exported.filePath);
    await callBusiness(
      context.config.business_task_integration,
      context.config.business_task_integration.update_task,
      {
        taskId: task.business_task_id,
        reportId: request.reportId,
        tenantId: request.tenantId ?? request.context?.tenantId ?? null,
        status: "COMPLETED",
        fileUrl,
        fileName: exported.fileName,
      },
      task.business_task_id,
    );
    const done = taskDatabase(context.workspace, context.config);
    done.prepare("UPDATE runtime_tasks SET status='COMPLETED',updated_at=? WHERE id=?")
      .run(new Date().toISOString(), task.id);
    done.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stateDb = taskDatabase(context.workspace, context.config);
    const current = stateDb.prepare("SELECT status FROM runtime_tasks WHERE id=?").get(task.id) as JsonRecord;
    stateDb.close();
    const canceled = current?.status === "CANCELED" || controller.signal.aborted;
    try {
      await callBusiness(
        context.config.business_task_integration,
        context.config.business_task_integration.update_task,
        {
          taskId: task.business_task_id,
          reportId: request.reportId,
          tenantId: request.tenantId ?? request.context?.tenantId ?? null,
          status: canceled ? "CANCELED" : "FAILED",
          errorMessage: message,
        },
        task.business_task_id,
      );
    } catch {
      // Internal cancellation/failure state remains authoritative when the
      // optional business-task endpoint does not understand CANCELED.
    } finally {
      const failed = taskDatabase(context.workspace, context.config);
      failed.prepare("UPDATE runtime_tasks SET status=?,last_error=?,updated_at=? WHERE id=?")
        .run(canceled ? "CANCELED" : "FAILED", message, new Date().toISOString(), task.id);
      failed.close();
    }
  } finally {
    activeTasks.delete(String(task.id));
    if (generatedFile) await unlink(generatedFile).catch(() => undefined);
  }
  return true;
}

export async function createRuntimeServer(workspaceValue: string): Promise<{
  server: ReturnType<typeof createServer>;
  context: RuntimeContext;
  close: () => Promise<void>;
}> {
  const context = await loadRuntimeContext(workspaceValue);
  const recoveryDatabase = taskDatabase(context.workspace, context.config);
  recoveryDatabase.prepare("UPDATE runtime_tasks SET status='QUEUED',updated_at=? WHERE status='RUNNING'")
    .run(new Date().toISOString());
  recoveryDatabase.close();
  let stopping = false;
  const activeRequests = new Map<string, AbortController>();
  const activeTasks = new Map<string, AbortController>();
  const workerTimers = new Set<NodeJS.Timeout>();
  const worker = async (): Promise<void> => {
    if (stopping) return;
    try {
      if (context.config.execution_strategy?.async?.enabled) {
        await processOneTask(context, activeTasks);
      }
    } catch (error) {
      console.error("异步任务处理失败：", error);
    } finally {
      if (!stopping) {
        const timer = setTimeout(() => {
          workerTimers.delete(timer);
          void worker();
        }, 1_000);
        workerTimers.add(timer);
      }
    }
  };
  const server = createServer(async (request, response) => {
    const requestId =
      String(request.headers["x-request-id"] ?? "").trim() || randomUUID();
    try {
      const url = new URL(request.url ?? "/", "http://easybi.local");
      const cancelMatch = url.pathname.match(/^\/api\/v1\/executions\/([^/]+)$/);
      if (request.method === "DELETE" && cancelMatch) {
        const targetRequestId = decodeURIComponent(cancelMatch[1]!);
        const controller = activeRequests.get(targetRequestId);
        if (!controller) {
          throw new RuntimeError("EXECUTION_NOT_FOUND", `未找到运行中的执行：${targetRequestId}`);
        }
        controller.abort();
        jsonResponse(response, success(requestId, { canceled: true, requestId: targetRequestId }));
        return;
      }
      const cancelTaskMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
      if (request.method === "DELETE" && cancelTaskMatch) {
        const taskId = decodeURIComponent(cancelTaskMatch[1]!);
        const database = taskDatabase(context.workspace, context.config);
        const task = database.prepare("SELECT status FROM runtime_tasks WHERE id=?").get(taskId) as JsonRecord | undefined;
        if (!task || !["QUEUED", "RUNNING"].includes(String(task.status))) {
          database.close();
          throw new RuntimeError("TASK_NOT_CANCELABLE", `异步任务不存在或不可取消：${taskId}`);
        }
        database.prepare("UPDATE runtime_tasks SET status='CANCELED',updated_at=? WHERE id=?")
          .run(new Date().toISOString(), taskId);
        database.close();
        activeTasks.get(taskId)?.abort();
        jsonResponse(response, success(requestId, { canceled: true, runtimeTaskId: taskId }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/reports") {
        jsonResponse(
          response,
          success(requestId, { items: await listReports(context.workspace) }),
        );
        return;
      }
      const parameterMatch = url.pathname.match(/^\/api\/v1\/reports\/([^/]+)\/parameters$/);
      if (request.method === "GET" && parameterMatch) {
        jsonResponse(
          response,
          success(
            requestId,
            await getReportParameters(
              context.workspace,
              decodeURIComponent(parameterMatch[1]!),
              url.searchParams.get("version") ?? undefined,
            ),
          ),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/exports") {
        const body = (await readBody(request)) as ExportRequest;
        if (!body.reportId) throw new RuntimeError("REPORT_ID_REQUIRED", "缺少 reportId");
        const mode =
          body.executionMode ??
          context.config.execution_strategy?.default_mode ??
          "sync";
        if (mode === "async") {
          jsonResponse(
            response,
            success(requestId, await enqueueAsync(context, body)),
          );
          return;
        }
        if (mode !== "sync") {
          throw new RuntimeError("INVALID_EXECUTION_MODE", `未知执行方式：${mode}`);
        }
        const controller = new AbortController();
        activeRequests.set(requestId, controller);
        const cancelOnDisconnect = (): void => {
          if (!response.writableEnded) controller.abort();
        };
        response.once("close", cancelOnDisconnect);
        request.once("aborted", cancelOnDisconnect);
        let exported: JsonRecord;
        try {
          exported = await exportSync(context.workspace, body, { signal: controller.signal });
        } finally {
          activeRequests.delete(requestId);
          response.removeListener("close", cancelOnDisconnect);
          request.removeListener("aborted", cancelOnDisconnect);
        }
        response.writeHead(200, {
          "content-type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(exported.fileName)}`,
          "content-length": String(exported.fileBytes),
          "x-easybi-row-count": String(exported.rowCount),
          "x-easybi-sheet-count": String(exported.sheetCount),
          "x-easybi-execution-mode": "sync",
          "x-easybi-request-id": requestId,
        });
        const stream = createReadStream(exported.filePath);
        stream.pipe(response);
        stream.on("close", () => unlink(exported.filePath).catch(() => undefined));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/queries") {
        // Synchronous JSON query: returns 中文 表头 (columns) + 数据 (rows) for
        // preview. Same query/filters/transform as export; bounded row count, no
        // pagination. Always sync (no async mode for a preview).
        const body = (await readBody(request)) as ExportRequest & { limit?: number };
        if (!body.reportId) throw new RuntimeError("REPORT_ID_REQUIRED", "缺少 reportId");
        const controller = new AbortController();
        activeRequests.set(requestId, controller);
        const cancelOnDisconnect = (): void => {
          if (!response.writableEnded) controller.abort();
        };
        response.once("close", cancelOnDisconnect);
        request.once("aborted", cancelOnDisconnect);
        try {
          jsonResponse(
            response,
            success(requestId, await querySync(context.workspace, body, { signal: controller.signal })),
          );
        } finally {
          activeRequests.delete(requestId);
          response.removeListener("close", cancelOnDisconnect);
          request.removeListener("aborted", cancelOnDisconnect);
        }
        return;
      }
      throw new RuntimeError("NOT_FOUND", "接口不存在");
    } catch (error) {
      if (!response.headersSent) jsonResponse(response, failure(requestId, error));
      else response.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  server.on("listening", () => {
    if (
      context.config.execution_strategy?.async?.enabled &&
      context.config.aliyun_oss?.enabled &&
      context.config.business_task_integration?.enabled
    ) {
      const concurrency = Math.max(
        1,
        Number(context.config.execution_strategy.async.worker_concurrency ?? 1),
      );
      for (let index = 0; index < concurrency; index += 1) void worker();
    }
  });
  return {
    server,
    context,
    close: async () => {
      stopping = true;
      for (const controller of activeRequests.values()) controller.abort();
      activeRequests.clear();
      for (const controller of activeTasks.values()) controller.abort();
      activeTasks.clear();
      for (const timer of workerTimers) clearTimeout(timer);
      workerTimers.clear();
      await new Promise<void>((resolvePromise, rejectPromise) =>
        server.close((error) => error ? rejectPromise(error) : resolvePromise()),
      );
    },
  };
}
