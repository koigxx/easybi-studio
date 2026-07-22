import type Database from 'better-sqlite3';
import type { Job, JobEvent } from '@easybi-studio/contracts';

/**
 * Persist Job records to Studio SQLite (registration + task state only, plan §10.7).
 * On restart, in-flight jobs are reconciled: Studio does NOT auto-restart unknown
 * agent processes; it marks previously-active jobs as FAILED (interrupted).
 */

interface JobRow {
  id: string;
  project_id: string;
  type: string;
  status: string;
  agent_provider: string | null;
  session_id: string | null;
  phase: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  log_file: string | null;
  error: string | null;
  exit_code: number | null;
  checkpoint_id: string | null;
  undoable: number | null;
}

export class JobStore {
  constructor(private readonly db: Database.Database) {}

  upsert(job: Job): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, project_id, type, status, agent_provider, session_id, phase,
           created_at, started_at, finished_at, log_file, error, exit_code, checkpoint_id, undoable)
         VALUES (@id, @project_id, @type, @status, @agent_provider, @session_id, @phase,
           @created_at, @started_at, @finished_at, @log_file, @error, @exit_code, @checkpoint_id, @undoable)
         ON CONFLICT(id) DO UPDATE SET
           status=excluded.status, session_id=excluded.session_id, phase=excluded.phase,
           finished_at=excluded.finished_at, error=excluded.error, exit_code=excluded.exit_code,
           checkpoint_id=excluded.checkpoint_id, undoable=excluded.undoable`,
      )
      .run({
        id: job.id,
        project_id: job.projectId,
        type: job.type,
        status: job.status,
        agent_provider: job.agentProvider ?? null,
        session_id: job.sessionId ?? null,
        phase: job.phase ?? null,
        created_at: job.createdAt,
        started_at: job.startedAt ?? null,
        finished_at: job.finishedAt ?? null,
        log_file: job.logFile ?? null,
        error: job.error ?? null,
        exit_code: job.exitCode ?? null,
        checkpoint_id: job.checkpointId ?? null,
        undoable: job.undoable ? 1 : 0,
      });
  }

  list(projectId?: string): Job[] {
    const rows = (
      projectId
        ? this.db.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
        : this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all()
    ) as JobRow[];
    return rows.map(rowToJob);
  }

  get(jobId: string): Job | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
    return row ? rowToJob(row) : undefined;
  }

  /** Append one conversation event (append-only log; seq is caller-assigned). */
  appendEvent(jobId: string, seq: number, event: JobEvent): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO job_events (job_id, seq, type, at, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(jobId, seq, event.type, event.at, event.payload ? JSON.stringify(event.payload) : null);
  }

  /** Delete a job and its conversation event log (cascade). */
  deleteJob(jobId: string): void {
    // job_events has ON DELETE CASCADE, but delete explicitly to be robust
    // regardless of PRAGMA foreign_keys state.
    this.db.prepare('DELETE FROM job_events WHERE job_id = ?').run(jobId);
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
  }

  /** Load a job's full conversation event log in order. */
  listEvents(jobId: string): JobEvent[] {
    const rows = this.db
      .prepare('SELECT type, at, payload_json FROM job_events WHERE job_id = ? ORDER BY seq ASC')
      .all(jobId) as Array<{ type: string; at: string; payload_json: string | null }>;
    return rows.map((r) => ({
      type: r.type as JobEvent['type'],
      jobId,
      at: r.at,
      ...(r.payload_json ? { payload: JSON.parse(r.payload_json) as Record<string, unknown> } : {}),
    }));
  }

  /**
   * Reconcile interrupted jobs on startup. Studio never silently resumes an
   * unknown process, so no process is relaunched here. But to support reopening
   * a chat after restart, a job that has a saved Claude session_id is left in a
   * terminal-but-resumable SUCCEEDED state (the user can continue it, which
   * spawns a fresh --resume process on demand); a job with no session to resume
   * is marked FAILED (interrupted). The conversation event log is preserved
   * either way.
   */
  reconcileOnStartup(): number {
    const now = new Date().toISOString();
    const resumable = this.db
      .prepare(
        `UPDATE jobs SET status='SUCCEEDED', finished_at=COALESCE(finished_at, ?)
         WHERE status IN ('QUEUED','RUNNING','WAITING_FOR_USER') AND session_id IS NOT NULL`,
      )
      .run(now);
    const dead = this.db
      .prepare(
        `UPDATE jobs SET status='FAILED', error='Studio 重启前任务处于进行中，未自动恢复',
         finished_at=? WHERE status IN ('QUEUED','RUNNING','WAITING_FOR_USER') AND session_id IS NULL`,
      )
      .run(now);
    return resumable.changes + dead.changes;
  }
}

function rowToJob(r: JobRow): Job {
  const job: Job = {
    id: r.id,
    projectId: r.project_id,
    type: r.type as Job['type'],
    status: r.status as Job['status'],
    createdAt: r.created_at,
  };
  if (r.agent_provider) job.agentProvider = r.agent_provider;
  if (r.session_id) job.sessionId = r.session_id;
  if (r.phase) job.phase = r.phase;
  if (r.started_at) job.startedAt = r.started_at;
  if (r.finished_at) job.finishedAt = r.finished_at;
  if (r.error) job.error = r.error;
  if (r.exit_code !== null) job.exitCode = r.exit_code;
  if (r.checkpoint_id) job.checkpointId = r.checkpoint_id;
  job.undoable = r.undoable === 1;
  return job;
}
