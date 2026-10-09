# Easy BI Studio

本地独立的 Easy BI Studio 产品工程。先对接本机 Claude Code，初版，功能暂未完善。
**单仓库分发**：本仓库同时包含 Studio 应用代码与内置的技能包源（`skill-source/easy-bi/`）。
`git clone` 一个仓库即可获得运行所需的全部内容——无需另外获取技能包。

## 快速上手（拉取即用）

```bash
# 1. 克隆并安装依赖
git clone <仓库地址> easybi-studio
cd easybi-studio
corepack enable pnpm
pnpm install

# 2. 启动（前后端并行）
pnpm dev
# studio-service: http://127.0.0.1:8932   （管理 API 前缀 /api/easybi）
# studio-web:     http://127.0.0.1:8931   （通过 /api 代理到 service）
```

然后在页面上：**新建工作区** → Studio 自动把技能包装入本地工作区目录 → **配置数据库/OSS 连接**（写入本地工作区，不入库）→ 扫描知识库、生成报表、预览导出。

> 技能包的编译产物（`dist/scripts`）已随仓库分发，因此新建工作区**无需先编译技能包**。
> 只有应用依赖需要 `pnpm install`。

## 目录布局

```
easybi-studio/                 ← 本仓库（git 根）
├── apps/                      ← studio-service（后端）+ studio-web（前端）
├── packages/                  ← 领域包（skill-bundle-*、workspace-*、runtime-* 等）
├── skill-source/              ← 技能包源容器（可扩展多个技能包）
│   └── easy-bi/               ← 内置技能包源（skills/ + toolkit/，含编译产物）
├── scripts/                   ← sync / create-workspace 等运维脚本
├── docs/                      ← 文档
└── vendor/easybi-bundle/      ← sync 产物（不入库，可重新生成）

<仓库外>
easybi-studio-workspaces/      ← 测试工作区根（由 Studio 自动创建，不入库）
```

**路径自解析**：默认技能源指向仓库内 `skill-source/easy-bi/`，工作区根指向仓库外同级
`easybi-studio-workspaces/`。二者均由代码相对本仓库位置推导，**克隆到任意目录都可直接运行，无需配置环境变量**。

## 环境要求

- Node.js 24（本机 v24.16.0）
- pnpm 9（`corepack enable pnpm`）
- 本机 Claude Code（`~/.local/bin/claude`，用于真实 Agent 任务；缺省则走 Fake Bridge）

## 质量门禁

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

## 什么入库 / 什么不入库

本仓库只包含**基础代码 + 基础技能包源**；一切「拉取后 install / build / 运行 / 配置」产生的内容都是用户本地的，不入库。

| 入库 | 不入库（本地产生） |
|---|---|
| 应用代码 `apps/` `packages/` `tests/` `scripts/` | `node_modules/`（`pnpm install`） |
| 技能包源 `skill-source/easy-bi/`（含 `dist/` 发布制品、空外壳目录） | 应用构建产物 `apps|packages/**/dist/` |
| 依赖锁 `pnpm-lock.yaml`、`npm-shrinkwrap.json` | `vendor/`（`sync` 产物，可重新生成） |
| 文档 `docs/` `README.md` `CLAUDE.md` | 工作区 `easybi-studio-workspaces/`（含连接密钥） |
| | 工作区实例 `toolkit/config/runtime.json`（OSS key / 业务 token） |
| | 个人工具配置 `.claude/` `.idea/` |

> 技能包 `dist/` 是**例外中的合理项**：它是随包分发给工作区的「发布制品」，入库才能实现零构建即用。
> 敏感信息（数据库明文密码、OSS/业务 token）只在工作区内，随工作区整体排除。

## 常用环境变量（均有默认值，一般无需设置）

| 变量 | 说明 | 默认 |
|---|---|---|
| `EASYBI_STUDIO_HOST` | Service 监听地址 | 127.0.0.1 |
| `EASYBI_STUDIO_PORT` | Service 端口 | 8932 |
| `EASYBI_STUDIO_WORKSPACES_ROOT` | 允许的工作区根 | 仓库外同级 `easybi-studio-workspaces/` |
| `EASYBI_STUDIO_DATA_DIR` | Studio 数据目录（SQLite、Skill 缓存） | `~/.easybi-studio` |
| `EASYBI_STUDIO_DB_FILE` | SQLite 文件路径 | `<DATA_DIR>/studio.db` |
| `EASYBI_SKILL_SOURCE_TYPE` | 技能包来源类型：`local-directory` \| `local-archive` \| `http-registry` | local-directory |
| `EASYBI_SKILL_SOURCE_DIR` | 来源位置（见下表按类型解释） | 仓库内 `skill-source/easy-bi/` |
| `EASYBI_SKILL_SOURCE_AUTH_TOKEN_ENV` | 仅 http-registry：持有 Bearer Token 的环境变量名（值不落盘/不入日志） | 无 |
| `EASYBI_AGENT_PROVIDER` | `claude` \| `innos`（否则 Fake） | 未设置=Fake |

### 切换技能包来源（只改配置，不改业务代码）

| `EASYBI_SKILL_SOURCE_TYPE` | `EASYBI_SKILL_SOURCE_DIR` 填什么 |
|---|---|
| `local-directory`（默认） | 技能包目录路径，默认仓库内 `skill-source/easy-bi/` |
| `local-archive` | 本地 `.tar.gz` 压缩包路径 |
| `http-registry` | 云端 Registry 基址，如 `https://registry.example.com/easybi` |

三种来源走完全相同的后续管线（下载/读取 → 白名单 + SHA-256 校验 → 本地不可变缓存 → 装入工作区）。
云端 Registry 接口约定见 `docs/INNOS_INTEGRATION.md` §3。

## 维护技能包

技能包源在 `skill-source/easy-bi/`。修改流程：

```bash
# 1. 改技能源码：skill-source/easy-bi/skills/<skill>/scripts/*.ts
# 2. 编译（在对应 skill 目录内）：npm run build   → 更新 dist/scripts
# 3. （可选）刷新 vendor 快照：node scripts/sync-easybi-bundle.mjs
# 4. 提交：因 dist/ 入库，务必把新编译产物一并提交，别人才能拿到新版
```

> `vendor/` 不入库，但技能包的 `dist/` 入库——所以改技能包后**必须提交更新后的 `dist/`**。

## 同步 Skill 与创建测试工作区

```bash
# 从技能源同步到本地不可变缓存并刷新 vendor/easybi-bundle（默认源 = skill-source/easy-bi）
node scripts/sync-easybi-bundle.mjs

# 创建/打开一个测试工作区（source→cache→独立安装→lock→bootstrap；默认落在仓库外同级根）
node scripts/create-test-workspace.mjs --id transport-test --name "运输测试"
```

## 关键设计

- **Skill 获取**：`SkillBundleSource`（`LocalDirectorySource` / `LocalArchiveSource` / `HttpRegistrySource`）→ 本地不可变版本缓存 → 工作区独立安装（`skills/bundle.lock.json`）。
- **AI 接入**：`AgentBridge`（`ClaudeCodeBridge` 真实 / `FakeAgentBridge` 离线 / `InnosAgentBridge` 预留）。前端只经 AgentBridge + Job/SSE 管线，绝不直连任何 AI 厂商 API。
- **路径解析**：全部经 `WorkspaceSkillAdapter` + `bundle.manifest.json`，页面不硬编码 Skill 深层目录。
- **安全**：工作区根白名单 + 防穿越、配置 revision 冲突、原子写入、日志脱敏、写任务互斥、数据库只读、技能源只读。
- **Runtime**：`RuntimeSupervisor` 动态端口托管 bundled easybi-runtime，三接口透明代理。
- **制品**：仅 development 可构建（tar.gz + 校验清单 + 脱敏），candidate/production 仅预检。

## 文档

新贡献者请按此顺序读（完整索引见 `docs/README.md`）：

1. `CLAUDE.md`（根目录）—— 硬约束，最高优先级。
2. `docs/GETTING_STARTED.md` —— 环境、启动、Provider、冒烟验证、常见问题。
3. `docs/ARCHITECTURE.md` —— 系统构成、模块地图、数据流、安全不变量。
4. `docs/AI_CONTRIBUTING.md` —— 上手、分层加功能、技能包同步、质量门禁、文档维护义务。
5. `docs/IMPLEMENTATION_STATUS.md` —— 当前进度与变更历史。
6. `docs/UI_STYLE_GUIDE.md`（动 UI 前必读）、`docs/INNOS_INTEGRATION.md`（动接入前必读）。
