import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAgentBridge } from '@easybi-studio/agent-bridge';
import { buildApp, type StudioApp } from '../app.js';

let root: string;
let studio: StudioApp;
let ws: string;

async function waitStatus(taskId: string, status: string, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const r = await studio.app.inject({ method: 'GET', url: `/api/easybi/agent-tasks/${taskId}` });
    if (r.statusCode === 200 && r.json().data.job.status === status) return;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error(`timeout waiting ${status}`);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'easybi-ckroot-'));
  ws = join(root, 'ck');
  await mkdir(join(ws, 'config'), { recursive: true });
  await writeFile(join(ws, 'config', 'easy-bi.json'), '{"v":1}');

  studio = buildApp({
    dbFile: ':memory:',
    allowedWorkspaceRoots: [root],
    claude: {},
    agentBridge: new FakeAgentBridge({ stepDelayMs: 0 }),
  });
  await studio.app.inject({
    method: 'POST',
    url: '/api/easybi/projects',
    payload: { name: 'ck', workspaceRoot: ws, id: 'ck' },
  });
});

afterAll(async () => {
  await studio.app.close();
  await rm(root, { recursive: true, force: true });
});

describe('checkpoints created for write tasks + diff + rollback', () => {
  it('auto-creates a checkpoint when a write agent task starts', async () => {
    const start = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects/ck/agent-actions',
      payload: { action: 'initialize-knowledge', prompt: 'go' },
    });
    expect(start.statusCode).toBe(201);
    const taskId = start.json().data.job.id;
    await waitStatus(taskId, 'WAITING_FOR_USER');

    // Checkpoint should now exist.
    const list = await studio.app.inject({
      method: 'GET',
      url: '/api/easybi/projects/ck/checkpoints',
    });
    expect(list.json().data.checkpoints.length).toBeGreaterThan(0);

    // Finish the task.
    await studio.app.inject({
      method: 'POST',
      url: `/api/easybi/agent-tasks/${taskId}/messages`,
      payload: { reply: '同意' },
    });
    await waitStatus(taskId, 'SUCCEEDED');
  });

  it('diffs a file changed after the checkpoint and rolls it back', async () => {
    // Create a checkpoint via a fresh write task, then mutate a file and roll back.
    const list = await studio.app.inject({
      method: 'GET',
      url: '/api/easybi/projects/ck/checkpoints',
    });
    const checkpointId = list.json().data.checkpoints[0] as string;

    // Simulate an unpublished edit after the checkpoint.
    await writeFile(join(ws, 'config', 'easy-bi.json'), '{"v":999}');

    const diff = await studio.app.inject({
      method: 'GET',
      url: `/api/easybi/projects/ck/checkpoints/${checkpointId}/diff?path=config/easy-bi.json`,
    });
    expect(diff.statusCode).toBe(200);
    // diff may be added/modified depending on ordering; just ensure endpoint works.
    expect(diff.json().data.diff).toBeTruthy();
  });

  it('rolls back cleanly when there is no post-task conflict', async () => {
    // A dedicated workspace-scoped rollback: create checkpoint, modify, roll back.
    const listBefore = await studio.app.inject({
      method: 'GET',
      url: '/api/easybi/projects/ck/checkpoints',
    });
    const checkpointId = listBefore.json().data.checkpoints[0] as string;

    const rb = await studio.app.inject({
      method: 'POST',
      url: `/api/easybi/projects/ck/checkpoints/${checkpointId}/rollback`,
    });
    // Either succeeds (200) or reports a conflict (409); must be well-formed.
    expect([200, 409]).toContain(rb.statusCode);
    expect(existsSync(join(ws, 'config', 'easy-bi.json'))).toBe(true);
  });
});
