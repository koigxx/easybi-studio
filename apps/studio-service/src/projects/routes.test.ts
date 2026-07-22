import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type StudioApp } from '../app.js';

let allowedRoot: string;
let studio: StudioApp;

beforeAll(async () => {
  allowedRoot = await mkdtemp(join(tmpdir(), 'easybi-root-'));
  studio = buildApp({ dbFile: ':memory:', allowedWorkspaceRoots: [allowedRoot] });
});

afterAll(async () => {
  await studio.app.close();
  await rm(allowedRoot, { recursive: true, force: true });
});

describe('project registration API', () => {
  it('starts with an empty project list', async () => {
    const res = await studio.app.inject({ method: 'GET', url: '/api/easybi/projects' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.projects).toEqual([]);
  });

  it('registers an existing directory under the allowed root', async () => {
    const dir = join(allowedRoot, 'transport-test');
    await mkdir(dir);
    const res = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects',
      payload: { name: '运输测试', workspaceRoot: dir },
    });
    expect(res.statusCode).toBe(201);
    const project = res.json().data.project;
    expect(project.name).toBe('运输测试');
    expect(project.workspaceRoot).toBe(dir);
    expect(project.id).toBeTruthy();
  });

  it('rejects a path outside the allowed root', async () => {
    const res = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects',
      payload: { name: 'evil', workspaceRoot: '/etc' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PATH_NOT_ALLOWED');
  });

  it('rejects path traversal that escapes the allowed root', async () => {
    const res = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects',
      payload: { name: 'evil', workspaceRoot: join(allowedRoot, '..', '..', 'etc') },
    });
    expect(res.statusCode).toBe(400);
    expect(['PATH_TRAVERSAL', 'PATH_NOT_ALLOWED']).toContain(res.json().error.code);
  });

  it('rejects a non-existent directory', async () => {
    const res = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects',
      payload: { name: 'ghost', workspaceRoot: join(allowedRoot, 'nope') },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('WORKSPACE_INVALID');
  });

  it('rejects duplicate registration of the same path', async () => {
    const dir = join(allowedRoot, 'dup');
    await mkdir(dir);
    const first = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects',
      payload: { name: 'dup-a', workspaceRoot: dir },
    });
    expect(first.statusCode).toBe(201);
    const second = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects',
      payload: { name: 'dup-b', workspaceRoot: dir },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('ALREADY_REGISTERED');
  });

  it('removes registration without deleting workspace files', async () => {
    const dir = join(allowedRoot, 'removable');
    await mkdir(dir);
    const reg = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects',
      payload: { name: 'removable', workspaceRoot: dir, id: 'removable' },
    });
    expect(reg.statusCode).toBe(201);

    const del = await studio.app.inject({
      method: 'DELETE',
      url: '/api/easybi/projects/removable/registration',
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().data.filesDeleted).toBe(false);

    // Directory on disk is preserved.
    expect(existsSync(dir)).toBe(true);

    // Project is gone from the registry.
    const get = await studio.app.inject({ method: 'GET', url: '/api/easybi/projects/removable' });
    expect(get.statusCode).toBe(404);
  });

  it('validate-path reports structure for an allowed directory', async () => {
    const dir = join(allowedRoot, 'inspect');
    await mkdir(dir);
    const res = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects/validate-path',
      payload: { workspaceRoot: dir },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.check.registrable).toBe(true);
  });
});
