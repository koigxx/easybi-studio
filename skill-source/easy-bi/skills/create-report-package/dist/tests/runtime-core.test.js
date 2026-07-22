import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { aggregateMany, applyEnrichmentToBatch, buildEnrichmentValueMap, buildFlagPredicate, buildPostTransformFilter, coerceFlagValue, collectBatchKeys, collectRows, compileSql, enrichBatched, exportSync, createRuntimeServer, listReports, loadReportPackage, outputColumns, querySync, runControlQuery, runGroupQueriesMerged, RuntimeError, topoSortEnrichments, widenComparisonFilters, writeWorkbookRows, } from "../scripts/runtime-core.js";
import { runScriptIsolated, ScriptExecutionError } from "../scripts/script-runtime.js";
test("isolated v3 script uses queryStream/loadIndex/batchLookup/emit through bounded IPC", async () => {
    const root = await mkdtemp(join(tmpdir(), "easybi-script-"));
    const script = join(root, "report.mjs");
    await writeFile(script, [
        "export async function run(ctx) {",
        "  const names = await ctx.loadIndex('names', [], ['id']);",
        "  for await (const row of ctx.queryStream('main')) {",
        "    const children = await ctx.batchLookup('children', [row.id]);",
        "    await ctx.emit({ id: row.id, name: names.get(row.id)[0]?.name, childCount: children.length });",
        "  }",
        "}",
    ].join("\n"));
    const emitted = [];
    const stats = await runScriptIsolated({
        scriptPath: script,
        budget: { max_queries: 10, max_query_rows: 20, max_index_rows: 10, max_batch_keys: 5, max_output_rows: 5, max_memory_mb: 64, timeout_seconds: 10, stream_batch_rows: 1 },
        handlers: {
            async queryStream() { return (async function* () { yield { id: 1 }; yield { id: 2 }; })(); },
            async loadIndex() { return [{ id: 1, name: "A" }, { id: 2, name: "B" }]; },
            async batchLookup(_id, keys) { return keys.map((key) => ({ parent_id: key })); },
        },
        onEmit(row) { emitted.push(row); },
    });
    assert.deepEqual(emitted, [
        { id: 1, name: "A", childCount: 1 },
        { id: 2, name: "B", childCount: 1 },
    ]);
    assert.equal(stats.queryCount, 4);
    assert.equal(stats.outputRows, 2);
});
test("isolated v3 script is canceled through AbortSignal", async () => {
    const root = await mkdtemp(join(tmpdir(), "easybi-script-cancel-"));
    const script = join(root, "report.mjs");
    await writeFile(script, "export async function run(ctx) { for await (const row of ctx.queryStream('main')) await ctx.emit(row); }");
    const controller = new AbortController();
    const running = runScriptIsolated({
        scriptPath: script,
        signal: controller.signal,
        handlers: {
            async queryStream() { return (async function* () { await new Promise(() => undefined); yield {}; })(); },
            async loadIndex() { return []; },
            async batchLookup() { return []; },
        },
        onEmit() { },
    });
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(running, (error) => error instanceof ScriptExecutionError && error.code === "SCRIPT_CANCELED");
});
test("isolated v3 script fails explicitly when the query budget is exceeded", async () => {
    const root = await mkdtemp(join(tmpdir(), "easybi-script-budget-"));
    const script = join(root, "report.mjs");
    await writeFile(script, [
        "export async function run(ctx) {",
        "  await ctx.loadIndex('small', [], ['id']);",
        "  await ctx.loadIndex('small', [], ['id']);",
        "}",
    ].join("\n"));
    await assert.rejects(runScriptIsolated({
        scriptPath: script,
        budget: { max_queries: 1 },
        handlers: {
            async queryStream() { return (async function* () { })(); },
            async loadIndex() { return []; },
            async batchLookup() { return []; },
        },
        onEmit() { },
    }), (error) => error instanceof ScriptExecutionError && error.code === "QUERY_BUDGET_EXCEEDED");
});
test("Runtime preview and Excel export execute a v3 package in the isolated runner", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "easybi-v3-runtime-"));
    const packageRoot = join(workspace, "reports", "packages", "script-report", "0.1.0-draft");
    await mkdir(join(workspace, "toolkit", "config"), { recursive: true });
    await mkdir(join(workspace, "config"), { recursive: true });
    await mkdir(join(workspace, "reports"), { recursive: true });
    await mkdir(join(packageRoot, "scripts"), { recursive: true });
    await writeJson(join(workspace, "toolkit", "config", "runtime.json"), {
        execution_strategy: {
            sync: {
                enabled: true,
                preview_max_rows: 100,
                query_timeout_seconds: 5,
                total_timeout_seconds: 10,
                max_rows_per_sheet: 1000,
                max_sheets_per_workbook: 2,
                max_columns: 20,
                max_file_bytes: 10_000_000,
                sheet_overflow: "split",
                build_to_temp_file_before_response: true,
                script_budget_ceiling: {
                    max_queries: 10, max_query_rows: 100, max_index_rows: 100,
                    max_batch_keys: 100, max_output_rows: 100, max_memory_mb: 128,
                    timeout_seconds: 10, stream_batch_rows: 16,
                },
            },
        },
        storage: { local_output_directory: "outputs/files" },
    });
    await writeJson(join(workspace, "config", "easy-bi.json"), { connections: { database_profiles: [] } });
    await writeJson(join(workspace, "reports", "index.json"), {
        reports: [{ id: "script-report", name: "脚本报表", version: "0.1.0-draft", path: "packages/script-report/0.1.0-draft" }],
    });
    await writeJson(join(packageRoot, "report.manifest.json"), {
        report_package_format_version: "3",
        id: "script-report",
        name: "脚本报表",
        version: "0.1.0-draft",
        entrypoints: { script: "scripts/report.mjs", fields: "fields.json", parameters: "parameters.schema.json", knowledge_lock: "knowledge.lock.json" },
        resource_budget: { max_queries: 2, max_query_rows: 10, max_index_rows: 10, max_batch_keys: 10, max_output_rows: 10, max_memory_mb: 64, timeout_seconds: 5, stream_batch_rows: 2 },
        queries: [],
    });
    await writeJson(join(packageRoot, "fields.json"), {
        schema_version: "2",
        fields: [{ id: "name", label: "名称", value_type: "string", source: { kind: "script" } }],
    });
    await writeJson(join(packageRoot, "parameters.schema.json"), { schema_version: "1", parameters: [] });
    await writeJson(join(packageRoot, "knowledge.lock.json"), { lock_format_version: "2", sources: [] });
    await writeFile(join(packageRoot, "scripts", "report.mjs"), [
        "export async function run(ctx) {",
        "  await ctx.emit({ name: '甲' });",
        "  await ctx.emit({ name: '乙' });",
        "}",
    ].join("\n"));
    const preview = await querySync(workspace, { reportId: "script-report" });
    assert.deepEqual(preview.rows, [{ name: "甲" }, { name: "乙" }]);
    assert.equal(preview.executionModel, "isolated_script");
    const exported = await exportSync(workspace, { reportId: "script-report" });
    assert.equal(exported.rowCount, 2);
    assert.equal(exported.executionModel, "isolated_script");
});
async function writeJson(path, value) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
test("SQL compiler supports empty filters, fixed values, defaults and WHERE marker", () => {
    const bindings = {
        parameters: [
            {
                id: "code",
                expression: "t0.`code`",
                clause: "where",
                operators: ["eq", "in"],
                default_operator: "eq",
            },
            {
                id: "name",
                expression: "t0.`name`",
                clause: "where",
                operators: ["contains", "eq"],
                value_adapter: "contains",
            },
            {
                id: "create_time",
                expression: "t0.`create_time`",
                clause: "where",
                operators: ["between", "gte", "lte"],
                default_operator: "between",
            },
        ],
        context: [
            {
                api_key: "tenantId",
                expression: "t0.`tenant_id`",
                operator: "eq",
                required: false,
            },
        ],
        system: [
            {
                id: "__system_is_delete",
                expression: "t0.`is_delete`",
                operator: "eq",
                value: 0,
            },
        ],
    };
    const template = [
        "SELECT * FROM t AS t0",
        "WHERE t0.`is_delete` = :__system_is_delete",
        "/* EASYBI_FILTERS */",
        "ORDER BY t0.`create_time` DESC, t0.`id` DESC",
    ].join("\n");
    const empty = compileSql(template, bindings);
    assert.doesNotMatch(empty.sql, /EASYBI_FILTERS|AND\s+ORDER BY/);
    assert.deepEqual(empty.values, [0]);
    const filtered = compileSql(template, bindings, {
        code: "D001",
        name: "张_%",
        create_time: { value: { from: "2026-01-01", to: "2026-01-31" } },
    }, { tenantId: 8 });
    assert.match(filtered.sql, /t0\.`code` = \?/);
    assert.match(filtered.sql, /t0\.`name` LIKE \? ESCAPE/);
    assert.match(filtered.sql, /t0\.`tenant_id` = \?/);
    assert.match(filtered.sql, /t0\.`create_time` BETWEEN \? AND \?/);
    assert.deepEqual(filtered.values, [
        0,
        "D001",
        "%张\\_\\%%",
        "2026-01-01",
        "2026-01-31",
        8,
    ]);
});
test("SQL compiler places WHERE and HAVING values in textual placeholder order", () => {
    const compiled = compileSql([
        "SELECT t0.`code`, SUM(t1.`qty`) AS `total_qty`",
        "FROM `demo`.`orders` AS t0",
        "LEFT JOIN `demo`.`items` AS t1",
        "  ON t0.`id` = t1.`order_id` AND t1.`is_delete` = :__join_deleted",
        "WHERE t0.`is_delete` = :__main_deleted",
        "/* EASYBI_FILTERS */",
        "GROUP BY t0.`code`",
        "HAVING SUM(t1.`qty`) >= :__minimum",
        "/* EASYBI_HAVING_FILTERS */",
    ].join("\n"), {
        parameters: [
            {
                id: "code",
                expression: "t0.`code`",
                clause: "where",
                operators: ["eq"],
                default_operator: "eq",
            },
            {
                id: "total_qty",
                expression: "SUM(t1.`qty`)",
                clause: "having",
                operators: ["gte"],
                default_operator: "gte",
            },
        ],
        system: [
            { id: "__main_deleted", value: 0 },
            { id: "__join_deleted", value: 0 },
            { id: "__minimum", value: 1 },
        ],
    }, { code: "A", total_qty: 10 });
    assert.deepEqual(compiled.values, [0, 0, "A", 1, 10]);
    assert.doesNotMatch(compiled.sql, /EASYBI_|:[A-Za-z_]/);
});
test("SQL compiler wraps an exists_subquery filter value as a bound ? inside EXISTS", () => {
    const bindings = {
        parameters: [
            {
                id: "product_name",
                expression: "ex_t1.`product_name`",
                clause: "exists_subquery",
                operators: ["contains"],
                default_operator: "contains",
                value_adapter: "contains",
                subquery_prefix: "EXISTS (SELECT 1 FROM `transport`.`driver_product` AS ex_t1 WHERE ex_t1.`driver_id` = t0.`id` AND ex_t1.`is_delete` = 0 AND ",
                subquery_suffix: ")",
            },
        ],
        system: [{ id: "__main_deleted", expression: "t0.`is_delete`", operator: "eq", value: 0 }],
    };
    const template = [
        "SELECT t0.`id`, GROUP_CONCAT(t1.`product_name`) AS `product_name`",
        "FROM `transport`.`orders` AS t0",
        "LEFT JOIN `transport`.`driver_product` AS t1 ON t0.`id` = t1.`driver_id`",
        "WHERE t0.`is_delete` = :__main_deleted",
        "/* EASYBI_FILTERS */",
        "GROUP BY t0.`id`",
    ].join("\n");
    const compiled = compileSql(template, bindings, { product_name: "钢" });
    // The value is bound, not inlined; the EXISTS skeleton surrounds a single ?.
    assert.match(compiled.sql, /EXISTS \(SELECT 1 FROM `transport`\.`driver_product` AS ex_t1 WHERE ex_t1\.`driver_id` = t0\.`id` AND ex_t1\.`is_delete` = 0 AND ex_t1\.`product_name` LIKE \? ESCAPE '\\\\'\)/);
    assert.deepEqual(compiled.values, [0, "%钢%"]);
    assert.doesNotMatch(compiled.sql, /EASYBI_|:[A-Za-z_]/);
});
test("required filter is enforced; a two-bound range compiles to BETWEEN", () => {
    const bindings = {
        parameters: [
            {
                id: "create_time",
                expression: "t0.`create_time`",
                clause: "where",
                operators: ["between", "gte", "lte"],
                default_operator: "between",
                required: true,
                value_type: "datetime_range",
            },
        ],
        system: [{ id: "__main_deleted", expression: "t0.`is_delete`", operator: "eq", value: 0 }],
    };
    const template = [
        "SELECT * FROM `t` AS t0",
        "WHERE t0.`is_delete` = :__main_deleted",
        "/* EASYBI_FILTERS */",
    ].join("\n");
    // Missing required create-time range -> error.
    assert.throws(() => compileSql(template, bindings, {}), /必填/);
    // Empty range object also counts as missing.
    assert.throws(() => compileSql(template, bindings, { create_time: { from: "", to: "" } }), /必填/);
    // A full range compiles to BETWEEN with both bounds bound as ?.
    const both = compileSql(template, bindings, {
        create_time: { from: "2026-01-01 00:00:00", to: "2026-01-31 23:59:59" },
    });
    assert.match(both.sql, /t0\.`create_time` BETWEEN \? AND \?/);
    assert.deepEqual(both.values, [0, "2026-01-01 00:00:00", "2026-01-31 23:59:59"]);
    // A one-sided range degrades to >= (still satisfies required).
    const fromOnly = compileSql(template, bindings, {
        create_time: { from: "2026-01-01 00:00:00" },
    });
    assert.match(fromOnly.sql, /t0\.`create_time` >= \?/);
    assert.deepEqual(fromOnly.values, [0, "2026-01-01 00:00:00"]);
});
test("comparison widening pushes the period lower bound back to cover chain + yoy", () => {
    const comparison = {
        enabled: true,
        period_param: "create_time",
        modes: ["chain", "yoy"],
        lookback_months: 1,
    };
    // 4–8 月：chain 需要上月(3 月)、yoy 需要去年 4 月；取更早的去年 4 月作下界。
    const widened = widenComparisonFilters(comparison, {
        create_time: { from: "2026-04", to: "2026-08" },
    });
    assert.equal(widened.create_time.from, "2025-04-01");
    assert.equal(widened.create_time.to, "2026-08");
});
test("comparison widening with only chain looks back lookback_months, not a year", () => {
    const widened = widenComparisonFilters({ enabled: true, period_param: "create_time", modes: ["chain"], lookback_months: 2 }, { create_time: { from: "2026-04", to: "2026-08" } });
    assert.equal(widened.create_time.from, "2026-02-01");
    assert.equal(widened.create_time.to, "2026-08");
});
test("comparison widening preserves the {operator,value} wrapper shape", () => {
    const widened = widenComparisonFilters({ enabled: true, period_param: "create_time", modes: ["yoy"], lookback_months: 1 }, { create_time: { operator: "between", value: { from: "2026-04", to: "2026-08" } } });
    const value = widened.create_time.value;
    assert.equal(value.from, "2025-04-01");
    assert.equal(value.to, "2026-08");
});
test("comparison widening is a no-op without comparison or a lower bound", () => {
    const filters = { create_time: { from: "2026-04", to: "2026-08" } };
    // No comparison / disabled → returns the same object reference untouched.
    assert.strictEqual(widenComparisonFilters(undefined, filters), filters);
    assert.strictEqual(widenComparisonFilters({ enabled: false }, filters), filters);
    // Enabled but the period filter has no lower bound → nothing to widen.
    const noFrom = { create_time: { to: "2026-08" } };
    assert.strictEqual(widenComparisonFilters({ enabled: true, period_param: "create_time", modes: ["yoy"] }, noFrom), noFrom);
});
test("MySQL control statements always use query rather than execute", async () => {
    const calls = [];
    const connection = {
        query(sql, callback) {
            calls.push(sql);
            callback(null);
        },
        execute() {
            assert.fail("控制语句不得调用 execute()");
        },
    };
    await runControlQuery(connection, "SET SESSION TRANSACTION READ ONLY");
    await runControlQuery(connection, "START TRANSACTION");
    await runControlQuery(connection, "ROLLBACK");
    assert.deepEqual(calls, [
        "SET SESSION TRANSACTION READ ONLY",
        "START TRANSACTION",
        "ROLLBACK",
    ]);
});
test("streaming workbook automatically splits into at most two sheets", async () => {
    const root = await mkdtemp(join(tmpdir(), "easybi-runtime-xlsx-"));
    const output = join(root, "two-sheets.xlsx");
    async function* rows() {
        yield { id: "1", name: "甲" };
        yield { id: "2", name: "乙" };
        yield { id: "3", name: "丙" };
    }
    const report = {
        manifest: { id: "demo", name: "测试报表" },
        fields: {
            fields: [
                { id: "id", label: "编码", excel: {} },
                { id: "name", label: "名称", excel: {} },
            ],
        },
    };
    const result = await writeWorkbookRows(report, rows(), output, {
        max_rows_per_sheet: 2,
        max_sheets_per_workbook: 2,
        max_file_bytes: 10_000_000,
        total_timeout_seconds: 30,
    }, (row) => ({ ...row, name: `${row.name}！` }));
    assert.equal(result.rowCount, 3);
    assert.equal(result.sheetCount, 2);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    assert.equal(workbook.worksheets.length, 2);
    assert.equal(workbook.worksheets[0]?.rowCount, 3);
    assert.equal(workbook.worksheets[1]?.rowCount, 2);
    assert.equal(workbook.worksheets[0]?.getCell("B2").value, "甲！");
});
test("enum output columns are translated to 中文, unmapped values kept raw", async () => {
    const root = await mkdtemp(join(tmpdir(), "easybi-runtime-enum-"));
    const output = join(root, "enum.xlsx");
    async function* rows() {
        yield { id: "1", status: "FINISHED" };
        yield { id: "2", status: "BE_ALLOCATED" };
        yield { id: "3", status: "UNKNOWN_CODE" }; // not in the dictionary
    }
    const report = {
        manifest: { id: "demo", name: "测试报表" },
        fields: {
            fields: [
                { id: "id", label: "编码", excel: {} },
                { id: "status", label: "订单状态", excel: {} },
            ],
        },
        enums: {
            schema_version: "1",
            report_id: "demo",
            byField: { status: { FINISHED: "已完成", BE_ALLOCATED: "待分配" } },
        },
    };
    const result = await writeWorkbookRows(report, rows(), output, {
        max_rows_per_sheet: 100,
        max_sheets_per_workbook: 2,
        max_file_bytes: 10_000_000,
        total_timeout_seconds: 30,
    });
    assert.equal(result.rowCount, 3);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.getCell("B2").value, "已完成"); // FINISHED -> 中文
    assert.equal(sheet.getCell("B3").value, "待分配"); // BE_ALLOCATED -> 中文
    assert.equal(sheet.getCell("B4").value, "UNKNOWN_CODE"); // unmapped kept raw
});
test("packages without an enums file export raw values unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "easybi-runtime-noenum-"));
    const output = join(root, "raw.xlsx");
    async function* rows() {
        yield { id: "1", status: "FINISHED" };
    }
    const report = {
        manifest: { id: "demo", name: "测试报表" },
        fields: { fields: [{ id: "id", label: "编码", excel: {} }, { id: "status", label: "状态", excel: {} }] },
    };
    const result = await writeWorkbookRows(report, rows(), output, {
        max_rows_per_sheet: 100,
        max_sheets_per_workbook: 2,
        max_file_bytes: 10_000_000,
        total_timeout_seconds: 30,
    });
    assert.equal(result.rowCount, 1);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    assert.equal(workbook.worksheets[0].getCell("B2").value, "FINISHED");
});
test("outputColumns returns 中文 headers with optional descriptions", () => {
    const columns = outputColumns({
        fields: {
            fields: [
                { id: "id", label: "编码" },
                { id: "qty", label: "订单数总和", description: "订单数量的总和" },
            ],
        },
    });
    assert.deepEqual(columns, [
        { id: "id", label: "编码" },
        { id: "qty", label: "订单数总和", description: "订单数量的总和" },
    ]);
});
test("collectRows applies enum translation and honors the row cap (truncation)", async () => {
    async function* rows() {
        yield { id: "1", status: "FINISHED", extra: "dropped" };
        yield { id: "2", status: "BE_ALLOCATED" };
        yield { id: "3", status: "UNKNOWN_CODE" };
    }
    const report = {
        manifest: { id: "demo", name: "测试报表" },
        fields: {
            fields: [
                { id: "id", label: "编码" },
                { id: "status", label: "订单状态" },
            ],
        },
        enums: { byField: { status: { FINISHED: "已完成", BE_ALLOCATED: "待分配" } } },
    };
    const capped = await collectRows(report, rows(), { mode: "identity" }, {
        maxRows: 2,
        startedAt: Date.now(),
        totalTimeoutSeconds: 30,
    });
    assert.equal(capped.rowCount, 2);
    assert.equal(capped.truncated, true);
    // Only declared output fields survive; enum codes map to 中文.
    assert.deepEqual(capped.rows[0], { id: "1", status: "已完成" });
    assert.deepEqual(capped.rows[1], { id: "2", status: "待分配" });
    // A cap above the row count keeps every row and leaves unmapped codes raw.
    const full = await collectRows(report, rows(), { mode: "identity" }, {
        maxRows: 100,
        startedAt: Date.now(),
        totalTimeoutSeconds: 30,
    });
    assert.equal(full.rowCount, 3);
    assert.equal(full.truncated, false);
    assert.equal(full.rows[2]?.status, "UNKNOWN_CODE");
});
test("collectRows runs a group transform and returns computed rows", async () => {
    async function* rows() {
        yield { driver: "A", qty: 2 };
        yield { driver: "A", qty: 3 };
        yield { driver: "B", qty: 10 };
    }
    const report = {
        manifest: { id: "demo", name: "测试报表" },
        fields: { fields: [{ id: "driver", label: "司机" }, { id: "qty", label: "货量合计" }] },
    };
    const collected = await collectRows(report, rows(), {
        mode: "group",
        groupKeys: ["driver"],
        maxGroupRows: 1000,
        transformGroup: (groupRows) => ({
            driver: groupRows[0].driver,
            qty: groupRows.reduce((sum, r) => sum + Number(r.qty), 0),
        }),
    }, { maxRows: 100, startedAt: Date.now(), totalTimeoutSeconds: 30 });
    assert.equal(collected.rowCount, 2);
    assert.deepEqual(collected.rows[0], { driver: "A", qty: 5 });
    assert.deepEqual(collected.rows[1], { driver: "B", qty: 10 });
});
test("group transform streams contiguous groups and emits computed rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "easybi-runtime-group-"));
    const output = join(root, "group.xlsx");
    async function* rows() {
        yield { order_id: "A", qty: "2" };
        yield { order_id: "A", qty: "3" };
        yield { order_id: "B", qty: "4" };
    }
    const report = {
        manifest: { id: "group-demo", name: "分组计算报表" },
        fields: {
            fields: [
                { id: "order_id", label: "订单", excel: {} },
                { id: "total_qty", label: "总数量", excel: {} },
            ],
        },
    };
    const result = await writeWorkbookRows(report, rows(), output, {
        max_rows_per_sheet: 100,
        max_sheets_per_workbook: 2,
        max_file_bytes: 10_000_000,
        total_timeout_seconds: 30,
    }, {
        mode: "group",
        groupKeys: ["order_id"],
        maxGroupRows: 10,
        transformGroup(groupRows, context) {
            return {
                order_id: context.groupKey[0],
                total_qty: groupRows.reduce((sum, row) => sum + Number(row.qty), 0),
            };
        },
    });
    assert.equal(result.rowCount, 2);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.getCell("A2").value, "A");
    assert.equal(sheet.getCell("B2").value, 5);
    assert.equal(sheet.getCell("A3").value, "B");
    assert.equal(sheet.getCell("B3").value, 4);
});
test("row transform computes derived columns without buffering", async () => {
    const root = await mkdtemp(join(tmpdir(), "easybi-runtime-row-"));
    const output = join(root, "row.xlsx");
    async function* rows() {
        yield { qty: 2, price: 3 };
        yield { qty: 4, price: 5 };
    }
    const result = await writeWorkbookRows({
        manifest: { id: "row-demo", name: "逐行计算报表" },
        fields: {
            fields: [{ id: "amount", label: "金额", excel: {} }],
        },
    }, rows(), output, {
        max_rows_per_sheet: 100,
        max_sheets_per_workbook: 2,
        max_file_bytes: 10_000_000,
        total_timeout_seconds: 30,
    }, {
        mode: "row",
        transformRow: (row) => ({
            ...row,
            amount: Number(row.qty) * Number(row.price),
        }),
    });
    assert.equal(result.rowCount, 2);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    assert.equal(workbook.worksheets[0].getCell("A2").value, 6);
    assert.equal(workbook.worksheets[0].getCell("A3").value, 20);
});
test("HTTP server exposes report list and parameter schema with HTTP 200", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "easybi-runtime-http-"));
    const packageRoot = join(workspace, "reports", "packages", "demo", "1.0.0");
    await writeJson(join(workspace, "reports", "index.json"), {
        reports: [
            {
                id: "demo",
                name: "演示报表",
                version: "1.0.0",
                status: "draft",
                path: "packages/demo/1.0.0",
                development_only: true,
            },
        ],
    });
    await writeJson(join(packageRoot, "report.manifest.json"), {
        report_package_format_version: "2",
        id: "demo",
        name: "演示报表",
        version: "1.0.0",
        entrypoints: {},
        custom_logic: { mode: "identity" },
        context_bindings: [
            { api_key: "tenantId", required: false },
        ],
    });
    await writeJson(join(packageRoot, "fields.json"), { fields: [] });
    await writeJson(join(packageRoot, "parameters.schema.json"), {
        parameters: [
            {
                id: "code",
                label: "编码",
                value_type: "string",
                component: "text",
                operators: ["eq"],
                default_operator: "eq",
            },
        ],
    });
    await writeJson(join(packageRoot, "queries", "bindings.json"), {});
    await writeJson(join(packageRoot, "knowledge.lock.json"), {});
    await mkdir(join(packageRoot, "queries"), { recursive: true });
    await writeFile(join(packageRoot, "queries", "main.sql"), "SELECT 1\n/* EASYBI_FILTERS */\n");
    await writeJson(join(workspace, "toolkit", "config", "runtime.json"), {
        http: { host: "127.0.0.1", port: 0, always_http_200: true },
        execution_strategy: { default_mode: "sync", async: { enabled: false } },
        storage: {
            sqlite_path: "data/runtime.db",
            local_output_directory: "outputs/files",
        },
    });
    const runtime = await createRuntimeServer(workspace);
    await new Promise((resolvePromise) => runtime.server.listen(0, "127.0.0.1", resolvePromise));
    const address = runtime.server.address();
    assert.ok(address && typeof address === "object");
    try {
        const reportsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/reports`);
        assert.equal(reportsResponse.status, 200);
        const reports = await reportsResponse.json();
        assert.equal(reports.success, true);
        assert.equal(reports.data.items[0].id, "demo");
        const paramsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/reports/demo/parameters`);
        assert.equal(paramsResponse.status, 200);
        const parameters = await paramsResponse.json();
        assert.equal(parameters.data.parameters[0].valueType, "string");
        assert.equal(parameters.data.contextParameters[0].visible, false);
        const notFound = await fetch(`http://127.0.0.1:${address.port}/missing`);
        assert.equal(notFound.status, 200);
        const missing = await notFound.json();
        assert.equal(missing.success, false);
        assert.equal(missing.error.code, "NOT_FOUND");
        // The sync JSON query endpoint exists and validates its request body.
        const noReport = await fetch(`http://127.0.0.1:${address.port}/api/v1/queries`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
        });
        assert.equal(noReport.status, 200);
        const noReportBody = await noReport.json();
        assert.equal(noReportBody.success, false);
        assert.equal(noReportBody.error.code, "REPORT_ID_REQUIRED");
    }
    finally {
        await runtime.close();
    }
    const manifestPath = join(packageRoot, "report.manifest.json");
    const v1Manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    v1Manifest.report_package_format_version = "1";
    await writeJson(manifestPath, v1Manifest);
    await assert.rejects(loadReportPackage(workspace, "demo"), (error) => error instanceof RuntimeError &&
        error.code === "UNSUPPORTED_REPORT_PACKAGE_FORMAT");
    await assert.rejects(listReports(workspace), (error) => error instanceof RuntimeError &&
        error.code === "UNSUPPORTED_REPORT_PACKAGE_FORMAT");
});
test("third sheet is rejected deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "easybi-runtime-overflow-"));
    async function* rows() {
        yield { id: 1 };
        yield { id: 2 };
        yield { id: 3 };
    }
    await assert.rejects(writeWorkbookRows({
        manifest: { id: "demo", name: "演示" },
        fields: { fields: [{ id: "id", label: "ID", excel: {} }] },
    }, rows(), join(root, "overflow.xlsx"), {
        max_rows_per_sheet: 1,
        max_sheets_per_workbook: 2,
        max_file_bytes: 10_000_000,
        total_timeout_seconds: 30,
    }), (error) => error instanceof RuntimeError && error.code === "SHEET_LIMIT_EXCEEDED");
});
test("post_transform numeric range filter keeps only in-range computed rows", () => {
    const bindings = {
        parameters: [
            {
                id: "sum_qty",
                clause: "post_transform",
                value_type: "number_range",
                operators: ["between", "gte", "lte"],
                required: false,
            },
        ],
    };
    // between {from:10, to:20}
    const between = buildPostTransformFilter(bindings, {
        sum_qty: { operator: "between", value: { from: 10, to: 20 } },
    });
    assert.equal(between({ sum_qty: 5 }), false);
    assert.equal(between({ sum_qty: 10 }), true);
    assert.equal(between({ sum_qty: 15 }), true);
    assert.equal(between({ sum_qty: 20 }), true);
    assert.equal(between({ sum_qty: 21 }), false);
    // A non-numeric / missing computed value can't satisfy a numeric range.
    assert.equal(between({ sum_qty: null }), false);
    // One-sided lower bound (>=).
    const gte = buildPostTransformFilter(bindings, { sum_qty: { from: 100, to: "" } });
    assert.equal(gte({ sum_qty: 99 }), false);
    assert.equal(gte({ sum_qty: 100 }), true);
    // Empty (optional) filter → pass-through predicate.
    const none = buildPostTransformFilter(bindings, {});
    assert.equal(none({ sum_qty: -999 }), true);
});
test("post_transform required filter with no value throws MISSING_FILTER", () => {
    const bindings = {
        parameters: [
            { id: "sum_qty", clause: "post_transform", value_type: "number_range", required: true },
        ],
    };
    assert.throws(() => buildPostTransformFilter(bindings, {}), (error) => error instanceof RuntimeError && error.code === "MISSING_FILTER");
});
test("collectRows applies the post_transform filter to transformed output rows", async () => {
    async function* rows() {
        yield { g: "a", n: 5 };
        yield { g: "b", n: 15 };
        yield { g: "c", n: 25 };
    }
    const report = {
        manifest: { id: "demo", name: "测试报表" },
        fields: { fields: [{ id: "g", label: "组" }, { id: "n", label: "数值" }] },
    };
    const bindings = {
        parameters: [
            { id: "n", clause: "post_transform", value_type: "number_range", operators: ["between"], required: false },
        ],
    };
    const postFilter = buildPostTransformFilter(bindings, {
        n: { operator: "between", value: { from: 10, to: 20 } },
    });
    const collected = await collectRows(report, rows(), { mode: "identity" }, { maxRows: 1000, startedAt: Date.now(), totalTimeoutSeconds: 30, postFilter });
    assert.equal(collected.rowCount, 1);
    assert.equal(collected.rows[0].n, 15);
});
// ── enrichment (batch secondary-query + in-memory merge) ────────────────────
test("topoSortEnrichments orders a chained enrichment after its upstream", () => {
    const e = (id, src) => ({
        id,
        sql_template: "",
        key_source: (src ? "enrichment" : "main"),
        key_source_id: src ?? null,
        main_key_field: "k",
        lookup_key_alias: "__key",
        cardinality: "one",
        select_ids: [id],
    });
    // t3 depends on t1's output; declared out of order.
    const ordered = topoSortEnrichments([e("t3", "t1"), e("t1"), e("t2")]);
    const ids = ordered.map((x) => x.id);
    assert.ok(ids.indexOf("t1") < ids.indexOf("t3"), "t1 must run before t3");
    assert.ok(ids.includes("t2"));
});
test("topoSortEnrichments throws on a dependency cycle", () => {
    const e = (id, src) => ({
        id,
        sql_template: "",
        key_source: "enrichment",
        key_source_id: src,
        main_key_field: "k",
        lookup_key_alias: "__key",
        cardinality: "one",
        select_ids: [id],
    });
    assert.throws(() => topoSortEnrichments([e("a", "b"), e("b", "a")]), (error) => error instanceof RuntimeError && error.code === "INVALID_ENRICHMENT");
});
test("aggregateMany: group_concat distinct, count, sum, first", () => {
    const rows = [{ v: "钢" }, { v: "铝" }, { v: "钢" }];
    assert.equal(aggregateMany(rows, "sku", "v", { kind: "group_concat", distinct: true, separator: "," }), "钢,铝");
    assert.equal(aggregateMany(rows, "sku", "v", { kind: "group_concat", distinct: false, separator: "|" }), "钢|铝|钢");
    assert.equal(aggregateMany(rows, "sku", "v", { kind: "count" }), 3);
    assert.equal(aggregateMany([{ v: 2 }, { v: 3 }], "s", "v", { kind: "sum" }), 5);
    assert.equal(aggregateMany([{ v: "x" }, { v: "y" }], "s", "v", { kind: "first" }), "x");
});
test("buildEnrichmentValueMap: one takes first + records multi-hit; many aggregates", () => {
    const oneBinding = {
        id: "e1",
        sql_template: "",
        key_source: "main",
        main_key_field: "raw_k",
        lookup_key_alias: "__key",
        cardinality: "one",
        select_ids: ["outbound_date"],
    };
    const oneRows = [
        { __key: "A", outbound_date: "2026-01-01" },
        { __key: "A", outbound_date: "2026-02-02" }, // duplicate key → multi-hit
        { __key: "B", outbound_date: "2026-03-03" },
    ];
    const one = buildEnrichmentValueMap(oneBinding, oneRows, { outbound_date: "outbound_date" });
    assert.equal(one.values.get("A").outbound_date, "2026-01-01"); // first wins
    assert.deepEqual(one.multiHitKeys, ["A"]);
    const manyBinding = {
        id: "e2",
        sql_template: "",
        key_source: "main",
        main_key_field: "raw_wb",
        lookup_key_alias: "__key",
        cardinality: "many",
        aggregate: { kind: "group_concat", distinct: true, separator: "," },
        select_ids: ["sku_name"],
    };
    const manyRows = [
        { __key: "W1", sku_name: "钢" },
        { __key: "W1", sku_name: "铝" },
        { __key: "W2", sku_name: "铜" },
    ];
    const many = buildEnrichmentValueMap(manyBinding, manyRows, { sku_name: "sku_name" });
    assert.equal(many.values.get("W1").sku_name, "钢,铝");
    assert.equal(many.values.get("W2").sku_name, "铜");
    assert.equal(many.multiHitKeys.length, 0); // many never records multi-hit
});
test("collectBatchKeys dedupes and drops null/empty keys", () => {
    const batch = [
        { raw_k: "A" },
        { raw_k: "A" },
        { raw_k: null },
        { raw_k: "" },
        { raw_k: "B" },
    ];
    assert.deepEqual(collectBatchKeys(batch, "raw_k"), ["A", "B"]);
});
test("applyEnrichmentToBatch merges values and applies on_missing", () => {
    const binding = {
        id: "e",
        sql_template: "",
        key_source: "main",
        main_key_field: "raw_k",
        lookup_key_alias: "__key",
        cardinality: "one",
        select_ids: ["label"],
        on_missing: "null",
    };
    const batch = [{ raw_k: "A" }, { raw_k: "Z" }]; // Z has no match
    const valueMap = new Map([["A", { label: "甲" }]]);
    applyEnrichmentToBatch(batch, binding, valueMap);
    assert.equal(batch[0].label, "甲");
    assert.equal(batch[1].label, null); // on_missing=null
});
test("enrichBatched batches keys, issues IN queries, merges, and warns on multi-hit", async () => {
    // Two batches of 2 main rows each (batchSize=2). Main rows carry raw_wb key.
    async function* main() {
        yield { id: 1, raw_wb: "W1" };
        yield { id: 2, raw_wb: "W2" };
        yield { id: 3, raw_wb: "W3" };
        yield { id: 4, raw_wb: null }; // no key
    }
    const inCalls = [];
    const fakeAdapter = {
        async queryAll(sql, values) {
            inCalls.push(values);
            // Return sku rows for whichever keys were asked (many-cardinality).
            const rowsByKey = {
                W1: [{ __key: "W1", sku_name: "钢" }, { __key: "W1", sku_name: "铝" }],
                W2: [{ __key: "W2", sku_name: "铜" }],
                // W3 has no lookup rows → on_missing
            };
            return values.flatMap((k) => rowsByKey[String(k)] ?? []);
        },
    };
    const binding = {
        id: "sku_lookup",
        sql_template: "SELECT `wb` AS `__key`, `sku_name` FROM `t`.`sku` WHERE `is_delete` = 0 AND `wb` IN (/* KEYS */)",
        key_source: "main",
        main_key_field: "raw_wb",
        lookup_key_alias: "__key",
        cardinality: "many",
        aggregate: { kind: "group_concat", distinct: true, separator: "," },
        select_ids: ["sku_name"],
        on_missing: "null",
    };
    const warnings = [];
    const out = [];
    for await (const row of enrichBatched(main(), [binding], fakeAdapter, 30_000, 2, warnings)) {
        out.push(row);
    }
    assert.equal(out.length, 4); // many folds child rows → main row count unchanged
    assert.equal(out[0].sku_name, "钢,铝");
    assert.equal(out[1].sku_name, "铜");
    assert.equal(out[2].sku_name, null); // W3 unmatched → on_missing null
    assert.equal(out[3].sku_name, null); // null key → on_missing
    // Two batches → two IN queries; first batch asked for [W1, W2], second [W3].
    assert.equal(inCalls.length, 2);
    assert.deepEqual(inCalls[0], ["W1", "W2"]);
    assert.deepEqual(inCalls[1], ["W3"]);
});
test("enrichBatched (one) warns when a key hits multiple lookup rows", async () => {
    async function* main() {
        yield { raw_k: "A" };
    }
    const fakeAdapter = {
        async queryAll() {
            return [
                { __key: "A", label: "甲" },
                { __key: "A", label: "乙" }, // multi-hit for cardinality=one
            ];
        },
    };
    const binding = {
        id: "e",
        sql_template: "SELECT `k` AS `__key`, `label` FROM `t`.`d` WHERE `k` IN (/* KEYS */)",
        key_source: "main",
        main_key_field: "raw_k",
        lookup_key_alias: "__key",
        cardinality: "one",
        select_ids: ["label"],
        on_missing: "null",
    };
    const warnings = [];
    const out = [];
    for await (const row of enrichBatched(main(), [binding], fakeAdapter, 30_000, 100, warnings)) {
        out.push(row);
    }
    assert.equal(out[0].label, "甲"); // first wins
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /命中多行/);
});
test("many count enrichment defaults missing rows to 0", () => {
    const binding = {
        id: "e",
        sql_template: "",
        key_source: "main",
        main_key_field: "raw_k",
        lookup_key_alias: "__key",
        cardinality: "many",
        aggregate: { kind: "count" },
        select_ids: ["cnt"],
        on_missing: "null",
    };
    const batch = [{ raw_k: "A" }, { raw_k: "Z" }];
    const valueMap = new Map([["A", { cnt: 3 }]]);
    applyEnrichmentToBatch(batch, binding, valueMap);
    assert.equal(batch[0].cnt, 3);
    assert.equal(batch[1].cnt, 0); // count missing → 0, not null
});
test("coerceFlagValue accepts booleans and select strings, rejects junk", () => {
    assert.equal(coerceFlagValue(true), true);
    assert.equal(coerceFlagValue(false), false);
    assert.equal(coerceFlagValue("true"), true);
    assert.equal(coerceFlagValue("false"), false);
    assert.equal(coerceFlagValue(1), true);
    assert.equal(coerceFlagValue(0), false);
    assert.equal(coerceFlagValue(""), null);
    assert.equal(coerceFlagValue("maybe"), null);
});
test("buildFlagPredicate folds a column into (col op n) / NOT (col op n)", () => {
    assert.equal(buildFlagPredicate("t0.`receipt_count`", "gt", 0, true, "`"), "(t0.`receipt_count` > 0)");
    assert.equal(buildFlagPredicate("t0.`receipt_count`", "gt", 0, false, "`"), "NOT (t0.`receipt_count` > 0)");
    assert.equal(buildFlagPredicate("t0.`status`", "eq", 5, true, "`"), "(t0.`status` = 5)");
});
test("buildFlagPredicate rejects non-column expr, bad operator, non-finite threshold", () => {
    assert.throws(() => buildFlagPredicate("t0.`x` > 0", "gt", 0, true, "`"), /单个列引用/);
    assert.throws(() => buildFlagPredicate("t0.`x`", "'; DROP", 0, true, "`"), /比较符/);
    assert.throws(() => buildFlagPredicate("t0.`x`", "gt", "abc", true, "`"), /阈值/);
});
test("compileSql boolean-flag: 是 -> (col>0), 否 -> NOT(col>0), empty -> no predicate, no bound values", () => {
    const bindings = {
        parameters: [
            {
                id: "flag",
                expression: "t0.`receipt_count`",
                clause: "where",
                operators: ["eq"],
                default_operator: "eq",
                value_adapter: "flag",
                value_type: "boolean",
                flag_operator: "gt",
                flag_threshold: 0,
            },
        ],
    };
    const tmpl = "SELECT 1 FROM t0 WHERE 1=1 /* EASYBI_FILTERS */";
    const yes = compileSql(tmpl, bindings, { flag: { operator: "eq", value: "true" } }, {}, { id: "mysql", quoteChar: "`" });
    assert.match(yes.sql, /AND \(t0\.`receipt_count` > 0\)/);
    assert.equal(yes.values.length, 0);
    const no = compileSql(tmpl, bindings, { flag: { operator: "eq", value: "false" } }, {}, { id: "mysql", quoteChar: "`" });
    assert.match(no.sql, /AND NOT \(t0\.`receipt_count` > 0\)/);
    assert.equal(no.values.length, 0);
    const none = compileSql(tmpl, bindings, {}, {}, { id: "mysql", quoteChar: "`" });
    assert.doesNotMatch(none.sql, /receipt_count/);
});
test("compileSql boolean-flag rejects a non-where clause", () => {
    const bindings = {
        parameters: [
            {
                id: "flag",
                expression: "t0.`c`",
                clause: "having",
                operators: ["eq"],
                default_operator: "eq",
                value_type: "boolean",
                flag_operator: "gt",
                flag_threshold: 0,
            },
        ],
    };
    assert.throws(() => compileSql("SELECT 1 /* EASYBI_FILTERS */", bindings, { flag: { operator: "eq", value: "true" } }, {}, { id: "mysql", quoteChar: "`" }), /where clause/);
});
test("runGroupQueriesMerged: full-outer merge on merge_keys, numeric metrics default 0", async () => {
    // Fake adapter returns a scripted result set per SQL string.
    const results = {
        MAIN: [
            { code: "C1", order_total: 3 },
            { code: "C2", order_total: 5 },
        ],
        PRODUCT: [
            { code: "C1", product_total: 2 },
            // C3 exists only in the sibling → full-outer row; its order_total defaults 0.
            { code: "C3", product_total: 7 },
        ],
    };
    const adapter = {
        async queryAll(sql) {
            return results[sql] ?? [];
        },
    };
    const merged = await runGroupQueriesMerged(adapter, { sql: "MAIN", values: [] }, { mergeKeys: ["code"], compiled: [{ id: "product", sql: "PRODUCT", values: [] }] }, 1000, new Set(["order_total", "product_total"]));
    // Main-query key order first (C1, C2), then sibling-only key (C3).
    assert.deepEqual(merged.map((r) => r.code), ["C1", "C2", "C3"]);
    // C1 has both metrics.
    assert.deepEqual(merged[0], { code: "C1", order_total: 3, product_total: 2 });
    // C2 present only in main → product_total defaults 0.
    assert.deepEqual(merged[1], { code: "C2", order_total: 5, product_total: 0 });
    // C3 present only in sibling → order_total defaults 0.
    assert.deepEqual(merged[2], { code: "C3", order_total: 0, product_total: 7 });
});
test("runGroupQueriesMerged: rejects an unbounded number of merged groups", async () => {
    const adapter = {
        async queryAll() {
            return [{ code: "C1" }, { code: "C2" }, { code: "C3" }];
        },
    };
    await assert.rejects(() => runGroupQueriesMerged(adapter, { sql: "MAIN", values: [] }, { mergeKeys: ["code"], compiled: [] }, 1000, new Set(), 2), (error) => error?.code === "GROUP_QUERY_LIMIT_EXCEEDED");
});
//# sourceMappingURL=runtime-core.test.js.map