import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  AgentRun,
  AgentBridge,
  AgentActionType,
  Job,
  JobEvent,
  JobStatus,
  ReportWorkflowPhase,
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
  action: AgentActionType;
  currentProviderTaskId: string;
  currentRun: AgentRun;
  reportStrategy?: string;
  pendingQueryIds: string[];
  reviewedBy?: string;
}

export interface StartJobInput {
  projectId: string;
  workspaceRoot: string;
  action: AgentActionType;
  prompt: string;
  reportId?: string;
}

export interface ReportPhaseHookInput {
  phase: ReportWorkflowPhase;
  projectId: string;
  workspaceRoot: string;
  reportId: string;
  userConfirmation?: string;
  reportRevision: string;
  unitId?: string;
  strategy?: string;
  reviewedBy?: string;
}

export interface ReportPhaseHookResult {
  ok: boolean;
  error?: string;
  modelHash?: string;
  details?: Record<string, unknown>;
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
  upsertRun?(run: AgentRun): void;
  listRuns?(conversationId: string): AgentRun[];
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
  /** Build a minimal prompt for a provider-fresh report phase. */
  buildReportPhasePrompt?: (
    phase: ReportWorkflowPhase,
    context: { reportId?: string; reportRevision?: string; userConfirmation?: string; unitId?: string; strategy?: string },
  ) => string;
  prepareInitialReport?: (input: ReportPhaseHookInput) => Promise<ReportPhaseHookResult>;
  prepareReportPhase?: (input: ReportPhaseHookInput) => Promise<ReportPhaseHookResult>;
  completeReportPhase?: (input: ReportPhaseHookInput) => Promise<ReportPhaseHookResult>;
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
  private readonly buildReportPhasePrompt?: (
    phase: ReportWorkflowPhase,
    context: { reportId?: string; reportRevision?: string; userConfirmation?: string; unitId?: string; strategy?: string },
  ) => string;
  private readonly prepareInitialReport?: (input: ReportPhaseHookInput) => Promise<ReportPhaseHookResult>;
  private readonly prepareReportPhase?: (input: ReportPhaseHookInput) => Promise<ReportPhaseHookResult>;
  private readonly completeReportPhase?: (input: ReportPhaseHookInput) => Promise<ReportPhaseHookResult>;

  constructor(options: JobManagerOptions) {
    this.bridge = options.bridge;
    if (options.onJobChange) this.onJobChange = options.onJobChange;
    if (options.checkpoint) this.checkpoint = options.checkpoint;
    if (options.events) this.eventStore = options.events;
    if (options.buildReportPhasePrompt) this.buildReportPhasePrompt = options.buildReportPhasePrompt;
    if (options.prepareInitialReport) this.prepareInitialReport = options.prepareInitialReport;
    if (options.prepareReportPhase) this.prepareReportPhase = options.prepareReportPhase;
    if (options.completeReportPhase) this.completeReportPhase = options.completeReportPhase;
  }

  private isWriteAction(action: AgentActionType): boolean {
    return WRITE_ACTIONS.has(action);
  }

  private activeStatuses: JobStatus[] = ['QUEUED', 'RUNNING', 'WAITING_FOR_USER'];

  private initialPhase(action: AgentActionType): ReportWorkflowPhase | undefined {
    return action === 'create-report' || action === 'modify-report' ? 'DISCOVERY' : undefined;
  }

  private phaseLabel(phase: ReportWorkflowPhase): string {
    const labels: Record<ReportWorkflowPhase, string> = {
      DISCOVERY: '基础建模',
      AWAITING_DISCOVERY_CONFIRMATION: '等待确认基础模型',
      MODELING: '确定建模',
      AWAITING_MODEL_APPROVAL: '等待批准确定模型',
      QUERY_COMPILATION: '编译查询',
      SCRIPT_COMPILATION: '编译封装脚本',
      VALIDATING: '确定性校验',
      REVISION_REQUIRED: '需要修订模型',
      COMPLETED: '完成',
    };
    return labels[phase];
  }

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

    const reportRevision = input.reportId
      ? `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`
      : undefined;
    if (input.reportId && reportRevision && this.prepareInitialReport) {
      const prepared = await this.prepareInitialReport({
        phase: 'DISCOVERY',
        projectId: input.projectId,
        workspaceRoot: input.workspaceRoot,
        reportId: input.reportId,
        reportRevision,
      });
      if (!prepared.ok) throw new Error(prepared.error ?? '当前工作区不支持分阶段报表构建');
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

    const scopedPrompt = reportRevision && input.reportId
      ? `${input.prompt}\n\n本次构建修订号：${reportRevision}。所有阶段产物只能写入 work/report-build/${input.reportId}/${reportRevision}。`
      : input.prompt;
    const task = await this.bridge.start({
      projectId: input.projectId,
      workspaceRoot: input.workspaceRoot,
      action: input.action,
      prompt: scopedPrompt,
    });

    const now = new Date().toISOString();
    const phase = this.initialPhase(input.action);
    const run: AgentRun = {
      id: `run_${randomUUID()}`,
      conversationId: task.taskId,
      ...(phase ? { phase } : {}),
      providerTaskId: task.taskId,
      ...(task.sessionId ? { providerSessionId: task.sessionId } : {}),
      contextMode: 'fresh',
      status: 'RUNNING',
      createdAt: now,
      startedAt: now,
      ...(checkpointId ? { checkpointId } : {}),
      ...(reportRevision ? { reportRevision } : {}),
    };
    const job: Job = {
      id: task.taskId,
      projectId: input.projectId,
      type: 'agent',
      status: 'RUNNING',
      agentProvider: task.provider,
      createdAt: now,
      startedAt: now,
      undoable: isWrite,
      currentRunId: run.id,
      ...(phase ? { phase } : {}),
      ...(input.reportId ? { reportId: input.reportId } : {}),
      ...(reportRevision ? { reportRevision } : {}),
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
      action: input.action,
      currentProviderTaskId: task.taskId,
      currentRun: run,
      pendingQueryIds: [],
      ...(checkpointId ? { checkpointId } : {}),
    };
    this.jobs.set(job.id, record);
    this.taskToJob.set(task.taskId, job.id);
    if (this.isWriteAction(input.action)) {
      this.activeWriteByWorkspace.set(input.workspaceRoot, job.id);
    }
    this.onJobChange?.(job);
    this.eventStore?.upsertRun?.(run);

    this.emit(record, {
      type: JobEventTypes.JOB_STARTED,
      jobId: job.id,
      at: now,
      payload: { action: input.action },
    });
    this.emit(record, {
      type: JobEventTypes.RUN_STARTED,
      jobId: job.id,
      at: now,
      payload: {
        runId: run.id,
        contextMode: 'fresh',
        ...(phase ? { phase, label: this.phaseLabel(phase) } : {}),
      },
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
    if (status === 'RUNNING') delete record.job.finishedAt;
    if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(status)) {
      record.job.finishedAt = new Date().toISOString();
    }
    this.onJobChange?.(record.job);
  }

  private async pump(record: JobRecord, taskId: string): Promise<void> {
    const { workspaceRoot, checkpointId } = record;
    let autoNextPhase: ReportWorkflowPhase | undefined;
    let deferredCompletionSummary: string | undefined;
    record.pumping = true;
    try {
      for await (const e of this.bridge.events(taskId)) {
        const at = new Date().toISOString();
        const next = statusFromAgentEvent(e);
        if (next) this.setStatus(record, next);
        if (e.type === 'session') {
          record.job.sessionId = e.sessionId;
          record.currentRun.providerSessionId = e.sessionId;
          this.onJobChange?.(record.job);
          this.eventStore?.upsertRun?.(record.currentRun);
        }
        if (e.type === 'completed') {
          const completedPhase = record.currentRun.phase;
          let gateError: string | undefined;
          let gateResult: ReportPhaseHookResult | undefined;
          if (completedPhase && record.job.reportId && this.completeReportPhase) {
            try {
              const result = await this.completeReportPhase({
                phase: completedPhase,
                projectId: record.job.projectId,
                workspaceRoot: record.workspaceRoot,
                reportId: record.job.reportId,
                reportRevision: record.job.reportRevision!,
                ...(record.currentRun.unitId ? { unitId: record.currentRun.unitId } : {}),
                ...(record.reportStrategy ? { strategy: record.reportStrategy } : {}),
                ...(record.reviewedBy ? { reviewedBy: record.reviewedBy } : {}),
              });
              gateResult = result;
              if (!result.ok) gateError = result.error ?? '阶段产物校验失败';
            } catch (error) {
              gateError = String((error as Error).message ?? error);
            }
          }
          if (gateError && completedPhase) {
            deferredCompletionSummary = `阶段产物未通过门禁：${gateError}`;
            record.currentRun.status = 'FAILED';
            record.currentRun.finishedAt = at;
            this.eventStore?.upsertRun?.(record.currentRun);
            this.emit(record, {
              type: JobEventTypes.RUN_COMPLETED,
              jobId: record.job.id,
              at,
              payload: {
                runId: record.currentRun.id,
                phase: completedPhase,
                status: 'FAILED',
                error: gateError,
              },
            });
            this.emit(record, {
              type: JobEventTypes.PHASE_CHANGED,
              jobId: record.job.id,
              at,
              payload: {
                phase: completedPhase,
                label: `${this.phaseLabel(completedPhase)}（产物需修复）`,
                validationFailed: true,
                error: gateError,
                runId: record.currentRun.id,
              },
            });
            continue;
          }
          if (record.currentRun.phase) deferredCompletionSummary = e.summary;
          record.currentRun.status = 'SUCCEEDED';
          record.currentRun.finishedAt = at;
          this.eventStore?.upsertRun?.(record.currentRun);
          this.emit(record, {
            type: JobEventTypes.RUN_COMPLETED,
            jobId: record.job.id,
            at,
            payload: {
              runId: record.currentRun.id,
              ...(record.job.phase ? { phase: record.job.phase } : {}),
              ...(e.summary ? { summary: e.summary } : {}),
              ...(record.currentRun.unitId ? { unitId: record.currentRun.unitId } : {}),
            },
          });
          let awaiting: ReportWorkflowPhase | undefined =
            record.job.phase === 'DISCOVERY'
              ? 'AWAITING_DISCOVERY_CONFIRMATION'
              : record.job.phase === 'MODELING'
                ? 'AWAITING_MODEL_APPROVAL'
                : record.job.phase === 'SCRIPT_COMPILATION'
                  ? 'COMPLETED'
                  : undefined;
          if (record.job.phase === 'QUERY_COMPILATION') {
            if (gateResult?.details?.workflow_complete === true) {
              awaiting = 'COMPLETED';
            } else if (record.pendingQueryIds.length > 0) {
              autoNextPhase = 'QUERY_COMPILATION';
            } else if (record.reportStrategy === 'script') {
              autoNextPhase = 'SCRIPT_COMPILATION';
            } else {
              awaiting = 'COMPLETED';
            }
          }
          if (awaiting) {
            record.job.phase = awaiting;
            this.onJobChange?.(record.job);
            this.emit(record, {
              type: JobEventTypes.PHASE_CHANGED,
              jobId: record.job.id,
              at,
              payload: {
                phase: awaiting,
                label: this.phaseLabel(awaiting),
                runId: record.currentRun.id,
              },
            });
          }
        }
        // Query compilation chains directly into a provider-fresh script run.
        // Suppress the logical job_completed marker so the existing SSE stream
        // remains open across the hidden provider-session boundary.
        if (!(e.type === 'completed' && (autoNextPhase || record.currentRun.phase))) {
          const normalized = normalizeAgentEvent(record.job.id, e, at);
          this.emit(record, {
            ...normalized,
            payload: {
              ...(normalized.payload ?? {}),
              runId: record.currentRun.id,
              ...(record.job.phase ? { phase: record.job.phase } : {}),
            },
          });
        }
      }
    } catch (err) {
      this.setStatus(record, 'FAILED');
      record.currentRun.status = 'FAILED';
      record.currentRun.finishedAt = new Date().toISOString();
      this.eventStore?.upsertRun?.(record.currentRun);
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
        if (autoNextPhase && this.buildReportPhasePrompt) {
          const nextUnitId = autoNextPhase === 'QUERY_COMPILATION'
            ? record.pendingQueryIds.shift()
            : undefined;
          await this.startFreshPhase({
            jobId: record.job.id,
            phase: autoNextPhase,
            ...(nextUnitId ? { unitId: nextUnitId } : {}),
            skipPrepare: true,
          }).catch((error) => {
            this.setStatus(record, 'FAILED');
            this.emit(record, {
              type: JobEventTypes.JOB_FAILED,
              jobId: record.job.id,
              at: new Date().toISOString(),
              payload: { error: `无法启动下一阶段：${String((error as Error).message ?? error)}` },
            });
          });
        } else if (
          record.currentRun.phase &&
          (deferredCompletionSummary !== undefined || record.currentRun.status === 'SUCCEEDED')
        ) {
          this.emit(record, {
            type: JobEventTypes.JOB_COMPLETED,
            jobId: record.job.id,
            at: new Date().toISOString(),
            payload: {
              ...(deferredCompletionSummary ? { summary: deferredCompletionSummary } : {}),
              runId: record.currentRun.id,
              ...(record.job.phase ? { phase: record.job.phase } : {}),
            },
          });
        }
      }
    }
  }

  /** Start a provider-fresh phase while preserving one logical conversation/event stream. */
  async startFreshPhase(input: {
    jobId: string;
    phase: ReportWorkflowPhase;
    prompt?: string;
    modelRevision?: string;
    modelHash?: string;
    userMessage?: string;
    unitId?: string;
    reviewedBy?: string;
    skipPrepare?: boolean;
  }): Promise<AgentRun> {
    const record = this.jobs.get(input.jobId);
    if (!record) throw new Error(`未知任务：${input.jobId}`);
    if (record.pumping || this.activeStatuses.includes(record.job.status)) {
      throw new JobActiveError(`任务当前阶段仍在运行（${record.job.status}）`);
    }
    const allowed: Partial<Record<ReportWorkflowPhase, ReportWorkflowPhase[]>> = {
      AWAITING_DISCOVERY_CONFIRMATION: ['MODELING'],
      AWAITING_MODEL_APPROVAL: ['QUERY_COMPILATION'],
      QUERY_COMPILATION: ['QUERY_COMPILATION', 'SCRIPT_COMPILATION', 'REVISION_REQUIRED'],
      REVISION_REQUIRED: ['MODELING'],
    };
    if (record.job.phase && !(allowed[record.job.phase] ?? []).includes(input.phase)) {
      throw new Error(`不能从 ${record.job.phase} 切换到 ${input.phase}`);
    }
    let prepared: ReportPhaseHookResult | undefined;
    if (record.job.reportId && this.prepareReportPhase && !input.skipPrepare) {
      prepared = await this.prepareReportPhase({
        phase: input.phase,
        projectId: record.job.projectId,
        workspaceRoot: record.workspaceRoot,
        reportId: record.job.reportId,
        reportRevision: record.job.reportRevision!,
        ...(input.reviewedBy ? { reviewedBy: input.reviewedBy } : {}),
        ...(input.userMessage ? { userConfirmation: input.userMessage } : {}),
      });
      if (!prepared.ok) throw new Error(prepared.error ?? '下一阶段准备失败');
    }
    if (input.reviewedBy) record.reviewedBy = input.reviewedBy;
    if (prepared?.details) {
      if (typeof prepared.details.strategy === 'string') record.reportStrategy = prepared.details.strategy;
      if (Array.isArray(prepared.details.query_ids)) {
        const ids = prepared.details.query_ids.map(String);
        input.unitId ??= ids.shift();
        record.pendingQueryIds = ids;
      }
    }
    if (input.phase === 'QUERY_COMPILATION' && !record.reportStrategy) record.reportStrategy = 'script';
    const prompt = input.prompt ?? this.buildReportPhasePrompt?.(input.phase, {
      reportId: record.job.reportId,
      reportRevision: record.job.reportRevision,
      userConfirmation: input.userMessage,
      unitId: input.unitId,
      strategy: record.reportStrategy,
    });
    if (!prompt) throw new Error(`缺少阶段 ${input.phase} 的 Agent 提示词`);
    let checkpointId: string | undefined;
    if (record.isWrite && this.checkpoint) {
      checkpointId = await this.checkpoint.before({
        projectId: record.job.projectId,
        workspaceRoot: record.workspaceRoot,
        jobId: `${record.job.id}:${input.phase}`,
      });
    }
    const task = await this.bridge.start({
      projectId: record.job.projectId,
      workspaceRoot: record.workspaceRoot,
      action: record.action,
      prompt,
      params: { phase: input.phase, contextMode: 'fresh' },
    });
    const now = new Date().toISOString();
    const run: AgentRun = {
      id: `run_${randomUUID()}`,
      conversationId: record.job.id,
      phase: input.phase,
      providerTaskId: task.taskId,
      ...(task.sessionId ? { providerSessionId: task.sessionId } : {}),
      contextMode: 'fresh',
      status: 'RUNNING',
      ...(input.modelRevision ? { modelRevision: input.modelRevision } : {}),
      ...(input.modelHash ?? prepared?.modelHash ? { modelHash: input.modelHash ?? prepared?.modelHash } : {}),
      ...(input.unitId ? { unitId: input.unitId } : {}),
      ...(record.job.reportRevision ? { reportRevision: record.job.reportRevision } : {}),
      ...(checkpointId ? { checkpointId } : {}),
      createdAt: now,
      startedAt: now,
    };
    record.currentProviderTaskId = task.taskId;
    record.currentRun = run;
    record.job.currentRunId = run.id;
    record.job.phase = input.phase;
    record.job.sessionId = task.sessionId;
    if (checkpointId) {
      record.checkpointId = checkpointId;
      record.job.checkpointId = checkpointId;
    }
    this.taskToJob.set(task.taskId, record.job.id);
    this.setStatus(record, 'RUNNING');
    if (record.isWrite) this.activeWriteByWorkspace.set(record.workspaceRoot, record.job.id);
    this.onJobChange?.(record.job);
    this.eventStore?.upsertRun?.(run);
    if (input.userMessage) {
      this.emit(record, {
        type: JobEventTypes.USER_MESSAGE,
        jobId: record.job.id,
        at: now,
        payload: {
          text: input.userMessage,
          runId: run.id,
          phase: input.phase,
        },
      });
    }
    this.emit(record, {
      type: JobEventTypes.PHASE_CHANGED,
      jobId: record.job.id,
      at: now,
      payload: {
        phase: input.phase,
        label: this.phaseLabel(input.phase),
        contextReset: true,
        runId: run.id,
        ...(run.unitId ? { unitId: run.unitId } : {}),
      },
    });
    this.emit(record, {
      type: JobEventTypes.RUN_STARTED,
      jobId: record.job.id,
      at: now,
      payload: {
        phase: input.phase,
        label: this.phaseLabel(input.phase),
        contextMode: 'fresh',
        runId: run.id,
        ...(run.unitId ? { unitId: run.unitId } : {}),
      },
    });
    if (checkpointId) {
      this.emit(record, {
        type: JobEventTypes.CHECKPOINT_CREATED,
        jobId: record.job.id,
        at: now,
        payload: { checkpointId, runId: run.id, phase: input.phase },
      });
    }
    void this.pump(record, task.taskId);
    return run;
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
        taskId: record.currentProviderTaskId,
        projectId: record.job.projectId,
        workspaceRoot: record.workspaceRoot,
        sessionId: record.job.sessionId,
      });
    }
    this.emit(record, {
      type: JobEventTypes.USER_MESSAGE,
      jobId: record.job.id,
      at: new Date().toISOString(),
      payload: {
        text: reply,
        runId: record.currentRun.id,
        ...(record.job.phase ? { phase: record.job.phase } : {}),
      },
    });
    this.setStatus(record, 'RUNNING');
    await this.bridge.continue({ taskId: record.currentProviderTaskId, reply });
    // If the previous turn's pump already ended (real Claude), start a new one
    // to drain the resumed turn's fresh event stream.
    if (!wasPumping) void this.pump(record, record.currentProviderTaskId);
  }

  async cancelJob(jobId: string): Promise<void> {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`未知任务：${jobId}`);
    await this.bridge.cancel(record.currentProviderTaskId);
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
    await this.bridge.interrupt(record.currentProviderTaskId);
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
    const runs = this.eventStore?.listRuns?.(jobId) ?? [];
    const currentRun =
      runs.find((run) => run.id === job.currentRunId) ??
      runs[runs.length - 1] ?? {
        id: job.currentRunId ?? `run_legacy_${job.id}`,
        conversationId: job.id,
        ...(job.phase ? { phase: job.phase } : {}),
        providerTaskId: job.id,
        ...(job.sessionId ? { providerSessionId: job.sessionId } : {}),
        contextMode: 'resume' as const,
        status: job.status,
        createdAt: job.createdAt,
      };
    const record: JobRecord = {
      job,
      events,
      emitter: new EventEmitter(),
      workspaceRoot,
      isWrite: action ? this.isWriteAction(action) : false,
      pumping: false,
      action: action ?? 'free-chat',
      currentProviderTaskId: currentRun.providerTaskId,
      currentRun,
      pendingQueryIds: [],
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
