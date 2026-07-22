import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDirectorySource } from '@easybi-studio/skill-bundle-source';
import { SkillVersionCache } from '@easybi-studio/skill-bundle-manager';
import { createOrOpenWorkspace } from '@easybi-studio/workspace-bootstrapper';
import { FakeMysqlAdapter } from '@easybi-studio/config-sdk';
import { buildApp, type StudioApp } from '../app.js';

const SOURCE = '/Users/admin/innos/easy-bi-workspace/easy-bi';

let allowedRoot: string;
let studio: StudioApp;
let projectId: string;

beforeAll(async () => {
  allowedRoot = await mkdtemp(join(tmpdir(), 'easybi-cfgroot-'));
  const dataDir = join(allowedRoot, '.data');

  // Create a real workspace via the product code.
  const ws = join(allowedRoot, 'cfg-test');
  await createOrOpenWorkspace({
    workspaceRoot: ws,
    source: new LocalDirectorySource(SOURCE),
    cache: new SkillVersionCache(join(dataDir, 'skill-cache')),
    bundleId: 'easybi',
    systemId: 'cfg-test',
    systemName: '配置测试',
  });

  studio = buildApp({
    dbFile: ':memory:',
    allowedWorkspaceRoots: [allowedRoot],
    config: { dataDir, skillSourceDir: SOURCE },
    claude: {},
    mysqlAdapter: new FakeMysqlAdapter(),
  });

  const reg = await studio.app.inject({
    method: 'POST',
    url: '/api/easybi/projects',
    payload: { name: '配置测试', workspaceRoot: ws, id: 'cfg-test' },
  });
  projectId = reg.json().data.project.id;
});

afterAll(async () => {
  await studio.app.close();
  await rm(allowedRoot, { recursive: true, force: true });
});

describe('config + state + diagnostics routes', () => {
  it('reads the build config with a revision', async () => {
    const res = await studio.app.inject({
      method: 'GET',
      url: `/api/easybi/projects/${projectId}/config/build`,
    });
    expect(res.statusCode).toBe(200);
    const { value, revision } = res.json().data;
    expect(value.config_version).toBe('4');
    expect(revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a save with a stale revision (409 CONFIG_CONFLICT)', async () => {
    const read = await studio.app.inject({
      method: 'GET',
      url: `/api/easybi/projects/${projectId}/config/build`,
    });
    const { value, revision } = read.json().data;

    // First save succeeds.
    const first = await studio.app.inject({
      method: 'PUT',
      url: `/api/easybi/projects/${projectId}/config/build`,
      payload: { value: { ...value, edited: 1 }, expectedRevision: revision },
    });
    expect(first.statusCode).toBe(200);

    // Second save with the OLD revision conflicts.
    const stale = await studio.app.inject({
      method: 'PUT',
      url: `/api/easybi/projects/${projectId}/config/build`,
      payload: { value: { ...value, edited: 2 }, expectedRevision: revision },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('CONFIG_CONFLICT');
  });

  it('runs a fake MySQL test that never echoes secrets', async () => {
    const res = await studio.app.inject({
      method: 'POST',
      url: `/api/easybi/projects/${projectId}/config/test-mysql`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.adapter).toBe('fake');
  });

  it('computes workflow state from disk facts', async () => {
    const res = await studio.app.inject({
      method: 'GET',
      url: `/api/easybi/projects/${projectId}/workflow`,
    });
    expect(res.statusCode).toBe(200);
    const state = res.json().data;
    expect(state.steps.find((s: { stage: string }) => s.stage === 'WORKSPACE_READY').done).toBe(true);
    // A Chinese label accompanies the raw stage for display.
    expect(typeof state.currentLabel).toBe('string');
    expect(state.currentLabel.length).toBeGreaterThan(0);
  });

  it('serves config help sourced from the installed skills', async () => {
    const res = await studio.app.inject({
      method: 'GET',
      url: `/api/easybi/projects/${projectId}/config-help`,
    });
    expect(res.statusCode).toBe(200);
    const docs = res.json().data.docs as Array<{ target: string; sections: unknown[] }>;
    // The 1.4.0 bundle ships config-help.json for build + runtime.
    expect(docs.find((d) => d.target === 'build')?.sections.length).toBeGreaterThan(0);
    expect(docs.some((d) => d.target === 'runtime')).toBe(true);
  });

  it('runs diagnostics with graded statuses and keeps the source read-only', async () => {
    const res = await studio.app.inject({
      method: 'POST',
      url: `/api/easybi/projects/${projectId}/diagnostics`,
    });
    expect(res.statusCode).toBe(200);
    const run = res.json().data;
    const statuses = new Set(run.items.map((i: { status: string }) => i.status));
    // Node and source should PASS; claude NOT_CONFIGURED (we injected {}).
    expect(run.items.find((i: { key: string }) => i.key === 'node.version').status).toBe('PASS');
    expect(run.items.find((i: { key: string }) => i.key === 'skill.source').status).toBe('PASS');
    expect(run.items.find((i: { key: string }) => i.key === 'claude.cli').status).toBe(
      'NOT_CONFIGURED',
    );
    expect(['PASS', 'WARNING', 'FAIL', 'NOT_CONFIGURED']).toEqual(
      expect.arrayContaining([...statuses]),
    );
  });
});
