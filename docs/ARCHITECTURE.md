# Easy BI Studio 架构

> 面向新工作区 / 新贡献者的**系统级参考文档**。想了解“项目是什么、由哪些模块组成、数据怎么流动、有哪些不可违反的约束”，从这里开始。
> 开发规范与流程见 [AI_CONTRIBUTING.md](./AI_CONTRIBUTING.md)；当前进度见 [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md)。

## 1. 定位

Easy BI Studio 是一个**本地独立**的 BI 制作台：用户在本机管理“工作区（= 一个客户系统）”，由 AI（首版 Claude Code）在工作区内运行 Easy BI 技能包（Skill）来生成知识库与报表，Studio 负责编排、可视化查看、配置、测试导出与制品打包。

设计的两条主线贯穿全部模块：

- **AI 接入抽象**：所有 AI 访问经 `AgentBridge`。首个 Provider 是 `ClaudeCodeBridge`；`InnosAgentBridge` 为后续接入预留（同接口、未连接）。
- **Skill 获取抽象**：所有技能包获取经 `SkillBundleSource`。首个来源是 `LocalDirectorySource`；`LocalArchive` / `HttpRegistry` 走同一后续管线，切换来源**只改配置**。

Studio 不重复实现 HTTP/MySQL/Excel/OSS/任务等能力——这些在 bundled `easybi-runtime` 与技能包里，Studio 只做编排与代理。

## 2. 分层

```
┌─────────────────────────────────────────────────────────────┐
│ studio-web (React 18 + Vite)  只读查看 + 配置表单，无前端 AI 交互   │
└───────────────┬─────────────────────────────────────────────┘
                │ HTTP  /api/easybi/*   （dev 时 Vite 代理；线上 cloud-gateway 反代）
┌───────────────▼─────────────────────────────────────────────┐
│ studio-service (Fastify)  API 编排、鉴权边界、事件流             │
│   projects · config · knowledge · jobs · checkpoints ·        │
│   runtime(proxy) · publish · workspace-state · watch          │
└───────────────┬─────────────────────────────────────────────┘
                │ 复用
┌───────────────▼─────────────────────────────────────────────┐
│ packages/*  纯领域 SDK（无 Fastify 依赖，可独立测试）             │
│   contracts · workspace-sdk · config-sdk · agent-bridge ·     │
│   skill-bundle-source · skill-bundle-manager ·                │
│   workspace-bootstrapper · job-manager · checkpoint ·         │
│   runtime-supervisor · artifact-exporter                      │
└───────────────┬─────────────────────────────────────────────┘
                │ spawn(shell:false) / 代理
┌───────────────▼─────────────────────────────────────────────┐
│ 外部执行体：Claude Code CLI · Easy BI 技能包 · easybi-runtime      │
│ 工作区文件系统（客户数据，永不写入产品仓库）                        │
└─────────────────────────────────────────────────────────────┘
```

**分层规则**：`studio-web` 只调 `studio-service` 的 HTTP；`studio-service` 只做编排、鉴权与事件规范化，领域逻辑下沉到 `packages/*`；`packages/*` 不依赖 Fastify，可脱离服务独立单测。技能包/Runtime 是外部执行体，经 spawn 或代理调用，不把其内部逻辑复制进 Studio。

## 3. 模块地图

> 单一维护点：新增/改动模块职责时**只更新本表**。每个包都是 `@easybi-studio/<name>`。

### 应用

| 模块 | 职责 | 关键接缝 |
|---|---|---|
| `apps/studio-web` | React 查看器 + 配置表单 + **AI 对话抽屉**。IDE-Mono 主题（`--ide-*` 令牌）。AI 生成经 AgentBridge/Job/SSE，Provider 可切（本机 Claude→Innos），前端不直连厂商 API。 | `api.ts`（唯一 HTTP 出口，含 `agentApi`）、`AgentDrawer.tsx`（全局抽屉 + `useAgentDrawer`）、`panels/*`（各页面）、`panels/*-config.ts`/`*-view.ts`/`agent-chat.ts`（可独立单测的纯逻辑）、`theme.ts` |
| `apps/studio-service` | Fastify API：编排、127.0.0.1 绑定、`/api/easybi` 前缀、SSE/NDJSON 事件流、日志脱敏。 | `app.ts`（组装 + `register*Routes`）、`skill-source/resolve.ts`（来源切换唯一接缝）、各 `*/routes.ts` |

### 领域包（`packages/*`）

| 包 | 职责 | 关键接缝 / 导出 |
|---|---|---|
| `contracts` | 全站类型与 `{success,requestId,data|error}` 信封。被 89 处引用，是类型单一真源。 | `envelope`、`project`、`job`、`checkpoint`、`agent`、`artifact`、`skill-bundle`、`bootstrap`、`diagnostic` |
| `workspace-sdk` | 工作区文件系统读写：路径解析与防穿越、知识库目录/编辑、报表状态、Skill 适配器。 | `paths.resolveWithinWorkspace`、`skill-adapter`（Skill 路径经 manifest）、`knowledge-catalog`/`knowledge-edit`/`knowledge-state`、`report-state`、`structure`、`workflow` |
| `config-sdk` | `config/easy-bi.json` 读写：revision（SHA-256）乐观锁 + 原子写 + 备份；MySQL 测试连接适配器。 | `store`（revision/原子写）、`validate`、`mysql-adapter`（`RealMysqlAdapter` 只读 SELECT 1 / `FakeMysqlAdapter` 离线） |
| `agent-bridge` | AI 接入抽象。三 Provider 同接口。事件规范化与脱敏。 | `AgentBridge` 接口、`ClaudeCodeBridge`（真实）、`FakeAgentBridge`（离线）、`InnosAgentBridge`（预留存根）、`redact`、`event-queue` |
| `skill-bundle-source` | 技能包**获取**抽象：白名单快照 + SHA-256 校验。 | `SkillBundleSource` 接口、`LocalDirectorySource`（首版）、保留 `LocalArchive`/`HttpRegistry`、`whitelist`、`hash`、`snapshot` |
| `skill-bundle-manager` | 不可变版本**缓存** + 工作区独立安装 + `bundle.lock.json`。 | `cache`（版本键缓存）、`lock`（生成/校验 lock） |
| `workspace-bootstrapper` | 创建工作区：建目录 → 装技能包 → 写 lock → bootstrap init/check → 登记。 | `create-workspace`、`bootstrapper`、`templates` |
| `job-manager` | Agent 写任务生命周期：PID/session/exit/artifacts 跟踪，事件规范化。 | `manager`、`normalize` |
| `checkpoint` | 写任务前后检查点 + diff + 撤销。 | `manager`、`diff` |
| `runtime-supervisor` | 动态端口托管 bundled `easybi-runtime`，三接口透明代理。 | `supervisor`（启停/就绪探测）、`port` |
| `artifact-exporter` | 制品打包：仅 development 可构建（tar.gz + 校验清单 + 脱敏）；candidate/production 仅预检。 | `build`、`precheck` |

## 4. 目录与数据布局

```
easybi-studio/                        # 产品仓库（永不写入客户数据）
├── apps/{studio-web,studio-service}
├── packages/*                        # 领域 SDK
├── scripts/{sync-easybi-bundle,create-test-workspace}.mjs
├── vendor/easybi-bundle              # 从正式来源同步的技能包快照（只读产物）
├── docs/                             # 见 docs/README.md
└── tests/                            # 跨包集成测试

~/.easybi-studio/                     # Studio 数据目录（EASYBI_STUDIO_DATA_DIR）
├── studio.db                         # 项目登记、任务、job_events、检查点索引（EASYBI_STUDIO_DB_FILE）
└── skill-cache/easybi/<version>/     # 不可变版本缓存（按版本键）

<workspaces-root>/<id>/               # 一个工作区 = 一个客户系统（在产品仓库之外）
├── skills/                           # 独立安装的技能包 + bundle.lock.json
├── config/easy-bi.json              # 连接/OSS/报表配置（revision 乐观锁）
├── knowledge/{drafts,versions,scans} # 草稿可改；versions/ 不可变
└── reports/{index.json,packages/<id>/<version>/}  # 已发布包不可原地覆盖
```

## 5. 关键流程

- **技能包同步**：`scripts/sync-easybi-bundle.mjs`：正式来源 → `SkillBundleSource` 白名单快照 + SHA-256 → 写入不可变版本缓存 → 刷新 `vendor/easybi-bundle`。**缓存按版本键**，改了技能包需先删对应缓存目录再同步（否则复用旧版）。
- **创建工作区**：`POST /api/easybi/projects/create` → `workspace-bootstrapper`：建目录 → 从缓存独立安装技能包 → 写 lock → bootstrap init → 登记进 SQLite。既有工作区**不自动升级**。
- **知识库**：AI 在工作区跑知识库 Skill → 产物默认落 `knowledge/drafts/`（草稿）。Studio 提供草稿可视化编辑与发布；发布生成 `knowledge/versions/<semver>/`（不可变），草稿保留供后续迭代。
- **枚举中文映射**：知识库 `build` 自动做非阻断枚举初始化（真实 distinct 探测带 LIMIT + 短超时 + 只读事务，绝不覆盖人工 label）。Studio 枚举页经 Skill 适配器读写，字段绑定 ↔ 枚举字典，JSON/Excel 双通道。
- **报表**：报表配置写入 `config/easy-bi.json`；AI 跑报表 Skill 生成报表包（格式 v2）到 `reports/packages/`。development-only 包可在页面删除；已发布包受保护。
- **同步导出**：测试页命中 `runtime-supervisor` 代理的 `easybi-runtime`，Excel 二进制触发下载；未配 DB/OSS 时返回 HTTP-200 JSON 友好错误，**静态校验绝不记为成功导出**。
- **AI 对话**：前端全局对话抽屉（`AgentDrawerProvider`）→ `POST /agent-actions`（带 action + 可选自由文本）→ `JobManager` 起写/读任务（写任务先建检查点）→ `AgentBridge` Provider（本机 `ClaudeCodeBridge`）执行 → 事件经 `normalizeAgentEvent` 归一为 `JobEvent` → `GET /jobs/:id/events`(SSE) 流式回前端 → `panels/agent-chat.ts` 折叠成对话视图，`ChatMarkdown.tsx` 渲染 Markdown。**多轮**经 `/agent-tasks/:id/messages`：真实 Claude 每轮以 `completed` 收尾（不发 `waiting_for_user`），回复时 `replyToJob` 从 SUCCEEDED 续轮（`--resume <session>` + 重新 pump 新事件流，`JOB_TRANSITIONS` 允许 `SUCCEEDED→RUNNING`）。回复后前端重新订阅 SSE 时带 `?since=<已消费事件数>` 游标，`subscribe(jobId, since)` 只重放未看过的事件、并按任务真实状态（而非最后缓冲事件）决定关流，避免重放上一轮 `job_completed` 导致新一轮无响应。前端把连续 tool 行折叠成可展开分组（`groupRows`），`job_completed.summary` 与末尾 assistant 行同文时不重复渲染。**终止**经 `POST /agent-tasks/:id/interrupt`（`AgentBridge.interrupt?`）：停当前轮但保留 session，任务落 SUCCEEDED 可继续对话，区别于 `POST /cancel`（终态 CANCELED）。删除历史经 `DELETE /agent-tasks/:id`（级联 job_events；活跃任务 409）。**普通对话**：`action='free-chat'`（只读、不占写锁）发用户原文，不套模板。**可配置预置提示词**：各 skill 的 `prompts.json`（manifest `agent_prompts` 引用）→ 首次回退默认；`GET/PUT /projects/:id/agent-prompts` 存到 config 可选 `agent_prompts` 块（`buildActionPrompt` 的 `fullPrompt` 覆盖内置模板）。**对话持久化**：每个 `JobEvent` 落 SQLite `job_events` 表（`0003`），重启后 `POST /agent-tasks/:id/reopen` 从库重建会话供查看，并可用保存的 `session_id`（`AgentBridge.rehydrate` + `--resume`）继续追问——像 Claude Code 一样关闭后仍能找回。**Provider 切换是后端环境变量（`EASYBI_AGENT_PROVIDER`），前端零改动**；前端不直连任何 AI 厂商 API。

## 6. 安全不变量（任何改动都必须守住）

- **目录边界**：客户数据只进工作区，**永不写入产品仓库**；正式 Easy BI 来源 (`/Users/admin/innos/easy-bi-workspace/easy-bi`) 默认只读；工具全权限不等于可越界到已登记产品/工作区目录之外。
- **路径**：一切工作区路径经 `workspace-sdk` 解析并防穿越；技能包路径经 `bundle.manifest.json` + Skill 适配器，**不硬编码 Skill 深层目录**。
- **进程**：`child_process.spawn` + `shell:false` + 数组参数 + `cwd=工作区`；只停 Studio 自己启动的进程。
- **数据库**：只读，禁止 DDL/DML；探测扫描带 LIMIT + 服务端/客户端超时 + 只读事务，降级不阻断。支持 MySQL（默认）与 PostgreSQL，经 skill 的 `dialect.ts` 方言层分派（`connector_id` 决定）；报表包记录 `sql_dialect`。新增引擎 = 实现方言接口，不改扫描/生成主流程。
- **密钥**：DB 密码 / API Key / OSS Key / Token 绝不进日志、快照、发布版本、前端。
- **版本**：已发布知识库版本与报表包**不可原地覆盖**；既有工作区**不静默升级**。
- **契约**：改公共契约需分类（内部 / 兼容扩展 / 破坏性）；破坏性需 `catalog_format_version` bump + 迁移 + 回滚 + 变更记录。
- **门禁**：TS strict；每个 Agent 写任务先建检查点与变更摘要；无错误/取消/重启/空态处理不算完成。

## 7. 接入 Innos（预留，未连接）

Provider 经 `buildApp` 注入切换（`EASYBI_AGENT_PROVIDER=innos`）。接入时 Innos 只需：实现 `InnosAgentBridge`、进程托管、cloud-gateway 反代 `/api/easybi/* → 127.0.0.1:8932`、可选实现 `HttpRegistrySource` 的三只读接口。Studio 页面与 Easy BI 业务模块无需重写。客户数据库与工作区**不经过 cloud-gateway**。详见 [INNOS_INTEGRATION.md](./INNOS_INTEGRATION.md)。
