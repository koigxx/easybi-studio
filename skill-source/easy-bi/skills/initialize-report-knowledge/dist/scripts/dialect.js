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
// ── MySQL ────────────────────────────────────────────────────────────────────
function mysqlQuote(value) {
    return `\`${value.replaceAll("`", "``")}\``;
}
class MysqlConn {
    raw;
    constructor(raw) {
        this.raw = raw;
    }
    async query(sql, params) {
        const [rows] = await this.raw.query(params ? { sql, values: params } : sql);
        return rows;
    }
    async beginReadOnly() {
        await this.raw.query("SET SESSION TRANSACTION READ ONLY");
        await this.raw.query("START TRANSACTION");
    }
    async close() {
        await this.raw.end();
    }
}
const mysqlDialect = {
    id: "mysql",
    quoteId: mysqlQuote,
    async connect(source, secret, database) {
        const mysql = await import("mysql2/promise");
        const conn = await mysql.default.createConnection({
            host: source.host,
            port: Number(source.port ?? 3306),
            user: source.username,
            password: secret,
            ...(database ? { database } : {}),
            charset: "utf8mb4",
            connectTimeout: Number(source.connect_timeout_seconds ?? 8) * 1000,
            multipleStatements: false,
            dateStrings: true,
        });
        return new MysqlConn(conn);
    },
    async serverMetadata(conn) {
        const rows = await conn.query(`
      SELECT VERSION() AS version,
        @@version_comment AS version_comment,
        @@character_set_server AS character_set_server,
        @@collation_server AS collation_server,
        @@time_zone AS time_zone,
        @@system_time_zone AS system_time_zone,
        @@sql_mode AS sql_mode,
        @@lower_case_table_names AS lower_case_table_names
    `);
        return rows[0] ?? {};
    },
    async listDatabases(conn) {
        const rows = await conn.query("SHOW DATABASES");
        return rows.map((row) => String(Object.values(row)[0])).sort();
    },
    async tables(conn, databases) {
        const ph = databases.map(() => "?").join(",");
        const rows = await conn.query(`SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_COMMENT, TABLE_ROWS, UPDATE_TIME
       FROM information_schema.TABLES WHERE TABLE_SCHEMA IN (${ph})`, databases);
        return rows.map((r) => ({
            database: String(r.TABLE_SCHEMA),
            table: String(r.TABLE_NAME),
            table_type: String(r.TABLE_TYPE ?? ""),
            comment: String(r.TABLE_COMMENT ?? ""),
            estimated_rows: r.TABLE_ROWS === null ? null : Number(r.TABLE_ROWS),
            update_at: r.UPDATE_TIME ?? null,
        }));
    },
    async columns(conn, databases) {
        const ph = databases.map(() => "?").join(",");
        const rows = await conn.query(`SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_DEFAULT,
         IS_NULLABLE, DATA_TYPE, COLUMN_TYPE, COLUMN_COMMENT, COLUMN_KEY, EXTRA
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA IN (${ph})
       ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`, databases);
        return rows.map((r) => ({
            database: String(r.TABLE_SCHEMA),
            table: String(r.TABLE_NAME),
            name: String(r.COLUMN_NAME),
            ordinal: Number(r.ORDINAL_POSITION),
            data_type: String(r.DATA_TYPE ?? ""),
            native_type: String(r.COLUMN_TYPE ?? ""),
            nullable: r.IS_NULLABLE === "YES",
            default: r.COLUMN_DEFAULT ?? null,
            comment: String(r.COLUMN_COMMENT ?? ""),
            primary_key: r.COLUMN_KEY === "PRI",
            extra: String(r.EXTRA ?? ""),
        }));
    },
    async indexes(conn, databases) {
        const ph = databases.map(() => "?").join(",");
        const rows = await conn.query(`SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA IN (${ph})
       ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, databases);
        return rows.map((r) => ({
            database: String(r.TABLE_SCHEMA),
            table: String(r.TABLE_NAME),
            name: String(r.INDEX_NAME),
            unique: !Number(r.NON_UNIQUE),
            seq: Number(r.SEQ_IN_INDEX),
            column: String(r.COLUMN_NAME),
        }));
    },
    async foreignKeys(conn, databases) {
        const ph = databases.map(() => "?").join(",");
        const rows = await conn.query(`SELECT TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME,
         REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, ORDINAL_POSITION
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA IN (${ph}) AND REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`, databases);
        return rows.map((r) => ({
            database: String(r.TABLE_SCHEMA),
            table: String(r.TABLE_NAME),
            name: String(r.CONSTRAINT_NAME),
            column: String(r.COLUMN_NAME),
            ref_database: String(r.REFERENCED_TABLE_SCHEMA ?? ""),
            ref_table: String(r.REFERENCED_TABLE_NAME ?? ""),
            ref_column: String(r.REFERENCED_COLUMN_NAME ?? ""),
            ordinal: Number(r.ORDINAL_POSITION),
        }));
    },
    latestValueSql(database, table, column, timeoutMs) {
        return `SELECT /*+ MAX_EXECUTION_TIME(${timeoutMs}) */ ${mysqlQuote(column)} AS latest_value
      FROM ${mysqlQuote(database)}.${mysqlQuote(table)}
      WHERE ${mysqlQuote(column)} IS NOT NULL
      ORDER BY ${mysqlQuote(column)} DESC LIMIT 1`;
    },
    recentExistsSql(database, table, columns, timeoutMs) {
        const conditions = columns.map((c) => `${mysqlQuote(c)} >= ?`).join(" OR ");
        return {
            sql: `SELECT /*+ MAX_EXECUTION_TIME(${timeoutMs}) */
        EXISTS(
          SELECT 1 FROM ${mysqlQuote(database)}.${mysqlQuote(table)}
          WHERE ${conditions} LIMIT 1
        ) AS has_recent_data`,
            params: columns.map(() => null),
        };
    },
    distinctSql(database, table, column, limit, timeoutMs) {
        return `SELECT /*+ MAX_EXECUTION_TIME(${timeoutMs}) */ DISTINCT ${mysqlQuote(column)} AS v
      FROM ${mysqlQuote(database)}.${mysqlQuote(table)}
      WHERE ${mysqlQuote(column)} IS NOT NULL
      LIMIT ${limit + 1}`;
    },
};
// ── PostgreSQL ─────────────────────────────────────────────────────────────────
function pgQuote(value) {
    return `"${value.replaceAll('"', '""')}"`;
}
/**
 * In PostgreSQL a "database" is a separate catalog you connect to; cross-database
 * queries aren't supported on one connection. Easy BI's "databases" list maps to
 * PostgreSQL SCHEMAS within the connection's database (the common multi-tenant
 * layout), so schema discovery filters by table_schema and the qualified name is
 * schema.table. The connection's database name comes from the profile.
 */
class PgConn {
    client;
    constructor(client) {
        this.client = client;
    }
    async query(sql, params) {
        const res = await this.client.query(sql, params ?? []);
        return res.rows;
    }
    async beginReadOnly() {
        await this.client.query("BEGIN TRANSACTION READ ONLY");
    }
    async close() {
        await this.client.end();
    }
}
const pgDialect = {
    id: "postgresql",
    quoteId: pgQuote,
    async connect(source, secret, database) {
        const pg = await import("pg");
        const client = new pg.default.Client({
            host: source.host,
            port: Number(source.port ?? 5432),
            user: source.username,
            password: secret,
            database: database ?? source.database ?? source.databases?.[0],
            connectionTimeoutMillis: Number(source.connect_timeout_seconds ?? 8) * 1000,
        });
        await client.connect();
        return new PgConn(client);
    },
    async serverMetadata(conn) {
        const rows = await conn.query(`SELECT version() AS version,
        current_setting('server_version') AS server_version,
        current_setting('server_encoding') AS server_encoding,
        current_setting('TimeZone') AS time_zone`);
        return rows[0] ?? {};
    },
    async listDatabases(conn) {
        // Easy BI "databases" == schemas here; list non-system schemas.
        const rows = await conn.query(`SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog','information_schema')
         AND schema_name NOT LIKE 'pg_%'
       ORDER BY schema_name`);
        return rows.map((r) => String(r.schema_name)).sort();
    },
    async tables(conn, databases) {
        const ph = databases.map((_, i) => `$${i + 1}`).join(",");
        const rows = await conn.query(`SELECT t.table_schema, t.table_name, t.table_type,
         obj_description(c.oid) AS table_comment,
         c.reltuples::bigint AS est_rows
       FROM information_schema.tables t
       JOIN pg_namespace n ON n.nspname = t.table_schema
       JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid
       WHERE t.table_schema IN (${ph})`, databases);
        return rows.map((r) => ({
            database: String(r.table_schema),
            table: String(r.table_name),
            table_type: String(r.table_type ?? ""),
            comment: String(r.table_comment ?? ""),
            estimated_rows: r.est_rows === null ? null : Number(r.est_rows),
            update_at: null,
        }));
    },
    async columns(conn, databases) {
        const ph = databases.map((_, i) => `$${i + 1}`).join(",");
        const rows = await conn.query(`SELECT c.table_schema, c.table_name, c.column_name, c.ordinal_position,
         c.column_default, c.is_nullable, c.data_type, c.udt_name,
         col_description(fc.oid, c.ordinal_position::int) AS column_comment,
         CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS column_key
       FROM information_schema.columns c
       JOIN pg_namespace n ON n.nspname = c.table_schema
       JOIN pg_class fc ON fc.relname = c.table_name AND fc.relnamespace = n.oid
       LEFT JOIN (
         SELECT kcu.table_schema, kcu.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
          AND kcu.table_schema = tc.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY'
       ) pk ON pk.table_schema = c.table_schema AND pk.table_name = c.table_name
           AND pk.column_name = c.column_name
       WHERE c.table_schema IN (${ph})
       ORDER BY c.table_schema, c.table_name, c.ordinal_position`, databases);
        return rows.map((r) => ({
            database: String(r.table_schema),
            table: String(r.table_name),
            name: String(r.column_name),
            ordinal: Number(r.ordinal_position),
            data_type: String(r.data_type ?? ""),
            native_type: String(r.udt_name ?? r.data_type ?? ""),
            nullable: r.is_nullable === "YES",
            default: r.column_default ?? null,
            comment: String(r.column_comment ?? ""),
            primary_key: r.column_key === "PRI",
            extra: "",
        }));
    },
    async indexes(conn, databases) {
        const ph = databases.map((_, i) => `$${i + 1}`).join(",");
        const rows = await conn.query(`SELECT n.nspname AS table_schema, t.relname AS table_name,
         i.relname AS index_name, ix.indisunique AS is_unique,
         a.attname AS column_name, k.ord AS seq
       FROM pg_class t
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_index ix ON ix.indrelid = t.oid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
       WHERE n.nspname IN (${ph})
       ORDER BY table_schema, table_name, index_name, seq`, databases);
        return rows.map((r) => ({
            database: String(r.table_schema),
            table: String(r.table_name),
            name: String(r.index_name),
            unique: Boolean(r.is_unique),
            seq: Number(r.seq),
            column: String(r.column_name),
        }));
    },
    async foreignKeys(conn, databases) {
        const ph = databases.map((_, i) => `$${i + 1}`).join(",");
        const rows = await conn.query(`SELECT tc.table_schema, tc.table_name, tc.constraint_name,
         kcu.column_name, kcu.ordinal_position,
         ccu.table_schema AS ref_schema, ccu.table_name AS ref_table, ccu.column_name AS ref_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema IN (${ph})
       ORDER BY tc.table_schema, tc.table_name, tc.constraint_name, kcu.ordinal_position`, databases);
        return rows.map((r) => ({
            database: String(r.table_schema),
            table: String(r.table_name),
            name: String(r.constraint_name),
            column: String(r.column_name),
            ref_database: String(r.ref_schema ?? ""),
            ref_table: String(r.ref_table ?? ""),
            ref_column: String(r.ref_column ?? ""),
            ordinal: Number(r.ordinal_position),
        }));
    },
    latestValueSql(database, table, column, _timeoutMs) {
        return `SELECT ${pgQuote(column)} AS latest_value
      FROM ${pgQuote(database)}.${pgQuote(table)}
      WHERE ${pgQuote(column)} IS NOT NULL
      ORDER BY ${pgQuote(column)} DESC LIMIT 1`;
    },
    recentExistsSql(database, table, columns, _timeoutMs) {
        const conditions = columns.map((c, i) => `${pgQuote(c)} >= $${i + 1}`).join(" OR ");
        return {
            sql: `SELECT EXISTS(
          SELECT 1 FROM ${pgQuote(database)}.${pgQuote(table)}
          WHERE ${conditions} LIMIT 1
        ) AS has_recent_data`,
            params: columns.map(() => null),
        };
    },
    distinctSql(database, table, column, limit, _timeoutMs) {
        return `SELECT DISTINCT ${pgQuote(column)} AS v
      FROM ${pgQuote(database)}.${pgQuote(table)}
      WHERE ${pgQuote(column)} IS NOT NULL
      LIMIT ${limit + 1}`;
    },
};
const DIALECTS = {
    mysql: mysqlDialect,
    postgresql: pgDialect,
    postgres: pgDialect,
    pg: pgDialect,
};
/** Resolve a dialect by connector_id/engine; throws for unknown engines. */
export function getDialect(engine) {
    const dialect = DIALECTS[String(engine ?? "").toLowerCase()];
    if (!dialect) {
        throw new Error(`Unsupported database connector: ${engine}`);
    }
    return dialect;
}
export function isSupportedEngine(engine) {
    return Boolean(DIALECTS[String(engine ?? "").toLowerCase()]);
}
/**
 * PostgreSQL enforces the statement timeout via a session GUC rather than a query
 * hint. Callers set it once after connecting when the engine needs it.
 */
export async function applyStatementTimeout(dialect, conn, timeoutMs) {
    if (dialect.id === "postgresql") {
        await conn.query(`SET statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
    }
}
//# sourceMappingURL=dialect.js.map