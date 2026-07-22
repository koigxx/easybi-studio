import { describe, it, expect } from 'vitest';
import { FakeAgentBridge, AsyncEventQueue } from '@easybi-studio/agent-bridge';
import type {
  AgentBridge,
  AgentEvent,
  AgentHealth,
  AgentTask,
  ContinueAgentInput,
  StartAgentInput,
} from '@easybi-studio/contracts';
import { JobManager, WriteTaskConflictError, type EventStore } from './manager.js';
import type { Job, JobEvent } from '@easybi-studio/contracts';
import { JobEventTypes } from '@easybi-studio/contracts';

/** In-memory EventStore mirroring the SQLite JobStore contract, for tests. */
class MemEventStore implements EventStore {
  events = new Map<string, JobEvent[]>();
  jobs = new Map<string, Job>();
  runs = new Map<string, import('@easybi-studio/contracts').AgentRun[]>();
  appendEvent(jobId: string, seq: number, event: JobEvent): void {
    const list = this.events.get(jobId) ?? [];
    list[seq] = event;
    this.events.set(jobId, list);
  }
  listEvents(jobId: string): JobEvent[] {
    return (this.events.get(jobId) ?? []).filter(Boolean);
  }
  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }
  deleteJob(jobId: string): void {
    this.events.delete(jobId);
    this.jobs.delete(jobId);
  }
  upsertRun(run: import('@easybi-studio/contracts').AgentRun): void {
    const list = this.runs.get(run.conversationId) ?? [];
    const index = list.findIndex((item) => item.id === run.id);
    if (index >= 0) list[index] = { ...run };
    else list.push({ ...run });
    this.runs.set(run.conversationId, list);
  }
  listRuns(conversationId: string): import('@easybi-studio/contracts').AgentRun[] {
    return this.runs.get(conversationId) ?? [];
  }
}

/**
 * A provider that ends each turn as `completed` (like real Claude Code) instead
 * of pausing at WAITING_FOR_USER. Each continue() spawns a fresh event stream,
 * so the JobManager must re-pump on reply. Used to test multi-turn resume from
 * SUCCEEDED.
 */
class TurnByTurnBridge implements AgentBridge {
  private queues = new Map<string, AsyncEventQueue<AgentEvent>>();
  private turn = 0;
  async healthCheck(): Promise<AgentHealth> {
    return { available: true, provider: 'turn-fake', version: '0' };
  }
  async start(input: StartAgentInput): Promise<AgentTask> {
    const taskId = `turn_${(this.turn += 1)}`;
    const q = new AsyncEventQueue<AgentEvent>();
    this.queues.set(taskId, q);
    q.push({ type: 'session', taskId, sessionId: 'sess-1' });
    q.push({ type: 'message_delta', taskId, text: `answer for ${input.action}` });
    q.push({ type: 'completed', taskId, summary: 'turn 1 done' });
    q.end();
    return { taskId, projectId: input.projectId, provider: 'turn-fake', sessionId: 'sess-1', status: 'RUNNING' };
  }
  async continue(input: ContinueAgentInput): Promise<AgentTask> {
    const q = new AsyncEventQueue<AgentEvent>();
    this.queues.set(input.taskId, q);
    q.push({ type: 'message_delta', taskId: input.taskId, text: `reply-answer: ${input.reply}` });
    q.push({ type: 'completed', taskId: input.taskId, summary: 'turn 2 done' });
    q.end();
    return { taskId: input.taskId, projectId: 'p', provider: 'turn-fake', sessionId: 'sess-1', status: 'RUNNING' };
  }
  async cancel(): Promise<void> {}
  events(taskId: string): AsyncIterable<AgentEvent> {
    const q = this.queues.get(taskId);
    if (!q) throw new Error('unknown task');
    return q.iterate();
  }
}

function collect(iter: AsyncIterable<{ type: string; payload?: Record<string, unknown> }>) {
  return (async () => {
    const out: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    for await (const e of iter) out.push(e);
    return out;
  })();
}

const WS = '/tmp/ws-jm';

describe('JobManager with FakeAgentBridge', () => {
  it('streams events, pauses for user, resumes, and completes', async () => {
    const bridge = new FakeAgentBridge({ requireConfirmation: true });
    const jm = new JobManager({ bridge });

    const job = await jm.startAgentJob({
      projectId: 'p1',
      workspaceRoot: WS,
      action: 'initialize-knowledge',
      prompt: 'go',
    });

    // Wait until it reaches WAITING_FOR_USER.
    await waitFor(() => jm.getJob(job.id)?.status === 'WAITING_FOR_USER');
    expect(jm.getJob(job.id)?.status).toBe('WAITING_FOR_USER');

    // Now subscribe and reply; expect completion.
    const eventsPromise = collect(jm.subscribe(job.id));
    await jm.replyToJob(job.id, '同意');
    const events = await eventsPromise;

    const types = events.map((e) => e.type);
    expect(types).toContain(JobEventTypes.WAITING_FOR_USER);
    expect(types).toContain(JobEventTypes.JOB_COMPLETED);
    expect(jm.getJob(job.id)?.status).toBe('SUCCEEDED');
  });

  it('resumes a finished turn on reply (real-Claude style: SUCCEEDED -> RUNNING -> SUCCEEDED)', async () => {
    const bridge = new TurnByTurnBridge();
    const jm = new JobManager({ bridge });

    const job = await jm.startAgentJob({
      projectId: 'p1',
      workspaceRoot: '/tmp/ws-multiturn',
      action: 'create-report',
      prompt: 'first',
    });
    // First turn completes on its own.
    await waitFor(() => jm.getJob(job.id)?.status === 'SUCCEEDED');

    // A follow-up reply resumes the same job with a fresh turn.
    await jm.replyToJob(job.id, 'do more');
    await waitFor(
      () =>
        jm.getJob(job.id)?.status === 'SUCCEEDED' &&
        jm.getEvents(job.id).some((e) => e.payload?.text === 'reply-answer: do more'),
    );

    const texts = jm
      .getEvents(job.id)
      .filter((e) => e.type === JobEventTypes.MESSAGE_DELTA)
      .map((e) => e.payload?.text);
    // Both the first-turn answer and the resumed second-turn answer are present
    // in the same job's event history.
    expect(texts).toContain('answer for create-report');
    expect(texts).toContain('reply-answer: do more');
    // The write slot was re-acquired then released again after the second turn.
    const second = await jm.startAgentJob({
      projectId: 'p1',
      workspaceRoot: '/tmp/ws-multiturn',
      action: 'create-report',
      prompt: 'third',
    });
    expect(second.id).toBeTruthy();
  });

  it('keeps one logical conversation while report phases use fresh provider runs', async () => {
    const bridge = new TurnByTurnBridge();
    const store = new MemEventStore();
    const completedPhases: string[] = [];
    const jm = new JobManager({
      bridge,
      events: store,
      buildReportPhasePrompt: (phase, context) => `fresh ${phase} ${context.reportId}`,
      prepareReportPhase: async ({ phase }) => phase === 'QUERY_COMPILATION'
        ? { ok: true, details: { strategy: 'script', query_ids: ['orders', 'waybills'] } }
        : { ok: true },
      completeReportPhase: async ({ phase }) => {
        completedPhases.push(phase);
        return { ok: true };
      },
      onJobChange: (job) => store.jobs.set(job.id, { ...job }),
    });
    const job = await jm.startAgentJob({
      projectId: 'p1',
      workspaceRoot: '/tmp/ws-phases',
      action: 'create-report',
      prompt: 'discover',
      reportId: 'customer-volume',
    });
    await waitFor(() => jm.getJob(job.id)?.phase === 'AWAITING_DISCOVERY_CONFIRMATION');
    await jm.startFreshPhase({ jobId: job.id, phase: 'MODELING', userMessage: '确认关系' });
    await waitFor(() => jm.getJob(job.id)?.phase === 'AWAITING_MODEL_APPROVAL');
    await jm.startFreshPhase({ jobId: job.id, phase: 'QUERY_COMPILATION', userMessage: '批准模型' });
    await waitFor(() => jm.getJob(job.id)?.phase === 'COMPLETED');

    const runs = store.listRuns(job.id);
    expect(runs.map((run) => run.phase)).toEqual([
      'DISCOVERY',
      'MODELING',
      'QUERY_COMPILATION',
      'QUERY_COMPILATION',
      'SCRIPT_COMPILATION',
    ]);
    expect(runs.filter((run) => run.phase === 'QUERY_COMPILATION').map((run) => run.unitId)).toEqual(['orders', 'waybills']);
    expect(new Set(runs.map((run) => run.providerTaskId)).size).toBe(5);
    expect(completedPhases).toEqual(['DISCOVERY', 'MODELING', 'QUERY_COMPILATION', 'QUERY_COMPILATION', 'SCRIPT_COMPILATION']);
    expect(jm.getEvents(job.id).filter((event) => event.type === JobEventTypes.JOB_STARTED)).toHaveLength(1);
    expect(
      jm.getEvents(job.id).some(
        (event) => event.type === JobEventTypes.PHASE_CHANGED && event.payload?.contextReset === true,
      ),
    ).toBe(true);
  });

  it('does not advance a report phase when deterministic artifact validation fails', async () => {
    const bridge = new TurnByTurnBridge();
    const store = new MemEventStore();
    const jm = new JobManager({
      bridge,
      events: store,
      completeReportPhase: async () => ({ ok: false, error: '缺少 discovery-model.json' }),
      onJobChange: (job) => store.jobs.set(job.id, { ...job }),
    });
    const job = await jm.startAgentJob({
      projectId: 'p1',
      workspaceRoot: '/tmp/ws-gate',
      action: 'create-report',
      prompt: 'discover',
      reportId: 'customer-volume',
    });
    await waitFor(() => jm.getJob(job.id)?.status === 'SUCCEEDED');
    expect(jm.getJob(job.id)?.phase).toBe('DISCOVERY');
    expect(store.listRuns(job.id)[0]?.status).toBe('FAILED');
    expect(jm.getEvents(job.id)).toContainEqual(expect.objectContaining({
      type: JobEventTypes.PHASE_CHANGED,
      payload: expect.objectContaining({ validationFailed: true }),
    }));
  });

  it('finishes a declarative report after configuration compilation without a script run', async () => {
    const bridge = new TurnByTurnBridge();
    const store = new MemEventStore();
    const jm = new JobManager({
      bridge,
      events: store,
      buildReportPhasePrompt: (phase, context) => `${phase}:${context.unitId ?? ''}:${context.strategy ?? ''}`,
      prepareReportPhase: async ({ phase }) => phase === 'QUERY_COMPILATION'
        ? { ok: true, details: { strategy: 'group_queries', query_ids: ['declarative'] } }
        : { ok: true },
      completeReportPhase: async ({ phase }) => phase === 'QUERY_COMPILATION'
        ? { ok: true, details: { workflow_complete: true } }
        : { ok: true },
      onJobChange: (job) => store.jobs.set(job.id, { ...job }),
    });
    const job = await jm.startAgentJob({ projectId: 'p1', workspaceRoot: '/tmp/ws-v2', action: 'create-report', prompt: 'discover', reportId: 'v2-report' });
    await waitFor(() => jm.getJob(job.id)?.phase === 'AWAITING_DISCOVERY_CONFIRMATION');
    await jm.startFreshPhase({ jobId: job.id, phase: 'MODELING', userMessage: '确认' });
    await waitFor(() => jm.getJob(job.id)?.phase === 'AWAITING_MODEL_APPROVAL');
    await jm.startFreshPhase({ jobId: job.id, phase: 'QUERY_COMPILATION', userMessage: '批准' });
    await waitFor(() => jm.getJob(job.id)?.phase === 'COMPLETED');
    expect(store.listRuns(job.id).map((run) => run.phase)).toEqual(['DISCOVERY', 'MODELING', 'QUERY_COMPILATION']);
    expect(store.listRuns(job.id)[2]?.unitId).toBe('declarative');
  });

  it('re-subscribe after a finished turn streams the resumed turn, not the old completion (since cursor)', async () => {
    const bridge = new TurnByTurnBridge();
    const jm = new JobManager({ bridge });

    const job = await jm.startAgentJob({
      projectId: 'p1',
      workspaceRoot: '/tmp/ws-resub',
      action: 'create-report',
      prompt: 'first',
    });
    await waitFor(() => jm.getJob(job.id)?.status === 'SUCCEEDED');

    // Client has consumed the whole first turn (incl. its job_completed).
    const consumed = jm.getEvents(job.id).length;

    // Reply, then re-subscribe with `since = consumed` exactly as the drawer does.
    // Regression: without the cursor the buffer would replay the first turn's
    // job_completed and close the fresh stream before the second turn arrives.
    await jm.replyToJob(job.id, 'do more');
    const events = await collect(jm.subscribe(job.id, consumed));

    const texts = events.filter((e) => e.type === JobEventTypes.MESSAGE_DELTA).map((e) => e.payload?.text);
    expect(texts).toContain('reply-answer: do more');
    // The replayed first-turn answer must NOT reappear on the resumed stream.
    expect(texts).not.toContain('answer for create-report');
    expect(events[events.length - 1]?.type).toBe(JobEventTypes.JOB_COMPLETED);
  });

  it('interrupt settles the job to SUCCEEDED (resumable) instead of CANCELED', async () => {
    const bridge = new FakeAgentBridge({ requireConfirmation: false });
    const jm = new JobManager({ bridge });
    const job = await jm.startAgentJob({
      projectId: 'p1',
      workspaceRoot: '/tmp/ws-interrupt',
      action: 'create-report',
      prompt: 'go',
    });
    await jm.interruptJob(job.id);
    await waitFor(() => jm.getJob(job.id)?.status === 'SUCCEEDED');
    expect(jm.getJob(job.id)?.status).toBe('SUCCEEDED');
    // The write slot is freed, so a new write task in the same workspace is allowed.
    const next = await jm.startAgentJob({
      projectId: 'p1',
      workspaceRoot: '/tmp/ws-interrupt',
      action: 'create-report',
      prompt: 'again',
    });
    expect(next.id).toBeTruthy();
  });

  it('rejects a second concurrent write task in the same workspace', async () => {
    const bridge = new FakeAgentBridge({ requireConfirmation: true });
    const jm = new JobManager({ bridge });

    const first = await jm.startAgentJob({
      projectId: 'p1',
      workspaceRoot: WS,
      action: 'initialize-knowledge',
      prompt: 'a',
    });
    await waitFor(() => jm.getJob(first.id)?.status === 'WAITING_FOR_USER');

    await expect(
      jm.startAgentJob({
        projectId: 'p1',
        workspaceRoot: WS,
        action: 'create-report',
        prompt: 'b',
      }),
    ).rejects.toBeInstanceOf(WriteTaskConflictError);
  });

  it('releases the write slot after the task finishes', async () => {
    const bridge = new FakeAgentBridge({ requireConfirmation: false });
    const jm = new JobManager({ bridge });

    const first = await jm.startAgentJob({
      projectId: 'p1',
      workspaceRoot: '/tmp/ws-free',
      action: 'create-report',
      prompt: 'a',
    });
    await waitFor(() => jm.getJob(first.id)?.status === 'SUCCEEDED');

    // A new write task should now be allowed.
    const second = await jm.startAgentJob({
      projectId: 'p1',
      workspaceRoot: '/tmp/ws-free',
      action: 'create-report',
      prompt: 'b',
    });
    expect(second.id).toBeTruthy();
  });

  it('allows different workspaces to run write tasks concurrently', async () => {
    const bridge = new FakeAgentBridge({ requireConfirmation: true });
    const jm = new JobManager({ bridge });
    const a = await jm.startAgentJob({
      projectId: 'p1',
      workspaceRoot: '/tmp/ws-a',
      action: 'initialize-knowledge',
      prompt: 'a',
    });
    const b = await jm.startAgentJob({
      projectId: 'p2',
      workspaceRoot: '/tmp/ws-b',
      action: 'initialize-knowledge',
      prompt: 'b',
    });
    expect(a.id).not.toBe(b.id);
  });

  it('can cancel a waiting task', async () => {
    const bridge = new FakeAgentBridge({ requireConfirmation: true });
    const jm = new JobManager({ bridge });
    const job = await jm.startAgentJob({
      projectId: 'p1',
      workspaceRoot: '/tmp/ws-cancel',
      action: 'initialize-knowledge',
      prompt: 'x',
    });
    await waitFor(() => jm.getJob(job.id)?.status === 'WAITING_FOR_USER');
    await jm.cancelJob(job.id);
    expect(jm.getJob(job.id)?.status).toBe('CANCELED');
  });

  it('keeps job history and buffered events (page switch does not lose task)', async () => {
    const bridge = new FakeAgentBridge({ requireConfirmation: false });
    const jm = new JobManager({ bridge });
    const job = await jm.startAgentJob({
      projectId: 'p1',
      workspaceRoot: '/tmp/ws-hist',
      action: 'validate-report',
      prompt: 'x',
    });
    await waitFor(() => jm.getJob(job.id)?.status === 'SUCCEEDED');
    // Simulate re-opening the drawer after switching pages: buffered events remain.
    const events = jm.getEvents(job.id);
    expect(events.length).toBeGreaterThan(0);
    expect(jm.listJobs('p1').map((j) => j.id)).toContain(job.id);
  });

  it('deletes a finished conversation but refuses an active one', async () => {
    const store = new MemEventStore();
    const bridge = new FakeAgentBridge({ requireConfirmation: true });
    const jm = new JobManager({
      bridge,
      events: store,
      onJobChange: (j) => store.jobs.set(j.id, j),
    });
    const job = await jm.startAgentJob({
      projectId: 'p1',
      workspaceRoot: '/tmp/ws-del',
      action: 'initialize-knowledge',
      prompt: 'x',
    });
    await waitFor(() => jm.getJob(job.id)?.status === 'WAITING_FOR_USER');
    // Active job cannot be deleted.
    expect(() => jm.deleteJob(job.id)).toThrow(/进行中/);

    await jm.cancelJob(job.id);
    expect(jm.deleteJob(job.id)).toBe(true);
    expect(jm.getJob(job.id)).toBeUndefined();
    expect(store.listEvents(job.id)).toHaveLength(0);
    // Deleting the write job also freed the workspace write slot.
    const next = await jm.startAgentJob({
      projectId: 'p1',
      workspaceRoot: '/tmp/ws-del',
      action: 'create-report',
      prompt: 'y',
    });
    expect(next.id).toBeTruthy();
  });

  it('persists conversation events to the EventStore', async () => {
    const store = new MemEventStore();
    const bridge = new FakeAgentBridge({ requireConfirmation: false });
    const jm = new JobManager({
      bridge,
      events: store,
      onJobChange: (j) => store.jobs.set(j.id, j),
    });
    const job = await jm.startAgentJob({
      projectId: 'p1',
      workspaceRoot: '/tmp/ws-persist',
      action: 'validate-report',
      prompt: 'x',
    });
    await waitFor(() => jm.getJob(job.id)?.status === 'SUCCEEDED');
    // The store holds the full ordered event log independent of in-memory state.
    const persisted = store.listEvents(job.id);
    expect(persisted.length).toBe(jm.getEvents(job.id).length);
    expect(persisted.some((e) => e.type === JobEventTypes.JOB_COMPLETED)).toBe(true);
  });

  it('reopens a past conversation from the store after a restart, then resumes it', async () => {
    const store = new MemEventStore();
    const WS_R = '/tmp/ws-restart';

    // First Studio instance runs a chat to completion; it persists to the store.
    {
      const bridge = new TurnByTurnBridge();
      const jm = new JobManager({
        bridge,
        events: store,
        onJobChange: (j) => store.jobs.set(j.id, j),
      });
      const job = await jm.startAgentJob({
        projectId: 'p1',
        workspaceRoot: WS_R,
        action: 'create-report',
        prompt: 'first',
      });
      await waitFor(() => jm.getJob(job.id)?.status === 'SUCCEEDED');
    }

    const jobId = [...store.jobs.keys()][0]!;

    // Second Studio instance: fresh manager+bridge (nothing in memory), like a restart.
    const bridge2 = new TurnByTurnBridge();
    const jm2 = new JobManager({
      bridge: bridge2,
      events: store,
      onJobChange: (j) => store.jobs.set(j.id, j),
    });

    // Reopen loads the persisted job + events (viewable).
    const reopened = jm2.reopenJob(jobId, WS_R);
    expect(reopened?.id).toBe(jobId);
    expect(jm2.getEvents(jobId).some((e) => e.payload?.text === 'answer for create-report')).toBe(
      true,
    );

    // Continue the reopened chat: rehydrate happens for real Claude; the fake
    // bridge just resumes and produces a second turn.
    await jm2.replyToJob(jobId, 'more please');
    await waitFor(() =>
      jm2.getEvents(jobId).some((e) => e.payload?.text === 'reply-answer: more please'),
    );
    expect(jm2.getJob(jobId)?.status).toBe('SUCCEEDED');
  });
});

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}
