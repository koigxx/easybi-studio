import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  approveCatalogPlan,
  buildCatalog,
  configTemplate,
  diffSnapshots,
  dumpJson,
  exportEnums,
  importEnums,
  importEnumsJson,
  initEnums,
  initWorkspace,
  jsonHash,
  loadJson,
  parseCli,
  promoteTable,
  probeActivity,
  propose,
  runCli,
  tableId,
  validateCatalog,
  validateConfig,
} from "../scripts/catalog-cli.js";
import { getDialect } from "../scripts/dialect.js";

const MYSQL = getDialect("mysql");

function column(name: string, comment: string, nativeType = "varchar(255)") {
  return {
    name,
    ordinal: 1,
    data_type: nativeType.split("(")[0],
    native_type: nativeType,
    nullable: false,
    default: null,
    comment,
    primary_key: name === "id",
    extra: "",
  };
}

function table(name: string, columns: any[], fingerprint: string, inactiveDays = 1) {
  const id = tableId("transport-mysql", "transport", name);
  return {
    table_id: id,
    physical: { profile_id: "transport-mysql", database: "transport", table: name },
    table_type: "BASE TABLE",
    comment: name,
    estimated_rows: 10,
    columns,
    indexes: [{ name: "PRIMARY", unique: true, columns: ["id"] }],
    foreign_keys: [],
    activity: {
      status: "observed",
      field: "updated_at",
      method: "indexed_desc_limit_1",
      last_data_at: "2026-07-15T00:00:00Z",
      inactive_days: inactiveDays,
      confidence: "high",
    },
    schema_fingerprint: fingerprint,
  };
}

function snapshot(tables: any[]) {
  const value: any = {
    snapshot_version: "2",
    tool_version: "0.7.0",
    generated_at: "2026-07-16T00:00:00Z",
    system: { id: "transport-system", name: "运输系统" },
    policy: {
      inactivity_days: 90,
      classification: { hot_threshold: 80, cold_threshold: 25 },
    },
    sources: [
      {
        id: "transport-mysql",
        connector_id: "mysql",
        engine: "mysql",
        databases: ["transport"],
      },
    ],
    tables,
  };
  value.snapshot_hash = jsonHash(value);
  return value;
}

async function tempRoot() {
  return mkdtemp(join(tmpdir(), "easybi-ts-"));
}

async function captureStdout(action: () => Promise<unknown>): Promise<string> {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await action();
    return output;
  } finally {
    process.stdout.write = original;
  }
}

test("CLI parses equals syntax and reserves global version for no-subcommand use", async () => {
  assert.deepEqual(
    parseCli(["publish", "--catalog=/tmp/catalog", "--version=1.2.3", "--dry-run"]),
    {
      command: "publish",
      options: {
        catalog: "/tmp/catalog",
        version: "1.2.3",
        "dry-run": true,
      },
    },
  );
  assert.equal(await captureStdout(() => runCli(["--version"])), "0.10.0\n");
  await assert.rejects(
    () => captureStdout(() => runCli(["publish", "--version", "1.2.3"])),
    /--catalog is required/,
  );
});

test("approve-plan records decision and enables deterministic catalog build", async () => {
  const root = await tempRoot();
  const current = snapshot([
    table(
      "driver",
      [
        column("id", "主键", "bigint"),
        column("name", "司机姓名"),
        column("create_time", "创建时间", "datetime"),
      ],
      "driver-hash",
    ),
  ]);
  const plan = propose(current, {
    forced_hot_tables: [],
    business_semantics: ["司机"],
    report_scenarios: [],
    report_requirements: [],
  });
  const planPath = join(root, "catalog-plan.json");
  const snapshotPath = join(root, "snapshot.json");
  const out = join(root, "catalog");
  await dumpJson(planPath, plan);
  await dumpJson(snapshotPath, current);
  await assert.rejects(buildCatalog(current, plan, out), /not approved/);
  const result = await approveCatalogPlan(planPath, "tester", "确认热温冷分层");
  assert.equal(result.approval.status, "approved");
  assert.equal(result.approval.approved_by, "tester");
  assert.equal(result.approval.decision, "确认热温冷分层");
  const approved = await loadJson(planPath);
  assert.equal(approved.status, "approved");
  await buildCatalog(await loadJson(snapshotPath), approved, out);
  assert.equal((await loadJson(join(out, "manifest.json"))).catalog_format_version, "3");
});

test("CLI build automatically initializes native enum bindings", async () => {
  const root = await tempRoot();
  const order = table(
    "transport_order",
    [
      column("id", "主键", "bigint"),
      column("status", "订单状态", "enum('CREATED','DONE')"),
    ],
    "order-auto-enum",
  );
  const current = snapshot([order]);
  const hints = configTemplate("transport-system", "运输系统");
  hints.knowledge.forced_hot_tables = [order.table_id];
  const plan = propose(current, hints);
  plan.approval = {
    status: "approved",
    approved_by: "tester",
    approved_at: "2026-07-19T00:00:00Z",
    decision: "批准",
  };
  const snapshotPath = join(root, "snapshot.json");
  const planPath = join(root, "plan.json");
  const configPath = join(root, "config.json");
  const draft = join(root, "knowledge", "drafts", "auto-enums");
  await dumpJson(snapshotPath, current);
  await dumpJson(planPath, plan);
  await dumpJson(configPath, hints);
  const output = await captureStdout(() =>
    runCli([
      "build",
      "--snapshot",
      snapshotPath,
      "--plan",
      planPath,
      "--config",
      configPath,
      "--out",
      draft,
    ]),
  );
  assert.equal(JSON.parse(output).enum_initialization.ok, true);
  const enums = await loadJson(join(draft, "global", "enums.json"));
  const binding = enums.bindings.find((item: any) => item.field === "status");
  assert.ok(binding);
  const dictionary = enums.dictionaries.find(
    (item: any) => item.name === binding.dictionary_name,
  );
  assert.deepEqual(
    dictionary.values.map((item: any) => item.value),
    ["CREATED", "DONE"],
  );
});

test("knowledge config only requires MySQL basics and ignores OSS", () => {
  const config = configTemplate("transport-system", "运输系统");
  config.connections.database_profiles.push({
    id: "transport-mysql",
    connector_id: "mysql",
    password: "prototype",
    settings: {
      host: "127.0.0.1",
      port: 3306,
      username: "reader",
      databases: ["transport", "settlement"],
    },
  });
  config.knowledge.database_profile_ids = ["transport-mysql"];
  config.connections.object_storage_profiles.push({ id: "unfinished-oss" });
  const result = validateConfig(config, "knowledge");
  assert.equal(result.ok, true);
  assert.equal(result.database_profiles, 1);
});

test("planned report requirements accept labeled physical fields and reject empty fields", () => {
  const config = configTemplate("transport-system", "运输系统");
  config.connections.database_profiles.push({
    id: "transport-mysql",
    connector_id: "mysql",
    password: "prototype",
    settings: {
      host: "127.0.0.1",
      port: 3306,
      username: "reader",
      databases: ["transport"],
    },
  });
  config.knowledge.database_profile_ids = ["transport-mysql"];
  config.knowledge.report_requirements = [
    {
      id: "driver-basic-detail",
      name: "司机基础信息明细",
      required_fields: [
        { field: "base_primary_driver.code", label: "司机编码" },
        { field: "base_primary_driver.name", label: "司机姓名" },
      ],
    },
  ];
  assert.equal(validateConfig(config, "knowledge").ok, true);

  config.knowledge.report_requirements[0].required_fields.push({ label: "缺少字段" });
  const invalid = validateConfig(config, "knowledge");
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join("\n"), /object with field/);
});

test("snapshot diff reports added, removed, and changed tables", () => {
  const orderV1 = table("transport_order", [column("id", "订单ID")], "v1");
  const orderV2 = table(
    "transport_order",
    [column("id", "订单ID"), column("amount", "金额", "decimal(18,2)")],
    "v2",
  );
  const diff = diffSnapshots(
    snapshot([orderV1, table("old_table", [column("id", "ID")], "old")]),
    snapshot([orderV2, table("new_table", [column("id", "ID")], "new")]),
  );
  assert.deepEqual(diff.summary, {
    added_tables: 1,
    removed_tables: 1,
    changed_tables: 1,
    unchanged_tables: 0,
  });
  assert.deepEqual(diff.changed_tables[0].added_columns, ["amount"]);
});

test("unindexed time fields use a bounded recent-data existence probe", async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const connection = {
    query: async (sql: string, values: unknown[]) => {
      queries.push({ sql, values: values ?? [] });
      return [{ has_recent_data: 0 }];
    },
  } as any;
  const activity = await probeActivity(
    connection,
    {
      physical: {
        profile_id: "transport-mysql",
        database: "transport",
        table: "transport_order",
      },
      columns: [
        column("create_time", "创建时间", "datetime"),
        column("update_time", "更新时间", "datetime"),
      ],
      indexes: [{ name: "PRIMARY", unique: true, columns: ["id"] }],
    },
    {
      inactivity_days: 90,
      activity_probe: {
        enabled: true,
        require_index: false,
        unindexed_max_columns: 2,
        statement_timeout_seconds: 8,
        candidate_columns: ["update_time", "create_time"],
      },
    },
    MYSQL,
  );
  assert.equal(activity.status, "observed");
  assert.equal(activity.method, "unindexed_recent_exists");
  assert.equal(activity.has_recent_data, false);
  assert.equal(activity.inactive_days_at_least, 90);
  assert.match(queries[0]!.sql, /EXISTS/);
  assert.match(queries[0]!.sql, /MAX_EXECUTION_TIME\(8000\)/);
  assert.deepEqual(activity.fields, ["update_time", "create_time"]);
  assert.equal(queries[0]!.values.length, 2);
});

test("indexed activity probes persist observed status", async () => {
  const connection = {
    query: async () => [{ latest_value: "2026-07-16T00:00:00Z" }],
  } as any;
  const activity = await probeActivity(
    connection,
    {
      physical: {
        profile_id: "transport-mysql",
        database: "transport",
        table: "transport_order",
      },
      columns: [column("update_time", "更新时间", "datetime")],
      indexes: [{ name: "idx_update_time", unique: false, columns: ["update_time"] }],
    },
    {
      inactivity_days: 90,
      activity_probe: {
        enabled: true,
        require_index: false,
        statement_timeout_seconds: 8,
        candidate_columns: ["update_time"],
      },
    },
    MYSQL,
  );
  assert.equal(activity.status, "observed");
  assert.equal(activity.method, "indexed_desc_limit_1");
  assert.equal(activity.confidence, "high");
});

test("legacy indexed activity evidence without status is normalized", () => {
  const current = table(
    "transport_order",
    [column("id", "订单主键", "bigint")],
    "legacy-indexed-activity-v1",
  );
  current.activity = {
    field: "update_time",
    method: "indexed_desc_limit_1",
    last_data_at: "2026-07-16T00:00:00Z",
    inactive_days: 1,
    confidence: "high",
  } as any;
  const plan = propose(
    snapshot([current]),
    configTemplate("transport-system", "运输系统"),
  );
  const entry = plan.entries[0];
  assert.equal(entry.evidence.activity.status, "observed");
  assert.equal(entry.reasons.includes("Recent activity observed"), true);
});

test("failed unindexed activity probes remain unknown", async () => {
  const connection = {
    query: async () => {
      throw new Error("query timeout");
    },
  } as any;
  const activity = await probeActivity(
    connection,
    {
      physical: {
        profile_id: "transport-mysql",
        database: "transport",
        table: "large_history",
      },
      columns: [column("create_time", "创建时间", "datetime")],
      indexes: [],
    },
    {
      inactivity_days: 90,
      activity_probe: {
        enabled: true,
        require_index: false,
        unindexed_max_columns: 2,
        statement_timeout_seconds: 8,
        candidate_columns: ["create_time"],
      },
    },
    MYSQL,
  );
  assert.equal(activity.status, "unknown");
  assert.equal(activity.inactive_days, null);
  assert.match(activity.reason, /failed or timed out/i);
});

test("report name and required fields provide strong hot-table evidence", () => {
  const order = table(
    "transport_order",
    [
      column("order_no", "运输订单号"),
      column("carrier_name", "承运商名称"),
      column("create_time", "创建时间", "datetime"),
    ],
    "order-v1",
  );
  const unrelated = table(
    "system_user",
    [column("name", "用户名称"), column("status", "状态")],
    "user-v1",
  );
  const hints = configTemplate("transport-system", "运输系统");
  hints.knowledge.report_requirements = [
    {
      id: "transport-detail",
      name: "运输订单明细",
      required_fields: ["运输订单号", "承运商名称", "创建时间"],
    },
  ];
  const plan = propose(snapshot([order, unrelated]), hints);
  const orderEntry = plan.entries.find((entry: any) => entry.table_id === order.table_id);
  const unrelatedEntry = plan.entries.find(
    (entry: any) => entry.table_id === unrelated.table_id,
  );
  assert.equal(orderEntry.proposed_tier, "hot");
  assert.deepEqual(orderEntry.evidence.report_requirements.strong_reports, [
    "运输订单明细",
  ]);
  assert.notEqual(unrelatedEntry.proposed_tier, "hot");
});

test("business-name matches alone remain warm", () => {
  const carrier = table(
    "base_carrier",
    [column("carrier_name", "承运商名称")],
    "carrier-v1",
  );
  carrier.comment = "承运商";
  const hints = configTemplate("transport-system", "运输系统");
  hints.knowledge.business_semantics = ["承运商"];
  const plan = propose(snapshot([carrier]), hints);
  assert.equal(plan.entries[0].proposed_tier, "warm");
  assert.equal(plan.entries[0].classification.score, 75);
});

test("reliable 90-day inactivity overrides business semantics and becomes cold", () => {
  const carrier = table(
    "base_carrier",
    [column("carrier_name", "承运商名称")],
    "carrier-inactive-v1",
    90,
  );
  carrier.comment = "承运商";
  const hints = configTemplate("transport-system", "运输系统");
  hints.knowledge.business_semantics = ["承运商"];
  const plan = propose(snapshot([carrier]), hints);
  assert.equal(plan.entries[0].proposed_tier, "cold");
  assert.equal(plan.entries[0].classification.score, 25);
  assert.equal(plan.entries[0].classification.decision_rule, "inactive");
});

test("forced-hot and planned-report dependencies override inactivity", () => {
  const forced = table(
    "forced_dimension",
    [column("code", "编码")],
    "forced-inactive-v1",
    180,
  );
  const required = table(
    "required_dimension",
    [column("code", "编码")],
    "required-inactive-v1",
    180,
  );
  const hints = configTemplate("transport-system", "运输系统");
  hints.knowledge.forced_hot_tables = [forced.table_id];
  hints.knowledge.report_requirements = [
    {
      id: "required-report",
      name: "必需维表报表",
      required_fields: [{ field: "required_dimension.code", label: "编码" }],
    },
  ];
  const plan = propose(snapshot([forced, required]), hints);
  const forcedEntry = plan.entries.find((entry: any) => entry.table_id === forced.table_id);
  const requiredEntry = plan.entries.find(
    (entry: any) => entry.table_id === required.table_id,
  );
  assert.equal(forcedEntry.proposed_tier, "hot");
  assert.equal(forcedEntry.classification.decision_rule, "forced_hot");
  assert.equal(requiredEntry.proposed_tier, "hot");
  assert.equal(requiredEntry.classification.decision_rule, "planned_report_dependency");
});

test("catalog build applies report fields, filter defaults, scope and minimal review", async () => {
  const root = await tempRoot();
  const driver = table(
    "base_primary_driver",
    [
      column("code", "编码"),
      column("name", "姓名"),
      column("phone", "手机号"),
      column("status", "状态"),
      column("driver_license", "驾照类型"),
      column("tenant_id", "租户id", "bigint"),
      column("belong_corp_id", "所属公司id", "bigint"),
      column("create_time", "创建时间", "datetime"),
      column("is_delete", "逻辑删除,0正常,1删除", "tinyint(1)"),
    ],
    "driver-v1",
  );
  driver.comment = "司机";
  const current = snapshot([driver]);
  const hints = configTemplate("transport-system", "运输系统");
  hints.knowledge.report_requirements = [
    {
      id: "driver-basic-detail",
      name: "司机基础信息明细",
      required_fields: [
        { field: "base_primary_driver.code", label: "司机编码" },
        { field: "base_primary_driver.name", label: "司机姓名" },
        {
          field: "base_primary_driver.phone",
          label: "手机号",
          filter: { operator: "contains" },
        },
        { field: "base_primary_driver.create_time", label: "创建时间" },
      ],
    },
  ];
  const plan = propose(current, hints);
  plan.approval = {
    status: "approved",
    approved_by: "tester",
    approved_at: "2026-07-17T00:00:00Z",
    decision: "批准",
  };
  const draft = join(root, "knowledge", "drafts", "driver");
  await buildCatalog(current, plan, draft);
  const hotDirectory = join(
    draft,
    "databases",
    "transport-mysql",
    "transport",
    "hot",
    "tables",
  );
  const document = await loadJson(join(hotDirectory, (await readdir(hotDirectory))[0]!));
  const fields = new Map<string, any>(
    document.physical_fields.map((field: any) => [field.physical.name, field]),
  );
  assert.equal(document.business.name, "司机");
  assert.equal(document.business.status, "inferred");
  assert.equal(fields.get("code").semantic.name, "司机编码");
  assert.equal(fields.get("code").semantic.report_exposed, true);
  assert.equal(fields.get("code").filter.default_operator, "eq");
  assert.equal(fields.get("name").filter.default_operator, "contains");
  assert.equal("sensitive" in fields.get("phone").semantic, false);
  assert.equal(fields.get("phone").filter.default_operator, "contains");
  assert.equal(fields.get("phone").filter.operators.includes("contains"), true);
  assert.equal(fields.get("phone").filter.source, "report_requirement");
  assert.equal(fields.get("status").filter.role, "enum");
  assert.equal(fields.get("driver_license").filter.role, "enum");
  assert.equal(fields.get("tenant_id").filter.role, "tenant_scope");
  assert.equal(fields.get("tenant_id").filter.visibility, "system");
  assert.equal(fields.get("tenant_id").filter.input_type, "hidden");
  assert.equal(fields.get("tenant_id").filter.required, false);
  assert.equal(fields.get("tenant_id").filter.accepted_by_api, true);
  assert.equal(fields.get("tenant_id").filter.parameter_source, "request_context");
  assert.equal(fields.get("tenant_id").filter.request_key, "tenant_id");
  assert.equal(fields.get("tenant_id").filter.apply_when_present, true);
  assert.deepEqual(fields.get("tenant_id").filter.operators, ["eq"]);
  assert.equal(fields.get("belong_corp_id").filter.role, "organization_scope");
  assert.equal(fields.get("create_time").filter.default_operator, "between");
  assert.equal(fields.get("is_delete").filter.role, "system_condition");
  assert.equal(fields.get("is_delete").filter.visibility, "system");
  assert.equal(fields.get("is_delete").filter.input_type, "hidden");
  assert.equal(fields.get("is_delete").filter.required, true);
  assert.equal(fields.get("is_delete").filter.fixed_value, 0);
  assert.equal(fields.get("is_delete").semantic.report_exposed, false);
  assert.deepEqual(document.system_conditions, [
    {
      field: "is_delete",
      operator: "eq",
      value: 0,
      source: "default_policy",
      status: "inferred",
    },
  ]);
  assert.equal(document.security.scope_status, "inferred");
  assert.deepEqual(document.security.tenant_fields, ["tenant_id"]);
  assert.deepEqual(document.security.organization_fields, ["belong_corp_id"]);
  assert.equal(
    (await loadJson(join(draft, "reviews", "blocking-issues.json"))).issues.length,
    0,
  );
  assert.equal(
    (await loadJson(join(draft, "reviews", "semantic-review.json"))).status,
    "ready_for_batch_approval",
  );
  assert.equal((await loadJson(join(draft, "manifest.json"))).catalog_format_version, "3");
});

test("catalog build records only unique conservative relationship candidates", async () => {
  const root = await tempRoot();
  const carrier = table(
    "carrier",
    [column("id", "承运商主键", "bigint"), column("name", "承运商名称")],
    "carrier-relation-v1",
  );
  const order = table(
    "transport_order",
    [
      column("id", "订单主键", "bigint"),
      column("carrier_id", "承运商id", "bigint"),
      column("tenant_id", "租户id", "bigint"),
    ],
    "order-relation-v1",
  );
  const current = snapshot([carrier, order]);
  const hints = configTemplate("transport-system", "运输系统");
  const plan = propose(current, hints);
  plan.approval = {
    status: "approved",
    approved_by: "tester",
    approved_at: "2026-07-17T00:00:00Z",
    decision: "批准",
  };
  const draft = join(root, "knowledge", "drafts", "relationship-candidate");
  await buildCatalog(current, plan, draft);
  const relationshipDocument = await loadJson(
    join(
      draft,
      "databases",
      "transport-mysql",
      "transport",
      "relationships.json",
    ),
  );
  assert.equal(relationshipDocument.relationships.length, 0);
  assert.equal(relationshipDocument.candidates.length, 1);
  assert.deepEqual(relationshipDocument.candidates[0].source_columns, ["carrier_id"]);
  assert.equal(relationshipDocument.candidates[0].target_table_id, carrier.table_id);
  assert.equal(relationshipDocument.candidates[0].status, "unverified");
  assert.equal(
    relationshipDocument.candidates.some((item: any) =>
      item.source_columns.includes("tenant_id"),
    ),
    false,
  );
  const inference = await loadJson(join(draft, "reviews", "inference-summary.json"));
  assert.deepEqual(inference.relationship_inference, { confirmed: 0, candidates: 1 });
  assert.equal(inference.deferred_reviews.includes("relationship_candidates"), true);
});

test("missing planned report fields become one blocking review list", async () => {
  const root = await tempRoot();
  const driver = table("base_primary_driver", [column("code", "编码")], "driver-v1");
  driver.comment = "司机";
  const current = snapshot([driver]);
  const hints = configTemplate("transport-system", "运输系统");
  hints.knowledge.forced_hot_tables = [driver.table_id];
  hints.knowledge.report_requirements = [
    {
      id: "driver-basic-detail",
      name: "司机基础信息明细",
      required_fields: [{ field: "base_primary_driver.missing_field", label: "缺失字段" }],
    },
  ];
  const plan = propose(current, hints);
  plan.approval = {
    status: "approved",
    approved_by: "tester",
    approved_at: "2026-07-17T00:00:00Z",
    decision: "批准",
  };
  const draft = join(root, "knowledge", "drafts", "driver-missing");
  await buildCatalog(current, plan, draft);
  const blocking = await loadJson(join(draft, "reviews", "blocking-issues.json"));
  assert.equal(blocking.status, "blocked");
  assert.equal(blocking.issues.length, 1);
  assert.equal(blocking.issues[0].type, "missing_report_field");
});

test("classification, database navigation, promotion, enum round-trip, and publish", async () => {
  const root = await tempRoot();
  await initWorkspace(root, "transport-system", "运输系统");
  const order = table(
    "transport_order",
    [
      column("id", "订单ID"),
      column("status", "订单状态", "enum('CREATED','DONE')"),
    ],
    "order-v1",
  );
  const warm = table("carrier", [column("id", "承运商ID")], "carrier-v1");
  const technical = table("flyway_schema_history", [column("id", "ID")], "tech-v1");
  const current = snapshot([order, warm, technical]);
  const hints = configTemplate("transport-system", "运输系统");
  hints.knowledge.forced_hot_tables = [order.table_id];
  const plan = propose(current, hints);
  assert.equal(
    plan.entries.find((entry: any) => entry.table_id === order.table_id).proposed_tier,
    "hot",
  );
  assert.equal(
    plan.entries.find((entry: any) => entry.table_id === technical.table_id).proposed_tier,
    "cold",
  );
  plan.approval = {
    status: "approved",
    approved_by: "tester",
    approved_at: "2026-07-16T00:00:00Z",
    decision: "批准",
  };
  const scanDir = join(root, "knowledge", "scans", "scan-1");
  const snapshotPath = join(scanDir, "snapshot.json");
  const draft = join(root, "knowledge", "drafts", "draft-1");
  await dumpJson(snapshotPath, current);
  await buildCatalog(current, plan, draft);

  const hotDirectory = join(
    draft,
    "databases",
    "transport-mysql",
    "transport",
    "hot",
    "tables",
  );
  const hotFile = join(hotDirectory, (await readdir(hotDirectory))[0]!);
  const hot = await loadJson(hotFile);
  hot.business = { ...hot.business, name: "运输订单", status: "confirmed" };
  hot.security.scope_status = "not_applicable";
  hot.physical_fields[0].semantic = {
    ...hot.physical_fields[0].semantic,
    name: "订单ID",
    status: "confirmed",
    report_exposed: true,
  };
  await dumpJson(hotFile, hot);

  const promoted = await promoteTable(
    draft,
    warm.table_id,
    "hot",
    "报表需要承运商",
    snapshotPath,
  );
  assert.equal(promoted.changed, true);

  const enumFile = join(root, "work", "enum-review.xlsx");
  const exported = await exportEnums(draft, enumFile);
  assert.equal(exported.field_rows, 1);
  assert.equal(exported.mapping_rows, 2);
  assert.equal(exported.rows, 2);

  const ExcelModule = await import("exceljs");
  const ExcelJS: any = (ExcelModule as any).default ?? ExcelModule;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(enumFile);
  const sheet = workbook.getWorksheet("枚举值映射")!;
  sheet.getRow(2).getCell(3).value = "已创建";
  sheet.getRow(3).getCell(3).value = "已完成";
  await workbook.xlsx.writeFile(enumFile);
  const preview = await importEnums(draft, enumFile, true);
  assert.equal(preview.ok, true);
  assert.equal(preview.changes, 2);
  const imported = await importEnums(draft, enumFile, false);
  assert.equal(imported.ok, true);
  const storedEnums = await loadJson(join(draft, "global", "enums.json"));
  assert.equal(storedEnums.dictionaries.length, 1);
  assert.equal(storedEnums.bindings.length, 1);
  assert.deepEqual(storedEnums.dictionaries[0].values, [
    { value: "CREATED", label: "已创建", description: "" },
    { value: "DONE", label: "已完成", description: "" },
  ]);

  const promotedHotFiles = await readdir(hotDirectory);
  for (const file of promotedHotFiles) {
    const path = join(hotDirectory, file);
    const document = await loadJson(path);
    document.business = {
      ...document.business,
      name: document.business.name ?? document.physical.table,
      status: "confirmed",
    };
    document.security.scope_status = "not_applicable";
    document.physical_fields[0].semantic = {
      ...document.physical_fields[0].semantic,
      name: document.physical_fields[0].semantic.name ?? document.physical_fields[0].physical.name,
      status: "confirmed",
      report_exposed: true,
    };
    await dumpJson(path, document);
  }
  // The semantic-review approval gate was removed: a data-quality- and
  // structurally-sound catalog is publishable even when the review is still
  // "ready_for_batch_approval" with unresolved questions. Deliberately leave the
  // review UNAPPROVED to prove the gate no longer blocks publish.
  // The semantic-review approval gate was removed: a data-quality- and
  // structurally-sound catalog is publishable even when the review is still
  // "ready_for_batch_approval" with unresolved questions. Deliberately leave the
  // review UNAPPROVED to prove the gate no longer blocks publish. (The publish
  // command below runs the full publishReady validation with a temporary
  // catalog_status=ready, so a successful publish is the real assertion.)
  const reviewPath = join(draft, "reviews", "semantic-review.json");
  const review = await loadJson(reviewPath);
  assert.notEqual(review.status, "approved");

  const draftValidation = await validateCatalog(draft);
  assert.equal(draftValidation.ok, true, JSON.stringify(draftValidation));
  const published = JSON.parse(
    await captureStdout(() =>
      runCli([
        "publish",
        "--catalog",
        draft,
        "--workspace",
        root,
        "--version",
        "1.0.0",
        "--published-by",
        "tester",
        "--decision",
        "测试发布",
      ]),
    ),
  );
  assert.equal(published.version, "1.0.0");
  assert.equal(
    (await loadJson(join(root, "knowledge", "versions", "1.0.0", "manifest.json")))
      .catalog_status,
    "published",
  );
});

test("workspace initialization is idempotent and preserves host-managed fields", async () => {
  const root = await tempRoot();
  await initWorkspace(root, "transport-system", "运输系统");
  const workspacePath = join(root, "workspace.json");
  const existing = await loadJson(workspacePath);
  await dumpJson(workspacePath, {
    ...existing,
    status: "ready",
    system: { id: "transport-system", name: "人工名称" },
    host_extension: { managed_by: "studio" },
    paths: {
      ...existing.paths,
      outputs: "custom-outputs",
    },
  });

  const result = await initWorkspace(root, "other-system", "不应覆盖");
  const current = await loadJson(workspacePath);
  assert.equal(result.status, "ready");
  assert.equal(current.system.id, "transport-system");
  assert.equal(current.system.name, "人工名称");
  assert.equal(current.host_extension.managed_by, "studio");
  assert.equal(current.paths.outputs, "custom-outputs");
  assert.equal(current.paths.skill_bundle_manifest, "skills/bundle.manifest.json");
  assert.equal(current.paths.skill_bundle_lock, "skills/bundle.lock.json");
  assert.equal(current.paths.report_plans, "reports/plans");
});

test("one enum field imports five code-to-Chinese mappings without row statuses", async () => {
  const root = await tempRoot();
  const driver = table(
    "base_primary_driver",
    [
      column("id", "主键", "bigint"),
      column("drvicer_type", "司机类型", "int"),
    ],
    "driver-enum-v1",
  );
  driver.comment = "司机";
  const current = snapshot([driver]);
  const hints = configTemplate("transport-system", "运输系统");
  hints.knowledge.forced_hot_tables = [driver.table_id];
  const plan = propose(current, hints);
  plan.approval = {
    status: "approved",
    approved_by: "tester",
    approved_at: "2026-07-17T00:00:00Z",
    decision: "批准",
  };
  const draft = join(root, "knowledge", "drafts", "driver-enums");
  await buildCatalog(current, plan, draft);

  const enumFile = join(root, "work", "driver-enums.xlsx");
  const exported = await exportEnums(draft, enumFile);
  assert.equal(exported.field_rows, 1);
  assert.equal(exported.mapping_rows, 1);

  const ExcelModule = await import("exceljs");
  const ExcelJS: any = (ExcelModule as any).default ?? ExcelModule;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(enumFile);
  const mappingSheet = workbook.getWorksheet("枚举值映射")!;
  const dictionaryName = mappingSheet.getRow(2).getCell(1).value;
  const labels = ["普通司机", "叉车司机", "临调司机", "外协司机", "其他司机"];
  for (let index = 0; index < labels.length; index += 1) {
    const row = mappingSheet.getRow(index + 2);
    row.getCell(1).value = dictionaryName;
    row.getCell(2).value = index === 0 ? "00" : String(index);
    row.getCell(3).value = labels[index]!;
    row.getCell(4).value = "";
  }
  await workbook.xlsx.writeFile(enumFile);

  const preview = await importEnums(draft, enumFile, true);
  assert.equal(preview.ok, true);
  assert.equal(preview.changes, 2);
  const imported = await importEnums(draft, enumFile, false);
  assert.equal(imported.ok, true);
  const state = await loadJson(join(draft, "global", "enums.json"));
  const stored = state.dictionaries[0];
  assert.equal(state.bindings.length, 1);
  assert.equal(stored.values.length, 5);
  assert.deepEqual(
    stored.values.map((item: any) => [item.value, item.label]),
    [
      ["00", "普通司机"],
      ["1", "叉车司机"],
      ["2", "临调司机"],
      ["3", "外协司机"],
      ["4", "其他司机"],
    ],
  );
  assert.equal("order" in stored.values[0], false);
  assert.equal("enabled" in stored.values[0], false);
  assert.equal("status" in stored.values[0], false);
});

test("matching specific enum fields share one dictionary and re-export preserves edits", async () => {
  const root = await tempRoot();
  const driver = table(
    "base_primary_driver",
    [
      column("id", "主键", "bigint"),
      column(
        "enable_status",
        "启用状态",
        "enum('ENABLED','DISABLED')",
      ),
    ],
    "driver-shared-enum-v1",
  );
  driver.comment = "司机";
  const carrier = table(
    "base_carrier",
    [
      column("id", "主键", "bigint"),
      column(
        "enable_status",
        "启用状态",
        "enum('ENABLED','DISABLED')",
      ),
    ],
    "carrier-shared-enum-v1",
  );
  carrier.comment = "承运商";
  const current = snapshot([driver, carrier]);
  const hints = configTemplate("transport-system", "运输系统");
  hints.knowledge.forced_hot_tables = [driver.table_id, carrier.table_id];
  const plan = propose(current, hints);
  plan.approval = {
    status: "approved",
    approved_by: "tester",
    approved_at: "2026-07-17T00:00:00Z",
    decision: "批准",
  };
  const draft = join(root, "knowledge", "drafts", "shared-enums");
  await buildCatalog(current, plan, draft);

  const enumFile = join(root, "work", "shared-enums.xlsx");
  const exported = await exportEnums(draft, enumFile);
  assert.equal(exported.field_rows, 2);
  assert.equal(exported.dictionary_rows, 1);
  assert.equal(exported.mapping_rows, 2);

  const ExcelModule = await import("exceljs");
  const ExcelJS: any = (ExcelModule as any).default ?? ExcelModule;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(enumFile);
  const bindingSheet = workbook.getWorksheet("枚举字段绑定")!;
  const mappingSheet = workbook.getWorksheet("枚举值映射")!;
  const firstName = String(bindingSheet.getRow(2).getCell(6).value);
  assert.equal(bindingSheet.getRow(3).getCell(6).value, firstName);
  mappingSheet.getRow(2).getCell(3).value = "启用";
  mappingSheet.getRow(3).getCell(3).value = "停用";
  await workbook.xlsx.writeFile(enumFile);

  const preview = await importEnums(draft, enumFile, true);
  assert.equal(preview.ok, true);
  assert.equal(preview.dictionary_count, 1);
  assert.equal(preview.binding_count, 2);
  assert.equal(preview.changes, 3);
  const imported = await importEnums(draft, enumFile, false);
  assert.equal(imported.ok, true);

  const state = await loadJson(join(draft, "global", "enums.json"));
  assert.equal(state.dictionaries.length, 1);
  assert.equal(state.bindings.length, 2);
  assert.deepEqual(
    state.dictionaries[0].values.map((item: any) => [item.value, item.label]),
    [
      ["ENABLED", "启用"],
      ["DISABLED", "停用"],
    ],
  );
  assert.equal(state.bindings[0].dictionary_name, firstName);
  assert.equal(state.bindings[1].dictionary_name, firstName);

  const secondExport = join(root, "work", "shared-enums-roundtrip.xlsx");
  const reExported = await exportEnums(draft, secondExport);
  assert.equal(reExported.dictionary_rows, 1);
  const roundTrip = new ExcelJS.Workbook();
  await roundTrip.xlsx.readFile(secondExport);
  const roundTripBindings = roundTrip.getWorksheet("枚举字段绑定")!;
  const roundTripMappings = roundTrip.getWorksheet("枚举值映射")!;
  assert.equal(roundTripBindings.getRow(2).getCell(6).value, firstName);
  assert.equal(roundTripBindings.getRow(3).getCell(6).value, firstName);
  assert.deepEqual(
    [2, 3].map((row) => [
      roundTripMappings.getRow(row).getCell(2).value,
      roundTripMappings.getRow(row).getCell(3).value,
    ]),
    [
      ["ENABLED", "启用"],
      ["DISABLED", "停用"],
    ],
  );
});

test("generic status fields are not auto-merged without value evidence", async () => {
  const root = await tempRoot();
  const order = table(
    "transport_order",
    [column("id", "主键", "bigint"), column("status", "状态", "varchar(30)")],
    "order-status-v1",
  );
  order.comment = "运输订单";
  const invoice = table(
    "settlement_invoice",
    [column("id", "主键", "bigint"), column("status", "状态", "varchar(30)")],
    "invoice-status-v1",
  );
  invoice.comment = "结算单";
  const current = snapshot([order, invoice]);
  const hints = configTemplate("transport-system", "运输系统");
  hints.knowledge.forced_hot_tables = [order.table_id, invoice.table_id];
  const plan = propose(current, hints);
  plan.approval = {
    status: "approved",
    approved_by: "tester",
    approved_at: "2026-07-17T00:00:00Z",
    decision: "批准",
  };
  const draft = join(root, "knowledge", "drafts", "generic-status");
  await buildCatalog(current, plan, draft);

  const enumFile = join(root, "work", "generic-status.xlsx");
  const exported = await exportEnums(draft, enumFile);
  assert.equal(exported.field_rows, 2);
  assert.equal(exported.dictionary_rows, 2);

  const ExcelModule = await import("exceljs");
  const ExcelJS: any = (ExcelModule as any).default ?? ExcelModule;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(enumFile);
  const bindingSheet = workbook.getWorksheet("枚举字段绑定")!;
  assert.notEqual(
    bindingSheet.getRow(2).getCell(6).value,
    bindingSheet.getRow(3).getCell(6).value,
  );
});

test("generic status fields may share when native enum values provide matching evidence", async () => {
  const root = await tempRoot();
  const order = table(
    "transport_order",
    [
      column("id", "主键", "bigint"),
      column("status", "状态", "enum('CREATED','DONE')"),
    ],
    "order-native-status-v1",
  );
  order.comment = "运输订单";
  const invoice = table(
    "settlement_invoice",
    [
      column("id", "主键", "bigint"),
      column("status", "状态", "enum('CREATED','DONE')"),
    ],
    "invoice-native-status-v1",
  );
  invoice.comment = "结算单";
  const current = snapshot([order, invoice]);
  const hints = configTemplate("transport-system", "运输系统");
  hints.knowledge.forced_hot_tables = [order.table_id, invoice.table_id];
  const plan = propose(current, hints);
  plan.approval = {
    status: "approved",
    approved_by: "tester",
    approved_at: "2026-07-17T00:00:00Z",
    decision: "批准",
  };
  const draft = join(root, "knowledge", "drafts", "generic-status-with-evidence");
  await buildCatalog(current, plan, draft);

  const enumFile = join(root, "work", "generic-status-with-evidence.xlsx");
  const exported = await exportEnums(draft, enumFile);
  assert.equal(exported.field_rows, 2);
  assert.equal(exported.dictionary_rows, 1);
  assert.equal(exported.mapping_rows, 2);
});

test("enum import blocks incomplete candidate configuration", async () => {
  const root = await tempRoot();
  const driver = table(
    "base_primary_driver",
    [column("id", "主键", "bigint"), column("drvicer_type", "司机类型", "int")],
    "driver-incomplete-enum-v1",
  );
  driver.comment = "司机";
  const current = snapshot([driver]);
  const hints = configTemplate("transport-system", "运输系统");
  hints.knowledge.forced_hot_tables = [driver.table_id];
  const plan = propose(current, hints);
  plan.approval = {
    status: "approved",
    approved_by: "tester",
    approved_at: "2026-07-17T00:00:00Z",
    decision: "批准",
  };
  const draft = join(root, "knowledge", "drafts", "incomplete-enums");
  await buildCatalog(current, plan, draft);

  const enumFile = join(root, "work", "incomplete-enums.xlsx");
  await exportEnums(draft, enumFile);
  const preview = await importEnums(draft, enumFile, true);
  assert.equal(preview.ok, false);
  assert.match(preview.errors.join("\n"), /没有配置任何code和中文名称/);
});

test("enums-init writes bindings and prefills native ENUM values offline, idempotently", async () => {
  const root = await tempRoot();
  await initWorkspace(root, "transport-system", "运输系统");
  const order = table(
    "transport_order",
    [
      column("id", "订单ID"),
      // native ENUM => offline prefill from definition
      column("status", "订单状态", "enum('CREATED','DONE')"),
      // plain varchar generic enum candidate => empty (no DB reachable in test)
      column("type", "类型", "varchar(32)"),
    ],
    "order-v1",
  );
  const current = snapshot([order]);
  const hints = configTemplate("transport-system", "运输系统");
  hints.knowledge.forced_hot_tables = [order.table_id];
  const plan = propose(current, hints);
  plan.approval = {
    status: "approved",
    approved_by: "tester",
    approved_at: "2026-07-16T00:00:00Z",
    decision: "批准",
  };
  const draft = join(root, "knowledge", "drafts", "draft-1");
  await buildCatalog(current, plan, draft);

  // Config points at a profile that cannot connect => must degrade to offline,
  // never throw, never block.
  const config = configTemplate("transport-system", "运输系统");
  config.connections = {
    database_profiles: [
      {
        id: "transport-mysql",
        connector_id: "mysql",
        password: "x",
        settings: { host: "127.0.0.1", port: 59999, username: "nobody", databases: ["transport"] },
      },
    ],
  };
  config.knowledge.database_profile_ids = ["transport-mysql"];

  const first = await initEnums(draft, config, { limit: 50, timeoutMs: 800 });
  assert.equal(first.ok, true);
  assert.ok(first.bindings >= 2, "status and type should both be bound");

  const enums = await loadJson(join(draft, "global", "enums.json"));
  const statusBinding = enums.bindings.find((b: any) => b.field === "status");
  assert.ok(statusBinding, "status must have a binding");
  const statusDict = enums.dictionaries.find(
    (d: any) => d.name === statusBinding.dictionary_name,
  );
  assert.deepEqual(
    statusDict.values.map((v: any) => v.value).sort(),
    ["CREATED", "DONE"],
    "native ENUM values are prefilled offline",
  );
  assert.equal(statusDict.values.every((v: any) => v.label === ""), true);

  // status and type are generic names => must NOT merge into one dictionary.
  const typeBinding = enums.bindings.find((b: any) => b.field === "type");
  assert.notEqual(typeBinding.dictionary_name, statusBinding.dictionary_name);

  // enum_ref is set on the field so report generation can resolve it.
  const hotDir = join(draft, "databases", "transport-mysql", "transport", "hot", "tables");
  const hotFile = join(hotDir, (await readdir(hotDir))[0]!);
  const hot = await loadJson(hotFile);
  const statusField = hot.physical_fields.find((f: any) => f.physical.name === "status");
  assert.equal(statusField.semantic.enum_ref, statusBinding.dictionary_name);

  // Idempotency: a human-entered label must survive a re-run.
  statusDict.values.find((v: any) => v.value === "CREATED").label = "已创建";
  await dumpJson(join(draft, "global", "enums.json"), enums);
  await initEnums(draft, config, { limit: 50, timeoutMs: 800 });
  const after = await loadJson(join(draft, "global", "enums.json"));
  const afterDict = after.dictionaries.find((d: any) => d.name === statusBinding.dictionary_name);
  assert.equal(
    afterDict.values.find((v: any) => v.value === "CREATED").label,
    "已创建",
    "human label preserved on re-run",
  );
});

test("enums-import-json allow-incomplete saves WIP without blocking on missing labels", async () => {
  const root = await tempRoot();
  await initWorkspace(root, "transport-system", "运输系统");
  const order = table(
    "transport_order",
    [
      column("id", "订单ID"),
      column("status", "订单状态", "enum('CREATED','DONE')"),
    ],
    "order-v1",
  );
  const current = snapshot([order]);
  const hints = configTemplate("transport-system", "运输系统");
  hints.knowledge.forced_hot_tables = [order.table_id];
  const plan = propose(current, hints);
  plan.approval = { status: "approved", approved_by: "t", approved_at: "2026-07-16T00:00:00Z", decision: "ok" };
  const draft = join(root, "knowledge", "drafts", "draft-1");
  await buildCatalog(current, plan, draft);

  // Page model: binding present, but the mapping has an empty label (WIP).
  const model = {
    bindings: [
      { table_id: order.table_id, field: "status", dictionary_name: "订单状态" },
    ],
    dictionaries: [
      { name: "订单状态", values: [{ value: "CREATED", label: "", description: "" }] },
    ],
  };
  const file = join(root, "work", "enum-page.json");
  await dumpJson(file, model);

  // Strict import blocks; WIP import succeeds with a warning and still writes.
  const strict = await importEnumsJson(draft, file, false, false);
  assert.equal(strict.ok, false);

  const wip = await importEnumsJson(draft, file, false, true);
  assert.equal(wip.ok, true, JSON.stringify(wip));
  assert.ok((wip.warnings as string[]).length >= 1);
  const stored = await loadJson(join(draft, "global", "enums.json"));
  assert.equal(stored.bindings.length, 1);
  assert.equal(stored.dictionaries[0].name, "订单状态");
});
