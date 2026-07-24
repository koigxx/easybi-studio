import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------
// ScriptExecutionError
// ---------------------------------------------------------------------------

export class ScriptExecutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ScriptExecutionError";
  }
}

// ---------------------------------------------------------------------------
// ScriptQueryHandlers — injected by the host (runtime-core)
// ---------------------------------------------------------------------------

export interface ScriptQueryHandlers {
  /** Return an async iterable of rows for a streaming query (with request filters compiled). */
  queryStream(queryId: string, values: unknown[]): Promise<AsyncIterable<JsonRecord>>;
  /** Re-compile the SQL with different filter overrides, then stream. */
  queryStreamWithFilters(queryId: string, filtersOverride: unknown): Promise<AsyncIterable<JsonRecord>>;
  /** Return all rows for a small lookup/index query. */
  loadIndex(queryId: string, values: unknown[]): Promise<JsonRecord[]>;
  /** Batch-lookup rows by a set of keys. */
  batchLookup(queryId: string, keys: unknown[], values: unknown[]): Promise<JsonRecord[]>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

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
  /** Called when the script switches to a new named sheet (export only). */
  onBeginSheet?: (name: string) => void;
  /** True when the caller is a preview (not an export). */
  isPreview?: boolean;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/**
 * Build a Map index from an array of rows.
 *
 * - Single key: raw value is used as the Map key (preserving type).
 * - Multiple keys: values are joined with \x00 as a composite string key.
 */
function buildIndex(rows: JsonRecord[], keys: string[]): Map<unknown, JsonRecord[]> {
  const index = new Map<unknown, JsonRecord[]>();
  for (const row of rows) {
    const key =
      keys.length === 1
        ? row[keys[0]!]
        : keys.map((k) => String(row[k] ?? "")).join("\x00");
    const bucket = index.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      index.set(key, [row]);
    }
  }
  return index;
}

/** Create a Promise that rejects when the signal fires. */
function abortRace(signal: AbortSignal | undefined): Promise<never> | undefined {
  if (!signal) return undefined;
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new ScriptExecutionError("SCRIPT_CANCELED", "Script was canceled"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new ScriptExecutionError("SCRIPT_CANCELED", "Script was canceled")),
      { once: true },
    );
  });
}

/** Create a Promise that rejects after timeoutSeconds. */
function timeoutRace(seconds: number): Promise<never> | undefined {
  if (seconds <= 0) return undefined;
  return new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new ScriptExecutionError("SCRIPT_TIMEOUT", `脚本执行超时（${seconds}s）`));
    }, seconds * 1000);
  });
}

// ---------------------------------------------------------------------------
// runScriptIsolated
// ---------------------------------------------------------------------------

export async function runScriptIsolated(options: RunScriptOptions): Promise<{
  queryCount: number;
  outputRows: number;
}> {
  const { scriptPath, budget = {}, handlers, onEmit, signal } = options;

  let queryCount = 0;
  let outputRows = 0;

  const maxQueries = Number(budget.max_queries ?? Infinity);
  const maxOutputRows = Number(budget.max_output_rows ?? Infinity);
  const timeoutSeconds = Number(budget.timeout_seconds ?? 0);

  function checkBudget(): void {
    if (queryCount >= maxQueries) {
      throw new BudgetExceededError(`查询次数已达上限（${maxQueries}）`);
    }
    if (outputRows >= maxOutputRows) {
      throw new BudgetExceededError(`输出行数已达上限（${maxOutputRows}）`);
    }
  }

  const isPreview = Boolean(options.isPreview);

  // --- ctx object exposed to user scripts ---
  // NOTE: queryStream is NOT async so that "for await (const row of ctx.queryStream(...))"
  // works directly. The handler call is deferred until the first iterator pull.
  const ctx = {
    /** True during preview; false during export. */
    isPreview,

    /** The request's filter values (read-only snapshot). */
    filters: (options.filters ?? {}) as JsonRecord,

    /** Switch to a named output sheet (export only; no-op in preview). */
    beginSheet(_name: string): void {
      if (options.onBeginSheet) options.onBeginSheet(_name);
    },

    /** Stream query with different filter overrides (for comparison queries). */
    queryStreamWithFilters(queryId: string, filterOverrides: unknown): AsyncIterable<JsonRecord> {
      checkBudget();
      queryCount++;
      let iter: AsyncIterator<JsonRecord> | undefined;
      return {
        [Symbol.asyncIterator](): AsyncIterator<JsonRecord> {
          return {
            async next() {
              if (!iter) {
                const iterable = await handlers.queryStreamWithFilters(queryId, filterOverrides);
                iter = iterable[Symbol.asyncIterator]();
              }
              return iter.next();
            },
            async return(value?: unknown) {
              return iter?.return?.(value) ?? ({ done: true, value } as IteratorResult<JsonRecord>);
            },
            async throw(e?: unknown) {
              if (iter?.throw) return iter.throw(e);
              throw e;
            },
          };
        },
      };
    },

    queryStream(queryId: string): AsyncIterable<JsonRecord> {
      checkBudget();
      queryCount++;
      return {
        [Symbol.asyncIterator](): AsyncIterator<JsonRecord> {
          let iter: AsyncIterator<JsonRecord> | undefined;
          return {
            async next() {
              if (!iter) {
                const iterable = await handlers.queryStream(queryId, []);
                iter = iterable[Symbol.asyncIterator]();
              }
              return iter.next();
            },
            async return(value?: unknown) {
              return iter?.return?.(value) ?? ({ done: true, value } as IteratorResult<JsonRecord>);
            },
            async throw(e?: unknown) {
              if (iter?.throw) return iter.throw(e);
              throw e;
            },
          };
        },
      };
    },

    async loadIndex(
      queryId: string,
      values: unknown[] = [],
      keys?: string[],
    ): Promise<Map<unknown, JsonRecord[]> | JsonRecord[]> {
      checkBudget();
      queryCount++;
      const rows = await handlers.loadIndex(queryId, values);
      if (keys && keys.length > 0) {
        return buildIndex(rows, keys);
      }
      return rows;
    },

    async batchLookup(queryId: string, keys: unknown[]): Promise<JsonRecord[]> {
      checkBudget();
      queryCount++;
      return handlers.batchLookup(queryId, keys, []);
    },

    async emit(row: JsonRecord): Promise<void> {
      checkBudget();
      outputRows++;
      onEmit(row);
    },
  };

  // --- load and execute user script ---
  try {
    // Cache-bust to allow repeated loads of the same path (needed in tests).
    const url = `${pathToFileURL(scriptPath).href}?t=${Date.now()}`;
    const mod = await import(url);
    if (typeof mod.run !== "function") {
      throw new ScriptExecutionError(
        "INVALID_SCRIPT",
        "脚本必须导出 async function run(ctx)",
      );
    }

    const runPromise = mod.run(ctx);

    // Race: user script vs abort vs timeout
    const racers: Promise<unknown>[] = [runPromise];
    const abortP = abortRace(signal);
    const timeoutP = timeoutRace(timeoutSeconds);
    if (abortP) racers.push(abortP);
    if (timeoutP) racers.push(timeoutP);

    await Promise.race(racers);

    return { queryCount, outputRows };
  } catch (error: unknown) {
    if (error instanceof ScriptExecutionError) throw error;
    if (
      error instanceof BudgetExceededError ||
      (error instanceof Error && error.name === "BudgetExceededError")
    ) {
      throw new ScriptExecutionError("QUERY_BUDGET_EXCEEDED", error.message);
    }
    throw new ScriptExecutionError(
      "SCRIPT_RUNTIME_ERROR",
      error instanceof Error ? error.message : String(error),
    );
  }
}
