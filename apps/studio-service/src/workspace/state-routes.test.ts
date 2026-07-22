import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDirectorySource } from '@easybi-studio/skill-bundle-source';
import { SkillVersionCache } from '@easybi-studio/skill-bundle-manager';
import { createOrOpenWorkspace } from '@easybi-studio/workspace-bootstrapper';
import { buildApp, type StudioApp } from '../app.js';

const SOURCE = '/Users/admin/innos/easy-bi-workspace/easy-bi';
let root: string;
let studio: StudioApp;
let ws: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'easybi-wsstate-'));
  const dataDir = join(root, '.data');
  ws = join(root, 'wss');
  await createOrOpenWorkspace({
    workspaceRoot: ws,
    source: new LocalDirectorySource(SOURCE),
    cache: new SkillVersionCache(join(dataDir, 'skill-cache')),
    bundleId: 'easybi',
  });
  studio = buildApp({
    dbFile: ':memory:',
    allowedWorkspaceRoots: [root],
    config: { dataDir, skillSourceDir: SOURCE },
    claude: {},
  });
  await studio.app.inject({
    method: 'POST',
    url: '/api/easybi/projects',
    payload: { name: 'wss', workspaceRoot: ws, id: 'wss' },
  });
});

afterAll(async () => {
  await studio.app.close();
  await rm(root, { recursive: true, force: true });
});

describe('knowledge & report state routes', () => {
  it('returns knowledge state consistent with disk (empty, freshly bootstrapped)', async () => {
    const res = await studio.app.inject({ method: 'GET', url: '/api/easybi/projects/wss/knowledge' });
    expect(res.statusCode).toBe(200);
    const s = res.json().data;
    expect(s.drafts).toEqual([]);
    expect(s.publishedVersions).toEqual([]);
  });

  it('returns report state with requirements from the template config', async () => {
    const res = await studio.app.inject({ method: 'GET', url: '/api/easybi/projects/wss/reports' });
    expect(res.statusCode).toBe(200);
    const s = res.json().data;
    // The example config template ships two report requirements.
    expect(Array.isArray(s.requirements)).toBe(true);
    expect(s.reports).toEqual([]);
  });

  it('deletes any report package unrestricted, drafts and published alike', async () => {
    await mkdir(join(ws, 'reports', 'packages', 'r1', '0.1.0-draft'), { recursive: true });
    await writeFile(join(ws, 'reports', 'packages', 'r1', '0.1.0-draft', 'f.txt'), 'x');
    await mkdir(join(ws, 'reports', 'packages', 'r2', '1.0.0'), { recursive: true });
    await writeFile(
      join(ws, 'reports', 'index.json'),
      JSON.stringify({
        reports: [
          { id: 'r1', name: '开发报表', version: '0.1.0-draft', status: 'draft', path: 'packages/r1/0.1.0-draft', development_only: true },
          { id: 'r2', name: '正式报表', version: '1.0.0', status: 'published', path: 'packages/r2/1.0.0', development_only: false },
        ],
      }),
    );

    // A published package is now deletable (report packages are unrestricted).
    const pubDel = await studio.app.inject({
      method: 'DELETE',
      url: '/api/easybi/projects/wss/reports/package',
      payload: { id: 'r2', version: '1.0.0' },
    });
    expect(pubDel.statusCode).toBe(200);
    expect(pubDel.json().data.removedDir).toBe(true);
    expect(existsSync(join(ws, 'reports', 'packages', 'r2', '1.0.0'))).toBe(false);

    // A draft package is likewise removed + deregistered.
    const okRes = await studio.app.inject({
      method: 'DELETE',
      url: '/api/easybi/projects/wss/reports/package',
      payload: { id: 'r1', version: '0.1.0-draft' },
    });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json().data.removedDir).toBe(true);
    expect(existsSync(join(ws, 'reports', 'packages', 'r1', '0.1.0-draft'))).toBe(false);

    const state = await studio.app.inject({ method: 'GET', url: '/api/easybi/projects/wss/reports' });
    const ids = (state.json().data.reports as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain('r1');
    expect(ids).not.toContain('r2');
  });

  it('404s deleting an unknown package', async () => {
    const res = await studio.app.inject({
      method: 'DELETE',
      url: '/api/easybi/projects/wss/reports/package',
      payload: { id: 'ghost', version: '9.9.9' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('report package editor: detail/read/write with whitelist guard (unrestricted lifecycle)', async () => {
    const dir = join(ws, 'reports', 'packages', 'edit1', '0.1.0-draft', 'queries');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'main.sql'), 'SELECT 1;\n');
    await writeFile(join(ws, 'reports', 'packages', 'edit1', '0.1.0-draft', 'report.manifest.json'), '{}');
    const pubDir = join(ws, 'reports', 'packages', 'pub1', '1.0.0', 'queries');
    await mkdir(pubDir, { recursive: true });
    await writeFile(join(pubDir, 'main.sql'), 'SELECT 2;\n');
    await writeFile(
      join(ws, 'reports', 'index.json'),
      JSON.stringify({
        reports: [
          { id: 'edit1', name: '可编辑', version: '0.1.0-draft', path: 'packages/edit1/0.1.0-draft', development_only: true },
          { id: 'pub1', name: '已发布', version: '1.0.0', path: 'packages/pub1/1.0.0', development_only: false },
        ],
      }),
    );

    // Detail lists files with editable flags.
    const detail = await studio.app.inject({
      method: 'GET',
      url: '/api/easybi/projects/wss/reports/package/detail?id=edit1&version=0.1.0-draft',
    });
    expect(detail.statusCode).toBe(200);
    const files = detail.json().data.files as Array<{ path: string; editable: boolean }>;
    expect(files.find((f) => f.path === 'queries/main.sql')?.editable).toBe(true);

    // Read a file.
    const read = await studio.app.inject({
      method: 'GET',
      url: '/api/easybi/projects/wss/reports/package/file?id=edit1&version=0.1.0-draft&path=queries/main.sql',
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().data.content).toContain('SELECT 1');

    // Write an editable file on a dev package.
    const write = await studio.app.inject({
      method: 'PUT',
      url: '/api/easybi/projects/wss/reports/package/file',
      payload: { id: 'edit1', version: '0.1.0-draft', path: 'queries/main.sql', content: 'SELECT 42;\n' },
    });
    expect(write.statusCode).toBe(200);
    const reread = await studio.app.inject({
      method: 'GET',
      url: '/api/easybi/projects/wss/reports/package/file?id=edit1&version=0.1.0-draft&path=queries/main.sql',
    });
    expect(reread.json().data.content).toContain('SELECT 42');

    // A non-whitelisted file is rejected.
    const badFile = await studio.app.inject({
      method: 'PUT',
      url: '/api/easybi/projects/wss/reports/package/file',
      payload: { id: 'edit1', version: '0.1.0-draft', path: 'report.manifest.json', content: '{}' },
    });
    expect(badFile.statusCode).toBe(400);

    // Report packages are unrestricted: a whitelisted file on any package
    // (including a published one) is now writable.
    const pubWrite = await studio.app.inject({
      method: 'PUT',
      url: '/api/easybi/projects/wss/reports/package/file',
      payload: { id: 'pub1', version: '1.0.0', path: 'queries/main.sql', content: 'SELECT 3;\n' },
    });
    expect(pubWrite.statusCode).toBe(200);
    const pubReread = await studio.app.inject({
      method: 'GET',
      url: '/api/easybi/projects/wss/reports/package/file?id=pub1&version=1.0.0&path=queries/main.sql',
    });
    expect(pubReread.json().data.content).toContain('SELECT 3');
  });
});
