/**
 * Pure view-model logic for the AI chat drawer.
 *
 * The drawer streams provider-agnostic JobEvents (see api.ts / contracts JobEvent)
 * and folds them into a render model. Keeping this pure makes the event→UI mapping
 * unit-testable and independent of React or the underlying provider (Claude/Innos).
 */
import type { AgentTaskStatus, JobEvent } from '../api.js';

export interface ChatToolLine {
  kind: 'tool';
  tool: string;
  detail?: string;
  ok?: boolean;
  running: boolean;
}

export interface ChatTextLine {
  kind: 'assistant';
  text: string;
}

export interface ChatUserLine {
  kind: 'user';
  text: string;
}

export interface ChatNoticeLine {
  kind: 'notice';
  text: string;
}

export type ChatLine = ChatTextLine | ChatUserLine | ChatToolLine | ChatNoticeLine;

export interface ChatModel {
  status: AgentTaskStatus;
  lines: ChatLine[];
  /** Present when the task is paused awaiting a user reply. */
  waitingQuestion?: string;
  /** Final summary text on success. */
  summary?: string;
  /** Error text on failure. */
  error?: string;
  /** Checkpoint id created before a write task (for later diff/rollback). */
  checkpointId?: string;
  /**
   * Number of JobEvents folded into this model. Used as the `since` cursor when
   * (re)subscribing to the SSE stream so a resumed turn doesn't replay prior events.
   */
  eventCount: number;
  /** Logical report workflow phase; provider session switches stay hidden. */
  phase?: string;
}

export function emptyChat(status: AgentTaskStatus = 'QUEUED'): ChatModel {
  return { status, lines: [], eventCount: 0 };
}

function str(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = payload?.[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Fold one JobEvent into the model, returning a new model (immutable update).
 * Consecutive message_delta events append to the trailing assistant line so
 * streamed text renders as one growing paragraph.
 */
export function reduceEvent(model: ChatModel, e: JobEvent): ChatModel {
  const folded = foldEvent(model, e);
  // Count every consumed event (even no-op branches) so the SSE `since` cursor
  // stays aligned with the server's buffer length.
  return folded === model
    ? { ...model, eventCount: model.eventCount + 1 }
    : { ...folded, eventCount: model.eventCount + 1 };
}

function foldEvent(model: ChatModel, e: JobEvent): ChatModel {
  const lines = model.lines;
  switch (e.type) {
    case 'message_delta': {
      const text = str(e.payload, 'text') ?? '';
      if (!text) return model;
      const last = lines[lines.length - 1];
      if (last && last.kind === 'assistant') {
        const updated: ChatTextLine = { kind: 'assistant', text: last.text + text };
        return { ...model, status: 'RUNNING', lines: [...lines.slice(0, -1), updated] };
      }
      return { ...model, status: 'RUNNING', lines: [...lines, { kind: 'assistant', text }] };
    }
    case 'user_message': {
      const text = str(e.payload, 'text') ?? '';
      if (!text) return model;
      const last = lines[lines.length - 1];
      if (last?.kind === 'user' && last.text === text) return model;
      return { ...model, lines: [...lines, { kind: 'user', text }] };
    }
    case 'phase_changed': {
      const phase = str(e.payload, 'phase');
      const label = str(e.payload, 'label');
      const contextReset = e.payload?.contextReset === true;
      if (!phase) return model;
      const text = contextReset
        ? `进入「${label ?? phase}」：已启动干净的 Agent 上下文。`
        : label
          ? `当前阶段：${label}`
          : undefined;
      return {
        ...model,
        phase,
        lines: text ? [...lines, { kind: 'notice', text }] : lines,
      };
    }
    case 'run_started':
      return { ...model, status: 'RUNNING' };
    case 'run_completed':
      return model;
    case 'tool_started': {
      const tool = str(e.payload, 'tool') ?? '工具';
      const line: ChatToolLine = {
        kind: 'tool',
        tool,
        detail: str(e.payload, 'detail'),
        running: true,
      };
      return { ...model, status: 'RUNNING', lines: [...lines, line] };
    }
    case 'tool_finished': {
      const tool = str(e.payload, 'tool') ?? '工具';
      const ok = e.payload?.ok !== false;
      // Mark the most recent running line for this tool as finished.
      const idx = [...lines]
        .map((l, i) => ({ l, i }))
        .reverse()
        .find(({ l }) => l.kind === 'tool' && l.tool === tool && (l as ChatToolLine).running)?.i;
      if (idx === undefined) {
        return {
          ...model,
          lines: [...lines, { kind: 'tool', tool, detail: str(e.payload, 'detail'), ok, running: false }],
        };
      }
      const updated: ChatToolLine = {
        ...(lines[idx] as ChatToolLine),
        ok,
        running: false,
        detail: str(e.payload, 'detail') ?? (lines[idx] as ChatToolLine).detail,
      };
      const next = [...lines];
      next[idx] = updated;
      return { ...model, lines: next };
    }
    case 'waiting_for_user': {
      const question = str(e.payload, 'question') ?? '需要你的确认才能继续。';
      return {
        ...model,
        status: 'WAITING_FOR_USER',
        waitingQuestion: question,
        lines: [...lines, { kind: 'notice', text: question }],
      };
    }
    case 'checkpoint_created': {
      const checkpointId = str(e.payload, 'checkpointId');
      return { ...model, checkpointId: checkpointId ?? model.checkpointId };
    }
    case 'job_completed': {
      const summary = str(e.payload, 'summary');
      // Claude's final `result` text is the SAME text already streamed as the
      // trailing assistant message, so appending it again renders the answer
      // twice (once styled, once raw). Only surface the summary as a notice when
      // it isn't already the last assistant line.
      const lastAssistant = [...lines].reverse().find((l) => l.kind === 'assistant') as
        | ChatTextLine
        | undefined;
      const dup =
        !!summary && !!lastAssistant && lastAssistant.text.trim() === summary.trim();
      return {
        ...model,
        status: 'SUCCEEDED',
        summary,
        waitingQuestion: undefined,
        lines: summary && !dup ? [...lines, { kind: 'notice', text: summary }] : lines,
      };
    }
    case 'job_failed': {
      const error = str(e.payload, 'error') ?? '任务失败';
      return {
        ...model,
        status: 'FAILED',
        error,
        waitingQuestion: undefined,
        lines: [...lines, { kind: 'notice', text: `失败：${error}` }],
      };
    }
    case 'job_started':
    case 'artifact_changed':
    case 'change_summary_ready':
    default:
      return model;
  }
}

export function reduceEvents(seed: ChatModel, events: JobEvent[]): ChatModel {
  return events.reduce(reduceEvent, seed);
}

export function isTerminal(status: AgentTaskStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELED';
}

/** A run of consecutive tool lines, collapsed into one expandable block. */
export interface ChatToolGroup {
  kind: 'tool-group';
  tools: ChatToolLine[];
}

/** A renderable row: either a single non-tool line, or a collapsed tool group. */
export type ChatRow = Exclude<ChatLine, ChatToolLine> | ChatToolGroup;

/**
 * Collapse consecutive `tool` lines into groups so a long run of Read/Grep/…
 * calls renders as one foldable summary instead of flooding the transcript.
 * Non-tool lines pass through unchanged and preserve ordering.
 */
export function groupRows(lines: ChatLine[]): ChatRow[] {
  const rows: ChatRow[] = [];
  let bucket: ChatToolLine[] | null = null;
  const flush = (): void => {
    if (bucket && bucket.length) rows.push({ kind: 'tool-group', tools: bucket });
    bucket = null;
  };
  for (const line of lines) {
    if (line.kind === 'tool') {
      (bucket ??= []).push(line);
    } else {
      flush();
      rows.push(line);
    }
  }
  flush();
  return rows;
}

/** One-line summary for a collapsed tool group, e.g. "6 个步骤 · 1 进行中". */
export function toolGroupSummary(tools: ChatToolLine[]): string {
  const running = tools.filter((t) => t.running).length;
  const failed = tools.filter((t) => t.ok === false).length;
  const parts = [`${tools.length} 个步骤`];
  if (running > 0) parts.push(`${running} 进行中`);
  if (failed > 0) parts.push(`${failed} 失败`);
  return parts.join(' · ');
}

/**
 * Which preset action verbs each page surfaces in its quick-start dropdown. The
 * preset LABEL/HINT/PROMPT now come from the workspace config (initialized from
 * skill prompts.json), fetched at open time; these arrays only decide which
 * verbs belong on which page.
 */
export const KNOWLEDGE_ACTION_VERBS: string[] = [
  'initialize-knowledge',
  'continue-knowledge',
  'rescan-knowledge',
  'review-enums',
  'publish-knowledge',
];

export const REPORT_ACTION_VERBS: string[] = ['create-report', 'modify-report', 'validate-report'];

/** Fallback labels for action verbs (used for history titles when no preset). */
const ACTION_LABELS: Record<string, string> = {
  'initialize-knowledge': '初始化知识库',
  'continue-knowledge': '继续完善草稿',
  'rescan-knowledge': '重新扫描',
  'review-enums': '审阅枚举映射',
  'publish-knowledge': '发布知识库版本',
  'create-report': '构建报表',
  'modify-report': '修改报表',
  'validate-report': '静态校验报表',
  'free-chat': '自由对话',
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}
