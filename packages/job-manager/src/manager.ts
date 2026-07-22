import { EventEmitter } from 'node:events';
import type {
  AgentBridge,
  AgentActionType,
  Job,
  JobEvent,
  JobStatus,
} from '@easybi-studio/contracts';
import { canTransition, JobEventTypes } from '@easybi-studio/contracts';
import { AsyncEventQueue } from '@easybi-studio/agent-bridge';
import { normalizeAgentEvent, statusFromAgentEvent } from './normalize.js';

export class WriteTaskConflictError extends Error {
  readonly code = 'WRITE_TASK_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'WriteTaskConflictError';
  }
}

/** Actions that write files -> subject to per-workspace mutex. */
const WRITE_ACTIONS = new Set<AgentActionType>([
  'initialize-knowledge',
  'continue-knowledge',
  'rescan-knowledge',
  'review-enums',
  'publish-knowledge',
  'create-report',
  'modify-report',
]);

interface JobRecord {
  job: Job;
  events: JobEvent[];
  emitter: EventEmitter;
  /** Context kept so a follow-up reply can re-pump a resumed conversation turn. */
  workspaceRoot: string;
  isWrite: boolean;
  checkpointId?: string;
  /** True while a pump loop is actively consuming this task's event stream. */
  pumping: boolean;
}

export interface StartJobInput {
  projectId: string;
  workspaceRoot: string;
  action: AgentActionType;
  prompt: string;
}

export interface CheckpointHook {
  /** Create a checkpoint before a write job; returns a checkpoint id. */
  before(input: { projectId: string; workspaceRoot: string; jobId: string }): Promise<string>;
  /** Produce a change summary after a write job terminates. */
  after(input: {
    projectId: string;
    workspaceRoot: string;
    jobId: string;
    checkpointId: string;
  }): Promise<void>;
}

/** Persistence for the conversation event log, so chats survive restart. */
export interface EventStore {
  /** Append one event to a job's ordered log. */
  appendEvent(jobId: string, seq: number, event: JobEvent): void;
  /** Load a job's full event log in order (used to reopen a past chat). */
  listEvents(jobId: string): JobEvent[];
  /** Look up a persisted job by id (used to reopen a chat not in memory). */
  get(jobId: string): Job | undefined;
  /** Delete a job and its event log (used to delete a chat from history). */
  deleteJob(jobId: string): void;
}

export class JobActiveError extends Error {
  readonly code = 'JOB_ACTIVE';
  constructor(message: string) {
    super(message);
    this.name = 'JobActiveError';
  }
}

export interface JobManagerOptions {
  bridge: AgentBridge;
  /** Called when a job transitions, for persistence (optional). */
  onJobChange?: (job: Job) => void;
  /** Optional checkpoint hook for write tasks (plan §10.10). */
  checkpoint?: CheckpointHook;
  /** Optional event log persistence; enables reopening chats after restart. */
  events?: EventStore;
}

/**
 * JobManager owns Job lifecycle and normalizes provider events into JobEvents.
 * Enforces one active write task per workspace (plan §13, §17).
 */
export class JobManager {
  private jobs = new Map<string, JobRecord>();
  /** taskId -> jobId */
  private taskToJob = new Map<string, string>();
  /** workspaceRoot -> active write jobId */
  private activeWriteByWorkspace = new Map<string, string>();
  private readonly bridge: AgentBridge;
  private readonly onJobChange?: (job: Job) => void;
  private readonly checkpoint?: CheckpointHook;
  private readonly eventStore?: EventStore;

  constructor(options: JobManagerOptions) {
    this.bridge = options.bridge;
    if (options.onJobChange) this.onJobChange = options.onJobChange;
    if (options.checkpoint) this.checkpoint = options.checkpoint;
    if (options.events) this.eventStore = options.events;
  }

  private isWriteAction(action: AgentActionType): boolean {
    return WRITE_ACTIONS.has(action);
  }

  private activeStatuses: JobStatus[] = ['QUEUED', 'RUNNING', 'WAITING_FOR_USER'];

  async startAgentJob(input: StartJobInput): Promise<Job> {
    // Write-task mutex: reject a second concurrent write task in the same workspace.
    if (this.isWriteAction(input.action)) {
      const activeId = this.activeWriteByWorkspace.get(input.workspaceRoot);
      if (activeId) {
        const active = this.jobs.get(activeId);
        if (active && this.activeStatuses.includes(active.job.status)) {
          throw new WriteTaskConflictError(
            `该工作区已有进行中的写任务（${activeId}），同一时刻只允许一个写任务`,
          );
        }
      }
    }

    // Create a checkpoint BEFORE a write task starts (plan §10.10).
    let checkpointId: string | undefined;
    const isWrite = this.isWriteAction(input.action);
    if (isWrite && this.checkpoint) {
      // taskId is not known until start(); use a provisional id keyed by time.
      checkpointId = await this.checkpoint.before({
        projectId: input.projectId,
        workspaceRoot: input.workspaceRoot,
        jobId: `pending_${Date.now()}`,
      });
    }

    const task = await this.bridge.start({
      projectId: input.projectId,
      workspaceRoot: input.workspaceRoot,
      action: input.action,
      prompt: input.prompt,
    });

    const now = new Date().toISOString();
    const job: Job = {
      id: task.taskId,
      projectId: input.projectId,
      type: 'agent',
      status: 'RUNNING',
      agentProvider: task.provider,
      createdAt: now,
      startedAt: now,
      undoable: isWrite,
      ...(task.sessionId ? { sessionId: task.sessionId } : {}),
      ...(checkpointId ? { checkpointId } : {}),
    };
    const record: JobRecord = {
      job,
      events: [],
      emitter: new EventEmitter(),
      workspaceRoot: input.workspaceRoot,
      isWrite,
      pumping: false,
      ...(checkpointId ? { checkpointId } : {}),
    };
    this.jobs.set(job.id, record);
    this.taskToJob.set(task.taskId, job.id);
    if (this.isWriteAction(input.action)) {
      this.activeWriteByWorkspace.set(input.workspaceRoot, job.id);
    }
    this.onJobChange?.(job);

    this.emit(record, {
      type: JobEventTypes.JOB_STARTED,
      jobId: job.id,
      at: now,
      payload: { action: input.action },
    });
    if (checkpointId) {
      this.emit(record, {
        type: JobEventTypes.CHECKPOINT_CREATED,
        jobId: job.id,
        at: now,
        payload: { checkpointId },
      });
    }

    void this.pump(record, task.taskId);
    return job;
  }

  private emit(record: JobRecord, event: JobEvent): void {
    const seq = record.events.length;
    record.events.push(event);
    // Persist to the event log so the conversation survives a Studio restart.
    this.eventStore?.appendEvent(record.job.id, seq, event);
    record.emitter.emit('event', event);
  }

  private setStatus(record: JobRecord, status: JobStatus): void {
    if (record.job.status === status) return;
    if (!canTransition(record.job.status, status)) return;
    record.job.status = status;
    if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(status)) {
      record.job.finishedAt = new Date().toISOString();
    }
    this.onJobChange?.(record.job);
  }

  private async pump(record: JobRecord, taskId: string): Promise<void> {
    const { workspaceRoot, checkpointId } = record;
    record.pumping = true;
    try {
      for await (const e of this.bridge.events(taskId)) {
        const at = new Date().toISOString();
        const next = statusFromAgentEvent(e);
        if (next) this.setStatus(record, next);
        this.emit(record, normalizeAgentEvent(record.job.id, e, at));
      }
    } catch (err) {
      this.setStatus(record, 'FAILED');
      this.emit(record, {
        type: JobEventTypes.JOB_FAILED,
        jobId: record.job.id,
        at: new Date().toISOString(),
        payload: { error: String((err as Error).message ?? err) },
      });
    } finally {
      record.pumping = false;
      // A turn that paused for confirmation (Fake provider) stays open; a turn
      // that finished (SUCCEEDED, typical for real Claude) may still be resumed
      // by a follow-up reply. In both cases we finalize the checkpoint summary
      // and release the write slot for THIS turn; a reply re-acquires it.
      const paused = record.job.status === 'WAITING_FOR_USER';
      if (!paused) {
        if (checkpointId && this.checkpoint) {
          await this.checkpoint
            .after({
              projectId: record.job.projectId,
              workspaceRoot,
              jobId: record.job.id,
              checkpointId,
            })
            .then(() =>
              this.emit(record, {
                type: JobEventTypes.CHANGE_SUMMARY_READY,
                jobId: record.job.id,
                at: new Date().toISOString(),
                payload: { checkpointId },
              }),
            )
            .catch(() => undefined);
        }
        if (this.activeWriteByWorkspace.get(workspaceRoot) === record.job.id) {
          this.activeWriteByWorkspace.delete(workspaceRoot);
        }
      }
    }
  }

  /**
   * Resume a conversation with a user reply. Supports two provider styles:
   *  - Fake pauses at WAITING_FOR_USER; continue() releases the gate and the
   *    original pump loop keeps draining the same event stream.
   *  - Real Claude ends each turn as SUCCEEDED; continue() spawns a fresh
   *    resumed turn (--resume <session>) with a NEW event stream, so we must
   *    re-pump. We only re-pump when no pump loop is currently active.
   */
  async replyToJob(jobId: string, reply: string): Promise<void> {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`未知任务：${jobId}`);
    const wasPumping = record.pumping;
    // Re-acquire the write slot for the resumed turn (previous turn released it).
    if (record.isWrite) {
      const activeId = this.activeWriteByWorkspace.get(record.workspaceRoot);
      if (activeId && activeId !== jobId) {
        const active = this.jobs.get(activeId);
        if (active && this.activeStatuses.includes(active.job.status)) {
          throw new WriteTaskConflictError(
            `该工作区已有进行中的写任务（${activeId}），同一时刻只允许一个写任务`,
          );
        }
      }
      this.activeWriteByWorkspace.set(record.workspaceRoot, jobId);
    }
    // After a Studio restart the provider has no in-memory state for this task;
    // rebuild it from the saved session so continue() can --resume it.
    if (record.job.sessionId && this.bridge.rehydrate) {
      this.bridge.rehydrate({
        taskId: jobId,
        projectId: record.job.projectId,
        workspaceRoot: record.workspaceRoot,
        sessionId: record.job.sessionId,
      });
    }
    this.setStatus(record, 'RUNNING');
    await this.bridge.continue({ taskId: jobId, reply });
    // If the previous turn's pump already ended (real Claude), start a new one
    // to drain the resumed turn's fresh event stream.
    if (!wasPumping) void this.pump(record, jobId);
  }

  async cancelJob(jobId: string): Promise<void> {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`未知任务：${jobId}`);
    await this.bridge.cancel(jobId);
    this.setStatus(record, 'CANCELED');
  }

  /**
   * Interrupt the current turn without ending the conversation. The turn stops
   * and the job settles to SUCCEEDED (resumable), so the user can send another
   * message. Falls back to cancel() for providers that can't interrupt.
   * The write slot for this turn is released so a follow-up reply can re-acquire.
   */
  async interruptJob(jobId: string): Promise<void> {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`未知任务：${jobId}`);
    if (!this.bridge.interrupt) {
      await this.cancelJob(jobId);
      return;
    }
    await this.bridge.interrupt(jobId);
    if (this.activeWriteByWorkspace.get(record.workspaceRoot) === jobId) {
      this.activeWriteByWorkspace.delete(record.workspaceRoot);
    }
    // The pump loop draining this turn will emit job_completed and set SUCCEEDED.
  }

  /**
   * Delete a conversation from history (in memory + persisted log). Refuses an
   * active job (QUEUED/RUNNING/WAITING_FOR_USER) — cancel it first. Returns true
   * if a job was found and deleted.
   */
  deleteJob(jobId: string): boolean {
    const job = this.getJob(jobId);
    if (!job) return false;
    if (this.activeStatuses.includes(job.status)) {
      throw new JobActiveError(`任务进行中（${job.status}），请先取消再删除`);
    }
    const record = this.jobs.get(jobId);
    if (record) {
      record.emitter.removeAllListeners();
      if (this.activeWriteByWorkspace.get(record.workspaceRoot) === jobId) {
        this.activeWriteByWorkspace.delete(record.workspaceRoot);
      }
      this.jobs.delete(jobId);
    }
    this.eventStore?.deleteJob(jobId);
    return true;
  }

  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId)?.job ?? this.eventStore?.get(jobId);
  }

  listJobs(projectId?: string): Job[] {
    const all = [...this.jobs.values()].map((r) => r.job);
    const filtered = projectId ? all.filter((j) => j.projectId === projectId) : all;
    return filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  getEvents(jobId: string): JobEvent[] {
    const inMemory = this.jobs.get(jobId);
    if (inMemory) return inMemory.events;
    return this.eventStore?.listEvents(jobId) ?? [];
  }

  /**
   * Reopen a past conversation that is no longer in memory (e.g. after a Studio
   * restart). Rebuilds an in-memory record from persisted job + event log so it
   * can be viewed and continued. `workspaceRoot` (from the owning project) is
   * needed so a follow-up reply can resume the Claude session with the correct
   * cwd. Returns the job, or undefined if unknown. Idempotent.
   */
  reopenJob(jobId: string, workspaceRoot: string): Job | undefined {
    const existing = this.jobs.get(jobId);
    if (existing) return existing.job;
    if (!this.eventStore) return undefined;
    const job = this.eventStore.get(jobId);
    if (!job) return undefined;
    const events = this.eventStore.listEvents(jobId);
    // Recover the original action from the persisted job_started event to decide
    // write-ness (write tasks re-acquire the mutex on resume).
    const started = events.find((e) => e.type === JobEventTypes.JOB_STARTED);
    const action = started?.payload?.action as AgentActionType | undefined;
    const record: JobRecord = {
      job,
      events,
      emitter: new EventEmitter(),
      workspaceRoot,
      isWrite: action ? this.isWriteAction(action) : false,
      pumping: false,
      ...(job.checkpointId ? { checkpointId: job.checkpointId } : {}),
    };
    this.jobs.set(jobId, record);
    return job;
  }

  /**
   * Subscribe to a job's live event stream. Replays buffered events from `since`
   * (the number of events the consumer has already seen) onward, then streams new
   * ones until the current turn ends. Suitable for SSE.
   *
   * `since` is essential for multi-turn resume: real Claude ends each turn with
   * job_completed and closes the stream, so a follow-up reply re-subscribes. Without
   * a cursor the buffer would replay the *previous* turn's job_completed, which both
   * closes the fresh stream early and re-renders the old turn. Passing `since` = the
   * count already consumed skips those, delivering only the new turn's events.
   */
  subscribe(jobId: string, since = 0): AsyncIterable<JobEvent> {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`未知任务：${jobId}`);
    const queue = new AsyncEventQueue<JobEvent>();

    // Replay only events the consumer hasn't seen yet.
    const start = Math.max(0, Math.min(since, record.events.length));
    for (const e of record.events.slice(start)) queue.push(e);

    const terminal = (e: JobEvent): boolean =>
      e.type === JobEventTypes.JOB_COMPLETED || e.type === JobEventTypes.JOB_FAILED;

    // Close after replay only if the turn is genuinely over — no pump loop is
    // draining events and the status is terminal. A job that just transitioned
    // back to RUNNING for a resumed turn (buffer still ends in the prior turn's
    // job_completed) must stay open and wait for the new turn's events.
    const settled = ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(record.job.status);
    if (!record.pumping && settled) {
      queue.end();
      return queue.iterate();
    }

    const listener = (e: JobEvent): void => {
      queue.push(e);
      if (terminal(e)) {
        record.emitter.off('event', listener);
        queue.end();
      }
    };
    record.emitter.on('event', listener);
    return queue.iterate();
  }
}
