import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runMigrations } from './migrations.js';

/**
 * Studio SQLite database.
 *
 * Stores ONLY project registration, jobs, and UI state — never workspace
 * business facts (knowledge, reports, outputs). Migrations are idempotent and
 * safe to run repeatedly (plan stage 1 exit criteria).
 */
export interface StudioDb {
  readonly raw: Database.Database;
  close(): void;
}

export function openDatabase(filePath: string): StudioDb {
  if (filePath !== ':memory:') {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const raw = new Database(filePath);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  runMigrations(raw);
  return {
    raw,
    close() {
      raw.close();
    },
  };
}
