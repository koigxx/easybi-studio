#!/usr/bin/env node
import { pathToFileURL } from "node:url";
const pending = new Map();
let sequence = 0;
function rpc(method, payload = {}) {
    const requestId = `rpc-${++sequence}`;
    return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        process.send?.({ type: "call", requestId, method, payload });
    });
}
function indexKey(values) {
    return JSON.stringify(values.map((value) => value ?? null));
}
function createContext(input) {
    return Object.freeze({
        isPreview: Boolean(input.isPreview),
        filters: Object.freeze({ ...(input.filters ?? {}) }),
        context: Object.freeze({ ...(input.context ?? {}) }),
        async *queryStream(queryId, values = []) {
            const opened = await rpc("openQueryStream", { queryId, values });
            const streamId = String(opened.streamId);
            try {
                while (true) {
                    const next = await rpc("nextQueryStream", { streamId });
                    for (const row of next.rows ?? [])
                        yield row;
                    if (next.done)
                        break;
                }
            }
            finally {
                await rpc("closeQueryStream", { streamId }).catch(() => undefined);
            }
        },
        async *queryStreamWithFilters(queryId, filtersOverride = {}) {
            const opened = await rpc("openQueryStreamWithFilters", {
                queryId,
                filtersOverride,
            });
            const streamId = String(opened.streamId);
            try {
                while (true) {
                    const next = await rpc("nextQueryStream", { streamId });
                    for (const row of next.rows ?? [])
                        yield row;
                    if (next.done)
                        break;
                }
            }
            finally {
                await rpc("closeQueryStream", { streamId }).catch(() => undefined);
            }
        },
        async beginSheet(name) {
            if (input.isPreview)
                return;
            await rpc("beginSheet", { name });
        },
        async loadIndex(queryId, values = [], keyFields = []) {
            if (!keyFields.length)
                throw new Error("loadIndex 必须声明 keyFields");
            const rows = (await rpc("loadIndex", { queryId, values, keyFields }));
            const grouped = new Map();
            for (const row of rows) {
                const key = indexKey(keyFields.map((field) => row[field]));
                grouped.set(key, [...(grouped.get(key) ?? []), row]);
            }
            return Object.freeze({
                size: grouped.size,
                get(...keys) {
                    return grouped.get(indexKey(keys)) ?? [];
                },
                has(...keys) {
                    return grouped.has(indexKey(keys));
                },
            });
        },
        async batchLookup(queryId, keys, values = []) {
            return rpc("batchLookup", { queryId, keys, values });
        },
        async emit(row) {
            if (!row || Array.isArray(row) || typeof row !== "object") {
                throw new Error("emit 只接受对象行");
            }
            await rpc("emit", { row });
        },
    });
}
process.on("message", async (message) => {
    if (message?.type === "result") {
        const result = message;
        const waiter = pending.get(result.requestId);
        if (!waiter)
            return;
        pending.delete(result.requestId);
        if (result.ok)
            waiter.resolve(result.value);
        else {
            const error = new Error(result.error?.message ?? "父 Runtime 调用失败");
            Object.assign(error, { code: result.error?.code });
            waiter.reject(error);
        }
        return;
    }
    if (message?.type !== "start")
        return;
    try {
        const module = (await import(`${pathToFileURL(String(message.scriptPath)).href}?run=${Date.now()}`));
        if (typeof module.run !== "function") {
            throw new Error("v3 报表脚本必须导出 async function run(ctx)");
        }
        await module.run(createContext(message.input ?? {}));
        process.send?.({ type: "completed" });
    }
    catch (error) {
        const details = error;
        const permissionDetail = [details.permission, details.resource]
            .filter(Boolean)
            .map(String)
            .join(" ");
        process.send?.({
            type: "failed",
            error: {
                code: String(error?.code ?? "SCRIPT_FAILED"),
                message: `${error instanceof Error ? error.message : String(error)}${permissionDetail ? `（${permissionDetail}）` : ""}`,
            },
        });
    }
});
process.send?.({ type: "ready" });
//# sourceMappingURL=script-runner.js.map