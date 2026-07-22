# 决策 0001：阶段 0 工程基线

- 日期：2026-07-18
- 状态：已采纳

## 背景

按开发计划阶段 0 建立产品工程骨架，作为后续阶段的执行基线。

## 决策

- 使用 pnpm workspace Monorepo，包含 `apps/studio-web`、`apps/studio-service` 与 `packages/*`。
- 统一 `type: module`（ESM），TypeScript strict + `noUncheckedIndexedAccess`。
- studio-service 使用 Fastify 5，端口默认 `8932`（可用 `EASYBI_STUDIO_PORT` 覆盖）。
- studio-web 使用 React 18 + Vite 6，dev 端口 `8931`，通过 `/api` 代理到 service。
- 统一封装 `{success,requestId,data}` / `{success,requestId,error}` 放在 `@easybi-studio/contracts`。
- 测试使用 Vitest；ESLint 9 flat config；Prettier。

## 备注

阶段 0 不实现任何业务能力（Skill 同步、工作区、Claude、数据库、Runtime 均不涉及）。
包边界预留，后续阶段逐步填充 `packages/*`。
