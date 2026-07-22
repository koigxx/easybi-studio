import type {
  AgentBridge,
  AgentEvent,
  AgentHealth,
  AgentTask,
  ContinueAgentInput,
  StartAgentInput,
} from '@easybi-studio/contracts';
import { AsyncEventQueue } from './event-queue.js';

/**
 * FakeAgentBridge (plan stage 4): a deterministic, offline provider used to
 * exercise the job system, SSE stream, WAITING_FOR_USER/resume and cancel flows
 * WITHOUT launching a real Claude Code process. It normalizes into the same
 * AgentEvent shape every provider must emit.
 */
interface FakeTaskState {
  task: AgentTask;
  queue: AsyncEventQueue<AgentEvent>;
  waiting: boolean;
  canceled: boolean;
  /** Resolves the pending "waiting" gate when the user replies. */
  resumeGate?: () => void;
}

export interface FakeBridgeOptions {
  /** Delay (ms) between scripted events; 0 for tests. */
  stepDelayMs?: number;
  /** When true, the scripted run pauses once for user confirmation. */
  requireConfirmation?: boolean;
}

let counter = 0;

export class FakeAgentBridge implements AgentBridge {
  private tasks = new Map<string, FakeTaskState>();
  private readonly stepDelay: number;
  private readonly requireConfirmation: boolean;

  constructor(options: FakeBridgeOptions = {}) {
    this.stepDelay = options.stepDelayMs ?? 0;
    this.requireConfirmation = options.requireConfirmation ?? true;
  }

  async healthCheck(): Promise<AgentHealth> {
    return { available: true, provider: 'fake', version: '0', note: '离线 Fake Provider' };
  }

  private async delay(): Promise<void> {
    if (this.stepDelay > 0) await new Promise((r) => setTimeout(r, this.stepDelay));
  }

  async start(input: StartAgentInput): Promise<AgentTask> {
    counter += 1;
    const taskId = `fake_${counter}_${input.action}`;
    const sessionId = `sess_${counter}`;
    const task: AgentTask = {
      taskId,
      projectId: input.projectId,
      provider: 'fake',
      sessionId,
      status: 'RUNNING',
    };
    const state: FakeTaskState = {
      task,
      queue: new AsyncEventQueue<AgentEvent>(),
      waiting: false,
      canceled: false,
    };
    this.tasks.set(taskId, state);
    void this.run(state, input);
    return task;
  }

  private async run(state: FakeTaskState, input: StartAgentInput): Promise<void> {
    const { queue, task } = state;
    const emit = (e: AgentEvent): void => queue.push(e);
    try {
      emit({ type: 'session', taskId: task.taskId, sessionId: task.sessionId! });
      await this.delay();
      if (state.canceled) return this.finishCanceled(state);

      emit({ type: 'message_delta', taskId: task.taskId, text: `开始执行 ${input.action}…` });
      emit({ type: 'tool_started', taskId: task.taskId, tool: 'read-skill', detail: 'SKILL.md' });
      await this.delay();
      emit({ type: 'tool_finished', taskId: task.taskId, tool: 'read-skill', ok: true });
      if (state.canceled) return this.finishCanceled(state);

      if (this.requireConfirmation) {
        state.waiting = true;
        task.status = 'WAITING_FOR_USER';
        emit({
          type: 'waiting_for_user',
          taskId: task.taskId,
          question: '请确认热温冷分层方案是否可以继续？',
        });
        // Block until the user replies or the task is canceled.
        await new Promise<void>((resolve) => {
          state.resumeGate = resolve;
        });
        if (state.canceled) return this.finishCanceled(state);
        state.waiting = false;
        task.status = 'RUNNING';
      }

      emit({ type: 'message_delta', taskId: task.taskId, text: '已确认，继续生成产物…' });
      await this.delay();
      if (state.canceled) return this.finishCanceled(state);

      emit({ type: 'completed', taskId: task.taskId, summary: '任务完成（Fake）' });
      task.status = 'SUCCEEDED';
    } catch (err) {
      task.status = 'FAILED';
      emit({ type: 'failed', taskId: task.taskId, error: String((err as Error).message ?? err) });
    } finally {
      queue.end();
    }
  }

  private finishCanceled(state: FakeTaskState): void {
    state.task.status = 'CANCELED';
    state.queue.push({ type: 'failed', taskId: state.task.taskId, error: '任务已取消' });
    state.queue.end();
  }

  async continue(input: ContinueAgentInput): Promise<AgentTask> {
    const state = this.tasks.get(input.taskId);
    if (!state) throw new Error(`未知任务：${input.taskId}`);
    if (!state.waiting || !state.resumeGate) {
      throw new Error('任务当前不处于等待用户状态');
    }
    state.queue.push({
      type: 'message_delta',
      taskId: input.taskId,
      text: `收到用户回复：${input.reply}`,
    });
    const gate = state.resumeGate;
    state.resumeGate = undefined;
    gate();
    return state.task;
  }

  async cancel(taskId: string): Promise<void> {
    const state = this.tasks.get(taskId);
    if (!state) throw new Error(`未知任务：${taskId}`);
    state.canceled = true;
    // If it is waiting, release the gate so run() can observe cancellation.
    if (state.resumeGate) {
      const gate = state.resumeGate;
      state.resumeGate = undefined;
      gate();
    }
  }

  /** Stop the current turn but keep the task resumable (settles to SUCCEEDED). */
  async interrupt(taskId: string): Promise<void> {
    const state = this.tasks.get(taskId);
    if (!state) throw new Error(`未知任务：${taskId}`);
    // Release a waiting gate (if any) so the run loop can exit cleanly.
    if (state.resumeGate) {
      const gate = state.resumeGate;
      state.resumeGate = undefined;
      gate();
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

  /** Test helper. */
  getTask(taskId: string): AgentTask | undefined {
    return this.tasks.get(taskId)?.task;
  }
}
