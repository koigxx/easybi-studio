import { describe, it, expect } from 'vitest';
import {
  emptyChat,
  reduceEvent,
  reduceEvents,
  isTerminal,
  actionLabel,
  groupRows,
  toolGroupSummary,
  type ChatModel,
  type ChatLine,
  type ChatToolLine,
} from './agent-chat.js';
import type { JobEvent } from '../api.js';

function ev(type: JobEvent['type'], payload?: Record<string, unknown>): JobEvent {
  return { type, jobId: 'j1', at: '2026-07-19T00:00:00Z', payload };
}

describe('agent-chat reducer', () => {
  it('appends consecutive message_delta into one assistant line', () => {
    let m = emptyChat();
    m = reduceEvent(m, ev('message_delta', { text: 'Hello ' }));
    m = reduceEvent(m, ev('message_delta', { text: 'world' }));
    expect(m.lines).toHaveLength(1);
    expect(m.lines[0]).toEqual({ kind: 'assistant', text: 'Hello world' });
    expect(m.status).toBe('RUNNING');
  });

  it('starts a new assistant line after a tool line interrupts', () => {
    let m = emptyChat();
    m = reduceEvent(m, ev('message_delta', { text: 'a' }));
    m = reduceEvent(m, ev('tool_started', { tool: 'Bash', detail: 'ls' }));
    m = reduceEvent(m, ev('message_delta', { text: 'b' }));
    expect(m.lines.map((l) => l.kind)).toEqual(['assistant', 'tool', 'assistant']);
    expect((m.lines[0] as { text: string }).text).toBe('a');
    expect((m.lines[2] as { text: string }).text).toBe('b');
  });

  it('marks a running tool line finished on tool_finished', () => {
    let m = emptyChat();
    m = reduceEvent(m, ev('tool_started', { tool: 'Read' }));
    expect((m.lines[0] as ChatToolLine).running).toBe(true);
    m = reduceEvent(m, ev('tool_finished', { tool: 'Read', ok: true }));
    const tool = m.lines[0] as ChatToolLine;
    expect(tool.running).toBe(false);
    expect(tool.ok).toBe(true);
  });

  it('records failed tool result (ok=false)', () => {
    let m = emptyChat();
    m = reduceEvent(m, ev('tool_started', { tool: 'Bash' }));
    m = reduceEvent(m, ev('tool_finished', { tool: 'Bash', ok: false, detail: 'exit 1' }));
    const tool = m.lines[0] as ChatToolLine;
    expect(tool.ok).toBe(false);
    expect(tool.detail).toBe('exit 1');
  });

  it('enters WAITING_FOR_USER with the question', () => {
    let m = emptyChat();
    m = reduceEvent(m, ev('waiting_for_user', { question: '确认删除？' }));
    expect(m.status).toBe('WAITING_FOR_USER');
    expect(m.waitingQuestion).toBe('确认删除？');
    expect(m.lines.at(-1)).toEqual({ kind: 'notice', text: '确认删除？' });
  });

  it('captures checkpointId without adding a line', () => {
    let m = emptyChat();
    m = reduceEvent(m, ev('checkpoint_created', { checkpointId: 'ckpt_1' }));
    expect(m.checkpointId).toBe('ckpt_1');
    expect(m.lines).toHaveLength(0);
  });

  it('keeps one chat while a fresh report phase adds a visible boundary', () => {
    let m = emptyChat('SUCCEEDED');
    m = reduceEvent(m, ev('phase_changed', {
      phase: 'MODELING',
      label: '确定建模',
      contextReset: true,
      runId: 'run-2',
    }));
    m = reduceEvent(m, ev('run_started', { phase: 'MODELING', runId: 'run-2' }));
    m = reduceEvent(m, ev('user_message', { text: '确认关系' }));
    expect(m.phase).toBe('MODELING');
    expect(m.status).toBe('RUNNING');
    expect(m.lines).toEqual([
      { kind: 'notice', text: '进入「确定建模」：已启动干净的 Agent 上下文。' },
      { kind: 'user', text: '确认关系' },
    ]);
  });

  it('shows the deterministic stage validation error instead of a generic phase label', () => {
    const m = reduceEvent(
      emptyChat('SUCCEEDED'),
      ev('phase_changed', {
        phase: 'DISCOVERY',
        label: '基础建模（产物需修复）',
        validationFailed: true,
        error: '基础模型必须描述结果粒度假设',
      }),
    );
    expect(m.lines.at(-1)).toEqual({
      kind: 'notice',
      text: '阶段产物未通过校验：基础模型必须描述结果粒度假设',
    });
  });

  it('captures the structured one-shot model confirmation from the phase gate', () => {
    const m = reduceEvent(
      emptyChat('SUCCEEDED'),
      ev('phase_changed', {
        phase: 'AWAITING_MODEL_CONFIRMATION',
        label: '等待统一确认模型',
        details: {
          model_confirmation: {
            confirmation_format_version: '1',
            report_id: 'r1',
            discovery_revision: 'rev-1',
            discovery_model_hash: 'hash-1',
            questions: [
              {
                id: 'grain',
                question: '按哪个字段去重？',
                options: [
                  { value: 'id', label: '主键' },
                  { value: 'code', label: '业务编码' },
                ],
                recommended: 'id',
                required: true,
                affected_metrics: ['订单数量'],
              },
            ],
            metric_hypotheses: [{ label: '订单数量', aggregation: 'count_distinct' }],
            relationship_hypotheses: [],
          },
        },
      }),
    );
    expect(m.modelConfirmation?.discovery_revision).toBe('rev-1');
    expect(m.modelConfirmation?.questions[0]?.recommended).toBe('id');
    expect(m.modelConfirmation?.metric_hypotheses[0]?.aggregation).toBe('count_distinct');
  });

  it('completes with summary and clears waiting', () => {
    let m: ChatModel = { ...emptyChat('WAITING_FOR_USER'), waitingQuestion: 'q' };
    m = reduceEvent(m, ev('job_completed', { summary: '生成了 3 张表' }));
    expect(m.status).toBe('SUCCEEDED');
    expect(m.summary).toBe('生成了 3 张表');
    expect(m.waitingQuestion).toBeUndefined();
  });

  it('does not duplicate the final answer when job_completed summary equals the last assistant line', () => {
    let m = emptyChat('RUNNING');
    m = reduceEvent(m, ev('message_delta', { text: '这是最终确认的计划。' }));
    m = reduceEvent(m, ev('job_completed', { summary: '这是最终确认的计划。' }));
    // The summary is stored but NOT re-appended as a notice line.
    expect(m.summary).toBe('这是最终确认的计划。');
    const notices = m.lines.filter((l) => l.kind === 'notice');
    expect(notices).toHaveLength(0);
    expect(m.lines.filter((l) => l.kind === 'assistant')).toHaveLength(1);
  });

  it('still shows summary as a notice when it differs from the last assistant line', () => {
    let m = emptyChat('RUNNING');
    m = reduceEvent(m, ev('message_delta', { text: '正在处理…' }));
    m = reduceEvent(m, ev('job_completed', { summary: '已生成 3 张报表。' }));
    expect(m.lines.at(-1)).toEqual({ kind: 'notice', text: '已生成 3 张报表。' });
  });

  it('groups consecutive tool lines and keeps other rows in order', () => {
    const lines: ChatLine[] = [
      { kind: 'assistant', text: 'hi' },
      { kind: 'tool', tool: 'Read', running: false, ok: true },
      { kind: 'tool', tool: 'Grep', running: false, ok: true },
      { kind: 'notice', text: 'done' },
      { kind: 'tool', tool: 'Bash', running: true },
    ];
    const rows = groupRows(lines);
    expect(rows.map((r) => r.kind)).toEqual(['assistant', 'tool-group', 'notice', 'tool-group']);
    const firstGroup = rows[1];
    if (!firstGroup || firstGroup.kind !== 'tool-group') throw new Error('expected tool-group');
    expect(firstGroup.tools).toHaveLength(2);
  });

  it('summarizes a tool group with counts', () => {
    const tools: ChatToolLine[] = [
      { kind: 'tool', tool: 'Read', running: false, ok: true },
      { kind: 'tool', tool: 'Bash', running: true },
      { kind: 'tool', tool: 'Grep', running: false, ok: false },
    ];
    expect(toolGroupSummary(tools)).toBe('3 个步骤 · 1 进行中 · 1 失败');
  });

  it('fails with error text', () => {
    let m = emptyChat();
    m = reduceEvent(m, ev('job_failed', { error: '连接超时' }));
    expect(m.status).toBe('FAILED');
    expect(m.error).toBe('连接超时');
    expect(m.lines.at(-1)).toEqual({ kind: 'notice', text: '失败：连接超时' });
  });

  it('ignores job_started and provider-only phase_changed events', () => {
    let m = emptyChat();
    m = reduceEvents(m, [ev('job_started'), ev('phase_changed', { sessionId: 's1' })]);
    expect(m.lines).toHaveLength(0);
    expect(m.status).toBe('QUEUED');
  });

  it('isTerminal true only for terminal states', () => {
    expect(isTerminal('SUCCEEDED')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('CANCELED')).toBe(true);
    expect(isTerminal('RUNNING')).toBe(false);
    expect(isTerminal('WAITING_FOR_USER')).toBe(false);
  });

  it('actionLabel resolves known actions and falls back to raw', () => {
    expect(actionLabel('create-report')).toBe('构建报表');
    expect(actionLabel('initialize-knowledge')).toBe('初始化知识库');
    expect(actionLabel('mystery')).toBe('mystery');
  });
});
