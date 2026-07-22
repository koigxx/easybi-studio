import type Database from 'better-sqlite3';
import type { AgentRun, Job, JobEvent } from '@easybi-studio/contracts';

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
  current_run_id: string | null;
  report_id: string | null;
  report_revision: string | null;
}

export class JobStore {
  constructor(private readonly db: Database.Database) {}

  upsert(job: Job): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, project_id, type, status, agent_provider, session_id, phase, current_run_id, report_id, report_revision,
           created_at, started_at, finished_at, log_file, error, exit_code, checkpoint_id, undoable)
         VALUES (@id, @project_id, @type, @status, @agent_provider, @session_id, @phase, @current_run_id, @report_id, @report_revision,
           @created_at, @started_at, @finished_at, @log_file, @error, @exit_code, @checkpoint_id, @undoable)
         ON CONFLICT(id) DO UPDATE SET
           status=excluded.status, session_id=excluded.session_id, phase=excluded.phase,
           current_run_id=excluded.current_run_id, report_id=excluded.report_id, report_revision=excluded.report_revision,
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
        current_run_id: job.currentRunId ?? null,
        report_id: job.reportId ?? null,
        report_revision: job.reportRevision ?? null,
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
        `INSERT OR IGNORE INTO job_events (job_id, seq, type, at, payload_json, run_id, phase)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        jobId,
        seq,
        event.type,
        event.at,
        event.payload ? JSON.stringify(event.payload) : null,
        typeof event.payload?.runId === 'string' ? event.payload.runId : null,
        typeof event.payload?.phase === 'string' ? event.payload.phase : null,
      );
  }

  upsertRun(run: AgentRun): void {
    this.db.prepare(
      `INSERT INTO agent_runs (id, conversation_id, phase, provider_task_id, provider_session_id,
         context_mode, status, model_revision, model_hash, unit_id, report_revision, checkpoint_id, created_at, started_at, finished_at)
       VALUES (@id, @conversation_id, @phase, @provider_task_id, @provider_session_id,
         @context_mode, @status, @model_revision, @model_hash, @unit_id, @report_revision, @checkpoint_id, @created_at, @started_at, @finished_at)
       ON CONFLICT(id) DO UPDATE SET provider_session_id=excluded.provider_session_id,
         status=excluded.status, model_revision=excluded.model_revision, model_hash=excluded.model_hash,
         unit_id=excluded.unit_id, report_revision=excluded.report_revision,
         checkpoint_id=excluded.checkpoint_id, finished_at=excluded.finished_at`,
    ).run({
      id: run.id,
      conversation_id: run.conversationId,
      phase: run.phase ?? null,
      provider_task_id: run.providerTaskId,
      provider_session_id: run.providerSessionId ?? null,
      context_mode: run.contextMode,
      status: run.status,
      model_revision: run.modelRevision ?? null,
      model_hash: run.modelHash ?? null,
      unit_id: run.unitId ?? null,
      report_revision: run.reportRevision ?? null,
      checkpoint_id: run.checkpointId ?? null,
      created_at: run.createdAt,
      started_at: run.startedAt ?? null,
      finished_at: run.finishedAt ?? null,
    });
  }

  listRuns(conversationId: string): AgentRun[] {
    const rows = this.db.prepare(
      'SELECT * FROM agent_runs WHERE conversation_id = ? ORDER BY created_at ASC',
    ).all(conversationId) as Array<Record<string, string | null>>;
    return rows.map((row) => ({
      id: String(row.id),
      conversationId: String(row.conversation_id),
      ...(row.phase ? { phase: row.phase as AgentRun['phase'] } : {}),
      providerTaskId: String(row.provider_task_id),
      ...(row.provider_session_id ? { providerSessionId: row.provider_session_id } : {}),
      contextMode: row.context_mode as AgentRun['contextMode'],
      status: row.status as AgentRun['status'],
      ...(row.model_revision ? { modelRevision: row.model_revision } : {}),
      ...(row.model_hash ? { modelHash: row.model_hash } : {}),
      ...(row.unit_id ? { unitId: row.unit_id } : {}),
      ...(row.report_revision ? { reportRevision: row.report_revision } : {}),
      ...(row.checkpoint_id ? { checkpointId: row.checkpoint_id } : {}),
      createdAt: String(row.created_at),
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    }));
  }

  /** Delete a job and its conversation event log (cascade). */
  deleteJob(jobId: string): void {
    // job_events has ON DELETE CASCADE, but delete explicitly to be robust
    // regardless of PRAGMA foreign_keys state.
    this.db.prepare('DELETE FROM job_events WHERE job_id = ?').run(jobId);
    this.db.prepare('DELETE FROM agent_runs WHERE conversation_id = ?').run(jobId);
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
    // A provider process that was active before restart no longer exists. Keep
    // the logical conversation resumable when it has a session, but close the
    // historical run honestly instead of leaving a permanent RUNNING record.
    this.db
      .prepare(
        `UPDATE agent_runs SET status='FAILED', finished_at=COALESCE(finished_at, ?)
         WHERE status IN ('QUEUED','RUNNING','WAITING_FOR_USER')`,
      )
      .run(now);
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
  if (r.phase) job.phase = r.phase as Job['phase'];
  if (r.current_run_id) job.currentRunId = r.current_run_id;
  if (r.report_id) job.reportId = r.report_id;
  if (r.report_revision) job.reportRevision = r.report_revision;
  if (r.started_at) job.startedAt = r.started_at;
  if (r.finished_at) job.finishedAt = r.finished_at;
  if (r.error) job.error = r.error;
  if (r.exit_code !== null) job.exitCode = r.exit_code;
  if (r.checkpoint_id) job.checkpointId = r.checkpoint_id;
  job.undoable = r.undoable === 1;
  return job;
}
