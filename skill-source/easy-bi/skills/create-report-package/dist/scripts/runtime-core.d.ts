import { createServer } from "node:http";
type JsonRecord = Record<string, any>;
export declare class RuntimeError extends Error {
    readonly code: string;
    readonly details?: unknown;
    constructor(code: string, message: string, details?: unknown);
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
export type TransformPipeline = {
    mode: "identity";
} | {
    mode: "row";
    transformRow: (row: JsonRecord) => JsonRecord;
} | {
    mode: "group";
    groupKeys: string[];
    maxGroupRows: number;
    transformGroup: (rows: JsonRecord[], context: {
        groupKey: unknown[];
    }) => JsonRecord | JsonRecord[];
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
export declare function loadRuntimeContext(workspaceValue: string): Promise<RuntimeContext>;
export declare function listReports(workspaceValue: string): Promise<JsonRecord[]>;
export declare function loadReportPackage(workspaceValue: string, reportId: string, reportVersion?: string): Promise<LoadedReport>;
export declare function getReportParameters(workspace: string, reportId: string, reportVersion?: string): Promise<JsonRecord>;
/**
 * Runtime SQL dialect: identifier quote char + placeholder style. MySQL (`col`,
 * `?` placeholders) is the default so existing packages without sql_dialect keep
 * exact behavior; PostgreSQL uses "col" and $n placeholders via the pg driver.
 */
type RuntimeDialect = {
    id: "mysql" | "postgresql";
    quoteChar: string;
};
/**
 * When a package declares comparison (环比/同比), widen the period filter's lower
 * bound backward so ONE query returns the current window plus the look-back
 * window(s) the group transform needs: chain looks back `lookback_months`,
 * yoy looks back 12 months (× nothing — same month last year). The upper bound
 * and every other filter are untouched. Returns a new filters object; the
 * original is not mutated. No-op when comparison is absent/disabled or the
 * period filter has no month lower bound.
 */
export declare function widenComparisonFilters(comparison: JsonRecord | undefined, filters: Record<string, unknown>): Record<string, unknown>;
/**
 * Coerce a boolean-flag filter value (the test page sends `true`/`false`, or the
 * strings `"true"`/`"false"` from a `<select>`) into a real boolean. Returns null
 * for anything unrecognised so the caller can skip the filter rather than guess.
 */
export declare function coerceFlagValue(value: unknown): boolean | null;
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
export declare function buildFlagPredicate(expression: string, operatorKey: string, threshold: unknown, truthy: boolean, quoteChar: string): string;
export declare function compileSql(templateValue: string, bindings: JsonRecord, filtersValue?: Record<string, unknown>, contextValue?: Record<string, unknown>, dialect?: RuntimeDialect): {
    sql: string;
    values: unknown[];
};
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
export declare function buildPostTransformFilter(bindings: JsonRecord, filtersValue?: Record<string, unknown>): (outputRow: JsonRecord) => boolean;
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
export declare function topoSortEnrichments(enrichments: EnrichmentBinding[]): EnrichmentBinding[];
/** Fold multiple child rows sharing one key into a single value per the aggregate spec. */
export declare function aggregateMany(rows: JsonRecord[], selectId: string, lookupField: string, aggregate: NonNullable<EnrichmentBinding["aggregate"]>): unknown;
/**
 * Build a `keyText → merged select-values` map for one enrichment from its raw
 * lookup rows. `one`: first row per key (records a multi-hit key list for a
 * warning). `many`: all rows per key folded via aggregate. Pure.
 */
export declare function buildEnrichmentValueMap(binding: EnrichmentBinding, lookupRows: JsonRecord[], selectLookupFields: Record<string, string>): {
    values: Map<string, JsonRecord>;
    multiHitKeys: string[];
};
/**
 * Attach one enrichment's select columns to every row of a batch, keyed by the
 * row's `main_key_field`. Mutates rows in place (the batch is transient). Returns
 * the set of collected keys (for the caller to know what to query) is NOT here —
 * key collection + the actual query happen in enrichBatched; this only merges.
 */
export declare function applyEnrichmentToBatch(batch: JsonRecord[], binding: EnrichmentBinding, valueMap: Map<string, JsonRecord>): void;
/** Distinct non-null join keys present in a batch for one enrichment. */
export declare function collectBatchKeys(batch: JsonRecord[], mainKeyField: string): unknown[];
export declare function runControlQuery(connection: JsonRecord, sql: string): Promise<void>;
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
    rows(sql: string, values: unknown[], queryTimeoutMs: number): Promise<AsyncIterable<JsonRecord>>;
    /**
     * Run a query and materialize ALL rows. Used for enrichment secondary queries,
     * whose result sets are small (bounded by the batch's distinct key count). Runs
     * on the same read-only transaction/connection as `rows`.
     */
    queryAll(sql: string, values: unknown[], queryTimeoutMs: number): Promise<JsonRecord[]>;
    rollback(): Promise<void>;
    close(): Promise<void>;
};
export declare function writeWorkbookRows(report: Pick<LoadedReport, "manifest" | "fields"> & {
    enums?: JsonRecord | null;
}, rows: AsyncIterable<JsonRecord>, output: string, policy: JsonRecord, transform?: TransformPipeline | ((row: JsonRecord) => JsonRecord), startedAt?: number, postFilter?: (outputRow: JsonRecord) => boolean): Promise<{
    rowCount: number;
    sheetCount: number;
    fileBytes: number;
}>;
export declare function runGroupQueriesMerged(adapter: Pick<QueryAdapter, "queryAll">, main: {
    sql: string;
    values: unknown[];
}, groupQueries: {
    mergeKeys: string[];
    compiled: Array<{
        id: string;
        sql: string;
        values: unknown[];
    }>;
}, queryTimeoutMs: number, numericFieldIds: Set<string>, maxMergedGroups?: number): Promise<JsonRecord[]>;
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
export declare function enrichBatched(rows: AsyncIterable<JsonRecord>, enrichments: EnrichmentBinding[], adapter: Pick<QueryAdapter, "queryAll">, queryTimeoutMs: number, batchSize: number, warningsSink: string[]): AsyncGenerator<JsonRecord>;
/** Report output columns as {id, label, description?} — the 中文 headers a caller
 * (Studio 测试页预览) renders as table headers. Description is included when the
 * package field carries one. */
export declare function outputColumns(report: Pick<LoadedReport, "fields">): JsonRecord[];
/**
 * Collect transformed, enum-translated output rows into memory (instead of
 * streaming to a workbook), applying the same identity/row/group transform and
 * enum code→中文 mapping as `writeWorkbookRows`. Bounded by `maxRows`: once the
 * cap is reached collection stops and `truncated` is true. No pagination — the
 * caller scrolls the returned rows.
 */
export declare function collectRows(report: Pick<LoadedReport, "manifest" | "fields"> & {
    enums?: JsonRecord | null;
}, rows: AsyncIterable<JsonRecord>, transform: TransformPipeline | ((row: JsonRecord) => JsonRecord), options: {
    maxRows: number;
    startedAt: number;
    totalTimeoutSeconds: number;
    /** Post-transform numeric-range filter; rows failing it are dropped. */
    postFilter?: (outputRow: JsonRecord) => boolean;
}): Promise<{
    rows: JsonRecord[];
    rowCount: number;
    truncated: boolean;
}>;
/**
 * Synchronous JSON query: runs the report's query/filters/transform exactly like
 * `exportSync` but returns the 中文 column headers and data rows as JSON instead
 * of a workbook. Row count is bounded (preview) — no pagination. Intended for the
 * Studio 测试页 data preview.
 */
export declare function querySync(workspaceValue: string, request: ExportRequest & {
    limit?: number;
}, options?: {
    policy?: JsonRecord;
    signal?: AbortSignal;
}): Promise<JsonRecord>;
export declare function exportSync(workspaceValue: string, request: ExportRequest, options?: {
    output?: string;
    policy?: JsonRecord;
    signal?: AbortSignal;
}): Promise<JsonRecord>;
export declare function createRuntimeServer(workspaceValue: string): Promise<{
    server: ReturnType<typeof createServer>;
    context: RuntimeContext;
    close: () => Promise<void>;
}>;
export {};
