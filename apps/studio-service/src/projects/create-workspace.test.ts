import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type StudioApp } from '../app.js';

const SOURCE = '/Users/admin/innos/easy-bi-workspace/easy-bi';
const available = existsSync(join(SOURCE, 'skills', 'bundle.manifest.json'));
const maybe = available ? describe : describe.skip;

let root: string;
let studio: StudioApp;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'easybi-newws-'));
  studio = buildApp({
    dbFile: ':memory:',
    allowedWorkspaceRoots: [root],
    config: { dataDir: join(root, '.data'), skillSourceDir: SOURCE, skillSourceType: 'local-directory' },
    claude: {},
  });
});

afterAll(async () => {
  await studio.app.close();
  await rm(root, { recursive: true, force: true });
});

maybe('POST /api/easybi/projects/create (one-step new workspace)', () => {
  it('creates the directory, installs the skill bundle, bootstraps, and registers', async () => {
    const res = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects/create',
      payload: { name: '演示系统', id: 'demo-sys' },
    });
    expect(res.statusCode).toBe(201);
    const { project, bootstrap } = res.json().data;
    expect(project.id).toBe('demo-sys');
    expect(project.workspaceRoot).toBe(join(root, 'demo-sys'));
    expect(bootstrap.ok).toBe(true);

    // Skill bundle installed + workspace structure created on disk.
    const ws = join(root, 'demo-sys');
    expect(await stat(join(ws, 'skills', 'bundle.manifest.json')).then(() => true)).toBe(true);
    expect(await stat(join(ws, 'skills', 'bundle.lock.json')).then(() => true)).toBe(true);
    expect(await stat(join(ws, 'config', 'easy-bi.json')).then(() => true)).toBe(true);

    // It now appears in the project list.
    const list = await studio.app.inject({ method: 'GET', url: '/api/easybi/projects' });
    expect(list.json().data.projects.map((p: { id: string }) => p.id)).toContain('demo-sys');
  });

  it('rejects a duplicate id', async () => {
    const res = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects/create',
      payload: { name: '演示系统2', id: 'demo-sys' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ALREADY_REGISTERED');
  });

  it('rejects a missing name', async () => {
    const res = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects/create',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
