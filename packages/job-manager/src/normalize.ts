import type { AgentEvent, JobEvent, JobStatus } from '@easybi-studio/contracts';
import { JobEventTypes } from '@easybi-studio/contracts';

/**
 * Normalize a provider AgentEvent into a Studio JobEvent (plan §12.7, §13).
 * Pages consume only JobEvents; they never parse provider-private protocols.
 */
export function normalizeAgentEvent(jobId: string, e: AgentEvent, at: string): JobEvent {
  switch (e.type) {
    case 'message_delta':
      return { type: JobEventTypes.MESSAGE_DELTA, jobId, at, payload: { text: e.text } };
    case 'tool_started':
      return {
        type: JobEventTypes.TOOL_STARTED,
        jobId,
        at,
        payload: { tool: e.tool, detail: e.detail },
      };
    case 'tool_finished':
      return {
        type: JobEventTypes.TOOL_FINISHED,
        jobId,
        at,
        payload: { tool: e.tool, ok: e.ok, detail: e.detail },
      };
    case 'waiting_for_user':
      return {
        type: JobEventTypes.WAITING_FOR_USER,
        jobId,
        at,
        payload: { question: e.question },
      };
    case 'session':
      return { type: JobEventTypes.PHASE_CHANGED, jobId, at, payload: { sessionId: e.sessionId } };
    case 'completed':
      return { type: JobEventTypes.JOB_COMPLETED, jobId, at, payload: { summary: e.summary } };
    case 'failed':
      return { type: JobEventTypes.JOB_FAILED, jobId, at, payload: { error: e.error } };
    default: {
      const _exhaustive: never = e;
      return _exhaustive;
    }
  }
}

/** Map an AgentEvent to the resulting job status transition, if any. */
export function statusFromAgentEvent(e: AgentEvent): JobStatus | null {
  switch (e.type) {
    case 'waiting_for_user':
      return 'WAITING_FOR_USER';
    case 'completed':
      return 'SUCCEEDED';
    case 'failed':
      return 'FAILED';
    case 'message_delta':
    case 'tool_started':
    case 'tool_finished':
    case 'session':
      return 'RUNNING';
    default:
      return null;
  }
}
