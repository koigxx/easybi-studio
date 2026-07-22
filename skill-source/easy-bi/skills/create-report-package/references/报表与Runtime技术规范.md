# 报表与 Runtime Skill 技术规范

## 1. 适用范围

本规范是 `create-report-package` 的唯一详细参考，覆盖 v2 报表计划、报表包、筛选、SQL、Transform、Runtime 同步/异步分支和容量策略。执行顺序以同目录 `SKILL.md` 为准。

## 2. v2 报表计划

计划格式固定为：

```json
{
  "plan_format_version": "2"
}
```

计划至少包含：

- 报表 ID、名称和业务版本；
- 知识库版本、状态、hash 和来源；
- 主表、别名和 `joins[]`；
- 输出字段与来源种类；
- 可见参数、隐藏系统条件和上下文绑定；
- 聚合、排序和 Transform；
- 阻断项、告警和审批；
- 执行策略。

字段来源：

| kind | 用途 |
|---|---|
| `column` | 物理列 |
| `sql_expression` | 参数无关的安全 SQL 表达式或聚合 |
| `computed` | 可信 TypeScript 逐行或分组计算 |
| `boolean_flag` | 数值/状态列折叠为是/否（`CASE WHEN col op n THEN 1 ELSE 0 END`，见 §9.3） |
| `enrichment` | 批量二次查询 + 内存合并（见 §8.1） |

所有来源必须显式写 `kind` 和表别名。多表必须声明唯一别名、`LEFT/INNER`、等值 ON 键和结果粒度。

从表逻辑删除条件进入 JOIN `ON`，避免把 LEFT JOIN 变成 INNER JOIN。主表逻辑删除进入 WHERE。

## 3. 报表包结构

报表包格式固定为：

```json
{
  "report_package_format_version": "2"
}
```

目录：

```text
reports/packages/<report-id>/<version>/
├── report.manifest.json
├── fields.json
├── parameters.schema.json
├── queries/
│   ├── main.sql
│   └── bindings.json
├── transforms/
│   ├── index.ts
│   └── index.mjs
├── tests/cases.json
├── knowledge.lock.json
└── checksums.sha256
```

Manifest 保存身份、状态、执行策略、入口、上下文绑定、Transform mode 和签名状态。

`fields.json` 使用 schema v2，定义输出顺序、类型、Excel 设置、来源和可选枚举引用。

`parameters.schema.json` 是前端动态筛选的唯一来源。

`knowledge.lock.json` 使用 lock v2，锁定所有来源表、字段、JOIN 键、计算依赖、Schema fingerprint 和知识版本。

`checksums.sha256` 覆盖除自身和发布签名外的全部包文件。

## 4. 字段解析

字段按以下顺序解析：

1. 完整物理标识；
2. `table.field`；
3. 同表物理字段名；
4. 唯一 `semantic.name`；
5. 唯一 `semantic.label`。

唯一中文语义可以自动解析。多义返回 `FIELD_AMBIGUOUS` 并列出候选 `table.field`；没有命中返回 `FIELD_NOT_FOUND` 和相似候选。

只读取热表和温表字段。冷表无字段详情，不能用于生成。

### 4.1 字段描述（业务口径）

`required_fields` 的对象形式可携带可选 `description` 字段，用于说明该字段的业务口径，便于 AI 在生成报表包时理解字段含义（例如 `{ "field": "...", "label": "订单数总和", "description": "订单数量的总和" }`）。`inspect` 会把它原样带到 `plan.fields[].description`，并写入 `fields.json` 的字段项（为空时省略，保持既有包字节一致）。它仅作文档，**不参与 SQL**。在 Studio 的报表编辑器与导入 JSON 中均可配置。

## 5. 默认排序

默认：

1. 创建时间倒序；
2. ID 倒序作为稳定 tie-breaker；
3. 无创建时间时只按 ID 倒序。

用户明确要求时可以覆盖。聚合报表的排序字段必须在输出、分组或安全聚合表达式中有效。

## 6. 筛选 Schema

参数类型：

| valueType | 默认组件 | 常见操作符 |
|---|---|---|
| `string` | text | `eq`、`contains`、`in` |
| `enum` | select/multi-select | `eq`、`in` |
| `date/datetime` | date-range | `between`、`gte`、`lte` |
| `number` | number/range | `eq`、`between`、`gte`、`lte` |
| `boolean` | switch/select | `eq` |

约定：

- code/no/业务编号默认精确；
- 普通名称和描述默认模糊；
- 时间默认范围；
- 数字支持等于和范围；
- 枚举使用知识库中文映射；
- tenantId 等上下文不出现在可见参数列表。

参数值同时支持直接值和：

```json
{"operator": "eq", "value": "A001"}
```

范围支持：

```json
{"from": "2026-01-01", "to": "2026-01-31"}
```

或二元素数组。

## 7. SQL 与绑定

SQL 只能来自计划和报表包声明，不能拼接请求值。

Bindings 使用 format v2，每个参数显式声明：

- 安全表达式；
- `clause=where|having|exists_subquery|post_transform`（`post_transform` 为运行时内存后置筛选，无 SQL 表达式/子句）；
- 允许操作符；
- 默认操作符；
- 值类型；
- 可选默认值。

Bindings 还可含可选 `enrichments[]`（批量二次查询块，见 §8.1）；老包无此键时
Runtime 走原路径。

SQL 固定插入标记：

```sql
/* EASYBI_FILTERS */
/* EASYBI_HAVING_FILTERS */
```

没有 HAVING 参数时可以没有 HAVING 标记；存在时必须提供。enrichment 的
`sql_template` 使用独立标记 `/* KEYS */`（批内键的唯一动态部分）。

运行时：

- 控制语句使用 MySQL `query()`；
- 业务 SELECT 使用参数化执行和流式结果；
- 表名、别名、表达式和操作符必须来自已校验报表包；
- 请求只提供绑定值。

## 8. JOIN

JOIN 校验：

- 别名唯一且存在；
- ON 左右字段存在并被知识锁覆盖；
- 只允许 `LEFT` 和 `INNER`；
- 不接受请求提供 JOIN；
- 从表逻辑删除固定条件放 ON；
- 计划必须记录结果粒度；
- 未解决 JOIN 产生 `JOIN_REQUIRED`；
- 完整配置后记录 `JOIN_RESOLVED`，不再阻断。

### 8.1 Enrichment：批量二次查询 + 内存合并（替代撑行的一对多 JOIN）

多表报表里，只要有 **一张一对多** 表（如一单多货品），它就会逼出
`GROUP_CONCAT + GROUP BY + MAX()`，把整条查询拖进聚合。定位：**n:1 维度表继续
JOIN**（不撑行、走索引），只把这张一对多表改为 enrichment——Runtime 流式读主
查询，按批收集 join 键，对 lookup 表发一次 `WHERE key IN (…)` 查询，在内存按键合并
回来。不 JOIN、不撑行、`group_concat` 不受 `group_concat_max_len` 截断。

`plan.enrichments[]` / `manifest.enrichments[]` / `bindings.enrichments[]` 契约：

- `lookup`：`{profile_id, database, table, alias, table_id, schema_fingerprint}`，
  从知识库解析（必须是已扫描表，且与主表 **同 profile**），锁进 `knowledge.lock`，
  **不进** SQL `FROM`/`JOIN`；lock 中标 `kind:"enrichment"`，`validate` 免其 JOIN 检查。
- `on`：`{source:"main"|"enrichment", source_id, main_field, lookup_field}`。
  `main_field` 必须是主查询实际 SELECT 的列 id；`source:"enrichment"` 表示链式
  （键取自上游 enrichment 输出），Runtime 按依赖 **拓扑排序** 执行。
- `cardinality`：`one`（多对一，取标量；一键命中多行 → 取第一条 + warning）或
  `many`（一对多，按 `aggregate` 折叠：`group_concat|count|sum|max|min|first`）。
- `select[]`：每项生成一个 `source.kind="enrichment"` 字段（不进 SQL SELECT，由
  Runtime 合并后挂到输出行）。`on_missing`：`null|empty|zero`（count 缺省为 0）。
- `bindings.enrichments[].sql_template`：生成期从知识构建、过安全护栏，含且仅含一个
  `/* KEYS */` 标记；Runtime 仅把批内键展开成 `?, ?, …` 参数化绑定，**绝不拼接用户输入**。

**筛选**：enrichment 字段不在主 SQL，**禁止内存筛**（只筛已取批次会漏行）。带 `filter`
角色时 `configure-plan` 下推为对 lookup 表的相关 **EXISTS** 半连接（与 GROUP_CONCAT
筛选同机制）——输出走内存合并、筛选走 SQL。键无法关联回主查询（链式且键表不在主 SQL）
时，配置期 **拒绝** 该筛选（须保留该表为 JOIN）。

**分批**：预览按 `preview_max_rows` 一批；导出按 `enrichment_batch_size`（默认 1000）
多批，边流边合。`many` 折叠不改变主行数，故预览 `LIMIT`、`truncated`、Sheet/行上限均不受影响。

**不支持（校验期报错，不静默降级）**：分组(group)报表 + enrichment、跨 profile、依赖成环。

## 9. 聚合与计算

可以用 SQL 表达的计算优先放 SQL：

- `SUM/COUNT/AVG/MIN/MAX`；
- 条件聚合；
- `GROUP BY`；
- 参数化 `HAVING`。

`sql_expression` 不能包含子查询、语句分隔符、注释、DML/DDL 和字符串拼接请求。

逐行计算：

```text
custom_logic.mode=row
transformRow(row) → row
```

按组计算：

```text
custom_logic.mode=group
transformGroup(rows, context) → row | rows
```

Group 查询必须按 `group_keys` 排序。Runtime 只缓冲当前连续组并限制 `max_group_rows`。Identity 和 SQL-only 报表不加载 Transform 模块。

Transform 是报表包内受信任代码，只能依赖行数据和声明的字段，不能访问网络、文件系统、凭据或任意数据库。

### 9.1 计算/派生字段：数值支持后置筛选，其余不可筛选

`source.kind=computed` 的字段由 Transform 产出，不是可查询的列或 SQL 表达式，**不能**作为 `WHERE`/`HAVING`（数据库层）筛选项。但**数值**计算字段（`output_type=number`，如 件数总和 / 环比变化量）可在 Transform 产出后于内存中做范围筛选：

- 当数值计算字段带 `filter` 角色时，`configure-plan` 为其生成 `clause=post_transform` 参数（`value_type=number_range`、`component=number-range`、`operators=[between,gte,lte]`）。运行时（同步导出与测试页预览）对 Transform 输出行按范围（≥下限 / ≤上限 / between）在内存过滤。`post_transform` 参数不进 SQL，其 `expression` 为计算字段 id。
- **非数值**计算字段仍不可筛选：`configure-plan` 删除其 `parameters` 项并产出 `FILTER_DROPPED_COMPUTED` 警告（列出受影响字段）。技能应把该警告呈现给用户确认后再继续。
- `validate` 兜底：`computed` 字段若挂着 clause 非 `post_transform` 的同 id 参数即报错；`post_transform` 参数必须为数值计算字段上的 `number_range`。

**小数列累加必须用整数累加（禁止浮点漂移）**：`computed`（row/group）表达式对 `DECIMAL`/`NUMERIC` 列做求和/累加时，必须以**放大后的整数**累加，不能直接相加 JS 浮点数——浮点相加会漂移（`12.34 + 8.2755 + 30 → 50.615500000000004`），污染输出小数位。规则：按列的 `DECIMAL(p,s)` 小数位 `s` 取 `SCALE`（如 `DECIMAL(16,4)` → `10000`；多列取最大）；累加 `Math.round(Number(v) * SCALE)` 到整数桶；**末尾一次性除回** `intBucket / SCALE`（差值型如环比/同比则对最终相减结果除：`(curInt - prevInt) / SCALE`）。计数（`COUNT`/`+= 1`）本身是整数，不缩放、不除。

### 9.2 环比 / 同比（comparison）

对比指标 = **同一套分组汇总逻辑，跑更宽的时间窗口**：环比 `chain` = 上一个月，同比 `yoy` = 去年同月。计算写在 **group transform** 里（按月分桶），技能负责让 transform 一次拿到这些回看月份的数据。

Manifest/plan 可选 `comparison` 块（配置时 `period_param` 可省略）：

```json
{
  "enabled": true,
  "modes": ["chain", "yoy"],
  "lookback_months": 1              // chain 回看月数；yoy 固定回看 12 个月
}
```

**period_param 自动默认（关键）**：启用环比/同比但未指定 `period_param`（或所指列尚不是筛选项）时，`configure-plan` 自动在主表创建时间列（`create_time`/`gmt_create`/创建时间…）上**合成一个必填的按月区间筛选**并将 `period_param` 指向它，产出 `PERIOD_FILTER_ADDED` 警告（技能应转告用户）。这就是"默认的创建时间筛选，遇到同比环比时按月份查"的行为——**无需**让用户把创建时间加进 `required_fields`。主表无创建时间列、或有多个候选时，CLI 报错并要求显式指定 `comparison.period_param`（此时才询问用户）。

**新增派生列**：环比/同比输出列是全新的 `computed`（`mode: group`）字段，直接在 `configure-plan` 的 `fields` 里声明即可——即使 id 不在 `required_fields` 中，`configure-plan` 会**追加**新的 `computed`/`sql_expression` 字段（全新的 `column` 字段会被拒绝，必须走 `required_fields`）。

约束（`validate` 校验）：`period_param` 必须解析到**必填**的 `date_range`/`datetime_range` 参数；`custom_logic.mode` 必须为 `group`。对比 `period_param` 是分组内按月分桶用的筛选，**不要求**作为输出列（generate 校验对其豁免"每个筛选须对应输出列"规则）。

运行时窗口加宽（用户无需额外操作）：用户只选报告区间（如 4–8 月），Runtime **自动把该筛选的下界向前扩**——`chain` 扩 `lookback_months` 个月、`yoy` 扩 12 个月，取**最早**的下界；上界不变。因此边界月（如 4 月）也能拿到上月 / 去年同月的数据，一次查询即覆盖本期与全部回看期。依赖列（月份列 + 指标列）以 `raw_*` 别名进入结果；`transformGroup` 按 `String(row.raw_ct).slice(0,7)` 归月，算出本期值与环比/同比差值，每组输出一行。

环比/同比是**同一张表上的额外输出列**；作为独立对比 *sheet* 输出是更大的、暂缓的设计（见决策 0002）。

### 9.3 布尔标记字段（boolean_flag）：数值/状态列折叠为是/否

业务语义是**是/否**、但底层是数值或状态码的字段（如「签单是否上传」由回单数量 `receipt_count` 支撑，>0 即已上传）。**不要**把原始数量暴露成 number-range 筛选，用 `source.kind=boolean_flag` 让筛选与展示都是是/否。

在 `configure-plan` 里以字段 override 声明（该字段须已在计划血缘中解析为列，以锁定别名/表）：`source = {kind:"boolean_flag", operator, threshold, labels?}`。

- `operator ∈ {gt,gte,lt,lte,eq,ne}`（固定集合，**非**自由文本）；`threshold` 为数值；`labels` 可选（默认 是/否）。
- **SELECT**：生成 `CASE WHEN col <op> <n> THEN 1 ELSE 0 END`；1/0 经自动注入的 `{1:"是",0:"否"}` 枚举映射渲染为是/否（预览 + Excel）。
- **筛选**：`value_type=boolean`、`component=switch`，测试页显示 不筛选／是／否。Runtime **结构化**构建谓词——是 → `(col <op> <n>)`，否 → `NOT (col <op> <n>)`——**不绑定任何值**、无自由比较串，故天然防注入且跨方言（无 true/false 字面量差异）。筛选**下推 SQL WHERE**（对全表正确，不是只筛已取批次）。
- `validate` 兜底：列必须存在且被 JOIN、`output_type` 必须为 `boolean`、`operator` 必须在允许集合内、`threshold` 必须有限。

## 10. Runtime 报表发现

`reports/index.json` 注册报表 ID、版本和包路径。Runtime 加载时必须：

1. 找到指定或最新版本；
2. 检查 `report_package_format_version=2`；
3. 读取 Manifest 声明的入口；
4. 校验必要格式；
5. 拒绝格式 v1、缺失格式和未知格式。

列表接口也必须校验包格式，旧包不能被展示为可用报表。

## 11. 同步分支

请求：

```json
{
  "reportId": "driver-basic-detail",
  "reportVersion": "1.0.0",
  "executionMode": "sync",
  "filters": {},
  "context": {
    "tenantId": 1001
  }
}
```

流程：

1. 加载 v2 包；
2. 校验参数和上下文；
3. 编译参数化 WHERE/HAVING；
4. 开启只读事务；
5. 流式读取并应用 Transform；
6. 写临时 xlsx；
7. 验证 Sheet、表头、行数和文件大小；
8. 原子写入输出或返回文件；
9. 清理临时文件。

同步不要求 OSS 和业务任务接口。

### 11.1 同步 JSON 查询（预览）

除导出 Excel 外，Runtime 还提供同步 **JSON 查询** 接口，返回中文表头与数据行，供 Studio 测试页预览。

- **接口**：`POST /api/v1/queries`，请求体同同步导出（`reportId`/`reportVersion`/`filters`/`context`/`tenantId`），可选 `limit`（行上限，受策略 `preview_max_rows`（默认 1000）约束）。始终同步、无异步分支。
- **复用同一执行核心**：与 `exportSync` 共享查询编译、筛选、comparison 窗口加宽、Transform（identity/row/group）与枚举 code→中文映射；差别仅在于把结果收集进内存而非写 xlsx。
- **返回**（包在标准成功信封里）：
  ```json
  {
    "columns": [{ "id": "qty", "label": "订单数总和", "description": "订单数量的总和" }],
    "rows": [{ "qty": 123 }],
    "rowCount": 1,
    "truncated": false,
    "limit": 1000
  }
  ```
  `columns` 是报表输出列的中文表头（含可选字段描述）；`rows` 每行按字段 `id` 映射到（已做枚举翻译的）值。达到行上限时停止收集并置 `truncated=true`。
- **无分页**：一次返回至多 `limit` 行，调用方滚动查看。预览不计入 REAL_SYNC_EXPORT（不生成 Excel 文件）。

## 12. 异步分支

异步必须配置阿里云 OSS 和业务任务接口，不得自动降级同步。

流程：

1. 校验配置和队列容量；
2. 调业务系统创建任务并获得 taskId；
3. 写入 SQLite 队列；
4. Worker 复用同步生成核心；
5. 上传 OSS；
6. 更新业务任务为成功并带文件 URL/元数据；
7. 失败时更新失败状态和简要原因；
8. 重启时将运行中任务恢复为可重试状态。

缺少配置使用：

```text
OSS_PROFILE_UNAVAILABLE
BUSINESS_TASK_PROFILE_UNAVAILABLE
```

## 13. HTTP 200 错误模型

接口固定：

```text
GET  /api/v1/reports
GET  /api/v1/reports/{reportId}/parameters
POST /api/v1/exports
POST /api/v1/queries
```

JSON 错误：

```json
{
  "success": false,
  "requestId": "uuid",
  "error": {
    "code": "INVALID_FILTER",
    "message": "筛选条件无效",
    "retryable": false,
    "details": []
  }
}
```

成功同步导出返回 xlsx 二进制；其他结果返回 JSON。调用方必须检查 `Content-Type`。

## 14. 容量策略

默认上限：

- 每个 Sheet 最多 1,048,575 条数据行；
- 每个工作簿最多两个 Sheet；
- 查询超时 600 秒；
- 总超时 900 秒；
- 查询和 Excel 必须流式；
- Group Transform 只缓冲一个组；
- 异步队列限制由 Runtime 配置控制。

超过第三个 Sheet、文件大小、组大小或时间限制时明确失败，不返回不完整文件。

## 15. 验证

静态验证至少覆盖：

- 必需文件和格式版本；
- 计划批准；
- 字段、别名、JOIN 和知识锁；
- 参数与 WHERE/HAVING 标记；
- SQL 安全；
- Transform mode 和入口；
- 校验和；
- 执行策略。

真实同步测试必须验证：

- 数据库实际连接；
- 筛选生效；
- Excel 可打开；
- 表头和字段顺序正确；
- 枚举中文映射正确；
- 行数和 Sheet 数；
- 输出文件确实存在。

静态生成或断开数据库的尝试不能声明为真实导出成功。

## 16. v2-only

格式 v1 计划和报表包不读取、不迁移、不执行。工作区所有者明确删除旧索引、计划和包，再基于现有知识库与报表需求重新生成 v2。

不要删除或改名 `/api/v1/*`：它是 Runtime HTTP API 版本。

## 17. 跨工作区维护

Runtime 和 CLI 从 Bundle Manifest 与工作区根目录解析路径。具体报表包不包含工作区绝对路径。切换工作区后，只发现该工作区 `reports/index.json` 注册的 v2 包。
