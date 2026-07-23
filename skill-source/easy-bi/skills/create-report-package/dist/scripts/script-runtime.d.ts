type JsonRecord = Record<string, unknown>;
export declare class ScriptExecutionError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export interface ScriptQueryHandlers {
    /** Return an async iterable of rows for a streaming query. */
    queryStream(queryId: string, values: unknown[]): Promise<AsyncIterable<JsonRecord>>;
    /** Return all rows for a small lookup/index query. */
    loadIndex(queryId: string, values: unknown[]): Promise<JsonRecord[]>;
    /** Batch-lookup rows by a set of keys. */
    batchLookup(queryId: string, keys: unknown[], values: unknown[]): Promise<JsonRecord[]>;
}
export interface RunScriptOptions {
    /** Absolute path to the user .mjs script. */
    scriptPath: string;
    /** Request filters (v2 compat, forwarded to user script via context if needed). */
    filters?: unknown;
    /** Opaque context the host may attach. */
    context?: unknown;
    /**
     * Resource budget: max_queries, max_output_rows, timeout_seconds, etc.
     * Values may come from JSON manifests (unknown) — the runner coerces via Number().
     */
    budget?: Record<string, unknown>;
    /** Query handlers injected by the host. */
    handlers: ScriptQueryHandlers;
    /** Called for each row emitted by the user script. */
    onEmit: (row: JsonRecord) => void;
    /** AbortSignal for cancellation. */
    signal?: AbortSignal;
}
export declare function runScriptIsolated(options: RunScriptOptions): Promise<{
    queryCount: number;
    outputRows: number;
}>;
export {};
