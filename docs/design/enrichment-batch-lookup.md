# 设计评审：批量二次查询 + 内存合并（enrichment / batch lookup）

> 状态：**待评审**（2026-07-21，v2 — 按真实 4 表报表反馈重写）。评审通过后再分期实现。

## 目标（修正后的定位）

enrichment 不是"消灭所有 JOIN、把报表压成单表查询"。它是一把**精准的手术刀**：

> **只把"会撑行、逼出 `GROUP_CONCAT` / 全表 `MAX()` / `GROUP BY`"的那张一对多表**从主查询里摘出去，改成批量二次查询 + 内存合并；**其余 n:1 维度表继续留在 SQL JOIN 里**（多对一不撑行、走索引、一次查询无往返，本来就快）。

这来自真实基数反馈：本系统里 订单:主运单=1:1、主运单:运单=1:n。从运单/回单层看出去，订单、主运单都是 **n:1**，JOIN 它们完全合理；真正的性能刺是一对多的 SKU 表（`oms_waybill_sku` 的 `GROUP_CONCAT`）——一个一对多 join 会把整条查询拖进聚合模式，逼得其余所有列套 `MAX()`。见 §2 的 before/after 实例。

## 0. 已确认的设计决策

| 决策 | 选择 | 影响 |
|------|------|------|
| 定位 | **混合模型**：n:1 维度表继续 JOIN，只摘一对多撑行表 | 不过度拆分；2-3 张 JOIN 是正常且更优的 |
| 合并时机 | **仅输出阶段合并** | lookup 列是展示/拼接列，不参与 group by / 环比 / computed；实现最干净 |
| 分批策略 | **按预览/导出上限分批** | 不破坏现有流式模型；预览一次 IN(≤1000) 足够，导出按固定批大小边流边合 |
| **一对多聚合** | **`cardinality=many` 并入一期**（不再留二期） | 这才是核心价值——要解决的正是 `GROUP_CONCAT` 那张表；`one` 反而是次要场景 |
| **enrichment 字段的筛选** | **默认下推 SQL（EXISTS 半连接），不在内存筛** | 正确性红线：内存筛只对已捞批次生效会漏行。见 §5 |
| 链式 enrichment | 支持（某 enrichment 的键来自另一 enrichment 的输出列） | 真实存在：`shipping_order` 的键 `sho_code` 来自 `oms_waybill`。见 §3.4 |
| 落地范围 | **先出本设计文档评审** | 改动大，先对齐再实现 |

---

## 1. 现状与约束（带行号，均已核实）

**runtime 查询管线**（`create-report-package/scripts/runtime-core.ts`）：
- `prepareSyncQuery`（L1058-1123）返回 `{report, policy, source, profile, dialect, compiled, transform, postFilter}`。
- `querySync`（L1241-1307）/ `exportSync`（L1309-1377）：`createQueryAdapter`（L894）→ `beginReadOnly`（只读事务，L826-828）→ `adapter.rows(sql,values,timeout)` 流式（L830-837）→ `collectRows`（L1143）/ `writeWorkbookRows`（L934）→ `rollback`（L1282）。
- **QueryAdapter**（L808-817）：`beginReadOnly / rows / rollback / close`。**关键事实**：连接在整个 try 块内保持打开，`adapter.rows()` 可在同一只读事务里**再调一次**发第二个 `WHERE key IN (...)` 查询 —— 批量二次查询在连接层完全可行，无需新连接。
- **流式模型**：row/identity 路径严格流式（L1027/L1225）；group 模式只 buffer 当前连续组（L996-1024）；**从不全量物化**，到 `maxRows` 即停并置 `truncated`（L1175-1178）。→ enrichment 必须**分批**，不能等全量。
- **输出列**：`outputColumns`（L1128-1134）+ 逐 `report.fields.fields` 拷贝 `transformed[field.id]`（L1180-1187）；enum 翻译走 `enumByField`（L1155）。→ lookup 列要在输出里出现，**必须声明为一个 field（有 id）**，且合并后挂在行上该 id。
- **沙箱**（规范 L210）：transform 是动态 import 的 `.mjs`，只拿内存行、**无 DB 句柄** → enrichment 只能在 **runtime** 做，不能在 transform 里。
- SQL 安全：`safeExpression`（L233-249）、值一律 `?` 绑定（L586-592）→ 二次查询的 `IN (?, ?, …)` 走同样参数化。

**plan/package 数据模型**（`report-package-cli.ts`）：
- plan 顶层（L1031-1097）：`source{primary_table,tables[],joins[]}`、`fields`、`parameters`、`custom_logic`、`comparison`（configure-plan 追加，L1509）…
- 声明块落地范式（**这是新块要模仿的**）：`configurePlan`（L1283-1630）读 configuration JSON → 原地改 plan → 重校验 → 写回。join 的写法在 L1317-1323；comparison 的合成在 L1518-1566。
- `buildSql`（L1656）：`column`→`alias.\`f\` AS \`id\``；`computed`**不自出**，只把 dependencies 作为 `raw_*` 列 SELECT 出来（L1674-1681）。
- `buildBindings`（L1840）：`parameters[]` + `system[]`（含 join/having），`exists_subquery` 额外带 `subquery_prefix/suffix`（L1883）。
- `lockedSources`（L2026-2095）：从 `plan.source.tables` 派生每张表的 `{profile_id,database,table,alias,table_id,schema_fingerprint,fields[]}`。**enrichment 表若不在 `source.tables` 里，就不会被 lock** → 必须让它进 lock。
- `generatePackage`（L2097-2284）写：manifest / fields.json / parameters.schema.json / main.sql / bindings.json / transforms / tests / **knowledge.lock.json** / checksums。

---

## 2. Before / After 实例（真实 4 表报表）

### Before：现在生成的 SQL（一对多把整条查询拖进聚合）

```sql
SELECT
  t0.`receipt_count`, t0.`update_by`, t0.`update_time`, t0.`external_order_no`, t0.`abnormal_record`,
  MAX(t1.`oms_customer_name`), MAX(t1.`receive_company`), MAX(t1.`carrier_name`), … ,   -- t1 全被 MAX
  MAX(t2.`customer_order_no`), MAX(t2.`recipient_full_address`), MAX(t2.`total_quantity`),
  MAX(t3.`trained_time`),
  GROUP_CONCAT(DISTINCT t4.`sku_name`) AS `sku_name`                                      -- ← 唯一撑行的刺
FROM `…`.`tms_receipt` AS t0
LEFT JOIN `…`.`oms_waybill` AS t1 ON t0.`waybill_code`=t1.`waybill_code` AND t1.`is_delete`=…
LEFT JOIN `…`.`oms_main_order_simple` AS t2 ON t0.`oms_main_order_no`=t2.`main_order_no` AND …
LEFT JOIN `…`.`shipping_order` AS t3 ON t1.`sho_code`=t3.`code` AND …                     -- 键来自 t1
LEFT JOIN `…`.`oms_waybill_sku` AS t4 ON t0.`waybill_code`=t4.`waybill_code` AND …        -- 一对多
WHERE 1=1 /* EASYBI_FILTERS */
GROUP BY t0.`id`
ORDER BY t0.`id` DESC;
```

**诊断**：t1/t2/t3 都是 **n:1**（不撑行）；只有 t4 `oms_waybill_sku` 是**一对多**。正是 t4 逼出了 `GROUP_CONCAT` + `GROUP BY t0.id`，进而逼得 t1/t2/t3 的所有列套 `MAX()`（组内本是常量）。**一根刺连累全身。**

### After：摘掉 t4，其余 JOIN 保留

```sql
SELECT
  t0.`receipt_count`, t0.`update_by`, t0.`update_time`, t0.`external_order_no`, t0.`abnormal_record`,
  t1.`oms_customer_name`, t1.`receive_company`, t1.`carrier_name`, t1.`carrier_order_no`,
  t1.`recipient_address`, t1.`unload_quantity`, t1.`receipt_requirement`, t1.`recipient_name`,
  t1.`consignor_name`, t1.`customer_abbreviation`, t1.`finish_time`, t1.`remark`,
  t2.`customer_order_no`, t2.`recipient_full_address`, t2.`total_quantity`,
  t3.`trained_time`,
  t0.`waybill_code` AS `raw_waybill_code`     -- E(sku) 的批量二次查询键
FROM `…`.`tms_receipt` AS t0
LEFT JOIN `…`.`oms_waybill` AS t1 ON t0.`waybill_code`=t1.`waybill_code` AND t1.`is_delete`=…
LEFT JOIN `…`.`oms_main_order_simple` AS t2 ON t0.`oms_main_order_no`=t2.`main_order_no` AND …
LEFT JOIN `…`.`shipping_order` AS t3 ON t1.`sho_code`=t3.`code` AND …
-- t4 没了 → 无 GROUP_CONCAT → 无 GROUP BY t0.id → 无满屏 MAX()
WHERE 1=1 /* EASYBI_FILTERS */
ORDER BY t0.`id` DESC
LIMIT 1000;   -- 预览下推（本轮已加）
```

`sku_name` 由**一次批量二次查询** + 内存按 `raw_waybill_code` 分组 `DISTINCT` 拼 `,` 得到：
```sql
SELECT `waybill_code` AS `__key`, `sku_name`
FROM `…`.`oms_waybill_sku` WHERE `is_delete`=0 AND `waybill_code` IN (?,?,…);
```

**收益**：主查询从"3 join + 1 撑行 join + group by + 20 个 MAX + group_concat" → "3 join 的平查 + LIMIT"。t4 一次批量查（走 `waybill_code` 索引）。**摘掉的是那根刺，不是所有 JOIN。**

> 若同一报表还想把 t3 `shipping_order` 也摘出去（例如它其实也是可选维度），可再声明一个 enrichment；但因为 t3 的键 `sho_code` 来自 t1，会形成**链式**依赖（§3.4）。默认建议：n:1 表能 JOIN 就 JOIN，只摘一对多的。

---

## 3. 核心设计：声明式 `enrichments[]` 块

在 plan / manifest 增加一个与 `source.joins` 平级的**声明块**，runtime 据此做批量二次查询与内存合并。

### 3.1 plan / manifest 契约

```jsonc
// plan.enrichments[] （以及原样进 manifest.enrichments[]）
{
  "id": "sku_lookup",                    // 唯一 id
  "lookup": {                            // 被查的表（必须同 profile）
    "profile_id": "transport-main-mysql",
    "database": "baixin_saasx_otms",
    "table": "oms_waybill_sku",
    "alias": "lk_sku",                   // 独立别名，进 knowledge.lock
    "table_id": "…",                     // 供 lock/校验
    "schema_fingerprint": "…"
  },
  "on": {                                // 主行键 → lookup 键（等值）
    "source": "main",                    // main=主查询列 | enrichment=另一 enrichment 的输出（链式）
    "source_id": null,                   // source=enrichment 时，指向的 enrichment id
    "main_field": "raw_waybill_code",    // 主查询/上游 enrichment 里的列 id
    "lookup_field": "waybill_code"       // lookup 表物理列
  },
  "conditions": [                        // lookup 侧固定条件（逻辑删除等），值来自知识、非用户输入
    { "field": "is_delete", "operator": "eq", "value": 0 }
  ],
  "cardinality": "many",                 // one=多对一（不撑行，取标量）| many=一对多（内存聚合）
  "aggregate": {                         // 仅 cardinality=many 需要：如何把多条子行折成一个值
    "kind": "group_concat",              // group_concat | count | sum | max | min | first
    "distinct": true,                    // group_concat 去重
    "separator": ","                     // group_concat 分隔符（内存拼接，不受 group_concat_max_len 截断）
  },
  "select": [                            // 要附加的输出列
    {
      "id": "sku_name",                  // 新 field 的 id
      "label": "商品名称",
      "lookup_field": "sku_name",        // one：直接取；many：作为 aggregate 的输入列
      "output_type": "string"
    }
  ],
  "on_missing": "null"                   // 主行无匹配时列值为 null（one）/ 空串或 0（many，按 aggregate 定）
}
```

- **`cardinality: "one"`**（多对一，如 `出库日期`）：每主行至多一条 lookup → 直接取标量列。若声明 `one` 却命中多行，runtime 取第一条 + 记 warning（可配置为报错）。
- **`cardinality: "many"`**（一对多，如 `sku_name`）：多条子行按 `on` 键分组，用 `aggregate` 折成一个值。`group_concat` 在**内存**拼接 → **不受 MySQL `group_concat_max_len`（默认 1024 字节）截断**，比 SQL 的 `GROUP_CONCAT` 更安全。这是替代原 `GROUP_CONCAT` 那张撑行表的核心机制。

### 3.2 对应的 field 声明

`enrichment.select[]` 的每一项，在 `fields.json` / plan.fields 里生成一个 **新 field kind：`enrichment`**：

```jsonc
{
  "id": "sku_name",
  "label": "商品名称",
  "output_type": "string",
  "source": { "kind": "enrichment", "enrichment_id": "sku_lookup", "lookup_field": "sku_name" }
}
```

- `buildSql`：`enrichment` kind **不进 SELECT**（和 `computed` 一样跳过），但要确保 `on.main_field`（如 `raw_waybill_code`）作为主查询的 `raw_*` 列被 SELECT 出来（复用 computed dependency 的老机制）。链式 enrichment（键来自上游 enrichment）的键列由上游 lookup 的 `select` 提供，不必是主查询列。
- 输出阶段：合并后 `outputRow["sku_name"]` 已挂值，`report.fields.fields` 正常拷出 → 自动出现在预览和 Excel。

### 3.3 bindings.json

新增 `enrichments[]`（与 `parameters`/`system` 平级），runtime 读它执行二次查询：
```jsonc
"enrichments": [{
  "id": "sku_lookup",
  "sql_template": "SELECT `waybill_code` AS `__key`, `sku_name` FROM `…`.`oms_waybill_sku` WHERE `is_delete` = 0 AND `waybill_code` IN (/* KEYS */)",
  "key_source": "main",                  // main | enrichment
  "key_source_id": null,
  "main_key_field": "raw_waybill_code",
  "lookup_key_alias": "__key",
  "cardinality": "many",
  "aggregate": { "kind": "group_concat", "distinct": true, "separator": "," },
  "select_ids": ["sku_name"],
  "on_missing": "null"
}]
```
`sql_template` 在**生成期**从知识构建、过安全护栏；runtime 只把 key 列表参数化成 `IN (?, ?, …)` 填进 `/* KEYS */`，**绝不拼接用户输入**。

---

## 4. runtime 执行流程（分批合并）

在 `prepareSyncQuery` 之后、collector 之前插入一个 **enrichment 阶段**，把主行流"分批"包装：

```
主查询流 rowStream
   │
   ├─（无 enrichments）→ 原样进 collectRows/writeWorkbookRows   ← 现有行为，零改动
   │
   └─（有 enrichments）→ enrichBatched(rowStream, enrichments, adapter, batchSize)
          对每一批 N 行（N = 预览 maxRows 或导出批大小，如 1000）：
            1. 按依赖顺序（拓扑排序，§4.1）逐个 enrichment 执行：
            2.   收集该批所有 key（去重、去空；键来自主查询列或上游 enrichment 的输出）
            3.   adapter.queryAll(sql_template 填 IN(?..), keys, timeout)   ← 同一只读事务
            4.   构建 key→值 的 Map：
                   one  → 一个 key 存一条标量（多命中记 warning）
                   many → 一个 key 聚合所有子行（group_concat 内存拼接 / count / sum …）
            5.   把 select 列 attach 到该批每一行（未命中 → on_missing）
            6. yield 出附加好的行
          → 下游 collectRows/writeWorkbookRows 完全不变
```

- **流式友好**：一次只在内存持有一批（≤batchSize）主行 + 该批的 lookup 结果，不全量物化。
- **many 不撑主行**：一对多聚合在内存里把 N 条子行折成 1 个值挂到主行上，**主行数不变** → 预览 LIMIT 仍可下推、`truncated` 仍准。
- **group transform 模式**：本设计"仅输出阶段合并"，group 报表（`custom_logic.mode=group`）**不支持 enrichment**（校验期硬错误）——group 的 buffer 边界与 enrichment 批边界会交叉，语义复杂，留"transform 前合并"的后续设计。（注意：这里的 group 指报表的 group transform，与 enrichment 自己 many 聚合的"内存分组"无关。）
- **超时**：二次查询各自计入 `query_timeout_seconds`；总时限 `total_timeout_seconds` 仍逐行检查。

### 4.1 链式 enrichment（键来自上游）

真实存在：`shipping_order` 的键 `sho_code` **不在主查询里，而是 `oms_waybill`（另一 enrichment）查回来的列**。所以 enrichment 之间可有依赖：某个 `on.source="enrichment"` 指向另一个 enrichment 的输出列。

- runtime 对 `enrichments[]` 做**拓扑排序**后按序执行：先跑键来自主查询的，再跑依赖它们输出的。
- 生成期校验：依赖不能成环；被依赖的 enrichment 必须先 `select` 出那个键列。
- 若某报表把 t1、t3 都摘成 enrichment，则 E(t3) 依赖 E(t1).sho_code —— 拓扑序保证 E(t1) 先跑。

### QueryAdapter 改动
现有接口够用（`rows` 可重复调）。新增便捷方法 `queryAll(sql, values, timeout): Promise<JsonRecord[]>`（内部 drain 一次 `rows`），供 enrichment 的小批量结果集使用；不改现有 `rows`。

---

## 5. enrichment 字段怎么筛选（关键：输出与筛选走两条路）

一个字段一旦"后封装"，它就**不在主查询的 SQL 里**，`WHERE` 碰不到它——和 computed 字段的困境相同。**内存筛是错的**：内存筛只对"主查询已经捞上来的那批行"生效，而筛选的语义是"先筛掉不匹配的主行"。先捞 1000 行回单再内存筛 sku，会漏掉本该命中、却排在 1000 行之外的回单。**这是正确性红线。**

所以：**同一个 enrichment 字段，输出走后封装，筛选走 SQL 下推——两条路，对用户是一个字段。**

### 5.1 默认：筛选下推为 EXISTS 半连接（复用现有机制）

系统里**已经有这套**——就是现在 `GROUP_CONCAT` 字段自动改写成 `clause=exists_subquery` 的机制（`buildExistsSkeleton`）。enrichment 字段若带 `filter` 角色，`configure-plan` **自动为它再合成一个 EXISTS 筛选绑定**：

- **输出**：`sku_name` 走 enrichment 后封装（内存拼接展示）；
- **筛选**：`sku_name` 作为条件 → 主查询 `WHERE` 里
  `EXISTS (SELECT 1 FROM oms_waybill_sku ex WHERE ex.waybill_code = t0.waybill_code AND ex.sku_name LIKE ?)`。

优势和现有 GROUP_CONCAT→EXISTS 完全一致：**先筛后聚**、走子表索引、不受 `group_concat_max_len` 截断、值只作 `?` 绑定。lookup 表本就在 knowledge.lock 里，EXISTS 骨架生成期构建、过安全护栏。

> 链式 enrichment 的筛选：EXISTS 需要能把子表关联回**主查询里的某列**。若键来自上游 enrichment（如 t3 的键来自 t1.sho_code）而 t1 也被摘出，则该 enrichment 字段**无法下推 EXISTS**（相关列不在主查询）——此时校验期**拒绝**给它加筛选，提示"要筛此字段，请让其键链上的表保留为 JOIN"。这把"能否筛"和"表怎么建模"显式绑定，不静默出错。

### 5.2 例外：数值 lookup 的内存范围筛（需显式选择 + 正确性警示）

若筛的是**一对一 lookup 的数值标量列**（如 `出库件数`），且用户能接受"只在已捞批次里筛近似"，可走**已有的 `post_transform` 内存范围筛**（本轮刚做的件数筛选那套）。但它有 5 开头说的漏行风险，所以：

- **默认仍下推 SQL**；只有报表显式声明 `filter.strategy="in_memory"` 时才用 post_transform；
- 生成期对这种字段强制加一条 `warning`，SKILL 文档要求向用户确认"该筛选仅在预览/导出批次内近似生效"。

### 5.3 小结（筛选决策表）

| enrichment 字段筛选场景 | 处理 |
|---|---|
| 键能关联回主查询（默认情形） | **EXISTS 下推**（复用 buildExistsSkeleton），输出仍后封装 |
| 键来自上游 enrichment、相关列不在主查询 | 校验期**拒绝加筛选**，提示保留该键链为 JOIN |
| 一对一数值列 + 显式 `in_memory` | post_transform 内存范围筛 + 强制 warning |

---

## 6. 生成期（report-package-cli.ts）改动

1. **configure-plan**：接受 `configuration.enrichments[]` → 校验（含拓扑排序、cardinality/aggregate、筛选可下推性）→ 写入 `plan.enrichments` + 追加 `enrichment` kind 的 fields + 对带 filter 的字段合成 EXISTS 绑定（模仿 join L1317-1323、append-field L1390-1420、GROUP_CONCAT→EXISTS 自动改写 L1357-1380 的范式）。
2. **buildSql**：`enrichment` field 跳过 SELECT；确保 `on.main_field` 依赖列被 SELECT。
3. **buildBindings**：输出 `enrichments[]`（sql_template 生成期构建 + 过 `assertSafeSqlExpression` / 新增 `assertSafeLookupTemplate`）；enrichment 字段的 EXISTS 筛选走现有 `exists_subquery` 绑定。
4. **lockedSources**：把每个 enrichment.lookup 表**并入 lock 的 sources**（alias、table_id、fingerprint、用到的列 = select.lookup_field + on.lookup_field + conditions.field + EXISTS 用到的列）。
5. **manifest**：`...(plan.enrichments ? {enrichments} : {})`（兼容扩展，老包无此键）。
6. **generate**：无新文件，只是上述文件多出内容。

## 7. 校验（validatePlanV2 / validatePackage）

- enrichment.id / alias 唯一；lookup 表 profile 必须与主表**同 profile**（跨 profile 不支持，和 JOIN 一致）。
- `on.main_field` 必须是主查询可得的列 id，或（链式）上游 enrichment 的 `select` 输出 id；依赖不成环（拓扑可排序）。
- `on.lookup_field` / `select.lookup_field` / `conditions.field` / `aggregate` 输入列必须在 lookup 表 `available_fields` 内。
- `cardinality=many` 必须带合法 `aggregate`；`cardinality=one` 不得带 aggregate。
- lookup 表必须出现在 knowledge.lock.sources（backstop 手改包）。
- `enrichment` kind field 必须绑定到存在的 enrichment.id + 合法 lookup_field。
- **带 filter 角色的 enrichment 字段**：若键能关联回主查询 → 合成 EXISTS；否则**拒绝**（除非显式 `in_memory` 且为数值一对一列）。
- **报表 group transform 模式（custom_logic.mode=group）+ enrichment = 硬错误**（本期不支持）。
- sql_template 必须含且仅含一个 `/* KEYS */` 标记、过安全护栏、无用户输入。

## 8. 知识库侧（initialize-report-knowledge）

enrichment 的 lookup 表也必须是**已扫描的知识表**（要有 table_id / fingerprint / available_fields）。通常它已是 warm/cold 表；若未纳入知识库，需先 promote/scan。文档说明这一前置。

## 9. SKILL.md / 规范文档

- 报表 SKILL.md 新增一节"附加另一表的列（enrichment：批量二次查询，专治一对多撑行表）"，讲清：**定位（只摘一对多撑行表，n:1 继续 JOIN）**、one vs many、链式依赖、**筛选走 EXISTS 下推**、报表 group 不支持、与 JOIN/EXISTS 的取舍、批大小权衡。
- 技术规范新增 enrichment 契约 + runtime 分批合并流程 + 拓扑排序 + 筛选下推 + 安全边界。

## 10. 测试策略

- 生成期：configure-plan 注入 one/many/链式 enrichment → plan/bindings/lock/EXISTS 断言；跨 profile、报表 group+enrichment、未知列、成环依赖、many 缺 aggregate、不可下推筛选 → 报错断言。
- runtime：伪造 adapter（返回预设行 + 记录每次二次查询的 IN 值），断言 ①分批 key 收集正确 ②拓扑序执行 ③one hash-merge ④many 内存聚合（group_concat 去重/分隔、count/sum）⑤未命中走 on_missing ⑥one 多命中记 warning ⑦预览 LIMIT 仍生效、行数不被 many 撑大 ⑧总时限仍检查 ⑨EXISTS 筛选实际过滤主行。
- 端到端：用那条真实 4 表报表——把 `oms_waybill_sku` 摘成 many enrichment、t1/t2/t3 保留 JOIN，validate + querySync 断言 `sku_name` 拼接正确、主查询无 GROUP BY、按 sku 筛选走 EXISTS 且结果正确。

## 11. 分期建议（已调整）

- **一期（MVP，含 many）**：row/identity 报表的输出阶段合并 + one **和** many 聚合 + 链式 enrichment + **筛选 EXISTS 下推** + 按上限分批 + 全套校验/lock/文档/测试。**覆盖那条真实 4 表报表的完整优化**（摘 t4、其余 JOIN、sku 可筛）。
- **二期（可选）**：transform 前合并（让 lookup 列参与 computed/环比/group by）；更多 aggregate 类型；批大小自适应。

## 12. 风险与取舍

- **二次查询往返**：预览 = 1 主 + K 个 enrichment 查询（K 通常 1-2）。导出大表 = ⌈行数/批⌉ × (1+K)。每条都是主键/索引 `IN` 查，主查询是保留少量 JOIN 的平查 + LIMIT——通常远快于"一对多 join + group by + group_concat"。文档写明"批大小"权衡（批大=往返少但 IN 列表长）。
- **一 key 多命中（one）**：声明 one 却命中多行 → 取第一条 + warning（默认）或报错（可配）。强调 cardinality 声明的责任。
- **内存聚合无 max_len 截断**：many 的 group_concat 在内存拼，比 SQL 的 `GROUP_CONCAT` 更完整；但需注意超长拼接的内存/单元格大小，受 `max_file_bytes` 等既有限制约束。
- **筛选正确性**：默认 EXISTS 下推保证"先筛后取"；内存筛是显式例外且带 warning，绝不默认。
- **兼容性**：全部为可选扩展块，老包 `enrichments` 缺省 → runtime 走原路径，零回归。
- **不支持项（本期显式报错，不静默降级）**：跨 profile、报表 group transform、键不可下推却要筛选、成环依赖。
