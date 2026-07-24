---
name: create-report-package
description: Create, review, validate, and version Easy BI v2 declarative or v3 isolated-script report packages from a semantic knowledge catalog. Use for report planning, safe query strategy selection, package generation, validation, preview, and Excel export.
---

# Create Report Package

Use conversation for business confirmation and the bundled CLI for deterministic inspection, planning, generation, checksums, and validation. One Skill serves every report; never create a Skill per report.

Before changing formats, commands, Runtime APIs, outputs, or workspace paths, read [目录与项目兼容性规范](../目录与项目兼容性规范.md) completely.

## Context loading policy

Keep the default prompt small and cross phase boundaries with fresh Agent sessions:

1. Read this file.
2. Run `inspect`, `init-model`, and the `discovery` phase context; do not write code. Natural-language totals and status counts are metric intents, not missing physical fields.
3. Discovery uses requirement-driven retrieval: at most 6 tables, 80 fields, and a 64 KB knowledge slice containing candidate fields, enum evidence, and relevant relationships. Put only unresolved business semantics in structured `open_questions` and end the Agent turn; field availability, context expansion, and execution strategy are technical decisions and must not be sent to the user. The discovery Agent must not ask interactively.
4. When business questions exist, Studio shows one consolidated confirmation. When none exist, Studio creates the revision-bound `confirmation.json` automatically. In both cases it then starts a fresh modeling Agent that reads only that artifact plus the `modeling` context under `work/report-model/<report-id>/<revision>`.
5. Deterministically validate, approve, and promote one current model package to `reports/models/<report-id>/`. Contract-only failures are repaired in a bounded provider-fresh run inside the same phase and never reopen business confirmation. The package contains only the model, semantic/execution plans, optional declarative configuration, and the compact `source.lock.json`.
6. A later, independent **Generate Report** action copies only that approved current model into `work/report-build/<report-id>/<revision>`. It must not rediscover knowledge or ask another business question.
7. Compile each v3 query from its own `query` context, then start another fresh session with only the `script` context. Declarative strategies skip the script session.
8. Select one strategy and load only its sections from [报表与 Runtime 技术规范](references/报表与Runtime技术规范.md):
   - simple SQL/JOIN: plan, SQL, filters, validation;
   - enrichment: additionally §8.1;
   - grouped multi-query: additionally the `group_queries` section;
   - isolated script: additionally §18.
6. Read [使用说明](使用说明.md) only for operator or administrator questions.

Never recursively read the knowledge directory, table samples, scan history, connection configuration, unrelated reports, or the whole technical reference by default. If the slice cannot resolve one planned relation, rebuild it with explicit `--include` tables; do not restart the whole reasoning process.

## Non-negotiable rules

- Reuse `knowledge.report_requirements`; do not ask users to repeat confirmed fields.
- State target result grain before choosing a query strategy.
- Generate and review a semantic plan plus execution plan before package code.
- Use one logical Studio conversation but never resume a provider session across discovery, modeling, query compilation, and script compilation.
- Hand phases off only through approved, hashed artifacts and generated Context Packs.
- Ask only about unresolved business semantics, in one consolidated question.
- One report requirement owns exactly one current model package and one current development report package.
- Manual model edits may change only the current source-field whitelist and relationships; revalidate and reseal the model before generation.
- Read hot tables before warm tables; never infer fields from cold summaries.
- Never concatenate request values into SQL. Only package-declared bindings and fixed operators are allowed.
- Do not run DDL, DML, stored procedures, network calls, filesystem access, or direct database APIs from a report script.
- Keep DB, Excel, OSS, HTTP, queue, cancellation, logging, and errors in the shared Runtime.
- Put only report-specific lineage, queries, transforms/scripts, tests, budgets, and locks in a package.
- Allow sync and async by default. Do not fix one mode unless explicitly required.
- Keep tenant context hidden from visible parameters and bind it only when supplied.
- Never edit a published report version in place. Generate a new version.
- A draft catalog may produce only a development package; production needs published knowledge and release signing.
- Keep `bundle.manifest.json`, compatibility ranges, commands, and checksums synchronized after public changes.

## 1. Check dependencies

Generation needs Node.js. Runtime additionally needs the pinned database, Excel, and OSS adapters:

```bash
npm run bootstrap:core
node dist/scripts/report-package-cli.js doctor
```

When maintaining the Skill:

```bash
npm run bootstrap:runtime
npm run bootstrap:dev
npm test
```

Bootstrap commands must inspect pinned local dependencies first and download only missing or mismatched packages.

## 2. Discover and model before code

```bash
node dist/scripts/report-package-cli.js inspect \
  --workspace <workspace> \
  --knowledge <knowledge-directory> \
  --report-id <report-id> \
  --out <workspace>/reports/plans/<report-id>.json

node dist/scripts/report-package-cli.js build-context \
  --plan <workspace>/reports/plans/<report-id>.json \
  --out <workspace>/work/<report-id>-context.json

node dist/scripts/report-package-cli.js init-model \
  --plan <workspace>/reports/plans/<report-id>.json \
  --out <workspace>/work/report-model/<report-id>/<revision>/discovery-model.json

node dist/scripts/report-package-cli.js build-phase-context \
  --phase discovery \
  --plan <workspace>/reports/plans/<report-id>.json \
  --out <workspace>/work/report-model/<report-id>/<revision>/discovery/context.json
```

The inspector resolves required fields, aliases, visible filters, hidden conditions, tenant binding, deterministic ordering, source lineage, blockers, and an initial semantic/execution plan. It must not create enum questions.

The context slice contains only scored candidate sets, selected semantic/physical fields,
referenced enums, relevant relationships, indexes, conditions, and security metadata. Discovery
defaults to 6 tables, 80 fields, a 64 KB knowledge slice, and a 100 KB complete phase context.
The byte and field budgets are both enforced before Agent startup. It excludes samples, secrets,
configuration, and history. If a planned relation is absent:

```bash
node dist/scripts/report-package-cli.js build-context \
  --plan <plan-file> \
  --include database.table,other_database.other_table \
  --max-tables 12 \
  --max-fields 120 \
  --max-bytes 96000 \
  --out <context-file>
```

Extend the existing plan; do not repeatedly rerun a broad discovery pass.

The discovery Agent must output only the draft result grain, source field whitelist,
relationships/cardinalities, `metric_hypotheses`, metric distinct keys, time/exclusion semantics,
recommended strategy, `relationship_hypotheses`, and structured `open_questions`
(`id/question/options/recommended/required/affected_metrics/impact`). Each `open_questions` entry
MUST be a JSON object — strings are rejected by the validator. Example:

```json
{
  "id": "q_order_count_semantics",
  "question": "「订单数」的统计口径如何定义？",
  "options": [
    { "value": "all_orders", "label": "所有订单（含已取消）" },
    { "value": "valid_only", "label": "仅有效订单（排除取消/拒收）" }
  ],
  "recommended": "valid_only",
  "required": true,
  "affected_metrics": ["订单数总和"],
  "impact": "决定订单数 COUNT 的 WHERE 条件"
}
```

It must not call an interactive question tool,
generate SQL, scripts, or packages. Write it to
`work/report-model/<report-id>/<revision>/discovery-model.json`, then end the phase.
**JSON hygiene**: JSON string values must not contain unescaped ASCII `"` or
Chinese `""` quotation marks — use `「」` for inline quoting instead. After
writing, always validate with `python3 -m json.tool <file>` before ending. Studio
runs `validate-stage --phase discovery` and shows the only user confirmation boundary.

Persist that response before starting a provider-fresh modeling Agent:

```bash
node dist/scripts/report-package-cli.js confirm-discovery \
  --model <discovery-model> \
  --input <confirmation-input.json> \
  --out <workspace>/work/report-model/<report-id>/<revision>/confirmation.json \
  --reviewed-by "<reviewer>"

node dist/scripts/report-package-cli.js build-phase-context \
  --phase modeling --plan <plan-file> --model <discovery-model> \
  --confirmation <workspace>/work/report-model/<report-id>/<revision>/confirmation.json \
  --out <workspace>/work/report-model/<report-id>/<revision>/modeling/context.json
```

The modeling Agent resolves the confirmed model, semantic plan, execution plan, and one
`query_contract` per independently compiled query. Write them only to
`work/report-model/<report-id>/<revision>/{report-model.json,semantic-plan.json,execution-plan.json}`
and clear `open_questions`. **Never write modeling output to `work/report-build/`** — that
directory is exclusively for the separate "Generate Report" action (see §5).
`report-model.json.confirmation` must copy the discovery revision and
confirmation hash from `confirmation.json`. There is no second user approval: this immutable
artifact is the only approval input. Studio deterministically validates, approves, and promotes
the result.

When `recommended_strategy` is `sql`, `enrichment`, or `group_queries`, also write
`declarative-configuration.json` in the same revision. It is stored in the current model package
as generation input; no report package is generated during modeling.

```bash
node dist/scripts/report-package-cli.js validate-stage \
  --phase modeling --plan <plan-file> --root <workspace>/work/report-model/<report-id>/<revision>
node dist/scripts/report-package-cli.js finalize-staged-model \
  --plan <plan-file> \
  --root <workspace>/work/report-model/<report-id>/<revision> \
  --out <workspace>/reports/models/<report-id> \
  --reviewed-by "<reviewer>"
```

`reports/models/<report-id>/` is the only generation input. Studio may expose its selected
fields and relationships for manual editing. Saving an edit must validate every selected field
against the knowledge catalog, synchronize query contracts and the compact source lock, update
the model hash and plan reference, and reseal checksums.

### 2a. 修改当前模型（仅当用户显式要求时）

当用户通过「AI 修改模型」动作进入时，当前报表的 `reports/models/<report-id>/report-model.json`
已经存在且已确认。此流程**不是**重新建模，而是对现有模型的定向修改。

**前置条件：**
- `reports/models/<report-id>/report-model.json` 存在且 `status === "approved"` 或 `"draft"`
- 知识库中对应表的 catalog 可读
- 用户表达了明确的修改意图

**允许的修改范围：**
- 增/减 source 的 fields（仅在知识库已有字段范围内）
- 调整 relationship 的 type、cardinality
- 增/删 relationship
- 修改 comparison（环比/同比）配置
- 修改 filters / metrics 的口径描述

**禁止的修改：**
- 改变 `result_grain` 或 `strategy`
- 新增 source 表（超出知识库范围）
- 重新扫描数据库或跑 discovery
- 重新询问全局业务确认问题

**流程：**

1. 读取当前模型和 `source.lock.json`，了解已有字段和关系。
2. 理解用户的修改意图；如果涉及歧义（如"把那个字段去掉"但未指明具体字段），简要提问确认。
3. 直接编辑 `report-model.json`，修改完成后运行：
   ```bash
   node dist/scripts/report-package-cli.js finalize-staged-model \
     --report-id <report-id> \
     --root <workspace>/work/report-model/<report-id>/<revision> \
     --out <workspace>/reports/models/<report-id> \
     --reviewed-by "<reviewer>"
   ```
4. 向用户列出变更清单（字段 X 个变更、关系 Y 个变更、对比配置 Z 个变更）。
5. 不自动触发生成报表包；用户需手动触发「生成报表」动作。

## 3. Choose exactly one execution strategy

Do not decide only from table count:

- One table, or only n:1 dimensions that preserve grain: one SQL query with JOINs.
- One 1:n child only attaches values to detail rows: enrichment with bounded batch lookup.
- One fact entity summarized by dimensions: SQL `GROUP BY` or bounded group transform.
- Independent fact entities or an n:n/multiple-1:n fan-out: `group_queries`, one independently aggregated query per entity, then merge by stable key.
- Multi-stage lookup, pivot, branching, cross-profile routing, or logic not expressible above: v3 isolated script.

More than three tables is not automatically wrong; fan-out and unclear grain are. Conversely, an n:n relationship can make even three tables unsafe for one large SQL.

For grouped metrics, merge by stable IDs, not display names. Confirm only unresolved items: result grain, distinct key per metric, inclusion rules, time field per entity, exclusions/logical delete, and how shared n:n records are counted.

## 4. Write semantic and execution plans

Apply one reviewed configuration:

```bash
node dist/scripts/report-package-cli.js configure-plan \
  --plan <plan-file> \
  --configuration <configuration.json>

node dist/scripts/report-package-cli.js explain-plan --plan <plan-file>
```

The semantic plan must state:

- target result grain and grouping dimensions;
- metric definitions and distinct keys;
- time semantics;
- inclusion/exclusion and logical-delete rules;
- unresolved questions.

The execution plan must state, in order:

- each SQL/query/index/batch step and why it exists;
- inputs, output keys, expected cardinality, and merge key;
- where calculations and deduplication occur;
- resource budget and final emit step.

Do not write package code before review. If decisions are missing, ask one clear consolidated question, update the configuration, and explain again. When approved:

```bash
node dist/scripts/report-package-cli.js approve-plan \
  --plan <plan-file> \
  --reviewed-by "<reviewer>"
```

For a staged model, plan approval additionally verifies the attached model hash and rejects
queries or sources outside its whitelist.

## 5. Compile queries and script in separate contexts

This section belongs to the separate **Generate Report** action. Before starting, validate
`reports/models/<report-id>/report-model.json` with `--require-approved true`, copy that minimal
model package into a new `work/report-build/<report-id>/<revision>`, and do not read the full
knowledge catalog.

For every approved `query_contract`, start a fresh query compiler with only that contract,
its dialect, and its exact field/relationship slice:

```bash
node dist/scripts/report-package-cli.js build-phase-context \
  --phase query --plan <plan-file> --model <approved-model> \
  --query-id <query-id> --out <query-context>
```

Generate only `work/report-build/<report-id>/<revision>/queries/<id>.sql` and
`work/report-build/<report-id>/<revision>/query-outputs/<id>.json`. Every outer SELECT item must use an explicit `AS <contract-column>` in contract order. A query context defaults to
at most three tables and forty fields. If it needs more, split the query contract or return a
structured `QUERY_*` failure; never silently load more knowledge.

After all query outputs validate, start another fresh script compiler:

```bash
node dist/scripts/report-package-cli.js build-phase-context \
  --phase script --plan <plan-file> --model <approved-model> \
  --query-outputs <query-output-directory> \
  --out <script-context>
```

This context intentionally excludes physical tables and contains only result grain,
semantic/execution plans, query output schemas, and the four v3 context APIs. Generate the
orchestration script at `work/report-build/<report-id>/<revision>/scripts/report.ts`. Route failures with `--phase repair --failure` to
modeling, one query, script, or runtime instead of replaying the entire workflow.

## 6. v2 declarative packages

Use v2 for SQL, safe JOIN/aggregation, computed transforms, enrichment, and `group_queries`. Configuration may declare `joins`, field overrides, aggregation/HAVING, computed dependencies, `custom_logic`, enrichment, comparison, or sibling group queries.

Important routing rules:

- Same-profile cross-database JOIN is allowed; cross-profile single SQL is not.
- Put child logical-delete conditions in JOIN `ON`; put primary conditions in `WHERE`.
- A filter on a concatenated 1:n field uses a knowledge-built correlated `EXISTS`, not in-memory filtering.
- Numeric computed filters run post-transform; unsupported computed filters must be surfaced for confirmation.
- Decimal transforms accumulate scaled integers and divide once at the end.
- `group_queries` independently aggregate facts and full-outer-merge on declared stable keys, preventing fan-out inflation.
- Enrichment batches one bounded secondary lookup and is not used to hide an unbounded multi-stage workflow.

Load the matching detailed section from the technical reference only after choosing one of these features.

## 7. v3 isolated script packages

Use `configuration.script_report` only when the reviewed strategy is `script`. Declare every query and every knowledge source explicitly:

- `mode=stream`: large driving rows through `ctx.queryStream(queryId, values)`;
- `mode=index`: bounded reference rows through `ctx.loadIndex(queryId, values, keyFields)`;
- `mode=batch`: key lookup through `ctx.batchLookup(queryId, keys, values)` and exactly one `/* KEYS */` marker;
- output only through `await ctx.emit(row)`.

Rules:

- At least one stream query is required.
- Each query has its own profile, database, dialect, SQL file, exact table/column sources, and knowledge lock.
- A single SQL query uses only one connection profile. The script may orchestrate separate queries across profiles.
- `report.ts` is editable source; generation strips supported TypeScript annotations into `report.mjs`.
- Script source cannot import, require, evaluate code, access process/global state, filesystem, network, workers, or direct DB clients.
- SQL is read-only `SELECT`/CTE and parameterized. Batch keys precede fixed positional values.
- Runtime owns all connections and runs the script in a permission-restricted child process.
- Declare positive limits for queries, query/index/output rows, batch keys, memory, timeout, and stream batch rows. Runtime applies the smaller of package and global ceilings.
- Budget overflow is an explicit failure. HTTP disconnect, execution cancellation, or task cancellation aborts queries and terminates the child.

The script should stream the largest fact set, index only genuinely small data, batch n:n lookups, calculate in memory with bounded state, and emit incrementally. It must not load every fact table into maps.

## 8. Deterministically assemble, generate, and validate

For the staged v3 workflow, never hand-edit `plan.script_report`. Studio runs one command after
the script Agent completes; it validates the approved model and every SQL/output contract,
assembles configuration, updates and approves the plan, generates the package, and validates it:

```bash
node dist/scripts/report-package-cli.js finalize-staged \
  --workspace <workspace> --plan <plan-file> \
  --root <workspace>/work/report-build/<report-id>/<revision> --reviewed-by "<reviewer>"
```

Any missing file, model hash drift, column name/order/type mismatch, unsafe SQL/script, source
outside the table/field whitelist, or package validation failure blocks the phase. Fix only the
current stage; do not advance or replay all prior context.

For the non-staged declarative workflow:

```bash
node dist/scripts/report-package-cli.js generate \
  --workspace <workspace> \
  --plan <approved-plan>

node dist/scripts/report-package-cli.js validate \
  --workspace <workspace> \
  --package <package-directory>
```

Default output is `reports/packages/<report-id>/<version>/`. Generation also updates
`reports/index.json`. The one current development package may be replaced atomically after its
candidate validates; a published or unregistered target is never overwritten.

Validation must pass plan approval, schema, lineage locks, query safety, dialect quoting, script safety, resource budgets, required files, checksums, filters, ordering, and execution policy. A static pass is not a real export test.

For an intentional development edit:

```bash
node dist/scripts/report-package-cli.js reseal \
  --workspace <workspace> \
  --package <package-directory>
```

Reseal only after validating the changed query/script and preserving approved semantics. Never reseal a published version in place.

## 9. Runtime verification

Start the shared Runtime from the installed bundle manifest. Do not copy its code into a report package.

Required verification for a changed report:

1. list/parameters load;
2. preview returns expected columns and bounded rows;
3. sync export creates a valid xlsx;
4. async path either completes or returns the documented missing-integration error;
5. cancellation stops active work;
6. empty results, budget failures, restart, and errors use standard envelopes.

Relevant control APIs:

- `POST /api/v1/queries` for preview;
- `POST /api/v1/exports` for sync/async export;
- `DELETE /api/v1/executions/{requestId}` for an active synchronous execution;
- `DELETE /api/v1/tasks/{runtimeTaskId}` for queued/running asynchronous work.

The caller may set `X-Request-Id` to obtain a stable synchronous cancellation ID. Successful sync export returns xlsx; other business results and failures use JSON with HTTP 200 according to the shared contract.

## 10. Modify and version

Edit or rebuild the one current model first, then run **Generate Report** again. A development
current package is atomically replaced only after the candidate passes all gates. Preserve
published package versions and never overwrite them in place.

## 11. Reject legacy formats

Plan format v1 and report package v1 are unsupported: do not generate, migrate, validate, or execute them. The workspace owner must explicitly remove legacy index entries/assets, then regenerate v2 or v3 from current knowledge. HTTP `/api/v1` is an independent API version and does not imply report format v1.
