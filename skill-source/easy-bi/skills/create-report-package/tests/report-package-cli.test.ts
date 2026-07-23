import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  approvePlan,
  buildKnowledgeContext,
  buildPhaseContext,
  createModelConfirmation,
  initializeReportModel,
  approveReportModel,
  approveStagedModel,
  finalizeStagedModel,
  finalizeStagedPackage,
  validateStagedArtifacts,
  validateReportModelValue,
  configurePlan,
  explainPlan,
  generatePackage,
  inspectReport,
  resealPackage,
  validatePackage,
} from "../scripts/report-package-cli.js";

async function createFixture(): Promise<{
  workspace: string;
  knowledge: string;
  plan: string;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "easybi-report-"));
  const knowledge = join(workspace, "knowledge", "drafts", "v1");
  const tableDirectory = join(
    knowledge,
    "databases",
    "mysql-main",
    "transport",
    "hot",
    "tables",
  );
  await mkdir(join(workspace, "config"), { recursive: true });
  await mkdir(tableDirectory, { recursive: true });
  await writeFile(
    join(workspace, "config", "easy-bi.json"),
    JSON.stringify({
      knowledge: {
        report_requirements: [
          {
            id: "driver-detail",
            name: "司机明细",
            required_fields: [
              { field: "driver.code", label: "司机编码" },
              { field: "driver.name", label: "司机姓名" },
              { field: "driver.create_time", label: "创建时间" },
            ],
          },
        ],
      },
    }),
  );
  await writeFile(
    join(knowledge, "manifest.json"),
    JSON.stringify({
      catalog_format_version: "3",
      catalog_version: "0.1.0-draft",
      catalog_status: "draft",
      source_kind: "editable_draft",
      snapshot_hash: "snapshot-hash",
    }),
  );
  const field = (
    name: string,
    dataType: string,
    role: string,
    operator: string,
    inputType: string,
    primaryKey = false,
  ) => ({
    physical: {
      name,
      data_type: dataType,
      native_type: dataType,
      primary_key: primaryKey,
      comment: name,
    },
    semantic: {
      name,
      status: "inferred",
      report_ids: ["driver-detail"],
      enum_ref: null,
    },
    filter: {
      enabled: true,
      role,
      default_operator: operator,
      operators:
        operator === "between"
          ? ["between", "gte", "lte"]
          : operator === "contains"
            ? ["contains", "eq"]
            : ["eq", "in"],
      input_type: inputType,
      visibility: "user",
      required: false,
    },
  });
  await writeFile(
    join(tableDirectory, "driver.json"),
    JSON.stringify({
      table_id: "mysql-main_transport_driver",
      tier: "hot",
      schema_fingerprint: "schema-hash",
      physical: {
        profile_id: "mysql-main",
        database: "transport",
        table: "driver",
      },
      physical_fields: [
        field("id", "bigint", "business_identifier", "eq", "text", true),
        field("code", "varchar", "business_identifier", "eq", "text"),
        field("name", "varchar", "text", "contains", "text"),
        field(
          "create_time",
          "datetime",
          "time",
          "between",
          "datetime_range",
        ),
        field("is_delete", "tinyint", "system_condition", "eq", "boolean"),
        field("tenant_id", "bigint", "business_identifier", "eq", "text"),
      ],
      system_conditions: [
        { field: "is_delete", operator: "eq", value: 0 },
      ],
      security: { tenant_field: "tenant_id" },
    }),
  );
  const plan = join(workspace, "reports", "plans", "driver-detail.json");
  return { workspace, knowledge, plan };
}

async function addProductTable(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): Promise<void> {
  const tableDirectory = join(
    fixture.knowledge,
    "databases",
    "mysql-main",
    "transport",
    "hot",
    "tables",
  );
  const field = (name: string, dataType: string, role = "text") => ({
    physical: {
      name,
      data_type: dataType,
      native_type: dataType,
      primary_key: name === "id",
      comment: name,
    },
    semantic: {
      name,
      status: "inferred",
      report_ids: ["driver-detail"],
      enum_ref: null,
    },
    filter: {
      enabled: true,
      role,
      default_operator: role === "number" ? "between" : "contains",
      operators: role === "number" ? ["between", "gte", "lte"] : ["contains", "eq"],
      input_type: role === "number" ? "number_range" : "text",
      visibility: "user",
      required: false,
    },
  });
  await writeFile(
    join(tableDirectory, "driver_product.json"),
    JSON.stringify({
      table_id: "mysql-main_transport_driver_product",
      tier: "hot",
      schema_fingerprint: "product-schema-hash",
      physical: {
        profile_id: "mysql-main",
        database: "transport",
        table: "driver_product",
      },
      physical_fields: [
        field("id", "bigint", "business_identifier"),
        field("driver_id", "bigint", "business_identifier"),
        field("product_name", "varchar"),
        field("qty", "decimal", "number"),
        field("is_delete", "tinyint", "system_condition"),
      ],
      system_conditions: [{ field: "is_delete", operator: "eq", value: 0 }],
      security: {},
    }),
  );
  const configPath = join(fixture.workspace, "config", "easy-bi.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.knowledge.report_requirements[0].required_fields.push(
    { field: "driver_product.product_name", label: "货品名称" },
    { field: "driver_product.qty", label: "货品数量" },
  );
  await writeFile(configPath, JSON.stringify(config));
}

/** Add an enum column (status) to the driver table + a global/enums.json dict. */
async function addStatusEnumField(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): Promise<void> {
  const driverPath = join(
    fixture.knowledge,
    "databases",
    "mysql-main",
    "transport",
    "hot",
    "tables",
    "driver.json",
  );
  const driver = JSON.parse(await readFile(driverPath, "utf8"));
  driver.physical_fields.push({
    physical: { name: "status", data_type: "tinyint", native_type: "tinyint", primary_key: false, comment: "状态" },
    semantic: { name: "状态", status: "confirmed", report_ids: ["driver-detail"], enum_ref: "driver_status" },
    filter: {
      enabled: true,
      role: "enum",
      default_operator: "in",
      operators: ["in", "eq"],
      input_type: "select",
      visibility: "user",
      required: false,
    },
  });
  await writeFile(driverPath, JSON.stringify(driver));
  await mkdir(join(fixture.knowledge, "global"), { recursive: true });
  await writeFile(
    join(fixture.knowledge, "global", "enums.json"),
    JSON.stringify({
      schema_version: "2",
      dictionaries: [
        {
          name: "driver_status",
          values: [
            { value: "0", label: "停用" },
            { value: "1", label: "启用" },
          ],
        },
      ],
      bindings: [],
    }),
  );
  const configPath = join(fixture.workspace, "config", "easy-bi.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.knowledge.report_requirements[0].required_fields.push({ field: "driver.status", label: "状态" });
  await writeFile(configPath, JSON.stringify(config));
}

/**
 * Add a table in a DIFFERENT database (`settlement`) under the SAME profile
 * (`mysql-main`) — for cross-database JOIN within one connection.
 */
async function addSettlementTable(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): Promise<void> {
  const dir = join(
    fixture.knowledge,
    'databases',
    'mysql-main',
    'settlement',
    'hot',
    'tables',
  );
  await mkdir(dir, { recursive: true });
  const field = (name: string, dataType: string, role = 'text') => ({
    physical: { name, data_type: dataType, native_type: dataType, primary_key: name === 'id', comment: name },
    semantic: { name, status: 'inferred', report_ids: ['driver-detail'], enum_ref: null },
    filter: {
      enabled: true,
      role,
      default_operator: role === 'number' ? 'between' : 'contains',
      operators: role === 'number' ? ['between', 'gte', 'lte'] : ['contains', 'eq'],
      input_type: role === 'number' ? 'number_range' : 'text',
      visibility: 'user',
      required: false,
    },
  });
  await writeFile(
    join(dir, 'driver_fee.json'),
    JSON.stringify({
      table_id: 'mysql-main_settlement_driver_fee',
      tier: 'hot',
      schema_fingerprint: 'fee-schema-hash',
      physical: { profile_id: 'mysql-main', database: 'settlement', table: 'driver_fee' },
      physical_fields: [
        field('id', 'bigint', 'business_identifier'),
        field('driver_id', 'bigint', 'business_identifier'),
        field('total_fee', 'decimal', 'number'),
        field('is_delete', 'tinyint', 'system_condition'),
      ],
      system_conditions: [{ field: 'is_delete', operator: 'eq', value: 0 }],
      security: {},
    }),
  );
  const configPath = join(fixture.workspace, 'config', 'easy-bi.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.knowledge.report_requirements[0].required_fields.push({
    field: 'driver_fee.total_fee',
    label: '费用合计',
  });
  await writeFile(configPath, JSON.stringify(config));
}

async function configureJoin(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  extra: Record<string, unknown> = {},
): Promise<any> {
  const configurationPath = join(fixture.workspace, "reports", "plans", "configuration.json");
  await writeFile(
    configurationPath,
    JSON.stringify({
      joins: [
        {
          type: "LEFT",
          alias: "t1",
          on: [{ left: "t0.id", right: "t1.driver_id", operator: "eq" }],
          grain: "司机一对多货品",
        },
      ],
      ...extra,
    }),
  );
  return configurePlan(fixture.plan, configurationPath);
}

test("inspect reuses configured fields and derives strategy", async () => {
  const fixture = await createFixture();
  const plan = await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  assert.equal(plan.fields.length, 3);
  assert.equal(plan.parameters.length, 3);
  assert.deepEqual(plan.execution_policy.supported_modes, ["sync", "async"]);
  assert.equal(plan.context_bindings[0].required, false);
  assert.equal(plan.blockers.length, 0);
  assert.deepEqual(plan.ordering, [
    { expression: "t0.`create_time`", direction: "DESC" },
    { expression: "t0.`id`", direction: "DESC" },
  ]);
});

test("config-declared roles + description flow into the plan", async () => {
  const fixture = await createFixture();
  // Add roles + description to the requirement's config.
  const configPath = join(fixture.workspace, "config", "easy-bi.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const req = config.knowledge.report_requirements[0];
  req.description = "仅统计签收复核后";
  req.required_fields = [
    {
      field: "driver.code",
      label: "司机编码",
      roles: ["output", "filter"],
      description: "司机在系统中的唯一编码",
    },
    { field: "driver.name", label: "司机姓名", roles: ["group"] },
    { field: "driver.create_time", label: "创建时间" },
  ];
  await writeFile(configPath, JSON.stringify(config));
  const plan = await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  assert.equal(plan.report.description, "仅统计签收复核后");
  const code = plan.fields.find((f: any) => f.source.field === "code");
  const name = plan.fields.find((f: any) => f.source.field === "name");
  const ctime = plan.fields.find((f: any) => f.source.field === "create_time");
  assert.deepEqual(code.roles, ["output", "filter"]);
  assert.deepEqual(name.roles, ["group"]);
  assert.deepEqual(ctime.roles, []); // plain string → output-only
  // Per-field business description flows onto the resolved plan field so the AI
  // reading the plan understands the field's intent; empty when not authored.
  assert.equal(code.description, "司机在系统中的唯一编码");
  assert.equal(name.description, "");
  assert.equal(ctime.description, "");
});

test("create-time is a required datetime range filter", async () => {
  const fixture = await createFixture();
  const plan = await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  const ct = plan.parameters.find((p: any) => p.id === "create_time");
  assert.ok(ct, "应存在 create_time 参数");
  assert.equal(ct.value_type, "datetime_range");
  assert.equal(ct.component, "datetime-range");
  assert.equal(ct.default_operator, "between");
  assert.deepEqual(ct.operators, ["between", "gte", "lte"]);
  // Forced required even though the knowledge fixture marks it required:false.
  assert.equal(ct.required, true);
  // Non-date filters stay single-value and optional.
  const code = plan.parameters.find((p: any) => p.id === "code");
  assert.equal(code.value_type, "string");
  assert.equal(code.required, false);
  // The binding carries required + value_type for the runtime.
  await approvePlan(fixture.plan, "range-reviewer");
  const packageRoot = await generatePackage({ workspace: fixture.workspace, plan: fixture.plan });
  const bindings = JSON.parse(await readFile(join(packageRoot, "queries", "bindings.json"), "utf8"));
  const bound = bindings.parameters.find((p: any) => p.id === "create_time");
  assert.equal(bound.required, true);
  assert.equal(bound.value_type, "datetime_range");
  const validation = await validatePackage(packageRoot);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
});

test("parameters carry data_type and enum filters carry {code,label} options", async () => {
  const fixture = await createFixture();
  await addStatusEnumField(fixture);
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  await approvePlan(fixture.plan, "enum-reviewer");
  const packageRoot = await generatePackage({ workspace: fixture.workspace, plan: fixture.plan });
  const schema = JSON.parse(
    await readFile(join(packageRoot, "parameters.schema.json"), "utf8"),
  );
  const status = schema.parameters.find((p: any) => p.id === "status");
  assert.ok(status, "应存在 status 参数");
  assert.equal(status.data_type, "enum");
  assert.deepEqual(status.enum_options, [
    { code: "0", label: "停用" },
    { code: "1", label: "启用" },
  ]);
  // Non-enum params get a data_type too, and no enum_options.
  const code = schema.parameters.find((p: any) => p.id === "code");
  assert.equal(code.data_type, "string");
  assert.equal(code.enum_options, undefined);
  const ct = schema.parameters.find((p: any) => p.id === "create_time");
  assert.equal(ct.data_type, "datetime_range");
});

test("reseal re-checksums a development package after a manual edit", async () => {
  const fixture = await createFixture();
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  await approvePlan(fixture.plan, "reseal-reviewer");
  const packageRoot = await generatePackage({ workspace: fixture.workspace, plan: fixture.plan });
  // Hand-edit the SQL (add a harmless comment) — checksums now mismatch.
  const sqlPath = join(packageRoot, "queries", "main.sql");
  const edited = `${await readFile(sqlPath, "utf8")}\n-- manually reviewed\n`;
  await writeFile(sqlPath, edited);
  const broken = await validatePackage(packageRoot);
  assert.equal(broken.valid, false);
  assert.ok(broken.errors.some((e) => e.startsWith("校验和不匹配")));
  // Reseal accepts the edit, recomputes checksums, and re-validation passes.
  const resealed = await resealPackage(packageRoot);
  assert.equal(resealed.resealed, true, resealed.errors.join("\n"));
  const after = await validatePackage(packageRoot);
  assert.equal(after.valid, true, after.errors.join("\n"));
  assert.match(await readFile(sqlPath, "utf8"), /manually reviewed/);
});

test("reseal refuses when the manual edit breaks package structure", async () => {
  const fixture = await createFixture();
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  await approvePlan(fixture.plan, "reseal-reviewer");
  const packageRoot = await generatePackage({ workspace: fixture.workspace, plan: fixture.plan });
  // Corrupt the SQL: remove the required EASYBI_FILTERS marker.
  const sqlPath = join(packageRoot, "queries", "main.sql");
  const corrupt = (await readFile(sqlPath, "utf8")).replace("/* EASYBI_FILTERS */", "");
  await writeFile(sqlPath, corrupt);
  const result = await resealPackage(packageRoot);
  assert.equal(result.resealed, false);
  assert.ok(result.errors.some((e) => e.includes("EASYBI_FILTERS")));
});

test("generation requires approval and produces a valid package", async () => {
  const fixture = await createFixture();
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  await assert.rejects(
    generatePackage({ workspace: fixture.workspace, plan: fixture.plan }),
    /未批准/,
  );
  await approvePlan(fixture.plan, "test-reviewer");
  const packageRoot = await generatePackage({
    workspace: fixture.workspace,
    plan: fixture.plan,
  });
  const result = await validatePackage(packageRoot);
  assert.equal(result.valid, true, result.errors.join("\n"));
  assert.equal(result.warnings.length, 1);
  const sql = await readFile(join(packageRoot, "queries", "main.sql"), "utf8");
  assert.match(sql, /EASYBI_FILTERS/);
  assert.match(sql, /ORDER BY t0\.`create_time` DESC, t0\.`id` DESC/);
  assert.doesNotMatch(sql, /AND\s+\/\* EASYBI_FILTERS/);
  assert.doesNotMatch(sql, /\$\{/);
});

test("falls back to id descending when create time is absent", async () => {
  const fixture = await createFixture();
  const tablePath = join(
    fixture.knowledge,
    "databases",
    "mysql-main",
    "transport",
    "hot",
    "tables",
    "driver.json",
  );
  const table = JSON.parse(await readFile(tablePath, "utf8"));
  table.physical_fields = table.physical_fields.filter(
    (field: any) => field.physical.name !== "create_time",
  );
  await writeFile(tablePath, JSON.stringify(table));
  const configPath = join(fixture.workspace, "config", "easy-bi.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.knowledge.report_requirements[0].required_fields =
    config.knowledge.report_requirements[0].required_fields.filter(
      (field: any) => !field.field.endsWith(".create_time"),
    );
  await writeFile(configPath, JSON.stringify(config));
  const plan = await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  assert.deepEqual(plan.ordering, [
    { expression: "t0.`id`", direction: "DESC" },
  ]);
});

test("inspect resolves a unique Chinese semantic field name", async () => {
  const fixture = await createFixture();
  const tablePath = join(
    fixture.knowledge,
    "databases",
    "mysql-main",
    "transport",
    "hot",
    "tables",
    "driver.json",
  );
  const table = JSON.parse(await readFile(tablePath, "utf8"));
  table.physical_fields.find((field: any) => field.physical.name === "code").semantic.name =
    "司机编码";
  await writeFile(tablePath, JSON.stringify(table));
  const configPath = join(fixture.workspace, "config", "easy-bi.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.knowledge.report_requirements[0].required_fields = ["司机编码"];
  await writeFile(configPath, JSON.stringify(config));
  const plan = await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  assert.equal(plan.blockers.length, 0);
  assert.equal(plan.fields[0].source.field, "code");
  assert.equal(plan.fields[0].label, "司机编码");
});

test("inspect reports semantic ambiguity and useful table.field suggestions", async () => {
  const fixture = await createFixture();
  await addProductTable(fixture);
  const driverPath = join(
    fixture.knowledge,
    "databases",
    "mysql-main",
    "transport",
    "hot",
    "tables",
    "driver.json",
  );
  const productPath = join(
    fixture.knowledge,
    "databases",
    "mysql-main",
    "transport",
    "hot",
    "tables",
    "driver_product.json",
  );
  const driver = JSON.parse(await readFile(driverPath, "utf8"));
  const product = JSON.parse(await readFile(productPath, "utf8"));
  driver.physical_fields.find((field: any) => field.physical.name === "name").semantic.name =
    "业务名称";
  driver.physical_fields.find((field: any) => field.physical.name === "code").semantic.name =
    "司机编码";
  product.physical_fields.find(
    (field: any) => field.physical.name === "product_name",
  ).semantic.name = "业务名称";
  await writeFile(driverPath, JSON.stringify(driver));
  await writeFile(productPath, JSON.stringify(product));
  const configPath = join(fixture.workspace, "config", "easy-bi.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.knowledge.report_requirements[0].required_fields = [
    "业务名称",
    "司机编",
  ];
  await writeFile(configPath, JSON.stringify(config));
  const plan = await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  const ambiguous = plan.blockers.find(
    (item: any) => item.code === "FIELD_AMBIGUOUS",
  );
  assert.equal(ambiguous.candidates.length, 2);
  const missing = plan.blockers.find((item: any) => item.code === "FIELD_NOT_FOUND");
  assert.ok(missing.suggestions.includes("driver.code"));
  assert.match(missing.message, /你可能想要/);
});

test("checksum changes are detected", async () => {
  const fixture = await createFixture();
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  await approvePlan(fixture.plan, "test-reviewer");
  const packageRoot = await generatePackage({
    workspace: fixture.workspace,
    plan: fixture.plan,
  });
  await writeFile(join(packageRoot, "fields.json"), "{}\n");
  const result = await validatePackage(packageRoot);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.includes("校验和不匹配")));
});

test("v2 plan resolves a multi-table LEFT JOIN and locks every source", async () => {
  const fixture = await createFixture();
  await addProductTable(fixture);
  const inspected = await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  assert.ok(inspected.blockers.some((item: any) => item.code === "JOIN_REQUIRED"));
  const configured = await configureJoin(fixture);
  assert.equal(configured.blockers.length, 0);
  assert.ok(configured.warnings.some((item: any) => item.code === "JOIN_RESOLVED"));
  await approvePlan(fixture.plan, "join-reviewer");
  const packageRoot = await generatePackage({
    workspace: fixture.workspace,
    plan: fixture.plan,
  });
  const sql = await readFile(join(packageRoot, "queries", "main.sql"), "utf8");
  assert.match(sql, /LEFT JOIN `transport`\.`driver_product` AS t1/);
  assert.match(sql, /ON t0\.`id` = t1\.`driver_id`/);
  assert.match(sql, /t1\.`is_delete` = :__join_t1_is_delete_1/);
  assert.match(sql, /t1\.`product_name` AS `product_name`/);
  const lock = JSON.parse(
    await readFile(join(packageRoot, "knowledge.lock.json"), "utf8"),
  );
  assert.equal(lock.sources.length, 2);
  assert.deepEqual(lock.sources.map((item: any) => item.alias), ["t0", "t1"]);
  const validation = await validatePackage(packageRoot);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
});

test("cross-database JOIN within one profile qualifies each table with its own database", async () => {
  const fixture = await createFixture();
  await addSettlementTable(fixture);
  const inspected = await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  // t0 (transport.driver) + t1 (settlement.driver_fee) — same profile, different DB.
  assert.ok(inspected.blockers.some((item: any) => item.code === "JOIN_REQUIRED"));
  const configured = await configureJoin(fixture, {
    joins: [
      {
        type: "LEFT",
        alias: "t1",
        on: [{ left: "t0.id", right: "t1.driver_id", operator: "eq" }],
        grain: "司机一对一费用",
      },
    ],
  });
  assert.equal(configured.blockers.length, 0);
  await approvePlan(fixture.plan, "xdb-reviewer");
  const packageRoot = await generatePackage({ workspace: fixture.workspace, plan: fixture.plan });
  const sql = await readFile(join(packageRoot, "queries", "main.sql"), "utf8");
  // Primary from transport; joined table qualified with its OWN database (settlement).
  assert.match(sql, /FROM `transport`\.`driver` AS t0/);
  assert.match(sql, /LEFT JOIN `settlement`\.`driver_fee` AS t1/);
  assert.match(sql, /t1\.`total_fee` AS `total_fee`/);
  const validation = await validatePackage(packageRoot);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
});

test("v2 SQL aggregate fields generate GROUP BY and parameterized HAVING", async () => {
  const fixture = await createFixture();
  await addProductTable(fixture);
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  await configureJoin(fixture, {
    fields: [
      {
        id: "qty",
        source: {
          kind: "sql_expression",
          expression: "SUM(t1.`qty`)",
          aggregate: true,
          dependencies: [{ alias: "t1", field: "qty" }],
        },
        sql_binding: {
          expression: "SUM(t1.`qty`)",
          clause: "having",
        },
      },
    ],
    aggregation: {
      group_by: [
        "t0.id",
        "t0.code",
        "t0.name",
        "t0.create_time",
        "t1.product_name",
      ],
      having: [],
    },
  });
  await approvePlan(fixture.plan, "aggregate-reviewer");
  const packageRoot = await generatePackage({
    workspace: fixture.workspace,
    plan: fixture.plan,
  });
  const sql = await readFile(join(packageRoot, "queries", "main.sql"), "utf8");
  assert.match(sql, /SUM\(t1\.`qty`\) AS `qty`/);
  assert.match(sql, /GROUP BY t0\.`id`, t0\.`code`/);
  assert.match(sql, /HAVING\n  1 = 1\n\/\* EASYBI_HAVING_FILTERS \*\//);
  const bindings = JSON.parse(
    await readFile(join(packageRoot, "queries", "bindings.json"), "utf8"),
  );
  assert.equal(
    bindings.parameters.find((item: any) => item.id === "qty").clause,
    "having",
  );
  const validation = await validatePackage(packageRoot);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
});

test("grouped query drops the default create-time/id ordering when they are not group keys", async () => {
  const fixture = await createFixture();
  await addProductTable(fixture);
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  // Group only by product_name — neither create_time nor id is a group key, so
  // the inspect-time default ORDER BY t0.`create_time`, t0.`id` would be invalid
  // SQL under this GROUP BY and must be dropped.
  await configureJoin(fixture, {
    fields: [
      {
        id: "qty",
        source: {
          kind: "sql_expression",
          expression: "SUM(t1.`qty`)",
          aggregate: true,
          dependencies: [{ alias: "t1", field: "qty" }],
        },
        sql_binding: { expression: "SUM(t1.`qty`)", clause: "having" },
      },
    ],
    aggregation: { group_by: ["t1.product_name"], having: [] },
  });
  await approvePlan(fixture.plan, "aggregate-reviewer");
  const packageRoot = await generatePackage({
    workspace: fixture.workspace,
    plan: fixture.plan,
  });
  const sql = await readFile(join(packageRoot, "queries", "main.sql"), "utf8");
  assert.match(sql, /GROUP BY t1\.`product_name`/);
  assert.doesNotMatch(sql, /ORDER BY[^;]*t0\.`create_time`/);
  assert.doesNotMatch(sql, /ORDER BY[^;]*t0\.`id`/);
  const validation = await validatePackage(packageRoot);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
});

test("default ordering picks up a gmt_create column even when create-time is not an output field", async () => {
  const fixture = await createFixture();
  // Rename the driver's create_time column to gmt_create and drop it from the
  // report's output fields; the default sort should still find it by name.
  const tablePath = join(
    fixture.knowledge,
    "databases",
    "mysql-main",
    "transport",
    "hot",
    "tables",
    "driver.json",
  );
  const table = JSON.parse(await readFile(tablePath, "utf8"));
  for (const f of table.physical_fields) {
    if (f.physical.name === "create_time") f.physical.name = "gmt_create";
  }
  await writeFile(tablePath, JSON.stringify(table));
  const configPath = join(fixture.workspace, "config", "easy-bi.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.knowledge.report_requirements[0].required_fields =
    config.knowledge.report_requirements[0].required_fields.filter(
      (field: any) =>
        !(typeof field === "object" && String(field.field).endsWith(".create_time")),
    );
  await writeFile(configPath, JSON.stringify(config));
  const plan = await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  assert.deepEqual(plan.ordering, [
    { expression: "t0.`gmt_create`", direction: "DESC" },
    { expression: "t0.`id`", direction: "DESC" },
  ]);
});

test("aggregated one-to-many field filter is auto-routed to a correlated EXISTS subquery", async () => {
  const fixture = await createFixture();
  await addProductTable(fixture);
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  // Make product_name a GROUP_CONCAT of the one-to-many child rows but DO NOT
  // touch its filter binding — the CLI must push the filter down to EXISTS.
  const configured = await configureJoin(fixture, {
    fields: [
      {
        id: "product_name",
        source: {
          kind: "sql_expression",
          expression: "GROUP_CONCAT(DISTINCT t1.`product_name`)",
          dependencies: [{ alias: "t1", field: "product_name" }],
        },
      },
    ],
    aggregation: { group_by: ["t0.id", "t0.code", "t0.name", "t0.create_time"], having: [] },
  });
  const param = configured.parameters.find((item: any) => item.id === "product_name");
  assert.equal(param.sql_binding.clause, "exists_subquery");
  assert.equal(param.sql_binding.value_adapter, "contains");
  // Inner predicate matches the raw child column, not the concatenated value.
  assert.equal(param.sql_binding.expression, "ex_t1.`product_name`");
  // Skeleton correlates the child back to the parent and keeps logical-delete.
  assert.match(param.sql_binding.subquery_prefix, /^EXISTS \(SELECT 1 FROM `transport`\.`driver_product` AS ex_t1 WHERE /);
  assert.match(param.sql_binding.subquery_prefix, /ex_t1\.`driver_id` = t0\.`id`/);
  assert.match(param.sql_binding.subquery_prefix, /ex_t1\.`is_delete` = 0/);
  assert.equal(param.sql_binding.subquery_suffix, ")");
  assert.equal(param.default_operator, "contains");
  await approvePlan(fixture.plan, "agg-filter-reviewer");
  const packageRoot = await generatePackage({ workspace: fixture.workspace, plan: fixture.plan });
  const bindings = JSON.parse(
    await readFile(join(packageRoot, "queries", "bindings.json"), "utf8"),
  );
  const bound = bindings.parameters.find((item: any) => item.id === "product_name");
  assert.equal(bound.clause, "exists_subquery");
  assert.ok(bound.subquery_prefix.startsWith("EXISTS (SELECT 1 FROM"));
  const validation = await validatePackage(packageRoot);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
});

test("v2 generator emits executable row and streaming-group computation hooks", async () => {
  const fixture = await createFixture();
  await addProductTable(fixture);
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  await configureJoin(fixture, {
    fields: [
      {
        id: "product_name",
        source: {
          kind: "computed",
          mode: "row",
          dependencies: [
            { id: "raw_product_name", alias: "t1", field: "product_name" },
          ],
          expression: "String(row.raw_product_name ?? '').toUpperCase()",
        },
      },
      {
        id: "qty",
        source: {
          kind: "computed",
          mode: "group",
          dependencies: [{ id: "raw_qty", alias: "t1", field: "qty" }],
          expression:
            "rows.reduce((sum, row) => sum + Number(row.raw_qty ?? 0), 0)",
        },
      },
    ],
    custom_logic: {
      group_keys: ["code"],
      max_group_rows: 1000,
      description: "货品名称逐行标准化并按司机汇总数量",
    },
  });
  await approvePlan(fixture.plan, "computed-reviewer");
  const packageRoot = await generatePackage({
    workspace: fixture.workspace,
    plan: fixture.plan,
  });
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "report.manifest.json"), "utf8"),
  );
  assert.equal(manifest.custom_logic.mode, "group");
  assert.deepEqual(manifest.custom_logic.group_keys, ["code"]);
  const sql = await readFile(join(packageRoot, "queries", "main.sql"), "utf8");
  assert.match(sql, /t1\.`product_name` AS `raw_product_name`/);
  assert.match(sql, /t1\.`qty` AS `raw_qty`/);
  assert.match(sql, /ORDER BY `code` ASC/);
  const transform = (await import(
    `${pathToFileURL(join(packageRoot, "transforms", "index.mjs")).href}?test=${Date.now()}`
  )) as any;
  const transformed = transform.transformGroup(
    [
      { code: "D1", raw_product_name: "apple", raw_qty: "2" },
      { code: "D1", raw_product_name: "pear", raw_qty: "3" },
    ],
    { groupKey: ["D1"] },
  );
  assert.equal(transformed.product_name, "APPLE");
  assert.equal(transformed.qty, 5);
  const validation = await validatePackage(packageRoot);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
});

test("configure-plan drops the filter of a field turned into a computed field and warns", async () => {
  const fixture = await createFixture();
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  // create_time started as a required datetime-range filter; turning it into a
  // computed (derived) field must remove that parameter and warn.
  const before = await readFile(fixture.plan, "utf8");
  assert.ok(
    JSON.parse(before).parameters.some((p: any) => p.id === "create_time"),
    "前置条件：create_time 原本是筛选参数",
  );
  const configurationPath = join(
    fixture.workspace,
    "reports",
    "plans",
    "configuration.json",
  );
  await writeFile(
    configurationPath,
    JSON.stringify({
      fields: [
        {
          id: "create_time",
          source: {
            kind: "computed",
            mode: "row",
            dependencies: [{ id: "raw_ct", alias: "t0", field: "create_time" }],
            expression: "String(row.raw_ct ?? '')",
          },
        },
      ],
    }),
  );
  const plan = await configurePlan(fixture.plan, configurationPath);
  assert.ok(
    !plan.parameters.some((p: any) => p.id === "create_time"),
    "计算字段的筛选参数应被删除",
  );
  const warning = plan.warnings.find((w: any) => w.code === "FILTER_DROPPED_COMPUTED");
  assert.ok(warning, "应产生 FILTER_DROPPED_COMPUTED 警告");
  assert.ok(warning.fields.some((f: any) => f.id === "create_time"));
});

test("configure-plan makes a numeric filterable computed field a post_transform range filter", async () => {
  const fixture = await createFixture();
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  const configurationPath = join(
    fixture.workspace,
    "reports",
    "plans",
    "configuration.json",
  );
  // Add a NEW numeric computed field (transform-produced 件数总和 analogue) that the
  // config marks filterable. It must become a post_transform number-range param,
  // NOT be dropped.
  await writeFile(
    configurationPath,
    JSON.stringify({
      fields: [
        {
          id: "sum_qty",
          label: "件数总和",
          output_type: "number",
          roles: ["output", "filter"],
          source: {
            kind: "computed",
            mode: "row",
            dependencies: [{ id: "raw_code", alias: "t0", field: "code" }],
            expression: "Number(row.raw_code ?? 0)",
          },
        },
      ],
    }),
  );
  const plan = await configurePlan(fixture.plan, configurationPath);
  const param = plan.parameters.find((p: any) => p.id === "sum_qty");
  assert.ok(param, "数值计算字段应生成筛选参数");
  assert.equal(param.value_type, "number_range");
  assert.equal(param.component, "number-range");
  assert.equal(param.sql_binding.clause, "post_transform");
  assert.deepEqual(param.operators, ["between", "gte", "lte"]);
  // It must NOT appear in the dropped-filter warning.
  const warning = plan.warnings.find((w: any) => w.code === "FILTER_DROPPED_COMPUTED");
  assert.ok(
    !warning || !warning.fields.some((f: any) => f.id === "sum_qty"),
    "数值可筛选计算字段不应被列为已丢弃",
  );
});

test("validate rejects a hand-edited plan that keeps a filter on a computed field", async () => {
  const fixture = await createFixture();
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  // Hand-edit: make create_time computed but leave its parameter in place.
  const plan = JSON.parse(await readFile(fixture.plan, "utf8"));
  const field = plan.fields.find((f: any) => f.id === "create_time");
  field.source = {
    kind: "computed",
    mode: "row",
    dependencies: [{ id: "raw_ct", alias: "t0", field: "create_time" }],
    expression: "String(row.raw_ct ?? '')",
  };
  await writeFile(fixture.plan, JSON.stringify(plan));
  await assert.rejects(
    approvePlan(fixture.plan, "reviewer"),
    /计算字段 create_time 不能作为 SQL 筛选参数/,
  );
});

test("comparison (环比/同比) package: generates, validates, and computes chain/yoy in the group transform", async () => {
  const fixture = await createFixture();
  await addProductTable(fixture);
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  // Group by driver code; the group transform sees every row in the widened
  // window (current + look-back months) and computes the latest month's qty plus
  // the chain (vs previous month) delta. create_time is the required month range.
  // Override the existing `qty` and `product_name` fields into computed group
  // fields (configure-plan overrides fields by id, so we reuse resolved ids).
  await configureJoin(fixture, {
    fields: [
      {
        id: "qty",
        output_type: "number",
        source: {
          kind: "computed",
          mode: "group",
          dependencies: [
            { id: "raw_month", alias: "t0", field: "create_time" },
            { id: "raw_qty", alias: "t1", field: "qty" },
          ],
          expression:
            "(() => { const b={}; for (const r of rows){ const m=String(r.raw_month).slice(0,7); b[m]=(b[m]||0)+Number(r.raw_qty||0);} const ms=Object.keys(b).sort(); return ms.length ? b[ms[ms.length-1]] : 0; })()",
        },
      },
      {
        id: "product_name",
        output_type: "number",
        source: {
          kind: "computed",
          mode: "group",
          dependencies: [
            { id: "raw_month", alias: "t0", field: "create_time" },
            { id: "raw_qty", alias: "t1", field: "qty" },
          ],
          expression:
            "(() => { const b={}; for (const r of rows){ const m=String(r.raw_month).slice(0,7); b[m]=(b[m]||0)+Number(r.raw_qty||0);} const ms=Object.keys(b).sort(); if (ms.length<2) return 0; return b[ms[ms.length-1]] - b[ms[ms.length-2]]; })()",
        },
      },
    ],
    custom_logic: {
      group_keys: ["code"],
      max_group_rows: 100000,
      description: "按司机分组，计算最近一个月货量及其环比变化量",
    },
    comparison: {
      period_param: "create_time",
      modes: ["chain", "yoy"],
      lookback_months: 1,
    },
  });
  const plan = JSON.parse(await readFile(fixture.plan, "utf8"));
  assert.equal(plan.comparison.enabled, true);
  assert.deepEqual(plan.comparison.modes, ["chain", "yoy"]);
  assert.equal(plan.custom_logic.mode, "group");

  await approvePlan(fixture.plan, "comparison-reviewer");
  const packageRoot = await generatePackage({
    workspace: fixture.workspace,
    plan: fixture.plan,
  });
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "report.manifest.json"), "utf8"),
  );
  assert.equal(manifest.comparison.enabled, true);
  assert.equal(manifest.comparison.period_param, "create_time");
  const sql = await readFile(join(packageRoot, "queries", "main.sql"), "utf8");
  assert.match(sql, /t0\.`create_time` AS `raw_month`/);
  assert.match(sql, /t1\.`qty` AS `raw_qty`/);

  const transform = (await import(
    `${pathToFileURL(join(packageRoot, "transforms", "index.mjs")).href}?test=${Date.now()}`
  )) as any;
  // Two months in the widened window: 2026-03 total 10, 2026-04 total 30.
  const out = transform.transformGroup(
    [
      { code: "D1", raw_month: "2026-03-15 00:00:00", raw_qty: "4" },
      { code: "D1", raw_month: "2026-03-20 00:00:00", raw_qty: "6" },
      { code: "D1", raw_month: "2026-04-05 00:00:00", raw_qty: "12" },
      { code: "D1", raw_month: "2026-04-25 00:00:00", raw_qty: "18" },
    ],
    { groupKey: ["D1"] },
  );
  // qty = latest month (2026-04) total = 30; product_name (reused id) = chain
  // delta = 30 − 10 = 20.
  assert.equal(out.qty, 30);
  assert.equal(out.product_name, 20);

  const validation = await validatePackage(packageRoot);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
});

test("comparison auto-adds a required create-time month filter and appends new computed fields (no create_time required_field)", async () => {
  const fixture = await createFixture();
  // Drop create_time from required_fields: the report only outputs code + name.
  // Comparison must still work — the skill defaults the period filter to the
  // primary table's create-time column and appends the new computed delta field.
  const configPath = join(fixture.workspace, "config", "easy-bi.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.knowledge.report_requirements[0].required_fields = [
    { field: "driver.code", label: "司机编码" },
    { field: "driver.name", label: "司机姓名" },
  ];
  await writeFile(configPath, JSON.stringify(config));
  await addProductTable(fixture);
  const inspected = await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  // inspect records the create-time candidate but derives NO create_time filter
  // (it's not a required_field, only used for default ordering).
  assert.equal(inspected.default_period_candidates.length, 1);
  assert.equal(inspected.default_period_candidates[0].field, "create_time");
  assert.ok(!(inspected.parameters ?? []).some((p: any) => p.id === "create_time"));

  // Declare a BRAND-NEW computed group field (id not in the plan yet) + comparison
  // WITHOUT naming period_param — the skill must synthesize the month filter.
  const plan = await configureJoin(fixture, {
    fields: [
      {
        id: "qty_mom",
        label: "货量环比",
        output_type: "number",
        source: {
          kind: "computed",
          mode: "group",
          dependencies: [
            { id: "raw_month", alias: "t0", field: "create_time" },
            { id: "raw_qty", alias: "t1", field: "qty" },
          ],
          expression:
            "(() => { const b={}; for (const r of rows){ const m=String(r.raw_month).slice(0,7); b[m]=(b[m]||0)+Number(r.raw_qty||0);} const ms=Object.keys(b).sort(); if (ms.length<2) return 0; return b[ms[ms.length-1]] - b[ms[ms.length-2]]; })()",
        },
      },
    ],
    custom_logic: { group_keys: ["code"], max_group_rows: 100000, description: "环比" },
    comparison: { modes: ["chain", "yoy"], lookback_months: 1 },
  });
  // The new computed field was appended, not dropped.
  assert.ok(plan.fields.some((f: any) => f.id === "qty_mom"));
  // A required datetime month range was synthesized and pointed at by comparison.
  const period = plan.parameters.find((p: any) => p.id === "create_time");
  assert.ok(period, "应自动新增 create_time 按月筛选");
  assert.equal(period.required, true);
  assert.equal(period.value_type, "datetime_range");
  assert.equal(plan.comparison.period_param, "create_time");
  assert.equal(plan.custom_logic.mode, "group");
  assert.ok(
    (plan.warnings ?? []).some((w: any) => w.code === "PERIOD_FILTER_ADDED"),
    "应产出 PERIOD_FILTER_ADDED 警告供 AI 告知用户",
  );

  await approvePlan(fixture.plan, "reviewer");
  const packageRoot = await generatePackage({
    workspace: fixture.workspace,
    plan: fixture.plan,
  });
  const validation = await validatePackage(packageRoot);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
});

test("configure-plan rejects a brand-new column field (must go through required_fields)", async () => {
  const fixture = await createFixture();
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  const configurationPath = join(fixture.workspace, "reports", "plans", "cfg.json");
  await writeFile(
    configurationPath,
    JSON.stringify({
      fields: [
        { id: "brand_new_col", source: { kind: "column", alias: "t0", field: "code" } },
      ],
    }),
  );
  await assert.rejects(configurePlan(fixture.plan, configurationPath), /只能新增 computed/);
});

test("configure-plan resolves a natural-language business metric blocker explicitly", async () => {
  const fixture = await createFixture();
  const configPath = join(fixture.workspace, "config", "easy-bi.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.knowledge.report_requirements[0].required_fields.push({
    field: "订单量",
    label: "订单量",
    description: "按订单主键去重计数",
  });
  await writeFile(configPath, JSON.stringify(config));
  await inspectDriver(fixture);

  const inspected = JSON.parse(await readFile(fixture.plan, "utf8"));
  const blocker = inspected.blockers.find((item: any) => item.code === "FIELD_NOT_FOUND");
  assert.ok(blocker?.field_id, "unresolved metric should expose a deterministic field_id");

  const configurationPath = join(fixture.workspace, "reports", "plans", "metric.json");
  await writeFile(
    configurationPath,
    JSON.stringify({
      fields: [
        {
          id: blocker.field_id,
          label: "订单量",
          output_type: "number",
          source: {
            kind: "computed",
            mode: "row",
            dependencies: [{ id: "raw_order_id", alias: "t0", field: "id" }],
            expression: "1",
          },
        },
      ],
    }),
  );

  const configured = await configurePlan(fixture.plan, configurationPath);
  assert.equal(
    configured.blockers.some((item: any) => item.code === "FIELD_NOT_FOUND"),
    false,
  );
  assert.ok(
    configured.warnings.some((item: any) => item.code === "BUSINESS_METRICS_RESOLVED"),
  );
});

test("configure-plan rejects comparison whose period_param is not a required month range", async () => {
  const fixture = await createFixture();
  await addProductTable(fixture);
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  await assert.rejects(
    configureJoin(fixture, {
      fields: [
        {
          id: "qty_current",
          source: {
            kind: "computed",
            mode: "group",
            dependencies: [{ id: "raw_qty", alias: "t1", field: "qty" }],
            expression: "rows.reduce((s, r) => s + Number(r.raw_qty || 0), 0)",
          },
        },
      ],
      custom_logic: { group_keys: ["code"], max_group_rows: 1000, description: "x" },
      // product_name is a text filter, not a month range → must be rejected.
      comparison: { period_param: "product_name", modes: ["chain"], lookback_months: 1 },
    }),
    /period_param/,
  );
});

test("postgresql engine generates double-quoted identifiers and records sql_dialect", async () => {
  const fixture = await createFixture();
  const configPath = join(fixture.workspace, "config", "easy-bi.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  // Map the table's profile to a PostgreSQL connector so generation picks pg quoting.
  config.connections = {
    database_profiles: [{ id: "mysql-main", connector_id: "postgresql" }],
  };
  await writeFile(configPath, JSON.stringify(config));
  const plan = await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  assert.equal(plan.sql_dialect, "postgresql");
  assert.deepEqual(plan.ordering, [
    { expression: 't0."create_time"', direction: "DESC" },
    { expression: 't0."id"', direction: "DESC" },
  ]);
  await approvePlan(fixture.plan, "pg-reviewer");
  const packageRoot = await generatePackage({
    workspace: fixture.workspace,
    plan: fixture.plan,
  });
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "report.manifest.json"), "utf8"),
  );
  assert.equal(manifest.sql_dialect, "postgresql");
  const sql = await readFile(join(packageRoot, "queries", "main.sql"), "utf8");
  assert.match(sql, /FROM "transport"\."driver" AS t0/);
  assert.match(sql, /t0\."code" AS "code"/);
  assert.match(sql, /ORDER BY t0\."create_time" DESC, t0\."id" DESC/);
  assert.doesNotMatch(sql, /`/);
  const validation = await validatePackage(packageRoot);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
});

test("v2-only validator rejects a v1 report package", async () => {
  const fixture = await createFixture();
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  await approvePlan(fixture.plan, "v2-only-reviewer");
  const packageRoot = await generatePackage({
    workspace: fixture.workspace,
    plan: fixture.plan,
  });
  const manifestPath = join(packageRoot, "report.manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.report_package_format_version = "1";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const validation = await validatePackage(packageRoot);
  assert.equal(validation.valid, false);
  assert.ok(
    validation.errors.includes("只支持 report_package_format_version=2"),
  );
});

// ── enrichment (batch secondary-query, generation side) ─────────────────────

/** Add a lookup table (`driver_sku`, one-to-many child of driver via driver_id)
 * to knowledge WITHOUT adding it to required_fields — it is used as an enrichment
 * lookup, not a JOIN. */
async function addSkuLookupTable(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): Promise<void> {
  const dir = join(fixture.knowledge, "databases", "mysql-main", "transport", "hot", "tables");
  const field = (name: string, dataType: string) => ({
    physical: { name, data_type: dataType, native_type: dataType, primary_key: name === "id", comment: name },
    semantic: { name, status: "inferred", report_ids: ["driver-detail"], enum_ref: null },
    filter: { enabled: true, role: "text", default_operator: "contains", operators: ["contains", "eq"], input_type: "text", visibility: "user", required: false },
  });
  await writeFile(
    join(dir, "driver_sku.json"),
    JSON.stringify({
      table_id: "mysql-main_transport_driver_sku",
      tier: "hot",
      schema_fingerprint: "sku-schema-hash",
      physical: { profile_id: "mysql-main", database: "transport", table: "driver_sku" },
      physical_fields: [
        field("id", "bigint"),
        field("driver_code", "varchar"),
        field("sku_name", "varchar"),
        field("is_delete", "tinyint"),
      ],
      system_conditions: [{ field: "is_delete", operator: "eq", value: 0 }],
      security: {},
    }),
  );
}

async function inspectDriver(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<void> {
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
}

test("enrichment (many/group_concat) writes plan.enrichments, an enrichment field, binding + lock", async () => {
  const fixture = await createFixture();
  await addSkuLookupTable(fixture);
  await inspectDriver(fixture);
  const configurationPath = join(fixture.workspace, "reports", "plans", "enrich.json");
  await writeFile(
    configurationPath,
    JSON.stringify({
      // Emit the join key column as a normal output column (raw key on the main query).
      enrichments: [
        {
          id: "sku_lookup",
          lookup: { profile_id: "mysql-main", database: "transport", table: "driver_sku", alias: "lk_sku" },
          on: { source: "main", main_field: "code", lookup_field: "driver_code" },
          cardinality: "many",
          aggregate: { kind: "group_concat", distinct: true, separator: "," },
          select: [{ id: "sku_name", label: "商品名称", lookup_field: "sku_name", output_type: "string" }],
          on_missing: "null",
        },
      ],
    }),
  );
  const plan = await configurePlan(fixture.plan, configurationPath);
  // plan.enrichments recorded, lookup resolved from knowledge (table_id/fingerprint filled).
  assert.equal(plan.enrichments.length, 1);
  assert.equal(plan.enrichments[0].lookup.table_id, "mysql-main_transport_driver_sku");
  assert.equal(plan.enrichments[0].on.main_field, "code");
  // A new enrichment-kind field appears.
  const skuField = plan.fields.find((f: any) => f.id === "sku_name");
  assert.equal(skuField.source.kind, "enrichment");
  assert.equal(skuField.source.enrichment_id, "sku_lookup");
  // Enrichment is NOT a JOIN: lookup table is not added to source.tables.
  assert.ok(!(plan.source.tables ?? []).some((t: any) => t.table === "driver_sku"));

  await approvePlan(fixture.plan, "reviewer");
  const packageRoot = await generatePackage({ workspace: fixture.workspace, plan: fixture.plan });

  const bindings = JSON.parse(await readFile(join(packageRoot, "queries", "bindings.json"), "utf8"));
  assert.equal(bindings.enrichments.length, 1);
  assert.match(bindings.enrichments[0].sql_template, /\/\* KEYS \*\//);
  assert.match(bindings.enrichments[0].sql_template, /driver_sku/);
  assert.equal(bindings.enrichments[0].cardinality, "many");

  // main.sql must NOT JOIN the lookup table.
  const sql = await readFile(join(packageRoot, "queries", "main.sql"), "utf8");
  assert.ok(!/JOIN.*driver_sku/i.test(sql));

  // Lock includes the lookup table as kind=enrichment with its used columns.
  const lock = JSON.parse(await readFile(join(packageRoot, "knowledge.lock.json"), "utf8"));
  const skuSource = lock.sources.find((s: any) => s.table === "driver_sku");
  assert.equal(skuSource.kind, "enrichment");
  assert.ok(skuSource.fields.includes("sku_name"));
  assert.ok(skuSource.fields.includes("driver_code"));

  const validation = await validatePackage(packageRoot);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
});

test("filterable enrichment field pushes the filter down to an EXISTS subquery", async () => {
  const fixture = await createFixture();
  await addSkuLookupTable(fixture);
  await inspectDriver(fixture);
  const configurationPath = join(fixture.workspace, "reports", "plans", "enrich-filter.json");
  await writeFile(
    configurationPath,
    JSON.stringify({
      enrichments: [
        {
          id: "sku_lookup",
          lookup: { profile_id: "mysql-main", database: "transport", table: "driver_sku", alias: "lk_sku" },
          on: { source: "main", main_field: "code", lookup_field: "driver_code" },
          cardinality: "many",
          aggregate: { kind: "group_concat", distinct: true, separator: "," },
          // filter role → EXISTS pushdown
          select: [{ id: "sku_name", label: "商品名称", lookup_field: "sku_name", output_type: "string", roles: ["output", "filter"] }],
          on_missing: "null",
        },
      ],
    }),
  );
  const plan = await configurePlan(fixture.plan, configurationPath);
  // A parameter is synthesized for the filterable enrichment column, as EXISTS.
  const param = plan.parameters.find((p: any) => p.id === "sku_name");
  assert.ok(param, "sku_name filter parameter should exist");
  assert.equal(param.sql_binding.clause, "exists_subquery");
  // Correlates the lookup table back to the main query key column (driver.code = t0).
  assert.match(param.sql_binding.subquery_prefix, /EXISTS \(SELECT 1 FROM/);
  assert.match(param.sql_binding.subquery_prefix, /driver_sku/);
  assert.match(param.sql_binding.subquery_prefix, /driver_code`? = t0/);

  await approvePlan(fixture.plan, "reviewer");
  const packageRoot = await generatePackage({ workspace: fixture.workspace, plan: fixture.plan });
  const validation = await validatePackage(packageRoot);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
  // The EXISTS lives in the main SQL WHERE via the filter marker + binding.
  const bindings = JSON.parse(await readFile(join(packageRoot, "queries", "bindings.json"), "utf8"));
  const skuParam = bindings.parameters.find((p: any) => p.id === "sku_name");
  assert.equal(skuParam.clause, "exists_subquery");
});

test("enrichment rejects a cross-profile lookup table", async () => {
  const fixture = await createFixture();
  // Add a lookup table under a DIFFERENT profile.
  const dir = join(fixture.knowledge, "databases", "other-profile", "transport", "hot", "tables");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "ext.json"),
    JSON.stringify({
      table_id: "other_transport_ext",
      tier: "hot",
      schema_fingerprint: "ext-hash",
      physical: { profile_id: "other-profile", database: "transport", table: "ext" },
      physical_fields: [
        { physical: { name: "code", data_type: "varchar" }, semantic: {}, filter: {} },
        { physical: { name: "label", data_type: "varchar" }, semantic: {}, filter: {} },
      ],
      system_conditions: [],
      security: {},
    }),
  );
  await inspectDriver(fixture);
  const configurationPath = join(fixture.workspace, "reports", "plans", "enrich-x.json");
  await writeFile(
    configurationPath,
    JSON.stringify({
      enrichments: [
        {
          id: "ext_lookup",
          lookup: { profile_id: "other-profile", database: "transport", table: "ext", alias: "lk_ext" },
          on: { source: "main", main_field: "code", lookup_field: "code" },
          cardinality: "one",
          select: [{ id: "ext_label", label: "外部标签", lookup_field: "label" }],
        },
      ],
    }),
  );
  await assert.rejects(
    () => configurePlan(fixture.plan, configurationPath),
    /跨 profile|同一连接/,
  );
});

test("enrichment on a group report is rejected by validation (approvePlan)", async () => {
  const fixture = await createFixture();
  await addSkuLookupTable(fixture);
  await inspectDriver(fixture);
  // Hand-edit the plan into an unsupported state: group transform + enrichment.
  const plan = JSON.parse(await readFile(fixture.plan, "utf8"));
  plan.custom_logic = { ...plan.custom_logic, mode: "group", required: true, group_keys: ["code"] };
  plan.enrichments = [
    {
      id: "sku_lookup",
      lookup: { profile_id: "mysql-main", database: "transport", table: "driver_sku", alias: "lk_sku", table_id: "x", schema_fingerprint: "y" },
      on: { source: "main", main_field: "code", lookup_field: "driver_code" },
      conditions: [],
      cardinality: "many",
      aggregate: { kind: "group_concat", distinct: true, separator: "," },
      select: [{ id: "sku_ex", label: "商品名称", lookup_field: "sku_name", output_type: "string" }],
      on_missing: "null",
    },
  ];
  await writeFile(fixture.plan, JSON.stringify(plan));
  await assert.rejects(() => approvePlan(fixture.plan, "reviewer"), /分组\(group\)报表暂不支持 enrichment/);
});

test("enrichment many-cardinality without aggregate is rejected", async () => {
  const fixture = await createFixture();
  await addSkuLookupTable(fixture);
  await inspectDriver(fixture);
  const configurationPath = join(fixture.workspace, "reports", "plans", "enrich-bad.json");
  await writeFile(
    configurationPath,
    JSON.stringify({
      enrichments: [
        {
          id: "sku_lookup",
          lookup: { profile_id: "mysql-main", database: "transport", table: "driver_sku", alias: "lk_sku" },
          on: { source: "main", main_field: "code", lookup_field: "driver_code" },
          cardinality: "many", // missing aggregate → configure-plan defaults it; force error via hand path
          aggregate: { kind: "not_a_kind" },
          select: [{ id: "sku_name", label: "商品名称", lookup_field: "sku_name" }],
        },
      ],
    }),
  );
  await assert.rejects(() => configurePlan(fixture.plan, configurationPath), /aggregate/);
});

/** Add a numeric receipt_count column to the driver table + requirement so a test
 * can convert it into a boolean-flag (是/否) field via configure-plan. */
async function addReceiptCountField(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): Promise<void> {
  const driverPath = join(
    fixture.knowledge, "databases", "mysql-main", "transport", "hot", "tables", "driver.json",
  );
  const driver = JSON.parse(await readFile(driverPath, "utf8"));
  driver.physical_fields.push({
    physical: { name: "receipt_count", data_type: "int", native_type: "int(4)", primary_key: false, comment: "回单数量" },
    semantic: { name: "回单数量", status: "inferred", report_ids: ["driver-detail"], enum_ref: null },
    filter: {
      enabled: true,
      role: "number",
      default_operator: "between",
      operators: ["eq", "between", "gte", "lte"],
      input_type: "number_range",
      visibility: "user",
      required: false,
    },
  });
  await writeFile(driverPath, JSON.stringify(driver));
  const configPath = join(fixture.workspace, "config", "easy-bi.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.knowledge.report_requirements[0].required_fields.push({ field: "driver.receipt_count", label: "签单是否上传" });
  await writeFile(configPath, JSON.stringify(config));
}

test("boolean_flag: configure converts a numeric column to 是/否, generates CASE + flag binding + 是否 enum", async () => {
  const fixture = await createFixture();
  await addReceiptCountField(fixture);
  await inspectDriver(fixture);
  const configurationPath = join(fixture.workspace, "reports", "plans", "boolflag.json");
  await writeFile(
    configurationPath,
    JSON.stringify({
      fields: [
        {
          id: "receipt_count",
          output_type: "boolean",
          roles: ["output", "filter"],
          source: { kind: "boolean_flag", operator: "gt", threshold: 0 },
        },
      ],
    }),
  );
  const plan = await configurePlan(fixture.plan, configurationPath);
  const field = plan.fields.find((f: any) => f.id === "receipt_count");
  assert.equal(field.source.kind, "boolean_flag");
  assert.equal(field.output_type, "boolean");
  const param = plan.parameters.find((p: any) => p.id === "receipt_count");
  assert.equal(param.value_type, "boolean");
  assert.equal(param.sql_binding.value_adapter, "flag");
  assert.equal(param.sql_binding.flag_operator, "gt");
  assert.equal(param.sql_binding.flag_threshold, 0);

  await approvePlan(fixture.plan, "reviewer");
  const packageRoot = await generatePackage({ workspace: fixture.workspace, plan: fixture.plan });
  const validation = await validatePackage(packageRoot);
  assert.equal(validation.valid, true);

  const sql = await readFile(join(packageRoot, "queries", "main.sql"), "utf8");
  assert.match(sql, /CASE WHEN t0\.`receipt_count` > 0 THEN 1 ELSE 0 END AS `receipt_count`/);
  const enums = JSON.parse(await readFile(join(packageRoot, "enums.json"), "utf8"));
  assert.deepEqual(enums.byField.receipt_count, { "1": "是", "0": "否" });
  const bindings = JSON.parse(await readFile(join(packageRoot, "queries", "bindings.json"), "utf8"));
  const b = bindings.parameters.find((p: any) => p.id === "receipt_count");
  assert.equal(b.flag_operator, "gt");
  assert.equal(b.flag_threshold, 0);
  assert.equal(b.value_type, "boolean");
});

test("boolean_flag rejects an unknown comparison operator", async () => {
  const fixture = await createFixture();
  await addReceiptCountField(fixture);
  await inspectDriver(fixture);
  const configurationPath = join(fixture.workspace, "reports", "plans", "boolflag-bad.json");
  await writeFile(
    configurationPath,
    JSON.stringify({
      fields: [
        { id: "receipt_count", output_type: "boolean", roles: ["output", "filter"], source: { kind: "boolean_flag", operator: "like", threshold: 0 } },
      ],
    }),
  );
  await assert.rejects(() => configurePlan(fixture.plan, configurationPath), /比较符/);
});

// ── group_queries: multi-entity grouped statistics (按客户分组，分别统计多张表) ──

/**
 * Write ONLY a driver_product table into knowledge (with a create_time column),
 * WITHOUT adding its columns to the main report's required_fields — a sibling
 * group query resolves its own table from knowledge, so the main query must stay
 * single-table (no forced JOIN).
 */
async function addProductKnowledgeOnly(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): Promise<void> {
  const dir = join(fixture.knowledge, "databases", "mysql-main", "transport", "hot", "tables");
  const field = (name: string, dataType: string, primaryKey = false) => ({
    physical: { name, data_type: dataType, native_type: dataType, primary_key: primaryKey, comment: name },
    semantic: { name, status: "inferred", report_ids: ["driver-detail"], enum_ref: null },
    filter: { enabled: true, role: "text", default_operator: "eq", operators: ["eq", "in"], input_type: "text", visibility: "user", required: false },
  });
  await writeFile(
    join(dir, "driver_product.json"),
    JSON.stringify({
      table_id: "mysql-main_transport_driver_product",
      tier: "hot",
      schema_fingerprint: "product-schema-hash",
      physical: { profile_id: "mysql-main", database: "transport", table: "driver_product" },
      physical_fields: [
        field("id", "bigint", true),
        field("driver_id", "bigint"),
        field("product_name", "varchar"),
        field("create_time", "datetime"),
        field("is_delete", "tinyint"),
      ],
      system_conditions: [{ field: "is_delete", operator: "eq", value: 0 }],
      security: {},
    }),
  );
}

async function addDispatchManyToManyKnowledge(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): Promise<void> {
  const dir = join(fixture.knowledge, "databases", "mysql-main", "transport", "hot", "tables");
  const field = (name: string, dataType: string, primaryKey = false) => ({
    physical: { name, data_type: dataType, native_type: dataType, primary_key: primaryKey, comment: name },
    semantic: { name, status: "inferred", report_ids: ["driver-detail"], enum_ref: null },
    filter: { enabled: false, visibility: "system" },
  });
  const writeTable = async (
    table: string,
    fields: Array<ReturnType<typeof field>>,
    systemConditions: any[] = [],
  ): Promise<void> => {
    await writeFile(
      join(dir, `${table}.json`),
      JSON.stringify({
        table_id: `mysql-main_transport_${table}`,
        tier: "hot",
        schema_fingerprint: `${table}-schema-hash`,
        physical: { profile_id: "mysql-main", database: "transport", table },
        physical_fields: fields,
        system_conditions: systemConditions,
        security: {},
      }),
    );
  };
  await writeTable(
    "dispatch",
    [field("id", "bigint", true), field("create_time", "datetime"), field("is_delete", "tinyint")],
    [{ field: "is_delete", operator: "eq", value: 0 }],
  );
  await writeTable("dispatch_waybill", [
    field("id", "bigint", true),
    field("dispatch_id", "bigint"),
    field("waybill_id", "bigint"),
  ]);
  await writeTable("waybill", [
    field("id", "bigint", true),
    field("main_waybill_id", "bigint"),
    field("is_delete", "tinyint"),
  ], [{ field: "is_delete", operator: "eq", value: 0 }]);
  await writeTable("main_waybill", [
    field("id", "bigint", true),
    field("order_id", "bigint"),
  ]);
  await writeTable("customer_order", [
    field("id", "bigint", true),
    field("driver_id", "bigint"),
  ]);
}

/**
 * Configure a group_queries report: main query on `driver` grouped by code with a
 * conditional count, plus a sibling grouped query on `driver_product` counting per
 * driver. Both share a create-time range filter bound to each table's own column.
 */
async function configureGroupQueries(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  extra: Record<string, unknown> = {},
): Promise<any> {
  const configurationPath = join(fixture.workspace, "reports", "plans", "gq.json");
  await writeFile(
    configurationPath,
    JSON.stringify({
      // Main query: group drivers by code, count total drivers.
      aggregation: { group_by: ["t0.code"], having: [] },
      fields: [
        {
          id: "order_total",
          label: "司机总数",
          output_type: "number",
          source: { kind: "sql_expression", expression: "COUNT(t0.`id`)", dependencies: [{ alias: "t0", field: "id" }] },
        },
      ],
      group_queries: {
        merge_keys: ["code"],
        period_param: "create_time",
        queries: [
          {
            id: "product",
            table: { database: "transport", table: "driver_product" },
            alias: "t0",
            group_by: ["t0.driver_id"],
            period_field: "create_time",
            fields: [
              // Merge-key dimension column (aligns with the main query's `code`).
              { id: "code", label: "司机编码", output_type: "string", source: { kind: "column", field: "driver_id" } },
              {
                id: "product_total",
                label: "货品数量",
                output_type: "number",
                source: { kind: "sql_expression", expression: "COUNT(t0.`id`)", dependencies: [{ alias: "t0", field: "id" }] },
              },
            ],
          },
        ],
      },
      ...extra,
    }),
  );
  return configurePlan(fixture.plan, configurationPath);
}

test("group_queries: configure resolves sibling table + fields into plan.group_queries", async () => {
  const fixture = await createFixture();
  await addProductKnowledgeOnly(fixture);
  await inspectDriver(fixture);
  const plan = await configureGroupQueries(fixture);
  assert.ok(plan.group_queries, "plan.group_queries should exist");
  assert.deepEqual(plan.group_queries.merge_keys, ["code"]);
  assert.equal(plan.group_queries.period_param, "create_time");
  assert.equal(plan.group_queries.queries.length, 1);
  const sib = plan.group_queries.queries[0];
  assert.equal(sib.id, "product");
  assert.equal(sib.source.primary_table.table, "driver_product");
  assert.equal(sib.period_field, "create_time");
  assert.deepEqual(sib.aggregation.group_by, ["t0.driver_id"]);
});

test("group_queries: generate writes sibling SQL + bindings, merged fields, manifest", async () => {
  const fixture = await createFixture();
  await addProductKnowledgeOnly(fixture);
  await inspectDriver(fixture);
  await configureGroupQueries(fixture);
  await approvePlan(fixture.plan, "gq-reviewer");
  const packageRoot = await generatePackage({ workspace: fixture.workspace, plan: fixture.plan });

  // Sibling SQL + bindings written.
  const siblingSql = await readFile(join(packageRoot, "queries", "group-product.sql"), "utf8");
  assert.match(siblingSql, /FROM `transport`\.`driver_product`/);
  assert.match(siblingSql, /GROUP BY/);
  // The filter marker is present so the runtime can inject the shared time range.
  assert.match(siblingSql, /EASYBI_FILTERS/);
  // The knowledge logical-delete system condition is compiled into the WHERE.
  assert.match(siblingSql, /`is_delete`/);
  const siblingBindings = JSON.parse(await readFile(join(packageRoot, "queries", "group-product.bindings.json"), "utf8"));
  // The shared period filter is re-bound to the sibling's own create_time column.
  const period = siblingBindings.parameters.find((p: any) => p.id === "create_time");
  assert.ok(period, "sibling should carry the period param");
  assert.match(period.expression, /`create_time`/);

  // Merged fields.json carries main + sibling metrics (deduped on the merge key).
  const fields = JSON.parse(await readFile(join(packageRoot, "fields.json"), "utf8"));
  const ids = fields.fields.map((f: any) => f.id);
  assert.ok(ids.includes("order_total"), "main metric present");
  assert.ok(ids.includes("product_total"), "sibling metric present");
  assert.equal(ids.filter((id: string) => id === "code").length, 1, "merge key not duplicated");

  // Manifest records the sibling query.
  const manifest = JSON.parse(await readFile(join(packageRoot, "report.manifest.json"), "utf8"));
  assert.equal(manifest.group_queries.queries.length, 1);
  assert.equal(manifest.group_queries.queries[0].sql, "queries/group-product.sql");
  const validation = await validatePackage(packageRoot);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
});

test("group_queries: rejected together with a group transform (mutual exclusivity)", async () => {
  const fixture = await createFixture();
  await addProductKnowledgeOnly(fixture);
  await inspectDriver(fixture);
  const configurationPath = join(fixture.workspace, "reports", "plans", "gq-bad.json");
  await writeFile(
    configurationPath,
    JSON.stringify({
      aggregation: { group_by: ["t0.code"], having: [] },
      // A computed/group field forces custom_logic.mode=group → must conflict.
      fields: [
        {
          id: "grp",
          label: "计算",
          output_type: "number",
          source: { kind: "computed", mode: "group", dependencies: [{ id: "raw_id", alias: "t0", field: "id" }], expression: "rows.length" },
        },
      ],
      group_queries: {
        merge_keys: ["code"],
        queries: [
          {
            id: "product",
            table: { database: "transport", table: "driver_product" },
            alias: "t0",
            group_by: ["t0.driver_id"],
            fields: [
              { id: "code", label: "编码", output_type: "string", source: { kind: "column", field: "driver_id" } },
              { id: "product_total", label: "货品数量", output_type: "number", source: { kind: "sql_expression", expression: "COUNT(t0.`id`)", dependencies: [{ alias: "t0", field: "id" }] } },
            ],
          },
        ],
      },
    }),
  );
  await assert.rejects(() => configurePlan(fixture.plan, configurationPath), /group_queries 与内存分组/);
});

test("group_queries: order-waybill-dispatch N:N path is locked and counts distinct dispatches", async () => {
  const fixture = await createFixture();
  await addDispatchManyToManyKnowledge(fixture);
  const configPath = join(fixture.workspace, "config", "easy-bi.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.knowledge.report_requirements[0].required_fields.push({
    field: "派车单数量",
    label: "派车单数量",
    description: "同一派车单关联同一客户多张运单时按派车单主键去重",
  });
  await writeFile(configPath, JSON.stringify(config));
  await inspectDriver(fixture);
  const inspected = JSON.parse(await readFile(fixture.plan, "utf8"));
  const metricBlocker = inspected.blockers.find(
    (item: any) => item.code === "FIELD_NOT_FOUND" && item.field === "派车单数量",
  );
  assert.ok(metricBlocker?.field_id);

  const configurationPath = join(fixture.workspace, "reports", "plans", "gq-nn.json");
  await writeFile(
    configurationPath,
    JSON.stringify({
      aggregation: { group_by: ["t0.code"], having: [] },
      fields: [
        {
          id: "name",
          source: { kind: "sql_expression", expression: "MAX(t0.`name`)", dependencies: [{ alias: "t0", field: "name" }] },
        },
        {
          id: "create_time",
          source: { kind: "sql_expression", expression: "MAX(t0.`create_time`)", dependencies: [{ alias: "t0", field: "create_time" }] },
        },
      ],
      group_queries: {
        merge_keys: ["code"],
        period_param: "create_time",
        queries: [
          {
            id: "dispatch",
            table: { database: "transport", table: "dispatch" },
            alias: "d",
            period_alias: "d",
            period_field: "create_time",
            joins: [
              {
                type: "INNER",
                table: { database: "transport", table: "dispatch_waybill" },
                alias: "dw",
                on: [{ left: "d.id", right: "dw.dispatch_id", operator: "eq" }],
                grain: "派车单与运单多对多关系",
              },
              {
                type: "INNER",
                table: { database: "transport", table: "waybill" },
                alias: "w",
                on: [{ left: "dw.waybill_id", right: "w.id", operator: "eq" }],
                grain: "关系记录属于一张运单",
              },
              {
                type: "INNER",
                table: { database: "transport", table: "main_waybill" },
                alias: "mw",
                on: [{ left: "w.main_waybill_id", right: "mw.id", operator: "eq" }],
                grain: "拆分运单归属一个主运单",
              },
              {
                type: "INNER",
                table: { database: "transport", table: "customer_order" },
                alias: "o",
                on: [{ left: "mw.order_id", right: "o.id", operator: "eq" }],
                grain: "一个主运单对应一个订单",
              },
              {
                type: "INNER",
                table: { database: "transport", table: "driver" },
                alias: "c",
                on: [{ left: "o.driver_id", right: "c.id", operator: "eq" }],
                grain: "订单归属一个客户",
              },
            ],
            group_by: ["c.code"],
            fields: [
              { id: "code", label: "客户编码", output_type: "string", source: { kind: "column", alias: "c", field: "code" } },
              {
                id: metricBlocker.field_id,
                label: "派车单数量",
                output_type: "number",
                source: {
                  kind: "sql_expression",
                  expression: "COUNT(DISTINCT d.`id`)",
                  dependencies: [{ alias: "d", field: "id" }],
                },
              },
            ],
          },
        ],
      },
    }),
  );

  const configured = await configurePlan(fixture.plan, configurationPath);
  assert.equal(configured.blockers.length, 0);
  await approvePlan(fixture.plan, "nn-reviewer");
  const packageRoot = await generatePackage({ workspace: fixture.workspace, plan: fixture.plan });
  const sql = await readFile(join(packageRoot, "queries", "group-dispatch.sql"), "utf8");
  assert.match(sql, /INNER JOIN `transport`\.`dispatch_waybill` AS dw/);
  assert.match(sql, /INNER JOIN `transport`\.`waybill` AS w/);
  assert.match(sql, /INNER JOIN `transport`\.`main_waybill` AS mw/);
  assert.match(sql, /INNER JOIN `transport`\.`customer_order` AS o/);
  assert.match(sql, /INNER JOIN `transport`\.`driver` AS c/);
  assert.match(sql, /COUNT\(DISTINCT d\.`id`\)/);
  const lock = JSON.parse(await readFile(join(packageRoot, "knowledge.lock.json"), "utf8"));
  assert.equal(lock.group_query_sources[0].sources.length, 6);
  const validation = await validatePackage(packageRoot);
  assert.equal(validation.valid, true, validation.errors.join("\n"));
});

test("v3 script package requires a readable semantic/execution plan and locks each query", async () => {
  const fixture = await createFixture();
  await addProductTable(fixture);
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  const configPath = join(fixture.workspace, "script-config.json");
  await writeFile(configPath, JSON.stringify({
    semantic_plan: {
      result_grain: "每个司机一行",
      metrics: [{ id: "code", label: "司机编码", definition: "司机唯一编码" }],
      distinct_keys: { driver: "driver.id" },
      time_semantics: [],
      exclusions: ["排除逻辑删除记录"],
      open_questions: [],
    },
    execution_plan: {
      rationale: "主数据流式读取，姓名建立小索引，产品按司机键批量补充",
      steps: [
        { id: "Q1", type: "load_index", description: "加载司机姓名索引" },
        { id: "Q2", type: "query_stream", description: "流式读取司机主数据" },
        { id: "Q3", type: "batch_lookup", description: "按司机键批量查询产品" },
        { id: "E1", type: "emit", description: "封装并输出报表行" },
      ],
    },
    script_report: {
      resource_budget: { max_queries: 8, max_output_rows: 1000, timeout_seconds: 30 },
      queries: [
        {
          id: "drivers",
          mode: "stream",
          profile_id: "mysql-main",
          database: "transport",
          sql: "SELECT t0.`id`, t0.`code`, t0.`create_time` FROM `transport`.`driver` AS t0",
          sources: [{ profile_id: "mysql-main", database: "transport", table: "driver", alias: "t0", fields: ["id", "code", "create_time"] }],
        },
        {
          id: "driver-names",
          mode: "index",
          profile_id: "mysql-main",
          database: "transport",
          sql: "SELECT t0.`id`, t0.`name` FROM `transport`.`driver` AS t0",
          sources: [{ profile_id: "mysql-main", database: "transport", table: "driver", alias: "t0", fields: ["id", "name"] }],
        },
        {
          id: "driver-products",
          mode: "batch",
          profile_id: "mysql-main",
          database: "transport",
          sql: "SELECT t0.`driver_id`, t0.`product_name` FROM `transport`.`driver_product` AS t0 WHERE t0.`driver_id` IN (/* KEYS */)",
          sources: [{ profile_id: "mysql-main", database: "transport", table: "driver_product", alias: "t0", fields: ["driver_id", "product_name"] }],
        },
      ],
      source: [
        "export async function run(ctx: any) {",
        "  const names = await ctx.loadIndex('driver-names', [], ['id']);",
        "  for await (const row of ctx.queryStream('drivers')) {",
        "    await ctx.batchLookup('driver-products', [row.id]);",
        "    await ctx.emit({ code: row.code, name: names.get(row.id)[0]?.name ?? null, create_time: row.create_time });",
        "  }",
        "}",
      ].join("\n"),
    },
  }, null, 2));
  const configured = await configurePlan(fixture.plan, configPath);
  assert.equal(configured.execution_plan.strategy, "script");
  assert.match(await explainPlan(fixture.plan), /主数据流式读取/);
  await approvePlan(fixture.plan, "script-reviewer");
  const packageRoot = await generatePackage({ workspace: fixture.workspace, plan: fixture.plan });
  const manifest = JSON.parse(await readFile(join(packageRoot, "report.manifest.json"), "utf8"));
  assert.equal(manifest.report_package_format_version, "3");
  assert.equal(manifest.execution_model, "isolated_script");
  assert.equal(manifest.queries.every((query: any) => query.sql_dialect === "mysql"), true);
  const compiledScript = await readFile(join(packageRoot, "scripts", "report.mjs"), "utf8");
  assert.doesNotMatch(compiledScript, /ctx:\s*any/);
  const lock = JSON.parse(await readFile(join(packageRoot, "knowledge.lock.json"), "utf8"));
  assert.equal(lock.script_query_sources.length, 3);
  const validation = await validatePackage(packageRoot);
  assert.equal(validation.valid, true, validation.errors.join("\n"));

  const contextPath = join(fixture.workspace, "work", "report-context.json");
  const context = await buildKnowledgeContext({ plan: fixture.plan, out: contextPath });
  assert.equal(context.selected_table_count, 2);
  assert.equal(JSON.stringify(context).includes("password"), false);
});

test("staged report model builds query/script context packs without leaking physical knowledge to script", async () => {
  const fixture = await createFixture();
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  const modelPath = join(fixture.workspace, "work", "driver-model.json");
  const model = await initializeReportModel({ plan: fixture.plan, out: modelPath });
  model.result_grain.keys = ["code"];
  model.open_questions = [];
  model.recommended_strategy = "script";
  model.query_contracts[0].sources[0].fields.push("not-approved-field");
  assert.match(validateReportModelValue(model).join("\n"), /模型外字段/);
  model.query_contracts[0].sources[0].fields.pop();
  await writeFile(modelPath, JSON.stringify(model, null, 2));
  const approved = await approveReportModel(modelPath, "model-reviewer", fixture.plan);
  assert.equal(validateReportModelValue(approved, true).length, 0);
  const attachedPlan = JSON.parse(await readFile(fixture.plan, "utf8"));
  assert.equal(attachedPlan.report_model.model_hash, approved.approval.model_hash);

  const queryContext = await buildPhaseContext({
    phase: "query",
    plan: fixture.plan,
    model: modelPath,
    queryId: "main",
    out: join(fixture.workspace, "work", "query-context.json"),
  });
  assert.equal(queryContext.context_manifest.fresh_session, true);
  assert.equal(queryContext.payload.knowledge.tables.length, 1);
  assert.equal(queryContext.payload.query_contract.id, "main");

  const outputDir = join(fixture.workspace, "work", "query-outputs");
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "main.json"), JSON.stringify({
    query_id: "main",
    mode: "stream",
    columns: approved.query_contracts[0].output,
  }));
  const scriptContext = await buildPhaseContext({
    phase: "script",
    plan: fixture.plan,
    model: modelPath,
    queryOutputs: outputDir,
    out: join(fixture.workspace, "work", "script-context.json"),
  });
  const serialized = JSON.stringify(scriptContext);
  assert.equal(serialized.includes("physical_fields"), false);
  assert.equal(serialized.includes("schema_fingerprint"), false);
  assert.deepEqual(scriptContext.payload.allowed_api, ["queryStream", "loadIndex", "batchLookup", "emit"]);
  await assert.rejects(
    buildPhaseContext({
      phase: "unknown" as "query",
      plan: fixture.plan,
      out: join(fixture.workspace, "work", "invalid-context.json"),
    }),
    /未知阶段/,
  );
});

test("discovery context infers metric intent, resolves enums, and enforces the field/byte budget", async () => {
  const fixture = await createFixture();
  await addStatusEnumField(fixture);
  const configPath = join(fixture.workspace, "config", "easy-bi.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.knowledge.report_requirements[0].required_fields = [
    {
      label: "启用司机数量",
      roles: ["output", "metric"],
      aggregation: "count_distinct",
      description: "按司机主键去重，状态为启用",
    },
  ];
  await writeFile(configPath, JSON.stringify(config));
  const driverPath = join(
    fixture.knowledge,
    "databases",
    "mysql-main",
    "transport",
    "hot",
    "tables",
    "driver.json",
  );
  const driver = JSON.parse(await readFile(driverPath, "utf8"));
  for (let index = 0; index < 180; index += 1) {
    driver.physical_fields.push({
      physical: {
        name: `unused_${index}`,
        data_type: "varchar",
        native_type: "varchar(255)",
        primary_key: false,
        comment: `无关字段 ${index}`,
      },
      semantic: { name: `无关字段 ${index}`, status: "inferred", enum_ref: null },
      filter: { enabled: false, role: "text", operators: [] },
    });
  }
  await writeFile(driverPath, JSON.stringify(driver));
  const plan = await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  assert.equal(plan.blockers[0].code, "METRIC_REQUIRES_MODELING");
  const context = await buildPhaseContext({
    phase: "discovery",
    plan: fixture.plan,
    out: join(fixture.workspace, "work", "discovery-context.json"),
  });
  const knowledge = context.payload.knowledge;
  assert.equal(knowledge.requirement_intents[0].aggregation, "count_distinct");
  assert.ok(knowledge.selected_field_count <= 80);
  assert.ok(Buffer.byteLength(JSON.stringify(context, null, 2), "utf8") <= 100_000);
  assert.ok(
    knowledge.candidate_sets[0].candidates.some(
      (candidate: any) => candidate.field === "status" && candidate.enum_ref === "driver_status",
    ),
  );
  assert.ok(
    knowledge.enum_dictionaries.some(
      (dictionary: any) =>
        dictionary.name === "driver_status" &&
        dictionary.values.some((item: any) => item.label === "启用"),
    ),
  );
});

test("structured confirmation is revision-bound and becomes the only modeling approval input", async () => {
  const fixture = await createFixture();
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  const root = join(fixture.workspace, "work", "confirmation");
  await mkdir(root, { recursive: true });
  const modelPath = join(root, "discovery-model.json");
  const model = await initializeReportModel({ plan: fixture.plan, out: modelPath });
  model.result_grain.keys = ["code"];
  model.recommended_strategy = "sql";
  model.open_questions = [{
    id: "grain",
    question: "是否按司机编码去重？",
    options: [
      { value: "code", label: "司机编码" },
      { value: "id", label: "司机主键" },
    ],
    recommended: "code",
    required: true,
    affected_metrics: ["司机数量"],
  }];
  await writeFile(modelPath, JSON.stringify(model, null, 2));
  const inputPath = join(root, "confirmation-input.json");
  const confirmationPath = join(root, "confirmation.json");
  await writeFile(
    inputPath,
    JSON.stringify({ accept_recommended: true, answers: {}, note: "" }),
  );
  const confirmation = await createModelConfirmation({
    model: modelPath,
    input: inputPath,
    out: confirmationPath,
    reviewedBy: "reviewer",
  });
  assert.equal(confirmation.answers[0].value, "code");
  const context = await buildPhaseContext({
    phase: "modeling",
    plan: fixture.plan,
    model: modelPath,
    confirmation: confirmationPath,
    out: join(root, "modeling-context.json"),
  });
  assert.equal(context.payload.confirmation.status, "confirmed");
  model.metrics.push({ id: "changed" });
  await writeFile(modelPath, JSON.stringify(model, null, 2));
  await assert.rejects(
    buildPhaseContext({
      phase: "modeling",
      plan: fixture.plan,
      model: modelPath,
      confirmation: confirmationPath,
      out: join(root, "stale-context.json"),
    }),
    /revision 已过期/,
  );
});

test("discovery hypotheses may use selected_tables, keyless grain, and a recommended answer outside options", async () => {
  const fixture = await createFixture();
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  const root = join(fixture.workspace, "work", "report-model", "driver-detail", "hypothesis");
  await mkdir(root, { recursive: true });
  const modelPath = join(root, "discovery-model.json");
  const model = await initializeReportModel({ plan: fixture.plan, out: modelPath });
  const source = model.sources[0];
  model.result_grain = {
    description: "单行汇总，无分组维度",
    keys: [],
    status: "hypothesis",
  };
  model.metric_hypotheses = [{
    id: "driver_count",
    label: "司机数量",
    aggregation: "COUNT(DISTINCT code)",
    confidence: "medium",
  }];
  model.selected_tables = [{
    table_id: `${source.profile_id}/${source.database}/${source.table}`,
    entity: "司机",
    selected_fields: source.fields.filter((field: any) => field.name === "code").map((field: any) => ({
      physical_name: field.name,
      role: "source",
    })),
  }];
  model.sources = [{ ...source, fields: [] }];
  model.query_contracts = [{
    id: "driver_counts",
    output: [{ column: "driver_count", label: "司机数量" }],
    status: "draft",
  }];
  model.open_questions = [{
    id: "count_scope",
    question: "租户隔离是否使用 tenant_id？",
    options: ["不使用租户隔离"],
    recommended: "使用 tenant_id",
    required: true,
  }, {
    id: "strategy",
    question: "是否使用 group_queries？",
    category: "execution_strategy",
    options: ["group_queries", "script"],
    recommended: "group_queries",
    required: true,
  }];
  await writeFile(modelPath, JSON.stringify(model, null, 2));

  const validation = await validateStagedArtifacts({
    phase: "discovery",
    plan: fixture.plan,
    root,
  });
  assert.equal(validation.ok, true);
  assert.ok(
    validation.confirmation.questions[0].options.some(
      (option: any) => option.value === "使用 tenant_id",
    ),
  );
  assert.equal(validation.confirmation.questions.length, 1);

  const inputPath = join(root, "confirmation-input.json");
  const confirmationPath = join(root, "confirmation.json");
  await writeFile(inputPath, JSON.stringify({ accept_recommended: true, answers: {}, note: "" }));
  await createModelConfirmation({
    model: modelPath,
    input: inputPath,
    out: confirmationPath,
    reviewedBy: "reviewer",
  });
  const context = await buildPhaseContext({
    phase: "modeling",
    plan: fixture.plan,
    model: modelPath,
    confirmation: confirmationPath,
    out: join(root, "modeling-context.json"),
  });
  assert.equal(context.payload.discovery_model.sources.length, 1);
  assert.equal(context.payload.knowledge.tables.length, 1);
  assert.deepEqual(
    context.payload.discovery_model.sources[0].fields.map((field: any) => field.name).sort(),
    ["code", "create_time", "name", "tenant_id"],
  );
  assert.deepEqual(
    context.payload.knowledge.tables[0].fields.map((field: any) => field.physical.name).sort(),
    ["code", "create_time", "name", "tenant_id"],
  );
});

test("modeling gate canonicalizes alias sources and output_contract columns", async () => {
  const fixture = await createFixture();
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  const root = join(fixture.workspace, "work", "report-model", "driver-detail", "canonical");
  await mkdir(root, { recursive: true });
  const modelPath = join(root, "report-model.json");
  const model = await initializeReportModel({ plan: fixture.plan, out: modelPath });
  model.result_grain = { description: "按司机编码分组", keys: ["code"] };
  model.recommended_strategy = "sql";
  model.open_questions = [];
  model.relationships = [{
    type: "LEFT_JOIN",
    on: `${model.sources[0].alias}.code = ${model.sources[0].alias}.name`,
    cardinality: "1:N",
  }];
  model.query_contracts = [{
    id: "drivers",
    sources: [model.sources[0].alias],
    result_grain: { description: "按司机编码分组", keys: ["code"] },
    output_contract: [{ id: "code", label: "司机编码", type: "varchar" }],
  }];
  await writeFile(modelPath, JSON.stringify(model, null, 2));
  await writeFile(
    join(root, "semantic-plan.json"),
    JSON.stringify({ result_grain: "按司机编码分组" }),
  );
  await writeFile(
    join(root, "execution-plan.json"),
    JSON.stringify({ strategy: "sql", steps: [{ id: "query" }] }),
  );

  const validation = await validateStagedArtifacts({
    phase: "modeling",
    plan: fixture.plan,
    root,
  });
  assert.equal(validation.ok, true);
  const canonical = JSON.parse(await readFile(modelPath, "utf8"));
  assert.equal(canonical.query_contracts[0].sources[0].table, "driver");
  assert.equal(canonical.query_contracts[0].output[0].name, "code");
  assert.equal(canonical.relationships[0].from, `${model.sources[0].alias}.code`);
  assert.equal(canonical.relationships[0].to, `${model.sources[0].alias}.name`);
  assert.equal(canonical.relationships[0].fanout_risk, true);
});

test("staged artifacts are deterministically approved, assembled, generated, and validated", async () => {
  const fixture = await createFixture();
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  const root = join(fixture.workspace, "work", "report-build", "driver-detail");
  await mkdir(join(root, "queries"), { recursive: true });
  await mkdir(join(root, "query-outputs"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  const model = await initializeReportModel({ plan: fixture.plan, out: join(root, "report-model.json") });
  model.result_grain.keys = ["code"];
  model.open_questions = [];
  model.recommended_strategy = "script";
  await writeFile(join(root, "report-model.json"), JSON.stringify(model, null, 2));
  await writeFile(join(root, "discovery-model.json"), JSON.stringify(model, null, 2));
  const initialPlan = JSON.parse(await readFile(fixture.plan, "utf8"));
  await writeFile(join(root, "semantic-plan.json"), JSON.stringify(initialPlan.semantic_plan, null, 2));
  await writeFile(join(root, "execution-plan.json"), JSON.stringify({
    ...initialPlan.execution_plan,
    strategy: "script",
    steps: [{ id: "Q1", type: "query_stream", description: "读取主查询" }, { id: "E1", type: "emit", description: "输出行" }],
  }, null, 2));
  const approval = await approveStagedModel({ plan: fixture.plan, root, reviewedBy: "workflow-reviewer" });
  assert.equal(approval.ok, true);

  const contract = model.query_contracts[0];
  const columns = contract.output.map((column: any) => ({ name: column.name, type: column.type }));
  const select = columns.map((column: any) => `t0.\`${column.name}\` AS \`${column.name}\``).join(", ");
  await writeFile(join(root, "queries", "main.sql"), `SELECT ${select} FROM \`transport\`.\`driver\` AS t0`);
  await writeFile(join(root, "query-outputs", "main.json"), JSON.stringify({
    query_id: "main",
    mode: "stream",
    columns: [...columns].reverse(),
  }, null, 2));
  const mismatched = await validateStagedArtifacts({ phase: "query", plan: fixture.plan, root });
  assert.equal(mismatched.ok, false);
  assert.match((mismatched.errors ?? []).join("\n"), /第 1 列应为/);
  await writeFile(join(root, "query-outputs", "main.json"), JSON.stringify({
    query_id: "main",
    mode: "stream",
    columns,
  }, null, 2));
  await writeFile(join(root, "queries", "main.sql"), `SELECT ${[...columns].reverse().map((column: any) => `t0.\`${column.name}\` AS \`${column.name}\``).join(", ")} FROM \`transport\`.\`driver\` AS t0`);
  const aliasMismatch = await validateStagedArtifacts({ phase: "query", plan: fixture.plan, root });
  assert.equal(aliasMismatch.ok, false);
  assert.match((aliasMismatch.errors ?? []).join("\n"), /SELECT 输出别名/);
  await writeFile(join(root, "queries", "main.sql"), `SELECT ${select} FROM \`transport\`.\`driver\` AS t0`);
  const queryValidation = await validateStagedArtifacts({ phase: "query", plan: fixture.plan, root });
  assert.equal(queryValidation.ok, true, JSON.stringify(queryValidation.errors));
  await writeFile(join(root, "scripts", "report.ts"), [
    "export async function run(ctx: any) {",
    "  for await (const row of ctx.queryStream('main')) await ctx.emit(row);",
    "}",
  ].join("\n"));
  const finalized = await finalizeStagedPackage({
    workspace: fixture.workspace,
    plan: fixture.plan,
    root,
    reviewedBy: "workflow-reviewer",
  });
  assert.equal(finalized.ok, true);
  const packageValidation = await validatePackage(String(finalized.package));
  assert.equal(packageValidation.valid, true, packageValidation.errors.join("\n"));
});

test("a staged model is promoted as one minimal current model package", async () => {
  const fixture = await createFixture();
  await inspectReport({
    workspace: fixture.workspace,
    knowledge: fixture.knowledge,
    reportId: "driver-detail",
    out: fixture.plan,
  });
  const root = join(
    fixture.workspace,
    "work",
    "report-model",
    "driver-detail",
    "revision-a",
  );
  await mkdir(join(root, "modeling"), { recursive: true });
  const model = await initializeReportModel({
    plan: fixture.plan,
    out: join(root, "report-model.json"),
  });
  model.result_grain.keys = ["code"];
  model.open_questions = [];
  model.recommended_strategy = "script";
  await writeFile(join(root, "report-model.json"), JSON.stringify(model, null, 2));
  await writeFile(join(root, "discovery-model.json"), JSON.stringify(model, null, 2));
  const plan = JSON.parse(await readFile(fixture.plan, "utf8"));
  await writeFile(
    join(root, "semantic-plan.json"),
    JSON.stringify(plan.semantic_plan, null, 2),
  );
  await writeFile(
    join(root, "execution-plan.json"),
    JSON.stringify({ ...plan.execution_plan, strategy: "script" }, null, 2),
  );
  await writeFile(
    join(root, "confirmation-input.json"),
    JSON.stringify({ accept_recommended: true, answers: {}, note: "" }),
  );
  const stagedConfirmation = await createModelConfirmation({
    model: join(root, "discovery-model.json"),
    input: join(root, "confirmation-input.json"),
    out: join(root, "confirmation.json"),
    reviewedBy: "workflow-reviewer",
  });
  model.confirmation = {
    discovery_revision: stagedConfirmation.discovery_revision,
    confirmation_hash: stagedConfirmation.confirmation_hash,
  };
  await writeFile(join(root, "report-model.json"), JSON.stringify(model, null, 2));
  await buildPhaseContext({
    phase: "modeling",
    plan: fixture.plan,
    model: join(root, "discovery-model.json"),
    confirmation: join(root, "confirmation.json"),
    out: join(root, "modeling", "context.json"),
  });

  const out = join(fixture.workspace, "reports", "models", "driver-detail");
  const finalized = await finalizeStagedModel({
    plan: fixture.plan,
    root,
    out,
    reviewedBy: "workflow-reviewer",
  });
  assert.equal(finalized.ok, true);
  const files = (await import("node:fs/promises")).readdir(out);
  assert.deepEqual(
    (await files).sort(),
    [
      "checksums.sha256",
      "execution-plan.json",
      "model.manifest.json",
      "report-model.json",
      "semantic-plan.json",
      "source.lock.json",
    ],
  );
  const sourceLock = JSON.parse(await readFile(join(out, "source.lock.json"), "utf8"));
  assert.equal(sourceLock.tables.length, 1);
  assert.ok(sourceLock.tables[0].fields.length > 0);
  assert.equal(sourceLock.tables[0].physical_fields, undefined);
  const promotedPlan = JSON.parse(await readFile(fixture.plan, "utf8"));
  assert.equal(promotedPlan.report_model.status, "approved");
  assert.equal(promotedPlan.report_model.ref, "../models/driver-detail/report-model.json");
});

test("staged declarative strategy replaces one current development package but protects published output", async () => {
  const fixture = await createFixture();
  await inspectReport({ workspace: fixture.workspace, knowledge: fixture.knowledge, reportId: "driver-detail", out: fixture.plan });
  const root = join(fixture.workspace, "work", "report-build", "driver-detail", "revision-a");
  await mkdir(root, { recursive: true });
  const model = await initializeReportModel({ plan: fixture.plan, out: join(root, "report-model.json") });
  model.result_grain.keys = ["code"];
  model.open_questions = [];
  model.recommended_strategy = "sql";
  await writeFile(join(root, "report-model.json"), JSON.stringify(model, null, 2));
  const initialPlan = JSON.parse(await readFile(fixture.plan, "utf8"));
  await writeFile(join(root, "semantic-plan.json"), JSON.stringify(initialPlan.semantic_plan, null, 2));
  await writeFile(join(root, "execution-plan.json"), JSON.stringify({ ...initialPlan.execution_plan, strategy: "sql" }, null, 2));
  await writeFile(join(root, "declarative-configuration.json"), JSON.stringify({
    script_report: { source: "throw new Error('must be ignored')", queries: [] },
  }, null, 2));
  await approveStagedModel({ plan: fixture.plan, root, reviewedBy: "workflow-reviewer" });

  const finalRoot = join(fixture.workspace, "reports", "packages", "driver-detail", String(initialPlan.report.version));
  await mkdir(finalRoot, { recursive: true });
  await writeFile(join(finalRoot, "old-marker.txt"), "old");
  await mkdir(join(fixture.workspace, "reports"), { recursive: true });
  await writeFile(
    join(fixture.workspace, "reports", "index.json"),
    JSON.stringify({
      reports: [{
        id: "driver-detail",
        version: String(initialPlan.report.version),
        path: `packages/driver-detail/${initialPlan.report.version}`,
        development_only: true,
      }],
    }),
  );
  const finalized = await finalizeStagedPackage({ workspace: fixture.workspace, plan: fixture.plan, root, reviewedBy: "workflow-reviewer" });
  assert.equal(finalized.strategy, "sql");
  await assert.rejects(readFile(join(finalRoot, "old-marker.txt"), "utf8"));
  const manifest = JSON.parse(await readFile(join(String(finalized.package), "report.manifest.json"), "utf8"));
  assert.equal(manifest.report_package_format_version, "2");

  const protectedIndex = JSON.parse(await readFile(join(fixture.workspace, "reports", "index.json"), "utf8"));
  protectedIndex.reports[0].development_only = false;
  await writeFile(join(fixture.workspace, "reports", "index.json"), JSON.stringify(protectedIndex));
  const planBeforeCollision = await readFile(fixture.plan, "utf8");
  await assert.rejects(
    finalizeStagedPackage({ workspace: fixture.workspace, plan: fixture.plan, root, reviewedBy: "workflow-reviewer" }),
    /已发布或来源不明/,
  );
  assert.equal(await readFile(fixture.plan, "utf8"), planBeforeCollision);
  const index = JSON.parse(await readFile(join(fixture.workspace, "reports", "index.json"), "utf8"));
  assert.match(String(index.reports[0].path), /^packages\/driver-detail\//);
});
