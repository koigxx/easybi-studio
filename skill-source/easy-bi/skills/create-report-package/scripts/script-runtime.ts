import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  loadIndex(queryId: string, values: unknown[]): Promise<JsonRecord[]>;
  batchLookup(queryId: string, keys: unknown[], values: unknown[]): Promise<JsonRecord[]>;
};

export class ScriptExecutionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

function positive(value: unknown, fallback: number, name: string): number {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1) {
    throw new ScriptExecutionError("INVALID_RESOURCE_BUDGET", `${name} 必须是正整数`);
  }
  return number;
}

export function normalizeScriptBudget(value: JsonRecord = {}): ScriptResourceBudget {
  return {
    max_queries: positive(value.max_queries, 12, "max_queries"),
    max_query_rows: positive(value.max_query_rows, 1_000_000, "max_query_rows"),
    max_index_rows: positive(value.max_index_rows, 100_000, "max_index_rows"),
    max_batch_keys: positive(value.max_batch_keys, 2_000, "max_batch_keys"),
    max_output_rows: positive(value.max_output_rows, 500_000, "max_output_rows"),
    max_memory_mb: positive(value.max_memory_mb, 512, "max_memory_mb"),
    timeout_seconds: positive(value.timeout_seconds, 300, "timeout_seconds"),
    stream_batch_rows: positive(value.stream_batch_rows, 128, "stream_batch_rows"),
  };
}

export async function runScriptIsolated(options: {
  scriptPath: string;
  filters?: JsonRecord;
  context?: JsonRecord;
  budget?: JsonRecord;
  handlers: ScriptQueryHandlers;
  onEmit(row: JsonRecord): Promise<void> | void;
  signal?: AbortSignal;
}): Promise<{ outputRows: number; queryRows: number; queryCount: number }> {
  const budget = normalizeScriptBudget(options.budget);
  if (options.signal?.aborted) {
    throw new ScriptExecutionError("SCRIPT_CANCELED", "脚本报表执行已取消");
  }
  const runnerPath = fileURLToPath(new URL("./script-runner.js", import.meta.url));
  const streams = new Map<string, AsyncIterator<JsonRecord>>();
  let streamSequence = 0;
  let queryCount = 0;
  let queryRows = 0;
  let outputRows = 0;
  let child: ChildProcess | undefined;

  const assertRunning = (): void => {
    if (options.signal?.aborted) {
      throw new ScriptExecutionError("SCRIPT_CANCELED", "脚本报表执行已取消");
    }
  };
  const countQuery = (): void => {
    queryCount += 1;
    if (queryCount > budget.max_queries) {
      throw new ScriptExecutionError(
        "QUERY_BUDGET_EXCEEDED",
        `脚本查询次数超过上限 ${budget.max_queries}`,
      );
    }
  };
  const countRows = (count: number): void => {
    queryRows += count;
    if (queryRows > budget.max_query_rows) {
      throw new ScriptExecutionError(
        "QUERY_ROW_BUDGET_EXCEEDED",
        `脚本累计查询行数超过上限 ${budget.max_query_rows}`,
      );
    }
  };

  const terminate = (): void => {
    if (!child || child.killed) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child?.kill("SIGKILL"), 1_000);
    timer.unref();
  };

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (
      error?: Error,
      result?: { outputRows: number; queryRows: number; queryCount: number },
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      terminate();
      if (error) rejectPromise(error);
      else resolvePromise(result!);
    };
    const onAbort = (): void =>
      finish(new ScriptExecutionError("SCRIPT_CANCELED", "脚本报表执行已取消"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(
      () =>
        finish(
          new ScriptExecutionError(
            "SCRIPT_TIMEOUT",
            `脚本执行超过上限 ${budget.timeout_seconds} 秒`,
          ),
        ),
      budget.timeout_seconds * 1_000,
    );

    child = fork(runnerPath, [], {
      execArgv: [
        "--permission",
        `--allow-fs-read=${runnerPath}`,
        `--allow-fs-read=${options.scriptPath}`,
        `--max-old-space-size=${Math.max(16, budget.max_memory_mb)}`,
      ],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });

    const sendResult = (requestId: string, ok: boolean, value?: unknown, error?: unknown): void => {
      child?.send({
        type: "result",
        requestId,
        ok,
        ...(ok ? { value } : {
          error: {
            code: String((error as JsonRecord)?.code ?? "SCRIPT_RUNTIME_FAILED"),
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      });
    };

    child.on("message", async (message: JsonRecord) => {
      if (settled) return;
      if (message?.type === "ready") {
        child?.send({
          type: "start",
          scriptPath: options.scriptPath,
          input: { filters: options.filters ?? {}, context: options.context ?? {} },
        });
        return;
      }
      if (message?.type === "completed") {
        finish(undefined, { outputRows, queryRows, queryCount });
        return;
      }
      if (message?.type === "failed") {
        finish(
          new ScriptExecutionError(
            String(message.error?.code ?? "SCRIPT_FAILED"),
            String(message.error?.message ?? "脚本执行失败"),
          ),
        );
        return;
      }
      if (message?.type !== "call") return;
      const requestId = String(message.requestId);
      const payload = message.payload ?? {};
      try {
        assertRunning();
        if (message.method === "openQueryStream") {
          countQuery();
          const iterable = await options.handlers.queryStream(
            String(payload.queryId),
            payload.values ?? [],
          );
          const streamId = `stream-${++streamSequence}`;
          streams.set(streamId, iterable[Symbol.asyncIterator]());
          sendResult(requestId, true, { streamId });
        } else if (message.method === "nextQueryStream") {
          const iterator = streams.get(String(payload.streamId));
          if (!iterator) throw new ScriptExecutionError("STREAM_NOT_FOUND", "查询流不存在");
          const rows: JsonRecord[] = [];
          let done = false;
          while (rows.length < budget.stream_batch_rows) {
            const next = await iterator.next();
            if (next.done) {
              done = true;
              streams.delete(String(payload.streamId));
              break;
            }
            rows.push(next.value);
          }
          countRows(rows.length);
          sendResult(requestId, true, { rows, done });
        } else if (message.method === "closeQueryStream") {
          const iterator = streams.get(String(payload.streamId));
          streams.delete(String(payload.streamId));
          await iterator?.return?.();
          sendResult(requestId, true, null);
        } else if (message.method === "loadIndex") {
          countQuery();
          const rows = await options.handlers.loadIndex(
            String(payload.queryId),
            payload.values ?? [],
          );
          if (rows.length > budget.max_index_rows) {
            throw new ScriptExecutionError(
              "INDEX_LIMIT_EXCEEDED",
              `索引查询结果超过上限 ${budget.max_index_rows}`,
            );
          }
          countRows(rows.length);
          sendResult(requestId, true, rows);
        } else if (message.method === "batchLookup") {
          const keys = payload.keys ?? [];
          if (!Array.isArray(keys) || keys.length > budget.max_batch_keys) {
            throw new ScriptExecutionError(
              "BATCH_KEY_LIMIT_EXCEEDED",
              `批量查询键数量超过上限 ${budget.max_batch_keys}`,
            );
          }
          countQuery();
          const rows = await options.handlers.batchLookup(
            String(payload.queryId),
            keys,
            payload.values ?? [],
          );
          countRows(rows.length);
          sendResult(requestId, true, rows);
        } else if (message.method === "emit") {
          outputRows += 1;
          if (outputRows > budget.max_output_rows) {
            throw new ScriptExecutionError(
              "OUTPUT_ROW_LIMIT_EXCEEDED",
              `脚本输出行数超过上限 ${budget.max_output_rows}`,
            );
          }
          await options.onEmit(payload.row);
          sendResult(requestId, true, null);
        } else {
          throw new ScriptExecutionError("UNKNOWN_SCRIPT_CALL", `未知脚本调用：${message.method}`);
        }
      } catch (error) {
        sendResult(requestId, false, undefined, error);
      }
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (!settled) {
        finish(
          new ScriptExecutionError(
            "SCRIPT_PROCESS_EXITED",
            `脚本隔离进程异常退出（code=${code ?? "null"}, signal=${signal ?? "null"}）`,
          ),
        );
      }
    });
  });
}
