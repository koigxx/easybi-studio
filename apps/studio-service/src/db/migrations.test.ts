import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';

describe('migrations', () => {
  it('creates tables and is idempotent when re-run', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    runMigrations(db); // second run must be a no-op, not an error

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);

    expect(tables).toContain('projects');
    expect(tables).toContain('jobs');
    expect(tables).toContain('ui_state');
    expect(tables).toContain('schema_migrations');

    const applied = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as {
      n: number;
    };
    // Migration ids are recorded once each despite two runs (idempotent).
    const distinct = db.prepare('SELECT COUNT(DISTINCT id) AS n FROM schema_migrations').get() as {
      n: number;
    };
    expect(applied.n).toBe(distinct.n);
    expect(applied.n).toBeGreaterThanOrEqual(2);
    expect(tables).toContain('report_tests');
    expect(tables).toContain('job_events');
    db.close();
  });
});
