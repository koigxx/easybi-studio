---
name: create-report-package
description: Create, review, validate, and version standardized Easy BI report packages from report requirements and a database-navigated semantic knowledge catalog. Use when generating a new report package, modifying an existing report, deriving visible filter metadata and safe SQL bindings, locking report lineage to a knowledge version, or preparing packages for the shared TypeScript Runtime with selectable synchronous and asynchronous Excel export.
---

# Create Report Package

Use conversation for business confirmation and the bundled TypeScript CLI for deterministic inspection, generation, checksums, and validation. One Skill serves every report; do not create a new Codex Skill per report.

Before changing this Skill, the shared Runtime, its outputs, formats, commands, APIs, or workspace paths, read [Easy BI Skill 与项目目录兼容性规范](../目录与项目兼容性规范.md) completely. Treat the stable directory and upgrade rules in that document as public contracts.

Before executing the workflow, read [报表与 Runtime 技术规范](references/报表与Runtime技术规范.md) once. It is the single detailed reference for plan/package v2, field resolution, filters, SQL, JOIN, aggregation, Transform, Runtime branches, capacity, and validation.

For developer and administrator operation examples, use [使用说明](使用说明.md). Do not load it during routine Agent execution unless the user asks how to operate the Skill.

## Non-negotiable rules

- Reuse `knowledge.report_requirements`; do not ask the user to repeat confirmed report fields.
- Read hot tables first, then warm tables. Never infer fields from cold-table summaries.
- Generate a report plan before files. Ask only about blockers or missing business logic.
- Keep common MySQL, Excel, OSS, HTTP, task, logging, and error behavior in the Runtime bundled with this Skill. Workspace Toolkit files hold configuration and contracts, not duplicated executable logic.
- Put only report-specific fields, safe query model, optional TypeScript transforms, tests, and knowledge lock in a report package.
- Keep `../bundle.manifest.json` path mappings, command entries, and compatibility ranges synchronized with any public output or Runtime change.
- Allow both `sync` and `async` execution by default. Select the branch from `request.executionMode`; do not fix a report to one mode unless the user explicitly restricts it.
- Return HTTP 200 for both successful branches. Sync success is an xlsx stream; async success is a JSON task response. Runtime business errors use the standard `{success:false,requestId,error}` envelope with HTTP 200.
- Keep tenant context out of visible parameters. Accept optional `context.tenantId` and apply a parameterized equality predicate only when supplied.
- Assume knowledge enum mappings are ready during this phase. Do not block, warn, or ask about missing enum mappings while creating the report package.
- Never concatenate request values into SQL. Runtime may only compile predicates from package-declared bindings and operators.
- Never edit a published report version in place. Create a new version.
- A draft knowledge catalog may generate a development-only report package. Production publication requires a published knowledge version and release signing.

## 1. Check local dependencies

The packaged Skill contains compiled `dist/` files. Package generation only needs Node.js; Runtime execution additionally uses the pinned MySQL, Excel, and OSS adapters:

```bash
npm run bootstrap:core
node dist/scripts/report-package-cli.js doctor
```

`bootstrap:core` must inspect local pinned dependencies first and skip all downloads when they are already available. Use development dependencies only when modifying the Skill:

```bash
npm run bootstrap:runtime
npm run bootstrap:dev
npm test
```

Use `bootstrap:runtime` before starting HTTP or exporting Excel. Every bootstrap mode checks exact local versions first and downloads only missing or mismatched packages.

## 2. Inspect the report requirement

Choose a knowledge draft or published version and generate a plan:

```bash
node dist/scripts/report-package-cli.js inspect \
  --workspace <workspace> \
  --knowledge <knowledge-directory> \
  --report-id <report-id> \
  --out <workspace>/reports/plans/<report-id>.json
```

The inspector must:

1. load the matching `knowledge.report_requirements` entry;
2. resolve every output field to a knowledge table and physical field;
3. preserve configured field order, labels, and any per-field `description` (业务口径). A required-field object may carry `description` (e.g. `{ field, label: "订单数总和", description: "订单数量的总和" }`); it flows onto the resolved plan field so you understand the field's intent when generating the package. It is documentation only — never used in SQL.
4. derive visible parameters from knowledge filter metadata;
5. derive hidden logical-delete conditions and optional tenant context;
6. default to creation-time descending and add ID descending as a deterministic tie-breaker; if no creation-time field exists, use ID descending;
7. assign a deterministic alias to every source table and field;
8. produce blockers only for unresolved fields, ambiguous lineage, missing joins, or undefined calculations;
9. trust enum references as a knowledge-maintenance responsibility and do not add enum questions or blockers.

If all fields come from one table and require no calculations, accept the inferred query without asking extra questions.

## 3. Review only missing decisions

Present the plan summary: report, source tables, output fields, visible filters, system conditions, optional context bindings, execution strategy, warnings, and blockers.

Ask one consolidated question only when `blockers` is non-empty or when the user must define:

- a join not present in knowledge;
- a calculated or aggregate field;
- grouping and `HAVING`;
- non-default sort;
- a report-specific field or parameter override;
- a report-specific Excel layout.

Do not ask about OSS keys or business task URLs while designing a report. Those belong to Toolkit Runtime configuration.

For a multi-table or calculated report, write one reviewed configuration JSON and
apply it deterministically:

```bash
node dist/scripts/report-package-cli.js configure-plan \
  --plan <plan-file> \
  --configuration <join-and-calculation.json>
```

The configuration can declare:

- `joins[]`: `type=LEFT|INNER`, target `alias`, equality `on[]`, and result `grain`;
- field overrides with `source.kind=column|sql_expression|computed|boolean_flag`;
- `aggregation.group_by[]` and fixed `having[]`;
- computed dependencies, `mode=row|group`, and a trusted TypeScript expression;
- `custom_logic.group_keys[]` and `max_group_rows`.

The CLI validates aliases and ON keys against the knowledge-backed table column
lists. It automatically places a secondary table's logical-delete conditions in
the JOIN `ON` clause. A valid configuration removes `JOIN_REQUIRED` and records
`JOIN_RESOLVED`; approval remains a separate explicit action.

### Cross-database JOIN (same connection, multiple databases)

Tables from **different databases on the same connection profile** can be joined
directly — the generator qualifies every table with its own database, e.g.
`FROM \`otms\`.\`shipping_order\` AS t0 LEFT JOIN \`billing\`.\`fee\` AS t1 …`. The
only rule is **one profile**: all source tables must belong to the same
`database_profiles` entry (same host/account); the `database` may differ per
table. To use this, the knowledge base must have scanned all those databases
(list them in the profile's `settings.databases` and rescan). Joining tables
across **different profiles/connections** is NOT supported by a single SQL —
that needs the script-package model (see decision 0002).

### Grouped summary reports (one row per group)

For a statistics report that shows **one row per group** (e.g. one row per
customer), model it as an aggregate: put the group column(s) in
`aggregation.group_by` and emit aggregate expressions (`SUM`/`COUNT`/…) for the
metrics. N distinct groups → N rows. Filters on the raw grouped column follow the
aggregated-field rules below.

### Filtering a field that is aggregated (one-to-many, concatenated output)

When a join is one-to-many (e.g. one order → many products) and a child column
is emitted as a **concatenated** value (`GROUP_CONCAT(t1.\`product_name\`)`), that
column no longer exists as a plain row value — so it **cannot** be filtered in
`WHERE`. This is a recurring case; handle it one fixed way:

- Model the field as `source.kind=sql_expression` with the `GROUP_CONCAT`
  expression (for output), and let the filter be pushed down to a **correlated
  `EXISTS` semi-join**. Semantics: **return the parent (order) when ANY child row
  matches, while the output still concatenates every child value.** This is
  exactly "a fuzzy product-name filter over a one-to-many order→product join".
- `configure-plan` does this **automatically**: when a field becomes a
  `GROUP_CONCAT`/`STRING_AGG`-style concatenation with a single child column, the
  CLI rewrites its filter parameter to `clause=exists_subquery` and builds the
  subquery skeleton from knowledge (child table + join keys + logical-delete),
  binding the search value as a `contains` (`LIKE`) match on the raw child column.
  You do not hand-write the subquery. Non-aggregated parent filters (order no. /
  carrier / created time / status) stay in `WHERE` unchanged.

Why EXISTS and not HAVING-on-`GROUP_CONCAT`:

- **Faster**: the semi-join filters *before* grouping, short-circuits on the
  first matching child, and can use the child table's index — instead of building
  every group's concatenated string and then matching it.
- **Correct**: HAVING would match against a `GROUP_CONCAT` value that MySQL
  truncates at `group_concat_max_len` (default 1024 bytes), silently missing
  orders with many products. EXISTS matches the raw child row, no truncation.
- **Safe**: the subquery skeleton is built at generation time from knowledge only
  (never user input); the runtime binds just the value as `?`. The SQL-safety
  guard is never relaxed — it still rejects `SELECT`/quotes/`;` in any user-facing
  filter expression.

Configuration snippet (product-name example, MySQL):

```json
{
  "fields": [
    {
      "id": "product_name",
      "source": {
        "kind": "sql_expression",
        "expression": "GROUP_CONCAT(DISTINCT t1.`product_name`)",
        "dependencies": [{ "alias": "t1", "field": "product_name" }]
      },
      "filter": { "enabled": true, "visibility": "user", "role": "text" }
    }
  ],
  "aggregation": { "group_by": ["t0.`order_no`"], "having": [] }
}
```

Notes:

- Use `GROUP_CONCAT(… )` **without a `SEPARATOR '…'` literal** — the guard bans
  single quotes and MySQL's default separator is already a comma. The output
  column keeps this concatenated form; only the *filter* moves to EXISTS.
- If the concatenation can't map to a single child column (multi-column
  expression), `configure-plan` falls back to a `HAVING … LIKE` match on the
  concatenated value (subject to the truncation caveat above).
- A genuine **numeric aggregate** filter (e.g. `SUM(t1.\`qty\`) >= n`) is a real
  HAVING comparison and is **not** rerouted — keep it on `clause=having`.
- **PostgreSQL**: the concat equivalent is `STRING_AGG(t1."product_name", ',')`,
  whose quoted separator the guard rejects, but the **EXISTS push-down still
  works** (it matches the raw child column, not the aggregate). Confirm with the
  user; the auto-routing builds the same correlated EXISTS for PG plans.

After explicit user approval:

```bash
node dist/scripts/report-package-cli.js approve-plan \
  --plan <plan-file> \
  --reviewed-by "<reviewer>"
```

### Date / datetime filters are ranges; create-time is required

A `date`/`datetime` output column is **never** filtered as a single value — it's
a **range** (start + end). `inspect` derives this automatically:

- value type → `date_range` / `datetime_range`, component → `date-range` /
  `datetime-range`, operators → `["between","gte","lte"]`, default `between`.
- The runtime accepts `{ "from": …, "to": … }`; a one-sided range degrades to
  `>=` / `<=`. The test page renders two pickers ("起 / 止").
- **Create-time is forced `required`** (matched by column name — `create_time`,
  `created_at`, `gmt_create`, … — or a 创建时间/创建日期 label), even if the
  knowledge filter said optional. The runtime rejects a missing required filter
  with `MISSING_FILTER`; the test page blocks export and highlights it with `*`.

Other date columns (e.g. update time) become ranges too but stay optional. To
force another filter required, set `filter.required=true` in knowledge.

### Computed / derived fields: numeric ones filter post-transform, others cannot

Some fields exist **only after computation** — an environment-over-period delta
(环比/同比), a ratio, a bucketed metric like 件数总和. Model these as
`source.kind=computed` (`mode=row|group`); they are produced by the TypeScript
transform, not by SQL, so they **cannot** be a `WHERE`/`HAVING` filter evaluated by
the database.

A **numeric** computed field can still be range-filtered **after** the transform
runs: the runtime keeps only the output rows whose computed value falls in the
requested range. So:

- When a numeric computed field (`output_type=number`) carries a `filter` role,
  `configure-plan` synthesizes a **`clause=post_transform`** parameter for it:
  `value_type=number_range`, `component=number-range`, `operators=[between, gte,
  lte]`. The runtime applies it in memory (≥ lower / ≤ upper / between) to the
  transform's output rows — in both sync export and the 测试页 preview. Keep the
  `filter` role on numeric computed fields the user wants to range-filter.
- A **non-numeric** computed field still cannot be filtered. `configure-plan`
  removes any such parameter and emits a `FILTER_DROPPED_COMPUTED` warning listing
  the affected fields. **Present this warning to the user for confirmation** —
  e.g. "以下字段是计算/派生字段且非数值，无法作为筛选项，已取消其筛选、仅作为输出列，请确认：…".
- `validate` backstops hand-edited plans: a `computed` field carrying a same-id
  parameter whose clause is **not** `post_transform` is a hard error, and a
  `post_transform` parameter must be `number_range` on a computed field.

### Boolean-flag fields: a 是/否 column folded from a number/status (`source.kind=boolean_flag`)

A field whose **business meaning is 是/否** but whose **underlying column is a
number or status code** — e.g. 「签单是否上传」 backed by `receipt_count` (回单数量,
where >0 means 已上传). Do **not** expose the raw count as a number-range filter;
model it as a boolean flag so both the filter and the output are 是/否.

Declare it as a field override in `configure-plan` (the field must already exist in
the plan's lineage as a resolved column so its alias/table stay locked):

```json
{
  "fields": [
    {
      "id": "receipt_count",
      "output_type": "boolean",
      "roles": ["output", "filter"],
      "source": { "kind": "boolean_flag", "operator": "gt", "threshold": 0,
                  "labels": { "truthy": "是", "falsy": "否" } }
    }
  ]
}
```

- `operator` is one of `gt|gte|lt|lte|eq|ne` (a fixed set — never free text); `threshold`
  is a number. `labels` is optional (defaults 是/否).
- **SELECT**: the generator emits `CASE WHEN col <op> <n> THEN 1 ELSE 0 END`; the 1/0
  renders as 是/否 through an auto-injected `{1:"是",0:"否"}` enum map (preview + Excel).
- **Filter**: `value_type=boolean`, `component=switch`. The 测试页 shows a
  不筛选／是／否 selector. The runtime builds the predicate **structurally** — 是 →
  `(col <op> <n>)`, 否 → `NOT (col <op> <n>)` — with **no bound value** and no
  free-form comparison string, so it is injection-safe and dialect-agnostic (no
  true/false literal quirks). The filter pushes down to SQL `WHERE` (correct across
  the whole table, not just the fetched batch).
- `validate` backstops: the column must exist + be JOINed, `output_type` must be
  `boolean`, the operator must be in the allowed set, and the threshold must be finite.

### Decimal sums in a transform MUST use integer accumulation (no float drift)

When a `computed` (row/group) expression **sums or accumulates a decimal column**
(金额 / 重量 / 体积 / …, i.e. any `DECIMAL`/`NUMERIC` source), you MUST accumulate in
**scaled integers**, never by adding JavaScript floats. Floating-point addition
drifts — `12.34 + 8.2755 + 30 → 50.615500000000004` — producing dirty long-tail
decimals in the output.

Rule for the TypeScript expression you write into `source.expression`:

- Pick a scale from the column's `DECIMAL(p, s)` scale `s` (e.g. `DECIMAL(16,4)`
  → scale `10000`). When several decimal columns share a transform, use the max
  scale among them.
- Accumulate `Math.round(Number(value) * SCALE)` into an **integer** bucket.
- Divide by `SCALE` **once, at the end**, when producing the output value:
  `sum = intBucket / SCALE`. For a difference (环比/同比 delta) divide the final
  subtraction result: `(curInt - prevInt) / SCALE`.
- **Counts** (`COUNT` / `+= 1`) are already integers — do NOT scale or divide them.

```ts
// ✅ decimal(16,4) weight sum — integer accumulation, divide once at the end
let wt = 0;
for (const r of rows) wt += Math.round(Number(r.raw_weight ?? 0) * 10000);
return wt / 10000;              // 50.6155, not 50.615500000000004

// ❌ never: for (const r of rows) sum += Number(r.raw_weight ?? 0)
```

### Comparison reports (环比 / 同比) — same logic, wider window

A comparison metric compares the selected month range against an earlier window:
**环比 (`chain`) = 上一个月**, **同比 (`yoy`) = 去年同月**. The computation lives in
the **group transform** (per-group, month-bucketed); the skill's job is to make
sure the transform *receives* the earlier months in one query.

Declare a `comparison` block in `configure-plan`:

```json
{
  "custom_logic": { "group_keys": ["customer_id"], "max_group_rows": 100000 },
  "comparison": {
    "modes": ["chain", "yoy"],        // 环比 / 同比
    "lookback_months": 1               // chain looks back this many months; yoy is fixed 12
  }
}
```

**`period_param` is optional — do NOT ask the user to add a create-time filter.**
When you omit it (or name a create-time column that isn't a filter yet),
`configure-plan` **auto-synthesizes a required month-range filter** on the primary
table's create-time column (`create_time` / `gmt_create` / 创建时间 …) and points
`period_param` at it, emitting a `PERIOD_FILTER_ADDED` warning you should relay to
the user ("已自动新增必填按月时间筛选…作为对比基准"). This is the "default
create-time, but queried by month" behavior — no extra `required_fields` needed.

- If the primary table has **no** create-time column, or **several** candidates,
  the CLI errors and asks you to name one via `comparison.period_param`. Only then
  do you ask the user which column to use.
- `custom_logic.mode` must be `group` — comparison deltas are computed per group
  over the buffered rows. (`configure-plan` sets this automatically once any
  `computed`/`group` field exists.)
- `validate` still backstops hand-edited plans: `period_param` must resolve to a
  **required** `date_range`/`datetime_range` parameter.

**Declaring the delta columns:** the 环比/同比 output columns are brand-new
`computed` (`mode: group`) fields. List them directly in `configure-plan`'s
`fields` — even with ids not present in `required_fields`; `configure-plan`
**appends** new `computed`/`sql_expression` fields (a brand-new `column` field is
rejected — those must come through `required_fields`). You do NOT need to reuse an
existing field id.

How the window works at run time (no user action needed):

- The user selects only the reporting range (e.g. 4–8 月). The runtime
  **automatically widens the period filter's lower bound backward** so one query
  returns the current window **plus** the look-back window(s): `chain` extends by
  `lookback_months`, `yoy` extends by 12 months, and the **earliest** bound wins.
  The upper bound is unchanged; edge months (like 4 月) therefore still have their
  previous month / last-year month available.
- The dependency columns (the period column and the metric) are selected as
  `raw_*` aliases. In `transformGroup`, bucket rows by month (`String(row.raw_ct
  ).slice(0,7)`), then compute the current month's value and the chain/yoy delta
  against the earlier bucket. Return one output row per group.

This keeps 环比/同比 as **extra output columns on the same table**. (Emitting them
as separate comparison *sheets* is a larger, deferred design — see decision 0002.)

### Enrichment: attach another table's columns by batch secondary-query, NOT a JOIN

When a report joins several tables, watch for the ONE table whose relationship is
**one-to-many** (e.g. one order → many SKU rows). That single join forces a
`GROUP_CONCAT` + `GROUP BY` + `MAX()` over the *whole* query — every other column
gets wrapped in `MAX()` just to survive the grouping. That's the real performance
cost, not the number of joins.

**Rule of thumb:** keep **n:1 dimension tables as normal JOINs** (2-3 is fine —
many-to-one doesn't inflate rows and uses indexes). Only pull out the **one-to-many
table that would otherwise force the aggregation** and model it as an *enrichment*:
the runtime streams the main query, collects the join keys per batch, runs one
`WHERE key IN (…)` query against the lookup table, and merges the columns back in
memory. No JOIN, no row inflation, no `GROUP_CONCAT` truncation.

Declare `enrichments[]` in `configure-plan`:

```json
{
  "enrichments": [
    {
      "id": "sku_lookup",
      "lookup": { "profile_id": "…", "database": "…", "table": "oms_waybill_sku", "alias": "lk_sku" },
      "on": { "source": "main", "main_field": "raw_waybill_code", "lookup_field": "waybill_code" },
      "cardinality": "many",
      "aggregate": { "kind": "group_concat", "distinct": true, "separator": "," },
      "select": [{ "id": "sku_name", "label": "商品名称", "lookup_field": "sku_name", "output_type": "string" }],
      "on_missing": "null"
    }
  ]
}
```

- **`cardinality`**: `one` (many-to-one, e.g. 出库日期 — takes the scalar; multi-hit
  → first row + a warning) or `many` (one-to-many — folds child rows via `aggregate`:
  `group_concat` / `count` / `sum` / `max` / `min` / `first`). `group_concat` joins
  **in memory**, so it is NOT truncated by MySQL's `group_concat_max_len`.
- **`on.main_field`** must be a column the main query actually SELECTs (declare the
  join key as a normal output/`column` field). **Chained**: set `source:"enrichment"`
  + `source_id` to key off an earlier enrichment's output (e.g. `shipping_order`
  keyed by `oms_waybill.sho_code`); the runtime topologically orders them.
- The lookup table is resolved from **knowledge** (must be a scanned table, same
  `profile` as the main table), locked into `knowledge.lock.json`, and NEVER added
  to the SQL `FROM`/`JOIN`.

**Filtering an enrichment field — output and filter take two paths.** An enrichment
column is not in the main SQL, so it can't be a `WHERE` filter and must NOT be
filtered in memory (that would only filter the rows already fetched, silently
dropping matches outside the batch). If the user needs to filter by it, `configure-plan`
pushes the filter down to a correlated **EXISTS** semi-join on the lookup table
(the same mechanism as a `GROUP_CONCAT` filter) — output stays the in-memory merge,
filtering happens in SQL. If the join key can't be correlated back to the main query
(a chained enrichment whose key table isn't in the main SQL), the filter is
**refused** at configure time — keep that table as a JOIN if you must filter by it.

**Not supported (this version, rejected at validate time):** enrichment on a
**group transform** report (环比/同比 or grouped-summary), cross-`profile` lookups,
and dependency cycles.

## 4. Generate the package

```bash
node dist/scripts/report-package-cli.js generate \
  --workspace <workspace> \
  --plan <approved-plan>
```

Default output:

```text
reports/packages/<report-id>/<version>/
```

The generator creates:

```text
report.manifest.json
fields.json
parameters.schema.json
queries/main.sql
queries/bindings.json
transforms/index.ts
transforms/index.mjs
tests/cases.json
knowledge.lock.json
checksums.sha256
```

New packages use `report_package_format_version=2`. The shared Runtime rejects
format 1, missing-format, and unknown-format packages.

Keep `transforms/index.ts` as the editable source and `transforms/index.mjs` as its executable Runtime entry. Both remain identity transforms unless custom computation is explicitly required. If the TypeScript source changes, compile and validate the `.mjs` file before testing.

## 5. Validate

```bash
node dist/scripts/report-package-cli.js validate \
  --package <report-package-directory>
```

Validation must fail on:

- missing required files;
- unresolved blockers;
- an unapproved plan;
- unknown execution modes;
- unknown filter operators;
- request SQL interpolation;
- missing filter insertion marker;
- invalid field or parameter bindings;
- checksum mismatch;
- unknown JOIN aliases or unlocked ON/field/dependency columns;
- a HAVING parameter without the HAVING marker;
- in-place published version mutation.

Run static validation after every manual edit.

## 6. Modify a report

Use the same Skill. Inspect the current requirement and knowledge again, compare it with the latest package, select a new semantic version, generate a new plan, and publish a new directory. Preserve the previous version.

Re-run all structure, binding, parameter, empty-result, boundary, and expected-column tests. Do not copy common Toolkit code into the new version.

### Manual edit of a development package (reseal)

The generator's output isn't always final — a human may need to hand-tune the
SQL, the transform, the filter bindings, or the parameter schema. A development
package can be edited in place and re-sealed:

1. Edit the files under the package (`queries/main.sql`, `transforms/index.ts`
   + `index.mjs`, `queries/bindings.json`, `parameters.schema.json`, …). If you
   change `transforms/index.ts`, recompile `index.mjs` before resealing.
2. Recompute checksums and re-validate:

   ```bash
   node dist/scripts/report-package-cli.js reseal --package <package-dir>
   ```

`reseal` first checks package **structure** (required files, valid SQL markers,
bindings, loadable transform). If the edit broke the structure it **refuses** and
reports the errors — it never blesses a broken package. Only then does it rewrite
`checksums.sha256` and re-validate. Guardrail: **only development packages** may be
resealed; a published/signed package stays immutable — cut a new version instead.

## 7. Runtime handoff

The Runtime request chooses:

- `sync`: generate a temporary xlsx and return the file with HTTP 200;
- `async`: require ready OSS and business-task profiles, call the business “create task” endpoint, enqueue generation, upload the xlsx, then call the business “update task” endpoint with success or failure.

Missing async configuration returns `OSS_PROFILE_UNAVAILABLE` or `BUSINESS_TASK_PROFILE_UNAVAILABLE` in the standard HTTP-200 error envelope. Never silently switch modes.

## 8. Run the shared Runtime

The Skill owns one shared Runtime for every generated report package. A generated and indexed report package is callable immediately without adding report-specific HTTP or CLI code.

**No restart after editing a report package.** The Runtime re-reads every package
file from disk on each request and cache-busts the transform module, so a
`generate` / `reseal` / hand-edit of a report package (SQL, transform, bindings,
parameter schema) takes effect on the next request with **no server restart**. The
only change that requires restarting the Runtime process is editing the Skill's own
`dist/` code (e.g. `runtime-core.js`) — a long-lived process keeps the old compiled
module until restarted, so after `npm run build` on the Skill, restart any running
`serve` process (stale processes are a common cause of "why didn't my fix apply").

CLI:

```bash
node dist/scripts/runtime-cli.js list --workspace <workspace>
node dist/scripts/runtime-cli.js parameters \
  --workspace <workspace> --report-id <report-id>
node dist/scripts/runtime-cli.js export \
  --workspace <workspace> \
  --report-id <report-id> \
  --filters-json '{}' \
  --tenant-id <optional-tenant-id> \
  --output <optional-xlsx-path>
```

HTTP Server:

```bash
node dist/scripts/runtime-cli.js serve --workspace <workspace>
```

It exposes exactly:

- `GET /api/v1/reports`
- `GET /api/v1/reports/{reportId}/parameters`
- `POST /api/v1/exports`
- `POST /api/v1/queries` — synchronous JSON query returning 中文 column headers + data rows for preview (same query/filters/transform/enum-mapping as export; bounded row count via optional `limit`, no pagination; never writes a file). See 技术规范 §11.1.

The CLI directly exports synchronous files. Asynchronous export must use the HTTP Server so its SQLite queue and Worker stay alive.

## 9. Runtime query and export rules

Before claiming synchronous export passed:

1. confirm the report plan was explicitly approved and the package validates;
2. reuse the exact workspace MySQL Profile named in `knowledge.lock.json` and keep the connection read-only;
3. execute MySQL control statements (`SET`, `START TRANSACTION`, and `ROLLBACK`) with `connection.query()`, never prepared `execute()`;
4. execute the parameterized business `SELECT` as a stream and never load the full result set in memory;
5. compile only package-declared filters, fixed bindings, and optional context;
6. support both `{operator,value}` and direct values; range values accept `{from,to}` or a two-element array;
7. enforce `runtime.json`: at most 2 Sheets, 1,048,575 data rows per Sheet, 600-second query timeout, and 900-second total timeout;
8. generate a complete temporary xlsx before reporting success;
9. verify the workbook opens, headers match `fields.json`, row count is recorded, filters take effect, and the final file is written under the workspace `outputs`;
10. do not require OSS or call business task APIs for a sync test;
11. never report a simulated package, static validation, or disconnected database attempt as a successful synchronous export.

For `custom_logic.mode=group`, the query is ordered by `group_keys`; Runtime
buffers only the current contiguous group and enforces `max_group_rows`. Identity
and SQL-only reports do not load the Transform module.

## 10. Reject and rebuild old report formats

This Skill only accepts report plans and report packages with format `2`. It does
not migrate or execute format `1`.

When a workspace still contains format `1` plans or packages:

1. delete their entries from `reports/index.json`;
2. delete the old plan and package directories as explicitly requested by the
   workspace owner;
3. reuse the current knowledge catalog and `config/easy-bi.json` report
   requirements;
4. run `inspect`, resolve JOIN/calculation blockers, approve the new v2 plan, and
   run `generate`;
5. validate and test the new v2 package before exposing it through Runtime.

Do not change the HTTP `/api/v1/*` paths: that is the stable Runtime API version,
not the report package format.
