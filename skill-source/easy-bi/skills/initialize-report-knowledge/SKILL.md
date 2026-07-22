---
name: initialize-report-knowledge
description: Initialize, review, maintain, and publish a portable report-oriented semantic knowledge base from one or more MySQL connections and databases. Use when configuring an Easy BI project, collecting planned report names and required fields as relevance evidence, scanning MySQL metadata, classifying tables into hot/warm/cold tiers, reviewing database semantics, promoting warm or cold tables, maintaining enum meanings through Excel, comparing rescans, or publishing a knowledge version for report generation.
---

# Initialize Report Knowledge

Use conversation for user decisions and the bundled TypeScript CLI for deterministic discovery, file generation, validation, and publication.

Before changing this Skill, its outputs, formats, commands, or workspace paths, read [Easy BI Skill 与项目目录兼容性规范](../目录与项目兼容性规范.md) completely. Treat the stable directory and upgrade rules in that document as public contracts.

Before executing the workflow, read [知识库技术规范](references/知识库技术规范.md) once. It is the single detailed reference for workspace ownership, connectors, multi-database identity, classification, catalog structure, semantic defaults, relationships, and enums.

For developer and administrator operation examples, use [使用说明](使用说明.md). Do not load it during routine Agent execution unless the user asks how to operate the Skill.

## Non-negotiable rules

- Support MySQL only.
- Ask initially only for host, port, username, password or password environment variable, and all database names for each connection.
- Generate project identity and scanning defaults; let the user edit them later.
- Do not ask for OSS, delivery, callback, or Linux settings during knowledge initialization.
- Read metadata and bounded time-field activity only. Prefer indexed latest-value queries; when no time index exists, allow a timeout-limited recent-data existence query. Never execute DDL or DML.
- Never copy credentials into snapshots, catalogs, logs, or published versions.
- Treat reliable inactivity as a fixed cold-table rule unless the table is forced hot or is a strong planned/published report dependency.
- Require explicit user approval before building from a tier plan.
- Generate editable drafts and never overwrite human semantic edits on rescan.
- Store authored knowledge by `databases/<profile-id>/<database>`.
- Keep `../bundle.manifest.json` path mappings and compatibility ranges synchronized with any public output change.
- Store cold tables without field details.
- Never edit a published version in place.
- Apply semantic and filter defaults before asking questions. Never generate a fixed questionnaire for every hot table.
- Ask at most one consolidated question per stage and only use post-build questions from `reviews/blocking-issues.json`.

## 1. Check before preparing dependencies

The packaged Skill contains compiled `dist/` files. From the Skill directory, check knowledge-core dependencies before doing any download:

```bash
npm run bootstrap:core
node dist/scripts/catalog-cli.js doctor --scope knowledge
```

`bootstrap:core` must first inspect local `node_modules` and pinned versions. If all required packages already exist and match, skip `npm ci` and all network access. Install only when a required dependency is missing or mismatched. Do not install Excel or Runtime dependencies at this point.

For development of this design implementation:

```bash
npm run bootstrap:dev
npm test
```

`bootstrap:dev` applies the same local-first rule to core, optional, and development dependencies.

## 2. Initialize the workspace

Generate identifiers when the user does not supply them:

```bash
node dist/scripts/catalog-cli.js init-workspace \
  --root <workspace> \
  --system-id <generated-system-id> \
  --system-name "<generated-system-name>"
```

One workspace represents one customer business system.

## 3. Configure MySQL

For each connection collect:

1. host;
2. port, default 3306;
3. username;
4. password or `password_env`;
5. every database name belonging to the project.

Use one Profile for the same host, port, credentials, and network boundary. Use separate Profiles otherwise.

Write the choices to `<workspace>/config/easy-bi.json`. Apply default classification thresholds:

```json
{
  "hot_threshold": 80,
  "cold_threshold": 25
}
```

Validate only the knowledge scope:

```bash
node dist/scripts/catalog-cli.js validate-config \
  --scope knowledge \
  --config <workspace>/config/easy-bi.json
```

Then test visibility of every configured database:

```bash
node dist/scripts/catalog-cli.js test-connections \
  --config <workspace>/config/easy-bi.json
```

Stop on missing databases or unsupported connectors.

## 4. Configure planned report requirements

Immediately after all database connections pass, point the user to:

```text
<workspace>/config/easy-bi.json
```

Explain that only `knowledge.report_requirements` needs to be edited for planned reports. Show this format before discovery:

```json
"report_requirements": [
  {
    "id": "driver-basic-detail",
    "name": "司机基础信息明细",
    "required_fields": [
      { "field": "base_primary_driver.code", "label": "司机编码" },
      { "field": "base_primary_driver.name", "label": "司机姓名" },
      { "field": "base_primary_driver.phone", "label": "手机号" }
    ]
  }
]
```

Use [report-requirements.example.json](assets/report-requirements.example.json) as the complete editable driver-report default for testing. Copy its `report_requirements` array into the configuration only when the user accepts this default or the project contains `base_primary_driver`; otherwise replace it with the user's report.

For each report:

- require `name` and at least one `required_fields` item;
- generate a stable lowercase `id` when omitted;
- recommend `{ "field": "table.field", "label": "业务列名" }` so both the physical match and expected display name are explicit;
- allow an optional `filter` object only when the report must override project defaults;
- also accept Chinese business names, physical field names, `table.field`, or `database.table.field` strings;
- collect only desired output fields at this stage, not SQL, filters, OSS, or final report-package logic.

Then optionally ask for core business words, forced-hot tables, and known deprecated or technical table patterns. Do not ask table-by-table questions.

Write the confirmed values into `knowledge.report_requirements`, rerun `validate-config`, summarize the report names and field counts, and obtain confirmation before `discover`. If the user has no planned report yet, record an explicitly confirmed empty array and continue.

Use report requirements as table-classification evidence:

- a qualified physical field match is strong evidence;
- two or more required fields from the same report matching one table is strong evidence;
- a report-name match plus a required-field match is strong evidence;
- one unqualified generic field match is weak evidence and must not make a table hot by itself.

Do not silently keep the driver example for an unrelated customer project.

## 5. Discover and compare

Create a new scan:

```bash
node dist/scripts/catalog-cli.js discover \
  --config <workspace>/config/easy-bi.json \
  --out <workspace>/knowledge/scans/<scan-id>/snapshot.json
```

The snapshot records MySQL version, databases, tables, fields, indexes, foreign keys, comments, schema fingerprints, and bounded activity evidence.

For activity evidence, apply this order:

1. Prefer an indexed time field and read its latest value.
2. If no candidate time field has an index and `require_index` is `false`, query whether any row exists within `inactivity_days` using at most `unindexed_max_columns` time fields.
3. Apply `MAX_EXECUTION_TIME`; a timeout produces `activity_unknown`, never a cold conclusion.
4. A completed query with no recent row is reliable inactivity evidence. Classify the table as cold unless it is forced hot or is a strong planned/published report dependency.

When a previous snapshot exists:

```bash
node dist/scripts/catalog-cli.js diff-snapshots \
  --previous <previous-snapshot> \
  --current <current-snapshot> \
  --out <workspace>/knowledge/scans/<scan-id>/diff.json
```

Present added, removed, and changed tables before applying any semantic maintenance.

## 6. Propose and approve tiers

```bash
node dist/scripts/catalog-cli.js propose \
  --snapshot <snapshot> \
  --hints <workspace>/config/easy-bi.json \
  --out <workspace>/knowledge/scans/<scan-id>/catalog-plan.json
```

Present:

- hot candidates with score and evidence;
- warm candidates grouped by database;
- cold candidates summarized by category;
- semantic/activity conflicts;
- missing or conflicting forced-hot choices.

Let the user adjust `final_tier`. After explicit confirmation, approve through the deterministic CLI (manual JSON editing remains supported):

```bash
node dist/scripts/catalog-cli.js approve-plan \
  --plan <catalog-plan.json> \
  --approved-by "<reviewer>" \
  --decision "<tier approval summary>"
```

## 7. Build the database-navigated draft

```bash
node dist/scripts/catalog-cli.js build \
  --snapshot <snapshot> \
  --plan <approved-plan> \
  --config <workspace>/config/easy-bi.json \
  --out <workspace>/knowledge/drafts/<draft-id>
```

Treat `databases`, `global`, and `reviews` as authored sources. Treat `indexes` as generated files.

The builder automatically:

- infers the business entity from the table comment;
- maps confirmed report fields to semantic labels, report exposure, and lineage;
- generates structured exact, fuzzy, range, enum, tenant, user, and organization filters;
- keeps tenant IDs/codes out of visible filters while allowing them as optional task-API `request_context` parameters;
- converts conventional logical-delete fields such as `is_delete` into mandatory hidden system conditions;
- records confirmed foreign keys and conservative, unverified `_id → id` relationship candidates when exactly one same-database target matches;
- writes `reviews/inference-summary.json` and `reviews/blocking-issues.json`;
- initializes all hot/warm enum bindings immediately after build, prefilling native
  `ENUM/SET`, comment mappings, and bounded read-only distinct codes when the
  optional `--config` is supplied; scan failure is recorded and never blocks build;
- defers enum Chinese labels and unused JSON/ext fields.

The automatic enum step is idempotent: rerunning it may add newly observed codes
but must never overwrite an existing human label. It is also available separately:

```bash
node dist/scripts/catalog-cli.js enums-init \
  --catalog <draft> \
  --config <workspace>/config/easy-bi.json
```

If `blocking-issues.json` is clear, do not ask table-by-table semantic questions. Present one inference summary and continue to optional batch review. If blockers exist, ask one consolidated question containing only those blockers.

## 8. Promote tables when requested

Promote a warm table:

```bash
node dist/scripts/catalog-cli.js promote \
  --catalog <draft> \
  --table <profile/database/table> \
  --to hot \
  --reason "<user reason>"
```

Promoting a cold table must restore field details from the matching scan:

```bash
node dist/scripts/catalog-cli.js promote \
  --catalog <draft> \
  --snapshot <snapshot> \
  --table <profile/database/table> \
  --to hot \
  --reason "<user reason>"
```

Record the user override and regenerate indexes.

## 9. Review enum meanings through Excel

Check the Excel feature only when this step is needed:

```bash
npm run bootstrap:excel
```

`bootstrap:excel` must skip installation when the pinned core and Excel dependencies already exist locally. Download only missing or mismatched packages.

Export candidates:

```bash
node dist/scripts/catalog-cli.js enums-export \
  --catalog <draft> \
  --out <workspace>/work/枚举配置.xlsx
```

The workbook has two fixed worksheets:

- `枚举字段绑定`: one row per hot/warm enum field, with columns `连接`, `数据库`, `表`, `字段`, `字段说明`, and `枚举名称`. Keep the first five columns unchanged. Fields with the same `枚举名称` share one value dictionary. To merge or split dictionaries, edit only `枚举名称`.
- `枚举值映射`: one row per shared `枚举名称 + 枚举code → 中文名称`, with columns `枚举名称`, `枚举code`, `中文名称`, and `说明`. Add as many rows as needed for that enum name.

Every detected enum candidate in hot and warm tables must have a binding, and every referenced enum name must have at least one complete code/name mapping before import. A mapping is active when both `枚举code` and `中文名称` are filled. Do not expose an enum ID, order, enabled, or confirmation column. Keep enum codes as text so leading zeros and large numeric codes are preserved.

The exporter reuses previously imported enum names and labels. For unbound candidates, it may merge fields only when a physical field name, normalized comment, and full type agree. Generic fields named exactly `status`, `type`, `source`, `flag`, `category`, `level`, or `mode` stay table-specific unless matching native ENUM/SET values or explicit comment mappings provide value evidence, or the customer explicitly gives them the same enum name. Native ENUM/SET values and explicit code/name pairs in field comments are prefilled when possible. Generic `code`, `user_code`, and `carrier_code` fields remain identifiers unless stronger dictionary evidence exists.

Preview import:

```bash
node dist/scripts/catalog-cli.js enums-import \
  --catalog <draft> \
  --file <workspace>/work/枚举配置.xlsx \
  --dry-run
```

The dry run reports dictionary and field-binding additions, updates, removals, and unchanged items. Resolve all completeness errors and conflicts, then import without `--dry-run`. Import is authoritative for the draft: rows removed from the workbook remove the corresponding dictionary or binding. Never import directly into a published version.

## 10. Present a batch semantic summary (optional)

Do not repeat decisions already derived from a table comment, report requirements, or semantic defaults. Only surface unresolved blockers and any user-selected deferred categories. Present inferred business names, exposed field counts, filter role counts, scope fields, and enum-candidate counts as one summary so the human can inspect the generated semantics.

Use `confirmed` only for user-confirmed semantics; keep automatic values `inferred`. This summary is now informational — publish no longer requires an explicit `approved` semantic-review status. Human inspection of the generated catalog followed by choosing to publish IS the review.

Validate repeatedly:

```bash
node dist/scripts/catalog-cli.js validate --catalog <draft>
```

## 11. Publish

Publish whenever the catalog passes readiness (no separate semantic-review approval step is required):

```bash
node dist/scripts/catalog-cli.js publish \
  --catalog <draft> \
  --workspace <workspace> \
  --version <semver> \
  --published-by <name-or-id> \
  --decision "<approval summary>"
```

The CLI validates publish readiness, copies the draft to `knowledge/versions/<version>`, and updates `knowledge/index.json`.

Publish readiness enforces **data quality** and **structural integrity only** — it does NOT require an approved semantic review:

- every hot table has a usable business name with status `inferred`/`confirmed` and a usable security scope; report-dependent hot tables expose at least one field;
- table IDs are unique, tier counts match the manifest, cold tables carry no field detail, no secret-like keys are present, and `catalog_status` is `ready`/`published`.

Tables whose semantics are not yet usable should be corrected or demoted to warm/cold rather than blocking the whole publish.

## Resources

- `scripts/catalog-cli.ts`: deterministic TypeScript CLI source.
- `tests/catalog-cli.test.ts`: offline workflow regression tests.
- `package.json` and `npm-shrinkwrap.json`: pinned Node.js dependencies.
- `assets/easy-bi-config.example.json`: multi-database configuration example.
- `assets/report-requirements.example.json`: editable driver-report requirement default.
- `使用说明.md`: developer and administrator guide for Agent prompts, CLI flow, outputs, and troubleshooting.
- `references/知识库技术规范.md`: the single detailed contract for workspace, connectors, classification, catalog, semantics, relationships, and enums.
- `../目录与项目兼容性规范.md`: shared directory and compatibility contract between the Easy BI project and both Skills.
