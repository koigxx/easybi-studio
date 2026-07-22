import type Database from 'better-sqlite3';

/**
 * Idempotent schema migrations. Each migration has a stable id; applied ids are
 * recorded in `schema_migrations`. Re-running is a no-op (stage 1 exit criteria).
 */
interface Migration {
  id: string;
  up: string;
}

const MIGRATIONS: Migration[] = [
  {
    id: '0001_init',
    up: `
      CREATE TABLE IF NOT EXISTS projects (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        workspace_root TEXT NOT NULL UNIQUE,
        skill_source_type TEXT,
        bundle_version TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id             TEXT PRIMARY KEY,
        project_id     TEXT NOT NULL,
        type           TEXT NOT NULL,
        status         TEXT NOT NULL,
        agent_provider TEXT,
        session_id     TEXT,
        phase          TEXT,
        created_at     TEXT NOT NULL,
        started_at     TEXT,
        finished_at    TEXT,
        log_file       TEXT,
        error          TEXT,
        exit_code      INTEGER,
        checkpoint_id  TEXT,
        undoable       INTEGER,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS ui_state (
        project_id TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT,
        PRIMARY KEY (project_id, key),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
    `,
  },
  {
    id: '0002_report_tests',
    up: `
      CREATE TABLE IF NOT EXISTS report_tests (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL,
        report_id     TEXT NOT NULL,
        report_version TEXT,
        test_type     TEXT NOT NULL,
        filters_json  TEXT,
        created_at    TEXT NOT NULL,
        row_count     INTEGER,
        sheet_count   INTEGER,
        file_bytes    INTEGER,
        query_ms      INTEGER,
        total_ms      INTEGER,
        output_file   TEXT,
        ok            INTEGER,
        error         TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
    `,
  },
  {
    // Persist the conversation event log so a chat survives Studio restart and can
    // be reopened and continued (like Claude Code history). Append-only; one row
    // per normalized JobEvent, ordered by (job_id, seq).
    id: '0003_job_events',
    up: `
      CREATE TABLE IF NOT EXISTS job_events (
        job_id       TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        type         TEXT NOT NULL,
        at           TEXT NOT NULL,
        payload_json TEXT,
        PRIMARY KEY (job_id, seq),
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, seq);
    `,
  },
  {
    id: '0004_agent_runs',
    up: `
      ALTER TABLE jobs ADD COLUMN current_run_id TEXT;
      ALTER TABLE job_events ADD COLUMN run_id TEXT;
      ALTER TABLE job_events ADD COLUMN phase TEXT;

      CREATE TABLE IF NOT EXISTS agent_runs (
        id                  TEXT PRIMARY KEY,
        conversation_id     TEXT NOT NULL,
        phase               TEXT,
        provider_task_id    TEXT NOT NULL,
        provider_session_id TEXT,
        context_mode        TEXT NOT NULL,
        status              TEXT NOT NULL,
        model_revision      TEXT,
        model_hash          TEXT,
        checkpoint_id       TEXT,
        created_at          TEXT NOT NULL,
        started_at          TEXT,
        finished_at         TEXT,
        FOREIGN KEY (conversation_id) REFERENCES jobs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation
        ON agent_runs(conversation_id, created_at);
    `,
  },
  {
    id: '0005_job_report_scope',
    up: `ALTER TABLE jobs ADD COLUMN report_id TEXT;`,
  },
  {
    id: '0006_report_build_revisions',
    up: `
      ALTER TABLE jobs ADD COLUMN report_revision TEXT;
      ALTER TABLE agent_runs ADD COLUMN unit_id TEXT;
      ALTER TABLE agent_runs ADD COLUMN report_revision TEXT;
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set<string>(
    db
      .prepare('SELECT id FROM schema_migrations')
      .all()
      .map((r) => (r as { id: string }).id),
  );

  const insert = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');

  const apply = db.transaction((migration: Migration) => {
    db.exec(migration.up);
    insert.run(migration.id, new Date().toISOString());
  });

  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.id)) {
      apply(migration);
    }
  }
}
