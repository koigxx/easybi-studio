# Easy BI Studio

本地独立的 Easy BI Studio 产品工程。先对接本机 Claude Code，后续通过 AgentBridge 适配接入 Innos。

## 目录边界

- 产品源码：`/Users/admin/innos/easy-bi-workspace/easybi-studio`（本仓库）
- 测试工作区根：`/Users/admin/innos/easy-bi-workspace/easybi-studio-workspaces`
- 正式 Easy BI 来源（只读，Skill 快照唯一来源）：`/Users/admin/innos/easy-bi-workspace/easy-bi`

## 环境要求

- Node.js 24（本机 v24.16.0）
- pnpm 9（`corepack enable pnpm`）
- 本机 Claude Code（`~/.local/bin/claude`，用于真实 Agent 任务）

## 安装与质量门禁

```bash
cd /Users/admin/innos/easy-bi-workspace/easybi-studio
corepack enable pnpm
pnpm install
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

## 启动

```bash
pnpm dev
# studio-service: http://127.0.0.1:8932   （管理 API 前缀 /api/easybi）
# studio-web:     http://127.0.0.1:8931   （通过 /api 代理到 service）
```

> 完整运行指南（运行模式、Provider 切换、冒烟验证、常见问题）见 `docs/GETTING_STARTED.md`。

常用环境变量（均有默认值）：

| 变量 | 说明 | 默认 |
|---|---|---|
| `EASYBI_STUDIO_HOST` | Service 监听地址 | 127.0.0.1 |
| `EASYBI_STUDIO_PORT` | Service 端口 | 8932 |
| `EASYBI_STUDIO_WORKSPACES_ROOT` | 允许的工作区根 | /Users/admin/innos/easy-bi-workspace/easybi-studio-workspaces |
| `EASYBI_STUDIO_DATA_DIR` | Studio 数据目录（SQLite、Skill 缓存） | ~/.easybi-studio |
| `EASYBI_STUDIO_DB_FILE` | SQLite 文件路径 | \<DATA_DIR\>/studio.db |
| `EASYBI_SKILL_SOURCE_TYPE` | 技能包来源类型：`local-directory` \| `local-archive` \| `http-registry` | local-directory |
| `EASYBI_SKILL_SOURCE_DIR` | 来源位置（见下表按类型解释） | /Users/admin/innos/easy-bi-workspace/easy-bi |
| `EASYBI_SKILL_SOURCE_AUTH_TOKEN_ENV` | 仅 http-registry：持有 Bearer Token 的环境变量名（值不落盘/不入日志） | 无 |
| `EASYBI_AGENT_PROVIDER` | `claude` \| `innos`（否则 Fake） | 未设置=Fake |

### 切换技能包来源（只改配置）

来源类型与 `EASYBI_SKILL_SOURCE_DIR` 的含义：

| `EASYBI_SKILL_SOURCE_TYPE` | `EASYBI_SKILL_SOURCE_DIR` 填什么 |
|---|---|
| `local-directory`（默认） | 技能包目录路径，如 `/Users/admin/innos/easy-bi-workspace/easy-bi` |
| `local-archive` | 本地 `.tar.gz` 压缩包路径 |
| `http-registry` | 云端 Registry 基址，如 `https://registry.example.com/easybi` |

云端 Registry 只需提供三个只读接口（见 `docs/INNOS_INTEGRATION.md` §3）：
`GET /bundles/{id}/versions`、`GET /bundles/{id}/{version}/manifest`、`GET /bundles/{id}/{version}/archive`（不可变 tar.gz）。
Studio 下载压缩包 → 解压 → 复用同一白名单/SHA-256 校验 → 写入本地不可变缓存 → 装入工作区。三种来源走完全相同的后续管线；切换来源**不需要改任何业务代码**。

示例（用云端来源启动）：

```bash
EASYBI_SKILL_SOURCE_TYPE=http-registry \
EASYBI_SKILL_SOURCE_DIR=https://registry.example.com/easybi \
EASYBI_SKILL_SOURCE_AUTH_TOKEN_ENV=EASYBI_REGISTRY_TOKEN \
EASYBI_REGISTRY_TOKEN=*** \
pnpm dev
```

## 同步 Skill 与创建测试工作区

```bash
# 从正式来源同步到本地不可变缓存并刷新 vendor/easybi-bundle
node scripts/sync-easybi-bundle.mjs

# 创建/打开一个外置测试工作区（source→cache→独立安装→lock→bootstrap）
node scripts/create-test-workspace.mjs \
  --id transport-test --name "运输测试" \
  --root /Users/admin/innos/easy-bi-workspace/easybi-studio-workspaces \
  --bundle-source local-directory --bundle-path /Users/admin/innos/easy-bi-workspace/easy-bi
```

## 关键设计

- Skill 获取：`SkillBundleSource`（首版 `LocalDirectorySource`；保留 LocalArchive/BuiltIn/HttpRegistry）→ 本地不可变版本缓存 → 工作区独立安装（`skills/bundle.lock.json`）。
- AI 接入：`AgentBridge`（`ClaudeCodeBridge` 真实 / `FakeAgentBridge` 离线 / `InnosAgentBridge` 预留）。
- 路径解析：全部经 `WorkspaceSkillAdapter` + `bundle.manifest.json`，页面不硬编码 Skill 深层目录。
- 安全：工作区根白名单 + 防穿越、配置 revision 冲突、原子写入、日志脱敏、写任务互斥、数据库只读、正式来源只读。
- Runtime：`RuntimeSupervisor` 动态端口托管 bundled easybi-runtime，三接口透明代理。
- 制品：仅 development 可构建（tar.gz + 校验清单 + 脱敏），candidate/production 仅预检。

## 文档

新工作区/贡献者请按此顺序读（完整索引见 `docs/README.md`）：

1. `CLAUDE.md`（根目录）—— 硬约束，最高优先级。
2. `docs/GETTING_STARTED.md` —— 先把项目跑起来：环境、启动、Provider、冒烟验证、常见问题。
3. `docs/ARCHITECTURE.md` —— 系统构成、模块地图、数据流、安全不变量。
4. `docs/AI_CONTRIBUTING.md` —— 上手、分层加功能、技能包同步、质量门禁、文档维护义务。
5. `docs/IMPLEMENTATION_STATUS.md` —— 当前进度与变更历史。
6. `docs/UI_STYLE_GUIDE.md`（动 UI 前必读）、`docs/INNOS_INTEGRATION.md`（动接入前必读）。
