#!/usr/bin/env node
import { type Dialect, type DialectConnection } from "./dialect.js";
export declare const VERSION = "0.10.0";
export declare const TIERS: readonly ["hot", "warm", "cold"];
type JsonObject = Record<string, any>;
export declare const CONNECTORS: {
    readonly mysql: {
        readonly id: "mysql";
        readonly category: "database";
        readonly display_name: "MySQL";
        readonly version: "1";
        readonly status: "available";
        readonly capabilities: readonly ["connection_test", "server_metadata", "multi_database_discovery", "schema_discovery", "indexed_activity_probe", "unindexed_recent_activity_probe"];
    };
};
export declare class CatalogError extends Error {
}
export declare function utcNow(): string;
export declare function stableStringify(value: unknown): string;
export declare function jsonHash(value: unknown): string;
export declare function loadJson(path: string): Promise<JsonObject>;
export declare function dumpJson(path: string, value: unknown): Promise<void>;
export declare function tableId(profileId: string, database: string, table: string): string;
export declare function resolveDatabaseSources(config: JsonObject): JsonObject[];
export declare function probeActivity(connection: DialectConnection, table: JsonObject, policy: JsonObject, dialect: Dialect): Promise<JsonObject>;
export declare function testConnections(config: JsonObject): Promise<JsonObject>;
export declare function discover(config: JsonObject): Promise<JsonObject>;
export declare function diffSnapshots(previous: JsonObject, current: JsonObject): JsonObject;
export declare function propose(snapshot: JsonObject, hintsDocument: JsonObject): JsonObject;
export declare function approveCatalogPlan(planPathValue: string, approvedBy: string, decision: string): Promise<JsonObject>;
export declare function buildCatalog(snapshot: JsonObject, plan: JsonObject, output: string): Promise<JsonObject>;
export declare function validateCatalog(root: string, publishReady?: boolean): Promise<JsonObject>;
export declare function promoteTable(catalog: string, identifier: string, target: "warm" | "hot", reason: string, snapshotPath?: string): Promise<JsonObject>;
export declare function exportEnums(catalog: string, output: string): Promise<JsonObject>;
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
export declare function initEnums(catalog: string, config: JsonObject, options?: {
    limit?: number;
    timeoutMs?: number;
}): Promise<JsonObject>;
export declare function importEnums(catalog: string, input: string, dryRun: boolean): Promise<JsonObject>;
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
export declare function importEnumsJson(catalog: string, input: string, dryRun: boolean, allowIncomplete?: boolean): Promise<JsonObject>;
export declare function publishCatalog(draft: string, workspace: string, version: string, publishedBy: string, decision?: string): Promise<JsonObject>;
export declare function configTemplate(systemId?: string, systemName?: string): JsonObject;
export declare function initWorkspace(root: string, systemId?: string, systemName?: string): Promise<JsonObject>;
export declare function validateConfig(config: JsonObject, scope?: string): JsonObject;
type CliOptions = Record<string, string | boolean | undefined>;
export declare function parseCli(argv: string[]): {
    command: string;
    options: CliOptions;
};
export declare function runCli(argv: string[]): Promise<number>;
export {};
