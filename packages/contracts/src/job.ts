/** Job (long-running task) contracts (plan §10.7, §12.7). */

export type JobType = 'agent' | 'validation' | 'runtime' | 'export' | 'publish';

export type JobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_FOR_USER'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELED';

export interface Job {
  id: string;
  projectId: string;
  type: JobType;
  status: JobStatus;
  /** Agent provider identifier when type === 'agent' (e.g. 'claude-code'). */
  agentProvider?: string;
  /** Claude session id, for resume. */
  sessionId?: string;
  /** Current phase label. */
  phase?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Relative path to the job log file. */
  logFile?: string;
  /** Artifact identifiers/paths produced by the job. */
  artifacts?: string[];
  /** Short error summary (secret-free). */
  error?: string;
  exitCode?: number;
  /** Checkpoint created before this write job started. */
  checkpointId?: string;
  /** Whether the job's changes may be safely undone. */
  undoable?: boolean;
}

/** SSE event names emitted on the job event stream (plan §12.7). */
export const JobEventTypes = {
  JOB_STARTED: 'job_started',
  PHASE_CHANGED: 'phase_changed',
  MESSAGE_DELTA: 'message_delta',
  TOOL_STARTED: 'tool_started',
  TOOL_FINISHED: 'tool_finished',
  WAITING_FOR_USER: 'waiting_for_user',
  ARTIFACT_CHANGED: 'artifact_changed',
  CHECKPOINT_CREATED: 'checkpoint_created',
  CHANGE_SUMMARY_READY: 'change_summary_ready',
  JOB_COMPLETED: 'job_completed',
  JOB_FAILED: 'job_failed',
} as const;

export type JobEventType = (typeof JobEventTypes)[keyof typeof JobEventTypes];

export interface JobEvent {
  type: JobEventType;
  jobId: string;
  at: string;
  payload?: Record<string, unknown>;
}

/**
 * Valid job status transitions, used by the state machine (stage 4).
 * SUCCEEDED -> RUNNING is allowed so a finished conversation turn can be resumed
 * by a follow-up user reply (real Claude ends each turn as SUCCEEDED, then
 * --resume spawns a new turn). FAILED/CANCELED remain terminal.
 */
export const JOB_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  QUEUED: ['RUNNING', 'CANCELED', 'FAILED'],
  RUNNING: ['WAITING_FOR_USER', 'SUCCEEDED', 'FAILED', 'CANCELED'],
  WAITING_FOR_USER: ['RUNNING', 'CANCELED', 'FAILED'],
  SUCCEEDED: ['RUNNING'],
  FAILED: [],
  CANCELED: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}
