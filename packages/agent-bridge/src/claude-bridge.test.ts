import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ClaudeCodeBridge } from './claude-bridge.js';
import type { AgentEvent } from '@easybi-studio/contracts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(__dirname, '..', 'test-fixtures', 'fake-claude.mjs');

async function drain(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe('ClaudeCodeBridge against a fake Claude CLI (process protocol)', () => {
  it('reports health via --version', async () => {
    const bridge = new ClaudeCodeBridge({ claudePath: FAKE_CLI });
    const health = await bridge.healthCheck();
    expect(health.available).toBe(true);
    expect(health.version).toContain('fake-claude');
  });

  it('normalizes stream-json into AgentEvents, captures session, redacts secrets', async () => {
    const bridge = new ClaudeCodeBridge({ claudePath: FAKE_CLI });
    const task = await bridge.start({
      projectId: 'p',
      workspaceRoot: process.cwd(),
      action: 'initialize-knowledge',
      prompt: '创建 hello.txt',
    });
    const events = await drain(bridge.events(task.taskId));
    const types = events.map((e) => e.type);

    expect(types).toContain('session');
    expect(types).toContain('message_delta');
    expect(types).toContain('tool_started');
    expect(types).toContain('tool_finished');
    expect(types).toContain('completed');

    // Session id captured.
    const sess = events.find((e) => e.type === 'session');
    expect(sess && 'sessionId' in sess && sess.sessionId).toBe('sess-fake-0001');

    // Secret must be redacted in the message stream.
    const joined = events
      .filter((e): e is Extract<AgentEvent, { type: 'message_delta' }> => e.type === 'message_delta')
      .map((e) => e.text)
      .join('');
    expect(joined).not.toContain('hunter2');
    expect(joined).toContain('password="***"');
  });

  it('resumes a saved session with --resume and completes', async () => {
    const bridge = new ClaudeCodeBridge({ claudePath: FAKE_CLI });
    const task = await bridge.start({
      projectId: 'p',
      workspaceRoot: process.cwd(),
      action: 'initialize-knowledge',
      prompt: 'first turn',
    });
    await drain(bridge.events(task.taskId));
    expect(task.sessionId).toBe('sess-fake-0001');

    const resumed = await bridge.continue({ taskId: task.taskId, reply: '同意' });
    const events = await drain(bridge.events(resumed.taskId));
    const completed = events.find((e) => e.type === 'completed');
    expect(completed && 'summary' in completed && completed.summary).toContain('继续');
  });
});
