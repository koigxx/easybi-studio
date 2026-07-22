import { randomUUID } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import { mkdir, readFile, stat, unlink, } from "node:fs/promises";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ExcelJS from "exceljs";
import mysql from "mysql2";
import { FLAG_OPERATOR_SYMBOLS, hasSkeletonInjection, hasUnsafeSqlExpression, isBareQuotedColumnRef, isValidExistsSkeleton, } from "./sql-guard.js";
import { runScriptIsolated, ScriptExecutionError, } from "./script-runtime.js";
export class RuntimeError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
    }
}
async function readJson(path) {
    return JSON.parse(await readFile(path, "utf8"));
}
function relativeToWorkspace(workspace, value) {
    return resolve(workspace, value);
}
function latestVersion(entries) {
    return [...entries].sort((left, right) => String(right.version).localeCompare(String(left.version), undefined, {
        numeric: true,
        sensitivity: "base",
    }))[0];
}
export async function loadRuntimeContext(workspaceValue) {
    const workspace = resolve(workspaceValue);
    const config = await readJson(join(workspace, "toolkit", "config", "runtime.json"));
    return { workspace, config };
}
export async function listReports(workspaceValue) {
    const workspace = resolve(workspaceValue);
    const index = await readJson(join(workspace, "reports", "index.json"));
    const reports = Array.isArray(index.reports) ? index.reports : [];
    const byId = new Map();
    for (const report of reports) {
        const id = String(report.id ?? "");
        if (!id)
            continue;
        byId.set(id, [...(byId.get(id) ?? []), report]);
    }
    const latest = [...byId.values()].map((versions) => latestVersion(versions));
    const result = await Promise.all(latest.map(async (report) => {
        const loaded = await loadReportPackage(workspace, String(report.id), String(report.version));
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
                supportedModes: manifest.execution_policy?.supported_modes ?? ["sync", "async"],
                defaultMode: manifest.execution_policy?.default_mode ?? "sync",
            },
        };
    }));
    return result.sort((left, right) => String(left.name).localeCompare(String(right.name), "zh-CN"));
}
export async function loadReportPackage(workspaceValue, reportId, reportVersion) {
    const workspace = resolve(workspaceValue);
    const index = await readJson(join(workspace, "reports", "index.json"));
    const candidates = (index.reports ?? []).filter((entry) => entry.id === reportId && (!reportVersion || entry.version === reportVersion));
    if (!candidates.length) {
        throw new RuntimeError("REPORT_NOT_FOUND", `未找到报表：${reportId}`);
    }
    const entry = reportVersion ? candidates[0] : latestVersion(candidates);
    const root = join(workspace, "reports", String(entry.path));
    const manifest = await readJson(join(root, "report.manifest.json"));
    const packageFormat = String(manifest.report_package_format_version ?? "");
    if (packageFormat !== "2" && packageFormat !== "3") {
        throw new RuntimeError("UNSUPPORTED_REPORT_PACKAGE_FORMAT", `Runtime 不支持报表包格式 ${packageFormat}`);
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
        parameters: await readJson(join(root, entrypoints.parameters ?? "parameters.schema.json")),
        bindings: await readJson(join(root, entrypoints.bindings ?? "queries/bindings.json")),
        knowledgeLock: await readJson(join(root, entrypoints.knowledge_lock ?? "knowledge.lock.json")),
        sql: await readFile(join(root, entrypoints.query ?? "queries/main.sql"), "utf8"),
        enums: entrypoints.enums
            ? await readJson(join(root, String(entrypoints.enums))).catch(() => null)
            : null,
    };
}
export async function getReportParameters(workspace, reportId, reportVersion) {
    const report = await loadReportPackage(workspace, reportId, reportVersion);
    return {
        reportId: report.manifest.id,
        reportName: report.manifest.name,
        reportVersion: report.manifest.version,
        parameters: (report.parameters.parameters ?? []).map((parameter) => ({
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
        contextParameters: (report.manifest.context_bindings ?? []).map((binding) => ({
            id: binding.api_key,
            required: Boolean(binding.required),
            visible: false,
        })),
    };
}
function runtimeDialect(engine) {
    const value = String(engine ?? "").toLowerCase();
    if (value === "postgresql" || value === "postgres" || value === "pg") {
        return { id: "postgresql", quoteChar: '"' };
    }
    return { id: "mysql", quoteChar: "`" };
}
function safeExpression(value, dialect = { id: "mysql", quoteChar: "`" }) {
    const expression = String(value ?? "");
    const quote = dialect.quoteChar;
    // Allowed-char + banned-keyword checks are shared with the generation-time
    // guard (sql-guard.ts). The Runtime additionally requires the expression to
    // reference at least one dialect-quoted `alias.col`.
    const reference = new RegExp(`\\b[A-Za-z][A-Za-z0-9_]*\\.${quote}[A-Za-z0-9_$]+${quote}`);
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
function assertSafeSubquerySkeleton(prefix, suffix, _dialect) {
    // Shape + injection checks are shared with the generation-time guard
    // (sql-guard.ts). The Runtime additionally bans any SELECT/DML/DDL/UNION
    // keyword beyond the single leading `SELECT 1`.
    if (!isValidExistsSkeleton(prefix, suffix)) {
        throw new RuntimeError("UNSAFE_SUBQUERY", "EXISTS 子查询骨架结构无效");
    }
    const afterFirstSelect = prefix.replace(/^EXISTS \(SELECT 1 FROM /, "");
    if (hasSkeletonInjection(prefix) ||
        /\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|CALL|LOAD|OUTFILE|UNION)\b/i.test(afterFirstSelect)) {
        throw new RuntimeError("UNSAFE_SUBQUERY", "EXISTS 子查询骨架包含非法内容");
    }
}
function normalizedFilter(value, defaultOperator) {
    if (value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        ("value" in value || "operator" in value)) {
        const item = value;
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
function isFilterEmpty(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const record = value;
        if ("value" in record || "operator" in record) {
            return isFilterEmpty(record.value);
        }
        if ("from" in record || "to" in record) {
            return isEmpty(record.from) && isEmpty(record.to);
        }
    }
    return isEmpty(value);
}
function isEmpty(value) {
    return (value === undefined ||
        value === null ||
        value === "" ||
        (Array.isArray(value) && value.length === 0));
}
/**
 * Parse the `from` bound of a period filter value (a `{from,to}` range, possibly
 * wrapped as `{operator,value:{from,to}}`) into a `YYYY-MM` month key. Returns
 * null when there is no usable lower bound.
 */
function periodFromMonth(value) {
    let range = value;
    if (range && typeof range === "object" && !Array.isArray(range) && "value" in range) {
        range = range.value;
    }
    if (!range || typeof range !== "object" || Array.isArray(range))
        return null;
    const from = range.from;
    if (isEmpty(from))
        return null;
    const match = String(from).match(/^(\d{4})-(\d{2})/);
    if (!match)
        return null;
    return `${match[1]}-${match[2]}`;
}
/** Shift a `YYYY-MM` month key back by N months, returning `YYYY-MM-01`. */
function shiftMonthsBack(monthKey, months) {
    const [y, m] = monthKey.split("-").map((n) => Number(n));
    // Convert to a 0-based absolute month index, subtract, convert back — no Date
    // needed (Date.now/new Date are avoided; this is pure integer arithmetic).
    const total = y * 12 + (m - 1) - months;
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
export function widenComparisonFilters(comparison, filters) {
    if (!comparison?.enabled)
        return filters;
    const periodParam = String(comparison.period_param ?? "");
    if (!periodParam)
        return filters;
    const raw = filters[periodParam];
    const fromMonth = periodFromMonth(raw);
    if (!fromMonth)
        return filters;
    const modes = Array.isArray(comparison.modes) ? comparison.modes.map(String) : [];
    const lookback = Number(comparison.lookback_months ?? 1);
    const candidates = [];
    if (modes.includes("chain"))
        candidates.push(shiftMonthsBack(fromMonth, lookback));
    if (modes.includes("yoy"))
        candidates.push(shiftMonthsBack(fromMonth, 12));
    if (!candidates.length)
        return filters;
    // Earliest widened bound wins (covers all look-back needs in one query).
    const widened = candidates.sort()[0];
    // Preserve the original wrapper shape ({from,to} or {operator,value:{from,to}}).
    const applyFrom = (value) => {
        if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) {
            const rec = value;
            return { ...rec, value: applyFrom(rec.value) };
        }
        const rec = (value ?? {});
        return { ...rec, from: widened };
    };
    return { ...filters, [periodParam]: applyFrom(raw) };
}
function buildPredicate(expression, operator, value) {
    if (operator === "eq")
        return { sql: `${expression} = ?`, values: [value] };
    if (operator === "contains") {
        return { sql: `${expression} LIKE ? ESCAPE '\\\\'`, values: [`%${String(value).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`] };
    }
    if (operator === "in") {
        const values = Array.isArray(value) ? value : String(value).split(",").map((item) => item.trim()).filter(Boolean);
        if (!values.length)
            throw new RuntimeError("INVALID_FILTER", "in 查询值不能为空");
        return { sql: `${expression} IN (${values.map(() => "?").join(", ")})`, values };
    }
    if (operator === "between") {
        if (value &&
            typeof value === "object" &&
            !Array.isArray(value)) {
            const range = value;
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
            throw new RuntimeError("INVALID_FILTER", "between 查询值必须是 [开始, 结束] 或 {from, to}");
        }
        return { sql: `${expression} BETWEEN ? AND ?`, values: value };
    }
    if (operator === "gte")
        return { sql: `${expression} >= ?`, values: [value] };
    if (operator === "lte")
        return { sql: `${expression} <= ?`, values: [value] };
    throw new RuntimeError("INVALID_OPERATOR", `不支持的查询操作符：${operator}`);
}
/**
 * Coerce a boolean-flag filter value (the test page sends `true`/`false`, or the
 * strings `"true"`/`"false"` from a `<select>`) into a real boolean. Returns null
 * for anything unrecognised so the caller can skip the filter rather than guess.
 */
export function coerceFlagValue(value) {
    if (typeof value === "boolean")
        return value;
    if (value === "true" || value === "1" || value === 1)
        return true;
    if (value === "false" || value === "0" || value === 0)
        return false;
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
export function buildFlagPredicate(expression, operatorKey, threshold, truthy, quoteChar) {
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
export function compileSql(templateValue, bindings, filtersValue = {}, contextValue = {}, dialect = { id: "mysql", quoteChar: "`" }) {
    const parameters = new Map((bindings.parameters ?? []).map((binding) => [binding.id, binding]));
    const wherePredicates = [];
    const havingPredicates = [];
    const valueTokens = new Map();
    let valueTokenSequence = 0;
    const bindPredicateValues = (sql, values) => {
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
        if (binding.clause === "post_transform")
            continue;
        const raw = filtersValue[id];
        // Enforce required user filters (e.g. a mandatory create-time range). A range
        // object counts as empty when neither bound is provided.
        if (binding.required && isFilterEmpty(raw)) {
            throw new RuntimeError("MISSING_FILTER", `筛选项 ${id} 为必填项`);
        }
        if (isFilterEmpty(raw))
            continue;
        // Boolean-flag filter (是/否 over a folded numeric/status column, e.g.
        // receipt_count > 0). The predicate is built structurally from the trusted
        // truth descriptor (column + operator key + threshold) — the user only chooses
        // the direction 是/否. No user text or bound value reaches SQL. `false` (筛"否")
        // is a real filter, not "empty", so it survives isFilterEmpty above.
        if (binding.value_type === "boolean") {
            const flag = coerceFlagValue(raw && typeof raw === "object" && !Array.isArray(raw) && "value" in raw
                ? raw.value
                : raw);
            if (flag === null)
                continue;
            if (binding.clause !== "where") {
                throw new RuntimeError("INVALID_BINDING", `布尔筛选项 ${id} 必须使用 where clause`);
            }
            wherePredicates.push(buildFlagPredicate(String(binding.expression ?? ""), String(binding.flag_operator ?? ""), binding.flag_threshold, flag, dialect.quoteChar));
            continue;
        }
        const defaultOperator = binding.default_operator ??
            (binding.value_adapter === "contains"
                ? "contains"
                : binding.operators?.[0] ?? "eq");
        const normalized = normalizedFilter(raw, defaultOperator);
        if (!(binding.operators ?? []).includes(normalized.operator)) {
            throw new RuntimeError("INVALID_OPERATOR", `筛选项 ${id} 不支持操作符 ${normalized.operator}`);
        }
        if (isEmpty(normalized.value))
            continue;
        const predicate = buildPredicate(safeExpression(binding.expression, dialect), normalized.operator, normalized.value);
        if (!["where", "having", "exists_subquery"].includes(binding.clause)) {
            throw new RuntimeError("INVALID_BINDING", `筛选项 ${id} 必须显式声明 where/having/exists_subquery clause`);
        }
        if (binding.clause === "having") {
            havingPredicates.push(bindPredicateValues(predicate.sql, predicate.values));
        }
        else if (binding.clause === "exists_subquery") {
            // The subquery skeleton is trusted (built at generation time from
            // knowledge, never user input). We only wrap the value predicate — whose
            // value is still bound as a `?` — so no user text ever enters raw SQL.
            const prefix = String(binding.subquery_prefix ?? "");
            const suffix = String(binding.subquery_suffix ?? "");
            assertSafeSubquerySkeleton(prefix, suffix, dialect);
            const inner = bindPredicateValues(predicate.sql, predicate.values);
            wherePredicates.push(`${prefix}${inner}${suffix}`);
        }
        else {
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
        const predicate = buildPredicate(safeExpression(binding.expression, dialect), binding.operator ?? "eq", raw);
        wherePredicates.push(bindPredicateValues(predicate.sql, predicate.values));
    }
    let template = templateValue;
    for (const binding of bindings.system ?? []) {
        const token = `:${String(binding.id)}`;
        const occurrences = template.split(token).length - 1;
        if (occurrences !== 1) {
            throw new RuntimeError("INVALID_SYSTEM_BINDING", `固定条件 ${binding.id} 在 SQL 中必须且只能出现一次`);
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
    const havingMarkerCount = (template.match(/\/\*\s*EASYBI_HAVING_FILTERS\s*\*\//gi) ?? []).length;
    if (havingPredicates.length && havingMarkerCount !== 1) {
        throw new RuntimeError("INVALID_SQL_TEMPLATE", "HAVING 筛选必须且只能包含一个 HAVING 占位标记");
    }
    const havingFragment = havingPredicates.length
        ? `AND ${havingPredicates.join("\n  AND ")}`
        : "";
    const compiledTemplate = template
        .replace(/\/\*\s*EASYBI_FILTERS\s*\*\//i, fragment)
        .replace(/\/\*\s*EASYBI_HAVING_FILTERS\s*\*\//i, havingFragment);
    const values = [];
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
function appendPreviewLimit(sql, limit) {
    const trimmed = sql.replace(/\s*;\s*$/, "").replace(/\s+$/, "");
    return `${trimmed}\nLIMIT ${Math.trunc(limit)}`;
}
/** True when any active (non-empty) filter targets a post_transform binding, which
 * drops output rows AFTER the query — a SQL LIMIT would then under-fill the preview. */
function hasActivePostTransformFilter(bindings, filtersValue) {
    for (const binding of bindings.parameters ?? []) {
        if (binding.clause !== "post_transform")
            continue;
        if (!isFilterEmpty(filtersValue[binding.id]))
            return true;
    }
    return false;
}
/** Parse the two bounds of a numeric range filter value into finite numbers or
 * null. Accepts the shapes the test page sends: `{from,to}`, `{operator,value:{from,to}}`,
 * and a bare `[from, to]` array. A missing/blank bound → null (one-sided range). */
function numericRangeBounds(value) {
    let range = value;
    if (range &&
        typeof range === "object" &&
        !Array.isArray(range) &&
        "value" in range) {
        range = range.value;
    }
    const toNum = (v) => {
        if (isEmpty(v))
            return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };
    if (Array.isArray(range)) {
        return { from: toNum(range[0]), to: toNum(range[1]) };
    }
    if (range && typeof range === "object") {
        const rec = range;
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
export function buildPostTransformFilter(bindings, filtersValue = {}) {
    const active = [];
    for (const binding of bindings.parameters ?? []) {
        if (binding.clause !== "post_transform")
            continue;
        const raw = filtersValue[binding.id];
        if (isFilterEmpty(raw)) {
            if (binding.required) {
                throw new RuntimeError("MISSING_FILTER", `筛选项 ${binding.id} 为必填项`);
            }
            continue;
        }
        const { from, to } = numericRangeBounds(raw);
        if (from === null && to === null)
            continue; // Both bounds unparseable → no filter.
        active.push({ id: binding.id, from, to });
    }
    if (!active.length)
        return () => true;
    return (outputRow) => {
        for (const filter of active) {
            const cell = outputRow[filter.id];
            const value = Number(cell);
            // A non-numeric / null computed value can't satisfy a numeric range.
            if (!Number.isFinite(value))
                return false;
            if (filter.from !== null && value < filter.from)
                return false;
            if (filter.to !== null && value > filter.to)
                return false;
        }
        return true;
    };
}
/**
 * Order enrichments so every one runs AFTER the enrichment its key depends on
 * (key_source="enrichment"). Kahn's algorithm; throws on a cycle. Enrichments
 * whose key comes from the main query have no dependency and come first.
 */
export function topoSortEnrichments(enrichments) {
    const byId = new Map(enrichments.map((e) => [e.id, e]));
    const indegree = new Map();
    const dependents = new Map();
    for (const e of enrichments) {
        indegree.set(e.id, 0);
        dependents.set(e.id, []);
    }
    for (const e of enrichments) {
        if (e.key_source === "enrichment" && e.key_source_id) {
            if (!byId.has(e.key_source_id)) {
                throw new RuntimeError("INVALID_ENRICHMENT", `enrichment ${e.id} 依赖不存在的上游 ${e.key_source_id}`);
            }
            indegree.set(e.id, (indegree.get(e.id) ?? 0) + 1);
            dependents.get(e.key_source_id).push(e.id);
        }
    }
    const queue = enrichments.filter((e) => (indegree.get(e.id) ?? 0) === 0).map((e) => e.id);
    const ordered = [];
    while (queue.length) {
        const id = queue.shift();
        ordered.push(byId.get(id));
        for (const dep of dependents.get(id) ?? []) {
            const next = (indegree.get(dep) ?? 0) - 1;
            indegree.set(dep, next);
            if (next === 0)
                queue.push(dep);
        }
    }
    if (ordered.length !== enrichments.length) {
        throw new RuntimeError("INVALID_ENRICHMENT", "enrichment 依赖存在环");
    }
    return ordered;
}
/** Normalize a join key to a stable string key (null/undefined → null, no match). */
function enrichmentKeyText(value) {
    if (value === null || value === undefined || value === "")
        return null;
    return String(value);
}
/** Fold multiple child rows sharing one key into a single value per the aggregate spec. */
export function aggregateMany(rows, selectId, lookupField, aggregate) {
    const values = rows.map((r) => r[lookupField]);
    switch (aggregate.kind) {
        case "count":
            return values.length;
        case "first":
            return values.length ? values[0] : null;
        case "sum": {
            let sum = 0;
            for (const v of values)
                sum += Number(v ?? 0);
            return sum;
        }
        case "max":
        case "min": {
            const nums = values.map((v) => Number(v)).filter((n) => Number.isFinite(n));
            if (!nums.length)
                return null;
            return aggregate.kind === "max" ? Math.max(...nums) : Math.min(...nums);
        }
        case "group_concat":
        default: {
            let items = values
                .filter((v) => v !== null && v !== undefined && v !== "")
                .map((v) => String(v));
            if (aggregate.distinct)
                items = [...new Set(items)];
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
export function buildEnrichmentValueMap(binding, lookupRows, selectLookupFields) {
    const grouped = new Map();
    for (const row of lookupRows) {
        const key = enrichmentKeyText(row[binding.lookup_key_alias]);
        if (key === null)
            continue;
        grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    const values = new Map();
    const multiHitKeys = [];
    for (const [key, childRows] of grouped) {
        const merged = {};
        if (binding.cardinality === "many") {
            const aggregate = binding.aggregate ?? { kind: "group_concat" };
            for (const selectId of binding.select_ids) {
                merged[selectId] = aggregateMany(childRows, selectId, selectLookupFields[selectId] ?? selectId, aggregate);
            }
        }
        else {
            if (childRows.length > 1)
                multiHitKeys.push(key);
            const first = childRows[0];
            for (const selectId of binding.select_ids) {
                merged[selectId] = first[selectLookupFields[selectId] ?? selectId] ?? null;
            }
        }
        values.set(key, merged);
    }
    return { values, multiHitKeys };
}
/** The value attached when a main row has no matching lookup row. */
function enrichmentMissingValue(binding, selectId) {
    if (binding.cardinality === "many" && binding.aggregate?.kind === "count")
        return 0;
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
export function applyEnrichmentToBatch(batch, binding, valueMap) {
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
export function collectBatchKeys(batch, mainKeyField) {
    const seen = new Set();
    const keys = [];
    for (const row of batch) {
        const raw = row[mainKeyField];
        const key = enrichmentKeyText(raw);
        if (key === null || seen.has(key))
            continue;
        seen.add(key);
        keys.push(raw);
    }
    return keys;
}
export function runControlQuery(connection, sql) {
    return new Promise((resolvePromise, rejectPromise) => {
        connection.query(sql, (error) => {
            if (error)
                rejectPromise(error);
            else
                resolvePromise();
        });
    });
}
async function resolveTransform(report) {
    const mode = report.manifest.custom_logic?.mode;
    if (!["identity", "sql", "row", "group"].includes(mode)) {
        throw new RuntimeError("INVALID_TRANSFORM", "v2 报表包必须显式声明 custom_logic.mode");
    }
    if (mode === "identity" || mode === "sql")
        return { mode: "identity" };
    const relativePath = report.manifest.entrypoints?.transform;
    if (!relativePath || !String(relativePath).endsWith(".mjs")) {
        throw new RuntimeError("TRANSFORM_NOT_COMPILED", "自定义 Transform 必须提供编译后的 .mjs 入口");
    }
    const module = (await import(`${pathToFileURL(join(report.root, relativePath)).href}?v=${Date.now()}`));
    if (mode === "group") {
        if (typeof module.transformGroup !== "function") {
            throw new RuntimeError("INVALID_TRANSFORM", "分组 Transform 未导出 transformGroup 函数");
        }
        const groupKeys = report.manifest.custom_logic?.group_keys ?? [];
        if (!Array.isArray(groupKeys) || groupKeys.length === 0) {
            throw new RuntimeError("INVALID_TRANSFORM", "分组 Transform 缺少 group_keys");
        }
        return {
            mode: "group",
            groupKeys,
            maxGroupRows: Number(report.manifest.custom_logic?.max_group_rows ?? 100000),
            transformGroup: module.transformGroup,
        };
    }
    if (typeof module.transformRow !== "function") {
        throw new RuntimeError("INVALID_TRANSFORM", "Transform 未导出 transformRow 函数");
    }
    return {
        mode: "row",
        transformRow: module.transformRow,
    };
}
function connectionProfile(config, report) {
    const profileId = report.knowledgeLock.sources?.[0]?.profile_id;
    const profile = config.connections?.database_profiles?.find((item) => item.id === profileId);
    if (!profile) {
        throw new RuntimeError("DATABASE_PROFILE_NOT_FOUND", `未找到数据库连接：${profileId}`);
    }
    return profile;
}
function profilePassword(profile) {
    const password = profile.password ??
        (profile.password_env ? process.env[String(profile.password_env)] : undefined);
    if (password === undefined) {
        throw new RuntimeError("DATABASE_PASSWORD_MISSING", `数据库 ${profile.id} 未配置密码`);
    }
    return String(password);
}
function connect(profile, database) {
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
            if (error)
                rejectPromise(error);
            else
                resolvePromise(connection);
        });
    });
}
function endConnection(connection) {
    return new Promise((resolvePromise) => connection.end(() => resolvePromise()));
}
async function createMysqlAdapter(profile, database) {
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
            return query.stream({ highWaterMark: 128 });
        },
        async queryAll(sql, values, queryTimeoutMs) {
            return new Promise((resolvePromise, rejectPromise) => {
                connection.query({ sql, values, timeout: queryTimeoutMs, rowsAsArray: false }, (error, result) => {
                    if (error)
                        rejectPromise(error);
                    else
                        resolvePromise(result ?? []);
                });
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
function toDollarPlaceholders(sql) {
    let index = 0;
    return sql.replace(/\?/g, () => `$${(index += 1)}`);
}
async function createPostgresAdapter(profile, database) {
    const password = profilePassword(profile);
    const moduleName = "pg";
    const imported = (await import(moduleName));
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
            await client.query(`SET statement_timeout = ${Math.max(1, Math.floor(queryTimeoutMs))}`);
            const result = await client.query(toDollarPlaceholders(sql), values);
            const rows = (result?.rows ?? []);
            return (async function* () {
                for (const row of rows)
                    yield row;
            })();
        },
        async queryAll(sql, values, queryTimeoutMs) {
            await client.query(`SET statement_timeout = ${Math.max(1, Math.floor(queryTimeoutMs))}`);
            const result = await client.query(toDollarPlaceholders(sql), values);
            return (result?.rows ?? []);
        },
        async rollback() {
            await client.query("ROLLBACK");
        },
        async close() {
            await client.end();
        },
    };
}
async function createQueryAdapter(dialect, profile, database) {
    return dialect.id === "postgresql"
        ? createPostgresAdapter(profile, database)
        : createMysqlAdapter(profile, database);
}
class AsyncRowQueue {
    capacity;
    rows = [];
    readers = [];
    writers = [];
    ended = false;
    failure = null;
    constructor(capacity = 256) {
        this.capacity = capacity;
    }
    async push(row) {
        if (this.failure)
            throw this.failure;
        if (this.ended)
            throw new RuntimeError("SCRIPT_CANCELED", "脚本输出流已关闭");
        const reader = this.readers.shift();
        if (reader) {
            reader.resolve({ value: row, done: false });
            return;
        }
        while (this.rows.length >= this.capacity && !this.ended && !this.failure) {
            await new Promise((resolvePromise) => this.writers.push(resolvePromise));
        }
        if (this.failure)
            throw this.failure;
        if (this.ended)
            throw new RuntimeError("SCRIPT_CANCELED", "脚本输出流已关闭");
        this.rows.push(row);
    }
    end() {
        this.ended = true;
        for (const reader of this.readers.splice(0))
            reader.resolve({ value: undefined, done: true });
        for (const writer of this.writers.splice(0))
            writer();
    }
    fail(error) {
        this.failure = error;
        for (const reader of this.readers.splice(0))
            reader.reject(error);
        for (const writer of this.writers.splice(0))
            writer();
    }
    [Symbol.asyncIterator]() {
        return {
            next: async () => {
                if (this.rows.length) {
                    const value = this.rows.shift();
                    this.writers.shift()?.();
                    return { value, done: false };
                }
                if (this.failure)
                    throw this.failure;
                if (this.ended)
                    return { value: undefined, done: true };
                return new Promise((resolvePromise, rejectPromise) => {
                    this.readers.push({ resolve: resolvePromise, reject: rejectPromise });
                });
            },
            return: async () => {
                this.end();
                return { value: undefined, done: true };
            },
        };
    }
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw new RuntimeError("REQUEST_CANCELED", "报表执行已取消");
}
async function createScriptRows(options) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    throwIfAborted(options.signal);
    const queue = new AsyncRowQueue(256);
    const appConfig = await readJson(join(options.workspace, "config", "easy-bi.json"));
    const activeAdapters = new Set();
    controller.signal.addEventListener("abort", () => {
        for (const adapter of activeAdapters)
            void adapter.close().catch(() => undefined);
    }, { once: true });
    const queryById = new Map((options.report.scriptQueries ?? []).map((query) => [String(query.id), query]));
    const resolveQuery = async (id, expectedMode) => {
        throwIfAborted(controller.signal);
        const definition = queryById.get(id);
        if (!definition)
            throw new RuntimeError("SCRIPT_QUERY_NOT_FOUND", `脚本查询不存在：${id}`);
        if (definition.mode !== expectedMode) {
            throw new RuntimeError("SCRIPT_QUERY_MODE_MISMATCH", `脚本查询 ${id} 声明为 ${definition.mode}，不能通过 ${expectedMode} 调用`);
        }
        const profile = appConfig.connections?.database_profiles?.find((candidate) => candidate.id === definition.profile_id);
        if (!profile)
            throw new RuntimeError("DATABASE_PROFILE_NOT_FOUND", `未找到数据库连接：${definition.profile_id}`);
        const sqlPath = String(definition.sql ?? "");
        if (!/^queries\/[a-z0-9_-]+\.sql$/.test(sqlPath)) {
            throw new RuntimeError("INVALID_SCRIPT_QUERY_PATH", `脚本查询路径无效：${sqlPath}`);
        }
        return {
            definition,
            sql: await readFile(join(options.report.root, sqlPath), "utf8"),
            profile,
            dialect: runtimeDialect(profile.connector_id ?? options.report.manifest.sql_dialect ?? "mysql"),
        };
    };
    const handlers = {
        async queryStream(queryId, values) {
            const resolved = await resolveQuery(queryId, "stream");
            const adapter = await createQueryAdapter(resolved.dialect, resolved.profile, String(resolved.definition.database));
            activeAdapters.add(adapter);
            await adapter.beginReadOnly();
            const source = await adapter.rows(resolved.sql, values, Number(options.policy.query_timeout_seconds ?? 600) * 1000);
            return (async function* () {
                try {
                    for await (const row of source) {
                        throwIfAborted(controller.signal);
                        yield row;
                    }
                    await adapter.rollback();
                }
                finally {
                    activeAdapters.delete(adapter);
                    await adapter.close().catch(() => undefined);
                }
            })();
        },
        async loadIndex(queryId, values) {
            const resolved = await resolveQuery(queryId, "index");
            const adapter = await createQueryAdapter(resolved.dialect, resolved.profile, String(resolved.definition.database));
            activeAdapters.add(adapter);
            try {
                await adapter.beginReadOnly();
                const rows = await adapter.queryAll(resolved.sql, values, Number(options.policy.query_timeout_seconds ?? 600) * 1000);
                await adapter.rollback();
                return rows;
            }
            finally {
                activeAdapters.delete(adapter);
                await adapter.close().catch(() => undefined);
            }
        },
        async batchLookup(queryId, keys, values) {
            const resolved = await resolveQuery(queryId, "batch");
            const placeholders = Array.from({ length: Math.max(1, keys.length) }, () => "?").join(", ");
            const sql = resolved.sql.replace(/\/\*\s*KEYS\s*\*\//, placeholders);
            const adapter = await createQueryAdapter(resolved.dialect, resolved.profile, String(resolved.definition.database));
            activeAdapters.add(adapter);
            try {
                await adapter.beginReadOnly();
                const rows = await adapter.queryAll(sql, [...keys, ...values], Number(options.policy.query_timeout_seconds ?? 600) * 1000);
                await adapter.rollback();
                return rows;
            }
            finally {
                activeAdapters.delete(adapter);
                await adapter.close().catch(() => undefined);
            }
        },
    };
    const declaredBudget = options.report.manifest.resource_budget ?? {};
    const ceiling = options.policy.script_budget_ceiling ?? {};
    const effectiveBudget = Object.fromEntries(Object.entries(declaredBudget).map(([name, value]) => [
        name,
        ceiling[name] == null ? value : Math.min(Number(value), Number(ceiling[name])),
    ]));
    const completion = runScriptIsolated({
        scriptPath: join(options.report.root, String(options.report.manifest.entrypoints?.script ?? "scripts/report.mjs")),
        filters: options.filters,
        context: options.context,
        budget: effectiveBudget,
        handlers,
        onEmit: (row) => queue.push(row),
        signal: controller.signal,
    }).then((result) => {
        queue.end();
        return result;
    }, (error) => {
        const mapped = error instanceof ScriptExecutionError
            ? new RuntimeError(error.code, error.message)
            : error instanceof Error ? error : new Error(String(error));
        queue.fail(mapped);
        throw mapped;
    }).finally(() => options.signal?.removeEventListener("abort", abort));
    return { rows: queue, completion, cancel: () => controller.abort() };
}
function safeFileName(value) {
    return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 160);
}
function timestamp() {
    return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
}
function createSheet(workbook, report, sheetNumber) {
    const sheet = workbook.addWorksheet(sheetNumber === 1 ? "数据" : `数据${sheetNumber}`, { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.columns = (report.fields.fields ?? []).map((field) => ({
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
export async function writeWorkbookRows(report, rows, output, policy, transform = { mode: "identity" }, startedAt = Date.now(), postFilter = () => true) {
    // Per-field enum code→中文 map (empty when the package has no enums file).
    const enumByField = report.enums?.byField ?? {};
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
        filename: output,
        useStyles: true,
        useSharedStrings: false,
    });
    let sheetNumber = 1;
    let rowInSheet = 0;
    let rowCount = 0;
    let sheet = createSheet(workbook, report, sheetNumber);
    const pipeline = typeof transform === "function"
        ? { mode: "row", transformRow: transform }
        : transform;
    const appendOutputRow = (transformed) => {
        if (Date.now() - startedAt > Number(policy.total_timeout_seconds ?? 900) * 1000) {
            throw new RuntimeError("TOTAL_TIMEOUT", "导出超过总时限");
        }
        // Post-transform range filter: drop rows whose computed value is out of range.
        if (!postFilter(transformed))
            return;
        if (rowInSheet >= Number(policy.max_rows_per_sheet ?? 1_048_575)) {
            if (sheetNumber >= Number(policy.max_sheets_per_workbook ?? 2)) {
                throw new RuntimeError("SHEET_LIMIT_EXCEEDED", "数据超过最多 2 个 Sheet 的容量");
            }
            sheet.commit();
            sheetNumber += 1;
            rowInSheet = 0;
            sheet = createSheet(workbook, report, sheetNumber);
        }
        const outputRow = {};
        for (const field of report.fields.fields ?? []) {
            const raw = transformed[field.id];
            const map = enumByField[field.id];
            if (map &&
                raw != null &&
                Object.prototype.hasOwnProperty.call(map, String(raw))) {
                outputRow[field.id] = map[String(raw)];
            }
            else {
                outputRow[field.id] = raw;
            }
        }
        sheet.addRow(outputRow).commit();
        rowInSheet += 1;
        rowCount += 1;
    };
    try {
        if (pipeline.mode === "group") {
            let groupRows = [];
            let groupKeyText;
            let groupKey = [];
            const flush = () => {
                if (!groupRows.length)
                    return;
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
                    throw new RuntimeError("GROUP_ROW_LIMIT_EXCEEDED", `单个计算分组超过 ${pipeline.maxGroupRows} 行`);
                }
            }
            flush();
        }
        else {
            for await (const rawRow of rows) {
                appendOutputRow(pipeline.mode === "row" ? pipeline.transformRow(rawRow) : rawRow);
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
    }
    catch (error) {
        try {
            await workbook.commit();
        }
        catch {
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
async function prepareSyncQuery(workspaceValue, request, options = {}) {
    const { workspace, config } = await loadRuntimeContext(workspaceValue);
    const report = await loadReportPackage(workspace, request.reportId, request.reportVersion);
    const policy = options.policy ?? config.execution_strategy?.sync;
    if (!policy?.enabled)
        throw new RuntimeError("SYNC_DISABLED", "同步查询/导出未启用");
    if ((report.fields.fields ?? []).length > policy.max_columns) {
        throw new RuntimeError("TOO_MANY_COLUMNS", "报表列数超过运行时限制");
    }
    // Enrichment (batch secondary-query) bindings, ordered so a chained enrichment
    // runs after the one it depends on. Only output-stage merge is supported, so a
    // group transform + enrichment is rejected (buffer/batch boundaries would cross).
    const enrichmentsRaw = (report.bindings.enrichments ?? []);
    const enrichments = enrichmentsRaw.length ? topoSortEnrichments(enrichmentsRaw) : [];
    if (enrichments.length && report.manifest.custom_logic?.mode === "group") {
        throw new RuntimeError("ENRICHMENT_UNSUPPORTED", "分组(group)报表暂不支持 enrichment 二次查询合并");
    }
    // Widen the period filter's lower bound backward for comparison (环比/同比) so a
    // single query also returns the look-back window(s) the group transform needs.
    const filters = widenComparisonFilters(report.manifest.comparison, request.filters ?? {});
    const context = { ...(request.context ?? {}) };
    if (!isEmpty(request.tenantId) && isEmpty(context.tenantId)) {
        context.tenantId = request.tenantId;
    }
    const source = report.knowledgeLock.sources?.[0];
    const appConfig = await readJson(join(workspace, "config", "easy-bi.json"));
    const profile = connectionProfile(appConfig, report);
    // Engine comes from the package manifest (default mysql for older packages);
    // fall back to the resolved profile's connector_id when the manifest omits it.
    const dialect = runtimeDialect(report.manifest.sql_dialect ?? profile.connector_id ?? "mysql");
    const compiled = compileSql(report.sql, report.bindings, filters, context, dialect);
    // Multi-entity grouped queries: compile each sibling's SQL with the SAME filters
    // (the shared time range binds to each sibling's own time column) + context, so
    // the runtime can execute them and full-outer-merge on merge_keys. Mutually
    // exclusive with a group transform / enrichment (rejected at generation time; we
    // re-guard below for defense in depth).
    let groupQueries = null;
    const gqManifest = report.manifest.group_queries;
    if (gqManifest?.queries?.length) {
        if (report.manifest.custom_logic?.mode === "group" || enrichments.length) {
            throw new RuntimeError("GROUP_QUERIES_UNSUPPORTED", "group_queries 与内存分组 transform / enrichment 互斥");
        }
        const compiledSiblings = [];
        for (const gq of gqManifest.queries) {
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
const identityTransform = { mode: "identity" };
/** Adapt an in-memory row array to the AsyncIterable the collector/writer expect. */
async function* arrayToAsyncIterable(rows) {
    for (const row of rows)
        yield row;
}
export async function runGroupQueriesMerged(adapter, main, groupQueries, queryTimeoutMs, numericFieldIds, maxMergedGroups = 100000) {
    if (!Number.isInteger(maxMergedGroups) || maxMergedGroups < 1) {
        throw new RuntimeError("INVALID_RUNTIME_POLICY", "max_merged_groups 必须是正整数");
    }
    const { mergeKeys } = groupQueries;
    const keyOf = (row) => JSON.stringify(mergeKeys.map((k) => row[k] ?? null));
    const merged = new Map();
    const order = [];
    const mergeRows = (rows) => {
        for (const row of rows) {
            const key = keyOf(row);
            let target = merged.get(key);
            if (!target) {
                if (merged.size >= maxMergedGroups) {
                    throw new RuntimeError("GROUP_QUERY_LIMIT_EXCEEDED", `多查询分组结果超过上限 ${maxMergedGroups}，请缩小筛选范围或提高 max_merged_groups`);
                }
                target = {};
                // Seed the merge-key columns so every merged row carries the dimension.
                for (const k of mergeKeys)
                    target[k] = row[k] ?? null;
                merged.set(key, target);
                order.push(key);
            }
            // Copy every non-key column; later queries never overwrite the shared key.
            for (const [col, value] of Object.entries(row)) {
                if (mergeKeys.includes(col))
                    continue;
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
    const result = order.map((key) => merged.get(key));
    for (const row of result) {
        for (const id of numericFieldIds) {
            if (row[id] == null)
                row[id] = 0;
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
export async function* enrichBatched(rows, enrichments, adapter, queryTimeoutMs, batchSize, warningsSink) {
    // Map every enrichment's select id → its lookup source column (for aggregation).
    const selectLookupByEnrichment = new Map();
    for (const e of enrichments) {
        // sql_template aliases each select column to its select id already, so the
        // lookup row is keyed by select id; identity map keeps buildEnrichmentValueMap general.
        selectLookupByEnrichment.set(e.id, Object.fromEntries(e.select_ids.map((id) => [id, id])));
    }
    const processBatch = async (batch) => {
        for (const binding of enrichments) {
            const keys = collectBatchKeys(batch, binding.main_key_field);
            let valueMap = new Map();
            if (keys.length) {
                const sql = expandKeysPlaceholder(binding.sql_template, keys.length);
                const lookupRows = await adapter.queryAll(sql, keys, queryTimeoutMs);
                const built = buildEnrichmentValueMap(binding, lookupRows, selectLookupByEnrichment.get(binding.id) ?? {});
                valueMap = built.values;
                if (built.multiHitKeys.length) {
                    warningsSink.push(`enrichment ${binding.id}(cardinality=one) 有 ${built.multiHitKeys.length} 个键命中多行，已取第一条`);
                }
            }
            applyEnrichmentToBatch(batch, binding, valueMap);
        }
    };
    let batch = [];
    for await (const row of rows) {
        batch.push(row);
        if (batch.length >= batchSize) {
            await processBatch(batch);
            for (const r of batch)
                yield r;
            batch = [];
        }
    }
    if (batch.length) {
        await processBatch(batch);
        for (const r of batch)
            yield r;
    }
}
/** Expand the single `/* KEYS *​/` marker in an enrichment sql_template into
 * `?, ?, …` for `count` bound values. The template is built at generation time
 * from knowledge (never user input); only the count of placeholders is dynamic. */
function expandKeysPlaceholder(template, count) {
    const placeholders = Array.from({ length: Math.max(1, count) }, () => "?").join(", ");
    return template.replace(/\/\*\s*KEYS\s*\*\//, placeholders);
}
/** Report output columns as {id, label, description?} — the 中文 headers a caller
 * (Studio 测试页预览) renders as table headers. Description is included when the
 * package field carries one. */
export function outputColumns(report) {
    return (report.fields.fields ?? []).map((field) => ({
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
export async function collectRows(report, rows, transform, options) {
    const enumByField = report.enums?.byField ?? {};
    const fields = report.fields.fields ?? [];
    const out = [];
    const postFilter = options.postFilter ?? (() => true);
    let truncated = false;
    const pipeline = typeof transform === "function"
        ? { mode: "row", transformRow: transform }
        : transform;
    // Returns false once the row cap is hit, signalling callers to stop consuming.
    const appendOutputRow = (transformed) => {
        if (Date.now() - options.startedAt > options.totalTimeoutSeconds * 1000) {
            throw new RuntimeError("TOTAL_TIMEOUT", "查询超过总时限");
        }
        // Post-transform range filter: the computed value exists now, so drop the row
        // if it falls outside the requested range. Checked BEFORE the cap so filtered
        // rows don't consume the preview budget.
        if (!postFilter(transformed))
            return true;
        if (out.length >= options.maxRows) {
            truncated = true;
            return false;
        }
        const row = {};
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
        let groupRows = [];
        let groupKeyText;
        let groupKey = [];
        const flush = () => {
            if (!groupRows.length)
                return true;
            const transformed = pipeline.transformGroup(groupRows, { groupKey });
            groupRows = [];
            for (const row of Array.isArray(transformed) ? transformed : [transformed]) {
                if (!appendOutputRow(row))
                    return false;
            }
            return true;
        };
        for await (const rawRow of rows) {
            const nextKey = pipeline.groupKeys.map((key) => rawRow[key]);
            const nextKeyText = JSON.stringify(nextKey);
            if (groupKeyText !== undefined && nextKeyText !== groupKeyText) {
                if (!flush())
                    break;
            }
            if (!groupRows.length) {
                groupKeyText = nextKeyText;
                groupKey = nextKey;
            }
            groupRows.push(rawRow);
            if (groupRows.length > pipeline.maxGroupRows) {
                throw new RuntimeError("GROUP_ROW_LIMIT_EXCEEDED", `单个计算分组超过 ${pipeline.maxGroupRows} 行`);
            }
        }
        flush();
    }
    else {
        for await (const rawRow of rows) {
            const kept = appendOutputRow(pipeline.mode === "row" ? pipeline.transformRow(rawRow) : rawRow);
            if (!kept)
                break;
        }
    }
    return { rows: out, rowCount: out.length, truncated };
}
async function queryScriptSync(workspaceValue, request, options = {}) {
    const startedAt = Date.now();
    const { workspace, config } = await loadRuntimeContext(workspaceValue);
    const report = await loadReportPackage(workspace, request.reportId, request.reportVersion);
    const policy = options.policy ?? config.execution_strategy?.sync;
    if (!policy?.enabled)
        throw new RuntimeError("SYNC_DISABLED", "同步查询/导出未启用");
    const policyMax = Number(policy.preview_max_rows ?? 1000);
    const requested = Number.isFinite(Number(request.limit)) ? Number(request.limit) : policyMax;
    const maxRows = Math.max(1, Math.min(policyMax, requested > 0 ? requested : policyMax));
    const context = { ...(request.context ?? {}) };
    if (!isEmpty(request.tenantId) && isEmpty(context.tenantId))
        context.tenantId = request.tenantId;
    const execution = await createScriptRows({
        workspace,
        report,
        filters: request.filters ?? {},
        context,
        policy,
        signal: options.signal,
    });
    const collected = await collectRows(report, execution.rows, identityTransform, {
        maxRows,
        startedAt,
        totalTimeoutSeconds: Math.min(Number(policy.total_timeout_seconds ?? 900), Number(report.manifest.resource_budget?.timeout_seconds ?? 300)),
    });
    if (collected.truncated) {
        execution.cancel();
        await execution.completion.catch(() => undefined);
    }
    else {
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
async function exportScriptSync(workspaceValue, request, options = {}) {
    const startedAt = Date.now();
    const { workspace, config } = await loadRuntimeContext(workspaceValue);
    const report = await loadReportPackage(workspace, request.reportId, request.reportVersion);
    const policy = options.policy ?? config.execution_strategy?.sync;
    if (!policy?.enabled)
        throw new RuntimeError("SYNC_DISABLED", "同步查询/导出未启用");
    const outputDirectory = relativeToWorkspace(workspace, config.storage?.local_output_directory ?? "outputs/files");
    await mkdir(outputDirectory, { recursive: true });
    const output = resolve(options.output ?? join(outputDirectory, safeFileName(`${report.manifest.name}_${timestamp()}.xlsx`)));
    await mkdir(dirname(output), { recursive: true });
    const context = { ...(request.context ?? {}) };
    if (!isEmpty(request.tenantId) && isEmpty(context.tenantId))
        context.tenantId = request.tenantId;
    const execution = await createScriptRows({
        workspace,
        report,
        filters: request.filters ?? {},
        context,
        policy,
        signal: options.signal,
    });
    try {
        const written = await writeWorkbookRows(report, execution.rows, output, policy, identityTransform, startedAt);
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
    }
    catch (error) {
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
export async function querySync(workspaceValue, request, options = {}) {
    const candidate = await loadReportPackage(workspaceValue, request.reportId, request.reportVersion);
    if (String(candidate.manifest.report_package_format_version) === "3") {
        return queryScriptSync(workspaceValue, request, options);
    }
    const startedAt = Date.now();
    const prepared = await prepareSyncQuery(workspaceValue, request, options);
    const { report, policy, source, profile, dialect, compiled, transform, postFilter, enrichments, groupQueries } = prepared;
    const warnings = [];
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
    const canPushLimit = !isGroupTransform &&
        !groupQueries &&
        !hasActivePostTransformFilter(report.bindings, request.filters ?? {});
    if (canPushLimit) {
        compiled.sql = appendPreviewLimit(compiled.sql, maxRows + 1);
    }
    let adapter;
    let queryStartedAt = 0;
    try {
        adapter = await createQueryAdapter(dialect, profile, source.database);
        await adapter.beginReadOnly();
        queryStartedAt = Date.now();
        const queryTimeoutMs = Number(policy.query_timeout_seconds ?? 600) * 1000;
        // group_queries: execute main + siblings, full-outer-merge on merge_keys, then
        // feed the merged rows through the collector with an identity transform.
        let rowStream;
        if (groupQueries) {
            const numericFieldIds = new Set((report.fields.fields ?? [])
                .filter((f) => f.value_type === "number")
                .map((f) => String(f.id)));
            const mergedRows = await runGroupQueriesMerged(adapter, compiled, groupQueries, queryTimeoutMs, numericFieldIds, Number(policy.max_merged_groups ?? 100000));
            rowStream = arrayToAsyncIterable(mergedRows);
        }
        else {
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
    }
    catch (error) {
        if (adapter) {
            try {
                await adapter.rollback();
            }
            catch {
                // 原始异常优先。
            }
        }
        throw error;
    }
    finally {
        if (adapter)
            await adapter.close();
    }
}
export async function exportSync(workspaceValue, request, options = {}) {
    const candidate = await loadReportPackage(workspaceValue, request.reportId, request.reportVersion);
    if (String(candidate.manifest.report_package_format_version) === "3") {
        return exportScriptSync(workspaceValue, request, options);
    }
    const startedAt = Date.now();
    const prepared = await prepareSyncQuery(workspaceValue, request, options);
    const { workspace, config, report, policy, source, profile, dialect, compiled, transform, postFilter, enrichments, groupQueries } = prepared;
    const enrichWarnings = [];
    const outputDirectory = relativeToWorkspace(workspace, config.storage?.local_output_directory ?? "outputs/files");
    await mkdir(outputDirectory, { recursive: true });
    const output = resolve(options.output ??
        join(outputDirectory, safeFileName(`${report.manifest.name}_${timestamp()}.xlsx`)));
    await mkdir(dirname(output), { recursive: true });
    let adapter;
    let queryStartedAt = 0;
    try {
        adapter = await createQueryAdapter(dialect, profile, source.database);
        await adapter.beginReadOnly();
        queryStartedAt = Date.now();
        const queryTimeoutMs = Number(policy.query_timeout_seconds ?? 600) * 1000;
        // group_queries: execute main + siblings, full-outer-merge on merge_keys, then
        // write the merged rows with an identity transform.
        let rowStream;
        if (groupQueries) {
            const numericFieldIds = new Set((report.fields.fields ?? [])
                .filter((f) => f.value_type === "number")
                .map((f) => String(f.id)));
            const mergedRows = await runGroupQueriesMerged(adapter, compiled, groupQueries, queryTimeoutMs, numericFieldIds, Number(policy.max_merged_groups ?? 100000));
            rowStream = arrayToAsyncIterable(mergedRows);
        }
        else {
            const rawStream = await adapter.rows(compiled.sql, compiled.values, queryTimeoutMs);
            // Enrichment: batch by a fixed export batch size (each batch = one IN(…) query
            // per enrichment). Main row count is unchanged, so sheet/row caps stay correct.
            rowStream = enrichments.length
                ? enrichBatched(rawStream, enrichments, adapter, queryTimeoutMs, Number(policy.enrichment_batch_size ?? 1000), enrichWarnings)
                : rawStream;
        }
        const written = await writeWorkbookRows(report, rowStream, output, policy, groupQueries ? identityTransform : transform, startedAt, postFilter);
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
    }
    catch (error) {
        if (adapter) {
            try {
                await adapter.rollback();
            }
            catch {
                // 原始异常优先。
            }
        }
        try {
            await unlink(output);
        }
        catch {
            // 文件可能尚未创建。
        }
        throw error;
    }
    finally {
        if (adapter)
            await adapter.close();
    }
}
function jsonResponse(response, body) {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
}
function success(requestId, data) {
    return { success: true, requestId, data };
}
function failure(requestId, error) {
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
async function readBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunkValue of request) {
        const chunk = Buffer.from(chunkValue);
        size += chunk.length;
        if (size > 1_048_576)
            throw new RuntimeError("REQUEST_TOO_LARGE", "请求体超过 1 MiB");
        chunks.push(chunk);
    }
    if (!chunks.length)
        return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    catch {
        throw new RuntimeError("INVALID_JSON", "请求体不是有效 JSON");
    }
}
function businessHeaders(config) {
    const headers = { "content-type": "application/json" };
    if (config.auth?.type === "bearer" && config.auth?.token) {
        headers.authorization = `Bearer ${config.auth.token}`;
    }
    return headers;
}
async function callBusiness(integration, operation, body, taskId) {
    const path = String(operation.path).replace("{taskId}", encodeURIComponent(taskId ?? ""));
    const response = await fetch(new URL(path, integration.base_url), {
        method: operation.method ?? "POST",
        headers: businessHeaders(integration),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(operation.timeout_seconds ?? 10) * 1000),
    });
    if (!response.ok)
        throw new RuntimeError("BUSINESS_API_ERROR", `业务接口返回 ${response.status}`);
    return (await response.json());
}
function assertAsyncConfigured(config) {
    const oss = config.aliyun_oss;
    const business = config.business_task_integration;
    if (!oss?.enabled ||
        !oss.endpoint ||
        !oss.bucket ||
        !oss.access_key_id ||
        !oss.access_key_secret) {
        throw new RuntimeError("OSS_PROFILE_UNAVAILABLE", "异步导出需要先配置阿里云 OSS");
    }
    if (!business?.enabled || !business.base_url) {
        throw new RuntimeError("BUSINESS_TASK_PROFILE_UNAVAILABLE", "异步导出需要先配置业务任务接口");
    }
}
function taskDatabase(workspace, config) {
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
async function enqueueAsync(context, request) {
    assertAsyncConfigured(context.config);
    const database = taskDatabase(context.workspace, context.config);
    try {
        const queued = database
            .prepare("SELECT COUNT(*) AS count FROM runtime_tasks WHERE status IN ('QUEUED','RUNNING')")
            .get();
        if (Number(queued.count) >= Number(context.config.execution_strategy.async.max_queue_size)) {
            throw new RuntimeError("ASYNC_QUEUE_FULL", "异步任务队列已满");
        }
        const external = await callBusiness(context.config.business_task_integration, context.config.business_task_integration.create_task, {
            reportId: request.reportId,
            reportVersion: request.reportVersion ?? null,
            tenantId: request.tenantId ?? request.context?.tenantId ?? null,
            status: "PROCESSING",
        });
        const businessTaskId = String(external.data?.taskId ?? external.taskId ?? external.id ?? "");
        if (!businessTaskId) {
            throw new RuntimeError("BUSINESS_TASK_ID_MISSING", "创建任务接口未返回 taskId");
        }
        const id = randomUUID();
        const now = new Date().toISOString();
        database
            .prepare("INSERT INTO runtime_tasks(id,business_task_id,request_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?)")
            .run(id, businessTaskId, JSON.stringify(request), "QUEUED", now, now);
        return {
            executionMode: "async",
            runtimeTaskId: id,
            businessTaskId,
            status: "QUEUED",
            acceptedAt: now,
        };
    }
    finally {
        database.close();
    }
}
async function uploadOss(config, filePath) {
    const moduleName = "ali-oss";
    const imported = (await import(moduleName));
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
async function processOneTask(context, activeTasks) {
    const database = taskDatabase(context.workspace, context.config);
    let task;
    try {
        database.exec("BEGIN IMMEDIATE");
        task = database
            .prepare("SELECT * FROM runtime_tasks WHERE status = 'QUEUED' ORDER BY created_at LIMIT 1")
            .get();
        if (!task) {
            database.exec("COMMIT");
            return false;
        }
        database
            .prepare("UPDATE runtime_tasks SET status='RUNNING',attempts=attempts+1,updated_at=? WHERE id=?")
            .run(new Date().toISOString(), task.id);
        database.exec("COMMIT");
    }
    catch (error) {
        try {
            database.exec("ROLLBACK");
        }
        catch { }
        throw error;
    }
    finally {
        database.close();
    }
    const request = JSON.parse(task.request_json);
    const controller = new AbortController();
    activeTasks.set(String(task.id), controller);
    let generatedFile;
    try {
        const exported = await exportSync(context.workspace, request, {
            policy: {
                ...context.config.execution_strategy.sync,
                enabled: true,
                query_timeout_seconds: context.config.execution_strategy.async.query_timeout_seconds,
                total_timeout_seconds: context.config.execution_strategy.async.query_timeout_seconds + 300,
            },
            signal: controller.signal,
        });
        generatedFile = exported.filePath;
        const fileUrl = await uploadOss(context.config.aliyun_oss, exported.filePath);
        await callBusiness(context.config.business_task_integration, context.config.business_task_integration.update_task, {
            taskId: task.business_task_id,
            reportId: request.reportId,
            tenantId: request.tenantId ?? request.context?.tenantId ?? null,
            status: "COMPLETED",
            fileUrl,
            fileName: exported.fileName,
        }, task.business_task_id);
        const done = taskDatabase(context.workspace, context.config);
        done.prepare("UPDATE runtime_tasks SET status='COMPLETED',updated_at=? WHERE id=?")
            .run(new Date().toISOString(), task.id);
        done.close();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stateDb = taskDatabase(context.workspace, context.config);
        const current = stateDb.prepare("SELECT status FROM runtime_tasks WHERE id=?").get(task.id);
        stateDb.close();
        const canceled = current?.status === "CANCELED" || controller.signal.aborted;
        try {
            await callBusiness(context.config.business_task_integration, context.config.business_task_integration.update_task, {
                taskId: task.business_task_id,
                reportId: request.reportId,
                tenantId: request.tenantId ?? request.context?.tenantId ?? null,
                status: canceled ? "CANCELED" : "FAILED",
                errorMessage: message,
            }, task.business_task_id);
        }
        catch {
            // Internal cancellation/failure state remains authoritative when the
            // optional business-task endpoint does not understand CANCELED.
        }
        finally {
            const failed = taskDatabase(context.workspace, context.config);
            failed.prepare("UPDATE runtime_tasks SET status=?,last_error=?,updated_at=? WHERE id=?")
                .run(canceled ? "CANCELED" : "FAILED", message, new Date().toISOString(), task.id);
            failed.close();
        }
    }
    finally {
        activeTasks.delete(String(task.id));
        if (generatedFile)
            await unlink(generatedFile).catch(() => undefined);
    }
    return true;
}
export async function createRuntimeServer(workspaceValue) {
    const context = await loadRuntimeContext(workspaceValue);
    const recoveryDatabase = taskDatabase(context.workspace, context.config);
    recoveryDatabase.prepare("UPDATE runtime_tasks SET status='QUEUED',updated_at=? WHERE status='RUNNING'")
        .run(new Date().toISOString());
    recoveryDatabase.close();
    let stopping = false;
    const activeRequests = new Map();
    const activeTasks = new Map();
    const workerTimers = new Set();
    const worker = async () => {
        if (stopping)
            return;
        try {
            if (context.config.execution_strategy?.async?.enabled) {
                await processOneTask(context, activeTasks);
            }
        }
        catch (error) {
            console.error("异步任务处理失败：", error);
        }
        finally {
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
        const requestId = String(request.headers["x-request-id"] ?? "").trim() || randomUUID();
        try {
            const url = new URL(request.url ?? "/", "http://easybi.local");
            const cancelMatch = url.pathname.match(/^\/api\/v1\/executions\/([^/]+)$/);
            if (request.method === "DELETE" && cancelMatch) {
                const targetRequestId = decodeURIComponent(cancelMatch[1]);
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
                const taskId = decodeURIComponent(cancelTaskMatch[1]);
                const database = taskDatabase(context.workspace, context.config);
                const task = database.prepare("SELECT status FROM runtime_tasks WHERE id=?").get(taskId);
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
                jsonResponse(response, success(requestId, { items: await listReports(context.workspace) }));
                return;
            }
            const parameterMatch = url.pathname.match(/^\/api\/v1\/reports\/([^/]+)\/parameters$/);
            if (request.method === "GET" && parameterMatch) {
                jsonResponse(response, success(requestId, await getReportParameters(context.workspace, decodeURIComponent(parameterMatch[1]), url.searchParams.get("version") ?? undefined)));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/v1/exports") {
                const body = (await readBody(request));
                if (!body.reportId)
                    throw new RuntimeError("REPORT_ID_REQUIRED", "缺少 reportId");
                const mode = body.executionMode ??
                    context.config.execution_strategy?.default_mode ??
                    "sync";
                if (mode === "async") {
                    jsonResponse(response, success(requestId, await enqueueAsync(context, body)));
                    return;
                }
                if (mode !== "sync") {
                    throw new RuntimeError("INVALID_EXECUTION_MODE", `未知执行方式：${mode}`);
                }
                const controller = new AbortController();
                activeRequests.set(requestId, controller);
                const cancelOnDisconnect = () => {
                    if (!response.writableEnded)
                        controller.abort();
                };
                response.once("close", cancelOnDisconnect);
                request.once("aborted", cancelOnDisconnect);
                let exported;
                try {
                    exported = await exportSync(context.workspace, body, { signal: controller.signal });
                }
                finally {
                    activeRequests.delete(requestId);
                    response.removeListener("close", cancelOnDisconnect);
                    request.removeListener("aborted", cancelOnDisconnect);
                }
                response.writeHead(200, {
                    "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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
                const body = (await readBody(request));
                if (!body.reportId)
                    throw new RuntimeError("REPORT_ID_REQUIRED", "缺少 reportId");
                const controller = new AbortController();
                activeRequests.set(requestId, controller);
                const cancelOnDisconnect = () => {
                    if (!response.writableEnded)
                        controller.abort();
                };
                response.once("close", cancelOnDisconnect);
                request.once("aborted", cancelOnDisconnect);
                try {
                    jsonResponse(response, success(requestId, await querySync(context.workspace, body, { signal: controller.signal })));
                }
                finally {
                    activeRequests.delete(requestId);
                    response.removeListener("close", cancelOnDisconnect);
                    request.removeListener("aborted", cancelOnDisconnect);
                }
                return;
            }
            throw new RuntimeError("NOT_FOUND", "接口不存在");
        }
        catch (error) {
            if (!response.headersSent)
                jsonResponse(response, failure(requestId, error));
            else
                response.destroy(error instanceof Error ? error : new Error(String(error)));
        }
    });
    server.on("listening", () => {
        if (context.config.execution_strategy?.async?.enabled &&
            context.config.aliyun_oss?.enabled &&
            context.config.business_task_integration?.enabled) {
            const concurrency = Math.max(1, Number(context.config.execution_strategy.async.worker_concurrency ?? 1));
            for (let index = 0; index < concurrency; index += 1)
                void worker();
        }
    });
    return {
        server,
        context,
        close: async () => {
            stopping = true;
            for (const controller of activeRequests.values())
                controller.abort();
            activeRequests.clear();
            for (const controller of activeTasks.values())
                controller.abort();
            activeTasks.clear();
            for (const timer of workerTimers)
                clearTimeout(timer);
            workerTimers.clear();
            await new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
        },
    };
}
//# sourceMappingURL=runtime-core.js.map