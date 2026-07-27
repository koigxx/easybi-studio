#!/usr/bin/env node

import { pathToFileURL } from "node:url";

type JsonRecord = Record<string, any>;

type ParentResult = {
  type: "result";
  requestId: string;
  ok: boolean;
  value?: unknown;
  error?: { code?: string; message: string };
};

const pending = new Map<
  string,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
let sequence = 0;

function rpc(method: string, payload: JsonRecord = {}): Promise<any> {
  const requestId = `rpc-${++sequence}`;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    process.send?.({ type: "call", requestId, method, payload });
  });
}

function indexKey(values: unknown[]): string {
  return JSON.stringify(values.map((value) => value ?? null));
}

function createContext(input: JsonRecord): JsonRecord {
  return Object.freeze({
    isPreview: Boolean(input.isPreview),
    filters: Object.freeze({ ...(input.filters ?? {}) }),
    context: Object.freeze({ ...(input.context ?? {}) }),
    async *queryStream(queryId: string, values: unknown[] = []) {
      const opened = await rpc("openQueryStream", { queryId, values });
      const streamId = String(opened.streamId);
      try {
        while (true) {
          const next = await rpc("nextQueryStream", { streamId });
          for (const row of next.rows ?? []) yield row;
          if (next.done) break;
        }
      } finally {
        await rpc("closeQueryStream", { streamId }).catch(() => undefined);
      }
    },
    async *queryStreamWithFilters(
      queryId: string,
      filtersOverride: JsonRecord = {},
    ) {
      const opened = await rpc("openQueryStreamWithFilters", {
        queryId,
        filtersOverride,
      });
      const streamId = String(opened.streamId);
      try {
        while (true) {
          const next = await rpc("nextQueryStream", { streamId });
          for (const row of next.rows ?? []) yield row;
          if (next.done) break;
        }
      } finally {
        await rpc("closeQueryStream", { streamId }).catch(() => undefined);
      }
    },
    async beginSheet(name: string) {
      if (input.isPreview) return;
      await rpc("beginSheet", { name });
    },
    async loadIndex(
      queryId: string,
      values: unknown[] = [],
      keyFields: string[] = [],
    ) {
      if (!keyFields.length) throw new Error("loadIndex 必须声明 keyFields");
      const rows = (await rpc("loadIndex", { queryId, values, keyFields })) as JsonRecord[];
      const grouped = new Map<string, JsonRecord[]>();
      for (const row of rows) {
        const key = indexKey(keyFields.map((field) => row[field]));
        grouped.set(key, [...(grouped.get(key) ?? []), row]);
      }
      return Object.freeze({
        size: grouped.size,
        get(...keys: unknown[]) {
          return grouped.get(indexKey(keys)) ?? [];
        },
        has(...keys: unknown[]) {
          return grouped.has(indexKey(keys));
        },
      });
    },
    async batchLookup(
      queryId: string,
      keys: unknown[],
      values: unknown[] = [],
    ) {
      return rpc("batchLookup", { queryId, keys, values });
    },
    async emit(row: JsonRecord) {
      if (!row || Array.isArray(row) || typeof row !== "object") {
        throw new Error("emit 只接受对象行");
      }
      await rpc("emit", { row });
    },
  });
}

process.on("message", async (message: JsonRecord) => {
  if (message?.type === "result") {
    const result = message as ParentResult;
    const waiter = pending.get(result.requestId);
    if (!waiter) return;
    pending.delete(result.requestId);
    if (result.ok) waiter.resolve(result.value);
    else {
      const error = new Error(result.error?.message ?? "父 Runtime 调用失败");
      Object.assign(error, { code: result.error?.code });
      waiter.reject(error);
    }
    return;
  }
  if (message?.type !== "start") return;
  try {
    const module = (await import(
      `${pathToFileURL(String(message.scriptPath)).href}?run=${Date.now()}`
    )) as JsonRecord;
    if (typeof module.run !== "function") {
      throw new Error("v3 报表脚本必须导出 async function run(ctx)");
    }
    await module.run(createContext(message.input ?? {}));
    process.send?.({ type: "completed" });
  } catch (error) {
    const details = error as JsonRecord;
    const permissionDetail = [details.permission, details.resource]
      .filter(Boolean)
      .map(String)
      .join(" ");
    process.send?.({
      type: "failed",
      error: {
        code: String((error as JsonRecord)?.code ?? "SCRIPT_FAILED"),
        message: `${error instanceof Error ? error.message : String(error)}${
          permissionDetail ? `（${permissionDetail}）` : ""
        }`,
      },
    });
  }
});

process.send?.({ type: "ready" });
