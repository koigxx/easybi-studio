import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { approvePlan, configurePlan, generatePackage, inspectReport, resealPackage, validatePackage, } from "../scripts/report-package-cli.js";
async function createFixture() {
    const workspace = await mkdtemp(join(tmpdir(), "easybi-report-"));
    const knowledge = join(workspace, "knowledge", "drafts", "v1");
    const tableDirectory = join(knowledge, "databases", "mysql-main", "transport", "hot", "tables");
    await mkdir(join(workspace, "config"), { recursive: true });
    await mkdir(tableDirectory, { recursive: true });
    await writeFile(join(workspace, "config", "easy-bi.json"), JSON.stringify({
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
    }));
    await writeFile(join(knowledge, "manifest.json"), JSON.stringify({
        catalog_format_version: "3",
        catalog_version: "0.1.0-draft",
        catalog_status: "draft",
        source_kind: "editable_draft",
        snapshot_hash: "snapshot-hash",
    }));
    const field = (name, dataType, role, operator, inputType, primaryKey = false) => ({
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
            operators: operator === "between"
                ? ["between", "gte", "lte"]
                : operator === "contains"
                    ? ["contains", "eq"]
                    : ["eq", "in"],
            input_type: inputType,
            visibility: "user",
            required: false,
        },
    });
    await writeFile(join(tableDirectory, "driver.json"), JSON.stringify({
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
            field("create_time", "datetime", "time", "between", "datetime_range"),
            field("is_delete", "tinyint", "system_condition", "eq", "boolean"),
            field("tenant_id", "bigint", "business_identifier", "eq", "text"),
        ],
        system_conditions: [
            { field: "is_delete", operator: "eq", value: 0 },
        ],
        security: { tenant_field: "tenant_id" },
    }));
    const plan = join(workspace, "reports", "plans", "driver-detail.json");
    return { workspace, knowledge, plan };
}
async function addProductTable(fixture) {
    const tableDirectory = join(fixture.knowledge, "databases", "mysql-main", "transport", "hot", "tables");
    const field = (name, dataType, role = "text") => ({
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
    await writeFile(join(tableDirectory, "driver_product.json"), JSON.stringify({
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
    }));
    const configPath = join(fixture.workspace, "config", "easy-bi.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.knowledge.report_requirements[0].required_fields.push({ field: "driver_product.product_name", label: "货品名称" }, { field: "driver_product.qty", label: "货品数量" });
    await writeFile(configPath, JSON.stringify(config));
}
/** Add an enum column (status) to the driver table + a global/enums.json dict. */
async function addStatusEnumField(fixture) {
    const driverPath = join(fixture.knowledge, "databases", "mysql-main", "transport", "hot", "tables", "driver.json");
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
    await writeFile(join(fixture.knowledge, "global", "enums.json"), JSON.stringify({
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
    }));
    const configPath = join(fixture.workspace, "config", "easy-bi.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.knowledge.report_requirements[0].required_fields.push({ field: "driver.status", label: "状态" });
    await writeFile(configPath, JSON.stringify(config));
}
/**
 * Add a table in a DIFFERENT database (`settlement`) under the SAME profile
 * (`mysql-main`) — for cross-database JOIN within one connection.
 */
async function addSettlementTable(fixture) {
    const dir = join(fixture.knowledge, 'databases', 'mysql-main', 'settlement', 'hot', 'tables');
    await mkdir(dir, { recursive: true });
    const field = (name, dataType, role = 'text') => ({
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
    await writeFile(join(dir, 'driver_fee.json'), JSON.stringify({
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
    }));
    const configPath = join(fixture.workspace, 'config', 'easy-bi.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.knowledge.report_requirements[0].required_fields.push({
        field: 'driver_fee.total_fee',
        label: '费用合计',
    });
    await writeFile(configPath, JSON.stringify(config));
}
async function configureJoin(fixture, extra = {}) {
    const configurationPath = join(fixture.workspace, "reports", "plans", "configuration.json");
    await writeFile(configurationPath, JSON.stringify({
        joins: [
            {
                type: "LEFT",
                alias: "t1",
                on: [{ left: "t0.id", right: "t1.driver_id", operator: "eq" }],
                grain: "司机一对多货品",
            },
        ],
        ...extra,
    }));
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
    const code = plan.fields.find((f) => f.source.field === "code");
    const name = plan.fields.find((f) => f.source.field === "name");
    const ctime = plan.fields.find((f) => f.source.field === "create_time");
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
    const ct = plan.parameters.find((p) => p.id === "create_time");
    assert.ok(ct, "应存在 create_time 参数");
    assert.equal(ct.value_type, "datetime_range");
    assert.equal(ct.component, "datetime-range");
    assert.equal(ct.default_operator, "between");
    assert.deepEqual(ct.operators, ["between", "gte", "lte"]);
    // Forced required even though the knowledge fixture marks it required:false.
    assert.equal(ct.required, true);
    // Non-date filters stay single-value and optional.
    const code = plan.parameters.find((p) => p.id === "code");
    assert.equal(code.value_type, "string");
    assert.equal(code.required, false);
    // The binding carries required + value_type for the runtime.
    await approvePlan(fixture.plan, "range-reviewer");
    const packageRoot = await generatePackage({ workspace: fixture.workspace, plan: fixture.plan });
    const bindings = JSON.parse(await readFile(join(packageRoot, "queries", "bindings.json"), "utf8"));
    const bound = bindings.parameters.find((p) => p.id === "create_time");
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
    const schema = JSON.parse(await readFile(join(packageRoot, "parameters.schema.json"), "utf8"));
    const status = schema.parameters.find((p) => p.id === "status");
    assert.ok(status, "应存在 status 参数");
    assert.equal(status.data_type, "enum");
    assert.deepEqual(status.enum_options, [
        { code: "0", label: "停用" },
        { code: "1", label: "启用" },
    ]);
    // Non-enum params get a data_type too, and no enum_options.
    const code = schema.parameters.find((p) => p.id === "code");
    assert.equal(code.data_type, "string");
    assert.equal(code.enum_options, undefined);
    const ct = schema.parameters.find((p) => p.id === "create_time");
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
    await assert.rejects(generatePackage({ workspace: fixture.workspace, plan: fixture.plan }), /未批准/);
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
    const tablePath = join(fixture.knowledge, "databases", "mysql-main", "transport", "hot", "tables", "driver.json");
    const table = JSON.parse(await readFile(tablePath, "utf8"));
    table.physical_fields = table.physical_fields.filter((field) => field.physical.name !== "create_time");
    await writeFile(tablePath, JSON.stringify(table));
    const configPath = join(fixture.workspace, "config", "easy-bi.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.knowledge.report_requirements[0].required_fields =
        config.knowledge.report_requirements[0].required_fields.filter((field) => !field.field.endsWith(".create_time"));
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
    const tablePath = join(fixture.knowledge, "databases", "mysql-main", "transport", "hot", "tables", "driver.json");
    const table = JSON.parse(await readFile(tablePath, "utf8"));
    table.physical_fields.find((field) => field.physical.name === "code").semantic.name =
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
    const driverPath = join(fixture.knowledge, "databases", "mysql-main", "transport", "hot", "tables", "driver.json");
    const productPath = join(fixture.knowledge, "databases", "mysql-main", "transport", "hot", "tables", "driver_product.json");
    const driver = JSON.parse(await readFile(driverPath, "utf8"));
    const product = JSON.parse(await readFile(productPath, "utf8"));
    driver.physical_fields.find((field) => field.physical.name === "name").semantic.name =
        "业务名称";
    driver.physical_fields.find((field) => field.physical.name === "code").semantic.name =
        "司机编码";
    product.physical_fields.find((field) => field.physical.name === "product_name").semantic.name = "业务名称";
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
    const ambiguous = plan.blockers.find((item) => item.code === "FIELD_AMBIGUOUS");
    assert.equal(ambiguous.candidates.length, 2);
    const missing = plan.blockers.find((item) => item.code === "FIELD_NOT_FOUND");
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
    assert.ok(inspected.blockers.some((item) => item.code === "JOIN_REQUIRED"));
    const configured = await configureJoin(fixture);
    assert.equal(configured.blockers.length, 0);
    assert.ok(configured.warnings.some((item) => item.code === "JOIN_RESOLVED"));
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
    const lock = JSON.parse(await readFile(join(packageRoot, "knowledge.lock.json"), "utf8"));
    assert.equal(lock.sources.length, 2);
    assert.deepEqual(lock.sources.map((item) => item.alias), ["t0", "t1"]);
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
    assert.ok(inspected.blockers.some((item) => item.code === "JOIN_REQUIRED"));
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
    const bindings = JSON.parse(await readFile(join(packageRoot, "queries", "bindings.json"), "utf8"));
    assert.equal(bindings.parameters.find((item) => item.id === "qty").clause, "having");
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
    const tablePath = join(fixture.knowledge, "databases", "mysql-main", "transport", "hot", "tables", "driver.json");
    const table = JSON.parse(await readFile(tablePath, "utf8"));
    for (const f of table.physical_fields) {
        if (f.physical.name === "create_time")
            f.physical.name = "gmt_create";
    }
    await writeFile(tablePath, JSON.stringify(table));
    const configPath = join(fixture.workspace, "config", "easy-bi.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.knowledge.report_requirements[0].required_fields =
        config.knowledge.report_requirements[0].required_fields.filter((field) => !(typeof field === "object" && String(field.field).endsWith(".create_time")));
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
    const param = configured.parameters.find((item) => item.id === "product_name");
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
    const bindings = JSON.parse(await readFile(join(packageRoot, "queries", "bindings.json"), "utf8"));
    const bound = bindings.parameters.find((item) => item.id === "product_name");
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
                    expression: "rows.reduce((sum, row) => sum + Number(row.raw_qty ?? 0), 0)",
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
    const manifest = JSON.parse(await readFile(join(packageRoot, "report.manifest.json"), "utf8"));
    assert.equal(manifest.custom_logic.mode, "group");
    assert.deepEqual(manifest.custom_logic.group_keys, ["code"]);
    const sql = await readFile(join(packageRoot, "queries", "main.sql"), "utf8");
    assert.match(sql, /t1\.`product_name` AS `raw_product_name`/);
    assert.match(sql, /t1\.`qty` AS `raw_qty`/);
    assert.match(sql, /ORDER BY `code` ASC/);
    const transform = (await import(`${pathToFileURL(join(packageRoot, "transforms", "index.mjs")).href}?test=${Date.now()}`));
    const transformed = transform.transformGroup([
        { code: "D1", raw_product_name: "apple", raw_qty: "2" },
        { code: "D1", raw_product_name: "pear", raw_qty: "3" },
    ], { groupKey: ["D1"] });
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
    assert.ok(JSON.parse(before).parameters.some((p) => p.id === "create_time"), "前置条件：create_time 原本是筛选参数");
    const configurationPath = join(fixture.workspace, "reports", "plans", "configuration.json");
    await writeFile(configurationPath, JSON.stringify({
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
    }));
    const plan = await configurePlan(fixture.plan, configurationPath);
    assert.ok(!plan.parameters.some((p) => p.id === "create_time"), "计算字段的筛选参数应被删除");
    const warning = plan.warnings.find((w) => w.code === "FILTER_DROPPED_COMPUTED");
    assert.ok(warning, "应产生 FILTER_DROPPED_COMPUTED 警告");
    assert.ok(warning.fields.some((f) => f.id === "create_time"));
});
test("configure-plan makes a numeric filterable computed field a post_transform range filter", async () => {
    const fixture = await createFixture();
    await inspectReport({
        workspace: fixture.workspace,
        knowledge: fixture.knowledge,
        reportId: "driver-detail",
        out: fixture.plan,
    });
    const configurationPath = join(fixture.workspace, "reports", "plans", "configuration.json");
    // Add a NEW numeric computed field (transform-produced 件数总和 analogue) that the
    // config marks filterable. It must become a post_transform number-range param,
    // NOT be dropped.
    await writeFile(configurationPath, JSON.stringify({
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
    }));
    const plan = await configurePlan(fixture.plan, configurationPath);
    const param = plan.parameters.find((p) => p.id === "sum_qty");
    assert.ok(param, "数值计算字段应生成筛选参数");
    assert.equal(param.value_type, "number_range");
    assert.equal(param.component, "number-range");
    assert.equal(param.sql_binding.clause, "post_transform");
    assert.deepEqual(param.operators, ["between", "gte", "lte"]);
    // It must NOT appear in the dropped-filter warning.
    const warning = plan.warnings.find((w) => w.code === "FILTER_DROPPED_COMPUTED");
    assert.ok(!warning || !warning.fields.some((f) => f.id === "sum_qty"), "数值可筛选计算字段不应被列为已丢弃");
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
    const field = plan.fields.find((f) => f.id === "create_time");
    field.source = {
        kind: "computed",
        mode: "row",
        dependencies: [{ id: "raw_ct", alias: "t0", field: "create_time" }],
        expression: "String(row.raw_ct ?? '')",
    };
    await writeFile(fixture.plan, JSON.stringify(plan));
    await assert.rejects(approvePlan(fixture.plan, "reviewer"), /计算字段 create_time 不能作为 SQL 筛选参数/);
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
                    expression: "(() => { const b={}; for (const r of rows){ const m=String(r.raw_month).slice(0,7); b[m]=(b[m]||0)+Number(r.raw_qty||0);} const ms=Object.keys(b).sort(); return ms.length ? b[ms[ms.length-1]] : 0; })()",
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
                    expression: "(() => { const b={}; for (const r of rows){ const m=String(r.raw_month).slice(0,7); b[m]=(b[m]||0)+Number(r.raw_qty||0);} const ms=Object.keys(b).sort(); if (ms.length<2) return 0; return b[ms[ms.length-1]] - b[ms[ms.length-2]]; })()",
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
    const manifest = JSON.parse(await readFile(join(packageRoot, "report.manifest.json"), "utf8"));
    assert.equal(manifest.comparison.enabled, true);
    assert.equal(manifest.comparison.period_param, "create_time");
    const sql = await readFile(join(packageRoot, "queries", "main.sql"), "utf8");
    assert.match(sql, /t0\.`create_time` AS `raw_month`/);
    assert.match(sql, /t1\.`qty` AS `raw_qty`/);
    const transform = (await import(`${pathToFileURL(join(packageRoot, "transforms", "index.mjs")).href}?test=${Date.now()}`));
    // Two months in the widened window: 2026-03 total 10, 2026-04 total 30.
    const out = transform.transformGroup([
        { code: "D1", raw_month: "2026-03-15 00:00:00", raw_qty: "4" },
        { code: "D1", raw_month: "2026-03-20 00:00:00", raw_qty: "6" },
        { code: "D1", raw_month: "2026-04-05 00:00:00", raw_qty: "12" },
        { code: "D1", raw_month: "2026-04-25 00:00:00", raw_qty: "18" },
    ], { groupKey: ["D1"] });
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
    assert.ok(!(inspected.parameters ?? []).some((p) => p.id === "create_time"));
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
                    expression: "(() => { const b={}; for (const r of rows){ const m=String(r.raw_month).slice(0,7); b[m]=(b[m]||0)+Number(r.raw_qty||0);} const ms=Object.keys(b).sort(); if (ms.length<2) return 0; return b[ms[ms.length-1]] - b[ms[ms.length-2]]; })()",
                },
            },
        ],
        custom_logic: { group_keys: ["code"], max_group_rows: 100000, description: "环比" },
        comparison: { modes: ["chain", "yoy"], lookback_months: 1 },
    });
    // The new computed field was appended, not dropped.
    assert.ok(plan.fields.some((f) => f.id === "qty_mom"));
    // A required datetime month range was synthesized and pointed at by comparison.
    const period = plan.parameters.find((p) => p.id === "create_time");
    assert.ok(period, "应自动新增 create_time 按月筛选");
    assert.equal(period.required, true);
    assert.equal(period.value_type, "datetime_range");
    assert.equal(plan.comparison.period_param, "create_time");
    assert.equal(plan.custom_logic.mode, "group");
    assert.ok((plan.warnings ?? []).some((w) => w.code === "PERIOD_FILTER_ADDED"), "应产出 PERIOD_FILTER_ADDED 警告供 AI 告知用户");
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
    await writeFile(configurationPath, JSON.stringify({
        fields: [
            { id: "brand_new_col", source: { kind: "column", alias: "t0", field: "code" } },
        ],
    }));
    await assert.rejects(configurePlan(fixture.plan, configurationPath), /只能新增 computed/);
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
    await assert.rejects(configureJoin(fixture, {
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
    }), /period_param/);
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
    const manifest = JSON.parse(await readFile(join(packageRoot, "report.manifest.json"), "utf8"));
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
    assert.ok(validation.errors.includes("只支持 report_package_format_version=2"));
});
// ── enrichment (batch secondary-query, generation side) ─────────────────────
/** Add a lookup table (`driver_sku`, one-to-many child of driver via driver_id)
 * to knowledge WITHOUT adding it to required_fields — it is used as an enrichment
 * lookup, not a JOIN. */
async function addSkuLookupTable(fixture) {
    const dir = join(fixture.knowledge, "databases", "mysql-main", "transport", "hot", "tables");
    const field = (name, dataType) => ({
        physical: { name, data_type: dataType, native_type: dataType, primary_key: name === "id", comment: name },
        semantic: { name, status: "inferred", report_ids: ["driver-detail"], enum_ref: null },
        filter: { enabled: true, role: "text", default_operator: "contains", operators: ["contains", "eq"], input_type: "text", visibility: "user", required: false },
    });
    await writeFile(join(dir, "driver_sku.json"), JSON.stringify({
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
    }));
}
async function inspectDriver(fixture) {
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
    await writeFile(configurationPath, JSON.stringify({
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
    }));
    const plan = await configurePlan(fixture.plan, configurationPath);
    // plan.enrichments recorded, lookup resolved from knowledge (table_id/fingerprint filled).
    assert.equal(plan.enrichments.length, 1);
    assert.equal(plan.enrichments[0].lookup.table_id, "mysql-main_transport_driver_sku");
    assert.equal(plan.enrichments[0].on.main_field, "code");
    // A new enrichment-kind field appears.
    const skuField = plan.fields.find((f) => f.id === "sku_name");
    assert.equal(skuField.source.kind, "enrichment");
    assert.equal(skuField.source.enrichment_id, "sku_lookup");
    // Enrichment is NOT a JOIN: lookup table is not added to source.tables.
    assert.ok(!(plan.source.tables ?? []).some((t) => t.table === "driver_sku"));
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
    const skuSource = lock.sources.find((s) => s.table === "driver_sku");
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
    await writeFile(configurationPath, JSON.stringify({
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
    }));
    const plan = await configurePlan(fixture.plan, configurationPath);
    // A parameter is synthesized for the filterable enrichment column, as EXISTS.
    const param = plan.parameters.find((p) => p.id === "sku_name");
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
    const skuParam = bindings.parameters.find((p) => p.id === "sku_name");
    assert.equal(skuParam.clause, "exists_subquery");
});
test("enrichment rejects a cross-profile lookup table", async () => {
    const fixture = await createFixture();
    // Add a lookup table under a DIFFERENT profile.
    const dir = join(fixture.knowledge, "databases", "other-profile", "transport", "hot", "tables");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "ext.json"), JSON.stringify({
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
    }));
    await inspectDriver(fixture);
    const configurationPath = join(fixture.workspace, "reports", "plans", "enrich-x.json");
    await writeFile(configurationPath, JSON.stringify({
        enrichments: [
            {
                id: "ext_lookup",
                lookup: { profile_id: "other-profile", database: "transport", table: "ext", alias: "lk_ext" },
                on: { source: "main", main_field: "code", lookup_field: "code" },
                cardinality: "one",
                select: [{ id: "ext_label", label: "外部标签", lookup_field: "label" }],
            },
        ],
    }));
    await assert.rejects(() => configurePlan(fixture.plan, configurationPath), /跨 profile|同一连接/);
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
    await writeFile(configurationPath, JSON.stringify({
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
    }));
    await assert.rejects(() => configurePlan(fixture.plan, configurationPath), /aggregate/);
});
/** Add a numeric receipt_count column to the driver table + requirement so a test
 * can convert it into a boolean-flag (是/否) field via configure-plan. */
async function addReceiptCountField(fixture) {
    const driverPath = join(fixture.knowledge, "databases", "mysql-main", "transport", "hot", "tables", "driver.json");
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
    await writeFile(configurationPath, JSON.stringify({
        fields: [
            {
                id: "receipt_count",
                output_type: "boolean",
                roles: ["output", "filter"],
                source: { kind: "boolean_flag", operator: "gt", threshold: 0 },
            },
        ],
    }));
    const plan = await configurePlan(fixture.plan, configurationPath);
    const field = plan.fields.find((f) => f.id === "receipt_count");
    assert.equal(field.source.kind, "boolean_flag");
    assert.equal(field.output_type, "boolean");
    const param = plan.parameters.find((p) => p.id === "receipt_count");
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
    const b = bindings.parameters.find((p) => p.id === "receipt_count");
    assert.equal(b.flag_operator, "gt");
    assert.equal(b.flag_threshold, 0);
    assert.equal(b.value_type, "boolean");
});
test("boolean_flag rejects an unknown comparison operator", async () => {
    const fixture = await createFixture();
    await addReceiptCountField(fixture);
    await inspectDriver(fixture);
    const configurationPath = join(fixture.workspace, "reports", "plans", "boolflag-bad.json");
    await writeFile(configurationPath, JSON.stringify({
        fields: [
            { id: "receipt_count", output_type: "boolean", roles: ["output", "filter"], source: { kind: "boolean_flag", operator: "like", threshold: 0 } },
        ],
    }));
    await assert.rejects(() => configurePlan(fixture.plan, configurationPath), /比较符/);
});
//# sourceMappingURL=report-package-cli.test.js.map