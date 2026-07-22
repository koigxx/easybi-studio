import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAgentBridge } from '@easybi-studio/agent-bridge';
import { buildApp, type StudioApp } from '../app.js';
import { openDatabase } from '../db/database.js';
import { JobStore } from './store.js';

const SOURCE = '/Users/admin/innos/easy-bi-workspace/easy-bi';

let allowedRoot: string;
let studio: StudioApp;

async function waitForStatus(taskId: string, status: string, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const res = await studio.app.inject({ method: 'GET', url: `/api/easybi/agent-tasks/${taskId}` });
    if (res.statusCode === 200 && res.json().data.job.status === status) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for ${status}`);
}

beforeAll(async () => {
  allowedRoot = await mkdtemp(join(tmpdir(), 'easybi-jobroot-'));
  studio = buildApp({
    dbFile: ':memory:',
    allowedWorkspaceRoots: [allowedRoot],
    config: { skillSourceDir: SOURCE },
    claude: {},
    agentBridge: new FakeAgentBridge({ stepDelayMs: 0 }),
  });
  const ws = join(allowedRoot, 'jobws');
  await mkdir(ws, { recursive: true });
  await studio.app.inject({
    method: 'POST',
    url: '/api/easybi/projects',
    payload: { name: '任务测试', workspaceRoot: ws, id: 'jobws' },
  });
});

afterAll(async () => {
  await studio.app.close();
  await rm(allowedRoot, { recursive: true, force: true });
});

describe('agent-action job routes (FakeAgentBridge)', () => {
  it('starts a job, reaches WAITING_FOR_USER, replies, and completes', async () => {
    const start = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects/jobws/agent-actions',
      payload: { action: 'initialize-knowledge', prompt: 'go' },
    });
    expect(start.statusCode).toBe(201);
    const taskId = start.json().data.job.id;

    await waitForStatus(taskId, 'WAITING_FOR_USER');

    const reply = await studio.app.inject({
      method: 'POST',
      url: `/api/easybi/agent-tasks/${taskId}/messages`,
      payload: { reply: '同意' },
    });
    expect(reply.statusCode).toBe(200);

    await waitForStatus(taskId, 'SUCCEEDED');
  });

  it('rejects a second concurrent write task with 409', async () => {
    const first = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects/jobws/agent-actions',
      payload: { action: 'create-report', prompt: 'a', reportId: 'report-a' },
    });
    expect(first.statusCode).toBe(201);
    await waitForStatus(first.json().data.job.id, 'WAITING_FOR_USER');

    const second = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects/jobws/agent-actions',
      payload: { action: 'modify-report', prompt: 'b', reportId: 'report-b' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('WRITE_TASK_CONFLICT');
  });

  it('lists persisted task history', async () => {
    const res = await studio.app.inject({
      method: 'GET',
      url: '/api/easybi/agent-tasks?projectId=jobws',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.jobs.length).toBeGreaterThan(0);
  });

  it('persists the conversation event log and can reopen it', async () => {
    const start = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects/jobws/agent-actions',
      payload: { action: 'validate-report', prompt: 'go' },
    });
    const taskId = start.json().data.job.id;
    // FakeAgentBridge pauses once for confirmation; reply to let it finish.
    await waitForStatus(taskId, 'WAITING_FOR_USER');
    await studio.app.inject({
      method: 'POST',
      url: `/api/easybi/agent-tasks/${taskId}/messages`,
      payload: { reply: 'ok' },
    });
    await waitForStatus(taskId, 'SUCCEEDED');

    // Reopen returns the full persisted event log for the finished chat.
    const reopen = await studio.app.inject({
      method: 'POST',
      url: `/api/easybi/agent-tasks/${taskId}/reopen`,
    });
    expect(reopen.statusCode).toBe(200);
    const data = reopen.json().data;
    expect(data.job.id).toBe(taskId);
    expect(Array.isArray(data.events)).toBe(true);
    expect(data.events.length).toBeGreaterThan(0);
    expect(data.events.some((e: { type: string }) => e.type === 'job_completed')).toBe(true);
  });

  it('reopen returns 404 for an unknown task', async () => {
    const res = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/agent-tasks/does-not-exist/reopen',
    });
    expect(res.statusCode).toBe(404);
  });

  it('runs a free-chat task from a raw prompt (no preset action)', async () => {
    const start = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects/jobws/agent-actions',
      payload: { action: 'free-chat', prompt: '你好' },
    });
    expect(start.statusCode).toBe(201);
    const taskId = start.json().data.job.id;
    // Free-chat is read-only: no write mutex, so a write task can still start.
    await waitForStatus(taskId, 'WAITING_FOR_USER').catch(() => undefined);
    await studio.app.inject({
      method: 'POST',
      url: `/api/easybi/agent-tasks/${taskId}/messages`,
      payload: { reply: 'ok' },
    });
    await waitForStatus(taskId, 'SUCCEEDED');
  });

  it('rejects a free-chat with no prompt', async () => {
    const res = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects/jobws/agent-actions',
      payload: { action: 'free-chat' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('deletes a finished conversation from history', async () => {
    const start = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects/jobws/agent-actions',
      payload: { action: 'validate-report', prompt: 'go' },
    });
    const taskId = start.json().data.job.id;
    await waitForStatus(taskId, 'WAITING_FOR_USER');
    await studio.app.inject({
      method: 'POST',
      url: `/api/easybi/agent-tasks/${taskId}/messages`,
      payload: { reply: 'ok' },
    });
    await waitForStatus(taskId, 'SUCCEEDED');

    const del = await studio.app.inject({ method: 'DELETE', url: `/api/easybi/agent-tasks/${taskId}` });
    expect(del.statusCode).toBe(200);
    // Gone from history and no longer fetchable.
    const get = await studio.app.inject({ method: 'GET', url: `/api/easybi/agent-tasks/${taskId}` });
    expect(get.statusCode).toBe(404);
  });

  it('refuses to delete an active conversation (409)', async () => {
    // free-chat is read-only (no write mutex), so it starts even if a prior test
    // left a write task active; FakeBridge still pauses it at WAITING_FOR_USER.
    const start = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects/jobws/agent-actions',
      payload: { action: 'free-chat', prompt: '在吗' },
    });
    expect(start.statusCode).toBe(201);
    const taskId = start.json().data.job.id;
    await waitForStatus(taskId, 'WAITING_FOR_USER');
    const del = await studio.app.inject({ method: 'DELETE', url: `/api/easybi/agent-tasks/${taskId}` });
    expect(del.statusCode).toBe(409);
    // Clean up.
    await studio.app.inject({ method: 'POST', url: `/api/easybi/agent-tasks/${taskId}/cancel` });
  });
});

describe('restart reconciliation', () => {
  it('marks sessionless interrupted jobs FAILED, resumable ones SUCCEEDED', () => {
    const db = openDatabase(':memory:');
    // Seed a fake project + two active jobs: one with a saved session (resumable),
    // one without (dead/interrupted).
    db.raw
      .prepare(
        `INSERT INTO projects (id, name, workspace_root, created_at, updated_at)
         VALUES ('p','p','/tmp/p','t','t')`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO jobs (id, project_id, type, status, session_id, created_at)
         VALUES ('j1','p','agent','RUNNING',NULL,'t'),
                ('j2','p','agent','WAITING_FOR_USER','sess-9','t')`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO agent_runs
          (id, conversation_id, provider_task_id, context_mode, status, created_at)
         VALUES ('r2','j2','provider-2','fresh','RUNNING','t')`,
      )
      .run();
    const store = new JobStore(db.raw);
    const changed = store.reconcileOnStartup();
    expect(changed).toBe(2);
    const byId = new Map(store.list('p').map((j) => [j.id, j.status]));
    // No session → FAILED (interrupted); has session → SUCCEEDED (reopen + resume).
    expect(byId.get('j1')).toBe('FAILED');
    expect(byId.get('j2')).toBe('SUCCEEDED');
    expect(store.listRuns('j2')[0]?.status).toBe('FAILED');
    db.close();
  });
});
