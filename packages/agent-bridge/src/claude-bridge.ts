import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  AgentBridge,
  AgentEvent,
  AgentHealth,
  AgentTask,
  ContinueAgentInput,
  RehydrateAgentInput,
  StartAgentInput,
} from '@easybi-studio/contracts';
import { AsyncEventQueue } from './event-queue.js';
import { redactSecrets } from './redact.js';

/**
 * ClaudeCodeBridge (plan §14): first real AI provider.
 *
 * - child_process.spawn with shell:false (default) and array args.
 * - cwd is the registered workspace.
 * - prompt via stdin; --output-format stream-json; --include-partial-messages.
 * - local full-permission dev mode: --dangerously-skip-permissions.
 * - saves session_id; --resume <id> for continuation.
 * - normalizes Claude's stream-json into Studio AgentEvents.
 *
 * Never prints secrets. Never runs DB DDL/DML (enforced by prompt + Skill gates).
 */

export interface ClaudeCodeBridgeOptions {
  /** Path to the claude executable. */
  claudePath: string;
  /** Extra environment for the child (inherits parent env by default). */
  env?: NodeJS.ProcessEnv;
  /** Skip real permission prompts (local dev). Default true. */
  skipPermissions?: boolean;
  /** Append a safety system-prompt clause. */
  systemPromptSuffix?: string;
}

interface ClaudeTaskState {
  task: AgentTask;
  queue: AsyncEventQueue<AgentEvent>;
  child?: ChildProcessWithoutNullStreams;
  workspaceRoot: string;
  canceled: boolean;
  waiting: boolean;
  sawResult: boolean;
  /** Last few stderr lines of the current spawn, for diagnosing silent failures. */
  stderrTail: string[];
}

/** Keep at most this many recent stderr lines for failure diagnostics. */
const STDERR_TAIL_MAX = 8;

/**
 * Turn a headless `result` event's `subtype` into a human hint. `claude -p`
 * reports why a turn ended here (e.g. hitting the token/turn ceiling) even when
 * the `result` text is empty — surfacing it is the difference between a bare
 * 「任务失败」and an actionable message.
 */
function describeResultSubtype(subtype: string | undefined): string | undefined {
  switch (subtype) {
    case 'error_max_tokens':
      return '达到模型上下文/输出上限（无头模式不会自动压缩，建议拆小任务或精简上下文后重试）';
    case 'error_max_turns':
      return '达到最大回合数上限';
    case 'error_during_execution':
      return '执行过程中出错';
    default:
      // Unknown but non-success subtype: pass it through verbatim as a hint.
      return subtype && subtype !== 'success' ? `失败类型：${subtype}` : undefined;
  }
}

const SAFETY_SUFFIX = [
  '重要边界：只能修改当前工作区目录；',
  '不得修改工作区外的 Skill 正式来源（技能包源目录）；',
  '不得删除工作区外的目录；不得输出数据库密码/API Key/Token；',
  '数据库只读，禁止 DDL/DML；所有 Skill 审核门禁仍然有效。',
].join('');

let counter = 0;

export class ClaudeCodeBridge implements AgentBridge {
  private tasks = new Map<string, ClaudeTaskState>();
  private readonly opts: Required<Omit<ClaudeCodeBridgeOptions, 'env'>> & {
    env?: NodeJS.ProcessEnv;
  };

  constructor(options: ClaudeCodeBridgeOptions) {
    this.opts = {
      claudePath: options.claudePath,
      skipPermissions: options.skipPermissions ?? true,
      systemPromptSuffix: options.systemPromptSuffix ?? SAFETY_SUFFIX,
      ...(options.env ? { env: options.env } : {}),
    };
  }

  async healthCheck(): Promise<AgentHealth> {
    return new Promise((resolve) => {
      const child = spawn(this.opts.claudePath, ['--version'], { shell: false });
      let out = '';
      child.stdout.on('data', (d) => (out += String(d)));
      child.on('error', () =>
        resolve({ available: false, provider: 'claude-code', note: '无法启动 Claude Code' }),
      );
      child.on('close', (code) =>
        resolve({
          available: code === 0,
          provider: 'claude-code',
          version: out.trim() || undefined,
          note: code === 0 ? '本机 Claude Code 可用' : '版本检测失败',
        }),
      );
    });
  }

  private buildArgs(resumeSessionId?: string): string[] {
    const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
    if (this.opts.skipPermissions) args.push('--dangerously-skip-permissions');
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    args.push('--append-system-prompt', this.opts.systemPromptSuffix);
    return args;
  }

  private spawnClaude(state: ClaudeTaskState, prompt: string, resumeSessionId?: string): void {
    const child = spawn(this.opts.claudePath, this.buildArgs(resumeSessionId), {
      cwd: state.workspaceRoot,
      shell: false,
      env: this.opts.env ?? process.env,
    });
    state.child = child;
    // Fresh stderr buffer for THIS spawn (a resume reuses the same state).
    state.stderrTail = [];
    // Bind the queue for THIS spawn so a later resume's fresh queue is never
    // ended by this process's late close handler.
    const queue = state.queue;

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this.handleLine(state, queue, line));
    child.stderr.on('data', (d) => {
      const text = redactSecrets(String(d)).trim();
      if (text) {
        // Keep a rolling tail for failure diagnostics (bounded).
        state.stderrTail.push(text);
        if (state.stderrTail.length > STDERR_TAIL_MAX) state.stderrTail.shift();
        queue.push({ type: 'message_delta', taskId: state.task.taskId, text: `[stderr] ${text}` });
      }
    });
    child.on('error', (err) => {
      state.task.status = 'FAILED';
      queue.push({ type: 'failed', taskId: state.task.taskId, error: redactSecrets(String(err.message)) });
      queue.end();
    });
    child.on('close', (code, signal) => {
      if (!state.sawResult && !state.waiting && state.task.status === 'RUNNING') {
        state.task.status = 'FAILED';
        queue.push({
          type: 'failed',
          taskId: state.task.taskId,
          error: this.buildFailureMessage('Claude 进程异常退出', {
            code,
            signal,
            stderrTail: state.stderrTail,
          }),
        });
        queue.end();
      } else if (!state.waiting) {
        queue.end();
      }
    });

    // Prompt via stdin.
    child.stdin.write(prompt);
    child.stdin.end();
  }

  /**
   * Compose an actionable failure message from whatever diagnostics we have:
   * the base reason, the headless `result` subtype (why the turn ended), the
   * exit code/signal, and the tail of stderr. Keeps 「任务失败」from being the
   * only thing the user ever sees.
   */
  private buildFailureMessage(
    base: string,
    diag: {
      subtype?: string;
      code?: number | null;
      signal?: NodeJS.Signals | null;
      stderrTail?: string[];
    },
  ): string {
    const parts = [base];
    const hint = describeResultSubtype(diag.subtype);
    if (hint) parts.push(hint);
    if (diag.signal) parts.push(`信号 ${diag.signal}`);
    else if (typeof diag.code === 'number' && diag.code !== 0) parts.push(`退出码 ${diag.code}`);
    const tail = (diag.stderrTail ?? []).join(' | ').trim();
    if (tail) parts.push(`stderr: ${tail}`);
    // De-dup (e.g. base already equals the stderr line) and join.
    return [...new Set(parts)].join('；');
  }

  private handleLine(state: ClaudeTaskState, queue: AsyncEventQueue<AgentEvent>, line: string): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const taskId = state.task.taskId;
    const type = obj.type as string;

    // Capture / update session id.
    const sid = obj.session_id as string | undefined;
    if (sid && state.task.sessionId !== sid) {
      state.task.sessionId = sid;
      queue.push({ type: 'session', taskId, sessionId: sid });
    }

    if (type === 'stream_event') {
      const ev = obj.event as Record<string, unknown> | undefined;
      const evType = ev?.type as string | undefined;
      if (evType === 'content_block_start') {
        const block = ev?.content_block as Record<string, unknown> | undefined;
        if (block?.type === 'tool_use') {
          queue.push({
            type: 'tool_started',
            taskId,
            tool: String(block.name ?? 'tool'),
          });
        }
      } else if (evType === 'content_block_delta') {
        const delta = ev?.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          queue.push({ type: 'message_delta', taskId, text: redactSecrets(delta.text) });
        }
      }
      return;
    }

    if (type === 'user') {
      // tool_result comes back as a user message.
      const msg = obj.message as { content?: Array<{ type?: string; is_error?: boolean }> } | undefined;
      for (const c of msg?.content ?? []) {
        if (c.type === 'tool_result') {
          queue.push({ type: 'tool_finished', taskId, tool: 'tool', ok: !c.is_error });
        }
      }
      return;
    }

    if (type === 'result') {
      state.sawResult = true;
      const subtype = typeof obj.subtype === 'string' ? obj.subtype : undefined;
      // `claude -p` marks failure via is_error OR a non-success subtype; the
      // result text is often empty on failure, so we don't rely on it alone.
      const isError = obj.is_error === true || (subtype !== undefined && subtype !== 'success');
      const resultText = typeof obj.result === 'string' ? redactSecrets(obj.result.trim()) : undefined;
      if (isError) {
        state.task.status = 'FAILED';
        queue.push({
          type: 'failed',
          taskId,
          error: this.buildFailureMessage(resultText || '任务失败', {
            subtype,
            stderrTail: state.stderrTail,
          }),
        });
      } else {
        state.task.status = 'SUCCEEDED';
        queue.push({ type: 'completed', taskId, ...(resultText ? { summary: resultText } : {}) });
      }
      queue.end();
    }
  }

  async start(input: StartAgentInput): Promise<AgentTask> {
    counter += 1;
    const taskId = `claude_${counter}_${input.action}`;
    const task: AgentTask = {
      taskId,
      projectId: input.projectId,
      provider: 'claude-code',
      status: 'RUNNING',
    };
    const state: ClaudeTaskState = {
      task,
      queue: new AsyncEventQueue<AgentEvent>(),
      workspaceRoot: input.workspaceRoot,
      canceled: false,
      waiting: false,
      sawResult: false,
      stderrTail: [],
    };
    this.tasks.set(taskId, state);
    this.spawnClaude(state, input.prompt);
    return task;
  }

  /**
   * Rebuild in-memory state for a persisted task after a Studio restart, so a
   * follow-up reply can resume it. The actual Claude process is not relaunched
   * here; continue() spawns a fresh `--resume <sessionId>` process on demand.
   */
  rehydrate(input: RehydrateAgentInput): void {
    if (this.tasks.has(input.taskId)) return;
    const task: AgentTask = {
      taskId: input.taskId,
      projectId: input.projectId,
      provider: 'claude-code',
      sessionId: input.sessionId,
      status: 'SUCCEEDED',
    };
    this.tasks.set(input.taskId, {
      task,
      queue: new AsyncEventQueue<AgentEvent>(),
      workspaceRoot: input.workspaceRoot,
      canceled: false,
      waiting: false,
      sawResult: true,
      stderrTail: [],
    });
  }

  /**
   * Resume a saved session with the user's reply (plan §14.5). Spawns a new
   * claude process with --resume <sessionId> and the reply as the prompt.
   */
  async continue(input: ContinueAgentInput): Promise<AgentTask> {
    const state = this.tasks.get(input.taskId);
    if (!state) throw new Error(`未知任务：${input.taskId}`);
    if (!state.task.sessionId) throw new Error('该任务没有可恢复的 session');
    state.waiting = false;
    state.sawResult = false;
    state.task.status = 'RUNNING';
    // Fresh queue for the resumed turn.
    state.queue = new AsyncEventQueue<AgentEvent>();
    this.spawnClaude(state, input.reply, state.task.sessionId);
    return state.task;
  }

  async cancel(taskId: string): Promise<void> {
    const state = this.tasks.get(taskId);
    if (!state) throw new Error(`未知任务：${taskId}`);
    state.canceled = true;
    if (state.child && !state.child.killed) {
      state.child.kill('SIGTERM');
    }
    state.task.status = 'CANCELED';
    state.queue.push({ type: 'failed', taskId, error: '任务已取消' });
    state.queue.end();
  }

  /**
   * Stop the current turn but keep the conversation resumable. The child process
   * is killed, yet the session id survives, so a follow-up continue() can
   * --resume it. We end the turn as `completed` (not `failed`) so the job settles
   * to SUCCEEDED and the input box re-enables for the next message.
   */
  async interrupt(taskId: string): Promise<void> {
    const state = this.tasks.get(taskId);
    if (!state) throw new Error(`未知任务：${taskId}`);
    // Mark so this spawn's close handler doesn't also emit a failure.
    state.sawResult = true;
    if (state.child && !state.child.killed) {
      state.child.kill('SIGTERM');
    }
    state.task.status = 'SUCCEEDED';
    state.queue.push({ type: 'completed', taskId, summary: '（已终止本次回复，你可以继续输入）' });
    state.queue.end();
  }

  events(taskId: string): AsyncIterable<AgentEvent> {
    const state = this.tasks.get(taskId);
    if (!state) throw new Error(`未知任务：${taskId}`);
    return state.queue.iterate();
  }
}
