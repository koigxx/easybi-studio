# 决策 0002（提案）：脚本驱动的报表包（多库 / 多查询 / 同比环比 sheet）

- 日期：2026-07-20
- 状态：**已接受，阶段 B 最小版本已实现（2026-07-22）** — v2 与 v3 并存；多 Sheet/同比环比仍留待阶段 C。

## 背景与真实需求

现有报表包是**声明式单查询管线**：一个 `queries/main.sql`（一条 SQL）→ Runtime 执行 → 行流经 `transforms/index.mjs` 逐行/逐组变换 → 流式写 Excel。能覆盖同库多表 JOIN、一对多拼接、单结果集上的行/组计算。

真实报表（示例：**毛利明细表**）超出它的能力：

- **跨库**：订单库（HD 订单/客户/地址…）+ 计费库（各类应收/应付/成本费用），字段跨两个 database。
- **费用透视**：应收/提货应付/出库应付/承运商应付/内部成本各含"基本运费、送货费、赔付费…"——计费库大概率按"费用类型 × 归属方"行存，报表要**按归属方 pivot 成列**，非 JOIN 能干净表达。
- **计算列**：毛利 = 应收 − 提货应付 − 出库应付 − 承运商应付 − 内部成本。
- **数据范围**：仅统计签收复核后的；T+1。
- **同比环比**：需在同一份报表里**额外导出对比 sheet**。

### 用户确认的边界（据此简化设计）

1. **拓扑**：现在**同一服务器、同一账号、多 database**；将来可能多机。→ 先满足单连接多库，**结构保持可扩展**（dbKey→profile 路由），不为多机过度设计。
2. **同比环比 = 正常报表逻辑 + 多加 sheet，只是时间范围不同**。不是复杂的逐行对齐算差值，而是"同一套汇总逻辑，跑不同月份区间，各出一个 sheet"。
3. **对比筛选按月**（如 4–8 月），粒度**按月 × 业务维度汇总**；环比=相邻期、同比=去年同期。
4. **是否要对比 sheet 可在报表配置里开关**——不是每张报表都要。
5. 现有测试报表包可删，升级后重新生成；**一次只生成一个报表包**；遇到复杂报表**多向用户询问**。

## 决策（提案）

引入 **`report_package_format_version = 3`：脚本驱动报表包**，与 v2 单 SQL 包**并存**（v2 不废弃、不迁移；Runtime 按版本分派执行器）。

### A. 执行模型：脚本 + 受控查询接口

报表包新增入口 `report.ts`（编译 `report.mjs`），导出 `run(ctx)`：

```ts
export async function run(ctx: ReportContext): Promise<void> {
  const orders = ctx.query('otms',    'SELECT ... WHERE create_time BETWEEN ? AND ? AND audit_state = ?', [ctx.range.from, ctx.range.to, 'CONFIRMED']);
  const fees   = ctx.loadIndex('billing', 'SELECT order_no, party, fee_type, amount FROM ... WHERE ...', [...], ['order_no']);
  for await (const o of orders) {
    const f = fees.get(o.order_no) ?? [];
    ctx.emit({ ...o, ...pivotFees(f), gross: recv - payA - payB - payC - internal });
  }
}
```

- **`ctx.query(dbKey, sql, params)`** — 受控只读查询，返回**游标（异步可迭代）**。`dbKey` 是逻辑库标识，Runtime 按 dbKey→profile/连接路由；当前同连接多 database（`库.表` 或切库），**将来多机只改配置、脚本不变**。强制只读事务 + 超时 + 参数化，SQL 过安全护栏（禁 DDL/DML/多语句/引号）。
- **`ctx.loadIndex(dbKey, sql, params, keyFields)`** — 把**小维表/费用表**物化成 `Map`（按 key 分组），**有行数上限**（超限抛 `INDEX_LIMIT_EXCEEDED`，不静默）。费用透视、维表 join-in-code 走它。
- **`ctx.emit(row)`** — 产出一行，流式写 Excel（复用现有 workbook 流式 + 大小上限）。
- **`ctx.range` / `ctx.filters` / `ctx.context`** — 已校验筛选（含按月范围、必填、租户等）。
- **`ctx.enum(dict, code)`** — 只读中文映射等工具。

**内存策略（十万~百万行）**：主数据集流式（`ctx.query` 游标 + `ctx.emit`，不进内存）；维表/费用表用 `ctx.loadIndex`（基数小、带上限）。禁止把主表规模数据整体 loadIndex。

**安全沙箱（重点风险）**：脚本只能经 `ctx` 访问；禁 `import`/`require`/`eval`/`Function`/`fs`/`net`/`process`。生成期静态校验 + 运行期受限加载双保险。dbKey 只能是知识库锁定的已登记 profile。密钥永不进脚本/日志/包/前端。

### B. 同比环比 = 多 sheet + 多时间区间（本次的简化核心）

不做逐行对齐差值。做法：报表配置声明是否开启对比 + 对比类型；Runtime 用**同一套汇总逻辑**跑不同月份区间，各写一个语义 sheet。

- **语义 sheet**（区别于现有"行数溢出拆分"）：如「本期明细」「按月汇总-本期」「环比(上月)」「同比(去年同期)」。Runtime 支持一个报表输出**多个命名 sheet**（每个仍可因行数溢出内部再拆）。
- **对比数据来源**：脚本可导出一个 `summarize(ctx, range)`（按月 × 业务维度汇总），Runtime 按配置的区间多次调用：本期 / 上一相邻期 / 去年同期，各出一个 sheet。**同一逻辑、不同 range** —— 正是你说的"正常报表逻辑，只是时间范围不同"。
- **对比粒度**：按月 × 业务维度（所属公司/客户/业务员等，报表配置里指定维度）。
- **筛选**：对比区间按月（`YYYY-MM` 起止）。主明细 sheet 用用户选的范围；对比 sheet 由 Runtime 依据主范围推导相邻期/去年同期。

### C. 报表配置扩展（可开关）

在报表需求/计划里增可选块（兼容扩展，缺省不启用）：

```json
"comparison": {
  "enabled": true,
  "period": "month",
  "modes": ["chain", "yoy"],          // 环比 / 同比
  "dimensions": ["company", "salesman"],
  "metrics": ["gross", "receivable", "..."]
}
```

无该块的报表行为不变（只出明细 sheet）。

## 分期落地

- **阶段 A（前置，低风险，先做）** — **实测已基本具备，无需改代码**：
  1. 知识库**多 database 扫描并发布**：配置侧 `database_profiles[].settings.databases` 已是数组，Studio ConnectionsEditor 支持"添加多个 database"，扫描侧 `dialect.tables/columns/indexes/foreignKeys` 用 `WHERE TABLE_SCHEMA IN (…)` 全量扫，`discover` 遍历所有库。→ **只需用户在配置里列出多个库并重扫**。
  2. **同一连接跨 database 的 JOIN 已支持**：报表校验器只禁"跨 *profile*"（`profiles.size>1`），不禁跨 database；生成的 SQL 每张表都用自身 `库.表` 限定（`FROM \`transport\`.\`driver\`` JOIN `\`settlement\`.\`driver_fee\``）；Runtime 连主表所在库为默认 schema，同连接可引用兄弟库。已加测试锁定（`cross-database JOIN within one profile…`）。
  - 结论：**能靠 JOIN 表达的单连接多库报表现在就能做**。阶段 A 实际只剩：①补 SKILL/文档说明跨库用法；②用户配置多库并重扫初始化知识库。为 B 打好"多库知识 + 跨库引用"地基。
- **阶段 B（核心）**：✅ 已完成最小版本。v3 包包含批准后的语义计划/执行计划、逐查询 SQL 与知识锁；提供 `queryStream/loadIndex/batchLookup/emit`；父 Runtime 持有只读数据库连接，脚本由 Node Permission Model 子进程隔离执行；包预算与 Runtime ceiling 共同限制查询、行数、索引、批次、输出、内存和超时；支持 HTTP 断连、同步 requestId 和异步 runtimeTaskId 取消。跨 profile 路由沿查询自身 `profile_id` 解析。页面编辑器支持 `queries/*.sql` 与 `scripts/report.ts`，保存后自动生成 `report.mjs`。
- **阶段 C（对比 sheet）**：`comparison` 配置 + 多语义 sheet 输出 + 按月区间推导（相邻期/去年同期）+ `summarize` 范式。
- **阶段 D（多机，按需）**：dbKey→不同 profile/连接，脚本与 `ctx` 不变。仅当出现多机时做。

## 权衡与代价

- 包格式 v3 + Runtime 双执行器：复杂度上升，须保证 v2 不回归。
- 内存：脚本模型比纯流式吃内存；靠"主流式 + 小索引 + 上限"控制；两个都是大表的 code-join 仍需下推或分批。
- 安全：执行任意脚本使攻击面变大，沙箱设计是成败关键，需专门评审。
- 工作量：A 中等；B 中大型；C 中等；D 小（按需）。

## 待用户确认的问题（开工前）

1. **费用表结构**：应收/各方应付/内部成本的各项费用，是"一张费用表按费用类型+归属方行存"，还是分散在多张表/多列？（决定 pivot 逻辑与 `loadIndex` 用法）
2. **业务维度字段**：对比 sheet 的"业务维度"具体是哪几个（所属公司 / 客户 / 主业务员 …）？对比的指标是哪些（毛利、应收、各方应付合计…）？
3. **T+1 数据时效**：是查昨日快照库/离线表，还是实时库按时间截止？（影响 `ctx.query` 连的库与范围条件）
4. **"签收复核后"** 如何判定（哪个库哪个字段/状态值）？
5. 阶段 A 先落地时，你能否提供订单库、计费库的连接信息（同账号可访问的多个 database 名），以便扫描入知识库？

## 备注

本提案回应用户毛利明细表等真实需求。确认边界后先做**阶段 A（多库知识 + 跨库引用）**，再按 B→C 推进脚本模型与对比 sheet。多机（D）按需再做。
