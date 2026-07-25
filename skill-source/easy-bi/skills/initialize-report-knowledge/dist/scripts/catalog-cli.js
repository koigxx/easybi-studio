#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, rename, rm, writeFile, } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import AjvModule from "ajv";
import { getDialect, isSupportedEngine, applyStatementTimeout, } from "./dialect.js";
export const VERSION = "0.10.0";
export const TIERS = ["hot", "warm", "cold"];
export const CONNECTORS = {
    mysql: {
        id: "mysql",
        category: "database",
        display_name: "MySQL",
        version: "1",
        status: "available",
        capabilities: [
            "connection_test",
            "server_metadata",
            "multi_database_discovery",
            "schema_discovery",
            "indexed_activity_probe",
            "unindexed_recent_activity_probe",
        ],
    },
};
const DEFAULT_ACTIVITY_COLUMNS = [
    "updated_at",
    "update_time",
    "modified_at",
    "modified_time",
    "gmt_modified",
    "created_at",
    "create_time",
    "created_time",
    "gmt_create",
    "business_date",
    "biz_date",
];
const TECHNICAL_PATTERN = /(^|_)(flyway|liquibase|schema_history|xxl_job|qrtz|quartz|distributed_lock|shedlock|message_retry|retry_message|trace|tmp|temp)(_|$)/i;
const SECRET_KEY_PATTERN = /(^|_)(password|passwd|pwd|secret|token|dsn|connection_string)($|_)/i;
export class CatalogError extends Error {
}
const configSchema = {
    type: "object",
    required: ["connections", "knowledge"],
    properties: {
        connections: {
            type: "object",
            required: ["database_profiles"],
            properties: {
                database_profiles: { type: "array", minItems: 1 },
            },
        },
        knowledge: { type: "object" },
    },
};
const Ajv = AjvModule;
const ajv = new Ajv({ allErrors: true, strict: false });
const validateConfigShape = ajv.compile(configSchema);
export function utcNow() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
export function stableStringify(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(",")}]`;
    const object = value;
    return `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
        .join(",")}}`;
}
export function jsonHash(value) {
    return createHash("sha256").update(stableStringify(value)).digest("hex");
}
export async function loadJson(path) {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object") {
        throw new CatalogError(`Expected a JSON object in ${path}`);
    }
    return value;
}
export async function dumpJson(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, path);
}
async function exists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
async function isNonEmptyDirectory(path) {
    try {
        return (await readdir(path)).length > 0;
    }
    catch {
        return false;
    }
}
function normalizeDate(value) {
    if (value === null || value === undefined || value === "")
        return null;
    if (value instanceof Date)
        return value.toISOString();
    return String(value);
}
function inactiveDays(value) {
    const normalized = normalizeDate(value);
    if (!normalized)
        return null;
    const milliseconds = Date.parse(normalized);
    if (Number.isNaN(milliseconds))
        return null;
    return Math.max(0, Math.floor((Date.now() - milliseconds) / 86_400_000));
}
export function tableId(profileId, database, table) {
    return `${profileId}/${database}/${table}`;
}
function safeName(identifier) {
    const readable = identifier.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(-90) ||
        "table";
    return `${readable}-${createHash("sha1").update(identifier).digest("hex").slice(0, 10)}.json`;
}
/**
 * Resolve the effective connection settings for a database profile by applying the
 * active environment's overrides (host, port, username, password, databases).
 */
function resolveEffectiveProfile(profile) {
    const envName = profile.active_environment;
    if (envName && profile.environments && typeof profile.environments === "object") {
        const env = profile.environments[String(envName)];
        if (env && typeof env === "object" && !Array.isArray(env)) {
            const envRec = env;
            return {
                ...profile,
                password: envRec.password ?? profile.password,
                password_env: envRec.password_env ?? profile.password_env,
                settings: { ...(profile.settings ?? {}), ...(envRec.settings ?? {}) },
            };
        }
    }
    return profile;
}
function requireSecret(source) {
    if (source.password !== undefined && source.password !== null)
        return String(source.password);
    if (!source.password_env) {
        throw new CatalogError(`Database profile ${source.id ?? "<unknown>"} must specify password or password_env`);
    }
    const value = process.env[String(source.password_env)];
    if (value === undefined) {
        throw new CatalogError(`Environment variable ${source.password_env} is not set`);
    }
    return value;
}
export function resolveDatabaseSources(config) {
    const profiles = config.connections?.database_profiles ?? [];
    const selected = new Set(config.knowledge?.database_profile_ids ?? []);
    const sources = profiles
        .filter((profile) => !selected.size || selected.has(profile.id))
        .map((profile) => {
        const effective = resolveEffectiveProfile(profile);
        return {
            ...(effective.settings ?? {}),
            id: effective.id,
            engine: String(effective.connector_id ?? "").toLowerCase(),
            password: effective.password,
            password_env: effective.password_env,
            connect_timeout_seconds: effective.connect_timeout_seconds,
            read_timeout_seconds: effective.read_timeout_seconds,
        };
    });
    const resolvedIds = new Set(sources.map((source) => source.id));
    const missing = [...selected].filter((id) => !resolvedIds.has(id));
    if (missing.length) {
        throw new CatalogError(`Knowledge config references missing database profiles: ${missing}`);
    }
    return sources;
}
function sourceSummary(source, databases, server) {
    return {
        id: source.id,
        connector_id: source.engine,
        engine: source.engine,
        databases: [...new Set(databases)].sort(),
        ...(server ? { server } : {}),
    };
}
/** Open a dialect connection for a resolved source (engine chosen by connector_id). */
async function createConnection(source, database) {
    const dialect = getDialect(String(source.engine));
    return dialect.connect(source, requireSecret(source), database);
}
async function serverMetadata(connection, source) {
    return getDialect(String(source.engine)).serverMetadata(connection);
}
function emptyActivity(reason) {
    return {
        status: "unknown",
        field: null,
        method: null,
        last_data_at: null,
        inactive_days: null,
        confidence: "unverified",
        reason,
    };
}
function normalizeActivity(activityValue) {
    const activity = activityValue ?? emptyActivity("No activity evidence");
    if (!activity.status &&
        activity.method === "indexed_desc_limit_1" &&
        activity.last_data_at) {
        return { ...activity, status: "observed" };
    }
    return activity;
}
function activityCandidates(table, policy) {
    const names = policy.activity_probe?.candidate_columns ?? DEFAULT_ACTIVITY_COLUMNS;
    const ranks = new Map(names.map((name, index) => [String(name).toLowerCase(), index]));
    const firstIndexColumns = new Set((table.indexes ?? [])
        .filter((index) => index.columns?.length)
        .map((index) => index.columns[0]));
    return (table.columns ?? [])
        .map((column) => {
        const name = String(column.name ?? "");
        const lower = name.toLowerCase();
        const type = String(column.data_type ?? "").toLowerCase();
        if (!/(date|time)/.test(type))
            return null;
        const rank = ranks.get(lower) ??
            (/(updated|modified|changed|create|created|date|time)$/.test(lower)
                ? ranks.size + 20
                : null);
        if (rank === null)
            return null;
        return { ...column, indexed_first: firstIndexColumns.has(name), rank };
    })
        .filter(Boolean)
        .sort((a, b) => a.rank - b.rank);
}
export async function probeActivity(connection, table, policy, dialect) {
    const config = policy.activity_probe ?? {};
    if (config.enabled === false)
        return emptyActivity("Activity probing is disabled");
    const candidates = activityCandidates(table, policy).slice(0, 4);
    if (!candidates.length)
        return emptyActivity("No candidate activity time column found");
    const reasons = [];
    const probes = [];
    for (const column of candidates.filter((candidate) => candidate.indexed_first)) {
        const timeoutMs = Number(config.statement_timeout_seconds ?? 8) * 1000;
        const sql = dialect.latestValueSql(table.physical.database, table.physical.table, column.name, timeoutMs);
        try {
            const rows = await connection.query(sql);
            const latest = normalizeDate(rows[0]?.latest_value);
            if (latest) {
                probes.push({
                    status: "observed",
                    field: column.name,
                    method: "indexed_desc_limit_1",
                    last_data_at: latest,
                    inactive_days: inactiveDays(latest),
                    confidence: "high",
                });
            }
        }
        catch (error) {
            reasons.push(`Probe failed for ${column.name}: ${error.name}`);
        }
    }
    if (probes.length) {
        return probes.sort((a, b) => Date.parse(b.last_data_at) - Date.parse(a.last_data_at))[0];
    }
    if (config.require_index !== false) {
        const unindexed = candidates
            .filter((candidate) => !candidate.indexed_first)
            .map((candidate) => candidate.name);
        return emptyActivity([
            ...reasons,
            ...(unindexed.length
                ? [`Skipped unindexed activity columns: ${unindexed.join(", ")}`]
                : []),
        ].join("; ") || "No indexed activity value observed");
    }
    const maxColumns = Math.max(1, Math.min(Number(config.unindexed_max_columns ?? 2), 4));
    const fallbackColumns = candidates.slice(0, maxColumns);
    const lookbackDays = Math.max(1, Number(policy.inactivity_days ?? 90));
    const cutoff = new Date(Date.now() - lookbackDays * 86_400_000)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ");
    const timeoutMs = Number(config.statement_timeout_seconds ?? 8) * 1000;
    const probe = dialect.recentExistsSql(table.physical.database, table.physical.table, fallbackColumns.map((column) => column.name), timeoutMs);
    try {
        const rows = await connection.query(probe.sql, probe.params.map(() => cutoff));
        const hasRecentData = Boolean(Number(rows[0]?.has_recent_data ?? 0));
        return {
            status: "observed",
            field: fallbackColumns[0].name,
            fields: fallbackColumns.map((column) => column.name),
            method: "unindexed_recent_exists",
            lookback_days: lookbackDays,
            cutoff_at: `${cutoff}Z`,
            has_recent_data: hasRecentData,
            last_data_at: null,
            inactive_days: hasRecentData ? 0 : lookbackDays,
            inactive_days_at_least: hasRecentData ? null : lookbackDays,
            confidence: "medium",
            reason: hasRecentData
                ? `Observed data in the last ${lookbackDays} days using an unindexed time-field existence check`
                : `No data observed in the last ${lookbackDays} days using an unindexed time-field existence check`,
        };
    }
    catch (error) {
        return emptyActivity([
            ...reasons,
            `Unindexed recent-data probe failed or timed out for ${fallbackColumns
                .map((column) => column.name)
                .join(", ")}: ${error.name}`,
        ].join("; "));
    }
}
export async function testConnections(config) {
    const profiles = [];
    for (const source of resolveDatabaseSources(config)) {
        if (!isSupportedEngine(String(source.engine))) {
            throw new CatalogError(`Unsupported database connector: ${source.engine}`);
        }
        const dialect = getDialect(String(source.engine));
        const connection = await createConnection(source);
        try {
            const server = await serverMetadata(connection, source);
            const visible = await dialect.listDatabases(connection);
            const selected = (source.databases ?? []).map(String).sort();
            const missing = selected.filter((database) => !visible.includes(database));
            if (missing.length) {
                throw new CatalogError(`Database profile ${source.id} cannot see selected databases: ${missing.join(", ")}`);
            }
            profiles.push({
                profile_id: source.id,
                connector_id: dialect.id,
                ok: true,
                server,
                selected_databases: selected,
                visible_database_count: visible.length,
            });
        }
        finally {
            await connection.close();
        }
    }
    return { ok: true, profiles, tested: profiles.length };
}
export async function discover(config) {
    const sources = resolveDatabaseSources(config);
    if (!sources.length)
        throw new CatalogError("At least one database profile is required");
    const policy = config.knowledge ?? {};
    const results = [];
    for (const source of sources) {
        if (!isSupportedEngine(String(source.engine))) {
            throw new CatalogError(`Unsupported database connector: ${source.engine}`);
        }
        const dialect = getDialect(String(source.engine));
        const databases = (source.databases ?? []).map(String);
        if (!databases.length) {
            throw new CatalogError(`Database profile ${source.id} requires all database names`);
        }
        const connection = await createConnection(source);
        try {
            const server = await serverMetadata(connection, source);
            const rawTables = await dialect.tables(connection, databases);
            const rawColumns = await dialect.columns(connection, databases);
            const rawIndexes = await dialect.indexes(connection, databases);
            const rawFks = await dialect.foreignKeys(connection, databases);
            const columns = new Map();
            for (const row of rawColumns) {
                const key = `${row.database}.${row.table}`;
                const values = columns.get(key) ?? [];
                values.push({
                    name: row.name,
                    ordinal: row.ordinal,
                    data_type: row.data_type,
                    native_type: row.native_type,
                    nullable: row.nullable,
                    default: normalizeDate(row.default),
                    comment: row.comment ?? "",
                    primary_key: row.primary_key,
                    extra: row.extra ?? "",
                });
                columns.set(key, values);
            }
            const indexGroups = new Map();
            for (const row of rawIndexes) {
                const key = `${row.database}.${row.table}.${row.name}`;
                const index = indexGroups.get(key) ?? {
                    database: row.database,
                    table: row.table,
                    name: row.name,
                    unique: row.unique,
                    columns: [],
                };
                index.columns.push(row.column);
                indexGroups.set(key, index);
            }
            const indexes = new Map();
            for (const index of indexGroups.values()) {
                const key = `${index.database}.${index.table}`;
                indexes.set(key, [...(indexes.get(key) ?? []), index]);
            }
            const fkGroups = new Map();
            for (const row of rawFks) {
                const key = `${row.database}.${row.table}.${row.name}`;
                const fk = fkGroups.get(key) ?? {
                    database: row.database,
                    table: row.table,
                    name: row.name,
                    columns: [],
                    target: {
                        database: row.ref_database,
                        table: row.ref_table,
                        columns: [],
                    },
                };
                fk.columns.push(row.column);
                fk.target.columns.push(row.ref_column);
                fkGroups.set(key, fk);
            }
            const fks = new Map();
            for (const fk of fkGroups.values()) {
                const key = `${fk.database}.${fk.table}`;
                fks.set(key, [...(fks.get(key) ?? []), fk]);
            }
            const tables = [];
            for (const row of rawTables) {
                const key = `${row.database}.${row.table}`;
                const table = {
                    table_id: tableId(source.id, row.database, row.table),
                    physical: {
                        profile_id: source.id,
                        database: row.database,
                        table: row.table,
                    },
                    table_type: row.table_type,
                    comment: row.comment ?? "",
                    estimated_rows: row.estimated_rows,
                    database_update_at: normalizeDate(row.update_at),
                    columns: columns.get(key) ?? [],
                    indexes: indexes.get(key) ?? [],
                    foreign_keys: fks.get(key) ?? [],
                };
                table.activity = await probeActivity(connection, table, policy, dialect);
                table.schema_fingerprint = jsonHash({
                    columns: table.columns,
                    indexes: table.indexes,
                    foreign_keys: table.foreign_keys,
                });
                tables.push(table);
            }
            results.push({ source: sourceSummary(source, databases, server), tables });
        }
        finally {
            await connection.close();
        }
    }
    const system = config.system ?? {
        id: "easybi-project",
        name: "Easy BI 项目",
        timezone: "Asia/Shanghai",
        locale: "zh-CN",
    };
    const snapshot = {
        snapshot_version: "2",
        tool_version: VERSION,
        generated_at: utcNow(),
        system,
        policy,
        sources: results.map((result) => result.source),
        tables: results.flatMap((result) => result.tables).sort((a, b) => a.table_id.localeCompare(b.table_id)),
    };
    snapshot.snapshot_hash = jsonHash(snapshot);
    return snapshot;
}
function columnsByName(table) {
    return new Map((table.columns ?? []).map((column) => [column.name, column]));
}
export function diffSnapshots(previous, current) {
    const before = new Map((previous.tables ?? []).map((table) => [table.table_id, table]));
    const after = new Map((current.tables ?? []).map((table) => [table.table_id, table]));
    const addedIds = [...after.keys()].filter((id) => !before.has(id)).sort();
    const removedIds = [...before.keys()].filter((id) => !after.has(id)).sort();
    const changedTables = [];
    let unchanged = 0;
    for (const id of [...after.keys()].filter((value) => before.has(value)).sort()) {
        const previousTable = before.get(id);
        const currentTable = after.get(id);
        if (previousTable.schema_fingerprint === currentTable.schema_fingerprint) {
            unchanged += 1;
            continue;
        }
        const previousColumns = columnsByName(previousTable);
        const currentColumns = columnsByName(currentTable);
        changedTables.push({
            table_id: id,
            previous_fingerprint: previousTable.schema_fingerprint,
            current_fingerprint: currentTable.schema_fingerprint,
            added_columns: [...currentColumns.keys()].filter((name) => !previousColumns.has(name)).sort(),
            removed_columns: [...previousColumns.keys()].filter((name) => !currentColumns.has(name)).sort(),
            changed_columns: [...currentColumns.keys()]
                .filter((name) => previousColumns.has(name) &&
                stableStringify(previousColumns.get(name)) !== stableStringify(currentColumns.get(name)))
                .map((name) => ({
                name,
                before: previousColumns.get(name),
                after: currentColumns.get(name),
            })),
            indexes_changed: stableStringify(previousTable.indexes ?? []) !== stableStringify(currentTable.indexes ?? []),
            foreign_keys_changed: stableStringify(previousTable.foreign_keys ?? []) !==
                stableStringify(currentTable.foreign_keys ?? []),
        });
    }
    return {
        diff_version: "2",
        generated_at: utcNow(),
        previous_snapshot_hash: previous.snapshot_hash,
        current_snapshot_hash: current.snapshot_hash,
        summary: {
            added_tables: addedIds.length,
            removed_tables: removedIds.length,
            changed_tables: changedTables.length,
            unchanged_tables: unchanged,
        },
        added_tables: addedIds.map((id) => ({
            table_id: id,
            physical: after.get(id).physical,
            schema_fingerprint: after.get(id).schema_fingerprint,
        })),
        removed_tables: removedIds.map((id) => ({
            table_id: id,
            physical: before.get(id).physical,
            schema_fingerprint: before.get(id).schema_fingerprint,
        })),
        changed_tables: changedTables,
    };
}
function normalizeSearchText(value) {
    return value.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, "");
}
function semanticMatches(table, hints) {
    const haystack = normalizeSearchText([
        table.physical.table,
        table.comment ?? "",
        ...(table.columns ?? []).flatMap((column) => [
            column.name ?? "",
            column.comment ?? "",
        ]),
    ].join(" "));
    const matches = [];
    for (const phrase of [
        ...(hints.business_semantics ?? []),
        ...(hints.report_scenarios ?? []),
    ]) {
        const text = String(phrase);
        const normalized = normalizeSearchText(text);
        const tokens = text
            .split(/[\s,，、/;；]+/)
            .map(normalizeSearchText)
            .filter((token) => token.length >= 2);
        const tokenHits = tokens.filter((token) => haystack.includes(token));
        if ((normalized.length >= 2 && haystack.includes(normalized)) ||
            (tokens.length >= 2 && tokenHits.length >= 2)) {
            matches.push(text);
        }
    }
    return [...new Set(matches)].sort();
}
function reportRequirementEvidence(table, hints) {
    const columns = table.columns ?? [];
    const tableText = normalizeSearchText([table.physical.table, table.comment ?? ""].join(" "));
    const reports = (hints.report_requirements ?? []).map((report, reportIndex) => {
        const reportName = String(report.name ?? report.report_name ?? `report-${reportIndex + 1}`);
        const normalizedReportName = normalizeSearchText(reportName);
        const reportNameMatch = normalizedReportName.length >= 2 && tableText.includes(normalizedReportName);
        const matchedFields = [];
        for (const requirement of report.required_fields ?? []) {
            const fieldText = typeof requirement === "string"
                ? requirement
                : String(requirement.field ??
                    requirement.physical_field ??
                    requirement.name ??
                    requirement.label ??
                    "");
            if (!fieldText)
                continue;
            const parts = fieldText.split(".").filter(Boolean);
            const normalizedRequirement = normalizeSearchText(parts.at(-1) ?? fieldText);
            if (normalizedRequirement.length < 2)
                continue;
            const qualified = parts.length >= 2;
            const expectedTable = qualified ? parts.at(-2) : null;
            const expectedDatabase = parts.length >= 3 ? parts.at(-3) : null;
            if (expectedTable &&
                normalizeSearchText(expectedTable) !==
                    normalizeSearchText(String(table.physical.table))) {
                continue;
            }
            if (expectedDatabase &&
                normalizeSearchText(expectedDatabase) !==
                    normalizeSearchText(String(table.physical.database))) {
                continue;
            }
            const matchedColumn = columns.find((column) => {
                const physicalName = normalizeSearchText(String(column.name ?? ""));
                const semanticText = normalizeSearchText(`${column.name ?? ""} ${column.comment ?? ""}`);
                return qualified
                    ? physicalName === normalizedRequirement
                    : semanticText.includes(normalizedRequirement);
            });
            if (matchedColumn) {
                matchedFields.push({
                    requirement: fieldText,
                    column: matchedColumn.name,
                    qualified,
                });
            }
        }
        const qualifiedMatches = matchedFields.filter((field) => field.qualified).length;
        const strong = qualifiedMatches > 0 ||
            matchedFields.length >= 2 ||
            (reportNameMatch && matchedFields.length >= 1);
        return {
            id: report.id ?? `report-${reportIndex + 1}`,
            name: reportName,
            report_name_match: reportNameMatch,
            required_field_count: (report.required_fields ?? []).length,
            matched_fields: matchedFields,
            strong,
        };
    });
    return {
        reports: reports.filter((report) => report.report_name_match || report.matched_fields.length),
        strong_reports: reports
            .filter((report) => report.strong)
            .map((report) => report.name),
        matched_field_count: reports.reduce((total, report) => total + report.matched_fields.length, 0),
    };
}
function forcedTableId(value) {
    if (typeof value === "string")
        return value;
    const selector = value;
    if (!selector?.profile_id || !selector?.database || !selector?.table) {
        throw new CatalogError(`Invalid forced_hot_tables selector: ${JSON.stringify(value)}`);
    }
    return tableId(selector.profile_id, selector.database, selector.table);
}
export function propose(snapshot, hintsDocument) {
    const hints = hintsDocument.knowledge ?? hintsDocument;
    const tables = snapshot.tables ?? [];
    const byId = new Map(tables.map((table) => [table.table_id, table]));
    const forced = new Set((hints.forced_hot_tables ?? []).map(forcedTableId));
    const missing = [...forced].filter((id) => !byId.has(id));
    if (missing.length)
        throw new CatalogError(`Forced-hot tables were not discovered: ${missing}`);
    const classification = hints.classification ?? snapshot.policy?.classification ?? {};
    const hotThreshold = Number(classification.hot_threshold ?? 80);
    const coldThreshold = Number(classification.cold_threshold ?? 25);
    if (!(coldThreshold >= 0 && hotThreshold <= 100 && coldThreshold < hotThreshold)) {
        throw new CatalogError("Classification thresholds must satisfy 0 <= cold < hot <= 100");
    }
    const lookback = Number(snapshot.policy?.inactivity_days ?? hints.inactivity_days ?? 90);
    const adjacency = new Map();
    for (const table of tables) {
        for (const fk of table.foreign_keys ?? []) {
            const target = tableId(table.physical.profile_id, fk.target.database ?? table.physical.database, fk.target.table);
            if (!adjacency.has(table.table_id))
                adjacency.set(table.table_id, new Set());
            if (!adjacency.has(target))
                adjacency.set(target, new Set());
            adjacency.get(table.table_id).add(target);
            adjacency.get(target).add(table.table_id);
        }
    }
    const coldPatterns = (hints.confirmed_cold_patterns ?? []).map((pattern) => new RegExp(pattern, "i"));
    const entries = tables.map((table) => {
        const id = table.table_id;
        const activity = normalizeActivity(table.activity);
        const days = activity.inactive_days;
        const inactive = Number.isInteger(days) &&
            days >= lookback &&
            ["high", "medium"].includes(activity.confidence);
        const matches = semanticMatches(table, hints);
        const reportEvidence = reportRequirementEvidence(table, hints);
        const technical = TECHNICAL_PATTERN.test(table.physical.table) ||
            coldPatterns.some((pattern) => pattern.test(table.physical.table));
        const relatedToForced = [...(adjacency.get(id) ?? [])].some((target) => forced.has(target));
        let score = 50;
        const reasons = [];
        const warnings = [];
        if (matches.length) {
            score += 15;
            reasons.push(`Matches business semantics: ${matches.join(", ")}`);
        }
        if (reportEvidence.strong_reports.length) {
            score += 40;
            reasons.push(`Strongly matches required fields for reports: ${reportEvidence.strong_reports.join(", ")}`);
        }
        else if (reportEvidence.matched_field_count > 0) {
            score += 15;
            reasons.push(`Weakly matches ${reportEvidence.matched_field_count} required report field(s); review before promotion`);
        }
        if (activity.status === "observed" && !inactive) {
            score += 10;
            reasons.push("Recent activity observed");
        }
        if (inactive) {
            score -= 30;
            reasons.push(`No observed activity for ${days} days`);
        }
        if (relatedToForced) {
            score += 15;
            reasons.push("Related by foreign key to a forced-hot table");
        }
        if (technical) {
            score -= 50;
            reasons.push("Table name matches a technical-table pattern");
        }
        score = Math.max(0, Math.min(100, score));
        let tier = score >= hotThreshold ? "hot" : score <= coldThreshold ? "cold" : "warm";
        let confidence = "inferred";
        let decisionRule = "score";
        if (forced.has(id)) {
            tier = "hot";
            score = 100;
            confidence = "confirmed";
            decisionRule = "forced_hot";
            reasons.unshift("User selected this table as forced hot");
            if (technical)
                warnings.push("Forced-hot table also matches a technical-table pattern");
        }
        else if (reportEvidence.strong_reports.length) {
            tier = "hot";
            score = Math.max(score, hotThreshold);
            decisionRule = "planned_report_dependency";
            if (technical) {
                warnings.push("Planned-report table also matches a technical-table pattern");
            }
        }
        else if (technical) {
            tier = "cold";
            score = Math.min(score, coldThreshold);
            decisionRule = "technical_table";
        }
        else if (inactive) {
            tier = "cold";
            score = Math.min(score, coldThreshold);
            decisionRule = "inactive";
        }
        if (!reasons.length)
            reasons.push("Business relevance needs review");
        return {
            table_id: id,
            physical: table.physical,
            forced_hot: forced.has(id),
            proposed_tier: tier,
            final_tier: tier,
            lifecycle: "active",
            confidence,
            business_domain: null,
            classification: {
                score,
                hot_threshold: hotThreshold,
                cold_threshold: coldThreshold,
                decision_rule: decisionRule,
                override: null,
            },
            reasons,
            warnings,
            evidence: {
                semantic_matches: matches,
                report_requirements: reportEvidence,
                activity,
                technical_pattern: technical,
                related_to_forced_hot: relatedToForced,
            },
        };
    });
    const counts = Object.fromEntries(TIERS.map((tier) => [
        tier,
        entries.filter((entry) => entry.proposed_tier === tier).length,
    ]));
    const plan = {
        plan_version: "2",
        generated_at: utcNow(),
        system: snapshot.system ?? {},
        snapshot_hash: snapshot.snapshot_hash ?? jsonHash(snapshot),
        status: "proposed",
        approval: {
            status: "pending",
            approved_by: null,
            approved_at: null,
            decision: null,
        },
        policy: {
            inactivity_days: lookback,
            classification: {
                hot_threshold: hotThreshold,
                cold_threshold: coldThreshold,
            },
        },
        business_context: {
            business_semantics: hints.business_semantics ?? [],
            report_scenarios: hints.report_scenarios ?? [],
            report_requirements: hints.report_requirements ?? [],
            semantic_defaults: hints.semantic_defaults ?? DEFAULT_SEMANTIC_DEFAULTS,
        },
        summary: { total: entries.length, ...counts },
        entries: entries.sort((a, b) => TIERS.indexOf(a.proposed_tier) - TIERS.indexOf(b.proposed_tier) ||
            a.table_id.localeCompare(b.table_id)),
    };
    plan.plan_hash = jsonHash(plan);
    return plan;
}
export async function approveCatalogPlan(planPathValue, approvedBy, decision) {
    const planPath = resolve(planPathValue);
    const plan = await loadJson(planPath);
    if (plan.plan_version !== "2") {
        throw new CatalogError(`Unsupported catalog plan version: ${plan.plan_version ?? "missing"}`);
    }
    if (!approvedBy.trim())
        throw new CatalogError("approved-by must not be empty");
    if (!decision.trim())
        throw new CatalogError("decision must not be empty");
    const entries = Array.isArray(plan.entries) ? plan.entries : [];
    if (!entries.length)
        throw new CatalogError("Catalog plan has no table entries");
    const ids = entries.map((entry) => String(entry.table_id ?? ""));
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
        throw new CatalogError("Catalog plan contains missing or duplicate table_id");
    }
    for (const entry of entries) {
        if (!TIERS.includes(entry.final_tier)) {
            throw new CatalogError(`Invalid final tier for ${entry.table_id}`);
        }
        if (entry.forced_hot && entry.final_tier !== "hot") {
            throw new CatalogError(`Forced-hot table cannot leave hot tier: ${entry.table_id}`);
        }
    }
    if (plan.approval?.status === "approved" &&
        (plan.approval.approved_by !== approvedBy ||
            plan.approval.decision !== decision)) {
        throw new CatalogError("Plan is already approved with a different decision");
    }
    plan.status = "approved";
    plan.approval = {
        status: "approved",
        approved_by: approvedBy,
        approved_at: utcNow(),
        decision,
    };
    const hashInput = structuredClone(plan);
    delete hashInput.plan_hash;
    plan.plan_hash = jsonHash(hashInput);
    await dumpJson(planPath, plan);
    return {
        ok: true,
        plan: planPath,
        status: plan.status,
        approval: plan.approval,
        plan_hash: plan.plan_hash,
    };
}
const DEFAULT_SEMANTIC_DEFAULTS = {
    interaction_mode: "minimal",
    filters: {
        report_fields_enabled: true,
        identifier_operator: "eq",
        string_operator: "contains",
        number_operator: "between",
        date_operator: "between",
        enum_operator: "in",
        boolean_operator: "eq",
        large_text_enabled: false,
    },
};
function requirementText(requirement) {
    if (typeof requirement === "string")
        return requirement;
    const value = requirement;
    return String(value?.field ?? value?.physical_field ?? value?.name ?? value?.label ?? "");
}
function requirementLabel(requirement) {
    if (typeof requirement === "string")
        return requirement.includes(".") ? null : requirement;
    const value = requirement;
    return value?.label ? String(value.label) : null;
}
function matchingColumn(table, requirement) {
    const text = requirementText(requirement);
    if (!text)
        return null;
    const parts = text.split(".").filter(Boolean);
    const expectedTable = parts.length >= 2 ? parts.at(-2) : null;
    const expectedDatabase = parts.length >= 3 ? parts.at(-3) : null;
    if (expectedTable &&
        normalizeSearchText(expectedTable) !== normalizeSearchText(String(table.physical.table))) {
        return null;
    }
    if (expectedDatabase &&
        normalizeSearchText(expectedDatabase) !==
            normalizeSearchText(String(table.physical.database))) {
        return null;
    }
    const wanted = normalizeSearchText(parts.at(-1) ?? text);
    const candidates = (table.columns ?? []).filter((column) => {
        const name = normalizeSearchText(String(column.name ?? ""));
        if (parts.length >= 2)
            return name === wanted;
        const semantic = normalizeSearchText(`${column.name ?? ""} ${column.comment ?? ""}`);
        return name === wanted || semantic.includes(wanted);
    });
    return candidates.length === 1 ? candidates[0] : null;
}
function reportFieldMappings(table, reports) {
    const mappings = new Map();
    for (const [reportIndex, report] of reports.entries()) {
        for (const requirement of report.required_fields ?? []) {
            const column = matchingColumn(table, requirement);
            if (!column)
                continue;
            const existing = mappings.get(column.name) ?? {
                labels: [],
                reports: [],
                filter_overrides: [],
            };
            const label = requirementLabel(requirement);
            if (label)
                existing.labels.push(label);
            existing.reports.push({
                id: report.id ?? `report-${reportIndex + 1}`,
                name: report.name ?? `report-${reportIndex + 1}`,
                requirement: requirementText(requirement),
            });
            if (typeof requirement === "object" && requirement?.filter) {
                existing.filter_overrides.push(requirement.filter);
            }
            mappings.set(column.name, existing);
        }
    }
    return mappings;
}
function enumField(column) {
    const name = String(column.name ?? "");
    const comment = String(column.comment ?? "");
    const nativeType = String(column.native_type ?? "");
    if (/^(enum|set)\(/i.test(nativeType))
        return true;
    if (/(^|_)(status|type|flag|category|level|mode|source)($|_)/i.test(name))
        return true;
    const commentTitle = comment.split(/[：:,，;；]/, 1)[0].trim();
    if (/(状态|类型|类别|标志|级别|模式|来源)(?:编码|代码|值)?$/.test(commentTitle)) {
        return true;
    }
    return /(状态|类型|类别|标志|级别|模式|来源).*(枚举|字典)|(?:枚举|字典).*(状态|类型|类别|标志|级别|模式|来源)/.test(comment);
}
function logicalDeleteFixedValue(column) {
    const name = String(column.name ?? "").toLowerCase();
    if (!/^(is_delete|is_deleted|deleted|delete_flag|deleted_flag|del_flag|is_del)$/.test(name)) {
        return null;
    }
    const comment = String(column.comment ?? "").replace(/\s+/g, "");
    const dataType = String(column.data_type ?? "").toLowerCase();
    const defaultValue = column.default;
    const hasBinaryEvidence = /(?:tinyint|smallint|mediumint|int|bigint|bit|bool|boolean)/.test(dataType) ||
        defaultValue === 0 ||
        defaultValue === "0" ||
        defaultValue === 1 ||
        defaultValue === "1" ||
        /[01](?:正常|未删除|有效|否|删除|已删除)/.test(comment);
    if (!hasBinaryEvidence)
        return null;
    if (/(?:^|[，,：:;；])1(?:正常|未删除|有效|否)(?:$|[，,：:;；])/.test(comment)) {
        return 1;
    }
    if (/(?:^|[，,：:;；])0(?:正常|未删除|有效|否)(?:$|[，,：:;；])/.test(comment)) {
        return 0;
    }
    if (defaultValue === 0 || defaultValue === "0")
        return 0;
    if (defaultValue === 1 || defaultValue === "1")
        return 1;
    return 0;
}
function inferFilter(column, override, semanticDefaults = DEFAULT_SEMANTIC_DEFAULTS) {
    const name = String(column.name ?? "").toLowerCase();
    const dataType = String(column.data_type ?? "").toLowerCase();
    const nativeType = String(column.native_type ?? "").toLowerCase();
    const defaults = {
        ...DEFAULT_SEMANTIC_DEFAULTS.filters,
        ...(semanticDefaults.filters ?? {}),
    };
    let inferred;
    const logicalDeleteValue = logicalDeleteFixedValue(column);
    if (logicalDeleteValue !== null) {
        inferred = {
            enabled: true,
            role: "system_condition",
            default_operator: "eq",
            operators: ["eq"],
            input_type: "hidden",
            visibility: "system",
            required: true,
            fixed_value: logicalDeleteValue,
        };
    }
    else if (/^(tenant_id|tenant_code)$/.test(name)) {
        inferred = {
            enabled: true,
            role: "tenant_scope",
            default_operator: "eq",
            operators: ["eq"],
            input_type: "hidden",
            visibility: "system",
            required: false,
            accepted_by_api: true,
            parameter_source: "request_context",
            request_key: name,
            apply_when_present: true,
        };
    }
    else if (/^(user_id|user_code|create_by|update_by)$/.test(name)) {
        inferred = {
            enabled: true,
            role: "user_scope",
            default_operator: "eq",
            operators: ["eq", "in"],
            input_type: "text",
            visibility: "user",
            required: false,
        };
    }
    else if (/^(dept_id|org_id|corp_id|belong_corp_id)$/.test(name)) {
        inferred = {
            enabled: true,
            role: "organization_scope",
            default_operator: "eq",
            operators: ["eq", "in"],
            input_type: "text",
            visibility: "user",
            required: false,
        };
    }
    else if (enumField(column)) {
        inferred = {
            enabled: true,
            role: "enum",
            default_operator: defaults.enum_operator,
            operators: ["eq", "in"],
            input_type: "select",
            visibility: "user",
            required: false,
        };
    }
    else if (column.primary_key ||
        /(^id$|_id$|^code$|_code$|^no$|_no$|_number$)/.test(name)) {
        inferred = {
            enabled: true,
            role: "business_identifier",
            default_operator: defaults.identifier_operator,
            operators: ["eq", "in"],
            input_type: "text",
            visibility: "user",
            required: false,
        };
    }
    else if (/(date|time|timestamp|year)/.test(dataType) ||
        /(^|_)(date|time|day|month|year)($|_)/.test(name)) {
        inferred = {
            enabled: true,
            role: "time",
            default_operator: defaults.date_operator,
            operators: ["between", "gte", "lte"],
            input_type: dataType === "date" ? "date_range" : "datetime_range",
            visibility: "user",
            required: false,
        };
    }
    else if (dataType === "tinyint" && /\(1\)/.test(nativeType)) {
        inferred = {
            enabled: true,
            role: "boolean",
            default_operator: defaults.boolean_operator,
            operators: ["eq"],
            input_type: "boolean",
            visibility: "user",
            required: false,
        };
    }
    else if (/int|decimal|numeric|float|double|real/.test(dataType)) {
        inferred = {
            enabled: true,
            role: "number",
            default_operator: defaults.number_operator,
            operators: ["eq", "between", "gte", "lte"],
            input_type: "number_range",
            visibility: "user",
            required: false,
        };
    }
    else if (/char|varchar/.test(dataType) ||
        (/text/.test(dataType) && defaults.large_text_enabled)) {
        inferred = {
            enabled: true,
            role: "text",
            default_operator: defaults.string_operator,
            operators: ["contains", "eq"],
            input_type: "text",
            visibility: "user",
            required: false,
        };
    }
    else {
        inferred = {
            enabled: false,
            role: /json|blob|binary|text/.test(dataType) ? "large_or_structured" : "unsupported",
            default_operator: null,
            operators: [],
            input_type: null,
            visibility: "user",
            required: false,
        };
    }
    const explicit = inferred.role === "system_condition" ? {} : (override ?? {});
    const defaultOperator = explicit.operator ?? explicit.default_operator;
    const result = {
        ...inferred,
        ...explicit,
        ...(defaultOperator ? { default_operator: defaultOperator } : {}),
        source: Object.keys(explicit).length ? "report_requirement" : "default_policy",
        status: "inferred",
    };
    if (result.default_operator &&
        !result.operators.includes(result.default_operator)) {
        result.operators = [result.default_operator, ...result.operators];
    }
    return result;
}
function semanticField(column, mapping, semanticDefaults = DEFAULT_SEMANTIC_DEFAULTS) {
    const comment = String(column.comment ?? "").trim();
    const label = mapping?.labels?.[0] ?? null;
    const filterOverride = mapping?.filter_overrides?.at(-1);
    const filter = inferFilter(column, filterOverride, semanticDefaults);
    return {
        physical: column,
        semantic: {
            id: null,
            name: label || comment || null,
            description: null,
            status: label || comment ? "inferred" : "unverified",
            report_exposed: semanticDefaults.filters?.report_fields_enabled !== false &&
                Boolean(mapping?.reports?.length),
            report_ids: (mapping?.reports ?? []).map((report) => report.id),
            filter_candidate: filter.enabled && filter.role !== "system_condition",
            data_category: null,
            unit: null,
            enum_ref: null,
        },
        filter,
    };
}
function tableArtifact(table, entry, tier, reports = [], semanticDefaults = DEFAULT_SEMANTIC_DEFAULTS) {
    const mappings = reportFieldMappings(table, reports);
    const fields = (table.columns ?? []).map((column) => semanticField(column, mappings.get(column.name), semanticDefaults));
    const tenantFields = fields
        .filter((field) => field.filter.role === "tenant_scope")
        .map((field) => field.physical.name);
    const organizationFields = fields
        .filter((field) => field.filter.role === "organization_scope")
        .map((field) => field.physical.name);
    const userFields = fields
        .filter((field) => field.filter.role === "user_scope")
        .map((field) => field.physical.name);
    const systemConditions = fields
        .filter((field) => field.filter.role === "system_condition")
        .map((field) => ({
        field: field.physical.name,
        operator: field.filter.default_operator,
        value: field.filter.fixed_value,
        source: field.filter.source,
        status: field.filter.status,
    }));
    const reportLineage = [...mappings.values()].flatMap((mapping) => mapping.reports ?? []);
    const businessName = String(table.comment ?? "").trim() || String(table.physical.table);
    return {
        table_id: table.table_id,
        tier,
        lifecycle: entry.lifecycle ?? "unknown",
        confidence: entry.confidence ?? "unverified",
        classification: entry.classification ?? {},
        physical: table.physical,
        table_type: table.table_type,
        comment: table.comment ?? "",
        estimated_rows: table.estimated_rows,
        activity: normalizeActivity(table.activity),
        schema_fingerprint: table.schema_fingerprint,
        business: {
            entity_id: normalizeSearchText(businessName) || null,
            name: businessName,
            description: null,
            domain: entry.business_domain,
            status: table.comment ? "inferred" : "unverified",
            source: table.comment ? "table_comment" : "table_name",
        },
        physical_fields: fields,
        system_conditions: systemConditions,
        security: {
            scope_status: tenantFields.length || organizationFields.length || userFields.length
                ? "inferred"
                : "not_applicable",
            tenant_field: tenantFields[0] ?? null,
            tenant_fields: tenantFields,
            organization_field: organizationFields[0] ?? null,
            organization_fields: organizationFields,
            user_fields: userFields,
            source: "default_policy",
        },
        evidence: {
            classification_reasons: entry.reasons ?? [],
            classification_warnings: entry.warnings ?? [],
        },
        unresolved_questions: [],
        ...(tier === "hot"
            ? { enums: [], json_virtual_fields: [], metrics: [], report_lineage: reportLineage }
            : {}),
    };
}
function buildBlockingIssues(snapshot, plan) {
    const entries = new Map((plan.entries ?? []).map((entry) => [entry.table_id, entry]));
    const issues = [];
    for (const [reportIndex, report] of (plan.business_context?.report_requirements ?? []).entries()) {
        for (const [fieldIndex, requirement] of (report.required_fields ?? []).entries()) {
            const matches = (snapshot.tables ?? [])
                .map((table) => ({
                table,
                column: matchingColumn(table, requirement),
            }))
                .filter((match) => match.column);
            const text = requirementText(requirement);
            const fullyQualified = text.split(".").filter(Boolean).length >= 3;
            if (!matches.length) {
                issues.push({
                    id: `missing-report-field-${reportIndex + 1}-${fieldIndex + 1}`,
                    type: "missing_report_field",
                    priority: "blocking",
                    report_id: report.id ?? `report-${reportIndex + 1}`,
                    report_name: report.name ?? `report-${reportIndex + 1}`,
                    requirement: text,
                    status: "pending",
                });
            }
            else if (!fullyQualified && matches.length > 1) {
                issues.push({
                    id: `ambiguous-report-field-${reportIndex + 1}-${fieldIndex + 1}`,
                    type: "ambiguous_report_field",
                    priority: "blocking",
                    report_id: report.id ?? `report-${reportIndex + 1}`,
                    report_name: report.name ?? `report-${reportIndex + 1}`,
                    requirement: text,
                    candidates: matches.map((match) => ({
                        table_id: match.table.table_id,
                        field: match.column.name,
                    })),
                    status: "pending",
                });
            }
            else if (matches.every((match) => entries.get(match.table.table_id)?.final_tier !== "hot")) {
                issues.push({
                    id: `report-field-not-hot-${reportIndex + 1}-${fieldIndex + 1}`,
                    type: "report_field_not_hot",
                    priority: "blocking",
                    report_id: report.id ?? `report-${reportIndex + 1}`,
                    report_name: report.name ?? `report-${reportIndex + 1}`,
                    requirement: text,
                    candidates: matches.map((match) => match.table.table_id),
                    status: "pending",
                });
            }
        }
    }
    return issues;
}
function coldCard(table, entry) {
    return {
        table_id: table.table_id,
        tier: "cold",
        lifecycle: entry.lifecycle ?? "unknown",
        confidence: entry.confidence ?? "unverified",
        classification: entry.classification ?? {},
        physical: table.physical,
        table_type: table.table_type,
        comment: table.comment ?? "",
        estimated_rows: table.estimated_rows,
        activity: normalizeActivity(table.activity),
        category: entry.business_domain,
        reasons: entry.reasons ?? [],
        warnings: entry.warnings ?? [],
        schema_fingerprint: table.schema_fingerprint,
        inspect_ref: table.physical,
    };
}
function relationshipArtifacts(tables) {
    const known = new Set(tables.map((table) => table.table_id));
    return tables
        .flatMap((table) => (table.foreign_keys ?? []).map((fk) => {
        const targetId = tableId(table.physical.profile_id, fk.target.database ?? table.physical.database, fk.target.table);
        return {
            id: `${table.table_id}::${fk.name}`,
            source_table_id: table.table_id,
            source_columns: fk.columns ?? [],
            target_table_id: targetId,
            target_columns: fk.target.columns ?? [],
            cardinality: "many_to_one",
            evidence: "database_foreign_key",
            confidence: "confirmed",
            execution_mode: known.has(targetId) ? "server_side" : "unknown",
        };
    }))
        .sort((a, b) => a.id.localeCompare(b.id));
}
function tableEntityAliases(nameValue) {
    const aliases = new Set();
    let current = String(nameValue ?? "").toLowerCase();
    const prefixes = ["base_primary_", "base_", "biz_", "tbl_", "t_"];
    while (current) {
        aliases.add(current);
        const prefix = prefixes.find((value) => current.startsWith(value));
        if (!prefix)
            break;
        current = current.slice(prefix.length);
    }
    return aliases;
}
function relationshipTypeFamily(column) {
    const type = String(column.data_type ?? "").toLowerCase();
    if (/tinyint|smallint|mediumint|int|bigint|bit/.test(type))
        return "integer";
    if (/decimal|numeric|float|double|real/.test(type))
        return "number";
    if (/char|varchar|text/.test(type))
        return "text";
    return type;
}
function relationshipCandidateArtifacts(tables, allowedTableIds) {
    const eligible = tables.filter((table) => allowedTableIds.has(table.table_id));
    const ignoredEntities = new Set([
        "tenant",
        "user",
        "create_user",
        "update_user",
        "creator",
        "updater",
        "dept",
        "org",
        "corp",
        "belong_corp",
    ]);
    const candidates = [];
    for (const source of eligible) {
        for (const sourceColumn of source.columns ?? []) {
            const match = String(sourceColumn.name ?? "").toLowerCase().match(/^(.+)_id$/);
            if (!match || sourceColumn.primary_key)
                continue;
            const entity = match[1];
            if (ignoredEntities.has(entity))
                continue;
            const targets = eligible.filter((target) => {
                if (target.table_id === source.table_id)
                    return false;
                if (target.physical.profile_id !== source.physical.profile_id ||
                    target.physical.database !== source.physical.database) {
                    return false;
                }
                if (!tableEntityAliases(target.physical.table).has(entity))
                    return false;
                const targetColumn = (target.columns ?? []).find((column) => column.name === "id" && column.primary_key);
                return (targetColumn &&
                    relationshipTypeFamily(targetColumn) === relationshipTypeFamily(sourceColumn));
            });
            if (targets.length !== 1)
                continue;
            const target = targets[0];
            candidates.push({
                id: `${source.table_id}::candidate::${sourceColumn.name}::${target.table_id}`,
                source_table_id: source.table_id,
                source_columns: [sourceColumn.name],
                target_table_id: target.table_id,
                target_columns: ["id"],
                cardinality: "many_to_one",
                evidence: "naming_convention_unique_target",
                evidence_details: {
                    source_field_suffix: "_id",
                    matched_entity: entity,
                    target_aliases: [...tableEntityAliases(target.physical.table)].sort(),
                },
                confidence: "inferred",
                status: "unverified",
                execution_mode: "server_side",
            });
        }
    }
    return candidates.sort((a, b) => a.id.localeCompare(b.id));
}
async function collectTableArtifacts(root) {
    const databaseRoot = join(root, "databases");
    const result = [];
    if (!(await exists(databaseRoot)))
        return result;
    for (const profile of await readdir(databaseRoot)) {
        for (const database of await readdir(join(databaseRoot, profile))) {
            const base = join(databaseRoot, profile, database);
            for (const tier of ["hot", "warm"]) {
                const directory = join(base, tier, "tables");
                if (!(await exists(directory)))
                    continue;
                for (const file of await readdir(directory)) {
                    if (file.endsWith(".json")) {
                        const path = join(directory, file);
                        result.push({ tier, path, document: await loadJson(path) });
                    }
                }
            }
            // Cold tables — both aggregated tables.json (legacy) and individual files (current).
            const coldPath = join(base, "cold", "tables.json");
            if (await exists(coldPath)) {
                const cold = await loadJson(coldPath);
                for (const document of cold.tables ?? [])
                    result.push({ tier: "cold", path: null, document });
            }
            const coldDir = join(base, "cold", "tables");
            if (await exists(coldDir)) {
                for (const file of await readdir(coldDir)) {
                    if (file.endsWith(".json")) {
                        const path = join(coldDir, file);
                        result.push({ tier: "cold", path, document: await loadJson(path) });
                    }
                }
            }
        }
    }
    return result;
}
async function generateIndexes(root) {
    const documents = await collectTableArtifacts(root);
    const byTier = Object.fromEntries(TIERS.map((tier) => [
        tier,
        documents
            .filter((item) => item.tier === tier)
            .map((item) => item.document.table_id)
            .sort(),
    ]));
    const byField = [];
    for (const item of documents.filter((entry) => entry.tier !== "cold")) {
        for (const field of item.document.physical_fields ?? []) {
            byField.push({
                table_id: item.document.table_id,
                field: field.physical?.name,
                semantic_name: field.semantic?.name,
                tier: item.tier,
            });
        }
    }
    await dumpJson(join(root, "indexes", "by-tier.json"), byTier);
    await dumpJson(join(root, "indexes", "by-field.json"), { fields: byField.sort((a, b) => `${a.table_id}/${a.field}`.localeCompare(`${b.table_id}/${b.field}`)) });
    await dumpJson(join(root, "indexes", "by-domain.json"), { domains: [] });
}
export async function buildCatalog(snapshot, plan, output) {
    if (plan.approval?.status !== "approved") {
        throw new CatalogError("Catalog plan is not approved");
    }
    const actualHash = snapshot.snapshot_hash ?? jsonHash(snapshot);
    if (plan.snapshot_hash !== actualHash) {
        throw new CatalogError("Plan and discovery snapshot hashes do not match");
    }
    if (await isNonEmptyDirectory(output)) {
        throw new CatalogError(`Catalog output directory is not empty: ${output}`);
    }
    const byId = new Map((snapshot.tables ?? []).map((table) => [table.table_id, table]));
    const entries = plan.entries ?? [];
    if (new Set(entries.map((entry) => entry.table_id)).size !== entries.length ||
        entries.length !== byId.size) {
        throw new CatalogError("Approved plan must contain every discovered table exactly once");
    }
    const counts = { hot: 0, warm: 0, cold: 0 };
    const coldByDatabase = new Map();
    const reports = plan.business_context?.report_requirements ?? [];
    const blockingIssues = buildBlockingIssues(snapshot, plan);
    const inferenceCounts = {
        report_exposed_fields: 0,
        filter_roles: {},
    };
    for (const entry of entries) {
        const tier = entry.final_tier;
        if (!TIERS.includes(tier))
            throw new CatalogError(`Invalid tier: ${tier}`);
        if (entry.forced_hot && tier !== "hot") {
            throw new CatalogError(`Forced-hot table cannot be placed in ${tier}: ${entry.table_id}`);
        }
        const table = byId.get(entry.table_id);
        if (!table)
            throw new CatalogError(`Plan references missing table: ${entry.table_id}`);
        counts[tier] += 1;
        const base = join(output, "databases", table.physical.profile_id, table.physical.database);
        await dumpJson(join(base, "database.json"), {
            profile_id: table.physical.profile_id,
            database: table.physical.database,
        });
        if (tier === "cold") {
            const key = `${table.physical.profile_id}/${table.physical.database}`;
            coldByDatabase.set(key, [...(coldByDatabase.get(key) ?? []), coldCard(table, entry)]);
        }
        else {
            const artifact = tableArtifact(table, entry, tier, reports, plan.business_context?.semantic_defaults ?? DEFAULT_SEMANTIC_DEFAULTS);
            for (const field of artifact.physical_fields ?? []) {
                if (field.semantic?.report_exposed)
                    inferenceCounts.report_exposed_fields += 1;
                const role = String(field.filter?.role ?? "unknown");
                inferenceCounts.filter_roles[role] =
                    Number(inferenceCounts.filter_roles[role] ?? 0) + 1;
            }
            await dumpJson(join(base, tier, "tables", safeName(table.table_id)), artifact);
        }
    }
    for (const [key, cards] of coldByDatabase) {
        const [profile, database] = key.split("/");
        await dumpJson(join(output, "databases", profile, database, "cold", "tables.json"), { tables: cards.sort((a, b) => a.table_id.localeCompare(b.table_id)) });
    }
    const relationships = relationshipArtifacts(snapshot.tables ?? []);
    const allowedRelationshipTables = new Set(entries
        .filter((entry) => entry.final_tier !== "cold")
        .map((entry) => String(entry.table_id)));
    const relationshipCandidates = relationshipCandidateArtifacts(snapshot.tables ?? [], allowedRelationshipTables);
    for (const source of snapshot.sources ?? []) {
        for (const database of source.databases ?? []) {
            const prefix = `${source.id}/${database}/`;
            await dumpJson(join(output, "databases", source.id, database, "relationships.json"), {
                relationships: relationships.filter((relationship) => relationship.source_table_id.startsWith(prefix) &&
                    relationship.target_table_id.startsWith(prefix)),
                candidates: relationshipCandidates.filter((relationship) => relationship.source_table_id.startsWith(prefix) &&
                    relationship.target_table_id.startsWith(prefix)),
            });
            const coldPath = join(output, "databases", source.id, database, "cold", "tables.json");
            if (!(await exists(coldPath)))
                await dumpJson(coldPath, { tables: [] });
        }
    }
    await dumpJson(join(output, "global", "cross-database-relationships.json"), {
        relationships: relationships.filter((relationship) => {
            const sourceParts = relationship.source_table_id.split("/");
            const targetParts = relationship.target_table_id.split("/");
            return sourceParts[0] !== targetParts[0] || sourceParts[1] !== targetParts[1];
        }),
        candidates: relationshipCandidates.filter((relationship) => {
            const sourceParts = relationship.source_table_id.split("/");
            const targetParts = relationship.target_table_id.split("/");
            return sourceParts[0] !== targetParts[0] || sourceParts[1] !== targetParts[1];
        }),
    });
    await dumpJson(join(output, "global", "glossary.json"), {
        terms: (plan.business_context?.business_semantics ?? []).map((name) => ({
            id: normalizeSearchText(name),
            name,
            definition: null,
            synonyms: [],
            status: "unverified",
        })),
    });
    await dumpJson(join(output, "global", "enums.json"), {
        schema_version: "2",
        dictionaries: [],
        bindings: [],
    });
    await dumpJson(join(output, "global", "metrics.json"), { metrics: [] });
    await dumpJson(join(output, "global", "security.json"), {
        status: "inferred",
        tenant_policy: "tenant fields are hidden optional request-context parameters accepted by the task API",
        organization_policy: "organization and user fields are exact filter candidates",
        logical_delete_policy: "logical-delete fields are mandatory hidden system conditions",
        source: "default_policy",
    });
    await dumpJson(join(output, "reviews", "inference-summary.json"), {
        status: "generated",
        generated_at: utcNow(),
        interaction_mode: plan.business_context?.semantic_defaults?.interaction_mode ?? "minimal",
        tables: counts,
        report_requirements: reports.map((report) => ({
            id: report.id ?? null,
            name: report.name ?? null,
            required_field_count: (report.required_fields ?? []).length,
        })),
        field_inference: inferenceCounts,
        relationship_inference: {
            confirmed: relationships.length,
            candidates: relationshipCandidates.length,
        },
        blocking_issue_count: blockingIssues.length,
        deferred_reviews: [
            "enum_mappings",
            "unused_json_and_ext_fields",
            ...(relationshipCandidates.length ? ["relationship_candidates"] : []),
        ],
    });
    await dumpJson(join(output, "reviews", "blocking-issues.json"), {
        status: blockingIssues.length ? "blocked" : "clear",
        issues: blockingIssues,
    });
    await dumpJson(join(output, "reviews", "semantic-review.json"), {
        status: blockingIssues.length ? "blocked" : "ready_for_batch_approval",
        reviewed_by: null,
        reviewed_at: null,
        decision: null,
        unresolved_questions: blockingIssues,
    });
    await dumpJson(join(output, "reviews", "enum-review.json"), {
        status: "not_started",
        last_exported_at: null,
        last_imported_at: null,
    });
    const manifest = {
        catalog_format_version: "3",
        catalog_version: "0.1.0-draft",
        catalog_status: "draft",
        source_kind: "editable_draft",
        generated_at: utcNow(),
        system: snapshot.system ?? {},
        sources: snapshot.sources ?? [],
        snapshot_hash: actualHash,
        plan_hash: jsonHash(plan),
        counts: { total: entries.length, ...counts },
    };
    await dumpJson(join(output, "manifest.json"), manifest);
    await generateIndexes(output);
    return manifest;
}
function secretPaths(value, path = "$") {
    if (Array.isArray(value)) {
        return value.flatMap((child, index) => secretPaths(child, `${path}[${index}]`));
    }
    if (!value || typeof value !== "object")
        return [];
    return Object.entries(value).flatMap(([key, child]) => {
        const childPath = `${path}.${key}`;
        return [
            ...(SECRET_KEY_PATTERN.test(key) ? [childPath] : []),
            ...secretPaths(child, childPath),
        ];
    });
}
export async function validateCatalog(root, publishReady = false) {
    const errors = [];
    const warnings = [];
    for (const path of [
        "manifest.json",
        "global/cross-database-relationships.json",
        "global/glossary.json",
        "global/enums.json",
        "global/metrics.json",
        "global/security.json",
        "reviews/inference-summary.json",
        "reviews/blocking-issues.json",
        "reviews/semantic-review.json",
        "reviews/enum-review.json",
        "indexes/by-tier.json",
        "indexes/by-field.json",
    ]) {
        if (!(await exists(join(root, path))))
            errors.push(`Missing required file: ${path}`);
    }
    if (errors.length)
        return { ok: false, errors, warnings };
    const manifest = await loadJson(join(root, "manifest.json"));
    const documents = await collectTableArtifacts(root);
    const ids = documents.map((item) => item.document.table_id);
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
        errors.push("Table IDs are missing or duplicated");
    }
    const counts = Object.fromEntries(TIERS.map((tier) => [tier, documents.filter((item) => item.tier === tier).length]));
    for (const tier of TIERS) {
        if (counts[tier] !== Number(manifest.counts?.[tier] ?? -1)) {
            errors.push(`Manifest ${tier} count does not match files`);
        }
    }
    for (const item of documents) {
        const document = item.document;
        if (document.tier !== item.tier)
            errors.push(`Tier mismatch for ${document.table_id}`);
        const secrets = secretPaths(document);
        if (secrets.length)
            errors.push(`Secret-like keys found in ${document.table_id}: ${secrets}`);
        if (item.tier === "cold") {
            const forbidden = ["columns", "fields", "physical_fields", "samples", "values"].filter((key) => key in document);
            if (forbidden.length) {
                errors.push(`Cold table contains field detail ${forbidden}: ${document.table_id}`);
            }
        }
        else if (!document.physical_fields?.length) {
            warnings.push(`${item.tier} table has no fields: ${document.table_id}`);
        }
        if (publishReady && item.tier === "hot") {
            if (!document.business?.name ||
                !["inferred", "confirmed"].includes(document.business?.status)) {
                errors.push(`Hot table business semantics are not usable: ${document.table_id}`);
            }
            if (!["inferred", "confirmed", "not_applicable"].includes(document.security?.scope_status)) {
                errors.push(`Hot table security scope is not usable: ${document.table_id}`);
            }
            const exposed = (document.physical_fields ?? []).filter((field) => field.semantic?.report_exposed);
            if ((document.report_lineage ?? []).length && !exposed.length) {
                errors.push(`Report-dependent hot table has no report-exposed field: ${document.table_id}`);
            }
        }
    }
    if (publishReady) {
        // The explicit semantic-review approval gate was removed: human inspection of
        // the generated catalog followed by clicking Publish IS the review. Publish
        // readiness now enforces only data quality (hot-table semantics/security scope
        // above) and structural integrity (below) — not a separate approval ceremony.
        if (!["ready", "published"].includes(manifest.catalog_status)) {
            errors.push("Manifest catalog_status must be ready or published");
        }
    }
    return { ok: !errors.length, errors, warnings, counts };
}
async function updateManifestCounts(root) {
    const documents = await collectTableArtifacts(root);
    const manifest = await loadJson(join(root, "manifest.json"));
    manifest.counts = {
        total: documents.length,
        ...Object.fromEntries(TIERS.map((tier) => [tier, documents.filter((item) => item.tier === tier).length])),
    };
    await dumpJson(join(root, "manifest.json"), manifest);
    await generateIndexes(root);
}
export async function promoteTable(catalog, identifier, target, reason, snapshotPath) {
    const documents = await collectTableArtifacts(catalog);
    const current = documents.find((item) => item.document.table_id === identifier);
    if (!current)
        throw new CatalogError(`Table not found in catalog: ${identifier}`);
    if (current.tier === target)
        return { changed: false, table_id: identifier, tier: target };
    const [profile, database] = identifier.split("/");
    if (!profile || !database)
        throw new CatalogError(`Invalid table id: ${identifier}`);
    let artifact;
    if (current.tier === "cold") {
        if (!snapshotPath) {
            throw new CatalogError("Promoting a cold table requires --snapshot for field reconstruction");
        }
        const snapshot = await loadJson(snapshotPath);
        const table = (snapshot.tables ?? []).find((item) => item.table_id === identifier);
        if (!table)
            throw new CatalogError(`Table not found in snapshot: ${identifier}`);
        artifact = tableArtifact(table, {
            lifecycle: current.document.lifecycle,
            confidence: "confirmed",
            business_domain: current.document.category,
            classification: current.document.classification,
            reasons: current.document.reasons,
            warnings: current.document.warnings,
        }, target);
        const coldPath = join(catalog, "databases", profile, database, "cold", "tables.json");
        const cold = await loadJson(coldPath);
        cold.tables = (cold.tables ?? []).filter((item) => item.table_id !== identifier);
        await dumpJson(coldPath, cold);
    }
    else {
        artifact = current.document;
        if (!current.path)
            throw new CatalogError("Source table artifact path is missing");
        await rm(current.path);
    }
    artifact.tier = target;
    artifact.confidence = "confirmed";
    artifact.classification ??= {};
    artifact.classification.override = { source: "user", reason, changed_at: utcNow() };
    if (target === "hot") {
        artifact.enums ??= [];
        artifact.json_virtual_fields ??= [];
        artifact.metrics ??= [];
        artifact.report_lineage ??= [];
    }
    const destination = join(catalog, "databases", profile, database, target, "tables", safeName(identifier));
    await dumpJson(destination, artifact);
    await updateManifestCounts(catalog);
    return { changed: true, table_id: identifier, from: current.tier, to: target };
}
async function loadExcelJs() {
    try {
        const module = await import("exceljs");
        return module.default ?? module;
    }
    catch {
        throw new CatalogError("Enum Excel support is not installed. Install the pinned Excel feature dependency before this step.");
    }
}
function enumCandidate(field) {
    return enumField(field.physical ?? {});
}
function enumValues(nativeType) {
    const match = nativeType.match(/^(?:enum|set)\((.*)\)$/i);
    if (!match)
        return [];
    return [...match[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((item) => item[1].replaceAll("\\'", "'"));
}
function enumBindingKey(tableIdentifier, field) {
    return `${tableIdentifier}\u0000${field}`;
}
function cleanEnumName(field) {
    const raw = String(field.semantic?.name ??
        field.physical?.comment ??
        field.physical?.name ??
        "未命名枚举").trim();
    return (raw
        .replace(/[：:].*?(?=(?:\d+|[A-Z][A-Z0-9_]*)\s*[:：]?\s*\p{L})/u, "")
        .replace(/[,，;；]\s*(?=(?:\d+|[A-Z][A-Z0-9_]*)\s*[:：]?\s*\p{L}).*$/u, "")
        .trim() || String(field.physical?.name ?? "未命名枚举"));
}
function genericEnumField(field) {
    const physical = String(field.physical?.name ?? "").toLowerCase();
    const semantic = cleanEnumName(field);
    return (/^(status|type|source|flag|category|level|mode)$/.test(physical) ||
        /^(状态|类型|来源|标志|类别|级别|模式)$/.test(semantic));
}
function enumCandidateSignature(record) {
    const field = record.field;
    const evidence = normalizeEnumValues([
        ...enumValues(String(field.physical?.native_type ?? "")).map((value) => ({
            value,
            label: "",
            description: "",
        })),
        ...enumCommentValues(field.physical?.comment),
    ]).map((value) => [value.value, value.label]);
    const base = [
        String(field.physical?.name ?? "").toLowerCase(),
        normalizeSearchText(String(field.physical?.comment ?? "")),
        String(field.physical?.data_type ?? "").toLowerCase(),
        String(field.physical?.native_type ?? "").toLowerCase(),
    ].join("|");
    if (!genericEnumField(field))
        return base;
    return evidence.length
        ? `${base}|value-evidence:${stableStringify(evidence)}`
        : `${base}|table:${record.document.table_id}`;
}
function enumCommentValues(commentValue) {
    const comment = String(commentValue ?? "").trim();
    if (!comment)
        return [];
    const values = [];
    const expression = /(?:^|[：:,，;；\s])(-?\d+|[A-Z][A-Z0-9_]*)\s*[:：]?\s*([\p{Script=Han}][\p{Script=Han}A-Za-z]*?)(?=(?:[,，;；\s]+)(?:-?\d+|[A-Z][A-Z0-9_]*)|$)/gu;
    for (const match of comment.matchAll(expression)) {
        values.push({
            value: match[1],
            label: match[2],
            description: "从字段注释推断",
        });
    }
    return values;
}
function normalizeEnumValues(values = []) {
    const seen = new Set();
    const result = [];
    for (const item of values) {
        const value = cellText(item.value);
        if (!value || seen.has(value))
            continue;
        seen.add(value);
        result.push({
            value,
            label: cellText(item.label),
            description: cellText(item.description),
        });
    }
    return result;
}
function uniqueEnumName(preferred, record, signature, allocated) {
    const entity = String(record.document.business?.name ??
        record.document.comment ??
        record.document.physical?.table ??
        "").trim();
    const fieldName = String(record.field.physical?.name ?? "").trim();
    const candidates = [
        preferred,
        entity ? `${entity}-${preferred}` : "",
        fieldName ? `${preferred}-${fieldName}` : "",
        entity && fieldName ? `${entity}-${preferred}-${fieldName}` : "",
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (!allocated.has(candidate) || allocated.get(candidate) === signature) {
            allocated.set(candidate, signature);
            return candidate;
        }
    }
    let suffix = 2;
    while (allocated.has(`${preferred}-${suffix}`))
        suffix += 1;
    const value = `${preferred}-${suffix}`;
    allocated.set(value, signature);
    return value;
}
function enumState(document) {
    const dictionaries = new Map();
    const bindings = new Map();
    for (const dictionary of document.dictionaries ?? []) {
        const name = cellText(dictionary.name);
        if (!name)
            continue;
        dictionaries.set(name, {
            name,
            unknown_value_policy: dictionary.unknown_value_policy ?? "raw",
            value_types: [...new Set((dictionary.value_types ?? []).map(String))].sort(),
            values: normalizeEnumValues(dictionary.values ?? []),
        });
    }
    for (const binding of document.bindings ?? []) {
        const tableIdentifier = cellText(binding.table_id);
        const field = cellText(binding.field);
        const dictionaryName = cellText(binding.dictionary_name);
        if (!tableIdentifier || !field || !dictionaryName)
            continue;
        bindings.set(enumBindingKey(tableIdentifier, field), {
            table_id: tableIdentifier,
            field,
            dictionary_name: dictionaryName,
        });
    }
    for (const legacy of document.enums ?? []) {
        const tableIdentifier = cellText(legacy.table_id);
        const field = cellText(legacy.field);
        if (!tableIdentifier || !field)
            continue;
        const preferred = cellText(legacy.name) || field;
        let name = preferred;
        const normalized = normalizeEnumValues(legacy.values ?? []);
        if (dictionaries.has(name) &&
            stableStringify(dictionaries.get(name).values) !== stableStringify(normalized)) {
            const tableName = tableIdentifier.split("/").at(-1) ?? "table";
            name = `${preferred}-${tableName}-${field}`;
            let suffix = 2;
            while (dictionaries.has(name)) {
                name = `${preferred}-${tableName}-${field}-${suffix}`;
                suffix += 1;
            }
        }
        dictionaries.set(name, {
            name,
            unknown_value_policy: legacy.unknown_value_policy === "显示原值"
                ? "raw"
                : (legacy.unknown_value_policy ?? "raw"),
            value_types: legacy.value_type ? [String(legacy.value_type)] : [],
            values: normalized,
        });
        bindings.set(enumBindingKey(tableIdentifier, field), {
            table_id: tableIdentifier,
            field,
            dictionary_name: name,
        });
    }
    return { dictionaries, bindings };
}
async function enumFieldRecords(catalog) {
    const artifacts = await collectTableArtifacts(catalog);
    const records = [];
    for (const item of artifacts) {
        for (const field of item.document.physical_fields ?? []) {
            // System-fixed condition fields (e.g. del_flag) are never user-bound enums.
            // Import refuses to bind them, so they must not be treated as candidates
            // either — otherwise the required-binding check becomes unsatisfiable.
            if (field.filter?.role === "system_condition")
                continue;
            if (enumCandidate(field) || field.semantic?.enum_ref) {
                records.push({
                    tier: item.tier,
                    path: item.path,
                    document: item.document,
                    field,
                    binding_key: enumBindingKey(item.document.table_id, field.physical.name),
                });
            }
        }
    }
    return records.sort((a, b) => `${a.document.table_id}/${a.field.physical.name}`.localeCompare(`${b.document.table_id}/${b.field.physical.name}`));
}
export async function exportEnums(catalog, output) {
    const ExcelJS = await loadExcelJs();
    const workbook = new ExcelJS.Workbook();
    const fieldSheet = workbook.addWorksheet("枚举字段绑定");
    fieldSheet.columns = [
        { header: "连接", key: "profile", width: 22 },
        { header: "数据库", key: "database", width: 24 },
        { header: "表", key: "table", width: 30 },
        { header: "字段", key: "field", width: 24 },
        { header: "字段说明", key: "field_description", width: 38 },
        { header: "枚举名称", key: "dictionary_name", width: 30 },
    ];
    const mappingSheet = workbook.addWorksheet("枚举值映射");
    mappingSheet.columns = [
        { header: "枚举名称", key: "dictionary_name", width: 30 },
        { header: "枚举code", key: "value", width: 24 },
        { header: "中文名称", key: "label", width: 24 },
        { header: "说明", key: "description", width: 40 },
    ];
    const enumsPath = join(catalog, "global", "enums.json");
    const current = enumState(await loadJson(enumsPath));
    const records = await enumFieldRecords(catalog);
    // Reuse the shared proposal so enums-export and enums-init group/name enums the
    // same way (same signature, naming, generic-field, and existing-binding rules).
    const { proposedBindings, recordsByDictionary } = proposeEnumBindings(records, current);
    for (const record of records) {
        fieldSheet.addRow({
            profile: record.document.physical.profile_id,
            database: record.document.physical.database,
            table: record.document.physical.table,
            field: record.field.physical.name,
            field_description: record.field.physical.comment ??
                record.field.semantic?.name ??
                "",
            dictionary_name: proposedBindings.get(record.binding_key),
        });
    }
    let mappingCount = 0;
    for (const [dictionaryName, members] of [...recordsByDictionary].sort(([a], [b]) => a.localeCompare(b))) {
        const existingValues = current.dictionaries.get(dictionaryName)?.values ?? [];
        const inferredValues = normalizeEnumValues(members.flatMap((record) => [
            ...enumValues(String(record.field.physical.native_type ?? "")).map((value) => ({
                value,
                label: "",
                description: "",
            })),
            ...enumCommentValues(record.field.physical.comment),
        ]));
        const values = existingValues.length ? existingValues : inferredValues;
        for (const value of values.length ? values : [{ value: "", label: "", description: "" }]) {
            mappingSheet.addRow({
                dictionary_name: dictionaryName,
                value: value.value,
                label: value.label,
                description: value.description,
            });
            mappingCount += 1;
        }
    }
    for (const sheet of [fieldSheet, mappingSheet]) {
        sheet.getRow(1).font = { bold: true };
        sheet.views = [{ state: "frozen", ySplit: 1 }];
        sheet.autoFilter = {
            from: { row: 1, column: 1 },
            to: { row: 1, column: sheet.columnCount },
        };
    }
    mappingSheet.getColumn("value").numFmt = "@";
    await mkdir(dirname(output), { recursive: true });
    await workbook.xlsx.writeFile(output);
    const reviewPath = join(catalog, "reviews", "enum-review.json");
    const review = await loadJson(reviewPath);
    review.status = "exported";
    review.last_exported_at = utcNow();
    review.export_file = output;
    await dumpJson(reviewPath, review);
    return {
        output: resolve(output),
        field_rows: records.length,
        dictionary_rows: recordsByDictionary.size,
        mapping_rows: mappingCount,
        rows: mappingCount,
    };
}
function cellText(value) {
    if (value === null || value === undefined)
        return "";
    if (typeof value === "object" && "text" in value) {
        return String(value.text);
    }
    return String(value).trim();
}
/**
 * Compute the proposed enum bindings and per-dictionary member records for a draft.
 * This mirrors the deterministic grouping used by `exportEnums` (same signature,
 * naming, generic-field, and existing-binding reuse rules) so `enums-init` and
 * `enums-export` stay consistent. Pure: no I/O, no DB.
 */
function proposeEnumBindings(records, current) {
    const allocated = new Map();
    for (const name of current.dictionaries.keys()) {
        allocated.set(name, `existing:${name}`);
    }
    const proposedBindings = new Map();
    const groups = new Map();
    const existingNamesBySignature = new Map();
    for (const record of records) {
        const signature = enumCandidateSignature(record);
        const existing = current.bindings.get(record.binding_key);
        if (existing) {
            proposedBindings.set(record.binding_key, existing.dictionary_name);
            existingNamesBySignature.set(signature, new Set([
                ...(existingNamesBySignature.get(signature) ?? []),
                existing.dictionary_name,
            ]));
            continue;
        }
        groups.set(signature, [...(groups.get(signature) ?? []), record]);
    }
    for (const [signature, members] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
        const first = members[0];
        const base = cleanEnumName(first.field);
        const preferred = genericEnumField(first.field)
            ? `${String(first.document.business?.name ??
                first.document.comment ??
                first.document.physical.table)}-${base}`
            : base;
        const existingNames = [...(existingNamesBySignature.get(signature) ?? [])];
        const dictionaryName = existingNames.length === 1
            ? existingNames[0]
            : uniqueEnumName(preferred, first, signature, allocated);
        for (const member of members) {
            proposedBindings.set(member.binding_key, dictionaryName);
        }
    }
    const recordsByDictionary = new Map();
    for (const record of records) {
        const dictionaryName = proposedBindings.get(record.binding_key);
        recordsByDictionary.set(dictionaryName, [
            ...(recordsByDictionary.get(dictionaryName) ?? []),
            record,
        ]);
    }
    return { proposedBindings, recordsByDictionary };
}
/**
 * Read-only DISTINCT scan for one column. Returns up to `limit` distinct codes,
 * or null on timeout/over-limit/error (caller records the reason and degrades to
 * an empty dictionary — a scan failure MUST NOT block initialization).
 */
async function scanDistinctValues(connection, dialect, database, table, column, limit, timeoutMs) {
    // Fetch limit+1 to detect over-limit (too many distinct values => not a real enum).
    const sql = dialect.distinctSql(database, table, column, limit, timeoutMs);
    try {
        const rows = await connection.query(sql);
        if (rows.length > limit)
            return null; // too many distinct values; skip
        return rows
            .map((row) => cellText(row.v))
            .filter((value) => value.length > 0);
    }
    catch {
        return null;
    }
}
/**
 * Initialize the draft's global/enums.json from hot/warm enum candidates.
 *
 * Offline first: reuses the same binding/dictionary proposal as export (native
 * ENUM/SET values + comment-parsed code→中文). Then, for dictionaries still
 * without any values, runs a read-only DISTINCT scan to prefill candidate codes
 * (label left empty for humans to fill). Idempotent: existing dictionaries keep
 * their human-entered values (never overwritten); existing bindings are kept.
 * enum_ref is set on bound fields so downstream report generation can resolve it.
 */
export async function initEnums(catalog, config, options = {}) {
    const limit = Math.min(1000, Math.max(1, Number(options.limit ?? 200)));
    const timeoutMs = Math.min(30000, Math.max(500, Number(options.timeoutMs ?? 4000)));
    const enumsPath = join(catalog, "global", "enums.json");
    const current = enumState(await loadJson(enumsPath));
    const records = await enumFieldRecords(catalog);
    const { proposedBindings, recordsByDictionary } = proposeEnumBindings(records, current);
    // Resolve DB sources for the distinct scan (best-effort; degrade if unavailable).
    const sourcesById = new Map();
    try {
        for (const source of resolveDatabaseSources(config)) {
            if (isSupportedEngine(String(source.engine)))
                sourcesById.set(String(source.id), source);
        }
    }
    catch {
        // config without usable profiles => offline-only initialization
    }
    const connections = new Map();
    async function connectionFor(profileId) {
        if (connections.has(profileId))
            return connections.get(profileId) ?? null;
        const source = sourcesById.get(profileId);
        if (!source) {
            connections.set(profileId, null);
            return null;
        }
        try {
            const dialect = getDialect(String(source.engine));
            const connection = await createConnection(source);
            await connection.beginReadOnly();
            await applyStatementTimeout(dialect, connection, timeoutMs);
            const entry = { conn: connection, dialect };
            connections.set(profileId, entry);
            return entry;
        }
        catch {
            connections.set(profileId, null);
            return null;
        }
    }
    const skipped = [];
    let scanned = 0;
    let prefilled = 0;
    const desiredDictionaries = new Map();
    for (const [dictionaryName, members] of [...recordsByDictionary].sort(([a], [b]) => a.localeCompare(b))) {
        // Human-entered values win and are never overwritten (idempotency contract).
        const existingValues = current.dictionaries.get(dictionaryName)?.values ?? [];
        const offlineValues = normalizeEnumValues(members.flatMap((record) => [
            ...enumValues(String(record.field.physical.native_type ?? "")).map((value) => ({
                value,
                label: "",
                description: "",
            })),
            ...enumCommentValues(record.field.physical.comment),
        ]));
        let values = normalizeEnumValues([...existingValues, ...offlineValues]);
        let source = existingValues.length
            ? "existing"
            : offlineValues.length
                ? "native/comment"
                : "empty";
        // VARCHAR 等没有原生值定义的枚举每次初始化都做有限重扫，以便补充新 code；
        // existingValues 放在最前，normalizeEnumValues 保证人工 label 永远优先。
        if (!offlineValues.length) {
            for (const record of members) {
                const profileId = String(record.document.physical.profile_id);
                const entry = await connectionFor(profileId);
                if (!entry) {
                    skipped.push({ dictionary: dictionaryName, field: record.field.physical.name, reason: "无可用数据库连接" });
                    continue;
                }
                scanned += 1;
                const codes = await scanDistinctValues(entry.conn, entry.dialect, String(record.document.physical.database), String(record.document.physical.table), String(record.field.physical.name), limit, timeoutMs);
                if (codes === null) {
                    skipped.push({ dictionary: dictionaryName, field: record.field.physical.name, reason: `distinct 超时/超过 ${limit} 项/查询失败` });
                    continue;
                }
                if (codes.length) {
                    values = normalizeEnumValues([
                        ...existingValues,
                        ...values,
                        ...codes.map((value) => ({ value, label: "", description: "" })),
                    ]);
                    source = existingValues.length ? "existing+distinct" : "distinct";
                }
            }
            if (values.length)
                prefilled += 1;
        }
        const valueTypes = [
            ...new Set(members
                .map((record) => String(record.field.physical.data_type ?? record.field.physical.native_type ?? ""))
                .filter(Boolean)),
        ].sort();
        desiredDictionaries.set(dictionaryName, {
            name: dictionaryName,
            unknown_value_policy: current.dictionaries.get(dictionaryName)?.unknown_value_policy ?? "raw",
            value_types: valueTypes,
            values,
            source,
        });
    }
    for (const entry of connections.values()) {
        if (entry) {
            try {
                await entry.conn.query("ROLLBACK");
                await entry.conn.close();
            }
            catch {
                // ignore close errors
            }
        }
    }
    // Write enums.json: proposed bindings + dictionaries (human values preserved).
    const bindings = records
        .map((record) => ({
        table_id: String(record.document.table_id),
        field: String(record.field.physical.name),
        dictionary_name: proposedBindings.get(record.binding_key),
    }))
        .filter((binding) => Boolean(binding.dictionary_name))
        .sort((a, b) => `${a.table_id}/${a.field}`.localeCompare(`${b.table_id}/${b.field}`));
    await dumpJson(enumsPath, {
        schema_version: "2",
        dictionaries: [...desiredDictionaries.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))),
        bindings,
    });
    // Set enum_ref on bound hot/warm fields so report generation can resolve it.
    const artifacts = (await collectTableArtifacts(catalog)).filter((item) => item.tier !== "cold");
    for (const artifact of artifacts) {
        let changed = false;
        for (const fieldArtifact of artifact.document.physical_fields ?? []) {
            const binding = proposedBindings.get(enumBindingKey(artifact.document.table_id, fieldArtifact.physical.name));
            if (binding && cellText(fieldArtifact.semantic?.enum_ref) !== binding) {
                fieldArtifact.semantic = fieldArtifact.semantic ?? {};
                fieldArtifact.semantic.enum_ref = binding;
                changed = true;
            }
        }
        if (changed && artifact.path)
            await dumpJson(artifact.path, artifact.document);
    }
    const reviewPath = join(catalog, "reviews", "enum-review.json");
    const review = await loadJson(reviewPath);
    review.last_initialized_at = utcNow();
    review.last_initialization_summary = {
        limit,
        timeout_ms: timeoutMs,
        dictionaries: desiredDictionaries.size,
        bindings: bindings.length,
        scanned,
        prefilled,
        skipped,
    };
    await dumpJson(reviewPath, review);
    return {
        ok: true,
        dictionaries: desiredDictionaries.size,
        bindings: bindings.length,
        scanned,
        prefilled,
        skipped,
    };
}
export async function importEnums(catalog, input, dryRun) {
    const ExcelJS = await loadExcelJs();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(input);
    const fieldSheet = workbook.getWorksheet("枚举字段绑定");
    const mappingSheet = workbook.getWorksheet("枚举值映射");
    if (!fieldSheet || !mappingSheet) {
        throw new CatalogError("枚举配置文件必须包含“枚举字段绑定”和“枚举值映射”两个工作表");
    }
    const fieldHeaders = new Map();
    fieldSheet
        .getRow(1)
        .eachCell((cell, column) => fieldHeaders.set(cellText(cell.value), column));
    const mappingHeaders = new Map();
    mappingSheet
        .getRow(1)
        .eachCell((cell, column) => mappingHeaders.set(cellText(cell.value), column));
    const requiredFieldHeaders = [
        "连接",
        "数据库",
        "表",
        "字段",
        "字段说明",
        "枚举名称",
    ];
    const requiredMappingHeaders = ["枚举名称", "枚举code", "中文名称", "说明"];
    const missingFieldHeaders = requiredFieldHeaders.filter((header) => !fieldHeaders.has(header));
    const missingMappingHeaders = requiredMappingHeaders.filter((header) => !mappingHeaders.has(header));
    if (missingFieldHeaders.length || missingMappingHeaders.length) {
        throw new CatalogError([
            missingFieldHeaders.length
                ? `“枚举字段绑定”缺少列：${missingFieldHeaders.join("、")}`
                : "",
            missingMappingHeaders.length
                ? `“枚举值映射”缺少列：${missingMappingHeaders.join("、")}`
                : "",
        ]
            .filter(Boolean)
            .join("；"));
    }
    const fieldRows = [];
    fieldSheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1)
            return;
        const read = (header) => cellText(row.getCell(fieldHeaders.get(header)).value);
        fieldRows.push({
            rowNumber,
            profile: read("连接"),
            database: read("数据库"),
            table: read("表"),
            field: read("字段"),
            dictionary_name: read("枚举名称"),
        });
    });
    const mappingRows = [];
    mappingSheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1)
            return;
        const read = (header) => cellText(row.getCell(mappingHeaders.get(header)).value);
        mappingRows.push({
            rowNumber,
            dictionary_name: read("枚举名称"),
            value: read("枚举code"),
            label: read("中文名称"),
            description: read("说明"),
        });
    });
    return applyEnumRows(catalog, fieldRows, mappingRows, dryRun, true);
}
/**
 * Shared enum import core: validates parsed rows against the draft, computes the
 * diff, and (unless dry-run) writes global/enums.json + field enum_ref. Used by
 * both the Excel import and the JSON import so the completeness rules and the
 * write path live in exactly one place.
 */
async function applyEnumRows(catalog, fieldRows, mappingRows, dryRun, allowIncomplete = false) {
    const artifacts = await collectTableArtifacts(catalog);
    const byTable = new Map(artifacts.map((item) => [item.document.table_id, item]));
    const candidateRecords = await enumFieldRecords(catalog);
    const requiredBindings = new Set(candidateRecords
        .filter((record) => enumCandidate(record.field))
        .map((record) => record.binding_key));
    const desiredBindings = new Map();
    const errors = [];
    // Completeness issues (missing binding / partial mapping / empty enum). In WIP
    // "allowIncomplete" saves these are warnings that do NOT block the write; the
    // final publish-time import (allowIncomplete=false) still enforces them.
    const warnings = [];
    const pushCompleteness = (message) => {
        if (allowIncomplete)
            warnings.push(message);
        else
            errors.push(message);
    };
    for (const row of fieldRows) {
        const { profile, database, table, field, dictionary_name: dictionaryName, rowNumber } = row;
        if (![profile, database, table, field, dictionaryName].some(Boolean))
            continue;
        if (![profile, database, table, field].every(Boolean)) {
            errors.push(`“枚举字段绑定”第 ${rowNumber} 行：连接、数据库、表、字段均为必填`);
            continue;
        }
        if (!dictionaryName) {
            errors.push(`“枚举字段绑定”第 ${rowNumber} 行：枚举名称为必填`);
            continue;
        }
        const identifier = tableId(profile, database, table);
        const artifact = byTable.get(identifier);
        const fieldArtifact = artifact?.document.physical_fields?.find((item) => item.physical?.name === field);
        if (!artifact || !fieldArtifact) {
            errors.push(`”枚举字段绑定”第 ${rowNumber} 行：找不到字段 ${identifier}.${field}`);
            continue;
        }
        if (fieldArtifact.filter?.role === "system_condition") {
            errors.push(`“枚举字段绑定”第 ${rowNumber} 行：系统固定条件不能绑定枚举 ${identifier}.${field}`);
            continue;
        }
        const bindingKey = enumBindingKey(identifier, field);
        if (desiredBindings.has(bindingKey)) {
            errors.push(`“枚举字段绑定”第 ${rowNumber} 行：表字段重复 ${identifier}.${field}`);
            continue;
        }
        desiredBindings.set(bindingKey, {
            table_id: identifier,
            field,
            dictionary_name: dictionaryName,
            value_type: fieldArtifact.physical?.data_type ?? fieldArtifact.physical?.native_type ?? "",
        });
    }
    for (const requiredBinding of requiredBindings) {
        if (!desiredBindings.has(requiredBinding)) {
            const split = requiredBinding.split("\u0000");
            pushCompleteness(`缺少枚举字段绑定：${split[0]}.${split[1]}`);
        }
    }
    const seenMappings = new Map();
    const desiredValues = new Map();
    for (const row of mappingRows) {
        const { dictionary_name: dictionaryName, value, label, description, rowNumber } = row;
        if (![dictionaryName, value, label, description].some(Boolean))
            continue;
        if (!dictionaryName) {
            errors.push(`“枚举值映射”第 ${rowNumber} 行：枚举名称为必填`);
            continue;
        }
        if (!value && !label)
            continue;
        if (!value || !label) {
            // WIP: silently skip a half-filled row; strict import flags it.
            if (allowIncomplete)
                continue;
            errors.push(`“枚举值映射”第 ${rowNumber} 行：枚举code和中文名称必须同时填写`);
            continue;
        }
        const mappingKey = `${dictionaryName}\u0000${value}`;
        const firstRow = seenMappings.get(mappingKey);
        if (firstRow !== undefined) {
            // Duplicate within the uploaded file: warn, keep last occurrence (upsert).
            warnings.push(`“枚举值映射”第 ${rowNumber} 行：枚举code重复 ${dictionaryName} / ${value}（首次出现在第 ${firstRow} 行，已覆盖为最新值）`);
            // Remove the previous entry so last-wins.
            const prev = desiredValues.get(dictionaryName) ?? [];
            desiredValues.set(dictionaryName, prev.filter((entry) => entry.value !== value));
        }
        seenMappings.set(mappingKey, rowNumber);
        desiredValues.set(dictionaryName, [
            ...(desiredValues.get(dictionaryName) ?? []),
            { value, label, description },
        ]);
    }
    const referencedNames = new Set([...desiredBindings.values()].map((binding) => binding.dictionary_name));
    for (const name of referencedNames) {
        if (!(desiredValues.get(name) ?? []).length) {
            pushCompleteness(`枚举“${name}”没有配置任何code和中文名称`);
        }
    }
    for (const name of desiredValues.keys()) {
        if (!referencedNames.has(name)) {
            pushCompleteness(`枚举值映射“${name}”没有被任何表字段使用`);
        }
    }
    const enumsPath = join(catalog, "global", "enums.json");
    const current = enumState(await loadJson(enumsPath));
    const desiredDictionaries = new Map();
    for (const name of [...referencedNames].sort()) {
        const valueTypes = [
            ...new Set([...desiredBindings.values()]
                .filter((binding) => binding.dictionary_name === name)
                .map((binding) => String(binding.value_type ?? ""))
                .filter(Boolean)),
        ].sort();
        desiredDictionaries.set(name, {
            name,
            unknown_value_policy: "raw",
            value_types: valueTypes,
            values: normalizeEnumValues(desiredValues.get(name) ?? []),
        });
    }
    const dictionaryDiff = {
        added: [...desiredDictionaries.keys()].filter((name) => !current.dictionaries.has(name)),
        updated: [...desiredDictionaries.keys()].filter((name) => current.dictionaries.has(name) &&
            stableStringify(current.dictionaries.get(name)) !==
                stableStringify(desiredDictionaries.get(name))),
        removed: [...current.dictionaries.keys()].filter((name) => !desiredDictionaries.has(name)),
        unchanged: [...desiredDictionaries.keys()].filter((name) => current.dictionaries.has(name) &&
            stableStringify(current.dictionaries.get(name)) ===
                stableStringify(desiredDictionaries.get(name))),
    };
    const bindingDescription = (binding) => `${binding.table_id}.${binding.field} → ${binding.dictionary_name}`;
    const bindingDiff = {
        added: [...desiredBindings.entries()]
            .filter(([key]) => !current.bindings.has(key))
            .map(([, binding]) => bindingDescription(binding)),
        updated: [...desiredBindings.entries()]
            .filter(([key, binding]) => current.bindings.has(key) &&
            current.bindings.get(key).dictionary_name !== binding.dictionary_name)
            .map(([, binding]) => bindingDescription(binding)),
        removed: [...current.bindings.entries()]
            .filter(([key]) => !desiredBindings.has(key))
            .map(([, binding]) => bindingDescription(binding)),
        unchanged: [...desiredBindings.entries()]
            .filter(([key, binding]) => current.bindings.has(key) &&
            current.bindings.get(key).dictionary_name === binding.dictionary_name)
            .map(([, binding]) => bindingDescription(binding)),
    };
    const changeCount = dictionaryDiff.added.length +
        dictionaryDiff.updated.length +
        dictionaryDiff.removed.length +
        bindingDiff.added.length +
        bindingDiff.updated.length +
        bindingDiff.removed.length;
    const summary = {
        dry_run: dryRun,
        changes: changeCount,
        dictionary_count: desiredDictionaries.size,
        binding_count: desiredBindings.size,
        mapping_count: [...desiredValues.values()].reduce((total, values) => total + values.length, 0),
        errors,
        warnings,
    };
    const preview = {
        dictionaries: dictionaryDiff,
        bindings: bindingDiff,
    };
    if (errors.length || dryRun) {
        return { ok: !errors.length, ...summary, preview };
    }
    const nextEnums = {
        schema_version: "2",
        dictionaries: [...desiredDictionaries.values()],
        bindings: [...desiredBindings.values()]
            .map(({ table_id, field, dictionary_name }) => ({
            table_id,
            field,
            dictionary_name,
        }))
            .sort((a, b) => `${a.table_id}/${a.field}`.localeCompare(`${b.table_id}/${b.field}`)),
    };
    for (const artifact of artifacts) {
        let changed = false;
        for (const fieldArtifact of artifact.document.physical_fields ?? []) {
            const key = enumBindingKey(artifact.document.table_id, fieldArtifact.physical.name);
            const binding = desiredBindings.get(key);
            const currentReference = cellText(fieldArtifact.semantic?.enum_ref);
            if (binding) {
                if (currentReference !== binding.dictionary_name)
                    changed = true;
                fieldArtifact.semantic.enum_ref = binding.dictionary_name;
                if (fieldArtifact.filter?.role !== "system_condition") {
                    fieldArtifact.filter = {
                        enabled: true,
                        role: "enum",
                        default_operator: "in",
                        operators: ["eq", "in"],
                        input_type: "select",
                        visibility: "user",
                        required: false,
                        source: "enum_binding",
                        status: "confirmed",
                    };
                    fieldArtifact.semantic.filter_candidate = true;
                    changed = true;
                }
            }
            else if (currentReference) {
                fieldArtifact.semantic.enum_ref = null;
                fieldArtifact.filter = inferFilter(fieldArtifact.physical, undefined, DEFAULT_SEMANTIC_DEFAULTS);
                fieldArtifact.semantic.filter_candidate =
                    fieldArtifact.filter.enabled &&
                        fieldArtifact.filter.role !== "system_condition";
                changed = true;
            }
        }
        if (changed)
            await dumpJson(artifact.path, artifact.document);
    }
    await dumpJson(enumsPath, nextEnums);
    const reviewPath = join(catalog, "reviews", "enum-review.json");
    const review = await loadJson(reviewPath);
    review.status = "imported";
    review.last_imported_at = utcNow();
    review.dictionary_count = desiredDictionaries.size;
    review.binding_count = desiredBindings.size;
    review.mapping_count = summary.mapping_count;
    await dumpJson(reviewPath, review);
    return { ok: true, ...summary, preview };
}
/**
 * JSON-input enum import for programmatic callers (e.g. the studio enum tab).
 * Accepts the same logical content as the Excel workbook — either explicit
 * `fieldRows`/`mappingRows`, or a page model `{bindings, dictionaries}` — and
 * runs the identical validation and write path via `applyEnumRows`. This is a
 * compatible extension: the Excel command and format are unchanged.
 *
 * Page model shape:
 *   {
 *     "bindings": [{ "table_id": "profile/db/table", "field": "col", "dictionary_name": "..." }],
 *     "dictionaries": [{ "name": "...", "values": [{ "value": "CODE", "label": "中文", "description": "" }] }]
 *   }
 */
export async function importEnumsJson(catalog, input, dryRun, allowIncomplete = false) {
    const payload = await loadJson(input);
    let fieldRows;
    let mappingRows;
    if (Array.isArray(payload.fieldRows) || Array.isArray(payload.mappingRows)) {
        fieldRows = (payload.fieldRows ?? []).map((row, index) => ({
            rowNumber: index + 2,
            profile: cellText(row.profile ?? row["连接"]),
            database: cellText(row.database ?? row["数据库"]),
            table: cellText(row.table ?? row["表"]),
            field: cellText(row.field ?? row["字段"]),
            dictionary_name: cellText(row.dictionary_name ?? row["枚举名称"]),
        }));
        mappingRows = (payload.mappingRows ?? []).map((row, index) => ({
            rowNumber: index + 2,
            dictionary_name: cellText(row.dictionary_name ?? row["枚举名称"]),
            value: cellText(row.value ?? row["枚举code"]),
            label: cellText(row.label ?? row["中文名称"]),
            description: cellText(row.description ?? row["说明"]),
        }));
    }
    else {
        // Page model: bindings[] + dictionaries[].
        fieldRows = (payload.bindings ?? []).map((binding, index) => {
            const parts = cellText(binding.table_id).split("/");
            return {
                rowNumber: index + 2,
                profile: parts[0] ?? "",
                database: parts[1] ?? "",
                table: parts[2] ?? "",
                field: cellText(binding.field),
                dictionary_name: cellText(binding.dictionary_name),
            };
        });
        mappingRows = [];
        let mappingIndex = 0;
        for (const dictionary of payload.dictionaries ?? []) {
            const name = cellText(dictionary.name);
            for (const value of dictionary.values ?? []) {
                mappingRows.push({
                    rowNumber: (mappingIndex += 1) + 1,
                    dictionary_name: name,
                    value: cellText(value.value),
                    label: cellText(value.label),
                    description: cellText(value.description),
                });
            }
        }
    }
    return applyEnumRows(catalog, fieldRows, mappingRows, dryRun, allowIncomplete);
}
export async function publishCatalog(draft, workspace, version, publishedBy, decision) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new CatalogError("version must be SemVer-like");
    }
    const destination = join(resolve(workspace), "knowledge", "versions", version);
    if (await exists(destination)) {
        throw new CatalogError(`Published catalog version already exists: ${destination}`);
    }
    const manifestPath = join(draft, "manifest.json");
    const original = await loadJson(manifestPath);
    await dumpJson(manifestPath, {
        ...original,
        catalog_version: version,
        catalog_status: "ready",
    });
    try {
        const validation = await validateCatalog(draft, true);
        if (!validation.ok) {
            throw new CatalogError(`Catalog is not publishable: ${validation.errors.join("; ")}`);
        }
        await mkdir(dirname(destination), { recursive: true });
        await cp(draft, destination, { recursive: true });
    }
    finally {
        await dumpJson(manifestPath, original);
    }
    const publishedAt = utcNow();
    const publishedManifest = await loadJson(join(destination, "manifest.json"));
    Object.assign(publishedManifest, {
        catalog_status: "published",
        source_kind: "immutable_version",
        published_at: publishedAt,
        published_by: publishedBy,
        publication_decision: decision ?? null,
    });
    await dumpJson(join(destination, "manifest.json"), publishedManifest);
    const files = await listJsonFiles(destination);
    const contentHash = jsonHash(await Promise.all(files.map(async (path) => ({
        path: relative(destination, path),
        content: await loadJson(path),
    }))));
    const indexPath = join(workspace, "knowledge", "index.json");
    const index = (await exists(indexPath))
        ? await loadJson(indexPath)
        : { current_version: null, versions: [] };
    index.current_version = version;
    index.versions = [
        ...(index.versions ?? []),
        {
            version,
            path: `knowledge/versions/${version}`,
            published_at: publishedAt,
            published_by: publishedBy,
            catalog_hash: contentHash,
        },
    ];
    await dumpJson(indexPath, index);
    return { published: destination, version, catalog_hash: contentHash };
}
async function listJsonFiles(root) {
    const files = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory())
            files.push(...(await listJsonFiles(path)));
        else if (entry.name.endsWith(".json"))
            files.push(path);
    }
    return files.sort();
}
export function configTemplate(systemId = "easybi-project", systemName = "Easy BI 项目") {
    return {
        config_version: "4",
        setup_status: "draft",
        system: {
            id: systemId,
            name: systemName,
            description: "",
            timezone: "Asia/Shanghai",
            locale: "zh-CN",
            business_domains: [],
        },
        connections: { database_profiles: [], object_storage_profiles: [] },
        knowledge: {
            database_profile_ids: [],
            inactivity_days: 90,
            classification: { hot_threshold: 80, cold_threshold: 25 },
            activity_probe: {
                enabled: true,
                require_index: false,
                unindexed_max_columns: 2,
                statement_timeout_seconds: 8,
                candidate_columns: DEFAULT_ACTIVITY_COLUMNS,
            },
            forced_hot_tables: [],
            business_semantics: [],
            report_scenarios: [],
            report_requirements: [],
            semantic_defaults: structuredClone(DEFAULT_SEMANTIC_DEFAULTS),
            confirmed_cold_patterns: [],
            profiling: { allow_value_sampling: false, candidate_tables_only: true, sample_limit: 1000 },
        },
        delivery: {
            mode: "auto",
            object_storage_profile_id: null,
            local_output_directory: "outputs/files",
        },
        export: {
            target: "linux-x64-glibc",
            business_integration: {
                base_url: null,
                task_event_path: "/internal/easybi/report-task-events",
                auth: null,
            },
        },
    };
}
export async function initWorkspace(root, systemId = "easybi-project", systemName = "Easy BI 项目") {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(systemId)) {
        throw new CatalogError("system-id must contain 2-63 lowercase letters, digits, or hyphens");
    }
    const absolute = resolve(root);
    for (const directory of [
        "config",
        "knowledge/scans",
        "knowledge/drafts",
        "knowledge/versions",
        "reports/plans",
        "reports/packages",
        "outputs/files",
        "toolkit/config",
        "work/knowledge-init",
    ]) {
        await mkdir(join(absolute, directory), { recursive: true });
    }
    const workspacePath = join(absolute, "workspace.json");
    const workspaceDefaults = {
        workspace_format_version: "1",
        system: { id: systemId, name: systemName },
        status: "configuring",
        created_at: utcNow(),
        paths: {
            config: "config",
            skills: "skills",
            skill_bundle_manifest: "skills/bundle.manifest.json",
            skill_bundle_lock: "skills/bundle.lock.json",
            toolkit: "toolkit",
            knowledge: "knowledge",
            report_plans: "reports/plans",
            report_packages: "reports/packages",
            outputs: "outputs",
            work: "work",
        },
    };
    if (await exists(workspacePath)) {
        const existing = await loadJson(workspacePath);
        if (existing.workspace_format_version !== undefined &&
            String(existing.workspace_format_version) !== "1") {
            throw new CatalogError(`Unsupported workspace_format_version ${existing.workspace_format_version}`);
        }
        await dumpJson(workspacePath, {
            ...workspaceDefaults,
            ...existing,
            workspace_format_version: "1",
            system: {
                ...workspaceDefaults.system,
                ...(existing.system ?? {}),
            },
            paths: {
                ...workspaceDefaults.paths,
                ...(existing.paths ?? {}),
            },
        });
    }
    else {
        await dumpJson(workspacePath, workspaceDefaults);
    }
    const configPath = join(absolute, "config", "easy-bi.json");
    if (!(await exists(configPath)))
        await dumpJson(configPath, configTemplate(systemId, systemName));
    for (const [path, initial] of [
        ["knowledge/index.json", { current_version: null, versions: [] }],
        ["reports/index.json", { reports: [] }],
        ["outputs/index.json", { artifacts: [] }],
    ]) {
        if (!(await exists(join(absolute, path))))
            await dumpJson(join(absolute, path), initial);
    }
    const workspace = await loadJson(workspacePath);
    return { workspace: absolute, config: configPath, status: workspace.status };
}
export function validateConfig(config, scope = "knowledge") {
    const errors = [];
    const warnings = [];
    if (!validateConfigShape(config)) {
        errors.push(...((validateConfigShape.errors ?? []).map((error) => `${error.instancePath || "$"} ${error.message}`)));
    }
    let sources = [];
    try {
        sources = resolveDatabaseSources(config);
    }
    catch (error) {
        errors.push(error.message);
    }
    const ids = sources.map((source) => source.id);
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
        errors.push("Every database profile requires a unique id");
    }
    for (const source of sources) {
        if (source.engine !== "mysql")
            errors.push(`Unsupported connector: ${source.engine}`);
        for (const field of ["host", "username"]) {
            if (!source[field])
                errors.push(`Database profile ${source.id} requires ${field}`);
        }
        if (source.password === undefined && !source.password_env) {
            errors.push(`Database profile ${source.id} requires password or password_env`);
        }
        if (!Array.isArray(source.databases) || !source.databases.length) {
            errors.push(`Database profile ${source.id} requires all database names`);
        }
    }
    // Validate active_environment + environments format on raw profiles.
    const rawProfiles = (config.connections?.database_profiles ?? []);
    for (const profile of rawProfiles) {
        const envActive = profile.active_environment;
        const envs = profile.environments;
        if (envActive !== undefined || envs !== undefined) {
            if (typeof envs !== "object" || envs === null || Array.isArray(envs)) {
                errors.push(`Database profile ${profile.id}: environments must be an object`);
            }
            else if (Object.keys(envs).length === 0) {
                errors.push(`Database profile ${profile.id}: environments must have at least one entry`);
            }
            else {
                for (const [envKey, envVal] of Object.entries(envs)) {
                    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(envKey)) {
                        errors.push(`Database profile ${profile.id}: invalid environment name "${envKey}"`);
                    }
                    if (typeof envVal !== "object" || envVal === null || Array.isArray(envVal)) {
                        errors.push(`Database profile ${profile.id}: environment "${envKey}" must be an object`);
                        continue;
                    }
                    const envRec = envVal;
                    if (!envRec.password && !envRec.password_env && !profile.password && !profile.password_env) {
                        errors.push(`Database profile ${profile.id}: environment "${envKey}" requires password or password_env`);
                    }
                    const envSettings = envRec.settings;
                    if (!envSettings?.host) {
                        errors.push(`Database profile ${profile.id}: environment "${envKey}" requires settings.host`);
                    }
                }
                if (typeof envActive === "string" && envActive && !(envActive in envs)) {
                    errors.push(`Database profile ${profile.id}: active_environment "${envActive}" not found in environments`);
                }
            }
        }
    }
    const classification = config.knowledge?.classification ?? {};
    const hot = Number(classification.hot_threshold ?? 80);
    const cold = Number(classification.cold_threshold ?? 25);
    if (!(cold >= 0 && hot <= 100 && cold < hot)) {
        errors.push("knowledge.classification must satisfy 0 <= cold_threshold < hot_threshold <= 100");
    }
    const reportRequirements = config.knowledge?.report_requirements;
    const allowedOperators = new Set(["eq", "in", "contains", "between", "gte", "lte"]);
    if (reportRequirements !== undefined && !Array.isArray(reportRequirements)) {
        errors.push("knowledge.report_requirements must be an array");
    }
    else {
        for (const [reportIndex, report] of (reportRequirements ?? []).entries()) {
            const reportPath = `knowledge.report_requirements[${reportIndex}]`;
            if (!report || Array.isArray(report) || typeof report !== "object") {
                errors.push(`${reportPath} must be an object`);
                continue;
            }
            if (!String(report.name ?? "").trim()) {
                errors.push(`${reportPath}.name is required`);
            }
            if (!Array.isArray(report.required_fields) || !report.required_fields.length) {
                errors.push(`${reportPath}.required_fields must be a non-empty array`);
                continue;
            }
            for (const [fieldIndex, field] of report.required_fields.entries()) {
                const fieldPath = `${reportPath}.required_fields[${fieldIndex}]`;
                const validString = typeof field === "string" && field.trim().length > 0;
                const validObject = field &&
                    !Array.isArray(field) &&
                    typeof field === "object" &&
                    String(field.field ?? field.physical_field ?? field.name ?? "").trim().length > 0;
                if (!validString && !validObject) {
                    errors.push(`${fieldPath} must be a non-empty string or an object with field`);
                }
                if (validObject &&
                    field.filter?.operator &&
                    !allowedOperators.has(String(field.filter.operator))) {
                    errors.push(`${fieldPath}.filter.operator is invalid`);
                }
            }
        }
    }
    const filterDefaults = config.knowledge?.semantic_defaults?.filters ?? {};
    for (const key of [
        "identifier_operator",
        "string_operator",
        "number_operator",
        "date_operator",
        "enum_operator",
        "boolean_operator",
    ]) {
        if (filterDefaults[key] && !allowedOperators.has(String(filterDefaults[key]))) {
            errors.push(`knowledge.semantic_defaults.filters.${key} is invalid`);
        }
    }
    if (scope !== "knowledge" && scope !== "report-build") {
        const delivery = config.delivery ?? {};
        if (!["auto", "local_file", "object_storage"].includes(delivery.mode ?? "auto")) {
            errors.push("delivery.mode is invalid");
        }
        if (scope === "runtime-production" && !delivery.object_storage_profile_id) {
            errors.push("runtime-production requires an object storage profile");
        }
    }
    if (!config.knowledge?.business_semantics?.length) {
        warnings.push("Business semantics can be added after connection succeeds");
    }
    if (!config.knowledge?.report_requirements?.length) {
        warnings.push("Planned report requirements can be added after connection succeeds");
    }
    return { ok: !errors.length, scope, errors, warnings, database_profiles: sources.length };
}
export function parseCli(argv) {
    const [command = "", ...rest] = argv;
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (!token.startsWith("--"))
            throw new CatalogError(`Unexpected argument: ${token}`);
        const equalsAt = token.indexOf("=");
        if (equalsAt >= 0) {
            const key = token.slice(2, equalsAt);
            if (!key)
                throw new CatalogError(`Unexpected argument: ${token}`);
            options[key] = token.slice(equalsAt + 1);
            continue;
        }
        const key = token.slice(2);
        if (!key)
            throw new CatalogError(`Unexpected argument: ${token}`);
        const next = rest[index + 1];
        if (!next || next.startsWith("--"))
            options[key] = true;
        else {
            options[key] = next;
            index += 1;
        }
    }
    return { command, options };
}
function required(options, key) {
    const value = options[key];
    if (typeof value !== "string" || !value)
        throw new CatalogError(`--${key} is required`);
    return value;
}
function print(value) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
export async function runCli(argv) {
    if (argv.length === 1 &&
        (argv[0] === "--version" || argv[0] === "version")) {
        process.stdout.write(`${VERSION}\n`);
        return 0;
    }
    const { command, options } = parseCli(argv);
    switch (command) {
        case "doctor": {
            const scope = String(options.scope ?? "knowledge");
            const major = Number(process.versions.node.split(".")[0]);
            const ok = major === 24;
            print({
                ok,
                scope,
                node: process.version,
                platform: process.platform,
                arch: process.arch,
                required_node: ">=24 <25",
                feature_dependencies: scope === "knowledge" ? ["mysql2", "ajv"] : ["exceljs"],
            });
            return ok ? 0 : 1;
        }
        case "connectors":
            print({ connector_contract_version: "1", connectors: Object.values(CONNECTORS) });
            return 0;
        case "init-workspace":
            print(await initWorkspace(required(options, "root"), String(options["system-id"] ?? "easybi-project"), String(options["system-name"] ?? "Easy BI 项目")));
            return 0;
        case "validate-config": {
            const result = validateConfig(await loadJson(required(options, "config")), String(options.scope ?? "knowledge"));
            print(result);
            return result.ok ? 0 : 1;
        }
        case "test-connections":
            print(await testConnections(await loadJson(required(options, "config"))));
            return 0;
        case "discover": {
            const output = required(options, "out");
            const snapshot = await discover(await loadJson(required(options, "config")));
            await dumpJson(output, snapshot);
            print({ out: resolve(output), tables: snapshot.tables.length, sources: snapshot.sources.length });
            return 0;
        }
        case "diff-snapshots": {
            const output = required(options, "out");
            const diff = diffSnapshots(await loadJson(required(options, "previous")), await loadJson(required(options, "current")));
            await dumpJson(output, diff);
            print({ out: resolve(output), summary: diff.summary });
            return 0;
        }
        case "propose": {
            const output = required(options, "out");
            const plan = propose(await loadJson(required(options, "snapshot")), await loadJson(required(options, "hints")));
            await dumpJson(output, plan);
            print({ out: resolve(output), summary: plan.summary });
            return 0;
        }
        case "approve-plan":
            print(await approveCatalogPlan(required(options, "plan"), required(options, "approved-by"), required(options, "decision")));
            return 0;
        case "build": {
            const output = required(options, "out");
            const manifest = await buildCatalog(await loadJson(required(options, "snapshot")), await loadJson(required(options, "plan")), output);
            let enumInitialization;
            try {
                enumInitialization = await initEnums(output, typeof options.config === "string" ? await loadJson(options.config) : {}, {
                    limit: typeof options["enum-limit"] === "string"
                        ? Number(options["enum-limit"])
                        : undefined,
                    timeoutMs: typeof options["enum-timeout-ms"] === "string"
                        ? Number(options["enum-timeout-ms"])
                        : undefined,
                });
            }
            catch (error) {
                enumInitialization = {
                    ok: false,
                    non_blocking: true,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
            print({
                out: resolve(output),
                counts: manifest.counts,
                enum_initialization: enumInitialization,
            });
            return 0;
        }
        case "promote":
            print(await promoteTable(required(options, "catalog"), required(options, "table"), required(options, "to"), required(options, "reason"), typeof options.snapshot === "string" ? options.snapshot : undefined));
            return 0;
        case "enums-init": {
            const result = await initEnums(required(options, "catalog"), await loadJson(required(options, "config")), {
                limit: typeof options.limit === "string" ? Number(options.limit) : undefined,
                timeoutMs: typeof options["timeout-ms"] === "string" ? Number(options["timeout-ms"]) : undefined,
            });
            print(result);
            return result.ok ? 0 : 1;
        }
        case "enums-export":
            print(await exportEnums(required(options, "catalog"), required(options, "out")));
            return 0;
        case "enums-import": {
            const result = await importEnums(required(options, "catalog"), required(options, "file"), Boolean(options["dry-run"]));
            print(result);
            return result.ok ? 0 : 1;
        }
        case "enums-import-json": {
            const result = await importEnumsJson(required(options, "catalog"), required(options, "file"), Boolean(options["dry-run"]), Boolean(options["allow-incomplete"]));
            print(result);
            return result.ok ? 0 : 1;
        }
        case "validate": {
            const result = await validateCatalog(required(options, "catalog"), Boolean(options["publish-ready"]));
            print(result);
            return result.ok ? 0 : 1;
        }
        case "publish":
            print(await publishCatalog(required(options, "catalog"), required(options, "workspace"), required(options, "version"), required(options, "published-by"), typeof options.decision === "string" ? options.decision : undefined));
            return 0;
        default:
            throw new CatalogError("Command required: doctor, connectors, init-workspace, validate-config, test-connections, discover, diff-snapshots, propose, approve-plan, build, promote, enums-init, enums-export, enums-import, enums-import-json, validate, publish");
    }
}
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
    runCli(process.argv.slice(2))
        .then((code) => {
        process.exitCode = code;
    })
        .catch((error) => {
        process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
        process.exitCode = error instanceof CatalogError ? 2 : 1;
    });
}
//# sourceMappingURL=catalog-cli.js.map