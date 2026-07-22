/**
 * MySQL connection-test adapter boundary (plan §10.2, stage 3 note).
 *
 * Stage 3 only validates configuration structure. A FAKE adapter is used so the
 * flow works without a real database. A real adapter (read-only, no DDL/DML) is
 * introduced only when the user provides real connection info in a later stage.
 */

export interface MysqlProfileInput {
  host: string;
  port: number;
  username: string;
  databases: string[];
  /** Never logged. */
  password?: string;
  passwordEnv?: string;
  /** Database engine (connector_id). Defaults to 'mysql' for back-compat. */
  engine?: string;
}

/** Normalize a connector_id/engine string to a supported engine key. */
export function normalizeEngine(engine?: string): 'mysql' | 'postgresql' {
  const e = String(engine ?? 'mysql').toLowerCase();
  if (e === 'postgres' || e === 'postgresql' || e === 'pg') return 'postgresql';
  return 'mysql';
}

export interface MysqlTestResult {
  profileId: string;
  reachable: boolean;
  /** Databases the adapter reports visible. */
  visibleDatabases: string[];
  /** Chinese note (secret-free). */
  note: string;
  /** Adapter kind so callers/UI can label fake vs real. */
  adapter: 'fake' | 'real';
}

export interface MysqlAdapter {
  readonly kind: 'fake' | 'real';
  testConnection(profileId: string, input: MysqlProfileInput): Promise<MysqlTestResult>;
}

/** Structural checks shared by fake and real adapters. Returns Chinese problems. */
function structuralProblems(input: MysqlProfileInput): string[] {
  const problems: string[] = [];
  if (!input.host) problems.push('缺少 host');
  if (!input.port || input.port < 1 || input.port > 65535) problems.push('端口无效');
  if (!input.username) problems.push('缺少 username');
  if (!input.password && !input.passwordEnv) problems.push('缺少 password 或 password_env');
  if (!Array.isArray(input.databases) || input.databases.length === 0) {
    problems.push('未选择任何数据库');
  }
  return problems;
}

/**
 * Fake adapter: performs only structural validation of the profile and reports a
 * deterministic result. It NEVER opens a network connection and never echoes the
 * password.
 */
export class FakeMysqlAdapter implements MysqlAdapter {
  readonly kind = 'fake' as const;

  async testConnection(profileId: string, input: MysqlProfileInput): Promise<MysqlTestResult> {
    const problems = structuralProblems(input);

    if (problems.length > 0) {
      return {
        profileId,
        reachable: false,
        visibleDatabases: [],
        note: `配置结构不完整：${problems.join('，')}`,
        adapter: 'fake',
      };
    }
    return {
      profileId,
      reachable: true,
      visibleDatabases: [...input.databases],
      note: '结构校验通过（假 Adapter，未进行真实连接）',
      adapter: 'fake',
    };
  }
}

/** Resolve a password from the profile, preferring an explicit value over env. */
function resolvePassword(input: MysqlProfileInput): string | undefined {
  if (typeof input.password === 'string' && input.password.length > 0) return input.password;
  if (input.passwordEnv) {
    const fromEnv = process.env[input.passwordEnv];
    if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  }
  return undefined;
}

/** Strip anything secret-looking from a driver error before it reaches a user. */
function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // mysql2 error messages do not contain the password, but be defensive and keep
  // it short — never echo a stack or connection string.
  return raw.replace(/\s+/g, ' ').slice(0, 200);
}

export interface RealMysqlAdapterOptions {
  /** Connection + query timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * Real adapter: opens a short-lived READ-ONLY connection to verify reachability.
 * It runs only `SELECT 1` and `SHOW DATABASES` — never any DDL or DML. The
 * password is used only to connect and is never returned or logged.
 */
export class RealMysqlAdapter implements MysqlAdapter {
  readonly kind = 'real' as const;
  private readonly timeoutMs: number;

  constructor(options: RealMysqlAdapterOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async testConnection(profileId: string, input: MysqlProfileInput): Promise<MysqlTestResult> {
    const problems = structuralProblems(input);
    if (problems.length > 0) {
      return {
        profileId,
        reachable: false,
        visibleDatabases: [],
        note: `配置结构不完整：${problems.join('，')}`,
        adapter: 'real',
      };
    }

    const password = resolvePassword(input);
    if (!password) {
      return {
        profileId,
        reachable: false,
        visibleDatabases: [],
        note: input.passwordEnv
          ? `环境变量 ${input.passwordEnv} 未设置或为空`
          : '缺少密码',
        adapter: 'real',
      };
    }

    try {
      const engine = normalizeEngine(input.engine);
      const serverDatabases =
        engine === 'postgresql'
          ? await this.probePostgres(input, password)
          : await this.probeMysql(input, password);

      const requested = input.databases;
      const visible = requested.filter((d) => serverDatabases.includes(d));
      const missing = requested.filter((d) => !serverDatabases.includes(d));

      const note =
        missing.length === 0
          ? `连接成功，请求的 ${requested.length} 个数据库均可见`
          : `连接成功，但以下数据库不可见：${missing.join('，')}`;

      return {
        profileId,
        reachable: true,
        visibleDatabases: visible,
        note,
        adapter: 'real',
      };
    } catch (err) {
      return {
        profileId,
        reachable: false,
        visibleDatabases: [],
        note: `连接失败：${sanitizeError(err)}`,
        adapter: 'real',
      };
    }
  }

  /** MySQL: read-only SELECT 1 + SHOW DATABASES. Driver loaded on demand. */
  private async probeMysql(input: MysqlProfileInput, password: string): Promise<string[]> {
    const mysql = await import('mysql2/promise');
    let connection: Awaited<ReturnType<typeof mysql.createConnection>> | undefined;
    try {
      connection = await mysql.createConnection({
        host: input.host,
        port: input.port,
        user: input.username,
        password,
        connectTimeout: this.timeoutMs,
        multipleStatements: false,
      });
      await connection.query('SELECT 1');
      const [rows] = await connection.query('SHOW DATABASES');
      return Array.isArray(rows)
        ? (rows as Array<Record<string, unknown>>).map((r) => String(Object.values(r)[0] ?? ''))
        : [];
    } finally {
      if (connection) {
        try {
          await connection.end();
        } catch {
          // ignore close errors
        }
      }
    }
  }

  /**
   * PostgreSQL: connect and list non-system SCHEMAS in the connection's database
   * (Easy BI's "databases" list maps to PostgreSQL schemas). Read-only: only
   * SELECT against information_schema. Driver loaded on demand.
   */
  private async probePostgres(input: MysqlProfileInput, password: string): Promise<string[]> {
    const pg = await import('pg');
    const client = new pg.default.Client({
      host: input.host,
      port: input.port,
      user: input.username,
      password,
      // Connect to the first requested database (a schema-holding catalog).
      database: input.databases[0],
      connectionTimeoutMillis: this.timeoutMs,
      statement_timeout: this.timeoutMs,
    });
    await client.connect();
    try {
      const res = await client.query(
        `SELECT schema_name FROM information_schema.schemata
         WHERE schema_name NOT IN ('pg_catalog','information_schema') AND schema_name NOT LIKE 'pg_%'`,
      );
      return res.rows.map((r: Record<string, unknown>) => String(r.schema_name ?? ''));
    } finally {
      try {
        await client.end();
      } catch {
        // ignore close errors
      }
    }
  }
}
