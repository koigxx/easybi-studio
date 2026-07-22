#!/usr/bin/env node

import { resolve } from "node:path";
import {
  createRuntimeServer,
  exportSync,
  getReportParameters,
  listReports,
  RuntimeError,
  type ExportRequest,
} from "./runtime-core.js";

function parseArguments(values: string[]): {
  command: string;
  options: Record<string, string>;
} {
  const command = values[0] ?? "";
  const options: Record<string, string> = {};
  for (let index = 1; index < values.length; index += 1) {
    const token = values[index];
    if (!token?.startsWith("--")) throw new Error(`无法识别的参数：${token}`);
    const key = token.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) options[key] = "true";
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

function required(options: Record<string, string>, key: string): string {
  if (!options[key]) throw new Error(`缺少必填参数 --${key}`);
  return options[key]!;
}

function json(value: string | undefined, label: string): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new Error(`${label} 不是有效 JSON`);
  }
}

async function main(): Promise<void> {
  const { command, options } = parseArguments(process.argv.slice(2));
  const workspace = resolve(options.workspace ?? process.cwd());
  if (command === "list") {
    console.log(JSON.stringify(await listReports(workspace), null, 2));
    return;
  }
  if (command === "parameters") {
    console.log(
      JSON.stringify(
        await getReportParameters(
          workspace,
          required(options, "report-id"),
          options.version,
        ),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "export") {
    const mode = options.mode ?? "sync";
    if (mode !== "sync") {
      throw new RuntimeError(
        "ASYNC_REQUIRES_SERVER",
        "异步导出必须启动 HTTP Server，由持久任务队列执行；CLI 直接导出仅支持 sync",
      );
    }
    const request: ExportRequest = {
      reportId: required(options, "report-id"),
      reportVersion: options.version,
      executionMode: "sync",
      filters: json(options["filters-json"], "--filters-json"),
      context: json(options["context-json"], "--context-json"),
      tenantId: options["tenant-id"],
    };
    console.log(
      JSON.stringify(
        await exportSync(workspace, request, { output: options.output }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "serve") {
    const runtime = await createRuntimeServer(workspace);
    const host = options.host ?? runtime.context.config.http.host;
    const port = Number(options.port ?? runtime.context.config.http.port);
    runtime.server.listen(port, host, () => {
      console.log(`Easy BI Runtime 已启动：http://${host}:${port}`);
    });
    const stop = async (): Promise<void> => {
      await runtime.close();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }
  throw new Error(
    [
      "用法：",
      "  easybi-runtime list --workspace <项目目录>",
      "  easybi-runtime parameters --workspace <项目目录> --report-id <报表ID>",
      "  easybi-runtime export --workspace <项目目录> --report-id <报表ID> [--filters-json '{}'] [--tenant-id <租户ID>] [--output <xlsx>]",
      "  easybi-runtime serve --workspace <项目目录> [--host 127.0.0.1] [--port 39080]",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  const code = error instanceof RuntimeError ? error.code : "CLI_ERROR";
  console.error(
    JSON.stringify(
      {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
