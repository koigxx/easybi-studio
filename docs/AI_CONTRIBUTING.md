# AI / 贡献者开发指南

> 面向在**其他工作区**接手本项目的 AI 代理与人类开发者。目标：快速理解项目、按规范开发、开发完成后同步维护文档。
> 系统架构见 [ARCHITECTURE.md](./ARCHITECTURE.md)；不可违反的约束见根目录 `CLAUDE.md`。

## 1. 上手：必读顺序

按此顺序读，读完即可动手：

1. `CLAUDE.md`（根目录）——**最高优先级的硬约束**，覆盖一切默认行为。
2. [GETTING_STARTED.md](./GETTING_STARTED.md)——先把项目跑起来：环境、启动、Provider、冒烟验证、常见问题。
3. [ARCHITECTURE.md](./ARCHITECTURE.md)——系统构成、模块地图、数据流、安全不变量。
4. [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md)——当前进度、阶段表、仍待外部输入项。
5. 动 UI 前必读 [UI_STYLE_GUIDE.md](./UI_STYLE_GUIDE.md)；动接入/传输前必读 [INNOS_INTEGRATION.md](./INNOS_INTEGRATION.md)。
6. 正式来源的规范（只读）：`easy-bi/docs/总体架构.md`、`开发维护指南.md`、`skills/目录与项目兼容性规范.md`、`toolkit/contracts/统一接口契约.md`，以及要动的那个技能包的 `SKILL.md`。

## 2. 仓库导航

- 找**类型/契约** → `packages/contracts`（全站单一真源）。
- 找**某页面** → `apps/studio-web/src/panels/<Name>Panel.tsx`；其纯逻辑在同目录 `*-config.ts` / `*-view.ts`（**有独立单测，逻辑放这里**）。
- 找**某 API** → `apps/studio-service/src/<domain>/routes.ts`，在 `app.ts` 里 `register*Routes` 组装。
- 找**工作区文件读写** → `packages/workspace-sdk`。
- 找**配置读写** → `packages/config-sdk`。
- 模块职责一览 → [ARCHITECTURE.md §3 模块地图](./ARCHITECTURE.md#3-模块地图)。

## 3. 按层加功能

沿用现有分层，不要把领域逻辑写进路由或 React 组件：

1. **契约先行**：新增/改动类型放 `packages/contracts`，用信封 `{success,requestId,data|error}`。
2. **领域逻辑**：写进对应 `packages/*`（纯函数/类，不依赖 Fastify），配单测。
3. **API**：在 `apps/studio-service/src/<domain>/routes.ts` 暴露，`app.ts` 注册，配路由测试。
4. **前端**：纯逻辑放 `panels/*-config.ts`/`*-view.ts`（配单测），组件放 `panels/*Panel.tsx`，HTTP 只经 `api.ts`。UI 一律用 `--ide-*` 令牌 / `.ide-*` 类，禁止一次性样式。
5. **收尾**：错误、取消、重启、空态四类处理齐全，否则不算完成。

## 4. 技能包同步工作流

改**正式来源技能包**（需用户明确授权，正式来源默认只读）后，让 Studio 用上新版：

```bash
# 1. 在正式技能包目录构建
cd <canonical skill dir> && npm run build
# 2. 删旧版本缓存（缓存按版本键，否则复用旧版）
rm -rf ~/.easybi-studio/skill-cache/easybi/<version>
# 3. 刷新不可变缓存 + vendor 快照
node scripts/sync-easybi-bundle.mjs
# 4. 既有工作区不自动升级——如需，手动把 dist/scripts/*.js 拷入该工作区已安装的技能包
```

技能包 CLI 只经 `SkillBundleSource` 获取、经 `WorkspaceSkillAdapter` + `bundle.manifest.json` 解析路径调用——**不要在 Studio 里重实现 CLI 逻辑，不要硬编码技能包深层路径**。

## 5. 质量门禁

提交/收尾前必须全绿：

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

- TS strict + `noUncheckedIndexedAccess`。
- 单测覆盖：路径检查、配置冲突、事件规范化、任务状态迁移。
- 集成测试：ClaudeCodeBridge（假 CLI）、Runtime 代理二进制/JSON。
- 关键流程：Playwright 覆盖配置/知识库/报表/测试/发布。
- 每个 Agent 写任务必须先建检查点与变更摘要；静态校验绝不当作真实导出成功。

## 6. 契约变更分类

改动公共契约（`packages/contracts`、技能包对外接口、Runtime API、目录格式）前先分类：

- **内部**：不影响外部 → 直接改。
- **兼容扩展**：只增不改（如新增可选字段、新 CLI 命令）→ 在 `easy-bi/skills/兼容性变更记录/` 写变更记录。
- **破坏性**：改/删既有字段或行为 → `catalog_format_version` bump + 迁移 + 回滚方案 + 变更记录，并先与用户确认。

## 7. 文档维护义务（开发完成后必做）

**改完代码就同步文档**——这是硬要求，不是可选项。对照下表：

| 你改了什么 | 必须更新 |
|---|---|
| 新增/改动模块职责、包边界、数据流 | [ARCHITECTURE.md](./ARCHITECTURE.md)（§3 模块地图 / §5 流程） |
| 完成一个增量或阶段 | [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md)（更新“当前状态”快照 + 在历史区追加一条：改动文件、测试结果、已知问题、下一步） |
| 动了 UI 令牌/组件/布局约定 | [UI_STYLE_GUIDE.md](./UI_STYLE_GUIDE.md) |
| 动了接入/传输/反代/事件映射 | [INNOS_INTEGRATION.md](./INNOS_INTEGRATION.md) |
| 破坏性/兼容扩展契约变更 | `easy-bi/skills/兼容性变更记录/`（正式来源，需授权） |
| 环境变量、启动/同步命令、目录边界 | 根目录 `README.md` + [GETTING_STARTED.md](./GETTING_STARTED.md) |
| 运行模式、端口、Provider 切换、冒烟步骤、常见问题 | [GETTING_STARTED.md](./GETTING_STARTED.md) |
| 新增一份文档 | [docs/README.md](./README.md) 索引 |
| 长期开发约定、经验教训 | 根目录 `CLAUDE.md`（仅限真正的硬规则） |

原则：**只写代码/仓库/git 历史推导不出的东西**；不重复代码结构；相对日期转绝对日期；`IMPLEMENTATION_STATUS.md` 只在代码与测试都完成后更新。
