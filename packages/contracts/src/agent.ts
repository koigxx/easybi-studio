/**
 * AgentBridge contracts (plan §13).
 *
 * Studio business modules depend only on these types. Providers (ClaudeCodeBridge,
 * later InnosAgentBridge) must normalize their private protocol into these events.
 */

export interface AgentHealth {
  available: boolean;
  provider: string;
  /** Provider version string, when detectable. */
  version?: string;
  /** Chinese human-readable note. */
  note?: string;
}

/** First-release agent action verbs (plan §12.3). */
export type AgentActionType =
  | 'initialize-knowledge'
  | 'continue-knowledge'
  | 'rescan-knowledge'
  | 'review-enums'
  | 'publish-knowledge'
  | 'create-report'
  | 'modify-report'
  | 'validate-report'
  // Free-form conversation: the user's raw prompt is sent verbatim (no preset
  // template). Read-only by convention — not subject to the write-task mutex or
  // a pre-task checkpoint.
  | 'free-chat';

export interface StartAgentInput {
  projectId: string;
  /** Registered workspace root; used as cwd. */
  workspaceRoot: string;
  action: AgentActionType;
  /** Prompt text delivered to the provider via stdin. */
  prompt: string;
  /** Provider-agnostic action parameters. */
  params?: Record<string, unknown>;
}

export interface ContinueAgentInput {
  taskId: string;
  /** The user's reply that resumes a WAITING_FOR_USER task. */
  reply: string;
}

export interface AgentTask {
  taskId: string;
  projectId: string;
  provider: string;
  sessionId?: string;
  status: 'QUEUED' | 'RUNNING' | 'WAITING_FOR_USER' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
}

/** Normalized agent event, provider-independent. */
export type AgentEvent =
  | { type: 'message_delta'; taskId: string; text: string }
  | { type: 'tool_started'; taskId: string; tool: string; detail?: string }
  | { type: 'tool_finished'; taskId: string; tool: string; ok: boolean; detail?: string }
  | { type: 'waiting_for_user'; taskId: string; question: string }
  | { type: 'session'; taskId: string; sessionId: string }
  | { type: 'completed'; taskId: string; summary?: string }
  | { type: 'failed'; taskId: string; error: string };

/** Input to rebuild a task's provider-side state after a Studio restart. */
export interface RehydrateAgentInput {
  taskId: string;
  projectId: string;
  workspaceRoot: string;
  /** Saved provider session to resume (e.g. Claude session_id). */
  sessionId: string;
}

/** The provider-agnostic bridge every AI provider must implement. */
export interface AgentBridge {
  healthCheck(): Promise<AgentHealth>;
  start(input: StartAgentInput): Promise<AgentTask>;
  continue(input: ContinueAgentInput): Promise<AgentTask>;
  cancel(taskId: string): Promise<void>;
  /**
   * Optional: stop the CURRENT turn without ending the conversation. Unlike
   * cancel() (which is terminal), interrupt kills the in-flight turn but leaves
   * the session resumable, so the user can keep chatting. Providers that can't
   * distinguish may omit this and callers fall back to cancel().
   */
  interrupt?(taskId: string): Promise<void>;
  events(taskId: string): AsyncIterable<AgentEvent>;
  /**
   * Optional: recreate in-memory task state for a persisted task (identified by
   * a saved sessionId) so continue() can resume it after a Studio restart. A
   * provider that cannot resume across restarts may omit this.
   */
  rehydrate?(input: RehydrateAgentInput): void;
}
