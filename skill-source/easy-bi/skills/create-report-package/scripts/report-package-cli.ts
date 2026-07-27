#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FLAG_OPERATOR_SYMBOLS,
  hasSkeletonInjection,
  hasUnsafeSqlExpression,
  isBareQuotedColumnRef,
  isValidExistsSkeleton,
} from "./sql-guard.js";

type JsonRecord = Record<string, any>;

const PACKAGE_FORMAT_VERSION = "2";
const SCRIPT_PACKAGE_FORMAT_VERSION = "3";
const PLAN_FORMAT_VERSION = "2";
const ALLOWED_MODES = new Set(["sync", "async"]);
const ALLOWED_OPERATORS = new Set([
  "eq",
  "in",
  "contains",
  "between",
  "gte",
  "lte",
]);

const SCRIPT_FORBIDDEN_SOURCE =
  /\b(?:import|require|eval|Function|process|globalThis|child_process|worker_threads|fetch|WebSocket)\b|(?:node:|https?:|file:)|\b(?:fs|net|tls|dgram)\s*\./;

function parseArguments(values: string[]): {
  command: string;
  options: Record<string, string>;
} {
  const command = values[0] ?? "";
  const options: Record<string, string> = {};
  for (let index = 1; index < values.length; index += 1) {
    const token = values[index];
    if (!token?.startsWith("--")) {
      throw new Error(`无法识别的参数：${token ?? ""}`);
    }
    const equalsAt = token.indexOf("=");
    if (equalsAt > 2) {
      options[token.slice(2, equalsAt)] = token.slice(equalsAt + 1);
      continue;
    }
    const key = token.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = "true";
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

function requiredOption(
  options: Record<string, string>,
  name: string,
): string {
  const value = options[name];
  if (!value) {
    throw new Error(`缺少必填参数 --${name}`);
  }
  return value;
}

async function readJson(path: string): Promise<JsonRecord> {
  const raw = await readFile(path, "utf8");
  try {
    return JSON.parse(raw) as JsonRecord;
  } catch (error) {
    const msg = error instanceof SyntaxError ? error.message : String(error);
    // Extract position from Node's JSON.parse error (e.g. "at position 9067")
    const posMatch = msg.match(/at position (\d+)/);
    if (posMatch) {
      const pos = Number(posMatch[1]);
      const start = Math.max(0, pos - 60);
      const end = Math.min(raw.length, pos + 60);
      const ctx = raw.slice(start, end).replace(/\n/g, "\\n");
      throw new Error(`JSON 解析失败（位置 ${pos} 附近）：「${ctx}」—— ${msg}。请检查该位置是否有未转义的直双引号 " 或中文弯引号 ""，应改用 「」`);
    }
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function listJsonFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        result.push(path);
      }
    }
  }
  await visit(root);
  return result.sort();
}

async function listPackageFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (
        entry.isFile() &&
        entry.name !== "checksums.sha256" &&
        entry.name !== "signature.ed25519"
      ) {
        result.push(relative(root, path).split("\\").join("/"));
      }
    }
  }
  await visit(root);
  return result.sort();
}

async function writePackageChecksums(root: string): Promise<void> {
  const lines: string[] = [];
  for (const file of await listPackageFiles(root)) {
    const content = await readFile(join(root, file));
    lines.push(`${sha256(content)}  ${file}`);
  }
  await writeFile(
    join(root, "checksums.sha256"),
    `${lines.join("\n")}\n`,
    "utf8",
  );
}

function stableId(value: string): string {
  const normalized = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `field-${sha256(value).slice(0, 8)}`;
}

/**
 * SQL identifier quoting is engine-specific: MySQL uses backticks (`col`) while
 * PostgreSQL uses double quotes ("col"). The report skill only generates SQL text
 * here (it never connects), so a tiny dialect object carries the quote character
 * and the reference-extraction regex used by the safety checks. MySQL is the
 * default so older plans/packages without an engine keep their exact behavior.
 */
type SqlDialect = {
  id: "mysql" | "postgresql";
  quoteChar: string;
  quote(value: string): string;
  /** Fresh /g regex matching `alias`.`col` (or alias."col") column references. */
  referenceRegex(): RegExp;
};

function normalizeEngine(engine: unknown): "mysql" | "postgresql" {
  const value = String(engine ?? "").toLowerCase();
  if (value === "postgresql" || value === "postgres" || value === "pg") {
    return "postgresql";
  }
  return "mysql";
}

function getSqlDialect(engine: unknown): SqlDialect {
  const id = normalizeEngine(engine);
  const quoteChar = id === "postgresql" ? '"' : "`";
  return {
    id,
    quoteChar,
    quote(value: string): string {
      if (!/^[A-Za-z0-9_$]+$/.test(value)) {
        throw new Error(`不安全的标识符：${value}`);
      }
      return `${quoteChar}${value.replaceAll(quoteChar, quoteChar + quoteChar)}${quoteChar}`;
    },
    referenceRegex(): RegExp {
      return new RegExp(
        `\\b([A-Za-z][A-Za-z0-9_]*)\\.${quoteChar}([A-Za-z0-9_$]+)${quoteChar}`,
        "g",
      );
    },
  };
}

const DEFAULT_DIALECT = getSqlDialect("mysql");

/** Dialect a plan was built for; older plans without sql_dialect default to mysql. */
function dialectForPlan(plan: JsonRecord): SqlDialect {
  return getSqlDialect(plan.sql_dialect ?? "mysql");
}

/** Resolve the SQL engine for a plan from its knowledge config profile. */
function resolveEngine(config: JsonRecord, profileId: unknown): string {
  const profile = (config.connections?.database_profiles ?? []).find(
    (item: JsonRecord) => item.id === profileId,
  );
  return String(profile?.connector_id ?? "mysql");
}

function quoteIdentifier(
  value: string,
  dialect: SqlDialect = DEFAULT_DIALECT,
): string {
  return dialect.quote(value);
}

function tableKey(value: JsonRecord): string {
  return `${value.profile_id}/${value.database}/${value.table}`;
}

const RELATION_ALIASES: Record<string, string> = {
  inner_join: 'inner',
  left_join: 'left',
  right_join: 'right',
  full_join: 'full',
  cross_join: 'cross',
};
const MODEL_RELATION_TYPES = new Set(["left", "inner"]);
const MODEL_CARDINALITIES = new Set(["1:1", "1:n", "n:1", "n:n", "unknown"]);
const MODEL_CALCULATION_KINDS = new Set(["aggregate", "formula", "comparison", "window", "merge"]);
const MODEL_CALCULATION_EXECUTION_HINTS = new Set(["auto", "sql", "script"]);
const MODEL_CALCULATION_AGGREGATIONS = new Set(["sum", "count", "count_distinct", "avg", "min", "max", "first", "last"]);
const MODEL_CALCULATION_WINDOWS = new Set(["row_number", "rank", "dense_rank", "running_sum", "moving_avg", "lag", "lead"]);
const MODEL_CALCULATION_COMPARISONS = new Set(["difference", "rate", "chain", "yoy"]);
const MODEL_CALCULATION_MERGES = new Set(["add", "subtract", "multiply", "divide", "coalesce"]);
function normalizeRelationType(value: string): string {
  const key = value.trim().toLowerCase();
  return RELATION_ALIASES[key] ?? key;
}

function assertAlias(value: unknown): string {
  const alias = String(value ?? "");
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`不安全的表别名：${alias}`);
  }
  return alias;
}

/** Concatenation aggregates: filtering these means "does any child match", i.e.
 * an EXISTS semi-join — not a comparison of the aggregate itself. */
const CONCAT_FN = /\b(GROUP_CONCAT|STRING_AGG|ARRAY_AGG|JSON_ARRAYAGG)\s*\(/i;

/** True for GROUP_CONCAT-style fields where a filter means "any child matches". */
function isConcatField(field: JsonRecord): boolean {
  if (field.source?.kind !== "sql_expression") return false;
  return CONCAT_FN.test(String(field.source?.expression ?? ""));
}

/**
 * Build a correlated EXISTS subquery skeleton for filtering a one-to-many child
 * column WITHOUT flattening the parent grain. Instead of matching the aggregated
 * (GROUP_CONCAT) value in HAVING — which forces every group's string to be
 * materialised first and can silently miss rows past group_concat_max_len — we
 * push the filter down to a semi-join: "return the parent row when ANY child row
 * matches". Short-circuits and uses child indexes; the SELECT still concatenates
 * every child value for output.
 *
 * The skeleton is built entirely from KNOWLEDGE (join keys, child table, logical
 * delete conditions) — never from user input — so the runtime only binds the
 * search value as a `?` inside the inner predicate. The SQL-safety guard is never
 * relaxed: the generated `prefix`/`suffix` are trusted, and the inner column is a
 * plain `alias.col` reference that still passes safeExpression.
 *
 * Returns null when the field isn't a filterable child column of a join (e.g. a
 * multi-column aggregate expression), so the caller can fall back to HAVING.
 */
function buildExistsSkeleton(
  plan: JsonRecord,
  field: JsonRecord,
  dialect: SqlDialect,
): { prefix: string; inner_expression: string; suffix: string; child_alias: string } | null {
  const primaryAlias = assertAlias(plan.source?.primary_table?.alias);
  // Identify the child column this aggregate concatenates. Prefer an explicit
  // single dependency; otherwise parse the one reference out of the expression.
  const deps = (field.source?.dependencies ?? []) as JsonRecord[];
  let childAlias: string | undefined;
  let childField: string | undefined;
  if (deps.length === 1 && deps[0]?.alias && deps[0]?.field) {
    childAlias = String(deps[0].alias);
    childField = String(deps[0].field);
  } else {
    const refs = [...String(field.source?.expression ?? "").matchAll(dialect.referenceRegex())];
    const distinct = new Set(refs.map((m) => `${m[1]}.${m[2]}`));
    if (distinct.size === 1 && refs[0]) {
      childAlias = refs[0][1];
      childField = refs[0][2];
    }
  }
  if (!childAlias || !childField || childAlias === primaryAlias) return null;

  const joinItem = (plan.source?.joins ?? []).find(
    (item: JsonRecord) => assertAlias(item.alias) === childAlias,
  );
  const childTable = (plan.source?.tables ?? []).find(
    (table: JsonRecord) => assertAlias(table.alias) === childAlias,
  );
  if (!joinItem || !childTable || !(joinItem.on ?? []).length) return null;

  const columns = availableColumnsForPlan(plan);
  // A distinct inner alias so the subquery never collides with an outer alias.
  const exAlias = `ex_${childAlias}`;
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(exAlias)) return null;

  // Correlation predicates: rewrite each ON pair to correlate the inner alias
  // with the outer parent, e.g. t1.driver_id = t0.id  ->  ex_t1.driver_id = t0.id.
  const correlations: string[] = [];
  for (const condition of joinItem.on ?? []) {
    const left = normalizeColumnReference(condition.left, columns);
    const right = normalizeColumnReference(condition.right, columns);
    const child = left.alias === childAlias ? left : right.alias === childAlias ? right : null;
    const parent = left.alias === childAlias ? right : left;
    if (!child) return null;
    correlations.push(
      `${exAlias}.${quoteIdentifier(child.field, dialect)} = ${columnExpression(parent.alias, parent.field, dialect)}`,
    );
  }
  if (!correlations.length) return null;

  // Static logical-delete / system conditions on the child, values inlined from
  // knowledge (never user input); only literals that are safe numbers/booleans.
  const staticConds: string[] = [];
  for (const condition of joinItem.conditions ?? []) {
    const op = condition.operator === "eq" ? "=" : String(condition.operator);
    if (!["=", "!=", "<>", ">", ">=", "<", "<="].includes(op)) continue;
    const lit = sqlLiteral(condition.value);
    if (lit === null) continue;
    staticConds.push(`${exAlias}.${quoteIdentifier(String(condition.field), dialect)} ${op} ${lit}`);
  }

  const table = `${quoteIdentifier(String(childTable.database), dialect)}.${quoteIdentifier(String(childTable.table), dialect)}`;
  const where = [...correlations, ...staticConds].join(" AND ");
  return {
    prefix: `EXISTS (SELECT 1 FROM ${table} AS ${exAlias} WHERE ${where} AND `,
    inner_expression: `${exAlias}.${quoteIdentifier(childField, dialect)}`,
    suffix: ")",
    child_alias: exAlias,
  };
}

/** A safe SQL literal for a knowledge-provided condition value (no user input). */
function sqlLiteral(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return value;
  return null;
}

/**
 * Build a correlated EXISTS skeleton to FILTER by an enrichment column, pushed
 * into the main query's WHERE (so filtering happens in SQL — "先筛后取" — never in
 * memory, which would drop matches outside the fetched batch). Correlates the
 * lookup table back to the main query's key column: EXISTS (SELECT 1 FROM lookup
 * ex WHERE ex.lookup_key = <mainKeyColumn> AND <conditions> AND <ex.select_col ? >).
 *
 * Requires the enrichment key to resolve to a real `alias.field` in the main
 * query (`mainKeyColumn`), i.e. the key must come from the main query (not a
 * chained upstream enrichment whose table isn't in the FROM). Returns null when
 * it can't be built, so the caller refuses the filter rather than filtering wrong.
 */
function buildEnrichmentExistsSkeleton(
  enrichment: JsonRecord,
  filterLookupField: string,
  mainKeyColumn: string, // e.g. "t0.`waybill_code`" — already quoted
  dialect: SqlDialect,
): { prefix: string; inner_expression: string; suffix: string } | null {
  const lookup = enrichment.lookup ?? {};
  const exAlias = `ex_${enrichment.id}`;
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(exAlias)) return null;
  const table = `${quoteIdentifier(String(lookup.database), dialect)}.${quoteIdentifier(String(lookup.table), dialect)}`;
  const correlation = `${exAlias}.${quoteIdentifier(String(enrichment.on.lookup_field), dialect)} = ${mainKeyColumn}`;
  const staticConds: string[] = [];
  for (const condition of enrichment.conditions ?? []) {
    const op = condition.operator === "eq" ? "=" : String(condition.operator);
    if (!["=", "!=", "<>", ">", ">=", "<", "<="].includes(op)) continue;
    const lit = sqlLiteral(condition.value);
    if (lit === null) continue;
    staticConds.push(`${exAlias}.${quoteIdentifier(String(condition.field), dialect)} ${op} ${lit}`);
  }
  const where = [correlation, ...staticConds].join(" AND ");
  return {
    prefix: `EXISTS (SELECT 1 FROM ${table} AS ${exAlias} WHERE ${where} AND `,
    inner_expression: `${exAlias}.${quoteIdentifier(filterLookupField, dialect)}`,
    suffix: ")",
  };
}

function columnExpression(
  aliasValue: unknown,
  fieldValue: unknown,
  dialect: SqlDialect = DEFAULT_DIALECT,
): string {
  return `${assertAlias(aliasValue)}.${quoteIdentifier(String(fieldValue ?? ""), dialect)}`;
}

function assertSafeSqlExpression(
  value: unknown,
  availableColumns: Map<string, Set<string>>,
  dialect: SqlDialect = DEFAULT_DIALECT,
): string {
  const expression = String(value ?? "").trim();
  if (!expression) throw new Error("SQL 表达式不能为空");
  // The identifier quote char is dialect-specific and allowed; the OTHER quote
  // char plus single quotes stay banned so string literals can never appear.
  // (shared with the Runtime guard via sql-guard.ts)
  if (hasUnsafeSqlExpression(expression, dialect.quoteChar)) {
    throw new Error(`不安全的 SQL 表达式：${expression}`);
  }
  const references = [...expression.matchAll(dialect.referenceRegex())];
  if (!references.length) {
    throw new Error(`SQL 表达式必须显式引用带别名的列：${expression}`);
  }
  for (const match of references) {
    const alias = match[1]!;
    const field = match[2]!;
    if (!availableColumns.get(alias)?.has(field)) {
      throw new Error(`SQL 表达式引用了未知列：${alias}.${field}`);
    }
  }
  return expression;
}

/** A bare `alias.field` column reference (no dialect quoting, no db prefix). */
const COLUMN_REF_RE = /^([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z0-9_$]+)$/;

/**
 * A boolean-flag field folds a numeric/status column into a 是/否 value by
 * comparing it to a threshold (e.g. 回单数量 receipt_count > 0 → 已上传/未上传). The
 * descriptor lives on `field.source` as {kind:"boolean_flag", alias, field,
 * operator, threshold}; the label is what the user sees, the underlying column
 * stays hidden. The comparison operator is one of a fixed set (never free text) and
 * the threshold is coerced with Number(), so no injection vector exists.
 */
function isBooleanFlagField(field: JsonRecord): boolean {
  return field?.source?.kind === "boolean_flag";
}

/**
 * Validate a boolean-flag source and return its parts. Throws a caller-friendly
 * error if the operator isn't in the allowed set or the threshold isn't finite.
 * The column existence is checked separately against the plan's available columns.
 */
function resolveBooleanFlag(field: JsonRecord): {
  alias: string;
  field: string;
  operator: string;
  threshold: number;
} {
  const source = field.source ?? {};
  const alias = String(source.alias ?? "");
  const column = String(source.field ?? "");
  const operator = String(source.operator ?? "gt");
  if (!COLUMN_REF_RE.test(`${alias}.${column}`)) {
    throw new Error(`布尔字段 ${field.id} 的列引用无效：${alias}.${column}`);
  }
  if (!(operator in FLAG_OPERATOR_SYMBOLS)) {
    throw new Error(
      `布尔字段 ${field.id} 的比较符无效：${operator}（可选 ${Object.keys(FLAG_OPERATOR_SYMBOLS).join("/")}）`,
    );
  }
  const threshold = Number(source.threshold ?? 0);
  if (!Number.isFinite(threshold)) {
    throw new Error(`布尔字段 ${field.id} 的阈值必须是数值：${source.threshold}`);
  }
  return { alias, field: column, operator, threshold };
}

/**
 * The SELECT expression that materialises a boolean-flag column as 1/0 (rendered
 * 是/否 via the {1:"是",0:"否"} enum map). Built from validated parts only.
 */
function booleanFlagSelectExpression(field: JsonRecord, dialect: SqlDialect): string {
  const { alias, field: column, operator, threshold } = resolveBooleanFlag(field);
  const col = columnExpression(alias, column, dialect);
  const symbol = FLAG_OPERATOR_SYMBOLS[operator]!;
  return `CASE WHEN ${col} ${symbol} ${threshold} THEN 1 ELSE 0 END`;
}

function normalizeColumnReference(
  value: unknown,
  availableColumns: Map<string, Set<string>>,
): { alias: string; field: string } {
  const text = String(value ?? "");
  const match = text.match(COLUMN_REF_RE);
  if (!match || !availableColumns.get(match[1]!)?.has(match[2]!)) {
    throw new Error(`未知列引用：${text}`);
  }
  return { alias: match[1]!, field: match[2]! };
}

function parseFieldReference(value: string): {
  database?: string;
  table?: string;
  field: string;
} {
  const parts = value.split(".").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 1) {
    return { field: parts[0]! };
  }
  if (parts.length === 2) {
    return { table: parts[0]!, field: parts[1]! };
  }
  return {
    database: parts.at(-3),
    table: parts.at(-2),
    field: parts.at(-1)!,
  };
}

function outputValueType(field: JsonRecord): string {
  const dataType = String(field.physical?.data_type ?? "").toLowerCase();
  const role = field.filter?.role;
  if (role === "enum") return "string";
  if (role === "boolean" || dataType === "boolean" || dataType === "bool") {
    return "boolean";
  }
  if (dataType === "date") return "date";
  if (["datetime", "timestamp"].includes(dataType)) return "datetime";
  if (
    ["tinyint", "smallint", "mediumint", "int", "integer", "bigint", "decimal", "numeric", "float", "double"].includes(
      dataType,
    ) &&
    field.filter?.role !== "business_identifier"
  ) {
    return "number";
  }
  return "string";
}

function parameterValueType(field: JsonRecord): string {
  const inputType = field.filter?.input_type;
  if (
    ["date_range", "datetime_range", "number_range"].includes(inputType)
  ) {
    return inputType;
  }
  if (field.filter?.role === "enum" || inputType === "select") return "enum";
  if (field.filter?.role === "boolean" || inputType === "boolean") {
    return "boolean";
  }
  return "string";
}

/** A date/datetime output column is filtered as a range (start + end), never a
 * single value — the picker on the test page maps to `{from, to}` + BETWEEN. */
function isDateLikeOutput(outputType: unknown): boolean {
  return outputType === "date" || outputType === "datetime";
}

/** Physical-name conventions for a "created time" column. Shared by the output
 * field detector and the default-ordering builder so both stay consistent. */
const CREATE_TIME_NAME_PATTERNS = [
  /^create_?time$/,
  /^created_?at$/,
  /^create_?date$/,
  /^created_?date$/,
  /^created_?time$/,
  /^gmt_?create$/,
  /^gmt_?created$/,
  /^add_?time$/,
  /^insert_?time$/,
  /^create_?on$/,
  /^created_?on$/,
];
/** Semantic-label / comment conventions for a "created time" column (中文). */
const CREATE_TIME_LABEL_RE = /创建时间|创建日期|新增时间|录入时间|创建于/;

/** True when a physical column name follows a create-time convention. */
function isCreateTimeName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n.length > 0 && CREATE_TIME_NAME_PATTERNS.some((re) => re.test(n));
}

/** True when a field is the report's "created time" — matched by physical name or
 * semantic label against common conventions (create_time / created_at / gmt_create
 * / 创建时间 …). Such a filter is forced required per product rule. */
function isCreateTimeField(field: JsonRecord): boolean {
  if (!isDateLikeOutput(field.output_type)) return false;
  const name = String(field.source?.field ?? "");
  const label = String(field.label ?? "");
  if (isCreateTimeName(name)) return true;
  return CREATE_TIME_LABEL_RE.test(label);
}

/**
 * Find a table's "created time" physical column, so reports can default-sort by
 * newest first even when create-time is not one of the report's output columns.
 * Prefers a physical-name match; falls back to a semantic-label / comment match.
 * Returns the physical column name, or undefined when the table has none.
 */
function findCreateTimeColumn(table: JsonRecord | undefined): string | undefined {
  const fields = (table?.physical_fields ?? []) as JsonRecord[];
  for (const field of fields) {
    const name = String(field.physical?.name ?? "");
    if (isCreateTimeName(name)) return name;
  }
  for (const field of fields) {
    const name = String(field.physical?.name ?? "");
    if (!name) continue;
    const labels = [
      field.semantic?.name,
      field.semantic?.label,
      field.physical?.comment,
    ].filter((value): value is string => typeof value === "string");
    if (labels.some((label) => CREATE_TIME_LABEL_RE.test(label))) return name;
  }
  return undefined;
}

/**
 * All of a table's date/datetime "created time" columns (by physical name or
 * semantic label), each with the label + value_type needed to synthesize a
 * required month-range filter. Used so a comparison (环比/同比) report can default
 * its `period_param` to the create-time column without the user re-declaring it —
 * exactly one candidate is auto-used; zero or several trigger a clear prompt.
 */
function findCreateTimeCandidates(
  table: JsonRecord | undefined,
): Array<{ field: string; label: string; value_type: string }> {
  const fields = (table?.physical_fields ?? []) as JsonRecord[];
  const out: Array<{ field: string; label: string; value_type: string }> = [];
  for (const field of fields) {
    const name = String(field.physical?.name ?? "");
    if (!name) continue;
    const valueType = outputValueType(field);
    if (valueType !== "date" && valueType !== "datetime") continue;
    const labels = [
      field.semantic?.name,
      field.semantic?.label,
      field.physical?.comment,
    ].filter((value): value is string => typeof value === "string");
    const isCreateTime =
      isCreateTimeName(name) || labels.some((label) => CREATE_TIME_LABEL_RE.test(label));
    if (!isCreateTime) continue;
    out.push({
      field: name,
      label: labels[0] ?? name,
      value_type: valueType === "date" ? "date_range" : "datetime_range",
    });
  }
  return out;
}

/**
 * Normalize a date/datetime field's filter into a range filter: a two-bound
 * (start / end) BETWEEN selection rendered by a datetime picker. Create-time
 * fields are additionally forced required. Returns the effective filter object
 * used to build the parameter (does not mutate the plan field's knowledge copy).
 */
function rangeFilterFor(field: JsonRecord): JsonRecord {
  const base = { ...(field.filter ?? {}) } as JsonRecord;
  if (!isDateLikeOutput(field.output_type)) return base;
  const inputType = field.output_type === "date" ? "date_range" : "datetime_range";
  return {
    ...base,
    enabled: base.enabled ?? true,
    visibility: base.visibility ?? "user",
    input_type: inputType,
    operators: ["between", "gte", "lte"],
    default_operator: "between",
    required: base.required === true || isCreateTimeField(field),
  };
}

function componentFor(valueType: string, operators: string[]): string {
  if (valueType === "enum") return "multi-select";
  if (valueType === "date_range") return "date-range";
  if (valueType === "datetime_range") return "datetime-range";
  if (valueType === "number_range") return "number-range";
  if (valueType === "boolean") return "switch";
  if (operators.includes("in")) return "text-list";
  return "text";
}

/** Comparison (环比/同比) modes the runtime knows how to look back for. */
const COMPARISON_MODES = new Set(["chain", "yoy"]);

/** Time-shifted metric (单字段跨期计算) supported shift modes. */
const TIME_SHIFTED_SHIFT_MODES = new Set(["chain", "yoy"]);
/** Time-shifted metric supported operations between current and shifted value. */
const TIME_SHIFTED_OPERATIONS = new Set(["subtract", "divide", "percent_change"]);

/**
 * Normalize and validate a time_shifted field source declaration.
 * Expected shape:
 *   { kind: "time_shifted", base_metric: "field_xxx", shift: "chain"|"yoy",
 *     lookback: number, operation: "subtract"|"divide"|"percent_change" }
 */
function normalizeTimeShiftedSource(raw: unknown): JsonRecord {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("time_shifted source 必须是对象");
  }
  const s = raw as JsonRecord;
  if (String(s.kind) !== "time_shifted") throw new Error("time_shifted source.kind 必须是 time_shifted");
  const baseMetric = String(s.base_metric ?? "").trim();
  if (!baseMetric) throw new Error("time_shifted source.base_metric 不能为空");
  const shift = String(s.shift ?? "").trim();
  if (!TIME_SHIFTED_SHIFT_MODES.has(shift)) {
    throw new Error(`time_shifted source.shift 必须是 chain 或 yoy，收到：${shift}`);
  }
  const lookback = Number(s.lookback ?? 1);
  if (!Number.isInteger(lookback) || lookback < 1) {
    throw new Error(`time_shifted source.lookback 必须是 >=1 的整数，收到：${s.lookback}`);
  }
  const operation = String(s.operation ?? "subtract").trim();
  if (!TIME_SHIFTED_OPERATIONS.has(operation)) {
    throw new Error(
      `time_shifted source.operation 必须是 ${[...TIME_SHIFTED_OPERATIONS].join(" / ")}，收到：${operation}`,
    );
  }
  return { kind: "time_shifted", base_metric: baseMetric, shift, lookback, operation };
}

/**
 * Normalize a configuration `comparison` block into the plan/manifest shape.
 * `chain` = 环比（对比上一个月），`yoy` = 同比（对比去年同月）。`period_param` is the
 * required month-range filter whose lower bound the runtime widens backward so a
 * single query returns the current window plus the look-back window(s).
 */
function normalizeComparison(raw: unknown): JsonRecord | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "object") {
    throw new Error("comparison 配置必须是对象");
  }
  const record = raw as JsonRecord;
  if (record.enabled === false) return { enabled: false };
  // period_param may be omitted here: configure-plan defaults it to the primary
  // table's create-time month filter (synthesizing a required filter) right after
  // this normalization. An empty value is therefore allowed at this stage; the
  // final plan still requires a real, required month-range param (validatePlanV2).
  const periodParam = String(record.period_param ?? "").trim();
  const modes = Array.isArray(record.modes) ? record.modes.map((m) => String(m)) : [];
  if (!modes.length) {
    throw new Error("comparison.modes 至少要有一个（chain 环比 / yoy 同比）");
  }
  for (const mode of modes) {
    if (!COMPARISON_MODES.has(mode)) {
      throw new Error(`未知 comparison 模式：${mode}（仅支持 chain / yoy）`);
    }
  }
  const lookback = Number(record.lookback_months ?? 1);
  if (!Number.isInteger(lookback) || lookback < 1) {
    throw new Error("comparison.lookback_months 必须是 ≥1 的整数");
  }
  return {
    enabled: true,
    period_param: periodParam,
    modes: [...new Set(modes)],
    lookback_months: lookback,
  };
}

/**
 * Build a required month-range filter parameter for a create-time column, so a
 * comparison (环比/同比) report has a `period_param` to widen without the user
 * re-declaring create-time as a required_field. Mirrors what inspect derives for
 * a date/datetime output column (range operators, between default) but is always
 * required and carries a sql_binding bound to the create-time column.
 */
function buildPeriodParameter(
  candidate: { alias: string; field: string; label: string; value_type: string },
  dialect: SqlDialect,
): JsonRecord {
  return {
    id: candidate.field,
    label: candidate.label,
    value_type: candidate.value_type,
    component: componentFor(candidate.value_type, ["between", "gte", "lte"]),
    operators: ["between", "gte", "lte"],
    default_operator: "between",
    required: true,
    sql_binding: {
      expression: columnExpression(candidate.alias, candidate.field, dialect),
      clause: "where",
      value_adapter: "direct",
    },
    enum_source: null,
  };
}

async function loadKnowledgeTables(knowledgeRoot: string): Promise<JsonRecord[]> {
  const databaseRoot = join(knowledgeRoot, "databases");
  const files = await listJsonFiles(databaseRoot);
  const tables: JsonRecord[] = [];
  for (const file of files) {
    const document = await readJson(file);
    if (
      document.physical?.table &&
      Array.isArray(document.physical_fields)
    ) {
      tables.push({ ...document, __file: file });
    }
  }
  return tables;
}

function chooseMatch(
  matches: Array<{ table: JsonRecord; field: JsonRecord }>,
  reportId: string,
): Array<{ table: JsonRecord; field: JsonRecord }> {
  if (matches.length <= 1) return matches;
  const reportMatches = matches.filter((match) =>
    match.field.semantic?.report_ids?.includes(reportId),
  );
  return reportMatches.length === 1 ? reportMatches : matches;
}

function semanticFieldNames(field: JsonRecord): string[] {
  return [
    field.semantic?.name,
    field.semantic?.label,
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

function fieldCandidate(match: {
  table: JsonRecord;
  field: JsonRecord;
}): string {
  return `${match.table.physical.database}.${match.table.physical.table}.${match.field.physical.name}`;
}

function suggestedFields(
  raw: string,
  tables: JsonRecord[],
): string[] {
  const normalized = raw.trim().toLowerCase();
  const scored: Array<{ candidate: string; score: number }> = [];
  for (const table of tables) {
    for (const field of table.physical_fields ?? []) {
      const names = [
        field.physical?.name,
        ...semanticFieldNames(field),
      ]
        .filter(Boolean)
        .map((value) => String(value).trim().toLowerCase());
      let score = 0;
      for (const name of names) {
        if (name === normalized) score = Math.max(score, 100);
        else if (name.includes(normalized) || normalized.includes(name)) {
          score = Math.max(score, 70 - Math.abs(name.length - normalized.length));
        } else {
          const overlap = [...new Set(normalized)].filter((character) =>
            name.includes(character),
          ).length;
          score = Math.max(
            score,
            normalized.length && name.length
              ? Math.round((overlap * 40) / Math.max(normalized.length, name.length))
              : 0,
          );
        }
      }
      if (score >= 15) {
        scored.push({
          candidate: `${table.physical.table}.${field.physical.name}`,
          score,
        });
      }
    }
  }
  return scored
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.localeCompare(right.candidate),
    )
    .slice(0, 5)
    .map((item) => item.candidate);
}

export async function inspectReport(options: {
  workspace: string;
  knowledge: string;
  reportId: string;
  out: string;
  version?: string;
}): Promise<JsonRecord> {
  const workspace = resolve(options.workspace);
  const knowledgeRoot = resolve(options.knowledge);
  const config = await readJson(join(workspace, "config", "easy-bi.json"));
  const manifest = await readJson(join(knowledgeRoot, "manifest.json"));
  const requirement = (config.knowledge?.report_requirements ?? []).find(
    (item: JsonRecord) => item.id === options.reportId,
  );
  if (!requirement) {
    throw new Error(`未找到报表需求：${options.reportId}`);
  }
  const tables = await loadKnowledgeTables(knowledgeRoot);
  const blockers: JsonRecord[] = [];
  const warnings: JsonRecord[] = [];
  const resolvedFields: JsonRecord[] = [];

  for (const [index, requestedField] of (
    requirement.required_fields ?? []
  ).entries()) {
    const requestedObject =
      typeof requestedField === "object" && requestedField !== null
        ? requestedField
        : null;
    const explicitBinding =
      requestedObject !== null &&
      typeof requestedObject.field === "string" &&
      requestedObject.field.trim().length > 0;
    const raw =
      typeof requestedField === "string"
        ? requestedField
        : requestedField.field ?? requestedField.label;
    const label =
      typeof requestedField === "string"
        ? requestedField
        : requestedField.label ?? requestedField.field;
    // Optional per-field business description / 口径 authored in the config, to
    // help the AI understand exactly what the field means when generating the
    // package (e.g. 订单数总和 → "订单数量的总和"). Empty when absent.
    const fieldDescription =
      typeof requestedField === "object" &&
      requestedField !== null &&
      typeof requestedField.description === "string"
        ? requestedField.description.trim()
        : "";
    // Roles declared in the report config (output/filter/group/metric). Empty ⇒
    // output-only. Recorded onto the resolved field as a hint for generation.
    const roles: string[] =
      typeof requestedField === "object" &&
      requestedField !== null &&
      Array.isArray(requestedField.roles)
        ? requestedField.roles
            .map((r: unknown) => String(r))
            .filter((r: string) => ["output", "filter", "group", "metric"].includes(r))
        : [];
    if (!raw) {
      blockers.push({
        code: "INVALID_REQUIRED_FIELD",
        message: `第 ${index + 1} 个报表字段没有 field`,
      });
      continue;
    }
    const inferredMetric =
      roles.includes("metric") ||
      (!explicitBinding &&
        /数量|总数|合计|金额|总额|比例|比率|率$|均值|平均/u.test(String(label ?? raw)));
    if (inferredMetric) {
      const fieldId = stableId(String(label ?? raw)).replaceAll("-", "_");
      const aggregation =
        typeof requestedObject?.aggregation === "string"
          ? requestedObject.aggregation
          : /比例|比率|率$/u.test(String(label ?? raw))
            ? "ratio"
            : /数量|总数|数$/u.test(String(label ?? raw))
              ? "count_distinct"
              : /金额|总额|合计/u.test(String(label ?? raw))
                ? "sum"
                : /均值|平均/u.test(String(label ?? raw))
                  ? "avg"
                  : "count_distinct";
      blockers.push({
        code: "METRIC_REQUIRES_MODELING",
        field: raw,
        field_id: fieldId,
        label: label ?? raw,
        description: fieldDescription,
        roles: roles.length ? roles : ["metric", "output"],
        metric_intent: {
          aggregation,
          source_field: String(requestedObject?.metric?.source_field ?? requestedObject?.source_field ?? requestedObject?.field ?? "").trim() || null,
          distinct_field: String(requestedObject?.metric?.distinct_field ?? requestedObject?.distinct_field ?? "").trim() || null,
          conditions: requestedObject?.metric?.conditions ?? [],
          entity: String(label ?? raw).includes("派车单")
            ? "派车单"
            : String(label ?? raw).includes("运单")
              ? "运单"
              : String(label ?? raw).includes("订单")
                ? "订单"
                : null,
        },
        message: `指标「${String(label ?? raw)}」需要在建模阶段确认来源字段、聚合方式、去重键和条件口径`,
      });
      continue;
    }
    const reference = parseFieldReference(raw);
    let matches: Array<{ table: JsonRecord; field: JsonRecord }> = [];
    for (const table of tables) {
      if (reference.table && table.physical.table !== reference.table) continue;
      if (
        reference.database &&
        table.physical.database !== reference.database
      ) {
        continue;
      }
      for (const field of table.physical_fields) {
        if (field.physical?.name === reference.field) {
          matches.push({ table, field });
        }
      }
    }
    if (matches.length === 0 && !reference.table && !reference.database) {
      for (const table of tables) {
        for (const field of table.physical_fields ?? []) {
          if (semanticFieldNames(field).includes(reference.field.trim())) {
            matches.push({ table, field });
          }
        }
      }
    }
    matches = chooseMatch(matches, options.reportId);
    if (matches.length === 0) {
      const suggestions = suggestedFields(raw, tables);
      const fieldId = stableId(raw).replaceAll("-", "_");
      blockers.push({
        code: "FIELD_NOT_FOUND",
        field: raw,
        field_id: fieldId,
        label: label ?? raw,
        description: fieldDescription,
        roles,
        suggestions,
        message: suggestions.length
          ? `知识库中未找到物理字段 ${raw}；如果它是业务指标，请在 configure-plan 中用字段 id「${fieldId}」配置为 sql_expression/computed 或 group_queries 指标；你可能想要的物理字段：${suggestions.join("、")}`
          : `知识库中未找到物理字段 ${raw}；如果它是业务指标，请在 configure-plan 中用字段 id「${fieldId}」配置为 sql_expression/computed 或 group_queries 指标`,
      });
      continue;
    }
    if (matches.length > 1) {
      blockers.push({
        code: "FIELD_AMBIGUOUS",
        field: raw,
        candidates: matches.map(fieldCandidate),
        message: `报表字段 ${raw} 对应多个知识库字段，请从候选 table.field 中确认`,
      });
      continue;
    }
    const match = matches[0]!;
    const baseId = stableId(reference.field).replaceAll("-", "_");
    const fieldId = resolvedFields.some((field) => field.id === baseId)
      ? `${stableId(match.table.physical.table).replaceAll("-", "_")}_${baseId}`
      : baseId;
    resolvedFields.push({
      id: fieldId,
      label:
        label ??
        match.field.semantic?.name ??
        match.field.physical.comment ??
        reference.field,
      order: index + 1,
      output_type: outputValueType(match.field),
      source: {
        profile_id: match.table.physical.profile_id,
        database: match.table.physical.database,
        table: match.table.physical.table,
        field: match.field.physical.name,
        native_type: match.field.physical.native_type,
      },
      knowledge: {
        table_id: match.table.table_id,
        field_status: match.field.semantic?.status ?? "unknown",
        schema_fingerprint: match.table.schema_fingerprint,
      },
      filter: match.field.filter ?? null,
      enum_ref: match.field.semantic?.enum_ref ?? null,
      // Config-declared roles (output/filter/group); [] ⇒ output-only.
      roles,
      // Config-authored business description / 口径 for this field. Empty string
      // when none. Carried into the plan so downstream generation (and the AI
      // reading the plan) understands the field's intent; not used in SQL.
      description: fieldDescription,
    });
  }

  const tableKeys = new Map<string, JsonRecord>();
  for (const field of resolvedFields) {
    const key = tableKey(field.source);
    if (!tableKeys.has(key)) {
      const table = tables.find(
        (candidate) =>
          candidate.physical.profile_id === field.source.profile_id &&
          candidate.physical.database === field.source.database &&
          candidate.physical.table === field.source.table,
      );
      if (table) tableKeys.set(key, table);
    }
  }
  const primaryTable = tableKeys.values().next().value as
    | JsonRecord
    | undefined;
  const sourceTables = [...tableKeys.values()].map(
    (table: JsonRecord, index: number) => ({
      profile_id: table.physical.profile_id,
      database: table.physical.database,
      table: table.physical.table,
      alias: `t${index}`,
      table_id: table.table_id,
      schema_fingerprint: table.schema_fingerprint,
      available_fields: (table.physical_fields ?? []).map(
        (field: JsonRecord) => field.physical?.name,
      ),
      system_conditions: table.system_conditions ?? [],
    }),
  );
  const aliasesByTable = new Map(
    sourceTables.map((table: JsonRecord) => [tableKey(table), table.alias]),
  );
  for (const field of resolvedFields) {
    field.source.kind = "column";
    field.source.alias = aliasesByTable.get(tableKey(field.source));
  }
  if (tableKeys.size > 1) {
    blockers.push({
      code: "JOIN_REQUIRED",
      tables: sourceTables.map((table: JsonRecord) => ({
        alias: table.alias,
        source: `${table.database}.${table.table}`,
      })),
      required_decisions: ["join_type", "join_keys", "result_grain"],
      resolution_command:
        "configure-plan --plan <file> --configuration <join-and-calculation.json>",
      message: "报表字段来自多张表，请一次确认关联键、JOIN 类型和结果粒度",
    });
  }

  // The SQL engine is chosen by the source profile's connector_id (default
  // mysql). All source tables share one profile (validated later), so the
  // primary table's profile determines identifier quoting for the whole plan.
  const engine = resolveEngine(config, sourceTables[0]?.profile_id);
  const dialect = getSqlDialect(engine);
  const alias = sourceTables[0]?.alias ?? "t0";
  const parameters = resolvedFields
    .filter(
      (field) =>
        field.filter?.enabled === true &&
        field.filter?.visibility === "user" &&
        field.filter?.role !== "system_condition",
    )
    .map((field) => {
      // Date/datetime columns are filtered as a required-capable range (start /
      // end) rather than a single value; create-time is forced required.
      const effectiveFilter = rangeFilterFor(field);
      const valueType = parameterValueType({ filter: effectiveFilter });
      const operators = (effectiveFilter.operators ?? [
        effectiveFilter.default_operator,
      ]).filter((item: string) => ALLOWED_OPERATORS.has(item));
      return {
        id: field.id,
        label: field.label,
        value_type: valueType,
        component: componentFor(valueType, operators),
        operators,
        default_operator:
          operators.includes(effectiveFilter.default_operator)
            ? effectiveFilter.default_operator
            : operators[0],
        required: Boolean(effectiveFilter.required),
        sql_binding: {
          expression: columnExpression(field.source.alias, field.source.field, dialect),
          clause: "where",
          value_adapter:
            effectiveFilter.default_operator === "contains"
              ? "contains"
              : "direct",
        },
        enum_source:
          valueType === "enum"
            ? {
                type: "knowledge",
                enum_ref: field.enum_ref,
                assumed_configured: !field.enum_ref,
              }
            : null,
      };
    });

  const systemConditions = (primaryTable?.system_conditions ?? []).map(
    (condition: JsonRecord, index: number) => ({
      id: `__system_${stableId(condition.field).replaceAll("-", "_")}_${index + 1}`,
      expression: `${alias}.${quoteIdentifier(condition.field, dialect)}`,
      operator: condition.operator,
      value: condition.value,
    }),
  );
  const tenantField = primaryTable?.security?.tenant_field;
  const contextBindings = tenantField
    ? [
        {
          api_key: "tenantId",
          knowledge_request_key: "tenant_id",
          required: false,
          apply_when_present: true,
          operator: "eq",
          expression: `${alias}.${quoteIdentifier(tenantField, dialect)}`,
        },
      ]
    : [];
  const primaryKey = primaryTable?.physical_fields?.find(
    (field: JsonRecord) => field.physical?.primary_key,
  )?.physical?.name;
  // Default ordering sorts newest-first by the primary table's create-time
  // column even when create-time is NOT one of the report's output fields — the
  // column just has to exist on the table. Broad name/label matching keeps this
  // working across create_time / created_at / gmt_create / 创建时间 conventions.
  const createTimeField = findCreateTimeColumn(primaryTable);
  const idField = primaryTable?.physical_fields?.some(
    (field: JsonRecord) => field.physical?.name === "id",
  )
    ? "id"
    : primaryKey;
  const ordering = [
    ...(createTimeField
      ? [
          {
            expression: `${alias}.${quoteIdentifier(createTimeField, dialect)}`,
            direction: "DESC",
          },
        ]
      : []),
    ...(idField
      ? [
          {
            expression: `${alias}.${quoteIdentifier(idField, dialect)}`,
            direction: "DESC",
          },
        ]
      : []),
  ].filter(
    (item, index, values) =>
      values.findIndex(
        (candidate) => candidate.expression === item.expression,
      ) === index,
  );

  const plan: JsonRecord = {
    plan_format_version: PLAN_FORMAT_VERSION,
    generated_at: new Date().toISOString(),
    // SQL dialect for identifier quoting / execution. Optional extension: plans
    // without it default to "mysql" so older plans keep exact behavior.
    sql_dialect: dialect.id,
    report: {
      id: requirement.id,
      name: requirement.name,
      version: options.version ?? "0.1.0-draft",
      description: requirement.description ?? "",
      category: requirement.category ?? "",
    },
    knowledge: {
      catalog_format_version: manifest.catalog_format_version,
      catalog_version: manifest.catalog_version,
      catalog_status: manifest.catalog_status,
      snapshot_hash: manifest.snapshot_hash,
      source_kind: manifest.source_kind,
      // Absolute knowledge dir this plan was inspected against, so generate can
      // read global/enums.json for output code→中文 translation. Optional/extra
      // field: older plans without it simply skip enum embedding.
      source_dir: knowledgeRoot,
      profile_engines: Object.fromEntries(
        (config.connections?.database_profiles ?? []).map((profile: JsonRecord) => [
          String(profile.id),
          String(profile.connector_id ?? "mysql"),
        ]),
      ),
    },
    execution_policy: {
      supported_modes: ["sync", "async"],
      default_mode: "sync",
      request_field: "executionMode",
      allow_request_selection: true,
      runtime_policy_ref: "default",
    },
    semantic_plan: {
      status: "draft",
      result_grain: primaryTable
        ? `每行对应 ${primaryTable.semantic?.name ?? primaryTable.physical?.table} 的一条记录`
        : "待确认",
      dimensions: resolvedFields
        .filter((field: JsonRecord) => (field.roles ?? []).includes("group"))
        .map((field: JsonRecord) => ({ id: field.id, label: field.label })),
      metrics: [
        ...resolvedFields
          .filter((field: JsonRecord) => !(field.roles ?? []).includes("group"))
          .map((field: JsonRecord) => ({ id: field.id, label: field.label, definition: field.description ?? "" })),
        ...blockers
          .filter((blocker: JsonRecord) =>
            ["FIELD_NOT_FOUND", "METRIC_REQUIRES_MODELING"].includes(
              String(blocker.code),
            ),
          )
          .map((blocker: JsonRecord) => ({
            id: blocker.field_id,
            label: blocker.label ?? blocker.field,
            definition: blocker.description ?? "",
          })),
      ],
      distinct_keys: {},
      time_semantics: [],
      exclusions: [],
      open_questions: blockers.map((blocker: JsonRecord) => ({
        id: String(blocker.field_id ?? `q_unknown`),
        question: String(blocker.message ?? ''),
        options: Array.isArray(blocker.suggestions)
          ? (blocker.suggestions as string[]).map((s: string) => ({ value: s, label: s }))
          : [],
        recommended: null,
        required: true,
        affected_metrics: blocker.label ? [String(blocker.label)] : [],
        impact: String(
          blocker.code === 'METRIC_REQUIRES_MODELING'
            ? '需要确定来源表、聚合方式、去重键和条件口径'
            : blocker.code === 'FIELD_NOT_FOUND'
              ? '该字段需确定为 computed/sql_expression 或通过 comparison 机制实现'
              : '待确认',
        ),
      })),
    },
    execution_plan: {
      status: "draft",
      strategy: sourceTables.length <= 1 ? "sql" : "group_queries",
      steps: sourceTables.length <= 1 && sourceTables.length > 0
        ? [{ id: "Q1", type: "sql", description: `查询 ${sourceTables[0]!.database}.${sourceTables[0]!.table} 并输出报表字段` }]
        : [],
      rationale: sourceTables.length <= 1 ? "单一事实来源，使用参数化只读 SQL" : "待完成关联与粒度确认后选择执行策略",
    },
    source: {
      primary_table: sourceTables[0] ?? null,
      tables: sourceTables,
      joins: [],
    },
    fields: resolvedFields,
    parameters,
    context_bindings: contextBindings,
    system_conditions: systemConditions,
    ordering,
    custom_logic: {
      required: false,
      mode: "identity",
      group_keys: [],
      max_group_rows: 100000,
      description: "",
    },
    aggregation: {
      group_by: [],
      having: [],
    },
    // Create-time month-range candidates on the primary table (for comparison
    // period_param defaulting in configure-plan). Each carries the alias/field
    // and the range value_type needed to synthesize a required filter. Empty
    // when the primary table has no date/datetime create-time column.
    default_period_candidates: findCreateTimeCandidates(primaryTable).map(
      (candidate) => ({ alias, ...candidate }),
    ),
    warnings,
    blockers,
    approval: {
      status: "draft",
      reviewed_by: null,
      reviewed_at: null,
    },
  };
  await writeJson(resolve(options.out), plan);
  return plan;
}

function availableColumnsForPlan(plan: JsonRecord): Map<string, Set<string>> {
  return new Map(
    (plan.source?.tables ?? [plan.source?.primary_table])
      .filter(Boolean)
      .map((table: JsonRecord) => [
        assertAlias(table.alias),
        new Set((table.available_fields ?? []).map(String)),
      ]),
  );
}

function validatePlanV2(plan: JsonRecord): string[] {
  const errors: string[] = [];
  try {
    const dialect = dialectForPlan(plan);
    const columns = availableColumnsForPlan(plan);
    const primaryAlias = assertAlias(plan.source?.primary_table?.alias);
    if (!columns.has(primaryAlias)) errors.push("主表不在 source.tables 中");
    const profiles = new Set(
      (plan.source?.tables ?? []).map((table: JsonRecord) => table.profile_id),
    );
    if (profiles.size > 1) {
      errors.push("同一 SQL JOIN 的来源表必须属于同一个数据库连接 Profile");
    }
    const joinedAliases = new Set<string>([primaryAlias]);
    for (const joinItem of plan.source?.joins ?? []) {
      const alias = assertAlias(joinItem.alias);
      if (!columns.has(alias)) errors.push(`JOIN 引用了未知表别名：${alias}`);
      if (joinedAliases.has(alias)) errors.push(`JOIN 表别名重复：${alias}`);
      joinedAliases.add(alias);
      if (!["LEFT", "INNER"].includes(String(joinItem.type).toUpperCase())) {
        errors.push(`JOIN ${alias} 只支持 LEFT 或 INNER`);
      }
      if (!(joinItem.on ?? []).length) errors.push(`JOIN ${alias} 缺少 ON 条件`);
      for (const condition of joinItem.on ?? []) {
        normalizeColumnReference(condition.left, columns);
        normalizeColumnReference(condition.right, columns);
        if ((condition.operator ?? "eq") !== "eq") {
          errors.push(`JOIN ${alias} 当前只支持等值关联`);
        }
      }
      for (const condition of joinItem.conditions ?? []) {
        normalizeColumnReference(
          `${condition.alias ?? alias}.${condition.field}`,
          columns,
        );
      }
    }
    for (const field of plan.fields ?? []) {
      const kind = field.source?.kind;
      if (kind === "column") {
        const alias = assertAlias(field.source.alias);
        if (!columns.get(alias)?.has(String(field.source.field))) {
          errors.push(`字段 ${field.id} 引用了未知列`);
        }
        if (!joinedAliases.has(alias)) {
          errors.push(`字段 ${field.id} 的来源表 ${alias} 没有 JOIN`);
        }
      } else if (kind === "sql_expression") {
        assertSafeSqlExpression(field.source.expression, columns, dialect);
        for (const dependency of field.source.dependencies ?? []) {
          normalizeColumnReference(
            `${dependency.alias}.${dependency.field}`,
            columns,
          );
        }
      } else if (kind === "computed") {
        if (!["row", "group"].includes(field.source.mode)) {
          errors.push(`计算字段 ${field.id} 缺少 row/group 模式`);
        }
        if (!String(field.source.expression ?? "").trim()) {
          errors.push(`计算字段 ${field.id} 缺少 TypeScript 表达式`);
        }
        for (const dependency of field.source.dependencies ?? []) {
          normalizeColumnReference(
            `${dependency.alias}.${dependency.field}`,
            columns,
          );
          if (!dependency.id) errors.push(`计算字段 ${field.id} 的依赖缺少 id`);
        }
      } else if (kind === "boolean_flag") {
        // 是/否 folded from a numeric/status column. The column must exist + be
        // JOINed (it's a real DB column); operator + threshold must be valid.
        try {
          const flag = resolveBooleanFlag(field);
          if (!columns.get(flag.alias)?.has(flag.field)) {
            errors.push(`布尔字段 ${field.id} 引用了未知列 ${flag.alias}.${flag.field}`);
          }
          if (!joinedAliases.has(flag.alias)) {
            errors.push(`布尔字段 ${field.id} 的来源表 ${flag.alias} 没有 JOIN`);
          }
          if (field.output_type !== "boolean") {
            errors.push(`布尔字段 ${field.id} 的 output_type 必须是 boolean`);
          }
        } catch (error) {
          errors.push((error as Error).message);
        }
      } else if (kind === "enrichment") {
        // Produced by a batch secondary-query + in-memory merge (runtime), not SQL.
        // Must reference a declared enrichment that lists this field as a select.
        const enrichment = (plan.enrichments ?? []).find(
          (e: JsonRecord) => e.id === field.source.enrichment_id,
        );
        if (!enrichment) {
          errors.push(`enrichment 字段 ${field.id} 未绑定到任何 enrichment`);
        } else if (!(enrichment.select ?? []).some((s: JsonRecord) => s.id === field.id)) {
          errors.push(`enrichment 字段 ${field.id} 不在 enrichment ${enrichment.id} 的 select 中`);
        }
      } else if (kind === "script" && plan.script_report) {
        // Produced by the isolated v3 report script through ctx.emit. Physical
        // lineage, when known, is preserved under source.lineage and query locks.
      } else if (kind === "time_shifted") {
        // Time-shifted metric: must reference an existing base metric.
        const baseId = String(field.source?.base_metric ?? "");
        if (!baseId) {
          errors.push(`time_shifted 字段 ${field.id} 缺少 base_metric`);
        } else if (!(plan.fields ?? []).some((f: JsonRecord) => String(f.id) === baseId)) {
          errors.push(
            `time_shifted 字段 ${field.id} 引用的 base_metric ${baseId} 不存在`,
          );
        }
        const shift = String(field.source?.shift ?? "");
        if (!TIME_SHIFTED_SHIFT_MODES.has(shift)) {
          errors.push(`time_shifted 字段 ${field.id} 的 shift ${shift} 无效（仅支持 chain / yoy）`);
        }
        const lookback = Number(field.source?.lookback ?? 1);
        if (!Number.isInteger(lookback) || lookback < 1) {
          errors.push(`time_shifted 字段 ${field.id} 的 lookback 必须是 >=1 的整数`);
        }
        const operation = String(field.source?.operation ?? "subtract");
        if (!TIME_SHIFTED_OPERATIONS.has(operation)) {
          errors.push(
            `time_shifted 字段 ${field.id} 的 operation ${operation} 无效（仅支持 ${[...TIME_SHIFTED_OPERATIONS].join(" / ")}）`,
          );
        }
        // time_shifted + comparison are mutually exclusive
        if (plan.comparison?.enabled) {
          errors.push(
            `time_shifted 字段 ${field.id} 与 comparison（环比/同比全量对比）互斥；请选择其中一种方式`,
          );
        }
      } else {
        errors.push(`字段 ${field.id} 使用未知来源种类 ${kind}`);
      }
    }
    for (const item of plan.aggregation?.group_by ?? []) {
      normalizeColumnReference(item, columns);
    }
    // A computed field is transform-produced and cannot be a SQL (WHERE/HAVING)
    // filter. It CAN be a `post_transform` filter (evaluated in memory against the
    // computed output value). So a computed-field parameter is only an error when
    // its clause is not post_transform.
    const computedIds = new Set(
      (plan.fields ?? [])
        .filter((field: JsonRecord) => field.source?.kind === "computed")
        .map((field: JsonRecord) => field.id),
    );
    for (const parameter of plan.parameters ?? []) {
      const clause = parameter.sql_binding?.clause;
      if (computedIds.has(parameter.id) && clause !== "post_transform") {
        errors.push(
          `计算字段 ${parameter.id} 不能作为 SQL 筛选参数（数值计算字段可用 post_transform 后置筛选，其余应取消筛选仅作为输出列）`,
        );
      }
      // post_transform is a runtime-only, in-memory filter — it must NOT reference
      // a SQL clause/expression. Its expression is the computed field id.
      if (clause === "post_transform") {
        if (!computedIds.has(parameter.id)) {
          errors.push(`参数 ${parameter.id} 使用 post_transform，但它不是计算字段`);
        }
        if (parameter.value_type !== "number_range") {
          errors.push(`post_transform 参数 ${parameter.id} 目前仅支持 number_range`);
        }
        continue; // Skip the SQL-clause checks below for post_transform.
      }
      // A boolean-flag filter is a where-clause whose value predicate is built
      // structurally from a validated operator key + threshold (never a bound
      // value). Its expression is a bare quoted column; validate the descriptor.
      if (parameter.value_type === "boolean") {
        if (clause !== "where") {
          errors.push(`布尔筛选项 ${parameter.id} 必须使用 where clause`);
        }
        if (!isBareQuotedColumnRef(String(parameter.sql_binding?.expression ?? ""), dialect.quoteChar)) {
          errors.push(`布尔筛选项 ${parameter.id} 的表达式必须是单个列引用`);
        }
        if (!(String(parameter.sql_binding?.flag_operator) in FLAG_OPERATOR_SYMBOLS)) {
          errors.push(`布尔筛选项 ${parameter.id} 的比较符无效`);
        }
        if (!Number.isFinite(Number(parameter.sql_binding?.flag_threshold))) {
          errors.push(`布尔筛选项 ${parameter.id} 的阈值必须是数值`);
        }
        continue; // Skip the generic clause/expression checks below.
      }
      if (!["where", "having", "exists_subquery"].includes(clause)) {
        errors.push(`参数 ${parameter.id} 的 SQL 子句无效`);
      }
      if (clause === "exists_subquery") {
        // The inner predicate references a synthetic subquery alias (ex_*) that
        // isn't a plan table, so the alias-aware column check doesn't apply. We
        // instead validate the trusted, knowledge-built skeleton's shape and that
        // no user-controlled text or injection vector leaked in. The inner
        // expression must be a single quoted-column reference on that alias.
        const prefix = String(parameter.sql_binding.subquery_prefix ?? "");
        const suffix = String(parameter.sql_binding.subquery_suffix ?? "");
        const inner = String(parameter.sql_binding.expression ?? "");
        const q = dialect.quoteChar;
        if (!isValidExistsSkeleton(prefix, suffix)) {
          errors.push(`参数 ${parameter.id} 的 EXISTS 子查询骨架无效`);
        }
        if (hasSkeletonInjection(prefix)) {
          errors.push(`参数 ${parameter.id} 的 EXISTS 子查询骨架不安全`);
        }
        if (!new RegExp(`^ex_[A-Za-z0-9_]+\\.${q}[A-Za-z0-9_$]+${q}$`).test(inner)) {
          errors.push(`参数 ${parameter.id} 的 EXISTS 内层列引用无效`);
        }
      } else {
        assertSafeSqlExpression(parameter.sql_binding?.expression, columns, dialect);
      }
    }
    if (plan.custom_logic?.mode === "group") {
      if (!(plan.custom_logic.group_keys ?? []).length) {
        errors.push("分组 Transform 必须声明 group_keys");
      }
      const fieldIds = new Set((plan.fields ?? []).map((field: JsonRecord) => field.id));
      const dependencyIds = new Set(
        (plan.fields ?? [])
          .flatMap((field: JsonRecord) => field.source?.dependencies ?? [])
          .map((dependency: JsonRecord) => dependency.id),
      );
      for (const key of plan.custom_logic.group_keys ?? []) {
        if (!fieldIds.has(key) && !dependencyIds.has(key)) {
          errors.push(`分组键没有对应查询输出：${key}`);
        }
      }
    }
    if (plan.comparison?.enabled) {
      const periodParam = String(plan.comparison.period_param ?? "");
      const param = (plan.parameters ?? []).find(
        (p: JsonRecord) => p.id === periodParam,
      );
      if (!param) {
        errors.push(`comparison.period_param 未对应任何筛选参数：${periodParam}`);
      } else if (!["datetime_range", "date_range"].includes(String(param.value_type))) {
        errors.push(
          `comparison.period_param（${periodParam}）必须是按月/日期区间筛选（当前 value_type=${param.value_type}）`,
        );
      } else if (!param.required) {
        errors.push(`comparison.period_param（${periodParam}）必须是必填项，否则无法推导对比窗口`);
      }
      // Comparison relies on the group transform to bucket by period; require it.
      if (plan.custom_logic?.mode !== "group") {
        errors.push("启用 comparison 时 custom_logic.mode 必须为 group（在分组 Transform 里计算环比/同比）");
      }
    }
    // Enrichment (batch secondary-query) backstops for hand-edited plans.
    if (Array.isArray(plan.enrichments) && plan.enrichments.length) {
      // Output-stage merge only: a group transform + enrichment is unsupported.
      if (plan.custom_logic?.mode === "group") {
        errors.push("分组(group)报表暂不支持 enrichment 二次查询合并");
      }
      // Columns that ARE emitted by the main SELECT (usable as a join key source).
      const mainOutputIds = new Set(
        (plan.fields ?? [])
          .flatMap((f: JsonRecord) => {
            if (f.source?.kind === "column" || f.source?.kind === "sql_expression") return [f.id];
            if (f.source?.kind === "computed") {
              return (f.source.dependencies ?? []).map((d: JsonRecord) => d.id);
            }
            return [];
          }),
      );
      const enrichmentIds = new Set(plan.enrichments.map((e: JsonRecord) => e.id));
      const enrichmentOutputs = new Map<string, Set<string>>(
        plan.enrichments.map((e: JsonRecord) => [
          e.id,
          new Set((e.select ?? []).map((s: JsonRecord) => String(s.id))),
        ]),
      );
      const seen = new Set<string>();
      for (const e of plan.enrichments) {
        const eid = String(e.id ?? "");
        if (!eid) errors.push("enrichment 缺少 id");
        if (seen.has(eid)) errors.push(`enrichment id 重复：${eid}`);
        seen.add(eid);
        if (!["one", "many"].includes(String(e.cardinality))) {
          errors.push(`enrichment ${eid}：cardinality 必须为 one/many`);
        }
        if (e.cardinality === "many" && !e.aggregate) {
          errors.push(`enrichment ${eid}：cardinality=many 必须声明 aggregate`);
        }
        if (e.cardinality === "one" && e.aggregate) {
          errors.push(`enrichment ${eid}：cardinality=one 不能带 aggregate`);
        }
        const keySource = e.on?.source === "enrichment" ? "enrichment" : "main";
        if (keySource === "main") {
          if (!mainOutputIds.has(String(e.on?.main_field))) {
            errors.push(`enrichment ${eid}：join 键 ${e.on?.main_field} 不在主查询输出列中`);
          }
        } else {
          const upstream = String(e.on?.source_id ?? "");
          if (!enrichmentIds.has(upstream)) {
            errors.push(`enrichment ${eid}：上游 ${upstream} 不存在`);
          } else if (!enrichmentOutputs.get(upstream)?.has(String(e.on?.main_field))) {
            errors.push(`enrichment ${eid}：链式键 ${e.on?.main_field} 不是上游 ${upstream} 的输出`);
          }
        }
      }
      // Detect dependency cycles among enrichments (chained key_source).
      const indeg = new Map<string, number>();
      const deps = new Map<string, string[]>();
      for (const e of plan.enrichments) {
        indeg.set(e.id, 0);
        deps.set(e.id, []);
      }
      for (const e of plan.enrichments) {
        if (e.on?.source === "enrichment" && enrichmentIds.has(e.on?.source_id)) {
          indeg.set(e.id, (indeg.get(e.id) ?? 0) + 1);
          deps.get(e.on.source_id)!.push(e.id);
        }
      }
      const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([k]) => k);
      let visited = 0;
      while (queue.length) {
        const id = queue.shift()!;
        visited += 1;
        for (const d of deps.get(id) ?? []) {
          indeg.set(d, (indeg.get(d) ?? 0) - 1);
          if ((indeg.get(d) ?? 0) === 0) queue.push(d);
        }
      }
      if (visited !== plan.enrichments.length) {
        errors.push("enrichment 依赖存在环");
      }
    }

    // Multi-entity grouped queries: validate each sibling as a standalone plan and
    // enforce the mutual-exclusivity rules. group_queries do their own SQL GROUP BY
    // per sibling; combining them with an in-memory group transform, enrichment, or
    // comparison would cross incompatible merge grains — reject rather than degrade.
    if (plan.group_queries?.queries?.length) {
      const gqRoot = plan.group_queries as JsonRecord;
      const mergeKeys = (gqRoot.merge_keys ?? []).map(String);
      if (!mergeKeys.length) errors.push("group_queries.merge_keys 不能为空");
      if (plan.custom_logic?.mode === "group") {
        errors.push("group_queries 与内存分组 transform（custom_logic.mode=group）互斥");
      }
      if (Array.isArray(plan.enrichments) && plan.enrichments.length) {
        errors.push("group_queries 与 enrichment 二次查询互斥");
      }
      if (plan.comparison?.enabled) {
        errors.push("group_queries 与环比/同比（comparison）暂不支持同时使用");
      }
      // The shared period_param (if any) must be a required date/datetime range.
      const periodParamId = gqRoot.period_param ? String(gqRoot.period_param) : null;
      if (periodParamId) {
        const p = (plan.parameters ?? []).find((x: JsonRecord) => x.id === periodParamId);
        if (!p) errors.push(`group_queries.period_param 指向不存在的参数：${periodParamId}`);
        else if (!["date_range", "datetime_range"].includes(String(p.value_type))) {
          errors.push(`group_queries.period_param「${periodParamId}」必须是日期/时间范围筛选`);
        }
      }
      const seenGqIds = new Set<string>();
      for (const gq of gqRoot.queries as JsonRecord[]) {
        const gid = String(gq.id ?? "");
        if (!gid) errors.push("group_queries 查询缺少 id");
        if (seenGqIds.has(gid)) errors.push(`group_queries 查询 id 重复：${gid}`);
        seenGqIds.add(gid);
        // Validate the sibling by reusing the full plan validator on its mini-plan.
        const sibling = groupQueryToPlan(plan, gq);
        for (const err of validatePlanV2(sibling)) {
          errors.push(`group_queries ${gid}：${err}`);
        }
        // Every merge key must be produced by this sibling AND be in its GROUP BY.
        const gqFieldIds = new Set((gq.fields ?? []).map((f: JsonRecord) => String(f.id)));
        for (const key of mergeKeys) {
          if (!gqFieldIds.has(key)) {
            errors.push(`group_queries ${gid}：缺少合并键输出列 ${key}`);
          }
        }
        const groupBy = (gq.aggregation?.group_by ?? []).map(String);
        if (!groupBy.length) {
          errors.push(`group_queries ${gid}：缺少 aggregation.group_by（分组统计必须分组）`);
        }
      }
    }
    if (plan.script_report) {
      if (plan.execution_plan?.strategy !== "script") {
        errors.push("v3 脚本报表的 execution_plan.strategy 必须是 script");
      }
      validateScriptSource(String(plan.script_report.source ?? ""));
      const queryIds = new Set<string>();
      for (const query of plan.script_report.queries ?? []) {
        const id = String(query.id ?? "");
        if (!id || queryIds.has(id)) errors.push("v3 查询 id 缺失或重复");
        queryIds.add(id);
        safeScriptSql(String(query.sql ?? ""), String(query.mode ?? ""));
      }
      for (const [name, value] of Object.entries(plan.script_report.resource_budget ?? {})) {
        if (!Number.isInteger(Number(value)) || Number(value) < 1) {
          errors.push(`v3 资源预算 ${name} 必须是正整数`);
        }
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

/**
 * Apply `configuration.enrichments[]`: resolve each lookup table from the plan's
 * knowledge dir (trusting knowledge, not the config, for table_id/fingerprint/
 * columns), validate the join keys + select + aggregate, and write the normalized
 * blocks into `plan.enrichments[]` plus one `enrichment` kind field per select
 * column. The lookup table is deliberately NOT added to `source.tables` (that
 * feeds FROM/JOIN); it is carried only in plan.enrichments so the runtime does a
 * batch secondary-query instead of a SQL JOIN. See docs/design/enrichment-batch-lookup.md.
 */
async function applyEnrichments(
  plan: JsonRecord,
  enrichmentsConfig: JsonRecord[],
): Promise<void> {
  const knowledgeRoot = plan.knowledge?.source_dir
    ? resolve(String(plan.knowledge.source_dir))
    : null;
  if (!knowledgeRoot) {
    throw new Error("enrichment 需要知识库来源（plan.knowledge.source_dir 缺失）");
  }
  const knowledgeTables = await loadKnowledgeTables(knowledgeRoot);
  const primaryProfile = plan.source?.primary_table?.profile_id;

  const enrichments: JsonRecord[] = [];
  const seenIds = new Set<string>();
  const enrichmentSelectIds = new Map<string, string[]>(); // enrichment id → its select ids
  const maxOrder0 = (plan.fields ?? []).reduce(
    (max: number, f: JsonRecord) => Math.max(max, Number(f.order ?? 0)),
    0,
  );
  let order = maxOrder0;

  for (const raw of enrichmentsConfig) {
    const id = String(raw.id ?? "").trim();
    if (!id) throw new Error("enrichment 缺少 id");
    if (seenIds.has(id)) throw new Error(`enrichment id 重复：${id}`);
    seenIds.add(id);

    const lookupCfg = raw.lookup ?? {};
    // Resolve the lookup table from knowledge by database.table (trust knowledge).
    const doc = knowledgeTables.find(
      (t) =>
        t.physical?.database === lookupCfg.database &&
        t.physical?.table === lookupCfg.table &&
        (!lookupCfg.profile_id || t.physical?.profile_id === lookupCfg.profile_id),
    );
    if (!doc) {
      throw new Error(
        `enrichment ${id}：知识库中找不到 lookup 表 ${lookupCfg.database}.${lookupCfg.table}`,
      );
    }
    if (primaryProfile && doc.physical.profile_id !== primaryProfile) {
      throw new Error(
        `enrichment ${id}：lookup 表与主表不在同一连接 profile（不支持跨 profile）`,
      );
    }
    const availableFields = new Set(
      (doc.physical_fields ?? []).map((f: JsonRecord) => String(f.physical?.name)),
    );
    const alias = String(lookupCfg.alias ?? `lk_${id}`);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(alias)) {
      throw new Error(`enrichment ${id}：非法 lookup 别名 ${alias}`);
    }

    // Join key: from the main query, or from another enrichment's output (chained).
    const on = raw.on ?? {};
    const keySource = on.source === "enrichment" ? "enrichment" : "main";
    const keySourceId = keySource === "enrichment" ? String(on.source_id ?? "") : null;
    const mainKeyField = String(on.main_field ?? "");
    const lookupKeyField = String(on.lookup_field ?? "");
    if (!mainKeyField) throw new Error(`enrichment ${id}：on.main_field 不能为空`);
    if (!availableFields.has(lookupKeyField)) {
      throw new Error(`enrichment ${id}：lookup 表无列 ${lookupKeyField}（on.lookup_field）`);
    }
    if (keySource === "enrichment") {
      if (!keySourceId || !seenIds.has(keySourceId)) {
        throw new Error(
          `enrichment ${id}：on.source_id 必须指向已声明在前的上游 enrichment`,
        );
      }
      if (!(enrichmentSelectIds.get(keySourceId) ?? []).includes(mainKeyField)) {
        throw new Error(
          `enrichment ${id}：链式键 ${mainKeyField} 必须是上游 ${keySourceId} 的 select 输出`,
        );
      }
    }

    const cardinality = raw.cardinality === "many" ? "many" : "one";
    let aggregate: JsonRecord | undefined;
    if (cardinality === "many") {
      const agg = raw.aggregate ?? { kind: "group_concat" };
      const kind = String(agg.kind ?? "group_concat");
      if (!["group_concat", "count", "sum", "max", "min", "first"].includes(kind)) {
        throw new Error(`enrichment ${id}：未知 aggregate.kind ${kind}`);
      }
      aggregate = {
        kind,
        ...(kind === "group_concat"
          ? { distinct: agg.distinct !== false, separator: String(agg.separator ?? ",") }
          : {}),
      };
    } else if (raw.aggregate) {
      throw new Error(`enrichment ${id}：cardinality=one 不能带 aggregate`);
    }

    // Fixed lookup-side conditions (logical delete etc.), values from knowledge.
    const conditions = Array.isArray(raw.conditions)
      ? raw.conditions
      : (doc.system_conditions ?? []).map((c: JsonRecord) => ({
          field: c.field,
          operator: c.operator ?? "eq",
          value: c.value,
        }));
    for (const c of conditions) {
      if (!availableFields.has(String(c.field))) {
        throw new Error(`enrichment ${id}：条件列 ${c.field} 不在 lookup 表中`);
      }
    }

    // Resolve the main-query key column (alias.`field`) for pushing a filter down
    // as EXISTS. Only possible when the key comes from the main query and resolves
    // to a real column (or a sql_expression's single dependency). Null otherwise
    // (e.g. chained key) → a filter on this enrichment's columns will be refused.
    const dialect = dialectForPlan(plan);
    let mainKeyColumn: string | null = null;
    if (keySource === "main") {
      const keyField = (plan.fields ?? []).find((f: JsonRecord) => f.id === mainKeyField);
      if (keyField?.source?.kind === "column") {
        mainKeyColumn = columnExpression(keyField.source.alias, keyField.source.field, dialect);
      } else if (
        keyField?.source?.kind === "sql_expression" &&
        (keyField.source.dependencies ?? []).length === 1
      ) {
        const dep = keyField.source.dependencies[0];
        mainKeyColumn = columnExpression(dep.alias, dep.field, dialect);
      }
    }

    // Select columns → new enrichment fields (+ optional EXISTS filter param).
    const select = Array.isArray(raw.select) ? raw.select : [];
    if (!select.length) throw new Error(`enrichment ${id}：select 不能为空`);
    const selectIds: string[] = [];
    for (const sel of select) {
      const selId = String(sel.id ?? "").trim();
      const lookupField = String(sel.lookup_field ?? "");
      if (!selId) throw new Error(`enrichment ${id}：select 项缺少 id`);
      if (!availableFields.has(lookupField)) {
        throw new Error(`enrichment ${id}：lookup 表无列 ${lookupField}（select ${selId}）`);
      }
      if ((plan.fields ?? []).some((f: JsonRecord) => f.id === selId)) {
        throw new Error(`enrichment ${id}：select 字段 id 与已有字段冲突：${selId}`);
      }
      const roles = Array.isArray(sel.roles) ? sel.roles : [];
      order += 1;
      plan.fields.push({
        id: selId,
        label: sel.label ?? selId,
        order: sel.order ?? order,
        output_type: sel.output_type ?? "string",
        source: { kind: "enrichment", enrichment_id: id, lookup_field: lookupField },
        ...(sel.description ? { description: sel.description } : {}),
        filter: sel.filter ?? null,
        enum_ref: null,
        roles,
      });
      selectIds.push(selId);

      // Filterable enrichment column → push the filter down to a correlated EXISTS
      // on the lookup table (output stays the in-memory merge; filtering is in SQL,
      // so it filters main rows BEFORE they're fetched — no missed-match blind spot).
      if (roles.includes("filter")) {
        if (!mainKeyColumn) {
          throw new Error(
            `enrichment ${id}：字段 ${selId} 需要筛选，但其 join 键无法关联回主查询` +
              `（键来自上游 enrichment 或非普通列）。要筛此字段，请将该键所属表保留为 JOIN。`,
          );
        }
        const skeleton = buildEnrichmentExistsSkeleton(
          {
            id,
            lookup: { database: doc.physical.database, table: doc.physical.table, alias },
            on: { lookup_field: lookupKeyField },
            conditions,
          },
          lookupField,
          mainKeyColumn,
          dialect,
        );
        if (!skeleton) {
          throw new Error(`enrichment ${id}：无法为字段 ${selId} 构建 EXISTS 筛选`);
        }
        const isText = (sel.output_type ?? "string") === "string";
        plan.parameters = plan.parameters ?? [];
        // Drop any pre-existing param with this id, then add the EXISTS one.
        plan.parameters = plan.parameters.filter((p: JsonRecord) => p.id !== selId);
        plan.parameters.push({
          id: selId,
          label: sel.label ?? selId,
          value_type: "string",
          component: isText ? "text" : "text-list",
          operators: isText ? ["contains", "eq"] : ["eq", "in"],
          default_operator: isText ? "contains" : "eq",
          required: false,
          sql_binding: {
            expression: skeleton.inner_expression,
            clause: "exists_subquery",
            value_adapter: isText ? "contains" : "direct",
            subquery_prefix: skeleton.prefix,
            subquery_suffix: skeleton.suffix,
          },
          enum_source: null,
        });
      }
    }
    enrichmentSelectIds.set(id, selectIds);

    enrichments.push({
      id,
      lookup: {
        profile_id: doc.physical.profile_id,
        database: doc.physical.database,
        table: doc.physical.table,
        alias,
        table_id: doc.table_id,
        schema_fingerprint: doc.schema_fingerprint,
      },
      on: {
        source: keySource,
        source_id: keySourceId,
        main_field: mainKeyField,
        lookup_field: lookupKeyField,
      },
      conditions,
      cardinality,
      ...(aggregate ? { aggregate } : {}),
      select: select.map((s: JsonRecord) => ({
        id: String(s.id),
        label: s.label ?? String(s.id),
        lookup_field: String(s.lookup_field),
        output_type: s.output_type ?? "string",
      })),
      on_missing: raw.on_missing ?? "null",
    });
  }
  plan.enrichments = enrichments;
}

// ---------------------------------------------------------------------------
// Group-queries script report generation
// ---------------------------------------------------------------------------

interface GroupQueryMetricDef {
  id: string;
  output_column: string;
  label: string;
  aggregation: string;
  /** Fully qualified field reference, e.g. "t0.id", "t2.id". */
  field: string;
  /** Optional SQL condition, e.g. "t0.status = 'BE_ALLOCATED'". */
  condition: string | null;
}

/**
 * Extract structured metric definitions from the declarative config's
 * `query_groups[].metrics[]`. Returns a Map keyed by group query id.
 */
function collectGroupQueryMetrics(
  queryGroups: JsonRecord[],
): Map<string, GroupQueryMetricDef[]> {
  const result = new Map<string, GroupQueryMetricDef[]>();
  for (const g of queryGroups) {
    const gid = String((g as JsonRecord).id ?? "");
    const defs: GroupQueryMetricDef[] = [];
    for (const m of (g as JsonRecord).metrics ?? []) {
      const mj = m as JsonRecord;
      defs.push({
        id: String(mj.id ?? ""),
        output_column: String(mj.output_column ?? mj.id ?? ""),
        label: String(mj.label ?? mj.id ?? ""),
        aggregation: String(mj.aggregation ?? "count_distinct"),
        field: String(mj.field ?? ""),
        condition: mj.condition ? String(mj.condition) : null,
      });
    }
    if (defs.length) result.set(gid, defs);
  }
  return result;
}

/** Collect all unique column references needed for raw-data queries. */
function collectRequiredColumns(
  mergeKey: string,
  metricDefs: GroupQueryMetricDef[],
): { alias: string; name: string }[] {
  const seen = new Map<string, { alias: string; name: string }>();
  // Merge key (only when non-empty)
  if (mergeKey) {
    const mkParts = mergeKey.includes(".") ? mergeKey.split(".") : ["t0", mergeKey];
    const mkAlias = mkParts[0]!;
    const mkName = mkParts[mkParts.length - 1]!;
    if (mkName) seen.set(`${mkAlias}.${mkName}`, { alias: mkAlias, name: mkName });
  }

  for (const m of metricDefs) {
    // Dedup field
    if (m.field) {
      const parts = m.field.includes(".") ? m.field.split(".") : ["t0", m.field];
      const alias = parts[0]!;
      const name = parts[parts.length - 1]!;
      const key = `${alias}.${name}`;
      if (!seen.has(key)) seen.set(key, { alias, name });
    }
    // Condition columns: extract alias.field patterns
    if (m.condition) {
      const re = /\b([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\b/gi;
      let match;
      while ((match = re.exec(m.condition)) !== null) {
        const alias = match[1]!;
        const name = match[2]!;
        const key = `${alias}.${name}`;
        if (!seen.has(key)) seen.set(key, { alias, name });
      }
    }
  }
  return [...seen.values()];
}

/**
 * Generate a raw-data (non-aggregated) SQL query for a single group-query sibling.
 * Returns just the columns needed for in-memory dedup + conditional counting —
 * no GROUP BY, no aggregation functions.
 */
function buildGroupQueryRawSql(
  sibling: JsonRecord,
  plan: JsonRecord,
  metricDefs: GroupQueryMetricDef[],
  mergeKeys: string[],
): string {
  const dialect = dialectForPlan(plan);
  const primary = sibling.source?.primary_table as JsonRecord | undefined;
  if (!primary) throw new Error("group_queries sibling 缺少主表");

  // Collect required columns: merge keys + metric dedup/condition fields
  const allCols: { alias: string; name: string }[] = [];
  for (const mk of mergeKeys) {
    allCols.push(...collectRequiredColumns(mk, []));
  }
  allCols.push(...collectRequiredColumns("", metricDefs));

  // Deduplicate by alias.name
  const uniqueCols = new Map<string, { alias: string; name: string }>();
  for (const col of allCols) {
    const key = `${col.alias}.${col.name}`;
    if (!uniqueCols.has(key)) uniqueCols.set(key, col);
  }

  const selectParts: string[] = [];
  for (const col of uniqueCols.values()) {
    selectParts.push(
      `  ${columnExpression(col.alias, col.name, dialect)} AS ${quoteIdentifier(col.name, dialect)}`,
    );
  }

  // FROM + JOINs — reuse from sibling.source
  const sourceTables = new Map<string, JsonRecord>(
    (sibling.source?.tables ?? [primary]).map((t: JsonRecord) => [t.alias, t]),
  );
  // Build a column Map from sibling's source tables for reference resolution
  const siblingColumns = new Map<string, Set<string>>();
  for (const t of sibling.source?.tables ?? [primary]) {
    const fields = (t as JsonRecord).available_fields ?? (t as JsonRecord).fields ?? [];
    siblingColumns.set(
      String((t as JsonRecord).alias ?? ""),
      new Set(fields.map(String)),
    );
  }

  const joinLines = (sibling.source?.joins ?? []).map((joinItem: JsonRecord) => {
    const alias = assertAlias(joinItem.alias);
    const table = sourceTables.get(alias);
    if (!table) throw new Error(`JOIN 引用了未知表：${alias}`);
    const predicates = (joinItem.on ?? []).map((condition: JsonRecord) => {
      const left = normalizeColumnReference(condition.left, siblingColumns);
      const right = normalizeColumnReference(condition.right, siblingColumns);
      return `${columnExpression(left.alias, left.field, dialect)} = ${columnExpression(right.alias, right.field, dialect)}`;
    });
    // Dedup by (alias, field) — knowledge may duplicate the same condition
    const seenCondKeys = new Set<string>();
    for (const condition of joinItem.conditions ?? []) {
      const condKey = `${condition.alias ?? alias}.${condition.field}`;
      if (seenCondKeys.has(condKey)) continue;
      seenCondKeys.add(condKey);

      const op = condition.operator === "eq" ? "=" : condition.operator;
      // Normalize value: prefer numeric form for numbers; avoids mixed 0 / '0' duplicates
      const rawVal = condition.value;
      const numVal = Number(rawVal);
      const val = (typeof rawVal === "number" || (typeof rawVal === "string" && rawVal !== "" && !isNaN(numVal)))
        ? String(numVal)
        : typeof rawVal === "string"
          ? `'${String(rawVal).replace(/'/g, "''")}'`
          : String(rawVal ?? 0);
      predicates.push(
        `${columnExpression(condition.alias ?? alias, condition.field, dialect)} ${op} ${val}`,
      );
    }
    return `${String(joinItem.type).toUpperCase()} JOIN ${quoteIdentifier(
      table.database,
      dialect,
    )}.${quoteIdentifier(table.table, dialect)} AS ${alias}\n  ON ${predicates.join("\n  AND ")}`;
  });

  // WHERE — embed system conditions as literals (script queries don't use separate bindings)
  const system = (Array.isArray(sibling.system_conditions) ? sibling.system_conditions : []).map(
    (c: JsonRecord) => {
      const op = c.operator === "eq" ? "=" : c.operator;
      const val = typeof c.value === "string" ? `'${c.value.replace(/'/g, "''")}'` : String(c.value ?? 0);
      return `  ${c.expression} ${op} ${val}`;
    },
  );
  const whereLines = (system.length ? system : ["  1 = 1"]).join("\n  AND ");

  // ORDER BY: merge key columns
  const orderParts = mergeKeys.map((mk) => {
    const parts = mk.includes(".") ? mk.split(".") : ["t0", mk];
    const name = parts[parts.length - 1]!;
    return `${quoteIdentifier(name, dialect)} ASC`;
  });

  return [
    "SELECT",
    selectParts.join(",\n"),
    `FROM ${quoteIdentifier(primary.database, dialect)}.${quoteIdentifier(primary.table, dialect)} AS ${assertAlias(primary.alias)}`,
    ...joinLines,
    "WHERE",
    whereLines,
    "  /* EASYBI_FILTERS */",
    ...(orderParts.length ? [`ORDER BY ${orderParts.join(", ")}`] : []),
    "",
  ].join("\n");
}

/**
 * Generate TypeScript script source for group_queries: streams raw data from each
 * sibling query, does in-memory COUNT DISTINCT with conditional dedup, then
 * full-outer-merges results on the shared merge key(s).
 */
function buildGroupQueriesScriptSource(
  plan: JsonRecord,
  metricDefsByGroup: Map<string, GroupQueryMetricDef[]>,
  mergeKeys: string[],
): string {
  const groupIds = [...metricDefsByGroup.keys()];
  // Extract the bare column name from a merge key ("t0.customer_name" → "customer_name")
  const mergeKeyNames = mergeKeys.map((mk) => {
    const parts = mk.includes(".") ? mk.split(".") : ["t0", mk];
    return parts[parts.length - 1]!;
  });
  const primaryKey = mergeKeyNames[0]!;

  const lines: string[] = [
    "// === AUTO-GENERATED: group_queries script ===\n// In-memory COUNT DISTINCT + conditional dedup + full-outer-merge.",
    "export async function run(ctx) {",
  ];

  // Emit metric definition tables as comments and as inline config
  for (const gid of groupIds) {
    const defs = metricDefsByGroup.get(gid) ?? [];
    lines.push(`  // --- Group: ${gid} (${defs.length} metrics) ---`);
    for (const d of defs) {
      const condDesc = d.condition ? ` WHERE ${d.condition}` : "";
      lines.push(`  //   ${d.id} (→${d.output_column}): ${d.aggregation}(${d.field})${condDesc}`);
    }
  }
  lines.push("");

  // Declare per-group storage: Map<mergeKey, { sets: Record<metricId, Set<dedupVal>> }>
  for (const gid of groupIds) {
    lines.push(`  // ${gid}: Map<mergeKey, { sets: Record<string, Set<string>> }>`);
    lines.push(`  const ${gid}Map = new Map();`);
  }
  lines.push("");

  // Stream each group's raw data query
  for (const gid of groupIds) {
    const defs = metricDefsByGroup.get(gid) ?? [];
    lines.push(`  // === Stream ${gid} raw data ===`);
    lines.push(`  for await (const row of ctx.queryStream("${gid}", ctx.filters)) {`);
    // Build composite merge key expression
    if (mergeKeyNames.length === 1) {
      lines.push(`    const key = String(row[${JSON.stringify(primaryKey)}] ?? "");`);
    } else {
      const keyExpr = mergeKeyNames.map((k) => `String(row[${JSON.stringify(k)}] ?? "")`).join(" + '|' + ");
      lines.push(`    const key = ${keyExpr};`);
    }
    // Ensure group entry with per-metric dedup Sets
    lines.push(`    if (!${gid}Map.has(key)) {`);
    lines.push(`      ${gid}Map.set(key, { sets: {} });`);
    lines.push(`    }`);
    lines.push(`    const grp = ${gid}Map.get(key);`);

    // Process each metric's dedup + condition
    for (const d of defs) {
      const fieldParts = d.field.includes(".") ? d.field.split(".") : ["t0", d.field];
      const fieldName = fieldParts[fieldParts.length - 1]!;
      const dedupCol = `row[${JSON.stringify(fieldName)}]`;

      // Build condition check
      let condCheck = "true";
      if (d.condition) {
        // Parse condition like "t0.status = 'BE_ALLOCATED'"
        // Extract column name from condition for the script
        const condMatch = d.condition.match(/^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\s*=\s*'([^']*)'$/i);
        if (condMatch) {
          const condField = condMatch[2]!;
          const condValue = condMatch[3]!;
          condCheck = `String(row[${JSON.stringify(condField)}] ?? "") === ${JSON.stringify(condValue)}`;
        } else {
          // Fallback: use the raw condition as a comment, always count
          condCheck = "true /* condition: " + d.condition + " */";
        }
      }

      const metricId = JSON.stringify(d.id);
      const dedupVal = `String(${dedupCol} ?? "")`;
      lines.push(`    // ${d.label}: ${d.aggregation}(${d.field})${d.condition ? " WHERE " + d.condition : ""}`);
      lines.push(`    if (${condCheck}) {`);
      lines.push(`      if (!grp.sets[${metricId}]) grp.sets[${metricId}] = new Set();`);
      lines.push(`      const s_${d.id} = ${dedupVal};`);
      lines.push(`      if (!grp.sets[${metricId}].has(s_${d.id})) {`);
      lines.push(`        grp.sets[${metricId}].add(s_${d.id});`);
      lines.push(`      }`);
      lines.push(`    }`);
    }
    lines.push(`  }`);
    lines.push("");
  }

  // Full-outer-merge
  lines.push(`  // === Full-outer-merge on ${primaryKey} ===`);
  if (groupIds.length === 1) {
    lines.push(`  for (const [key, grp] of ${groupIds[0]}Map) {`);
    if (mergeKeyNames.length === 1) {
      lines.push(`    const row = { ${JSON.stringify(primaryKey)}: key };`);
    } else {
      // Composite key: need to split the key back into components
      lines.push(`    const keyParts = key.split("|");`);
      const rowParts = mergeKeyNames.map((k, i) => `      ${JSON.stringify(k)}: keyParts[${i}] ?? ""`);
      lines.push(`    const row = {`);
      lines.push(rowParts.join(",\n"));
      lines.push(`    };`);
    }
    for (const d of metricDefsByGroup.get(groupIds[0]!) ?? []) {
      lines.push(`    row[${JSON.stringify(d.id)}] = grp.sets[${JSON.stringify(d.id)}]?.size ?? 0;`);
    }
    lines.push(`    ctx.emit(row);`);
    lines.push(`  }`);
  } else {
    // Multiple groups: collect all keys, build merged rows
    lines.push(`  const allKeys = new Set([`);
    for (const gid of groupIds) {
      lines.push(`    ...${gid}Map.keys(),`);
    }
    lines.push(`  ]);`);
    lines.push("");
    lines.push(`  for (const key of allKeys) {`);
    if (mergeKeyNames.length === 1) {
      lines.push(`    const row = { ${JSON.stringify(primaryKey)}: key };`);
    } else {
      lines.push(`    const keyParts = key.split("|");`);
      const rowParts = mergeKeyNames.map((k, i) => `      ${JSON.stringify(k)}: keyParts[${i}] ?? ""`);
      lines.push(`    const row = {`);
      lines.push(rowParts.join(",\n"));
      lines.push(`    };`);
    }
    for (const gid of groupIds) {
      lines.push(`    const ${gid}Grp = ${gid}Map.get(key);`);
      for (const d of metricDefsByGroup.get(gid) ?? []) {
        lines.push(`    row[${JSON.stringify(d.id)}] = ${gid}Grp?.sets[${JSON.stringify(d.id)}]?.size ?? 0;`);
      }
    }
    lines.push(`    ctx.emit(row);`);
    lines.push(`  }`);
  }
  lines.push("}");
  lines.push("");

  return lines.join("\n");
}

/**
 * Build a complete script_report from a group_queries plan, switching the report
 * from v2 SQL aggregation to v3 script-based in-memory computation.
 */
function buildScriptReportFromGroupQueriesPlan(
  plan: JsonRecord,
  queryGroups: JsonRecord[],
): void {
  if (!plan.group_queries?.queries?.length) return;

  const metricDefsByGroup = collectGroupQueryMetrics(queryGroups);
  if (!metricDefsByGroup.size) return;

  const mergeKeys: string[] = (plan.group_queries.merge_keys ?? []).map(String);
  const dialect = dialectForPlan(plan);

  // Build one query entry per sibling — raw-data SQL, no aggregation
  const queries: JsonRecord[] = [];

  for (const sibling of plan.group_queries.queries as JsonRecord[]) {
    const gid = String(sibling.id ?? "");
    const defs = metricDefsByGroup.get(gid);
    if (!defs || !defs.length) continue;

    const sql = buildGroupQueryRawSql(sibling, plan, defs, mergeKeys);
    const primary = sibling.source?.primary_table as JsonRecord | undefined;

    // Collect source table aliases and fields from this sibling
    const siblingSources: JsonRecord[] = [];
    for (const table of sibling.source?.tables ?? [primary]) {
      if (!table) continue;
      const alias = String((table as JsonRecord).alias ?? "");
      // Use all available fields from the sibling's source tables to cover:
      // merge keys, JOIN ON columns, system conditions, and metric fields.
      const tableFields = (table as JsonRecord).available_fields ?? [];
      const fields = [...new Set(tableFields.map(String))];

      // Dedup by alias
      const existing = siblingSources.find((s) => String((s as JsonRecord).alias ?? "") === alias);
      if (existing) {
        // Merge fields
        const existingFields = new Set((existing as JsonRecord).fields?.map(String) ?? []);
        for (const f of fields) existingFields.add(f);
        (existing as JsonRecord).fields = [...existingFields];
        continue;
      }

      siblingSources.push({
        profile_id: String((table as JsonRecord).profile_id ?? ""),
        database: String((table as JsonRecord).database ?? ""),
        table: String((table as JsonRecord).table ?? ""),
        alias,
        fields: [...new Set(fields)],
      });
    }

    queries.push({
      id: gid,
      mode: "stream",
      profile_id: String(primary?.profile_id ?? ""),
      database: String(primary?.database ?? ""),
      sql_dialect: dialect.id,
      sql,
      sources: siblingSources,
    });
  }

  if (!queries.length) return;

  // Generate script source
  const scriptSource = buildGroupQueriesScriptSource(plan, metricDefsByGroup, mergeKeys);

  // Build resource_budget
  const resource_budget = {
    max_queries: queries.length + 4,
    max_query_rows: 1000000,
    max_index_rows: 100000,
    max_batch_keys: 2000,
    max_output_rows: 500000,
    max_memory_mb: 512,
    timeout_seconds: 300,
    stream_batch_rows: 128,
  };

  plan.script_report = {
    queries,
    source: scriptSource,
    resource_budget,
  };

  // Inject all group-query fields into plan.fields so they appear in fields.json.
  // Merge-key dimension fields + all metric fields from every sibling.
  plan.fields = plan.fields ?? [];
  let fieldOrder = plan.fields.reduce((max: number, f: JsonRecord) => Math.max(max, Number((f as JsonRecord).order ?? 0)), 0);

  // Build a set of metric IDs for use during field source rewriting.
  const allMetricIds = new Set<string>();
  for (const defs of metricDefsByGroup.values()) {
    for (const d of defs) allMetricIds.add(d.id);
  }

  // Rewrite field sources to clean script lineage. For merge-key dimension fields
  // and metric fields, the data comes from in-memory computation — replace whatever
  // nested wrapping exists with a single-level { kind: "script", lineage: columnRef }.
  // Time-shifted and computed fields keep their own structural shapes.
  for (const field of plan.fields) {
    const fid = String((field as JsonRecord).id ?? "");
    const kind = String((field as JsonRecord).source?.kind ?? "");
    if (kind === "time_shifted" || kind === "computed") continue;

    // Metric fields: replace with clean script→column lineage from the metric def.
    if (allMetricIds.has(fid)) {
      const def = [...metricDefsByGroup.values()].flat().find((d) => d.id === fid);
      const alias = (def?.field ?? "").includes(".") ? (def?.field ?? "").split(".")[0]! : "t0";
      const fieldName = (def?.field ?? "").includes(".") ? (def?.field ?? "").split(".").pop()! : (def?.field ?? "");
      (field as JsonRecord).source = { kind: "script", lineage: { kind: "column", alias, field: fieldName } };
      (field as JsonRecord).output_type = "number";
      continue;
    }

    // Merge-key dimension fields: replace with clean script→column lineage.
    if (mergeKeys.includes(fid)) {
      // Try to find the column source from the first sibling's fields.
      const firstSibling = (plan.group_queries.queries as JsonRecord[])?.[0];
      const siblingField = (firstSibling?.fields as JsonRecord[] ?? []).find((f: JsonRecord) => String(f.id) === fid);
      if (siblingField?.source) {
        (field as JsonRecord).source = { kind: "script", lineage: { ...(siblingField as JsonRecord).source } };
      }
      (field as JsonRecord).output_type = "string";
      continue;
    }

    // Other fields: if not already script, wrap once. If already script but
    // double-wrapped (script → script → column), flatten to single-level.
    if (kind !== "script") {
      (field as JsonRecord).source = { kind: "script", lineage: { ...(field as JsonRecord).source } };
    } else if (
      (field as JsonRecord).source?.lineage?.kind === "script" &&
      (field as JsonRecord).source?.lineage?.lineage
    ) {
      // Flatten double-wrapped script source from prior pipeline runs.
      (field as JsonRecord).source = { ...(field as JsonRecord).source.lineage };
    }
  }

  // Ensure merge-key fields exist (add if missing from plan.fields).
  const existingFieldIds = new Set(plan.fields.map((f: JsonRecord) => String(f.id)));
  for (const sibling of plan.group_queries.queries as JsonRecord[]) {
    for (const f of sibling.fields ?? []) {
      const fid = String((f as JsonRecord).id ?? "");
      if (existingFieldIds.has(fid)) continue;
      const fkind = (f as JsonRecord).source?.kind;
      if (fkind === "column" && mergeKeys.includes(fid)) {
        fieldOrder += 1;
        plan.fields.push({
          id: fid,
          label: (f as JsonRecord).label ?? fid,
          order: fieldOrder,
          output_type: "string",
          source: { kind: "script", lineage: { ...(f as JsonRecord).source } },
          roles: ["group", "output"],
        });
        existingFieldIds.add(fid);
      }
    }
  }
}

/**
 * Resolve the sibling grouped queries of a multi-entity statistics report
 * (group_queries, §group-queries design) from knowledge into `plan.group_queries`.
 *
 * Shape of `config` (from configure-plan's `configuration.group_queries`):
 *   {
 *     merge_keys: ["<field id>"],          // output dimension(s) every query groups by
 *     queries: [
 *       {
 *         id: "waybill",                    // stable id, used for the generated SQL file
 *         table: { profile_id?, database, table },  // primary table (resolved from knowledge)
 *         alias: "t0",                      // optional; defaults to t0
 *         joins?: [{ type, table, alias, on, grain, extra_conditions? }],
 *         group_by: ["t0.`customer_name`"], // MUST cover every merge_key's bound column
 *         period_field: "create_time",      // the table's own time column the shared filter binds to
 *         fields: [ … sql_expression / column count fields … ],  // one row per group
 *         system_conditions?: [ … ]         // extra fixed WHERE (logical delete etc.); auto-filled from knowledge
 *       }, …
 *     ]
 *   }
 *
 * Each sibling is stored as a self-contained mini-plan object so the SAME
 * `buildSql`/`compileSql` can consume it. This function trusts knowledge for the
 * table + its columns; the count expressions the AI authors are still guarded by
 * `assertSafeSqlExpression` at generation time (never here).
 */
async function applyGroupQueries(plan: JsonRecord, config: JsonRecord): Promise<void> {
  const knowledgeRoot = plan.knowledge?.source_dir
    ? resolve(String(plan.knowledge.source_dir))
    : null;
  if (!knowledgeRoot) {
    throw new Error("group_queries 需要知识库来源（plan.knowledge.source_dir 缺失）");
  }
  const mergeKeys = (config.merge_keys ?? []).map(String);
  if (!mergeKeys.length) throw new Error("group_queries.merge_keys 不能为空");
  if (!Array.isArray(config.queries) || config.queries.length === 0) {
    throw new Error("group_queries.queries 不能为空");
  }
  // The shared time filter: a main-query parameter (date/datetime range) whose
  // value the runtime broadcasts to EACH sibling's own time column. Optional —
  // omit it for a report with no time filter. When set, it must reference an
  // existing required range parameter and every sibling must name a period_field.
  const periodParam = config.period_param ? String(config.period_param) : null;
  if (periodParam) {
    const param = (plan.parameters ?? []).find((p: JsonRecord) => p.id === periodParam);
    if (!param) {
      throw new Error(`group_queries.period_param 指向不存在的筛选参数：${periodParam}`);
    }
    if (!["date_range", "datetime_range"].includes(String(param.value_type))) {
      throw new Error(
        `group_queries.period_param「${periodParam}」必须是按日期/时间范围筛选（date_range/datetime_range）`,
      );
    }
  }
  const knowledgeTables = await loadKnowledgeTables(knowledgeRoot);
  const primaryProfile = plan.source?.primary_table?.profile_id;
  const dialect = dialectForPlan(plan);

  const seenIds = new Set<string>();
  const queries: JsonRecord[] = [];
  for (const raw of config.queries as JsonRecord[]) {
    const id = String(raw.id ?? "").trim();
    if (!id) throw new Error("group_queries.queries[] 缺少 id");
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) {
      throw new Error(`group_queries 查询 id 非法（仅字母数字/-/_）：${id}`);
    }
    if (seenIds.has(id)) throw new Error(`group_queries 查询 id 重复：${id}`);
    seenIds.add(id);

    const tableCfg = raw.table ?? {};
    const doc = knowledgeTables.find(
      (t) =>
        t.physical?.database === tableCfg.database &&
        t.physical?.table === tableCfg.table &&
        (!tableCfg.profile_id || t.physical?.profile_id === tableCfg.profile_id),
    );
    if (!doc) {
      throw new Error(
        `group_queries ${id}：知识库中找不到表 ${tableCfg.database}.${tableCfg.table}`,
      );
    }
    if (primaryProfile && doc.physical.profile_id !== primaryProfile) {
      throw new Error(
        `group_queries ${id}：来源表与主表不在同一连接 profile（不支持跨 profile 合并）`,
      );
    }
    const alias = String(raw.alias ?? "t0");
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(alias)) {
      throw new Error(`group_queries ${id}：非法表别名 ${alias}`);
    }
    const tableRecord = (tableDoc: JsonRecord, tableAlias: string): JsonRecord => ({
      profile_id: tableDoc.physical.profile_id,
      database: tableDoc.physical.database,
      table: tableDoc.physical.table,
      alias: tableAlias,
      table_id: tableDoc.table_id,
      schema_fingerprint: tableDoc.schema_fingerprint,
      available_fields: (tableDoc.physical_fields ?? []).map((f: JsonRecord) =>
        String(f.physical?.name),
      ),
      system_conditions: tableDoc.system_conditions ?? [],
    });
    const primaryRecord = tableRecord(doc, alias);
    const primaryAvailableSet = new Set((primaryRecord.available_fields ?? []).map(String));
    const resolvedByAlias = new Map<string, JsonRecord>([[alias, doc]]);
    const sourceTables: JsonRecord[] = [primaryRecord];
    const sourceJoins: JsonRecord[] = [];

    // A sibling metric may need a short, knowledge-locked JOIN path to reach the
    // shared dimension (e.g. 派车单 → 关系表 → 运单 → 订单 → 客户). This remains a
    // declarative SELECT plan: every table/column is resolved against knowledge,
    // only equality JOINs are allowed, and request values never participate.
    for (const rawJoin of raw.joins ?? []) {
      const joinAlias = String(rawJoin.alias ?? "").trim();
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(joinAlias)) {
        throw new Error(`group_queries ${id}：非法 JOIN 表别名 ${joinAlias}`);
      }
      if (resolvedByAlias.has(joinAlias)) {
        throw new Error(`group_queries ${id}：JOIN 表别名重复 ${joinAlias}`);
      }
      const joinTableCfg = rawJoin.table ?? {};
      const joinDoc = knowledgeTables.find(
        (t) =>
          t.physical?.database === joinTableCfg.database &&
          t.physical?.table === joinTableCfg.table &&
          (!joinTableCfg.profile_id || t.physical?.profile_id === joinTableCfg.profile_id),
      );
      if (!joinDoc) {
        throw new Error(
          `group_queries ${id}：知识库中找不到 JOIN 表 ${joinTableCfg.database}.${joinTableCfg.table}`,
        );
      }
      if (primaryProfile && joinDoc.physical.profile_id !== primaryProfile) {
        throw new Error(`group_queries ${id}：JOIN 表 ${joinAlias} 与主表不在同一连接 profile`);
      }
      const joinFields = new Set(
        (joinDoc.physical_fields ?? []).map((f: JsonRecord) => String(f.physical?.name)),
      );
      const on = (rawJoin.on ?? []).map((condition: JsonRecord) => {
        const left = String(condition.left ?? "");
        const right = String(condition.right ?? "");
        const leftMatch = left.match(/^([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)$/);
        const rightMatch = right.match(/^([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)$/);
        if (!leftMatch || !rightMatch || String(condition.operator ?? "eq") !== "eq") {
          throw new Error(`group_queries ${id}：JOIN ${joinAlias} 只支持 alias.field 等值关联`);
        }
        const knownSide = leftMatch[1] === joinAlias ? rightMatch : leftMatch;
        const joinedSide = leftMatch[1] === joinAlias ? leftMatch : rightMatch;
        if (!resolvedByAlias.has(knownSide[1]!)) {
          throw new Error(
            `group_queries ${id}：JOIN ${joinAlias} 必须关联到已加入的表，未知别名 ${knownSide[1]}`,
          );
        }
        const knownDoc = resolvedByAlias.get(knownSide[1]!)!;
        const knownFields = new Set(
          (knownDoc.physical_fields ?? []).map((f: JsonRecord) => String(f.physical?.name)),
        );
        if (!knownFields.has(knownSide[2]!) || !joinFields.has(joinedSide[2]!)) {
          throw new Error(`group_queries ${id}：JOIN ${joinAlias} 的 ON 字段不在知识库中`);
        }
        return { left, right, operator: "eq" };
      });
      if (!on.length) throw new Error(`group_queries ${id}：JOIN ${joinAlias} 缺少 ON 条件`);
      const joinExtraConditions = (rawJoin.extra_conditions ?? []).map((condition: JsonRecord) => {
        const field = String(condition.field ?? "");
        if (!joinFields.has(field)) {
          throw new Error(`group_queries ${id}：JOIN ${joinAlias} 条件列 ${field} 不存在`);
        }
        if (!new Set(["eq", "ne", "gt", "gte", "lt", "lte"]).has(String(condition.operator))) {
          throw new Error(`group_queries ${id}：JOIN ${joinAlias} 条件操作符不受支持`);
        }
        return { alias: joinAlias, field, operator: condition.operator, value: condition.value };
      });
      sourceTables.push(tableRecord(joinDoc, joinAlias));
      sourceJoins.push({
        type: String(rawJoin.type ?? "LEFT").toUpperCase(),
        alias: joinAlias,
        on,
        conditions: [
          ...(joinDoc.system_conditions ?? []).map((condition: JsonRecord) => ({
            alias: joinAlias,
            field: condition.field,
            operator: condition.operator,
            value: condition.value,
          })),
          ...joinExtraConditions,
        ],
        grain: String(rawJoin.grain ?? ""),
      });
      resolvedByAlias.set(joinAlias, joinDoc);
    }

    // Build a self-contained mini-source so buildSql can consume this query as-is.
    const source = {
      primary_table: {
        profile_id: doc.physical.profile_id,
        database: doc.physical.database,
        table: doc.physical.table,
        alias,
        table_id: doc.table_id,
        schema_fingerprint: doc.schema_fingerprint,
        available_fields: primaryRecord.available_fields,
        system_conditions: doc.system_conditions ?? [],
      },
      tables: sourceTables,
      joins: sourceJoins,
    };

    // Fields the query outputs (merge-key dimension columns + count expressions).
    // Trust the AI's field list; normalize kind/alias like the main query does.
    const fields = (raw.fields ?? []).map((field: JsonRecord, index: number) => {
      const normalized: JsonRecord = {
        id: String(field.id),
        label: field.label ?? String(field.id),
        order: index + 1,
        output_type: field.output_type ?? "number",
        source: { ...field.source },
        roles: Array.isArray(field.roles) ? field.roles : [],
        ...(field.description ? { description: field.description } : {}),
      };
      if (normalized.source.kind === "column") {
        normalized.source.alias = normalized.source.alias ?? alias;
        const fieldAlias = String(normalized.source.alias);
        const fieldDoc = resolvedByAlias.get(fieldAlias);
        const fieldSet = new Set(
          (fieldDoc?.physical_fields ?? []).map((f: JsonRecord) => String(f.physical?.name)),
        );
        if (!fieldDoc || !fieldSet.has(String(normalized.source.field))) {
          throw new Error(
            `group_queries ${id}：列 ${fieldAlias}.${normalized.source.field} 不在查询来源中`,
          );
        }
      }
      return normalized;
    });
    if (!fields.length) throw new Error(`group_queries ${id}：fields 不能为空`);

    // The shared time filter binds to THIS table's own time column.
    const periodField = raw.period_field ? String(raw.period_field) : null;
    const periodAlias = String(raw.period_alias ?? alias);
    const periodDoc = resolvedByAlias.get(periodAlias);
    const periodFields = new Set(
      (periodDoc?.physical_fields ?? []).map((f: JsonRecord) => String(f.physical?.name)),
    );
    if (periodField && (!periodDoc || !periodFields.has(periodField))) {
      throw new Error(
        `group_queries ${id}：period_field ${periodAlias}.${periodField} 不在查询来源中`,
      );
    }
    if (periodParam && !periodField) {
      throw new Error(
        `group_queries ${id}：已声明共享时间筛选 period_param，但本查询缺少 period_field（需指定本表的时间列）`,
      );
    }

    // Fixed WHERE conditions for this sibling: knowledge logical-delete + any
    // AI-declared per-entity filters (e.g. 运单「未拆分」/「已复核」). Both are declared
    // structurally as {field, operator, value} and compiled to plan-shaped
    // {id, expression, operator, value} so buildSql emits `col op :id` and
    // buildBindings binds the value as a parameter (never inlined — injection-safe).
    const ALLOWED_COND_OPS = new Set(["eq", "ne", "gt", "gte", "lt", "lte"]);
    const rawConditions = [
      ...(doc.system_conditions ?? []),
      ...(raw.extra_conditions ?? []).map((c: JsonRecord) => {
        const field = String(c.field ?? "");
        if (!primaryAvailableSet.has(field)) {
          throw new Error(`group_queries ${id}：extra_conditions 列 ${field} 不在表 ${doc.physical.table} 中`);
        }
        if (!ALLOWED_COND_OPS.has(String(c.operator))) {
          throw new Error(`group_queries ${id}：extra_conditions 不支持的操作符 ${c.operator}`);
        }
        return { field, operator: String(c.operator), value: c.value };
      }),
    ];
    const systemConditions = rawConditions.map((c: JsonRecord, index: number) => ({
      id: `__system_${stableId(String(c.field)).replaceAll("-", "_")}_${index + 1}`,
      expression: `${alias}.${quoteIdentifier(String(c.field), dialect)}`,
      operator: c.operator,
      value: c.value,
    }));

    queries.push({
      id,
      source,
      fields,
      aggregation: {
        group_by: (raw.group_by ?? mergeKeys).map(String),
        having: [],
      },
      // custom_logic identity: siblings use SQL GROUP BY, never an in-memory group
      // transform (that path is main-query only and mutually exclusive with this).
      custom_logic: { required: false, mode: "identity", group_keys: [], max_group_rows: 100000 },
      system_conditions: systemConditions,
      ...(periodField ? { period_field: periodField, period_alias: periodAlias } : {}),
      sql_dialect: dialect.id,
    });
  }

  plan.group_queries = {
    merge_keys: mergeKeys,
    ...(periodParam ? { period_param: periodParam } : {}),
    queries,
  };
}

function validateScriptSource(source: string): void {
  if (!source.includes("export async function run") && !source.includes("export const run")) {
    throw new Error("v3 脚本必须导出 async function run(ctx)");
  }
  if (SCRIPT_FORBIDDEN_SOURCE.test(source)) {
    throw new Error("v3 脚本只能使用 ctx API，禁止 import/require/eval/process/fs/net/fetch 等能力");
  }
}

function safeScriptSql(sql: string, mode: string): void {
  // Allow both /* KEYS */ (batch lookup) and /* EASYBI_FILTERS */ (filter injection)
  // markers, but reject any other /* ... */ comment blocks.
  const withoutSafeComments = sql
    .replace(/\/\*\s*KEYS\s*\*\//g, "KEYS_MARKER")
    .replace(/\/\*\s*EASYBI_FILTERS\s*\*\//gi, "EASYBI_FILTERS_MARKER")
    .replace(/\/\*\s*EASYBI_HAVING_FILTERS\s*\*\//gi, "EASYBI_HAVING_FILTERS_MARKER");
  if (!/^\s*(?:SELECT|WITH)\b/i.test(sql)) {
    throw new Error("v3 查询必须以 SELECT 或 WITH 开头");
  }
  if (/\b(?:INSERT|UPDATE|DELETE|REPLACE|MERGE|UPSERT|CREATE|ALTER|DROP|TRUNCATE|CALL|EXECUTE|GRANT|REVOKE)\b/i.test(sql)) {
    throw new Error("v3 查询只能包含只读 SELECT/CTE，禁止 DDL、DML 和过程调用");
  }
  if (/;|--|#|\/\*(?!\s*KEYS\s*\*\/)/.test(withoutSafeComments)) {
    throw new Error("v3 查询包含分号、注释或其它不安全结构");
  }
  const markerCount = (sql.match(/\/\*\s*KEYS\s*\*\//g) ?? []).length;
  if (mode === "batch" && markerCount !== 1) {
    throw new Error("batchLookup 查询必须且只能包含一个 /* KEYS */ 标记");
  }
  if (mode !== "batch" && markerCount !== 0) {
    throw new Error("只有 batchLookup 查询可以包含 /* KEYS */ 标记");
  }
  if (mode === "batch") {
    const markerAt = sql.search(/\/\*\s*KEYS\s*\*\//);
    const fixedBindingAt = sql.indexOf("?");
    if (fixedBindingAt >= 0 && markerAt > fixedBindingAt) {
      throw new Error("batchLookup 的 /* KEYS */ 必须位于其它位置参数之前");
    }
  }
}

async function applyScriptReport(plan: JsonRecord, config: JsonRecord): Promise<void> {
  const knowledgeRoot = plan.knowledge?.source_dir
    ? resolve(String(plan.knowledge.source_dir))
    : null;
  if (!knowledgeRoot) throw new Error("v3 脚本报表缺少 plan.knowledge.source_dir");
  const tables = await loadKnowledgeTables(knowledgeRoot);
  const ids = new Set<string>();
  const queries: JsonRecord[] = [];
  for (const raw of config.queries ?? []) {
    const id = stableId(String(raw.id ?? ""));
    if (!id || ids.has(id)) throw new Error(`v3 查询 id 缺失或重复：${raw.id ?? ""}`);
    ids.add(id);
    const mode = String(raw.mode ?? "stream");
    if (!["stream", "index", "batch"].includes(mode)) {
      throw new Error(`v3 查询 ${id} mode 必须是 stream/index/batch`);
    }
    const sql = String(raw.sql ?? "").trim();
    safeScriptSql(sql, mode);
    const locked: JsonRecord[] = [];
    for (const requested of raw.sources ?? []) {
      const table = tables.find(
        (candidate: JsonRecord) =>
          candidate.physical?.profile_id === requested.profile_id &&
          candidate.physical?.database === requested.database &&
          candidate.physical?.table === requested.table,
      );
      if (!table) {
        throw new Error(
          `v3 查询 ${id} 引用了知识库之外的表：${requested.profile_id}/${requested.database}/${requested.table}`,
        );
      }
      const available = new Set(
        (table.physical_fields ?? []).map((field: JsonRecord) => String(field.physical?.name)),
      );
      const fields = [...new Set((requested.fields ?? []).map(String))];
      for (const field of fields) {
        if (!available.has(field)) throw new Error(`v3 查询 ${id} 引用了未知列：${requested.table}.${field}`);
      }
      locked.push({
        profile_id: table.physical.profile_id,
        database: table.physical.database,
        table: table.physical.table,
        alias: assertAlias(requested.alias),
        table_id: table.table_id,
        schema_fingerprint: table.schema_fingerprint,
        fields: fields.sort(),
      });
    }
    if (!locked.length) throw new Error(`v3 查询 ${id} 必须声明至少一个知识来源`);
    const profiles = new Set(locked.map((source) => source.profile_id));
    if (profiles.size !== 1) throw new Error(`v3 单个查询 ${id} 只能使用一个连接 Profile`);
    const aliases = new Map(locked.map((source) => [source.alias, new Set(source.fields)]));
    const queryDialectId = String(
      plan.knowledge?.profile_engines?.[String(locked[0]!.profile_id)] ?? plan.sql_dialect ?? "mysql",
    );
    const dialect = getSqlDialect(queryDialectId);
    for (const match of sql.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
      if (aliases.has(match[1]!)) {
        throw new Error(`v3 查询 ${id} 的列必须使用方言引号并纳入知识锁：${match[0]}`);
      }
    }
    for (const match of sql.matchAll(dialect.referenceRegex())) {
      if (!aliases.get(match[1]!)?.has(match[2]!)) {
        throw new Error(`v3 查询 ${id} 引用了未锁定列：${match[1]}.${match[2]}`);
      }
    }
    queries.push({
      id,
      mode,
      profile_id: locked[0]!.profile_id,
      database: String(raw.database ?? locked[0]!.database),
      sql_dialect: dialect.id,
      sql,
      sources: locked,
    });
  }
  if (!queries.some((query) => query.mode === "stream")) {
    throw new Error("v3 脚本报表至少需要一个 stream 查询");
  }
  const source = String(config.source ?? "").trim();
  validateScriptSource(source);
  plan.script_report = {
    queries,
    source,
    resource_budget: {
      max_queries: 12,
      max_query_rows: 1_000_000,
      max_index_rows: 100_000,
      max_batch_keys: 2_000,
      max_output_rows: 500_000,
      max_memory_mb: 512,
      timeout_seconds: 300,
      stream_batch_rows: 128,
      ...(config.resource_budget ?? {}),
    },
  };
  // v3 的最终输出由 report.mjs 的 ctx.emit 产生。保留原知识血缘用于审阅，
  // 但不再要求这些字段同时出现在一条主 SQL 中。
  for (const field of plan.fields ?? []) {
    field.source = { kind: "script", lineage: field.source };
  }
}

/**
 * Wrap a v3 script source with comparison (环比/同比) logic.
 *
 * The wrapper injects:
 * 1. A `shiftMonths` helper to offset a period filter's {from,to} by N months.
 * 2. After the original script's `run()` body, chain/yoy queries that each
 *    re-compile the main stream query with a shifted time window, emitting
 *    into their own named sheets (export only).
 *
 * The original AI-authored source is kept intact between the `// --- your logic`
 * and `// --- end your logic` markers so it remains editable.
 */
function wrapScriptForComparison(plan: JsonRecord): void {
  const comp = plan.comparison as JsonRecord;
  const modes: string[] = Array.isArray(comp.modes) ? comp.modes.map(String) : [];
  const periodParam = String(comp.period_param ?? "create_time");
  const lookback = Number(comp.lookback_months ?? 1);

  const wrapper = `
// === AUTO-GENERATED: comparison wrapper ===
// shiftMonths: offset a period filter's {from,to} range by N months.
function shiftMonths(
  filterValue,
  months,
) {
  if (!filterValue) return filterValue;
  // Handle {operator, value:{from,to}} wrapper
  let range = filterValue;
  let wrapperObj = null;
  if (typeof range === 'object' && range !== null && !Array.isArray(range) && 'value' in range) {
    wrapperObj = range;
    range = range.value;
  }
  if (!range || typeof range !== 'object' || !range.from || !range.to) return filterValue;
  const shift = (ym) => {
    const [y, m] = String(ym).split('-').map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m)) return ym;
    const total = y * 12 + (m - 1) + months;
    const ny = Math.floor(total / 12);
    const nm = (total % 12) + 1;
    const padded = \`\${String(ny).padStart(4, '0')}-\${String(nm).padStart(2, '0')}\`;
    // Preserve day part if present
    const rest = String(ym).slice(7);
    return rest ? padded + rest : padded + '-01';
  };
  const shifted = { ...range, from: shift(String(range.from)), to: shift(String(range.to)) };
  return wrapperObj ? { ...wrapperObj, value: shifted } : shifted;
}

// === begin your logic ===
`;

  const trailer = `
// === end your logic ===

// --- comparison queries (auto-generated) ---
const __comp = {
  periodParam: ${JSON.stringify(periodParam)},
  modes: ${JSON.stringify(modes)},
  lookback: ${JSON.stringify(lookback)},
};
if (!ctx.isPreview && __comp.modes.length) {
  const periodValue = ctx.filters?.[__comp.periodParam];
  if (periodValue) {
    ${modes.includes("chain") ? `
    if (__comp.modes.includes('chain')) {
      ctx.beginSheet('环比');
      const chainFilters = { ...ctx.filters, [__comp.periodParam]: shiftMonths(periodValue, -__comp.lookback) };
      for await (const row of ctx.queryStreamWithFilters('main', chainFilters)) ctx.emit(row);
    }` : ""}
    ${modes.includes("yoy") ? `
    if (__comp.modes.includes('yoy')) {
      ctx.beginSheet('同比');
      const yoyFilters = { ...ctx.filters, [__comp.periodParam]: shiftMonths(periodValue, -12) };
      for await (const row of ctx.queryStreamWithFilters('main', yoyFilters)) ctx.emit(row);
    }` : ""}
  }
}
`;

  const original = String(plan.script_report.source ?? "");
  plan.script_report.source = wrapper + original + "\n" + trailer;
}

// ---------------------------------------------------------------------------
// Time-shifted metrics (单字段跨期计算)
// ---------------------------------------------------------------------------

interface TimeShiftedDecl {
  id: string;
  label: string;
  base_metric: string;
  /** Resolved output column name of the base metric in the SQL result. */
  base_column: string;
  shift: string;
  lookback: number;
  operation: string;
}

interface TimeShiftGroup {
  shift: string;
  lookback: number;
  effectiveLookback: number; // chain=lookback, yoy=12
  fields: TimeShiftedDecl[];
}

/** Query metadata extracted from declarative config for SQL generation. */
interface TimeShiftedQueryMeta {
  primary_alias: string;
  primary_table: string;
  profile_id: string;
  database: string;
  group_by: string[];
  metrics: JsonRecord[];
  metricColumns: Map<string, string>;
  system_conditions: JsonRecord[];
  time_filter: JsonRecord | null;
  filters: JsonRecord[];
  order_by: JsonRecord[];
}

/** Scan configuration.fields for time_shifted declarations and extract query metadata. */
function collectTimeShiftedDecls(configuration: JsonRecord): {
  groups: TimeShiftGroup[];
  queryMeta: TimeShiftedQueryMeta | null;
} {
  // Build a map of metric ID → output_column from declarative config sources
  const metricColumnMap = new Map<string, string>();
  // From query_groups (legacy declarative format for sql/group_queries)
  for (const g of configuration.query_groups ?? []) {
    for (const m of (g as JsonRecord).metrics ?? []) {
      const col = String((m as JsonRecord).output_column ?? (m as JsonRecord).field ?? (m as JsonRecord).id ?? "");
      metricColumnMap.set(String((m as JsonRecord).id), col.includes(".") ? col.split(".").pop() ?? col : col);
    }
  }
  // From top-level fields
  for (const f of configuration.fields ?? []) {
    const col = String((f as JsonRecord).output_column ?? (f as JsonRecord).id ?? "");
    metricColumnMap.set(String((f as JsonRecord).id), col);
  }
  // From group_queries (newer declarative format)
  for (const q of configuration.group_queries?.queries ?? []) {
    for (const f of (q as JsonRecord).fields ?? []) {
      const col = String((f as JsonRecord).id ?? "");
      metricColumnMap.set(col, col);
    }
  }

  const decls: TimeShiftedDecl[] = [];
  for (const candidate of configuration.fields ?? []) {
    if ((candidate as JsonRecord).source?.kind !== "time_shifted") continue;
    const source = normalizeTimeShiftedSource((candidate as JsonRecord).source);
    const baseMetric = String(source.base_metric);
    decls.push({
      id: String((candidate as JsonRecord).id ?? ""),
      label: String((candidate as JsonRecord).label ?? (candidate as JsonRecord).id ?? ""),
      base_metric: baseMetric,
      base_column: metricColumnMap.get(baseMetric) ?? baseMetric,
      shift: String(source.shift),
      lookback: Number(source.lookback),
      operation: String(source.operation),
    });
  }
  if (!decls.length) return { groups: [], queryMeta: null };

  // Extract query metadata from the first query_group for SQL generation.
  let queryMeta: TimeShiftedQueryMeta | null = null;
  const qg = (configuration.query_groups ?? [])[0] as JsonRecord | undefined;
  if (qg) {
    const alias = String(qg.primary_alias ?? "t0");
    queryMeta = {
      primary_alias: alias,
      primary_table: String(qg.primary_table ?? ""),
      profile_id: String(qg.profile_id ?? ""),
      database: String(qg.database ?? ""),
      group_by: (qg.group_by ?? []).map((g: unknown) =>
        String(g).includes(".") ? String(g).split(".").pop() ?? String(g) : String(g),
      ),
      metrics: (qg.metrics ?? []) as JsonRecord[],
      metricColumns: metricColumnMap,
      system_conditions: [],
      time_filter: (qg.time_filter ?? null) as JsonRecord | null,
      filters: (qg.filters ?? []) as JsonRecord[],
      order_by: (qg.order_by ?? []) as JsonRecord[],
    };
    // Extract system conditions
    const ld = (qg.system_conditions as JsonRecord)?.logical_delete;
    if (ld) {
      const items = Array.isArray(ld) ? ld : [ld];
      for (const item of items as JsonRecord[]) {
        queryMeta.system_conditions.push({
          alias: String((item as JsonRecord).field ?? "").includes(".")
            ? String((item as JsonRecord).field).split(".")[0]
            : alias,
          field: String((item as JsonRecord).field ?? "").includes(".")
            ? String((item as JsonRecord).field).split(".").pop() ?? ""
            : String((item as JsonRecord).field ?? ""),
          operator: String((item as JsonRecord).operator ?? "eq"),
          value: (item as JsonRecord).value ?? 0,
        });
      }
    }
    // Tenant binding
    const tb = (qg.tenant_binding as JsonRecord);
    if (tb?.field) {
      queryMeta.system_conditions.push({
        alias: String(tb.field).includes(".") ? String(tb.field).split(".")[0] : alias,
        field: String(tb.field).includes(".") ? String(tb.field).split(".").pop() ?? "" : String(tb.field),
        operator: "eq",
        value: null, // bound at runtime
      });
    }
    // Business exclusions
    for (const excl of (qg.business_exclusions ?? []) as JsonRecord[]) {
      const field = String(excl.field ?? "");
      queryMeta.system_conditions.push({
        alias: field.includes(".") ? field.split(".")[0] : alias,
        field: field.includes(".") ? field.split(".").pop() ?? "" : field,
        operator: String(excl.operator ?? "eq"),
        values: excl.values ?? [],
        placement: String(excl.placement ?? "WHERE"),
      });
    }
  }

  return { groups: groupTimeShiftedFields(decls), queryMeta };
}

/** Group time-shifted field declarations by (shift, lookback) to minimize extra queries. */
function groupTimeShiftedFields(decls: TimeShiftedDecl[]): TimeShiftGroup[] {
  const groups = new Map<string, TimeShiftGroup>();
  for (const d of decls) {
    const key = `${d.shift}:${d.lookback}`;
    if (!groups.has(key)) {
      groups.set(key, {
        shift: d.shift,
        lookback: d.lookback,
        effectiveLookback: d.shift === "yoy" ? 12 : d.lookback,
        fields: [],
      });
    }
    groups.get(key)!.fields.push(d);
  }
  return [...groups.values()];
}

/**
 * Validate base_metrics exist in plan.fields or declarative config metrics,
 * and inject time_shifted fields AND missing base_metric stubs into plan.fields
 * so the FIELD_NOT_FOUND blocker resolution picks them up and buildSql can
 * generate complete SQL.
 */
function resolveTimeShiftedMetrics(
  plan: JsonRecord,
  decls: TimeShiftedDecl[],
  configMetricIds: Set<string>,
  configMetricColumns: Map<string, { column: string; alias: string; field: string }>,
): void {
  plan.fields = plan.fields ?? [];
  const existingIds = new Set(plan.fields.map((f: JsonRecord) => String(f.id)));

  const errors: string[] = [];
  for (const d of decls) {
    if (!existingIds.has(d.base_metric) && !configMetricIds.has(d.base_metric)) {
      errors.push(
        `time_shifted 字段 ${d.id}（${d.label}）引用的 base_metric ${d.base_metric} 不在 plan.fields 或声明式配置指标中`,
      );
    }
    // Inject the base metric as a plan field if it's only in declarative config.
    if (!existingIds.has(d.base_metric) && configMetricIds.has(d.base_metric)) {
      const colInfo = configMetricColumns.get(d.base_metric);
      plan.fields.push({
        id: d.base_metric,
        label: d.base_metric,
        output_column: colInfo?.column ?? d.base_metric,
        output_type: "number",
        source: {
          kind: "column",
          alias: colInfo?.alias ?? "t0",
          field: colInfo?.field ?? d.base_metric,
        },
        roles: ["output", "metric"],
      });
      existingIds.add(d.base_metric);
    }
    // Inject the time_shifted field itself.
    if (existingIds.has(d.id)) continue;
    plan.fields.push({
      id: d.id,
      label: d.label,
      output_type: "number",
      source: {
        kind: "time_shifted",
        base_metric: d.base_metric,
        shift: d.shift,
        lookback: d.lookback,
        operation: d.operation,
      },
      roles: ["output", "metric"],
    });
    existingIds.add(d.id);
  }
  if (errors.length) throw new Error(errors.join("；"));

  (plan as JsonRecord)._has_time_shifted = decls.length > 0;
}

/**
 * Generate the TypeScript script source for time-shifted metrics.
 * The script:
 *  1. Defines a shiftMonths helper (reused from comparison wrapper)
 *  2. For each shift group, builds an index Map<groupKey, row> from
 *     queryStreamWithFilters with shifted filters
 *  3. Streams the main query, looks up shifted indexes, computes deltas, emits
 */
function buildTimeShiftedScriptSource(
  plan: JsonRecord,
  shiftGroups: TimeShiftGroup[],
  periodParam: string,
  groupByKeys: string[],
): string {
  // Resolve group key columns for time-shifted index lookup. Priority:
  //  1. groupByKeys parameter (from queryMeta or plan dims, already stripped of alias prefix)
  //  2. semantic_plan.dimensions[0].id
  //  3. result_grain.keys[0] (model format)
  //  4. Fallback "id"
  let groupKeys: string[] = groupByKeys.length
    ? groupByKeys
    : ((plan.semantic_plan as JsonRecord)?.dimensions as JsonRecord[] ?? [])
        .map((d: JsonRecord) => String(d.id ?? "").includes(".") ? String(d.id).split(".").pop() ?? String(d.id) : String(d.id));
  if (!groupKeys.length) {
    const grainKey = (plan.result_grain as JsonRecord)?.keys?.[0];
    if (grainKey) {
      const gk = typeof grainKey === "string" ? grainKey : (grainKey as JsonRecord)?.field ?? (grainKey as JsonRecord)?.name ?? String(grainKey);
      groupKeys = [gk.includes(".") ? gk.split(".").pop() ?? gk : gk];
    }
  }
  if (!groupKeys.length) groupKeys = ["id"];
  // Resolve each time_shifted field's base metric to its output column name.
  // base_column is resolved during collectTimeShiftedDecls from the declarative config.
  const fieldMap = new Map((plan.fields ?? []).map((f: JsonRecord) => [String(f.id), f]));
  const resolveColumn = (decl: TimeShiftedDecl): string => {
    // Prefer the pre-resolved column from the declarative config.
    if (decl.base_column) return decl.base_column;
    // Fallback: look up in plan.fields.
    const f = fieldMap.get(decl.base_metric);
    if (!f) return decl.base_metric;
    return String(
      (f as JsonRecord).output_column ??
      (f as JsonRecord).source?.field ??
      (f as JsonRecord).source?.expression ??
      (f as JsonRecord).id ??
      decl.base_metric,
    );
  };
  const resolveLabel = (baseMetricId: string): string => {
    const f = fieldMap.get(baseMetricId);
    return f ? String((f as JsonRecord).label ?? baseMetricId) : baseMetricId;
  };

  // Build key expression for Map lookups
  const keyExpr = groupKeys.length === 1
    ? `row[${JSON.stringify(groupKeys[0])}]`
    : groupKeys.map((k) => `row[${JSON.stringify(k)}]`).join(" + '|' + ");
  const keyExprQuoted = groupKeys.length === 1
    ? `row[${JSON.stringify(groupKeys[0])}]`
    : groupKeys.map((k) => `row[${JSON.stringify(k)}]`).join(" + \"|\" + ");

  const lines: string[] = [];
  lines.push("// === AUTO-GENERATED: time-shifted metrics script ===");
  lines.push("// shiftMonths: offset a period filter's {from,to} range by N months.");
  lines.push("function shiftMonths(filterValue, months) {");
  lines.push("  if (!filterValue) return filterValue;");
  lines.push("  let range = filterValue;");
  lines.push("  let wrapperObj = null;");
  lines.push("  if (typeof range === 'object' && range !== null && !Array.isArray(range) && 'value' in range) {");
  lines.push("    wrapperObj = range;");
  lines.push("    range = range.value;");
  lines.push("  }");
  lines.push("  if (!range || typeof range !== 'object' || !range.from || !range.to) return filterValue;");
  lines.push("  const shift = (ym) => {");
  lines.push("    const [y, m] = String(ym).split('-').map(Number);");
  lines.push("    if (!Number.isFinite(y) || !Number.isFinite(m)) return ym;");
  lines.push("    const total = y * 12 + (m - 1) + months;");
  lines.push("    const ny = Math.floor(total / 12);");
  lines.push("    const nm = (total % 12) + 1;");
  lines.push("    const padded = `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}`;");
  lines.push("    const rest = String(ym).slice(7);");
  lines.push("    return rest ? padded + rest : padded + '-01';");
  lines.push("  };");
  lines.push("  const shifted = { ...range, from: shift(String(range.from)), to: shift(String(range.to)) };");
  lines.push("  return wrapperObj ? { ...wrapperObj, value: shifted } : shifted;");
  lines.push("}");
  lines.push("");
  lines.push("export async function run(ctx) {");
  lines.push(`  const periodValue = ctx.filters?.[${JSON.stringify(periodParam)}];`);
  lines.push("");

  // Build a shifted index for each shift group
  for (const g of shiftGroups) {
    const indexName = `${g.shift}Index`;
    const monthsBack = g.effectiveLookback;
    const label = g.shift === "chain" ? "环比" : "同比";
    lines.push(`  // Build ${label} index (shift back ${monthsBack} month(s))`);
    lines.push(`  let ${indexName} = null;`);
    lines.push("  if (periodValue) {");
    lines.push(`    const ${g.shift}Filters = { ...ctx.filters, ${JSON.stringify(periodParam)}: shiftMonths(periodValue, ${-monthsBack}) };`);
    lines.push(`    const ${g.shift}Map = new Map();`);
    lines.push(`    for await (const row of ctx.queryStreamWithFilters('main', ${g.shift}Filters)) {`);
    lines.push(`      ${g.shift}Map.set(${keyExpr}, row);`);
    lines.push("    }");
    lines.push(`    ${indexName} = ${g.shift}Map;`);
    lines.push("  }");
    lines.push("");
  }

  // Stream main + merge
  lines.push("  // Stream main query and merge time-shifted values");
  lines.push("  for await (const row of ctx.queryStream('main', ctx.filters)) {");
  lines.push(`    const key = ${keyExprQuoted};`);
  lines.push("");

  // Generate merge + compute logic
  const usedBaseMetrics = new Set<string>();
  for (const g of shiftGroups) {
    const indexName = `${g.shift}Index`;
    lines.push(`    const ${g.shift}Row = ${indexName}?.get(key);`);
    if (g.fields.length > 0) {
      lines.push(`    if (${g.shift}Row) {`);
      for (const f of g.fields) {
        const col = resolveColumn(f);
        const baseLabel = resolveLabel(f.base_metric);
        // Reference the base metric's output column name on the current row
        lines.push(`      // ${f.label} = current ${baseLabel} - ${g.shift} ${baseLabel}`);
        if (f.operation === "subtract") {
          lines.push(`      row[${JSON.stringify(f.id)}] = (row[${JSON.stringify(col)}] ?? 0) - (${g.shift}Row[${JSON.stringify(col)}] ?? 0);`);
        } else if (f.operation === "divide") {
          lines.push(`      row[${JSON.stringify(f.id)}] = ${g.shift}Row[${JSON.stringify(col)}] != 0 ? (row[${JSON.stringify(col)}] ?? 0) / ${g.shift}Row[${JSON.stringify(col)}] : null;`);
        } else if (f.operation === "percent_change") {
          lines.push(`      row[${JSON.stringify(f.id)}] = ${g.shift}Row[${JSON.stringify(col)}] != 0 ? ((row[${JSON.stringify(col)}] ?? 0) - ${g.shift}Row[${JSON.stringify(col)}]) / ${g.shift}Row[${JSON.stringify(col)}] * 100 : null;`);
        }
      }
      lines.push("    }");
    }
    lines.push("");
  }

  lines.push("    ctx.emit(row);");
  lines.push("  }");
  lines.push("}");

  return lines.join("\n") + "\n";
}

/**
 * Build a script_report structure from a plan that has time_shifted metrics.
 * Generates a proper aggregated SQL query from the query metadata, locks sources,
 * and creates a generated script that handles querying + merging + computing
 * time-shifted fields.
 */
function buildScriptReportFromTimeShiftedPlan(
  plan: JsonRecord,
  shiftGroups: TimeShiftGroup[],
  periodParam: string,
  queryMeta: TimeShiftedQueryMeta | null,
): void {
  const primaryTable = plan.source?.primary_table as JsonRecord | undefined;
  const db = queryMeta?.database ?? String(primaryTable?.database ?? "");
  const table = queryMeta?.primary_table ?? String(primaryTable?.table ?? "");
  const alias = queryMeta?.primary_alias ?? String(primaryTable?.alias ?? "t0");
  const profileId = queryMeta?.profile_id ?? String(primaryTable?.profile_id ?? "");
  const dialect = dialectForPlan(plan);

  // Build GROUP BY from queryMeta or semantic_plan.dimensions
  const groupByCols: string[] = queryMeta?.group_by?.length
    ? queryMeta.group_by
    : ((plan.semantic_plan as JsonRecord)?.dimensions as JsonRecord[] ?? [])
        .map((d: JsonRecord) => String(d.id ?? ""));
  const groupByIdents = groupByCols.map((col) => columnExpression(alias, col, dialect));

  // Build SELECT list: dimension columns + aggregated metrics
  const selectParts: string[] = [];
  const addedCols = new Set<string>();

  // 1. Dimension columns (plain, no aggregation)
  for (const col of groupByCols) {
    if (addedCols.has(col)) continue;
    selectParts.push(`${columnExpression(alias, col, dialect)} AS ${quoteIdentifier(col, dialect)}`);
    addedCols.add(col);
  }

  // 2. ALL metric columns from queryMeta (incl. those not referenced by time_shifted)
  const metricMap = new Map<string, JsonRecord>();
  const metricIds: string[] = [];
  for (const m of queryMeta?.metrics ?? []) {
    const mid = String((m as JsonRecord).id);
    metricMap.set(mid, m as JsonRecord);
    metricIds.push(mid);
  }

  // 3. Also include plan.fields that are NOT time_shifted and NOT already in group_by
  //    (e.g., extra dimension columns from inspectReport)
  for (const field of plan.fields ?? []) {
    const kind = String((field as JsonRecord).source?.kind ?? "");
    if (kind === "time_shifted") continue;
    if (kind === "computed") continue;

    const fid = String((field as JsonRecord).id ?? "");
    const colName = String((field as JsonRecord).output_column ?? fid);

    // Skip if already in GROUP BY or metrics
    if (addedCols.has(colName)) continue;
    if (metricMap.has(fid)) continue;
    if (groupByCols.includes(colName) || groupByCols.includes(fid)) continue;

    // Extra non-grouped, non-metric columns: wrap in MAX() to be safe in GROUP BY
    if (kind === "column" || kind === "boolean_flag") {
      const fName = String((field as JsonRecord).source?.field ?? colName);
      const fAlias = String((field as JsonRecord).source?.alias ?? alias);
      selectParts.push(
        `MAX(${columnExpression(fAlias, fName, dialect)}) AS ${quoteIdentifier(colName, dialect)}`,
      );
      addedCols.add(colName);
    } else if (kind === "sql_expression") {
      selectParts.push(
        `${String((field as JsonRecord).source?.expression ?? colName)} AS ${quoteIdentifier(colName, dialect)}`,
      );
      addedCols.add(colName);
    }
  }

  // 4. Process ALL metrics from queryMeta
  for (const mid of metricIds) {
    const metricDef = metricMap.get(mid);
    if (!metricDef) continue;
    const colName = String(metricDef.output_column ?? mid);
    if (addedCols.has(colName)) continue;

    // Look up aggregation info from queryMeta
      const agg = String(metricDef.aggregation ?? "").toLowerCase();
      const rawField = String(metricDef.field ?? "");
      const fieldParts = rawField.includes(".") ? rawField.split(".") : [alias, rawField];
      const fAlias = fieldParts[0] ?? alias;
      const fName = fieldParts[fieldParts.length - 1] ?? rawField;
      const colRef = columnExpression(fAlias, fName, dialect);
      const cond = metricDef.condition ? String(metricDef.condition) : null;

      // Re-quote column references in AI-authored condition strings.
      const quotedCond = cond
        ? cond.replace(/\b([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\b/gi, (_m, a, f) =>
            `${dialect.quoteChar}${a}${dialect.quoteChar}.${dialect.quoteChar}${f}${dialect.quoteChar}`)
        : null;

      let expr: string;
      if (agg === "count_distinct") {
        expr = quotedCond
          ? `COUNT(DISTINCT CASE WHEN ${quotedCond} THEN ${colRef} END)`
          : `COUNT(DISTINCT ${colRef})`;
      } else if (agg === "sum") {
        expr = quotedCond ? `SUM(CASE WHEN ${quotedCond} THEN ${colRef} ELSE 0 END)` : `SUM(${colRef})`;
      } else if (agg === "max") {
        expr = quotedCond ? `MAX(CASE WHEN ${quotedCond} THEN ${colRef} END)` : `MAX(${colRef})`;
      } else if (agg === "min") {
        expr = quotedCond ? `MIN(CASE WHEN ${quotedCond} THEN ${colRef} END)` : `MIN(${colRef})`;
      } else if (agg === "avg") {
        expr = quotedCond ? `AVG(CASE WHEN ${quotedCond} THEN ${colRef} END)` : `AVG(${colRef})`;
      } else if (agg === "group_concat" || agg === "group_concat_distinct") {
        const distinct = agg === "group_concat_distinct" ? "DISTINCT " : "";
        expr = quotedCond
          ? `GROUP_CONCAT(${distinct}CASE WHEN ${quotedCond} THEN ${colRef} END)`
          : `GROUP_CONCAT(${distinct}${colRef})`;
      } else {
        expr = colRef; // fallback: plain column reference
      }
      selectParts.push(`${expr} AS ${quoteIdentifier(colName, dialect)}`);
      addedCols.add(colName);
  }

  if (!selectParts.length) {
    throw new Error("time_shifted 报表没有可查询字段");
  }
  const selectList = selectParts.map((s) => `  ${s}`).join(",\n");

  // Build WHERE clauses from system conditions
  const whereParts: string[] = [];
  for (const sc of queryMeta?.system_conditions ?? []) {
    const scAlias = String((sc as JsonRecord).alias ?? alias);
    const scField = String((sc as JsonRecord).field ?? "");
    if (!scField) continue;
    const scOp = String((sc as JsonRecord).operator ?? "eq");
    const scVal = (sc as JsonRecord).value;
    const scVals = (sc as JsonRecord).values;
    const placement = String((sc as JsonRecord).placement ?? "WHERE");
    if (placement !== "WHERE") continue; // only WHERE for now

    const colRef = columnExpression(scAlias, scField, dialect);
    if (scVals && Array.isArray(scVals) && (scVals as unknown[]).length) {
      const vals = (scVals as unknown[]).map((v) => `'${String(v).replace(/'/g, "''")}'`).join(", ");
      whereParts.push(`${colRef} ${scOp === "NOT IN" ? "NOT IN" : "IN"} (${vals})`);
    } else if (scVal !== null && scVal !== undefined) {
      whereParts.push(`${colRef} ${scOp === "eq" ? "=" : scOp} ${typeof scVal === "number" ? scVal : `'${String(scVal).replace(/'/g, "''")}'`}`);
    }
    // null value = bound at runtime (e.g. tenant_id), skip
  }

  // Build FROM clause
  const fromTable = db
    ? `${quoteIdentifier(db, dialect)}.${quoteIdentifier(table, dialect)}`
    : quoteIdentifier(table, dialect);

  // Assemble SQL
  const sqlLines = [`SELECT`, selectList, `FROM ${fromTable} AS ${quoteIdentifier(alias, dialect)}`];
  if (whereParts.length) {
    sqlLines.push(`WHERE ${whereParts.join("\n  AND ")}`);
  }
  sqlLines.push(`GROUP BY ${groupByIdents.join(", ")}`);

  // ORDER BY
  const orderCols: string[] = queryMeta?.order_by?.length
    ? (queryMeta.order_by as JsonRecord[]).map((o: JsonRecord) => {
        const f = String((o as JsonRecord).field ?? "").includes(".")
          ? String((o as JsonRecord).field).split(".").pop() ?? ""
          : String((o as JsonRecord).field ?? "");
        const dir = String((o as JsonRecord).direction ?? "ASC");
        return `${quoteIdentifier(f, dialect)} ${dir}`;
      })
    : groupByCols.map((col) => `${quoteIdentifier(col, dialect)} ASC`);
  sqlLines.push(`ORDER BY ${orderCols.join(", ")}`);

  const mainSql = sqlLines.join("\n") + "\n";

  const dialectId = String(plan.knowledge?.profile_engines?.[profileId] ?? plan.sql_dialect ?? "mysql");

  // Lock sources from the plan
  const availableCols = availableColumnsForPlan(plan);
  const availableFields = new Set<string>();
  for (const cols of availableCols.values()) {
    for (const c of cols) availableFields.add(c);
  }
  const sources: JsonRecord[] = [{
    profile_id: profileId,
    database: db,
    table,
    alias,
    fields: [...availableFields].sort(),
  }];

  // Generate the script source
  const scriptSource = buildTimeShiftedScriptSource(plan, shiftGroups, periodParam, groupByCols);

  // Build script_report structure
  plan.script_report = {
    queries: [
      {
        id: "main",
        mode: "stream",
        profile_id: profileId,
        database: db,
        sql_dialect: dialectId,
        sql: mainSql,
        sources,
      },
    ],
    source: scriptSource,
    resource_budget: {
      max_queries: 12,
      max_query_rows: 1_000_000,
      max_index_rows: 100_000,
      max_batch_keys: 2_000,
      max_output_rows: 500_000,
      max_memory_mb: 512,
      timeout_seconds: 300,
      stream_batch_rows: 128,
    },
  };

  // Rewrite field sources for the knowledge lock.
  for (const field of plan.fields ?? []) {
    const kind = String((field as JsonRecord).source?.kind ?? "");
    if (kind === "time_shifted") continue;
    (field as JsonRecord).source = {
      kind: "script",
      lineage: (field as JsonRecord).source,
    };
  }
}

function finalizePlanningDocuments(plan: JsonRecord, configuration: JsonRecord): void {
  const strategy = plan.script_report
    ? "script"
    : plan.group_queries?.queries?.length
      ? "group_queries"
      : plan.enrichments?.length
        ? "enrichment"
        : "sql";
  const suppliedSemantic = configuration.semantic_plan ?? {};
  plan.semantic_plan = {
    ...(plan.semantic_plan ?? {}),
    ...suppliedSemantic,
    status: "ready_for_review",
    result_grain:
      suppliedSemantic.result_grain ??
      configuration.result_grain ??
      plan.source?.joins?.find((joinItem: JsonRecord) => joinItem.grain)?.grain ??
      "主查询输出行粒度",
    open_questions: suppliedSemantic.open_questions ?? [],
  };
  const suppliedExecution = configuration.execution_plan ?? {};
  const automaticSteps = plan.script_report
    ? plan.script_report.queries.map((query: JsonRecord, index: number) => ({
        id: `Q${index + 1}`,
        type: query.mode === "stream" ? "query_stream" : query.mode === "index" ? "load_index" : "batch_lookup",
        description: `执行查询 ${query.id}（${query.mode}）`,
        query_id: query.id,
      }))
    : [{ id: "Q1", type: strategy, description: `按 ${strategy} 策略生成并执行报表` }];
  plan.execution_plan = {
    ...(plan.execution_plan ?? {}),
    ...suppliedExecution,
    status: "ready_for_review",
    strategy,
    steps: suppliedExecution.steps?.length ? suppliedExecution.steps : automaticSteps,
    rationale: suppliedExecution.rationale ?? `根据结果粒度和关系基数选择 ${strategy}`,
    ...(plan.script_report ? { resource_budget: plan.script_report.resource_budget } : {}),
  };
}

export function renderPlanReview(plan: JsonRecord): string {
  const semantic = plan.semantic_plan ?? {};
  const execution = plan.execution_plan ?? {};
  const lines = [
    `# ${plan.report?.name ?? plan.report?.id}：语义计划与执行计划`,
    "",
    `- 结果粒度：${semantic.result_grain ?? "待确认"}`,
    `- 执行策略：${execution.strategy ?? "待选择"}`,
    `- 选择理由：${execution.rationale ?? ""}`,
    "",
    "## 指标口径",
    ...(semantic.metrics ?? []).map(
      (metric: JsonRecord) => `- ${metric.label ?? metric.id}：${metric.definition || "待确认"}`,
    ),
    "",
    "## 执行步骤",
    ...(execution.steps ?? []).map(
      (step: JsonRecord, index: number) => `${index + 1}. ${step.description ?? step.id}`,
    ),
  ];
  if ((semantic.open_questions ?? []).length) {
    lines.push("", "## 待确认问题", ...(semantic.open_questions ?? []).map((question: unknown) => `- ${String(question)}`));
  }
  return `${lines.join("\n")}\n`;
}

export async function explainPlan(planPath: string): Promise<string> {
  return renderPlanReview(await readJson(resolve(planPath)));
}

export async function buildKnowledgeContext(options: {
  plan: string;
  out: string;
  include?: string[];
  maxTables?: number;
  maxFields?: number;
  maxBytes?: number;
}): Promise<JsonRecord> {
  const plan = await readJson(resolve(options.plan));
  const knowledgeRoot = resolve(String(plan.knowledge?.source_dir ?? ""));
  if (!plan.knowledge?.source_dir) throw new Error("计划缺少 knowledge.source_dir");
  const allTables = await loadKnowledgeTables(knowledgeRoot);
  const maxTables = options.maxTables ?? 6;
  const maxFields = options.maxFields ?? 80;
  const maxBytes = options.maxBytes ?? 64_000;
  const requested = new Set<string>();
  const explicitFields = new Set<string>();
  const addSource = (source: JsonRecord): void => {
    if (source?.table_id) requested.add(String(source.table_id));
    if (source?.profile_id && source?.database && source?.table) {
      requested.add(`${source.profile_id}/${source.database}/${source.table}`);
    }
  };
  for (const table of plan.source?.tables ?? []) addSource(table);
  for (const query of plan.script_report?.queries ?? []) {
    for (const source of query.sources ?? []) addSource(source);
  }
  for (const value of options.include ?? []) requested.add(String(value));
  for (const blocker of plan.blockers ?? []) {
    for (const suggestion of blocker.suggestions ?? []) {
      const value = String(suggestion);
      requested.add(value.split(".").slice(0, -1).join("."));
      explicitFields.add(value);
    }
  }

  const requirementIntents = (plan.semantic_plan?.metrics ?? []).map(
    (metric: JsonRecord, index: number) => {
      const label = String(metric.label ?? metric.id ?? `metric-${index + 1}`);
      const description = String(metric.definition ?? "");
      const isMetric =
        /数量|总数|合计|金额|总额|比例|比率|率$|均值|平均/.test(label) ||
        String(metric.kind ?? "") === "metric";
      const aggregation = /比例|比率|率$/.test(label)
        ? "ratio"
        : /数量|总数|数$/.test(label)
          ? "count_distinct"
          : /金额|总额|合计/.test(label)
            ? "sum"
            : /平均|均值/.test(label)
              ? "avg"
              : isMetric
                ? "count_distinct"
                : "value";
      const rawStatusSemantic = label
        .replace(/的?(订单|运单|派车单)?(数量|总数|数|合计)$/u, "")
        .trim();
      const statusSemantic =
        /^(合计|总计|全部|所有)$/u.test(rawStatusSemantic)
          ? ""
          : rawStatusSemantic;
      const entity = label.includes("派车单")
        ? "派车单"
        : label.includes("运单")
          ? "运单"
          : label.includes("订单")
            ? "订单"
            : "";
      return {
        id: String(metric.id ?? `metric-${index + 1}`),
        label,
        description,
        kind: isMetric ? "metric" : "value",
        aggregation,
        entity,
        status_semantic: statusSemantic && statusSemantic !== label ? statusSemantic : null,
      };
    },
  );

  let enumCatalog: JsonRecord = { dictionaries: [], bindings: [] };
  try {
    enumCatalog = await readJson(join(knowledgeRoot, "global", "enums.json"));
  } catch {
    // A catalog may legitimately have no enum dictionary.
  }
  const dictionaries = new Map<string, JsonRecord>(
    (enumCatalog.dictionaries ?? []).map((item: JsonRecord) => [String(item.name), item]),
  );
  const bindings = new Map<string, string>(
    (enumCatalog.bindings ?? []).map((item: JsonRecord) => [
      `${item.table_id}.${item.field}`,
      String(item.dictionary_name ?? ""),
    ]),
  );

  const normalized = (value: unknown): string =>
    String(value ?? "").toLowerCase().replaceAll(/[\s_\-—–·，。；：、（）()【】[\]]/gu, "");
  const tableIdentity = (table: JsonRecord): string => {
    const physical = table.physical ?? {};
    return `${physical.profile_id}/${physical.database}/${physical.table}`;
  };
  const fieldIdentity = (table: JsonRecord, field: JsonRecord): string =>
    `${table.physical?.table}.${field.physical?.name}`;
  const tableText = (table: JsonRecord): string =>
    normalized([
      table.physical?.database,
      table.physical?.table,
      table.semantic?.name,
      table.business?.entity_id,
      table.business?.name,
      table.comment,
    ].filter(Boolean).join(" "));
  const dictionaryFor = (table: JsonRecord, field: JsonRecord): JsonRecord | undefined => {
    const ref =
      field.semantic?.enum_ref ??
      bindings.get(`${table.table_id}.${field.physical?.name}`);
    return ref ? dictionaries.get(String(ref)) : undefined;
  };
  const fieldText = (table: JsonRecord, field: JsonRecord): string => {
    const dictionary = dictionaryFor(table, field);
    return normalized([
      field.physical?.name,
      field.physical?.comment,
      field.semantic?.name,
      field.semantic?.description,
      field.filter?.role,
      ...(dictionary?.values ?? []).flatMap((item: JsonRecord) => [
        item.value,
        item.label,
        item.description,
      ]),
    ].filter(Boolean).join(" "));
  };
  const entityScore = (entity: string, table: JsonRecord): number => {
    const text = tableText(table);
    const physical = normalized(table.physical?.table);
    const auxiliary =
      /draft|photo|proof|detail|history|log|item|product|relation|mapping/u.test(
        physical,
      );
    if (entity === "派车单" && /(派车|shippingorder|dispatch)/u.test(text)) {
      if (physical === "shippingorder" || physical === "dispatch") return 110;
      return auxiliary ? 15 : 65;
    }
    if (entity === "运单" && /(运单|waybill)/u.test(text)) {
      if (physical === "omswaybill" || physical === "waybill") return 110;
      return auxiliary ? 15 : 65;
    }
    if (entity === "订单" && /(订单|order)/u.test(text) && !/(派车|shipping)/u.test(text)) {
      if (["omsmainordersimple", "omsmainorder", "order"].includes(physical)) return 90;
      return auxiliary ? 10 : 45;
    }
    return 0;
  };

  const candidatesByIntent = requirementIntents.map((intent: JsonRecord) => {
    const scored: JsonRecord[] = [];
    for (const table of allTables) {
      const physical = table.physical ?? {};
      const selectedExplicitly =
        requested.has(String(table.table_id)) ||
        requested.has(tableIdentity(table)) ||
        requested.has(`${physical.database}.${physical.table}`) ||
        requested.has(String(physical.table));
      for (const field of table.physical_fields ?? []) {
        const text = fieldText(table, field);
        const label = normalized(intent.label);
        const status = normalized(intent.status_semantic);
        const physicalName = String(field.physical?.name ?? "");
        let score = selectedExplicitly ? 15 : 0;
        const reasons: string[] = [];
        if (explicitFields.has(fieldIdentity(table, field))) {
          score += 100;
          reasons.push("inspect 候选");
        }
        const entity = entityScore(String(intent.entity ?? ""), table);
        if (entity) {
          score += entity;
          reasons.push("实体匹配");
        }
        if (label && text.includes(label)) {
          score += 90;
          reasons.push("字段语义精确匹配");
        }
        if (status && text.includes(status)) {
          score += 80;
          reasons.push("状态语义匹配");
        }
        if (
          intent.kind === "metric" &&
          /(status|state|状态)/iu.test(
            `${physicalName} ${field.semantic?.name ?? ""} ${field.physical?.comment ?? ""}`,
          )
        ) {
          score += 35;
          reasons.push("状态字段");
        }
        if (field.physical?.primary_key === true) {
          score += intent.aggregation === "count_distinct" ? 28 : 8;
          reasons.push("去重键候选");
        }
        if (score < 35) continue;
        const dictionary = dictionaryFor(table, field);
        scored.push({
          table_id: table.table_id,
          profile_id: physical.profile_id,
          database: physical.database,
          table: physical.table,
          field: physicalName,
          semantic_name: field.semantic?.name ?? field.physical?.comment ?? physicalName,
          score,
          reasons,
          ...(dictionary ? { enum_ref: dictionary.name } : {}),
        });
      }
    }
    return {
      requirement_id: intent.id,
      label: intent.label,
      kind: intent.kind,
      aggregation: intent.aggregation,
      entity: intent.entity,
      status_semantic: intent.status_semantic,
      candidates: scored
        .sort(
          (left, right) =>
            Number(right.score) - Number(left.score) ||
            `${left.table}.${left.field}`.localeCompare(`${right.table}.${right.field}`),
        )
        .slice(0, 4),
    };
  });

  const tableScores = new Map<string, number>();
  for (const table of allTables) {
    const identity = tableIdentity(table);
    const physical = table.physical ?? {};
    if (
      requested.has(String(table.table_id)) ||
      requested.has(identity) ||
      requested.has(`${physical.database}.${physical.table}`) ||
      requested.has(String(physical.table))
    ) {
      tableScores.set(identity, 120);
    }
  }
  for (const set of candidatesByIntent) {
    for (const candidate of set.candidates ?? []) {
      const identity = `${candidate.profile_id}/${candidate.database}/${candidate.table}`;
      tableScores.set(identity, (tableScores.get(identity) ?? 0) + Number(candidate.score ?? 0));
    }
  }
  const selected = allTables
    .filter((table) => tableScores.has(tableIdentity(table)))
    .sort(
      (left, right) =>
        (tableScores.get(tableIdentity(right)) ?? 0) -
          (tableScores.get(tableIdentity(left)) ?? 0) ||
        tableIdentity(left).localeCompare(tableIdentity(right)),
    )
    .slice(0, maxTables);
  const selectedIdentities = new Set(selected.map(tableIdentity));
  const selectedTableIds = new Set(selected.map((table) => String(table.table_id)));
  const relationshipItems: JsonRecord[] = [];
  const relationshipCandidates: JsonRecord[] = [];
  const visitRelationships = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visitRelationships(child);
      } else if (entry.isFile() && entry.name === "relationships.json") {
        const catalog = await readJson(child).catch(() => null);
        if (!catalog) continue;
        relationshipItems.push(...(catalog.relationships ?? []));
        relationshipCandidates.push(...(catalog.candidates ?? []));
      }
    }
  };
  await visitRelationships(join(knowledgeRoot, "databases"));
  const relevantRelationship = (relationship: JsonRecord): boolean =>
    selectedTableIds.has(String(relationship.source_table_id ?? "")) &&
    selectedTableIds.has(String(relationship.target_table_id ?? ""));
  const relationships = relationshipItems.filter(relevantRelationship);
  const candidateRelationships = relationshipCandidates.filter(relevantRelationship);

  const priorities = new Map<string, number>();
  const raisePriority = (table: JsonRecord, fieldName: unknown, value: number): void => {
    const name = String(fieldName ?? "");
    if (!name) return;
    const key = `${tableIdentity(table)}.${name}`;
    priorities.set(key, Math.max(priorities.get(key) ?? 0, value));
  };
  for (const table of selected) {
    for (const field of table.physical_fields ?? []) {
      if (field.physical?.primary_key) raisePriority(table, field.physical.name, 100);
      if (
        /(status|state|状态|time|date|时间|日期)/iu.test(
          `${field.physical?.name ?? ""} ${field.semantic?.name ?? ""}`,
        )
      ) {
        raisePriority(table, field.physical?.name, 45);
      }
      if (
        /拆分|split/iu.test(String(plan.report?.description ?? "")) &&
        /拆分|split/iu.test(
          `${field.physical?.name ?? ""} ${field.semantic?.name ?? ""} ${field.physical?.comment ?? ""}`,
        )
      ) {
        raisePriority(table, field.physical?.name, 190);
      }
    }
    for (const condition of table.system_conditions ?? []) {
      raisePriority(table, condition.field, 95);
    }
    for (const foreignKey of table.foreign_keys ?? []) {
      for (const value of [
        foreignKey.field,
        foreignKey.column,
        foreignKey.local_field,
        ...(foreignKey.fields ?? []),
        ...(foreignKey.columns ?? []),
      ]) {
        raisePriority(table, value, 90);
      }
    }
  }
  for (const relationship of [...relationships, ...candidateRelationships]) {
    const source = selected.find(
      (table) => String(table.table_id) === String(relationship.source_table_id),
    );
    const target = selected.find(
      (table) => String(table.table_id) === String(relationship.target_table_id),
    );
    for (const field of relationship.source_columns ?? []) {
      if (source) raisePriority(source, field, 180);
    }
    for (const field of relationship.target_columns ?? []) {
      if (target) raisePriority(target, field, 180);
    }
  }
  for (const set of candidatesByIntent) {
    for (const candidate of set.candidates ?? []) {
      const identity = `${candidate.profile_id}/${candidate.database}/${candidate.table}`;
      const table = selected.find((item) => tableIdentity(item) === identity);
      if (table) raisePriority(table, candidate.field, 200 + Number(candidate.score ?? 0));
    }
  }
  for (const field of plan.fields ?? []) {
    const source = field.source ?? {};
    const table = selected.find(
      (item) =>
        item.physical?.profile_id === source.profile_id &&
        item.physical?.database === source.database &&
        item.physical?.table === source.table,
    );
    if (table) raisePriority(table, source.field, 400);
  }

  const fieldRows = selected.flatMap((table) =>
    (table.physical_fields ?? []).map((field: JsonRecord) => ({
      table,
      field,
      priority: priorities.get(`${tableIdentity(table)}.${field.physical?.name}`) ?? 0,
    })),
  );
  const chosenRows = fieldRows
    .filter((item) => item.priority > 0)
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        `${tableIdentity(left.table)}.${left.field.physical?.name}`.localeCompare(
          `${tableIdentity(right.table)}.${right.field.physical?.name}`,
        ),
    )
    .slice(0, maxFields);
  const chosenKeys = new Set(
    chosenRows.map((item) => `${tableIdentity(item.table)}.${item.field.physical?.name}`),
  );

  const compactField = (table: JsonRecord, field: JsonRecord): JsonRecord => {
    const dictionary = dictionaryFor(table, field);
    return {
      physical: {
        name: field.physical?.name,
        data_type: field.physical?.data_type,
        native_type: field.physical?.native_type,
        nullable: field.physical?.nullable,
        primary_key: field.physical?.primary_key === true,
        comment: field.physical?.comment,
      },
      semantic: {
        name: field.semantic?.name,
        description: field.semantic?.description,
        status: field.semantic?.status,
        enum_ref: field.semantic?.enum_ref,
      },
      filter: field.filter
        ? {
            enabled: field.filter.enabled,
            role: field.filter.role,
            operators: field.filter.operators,
            default_operator: field.filter.default_operator,
          }
        : null,
      ...(dictionary ? { enum_ref: dictionary.name } : {}),
    };
  };
  const buildTables = (): JsonRecord[] =>
    selected.map((table: JsonRecord) => ({
      table_id: table.table_id,
      tier: table.tier,
      physical: table.physical,
      semantic: table.semantic,
      business: table.business,
      fields: (table.physical_fields ?? [])
        .filter((field: JsonRecord) =>
          chosenKeys.has(`${tableIdentity(table)}.${field.physical?.name}`),
        )
        .map((field: JsonRecord) => compactField(table, field)),
      indexes: (table.indexes ?? []).filter((index: JsonRecord) =>
        (index.fields ?? index.columns ?? []).some((field: unknown) =>
          chosenKeys.has(`${tableIdentity(table)}.${String(field)}`),
        ),
      ),
      foreign_keys: table.foreign_keys ?? [],
      system_conditions: table.system_conditions ?? [],
      security: table.security
        ? { tenant_field: table.security.tenant_field ?? null }
        : null,
    }));

  const context: JsonRecord = {
    context_format_version: "1",
    generated_at: new Date().toISOString(),
    report: plan.report,
    requirement_intents: requirementIntents,
    candidate_sets: candidatesByIntent.map((set: JsonRecord) => ({
      ...set,
      candidates: (set.candidates ?? []).filter((candidate: JsonRecord) =>
        selectedIdentities.has(
          `${candidate.profile_id}/${candidate.database}/${candidate.table}`,
        ),
      ),
    })),
    selected_table_count: selected.length,
    selected_field_count: chosenRows.length,
    tables: buildTables(),
    relationships,
    relationship_candidates: candidateRelationships,
    enum_dictionaries: [...new Set(
      selected.flatMap((table) =>
        (table.physical_fields ?? [])
          .filter((field: JsonRecord) =>
            chosenKeys.has(`${tableIdentity(table)}.${field.physical?.name}`),
          )
          .map((field: JsonRecord) => dictionaryFor(table, field)?.name)
          .filter(Boolean)
          .map(String),
      ),
    )].map((name) => ({
      name,
      values: (dictionaries.get(name)?.values ?? []).slice(0, 50),
    })),
    omitted: {
      tables: Math.max(0, tableScores.size - selected.length),
      fields: Math.max(0, fieldRows.length - chosenRows.length),
      candidate_tables: [...tableScores.keys()].filter(
        (identity) => !selectedIdentities.has(identity),
      ),
    },
    usage: {
      instruction: "先根据 requirement_intents 和 candidate_sets 形成建模假设；仅使用本切片，缺失业务语义写入一次统一确认，不要读取整个 knowledge 目录。",
      omitted: ["扫描样本", "无关表", "历史版本", "密钥与连接配置"],
      budget: {
        max_tables: maxTables,
        max_fields: maxFields,
        max_bytes: maxBytes,
      },
    },
  };
  while (
    Buffer.byteLength(JSON.stringify(context, null, 2), "utf8") > maxBytes &&
    chosenRows.length > selected.length
  ) {
    const removable = [...chosenRows]
      .reverse()
      .find((row) => {
        const tableRows = chosenRows.filter(
          (candidate) => tableIdentity(candidate.table) === tableIdentity(row.table),
        );
        return tableRows.length > 1 && row.priority < 400;
      });
    if (!removable) break;
    const index = chosenRows.indexOf(removable);
    chosenRows.splice(index, 1);
    chosenKeys.delete(
      `${tableIdentity(removable.table)}.${removable.field.physical?.name}`,
    );
    context.tables = buildTables();
    context.selected_field_count = chosenRows.length;
    context.omitted.fields = Math.max(0, fieldRows.length - chosenRows.length);
  }
  const contextBytes = Buffer.byteLength(JSON.stringify(context, null, 2), "utf8");
  context.usage.actual_bytes = contextBytes;
  if (contextBytes > maxBytes) {
    throw new Error(
      `按需知识切片仍超过预算：${contextBytes}/${maxBytes} bytes；请减少显式 --include 表`,
    );
  }
  await writeJson(resolve(options.out), context);
  return context;
}

const REPORT_MODEL_FORMAT_VERSION = "1";
const PHASE_CONTEXT_FORMAT_VERSION = "1";

function reportModelHash(model: JsonRecord): string {
  const copy = structuredClone(model);
  delete copy.approval;
  delete copy.generated_at;
  return sha256(JSON.stringify(copy));
}

function modelSourceFields(plan: JsonRecord, table: JsonRecord): string[] {
  const names = new Set<string>();
  for (const field of plan.fields ?? []) {
    if (field.source?.alias === table.alias && field.source?.field) names.add(String(field.source.field));
    for (const dependency of field.source?.dependencies ?? []) {
      if (dependency.alias === table.alias && dependency.field) names.add(String(dependency.field));
    }
  }
  for (const joinItem of plan.source?.joins ?? []) {
    for (const pair of joinItem.on ?? []) {
      for (const ref of [pair.left, pair.right]) {
        const [alias, field] = String(ref ?? "").split(".");
        if (alias === table.alias && field) names.add(field.replaceAll(/[`\"]/g, ""));
      }
    }
  }
  for (const condition of table.system_conditions ?? []) {
    if (condition.field) names.add(String(condition.field));
  }
  return [...names].sort();
}

function initialQueryContracts(plan: JsonRecord): JsonRecord[] {
  if (plan.script_report?.queries?.length) {
    return plan.script_report.queries.map((query: JsonRecord) => ({
      id: query.id,
      purpose: plan.execution_plan?.steps?.find((step: JsonRecord) => step.query_id === query.id)?.description ?? query.id,
      mode: query.mode,
      result_grain: plan.semantic_plan?.result_grain,
      sources: (query.sources ?? []).map((source: JsonRecord) => ({
        profile_id: source.profile_id,
        database: source.database,
        table: source.table,
        alias: source.alias,
        fields: source.fields ?? [],
      })),
      distinct_keys: plan.semantic_plan?.distinct_keys ?? {},
      output: [],
      status: "draft",
    }));
  }
  return [{
    id: "main",
    purpose: plan.execution_plan?.rationale ?? "生成主查询",
    mode: "stream",
    result_grain: plan.semantic_plan?.result_grain,
    sources: (plan.source?.tables ?? []).map((table: JsonRecord) => ({
      profile_id: table.profile_id,
      database: table.database,
      table: table.table,
      alias: table.alias,
      fields: modelSourceFields(plan, table),
    })),
    distinct_keys: plan.semantic_plan?.distinct_keys ?? {},
    output: (plan.fields ?? []).map((field: JsonRecord) => ({
      name: field.id,
      label: field.label,
      type: field.output_type,
    })),
    status: "draft",
  }];
}

/** Canonical output registry: every business field has one stable id and one route. */
function deriveOutputFields(model: JsonRecord): JsonRecord[] {
  if (Array.isArray(model.output_fields) && model.output_fields.length) return model.output_fields;
  const graphIds = new Set((model.calculation_graph?.nodes ?? []).map((node: JsonRecord) => String(node.id)));
  const metricIds = new Set((model.metrics ?? []).map((metric: JsonRecord) => String(metric.id)));
  const seen = new Set<string>();
  const result: JsonRecord[] = [];
  for (const contract of model.query_contracts ?? []) {
    for (const raw of contract.output ?? contract.output_contract ?? []) {
      const column = typeof raw === "string" ? { name: raw } : raw;
      const id = String(column.name ?? column.id ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push({
        id,
        label: String(column.label ?? id),
        kind: graphIds.has(id) ? "calculation" : metricIds.has(id) ? "metric" : "data",
        route: graphIds.has(id) ? "calculation_graph" : metricIds.has(id) ? "metric" : "query",
        query_id: String(contract.id ?? ""),
        ...(graphIds.has(id) ? { calculation_node: id } : {}),
        ...(metricIds.has(id) ? { metric_id: id } : {}),
      });
    }
  }
  return result;
}

/**
 * Compile the calculation DAG into an execution-neutral contract.
 *
 * This is intentionally not SQL text: SQL is compiled later against one query
 * contract and its selected sources.  Keeping this intermediate representation
 * separate prevents an agent from silently moving a business calculation between
 * SQL and a script while it is generating code.
 */
export function compileCalculationPlan(model: JsonRecord): JsonRecord {
  const nodes = Array.isArray(model.calculation_graph?.nodes) ? model.calculation_graph.nodes as JsonRecord[] : [];
  const byId = new Map(nodes.map((node) => [String(node.id), node]));
  const ordered: JsonRecord[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = byId.get(id);
    if (!node) return;
    for (const dep of node.depends_on ?? []) visit(String(dep));
    ordered.push(node);
  };
  for (const node of nodes) visit(String(node.id));
  const stepById = new Map<string, JsonRecord>();
  const steps = ordered.map((node, index) => {
    const hint = String(node.execution_hint ?? "auto");
    const kind = String(node.kind ?? "");
    // Auto routing is deliberately conservative. Cross-query merge and period
    // comparison need materialised rows; aggregate/formula/window remain in the
    // query compiler unless the model explicitly asks for a script.
    const execution = hint !== "auto"
      ? hint
      : (kind === "merge" || kind === "comparison" || model.recommended_strategy === "script"
        ? "script"
        : "sql");
    const step = {
      order: index + 1,
      id: node.id,
      label: node.label,
      kind,
      dependencies: node.depends_on ?? [],
      execution,
      target: execution === "sql" ? "query" : "script",
      output: node.output === true,
      output_type: node.output_type,
      // Preserve only the kind-specific declarative payload needed by a lowerer.
      ...(kind === "aggregate" ? { source: node.source ?? {} } : {}),
      ...(kind === "formula" ? { expression: node.expression ?? "" } : {}),
      ...(kind === "comparison" ? { comparison: node.comparison ?? {} } : {}),
      ...(kind === "window" ? { window: node.window ?? {} } : {}),
      ...(kind === "merge" ? { merge: node.merge ?? {} } : {}),
    };
    stepById.set(String(node.id), step);
    return step;
  });
  const output_map = (deriveOutputFields(model) ?? []).map((field: JsonRecord) => {
    const route = String(field.route ?? "query");
    const nodeId = String(field.calculation_node ?? field.id ?? "");
    const step = route === "calculation_graph" ? stepById.get(nodeId) : undefined;
    return {
      output_id: field.id,
      label: field.label,
      kind: field.kind,
      route,
      ...(field.query_id ? { query_id: field.query_id } : {}),
      ...(route === "calculation_graph" ? {
        calculation_node: nodeId,
        execution: step?.execution ?? "unresolved",
        target: step?.target ?? "unresolved",
      } : { execution: "query", target: "query" }),
    };
  });
  return {
    version: "2",
    strategy: model.recommended_strategy,
    steps,
    output_map,
  };
}

/** Compatibility name retained for callers installed with an earlier bundle. */
function deriveCalculationPlan(model: JsonRecord): JsonRecord {
  return compileCalculationPlan(model);
}

function calculationPlanErrors(model: JsonRecord): string[] {
  const plan = compileCalculationPlan(model);
  const steps = new Map((plan.steps ?? []).map((step: JsonRecord) => [String(step.id), step]));
  const errors: string[] = [];
  for (const output of plan.output_map ?? []) {
    if (String(output.route) !== "calculation_graph") continue;
    if (!steps.has(String(output.calculation_node))) {
      errors.push(`输出字段 ${output.output_id} 没有可编译的计算节点：${output.calculation_node}`);
    }
    if (String(output.execution) === "unresolved") {
      errors.push(`输出字段 ${output.output_id} 的计算执行目标无法确定`);
    }
  }
  return errors;
}

export async function initializeReportModel(options: { plan: string; out: string }): Promise<JsonRecord> {
  const plan = await readJson(resolve(options.plan));
  const model: JsonRecord = {
    model_format_version: REPORT_MODEL_FORMAT_VERSION,
    generated_at: new Date().toISOString(),
    report: plan.report,
    input_lock: {
      lock_format_version: "1",
      knowledge: {
        catalog_version: plan.knowledge?.catalog_version,
        snapshot_hash: plan.knowledge?.snapshot_hash,
      },
      report_requirement: {
        id: plan.report?.id,
        name: plan.report?.name,
        fields: (plan.fields ?? []).map((field: JsonRecord) => ({ id: field.id, label: field.label, roles: field.roles ?? [] })),
        blockers: (plan.blockers ?? []).map((blocker: JsonRecord) => ({ id: blocker.field_id, code: blocker.code, label: blocker.label })),
      },
    },
    result_grain: {
      description: plan.semantic_plan?.result_grain ?? "待确认",
      keys: (plan.semantic_plan?.dimensions ?? []).map((item: JsonRecord) => item.id),
    },
    sources: (plan.source?.tables ?? []).map((table: JsonRecord) => ({
      id: table.alias,
      profile_id: table.profile_id,
      database: table.database,
      table: table.table,
      alias: table.alias,
      purpose: "待在确定建模阶段补充",
      fields: modelSourceFields(plan, table).map((name) => ({ name, role: "source" })),
    })),
    relationships: (plan.source?.joins ?? []).map((joinItem: JsonRecord) => ({
      from: joinItem.on?.[0]?.left ?? null,
      to: joinItem.on?.[0]?.right ?? null,
      type: joinItem.type,
      cardinality: joinItem.cardinality ?? "unknown",
      grain: joinItem.grain ?? null,
      fanout_risk: joinItem.cardinality === "1:n" || joinItem.cardinality === "n:n",
    })),
    metrics: (plan.semantic_plan?.metrics ?? []).map((metric: JsonRecord) => ({
      ...metric,
      distinct_key: plan.semantic_plan?.distinct_keys?.[metric.id] ?? null,
    })),
    filters: plan.parameters ?? [],
    time_semantics: plan.semantic_plan?.time_semantics ?? [],
    exclusions: plan.semantic_plan?.exclusions ?? [],
    recommended_strategy: plan.execution_plan?.strategy ?? "sql",
    query_contracts: initialQueryContracts(plan),
    output_fields: (plan.fields ?? []).map((field: JsonRecord) => ({
      id: field.id, label: field.label, kind: "data", route: "query", query_id: "main",
    })),
    open_questions: (() => {
      const seen = new Map<string, JsonRecord>();
      const add = (item: JsonRecord) => { seen.set(String(item.id ?? ''), item); };
      for (const item of (plan.semantic_plan?.open_questions ?? [])) add(item);
      for (const blocker of (plan.blockers ?? [])) {
        add({
          id: String(blocker.field_id ?? `q_${String(blocker.code ?? 'unknown')}`),
          question: String(blocker.message ?? ''),
          options: Array.isArray(blocker.suggestions)
            ? (blocker.suggestions as string[]).map((s: string) => ({ value: s, label: s }))
            : [],
          recommended: null,
          required: true,
          affected_metrics: blocker.label ? [String(blocker.label)] : [],
          impact: String(
            blocker.code === 'METRIC_REQUIRES_MODELING'
              ? '需要确定来源表、聚合方式、去重键和条件口径'
              : blocker.code === 'FIELD_NOT_FOUND'
                ? '该字段需确定为 computed/sql_expression 或通过 comparison 机制实现'
                : '待确认',
          ),
        });
      }
      return [...seen.values()];
    })(),
    approval: { status: "draft" },
  };
  model.calculation_plan = deriveCalculationPlan(model);
  await writeJson(resolve(options.out), model);
  return model;
}

function normalizeDiscoverySourceFields(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map((field: JsonRecord | string) => {
    if (typeof field === "string") return { name: field, role: "source" };
    return {
      name: String(
        field.name ??
        field.field ??
        field.physical_name ??
        field.physical?.name ??
        "",
      ),
      role: String(field.role ?? "source"),
    };
  }).filter((field: JsonRecord) => String(field.name).trim());
}

function discoveryModelSources(model: JsonRecord): JsonRecord[] {
  const normalizeSource = (value: JsonRecord, index: number): JsonRecord => {
    const parts = String(value.table_id ?? "").split("/").filter(Boolean);
    const [parsedProfileId = "", parsedDatabase = "", ...tableParts] = parts;
    const profileId = String(value.profile_id ?? parsedProfileId);
    const database = String(value.database ?? parsedDatabase);
    const table = String(value.table ?? tableParts.join("/"));
    const alias = String(value.alias ?? table ?? `source_${index + 1}`);
    return {
      id: String(value.id ?? alias),
      profile_id: profileId,
      database,
      table,
      alias,
      purpose: String(value.purpose ?? value.entity ?? value.role ?? ""),
      fields: normalizeDiscoverySourceFields(value.selected_fields ?? value.fields),
    };
  };
  const selected = !Array.isArray(model.selected_tables)
    ? []
    : model.selected_tables.map(normalizeSource);
  if (!Array.isArray(model.sources) || !model.sources.length) return selected;
  const selectedByTable = new Map(
    selected.map((source: JsonRecord) => [
      `${source.profile_id}/${source.database}/${source.table}`,
      source,
    ]),
  );
  const merged = model.sources.map((source: JsonRecord, index: number) => {
    const normalized = normalizeSource(source, index);
    const key = `${normalized.profile_id}/${normalized.database}/${normalized.table}`;
    const fallback = selectedByTable.get(key);
    selectedByTable.delete(key);
    return {
      ...fallback,
      ...normalized,
      fields: normalized.fields.length ? normalized.fields : fallback?.fields ?? [],
    };
  });
  return [...merged, ...selectedByTable.values()];
}

function normalizeFinalReportModelValue(model: JsonRecord): JsonRecord {
  const sources = Array.isArray(model.sources) ? model.sources : [];
  const sourceById = new Map<string, JsonRecord>();
  for (const source of sources) {
    for (const key of [source.id, source.alias]) {
      if (key) sourceById.set(String(key), source);
    }
  }
  const queryContracts = (model.query_contracts ?? []).map((query: JsonRecord) => {
    const normalizedSources = (query.sources ?? []).map((value: JsonRecord | string) => {
      if (typeof value === "string") {
        const source = sourceById.get(value);
        if (!source) return { id: value };
        return {
          id: source.id,
          profile_id: source.profile_id,
          database: source.database,
          table: source.table,
          alias: source.alias,
          fields: (source.fields ?? []).map((field: JsonRecord | string) =>
            String(typeof field === "string" ? field : field.name),
          ),
        };
      }
      const source = sourceById.get(String(value.id ?? value.alias ?? ""));
      return source && (!value.profile_id || !value.database || !value.table)
        ? {
            id: source.id,
            profile_id: source.profile_id,
            database: source.database,
            table: source.table,
            alias: source.alias,
            fields: (value.fields ?? source.fields ?? []).map((field: JsonRecord | string) =>
              String(typeof field === "string" ? field : field.name),
            ),
          }
        : value;
    });
    const output = (query.output ?? query.output_contract ?? []).map(
      (column: JsonRecord | string) =>
        typeof column === "string"
          ? { name: column }
          : {
              ...column,
              name: String(column.name ?? column.id ?? column.column ?? ""),
            },
    );
    return {
      ...query,
      sources: normalizedSources,
      output,
    };
  });
  const relationships = (model.relationships ?? []).map((relationship: JsonRecord) => {
    // Normalize relationship endpoints. Accepts:
    //   1. string "t0.field"
    //   2. object {alias, field} or {source, field}
    //   3. split-key format {from_source, from_field, to_source, to_field} (no from/to keys)
    const normalizeEndpoint = (raw: unknown): string => {
      if (typeof raw === "string" && raw.trim()) return raw.trim();
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const obj = raw as Record<string, unknown>;
        const alias = String(obj.alias ?? obj.source ?? obj.sourceId ?? obj.source_id ?? "");
        const field = String(obj.field ?? obj.fieldName ?? obj.field_name ?? "");
        if (alias && field) return `${alias}.${field}`;
      }
      return String(raw ?? "");
    };
    // Resolve from/to from the relationship, falling back to split-key fields.
    const resolveFrom = (): string => {
      const v = normalizeEndpoint(relationship.from);
      if (v && v !== "[object Object]") return v;
      const src = String(relationship.from_alias ?? relationship.from_source ?? "");
      const field = String(relationship.from_field ?? "");
      return src && field ? `${src}.${field}` : "";
    };
    const resolveTo = (): string => {
      const v = normalizeEndpoint(relationship.to);
      if (v && v !== "[object Object]") return v;
      const src = String(relationship.to_alias ?? relationship.to_source ?? "");
      const field = String(relationship.to_field ?? "");
      return src && field ? `${src}.${field}` : "";
    };
    const match = String(relationship.on ?? "").match(
      /^\s*([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\s*$/,
    );
    const nFrom = resolveFrom() || normalizeEndpoint(match?.[1] ?? "");
    const nTo = resolveTo() || normalizeEndpoint(match?.[2] ?? "");
    return {
      ...relationship,
      from: nFrom,
      to: nTo,
      fanout_risk:
        relationship.fanout_risk ??
        ["1:n", "n:n"].includes(String(relationship.cardinality ?? "").toLowerCase()),
    };
  });
  const queryIds = new Set(queryContracts.map((query: JsonRecord) => String(query.id ?? "")));
  const normalized = {
    ...model,
    sources,
    relationships,
    query_contracts: queryContracts,
    output_fields: Array.isArray(model.output_fields)
      ? model.output_fields.filter((field: JsonRecord) => !field.query_id || queryIds.has(String(field.query_id)))
      : model.output_fields,
  };
  return { ...normalized, output_fields: deriveOutputFields(normalized), calculation_plan: deriveCalculationPlan(normalized) };
}

export function validateDiscoveryReportModelValue(model: JsonRecord): string[] {
  const errors: string[] = [];
  if (String(model.model_format_version) !== REPORT_MODEL_FORMAT_VERSION) {
    errors.push("model_format_version 必须为 1");
  }
  if (!model.report?.id || !model.report?.name) errors.push("基础模型缺少报表 id/name");
  if (!String(model.result_grain?.description ?? "").trim()) {
    errors.push("基础模型必须描述结果粒度假设");
  }
  const strategy = String(model.recommended_strategy ?? "");
  if (!["sql", "enrichment", "group_queries", "script"].includes(strategy)) {
    errors.push("基础模型 recommended_strategy 必须是 sql|enrichment|group_queries|script");
  }
  const sources = discoveryModelSources(model);
  if (!sources.length) errors.push("基础模型至少需要一个候选来源表");
  const sourceIds = new Set<string>();
  for (const source of sources) {
    const id = String(source.id ?? "");
    if (!id || sourceIds.has(id)) errors.push("基础模型候选来源 id 缺失或重复");
    sourceIds.add(id);
    if (!source.profile_id || !source.database || !source.table) {
      errors.push(`基础模型来源 ${id || "?"} 缺少物理定位`);
    }
    const fields = (source.fields ?? []).filter((field: JsonRecord | string) =>
      String(typeof field === "string" ? field : field.name ?? "").trim(),
    );
    if (!fields.length) errors.push(`基础模型来源 ${id || "?"} 没有候选字段`);
  }
  const hypotheses = model.metric_hypotheses ?? model.metrics ?? [];
  if (!Array.isArray(hypotheses) || !hypotheses.length) {
    errors.push("基础模型至少需要一个指标假设");
  }
  const questionIds = new Set<string>();
  for (const question of normalizeConfirmationQuestions(model)) {
    const id = String(question.id ?? "");
    if (!id || questionIds.has(id)) errors.push("统一确认项 id 缺失或重复");
    questionIds.add(id);
    if (!String(question.question ?? "").trim()) errors.push(`统一确认项 ${id || "?"} 缺少问题文本`);
  }
  return errors;
}

function validateCalculationGraphValue(
  model: JsonRecord,
  sourceFields: Map<string, Set<string>>,
): string[] {
  const graph = model.calculation_graph;
  if (graph == null) return [];
  const errors: string[] = [];
  if (typeof graph !== "object" || Array.isArray(graph)) return ["calculation_graph 必须是对象"];
  if (String(graph.version ?? "") !== "1") errors.push("calculation_graph.version 必须为 1");
  if (!Array.isArray(graph.nodes)) return [...errors, "calculation_graph.nodes 必须是数组"];
  const nodes = graph.nodes as JsonRecord[];
  const nodeIds = new Set<string>();
  const metricIds = new Set<string>((model.metrics ?? []).map((metric: JsonRecord) => String(metric.id ?? "")));
  const queryOutputs = new Set<string>(
    (model.query_contracts ?? []).flatMap((query: JsonRecord) =>
      (query.output ?? query.output_contract ?? []).map((column: JsonRecord | string) =>
        String(typeof column === "string" ? column : column.name ?? ""),
      ),
    ),
  );
  for (const node of nodes) {
    const id = String(node.id ?? "");
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id) || nodeIds.has(id)) {
      errors.push(`计算节点 id 缺失、非法或重复：${id || "?"}`);
    }
    nodeIds.add(id);
  }
  const knownDependencies = new Set([...nodeIds, ...metricIds, ...queryOutputs]);
  const edges = new Map<string, string[]>();
  const parseField = (value: unknown): { alias: string; field: string } => {
    const text = String(value ?? "");
    const dot = text.indexOf(".");
    return dot > 0
      ? { alias: text.slice(0, dot), field: text.slice(dot + 1).replace(/\s+(asc|desc)$/i, "") }
      : { alias: "", field: "" };
  };
  for (const node of nodes) {
    const id = String(node.id ?? "");
    const kind = String(node.kind ?? "");
    const dependencies = Array.isArray(node.depends_on) ? node.depends_on.map(String) : [];
    edges.set(id, dependencies.filter((dependency) => nodeIds.has(dependency)));
    if (!String(node.label ?? "").trim()) errors.push(`计算节点 ${id || "?"} 缺少名称`);
    if (!MODEL_CALCULATION_KINDS.has(kind)) errors.push(`计算节点 ${id || "?"} 类型不支持：${kind}`);
    if (!String(node.output_type ?? "").trim()) errors.push(`计算节点 ${id || "?"} 缺少输出类型`);
    const executionHint = String(node.execution_hint ?? "auto");
    if (!MODEL_CALCULATION_EXECUTION_HINTS.has(executionHint)) {
      errors.push(`计算节点 ${id || "?"} 的执行偏好不支持：${executionHint}`);
    }
    if (new Set(dependencies).size !== dependencies.length) errors.push(`计算节点 ${id || "?"} 存在重复依赖`);
    for (const dependency of dependencies) {
      if (!knownDependencies.has(dependency)) errors.push(`计算节点 ${id || "?"} 引用了未知依赖：${dependency}`);
    }
    if (kind === "aggregate") {
      const source = String(node.source?.field ?? "");
      const endpoint = parseField(source);
      if (!endpoint.alias || !endpoint.field || !sourceFields.get(endpoint.alias)?.has(endpoint.field)) {
        errors.push(`聚合节点 ${id || "?"} 的来源字段不在模型白名单中：${source || "?"}`);
      }
      if (!MODEL_CALCULATION_AGGREGATIONS.has(String(node.source?.aggregation ?? ""))) {
        errors.push(`聚合节点 ${id || "?"} 的聚合方式不支持：${node.source?.aggregation ?? ""}`);
      }
    } else if (kind === "formula") {
      if (!dependencies.length) errors.push(`公式节点 ${id || "?"} 至少需要一个依赖`);
      const expression = String(node.expression ?? "").trim();
      if (!expression) {
        errors.push(`公式节点 ${id || "?"} 缺少表达式`);
      } else {
        const references = new Set(
          [...expression.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!),
        );
        for (const reference of references) {
          if (!dependencies.includes(reference)) errors.push(`公式节点 ${id || "?"} 的表达式引用未声明依赖：${reference}`);
        }
        for (const dependency of dependencies) {
          if (!references.has(dependency)) errors.push(`公式节点 ${id || "?"} 声明了未使用依赖：${dependency}`);
        }
      }
    } else if (kind === "comparison") {
      if (dependencies.length !== 1) errors.push(`对比节点 ${id || "?"} 必须且只能依赖一个指标`);
      if (!MODEL_CALCULATION_COMPARISONS.has(String(node.comparison?.mode ?? ""))) {
        errors.push(`对比节点 ${id || "?"} 的对比方式不支持：${node.comparison?.mode ?? ""}`);
      }
      if (!Number.isInteger(Number(node.comparison?.offset)) || Number(node.comparison?.offset) < 1) {
        errors.push(`对比节点 ${id || "?"} 的偏移期数必须是正整数`);
      }
    } else if (kind === "window") {
      if (dependencies.length !== 1) errors.push(`窗口节点 ${id || "?"} 必须且只能依赖一个指标`);
      if (!MODEL_CALCULATION_WINDOWS.has(String(node.window?.function ?? ""))) {
        errors.push(`窗口节点 ${id || "?"} 的窗口函数不支持：${node.window?.function ?? ""}`);
      }
      for (const field of [...(node.window?.partition_by ?? []), ...(node.window?.order_by ?? [])].map(String)) {
        const endpoint = parseField(field);
        if (!endpoint.alias || !endpoint.field || !sourceFields.get(endpoint.alias)?.has(endpoint.field)) {
          errors.push(`窗口节点 ${id || "?"} 使用了模型外字段：${field}`);
        }
      }
    } else if (kind === "merge") {
      if (dependencies.length < 2) errors.push(`合并节点 ${id || "?"} 至少需要两个依赖`);
      if (!MODEL_CALCULATION_MERGES.has(String(node.merge?.operation ?? ""))) {
        errors.push(`合并节点 ${id || "?"} 的运算方式不支持：${node.merge?.operation ?? ""}`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    if (visiting.has(id)) {
      errors.push(`计算节点存在循环依赖：${[...path, id].join(" -> ")}`);
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

function validateOutputFieldsValue(model: JsonRecord): string[] {
  if (model.output_fields == null) return [];
  if (!Array.isArray(model.output_fields)) return ["output_fields 必须是数组"];
  const errors: string[] = [];
  const seen = new Set<string>();
  const graphIds = new Set((model.calculation_graph?.nodes ?? []).map((node: JsonRecord) => String(node.id)));
  const metricIds = new Set((model.metrics ?? []).map((metric: JsonRecord) => String(metric.id)));
  const queryIds = new Set((model.query_contracts ?? []).map((query: JsonRecord) => String(query.id)));
  for (const field of model.output_fields) {
    const id = String(field?.id ?? "").trim();
    const label = String(field?.label ?? "").trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id) || seen.has(id)) errors.push(`输出字段 id 缺失、非法或重复：${id || "?"}`);
    seen.add(id);
    if (!label) errors.push(`输出字段 ${id || "?"} 缺少名称`);
    if (!["data", "metric", "calculation"].includes(String(field?.kind ?? ""))) errors.push(`输出字段 ${id || "?"} 类型不支持`);
    if (!["query", "metric", "calculation_graph"].includes(String(field?.route ?? ""))) errors.push(`输出字段 ${id || "?"} 缺少生成路径`);
    if (field?.query_id && !queryIds.has(String(field.query_id))) errors.push(`输出字段 ${id || "?"} 引用了未知查询契约：${field.query_id}`);
    if (field?.calculation_node && !graphIds.has(String(field.calculation_node))) errors.push(`输出字段 ${id || "?"} 引用了未知计算节点：${field.calculation_node}`);
    if (field?.metric_id && !metricIds.has(String(field.metric_id))) errors.push(`输出字段 ${id || "?"} 引用了未知指标：${field.metric_id}`);
    if (field?.route === "calculation_graph" && !field?.calculation_node) errors.push(`输出字段 ${id || "?"} 缺少 calculation_node`);
  }
  return errors;
}

export function validateReportModelValue(model: JsonRecord, requireApproved = false): string[] {
  const errors: string[] = [];
  const strategy = String(model.recommended_strategy ?? "");
  if (!["sql", "enrichment", "group_queries", "script"].includes(strategy)) {
    errors.push("recommended_strategy 必须是 sql|enrichment|group_queries|script");
  }
  if (String(model.model_format_version) !== REPORT_MODEL_FORMAT_VERSION) errors.push("model_format_version 必须为 1");
  if (!model.report?.id || !model.report?.name) errors.push("模型缺少报表 id/name");
  const grainDescription = String(model.result_grain?.description ?? "").trim();
  const grainKeys = model.result_grain?.keys;
  const keylessSingleRow =
    Array.isArray(grainKeys) &&
    grainKeys.length === 0 &&
    /单行|单条|汇总为一行|single[\s_-]?row/i.test(grainDescription);
  if (!grainDescription || !Array.isArray(grainKeys) || (!grainKeys.length && !keylessSingleRow)) {
    errors.push("模型必须明确结果粒度和稳定键；单行汇总可使用空 keys");
  }
  const sourceIds = new Set<string>();
  for (const source of model.sources ?? []) {
    if (!source.id || sourceIds.has(String(source.id))) errors.push("模型来源 id 缺失或重复");
    sourceIds.add(String(source.id));
    if (!source.profile_id || !source.database || !source.table || !source.alias) errors.push(`来源 ${source.id ?? "?"} 缺少物理定位`);
    if (!(source.fields ?? []).length) errors.push(`来源 ${source.id ?? "?"} 没有字段白名单`);
  }
  // Validate relationship endpoints: resolve object or string format and check against source fields.
  const sourceFields = new Map<string, Set<string>>(
    (model.sources ?? []).map((source: JsonRecord) => [
      String(source.id ?? source.alias ?? ""),
      new Set((source.fields ?? []).map((field: JsonRecord | string) => String(typeof field === "string" ? field : field.name))),
    ]),
  );
  for (const source of model.sources ?? []) {
    if (source.alias) {
      sourceFields.set(
        String(source.alias),
        new Set((source.fields ?? []).map((field: JsonRecord | string) =>
          String(typeof field === "string" ? field : field.name),
        )),
      );
    }
  }
  const relationKeys = new Set<string>();
  for (const relationship of model.relationships ?? []) {
    const relationshipType = normalizeRelationType(String(relationship.type ?? ""));
    if (!MODEL_RELATION_TYPES.has(relationshipType)) {
      errors.push(`不支持的关联类型：${relationship.type ?? ""}（仅支持 left/inner）`);
    }
    const cardinality = String(relationship.cardinality ?? "").trim().toLowerCase();
    if (!MODEL_CARDINALITIES.has(cardinality)) {
      errors.push(`不支持的关系基数：${relationship.cardinality ?? ""}`);
    }
    const resolveEp = (raw: unknown): { id: string; field: string; display: string } => {
      if (typeof raw === "string" && raw.trim()) {
        const dot = raw.indexOf(".");
        return { id: dot > 0 ? raw.slice(0, dot) : "", field: dot > 0 ? raw.slice(dot + 1) : "", display: raw };
      }
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const obj = raw as Record<string, unknown>;
        const alias = String(obj.alias ?? obj.source ?? obj.sourceId ?? obj.source_id ?? "");
        const field = String(obj.field ?? obj.fieldName ?? obj.field_name ?? "");
        return { id: alias, field, display: `${alias || "?"}.${field || "?"}（对象：${JSON.stringify(raw)}）` };
      }
      return { id: "", field: "", display: JSON.stringify(raw ?? "(空)") };
    };
    // Also accept split-key format: {from_source, from_field, to_source, to_field}
    const resolveFromRaw = (): unknown => {
      if (relationship.from != null) return relationship.from;
      const src = relationship.from_alias ?? relationship.from_source;
      const fld = relationship.from_field;
      if (src != null || fld != null) return { alias: src, field: fld };
      return undefined;
    };
    const resolveToRaw = (): unknown => {
      if (relationship.to != null) return relationship.to;
      const src = relationship.to_alias ?? relationship.to_source;
      const fld = relationship.to_field;
      if (src != null || fld != null) return { alias: src, field: fld };
      return undefined;
    };
    const epFrom = resolveEp(resolveFromRaw());
    const epTo = resolveEp(resolveToRaw());
    if (!epFrom.id || !epFrom.field || !sourceFields.get(epFrom.id)?.has(epFrom.field)) {
      errors.push(`关联端点不在字段白名单中：${epFrom.display}`);
    }
    if (!epTo.id || !epTo.field || !sourceFields.get(epTo.id)?.has(epTo.field)) {
      errors.push(`关联端点不在字段白名单中：${epTo.display}`);
    }
    const key = `${epFrom.id}.${epFrom.field}->${epTo.id}.${epTo.field}`;
    if (relationKeys.has(key)) errors.push(`重复关联：${key}`);
    relationKeys.add(key);
  }
  const approvedSources = new Map<string, Set<string>>(
    (model.sources ?? []).map((source: JsonRecord) => [
      `${source.profile_id}/${source.database}/${source.table}`,
      new Set((source.fields ?? []).map((field: JsonRecord | string) => String(typeof field === "string" ? field : field.name))),
    ]),
  );
  const queryIds = new Set<string>();
  for (const query of model.query_contracts ?? []) {
    if (!query.id || queryIds.has(String(query.id))) errors.push("查询契约 id 缺失或重复");
    queryIds.add(String(query.id));
    if (!(query.sources ?? []).length) errors.push(`查询契约 ${query.id ?? "?"} 没有来源`);
    if (!query.result_grain) errors.push(`查询契约 ${query.id ?? "?"} 缺少结果粒度`);
    const outputNames = new Set<string>();
    for (const column of query.output ?? []) {
      const name = String(typeof column === "string" ? column : column.name ?? "").trim();
      if (!name || outputNames.has(name)) errors.push(`查询契约 ${query.id ?? "?"} 的输出列缺失或重复`);
      outputNames.add(name);
    }
    if (!outputNames.size) errors.push(`查询契约 ${query.id ?? "?"} 没有输出契约`);
    for (const source of query.sources ?? []) {
      const sourceKey = `${source.profile_id}/${source.database}/${source.table}`;
      const allowedFields = approvedSources.get(sourceKey);
      if (!allowedFields) {
        errors.push(`查询契约 ${query.id ?? "?"} 使用了模型外来源 ${source.database}.${source.table}`);
        continue;
      }
      for (const field of source.fields ?? []) {
        if (!allowedFields.has(String(field))) {
          errors.push(`查询契约 ${query.id ?? "?"} 使用了模型外字段 ${source.database}.${source.table}.${field}`);
        }
      }
    }
  }
  if (!(model.query_contracts ?? []).length) errors.push("模型至少需要一个查询契约");
  errors.push(...validateCalculationGraphValue(model, sourceFields));
  errors.push(...validateOutputFieldsValue(model));
  if (requireApproved) {
    if ((model.open_questions ?? []).length) errors.push("仍有待确认问题，不能批准模型");
    if (model.approval?.status !== "approved") errors.push("模型尚未批准");
    if (model.approval?.model_hash !== reportModelHash(model)) errors.push("模型批准 hash 与当前内容不一致");
  }
  return errors;
}

export async function approveReportModel(
  modelPath: string,
  reviewedBy: string,
  planPathValue?: string,
): Promise<JsonRecord> {
  const path = resolve(modelPath);
  const model = await readJson(path);
  const preErrors = validateReportModelValue(model, false);
  if (preErrors.length) throw new Error(preErrors.join("；"));
  if ((model.open_questions ?? []).length) throw new Error("仍有待确认问题，不能批准模型");
  model.approval = {
    status: "approved",
    reviewed_by: reviewedBy,
    approved_at: new Date().toISOString(),
    model_hash: reportModelHash(model),
  };
  await writeJson(path, model);
  if (planPathValue) {
    const planPath = resolve(planPathValue);
    const plan = await readJson(planPath);
    plan.report_model = {
      model_format_version: REPORT_MODEL_FORMAT_VERSION,
      status: "approved",
      model_hash: model.approval.model_hash,
      ref: relative(dirname(planPath), path).replaceAll("\\", "/"),
    };
    await writeJson(planPath, plan);
  }
  return model;
}

async function validateAttachedReportModel(plan: JsonRecord, planPath: string): Promise<string[]> {
  if (!plan.report_model) return [];
  const modelPath = resolve(dirname(planPath), String(plan.report_model.ref ?? ""));
  let model: JsonRecord;
  try {
    model = await readJson(modelPath);
  } catch (error) {
    return [`无法读取已批准报表模型：${error instanceof Error ? error.message : String(error)}`];
  }
  const errors = validateReportModelValue(model, true);
  if (model.approval?.model_hash !== plan.report_model.model_hash) errors.push("计划引用的模型 hash 已变化");
  if (plan.script_report?.queries?.length) {
    const contracts = new Map((model.query_contracts ?? []).map((query: JsonRecord) => [String(query.id), query]));
    for (const query of plan.script_report.queries) {
      const contract = contracts.get(String(query.id)) as JsonRecord | undefined;
      if (!contract) { errors.push(`脚本查询 ${query.id} 不在已批准模型中`); continue; }
      const allowed = new Map<string, Set<string>>(
        (contract.sources ?? []).map((source: JsonRecord) => [
          `${source.profile_id}/${source.database}/${source.table}`,
          new Set((source.fields ?? []).map((field: unknown) => String(field))),
        ]),
      );
      for (const source of query.sources ?? []) {
        const sourceKey = `${source.profile_id}/${source.database}/${source.table}`;
        const allowedFields = allowed.get(sourceKey);
        if (!allowedFields) {
          errors.push(`脚本查询 ${query.id} 使用了模型外来源 ${source.database}.${source.table}`);
          continue;
        }
        for (const field of source.fields ?? []) {
          if (!allowedFields.has(String(field))) {
            errors.push(`脚本查询 ${query.id} 使用了模型外字段 ${source.database}.${source.table}.${field}`);
          }
        }
      }
    }
  }
  return errors;
}

function compactModelTable(table: JsonRecord, allowedFields: Set<string>): JsonRecord {
  const sourceFields = table.physical_fields ?? table.fields ?? [];
  return {
    table_id: table.table_id,
    physical: table.physical,
    semantic: table.semantic,
    fields: sourceFields
      .filter((field: JsonRecord) => allowedFields.has(String(field.physical?.name)))
      .map((field: JsonRecord) => ({ physical: field.physical, semantic: field.semantic, filter: field.filter })),
    indexes: (table.indexes ?? []).filter((index: JsonRecord) =>
      (index.fields ?? index.columns ?? []).some((name: unknown) => allowedFields.has(String(name))),
    ),
    foreign_keys: table.foreign_keys ?? [],
    system_conditions: table.system_conditions ?? [],
    security: table.security ?? null,
  };
}

function compactDiscoveryPlan(plan: JsonRecord): JsonRecord {
  return {
    plan_format_version: plan.plan_format_version,
    report: plan.report,
    sql_dialect: plan.sql_dialect,
    knowledge: {
      catalog_version: plan.knowledge?.catalog_version,
      catalog_status: plan.knowledge?.catalog_status,
      snapshot_hash: plan.knowledge?.snapshot_hash,
    },
    semantic_plan: {
      result_grain: plan.semantic_plan?.result_grain,
      dimensions: plan.semantic_plan?.dimensions ?? [],
      metrics: plan.semantic_plan?.metrics ?? [],
      distinct_keys: plan.semantic_plan?.distinct_keys ?? {},
      time_semantics: plan.semantic_plan?.time_semantics ?? [],
      exclusions: plan.semantic_plan?.exclusions ?? [],
    },
    source: plan.source,
    fields: (plan.fields ?? []).map((field: JsonRecord) => ({
      id: field.id,
      label: field.label,
      output_type: field.output_type,
      source: field.source,
      roles: field.roles ?? [],
      description: field.description ?? "",
    })),
    parameters: plan.parameters ?? [],
    system_conditions: plan.system_conditions ?? [],
  };
}

function normalizeConfirmationQuestions(model: JsonRecord): JsonRecord[] {
  const technicalCategories = new Set(["field_availability", "execution_strategy"]);
  return (model.open_questions ?? [])
    .filter(
      (value: JsonRecord | string) =>
        typeof value === "string" ||
        !technicalCategories.has(String(value.category ?? "")),
    )
    .map((value: JsonRecord | string, index: number) => {
    if (typeof value === "string") {
      return {
        id: `question_${stableId(value).replaceAll("-", "_")}`,
        question: value,
        options: [],
        recommended: null,
        required: true,
        affected_metrics: [],
        source: "legacy",
      };
    }
    const question = String(value.question ?? value.message ?? value.label ?? `确认问题 ${index + 1}`);
    const options = (value.options ?? value.candidates ?? []).map((option: JsonRecord | string) =>
      typeof option === "string"
        ? { value: option, label: option }
        : {
            value: String(option.value ?? option.id ?? option.label ?? ""),
            label: String(option.label ?? option.value ?? option.id ?? ""),
            ...(option.description ? { description: String(option.description) } : {}),
          },
    ).filter((option: JsonRecord) => String(option.value).length > 0);
    let recommended =
      value.recommended && typeof value.recommended === "object"
        ? String(value.recommended.value ?? value.recommended.id ?? value.recommended.label ?? "")
        : value.recommended == null
          ? null
          : String(value.recommended);
    if (recommended) {
      const decisionStem = (text: string) =>
        text.trim().split(/[（(：:—–-]/, 1)[0]?.trim().toLocaleLowerCase() ?? "";
      const recommendedStem = decisionStem(recommended);
      const matched = options.find((option: JsonRecord) => {
        const optionValue = String(option.value);
        if (optionValue === recommended) return true;
        const optionStem = decisionStem(optionValue);
        return optionStem.length >= 3 && optionStem === recommendedStem;
      });
      if (matched) {
        recommended = String(matched.value);
      } else {
        options.push({
          value: recommended,
          label: `推荐：${recommended}`,
          description: "Discovery Agent 给出的推荐处理方式",
        });
      }
    }
    return {
      id: String(value.id ?? `question_${stableId(question).replaceAll("-", "_")}`),
      question,
      options,
      recommended: recommended || null,
      required: value.required !== false,
      affected_metrics: (value.affected_metrics ?? value.affectedMetrics ?? []).map(String),
      category: String(value.category ?? "business_semantics"),
      impact: value.impact == null ? null : String(value.impact),
      source: "structured",
    };
    });
}

export async function createModelConfirmation(options: {
  model: string;
  input: string;
  out: string;
  reviewedBy: string;
}): Promise<JsonRecord> {
  const modelPath = resolve(options.model);
  const raw = await readFile(modelPath, "utf8");
  const model = JSON.parse(raw) as JsonRecord;
  const input = await readJson(resolve(options.input));
  const revision = sha256(raw);
  if (
    input.discovery_revision &&
    String(input.discovery_revision) !== revision
  ) {
    throw new Error("基础模型已变化，请刷新统一确认内容后重试");
  }
  const questions = normalizeConfirmationQuestions(model);
  const suppliedAnswers = new Map<string, unknown>();
  if (Array.isArray(input.answers)) {
    for (const answer of input.answers) {
      if (answer?.question_id) suppliedAnswers.set(String(answer.question_id), answer.value);
    }
  } else if (input.answers && typeof input.answers === "object") {
    for (const [id, value] of Object.entries(input.answers)) suppliedAnswers.set(id, value);
  }
  const note = String(input.note ?? "").trim();
  const acceptRecommended = input.accept_recommended !== false;
  const answers = questions.map((question) => {
    let value = suppliedAnswers.get(String(question.id));
    let source = "user";
    if ((value == null || String(value).trim() === "") && acceptRecommended && question.recommended) {
      value = question.recommended;
      source = "recommended";
    }
    if ((value == null || String(value).trim() === "") && note) {
      value = note;
      source = "user_note";
    }
    if ((value == null || String(value).trim() === "") && question.required !== false) {
      throw new Error(`确认项尚未回答：${question.question}`);
    }
    const allowed = new Set((question.options ?? []).map((option: JsonRecord) => String(option.value)));
    if (allowed.size && value != null && !allowed.has(String(value))) {
      throw new Error(`确认项「${question.question}」的答案不在候选范围内`);
    }
    return {
      question_id: question.id,
      value: value == null ? null : String(value),
      source,
    };
  });
  const confirmation: JsonRecord = {
    confirmation_format_version: "1",
    report_id: model.report?.id,
    discovery_revision: revision,
    discovery_model_hash: reportModelHash(model),
    status: "confirmed",
    accept_recommended: acceptRecommended,
    answers,
    note,
    reviewed_by: options.reviewedBy,
    reviewed_at: new Date().toISOString(),
  };
  confirmation.confirmation_hash = sha256(JSON.stringify(confirmation));
  await writeJson(resolve(options.out), confirmation);
  return confirmation;
}

export async function buildPhaseContext(options: {
  phase: "discovery" | "modeling" | "query" | "script" | "repair";
  plan: string;
  out: string;
  model?: string;
  confirmation?: string;
  queryId?: string;
  failure?: string;
  queryOutputs?: string;
}): Promise<JsonRecord> {
  const allowedPhases = new Set(["discovery", "modeling", "query", "script", "repair"]);
  if (!allowedPhases.has(options.phase)) throw new Error(`未知阶段：${String(options.phase)}`);
  const plan = await readJson(resolve(options.plan));
  const model = options.model ? await readJson(resolve(options.model)) : null;
  if (model && options.phase !== "discovery") {
    const errors = options.phase === "modeling"
      ? validateDiscoveryReportModelValue(model)
      : validateReportModelValue(model, ["query", "script"].includes(options.phase));
    if (errors.length) throw new Error(errors.join("；"));
  }
  const manifest: JsonRecord = {
    context_format_version: PHASE_CONTEXT_FORMAT_VERSION,
    phase: options.phase,
    fresh_session: options.phase !== "repair",
    generated_at: new Date().toISOString(),
    limits: {
      max_tables: options.phase === "query" ? 3 : options.phase === "discovery" ? 6 : 12,
      max_fields: options.phase === "query" ? 40 : options.phase === "discovery" ? 80 : 120,
      max_reference_sections: 2,
      max_context_bytes: Math.max(100_000, ((plan.fields ?? []).length || 0) * 6_000 + 40_000),
    },
    forbidden_inputs: ["knowledge/scans", "历史聊天", "连接配置", "无关报表", "先前失败脚本"],
  };
  let payload: JsonRecord;
  if (options.phase === "discovery") {
    const tempOut = `${resolve(options.out)}.knowledge.json`;
    const knowledge = await buildKnowledgeContext({
      plan: options.plan,
      out: tempOut,
      maxTables: 6,
      maxFields: 80,
      maxBytes: 64_000,
    });
    payload = {
      requirement: plan.report,
      initial_plan: compactDiscoveryPlan(plan),
      knowledge,
      output_contract: {
        root: "保留 init-model 生成的顶层结构；model_format_version 固定为字符串 1，report.id/name 必填",
        recommended_strategy: "只能是 sql|enrichment|group_queries|script；group_transform 只能作为执行步骤，不能作为策略",
        metric_hypotheses: "每个指标的来源、聚合、条件、去重键、证据和置信度",
        relationship_hypotheses: "只包含候选表之间实际需要的关联",
        selected_tables: "只列实际采用的来源表；table_id/selected_fields/role/entity，selected_fields 至少一个且只能引用本切片真实字段；不得列 excluded/无关表",
        open_questions: "结构化数组：id/question/options/recommended/required/affected_metrics/impact",
        discovery_note: "结果粒度和查询契约可以保留 hypothesis/draft；本阶段不要求最终稳定键、完整 sources 或输出契约",
      },
    };
    manifest.expected_outputs = ["discovery-model.json", "一个合并确认问题"];
  } else if (options.phase === "modeling") {
    if (!model || !options.confirmation) {
      throw new Error("modeling 阶段需要 --model 和 --confirmation");
    }
    const confirmation = await readJson(resolve(options.confirmation));
    const modelRaw = await readFile(resolve(options.model!), "utf8");
    if (confirmation.status !== "confirmed") throw new Error("统一确认产物尚未确认");
    if (String(confirmation.report_id ?? "") !== String(model.report?.id ?? "")) {
      throw new Error("统一确认产物与基础模型报表不一致");
    }
    if (String(confirmation.discovery_revision ?? "") !== sha256(modelRaw)) {
      throw new Error("统一确认产物引用的基础模型 revision 已过期");
    }
    if (String(confirmation.discovery_model_hash ?? "") !== reportModelHash(model)) {
      throw new Error("统一确认产物引用的基础模型 hash 已过期");
    }
    const knowledgeRoot = resolve(String(plan.knowledge?.source_dir ?? ""));
    const allTables = await loadKnowledgeTables(knowledgeRoot);
    const normalizedSources = discoveryModelSources(model);
    const referenceStrings: string[] = [];
    const collectReferenceStrings = (value: unknown): void => {
      if (typeof value === "string") {
        referenceStrings.push(value);
      } else if (Array.isArray(value)) {
        for (const item of value) collectReferenceStrings(item);
      } else if (value && typeof value === "object") {
        for (const item of Object.values(value)) collectReferenceStrings(item);
      }
    };
    collectReferenceStrings({ model, confirmation });
    const referencedIdentifiers = new Set(
      referenceStrings.join("\n").match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [],
    );
    const expandedSources = normalizedSources.map((source: JsonRecord) => {
      const table = allTables.find((candidate: JsonRecord) =>
        candidate.physical?.profile_id === source.profile_id && candidate.physical?.database === source.database && candidate.physical?.table === source.table,
      );
      if (!table) throw new Error(`模型来源不在知识库：${source.profile_id}/${source.database}/${source.table}`);
      const fields = new Map<string, JsonRecord>(
        (source.fields ?? []).map((field: JsonRecord) => [String(field.name), field]),
      );
      for (const field of table.physical_fields ?? []) {
        const name = String(field.physical?.name ?? "");
        if (name && referencedIdentifiers.has(name) && !fields.has(name)) {
          fields.set(name, { name, role: "confirmed-reference" });
        }
      }
      return { ...source, fields: [...fields.values()] };
    });
    const tables = expandedSources.map((source: JsonRecord) => {
      const table = allTables.find((candidate: JsonRecord) =>
        candidate.physical?.profile_id === source.profile_id && candidate.physical?.database === source.database && candidate.physical?.table === source.table,
      )!;
      return compactModelTable(table, new Set((source.fields ?? []).map((field: JsonRecord) => String(field.name))));
    });
    payload = {
      discovery_model: {
        ...model,
        sources: expandedSources,
      },
      confirmation,
      knowledge: { tables },
      output_contract: {
        model_format_version: REPORT_MODEL_FORMAT_VERSION,
        required_root_fields: ["report", "input_lock", "result_grain", "sources", "relationships", "metrics", "filters", "recommended_strategy", "query_contracts", "output_fields", "confirmation", "open_questions"],
        input_lock: "必须原样保留 knowledge snapshot 与 report requirement 引用；不得吸收聊天外的第四种业务输入",
        output_fields: "每个业务输出字段一项：id/label/kind(data|metric|calculation)/route(query|metric|calculation_graph)，派生字段必须关联 calculation_node；不得遗漏 requirement_intents 中的字段",
        recommended_strategy: ["sql", "enrichment", "group_queries", "script"],
        calculation_graph: {
          required_for: ["多级派生指标", "占比/差额", "同比环比", "窗口累计/排名", "跨查询运算"],
          version: "1",
          node_kinds: ["aggregate", "formula", "comparison", "window", "merge"],
          execution_hints: ["auto", "sql", "script"],
          rules: ["depends_on 只引用基础指标、查询输出或其他节点", "禁止循环依赖", "来源字段必须在模型白名单"],
          scenario_mapping: {
            detail: "直接输出字段，不强制创建节点",
            grouped_summary: "aggregate",
            ratio_or_multi_level_derived: "aggregate + formula",
            period_comparison: "comparison",
            rank_or_running_total: "window",
            cross_fact: "独立 query_contracts + merge",
            pivot_funnel_retention_recursive: "script 策略并在执行计划中显式拆步骤和中间粒度",
          },
        },
        confirmation: ["discovery_revision", "confirmation_hash"],
        open_questions: "必须为空；业务口径已完成唯一一次确认",
      },
      user_confirmation_required: false,
    };
    manifest.expected_outputs = ["report-model.json", "semantic-plan.json", "execution-plan.json", "query-contracts/*.json"];
  } else if (options.phase === "query") {
    if (!model || !options.model || !options.queryId) throw new Error("query 阶段需要 --model 和 --query-id");
    const contract = (model.query_contracts ?? []).find((query: JsonRecord) => query.id === options.queryId);
    if (!contract) throw new Error(`未知查询契约：${options.queryId}`);
    let allTables: JsonRecord[];
    try {
      const sourceLock = await readJson(join(dirname(resolve(options.model)), "source.lock.json"));
      if (!Array.isArray(sourceLock.tables)) throw new Error("source.lock.json 缺少 tables");
      allTables = sourceLock.tables;
    } catch {
      // Compatibility for older staged models that predate the independent
      // minimal-dependency model package.
      allTables = await loadKnowledgeTables(resolve(String(plan.knowledge?.source_dir ?? "")));
    }
    const tables = (contract.sources ?? []).map((source: JsonRecord) => {
      const table = allTables.find((candidate: JsonRecord) => candidate.physical?.profile_id === source.profile_id && candidate.physical?.database === source.database && candidate.physical?.table === source.table);
      if (!table) throw new Error(`查询来源不在知识库：${source.profile_id}/${source.database}/${source.table}`);
      return compactModelTable(table, new Set((source.fields ?? []).map(String)));
    });
    if (tables.length > 3) throw new Error(`查询 ${options.queryId} 涉及 ${tables.length} 张表；请拆分查询契约或明确例外`);
    payload = {
      query_contract: contract,
      calculation_graph: model.calculation_graph ?? null,
      output_fields: model.output_fields ?? [],
      calculation_plan: deriveCalculationPlan(model),
      knowledge: { tables },
      sql_dialect: contract.sql_dialect ?? plan.sql_dialect,
    };
    manifest.expected_outputs = [`queries/${options.queryId}.sql`, `query-outputs/${options.queryId}.json`];
  } else if (options.phase === "script") {
    if (!model) throw new Error("script 阶段需要 --model");
    let queryOutputs: JsonRecord[] = [];
    if (options.queryOutputs) {
      const outputPath = resolve(options.queryOutputs);
      const outputStat = await stat(outputPath);
      const files = outputStat.isDirectory()
        ? (await readdir(outputPath)).filter((name) => name.endsWith(".json")).map((name) => join(outputPath, name))
        : [outputPath];
      queryOutputs = await Promise.all(files.map((file) => readJson(file)));
      const expectedIds = new Set<string>((model.query_contracts ?? []).map((query: JsonRecord) => String(query.id)));
      const actualIds = new Set<string>(queryOutputs.map((output) => String(output.query_id ?? output.id ?? "")));
      for (const id of expectedIds) if (!actualIds.has(id)) throw new Error(`缺少查询输出契约：${id}`);
      for (const output of queryOutputs) {
        const id = String(output.query_id ?? output.id ?? "");
        if (!expectedIds.has(id)) throw new Error(`查询输出契约不在批准模型中：${id}`);
        if (!(output.columns ?? output.output ?? []).length) throw new Error(`查询输出契约 ${id} 没有 columns`);
      }
    } else {
      queryOutputs = (model.query_contracts ?? []).map((query: JsonRecord) => ({
        query_id: query.id,
        mode: query.mode,
        result_grain: query.result_grain,
        columns: query.output,
        source: "approved-model-fallback",
      }));
    }
    payload = {
      report: model.report,
      result_grain: model.result_grain,
      semantic_plan: plan.semantic_plan,
      execution_plan: plan.execution_plan,
      calculation_graph: model.calculation_graph ?? null,
      output_fields: model.output_fields ?? [],
      calculation_plan: deriveCalculationPlan(model),
      query_outputs: queryOutputs,
      allowed_api: ["queryStream", "queryStreamWithFilters", "loadIndex", "batchLookup", "beginSheet", "emit"],
    };
    manifest.forbidden_inputs.push("物理知识库", "表字段详情", "查询探索过程");
    manifest.expected_outputs = ["scripts/report.ts"];
  } else {
    if (!options.failure) throw new Error("repair 阶段需要 --failure");
    const failure = await readJson(resolve(options.failure));
    payload = { failure, route: failure.type?.startsWith("MODEL_") ? "modeling" : failure.type?.startsWith("QUERY_") ? "query" : failure.type?.startsWith("SCRIPT_") ? "script" : "runtime" };
    manifest.fresh_session = true;
    manifest.expected_outputs = ["仅修复 failure.route 对应组件"];
  }
  const context = { context_manifest: manifest, payload };
  const content = JSON.stringify(context, null, 2);
  if (Buffer.byteLength(content, "utf8") > Number(manifest.limits.max_context_bytes)) throw new Error("阶段上下文超过 max_context_bytes，请缩小模型字段或拆分查询");
  await writeFile(resolve(options.out), `${content}\n`, "utf8");
  return context;
}

type StagedArtifactPhase = "discovery" | "modeling" | "query" | "script";

interface StagedPaths {
  root: string;
  discoveryModel: string;
  confirmation: string;
  reportModel: string;
  semanticPlan: string;
  executionPlan: string;
  declarativeConfiguration: string;
  queries: string;
  queryOutputs: string;
  script: string;
  configuration: string;
  compiledCalculationPlan: string;
  compiledOutputMap: string;
  result: string;
}

function stagedPaths(rootValue: string): StagedPaths {
  const root = resolve(rootValue);
  return {
    root,
    discoveryModel: join(root, "discovery-model.json"),
    confirmation: join(root, "confirmation.json"),
    reportModel: join(root, "report-model.json"),
    semanticPlan: join(root, "semantic-plan.json"),
    executionPlan: join(root, "execution-plan.json"),
    declarativeConfiguration: join(root, "declarative-configuration.json"),
    queries: join(root, "queries"),
    queryOutputs: join(root, "query-outputs"),
    script: join(root, "scripts", "report.ts"),
    configuration: join(root, "assembled-configuration.json"),
    compiledCalculationPlan: join(root, "compiled-calculation-plan.json"),
    compiledOutputMap: join(root, "compiled-output-map.json"),
    result: join(root, "stage-result.json"),
  };
}

async function writeCompiledCalculationArtifacts(model: JsonRecord, paths: StagedPaths): Promise<JsonRecord> {
  const plan = compileCalculationPlan(model);
  await writeJson(paths.compiledCalculationPlan, plan);
  await writeJson(paths.compiledOutputMap, {
    format_version: "1",
    output_map: plan.output_map ?? [],
  });
  return plan;
}

function contractColumns(value: unknown): Array<{ name: string; type?: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((column) => {
    if (typeof column === "string") return { name: column };
    const item = column as JsonRecord;
    return {
      name: String(item.name ?? item.id ?? ""),
      ...(item.type ?? item.output_type ? { type: String(item.type ?? item.output_type) } : {}),
    };
  });
}

function compareQueryOutput(contract: JsonRecord, output: JsonRecord): string[] {
  const errors: string[] = [];
  const expected = contractColumns(contract.output);
  const actual = contractColumns(output.columns ?? output.output);
  if (String(output.query_id ?? output.id ?? "") !== String(contract.id)) {
    errors.push(`查询输出文件 id 与契约不一致：${contract.id}`);
  }
  if (actual.length !== expected.length) {
    errors.push(`查询 ${contract.id} 输出列数量不一致：期望 ${expected.length}，实际 ${actual.length}`);
    return errors;
  }
  for (let index = 0; index < expected.length; index += 1) {
    const expectedColumn = expected[index]!;
    const actualColumn = actual[index]!;
    if (actualColumn.name !== expectedColumn.name) {
      errors.push(`查询 ${contract.id} 第 ${index + 1} 列应为 ${expectedColumn.name}，实际为 ${actualColumn.name}`);
    }
    if (expectedColumn.type && actualColumn.type && expectedColumn.type !== actualColumn.type) {
      errors.push(`查询 ${contract.id}.${expectedColumn.name} 类型应为 ${expectedColumn.type}，实际为 ${actualColumn.type}`);
    }
  }
  return errors;
}

function outerSelectList(sql: string): string | null {
  let depth = 0;
  let quote = "";
  let selectEnd = -1;
  const isWord = (value: string | undefined): boolean => Boolean(value && /[A-Za-z0-9_$]/.test(value));
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    if (quote) {
      if (char === quote && sql[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "(") { depth += 1; continue; }
    if (char === ")") { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0) continue;
    const rest = sql.slice(index);
    const keyword = rest.match(/^(SELECT|FROM)\b/i)?.[1]?.toUpperCase();
    if (!keyword || isWord(sql[index - 1])) continue;
    if (keyword === "SELECT") {
      selectEnd = index + keyword.length;
      index += keyword.length - 1;
    } else if (selectEnd >= 0) {
      return sql.slice(selectEnd, index);
    }
  }
  return null;
}

function extractOuterSelectAliases(sql: string): string[] {
  const list = outerSelectList(sql);
  if (list === null) return [];
  const items: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index <= list.length; index += 1) {
    const char = list[index];
    if (quote) {
      if (char === quote && list[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if ((char === "," && depth === 0) || index === list.length) {
      items.push(list.slice(start, index).trim());
      start = index + 1;
    }
  }
  return items.map((item) => {
    const match = item.match(/\bAS\s+(?:`([^`]+)`|"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))\s*$/i);
    return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  });
}

function compareSqlOutputAliases(contract: JsonRecord, sql: string): string[] {
  const expected = contractColumns(contract.output).map((column) => column.name);
  const actual = extractOuterSelectAliases(sql);
  if (actual.length === expected.length && actual.every((name, index) => name === expected[index])) return [];
  return [`查询 ${contract.id} SELECT 输出别名必须逐列显式 AS 且与契约一致：期望 [${expected.join(", ")}], 实际 [${actual.join(", ")}]`];
}

async function readRequiredJson(path: string, label: string): Promise<JsonRecord> {
  try {
    return await readJson(path);
  } catch (error) {
    throw new Error(`${label} 不存在或不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function validateStagedArtifacts(options: {
  phase: StagedArtifactPhase;
  plan: string;
  root: string;
  requireApprovedModel?: boolean;
  queryId?: string;
}): Promise<JsonRecord> {
  const planPath = resolve(options.plan);
  const plan = await readRequiredJson(planPath, "报表计划");
  const paths = stagedPaths(options.root);
  const errors: string[] = [];
  let model: JsonRecord | null = null;
  if (options.phase === "discovery") {
    model = await readRequiredJson(paths.discoveryModel, "基础模型");
    errors.push(...validateDiscoveryReportModelValue(model));
  } else {
    model = await readRequiredJson(paths.reportModel, "确定模型");
    if (options.phase === "modeling") {
      model = normalizeFinalReportModelValue(model);
      await writeJson(paths.reportModel, model);
      await writeCompiledCalculationArtifacts(model, paths);
    }
    errors.push(...validateReportModelValue(model, options.requireApprovedModel ?? ["query", "script"].includes(options.phase)));
    errors.push(...calculationPlanErrors(model));
    const semanticPlan = await readRequiredJson(paths.semanticPlan, "语义计划");
    const executionPlan = await readRequiredJson(paths.executionPlan, "执行计划");
    if (!String(semanticPlan.result_grain ?? "").trim()) errors.push("语义计划缺少 result_grain");
    if (!(executionPlan.steps ?? []).length) errors.push("执行计划缺少 steps");
    if (String(executionPlan.strategy ?? "") !== String(model.recommended_strategy ?? "")) {
      errors.push("执行计划 strategy 与确定模型 recommended_strategy 不一致");
    }
    try {
      const confirmation = await readJson(paths.confirmation);
      if (
        String(model.confirmation?.discovery_revision ?? "") !==
        String(confirmation.discovery_revision ?? "")
      ) {
        errors.push("确定模型没有引用本次统一确认的 discovery revision");
      }
      if (
        String(model.confirmation?.confirmation_hash ?? "") !==
        String(confirmation.confirmation_hash ?? "")
      ) {
        errors.push("确定模型没有引用本次统一确认 hash");
      }
    } catch {
      // Compatibility: direct CLI assembly and old staged tests may predate the
      // independent confirmation artifact. Studio workflow v3 always creates it.
    }
    if (options.phase === "query" || options.phase === "script") {
      const strategy = String(model.recommended_strategy ?? executionPlan.strategy ?? "script");
      if (strategy !== "script") {
        try { await readRequiredJson(paths.declarativeConfiguration, "声明式配置"); }
        catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      }
      const selectedContracts = strategy === "script"
        ? (model.query_contracts ?? []).filter((item: JsonRecord) => !options.queryId || String(item.id) === options.queryId)
        : [];
      for (const contract of selectedContracts) {
        const id = String(contract.id);
        let sql = "";
        try {
          sql = (await readFile(join(paths.queries, `${id}.sql`), "utf8")).trim();
          safeScriptSql(sql, String(contract.mode ?? "stream"));
          errors.push(...compareSqlOutputAliases(contract, sql));
        } catch (error) {
          errors.push(`查询 ${id} SQL 无效：${error instanceof Error ? error.message : String(error)}`);
        }
        const output = await readRequiredJson(join(paths.queryOutputs, `${id}.json`), `查询 ${id} 输出契约`);
        errors.push(...compareQueryOutput(contract, output));
      }
      if (strategy === "script" && options.queryId && !(model.query_contracts ?? []).some((item: JsonRecord) => String(item.id) === options.queryId)) {
        errors.push(`模型不存在查询契约：${options.queryId}`);
      }
    }
    if (options.phase === "script") {
      try {
        const source = await readFile(paths.script, "utf8");
        validateScriptSource(source);
      } catch (error) {
        errors.push(`report.ts 无效：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (plan.report?.id !== model?.report?.id) errors.push("阶段模型与报表计划 id 不一致");
  const result: JsonRecord = {
    ok: errors.length === 0,
    phase: options.phase,
    report_id: plan.report?.id,
    root: paths.root,
    errors,
    checked_at: new Date().toISOString(),
  };
  if (options.phase === "discovery" && model) {
    const raw = await readFile(paths.discoveryModel, "utf8");
    result.confirmation = {
      confirmation_format_version: "1",
      report_id: model.report?.id,
      discovery_revision: sha256(raw),
      discovery_model_hash: reportModelHash(model),
      questions: normalizeConfirmationQuestions(model),
      metric_hypotheses: model.metric_hypotheses ?? [],
      relationship_hypotheses: model.relationship_hypotheses ?? model.relationships ?? [],
    };
  }
  await writeJson(paths.result, result);
  return result;
}

export async function approveStagedModel(options: {
  plan: string;
  root: string;
  reviewedBy: string;
}): Promise<JsonRecord> {
  const paths = stagedPaths(options.root);
  const validation = await validateStagedArtifacts({ phase: "modeling", plan: options.plan, root: options.root });
  if (!validation.ok) throw new Error((validation.errors ?? []).join("；"));
  const planPath = resolve(options.plan);
  const plan = await readJson(planPath);
  plan.semantic_plan = await readJson(paths.semanticPlan);
  plan.execution_plan = await readJson(paths.executionPlan);
  await writeJson(planPath, plan);
  const model = await approveReportModel(paths.reportModel, options.reviewedBy, planPath);
  const strategy = String(model.recommended_strategy ?? plan.execution_plan?.strategy ?? "script");
  return {
    ok: true,
    model_hash: model.approval?.model_hash,
    report_id: model.report?.id,
    strategy,
    query_ids: strategy === "script"
      ? (model.query_contracts ?? []).map((contract: JsonRecord) => String(contract.id))
      : ["declarative"],
  };
}

/**
 * Validate and approve a staged model, then atomically replace the one current
 * model package owned by the report. Discovery/chat/context files remain work
 * artifacts and are deliberately excluded; the model package carries only the
 * approved model, semantic/execution plans, optional declarative configuration,
 * and the compact physical source slice needed by later query compilation.
 */
export async function finalizeStagedModel(options: {
  plan: string;
  root: string;
  out: string;
  reviewedBy: string;
}): Promise<JsonRecord> {
  const paths = stagedPaths(options.root);
  const planPath = resolve(options.plan);
  const out = resolve(options.out);
  const candidate = join(paths.root, "model-package-candidate");
  const previous = join(paths.root, "previous-current-model");
  const originalPlan = await readFile(planPath, "utf8");
  let movedPrevious = false;
  let promoted = false;
  await rm(candidate, { recursive: true, force: true });
  await rm(previous, { recursive: true, force: true });
  try {
    const approval = await approveStagedModel({
      plan: planPath,
      root: paths.root,
      reviewedBy: options.reviewedBy,
    });
    const model = await readJson(paths.reportModel);
    const modelingContext = await readRequiredJson(
      join(paths.root, "modeling", "context.json"),
      "确定建模上下文",
    );
    const compactKnowledge = modelingContext.payload?.knowledge;
    if (!compactKnowledge || !Array.isArray(compactKnowledge.tables)) {
      throw new Error("确定建模上下文缺少最小知识切片");
    }
    const plan = await readJson(planPath);
    await mkdir(candidate, { recursive: true });
    await writeJson(join(candidate, "report-model.json"), model);
    await writeJson(join(candidate, "input.lock.json"), model.input_lock ?? {
      lock_format_version: "1",
      knowledge: plan.knowledge ?? null,
      report_requirement: { id: model.report?.id, name: model.report?.name },
    });
    await writeJson(join(candidate, "semantic-plan.json"), await readJson(paths.semanticPlan));
    await writeJson(join(candidate, "execution-plan.json"), await readJson(paths.executionPlan));
    const compiledCalculationPlan = await writeCompiledCalculationArtifacts(model, paths);
    await writeJson(join(candidate, "compiled-calculation-plan.json"), compiledCalculationPlan);
    await writeJson(join(candidate, "compiled-output-map.json"), {
      format_version: "1",
      output_map: compiledCalculationPlan.output_map ?? [],
    });
    try {
      await stat(paths.declarativeConfiguration);
      await writeJson(
        join(candidate, "declarative-configuration.json"),
        await readJson(paths.declarativeConfiguration),
      );
    } catch {
      // Script models do not carry declarative configuration.
    }
    const sourceLock = {
      source_lock_format_version: "1",
      report_id: model.report?.id,
      model_hash: model.approval?.model_hash,
      knowledge: plan.knowledge ?? null,
      input_lock: "input.lock.json",
      output_field_count: (model.output_fields ?? []).length,
      tables: compactKnowledge.tables,
    };
    await writeJson(join(candidate, "source.lock.json"), sourceLock);
    await writeJson(join(candidate, "model.manifest.json"), {
      model_package_format_version: "1",
      report: model.report,
      status: "approved",
      model_hash: model.approval?.model_hash,
      knowledge: plan.knowledge ?? null,
      source_table_count: compactKnowledge.tables.length,
      calculation_step_count: (compiledCalculationPlan.steps ?? []).length,
      calculation_output_count: (compiledCalculationPlan.output_map ?? []).filter(
        (item: JsonRecord) => item.route === "calculation_graph",
      ).length,
      approved_by: options.reviewedBy,
      approved_at: model.approval?.approved_at,
    });
    await writePackageChecksums(candidate);
    const modelErrors = validateReportModelValue(
      await readJson(join(candidate, "report-model.json")),
      true,
    );
    if (modelErrors.length) throw new Error(modelErrors.join("；"));

    await mkdir(dirname(out), { recursive: true });
    try {
      await stat(out);
      await rename(out, previous);
      movedPrevious = true;
    } catch {
      // No previous current model.
    }
    await rename(candidate, out);
    promoted = true;

    const updatedPlan = await readJson(planPath);
    updatedPlan.report_model = {
      model_format_version: REPORT_MODEL_FORMAT_VERSION,
      status: "approved",
      model_hash: model.approval?.model_hash,
      ref: relative(dirname(planPath), join(out, "report-model.json")).replaceAll("\\", "/"),
    };
    await writeJson(planPath, updatedPlan);
    if (movedPrevious) await rm(previous, { recursive: true, force: true });
    return {
      ok: true,
      report_id: model.report?.id,
      model_hash: model.approval?.model_hash,
      model: out,
      strategy: approval.strategy,
    };
  } catch (error) {
    if (promoted) await rm(out, { recursive: true, force: true });
    if (movedPrevious) await rename(previous, out).catch(() => undefined);
    await writeFile(planPath, originalPlan, "utf8");
    throw error;
  } finally {
    await rm(candidate, { recursive: true, force: true });
    if (!movedPrevious || promoted) {
      await rm(previous, { recursive: true, force: true });
    }
  }
}

export async function finalizeStagedPackage(options: {
  workspace: string;
  plan: string;
  root: string;
  reviewedBy: string;
}): Promise<JsonRecord> {
  const paths = stagedPaths(options.root);
  const model = await readJson(paths.reportModel);
  const executionPlan = await readJson(paths.executionPlan);
  const strategy = String(model.recommended_strategy ?? executionPlan.strategy ?? "script");
  const validation = await validateStagedArtifacts({
    phase: strategy === "script" ? "script" : "query",
    plan: options.plan,
    root: options.root,
    requireApprovedModel: true,
  });
  if (!validation.ok) throw new Error((validation.errors ?? []).join("；"));
  const declarative = strategy !== "script" ? await readJson(paths.declarativeConfiguration) : null;
  // Helper: convert old-style {left:{alias,field}, right:{alias,field}} → array format.
  const normalizeDeclarativeJoins = (joins: JsonRecord[]): JsonRecord[] =>
    (joins ?? []).map((j) => ({
      ...j,
      on: Array.isArray(j.on)
        ? j.on
        : j.on
          ? [{ left: `${(j.on as JsonRecord).left?.alias ?? ""}.${(j.on as JsonRecord).left?.field ?? ""}`, right: `${(j.on as JsonRecord).right?.alias ?? ""}.${(j.on as JsonRecord).right?.field ?? ""}`, operator: "eq" }]
          : [],
    }));
  // Declarative config can follow two shapes:
  //   OLD — source.primary_table / source.joins / select (nested)
  //   NEW — sources[] / relationships[] / query_contracts[0].output[] (flat)
  // Normalize both into the flat format configurePlan expects.
  const declPrimaryAlias: string | undefined =
    declarative?.source?.primary_table?.alias ?? declarative?.sources?.[0]?.alias;
  const declJoins: JsonRecord[] = declarative?.source?.joins?.length
    ? normalizeDeclarativeJoins(declarative.source.joins as JsonRecord[])
    : (declarative?.relationships ?? []).map((rel: JsonRecord) => {
        // from: "t0.field", to: "t1.field" → on: [{left, right, operator:"eq"}]
        const [fromAlias] = String(rel.from ?? "").split(".");
        const toAlias = String(rel.to ?? "").split(".")[0];
        const source = (declarative?.sources ?? []).find(
          (s: JsonRecord) => s.alias === toAlias,
        );
        return {
          type: String(rel.type ?? "LEFT").toUpperCase(),
          alias: toAlias,
          on: [{ left: rel.from, right: rel.to, operator: "eq" }],
          grain: rel.grain ?? "",
          ...(source ? { profile_id: source.profile_id, database: source.database, table: source.table } : {}),
        };
      });
  // select entries — old format uses {id,label,expression}, new format uses
  // query_contracts[0].output[{name,label,type}] with the actual SQL in queries/*.sql.
  // For the new format we emit simple column-reference fields (kind=column); the SQL
  // is already compiled in queries/main.sql.
  const declSelect: JsonRecord[] = declarative?.select?.length
    ? (declarative.select as JsonRecord[])
    : ((declarative?.query_contracts ?? [])[0]?.output ?? []).map((col: JsonRecord) => ({
        id: col.name,
        label: col.label ?? col.name,
        expression: col.expression ?? `\`${col.name}\``,
      }));
  // Inherit comparison from the report model when the declarative config doesn't
  // set one. Model-saved comparison serves as the default; AI can still override.
  const modelComparison = (model as JsonRecord).comparison as JsonRecord | undefined;
  const hasDeclComparison = !!(declarative?.comparison as JsonRecord | undefined);

  const configuration: JsonRecord = strategy === "script"
    ? { semantic_plan: await readJson(paths.semanticPlan), execution_plan: executionPlan }
    : {
        ...declarative,
        primary_alias: declPrimaryAlias,
        joins: declJoins,
        select: declSelect,
        // The query compiler receives the same deterministic IR as the script
        // compiler. It may only implement steps whose target is "query"; script
        // targets remain outside SQL and are handled by the script branch.
        calculation_plan: model.calculation_plan ?? compileCalculationPlan(model),
        calculation_graph: model.calculation_graph ?? null,
        output_fields: model.output_fields ?? deriveOutputFields(model),
        semantic_plan: await readJson(paths.semanticPlan),
        execution_plan: executionPlan,
        // Only inherit model comparison when AI didn't set one explicitly.
        ...(modelComparison?.enabled && !hasDeclComparison
          ? { comparison: modelComparison }
          : {}),
      };
  // The AI's declarative output for group_queries uses a nested per-group format
  // (query_groups[]) that differs from what configurePlan expects (group_queries.queries[]).
  // Normalize it here so applyGroupQueries can consume it.
  if (strategy === "group_queries" && Array.isArray(declarative?.query_groups)) {
    const modelSources = new Map(
      (model.sources ?? []).map((s: JsonRecord) => [s.alias, s]),
    );
    const modelSourceByTable = new Map(
      (model.sources ?? []).map((s: JsonRecord) => [s.table, s]),
    );
    function resolveJoinTable(j: JsonRecord, fallback: JsonRecord): JsonRecord {
      const byAlias: JsonRecord = j.to_alias ? (modelSources.get(j.to_alias) ?? {}) : {};
      const byTable: JsonRecord = j.table ? (modelSourceByTable.get(j.table) ?? {}) : {};
      return {
        profile_id: (j.profile_id as string) ?? (byAlias.profile_id as string) ?? (byTable.profile_id as string) ?? (fallback.profile_id as string),
        database: (j.database as string) ?? (byAlias.database as string) ?? (byTable.database as string) ?? (fallback.database as string),
        table: (j.table as string) ?? (byAlias.table as string) ?? (fallback.table as string),
      };
    }
    const modelFirstCol = ((model.sources ?? [])[0]?.fields ?? [])[0];
    const defaultMergeKey = typeof modelFirstCol === "string" ? modelFirstCol : (modelFirstCol as JsonRecord)?.name ?? "id";
    const gqMergeKey = String(declarative?.merge?.key ?? (declarative?.merge?.keys ?? [])[0] ?? defaultMergeKey);
    const hasCreateTime = (model.sources ?? []).some((s: JsonRecord) =>
      (s.fields ?? []).some((f: JsonRecord | string) => (typeof f === "string" ? f : f.name) === "create_time"),
    );
    const gqPeriodParam = (declarative?.merge?.period_param as string) ?? (hasCreateTime ? "create_time" : null);
    const metricsByGroup = (gid: string): JsonRecord[] => {
      const raw = (model.metrics ?? []) as JsonRecord[];
      if (gid === "shipping") return raw.filter((m) => String(m.label ?? "").includes("派车单"));
      return raw.filter((m) => !String(m.label ?? "").includes("派车单"));
    };
    // Merge user edits from model metrics into the declarative query_groups BEFORE
    // building configuration. This ensures user-adjusted source fields, dedup keys,
    // and conditions propagate into the generated report package.
    const modelMetricById = new Map<string, JsonRecord>(
      ((model as JsonRecord).metrics ?? []).map((m: JsonRecord) => [String(m.id), m]),
    );
    for (const g of (declarative.query_groups as JsonRecord[])) {
      for (const dm of (g.metrics ?? []) as JsonRecord[]) {
        const mm = modelMetricById.get(String(dm.id));
        if (!mm) continue;
        // dedup_key → override declarative metric's `field` (the aggregation target)
        if (mm.dedup_key) {
          (dm as JsonRecord).field = String(mm.dedup_key);
        }
        // source_alias + source_field → update the condition expression's column reference
        if (mm.source_alias && mm.source_field) {
          const newCol = `${String(mm.source_alias)}.${String(mm.source_field)}`;
          const oldCondition = String((dm as JsonRecord).condition ?? "");
          if (oldCondition) {
            // Replace the alias.field in the condition (e.g. "t0.status = 'X'" → "t0.waybill_status = 'X'")
            (dm as JsonRecord).condition = oldCondition.replace(
              /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\b/,
              newCol,
            );
          }
        }
        // Also carry over source_alias/source_field for later use by collectGroupQueryMetrics
        (dm as JsonRecord).source_alias = mm.source_alias ?? (dm as JsonRecord).source_alias;
        (dm as JsonRecord).source_field = mm.source_field ?? (dm as JsonRecord).source_field;
        (dm as JsonRecord).dedup_key = mm.dedup_key ?? (dm as JsonRecord).dedup_key;
      }
    }
    configuration.group_queries = {
      merge_keys: [gqMergeKey].filter(Boolean),
      period_param: gqPeriodParam,
      queries: (declarative.query_groups as JsonRecord[]).map((g) => {
        const primarySource = (g.sources ?? [])[0] ?? modelSources.get(g.id) ?? (model.sources ?? [])[0];
        const alias = primarySource?.alias ?? "t0";
        const firstField = ((model.sources ?? [])[0]?.fields ?? [])[0];
        const pkCol = typeof firstField === "string" ? firstField : (firstField as JsonRecord)?.name ?? "id";
        const fallbackFields = [
          // Always include the merge key as an output column first (column kind so it
          // passes the merge-key existence check without needing a knowledge lookup).
          { id: gqMergeKey, label: gqMergeKey, source: { kind: "column", alias, field: gqMergeKey }, roles: ["group", "output"] },
          ...metricsByGroup(g.id).map((m) => ({
            id: m.id,
            label: m.label,
            source: m.source as JsonRecord ?? { kind: "sql_expression", expression: `COUNT(${alias}.\`${pkCol}\`)`, dependencies: [{ alias, field: pkCol }] },
          })),
        ];
        return {
          id: g.id,
          table: {
            profile_id: primarySource?.profile_id,
            database: primarySource?.database,
            table: primarySource?.table,
          },
          alias,
          group_by: g.group_by?.length ? g.group_by : [`${alias}.${gqMergeKey}`],
          period_field: g.period_field ?? "create_time",
          fields: (g.fields ?? []).length ? g.fields : fallbackFields,
          system_conditions: (() => {
              const raw = g.system_conditions as JsonRecord | undefined;
              if (!raw) return [];
              const logicalDelete = raw.logical_delete;
              if (!logicalDelete) return [];
              const items = Array.isArray(logicalDelete) ? logicalDelete : [logicalDelete];
              return items.map((item: JsonRecord) => {
                const fieldRaw = String(item.field ?? "");
                const dot = fieldRaw.indexOf(".");
                return {
                  alias: dot > 0 ? fieldRaw.slice(0, dot) : "t0",
                  field: dot > 0 ? fieldRaw.slice(dot + 1) : fieldRaw,
                  operator: item.operator ?? "eq",
                  value: item.value ?? 0,
                };
              });
            })(),
          joins: (g.joins ?? []).map((j: JsonRecord) => {
            const resolved = resolveJoinTable(j, primarySource ?? {});
            return {
              type: normalizeRelationType(String(j.type ?? "left")),
              table: resolved,
              alias: j.to_alias ?? j.alias,
            on: typeof j.on === "string"
              ? [{ left: String(j.on).split(/\s*=\s*/)[0] ?? "", right: String(j.on).split(/\s*=\s*/)[1] ?? "", operator: "eq" }]
              : (j.on ?? []),
            grain: j.grain ?? null,
            extra_conditions: (j.extra_conditions ?? []).map((c: unknown) => {
              if (typeof c === "string") {
                const m = c.match(/^([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.+)$/);
                if (m) return { alias: m[1], field: m[2], operator: "eq", value: m[3]?.replace(/^["']|["']$/g, "") };
              }
              return c as JsonRecord;
            }),
          };
        }),
        };
      }),
    };
    // The main plan source also needs joins for the validator to recognise
    // that every table alias is reachable. Collect all unique joins from the
    // group queries and add them to configuration.joins.
    if (configuration.group_queries) {
      const seen = new Set<string>();
      const allJoins: JsonRecord[] = [];
      for (const q of configuration.group_queries.queries as JsonRecord[]) {
        for (const j of (q.joins ?? []) as JsonRecord[]) {
          const key = `${j.alias}`;
          if (!seen.has(key)) {
            seen.add(key);
            allJoins.push(j);
          }
        }
      }
      if (allJoins.length) {
        configuration.joins = [
          ...(Array.isArray(declJoins) ? declJoins : []),
          ...allJoins.map((j) => ({
            type: j.type ?? "left",
            alias: j.alias,
            on: j.on ?? [],
            grain: j.grain ?? null,
          })),
        ];
      }
    }
  }
  // Extract metric field IDs from query_groups so that:
  // 1. time_shifted base_metric references can be validated
  // 2. FIELD_NOT_FOUND blockers are resolved
  // 3. buildTimeShiftedScriptSource knows the output column names
  //
  // We add lightweight field stubs — full sql_expression resolution (with conditions,
  // aggregation functions, etc.) is handled by the existing query_groups→group_queries
  // normalization path in configurePlan. These stubs are just for blocker resolution.
  if (Array.isArray(configuration.query_groups)) {
    const qgFields: JsonRecord[] = [];
    for (const g of configuration.query_groups as JsonRecord[]) {
      for (const m of (g.metrics ?? []) as JsonRecord[]) {
        const mid = String(m.id ?? "");
        if (!mid) continue;
        // Only add if not already in configuration.fields (dedup)
        if ((configuration.fields ?? []).some((f: JsonRecord) => String(f.id) === mid)) continue;
        qgFields.push({
          id: mid,
          label: String(m.label ?? mid),
          output_column: String(m.output_column ?? mid),
          output_type: "number",
          source: { kind: "column", alias: String(g.primary_alias ?? "t0"), field: String(m.field ?? "").split(".").pop() ?? "" },
        });
      }
    }
    configuration.fields = [...(configuration.fields ?? []), ...qgFields];
  }
  if (strategy !== "script") delete configuration.script_report;
  if (strategy === "script") configuration.script_report = {
    queries: await Promise.all((model.query_contracts ?? []).map(async (contract: JsonRecord) => ({
      id: contract.id,
      mode: contract.mode ?? "stream",
      database: contract.sources?.[0]?.database,
      sources: contract.sources,
      sql: (await readFile(join(paths.queries, `${contract.id}.sql`), "utf8")).trim(),
    }))),
    source: await readFile(paths.script, "utf8"),
    resource_budget: model.resource_budget ?? {},
  };
  await writeJson(paths.configuration, configuration);
  const workspace = resolve(options.workspace);
  const planPath = resolve(options.plan);
  const plan = await readJson(planPath);
  // When plan.source.tables is empty or lacks available_fields, fill from the
  // report model so configurePlan can resolve column references. Preserve any
  // extra metadata (table_id, schema_fingerprint, system_conditions) already set
  // by inspect by merging available_fields into existing entries.
  // Rehydrate the model-selected fields into the plan. Time defaults are taken
  // only from real knowledge fields discovered by inspect (create_time,
  // created_at, gmt_create, semantic 创建时间, etc.); never fabricate a column.
  if (model.sources && Array.isArray(model.sources)) {
    plan.source = plan.source ?? {};
    const existingByAlias = new Map(
      (plan.source.tables ?? []).map((t: JsonRecord) => [t.alias, t]),
    );
    const modelTables = model.sources.map((s: JsonRecord) => {
      const existing: JsonRecord = existingByAlias.get(s.alias) ?? {};
      const modelFields = (s.fields ?? []).map((f: JsonRecord | string) =>
        typeof f === "string" ? f : String(f.name ?? ""),
      );
      const existingFields = (existing.available_fields ?? []).map(String);
      const merged = [...new Set([...existingFields, ...modelFields])];
      return {
        ...existing,
        alias: s.alias ?? existing.alias,
        profile_id: s.profile_id ?? existing.profile_id,
        database: s.database ?? existing.database,
        table: s.table ?? existing.table,
        available_fields: merged,
      };
    });
    plan.source.tables = modelTables;
    const primaryAlias = plan.source.primary_table?.alias ?? declPrimaryAlias ?? modelTables[0]?.alias;
    plan.source.primary_table = modelTables.find((t: JsonRecord) => t.alias === primaryAlias) ?? modelTables[0] ?? null;
    await writeJson(planPath, plan);
  }
  // Populate plan.fields from the declarative configuration's select expressions.
  // Each select entry has {id, label, expression} — convert to a sql_expression field.
  if (declarative && Array.isArray(declarative.select)) {
    plan.fields = (declarative.select as JsonRecord[]).map((sel) => ({
      id: sel.id,
      label: sel.label ?? sel.id,
      output_type: "number",
      source: { kind: "sql_expression", expression: sel.expression, dependencies: [] },
    }));
  }
  // Sync system_conditions and parameters from the declarative config into the
  // plan. The inspect phase only populates these when required_fields resolve to
  // physical columns; business-metric-only reports need them carried forward here.
  if (declarative) {
    if (Array.isArray(declarative.system_conditions) && declarative.system_conditions.length) {
      plan.system_conditions = (plan.system_conditions ?? []).length
        ? plan.system_conditions
        : declarative.system_conditions.map((sc: JsonRecord) => ({
            id: `__system_${sc.table_alias ?? "t0"}_${sc.field}`,
            expression: `${sc.table_alias ?? "t0"}.\`${sc.field}\``,
            operator: sc.operator ?? "eq",
            value: sc.value ?? 0,
          }));
    }
    // Merge user-edited filters from report-model.json into the plan parameters.
    // Model filters take precedence over declarative config filters, allowing users
    // to add/remove/edit filter configurations that flow into the generated package.
    const modelFilters: JsonRecord[] = (model as JsonRecord).filters ?? [];
    const effectiveFilters: JsonRecord[] =
      modelFilters.length > 0
        ? modelFilters
        : (declarative.filters as JsonRecord[]) ?? [];
    if (effectiveFilters.length) {
      plan.parameters = plan.parameters ?? [];
      const existingParamIds = new Set((plan.parameters ?? []).map((p: JsonRecord) => p.id));
      for (const filter of effectiveFilters) {
        if (existingParamIds.has(filter.id)) {
          // Update existing parameter with user-configured values
          const existing = plan.parameters.find((p: JsonRecord) => p.id === filter.id);
          if (existing) {
            if (filter.label) existing.label = filter.label;
            if (filter.value_type) existing.value_type = filter.value_type;
            if (filter.component) existing.component = filter.component;
            if (filter.operators) existing.operators = filter.operators;
            if (filter.default_operator) existing.default_operator = filter.default_operator;
            if (filter.required !== undefined) existing.required = filter.required;
            if (filter.sql_binding) {
              existing.sql_binding = {
                ...existing.sql_binding,
                ...filter.sql_binding,
              };
            }
          }
          continue;
        }
        // Derive value_adapter from component for text match mode
        const comp = String(filter.component ?? "");
        const isTextFuzzy = comp === "text-contains";
        const isTextExact = comp === "text-exact";
        const valueAdapter = isTextFuzzy ? "contains" : isTextExact ? "direct" : (filter.sql_binding?.value_adapter as string) ?? "direct";
        plan.parameters.push({
          id: filter.id,
          label: filter.label ?? filter.id,
          value_type: filter.value_type ?? "string",
          component: filter.component ?? "text",
          operators: filter.operators ?? ["eq"],
          default_operator: filter.default_operator ?? "eq",
          required: filter.required ?? false,
          sql_binding: {
            expression: (filter.sql_binding?.expression as string) ?? `${filter.alias ?? "t0"}.\`${filter.field}\``,
            clause: (filter.sql_binding?.clause as string) ?? filter.clause ?? "where",
            value_adapter: valueAdapter,
          },
        });
      }
    }
  }
  // If the plan has no time-range parameter yet, add a create_time filter from the
  // primary table. Business-metric reports (all required_fields are calculated
  // expressions) skip the inspect phase's time-column detection; this fallback
  // ensures every report has at least a basic time filter.
  if (!(plan.parameters ?? []).some((p: JsonRecord) => p.value_type === "datetime_range")) {
    const candidate =
      (plan.default_period_candidates ?? [])[0] ??
      (plan.source?.tables ?? []).find((t: JsonRecord) =>
        (t.available_fields ?? []).some((f: string) => f === "create_time"),
      );
    if (candidate) {
      const alias = candidate.alias ?? "t0";
      const fieldId = "create_time";
      // Also register create_time as a filter-only field so the package validator
      // doesn't reject it ("参数没有对应报表字段").
      const existingFieldIds = new Set((plan.fields ?? []).map((f: JsonRecord) => String(f.id)));
      if (!existingFieldIds.has(fieldId)) {
        plan.fields = [
          ...(plan.fields ?? []),
          {
            id: fieldId,
            label: "创建时间",
            output_type: "datetime",
            source: {
              kind: "column",
              alias,
              field: "create_time",
              native_type: "datetime",
              profile_id: candidate.profile_id ?? "unknown",
              database: candidate.database ?? "unknown",
              table: candidate.table ?? "unknown",
            },
            filter: { enabled: false },
            enum_ref: null,
            roles: [],
            description: "自动注入的时间筛选列",
          },
        ];
      }
      plan.parameters = [
        ...(plan.parameters ?? []),
        {
          id: fieldId,
          label: "创建时间",
          value_type: "datetime_range",
          component: "datetime-range",
          operators: ["between", "gte", "lte"],
          default_operator: "between",
          required: true,
          sql_binding: {
            expression: `${alias}.\`${fieldId}\``,
            clause: "where",
            value_adapter: "direct",
          },
        },
      ];
    }
  }
  // METRIC_REQUIRES_MODELING blockers are set during inspect for every business-
  // metric required_field. Once the model is approved (which has already happened
  // by the time we reach finalize), those blockers are resolved — remove them so
  // approvePlan doesn't reject the package.
  plan.blockers = (plan.blockers ?? []).filter(
    (b: JsonRecord) => b.code !== "METRIC_REQUIRES_MODELING",
  );
  await writeJson(planPath, plan);
  const originalPlan = await readFile(planPath, "utf8");
  const indexPath = join(workspace, "reports", "index.json");
  let originalIndex: string | null = null;
  try { originalIndex = await readFile(indexPath, "utf8"); } catch { /* index may not exist */ }
  const candidateRoot = join(paths.root, "candidate-package");
  const previousRoot = join(paths.root, "previous-current-package");
  const finalRoot = join(workspace, "reports", "packages", String(model.report?.id), String(model.report?.version));
  let published = false;
  let movedPrevious = false;
  try {
    await rm(candidateRoot, { recursive: true, force: true });
    await rm(previousRoot, { recursive: true, force: true });
    try {
      if ((await stat(finalRoot)).isDirectory()) {
        const currentIndex = originalIndex ? JSON.parse(originalIndex) as JsonRecord : { reports: [] };
        const relativePath = relative(join(workspace, "reports"), finalRoot).split("\\").join("/");
        const existing = (currentIndex.reports ?? []).find(
          (item: JsonRecord) =>
            String(item.id) === String(model.report?.id) &&
            String(item.path ?? "") === relativePath,
        );
        if (!existing || existing.development_only !== true) {
          throw new Error(`目标报表版本已发布或来源不明，禁止原地覆盖：${finalRoot}`);
        }
        await rename(finalRoot, previousRoot);
        movedPrevious = true;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    }
    await configurePlan(planPath, paths.configuration);
    await approvePlan(planPath, options.reviewedBy);
    await generatePackage({ workspace, plan: planPath, out: candidateRoot, register: false });
    // Clean up internal metadata that configurePlan stored on the plan, and sync the
    // execution_plan strategy in case generatePackage switched us to script.
    try {
      const candidateManifest = await readJson(join(candidateRoot, "report.manifest.json"));
      const updatedPlan = await readJson(planPath);
      let changed = false;
      if ((updatedPlan as JsonRecord)._time_shifted) {
        delete (updatedPlan as JsonRecord)._time_shifted;
        changed = true;
      }
      if (String(candidateManifest.execution_model ?? "").includes("script") && String((updatedPlan as JsonRecord).execution_plan?.strategy) !== "script") {
        (updatedPlan as JsonRecord).execution_plan = {
          ...((updatedPlan as JsonRecord).execution_plan ?? {}),
          strategy: "script",
        };
        changed = true;
      }
      if (changed) await writeJson(planPath, updatedPlan);
      // Also sync the standalone execution-plan.json so re-runs of the pipeline
      // see the updated strategy (validateStagedArtifacts reads this file).
      try {
        const standaloneEp = await readJson(paths.executionPlan);
        if (String(standaloneEp.strategy ?? "") !== String((updatedPlan as JsonRecord).execution_plan?.strategy ?? "")) {
          await writeJson(paths.executionPlan, { ...standaloneEp, ...(updatedPlan as JsonRecord).execution_plan });
        }
      } catch { /* best-effort */ }
    } catch { /* best-effort cleanup */ }
    const packageValidation = await validatePackage(candidateRoot);
    if (!packageValidation.valid) throw new Error(`报表包静态校验失败：${packageValidation.errors.join("；")}`);
    await mkdir(dirname(finalRoot), { recursive: true });
    await rename(candidateRoot, finalRoot);
    published = true;
    const manifest = await readJson(join(finalRoot, "report.manifest.json"));
    await updateReportIndex(workspace, manifest, finalRoot);
    if (movedPrevious) await rm(previousRoot, { recursive: true, force: true });
    const actualStrategy = String(manifest?.execution_model ?? "").includes("script") ? "script" : strategy;
    const result = { ok: true, phase: actualStrategy === "script" ? "script" : "query", strategy: actualStrategy, report_id: model.report?.id, package: finalRoot };
    await writeJson(paths.result, result);
    return result;
  } catch (error) {
    await writeFile(planPath, originalPlan, "utf8");
    if (published) await rm(finalRoot, { recursive: true, force: true });
    if (movedPrevious) await rename(previousRoot, finalRoot).catch(() => undefined);
    await rm(candidateRoot, { recursive: true, force: true });
    if (originalIndex === null) await rm(indexPath, { force: true });
    else await writeFile(indexPath, originalIndex, "utf8");
    throw error;
  }
  finally {
    await rm(previousRoot, { recursive: true, force: true });
  }
}

export async function configurePlan(
  planPathValue: string,
  configurationPathValue: string,
): Promise<JsonRecord> {
  const planPath = resolve(planPathValue);
  const plan = await readJson(planPath);
  if (plan.plan_format_version !== PLAN_FORMAT_VERSION) {
    throw new Error("configure-plan 只支持 v2 报表计划");
  }
  const configuration = await readJson(resolve(configurationPathValue));
  const tableAliases = new Set(
    (plan.source?.tables ?? []).map((table: JsonRecord) => table.alias),
  );
  if (configuration.primary_alias) {
    const primary = (plan.source.tables ?? []).find(
      (table: JsonRecord) => table.alias === configuration.primary_alias,
    );
    if (!primary) throw new Error(`未知主表别名：${configuration.primary_alias}`);
    plan.source.primary_table = primary;
  }
  if (Array.isArray(configuration.joins)) {
    plan.source.joins = configuration.joins.map((item: JsonRecord) => {
      if (!tableAliases.has(item.alias)) throw new Error(`未知 JOIN 表别名：${item.alias}`);
      const table = plan.source.tables.find(
        (candidate: JsonRecord) => candidate.alias === item.alias,
      );
      const logicalDelete = (table.system_conditions ?? []).map(
        (condition: JsonRecord) => ({
          alias: item.alias,
          field: condition.field,
          operator: condition.operator,
          value: condition.value,
        }),
      );
      return {
        type: String(item.type ?? "LEFT").toUpperCase(),
        alias: item.alias,
        on: item.on ?? [],
        conditions: item.conditions ?? logicalDelete,
        grain: item.grain ?? "",
      };
    });
  }
  // Enrichment (batch secondary-query, §enrichment design): declare a lookup table
  // whose columns are attached by a second `WHERE key IN (…)` query + in-memory
  // merge, INSTEAD of a SQL JOIN. Used to remove the one many-to-one/one-to-many
  // table that would otherwise force GROUP_CONCAT + GROUP BY + MAX over the whole
  // query. The lookup table is NOT added to source.tables (that drives FROM/JOIN);
  // its metadata lives in plan.enrichments[]. Each select column becomes a new
  // field with source.kind="enrichment".
  if (Array.isArray(configuration.enrichments)) {
    await applyEnrichments(plan, configuration.enrichments);
  }
  // Multi-entity grouped statistics (group_queries, §group-queries design): a report
  // that groups by a shared key (e.g. 客户) and counts SEPARATE entities (订单/运单/
  // 派车单) is modeled as several INDEPENDENT grouped queries — one primary plus N
  // sibling queries — merged in the runtime on the shared merge_keys. Each sibling
  // touches ONE base table (no fan-out), shares the time-range filter (broadcast to
  // each table's own time column), and is later executed + full-outer-merged by the
  // runtime. Resolved from knowledge here; stored in plan.group_queries.
  if (configuration.group_queries) {
    await applyGroupQueries(plan, configuration.group_queries);
  }
  if (configuration.script_report) {
    await applyScriptReport(plan, configuration.script_report);
    plan.blockers = (plan.blockers ?? []).filter(
      (blocker: JsonRecord) => blocker.code !== "JOIN_REQUIRED",
    );
  }
  const overrides = new Map<string, JsonRecord>(
    (configuration.fields ?? []).map((field: JsonRecord) => [field.id, field]),
  );
  for (const field of plan.fields ?? []) {
    const override = overrides.get(field.id);
    if (!override) continue;
    field.source = { ...field.source, ...override.source };
    if (override.output_type) field.output_type = override.output_type;
    if (override.filter !== undefined) field.filter = override.filter;
    // Allow re-declaring a field's roles (e.g. add "filter" to a numeric computed
    // field so it gets a post_transform range filter synthesized below).
    if (Array.isArray(override.roles)) field.roles = override.roles;
    const parameter = (plan.parameters ?? []).find(
      (item: JsonRecord) => item.id === field.id,
    );
    if (parameter && override.sql_binding) {
      parameter.sql_binding = {
        ...parameter.sql_binding,
        ...override.sql_binding,
      };
    }
    // A filter on a GROUP_CONCAT-style one-to-many field means "does ANY child
    // row match". That can't stay in WHERE (aggregate not yet computed) and
    // shouldn't be a plain column filter (wrong grain). Push it down to a
    // correlated EXISTS semi-join — faster (short-circuits, uses child indexes,
    // filters before aggregation) and correct (no group_concat_max_len
    // truncation blind spot). The subquery skeleton is built from knowledge
    // only; the runtime binds just the value. Fall back to a HAVING match on the
    // concatenated value when the skeleton can't be built (e.g. multi-column
    // expression). Genuine numeric aggregates (SUM/COUNT ≥ n) are NOT rerouted —
    // those are real HAVING comparisons and keep whatever clause they declared.
    if (parameter && isConcatField(field)) {
      const skeleton = buildExistsSkeleton(plan, field, dialectForPlan(plan));
      if (skeleton) {
        parameter.sql_binding = {
          ...parameter.sql_binding,
          expression: skeleton.inner_expression,
          clause: "exists_subquery",
          value_adapter: "contains",
          subquery_prefix: skeleton.prefix,
          subquery_suffix: skeleton.suffix,
        };
      } else {
        parameter.sql_binding = {
          ...parameter.sql_binding,
          expression: String(field.source.expression),
          clause: "having",
          value_adapter: "contains",
        };
      }
      if (!Array.isArray(parameter.operators) || !parameter.operators.includes("contains")) {
        parameter.operators = ["contains"];
      }
      parameter.default_operator = "contains";
    }
    // A boolean-flag field (config set source.kind="boolean_flag") is a numeric/
    // status column folded to 是/否. Force its output to boolean and rewrite its
    // filter into a structural truth descriptor: the runtime emits `(col op n)` for
    // 是 and `NOT (col op n)` for 否, with no bound value. The column alias/field
    // come from the field's original resolved lineage (trusted knowledge); operator
    // and threshold are validated here.
    if (isBooleanFlagField(field)) {
      const flag = resolveBooleanFlag(field); // throws on bad operator/threshold
      field.output_type = "boolean";
      if (parameter) {
        parameter.value_type = "boolean";
        parameter.component = componentFor("boolean", ["eq"]);
        parameter.operators = ["eq"];
        parameter.default_operator = "eq";
        parameter.sql_binding = {
          expression: columnExpression(flag.alias, flag.field, dialectForPlan(plan)),
          clause: "where",
          value_adapter: "flag",
          flag_operator: flag.operator,
          flag_threshold: flag.threshold,
        };
      }
    }
  }
  // Auto-generate a v3 script report from group_queries if declarative query_groups
  // are present. Must run AFTER the field override loop so script-kind rewriting
  // on plan.fields is not undone by column-kind overrides from configuration.
  if (
    configuration.group_queries &&
    Array.isArray(configuration.query_groups) &&
    configuration.query_groups.length
  ) {
    buildScriptReportFromGroupQueriesPlan(plan, configuration.query_groups as JsonRecord[]);
  }
  // Append brand-new computed / sql_expression fields declared in the config.
  // These are transform- or expression-produced (环比/同比 deltas, ratios, …) and
  // do NOT exist in the report's required_fields lineage, so the override loop
  // above (which only mutates existing plan.fields by id) skips them. Only
  // computed / sql_expression / time_shifted kinds may be added here — a brand-new
  // `column` field must still flow through required_fields + knowledge resolution so
  // its lineage is locked, so we reject it. Existing ids are handled by the loop and
  // are not re-added.
  //
  // Time-shifted fields are collected before this loop (via collectTimeShiftedDecls)
  // and injected into plan.fields by resolveTimeShiftedMetrics so blocker resolution
  // picks them up. They are skipped here.
  plan.fields = plan.fields ?? [];
  const { groups: tsDecls, queryMeta: tsQueryMeta } = collectTimeShiftedDecls(configuration);
  if (tsDecls.length > 0) {
    // Build set of metric IDs and column info from declarative config for base_metric
    // validation and injection into plan.fields.
    const configMetricIds = new Set<string>();
    const configMetricColumns = new Map<string, { column: string; alias: string; field: string }>();
    if (tsQueryMeta) {
      for (const m of tsQueryMeta.metrics) {
        const mid = String((m as JsonRecord).id);
        const col = String((m as JsonRecord).output_column ?? (m as JsonRecord).field ?? mid);
        const rawField = String((m as JsonRecord).field ?? "").includes(".")
          ? String((m as JsonRecord).field ?? "")
          : `${tsQueryMeta.primary_alias}.${String((m as JsonRecord).field ?? mid)}`;
        const fieldParts = rawField.split(".");
        const fieldName = fieldParts.pop() ?? rawField;
        const fieldAlias = fieldParts.pop() ?? tsQueryMeta.primary_alias;
        configMetricIds.add(mid);
        configMetricColumns.set(mid, { column: col, alias: fieldAlias, field: fieldName });
      }
    }
    for (const f of configuration.fields ?? []) {
      configMetricIds.add(String((f as JsonRecord).id));
    }
    const allDecls = tsDecls.flatMap((g) => g.fields);
    resolveTimeShiftedMetrics(plan, allDecls, configMetricIds, configMetricColumns);
  }

  const existingFieldIds = new Set((plan.fields ?? []).map((f: JsonRecord) => f.id));
  const queryGroupMetricIds = new Set<string>(
    (configuration.query_groups ?? []).flatMap((group: JsonRecord) =>
      (group.metrics ?? []).map((metric: JsonRecord) => String(metric.id ?? "")),
    ),
  );
  const maxOrder = (plan.fields ?? []).reduce(
    (max: number, f: JsonRecord) => Math.max(max, Number(f.order ?? 0)),
    0,
  );
  let appendedOrder = maxOrder;
  for (const candidate of configuration.fields ?? []) {
    if (existingFieldIds.has(candidate.id)) continue;
    const kind = candidate.source?.kind;
    // time_shifted fields are resolved above; skip them here.
    // Metric stubs from query_groups may temporarily use kind=column; their full
    // sql_expression resolution happens via applyGroupQueries. Any other new
    // physical column must still be rejected so knowledge lineage cannot be bypassed.
    if (kind === "time_shifted") continue;
    if (kind === "column" && queryGroupMetricIds.has(String(candidate.id))) continue;
    if (
      kind !== "computed" &&
      kind !== "sql_expression" &&
      !(kind === "script" && plan.script_report)
    ) {
      throw new Error(
        `无法新增字段 ${candidate.id}：configure-plan 只能新增 computed / sql_expression 字段；` +
          `新的数据库列必须通过 report_requirements 的 required_fields 解析以锁定血缘`,
      );
    }
    if (!candidate.id) throw new Error("新增字段缺少 id");
    appendedOrder += 1;
    plan.fields.push({
      id: candidate.id,
      label: candidate.label ?? candidate.id,
      order: candidate.order ?? appendedOrder,
      output_type: candidate.output_type ?? "string",
      source: { ...candidate.source },
      ...(candidate.description ? { description: candidate.description } : {}),
      // Computed/expression fields are transform/SQL outputs, never filters.
      filter: null,
      enum_ref: null,
      roles: Array.isArray(candidate.roles) ? candidate.roles : [],
    });
    existingFieldIds.add(candidate.id);
  }
  // A report requirement may name a business metric (订单量/运单量/派车单数量)
  // rather than a physical database column. inspect records that as FIELD_NOT_FOUND
  // with a deterministic field_id. Once configure-plan supplies the same id as a
  // trusted sql_expression/computed field, or as a group_queries output, the metric
  // is resolved and must no longer block approval. Physical-field misses that were
  // not explicitly configured remain blockers; nothing is guessed silently.
  const configuredMetricIds = new Set<string>([
    ...(plan.fields ?? []).map((field: JsonRecord) => String(field.id)),
    ...(plan.group_queries?.queries ?? []).flatMap((query: JsonRecord) =>
      (query.fields ?? []).map((field: JsonRecord) => String(field.id)),
    ),
  ]);
  const resolvedBusinessMetrics = (plan.blockers ?? []).filter(
    (blocker: JsonRecord) =>
      blocker.code === "FIELD_NOT_FOUND" &&
      blocker.field_id &&
      configuredMetricIds.has(String(blocker.field_id)),
  );
  if (resolvedBusinessMetrics.length) {
    const resolvedIds = new Set(
      resolvedBusinessMetrics.map((blocker: JsonRecord) => String(blocker.field_id)),
    );
    plan.blockers = (plan.blockers ?? []).filter(
      (blocker: JsonRecord) =>
        blocker.code !== "FIELD_NOT_FOUND" ||
        !blocker.field_id ||
        !resolvedIds.has(String(blocker.field_id)),
    );
    plan.warnings = [
      ...(plan.warnings ?? []).filter(
        (warning: JsonRecord) => warning.code !== "BUSINESS_METRICS_RESOLVED",
      ),
      {
        code: "BUSINESS_METRICS_RESOLVED",
        fields: resolvedBusinessMetrics.map((blocker: JsonRecord) => ({
          id: blocker.field_id,
          label: blocker.label ?? blocker.field,
        })),
        message: `以下非物理业务指标已由报表计划显式解析：${resolvedBusinessMetrics
          .map((blocker: JsonRecord) => blocker.label ?? blocker.field)
          .join("、")}`,
      },
    ];
  }
  // A `computed` field is produced by the TypeScript transform (row/group) — it
  // does not exist as a queryable column or SQL expression, so it can never be a
  // WHERE/HAVING filter evaluated by the database. But a NUMERIC computed field
  // (件数总和 / 环比变化量 …) can still be range-filtered AFTER the transform runs:
  // the runtime keeps only the output rows whose computed value falls in range.
  // So instead of unconditionally dropping computed filters, we:
  //   • for numeric computed fields the config marked as filterable → synthesize a
  //     `post_transform` number-range parameter (the runtime filters in memory);
  //   • for every other computed field → drop the filter and warn (can't filter).
  const computedFields = (plan.fields ?? []).filter(
    (field: JsonRecord) => field.source?.kind === "computed",
  );
  const computedFieldIds = new Set(computedFields.map((field: JsonRecord) => field.id));
  if (computedFieldIds.size) {
    // Which computed fields should become a post-transform numeric range filter:
    // output_type number AND the config asked for a filter role on them.
    const postTransformFields = computedFields.filter(
      (field: JsonRecord) =>
        field.output_type === "number" &&
        Array.isArray(field.roles) &&
        field.roles.includes("filter"),
    );
    const postTransformIds = new Set(postTransformFields.map((f: JsonRecord) => f.id));

    const dropped: JsonRecord[] = [];
    plan.parameters = (plan.parameters ?? []).filter((parameter: JsonRecord) => {
      if (!computedFieldIds.has(parameter.id)) return true;
      // A pre-existing parameter on a computed field (e.g. hand-edited) is removed
      // here; numeric filterable ones are re-synthesized below in canonical shape.
      if (!postTransformIds.has(parameter.id)) {
        dropped.push({ id: parameter.id, label: parameter.label ?? parameter.id });
      }
      return false;
    });

    // Synthesize a post_transform numeric range parameter for each qualifying
    // computed field. The runtime never sends these to SQL — it keeps only rows
    // whose computed value satisfies the range (>= / <= / between).
    const existingParamIds = new Set((plan.parameters ?? []).map((p: JsonRecord) => p.id));
    for (const field of postTransformFields) {
      if (existingParamIds.has(field.id)) continue;
      plan.parameters.push({
        id: field.id,
        label: field.label,
        value_type: "number_range",
        component: "number-range",
        operators: ["between", "gte", "lte"],
        default_operator: "between",
        required: false,
        sql_binding: {
          // post_transform filters are evaluated in memory against the computed
          // output value keyed by field id — there is no SQL expression/clause.
          expression: field.id,
          clause: "post_transform",
          value_adapter: "direct",
        },
        enum_source: null,
      });
      existingParamIds.add(field.id);
    }

    if (dropped.length) {
      plan.warnings = [
        ...(plan.warnings ?? []).filter(
          (warning: JsonRecord) => warning.code !== "FILTER_DROPPED_COMPUTED",
        ),
        {
          code: "FILTER_DROPPED_COMPUTED",
          fields: dropped,
          message: `以下字段是计算/派生字段且非数值，无法作为筛选项，已取消其筛选、仅作为输出列，请与用户确认：${dropped
            .map((d) => d.label)
            .join("、")}`,
        },
      ];
    }
  }
  if (configuration.aggregation) {
    plan.aggregation = {
      group_by: configuration.aggregation.group_by ?? [],
      having: configuration.aggregation.having ?? [],
    };
  }
  if (configuration.custom_logic) {
    plan.custom_logic = {
      ...plan.custom_logic,
      ...configuration.custom_logic,
    };
  }
  if (configuration.comparison !== undefined) {
    plan.comparison = normalizeComparison(configuration.comparison);
  }
  // Comparison (环比/同比) needs a required month-range `period_param` to widen.
  // If it's enabled but the referenced parameter doesn't exist yet (or none was
  // named), default it to the primary table's create-time column — the "default
  // create-time, but queried by month" behavior. Exactly one candidate is used
  // silently; zero or several raise a clear, actionable error so the AI asks the
  // user which column to use rather than guessing.
  if (plan.comparison?.enabled) {
    const periodParam = String(plan.comparison.period_param ?? "").trim();
    const existing = (plan.parameters ?? []).find(
      (p: JsonRecord) => p.id === periodParam,
    );
    if (!existing) {
      const candidates = (plan.default_period_candidates ?? []) as Array<{
        alias: string;
        field: string;
        label: string;
        value_type: string;
      }>;
      // If a specific period_param was named and it matches a candidate column,
      // use that one; otherwise fall back to the sole create-time candidate.
      const chosen =
        candidates.find((c) => c.field === periodParam) ??
        (candidates.length === 1 ? candidates[0] : undefined);
      if (!chosen) {
        if (candidates.length === 0) {
          throw new Error(
            "启用环比/同比需要一个按月的创建时间筛选作为对比基准，但主表没有可识别的" +
              "创建时间（date/datetime）列。请在知识库为该表标注创建时间列，或改用其它日期列并显式指定 comparison.period_param。",
          );
        }
        throw new Error(
          `启用环比/同比需要一个按月的时间筛选作为对比基准，主表有多个候选创建时间列：` +
            `${candidates.map((c) => `${c.field}（${c.label}）`).join("、")}。` +
            `请在 comparison.period_param 中显式指定其中之一。`,
        );
      }
      const synthesized = buildPeriodParameter(chosen, dialectForPlan(plan));
      plan.parameters = [...(plan.parameters ?? []), synthesized];
      plan.comparison.period_param = synthesized.id;
      plan.warnings = [
        ...(plan.warnings ?? []).filter(
          (w: JsonRecord) => w.code !== "PERIOD_FILTER_ADDED",
        ),
        {
          code: "PERIOD_FILTER_ADDED",
          field: synthesized.id,
          message: `已自动新增必填按月时间筛选「${chosen.label}(${chosen.field})」作为环比/同比对比基准（运行时按选定月份自动向前加宽下界）。`,
        },
      ];
    } else if (!existing.required) {
      // A create-time filter that inspect made optional must be required for the
      // window to be derivable — force it required (matches create-time rule).
      existing.required = true;
    }
  }
  if (configuration.ordering) plan.ordering = configuration.ordering;

  // When comparison is enabled and the plan uses a v3 script, auto-wrap the script
  // source so it emits multiple sheets (本期/环比/同比) via independent queries.
  if (plan.comparison?.enabled && plan.script_report) {
    wrapScriptForComparison(plan);
  }

  // When time_shifted fields exist and we haven't already built a script (comparison
  // may have set script_report above), store metadata in the plan so generatePackage
  // can auto-generate the script at the right time (when SQL + source data is ready).
  if ((plan as JsonRecord)._has_time_shifted && tsDecls.length > 0 && !plan.script_report) {
    const periodParam = String(
      plan.comparison?.period_param ??
      (plan.default_period_candidates?.length
        ? (plan.default_period_candidates as JsonRecord[])[0]?.field
        : tsQueryMeta?.time_filter?.field
          ? String((tsQueryMeta.time_filter as JsonRecord).field ?? "").includes(".")
            ? String((tsQueryMeta.time_filter as JsonRecord).field).split(".").pop() ?? "create_time"
            : String((tsQueryMeta.time_filter as JsonRecord).field ?? "create_time")
          : "create_time"),
    );
    const existingParam = (plan.parameters ?? []).find(
      (p: JsonRecord) => p.id === periodParam,
    );
    if (existingParam && !existingParam.required) {
      existingParam.required = true;
    }
    // Store deferred script generation metadata including query info for SQL generation.
    (plan as JsonRecord)._time_shifted = {
      shiftGroups: tsDecls,
      periodParam,
      queryMeta: tsQueryMeta,
    };
    delete (plan as JsonRecord)._has_time_shifted;
  }

  finalizePlanningDocuments(plan, configuration);
  plan.custom_logic = plan.custom_logic ?? { required: false, mode: "identity", group_keys: [], max_group_rows: 100000 };
  const fieldKinds = new Set(
    (plan.fields ?? []).map((field: JsonRecord) => field.source?.kind),
  );
  const computedModes = new Set(
    (plan.fields ?? [])
      .filter((field: JsonRecord) => field.source?.kind === "computed")
      .map((field: JsonRecord) => field.source.mode),
  );
  if (fieldKinds.has("computed")) {
    plan.custom_logic.required = true;
    plan.custom_logic.mode = computedModes.has("group") ? "group" : "row";
  } else if (fieldKinds.has("sql_expression")) {
    plan.custom_logic.required = true;
    plan.custom_logic.mode = "sql";
  } else {
    plan.custom_logic.required = false;
    plan.custom_logic.mode = "identity";
  }
  // Comparison (环比/同比) requires group transform regardless of field kinds.
  if (plan.comparison?.enabled) {
    plan.custom_logic.required = true;
    plan.custom_logic.mode = "group";
    // Auto-derive group_keys from plan parameters when none are declared.
    if (!(plan.custom_logic.group_keys ?? []).length) {
      const paramKeys = (plan.parameters ?? [])
        .filter((p: JsonRecord) => (p.roles ?? []).includes("group"))
        .map((p: JsonRecord) => String(p.id));
      const fieldKeys = (plan.fields ?? [])
        .filter((f: JsonRecord) => (f.roles ?? []).includes("group"))
        .map((f: JsonRecord) => String(f.id));
      plan.custom_logic.group_keys = [...new Set([...paramKeys, ...fieldKeys])];
      // Fallback: use the period_param field as the minimum grouping key.
      if (!plan.custom_logic.group_keys.length && plan.comparison.period_param) {
        plan.custom_logic.group_keys = [String(plan.comparison.period_param)];
      }
    }
  }

  const errors = validatePlanV2(plan);
  if (errors.length) {
    throw new Error(`计划配置无效：\n${errors.join("\n")}`);
  }
  const allSourceAliases = new Set(
    (plan.fields ?? [])
      .flatMap((field: JsonRecord) => [
        ...(field.source?.kind === "column" || field.source?.kind === "boolean_flag"
          ? [field.source.alias]
          : []),
        ...(field.source?.dependencies ?? []).map(
          (dependency: JsonRecord) => dependency.alias,
        ),
      ]),
  );
  const coveredAliases = new Set([
    plan.source.primary_table.alias,
    ...(plan.source.joins ?? []).map((item: JsonRecord) => item.alias),
  ]);
  const joinResolved = [...allSourceAliases].every((alias) =>
    coveredAliases.has(alias),
  );
  if (joinResolved) {
    plan.blockers = (plan.blockers ?? []).filter(
      (blocker: JsonRecord) => blocker.code !== "JOIN_REQUIRED",
    );
    if ((plan.source.tables ?? []).length > 1) {
      plan.warnings = [
        ...(plan.warnings ?? []).filter(
          (warning: JsonRecord) => warning.code !== "JOIN_RESOLVED",
        ),
        {
          code: "JOIN_RESOLVED",
          message: "多表关联关系、JOIN 类型和结果粒度已经计划配置确认",
        },
      ];
    }
  }
  plan.approval = {
    status: "draft",
    reviewed_by: null,
    reviewed_at: null,
  };
  await writeJson(planPath, plan);
  return plan;
}

export async function approvePlan(
  planPath: string,
  reviewedBy: string,
): Promise<JsonRecord> {
  const plan = await readJson(resolve(planPath));
  if (plan.plan_format_version !== PLAN_FORMAT_VERSION) {
    throw new Error("不支持的报表计划格式");
  }
  if ((plan.blockers ?? []).length > 0) {
    throw new Error("报表计划仍有阻塞问题，不能批准");
  }
  if (!String(plan.semantic_plan?.result_grain ?? "").trim()) {
    throw new Error("语义计划尚未明确结果粒度，不能批准");
  }
  if (!(plan.execution_plan?.steps ?? []).length) {
    throw new Error("执行计划没有可审阅步骤，不能批准");
  }
  const modelErrors = await validateAttachedReportModel(plan, resolve(planPath));
  if (modelErrors.length) throw new Error(`报表模型校验失败：\n${modelErrors.join("\n")}`);
  const errors = validatePlanV2(plan);
  if (errors.length) {
    throw new Error(`报表计划校验失败：\n${errors.join("\n")}`);
  }
  plan.approval = {
    status: "approved",
    reviewed_by: reviewedBy,
    reviewed_at: new Date().toISOString(),
  };
  plan.semantic_plan.status = "approved";
  plan.execution_plan.status = "approved";
  await writeJson(resolve(planPath), plan);
  return plan;
}

function buildSql(plan: JsonRecord): string {
  const primary = plan.source?.primary_table;
  if (!primary) throw new Error("报表计划缺少主表");
  const dialect = dialectForPlan(plan);
  const columns = availableColumnsForPlan(plan);
  const selectItems = new Map<string, string>();
  for (const field of plan.fields ?? []) {
    const kind = field.source?.kind;
    if (kind === "column") {
      selectItems.set(
        field.id,
        `${columnExpression(field.source.alias, field.source.field, dialect)} AS ${quoteIdentifier(field.id, dialect)}`,
      );
    } else if (kind === "sql_expression") {
      selectItems.set(
        field.id,
        `${assertSafeSqlExpression(field.source.expression, columns, dialect)} AS ${quoteIdentifier(field.id, dialect)}`,
      );
    } else if (kind === "boolean_flag") {
      // 是/否 column folded from a numeric/status column (CASE WHEN col op n THEN 1
      // ELSE 0 END). The 1/0 renders as 是/否 through the enum-translation map the
      // generator injects for this field id.
      selectItems.set(
        field.id,
        `${booleanFlagSelectExpression(field, dialect)} AS ${quoteIdentifier(field.id, dialect)}`,
      );
    } else if (kind === "computed") {
      for (const dependency of field.source.dependencies ?? []) {
        selectItems.set(
          dependency.id,
          `${columnExpression(dependency.alias, dependency.field, dialect)} AS ${quoteIdentifier(dependency.id, dialect)}`,
        );
      }
    }
    // kind === "enrichment": produced by a batch secondary-query + in-memory merge
    // (runtime), never SELECTed here. Its main-query join key is a separate normal
    // `column` field, so it is emitted by the branch above; validation guarantees
    // that key field exists in the main SELECT.
  }
  if (!selectItems.size) throw new Error("报表计划没有可查询字段");
  const select = [...selectItems.values()]
    .map((item) => `  ${item}`)
    .join(",\n");
  const sourceTables = new Map<string, JsonRecord>(
    (plan.source?.tables ?? [primary]).map((table: JsonRecord) => [
      table.alias,
      table,
    ]),
  );
  const joinLines = (plan.source?.joins ?? []).map((joinItem: JsonRecord) => {
    const alias = assertAlias(joinItem.alias);
    const table = sourceTables.get(alias);
    if (!table) throw new Error(`JOIN 引用了未知表：${alias}`);
    const predicates = (joinItem.on ?? []).map((condition: JsonRecord) => {
      const left = normalizeColumnReference(condition.left, columns);
      const right = normalizeColumnReference(condition.right, columns);
      return `${columnExpression(left.alias, left.field, dialect)} = ${columnExpression(
        right.alias,
        right.field,
        dialect,
      )}`;
    });
    for (const [index, condition] of (joinItem.conditions ?? []).entries()) {
      predicates.push(
        `${columnExpression(condition.alias ?? alias, condition.field, dialect)} ${
          condition.operator === "eq" ? "=" : condition.operator
        } :__join_${stableId(alias)}_${stableId(condition.field)}_${index + 1}`,
      );
    }
    return `${String(joinItem.type).toUpperCase()} JOIN ${quoteIdentifier(
      table.database,
      dialect,
    )}.${quoteIdentifier(table.table, dialect)} AS ${alias}\n  ON ${predicates.join(
      "\n  AND ",
    )}`;
  });
  const system = (Array.isArray(plan.system_conditions) ? plan.system_conditions : []).map(
    (condition: JsonRecord) =>
      `  ${condition.expression} ${condition.operator === "eq" ? "=" : condition.operator} :${condition.id}`,
  );
  const whereLines = (system.length ? system : ["  1 = 1"]).join(
    "\n  AND ",
  );
  const groupByExpressions = (plan.aggregation?.group_by ?? []).map(
    (item: string) => {
      const reference = normalizeColumnReference(item, columns);
      return columnExpression(reference.alias, reference.field, dialect);
    },
  );
  const groupBy = groupByExpressions.join(", ");
  const transformOrdering =
    plan.custom_logic?.mode === "group"
      ? (plan.custom_logic.group_keys ?? []).map((key: string) => ({
          expression: quoteIdentifier(key, dialect),
          direction: "ASC",
        }))
      : [];
  // Under an aggregate GROUP BY, ordering by a bare column that is not a group
  // key is invalid SQL. The create-time / id default sort is added at inspect
  // time (before any grouping is configured); drop those non-grouped expressions
  // once a GROUP BY exists so a grouped report doesn't emit illegal ORDER BY.
  const groupByExpressionSet = new Set(groupByExpressions);
  const ordering = [...transformOrdering, ...(plan.ordering ?? [])]
    .filter(
      (item, index, values) =>
        values.findIndex(
          (candidate) => candidate.expression === item.expression,
        ) === index,
    )
    .filter(
      (item: JsonRecord) =>
        groupByExpressions.length === 0 ||
        groupByExpressionSet.has(String(item.expression)),
    )
    .map(
      (item: JsonRecord) =>
        `${item.expression} ${String(item.direction).toUpperCase()}`,
    )
    .join(", ");
  const fixedHaving = (plan.aggregation?.having ?? []).map(
    (condition: JsonRecord, index: number) =>
      `  ${assertSafeSqlExpression(condition.expression, columns, dialect)} ${
        condition.operator === "eq" ? "=" : condition.operator
      } :__having_${condition.id ?? index + 1}`,
  );
  const hasHavingParameters = (plan.parameters ?? []).some(
    (parameter: JsonRecord) => parameter.sql_binding?.clause === "having",
  );
  const havingLines =
    fixedHaving.length || hasHavingParameters
      ? [
          "HAVING",
          (fixedHaving.length ? fixedHaving : ["  1 = 1"]).join("\n  AND "),
          "/* EASYBI_HAVING_FILTERS */",
        ]
      : [];
  return [
    "SELECT",
    select,
    `FROM ${quoteIdentifier(primary.database, dialect)}.${quoteIdentifier(primary.table, dialect)} AS ${assertAlias(primary.alias)}`,
    ...joinLines,
    "WHERE",
    whereLines,
    "/* EASYBI_FILTERS */",
    ...(groupBy ? [`GROUP BY ${groupBy}`] : []),
    ...havingLines,
    ...(ordering ? [`ORDER BY ${ordering}`] : []),
    ";",
    "",
  ].join("\n");
}

/**
 * Map a parameter's value_type to a stable, front-end-facing data-type tag so the
 * UI knows how to render/validate it: text | number | datetime | date | enum |
 * boolean | datetime_range | date_range | number_range.
 */
function parameterDataType(parameter: JsonRecord): string {
  const vt = String(parameter.value_type ?? "");
  if (vt === "enum") return "enum";
  if (vt === "boolean") return "boolean";
  if (["datetime_range", "date_range", "number_range"].includes(vt)) return vt;
  return "string";
}

/**
 * Build the parameter schema, enriching each filter with a `data_type` tag and —
 * for enum filters — the selectable options as `{ code, label }` pairs (code +
 * 中文) drawn from the locked knowledge dictionaries. The runtime surfaces these
 * verbatim so the front-end can render a proper picker (select for enums, range
 * inputs for dates) and know which filters are required.
 */
function buildParameterSchema(
  plan: JsonRecord,
  enumsByField: Record<string, Record<string, string>> = {},
): JsonRecord {
  const parameters = (plan.parameters ?? []).map((parameter: JsonRecord) => {
    const dataType = parameterDataType(parameter);
    const enriched: JsonRecord = { ...parameter, data_type: dataType };
    if (dataType === "enum") {
      const map = enumsByField[String(parameter.id)] ?? {};
      enriched.enum_options = Object.entries(map).map(([code, label]) => ({
        code,
        label,
      }));
    }
    return enriched;
  });
  return {
    schema_version: "1",
    report_id: plan.report.id,
    additional_properties: false,
    parameters,
  };
}

/**
 * Build a trusted `WHERE key IN (/* KEYS *​/)` template for one enrichment. The
 * table, key column, select columns and fixed conditions all come from KNOWLEDGE
 * (never user input); the runtime only expands `/* KEYS *​/` into `?, ?, …` and
 * binds the batch's join-key values. Conditions inline safe literals (numbers/
 * booleans) exactly like buildExistsSkeleton. Returns the template string.
 */
function buildEnrichmentTemplate(enrichment: JsonRecord, dialect: SqlDialect): string {
  const lookup = enrichment.lookup ?? {};
  const table = `${quoteIdentifier(String(lookup.database), dialect)}.${quoteIdentifier(String(lookup.table), dialect)}`;
  const keyCol = quoteIdentifier(String(enrichment.on.lookup_field), dialect);
  const selectCols = (enrichment.select ?? []).map(
    (sel: JsonRecord) =>
      `${quoteIdentifier(String(sel.lookup_field), dialect)} AS ${quoteIdentifier(String(sel.id), dialect)}`,
  );
  const staticConds: string[] = [];
  for (const condition of enrichment.conditions ?? []) {
    const op = condition.operator === "eq" ? "=" : String(condition.operator);
    if (!["=", "!=", "<>", ">", ">=", "<", "<="].includes(op)) continue;
    const lit = sqlLiteral(condition.value);
    if (lit === null) continue;
    staticConds.push(`${quoteIdentifier(String(condition.field), dialect)} ${op} ${lit}`);
  }
  const where = [...staticConds, `${keyCol} IN (/* KEYS */)`].join(" AND ");
  return (
    `SELECT ${keyCol} AS ${quoteIdentifier("__key", dialect)}, ${selectCols.join(", ")} ` +
    `FROM ${table} WHERE ${where}`
  );
}

/** Emit the runtime enrichment bindings from plan.enrichments[]. */
function buildEnrichmentBindings(plan: JsonRecord): JsonRecord[] {
  const dialect = dialectForPlan(plan);
  return (plan.enrichments ?? []).map((enrichment: JsonRecord) => ({
    id: enrichment.id,
    sql_template: buildEnrichmentTemplate(enrichment, dialect),
    key_source: enrichment.on.source ?? "main",
    key_source_id: enrichment.on.source_id ?? null,
    main_key_field: enrichment.on.main_field,
    lookup_key_alias: "__key",
    cardinality: enrichment.cardinality ?? "one",
    ...(enrichment.aggregate ? { aggregate: enrichment.aggregate } : {}),
    select_ids: (enrichment.select ?? []).map((s: JsonRecord) => String(s.id)),
    on_missing: enrichment.on_missing ?? "null",
  }));
}

function buildBindings(plan: JsonRecord): JsonRecord {
  const dialect = dialectForPlan(plan);
  const joinSystem = (plan.source?.joins ?? []).flatMap(
    (joinItem: JsonRecord) =>
      (joinItem.conditions ?? []).map(
        (condition: JsonRecord, index: number) => ({
          id: `__join_${stableId(joinItem.alias)}_${stableId(condition.field)}_${index + 1}`,
          expression: columnExpression(
            condition.alias ?? joinItem.alias,
            condition.field,
            dialect,
          ),
          operator: condition.operator,
          value: condition.value,
          clause: "join",
        }),
      ),
  );
  const havingSystem = (plan.aggregation?.having ?? []).map(
    (condition: JsonRecord, index: number) => ({
      id: `__having_${condition.id ?? index + 1}`,
      expression: condition.expression,
      operator: condition.operator,
      value: condition.value,
      clause: "having",
    }),
  );
  return {
    binding_format_version: "2",
    filter_marker: "/* EASYBI_FILTERS */",
    having_filter_marker: "/* EASYBI_HAVING_FILTERS */",
    parameters: plan.parameters.map((parameter: JsonRecord) => ({
      id: parameter.id,
      expression: parameter.sql_binding.expression,
      clause: parameter.sql_binding.clause,
      operators: parameter.operators,
      default_operator: parameter.default_operator,
      value_adapter: parameter.sql_binding.value_adapter,
      // Carried so the runtime can enforce required filters and recognise ranges.
      required: Boolean(parameter.required),
      value_type: parameter.value_type,
      // Present only for clause=exists_subquery: the trusted, knowledge-built
      // subquery skeleton the runtime wraps the value predicate in.
      ...(parameter.sql_binding.clause === "exists_subquery"
        ? {
            subquery_prefix: parameter.sql_binding.subquery_prefix,
            subquery_suffix: parameter.sql_binding.subquery_suffix,
          }
        : {}),
      // Present only for boolean-flag filters: the trusted comparison operator key
      // + threshold the runtime folds `col op n` into a 是/否 predicate. No user
      // value is bound; the user only picks the direction.
      ...(parameter.value_type === "boolean"
        ? {
            flag_operator: parameter.sql_binding.flag_operator,
            flag_threshold: parameter.sql_binding.flag_threshold,
          }
        : {}),
    })),
    context: plan.context_bindings,
    system: [...(Array.isArray(plan.system_conditions) ? plan.system_conditions : []), ...joinSystem, ...havingSystem],
    ...(plan.enrichments?.length ? { enrichments: buildEnrichmentBindings(plan) } : {}),
  };
}

/**
 * Build a per-query bindings object for a single script query, so the runtime can
 * compile user filters (e.g. create_time range) into that query's SQL template.
 * Filters only those plan.parameters whose expression refs are available in the
 * query's source tables.
 */
function buildScriptQueryBindings(plan: JsonRecord, query: JsonRecord): JsonRecord {
  const queryAliases = new Set(
    (query.sources ?? []).map((s: JsonRecord) => String(s.alias ?? "")).filter(Boolean),
  );
  const applicableParams = (plan.parameters ?? []).filter((p: JsonRecord) => {
    const expr = String(p.sql_binding?.expression ?? "");
    // Extract alias from expression like "t0.`create_time`" or "t0.create_time"
    const alias = expr.split(".")[0]?.replace(/`/g, "").trim();
    return queryAliases.has(alias);
  });
  const dialect = dialectForPlan(plan);
  return {
    binding_format_version: "2",
    filter_marker: "/* EASYBI_FILTERS */",
    parameters: applicableParams.map((parameter: JsonRecord) => ({
      id: parameter.id,
      expression: parameter.sql_binding.expression,
      clause: parameter.sql_binding.clause,
      operators: parameter.operators,
      default_operator: parameter.default_operator,
      value_adapter: parameter.sql_binding.value_adapter,
      required: Boolean(parameter.required),
      value_type: parameter.value_type,
      ...(parameter.value_type === "boolean"
        ? {
            flag_operator: parameter.sql_binding.flag_operator,
            flag_threshold: parameter.sql_binding.flag_threshold,
          }
        : {}),
    })),
    context: plan.context_bindings,
    // Script queries embed system conditions as SQL literals (no named params),
    // so system bindings aren't needed here.
    system: [],
  };
}

/**
 * Turn a sibling group query into a standalone plan-shaped object so the SAME
 * `buildSql`/`buildBindings` produce its SQL + bindings. The shared time filter
 * (plan.group_queries.period_param) is re-bound to THIS sibling's own time column
 * (period_field) as a `where` parameter carrying the same id — so the runtime
 * binds one user-picked range to every sibling's respective time column.
 */
function groupQueryToPlan(plan: JsonRecord, gq: JsonRecord): JsonRecord {
  const dialect = dialectForPlan(plan);
  const parameters: JsonRecord[] = [];
  const periodParamId = plan.group_queries?.period_param
    ? String(plan.group_queries.period_param)
    : null;
  if (periodParamId && gq.period_field) {
    const main = (plan.parameters ?? []).find(
      (p: JsonRecord) => p.id === periodParamId,
    );
    if (main) {
      parameters.push({
        ...main,
        sql_binding: {
          ...main.sql_binding,
          // Bind the shared filter to this sibling's own time column.
          expression: columnExpression(
            String(gq.period_alias ?? gq.source?.primary_table?.alias ?? "t0"),
            String(gq.period_field),
            dialect,
          ),
          clause: "where",
        },
      });
    }
  }
  return {
    plan_format_version: PLAN_FORMAT_VERSION,
    sql_dialect: gq.sql_dialect ?? dialect.id,
    report: plan.report,
    knowledge: plan.knowledge,
    source: gq.source,
    fields: gq.fields,
    parameters,
    // Siblings never carry tenant/context bindings of their own; the main query
    // owns those. Keep empty so buildBindings emits a clean, self-contained file.
    context_bindings: [],
    system_conditions: gq.system_conditions ?? [],
    ordering: [],
    custom_logic: gq.custom_logic ?? {
      required: false,
      mode: "identity",
      group_keys: [],
      max_group_rows: 100000,
    },
    aggregation: gq.aggregation ?? { group_by: [], having: [] },
  };
}

/**
 * The manifest record for multi-entity grouped queries: merge keys + one entry
 * per sibling pointing at its generated SQL/bindings files. The runtime executes
 * each, then full-outer-merges the result sets on merge_keys.
 */
function buildGroupQueriesManifest(plan: JsonRecord): JsonRecord {
  return {
    merge_keys: plan.group_queries.merge_keys,
    ...(plan.group_queries.period_param
      ? { period_param: plan.group_queries.period_param }
      : {}),
    queries: (plan.group_queries.queries ?? []).map((gq: JsonRecord) => ({
      id: gq.id,
      sql: `queries/group-${gq.id}.sql`,
      bindings: `queries/group-${gq.id}.bindings.json`,
      // The output field ids this sibling contributes (merge keys + its metrics).
      field_ids: (gq.fields ?? []).map((f: JsonRecord) => String(f.id)),
    })),
  };
}

async function updateReportIndex(
  workspace: string,
  manifest: JsonRecord,
  packageRoot: string,
): Promise<void> {
  const indexPath = join(workspace, "reports", "index.json");
  let index: JsonRecord = { reports: [] };
  try {
    index = await readJson(indexPath);
  } catch {
    // Create the index below.
  }
  const reports = Array.isArray(index.reports) ? index.reports : [];
  const entry = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    status: manifest.status,
    path: relative(join(workspace, "reports"), packageRoot)
      .split("\\")
      .join("/"),
    development_only: manifest.development_only,
  };
  const next = reports.filter(
    (item: JsonRecord) =>
      !(item.id === entry.id && item.version === entry.version),
  );
  next.push(entry);
  next.sort((left: JsonRecord, right: JsonRecord) =>
    `${left.id}/${left.version}`.localeCompare(`${right.id}/${right.version}`),
  );
  await writeJson(indexPath, { reports: next });
}

/**
 * Resolve the knowledge dir this plan was built from and translate each report
 * field's enum_ref into a code→中文 map keyed by field id. Returns {} when no
 * enums are available (older plan, unbound fields, or missing dictionaries) so
 * the package simply omits the optional enums file.
 */
async function buildPackageEnums(
  workspace: string,
  plan: JsonRecord,
): Promise<Record<string, Record<string, string>>> {
  const fields = (plan.fields ?? []) as JsonRecord[];
  if (!fields.some((field) => field.enum_ref)) return {};

  // Prefer the recorded source dir; fall back to the published version dir.
  let knowledgeRoot: string | null =
    typeof plan.knowledge?.source_dir === "string" ? plan.knowledge.source_dir : null;
  if (!knowledgeRoot && plan.knowledge?.catalog_status === "published" && plan.knowledge?.catalog_version) {
    knowledgeRoot = join(workspace, "knowledge", "versions", String(plan.knowledge.catalog_version));
  }
  if (!knowledgeRoot) return {};

  let enumsDoc: JsonRecord;
  try {
    enumsDoc = await readJson(join(knowledgeRoot, "global", "enums.json"));
  } catch {
    return {};
  }
  const dictionaries = new Map<string, Record<string, string>>();
  for (const dictionary of (enumsDoc.dictionaries ?? []) as JsonRecord[]) {
    const name = String(dictionary.name ?? "");
    if (!name) continue;
    const map: Record<string, string> = {};
    for (const value of (dictionary.values ?? []) as JsonRecord[]) {
      const code = String(value.value ?? "");
      const label = String(value.label ?? "");
      if (code && label) map[code] = label;
    }
    if (Object.keys(map).length) dictionaries.set(name, map);
  }

  const byField: Record<string, Record<string, string>> = {};
  for (const field of fields) {
    const ref = field.enum_ref ? String(field.enum_ref) : "";
    const map = ref ? dictionaries.get(ref) : undefined;
    if (map) byField[String(field.id)] = map;
  }
  return byField;
}

function buildTransformFiles(plan: JsonRecord): {
  source: string;
  compiled: string;
} {
  const rowFields = (plan.fields ?? []).filter(
    (field: JsonRecord) =>
      field.source?.kind === "computed" && field.source?.mode === "row",
  );
  const groupFields = (plan.fields ?? []).filter(
    (field: JsonRecord) =>
      field.source?.kind === "computed" && field.source?.mode === "group",
  );
  const body = (typed: boolean): string[] => {
    const lines = [
      ...(typed ? ["export type ReportRow = Record<string, unknown>;", ""] : []),
      `export function transformRow(row${typed ? ": ReportRow" : ""})${typed ? ": ReportRow" : ""} {`,
      "  const output = { ...row };",
    ];
    for (const field of rowFields) {
      lines.push(
        `  output[${JSON.stringify(field.id)}] = (${String(field.source.expression)});`,
      );
    }
    lines.push("  return output;", "}", "");
    if (groupFields.length || plan.comparison?.enabled) {
      lines.push(
        `export function transformGroup(rows${typed ? ": ReportRow[]" : ""}, context${typed ? ": { groupKey: unknown[] }" : ""})${typed ? ": ReportRow" : ""} {`,
        '  if (rows.length === 0) throw new Error("transformGroup 不接受空分组");',
        "  const preparedRows = rows.map(transformRow);",
        "  const output = { ...preparedRows[0] };",
      );
      for (const field of groupFields) {
        lines.push(
          `  output[${JSON.stringify(field.id)}] = (${String(field.source.expression)
            .replaceAll(/\brows\b/g, "preparedRows")
            .replaceAll(/\bgroupContext\b/g, "context")});`,
        );
      }
      lines.push("  return output;", "}", "");
    }
    return lines;
  };
  return {
    source: `${body(true).join("\n")}\n`,
    compiled: `${body(false).join("\n")}\n`,
  };
}

function lockedSources(plan: JsonRecord): JsonRecord[] {
  const dialect = dialectForPlan(plan);
  const fieldsByAlias = new Map<string, Set<string>>();
  const add = (alias: string, field: string): void => {
    fieldsByAlias.set(alias, fieldsByAlias.get(alias) ?? new Set());
    fieldsByAlias.get(alias)!.add(field);
  };
  const addExpression = (value: unknown): void => {
    for (const match of String(value ?? "").matchAll(dialect.referenceRegex())) {
      add(match[1]!, match[2]!);
    }
  };
  for (const field of plan.fields ?? []) {
    if (field.source?.kind === "column") {
      add(field.source.alias, field.source.field);
    }
    // A boolean-flag field reads one real DB column (folded to 是/否) — lock it.
    if (field.source?.kind === "boolean_flag") {
      add(field.source.alias, field.source.field);
    }
    for (const dependency of field.source?.dependencies ?? []) {
      add(dependency.alias, dependency.field);
    }
    if (field.source?.kind === "sql_expression") {
      addExpression(field.source.expression);
    }
  }
  for (const joinItem of plan.source?.joins ?? []) {
    for (const condition of joinItem.on ?? []) {
      for (const value of [condition.left, condition.right]) {
        const match = String(value).match(COLUMN_REF_RE);
        if (match) add(match[1]!, match[2]!);
      }
    }
    for (const condition of joinItem.conditions ?? []) {
      add(condition.alias ?? joinItem.alias, condition.field);
    }
  }
  for (const condition of Array.isArray(plan.system_conditions) ? plan.system_conditions : []) {
    addExpression(condition.expression);
  }
  for (const parameter of plan.parameters ?? []) {
    addExpression(parameter.sql_binding?.expression);
  }
  for (const binding of plan.context_bindings ?? []) {
    addExpression(binding.expression);
  }
  for (const item of plan.ordering ?? []) addExpression(item.expression);
  for (const item of plan.aggregation?.group_by ?? []) {
    const match = String(item).match(COLUMN_REF_RE);
    if (match) add(match[1]!, match[2]!);
  }
  for (const condition of plan.aggregation?.having ?? []) {
    addExpression(condition.expression);
  }
  const sourceTables = plan.source?.tables ?? [plan.source.primary_table];
  const orderedTables = [
    plan.source.primary_table,
    ...sourceTables.filter(
      (table: JsonRecord) => table.alias !== plan.source.primary_table.alias,
    ),
  ];
  const joinedSources = orderedTables.map(
    (table: JsonRecord) => ({
      profile_id: table.profile_id,
      database: table.database,
      table: table.table,
      alias: table.alias,
      table_id: table.table_id,
      schema_fingerprint: table.schema_fingerprint,
      fields: [...(fieldsByAlias.get(table.alias) ?? [])].sort(),
      kind: "join" as const,
    }),
  );
  // Enrichment lookup tables are NOT in source.tables (no FROM/JOIN), but must be
  // locked too: they carry their own alias + the columns the secondary query uses
  // (join key + select columns + condition fields). Marked kind="enrichment" so
  // validatePackage exempts them from the "must have a JOIN in main.sql" rule.
  const enrichmentSources = (plan.enrichments ?? []).map((enrichment: JsonRecord) => {
    const lookup = enrichment.lookup ?? {};
    const used = new Set<string>([
      String(enrichment.on.lookup_field),
      ...(enrichment.select ?? []).map((s: JsonRecord) => String(s.lookup_field)),
      ...(enrichment.conditions ?? []).map((c: JsonRecord) => String(c.field)),
    ]);
    return {
      profile_id: lookup.profile_id,
      database: lookup.database,
      table: lookup.table,
      alias: lookup.alias,
      table_id: lookup.table_id,
      schema_fingerprint: lookup.schema_fingerprint,
      fields: [...used].sort(),
      kind: "enrichment" as const,
    };
  });
  return [...joinedSources, ...enrichmentSources];
}

async function generateScriptPackage(
  workspace: string,
  plan: JsonRecord,
  packageRoot: string,
  register: boolean,
): Promise<string> {
  await mkdir(join(packageRoot, "queries"), { recursive: true });
  await mkdir(join(packageRoot, "scripts"), { recursive: true });
  await mkdir(join(packageRoot, "tests"), { recursive: true });
  const enumsByField = await buildPackageEnums(workspace, plan);
  const hasEnums = Object.keys(enumsByField).length > 0;
  const fields = {
    schema_version: "2",
    report_id: plan.report.id,
    fields: (plan.fields ?? []).map((field: JsonRecord, index: number) => ({
      id: field.id,
      label: field.label,
      order: field.order ?? index + 1,
      value_type: field.output_type,
      ...(field.description ? { description: field.description } : {}),
      source: field.source,
      excel: { number_format: null },
    })),
  };
  const manifest: JsonRecord = {
    report_package_format_version: SCRIPT_PACKAGE_FORMAT_VERSION,
    id: plan.report.id,
    name: plan.report.name,
    version: plan.report.version,
    description: plan.report.description,
    category: plan.report.category,
    status: "draft",
    generated_at: new Date().toISOString(),
    sql_dialect: dialectForPlan(plan).id,
    development_only: plan.knowledge.catalog_status !== "published",
    execution_model: "isolated_script",
    execution_policy: plan.execution_policy,
    resource_budget: plan.script_report.resource_budget,
    output: {
      format: "xlsx",
      file_name_pattern: `${plan.report.name}_{yyyyMMdd_HHmmss}.xlsx`,
    },
    entrypoints: {
      script: "scripts/report.mjs",
      script_source: "scripts/report.ts",
      fields: "fields.json",
      parameters: "parameters.schema.json",
      knowledge_lock: "knowledge.lock.json",
      semantic_plan: "semantic-plan.json",
      execution_plan: "execution-plan.json",
      ...(hasEnums ? { enums: "enums.json" } : {}),
    },
    queries: (plan.script_report.queries ?? []).map((query: JsonRecord) => ({
      id: query.id,
      mode: query.mode,
      profile_id: query.profile_id,
      database: query.database,
      sql_dialect: query.sql_dialect,
      sql: `queries/${query.id}.sql`,
      bindings: `queries/${query.id}.bindings.json`,
    })),
    signature: { status: "unsigned-development" },
  };
  const lock = {
    lock_format_version: "2",
    catalog_format_version: plan.knowledge.catalog_format_version,
    catalog_version: plan.knowledge.catalog_version,
    catalog_status: plan.knowledge.catalog_status,
    snapshot_hash: plan.knowledge.snapshot_hash,
    sources: [],
    script_query_sources: (plan.script_report.queries ?? []).map((query: JsonRecord) => ({
      id: query.id,
      sources: query.sources,
    })),
    report_requirement: {
      id: plan.report.id,
      name: plan.report.name,
      fields: (plan.fields ?? []).map((field: JsonRecord) => ({
        id: field.id,
        label: field.label,
        source: "script",
      })),
    },
  };
  await writeJson(join(packageRoot, "report.manifest.json"), manifest);
  await writeJson(join(packageRoot, "fields.json"), fields);
  await writeJson(
    join(packageRoot, "parameters.schema.json"),
    buildParameterSchema(plan, enumsByField),
  );
  await writeJson(join(packageRoot, "knowledge.lock.json"), lock);
  await writeJson(join(packageRoot, "semantic-plan.json"), plan.semantic_plan);
  await writeJson(join(packageRoot, "execution-plan.json"), plan.execution_plan);
  await writeFile(join(packageRoot, "plan-review.md"), renderPlanReview(plan), "utf8");
  await writeFile(join(packageRoot, "scripts", "report.ts"), plan.script_report.source, "utf8");
  await writeFile(
    join(packageRoot, "scripts", "report.mjs"),
    stripTypeScriptTypes(plan.script_report.source, { mode: "strip" }),
    "utf8",
  );
  for (const query of plan.script_report.queries ?? []) {
    await writeFile(join(packageRoot, "queries", `${query.id}.sql`), query.sql, "utf8");
    // Per-query bindings: each script query needs its own bindings file so the
    // runtime can compile user filters (e.g. create_time) into the SQL template.
    // Build bindings from plan.parameters filtering to parameters whose expression
    // references columns available in this query's source tables.
    const queryBindings = buildScriptQueryBindings(plan, query);
    await writeJson(
      join(packageRoot, "queries", `${query.id}.bindings.json`),
      queryBindings,
    );
  }
  await writeJson(join(packageRoot, "tests", "cases.json"), {
    schema_version: "1",
    cases: [{
      id: "empty-filters",
      filters: {},
      context: {},
      expected_columns: (plan.fields ?? []).map((field: JsonRecord) => field.id),
    }],
  });
  if (hasEnums) {
    await writeJson(join(packageRoot, "enums.json"), {
      schema_version: "1",
      report_id: plan.report.id,
      byField: enumsByField,
    });
  }
  await writePackageChecksums(packageRoot);
  if (register) await updateReportIndex(workspace, manifest, packageRoot);
  return packageRoot;
}

export async function generatePackage(options: {
  workspace: string;
  plan: string;
  out?: string;
  register?: boolean;
}): Promise<string> {
  const workspace = resolve(options.workspace);
  const resolvedPlanPath = resolve(options.plan);
  const plan = await readJson(resolvedPlanPath);
  if (plan.plan_format_version !== PLAN_FORMAT_VERSION) {
    throw new Error(`生成器只接受 v${PLAN_FORMAT_VERSION} 报表计划`);
  }
  const planErrors = validatePlanV2(plan);
  if (planErrors.length) {
    throw new Error(`报表计划校验失败：\n${planErrors.join("\n")}`);
  }
  if (plan.approval?.status !== "approved") {
    throw new Error("报表计划未批准");
  }
  if ((plan.blockers ?? []).length > 0) {
    throw new Error("报表计划仍有阻塞问题");
  }
  const packageRoot = resolve(
    options.out ??
      join(
        workspace,
        "reports",
        "packages",
        plan.report.id,
        plan.report.version,
      ),
  );
  try {
    const existing = await stat(packageRoot);
    if (existing.isDirectory()) {
      throw new Error(`目标报表版本已存在，禁止原地覆盖：${packageRoot}`);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      !("code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")
    ) {
      throw error;
    }
  }
  const modelErrors = await validateAttachedReportModel(plan, resolvedPlanPath);
  if (modelErrors.length) throw new Error(`报表模型校验失败：\n${modelErrors.join("\n")}`);
  // Deferred time_shifted script generation: configurePlan stored metadata because
  // the plan wasn't ready for SQL generation at that point. Now build the script.
  if ((plan as JsonRecord)._time_shifted) {
    const ts = (plan as JsonRecord)._time_shifted as {
      shiftGroups: TimeShiftGroup[];
      periodParam: string;
      queryMeta: TimeShiftedQueryMeta | null;
    };
    // Build the script_report from the plan (now fully configured).
    buildScriptReportFromTimeShiftedPlan(
      plan,
      ts.shiftGroups,
      ts.periodParam,
      ts.queryMeta,
    );
    delete (plan as JsonRecord)._time_shifted;
    // Update execution plan: finalizePlanningDocuments ran before the script was
    // built, so it set strategy="sql". Patch it now that script_report exists.
    plan.execution_plan = {
      ...(plan.execution_plan ?? {}),
      strategy: "script",
      steps: (plan.script_report as JsonRecord)?.queries?.length
        ? (plan.script_report as JsonRecord).queries.map((q: JsonRecord, i: number) => ({
            id: `Q${i + 1}`,
            type: String((q as JsonRecord).mode ?? "stream") === "stream" ? "query_stream" : "load_index",
            description: `执行查询 ${String((q as JsonRecord).id)}（${String((q as JsonRecord).mode ?? "stream")}）`,
            query_id: String((q as JsonRecord).id),
          }))
        : [{ id: "Q1", type: "query_stream", description: "执行主查询（含时间偏移）" }],
      rationale: "包含 time_shifted 跨期计算字段，自动生成脚本执行",
    };
  }

  if (plan.script_report) {
    return generateScriptPackage(workspace, plan, packageRoot, options.register !== false);
  }
  await mkdir(join(packageRoot, "queries"), { recursive: true });
  await mkdir(join(packageRoot, "transforms"), { recursive: true });
  await mkdir(join(packageRoot, "tests"), { recursive: true });

  const developmentOnly = plan.knowledge.catalog_status !== "published";
  // Build per-package enum code→中文 map from the locked knowledge enums, keyed by
  // the report field id. Empty when no field resolves to a dictionary.
  const enumsByField = await buildPackageEnums(workspace, plan);
  // Boolean-flag fields materialise as 1/0 in SQL; give them a {1:"是",0:"否"} map
  // so the runtime's enum-translation path renders 是/否 in preview + Excel. The
  // label pair is overridable per field via source.labels {truthy, falsy}.
  for (const field of plan.fields ?? []) {
    if (field.source?.kind === "boolean_flag") {
      const labels = field.source.labels ?? {};
      enumsByField[String(field.id)] = {
        "1": String(labels.truthy ?? "是"),
        "0": String(labels.falsy ?? "否"),
      };
    }
  }
  const hasEnums = Object.keys(enumsByField).length > 0;
  const manifest = {
    report_package_format_version: PACKAGE_FORMAT_VERSION,
    id: plan.report.id,
    name: plan.report.name,
    version: plan.report.version,
    description: plan.report.description,
    category: plan.report.category,
    status: "draft",
    generated_at: new Date().toISOString(),
    // SQL dialect the generated queries were quoted for. Compatible extension:
    // packages without it default to "mysql".
    sql_dialect: dialectForPlan(plan).id,
    development_only: developmentOnly,
    output: {
      format: "xlsx",
      file_name_pattern: `${plan.report.name}_{yyyyMMdd_HHmmss}.xlsx`,
    },
    execution_policy: plan.execution_policy,
    entrypoints: {
      query: "queries/main.sql",
      bindings: "queries/bindings.json",
      transform: "transforms/index.mjs",
      transform_source: "transforms/index.ts",
      fields: "fields.json",
      parameters: "parameters.schema.json",
      knowledge_lock: "knowledge.lock.json",
      ...(hasEnums ? { enums: "enums.json" } : {}),
    },
    context_bindings: plan.context_bindings,
    custom_logic: plan.custom_logic,
    // Optional comparison (环比/同比) block. When present and enabled, the runtime
    // widens the period filter's lower bound backward so a single query returns
    // the current window PLUS the look-back window(s) the group transform needs.
    ...(plan.comparison ? { comparison: plan.comparison } : {}),
    // Optional enrichment (batch secondary-query) blocks — the runtime attaches
    // these columns via a second WHERE key IN(…) query + in-memory merge instead
    // of a SQL JOIN. Old packages omit this key and take the original path.
    ...(plan.enrichments?.length ? { enrichments: plan.enrichments } : {}),
    // Optional multi-entity grouped queries: sibling grouped queries the runtime
    // executes independently and full-outer-merges on merge_keys. Each carries its
    // own generated SQL file + bindings (recorded here). Old packages omit this.
    ...(plan.group_queries?.queries?.length
      ? { group_queries: buildGroupQueriesManifest(plan) }
      : {}),
    signature: {
      status: "unsigned-development",
    },
  };
  // Output columns = the main query's fields plus every sibling group query's
  // fields (merged, deduped by id — the merge-key dimension repeats across
  // siblings). Order follows main fields first, then each sibling's own order.
  const outputFieldList: JsonRecord[] = [...(plan.fields ?? [])];
  const seenFieldIds = new Set(outputFieldList.map((f: JsonRecord) => String(f.id)));
  for (const gq of plan.group_queries?.queries ?? []) {
    for (const f of gq.fields ?? []) {
      if (seenFieldIds.has(String(f.id))) continue;
      seenFieldIds.add(String(f.id));
      outputFieldList.push(f);
    }
  }
  const fields = {
    schema_version: "2",
    report_id: plan.report.id,
    fields: outputFieldList.map((field: JsonRecord, index: number) => ({
      id: field.id,
      label: field.label,
      order: field.order ?? index + 1,
      value_type: field.output_type,
      // Config-authored business description / 口径, preserved for reference.
      // Optional: omitted when empty so existing packages stay byte-identical.
      ...(field.description ? { description: field.description } : {}),
      source: field.source,
      excel: {
        number_format:
          field.output_type === "date"
            ? "yyyy-mm-dd"
            : field.output_type === "datetime"
              ? "yyyy-mm-dd hh:mm:ss"
              : null,
      },
    })),
  };
  const lock = {
    lock_format_version: "2",
    catalog_format_version: plan.knowledge.catalog_format_version,
    catalog_version: plan.knowledge.catalog_version,
    catalog_status: plan.knowledge.catalog_status,
    snapshot_hash: plan.knowledge.snapshot_hash,
    sources: lockedSources(plan),
    ...(plan.group_queries?.queries?.length
      ? {
          group_query_sources: plan.group_queries.queries.map((gq: JsonRecord) => ({
            id: gq.id,
            sources: lockedSources(groupQueryToPlan(plan, gq)),
          })),
        }
      : {}),
    report_requirement: {
      id: plan.report.id,
      name: plan.report.name,
      fields: outputFieldList.map((field: JsonRecord) => ({
        id: field.id,
        label: field.label,
        source:
          field.source.kind === "column"
            ? `${field.source.database}.${field.source.table}.${field.source.field}`
            : field.source.kind,
      })),
    },
  };
  const transforms = buildTransformFiles(plan);
  const tests = {
    schema_version: "1",
    cases: [
      {
        id: "empty-filters",
        description: "允许所有可见筛选项为空，并仍执行固定系统条件",
        filters: {},
        context: {},
        expected_columns: outputFieldList.map((field: JsonRecord) => field.id),
      },
      {
        id: "optional-tenant-context",
        description: "传入租户时追加租户等值条件",
        filters: {},
        context: { tenantId: "test-tenant" },
        expected_columns: plan.fields.map((field: JsonRecord) => field.id),
      },
    ],
  };

  await writeJson(join(packageRoot, "report.manifest.json"), manifest);
  await writeJson(join(packageRoot, "fields.json"), fields);
  await writeJson(
    join(packageRoot, "parameters.schema.json"),
    buildParameterSchema(plan, enumsByField),
  );
  await writeFile(join(packageRoot, "queries", "main.sql"), buildSql(plan), "utf8");
  await writeJson(
    join(packageRoot, "queries", "bindings.json"),
    buildBindings(plan),
  );
  // Multi-entity grouped queries: one <id>.sql + <id>.bindings.json per sibling,
  // each a standalone grouped SELECT the runtime executes then merges on merge_keys.
  for (const gq of plan.group_queries?.queries ?? []) {
    const sibling = groupQueryToPlan(plan, gq);
    await writeFile(
      join(packageRoot, "queries", `group-${gq.id}.sql`),
      buildSql(sibling),
      "utf8",
    );
    await writeJson(
      join(packageRoot, "queries", `group-${gq.id}.bindings.json`),
      buildBindings(sibling),
    );
  }
  await writeFile(
    join(packageRoot, "transforms", "index.ts"),
    transforms.source,
    "utf8",
  );
  await writeFile(
    join(packageRoot, "transforms", "index.mjs"),
    transforms.compiled,
    "utf8",
  );
  await writeJson(join(packageRoot, "tests", "cases.json"), tests);
  await writeJson(join(packageRoot, "knowledge.lock.json"), lock);
  if (hasEnums) {
    await writeJson(join(packageRoot, "enums.json"), {
      schema_version: "1",
      report_id: plan.report.id,
      byField: enumsByField,
    });
  }

  await writePackageChecksums(packageRoot);
  if (options.register !== false) await updateReportIndex(workspace, manifest, packageRoot);
  return packageRoot;
}

async function validateScriptPackage(packageRoot: string): Promise<{
  valid: boolean;
  errors: string[];
  warnings: string[];
}> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const requiredFiles = [
    "report.manifest.json",
    "fields.json",
    "parameters.schema.json",
    "knowledge.lock.json",
    "semantic-plan.json",
    "execution-plan.json",
    "plan-review.md",
    "scripts/report.ts",
    "scripts/report.mjs",
    "tests/cases.json",
    "checksums.sha256",
  ];
  for (const file of requiredFiles) {
    try { await stat(join(packageRoot, file)); } catch { errors.push(`缺少文件：${file}`); }
  }
  if (errors.length) return { valid: false, errors, warnings };
  const manifest = await readJson(join(packageRoot, "report.manifest.json"));
  const fields = await readJson(join(packageRoot, "fields.json"));
  const lock = await readJson(join(packageRoot, "knowledge.lock.json"));
  const semantic = await readJson(join(packageRoot, "semantic-plan.json"));
  const execution = await readJson(join(packageRoot, "execution-plan.json"));
  const script = await readFile(join(packageRoot, "scripts", "report.mjs"), "utf8");
  if (String(manifest.report_package_format_version) !== SCRIPT_PACKAGE_FORMAT_VERSION) {
    errors.push("脚本报表包必须使用 report_package_format_version=3");
  }
  if (manifest.execution_model !== "isolated_script") errors.push("v3 execution_model 必须是 isolated_script");
  if (String(fields.schema_version) !== "2") errors.push("fields.json 必须使用 schema_version=2");
  if (!semantic.result_grain || semantic.status !== "approved") errors.push("v3 语义计划必须已批准并明确结果粒度");
  if (execution.strategy !== "script" || execution.status !== "approved" || !(execution.steps ?? []).length) {
    errors.push("v3 执行计划必须已批准且包含脚本步骤");
  }
  try { validateScriptSource(script); } catch (error) { errors.push((error as Error).message); }
  const requiredBudgetNames = [
    "max_queries",
    "max_query_rows",
    "max_index_rows",
    "max_batch_keys",
    "max_output_rows",
    "max_memory_mb",
    "timeout_seconds",
    "stream_batch_rows",
  ];
  for (const name of requiredBudgetNames) {
    if (!(name in (manifest.resource_budget ?? {}))) errors.push(`资源预算缺少 ${name}`);
  }
  for (const [name, value] of Object.entries(manifest.resource_budget ?? {})) {
    if (!Number.isInteger(Number(value)) || Number(value) < 1) errors.push(`资源预算 ${name} 必须是正整数`);
  }
  const lockById = new Map(
    (lock.script_query_sources ?? []).map((entry: JsonRecord) => [String(entry.id), entry]),
  );
  const queryIds = new Set<string>();
  for (const query of manifest.queries ?? []) {
    const id = String(query.id ?? "");
    if (!id || queryIds.has(id)) { errors.push("v3 查询 id 缺失或重复"); continue; }
    queryIds.add(id);
    const sqlPath = String(query.sql ?? "");
    if (!/^queries\/[a-z0-9_-]+\.sql$/.test(sqlPath)) {
      errors.push(`v3 查询 ${id} 路径无效`);
      continue;
    }
    try {
      const sql = await readFile(join(packageRoot, sqlPath), "utf8");
      safeScriptSql(sql, String(query.mode ?? ""));
      const dialect = getSqlDialect(query.sql_dialect ?? manifest.sql_dialect ?? "mysql");
      const lockEntry = lockById.get(id) as JsonRecord | undefined;
      if (!lockEntry) { errors.push(`v3 查询 ${id} 缺少独立知识锁`); continue; }
      const aliases = new Map<string, Set<string>>(
        (lockEntry.sources ?? []).map((source: JsonRecord) => [
          String(source.alias),
          new Set((source.fields ?? []).map(String)),
        ]),
      );
      for (const match of sql.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
        if (aliases.has(match[1]!)) errors.push(`v3 查询 ${id} 存在未加方言引号的列：${match[0]}`);
      }
      for (const match of sql.matchAll(dialect.referenceRegex())) {
        if (!aliases.get(match[1]!)?.has(match[2]!)) {
          errors.push(`v3 查询 ${id} 引用了未锁定列：${match[1]}.${match[2]}`);
        }
      }
    } catch (error) {
      errors.push(`v3 查询 ${id} 无法读取或校验：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const expected = new Map<string, string>();
  const checksumText = await readFile(join(packageRoot, "checksums.sha256"), "utf8");
  for (const line of checksumText.trim().split("\n").filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match) errors.push(`校验和格式错误：${line}`);
    else expected.set(match[2]!, match[1]!);
  }
  for (const file of await listPackageFiles(packageRoot)) {
    if (expected.get(file) !== sha256(await readFile(join(packageRoot, file)))) {
      errors.push(`校验和不匹配：${file}`);
    }
  }
  if (manifest.development_only) warnings.push("当前是开发包：知识库尚未发布或报表包尚未签名");
  return { valid: errors.length === 0, errors, warnings };
}

export async function validatePackage(packageRootValue: string): Promise<{
  valid: boolean;
  errors: string[];
  warnings: string[];
}> {
  const packageRoot = resolve(packageRootValue);
  try {
    const initialManifest = await readJson(join(packageRoot, "report.manifest.json"));
    if (String(initialManifest.report_package_format_version) === SCRIPT_PACKAGE_FORMAT_VERSION) {
      return validateScriptPackage(packageRoot);
    }
  } catch {
    // Continue through the v2 validator so the normal missing-file error is returned.
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const requiredFiles = [
    "report.manifest.json",
    "fields.json",
    "parameters.schema.json",
    "queries/main.sql",
    "queries/bindings.json",
    "transforms/index.ts",
    "transforms/index.mjs",
    "tests/cases.json",
    "knowledge.lock.json",
    "checksums.sha256",
  ];
  for (const file of requiredFiles) {
    try {
      await stat(join(packageRoot, file));
    } catch {
      errors.push(`缺少文件：${file}`);
    }
  }
  if (errors.length) return { valid: false, errors, warnings };

  const manifest = await readJson(join(packageRoot, "report.manifest.json"));
  const parameters = await readJson(join(packageRoot, "parameters.schema.json"));
  const fields = await readJson(join(packageRoot, "fields.json"));
  const bindings = await readJson(join(packageRoot, "queries", "bindings.json"));
  const knowledgeLock = await readJson(join(packageRoot, "knowledge.lock.json"));
  const sql = await readFile(join(packageRoot, "queries", "main.sql"), "utf8");

  // Validate every sibling grouped query as an independently locked SELECT.
  // Its aliases are local to that SQL file, so they must be checked against the
  // matching knowledge.lock.group_query_sources entry rather than main sources.
  for (const query of manifest.group_queries?.queries ?? []) {
    const queryId = String(query.id ?? "");
    const sqlPath = String(query.sql ?? "");
    const bindingsPath = String(query.bindings ?? "");
    if (!queryId || !sqlPath || !bindingsPath || sqlPath.includes("..") || bindingsPath.includes("..")) {
      errors.push(`group_queries ${queryId || "<unknown>"} 的入口路径无效`);
      continue;
    }
    try {
      const siblingSql = await readFile(join(packageRoot, sqlPath), "utf8");
      const siblingBindings = await readJson(join(packageRoot, bindingsPath));
      if ((siblingSql.match(/\/\* EASYBI_FILTERS \*\//g) ?? []).length !== 1) {
        errors.push(`group_queries ${queryId} SQL 必须且只能包含一个 EASYBI_FILTERS 标记`);
      }
      if (String(siblingBindings.binding_format_version) !== "2") {
        errors.push(`group_queries ${queryId} bindings 必须使用 binding_format_version=2`);
      }
      const lockEntry = (knowledgeLock.group_query_sources ?? []).find(
        (entry: JsonRecord) => String(entry.id) === queryId,
      );
      if (!lockEntry) {
        errors.push(`group_queries ${queryId} 缺少独立知识锁`);
        continue;
      }
      const dialect = getSqlDialect(manifest.sql_dialect ?? "mysql");
      const lockedAliases = new Map<string, Set<string>>();
      for (const source of lockEntry.sources ?? []) {
        if (!source.alias || lockedAliases.has(String(source.alias))) {
          errors.push(`group_queries ${queryId} 的知识锁表别名缺失或重复：${source.alias ?? ""}`);
          continue;
        }
        lockedAliases.set(String(source.alias), new Set((source.fields ?? []).map(String)));
      }
      for (const match of siblingSql.matchAll(dialect.referenceRegex())) {
        const alias = match[1]!;
        const field = match[2]!;
        if (!lockedAliases.has(alias)) {
          errors.push(`group_queries ${queryId} SQL 引用了未知表别名：${alias}`);
        } else if (!lockedAliases.get(alias)?.has(field)) {
          errors.push(`group_queries ${queryId} SQL 引用了未锁定的列：${alias}.${field}`);
        }
      }
      const sqlJoinAliases = new Set(
        [...siblingSql.matchAll(/\b(?:LEFT|INNER)\s+JOIN\s+[^ \n]+\s+AS\s+([A-Za-z][A-Za-z0-9_]*)/gi)].map(
          (match) => match[1]!,
        ),
      );
      for (const alias of [...lockedAliases.keys()].slice(1)) {
        if (!sqlJoinAliases.has(alias)) {
          errors.push(`group_queries ${queryId} 的来源表 ${alias} 没有对应 JOIN`);
        }
      }
    } catch (error) {
      errors.push(
        `group_queries ${queryId} 无法读取：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (String(manifest.report_package_format_version) !== PACKAGE_FORMAT_VERSION) {
    errors.push(
      `只支持 report_package_format_version=${PACKAGE_FORMAT_VERSION}`,
    );
  }
  if (String(fields.schema_version) !== "2") {
    errors.push("fields.json 必须使用 schema_version=2");
  }
  if (String(bindings.binding_format_version) !== "2") {
    errors.push("queries/bindings.json 必须使用 binding_format_version=2");
  }
  if (String(knowledgeLock.lock_format_version) !== "2") {
    errors.push("knowledge.lock.json 必须使用 lock_format_version=2");
  }
  for (const mode of manifest.execution_policy?.supported_modes ?? []) {
    if (!ALLOWED_MODES.has(mode)) errors.push(`不支持的执行方式：${mode}`);
  }
  if (
    !manifest.execution_policy?.supported_modes?.includes(
      manifest.execution_policy?.default_mode,
    )
  ) {
    errors.push("默认执行方式不在 supported_modes 中");
  }
  if ((sql.match(/\/\* EASYBI_FILTERS \*\//g) ?? []).length !== 1) {
    errors.push("main.sql 必须且只能包含一个 EASYBI_FILTERS 标记");
  }
  const hasHavingBindings = (bindings.parameters ?? []).some(
    (item: JsonRecord) => item.clause === "having",
  );
  if (
    hasHavingBindings &&
    (sql.match(/\/\* EASYBI_HAVING_FILTERS \*\//g) ?? []).length !== 1
  ) {
    errors.push("存在 HAVING 参数时必须且只能包含一个 EASYBI_HAVING_FILTERS 标记");
  }
  if (sql.includes("${") || sql.includes("{{")) {
    errors.push("main.sql 包含禁止的模板插值");
  }
  const fieldIds = new Set(
    (fields.fields ?? []).map((field: JsonRecord) => field.id),
  );
  const bindingIds = new Set(
    (bindings.parameters ?? []).map((item: JsonRecord) => item.id),
  );
  for (const binding of bindings.parameters ?? []) {
    // post_transform is a runtime-only in-memory filter (numeric computed fields);
    // it has no SQL clause/expression, so skip the SQL-clause shape checks for it.
    if (binding.clause === "post_transform") {
      if (binding.value_type !== "number_range") {
        errors.push(`post_transform 绑定 ${binding.id} 目前仅支持 number_range`);
      }
      continue;
    }
    if (!["where", "having", "exists_subquery"].includes(binding.clause)) {
      errors.push(`SQL 绑定 ${binding.id} 必须显式声明 where/having/exists_subquery clause`);
    }
    if (binding.clause === "exists_subquery") {
      const prefix = String(binding.subquery_prefix ?? "");
      if (
        !isValidExistsSkeleton(prefix, String(binding.subquery_suffix ?? "")) ||
        hasSkeletonInjection(prefix)
      ) {
        errors.push(`SQL 绑定 ${binding.id} 的 EXISTS 子查询骨架无效`);
      }
    }
  }
  // Enrichment bindings: each sql_template must contain exactly one /* KEYS */
  // marker (the only dynamic part), carry no injection vectors, and declare a
  // legal cardinality/aggregate. The template is trusted (built from knowledge),
  // but re-checked here as a backstop against hand edits.
  for (const enrichment of bindings.enrichments ?? []) {
    const template = String(enrichment.sql_template ?? "");
    const keyMarkers = (template.match(/\/\*\s*KEYS\s*\*\//g) ?? []).length;
    if (keyMarkers !== 1) {
      errors.push(`enrichment ${enrichment.id} 的 sql_template 必须且只能含一个 /* KEYS */ 标记`);
    }
    if (/;|--|'/.test(template.replace(/\/\*\s*KEYS\s*\*\//, ""))) {
      errors.push(`enrichment ${enrichment.id} 的 sql_template 含非法字符`);
    }
    if (!["one", "many"].includes(String(enrichment.cardinality))) {
      errors.push(`enrichment ${enrichment.id} cardinality 非法`);
    }
    if (enrichment.cardinality === "many" && !enrichment.aggregate) {
      errors.push(`enrichment ${enrichment.id} cardinality=many 缺少 aggregate`);
    }
  }
  // Comparison reports use period_param as a filter-only column; pre-compiled SQL
  // (custom_logic.mode="sql") reports may have standalone filter parameters that
  // aren't output fields. Both are exempt from "every filter maps to an output
  // column". The SQL binding check below still ensures the parameter is wired.
  const comparisonPeriodParam =
    manifest.comparison?.enabled ? String(manifest.comparison.period_param ?? "") : "";
  const isPrecompiledSql = String(manifest.custom_logic?.mode ?? "") === "sql";
  for (const parameter of parameters.parameters ?? []) {
    if (
      !fieldIds.has(parameter.id) &&
      parameter.id !== comparisonPeriodParam &&
      !isPrecompiledSql
    ) {
      errors.push(`参数没有对应报表字段：${parameter.id}`);
    }
    if (!bindingIds.has(parameter.id)) {
      errors.push(`参数没有 SQL 绑定：${parameter.id}`);
    }
    for (const operator of parameter.operators ?? []) {
      if (!ALLOWED_OPERATORS.has(operator)) {
        errors.push(`参数 ${parameter.id} 使用未知操作符 ${operator}`);
      }
    }
  }
  if (String(manifest.report_package_format_version) === PACKAGE_FORMAT_VERSION) {
    const dialect = getSqlDialect(manifest.sql_dialect ?? "mysql");
    const aliases = new Map<string, Set<string>>();
    // Enrichment lookup sources (kind="enrichment") are locked but never appear in
    // main.sql — keep them out of the SQL-reference alias map and the JOIN-required
    // check; they are validated against bindings.enrichments below.
    const joinLockAliases: string[] = [];
    for (const source of knowledgeLock.sources ?? []) {
      if (!source.alias) errors.push(`知识锁来源 ${source.table} 缺少 alias`);
      if (aliases.has(source.alias)) errors.push(`知识锁表别名重复：${source.alias}`);
      aliases.set(source.alias, new Set((source.fields ?? []).map(String)));
      if (source.kind !== "enrichment") joinLockAliases.push(source.alias);
    }
    const groupQueryFieldIds = new Set(
      (manifest.group_queries?.queries ?? []).flatMap((query: JsonRecord) =>
        (query.field_ids ?? []).map(String),
      ),
    );
    const groupQueryLocks = (knowledgeLock.group_query_sources ?? []).flatMap(
      (entry: JsonRecord) => entry.sources ?? [],
    );
    for (const field of fields.fields ?? []) {
      const kind = field.source?.kind;
      if (kind === "column" || kind === "boolean_flag") {
        // Both read a real DB column (boolean_flag folds it to 是/否 in the SELECT).
        if (!aliases.has(field.source?.alias)) {
          const lockedByGroupQuery =
            groupQueryFieldIds.has(String(field.id)) &&
            groupQueryLocks.some(
              (source: JsonRecord) =>
                source.alias === field.source?.alias &&
                (source.fields ?? []).map(String).includes(String(field.source?.field)),
            );
          if (!lockedByGroupQuery) errors.push(`字段 ${field.id} 引用了知识锁之外的表别名`);
        } else if (!aliases.get(field.source.alias)?.has(String(field.source.field))) {
          const lockedByGroupQuery =
            groupQueryFieldIds.has(String(field.id)) &&
            groupQueryLocks.some(
              (source: JsonRecord) =>
                source.alias === field.source?.alias &&
                (source.fields ?? []).map(String).includes(String(field.source?.field)),
            );
          if (!lockedByGroupQuery) errors.push(`字段 ${field.id} 引用了知识锁之外的列`);
        }
      } else if (kind === "enrichment") {
        // Must bind to a declared enrichment; its lookup column must be locked.
        const binding = (bindings.enrichments ?? []).find(
          (e: JsonRecord) => e.id === field.source?.enrichment_id,
        );
        if (!binding) {
          errors.push(`enrichment 字段 ${field.id} 未绑定到任何 enrichment`);
        } else if (!(binding.select_ids ?? []).includes(field.id)) {
          errors.push(`enrichment 字段 ${field.id} 不在 enrichment ${binding.id} 的 select 中`);
        }
      }
    }
    for (const match of sql.matchAll(dialect.referenceRegex())) {
      const alias = match[1]!;
      const field = match[2]!;
      if (!aliases.has(alias)) {
        errors.push(`SQL 引用了未知表别名：${alias}`);
      } else if (!aliases.get(alias)?.has(field)) {
        errors.push(`SQL 引用了未锁定的列：${alias}.${field}`);
      }
    }
    const joinAliases = new Set(
      [...sql.matchAll(/\b(?:LEFT|INNER)\s+JOIN\s+[^ \n]+\s+AS\s+([A-Za-z][A-Za-z0-9_]*)/gi)].map(
        (match) => match[1]!,
      ),
    );
    // Primary table (joinLockAliases[0]) needs no JOIN; every other JOINED source does.
    for (const alias of joinLockAliases.slice(1)) {
      if (!joinAliases.has(alias)) errors.push(`来源表 ${alias} 没有对应 JOIN`);
    }
    const transformMode = manifest.custom_logic?.mode;
    if (!["identity", "sql", "row", "group"].includes(transformMode)) {
      errors.push(`未知 Transform 模式：${transformMode}`);
    } else if (transformMode === "row" || transformMode === "group") {
      try {
        const transformPath =
          manifest.entrypoints?.transform ?? "transforms/index.mjs";
        const module = (await import(
          `${pathToFileURL(join(packageRoot, transformPath)).href}?validate=${Date.now()}`
        )) as JsonRecord;
        if (typeof module.transformRow !== "function") {
          errors.push("row/group Transform 必须导出 transformRow");
        }
        if (transformMode === "group") {
          if (typeof module.transformGroup !== "function") {
            errors.push("group Transform 必须导出 transformGroup");
          }
          if (!(manifest.custom_logic?.group_keys ?? []).length) {
            errors.push("group Transform 必须声明 group_keys");
          }
        }
      } catch (error) {
        errors.push(
          `Transform 无法加载：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  if (manifest.development_only) {
    warnings.push("当前是开发包：知识库尚未发布或报表包尚未签名");
  }

  const checksumLines = (
    await readFile(join(packageRoot, "checksums.sha256"), "utf8")
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const expected = new Map<string, string>();
  for (const line of checksumLines) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match) {
      errors.push(`校验和格式错误：${line}`);
      continue;
    }
    expected.set(match[2]!, match[1]!);
  }
  for (const file of await listPackageFiles(packageRoot)) {
    const actual = sha256(await readFile(join(packageRoot, file)));
    if (expected.get(file) !== actual) {
      errors.push(`校验和不匹配：${file}`);
    }
  }
  for (const file of expected.keys()) {
    try {
      await stat(join(packageRoot, file));
    } catch {
      errors.push(`校验和引用不存在的文件：${file}`);
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Re-seal a package after a MANUAL edit: recompute checksums.sha256 so hand-edited
 * files (queries/main.sql, transforms, bindings.json, parameters.schema.json, …)
 * are trusted again, then re-run full validation. Intended for the "AI output
 * isn't always right, a human fixes it" workflow.
 *
 * Guardrails: only DEVELOPMENT packages may be re-sealed — a published/signed
 * package stays immutable. The reseal first verifies STRUCTURE (every check
 * except the checksum match, which is expected to fail after an edit); if the
 * structure is broken (missing file, invalid SQL/binding, bad transform) it
 * refuses and reports those errors instead of blessing a broken package.
 */
export async function resealPackage(packageRootValue: string): Promise<{
  resealed: boolean;
  errors: string[];
  warnings: string[];
}> {
  const packageRoot = resolve(packageRootValue);
  let manifest: JsonRecord;
  try {
    manifest = await readJson(join(packageRoot, "report.manifest.json"));
  } catch {
    return { resealed: false, errors: ["无法读取 report.manifest.json"], warnings: [] };
  }
  // Editable unless the package's own lifecycle status is a released one. A draft
  // package built against published knowledge (development_only=false) is still a
  // work-in-progress a human may fix — gate on status, not development_only.
  const releasedStatuses = new Set(["published", "production", "released", "signed"]);
  const status = String(manifest.status ?? "").toLowerCase();
  const editable = status ? !releasedStatuses.has(status) : manifest.development_only === true;
  if (!editable) {
    return {
      resealed: false,
      errors: ["仅开发包可重新封包；已发布/已签名的报表包不可原地修改，请生成新版本"],
      warnings: [],
    };
  }
  // Validate first. Structural errors block reseal; a bare checksum mismatch is
  // exactly what an edit produces, so it does NOT block.
  const before = await validatePackage(packageRoot);
  const structural = before.errors.filter(
    (message) =>
      !message.startsWith("校验和不匹配") &&
      !message.startsWith("校验和引用不存在的文件") &&
      !message.startsWith("校验和格式错误"),
  );
  if (structural.length) {
    return { resealed: false, errors: structural, warnings: before.warnings };
  }
  // Structure is sound: recompute checksums to trust the edited files, then
  // re-validate to confirm the package is fully consistent again.
  await writePackageChecksums(packageRoot);
  const after = await validatePackage(packageRoot);
  return { resealed: after.valid, errors: after.errors, warnings: after.warnings };
}


function usage(): string {
  return [
    "Easy BI 报表包 CLI",
    "",
    "Commands:",
    "  doctor",
    "  inspect --workspace <dir> --knowledge <dir> --report-id <id> --out <file> [--version <version>]",
    "  configure-plan --plan <file> --configuration <file>",
    "  explain-plan --plan <file>",
    "  build-context --plan <file> --out <file> [--include database.table,table_id] [--max-tables 6] [--max-fields 80] [--max-bytes 64000]",
    "  init-model --plan <file> --out <file>",
    "  validate-model --model <file> [--require-approved true]",
    "  approve-model --model <file> --reviewed-by <name> [--plan <file>]",
    "  confirm-discovery --model <discovery-model> --input <confirmation-input.json> --out <confirmation.json> --reviewed-by <name>",
    "  build-phase-context --phase discovery|modeling|query|script|repair --plan <file> --out <file> [--model <file>] [--confirmation <file>] [--query-id <id>] [--query-outputs <dir>] [--failure <file>]",
    "  validate-stage --phase discovery|modeling|query|script --plan <file> --root <work/report-build/id/revision> [--query-id <id>] [--require-approved-model true]",
    "  compile-model --model <report-model.json> --out-plan <file> --out-output-map <file>",
    "  approve-staged-model --plan <file> --root <work/report-build/id/revision> --reviewed-by <name>",
    "  finalize-staged-model --plan <file> --root <work/report-model/id/revision> --out <reports/models/id> --reviewed-by <name>",
    "  finalize-staged --workspace <workspace> --plan <file> --root <work/report-build/id/revision> --reviewed-by <name>",
    "  approve-plan --plan <file> --reviewed-by <name>",
    "  generate --workspace <dir> --plan <file> [--out <dir>]",
    "  validate --package <dir>",
    "  reseal --package <dir>   (开发包：手改后重算校验和并重新校验)",
  ].join("\n");
}

async function main(): Promise<void> {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  if (command === "doctor") {
    console.log(
      JSON.stringify(
        {
          ok: true,
          node: process.version,
          package_format_version: PACKAGE_FORMAT_VERSION,
          supported_package_format_versions: [PACKAGE_FORMAT_VERSION, SCRIPT_PACKAGE_FORMAT_VERSION],
          plan_format_version: PLAN_FORMAT_VERSION,
          staged_workflow_version: 3,
          runtime_dependencies: [],
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "inspect") {
    const plan = await inspectReport({
      workspace: requiredOption(options, "workspace"),
      knowledge: requiredOption(options, "knowledge"),
      reportId: requiredOption(options, "report-id"),
      out: requiredOption(options, "out"),
      version: options.version,
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          report: plan.report,
          fields: plan.fields.length,
          parameters: plan.parameters.length,
          blockers: plan.blockers,
          warnings: plan.warnings,
          out: resolve(requiredOption(options, "out")),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "configure-plan") {
    const plan = await configurePlan(
      requiredOption(options, "plan"),
      requiredOption(options, "configuration"),
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          joins: plan.source?.joins ?? [],
          customLogic: plan.custom_logic,
          blockers: plan.blockers,
          warnings: plan.warnings,
          semanticPlan: plan.semantic_plan,
          executionPlan: plan.execution_plan,
          review: renderPlanReview(plan),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "explain-plan") {
    console.log(await explainPlan(requiredOption(options, "plan")));
    return;
  }
  if (command === "build-context") {
    const context = await buildKnowledgeContext({
      plan: requiredOption(options, "plan"),
      out: requiredOption(options, "out"),
      include: String(options.include ?? "").split(",").map((value) => value.trim()).filter(Boolean),
      maxTables: options["max-tables"] ? Number(options["max-tables"]) : undefined,
      maxFields: options["max-fields"] ? Number(options["max-fields"]) : undefined,
      maxBytes: options["max-bytes"] ? Number(options["max-bytes"]) : undefined,
    });
    console.log(JSON.stringify({
      ok: true,
      out: resolve(requiredOption(options, "out")),
      selectedTables: context.selected_table_count,
    }, null, 2));
    return;
  }
  if (command === "init-model") {
    const model = await initializeReportModel({
      plan: requiredOption(options, "plan"),
      out: requiredOption(options, "out"),
    });
    console.log(JSON.stringify({ ok: true, out: resolve(requiredOption(options, "out")), model }, null, 2));
    return;
  }
  if (command === "validate-model") {
    const model = await readJson(resolve(requiredOption(options, "model")));
    const errors = validateReportModelValue(model, options["require-approved"] === "true");
    console.log(JSON.stringify({ ok: errors.length === 0, errors, modelHash: reportModelHash(model) }, null, 2));
    if (errors.length) process.exitCode = 1;
    return;
  }
  if (command === "approve-model") {
    const model = await approveReportModel(
      requiredOption(options, "model"),
      requiredOption(options, "reviewed-by"),
      options.plan,
    );
    console.log(JSON.stringify({ ok: true, approval: model.approval }, null, 2));
    return;
  }
  if (command === "confirm-discovery") {
    const confirmation = await createModelConfirmation({
      model: requiredOption(options, "model"),
      input: requiredOption(options, "input"),
      out: requiredOption(options, "out"),
      reviewedBy: requiredOption(options, "reviewed-by"),
    });
    console.log(JSON.stringify({ ok: true, confirmation }, null, 2));
    return;
  }
  if (command === "build-phase-context") {
    const phase = requiredOption(options, "phase");
    if (!["discovery", "modeling", "query", "script", "repair"].includes(phase)) {
      throw new Error(`--phase 必须是 discovery|modeling|query|script|repair，收到：${phase}`);
    }
    const context = await buildPhaseContext({
      phase: phase as "discovery" | "modeling" | "query" | "script" | "repair",
      plan: requiredOption(options, "plan"),
      out: requiredOption(options, "out"),
      ...(options.model ? { model: options.model } : {}),
      ...(options.confirmation ? { confirmation: options.confirmation } : {}),
      ...(options["query-id"] ? { queryId: options["query-id"] } : {}),
      ...(options.failure ? { failure: options.failure } : {}),
      ...(options["query-outputs"] ? { queryOutputs: options["query-outputs"] } : {}),
    });
    console.log(JSON.stringify({ ok: true, out: resolve(requiredOption(options, "out")), manifest: context.context_manifest }, null, 2));
    return;
  }
  if (command === "validate-stage") {
    const phase = requiredOption(options, "phase");
    if (!["discovery", "modeling", "query", "script"].includes(phase)) {
      throw new Error(`--phase 必须是 discovery|modeling|query|script，收到：${phase}`);
    }
    const result = await validateStagedArtifacts({
      phase: phase as StagedArtifactPhase,
      plan: requiredOption(options, "plan"),
      root: requiredOption(options, "root"),
      requireApprovedModel: options["require-approved-model"] === "true",
      ...(options["query-id"] ? { queryId: options["query-id"] } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "compile-model") {
    const model = await readJson(resolve(requiredOption(options, "model")));
    const errors = [...validateReportModelValue(model), ...calculationPlanErrors(model)];
    if (errors.length) throw new Error(`报表模型无法编译：${errors.join("；")}`);
    const compiled = compileCalculationPlan(model);
    const outPlan = resolve(requiredOption(options, "out-plan"));
    await writeJson(outPlan, compiled);
    await writeJson(resolve(requiredOption(options, "out-output-map")), {
      format_version: "1",
      output_map: compiled.output_map ?? [],
    });
    console.log(JSON.stringify({ ok: true, steps: compiled.steps?.length ?? 0, outputs: compiled.output_map?.length ?? 0, plan: outPlan }, null, 2));
    return;
  }
  if (command === "approve-staged-model") {
    const result = await approveStagedModel({
      plan: requiredOption(options, "plan"),
      root: requiredOption(options, "root"),
      reviewedBy: requiredOption(options, "reviewed-by"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "finalize-staged-model") {
    const result = await finalizeStagedModel({
      plan: requiredOption(options, "plan"),
      root: requiredOption(options, "root"),
      out: requiredOption(options, "out"),
      reviewedBy: requiredOption(options, "reviewed-by"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "finalize-staged") {
    const result = await finalizeStagedPackage({
      workspace: requiredOption(options, "workspace"),
      plan: requiredOption(options, "plan"),
      root: requiredOption(options, "root"),
      reviewedBy: requiredOption(options, "reviewed-by"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "approve-plan") {
    const plan = await approvePlan(
      requiredOption(options, "plan"),
      requiredOption(options, "reviewed-by"),
    );
    console.log(JSON.stringify({ ok: true, approval: plan.approval }, null, 2));
    return;
  }
  if (command === "generate") {
    const packageRoot = await generatePackage({
      workspace: requiredOption(options, "workspace"),
      plan: requiredOption(options, "plan"),
      out: options.out,
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          package: packageRoot,
          next_hint:
            "报表包已生成，可在测试页直接预览/导出；Runtime 每次请求都重新读取报表包，无需重启。",
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "validate") {
    const result = await validatePackage(requiredOption(options, "package"));
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) process.exitCode = 1;
    return;
  }
  if (command === "reseal") {
    const result = await resealPackage(requiredOption(options, "package"));
    const output = result.resealed
      ? {
          ...result,
          next_hint:
            "报表包已重新封包，可在测试页直接预览/导出；Runtime 每次请求都重新读取报表包，无需重启。",
        }
      : result;
    console.log(JSON.stringify(output, null, 2));
    if (!result.resealed) process.exitCode = 1;
    return;
  }
  console.log(usage());
  if (command) process.exitCode = 2;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  });
}
