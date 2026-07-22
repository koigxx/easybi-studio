/**
 * Database dialect abstraction for knowledge-base scanning.
 *
 * The scanner was originally MySQL-only. This module isolates every
 * engine-specific concern (driver connect, server metadata, schema discovery,
 * identifier quoting, read-only session setup, statement-timeout probing) behind
 * one interface so additional engines can be added without touching the scan
 * orchestration. MySQL and PostgreSQL are implemented; the snapshot output shape
 * is engine-neutral and unchanged.
 */
export type JsonObject = Record<string, any>;
/** A normalized column row, engine-neutral (matches the existing snapshot shape). */
export interface RawColumn {
    database: string;
    table: string;
    name: string;
    ordinal: number;
    data_type: string;
    native_type: string;
    nullable: boolean;
    default: unknown;
    comment: string;
    primary_key: boolean;
    extra: string;
}
export interface RawTable {
    database: string;
    table: string;
    table_type: string;
    comment: string;
    estimated_rows: number | null;
    update_at: unknown;
}
export interface RawIndex {
    database: string;
    table: string;
    name: string;
    unique: boolean;
    seq: number;
    column: string;
}
export interface RawForeignKey {
    database: string;
    table: string;
    name: string;
    column: string;
    ref_database: string;
    ref_table: string;
    ref_column: string;
    ordinal: number;
}
export interface DialectConnection {
    /** Run a query returning row objects. Positional params use the dialect's placeholders. */
    query(sql: string, params?: unknown[]): Promise<JsonObject[]>;
    /** Begin a read-only transaction (best-effort isolation). */
    beginReadOnly(): Promise<void>;
    close(): Promise<void>;
}
export interface Dialect {
    readonly id: string;
    /** Quote a schema/table/column identifier. */
    quoteId(value: string): string;
    /** Open a connection using a resolved profile source (settings + engine + secret). */
    connect(source: JsonObject, secret: string, database?: string): Promise<DialectConnection>;
    /** Server metadata (version etc.); engine-neutral object, never secret-bearing. */
    serverMetadata(conn: DialectConnection): Promise<JsonObject>;
    /** List database/schema names visible to the connection. */
    listDatabases(conn: DialectConnection): Promise<string[]>;
    /** Discover tables in the given databases. */
    tables(conn: DialectConnection, databases: string[]): Promise<RawTable[]>;
    /** Discover columns in the given databases. */
    columns(conn: DialectConnection, databases: string[]): Promise<RawColumn[]>;
    /** Discover indexes in the given databases. */
    indexes(conn: DialectConnection, databases: string[]): Promise<RawIndex[]>;
    /** Discover foreign keys in the given databases. */
    foreignKeys(conn: DialectConnection, databases: string[]): Promise<RawForeignKey[]>;
    /**
     * Build an ORDER BY ... DESC LIMIT 1 probe for the latest value of a time column,
     * with a per-statement timeout expressed in the dialect's own way.
     */
    latestValueSql(database: string, table: string, column: string, timeoutMs: number): string;
    /** Build a "has any row with <col> >= cutoff (OR ...)" existence probe. */
    recentExistsSql(database: string, table: string, columns: string[], timeoutMs: number): {
        sql: string;
        params: unknown[];
    };
    /** Build a DISTINCT <col> ... LIMIT n+1 probe for enum candidate values. */
    distinctSql(database: string, table: string, column: string, limit: number, timeoutMs: number): string;
}
/** Resolve a dialect by connector_id/engine; throws for unknown engines. */
export declare function getDialect(engine: string): Dialect;
export declare function isSupportedEngine(engine: string): boolean;
/**
 * PostgreSQL enforces the statement timeout via a session GUC rather than a query
 * hint. Callers set it once after connecting when the engine needs it.
 */
export declare function applyStatementTimeout(dialect: Dialect, conn: DialectConnection, timeoutMs: number): Promise<void>;
