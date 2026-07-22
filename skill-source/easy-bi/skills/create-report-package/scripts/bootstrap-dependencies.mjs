#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2];

if (!["core", "runtime", "dev"].includes(mode)) {
  console.error("Usage: node scripts/bootstrap-dependencies.mjs <core|runtime|dev>");
  process.exit(2);
}

const packageDocument = JSON.parse(
  await readFile(join(skillRoot, "package.json"), "utf8"),
);
const required = {
  ...(packageDocument.dependencies ?? {}),
  ...(mode === "runtime" || mode === "dev"
    ? packageDocument.optionalDependencies ?? {}
    : {}),
  ...(mode === "dev" ? packageDocument.devDependencies ?? {} : {}),
};

async function inspectDependencies() {
  const missing = [];
  const mismatched = [];
  for (const [name, expectedVersion] of Object.entries(required)) {
    try {
      const installed = JSON.parse(
        await readFile(join(skillRoot, "node_modules", name, "package.json"), "utf8"),
      );
      if (installed.version !== expectedVersion) {
        mismatched.push({
          name,
          expected: expectedVersion,
          installed: installed.version ?? "unknown",
        });
      }
    } catch {
      missing.push({ name, expected: expectedVersion });
    }
  }
  return { missing, mismatched };
}

const before = await inspectDependencies();
if (!before.missing.length && !before.mismatched.length) {
  console.log(
    mode === "core"
      ? "Easy BI 报表包核心运行无需额外依赖，跳过下载。"
      : mode === "runtime"
        ? "Easy BI Runtime 依赖已存在且版本匹配，跳过下载。"
        : "Easy BI 报表包开发依赖已存在且版本匹配，跳过下载。",
  );
  process.exit(0);
}

for (const item of before.missing) {
  console.log(`缺少本地依赖：${item.name}@${item.expected}`);
}
for (const item of before.mismatched) {
  console.log(
    `本地依赖版本不匹配：${item.name}，当前 ${item.installed}，需要 ${item.expected}`,
  );
}

const npmArguments = [
  "ci",
  ...(mode === "dev" ? [] : ["--omit=dev"]),
  ...(mode === "core"
    ? ["--omit=optional"]
    : mode === "runtime"
      ? ["--include=optional"]
      : []),
];
const npmExecPath = process.env.npm_execpath;
const executable = npmExecPath ? process.execPath : "npm";
const argumentsForProcess = npmExecPath
  ? [npmExecPath, ...npmArguments]
  : npmArguments;

console.log(`仅安装当前缺失或版本不匹配的 ${mode} 作用域依赖。`);
const installation = spawnSync(executable, argumentsForProcess, {
  cwd: skillRoot,
  stdio: "inherit",
  env: process.env,
});
if (installation.error) {
  console.error(`依赖安装启动失败：${installation.error.message}`);
  process.exit(1);
}
if (installation.status !== 0) {
  process.exit(installation.status ?? 1);
}

const after = await inspectDependencies();
if (after.missing.length || after.mismatched.length) {
  console.error("依赖安装完成后校验仍未通过。");
  process.exit(1);
}
console.log("依赖已准备并通过本地版本校验。");
