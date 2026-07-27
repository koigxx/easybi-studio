type JsonRecord = Record<string, any>;
export type ScriptResourceBudget = {
    max_queries: number;
    max_query_rows: number;
    max_index_rows: number;
    max_batch_keys: number;
    max_output_rows: number;
    max_memory_mb: number;
    timeout_seconds: number;
    stream_batch_rows: number;
};
export type ScriptQueryHandlers = {
    queryStream(queryId: string, values: unknown[]): Promise<AsyncIterable<JsonRecord>>;
    queryStreamWithFilters(queryId: string, filtersOverride: unknown): Promise<AsyncIterable<JsonRecord>>;
    loadIndex(queryId: string, values: unknown[]): Promise<JsonRecord[]>;
    batchLookup(queryId: string, keys: unknown[], values: unknown[]): Promise<JsonRecord[]>;
};
export declare class ScriptExecutionError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function normalizeScriptBudget(value?: JsonRecord): ScriptResourceBudget;
export declare function runScriptIsolated(options: {
    scriptPath: string;
    filters?: JsonRecord;
    context?: JsonRecord;
    budget?: JsonRecord;
    handlers: ScriptQueryHandlers;
    onEmit(row: JsonRecord): Promise<void> | void;
    onBeginSheet?(name: string): Promise<void> | void;
    isPreview?: boolean;
    signal?: AbortSignal;
}): Promise<{
    outputRows: number;
    queryRows: number;
    queryCount: number;
}>;
export {};
