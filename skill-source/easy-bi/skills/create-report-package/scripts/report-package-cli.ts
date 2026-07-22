#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
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
  return JSON.parse(await readFile(path, "utf8")) as JsonRecord;
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
    const raw =
      typeof requestedField === "string"
        ? requestedField
        : requestedField.field;
    const label =
      typeof requestedField === "string"
        ? requestedField
        : requestedField.label;
    // Optional per-field business description / 口径 authored in the config, to
    // help the AI understand exactly what the field means when generating the
    // package (e.g. 订单数总和 → "订单数量的总和"). Empty when absent.
    const fieldDescription =
      typeof requestedField === "object" &&
      requestedField !== null &&
      typeof requestedField.description === "string"
        ? requestedField.description.trim()
        : "";
    // Roles declared in the report config (output/filter/group). Empty ⇒
    // output-only. Recorded onto the resolved field as a hint for generation.
    const roles: string[] =
      typeof requestedField === "object" &&
      requestedField !== null &&
      Array.isArray(requestedField.roles)
        ? requestedField.roles
            .map((r: unknown) => String(r))
            .filter((r: string) => ["output", "filter", "group"].includes(r))
        : [];
    if (!raw) {
      blockers.push({
        code: "INVALID_REQUIRED_FIELD",
        message: `第 ${index + 1} 个报表字段没有 field`,
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
      blockers.push({
        code: "FIELD_NOT_FOUND",
        field: raw,
        suggestions,
        message: suggestions.length
          ? `知识库中未找到报表字段 ${raw}；你可能想要：${suggestions.join("、")}`
          : `知识库中未找到报表字段 ${raw}`,
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
    },
    execution_policy: {
      supported_modes: ["sync", "async"],
      default_mode: "sync",
      request_field: "executionMode",
      allow_request_selection: true,
      runtime_policy_ref: "default",
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
  // Append brand-new computed / sql_expression fields declared in the config.
  // These are transform- or expression-produced (环比/同比 deltas, ratios, …) and
  // do NOT exist in the report's required_fields lineage, so the override loop
  // above (which only mutates existing plan.fields by id) skips them. Only
  // computed / sql_expression kinds may be added here — a brand-new `column`
  // field must still flow through required_fields + knowledge resolution so its
  // lineage is locked, so we reject it. Existing ids are handled by the loop and
  // are not re-added.
  const existingFieldIds = new Set((plan.fields ?? []).map((f: JsonRecord) => f.id));
  const maxOrder = (plan.fields ?? []).reduce(
    (max: number, f: JsonRecord) => Math.max(max, Number(f.order ?? 0)),
    0,
  );
  let appendedOrder = maxOrder;
  for (const candidate of configuration.fields ?? []) {
    if (existingFieldIds.has(candidate.id)) continue;
    const kind = candidate.source?.kind;
    if (kind !== "computed" && kind !== "sql_expression") {
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
  const errors = validatePlanV2(plan);
  if (errors.length) {
    throw new Error(`报表计划校验失败：\n${errors.join("\n")}`);
  }
  plan.approval = {
    status: "approved",
    reviewed_by: reviewedBy,
    reviewed_at: new Date().toISOString(),
  };
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
  const system = (plan.system_conditions ?? []).map(
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
    system: [...plan.system_conditions, ...joinSystem, ...havingSystem],
    ...(plan.enrichments?.length ? { enrichments: buildEnrichmentBindings(plan) } : {}),
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
    if (groupFields.length) {
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
  for (const condition of plan.system_conditions ?? []) {
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

export async function generatePackage(options: {
  workspace: string;
  plan: string;
  out?: string;
}): Promise<string> {
  const workspace = resolve(options.workspace);
  const plan = await readJson(resolve(options.plan));
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
    signature: {
      status: "unsigned-development",
    },
  };
  const fields = {
    schema_version: "2",
    report_id: plan.report.id,
    fields: plan.fields.map((field: JsonRecord) => ({
      id: field.id,
      label: field.label,
      order: field.order,
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
    report_requirement: {
      id: plan.report.id,
      name: plan.report.name,
      fields: plan.fields.map((field: JsonRecord) => ({
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
        expected_columns: plan.fields.map((field: JsonRecord) => field.id),
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
  await updateReportIndex(workspace, manifest, packageRoot);
  return packageRoot;
}

export async function validatePackage(packageRootValue: string): Promise<{
  valid: boolean;
  errors: string[];
  warnings: string[];
}> {
  const packageRoot = resolve(packageRootValue);
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
  // A comparison (环比/同比) report buckets by the period column inside the group
  // transform, so its month-range filter (period_param) is intentionally NOT an
  // output field — exempt it from the "every filter maps to an output column"
  // rule. It still must have a real SQL binding (checked below).
  const comparisonPeriodParam =
    manifest.comparison?.enabled ? String(manifest.comparison.period_param ?? "") : "";
  for (const parameter of parameters.parameters ?? []) {
    if (!fieldIds.has(parameter.id) && parameter.id !== comparisonPeriodParam) {
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
    for (const field of fields.fields ?? []) {
      const kind = field.source?.kind;
      if (kind === "column" || kind === "boolean_flag") {
        // Both read a real DB column (boolean_flag folds it to 是/否 in the SELECT).
        if (!aliases.has(field.source?.alias)) {
          errors.push(`字段 ${field.id} 引用了知识锁之外的表别名`);
        } else if (!aliases.get(field.source.alias)?.has(String(field.source.field))) {
          errors.push(`字段 ${field.id} 引用了知识锁之外的列`);
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
    "  approve-plan --plan <file> --reviewed-by <name>",
    "  generate --workspace <dir> --plan <file> [--out <dir>]",
    "  validate --package <dir>",
    "  reseal --package <dir>   (开发包：手改后重算校验和并重新校验)",
  ].join("\n");
}

async function main(): Promise<void> {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "doctor") {
    console.log(
      JSON.stringify(
        {
          ok: true,
          node: process.version,
          package_format_version: PACKAGE_FORMAT_VERSION,
          plan_format_version: PLAN_FORMAT_VERSION,
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
        },
        null,
        2,
      ),
    );
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
