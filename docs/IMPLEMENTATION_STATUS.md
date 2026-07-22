# Easy BI Studio 实施状态

最后更新时间：2026-07-23

> 本文档分三区：**① 当前状态快照**（现在是什么样）→ **② 变更历史**（倒序增量）→ **③ 历史阶段记录**（各阶段任务/测试归档）。
> 架构见 [ARCHITECTURE.md](./ARCHITECTURE.md)；开发规范见 [AI_CONTRIBUTING.md](./AI_CONTRIBUTING.md)。
> 完成一个增量或阶段后，更新本区快照 + 在 ② 追加一条（改动文件、测试结果、已知问题、下一步）。

---

## ① 当前状态快照

**阶段 0–9 全部完成。** 核心能力已闭环：工作区创建/编排、知识库草稿-发布双视图与可视化编辑、枚举中文映射、报表配置与生成、同步导出、制品打包、Innos 适配契约冻结、**前端 AI 对话抽屉（经 AgentBridge，Provider 可切）**。

### 阶段表

| 阶段 | 名称 | 状态 |
|---|---|---|
| 0 | 工程初始化与执行基线 | ✅ 已完成 |
| 1 | Contracts、SQLite 和项目登记 | ✅ 已完成 |
| 2 | Skill 最小快照与测试工作区创建 | ✅ 已完成 |
| 3 | 配置中心、引导流程和环境诊断 | ✅ 已完成 |
| 4 | 任务系统、Fake AgentBridge 和全局 Agent 抽屉 | ✅ 已完成 |
| 5 | 检查点、差异、撤销和 ClaudeCodeBridge | ✅ 已完成 |
| 6 | 知识库和报表工作流 | ✅ 已完成 |
| 7 | Runtime Supervisor 和报表测试体验 | ✅ 已完成（真实同步导出待 DB） |
| 8 | 开发测试制品 | ✅ 已完成 |
| 9 | Innos 适配准备 | ✅ 已完成 |

### 当前版本

- Bundle `1.29.5`、知识库 Skill `0.16.0`、报表 Skill `2.26.5`（开发版）。
- 数据库支持：MySQL（默认）与 PostgreSQL，经方言层分派；连接类型在配置页可选。
- 每个 Skill 含面向开发者/管理员的 `使用说明.md`；报表计划为 v2，报表包支持 v2 声明式和 v3 隔离脚本（v1 不读取、不迁移、不执行）；Runtime HTTP API 仍为 v1。
- 每次同步生成新的不可变版本缓存与 `vendor/easybi-bundle` 快照，不覆盖旧缓存。

### 仍待外部输入（非阻塞，阶段门禁允许）

1. **真实 MySQL 连接信息**（host/port/username/password 或 password_env/数据库名）：用于真实知识库扫描与真实同步 Excel 导出（阶段 6/7 的 DB 依赖）。
2. **OSS 与业务任务接口配置**：用于异步导出真实联调（无配置时正确返回 `OSS_PROFILE_UNAVAILABLE`）。
3. **业务语义确认**：热温冷分层、枚举中文映射、报表计划语义——由 Claude 提出、用户确认。

以上均为“外部输入”，不阻塞已完成的全部非 DB 能力。旧工作区策略：不迁移、不备份 v1 报表资产；用户明确升级后才删除 v1 索引/计划/报表包重生成 v2。`transport-test` 尚未被修改。

---

## ② 变更历史（倒序）

### 策略分流、逐查询 Agent 与原子发布（bundle 1.29.5）（2026-07-23）

- **策略正确分流**：模型批准结果返回 `strategy/query_ids`。`sql/enrichment/group_queries` 只用 fresh Agent 复核 `declarative-configuration.json`，随后确定性生成 v2；仅 `script` 进入 v3 查询和脚本编译，简单报表不再被强制脚本化。
- **一个查询一个上下文**：v3 每个 query contract 分配独立 `AgentRun.unitId` 和全新 Provider session；当前 run 只携带一个契约及精确知识切片，全部查询逐个通过后才启动脚本 Agent。一个逻辑 Job、SSE 和前端对话保持不变。
- **构建隔离与审计**：任务创建时生成不可变 `reportRevision`，阶段目录改为 `work/report-build/<report-id>/<revision>`；Job/AgentRun 经 migration `0006` 持久化 revision 与 unit。批准人来自 `X-EasyBI-User`（本地回退 `local-user`），不再硬编码；首个 Agent 启动前检查工作区 bundle 是否具备 staged CLI，旧工作区明确提示显式升级且不静默升级。
- **契约和发布门禁**：查询 SQL 的外层 SELECT 必须逐列显式 `AS` 且名称/顺序与批准契约完全一致；`validate-stage --query-id` 可只校验本次查询。`finalize-staged` 先在 revision 内生成候选包并静态校验，再移动到最终版本目录、最后更新索引；碰撞或失败恢复原计划/索引并清理候选，禁止半成品进入报表列表。
- **前端失败恢复**：确认模型、批准模型和新对话请求失败时，AI 抽屉恢复原阶段、等待问题和输入文本，不再永久停在伪 `RUNNING` 状态。
- **改动文件**：Contracts、migration/JobStore、JobManager、Service 路由/提示词/staged runner、AgentDrawer；报表 Skill CLI/测试/SKILL/提示词/编译制品；Bundle manifest/index、架构与 Innos 文档。
- **测试与分发**：报表 Skill 85/85、JobManager 15/15、Studio Web 91/91、Staged Workflow runner 3/3、Bundle Source 6 通过（5 个可选源跳过）、Workspace Bootstrapper 6/6；全仓 build/typecheck、变更产品文件定向 ESLint 通过。migration `0001–0006` 用 Node 内置 SQLite 验证两次执行幂等，并验证 `reportRevision/unitId` 持久化。Bundle 1.29.5 已同步到不可变缓存与 vendor（SHA-256 `fbc68eef…`），vendor `doctor` 验证 staged workflow v2 能力。Studio Service 全套 Vitest 仍受当前 Windows 的既有 `better-sqlite3` 原生绑定缺失和部分测试旧绝对源路径影响。
- **已知问题与下一步**：静态阶段已把 SQL 输出名称/顺序绑定到批准契约，但真实数据库返回类型与业务数据正确性仍需连接真实库做 preview/Excel 验收；结构化模型差异视图和 `failure.json` 自动定向回退仍可继续增强。

### 分阶段产物门禁与确定性装配闭环（bundle 1.28.0）（2026-07-22）

- **修复 SSE 游标错位**：前端补齐 `run_started/run_completed/user_message` 监听，消费事件数现在与后端持久化序号严格一致；阶段确认后重订阅不会再重放旧 `job_completed` 并提前断流。
- **稳定任务范围**：创建/修改报表必须携带 `reportId`，写入 Job 与 SQLite（migration `0005`），新 Agent 提示词包含固定 `work/report-build/<report-id>` 根目录；修改报表同样要求先选中目标，避免全新会话丢失报表身份。
- **产物门禁**：JobManager 新增阶段 prepare/complete hooks。Provider `completed` 后先运行本地 Skill CLI；失败时当前 AgentRun 标记失败、阶段保持不变并显示“产物需修复”，不会进入确认边界或自动启动脚本 Agent。查询阶段前由 Studio 执行模型批准，脚本阶段成功后才标记整个流程完成。
- **确定性装配**：报表 CLI 新增 `validate-stage/approve-staged-model/finalize-staged`。模型、语义/执行计划、逐查询 SQL/output contract 和 `report.ts` 使用固定目录；查询输出逐列校验名称、顺序和类型。`finalize-staged` 唯一负责构造 `configuration.script_report`、configure/approve/generate/validate，Agent 禁止手改最终 plan。
- **回归**：新增真实无数据库端到端 fixture，覆盖模型批准、错误列顺序阻断、SQL/脚本装配、v3 包生成及静态校验；新增 Studio CLI runner 与非法 reportId 路径测试、JobManager 门禁失败测试、前端完整 SSE 事件集合测试。
- **测试与分发**：报表 Skill 84/84、JobManager 14/14、Studio Web 91/91、Staged Workflow runner 2/2、Bundle Source 6 通过（5 个可选源跳过）、Workspace Bootstrapper 6/6；全仓 build/typecheck 与本次产品代码定向 lint 通过；0001–0005 migration 用 Node 内置 SQLite 验证幂等。Bundle 1.28.0 已同步到全新不可变缓存与 vendor（SHA-256 `f22396bd…`），vendor doctor 和三个新命令可发现性验证通过。
- **下一步**：使用真实“客户单量统计”表结构和数据验证多查询 SQL 结果、脚本合并、预览/Excel、预算与取消；现阶段静态生成链路已闭环，但真实业务口径和数据正确性仍需数据库验收。

### 分阶段报表建模、Provider 新会话与 Context Pack（bundle 1.27.0）（2026-07-22）

- **一个用户对话、多个底层运行**：报表任务新增 `DISCOVERY → AWAITING_DISCOVERY_CONFIRMATION → MODELING → AWAITING_MODEL_APPROVAL → QUERY_COMPILATION → SCRIPT_COMPILATION → COMPLETED` 阶段；前端仍保持一个抽屉、一个逻辑 Job 和一条持久化事件流。跨阶段统一调用 `AgentBridge.start` 创建全新 Provider 会话，普通阶段内追问才 resume，前端不感知 Provider task/session。
- **持久化与恢复**：新增 `agent_runs`，保存阶段、Provider task/session、fresh/resume、模型 revision/hash、检查点和终态；Job/Event 增加当前 run 与阶段关联。Studio 重启时已消失的活跃 run 标记失败，逻辑对话按既有策略可恢复；删除对话显式清理事件与运行记录。
- **用户确认门**：基础建模结束后前端显示“确认并确定建模”，确定模型结束后显示“批准并开始编译”；确认消息作为可见用户事件写入同一对话。查询编译完成后自动切到全新的脚本编译 Agent，阶段切换显示上下文已重置，但不暴露底层会话。
- **结构化模型与最小上下文**：报表 CLI 新增 `init-model/validate-model/approve-model/build-phase-context`。批准模型固定结果粒度、表/字段白名单、关系基数、指标去重键、时间/排除口径和逐查询契约，并以 hash 防止批准后漂移。查询 Context Pack 默认最多 3 表/40 字段；脚本 Context Pack 只带批准计划与实际 query-output contracts，明确排除物理知识库和探索历史。表或字段越界在批准/生成前失败。
- **定向修复**：`repair` Context Pack 根据 `MODEL_* / QUERY_* / SCRIPT_* / Runtime` 错误只返回对应阶段，不再携带整库知识与全部历史反复尝试。Skill 主提示词改为 discovery-only，创建和修改报表均禁止首轮直接写 SQL/脚本/报表包。
- **改动文件**：Contracts、SQLite migration/JobStore、JobManager、Studio Service 路由与阶段提示词、Agent Drawer/API/reducer；报表 Skill CLI/测试/编译制品/SKILL/提示词/使用说明/技术规范；Bundle 版本断言、总体架构、Innos 集成和本状态文档。
- **测试**：报表 Skill 83/83；JobManager 13/13；Studio Web 90/90；Bundle Source 6 通过（5 个可选源跳过）；Workspace Bootstrapper 6/6；全仓 `build`、`typecheck` 与本次产品代码定向 lint 通过；0001–0004 migration 另用 Node 内置 SQLite 验证两次执行幂等及 `agent_runs/current_run_id/event run+phase` 结构；Bundle 1.27.0 首次同步（SHA-256 `7c195ef5…`），vendor `doctor` 确认支持包格式 2/3。Studio Service Vitest 在当前 Windows 环境仍受既有 `better-sqlite3` 原生绑定缺失与部分测试旧绝对路径影响，新增路由/restart 断言未由该套件执行；全仓 lint 仍有既存规则问题。
- **已知边界与下一步**：当前模型批准 hash 可由 API 记录，但 UI 尚未展示结构化模型差异；查询→脚本为自动阶段切换，结构化 `failure.json` 的自动回退 UI 尚未接通。下一步用真实“客户单量统计”跑一次基础建模确认、订单/运单/派车单独立查询、脚本合并、预算与取消验收，再补模型差异视图和 failure 自动定向回退。

### 语义/执行计划、v3 隔离脚本与按需上下文（bundle 1.26.1）（2026-07-22）

- **先计划后代码**：`inspect/configure-plan` 生成 `semantic_plan` 与 `execution_plan`，`explain-plan` 输出确定性审阅文本，二者明确结果粒度、指标去重键、时间/排除口径以及逐步查询、合并和输出流程；未审批不得生成包。
- **v3 最小闭环**：新增格式 3 脚本包和 `queryStream/loadIndex/batchLookup/emit` 上下文；每条查询独立锁定知识来源、Profile、数据库和 SQL 方言，TypeScript 源自动生成 `.mjs`。父 Runtime 持有只读数据库连接，报表代码在 Node 权限隔离子进程执行，支持预览与 Excel。
- **资源与取消**：包级查询数、查询/索引/输出行、批次键、内存、超时和流批次预算受 Runtime 全局 ceiling 二次约束；预算越界明确失败。断连、`DELETE /api/v1/executions/{requestId}` 和 `DELETE /api/v1/tasks/{runtimeTaskId}` 会中断活动查询并终止脚本；同时修复任务数据库打开时误把全部 RUNNING 重置为 QUEUED 的问题。
- **上下文收敛**：新增 `build-context`，默认只选择计划来源、关系、索引、字段、系统条件与安全信息，缺表时显式 `--include`，不携带样本、扫描、连接配置、秘密或历史。主 `SKILL.md` 从 800 余行压缩为约 260 行核心工作流，策略细节按选中的 SQL/enrichment/group_queries/v3 路由到技术参考，避免“整库+整份规范”反复重试。
- **编辑与分发**：Studio 报表编辑器允许 `queries/*.sql` 和 `scripts/report.ts`，保存 TS 时同步生成 `.mjs`；Bundle 升级到 1.26.1、报表 Skill 2.23.0，并同步到全新不可变缓存和 vendor 快照。
- **改动文件**：报表 Skill 的生成器、隔离 runner/runtime、共享 Runtime、测试、编译制品、SKILL/提示词/规范/说明；Runtime 配置 Schema；workspace-sdk 报表编辑器；Bundle manifest/index 与版本测试；架构、接口、Innos、决策和本状态文档。
- **测试**：报表 Skill 82/82；workspace-sdk 报表状态 10/10；Bundle Source 6/6（另 5 项可选源跳过）；Workspace Bootstrapper 6/6；全仓 `build`、`typecheck` 均通过；同步后 vendor `doctor` 确认支持格式 2/3。未使用真实数据库执行 v3 客户单量报表，真实关系字段、业务排除状态和时间口径仍需业务方提供后联调。
- **下一步**：用实际客户单量数据跑“订单流 + 运单索引/批查 + 派车单 n:n 批查”的预览、同步 Excel、取消和预算越界验收；再根据真实基数调优包级预算。

### 复杂多实体/n:n 报表规划与执行加固（bundle 1.25.0）（2026-07-22）

- **规划门禁**：报表 Skill 不再用“表数量”机械决定方案，改为先确认结果粒度、实体去重键、时间归属、排除规则和 n:n 统计口径；明确 n:1 JOIN、单条 1:n enrichment、多指标实体/n:n `group_queries` 三种路径。自然语言业务指标产生的 `FIELD_NOT_FOUND` 现在带稳定 `field_id`，在 `configure-plan` 中被显式计算字段或分组查询字段实现后可解除；真实物理字段缺失仍保持阻塞。
- **生成与锁定**：`group_queries` 的每个指标查询可声明同 profile 的短 JOIN 链，逐跳校验表、字段、别名、连接方向和逻辑删除条件；列与时间字段可来自链上任意别名。每个查询单独写入 `knowledge.lock.json.group_query_sources`，校验器要求 SQL 只引用其独立锁定来源，并阻止“锁了表但没有 JOIN”的伪引用。扇出链路由配置显式选择 `COUNT(DISTINCT ...)` 等聚合口径。
- **运行时容量**：独立查询仍分别执行并按结果键合并；新增 `sync.max_merged_groups`（默认 100000），超过上限以 `GROUP_QUERY_LIMIT_EXCEEDED` 明确失败，避免复杂报表无界占用内存。
- **真实关系测试**：新增客户单量同构用例：派车单 → 派车单/运单桥表 → 运单 → 主运单 → 订单 → 客户，验证 n:n 链路 SQL、六张来源表独立锁定、`COUNT(DISTINCT 派车单ID)` 和业务指标阻塞解除；另增合并容量越界测试。
- **改动文件**：报表 Skill 的 `SKILL.md`、提示词、技术规范、使用说明、生成器、Runtime、Schema、测试与编译制品；Bundle manifest/index；Bundle Source/Workspace Bootstrapper 的版本断言和跨平台源目录测试；本架构与维护状态文档。
- **测试**：报表 Skill 77/77 通过；Bundle Source 6 通过（5 跳过可选源）、Workspace Bootstrapper 6/6 通过；全仓 `build`、`typecheck` 通过。全仓 `lint` 仍有既存 161 项规则问题；全仓测试仍受 Windows 基线问题影响（workspace-sdk 的 POSIX 路径断言、agent-bridge fake CLI `spawn EFTYPE`），与本增量无关。尚未使用真实数据库执行客户单量报表与 Excel 导出。
- **下一步**：用业务方确认的真实表名、主键/外键、作废状态与时间口径跑一次端到端导出；后续再评估 v3 跨 profile/脚本查询，本版本不允许跨 profile `group_queries`。

### 清理 0.1.x 报表包死代码兼容（bundle 1.24.0）（2026-07-20）

- 报表包/计划格式已强制 v2（`report_package_format_version`/`plan_format_version` 硬门禁，非 v2 直接报错拒绝加载/读取，无迁移分支）；`compileSql` 里唯一一段真·历史兼容——`兼容 0.1 版本错误生成的 "AND /* EASYBI_FILTERS */"` 正则改写——是够不到的死代码：v2 生成器（`buildSql`）始终把 `/* EASYBI_FILTERS */` 占位标记单独成行、从不带前导 `AND`，而 0.1.x 时代的坏包会先被 v2 格式门禁拦掉。删除该正则后，坏 `AND` 会被"占位标记只能有一个"检查正常拦下报错，而非被静默修好。
- **辨析**（避免误删）：`schema_version:"1"`（parameters/tests 子文件各自版本号）与 `/api/v1/*`（Runtime HTTP API 稳定版本）**都不是**报表包 v1，保留不动。
- **改动文件**：`runtime-core.ts`（删兼容正则）、`runtime-core.test.ts`（对应用例模板改为 v2 真实形态——标记单独成行）。行为对所有 v2 报表包零变化。
- **测试**：报表 skill **70 全绿**；studio 版本断言 11 全绿。
- **版本与分发**：报表 skill 2.20.0→**2.21.0**、bundle 1.23.0→**1.24.0**；sync（sha `3e20be50…`）；重装 transport-test（备份、保留 runtime.json、重生成 lock revision `585bd916…`、保留 report-2 包、node_modules 从 canonical 恢复）；Runtime serve 冒烟通过。

### 布尔标记字段：数值/状态列折叠为是/否（`source.kind=boolean_flag`）（bundle 1.23.0）（2026-07-20）

- **动机**：如「签单是否上传」——业务是是/否，底层是回单数量 `receipt_count`（>0 即已上传）。原来暴露成 number-range 数字筛选，语义错位。
- **新字段种类 `boolean_flag`**：`configure-plan` 字段 override 声明 `source={kind:"boolean_flag", operator∈{gt,gte,lt,lte,eq,ne}, threshold, labels?}`。生成 SELECT `CASE WHEN col op n THEN 1 ELSE 0 END`；1/0 经自动注入的 `{1:"是",0:"否"}` 枚举映射渲染（预览+Excel）。
- **筛选（防注入 + 跨方言）**：`value_type=boolean`、`component=switch`；测试页显示 不筛选／是／否。Runtime **结构化**构建谓词——是 → `(col op n)`，否 → `NOT (col op n)`——**不绑值**、无自由比较串（比较符取自固定集合、阈值经 `Number()`），下推 SQL WHERE（对全表正确）。
- **安全护栏**：`sql-guard.ts` 新增共享 `FLAG_OPERATOR_SYMBOLS` + `isBareQuotedColumnRef`（比较符禁止出现在自由表达式里，故只能走结构化路径）。CLI + Runtime 双侧校验：列存在且 JOIN、`output_type=boolean`、比较符合法、阈值有限。
- **改动文件**：`sql-guard.ts`（共享原语）、`runtime-core.ts`（`coerceFlagValue`/`buildFlagPredicate` + compileSql boolean 分支）、`report-package-cli.ts`（buildSql CASE、configurePlan 转换、buildBindings 透传、validatePlanV2/validatePackage/lockedSources 分支、generate 注入是否枚举）、`TestPanel.tsx`（不筛选/是/否 下拉）、SKILL.md + 技术规范 §9.3、测试各文件。
- **测试**：报表 skill 63→**70**（+7：coerceFlagValue、buildFlagPredicate 正/反例、compileSql 布尔是/否/空、非 where 拒绝、CLI 转换端到端 + 坏比较符拒绝）；studio 版本断言 11 全绿。
- **报表升级**：「回单信息汇总表」report-2 的 `receipt_count` 转 boolean_flag(gt,0)，新包版本 `0.2.0-draft`，`validate` valid:true，生成 SQL 确认 `CASE WHEN t0.\`receipt_count\` > 0 …`、enums `{1:是,0:否}`、binding `flag_operator=gt/flag_threshold=0`。
- **版本与分发**：报表 skill 2.19.0→**2.20.0**、bundle 1.22.0→**1.23.0**；sync（sha `35ce3613…`）；重装 transport-test（备份、保留 runtime.json、重生成 lock revision `b1f76d2d…`、保留 report-2 包、node_modules 从 canonical 恢复）；Runtime serve 冒烟通过。

### Enrichment：批量二次查询 + 内存合并（替代撑行的一对多 JOIN）（bundle 1.21.0）（2026-07-21）

- **背景**：多表报表里，一张一对多表（如一单多货品）会逼出 `GROUP_CONCAT + GROUP BY + MAX()`，把整条查询拖进聚合——性能刺是它，不是 JOIN 数量。设计评审见 `docs/design/enrichment-batch-lookup.md`（v2）。
- **定位（混合模型）**：n:1 维度表继续 JOIN（不撑行、走索引）；只把撑行的一对多表改为 enrichment——Runtime 流式读主查询、按批收键、对 lookup 表发一次 `WHERE key IN(…)`、内存按键合并。
- **契约**：plan/manifest/bindings 新增 `enrichments[]`；新 field kind `enrichment`（不进 SQL SELECT）。`cardinality=one`（多对一取标量，多命中取第一条+warning）/ `many`（一对多按 `aggregate` 折叠：group_concat/count/sum/max/min/first，**group_concat 内存拼接不受 group_concat_max_len 截断**）。支持**链式**（键取自上游 enrichment，Runtime 拓扑排序）。
- **筛选**：enrichment 字段禁止内存筛（会漏行）；带 filter 角色时 `configure-plan` 下推为对 lookup 表的相关 **EXISTS** 半连接（复用 GROUP_CONCAT 筛选机制）；键无法关联回主查询时配置期拒绝。
- **runtime**（runtime-core.ts）：新增纯函数 `topoSortEnrichments/aggregateMany/buildEnrichmentValueMap/applyEnrichmentToBatch/collectBatchKeys` + `enrichBatched` 分批合并生成器 + `QueryAdapter.queryAll`；`prepareSyncQuery` 载入并拓扑排序 enrichments，group 报表 + enrichment 报 `ENRICHMENT_UNSUPPORTED`；querySync/exportSync 在 collector 前插入分批阶段（同一只读事务），warning 透出。
- **生成期**（report-package-cli.ts）：`configurePlan` 接受 `configuration.enrichments[]`（从知识库解析 lookup 表、校验同 profile/列存在/cardinality/链式、追加 enrichment 字段）；`buildEnrichmentBindings`+`buildEnrichmentTemplate`（`/* KEYS */` 标记 + 安全护栏）；`lockedSources` 并入 lookup 表标 `kind:"enrichment"`；manifest 带 enrichments。
- **校验**：validatePlanV2（同 profile、键在主查询输出、cardinality/aggregate、链式不成环、group+enrichment 硬错、enrichment 字段绑定合法）+ validatePackage（lock 免 enrichment 表的 JOIN 检查、sql_template 单 `/* KEYS */` 标记 + 无注入）。
- **不支持（校验期报错）**：分组(group)报表、跨 profile、依赖成环。全为可选扩展块，老包缺省走原路径（report-1 在新代码下 validate 仍 valid:true，零回归）。
- **enrichment 字段筛选下推（补齐设计承诺）**：`buildEnrichmentExistsSkeleton` + `applyEnrichments` 里对带 `filter` 角色的 enrichment 字段合成相关 **EXISTS** 参数（关联回主查询键列），输出走内存合并、筛选走 SQL；键无法关联回主查询（链式/非普通列）时**拒绝**该筛选。新增测试断言。
- **实战升级「回单信息汇总表」(report-2)**：原 4 表 JOIN + `GROUP BY t0.id` + 17× `MAX()` + `GROUP_CONCAT(sku_name)`。升级后 t1/t2/t3（n:1）保留 JOIN，只把一对多的 `oms_waybill_sku` 摘成 `many/group_concat` enrichment。生成的 main.sql **无 GROUP BY、无 MAX()、无 GROUP_CONCAT**（3 join 平查 + 可 LIMIT）；`sku_name` 由批量 `WHERE waybill_code IN(…)` + 内存拼接得到；品名筛选走 EXISTS 半连接。validate valid、Runtime 加载 23 参数含 sku_name 筛选。旧包已备份至 /tmp 后替换。
- **文档**：报表 SKILL.md 新增 enrichment 节；技术规范新增 §8.1（契约 + 分批流程 + 拓扑 + 筛选下推 + 安全边界）+ §7 binding 说明。
- **版本与分发**：报表 skill 2.17.0→**2.18.0**、bundle 1.20.0→**1.21.0**；sync（sha `bb064d94…`）；重装 transport-test（**按记忆清单**：备份、保留 config/knowledge/reports、恢复 `toolkit/config/runtime.json`、用 `buildBundleLock` 重生成 `bundle.lock.json`、node_modules 从 canonical 恢复；report-1 整数累加保留 count 10）；版本断言 1.20.0→1.21.0。
- **测试**：报表 skill 62 全绿（新增 enrichment 纯函数 + `enrichBatched` 伪 adapter 分批/IN/合并/多命中 warning + 生成期 one/many/链式/跨profile/group/坏aggregate 断言）；studio 版本断言 17 全绿；Runtime 启动正常；report-1 validate 仍 valid:true。

### Skill 冗余清洗 + 预览性能/文档优化（bundle 1.20.0）（2026-07-21）

- **背景**：两个 skill 各跑一次独立冗余审计，交叉核对后统一清理死代码/重复逻辑，并落地基于网页实操体验的优化。
- **报表包死代码清理**：删 `AGGREGATE_FN`+`isAggregatedField`（从未被调用）、未用的 `basename` import；`inspectReport` 内联表键改用 `tableKey()`。
- **报表包抽公共 helper**：新增 `scripts/sql-guard.ts`，把 EXISTS 骨架校验（原三处重复）与 SQL 安全护栏正则（cli `assertSafeSqlExpression` 与 runtime `safeExpression` 逐字节相同）抽为共享纯谓词；两处 caller 各保留自己的错误类型与额外检查（runtime 仍多一层 UNION/二次 SELECT 禁令、cli 仍做已知列解析）。列引用正则提为 `COLUMN_REF_RE` 常量，`lockedSources` 三处复用。
- **知识库语义审阅残留清理**：删 `promoteTable` 里对 `semantic-review.json` 的 status 重算（无人读）、`build` 命令输出里的 `semantic_review` echo、`DEFAULT_SEMANTIC_DEFAULTS.review` 死配置块、未用的 `MysqlConnection` 别名。审阅门早已移除，本次清尸体。
- **知识库枚举去重**：`exportEnums` 改调已有的 `proposeEnumBindings`，去掉内联重抄的分组/命名算法，保证 enums-export 与 enums-init 一致。
- **优化②预览性能**：`querySync` 预览路径对**非 group 且无 post_transform 筛选**的报表下推 `LIMIT maxRows+1`（原来只在客户端截断，DB 仍全表排序+全量流式传输，大表预览必然慢）；group 报表与 post_transform 生效时不下推以保正确性；`truncated` 标志仍准确。
- **优化③CLI 引导**：`generate`/`reseal` 成功输出加 `next_hint`，提示"可直接测试页预览、Runtime 无需重启"。
- **优化①文档纠正**：报表 SKILL.md §8 明确"改报表包无需重启 Runtime（每请求重读磁盘+cache-bust transform），仅改 skill 自身 dist 才需重启"——这是本轮多次"改了没生效"卡顿的根因。
- **文档漂移**：知识库规范删 manifest "语义审核状态"字段（代码 manifest 无此字段）；报表规范 §13 端点表补 `POST /api/v1/queries`。
- **版本与分发**：报表 skill 2.16.0→**2.17.0**、知识库 skill 0.15.0→**0.16.0**、bundle 1.19.0→**1.20.0**；sync（sha `4b2e89f0…`，全新不可变缓存）；重装 transport-test（备份、保留 config/knowledge/reports——report-1 整数累加保留 count 10、node_modules 从 canonical 恢复、sql-guard.js 已进工作区）；版本断言 1.19.0→1.20.0。
- **测试**：报表 skill 49 全绿、知识库 skill 26 全绿、studio 版本断言 17 全绿；两 skill build 通过；report-1 包在新代码下 `validate` 仍 `valid:true`（证明重构行为等价）。

### 修复小数聚合浮点误差 + 立整数累加规则（bundle 1.19.0）（2026-07-21）

- **现象**：report-1 的重量总和/体积总和出现 `50.615500000000004` 这类浮点长尾巴。诊断：源列 `total_weight/volume/quantity` 均为 `decimal(16,4)`（库里最多 4 位），长尾是 transform 里 `sum += Number(decimalStr)` 的 JS 浮点累加漂移（经典 `0.1+0.2`）。数值本身对，只是精度表示脏。
- **关键约束澄清**：group 聚合表达式是 **AI 写进 plan 的自由 TS**，skill 只原样拼进 transform，无法"强制整数累加"。故治本靠①改数据②立文档规则，而非改 skill 代码。
- **① 修当前报表**：把 report-1 plan 里 10 个 computed 表达式的小数累加改为**万分位整数累加**（`Math.round(Number(v)*10000)` 累加，末尾 `/10000`；差值型对最终相减结果除；计数 cnt 不缩放）。真实执行验证：重量 50.6155、体积 26.1615、环比 40.6155 均干净。approve→删旧包→generate→validate 通过，整数累加已进 index.ts/mjs。
- **② 立规则防复发**：SKILL.md 新增"Decimal sums in a transform MUST use integer accumulation"小节 + 规范 §9.1 追加中文规则（按 DECIMAL(p,s) 取 SCALE、整数桶累加、末尾一次除回、计数不缩放），让 AI 今后生成同类聚合自带整数累加。
- **版本与分发**：报表 skill 2.15.0→2.16.0，bundle 1.18.0→**1.19.0**（文档契约变更）；sync（sha `f030b670…`）；重装 transport-test（备份、保留 config/knowledge/reports——report-1 整数累加修复保留、node_modules 从 canonical 恢复）；清理残留 runtime 进程；版本断言 1.18.0→1.19.0。
- **测试**：报表 skill 49 全绿；studio 版本断言 17 全绿；build 通过。

### 数值计算字段支持 post_transform 范围筛选（bundle 1.18.0）（2026-07-21）

- **背景**：用户给"件数总和"等字段标了 filter 角色，但这些最终是 group transform 产出的 computed 聚合值，旧逻辑一律删除其筛选参数（`FILTER_DROPPED_COMPUTED`），导致件数无法范围筛选。物理数值列本就有 `number_range`（知识库默认），缺的是 transform 聚合值的筛选。
- **改动（canonical 报表 skill）**：
  - `configure-plan`：computed 字段不再一律删筛选。`output_type=number` 且带 `filter` 角色的 computed 字段 → 合成 `clause=post_transform` 参数（`value_type=number_range`、`component=number-range`、`operators=[between,gte,lte]`）。非数值 computed 仍删除+警告（文案改为"且非数值"）。
  - 校验（`validatePlanV2`、`validatePackage`）：接受 `post_transform` clause；computed 字段挂 clause≠post_transform 的参数才报错；post_transform 必须 number_range。
  - `runtime-core`：`compileSql` 跳过 post_transform（不进 SQL）；新增 `buildPostTransformFilter`（内存数值范围谓词，支持 between/gte/lte、必填、空值语义、非数值/空值判否）；`collectRows`/`writeWorkbookRows` 新增 `postFilter` 参数，在 transform 产出行后、写出前过滤；`prepareSyncQuery` 用（widened）过滤值构建后置谓词，querySync/exportSync 共用。测试页 number_range 组件已支持（`isRangeParam`）。
- **测试**：报表 skill 49 全绿（+3：post_transform 数值范围谓词 between/gte/空值、必填抛错、collectRows 后置过滤；+1 configure-plan 生成 post_transform 参数；改 1 处旧错误文案断言）。
- **版本与分发**：报表 skill 2.14.0→2.15.0，bundle 1.17.0→**1.18.0**；sync 到不可变缓存+vendor（sha `bbed2373…`）；重装 transport-test（/tmp 备份，保留 config/knowledge/reports，node_modules 从 canonical 恢复）；版本断言测试 1.17.0→1.18.0。
- **注意**：已存在的 report-1 包（生成于本次之前）其 computed 字段 roles 只有 output（AI 当时丢了 filter 角色），需**重新生成/配置**该报表让数值计算字段带上 filter 角色，才会产出 post_transform 筛选。本次改的是生成契约，对新包/重生成包生效。

### 报表配置页改为主从视图（列表→点进编辑）（2026-07-21）

- **背景**：ReportsEditor 原来把所有报表需求平铺成卡片、每张卡片展开全部字段，报表多时页面很长、不便浏览。
- **改动（纯 studio-web）**：`ReportsEditor.tsx` 改为 master/detail——初始只显示报表名列表（表格：报表名 / ID / 字段数 / 编辑·删除），点行或铅笔进入单个报表的详情编辑（ID/名称/业务说明/字段与角色/绑定/描述，与原逻辑一致）；详情页顶部有「返回列表」。新增报表直接进入详情；报表场景（scenarios）仅在列表视图显示；重新加载/切换报表回到列表。工具栏（保存/导入/导出）保持常驻。
- **测试**：studio-web 89 全绿；web tsc exit 0。reports-config 纯函数未改，43 用例照常通过。

### 移除知识库发布的语义审阅门槛（bundle 1.17.0）（2026-07-21）

- **背景**：用户反馈"AI 生成 + 人工检查 + 点发布"本身已完成审查，独立的语义审阅批准环节冗余；且旧的预置提示词已精简为 2 套（初始化知识库 / 构建报表），不再有独立「审阅」按钮，文案却仍指向它。
- **改动（canonical skill）**：`initialize-report-knowledge` 的 `catalog-cli.ts` `validateCatalog(publishReady)` 删除两项门禁——`Semantic review is not approved` 与 `N unresolved table questions`。**保留**热表数据质量（业务名/状态、安全范围、报表暴露字段）与结构完整性（表 ID 唯一、tier 计数、冷表无字段明细、无密钥、`catalog_status` ready/published）。语义审阅摘要仍生成，仅供人工参考，不再阻断。
- **文档**：SKILL.md §10「批量语义审阅」改为可选/信息性、§11 明列发布就绪只校验数据质量+结构；references/知识库技术规范.md §13「发布前」条件同步更新。
- **测试**：CLI 回归用例 `classification…and publish` 改为**故意不批准**语义审阅（status=blocked、32→保留 unresolved）仍能成功发布，直接证明门槛已移除；node --test 26 全绿。在真实 transport-test 草稿（review=blocked、32 未解决）上验证 `validateCatalog(publishReady)` → ok:true。
- **版本与分发**：skill 0.14.0→0.15.0，bundle 1.16.0→**1.17.0**；`sync-easybi-bundle.mjs` 同步到不可变缓存 + vendor；手动重装 transport-test（/tmp 备份 132M，`rm skills/ toolkit/` 后重跑 create-test-workspace，保留 config/knowledge/reports/workspace.json；node_modules 从 canonical 恢复，shrinkwrap 一致）。
- **前端**：`KnowledgePanel.explainPublishError` 的审阅分支保留（向后兼容旧包），②③ 错误仍有友好解释与「去 AI 助手处理」入口。

### 发布参数修复 + 页面操作流优化（第一、二批）（2026-07-21）

- **发布空参数修复**：知识库发布报 `Unexpected argument: `（空）——studio-service `knowledge/routes.ts` 的 publish 无条件传 `--decision ""`，CLI 把 `--decision` 当布尔 flag、空串成为游离 token 被拒。改为 decision 非空才传（`--decision` 在 CLI 本就是可选）。加回归测试 `publish omits --decision when not provided`。
- **流程串联（第一批）**：
  - **AI 完成/artifact 变更 → 面板自动刷新**：`AgentDrawer` 新增 `refreshNonce`，收到 `artifact_changed`/`checkpoint_created`/`job_completed` SSE 事件时自增；新增 `useAgentRefresh()`，Overview/Knowledge/Enums/Reports/Test 面板将其加入加载 effect 依赖，AI 写盘后自动重载，不再手动挨个刷新。
  - **Overview 可导航**：新增 `nav.ts`（`NavContext`/`useNavigate`/`Tab`，App 提供 `setTab`）。Overview 阶段清单每行可点跳到对应 tab，`nextAction` 变主色按钮（`STAGE_TAB` 映射）。
  - **编辑→测试跳转**：`PackageEditor` 封包成功后出现「去测试」（关闭编辑器并跳测试页），封包成功文案提示需重启 Runtime 才加载改动。
- **降低上手门槛（第二批）**：
  - **空态放真实入口**：Knowledge/Enums 空态从灰字改为「用 AI 初始化知识库」按钮（`startAction('initialize-knowledge')`）。
  - **ConfigPanel**：默认落在「连接」友好编辑器（原为裸 JSON `build`）；构建/Runtime 配置归入「高级 · 原始 JSON」分隔区；裸 JSON 页的「…是什么？」帮助默认展开。
  - **ConnectionsEditor**：明文密钥警告移到顶部醒目卡片；保存后 `load({keepTests:true})` 保留「可连接」测试结果不再清空。
  - **TestPanel**：新增「Runtime 未启动」「已启动但无报表包（去报表页）」两个空态，消除白屏。
- **范围**：纯 Studio 侧前端 + 一处 studio-service 路由修复。**未改报表/知识库 Skill 或 Bundle**，无需 re-sync 或重装工作区。
- **测试**：studio-web 89 全绿；studio-service `knowledge/routes` 10 全绿（+1 发布空参数用例）；web/service tsc 均 exit 0。

### 报表包编辑器优化：文件按用途分组+说明、脚本 .ts 存即自动生成 .mjs、保存/封包流程更清晰（2026-07-21）

- **背景**：复杂报表 AI 难一次成型，常需人工改脚本；旧编辑器交互弱、提示少，不知每个文件干嘛，且 `transforms/index.ts`/`index.mjs` 双文件要手动同步（改了 .ts 忘改 .mjs → 运行时跑旧逻辑，静默出错）。
- **脚本 .ts → 自动生成 .mjs（核心）**：`writeReportPackageFile` 在保存 `transforms/index.ts` 时用 Node 24 内置 `stripTypeScriptTypes` 去类型生成 `transforms/index.mjs`，返回 `generated` 列表。`index.mjs` 在编辑器里标为"自动生成·只读"（有 .ts 时禁止直接改，仅 .mjs 的老包仍可直接编辑）。.ts 语法错误时报错阻止保存，不留下过期 .mjs。
- **每个文件"这是什么"**：编辑器内置 `FILE_GUIDE`（路径→用途/改法/只读原因），文件树按用途分组（查询/字段与表头/筛选参数/计算脚本/测试/元数据），选中文件顶部显示说明条；计算脚本页附"可用依赖列(raw_*)与函数签名"速查（从 fields.json 的 dependencies 读出）。
- **保存/封包更清晰**：底部相位标识（未保存/已保存待封包/已封包·校验通过）；新增「保存并封包」一键流程；封包失败错误按行结构化展示；默认优先打开 `transforms/index.ts`；Tab 键插入两空格。
- **范围**：纯 Studio 侧（studio-web `PackageEditor.tsx`+styles、studio-service 透传不变、workspace-sdk `report-state.ts` 加 `transpileTransformSource`+自动生成+只读标记）。**未改报表 Skill / Bundle**，无需 re-sync 或重装工作区。
- **测试**：workspace-sdk `knowledge-report-state` 10（+4：保存 .ts 重新生成去类型 .mjs / 拒绝直接改 .mjs / .ts 语法错误报错 / detail 里 .mjs 标只读+generated）；SDK+workspace 路由合计 59 全绿；studio-web/service/sdk 均过 tsc。

### 环比/同比：自动默认按月创建时间筛选 + configure-plan 可新增派生列（修两处构建失败）（2026-07-20）

- **背景**：构建同比环比报表包反复失败/被阻断。定位到两个根因并修复。
- **根因一（阻断点）**：`validate` 要求 `comparison.period_param` 指向一个已存在的**必填**月区间筛选，但 `inspect` 只从 `required_fields` 建筛选、默认创建时间仅用于**排序**不建筛选。于是创建时间不在 `required_fields` 时无筛选可指，AI 被迫弹窗让用户新增。**修复**：`inspect` 记录主表创建时间候选列（`default_period_candidates`）；`configure-plan` 在启用 comparison 且 `period_param` 缺失/未匹配时，**自动在创建时间列上合成一个必填按月区间筛选**并指向它（产出 `PERIOD_FILTER_ADDED` 警告转告用户）——即"默认创建时间筛选，遇同比环比按月查"。恰好一个候选静默采用；零个/多个才报错让 AI 询问用户用哪列。
- **根因二（回复后仍失败）**：`configure-plan` 的字段覆盖循环只按 id 改**已存在**字段，AI 声明的新派生列（如 `qty_mom` 等新 id）被静默丢弃 → 无 computed 字段 → `custom_logic.mode` 停在 identity → 与 comparison 要求的 group 冲突 → validate 失败。**修复**：覆盖后**追加**配置里 id 为新的 `computed`/`sql_expression` 字段（全新 `column` 字段拒绝，必须走 `required_fields` 锁血缘）。
- **配套**：`normalizeComparison` 允许配置期省略 `period_param`（由自动默认补齐）；generate 校验豁免 comparison `period_param` 的"每个筛选须对应输出列"规则（它是分组内按月分桶用，不作输出列）；创建时间筛选若被 inspect 设为可选，comparison 下强制必填。
- **测试**：报表 skill 26（+2：无 create_time required_field 时自动加必填月筛选并追加新 computed 字段→generate+validate 通过 / 拒绝新增 column 字段）；合计 45 全绿；版本断言 11 全绿。SKILL.md §3 与技术规范 §9.2 更新（明确"不要让用户加创建时间筛选"）。
- **版本**：报表 Skill 2.13.0→**2.14.0**、Bundle 1.15.0→**1.16.0**；已 sync（sha `6c555ab8…`），**transport-test 已重装到 1.16.0**（config/knowledge/reports 保留，备份 `/tmp/tt-preupgrade-116`）。

### 同步 JSON 查询接口 + 测试页数据预览（中文表头 + 数据，滚动查看）（2026-07-20）

- **动机**：此前 Runtime 只能同步导出 Excel。为在测试页快速核对数据，新增同步 JSON 查询：返回①中文表头、②数据行，前端据表头生成表格、下方填数据，滚动查看（暂不分页）。
- **Skill Runtime**：抽出 `prepareSyncQuery` 共享预处理（加载包/校验策略与列上限/comparison 窗口加宽/解析连接与方言/编译 SQL/解析 Transform），`exportSync` 与新 `querySync` 复用同一执行核心。`querySync` 把结果收进内存而非写 xlsx：`collectRows` 施加与导出**完全一致**的 identity/row/group Transform 与枚举 code→中文映射，按 `limit`（受 `preview_max_rows` 默认 1000 约束）截断并置 `truncated`；`outputColumns` 产出 `{id,label,description?}` 中文表头。新 HTTP 路由 `POST /api/v1/queries`（始终同步，无异步分支，不生成文件、不计入 REAL_SYNC_EXPORT）。
- **studio-service**：`/runtime/api/v1/queries` 透明代理到 Runtime（与 `/exports` 同构）。
- **studio-web**：`runtimeApi.query` + `QueryResult` 类型；测试页 `TestPanel` 新增「预览数据」按钮（与导出共用 `buildFilters` 组装筛选、必填拦截），下方渲染可滚动结果表（`maxHeight:460 + overflow:auto`），表头用中文 `label`（`title` 提示字段描述），空列/空数据分别给出提示；切换报表时清空预览。
- **测试**：runtime-core 19（+3：`outputColumns` 表头+描述 / `collectRows` 枚举翻译+行上限截断 / `collectRows` group 计算；HTTP 用例加 `/api/v1/queries` 缺 reportId → `REPORT_ID_REQUIRED`）；报表 skill 合计 43 全绿；前端 reports-config 43、版本断言 11 全绿；studio-web/studio-service 均通过 tsc。
- **版本**：报表 Skill 2.12.0→**2.13.0**、Bundle 1.14.0→**1.15.0**（知识库 Skill 不变）；已 sync（sha `acce59df…`），**transport-test 已重装到 1.15.0**（config/knowledge/reports 保留，备份 `/tmp/tt-preupgrade-115`）。

### 报表字段可加"字段描述"（业务口径），帮助 AI 理解字段（2026-07-20）

- **动机**：纯写表名+字段时，AI 有时难判断某字段到底指什么（如"订单数总和"）。为字段增可选描述后，AI 生成报表包时能读到口径。
- **数据结构**：`required_fields` 对象形式新增可选 `description`（如 `{ field, label: "订单数总和", description: "订单数量的总和" }`）。纯字符串字段无描述；仅在有内容时序列化，空则不写，保持配置/报表包字节一致（向后兼容）。
- **Skill**：`inspect` 把描述原样带到 `plan.fields[].description`，并写入 `fields.json` 字段项（空时省略）。仅文档用途，**不参与 SQL**。SKILL.md §2、`references/…技术规范.md` §4.1 记录契约。
- **Studio 页面**：报表编辑器（全量 `ReportsEditor` 与单张 `RequirementEditor`）每个字段行新增描述输入框；导入 JSON 支持字段写成对象带 `description`；导入提示更新。共享层 `reports-config.ts` 的 draft/序列化/导入全部透传描述。
- **测试**：前端 `reports-config.test.ts` 43（+2：读取&持久化描述 / 仅描述时升级为对象）；报表 skill 40（扩展"roles+description 流入 plan"用例断言 `plan.fields[].description`）全绿；版本断言（skill-bundle-source/workspace-bootstrapper）11 全绿。
- **版本**：报表 Skill 2.11.0→**2.12.0**、Bundle 1.13.0→**1.14.0**（知识库 Skill 不变）；已 sync 刷新缓存/vendor（sha `77b8e722…`），**transport-test 已重装到 1.14.0**（config/knowledge/reports 保留，备份 `/tmp/tt-preupgrade-114`）。

### 计算字段支持：无法筛选字段自动取消筛选 + 环比/同比（回看窗口）（2026-07-20）

让 skill 真正处理"需要计算才能得到的字段"，并对无法筛选的字段主动取消筛选：

- **无法筛选字段自动取消筛选**：`configure-plan` 中字段被改成 `computed` 时，自动删除 `inspect` 派生的该字段筛选参数，并产出 `FILTER_DROPPED_COMPUTED` 警告（列出字段）；SKILL.md 指示 AI 必须把该警告呈现给用户确认后再继续。`validate` 兜底：`computed` 字段仍挂同 id 参数 → 硬报错。
- **环比/同比（comparison）**：plan/manifest 增可选 `comparison` 块（`enabled`/`period_param`/`modes: chain\|yoy`/`lookback_months`）。环比=上月、同比=去年同月，计算写在 group transform 里（按月分桶）。运行时 `widenComparisonFilters` 在导出前**自动把 `period_param` 月区间的下界向前扩**（chain 扩 lookback、yoy 扩 12 月，取最早），上界不变——用户只选报告区间，边界月也能拿到回看数据，一次查询覆盖本期+对比期。`validate` 校验 `period_param` 必须是必填的 date/datetime range 且 `custom_logic.mode=group`。
- **契约文档**：SKILL.md 增"计算字段不可筛选""环比/同比"两节；`references/报表与Runtime技术规范.md` 增 §9.1/§9.2（窗口加宽规则、按月分桶、边界月保证）。定位：环比/同比是**同表额外输出列**，独立对比 sheet 属决策 0002 阶段 C。
- **测试**：report skill 24（+4：取消筛选/validate 兜底/comparison 端到端 generate+validate+transform 算出环比/period_param 校验）、runtime-core 16（+4：窗口加宽 chain+yoy/仅 chain/包装形状/no-op）全绿。
- **版本**：报表 Skill 2.10.0→**2.11.0**、Bundle 1.12.0→**1.13.0**（知识库 Skill 不变）；已 sync 刷新缓存/vendor，**transport-test 已重装到 1.13.0**（config/knowledge/reports 保留，备份 `/tmp/tt-preupgrade-113`）。

### 报表 tab 就地编辑单张报表 + 选中后才能 AI 构建（只构建选中的那张）（2026-07-20）

纯前端调整（不动 skill，无需 bump/sync）：

- **就地编辑**：报表 tab 的「报表需求」表每行加铅笔按钮，打开 `RequirementEditor` 弹窗，只编辑这一张（名称/业务说明/字段/角色/绑定），保存经 `upsertRequirementIntoConfig` **就地更新该条**（同 id 覆盖、按 `originalId` 匹配以支持改 id、其它需求与其它 config 分支原样保留），乐观 revision 写回 `config/easy-bi.json`。
- **选中门控 AI 构建**：表行可单选（radio + 整行点选高亮，再点取消）。`AgentQuickStart` 新增 `selectedReport`/`gateActions` 可选 props——`create-report` 预置在未选中报表时禁用+灰显+提示；选中后经 `buildScopedReportPrompt` 把"仅为报表 `<id>（<name>）` 生成、一次只生成这一个"追加进 prompt，AI 只构建选中的那张。「AI 助手」自由对话与知识库页用法不受影响（不传新 props 即旧行为）。
- **新增/改动**：`reports-config.ts`（`upsertRequirementIntoConfig`/`validateRequirement`/`buildScopedReportPrompt` + 提取 `requirementToConfig`）、新建 `RequirementEditor.tsx`、`AgentQuickStart.tsx`、`ReportsPanel.tsx`、`styles.css`（quick-item disabled 态）。
- **测试**：reports-config 41（+8，覆盖 upsert 同 id/新 id/改 id/保留其它分支、单条校验、scoped prompt）、web 87、typecheck/lint 全绿。

### 导入简化为「报表名+字段」+ 修复弹窗透明看不清（2026-07-20）

纯前端调整（不动 skill，无需 bump/sync）：

- **导入简化**：`parseImportedReports` 最简格式改为只写报表名和字段 `[{ "name": "报表名", "fields": ["字段一","字段二"] }]`。ID 缺省时按名称自动派生（ASCII 名 slug 化，中文名回退 `report-N`，可后续改）；每个字段默认同时具备 `output`+`filter` 角色、**不默认分组**（需分组导入后在编辑器点开）。仍向后兼容 `required_fields`/含 `report_requirements` 的对象/完整 config，显式 `roles` 会被尊重。导入对话框提示与占位示例同步简化。
- **弹窗透明修复**：`.ide-modal` 与 `.pkg-editor` 之前 `background: var(--ide-bg)`——该变量不存在（实为 `--ide-bg-app/panel/elevated`），解析为透明导致看不清内容。改为 `--ide-bg-panel`（不透明）。
- **测试**：reports-config 33（+2）、web 79、typecheck/lint 全绿。

### 创建时间默认排序（不依赖输出字段）+ 报表配置 JSON 导入/导出（2026-07-20）

两点优化：

- **创建时间默认排序**：只要主表存在创建时间列（即使它不是报表输出字段），查询默认按其倒序排序（其次按主键倒序）。`report-package-cli.ts` 新增 `findCreateTimeColumn`（按物理名 `create_time`/`created_at`/`gmt_create`… 或语义标签/注释 `创建时间…` 匹配，比旧的 4 个硬编码名更全），替换 inspect 期的排序构造。**分组安全护栏**：当查询带 `GROUP BY` 且创建时间/主键不是分组键时，会自动丢弃这些默认排序表达式，避免生成非法 SQL。新增 2 个用例（分组时丢弃默认排序、`gmt_create` 也能被识别）。
- **报表配置导入/导出**：配置页「报表」页签加「导入」「导出」。导入支持粘贴或上传 `.json`，兼容三种结构（需求数组 / 含 `report_requirements` 的对象 / 完整 config 的 `knowledge.report_requirements`），字段可为字符串或 `{field,label,roles}`；支持"合并（同 ID 覆盖，新 ID 追加，场景并集）"与"替换"两种模式；导入到编辑器后仍需手动「保存」才写盘。导出复制当前报表分支为格式化 JSON（剪贴板不可用时降级为填入导入框）。纯函数 `parseImportedReports`/`applyImport`/`exportReportsJson` + 12 个用例。
- **测试**：report skill 20（+2）、reports-config 31（+12）、web 77、typecheck/lint/版本断言全绿。
- **版本**：报表 Skill 2.9.0→**2.10.0**、Bundle 1.11.0→**1.12.0**（知识库 Skill 不变 0.14.0）；已 sync 刷新缓存/vendor，**transport-test 已重装到 1.12.0**（config/knowledge/reports 保留，备份 `/tmp/tt-preupgrade-112`）。

### 报表需求结构化配置：字段角色（输出/筛选/分组）+ 业务说明（2026-07-20）

为配置"真实报表"，把报表需求从"仅字段名+可选绑定"升级为结构化：

- **字段角色**：每个字段可标记 `output`/`filter`/`group`（可多选，缺省=输出）。`filter` 的操作符/控件仍由知识库语义自动推断（时间列自动范围+必填、枚举自动带选项）。
- **业务说明**：每张报表可写自然语言口径（如"仅统计签收复核后""毛利=应收-各方应付-内部成本"）。
- **前端**（`reports-config.ts` + `ReportsEditor.tsx` + `styles.css`）：`ReportFieldDraft` 增 `roles`、`ReportRequirementDraft` 增 `description`；`toggleRole`/`hasRole`/`normalizeRoles` 纯函数；编辑器字段行加"输出/筛选/分组"角色 chip、报表卡加说明 textarea。序列化时 output-only 字段仍存为纯字符串（配置整洁），带角色/绑定的存为对象，**向后兼容**旧配置。
- **skill**（`report-package-cli.ts`）：`inspectReport` 读取字段 `roles` 记入 plan 字段（生成期提示），`report.description` 本就透传。config-help 增角色/说明的解释。
- **测试**：reports-config 19、report skill 30（新增 roles/description 流入 plan 用例）；Studio typecheck/web 65/lint/版本断言全绿。
- **版本**：报表 Skill 2.8.0→**2.9.0**、知识库 Skill 0.13.0→**0.14.0**、Bundle 1.10.0→**1.11.0**（兼容扩展）；已 sync 刷新缓存/vendor，**transport-test 已重装到 1.11.0**（config 保留）。
- 说明：角色目前作为**配置意图 + 生成期提示**记录；让 roles 真正驱动"自动把 filter 字段建成筛选、group 字段建成 group_by"属阶段 B/C 的生成流程改造。

### 复杂报表方案（决策 0002）+ 跨库能力确认 + 阶段 A 落地（2026-07-20）

面向"多库 / 多查询 / 同比环比"的真实报表（毛利明细表等）出**决策 0002 提案**（`docs/decisions/0002-script-report-packages.md`）：脚本驱动报表包（v3，`ctx.query` 多库路由 + `loadIndex` + `emit` 流式）+ 对比 sheet（同一汇总逻辑跑不同月份区间，多语义 sheet），分 A/B/C/D 期。用户确认边界：现同机多库/同账号、将来多机；同比环比=正常报表逻辑多加 sheet、按月筛选；分组汇总（按客户等分组，N 组 N 行）；先做地基再上脚本。

**阶段 A 实测已基本具备，本次只补测试+文档**：
- **知识库多库扫描**：配置 `databases` 已是数组、Studio ConnectionsEditor 支持多库、扫描侧 `WHERE TABLE_SCHEMA IN(…)` 全量扫、`discover` 遍历所有库——只需用户配多库并重扫。
- **同连接跨 database JOIN 已支持**：校验器只禁跨 *profile*、不禁跨 database；SQL 每表用自身 `库.表` 限定；Runtime 连主库为默认 schema 可引用兄弟库。新增测试锁定（`cross-database JOIN within one profile…`）。
- **SKILL.md**：§3 增"Cross-database JOIN""Grouped summary reports"两节。
- **测试**：报表 skill 29 通过；Studio typecheck/lint/版本断言全绿。
- **版本**：报表 Skill 2.7.0→**2.8.0**、Bundle 1.9.0→**1.10.0**（文档+能力确认，无破坏性）；已 sync 刷新缓存/vendor。
- **transport-test 已重装到 1.10.0，并按用户要求清空知识库（drafts/versions/scans + index 置空）+ 删除旧报表包**（全量备份于 `/tmp/tt-preupgrade-5`）。下一步：用户配置多库连接 → 重新初始化多库知识库 → 再做报表生成调整（阶段 B/C）。

### 报表包页面内编辑器（改 SQL/脚本/筛选 → 保存 → 重新封包）（2026-07-20）

上一轮 `reseal` 只在 CLI 层；本轮接到 Studio 页面，让人工可在浏览器里直接修 AI 生成的报表包。

- **workspace-sdk**（`report-state.ts`）：新增 `readReportPackageDetail`（列文件 + 可编辑标记 + 包状态）、`readReportPackageFile`、`writeReportPackageFile`（防穿越 + 可编辑白名单 + 文件须已存在）、`resealReportPackage`（经调用方用 manifest 解析出的 `package_cli` 路径 spawn `reseal`，不硬编码深层路径）。**可编辑判定改为按报表包自身生命周期 `status`**（released/published/production/signed 只读；draft/approved 可编辑），不再用 `development_only`——修复"草稿包因基于已发布知识库而被误判只读"。编辑白名单：`main.sql`/`bindings.json`/`parameters.schema.json`/`fields.json`/`transforms/index.{ts,mjs}`/`tests/cases.json`；`manifest`/`lock`/`checksums` 只读。
- **服务**（`workspace/state-routes.ts`）：新增 `GET …/reports/package/detail`、`GET/PUT …/reports/package/file`、`POST …/reports/package/reseal`；reseal 经 `WorkspaceSkillAdapter.resolveCommand('create-report-package','package_cli')` 解析 CLI。发布包写/封返回 409，越界 400，未知 404。
- **skill**（`report-package-cli.ts`）：`reseal` 的可编辑门禁同步改为按 `status`（与 SDK 一致），draft 包即使 `development_only=false` 也可重封。
- **前端**（`PackageEditor.tsx` + `ReportsPanel.tsx` + `styles.css`）：报表包行增"编辑"按钮 → 弹出编辑器（左侧文件树、右侧文本编辑、保存单文件、顶部"重新封包"）；已发布包只读展示（禁用保存/封包并标"只读"）。
- **测试**：service 加编辑器路由用例（detail/read/write + 白名单/发布保护 409），52 通过；skill 28 通过；web 61、workspace-sdk 50 通过；typecheck/lint 全绿。
- **真机验证**：transport-test 上对 `transport-order-detail`（status=draft）走通"读→改 main.sql→保存→reseal 成功、校验通过"，随后还原为干净包。
- **版本**：报表 Skill 2.6.0→**2.7.0**、Bundle 1.8.0→**1.9.0**（reseal 门禁语义调整 + 兼容特性）；已 sync 刷新缓存/vendor，**transport-test 已整包重装到 1.9.0**（保留 config/knowledge/reports/toolkit）。

### 报表：筛选项带数据类型/枚举选项 + 报表包支持手改重封（2026-07-20）

两项：**(1) 参数元数据增强**——返回给前端的每个筛选项带 `data_type` 标签（string/number/datetime/date/enum/boolean/…range），枚举类型额外带 `enum_options`（`{code, label}` 数组，code + 中文，取自锁定的知识库字典）与 `required`；**(2) 报表包生成后可人工修改**——AI 产物不一定可用，新增 `reseal` CLI 命令支持手改后重封。

- **生成侧**（`report-package-cli.ts`）：`buildParameterSchema` 增 `parameterDataType`（value_type→稳定数据类型标签）并为枚举筛选嵌入 `enum_options`（复用 `buildPackageEnums` 的字典）。新增 `resealPackage`——先做结构校验（除校验和外的全部检查），结构损坏则拒绝并报错、绝不放行坏包；结构 OK 才重算 `checksums.sha256` 并重新校验。**仅开发包**可重封，已发布/签名包不可原地改。CLI 增 `reseal --package <dir>`。
- **运行时**（`runtime-core.ts`）：`parameters` 端点增回 `dataType`（缺省回退 value_type）与 `enumOptions`。
- **Studio 测试页**（`TestPanel.tsx`）：枚举筛选渲染 `<select>`（`in` 多选 / `eq` 单选，显示"中文（code）"），沿用范围/单值提交逻辑。
- **SKILL.md**：§6 增"Manual edit of a development package (reseal)"小节。
- **测试**：报表 skill 加 data_type/enum_options、reseal 成功、reseal 拒绝坏结构等用例，28/28 通过；Studio typecheck/web 61/service 51（单跑）/lint 全绿（并跑时 runtime 套件曾因资源竞争超时跳过，单跑通过，非回归）。
- **版本**：报表 Skill 2.5.0→**2.6.0**、Bundle 1.7.0→**1.8.0**（兼容特性；参数/绑定新增可选字段，不改 plan/package 格式）；已 sync 刷新缓存/vendor，Studio 版本断言更新为 1.8.0。**transport-test 已整包重装到 1.8.0**（保留 config/knowledge/reports/toolkit）。

### 报表：时间列改为范围筛选（起/止）+ 创建时间必填 + 测试页时间选择器（2026-07-20）

需求：创建时间应是**时间范围**筛选（起/止两字段）、**必填**；测试页要有时间选择器并按范围查询。

- **生成侧**（`report-package-cli.ts`）：新增 `rangeFilterFor`/`isCreateTimeField`/`isDateLikeOutput`——任何 `date`/`datetime` 输出列自动建成范围筛选（`value_type=date_range|datetime_range`、`component=date-range|datetime-range`、`operators=[between,gte,lte]`、默认 `between`）；**创建时间**（按列名 `create_time/created_at/gmt_create/…` 或"创建时间/创建日期"标签识别）强制 `required=true`，即使知识库标了可选。`buildBindings` 增带 `required` + `value_type` 供运行时使用。
- **运行时**（`runtime-core.ts`）：新增 `isFilterEmpty`（识别 `{operator,value}` 与 `{from,to}` 包装，范围两端皆空才算空）；`compileSql` 对 `required` 用户筛选缺失时抛 `MISSING_FILTER`；`between` 已支持 `{from,to}` 且单边降级为 `>=`/`<=`。
- **Studio 测试页**（`TestPanel.tsx`）：范围参数渲染两个时间选择器（`datetime-local`/`date`/number，"起 至 止"），必填项标 `*` 并在导出前前端拦截；提交时范围组为 `{operator:'between', value:{from,to}}`，`datetime-local` 的 `T` 归一为 SQL 空格分隔。
- **SKILL.md**：§3 新增"Date/datetime filters are ranges; create-time is required"小节。
- **测试**：报表 skill 加"create_time 必填 datetime_range"+"必填校验/范围 BETWEEN 编译"用例，25/25 通过；Studio typecheck/web 61/service 51/lint 全绿。
- **版本**：报表 Skill 2.4.0→**2.5.0**、Bundle 1.6.0→**1.7.0**（兼容特性；binding 新增可选字段，不改 plan/package 格式）；已 sync 刷新缓存/vendor，Studio 版本断言更新为 1.7.0。**transport-test 已整包重装到 1.7.0**（保留 config/knowledge/reports/toolkit）。

### 报表：一对多拼接列筛选下推为相关 EXISTS 子查询（2026-07-20）

场景：一对多关联（一个订单→多个货品）中，子表列以 `GROUP_CONCAT` 拼接输出后，不能再作为普通列在 `WHERE` 里筛选。这是通用建模问题。**最终方案：筛选下推为相关 `EXISTS` 半连接**——"命中任一货品即返回该订单，输出仍拼接全部货品名"。相比同日更早的 HAVING 方案，EXISTS **更快**（分组前过滤、命中即短路、可用子表索引）且**更正确**（不受 `group_concat_max_len` 默认 1024 字节截断导致的漏筛）。

关键约束：**不放松防注入护栏**。子查询骨架在**生成期**由知识库信息（子表名/关联键/逻辑删除条件）构建，绝不含用户输入；运行时只把搜索值当 `?` 绑进子查询内层的 `LIKE`。

- **CLI**（`report-package-cli.ts`）：新增 `isConcatField`（`GROUP_CONCAT/STRING_AGG/…`）与 `buildExistsSkeleton`（从 join 的 `on`/`conditions` 反推相关子查询骨架：`EXISTS (SELECT 1 FROM 子表 AS ex_x WHERE ex_x.fk = t0.pk AND <逻辑删除> AND ` + 内层列 + `)`）。`configure-plan` 遇到拼接字段的筛选，自动改为 `clause=exists_subquery` + `contains`，骨架落进 `sql_binding.subquery_prefix/suffix`；无法映射到单一子列时回退 `HAVING … LIKE`。**真·数值聚合**（`SUM(qty)>=n`）不改写，仍走 `having`。校验（`validatePlanV2` + `validatePackage`）接受新 clause 并校验骨架结构/禁注入字符/内层为 `ex_*.列` 引用。
- **Runtime**（`runtime-core.ts`）：`compileSql` 处理 `clause=exists_subquery`——先 `buildPredicate` 出内层 `列 LIKE ?`，再用可信骨架包成 `prefix + 内层 + suffix` 塞进 WHERE；值仍走参数绑定。新增 `assertSafeSubquerySkeleton` 二次校验骨架（结构 + 禁 `;/--/注释/引号` + 除首个外禁 `SELECT/UNION/…`）。
- **SKILL.md**：§3"Filtering a field that is aggregated"小节改为 EXISTS 方案，讲清为何优于 HAVING、安全边界、MySQL/PG 差异与回退。
- **测试**：报表 skill 新增/改写 EXISTS 用例（configure 生成骨架 + 运行时把值绑成 `?` 且骨架完整），23/23 通过；数值聚合 HAVING 老用例保持不变。
- **版本**：报表 Skill 2.3.0→**2.4.0**，Bundle 1.5.0→**1.6.0**（兼容特性新增，不改 plan/package 格式）；已 `sync-easybi-bundle` 刷新缓存与 vendor（新 SHA），Studio 版本断言更新为 1.6.0。全仓 typecheck/lint/test 全绿。

### 对话框三项优化：去重渲染 / 工具折叠 / 终止即续（2026-07-20）

针对聊天体验的三个问题：

1. **最终答案渲染两次**：真实 Claude 的 `result` 文本与流式 `message_delta` 是同一段文字，`job_completed.summary` 又作为 notice 追加了一遍。`reduceEvent` 的 `job_completed` 分支现比对末尾 assistant 行，重复时不再追加 notice（`agent-chat.ts`）。
2. **工具标签铺满页面**：连续的 tool 行（Read/Grep/…）折叠成一个可展开分组，头部显示"N 个步骤 · M 进行中 · K 失败"摘要，运行中自动展开、完成后折叠。新增纯函数 `groupRows` + `toolGroupSummary`，组件 `ToolGroupView`/`ToolRow`，CSS `chat-tool-group*`。参考 Innos `AgentThinkingCard` 的分组折叠交互。
3. **"终止"废掉整个会话**：原 `cancel` 把任务置 CANCELED（终态）且关流，无法再对话。新增 **interrupt** 语义——停止当前轮但保留 session 可续：契约 `AgentBridge.interrupt?()`（可选），`ClaudeCodeBridge`/`FakeAgentBridge` 实现（杀进程/放闸后以 `completed` 收尾，落 SUCCEEDED 而非 FAILED），`JobManager.interruptJob`（释放写槽、无 interrupt 能力则回退 cancel），服务 `POST /agent-tasks/:id/interrupt`，前端 `agentApi.interrupt` + 终止按钮改调它（不再置 CANCELED/关流，由 pump 的 job_completed 落定并重新启用输入框）。按钮 title 改"终止本次回复（可继续对话）"。
- **测试**：agent-chat 加去重、分组、摘要 3 个用例（web 61）；job-manager 加 interrupt 落 SUCCEEDED + 释放写槽用例（12）；agent-bridge 10、service 51 全绿；typecheck/lint/web build 全绿。
- **真机验证**：transport-test + 真实 Claude——数数任务运行中 interrupt → 落 SUCCEEDED（带"已终止"提示）→ 追问"改成只回复一个词"得到应答，会话经 `--resume` 正常续上；末轮 `message_delta`/`job_completed` 同文，前端不再重复渲染。

### 修复多轮对话回复无响应（SSE 重订阅竞态）（2026-07-20）

现象：AI 提问确认后，用户回复发出去没反应。根因是**多轮 resume 的 SSE 重订阅竞态**——真实 Claude 每轮以 `job_completed` 收尾并关流，回复后前端重新订阅，但后端 `subscribe()` 把整个事件缓冲区**从头重放**（含上一轮的 `job_completed`）：既导致后端判定"最后一个缓冲事件是终态"立刻 `queue.end()` 关流，又让前端收到重放的旧 `job_completed` 后立即 `closeStream()`，新一轮事件永远到不了前端。

- **后端**（`job-manager/manager.ts`）：`subscribe(jobId, since=0)` 加 `since` 游标，只重放消费者未看过的事件（`events.slice(since)`）；关流判定从"最后缓冲事件是否终态"改为**任务真实状态**（`!pumping && status∈{SUCCEEDED,FAILED,CANCELED}`），刚 resume 回 RUNNING 的任务不会被误关。
- **服务**（`jobs/routes.ts`）：SSE 路由 `GET /jobs/:id/events` 接受 `?since=N` 查询参数并透传。
- **前端**（`AgentDrawer.tsx` + `api.ts` + `panels/agent-chat.ts`）：`ChatModel` 加 `eventCount`（每折叠一个事件 +1），`eventsUrl(jobId, since)` 拼 `?since=`，`subscribe(id, since)` 带游标；回复重订阅传 `eventCountRef.current`，reopen 重订阅传 `events.length`。
- **测试**：job-manager 加回归测试（完成一轮后带 `since` 重订阅只收到 resumed 轮、不重放旧 `job_completed`）。job-manager 11、service 51、web 57 全绿；typecheck/lint 全绿。
- **真机验证**：transport-test + 真实 Claude 连跑三轮问答（你好→再见→不客气），事件日志三轮 `job_completed` 齐全、每次回复都得到应答；`since=5`/`since=8` 游标切片精确，无旧轮重放。

### 新增运行指南文档 GETTING_STARTED.md（2026-07-20）

文档缺少一份"怎么把项目跑起来"的完整说明，启动信息只散在根 `README.md`。新增 [docs/GETTING_STARTED.md](./GETTING_STARTED.md)：一眼概览（两进程/端口/入口）、前置环境、首次运行、三种运行模式、环境变量全表、Skill 同步与建工作区、Provider 切换、冒烟验证、常见问题排查表。

- 接入文档体系：`docs/README.md` 索引置顶、`AI_CONTRIBUTING.md §1` 上手顺序第 2 位、根 `README.md` 阅读顺序、`AI_CONTRIBUTING.md §7` 文档维护义务表新增对应行。
- 顺带修正两处文档-实现不符：`ARCHITECTURE.md §4` 的 `studio.sqlite`→实际 `studio.db`（`EASYBI_STUDIO_DB_FILE`）；根 `README.md` 环境变量表补齐 `EASYBI_STUDIO_HOST` 与 `EASYBI_STUDIO_DB_FILE`（此前遗漏）。
- 纯文档改动，无代码变更；不涉及门禁。

### 多数据库支持：新增 PostgreSQL（2026-07-19）

数据库连接此前固定 MySQL。现按预留的连接器接缝加入 PostgreSQL，MySQL 保持默认且行为不变。**skill 未大改，是"填方言接缝"**——扫描侧原就有 `CONNECTORS` 注册表与 `engine` 分派。

- **知识库扫描（initialize-report-knowledge）**：新增 `scripts/dialect.ts`——`Dialect` 接口（quoteId/connect/serverMetadata/listDatabases/tables/columns/indexes/foreignKeys/活跃探测 SQL/distinct SQL/只读事务/超时）+ MySQL 与 PostgreSQL 两份实现。`catalog-cli` 的连接/元数据/发现/`probeActivity`/`scanDistinctValues`/枚举初始化全部改走方言分派。PG：`information_schema`+`pg_catalog`、`"`引号、`SET statement_timeout`、`BEGIN TRANSACTION READ ONLY`；Easy BI 的“databases”映射为 PG 的 **schema**。快照产物结构保持引擎中立（不动 `catalog_format`）。skill 26/26 测试通过。
- **报表 SQL 生成 + Runtime 执行（create-report-package）**：`report-package-cli` 标识符引用与 SQL 表达式校验正则按方言分派（反引号 ↔ 双引号；仍禁止另一种引号、`;`、注释、DML）；报表包记录新字段 `sql_dialect`（兼容扩展，缺省 mysql）。`runtime-core` 加 `QueryAdapter`：MySQL 路径原样保留，PG 用 `pg` 驱动、`BEGIN TRANSACTION READ ONLY`、`SET statement_timeout`、`?`→`$n`。skill 21/21 测试通过。
- **Studio**：`config-sdk` `RealMysqlAdapter` 加 PG 分支（`pg`，只读列 schema）+ `normalizeEngine`；连接配置表单加「数据库类型」下拉（MySQL/PostgreSQL，自动切默认端口 3306/5432，PG 下 databases 提示填 schema）；`connector_id` 全链路打通（config 提取 + inline 测试）。
- **依赖/同步**：`pg` 加入两个 skill（知识库 dependencies、报表 optionalDependencies 由 `bootstrap:runtime` 装）与 config-sdk；bundle 1.4.0→**1.5.0**，报表 skill 2.2.0→2.3.0、知识库 package 版本对齐 0.13.0。
- **真机验证**：连接测试用 `connector_id: postgresql` 正确路由到 PG 适配器、连 **5432** 端口、返回干净的 ECONNREFUSED（本机无 PG，符合预期）。全仓 typecheck/lint/test 全绿；两个 skill 构建+测试全绿。
- **兼容性**：全部为兼容扩展——老工作区默认 mysql，老报表包无 `sql_dialect` 按 mysql 执行，`catalog_format` 未变。

### 总览阶段中文化 + 配置页说明（2026-07-19）

- **总览「当前阶段」中文化**：此前显示原始枚举（如 `REPORT_REQUIREMENT_READY`）。`workflow.ts` 加 `STAGE_LABELS`（全部 ProjectStage → 中文）与 `WorkflowState.currentLabel`；总览页大字显示中文标签、下方小字保留原始枚举备查。
- **配置页说明面板（来自技能包）**：JSON 配置页（构建/Runtime）此前看不出在配置什么。各 skill 新增 `config-help.json`（每个 config 文件的用途 summary + 各 section 的中文说明），manifest 加可选 `config_help` 引用、白名单纳入。`WorkspaceSkillAdapter.readConfigHelp()` 读取；`GET /projects/:id/config-help` 暴露；配置页在 JSON 编辑器上方渲染可折叠的「XX 是什么？」说明面板（summary + section 表 + 来源 skill）。旧 bundle 无此文件时降级为不显示。
- **bundle 1.3.0→1.4.0**（兼容扩展：新增可选文件/字段）；`transport-test` 手动补入 config-help.json + manifest config_help。
- **测试**：workspace-sdk workflow +currentLabel 断言、service config +config-help 与 currentLabel 断言、bundle-source/bootstrapper 版本断言→1.4.0；全仓 build/typecheck/lint/test 全绿。真机验证：`REPORT_REQUIREMENT_READY`→「待生成报表包」；config-help 返回 build(8 段)+runtime(4 段)。

### AI 对话：删除历史、普通对话、可配置预置提示词（2026-07-19）

三项按用户需求：

- **删除历史对话**：`JobStore.deleteJob`（删 job + 级联 job_events）、`JobManager.deleteJob`（同时清内存 + 释放写槽，进行中任务抛 `JobActiveError`）、路由 `DELETE /agent-tasks/:id`（200/409/404）。前端历史列表每项加垃圾桶按钮（hover 显现 + confirm）。
- **普通对话（free-chat）**：`AgentActionType` 新增 `'free-chat'`（只读，不占写锁、不建检查点）；`buildActionPrompt` 对 free-chat 用用户原文（+简短边界提醒），不套模板。抽屉「历史」视图加「+ 新建对话」→ 空白输入直接提问；首条消息经 `agentApi.start('free-chat', text)` 起任务，后续多轮复用续聊链路。「AI 助手」工具栏按钮改为**拆分按钮**：直接点主体 = 打开普通对话（`newChat` 经 context），点右侧箭头才展开预置提示词下拉。
- **可配置预置提示词（先从 skill 初始化）**：
  - **skill 包（兼容扩展，bundle 1.2.0→1.3.0）**：`initialize-report-knowledge` 与 `create-report-package` 各新增 `prompts.json`（初始化知识库 / 构建报表两条预置）。manifest 每个 skill 加可选 `agent_prompts` 字段引用；白名单 `SKILL_INCLUDE_PATTERNS` 加 `prompts.json`。skill 版本 0.12.0→0.13.0、2.2.0→2.3.0。
  - **config**：工作区 `config/easy-bi.json` 新增可选 `agent_prompts` 块（不改 config_version，纯兼容扩展）。`WorkspaceSkillAdapter.readSkillPromptPresets()` 读各 skill 的 prompts.json。
  - **API**：`GET /projects/:id/agent-prompts`（有配置读配置，否则回退 skill 默认值，标 `source`）、`PUT`（写回 config，revision 乐观锁 + 备份）。`buildActionPrompt` 支持 `fullPrompt` 覆盖——配置的预置文本替换内置模板，动作 verb 仍决定写锁/检查点。
  - **前端**：配置页新增「AI 提示词」页签（`PromptsEditor`：增删改 action/label/hint/prompt/write）；抽屉快捷入口 `AgentQuickStart` 改为按页拉取配置的预置（`KNOWLEDGE_ACTION_VERBS`/`REPORT_ACTION_VERBS` 只决定哪些 verb 出现在哪页），不再硬编码。
- **同步**：`sync-easybi-bundle.mjs` 生成不可变 `1.3.0` 缓存 + vendor 快照（prompts.json 已进白名单）；`transport-test` 手动补入两份 prompts.json + manifest agent_prompts（既有工作区不自动升级）。
- **真机验证**：transport-test 的 agent-prompts 回退返回两条 skill 默认预置；free-chat 起任务→完成；删除对话后 job + job_events 从磁盘 SQLite 双双清零（404）。
- **测试**：job-manager +1（删除/拒删活跃）、service jobs +4（free-chat 起/校验、删除 200/404、拒删 409）、service +prompt-routes 3（回退/保存/校验）、bundle-source 与 bootstrapper 版本断言更新到 1.3.0；全仓 build/typecheck/lint/test 全绿。

### AI 对话记录持久化（关闭后可找回并续聊）（2026-07-19）

对话此前只在内存,Studio 重启即丢。现在像 Claude Code 一样持久化,重启后可在「历史」里找回、查看、并继续追问:

- **事件落库**：迁移 `0003_job_events`（`job_id, seq, type, at, payload_json`，外键级联，按 `(job_id,seq)` 有序，append-only）。`JobStore` 加 `appendEvent`/`listEvents`/`get`；`JobManager` 每次 `emit` 时经 `EventStore` 持久化。
- **重启对账改进**：`reconcileOnStartup` 对有 `session_id` 的中断任务标记为**可续的 SUCCEEDED**（可重开并续聊），无 session 的才标 FAILED；事件日志一律保留。
- **重开会话**：`JobManager.reopenJob(jobId, workspaceRoot)` 从库里重建内存记录（job + 完整事件日志），供查看与续聊；路由 `POST /agent-tasks/:id/reopen`。`getJob`/`getEvents` 对不在内存的任务回退查库。
- **跨重启续聊**：契约 `AgentBridge` 加可选 `rehydrate(taskId,projectId,workspaceRoot,sessionId)`；`ClaudeCodeBridge` 实现（用保存的 `session_id` 重建任务态，`continue()` 走 `--resume`）。`replyToJob` 在续聊前若检测到 provider 无内存态则先 rehydrate。
- **前端**：抽屉右上角「历史」入口 → 列出本工作区历史对话（动作名/时间/状态）→ 点击 `reopen` 载入完整记录并可续问。`api.ts` 加 `agentApi.reopen`。
- **真机验证**：新对话 6 条事件落 `~/.easybi-studio/studio.db` 的 `job_events`（含 session_id）；reopen 完整返回记录;直接查磁盘 SQLite 确认独立于进程存活。
- **测试**：job-manager +2（事件持久化 roundtrip、重启后 reopen+续聊）、service +2（reopen 200/404、reconcile 分流 session→SUCCEEDED / 无 session→FAILED）、migrations +job_events、contracts 转移用例；全仓 build/typecheck/lint/test 全绿。

### AI 对话抽屉体验修复（2026-07-19）

针对试用反馈的 5 个问题：

- **多轮对话可续（核心，非样式）**：`ClaudeCodeBridge` 从不发 `waiting_for_user`（只有 Fake 发），真实 Claude 每轮以 `completed` 收尾→任务 SUCCEEDED、SSE 关闭。原「仅 WAITING_FOR_USER 才可输入」导致永远无法回复。修复：`JobManager.replyToJob` 支持从 SUCCEEDED 续轮——重设 RUNNING、重新 `continue()`（Claude 走 `--resume <session>`）、若上轮 pump 已结束则重新 pump 新一轮事件流；写任务续轮时重新占用写槽。契约 `JOB_TRANSITIONS` 放开 `SUCCEEDED→RUNNING`（FAILED/CANCELED 仍终态）。前端：空闲（本轮完成/等待）即可输入，回复后重新订阅 SSE。真机验证：一个 job 两轮 completed，第 2 轮记得第 1 轮上下文（session 连续）。
- **Markdown 渲染**（参考 Innos `embodied-platform/desktop` 的 `IdeChatMarkdown`）：新增 `panels/ChatMarkdown.tsx`，`react-markdown` + `remark-gfm` + 流式安全的错误边界（未闭合 ``` 降级纯文本）；代码块带语言标签 + 复制按钮。样式 `.chat-md*`（IDE-Mono 令牌）。
- **抽屉不透明 + 遮罩**：加 `.chat-backdrop` 半透明遮罩 + `--ide-bg-panel` 实底，不再和知识库冷热表叠字。
- **快捷入口文字挤压**：下拉项改用 `.agent-quick-*`（纵向排布、hint 正常换行），不再复用会挤压的 `sb-nav-item`。
- **用户气泡**：`ChatModel` 加 `user` 行，回复本地即时上屏（后端不重复回显）。
- **测试**：job-manager +1（真实 Claude 风格 TurnByTurnBridge：SUCCEEDED→RUNNING→SUCCEEDED 续轮）、contracts 转移用例更新；web 57、service 41、job-manager 7、contracts 9 全通过；typecheck/lint/build 全绿；新增 web 依赖 react-markdown + remark-gfm（bundle 267→424KB）。

### 前端 AI 对话抽屉增量（2026-07-19）

此前「移除前端 AI」只删了 studio-web 的抽屉，后端 AgentBridge + Job + Checkpoint + SSE 一直保留。本次把前端对话线重新接回,用本机 Claude 模拟对话,后续切 Innos 只改环境变量。

- **规则变更**：`CLAUDE.md` + `UI_STYLE_GUIDE.md` 把「禁止前端 AI 交互」改为「前端对话只经 AgentBridge + Job/SSE，Provider 可切（本机 claude→innos），前端不直连任何 AI 厂商 API、不内嵌厂商协议」。
- **后端**：新增 `GET /api/easybi/agent-health`（返回冻结的 `AgentHealth`，展示当前 Provider 与可用性）。对话发起/多轮/取消/SSE 端点（`/agent-actions`、`/agent-tasks/:id/messages|cancel`、`/jobs/:id/events`）与 8 个默认提示词模板（`agent/prompts.ts`）**均为既有**，无改动。`EASYBI_AGENT_PROVIDER=claude` 检测不到 CLI 时硬报错（不静默降级）。
- **前端**：`api.ts` 加 `agentApi`（start/reply/cancel/get/list/eventsUrl/health）+ `AgentJob`/`JobEvent`/`AgentHealth` 类型；`AgentDrawer.tsx` 全局抽屉（`AgentDrawerProvider` 挂 App 根 + `useAgentDrawer`）：SSE 流式渲染、多轮回复、取消、WAITING_FOR_USER 门、收起后台、Provider 状态条；知识库/报表页 TopBar 加「AI 助手」快捷入口（`AgentQuickStart`，各页预置对应 action 的默认提示词，写类动作标注「写」）。事件→视图映射为纯函数 `panels/agent-chat.ts`。
- **切 Innos**：前端与 SSE/Job/页面全部不改，只把 `EASYBI_AGENT_PROVIDER=innos` 并将 `InnosAgentBridge` 存根填成真实实现（映射表见 INNOS_INTEGRATION.md §2）。
- **测试**：新增 `agent-chat.test.ts` 11 项（事件折叠/工具态/等待门/完成失败/终态）、service `agent-health` 1 项；web 57、service 41 全通过；typecheck/lint/build 全绿。真机 `GET /agent-health` 返回 `provider:claude-code, available:true`。

### 报表包删除增量（2026-07-19）

页面此前无法删除已生成的报表包。新增删除能力（按 CLAUDE.md「保留已发布版本」约束加护栏）：

- workspace-sdk `deleteReportPackage(ws, id, version)`：仅允许删 `development_only` 包；已发布/生产版本抛 `PROTECTED`（拒绝）。删除 `reports/packages/<id>/<version>/` 目录（路径严格限定在 reports/packages 下，防穿越）并从 `reports/index.json` 去登记；若为该报表最后一个版本，清理空的 `packages/<id>` 父目录。`readReportState` 补出 `version`/`path`（此前只映射了 current_version，导致版本列显示 —）。
- 路由 `DELETE /api/easybi/projects/:projectId/reports/package`（body: id+version）：development-only→200；已发布→409 PROTECTED；未知→404；路径非法→400。
- 前端「报表」页报表包表格加删除列（垃圾桶按钮），仅 development-only 可点，删除前 `confirm` 二次确认，成功提示可见；版本列改用真实 `version`。
- 测试：workspace-sdk 3 项（删/保护/404）、service 路由 2 项（删除+保护、未知 404）；真机验证 transport-test：删 dev-only 包（目录移除+去登记）成功、删已发布包 409 被拒。

### 枚举中文映射增量（2026-07-19）

枚举字段（如 status varchar）此前无 code→中文，导出 Excel 显示原始码值。三项优化（改两个正式 Skill + studio）：

- **A. 自动初始化**：`initialize-report-knowledge` 新增 `enums-init`（离线原生 ENUM/注释预填 + 对无值字典连库只读 `SELECT DISTINCT … LIMIT+MAX_EXECUTION_TIME`，超时/超限/失败降级不阻断；幂等不覆盖人工 label；写 enum_ref；跳过 system_condition 字段）。真机 transport-test：160 绑定/143 字典/distinct 预填/0 跳过。
- **B. 译文链路**：`create-report-package` 生成期把锁定知识版本的 enums 按字段内嵌进报表包 `enums.json`（+ 可选 `entrypoints.enums`）；runtime 写 Excel 时对枚举列 code 译中文、未命中保持原值。plan 的 knowledge 块新增可选 `source_dir`。**真机验证**：导出「订单状态」列显示 待分配/已完成/已取消/已分配/已发车（原码值已译）。
- **C. 可视化配置**：studio「配置」页新增「枚举」页签。GET enums 附带连接/数据库/表拆分 + 字段说明（取自 by-field 索引）。Excel 风格双子表——「字段绑定」（连接/数据库/表/字段/字段说明/枚举名称 + 完成度）与「枚举字典」（集中维护所有枚举名，显示绑定数与完成度），点行/枚举进入该枚举的映射配置（返回 + 绑定字段明细 + code→中文 增删）；「表格 / JSON」视图切换，JSON 可编辑整份 enums.json。保存经 `enums-import-json`（与 Excel 导入共用 `applyEnumRows` 校验+写入核心），全部经 WorkspaceSkillAdapter，不拼路径/不复制 CLI 逻辑。
- **增量保存修复**：页面「保存」= WIP（`enums-import-json --allow-incomplete`，完整性问题降级为 warnings 仍写入草稿）；「校验」= 严格 dry-run（待补全项列在**可关闭**面板）；错误提示可关闭。发布/校验仍走严格模式。
- **兼容性**：枚举能力全部为兼容扩展（新增可选 CLI 命令/可选字段/可选包文件，不改已有语义）；旧工作区空 enums.json、旧报表包无 entrypoints.enums 行为不变。
- **测试**：initialize-report-knowledge 26 项、create-report-package 20 项全通过；Studio 全仓 build/typecheck/lint/test 全绿。

### 知识库草稿/发布双视图 + 可视化编辑增量（2026-07-19）

知识库设计为“草稿（可编辑）+ 发布（不可变）”双态，AI 生成默认 draft，发布后草稿保留可继续迭代：

- **后端只读读取器** `packages/workspace-sdk/knowledge-catalog.ts`：`listCatalogs`（草稿/版本清单 + counts + 当前版本）、`readCatalogOverview`（按 profile/database 分组精简条目）、`readTableDetail`（单表完整 JSON，冷表无字段，热/温表带 revision）。
- **草稿语义直写** `packages/workspace-sdk/knowledge-edit.ts`：白名单字段（表 business.name/description/domain；字段 semantic.name/description/report_exposed；filter.enabled/role/default_operator）；revision 乐观锁 + 原子写 + 备份到 `work/knowledge-backups/`；写后同步 `by-field.json`；人工改动标记 `status=confirmed / source=user`；不碰物理 schema、拒绝写已发布版本。
- **结构性操作走 skill CLI** `apps/studio-service/src/knowledge/skill-cli.ts`（`spawn` node + `catalog-cli.js`，路径经 Manifest 解析，可注入假执行器）：`validate` / `promote`（冷→热带 `--snapshot` 恢复字段）/ `publish`（校验就绪 → 拷为 `versions/<semver>`）。
- **前端 `KnowledgePanel` 双视图**：草稿/版本页签；主从布局（左=搜索+热温冷筛选+数据库下拉+表列表；右=表详情）；草稿态字段行内编辑 + 表头语义编辑、分层切换、校验、发布弹窗；发布/只读视图。纯函数 `knowledge-view.ts` + 单测。
- 路由：`GET /knowledge/catalogs|catalog|catalog/table`、`PUT /knowledge/catalog/table`、`POST /knowledge/validate|promote|publish`。
- 测试：workspace-sdk 读取器/编辑器单测、service 知识库路由（假 CLI）6 项、web 视图 helper 单测全绿。真机验证 validate/改名回写/warm↔hot 提层往返成功并还原。

### 配置可视化增量（2026-07-19）

将散落在 JSON 里的配置改为表单，改后同步写回配置文件（复用既有 revision 乐观锁 + 原子写 + 备份，后端零改动）：

- **报表配置**（`config/easy-bi.json` 的 `knowledge.report_requirements` / `report_scenarios`）：并入「配置」页页签，ID/名称/必需字段逐条增删；纯函数 `reports-config.ts` + 单测。
- **连接配置**（「配置」页「连接」页签）：数据库 profile（host/port/username/明文 password/databases）+ 阿里云 OSS profile（endpoint/region/bucket/prefix/明文 AccessKey/过期秒数）。明文直填直存；只改 `connections` 两块、保留其余与未知键；不误伤 `password_env`。纯函数 `connections-config.ts` + 单测。
- **数据库测试连接**：`config-sdk` 新增 `RealMysqlAdapter`（`mysql2`，只读：仅 `SELECT 1` + `SHOW DATABASES`，永不 DDL/DML，连接超时 5s，note 脱敏、永不回显密码）；`FakeMysqlAdapter` 保留供测试注入。`test-mysql` 支持传未保存的 inline profile。
- **配置页四页签**：连接 / 报表 / 构建配置 / Runtime 配置。
- `CLAUDE.md` 新增 “UI style” 规则段与必读文档，强制后续迭代遵循 IDE-Mono + 只读 AI + 网关反代接入。

### Skill P1–P5 收尾增量（2026-07-19）

- **P1**：知识库 CLI 的全局 `--version` 不再截获 `publish --version`，参数解析同时支持 `--key value` / `--key=value`。
- **P2**：报表计划和报表包升级到格式 v2，生成器支持多表 `LEFT/INNER JOIN`、从表逻辑删除 ON 条件、SQL 聚合 `GROUP BY/HAVING`、逐行计算和有界内存的流式分组计算。
- **P3/P4**：知识库新增确定性 `approve-plan`；报表需求可用唯一中文语义名定位物理字段，多义与未命中返回明确候选。
- **P5**：知识库 `build` 自动做非阻断枚举初始化（详见枚举增量）。
- **最终验证**：知识库 Skill 26/26、报表 Skill 20/20；Studio 197 项包级测试 + 5 项集成测试全部通过，lint/typecheck/build 全绿。最终真库导出重试因 MySQL 服务端主动断开连接而停止，未把外部连接失败记为导出成功。

### UI 改造增量（对齐 Innos IDE-Mono + 移除前端 AI）

参考 Innos 源码 `embodied-platform`（`1bdec31` IDE-Mono 主题、`cc78f76` 网关反代架构）：

- **对齐 IDE-Mono 主题**：Tailwind v4 + lucide-react；`--ide-*` 令牌与 `.ide-*` 组件类移入 `styles.css`；`theme.ts` 明暗（`data-theme`，默认 Light，可切 Dark，持久化）。
- **布局重写**：`App.tsx` 侧栏 + 顶栏 + 内容区；`components/ui/common.tsx`（TopBar/PageBody/Card/…/EmptyState）；所有页面用令牌重写。
- **移除前端 AI 交互**：删 `AgentDrawer`，知识库/报表页改**只读查看**；`api.ts` 移除 agent 调用。生成在 Claude Code 里跑，Studio 只看结果 + 导出。
- **导出主线**：测试页「同步导出 Excel」命中 Runtime 代理，Excel 二进制触发下载；HTTP-200 JSON 错误（未配 DB/OSS）友好提示；测试记录区分 REAL_SYNC_EXPORT 与静态类型。
- **后端 agent 代码保留**：AgentBridge + job/checkpoint 对接 Innos 时直接复用（实现 `InnosAgentBridge` 即可），不删、仍注册。
- **接入文档**：新增 `docs/UI_STYLE_GUIDE.md`；`docs/INNOS_INTEGRATION.md` 增补《作为内部平台经 cloud-gateway 接入》。
- 测试：131 项全部通过；build/typecheck/lint 全绿。

### 阶段后增量（2026-07-18）

- **页面新建工作区**：`POST /api/easybi/projects/create`（一步：建目录 → 安装技能包 → 写 Lock → bootstrap init → 登记）；前端 `NewWorkspaceForm`（空状态 + 顶栏“+ 新建工作区”）。
- **技能包来源统一接缝** `apps/studio-service/src/skill-source/resolve.ts`：所有创建/bootstrap/skill-status 路径经此解析来源，切换来源类型只改一处。
- **LocalArchiveSource 真实实现**（`.tar.gz` 解压 → 复用 LocalDirectorySource 的白名单/哈希/快照 → 安装）。config 新增 `EASYBI_SKILL_SOURCE_TYPE`。云端设计结论：技能包以**压缩包（tar.gz）**分发。
- **HttpRegistrySource 真实实现**：下载不可变归档 → 复用 LocalArchiveSource；可选 Bearer Token 从环境变量读取，绝不落盘/入日志。本地假 Registry 端到端验证通过。
- **来源切换只改配置**：`EASYBI_SKILL_SOURCE_TYPE` = `local-directory` | `local-archive` | `http-registry`。三种来源共用同一后续管线，业务代码零改动。
- 未做：切换“已安装工作区”的技能包升级（用户要求暂缓）；BuiltInSource 仍为保留存根。
- 测试：126 项全部通过；build/typecheck/lint 全绿。

---

## ③ 历史阶段记录

各阶段的任务清单、完成项、改动文件与测试结果归档（倒序）。

### 阶段 9（已完成）Innos 适配准备

**任务清单**
- [x] 冻结 AgentBridge 契约（Fake/Claude/Innos 三实现同一接口）
- [x] `InnosAgentBridge` 存根 + Innos 事件映射表（docs/INNOS_INTEGRATION.md §2）
- [x] HttpRegistrySource 接口映射 + Innos Skill 分发服务契约（三只读接口）
- [x] Sidecar 启停协议（启动/就绪探测/停止/重启对账）
- [x] 本地反代路径 + 认证上下文（客户 DB/工作区不经过 cloud-gateway）
- [x] 迁移清单
- [x] Provider 选择支持 EASYBI_AGENT_PROVIDER=innos（buildApp）
- [x] 契约冻结测试（AgentBridge 三实现 + 保留 Source 三实现）

**已完成**
- `docs/INNOS_INTEGRATION.md` 冻结四类适配边界、事件映射、分发契约、Sidecar 协议、反代/认证、迁移清单。
- `InnosAgentBridge` 与 `HttpRegistrySource` 均为“同接口、未连接”存根，测试断言其符合冻结接口且报告不可用。
- 未修改 Innos 代码；未连接远程平台服务。

**改动文件**
- `docs/INNOS_INTEGRATION.md`
- `packages/agent-bridge/src/innos-bridge.ts` + `innos-bridge.test.ts` + `index.ts`
- `packages/skill-bundle-source/src/reserved.test.ts`
- `apps/studio-service/src/app.ts`（provider=innos 选择、stage=9）

**测试结果**：build+typecheck+lint 通过；`pnpm test` 120 单元/集成 + 5 集成全部通过；AgentBridge 三 Provider 同接口、Innos 报不可用；三保留 Source 同接口、未连接。退出条件核对：Innos 只需实现 Provider/进程托管/反代/导航 ✓；后续可选实现 HttpRegistrySource 三接口 ✓；Studio 页面无需重写（provider 经 buildApp 注入）✓；客户 DB/工作区不过 cloud-gateway ✓。

### 阶段 8（已完成）开发测试制品

**任务清单**
- [x] `artifact-exporter` 包：制品等级预检（development/candidate/production）
- [x] 开发测试制品构建：暂存白名单子集 → 校验清单 → tar.gz
- [x] 版本选择、缺失配置展示、重复版本保护（同版本 409）
- [x] Secret 脱敏（归档字节中不含明文）
- [x] 不含 node_modules/work/checkpoints/tests/dist-tests/日志/.DS_Store
- [x] 候选/生产仅展示预检，构建按钮禁用（后端强制拒绝非 development 构建）
- [x] 发布路由 plan/build/artifacts/download（下载防路径穿越）
- [x] Web 发布页（等级切换、预检、development-only 醒目标识、构建、下载）

**已完成**：development 可构建且 developmentOnly=true；candidate 缺“真实导出验收”、production 额外缺“生产签名与 Secret 初始化”，均不可构建。构建产出 `outputs/artifacts/easybi-development-<版本>.tar.gz` 含 `artifact.json` + `checksums.sha256`；归档不含明文 Secret。同版本二次构建抛 `VERSION_EXISTS`(409)；非 development 抛 `LEVEL_NOT_BUILDABLE`；下载拒绝含 `/` 或 `..` 的文件名。

**改动文件**
- `packages/artifact-exporter/`（`src/{index,precheck,build}.ts`，依赖 `tar`）
- `packages/contracts/src/artifact.ts` + `index.ts`
- `apps/studio-service/src/publish/routes.ts`、`app.ts`
- `apps/studio-web/src/`：`panels/PublishPanel.tsx`、`App.tsx`、`api.ts`
- `tests/artifact-build.test.ts`

**测试结果**：build+typecheck+lint 通过；`pnpm test` 110 + 5 集成（含 4 制品）全部通过；归档不含明文 Secret；409 VERSION_EXISTS；仅 development 可构建。

### 阶段 7（已完成）Runtime Supervisor 和报表测试体验

**任务清单**
- [x] `runtime-supervisor` 包：动态端口、生命周期、只启停自己启动的进程、只监听 127.0.0.1、从 Manifest 解析 runtime_cli、启动前 bootstrap:runtime
- [x] 三接口透明代理：保留原始状态/Content-Type/Content-Disposition/X-EasyBI-* 头与 Excel 二进制流（流式），JSON/HTTP-200 错误原样透传
- [x] Runtime 启停/状态路由 + 日志尾部
- [x] 动态筛选表单（从 parameters 接口生成）
- [x] 报表测试记录（SQLite）+ 类型标记（STATIC_VALIDATION/UNIT_TEST/REAL_SYNC_EXPORT/REAL_ASYNC_EXPORT）
- [x] 预览接口（读取已生成 Excel，不重复查询数据库）
- [x] 静态校验记录接口（明确标注 STATIC_VALIDATION，不冒充真实导出）
- [x] Web 测试页
- [ ] 真实同步 Excel 导出（需测试 MySQL；路径已就绪，待用户提供连接）

**已完成**：代理启动 Runtime → `GET /reports`/`/parameters` → `POST /exports` async 返回 `OSS_PROFILE_UNAVAILABLE`(HTTP200 JSON) → 停止后确认进程消失。Supervisor 用干净环境跑 bootstrap:runtime；只 SIGTERM 自己启动的 pid，`stopAll` 关闭时清理。Excel 走 `Readable.fromWeb` 流式转发不整文件入内存。`isRealExport` 仅 REAL_SYNC/ASYNC 为真。

**改动文件**：`packages/runtime-supervisor/`；`packages/contracts/src/report-test.ts` + `index.ts`；`apps/studio-service/src/`：`runtime/routes.ts`(+test)、`report-tests/store.ts`、`db/migrations.ts`(0002_report_tests)+test、`app.ts`；`apps/studio-web/src/`：`panels/TestPanel.tsx`、`App.tsx`、`api.ts`。

**测试结果**：build+typecheck+lint 通过；`pnpm test` 110 + 1 报表包管线全部通过；Runtime 启动/代理/async错误/停止无残留；静态校验 STATIC_VALIDATION 不含 REAL_SYNC_EXPORT。**同步导出真实 Excel/表头行数/预览来自生成文件**三项待真实 MySQL。

### 阶段 6（已完成）知识库和报表工作流

**任务清单**
- [x] 知识库状态读取（扫描/草稿/版本/热温冷/枚举/阻塞项，全部来自磁盘）
- [x] 报表状态读取（需求/计划/报表包/development-only）
- [x] WorkspaceSkillAdapter：从 Manifest 解析 CLI 命令与逻辑路径（页面不硬编码深层目录）
- [x] Agent 动作模板（8 个动作，含安全边界与业务确认门禁）
- [x] 文件监听（递归 + 防抖 + 忽略 node_modules/临时/Excel 中间态）+ 变更 SSE
- [x] 知识库/报表页面
- [x] 静态报表包管线（inspect→approve→generate→validate）集成测试，development-only
- [x] 真实 Claude 知识库引导：读取 SKILL 并命中 MySQL 连接输入门禁（gated 测试）

**已完成**：工作区 Skill 依赖经 `bootstrap:core` 本地优先安装；两 CLI 的 `doctor`/`validate-config` 无数据库可运行。报表包静态管线：从样例草稿知识库生成合法包，main.sql 含系统条件 + `/* EASYBI_FILTERS */` + 确定性排序，manifest `development_only=true`。真实 Claude 读 SKILL 后正确要求连接输入而非编造扫描。文件监听 SSE 仅触发前端重拉，不用文件事件推断成功。

**改动文件**：`packages/workspace-sdk/src/`：`skill-adapter.ts`、`knowledge-state.ts`、`report-state.ts`(+3 测试)；`apps/studio-service/src/`：`agent/prompts.ts`、`workspace/{state-routes,watcher,watch-routes}.ts`(+test)、`app.ts`、`jobs/routes.ts`；`apps/studio-web/src/`：`panels/{KnowledgePanel,ReportsPanel}.tsx`、`App.tsx`、`api.ts`；`tests/report-package-static.test.ts` + fixtures。

**测试结果**：build+typecheck+lint 通过；`pnpm test` 108 + 1 报表包静态管线全部通过；真实 Claude 命中连接门禁；报表包 development-only、valid。

### 阶段 5（已完成）检查点、差异、撤销和 ClaudeCodeBridge

**任务清单**
- [x] `checkpoint` 包：受管文件捕获（hash + 可恢复副本）、变更摘要、行级 unified diff、带冲突检测的回滚
- [x] 保护规则：不回滚 knowledge/versions 与 reports/packages；不删除未知用户文件
- [x] 假 Claude CLI（test-fixtures/fake-claude.mjs）验证进程协议
- [x] ClaudeCodeBridge：spawn shell:false + 数组参数、cwd=工作区、stdin 提示词、stream-json、--include-partial-messages、--dangerously-skip-permissions、--append-system-prompt 安全边界、保存 session、--resume 恢复
- [x] Claude 事件归一化为统一 AgentEvent；日志脱敏（redactSecrets）
- [x] JobManager 写任务前自动创建检查点、结束后生成变更摘要
- [x] 检查点路由：列表/详情+摘要/diff/rollback（冲突 409 ROLLBACK_CONFLICT）
- [x] 真实 Claude Code 完成一个不连数据库的文件任务（集成测试，CLI 缺失时自动跳过）

**已完成**：ClaudeCodeBridge 解析真实 stream-json（system/init、content_block_start[tool_use]/text_delta、tool_result、result）。真实集成测试：Claude 在临时工作区创建文件、捕获 session，8.2s 完成。脱敏 password/token/api_key/Bearer/sk- → `***`。撤销冲突：任务后被改文件拒绝回滚（409）不覆盖。Provider 经 `EASYBI_AGENT_PROVIDER=claude` 选真实，否则 Fake。

**改动文件**：`packages/checkpoint/`（`src/{index,diff,manager}.ts`+test）；`packages/agent-bridge/`（`src/{redact,claude-bridge}.ts`+tests、`test-fixtures/fake-claude.mjs`）；`packages/job-manager/src/manager.ts`；`apps/studio-service/src/`：`app.ts`、`checkpoints/routes.ts`+test。

**测试结果**：build+typecheck+lint 通过；`pnpm test` 99/99（含真实 Claude 集成 1 项）；假 CLI 协议 session/tool/message/completed + 脱敏 + resume；撤销冲突拒绝不覆盖。

### 阶段 4（已完成）任务系统、Fake AgentBridge 和全局 Agent 抽屉

**任务清单**
- [x] Job 状态机（QUEUED/RUNNING/WAITING_FOR_USER/SUCCEEDED/FAILED/CANCELED，合法转移校验）
- [x] SSE 事件流（job_started/phase_changed/message_delta/tool_*/waiting_for_user/job_completed/job_failed）
- [x] `agent-bridge` 包：AgentBridge 接口 + FakeAgentBridge（脚本化事件、等待确认、resume、cancel）
- [x] `job-manager` 包：事件归一化、写任务互斥、任务历史、SSE 订阅（含缓冲重放）
- [x] 全局 Agent 抽屉（App 根挂载，跨标签切换不丢任务、折叠继续后台、用户回复、取消）
- [x] 工作区写任务互斥（同工作区第二个写任务 409 WRITE_TASK_CONFLICT）
- [x] 任务持久化到 SQLite + 重启对账（进行中任务标记 FAILED，不自动重启未知进程）

**已完成**：FakeAgentBridge 输出完整脚本化事件序列含一次 WAITING_FOR_USER 门；`continue` resume、`cancel` 置 CANCELED。同工作区最多一个写任务，不同工作区可并发。实测 SSE：`job_started→…→waiting_for_user→(reply)→message_delta→job_completed`。`reconcileOnStartup` 将重启前活动任务标记 FAILED。

**改动文件**：`packages/agent-bridge/`（`src/{index,event-queue,fake-bridge}.ts`）；`packages/job-manager/`（`src/{index,normalize,manager}.ts`+test）；`apps/studio-service/src/`：`app.ts`、`jobs/{store,routes}.ts`+test；`apps/studio-web/src/`：`AgentDrawer.tsx`、`App.tsx`、`api.ts`。

**测试结果**：build+typecheck+lint 通过；`pnpm test` 83/83；实时 SSE 完整序列 + SUCCEEDED；第二写任务 409；重启对账活动任务→FAILED。

### 阶段 3（已完成）配置中心、引导流程和环境诊断

**任务清单**
- [x] `config-sdk`：revision 并发控制、原子写入、保存前备份、JSON Schema/内置结构校验、假 MySQL Adapter
- [x] 构建配置 GET/PUT、Runtime 配置 GET/PUT、validate-build、test-mysql（假 Adapter）路由
- [x] 项目流程状态从磁盘事实计算（workspace-sdk/workflow）
- [x] `/state`、`/skill-status`、`/bootstrap`、`/workflow` 路由
- [x] 环境诊断引擎（OS/Node/Claude/来源/缓存/Manifest/Lock），分级 PASS/WARNING/FAIL/NOT_CONFIGURED
- [x] `/diagnostics` 项目级与全局路由；Claude CLI 只读探测（不读 API Key）
- [x] studio-web：总览/配置/诊断三视图

**已完成**：config revision = 内容 SHA-256；保存需提交读到的 revision，冲突 409 CONFIG_CONFLICT；临时文件 + rename 原子替换，覆盖前备份到 `work/config-backups/`。MySQL 测试为假 Adapter：仅结构校验，绝不联网，绝不回显密码。工作流状态完全由磁盘事实计算。诊断实测：真实 Claude CLI PASS、正式来源只读 PASS。

**改动文件**：`packages/config-sdk/`（`src/{index,store,validate,mysql-adapter}.ts`+tests）；`packages/workspace-sdk/src/workflow.ts`+test；`apps/studio-service/src/`：`app.ts`、`main.ts`、`claude-detect.ts`、`config/routes.ts`+test、`projects/state-routes.ts`、`diagnostics/engine.ts`；`apps/studio-web/src/`：`api.ts`、`App.tsx`、`panels/{OverviewPanel,ConfigPanel,DiagnosticsPanel}.tsx`。

**测试结果**：build+typecheck 通过；`pnpm test` 73/73；stale revision PUT → 409 CONFIG_CONFLICT；`/workflow` KNOWLEDGE_MISSING（磁盘计算）；`/diagnostics` overall PASS。

### 阶段 2（已完成）Skill 最小快照与测试工作区创建

**任务清单**
- [x] SkillBundleSource 接口 + LocalDirectorySource；预留 LocalArchive/BuiltIn/HttpRegistry
- [x] 读取并校验正式来源 bundle.manifest.json（结构 + Skill 入口/CLI/依赖锁物理存在）
- [x] Skill 快照白名单（含目录兼容规范、两个 Skill 使用说明；排除 docs/tests/node_modules/密码等）
- [x] 开发阶段直接校验当前 Manifest、入口和文件哈希
- [x] 按 Bundle 版本不可变本地缓存（临时目录构建 → 原子 rename → 复用缓存）
- [x] 生成产品 Manifest + 每文件 SHA-256 + 聚合 bundleSha256
- [x] 外置测试工作区创建（source→cache→独立安装）
- [x] 幂等 Bootstrapper（init/check，自动选择）
- [x] 生成并校验 bundle.lock.json（无 Secret）
- [x] 自动补齐缺失目录/空索引/模板/可选默认值，不覆盖已有配置与业务产物
- [x] 旧工作区缺 Manifest 时兼容补齐；工作区 CLAUDE.md 生成
- [x] scripts：sync-easybi-bundle.mjs、create-test-workspace.mjs

**已完成**：新增三包 `skill-bundle-source`/`skill-bundle-manager`/`workspace-bootstrapper`。`sync-easybi-bundle.mjs` 生成 `vendor/easybi-bundle`，二次运行 cacheReused=true。`create-test-workspace.mjs` 创建 transport-test，再次运行为 check/alreadyReady=true。工作区不含 node_modules/tests/docs；Lock 无 Secret。正式 easy-bi 只读未变。

**测试结果**：build 7 项目通过；`pnpm test` 55/55；快照白名单正确无禁止内容含哈希；缓存复用；多版本缓存不可变；工作区 init 后 check 幂等 preserved 用户文件。

**复现**
```bash
cd /Users/admin/innos/easy-bi-workspace/easybi-studio
pnpm build
node scripts/sync-easybi-bundle.mjs
node scripts/create-test-workspace.mjs \
  --id transport-test --name "运输测试" \
  --root /Users/admin/innos/easy-bi-workspace/easybi-studio-workspaces \
  --bundle-source local-directory --bundle-path /Users/admin/innos/easy-bi-workspace/easy-bi
```

### 阶段 1（已完成）Contracts、SQLite 和项目登记

**任务清单**
- [x] 统一成功/错误封装与稳定错误码
- [x] 核心契约：Project、Job、AgentEvent/AgentBridge、Diagnostic、Checkpoint、SkillBundleSource、BundleManifest、BundleLock、BootstrapResult
- [x] Studio SQLite 迁移（幂等、可重复执行）
- [x] 项目登记 / 列表 / 详情 / 移除登记（移除登记不删磁盘）
- [x] 外置路径规范化与白名单（防穿越）
- [x] 工作区结构只读校验（不创建/修改文件）
- [x] 项目总览空状态页面

**已完成**：新增 `@easybi-studio/workspace-sdk`（路径安全 + 只读结构校验）。`contracts` 拆为 envelope/project/job/agent/diagnostic/checkpoint/skill-bundle/bootstrap 八模块。SQLite 用 `better-sqlite3`，迁移表 `schema_migrations`，二次运行 no-op。`ProjectService` 登记前强制白名单 + 只读校验；移除登记仅删登记行保留目录。

**改动文件**：`packages/contracts/src/`（八契约模块 + index.test.ts）；`packages/workspace-sdk/`（`src/{index,paths,structure}.ts`+tests）；`apps/studio-service/src/`：`config.ts`、`app.ts`、`main.ts`、`db/{database,migrations}.ts`+test、`projects/{service,routes}.ts`+test、`app.test.ts`；`apps/studio-web/src/App.tsx`。

**测试结果**：typecheck 4 项目通过；build 通过；`pnpm test` 36/36（contracts 8、workspace-sdk 17、studio-web 1、studio-service 10）；POST /projects 201 统一封装；路径穿越 400 PATH_NOT_ALLOWED；迁移幂等。已知问题、阻塞项：均无。

### 阶段 0（已完成）工程初始化与执行基线

见 [docs/decisions/0001-stage0-baseline.md](./decisions/0001-stage0-baseline.md)：pnpm workspace Monorepo、ESM、TS strict + `noUncheckedIndexedAccess`、Fastify 5（8932）、React 18 + Vite 6（8931，`/api` 代理）、统一信封放 `contracts`、Vitest + ESLint 9 + Prettier。阶段 0 不实现业务能力，仅建骨架。

### 复现方式（基线）

```bash
cd /Users/admin/innos/easy-bi-workspace/easybi-studio
corepack enable pnpm && pnpm install
pnpm build && pnpm typecheck && pnpm test && pnpm lint
# 启动：pnpm dev（service:8932，web:8931）
# 覆盖工作区根：EASYBI_STUDIO_WORKSPACES_ROOT=... node apps/studio-service/dist/main.js
```
