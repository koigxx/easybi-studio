# 运行指南（怎么把项目跑起来）

> 面向第一次接手本项目的人/AI：从零到浏览器里看到 Studio 页面、跑通一次真实 AI 对话。
> 硬约束见根目录 `CLAUDE.md`；系统构成见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 0. 一眼概览

本项目是一个 **pnpm monorepo**，跑起来是两个进程：

| 进程 | 是什么 | 默认地址 |
|---|---|---|
| `studio-service` | 后端 Fastify（管理 API、任务、SQLite、Skill/Runtime 托管） | http://127.0.0.1:8932 （API 前缀 `/api/easybi`） |
| `studio-web` | 前端 Vite + React（`/api` 反代到 service） | http://127.0.0.1:8931 |

**入口从这里开始**：浏览器打开 http://127.0.0.1:8931 。前端所有请求经 `/api` 代理到 service，不需要单独访问 8932。

## 1. 前置环境

| 需要 | 版本 | 检查 / 安装 |
|---|---|---|
| Node.js | ≥ 24（本机验证 v24.16.0） | `node -v` |
| pnpm | 9（仓库锁定 `pnpm@9.15.9`） | `corepack enable pnpm` |
| 本机 Claude Code | 任意近版本 | `~/.local/bin/claude --version`（**仅真实 AI 任务需要**；不装则用 Fake Provider，页面照常可开） |

数据库不是启动前置：不连 DB 也能启动、能开页面、能做只读操作；真正连库探测/导出时才需要。

## 2. 首次运行

```bash
cd /Users/admin/innos/easy-bi-workspace/easybi-studio
corepack enable pnpm
pnpm install

# 质量门禁全绿再继续（可选但推荐）
pnpm build && pnpm typecheck && pnpm test && pnpm lint

# 起两个进程（service + web 并行）
pnpm dev
```

看到日志 `Easy BI Studio service listening on http://127.0.0.1:8932` 且 Vite 打印 `http://127.0.0.1:8931/` 后，浏览器打开 **http://127.0.0.1:8931** 即可。

> 首次没有任何工作区是正常的。用 §5 的脚本创建一个测试工作区，或在页面上创建。

## 3. 三种运行模式

| 模式 | 命令 | 用途 |
|---|---|---|
| 开发（默认） | `pnpm dev` | service `tsx watch` 热重载 + web Vite HMR |
| 只起一个 | `pnpm --filter @easybi-studio/studio-service dev`<br>`pnpm --filter @easybi-studio/studio-web dev` | 单独调后端/前端 |
| 生产式本地预览 | `pnpm build`，再分别 `pnpm --filter ...studio-service start`（`node dist/main.js`）与 `pnpm --filter ...studio-web preview` | 验证构建产物；`vite preview` 同样把 `/api` 代理到 8932 |

## 4. 环境变量（都有默认值，通常无需设置）

在 `pnpm dev` 前 `export` 或写在命令前即可。

| 变量 | 说明 | 默认 |
|---|---|---|
| `EASYBI_STUDIO_HOST` | Service 监听地址 | `127.0.0.1` |
| `EASYBI_STUDIO_PORT` | Service 端口 | `8932` |
| `EASYBI_STUDIO_WORKSPACES_ROOT` | 允许的工作区根（白名单，防越界） | `.../easybi-studio-workspaces` |
| `EASYBI_STUDIO_DATA_DIR` | Studio 数据目录（SQLite、Skill 缓存） | `~/.easybi-studio` |
| `EASYBI_STUDIO_DB_FILE` | SQLite 文件路径 | `<DATA_DIR>/studio.db` |
| `EASYBI_SKILL_SOURCE_TYPE` | 技能包来源：`local-directory` \| `local-archive` \| `http-registry` | `local-directory` |
| `EASYBI_SKILL_SOURCE_DIR` | 来源位置（按类型解释，见根 `README.md`） | `.../easy-bi` |
| `EASYBI_SKILL_SOURCE_AUTH_TOKEN_ENV` | 仅 http-registry：持 Bearer Token 的**环境变量名**（值不落盘/不入日志） | 无 |
| `EASYBI_AGENT_PROVIDER` | AI 后端：`claude`（本机） \| `innos`（预留）；**未设置=Fake 离线模拟** | 未设置 |

前端地址在 `apps/studio-web/vite.config.ts`（端口 8931 + `/api`→8932 代理），改端口需两边同步。

## 5. 同步 Skill 与创建测试工作区

页面要有东西可操作，需要一个工作区。工作区**在产品仓库之外**，一个工作区 = 一个客户系统。

```bash
cd /Users/admin/innos/easy-bi-workspace/easybi-studio

# 从正式来源同步技能包到不可变缓存并刷新 vendor/easybi-bundle
node scripts/sync-easybi-bundle.mjs

# 创建/打开一个外置测试工作区（source→cache→独立安装→lock→bootstrap）
node scripts/create-test-workspace.mjs \
  --id transport-test --name "运输测试" \
  --root /Users/admin/innos/easy-bi-workspace/easybi-studio-workspaces \
  --bundle-source local-directory --bundle-path /Users/admin/innos/easy-bi-workspace/easy-bi
```

> 改了正式来源技能包后要让 Studio 用上新版：缓存**按版本键**，需先删对应缓存目录再同步。完整流程见 [AI_CONTRIBUTING.md §4](./AI_CONTRIBUTING.md)。

## 6. 选择 AI Provider（对话/任务从哪来）

`EASYBI_AGENT_PROVIDER` 决定后端用哪个 `AgentBridge`，**前端零改动**：

- **不设**（默认）→ `FakeAgentBridge`：离线模拟，页面和对话都能开，任务返回假数据。适合只调 UI。
- `claude` → `ClaudeCodeBridge`：调本机 Claude Code 跑真实任务，需装好 `claude`。
- `innos` → `InnosAgentBridge`：接入 Innos 平台（预留，见 [INNOS_INTEGRATION.md](./INNOS_INTEGRATION.md)）。

跑真实 AI：

```bash
EASYBI_AGENT_PROVIDER=claude pnpm dev
```

自检后端连通：

```bash
curl -s http://127.0.0.1:8932/api/easybi/agent-health
```

## 7. 验证跑通（冒烟）

```bash
# service 活着？（走前端同款代理路径）
curl -s http://127.0.0.1:8931/api/easybi/agent-health

# 列出已登记项目
curl -s http://127.0.0.1:8931/api/easybi/projects
```

浏览器里：打开 http://127.0.0.1:8931 → 看到工作区 → 右上角「AI 助手」点击可开普通对话（点旁边小箭头用预置提示词）。用 `EASYBI_AGENT_PROVIDER=claude` 时对话由本机 Claude 真实驱动，关闭 Studio 后历史仍在（SQLite `job_events`）。

## 8. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 打开 8931 白屏或 `/api` 404 | service（8932）没起来；看 `pnpm dev` 里 service 那半是否报错 |
| `EADDRINUSE` 8931/8932 | 端口被占；`lsof -i:8932` 杀掉，或改 `EASYBI_STUDIO_PORT` + `vite.config.ts` |
| AI 对话没反应/返回假数据 | 没设 `EASYBI_AGENT_PROVIDER=claude`，当前是 Fake |
| `claude` provider 报找不到命令 | 本机没装 Claude Code，或不在 `~/.local/bin`；先 `claude --version` |
| 页面没有任何工作区 | 跑 §5 的 `create-test-workspace.mjs`，或页面上创建 |
| 连库探测失败 `ECONNREFUSED` | DB 未启动/地址错；这是**降级不阻断**的友好错误，不影响 Studio 本身 |
| 改了技能包 Studio 没生效 | 缓存按版本键，先删 `~/.easybi-studio/skill-cache/easybi/<version>` 再 `sync`（[AI_CONTRIBUTING.md §4](./AI_CONTRIBUTING.md)） |

## 9. 下一步

- 理解系统 → [ARCHITECTURE.md](./ARCHITECTURE.md)
- 开始开发 → [AI_CONTRIBUTING.md](./AI_CONTRIBUTING.md)（分层加功能 + 质量门禁 + 文档维护义务）
- 动 UI 前 → [UI_STYLE_GUIDE.md](./UI_STYLE_GUIDE.md)
- 接入 Innos → [INNOS_INTEGRATION.md](./INNOS_INTEGRATION.md)
