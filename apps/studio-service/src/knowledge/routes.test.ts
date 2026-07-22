import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDirectorySource } from '@easybi-studio/skill-bundle-source';
import { SkillVersionCache } from '@easybi-studio/skill-bundle-manager';
import { createOrOpenWorkspace } from '@easybi-studio/workspace-bootstrapper';
import { buildApp, type StudioApp } from '../app.js';
import type { SkillCliRunner, CliResult } from './skill-cli.js';

const SOURCE = '/Users/admin/innos/easy-bi-workspace/easy-bi';

/** Fake CLI runner: records calls, returns a canned success. */
class FakeCliRunner implements SkillCliRunner {
  calls: Array<{ workspaceRoot: string; args: string[] }> = [];
  next: CliResult = { ok: true, json: { ok: true }, stdout: '{"ok":true}', stderr: '', code: 0 };
  async run(workspaceRoot: string, args: string[]): Promise<CliResult> {
    this.calls.push({ workspaceRoot, args });
    return this.next;
  }
}

let allowedRoot: string;
let studio: StudioApp;
let projectId: string;
let runner: FakeCliRunner;

beforeAll(async () => {
  allowedRoot = await mkdtemp(join(tmpdir(), 'easybi-kroot-'));
  const dataDir = join(allowedRoot, '.data');
  const ws = join(allowedRoot, 'k-test');
  await createOrOpenWorkspace({
    workspaceRoot: ws,
    source: new LocalDirectorySource(SOURCE),
    cache: new SkillVersionCache(join(dataDir, 'skill-cache')),
    bundleId: 'easybi',
    systemId: 'k-test',
    systemName: '知识库测试',
  });
  runner = new FakeCliRunner();
  studio = buildApp({
    dbFile: ':memory:',
    allowedWorkspaceRoots: [allowedRoot],
    config: { dataDir, skillSourceDir: SOURCE },
    claude: {},
    skillCliRunner: runner,
  });
  const reg = await studio.app.inject({
    method: 'POST',
    url: '/api/easybi/projects',
    payload: { name: '知识库测试', workspaceRoot: ws, id: 'k-test' },
  });
  projectId = reg.json().data.project.id;
});

afterAll(async () => {
  await studio.app.close();
  await rm(allowedRoot, { recursive: true, force: true });
});

describe('knowledge structural routes', () => {
  it('validate calls the CLI with --catalog', async () => {
    const res = await studio.app.inject({
      method: 'POST',
      url: `/api/easybi/projects/${projectId}/knowledge/validate`,
      payload: { draftId: 'draft-x' },
    });
    expect(res.statusCode).toBe(200);
    const call = runner.calls.at(-1)!;
    expect(call.args[0]).toBe('validate');
    expect(call.args).toContain('--catalog');
    expect(call.args.some((a) => a.endsWith(join('knowledge', 'drafts', 'draft-x')))).toBe(true);
  });

  it('promote requires a reason', async () => {
    const res = await studio.app.inject({
      method: 'POST',
      url: `/api/easybi/projects/${projectId}/knowledge/promote`,
      payload: { draftId: 'd', tableId: 'p/db/t', to: 'hot' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('promote passes table/to/reason', async () => {
    const res = await studio.app.inject({
      method: 'POST',
      url: `/api/easybi/projects/${projectId}/knowledge/promote`,
      payload: { draftId: 'd', tableId: 'p/db/t', to: 'warm', reason: '用于报表' },
    });
    expect(res.statusCode).toBe(200);
    const call = runner.calls.at(-1)!;
    expect(call.args[0]).toBe('promote');
    expect(call.args).toContain('--table');
    expect(call.args).toContain('p/db/t');
    expect(call.args).toContain('--to');
    expect(call.args).toContain('warm');
    expect(call.args).toContain('用于报表');
  });

  it('promote surfaces a CLI failure as 422', async () => {
    runner.next = { ok: false, json: { ok: false, error: '快照缺失' }, stdout: '', stderr: '', code: 1 };
    const res = await studio.app.inject({
      method: 'POST',
      url: `/api/easybi/projects/${projectId}/knowledge/promote`,
      payload: { draftId: 'd', tableId: 'p/db/t', to: 'hot', reason: 'x' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain('快照缺失');
    runner.next = { ok: true, json: { ok: true }, stdout: '{"ok":true}', stderr: '', code: 0 };
  });

  it('publish surfaces a readiness failure from stderr JSON as a clean message', async () => {
    // The CLI writes thrown errors as JSON to stderr (stdout empty) and exits 2.
    runner.next = {
      ok: false,
      json: null,
      stdout: '',
      stderr:
        '{\n  "ok": false,\n  "error": "Catalog is not publishable: Semantic review is not approved"\n}',
      code: 2,
    };
    const res = await studio.app.inject({
      method: 'POST',
      url: `/api/easybi/projects/${projectId}/knowledge/publish`,
      payload: { draftId: 'd', version: '1.2.3' },
    });
    expect(res.statusCode).toBe(422);
    const msg = res.json().error.message as string;
    expect(msg).toContain('Semantic review is not approved');
    // The raw JSON braces must NOT leak through.
    expect(msg).not.toContain('"ok"');
    runner.next = { ok: true, json: { ok: true }, stdout: '{"ok":true}', stderr: '', code: 0 };
  });

  it('publish rejects an invalid version', async () => {
    const res = await studio.app.inject({
      method: 'POST',
      url: `/api/easybi/projects/${projectId}/knowledge/publish`,
      payload: { draftId: 'd', version: 'v1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('publish passes version/workspace/publisher', async () => {
    const res = await studio.app.inject({
      method: 'POST',
      url: `/api/easybi/projects/${projectId}/knowledge/publish`,
      payload: { draftId: 'd', version: '1.2.3', publishedBy: 'me', decision: 'ok' },
    });
    expect(res.statusCode).toBe(200);
    const call = runner.calls.at(-1)!;
    expect(call.args[0]).toBe('publish');
    expect(call.args).toContain('--version');
    expect(call.args).toContain('1.2.3');
    expect(call.args).toContain('--workspace');
    expect(call.args).toContain('--published-by');
    expect(call.args).toContain('me');
  });

  it('publish omits --decision when not provided', async () => {
    const res = await studio.app.inject({
      method: 'POST',
      url: `/api/easybi/projects/${projectId}/knowledge/publish`,
      payload: { draftId: 'd', version: '1.2.3' },
    });
    expect(res.statusCode).toBe(200);
    const call = runner.calls.at(-1)!;
    expect(call.args).not.toContain('--decision');
    // No empty-string token that the CLI would reject as "Unexpected argument".
    expect(call.args.every((a) => a.length > 0)).toBe(true);
  });

  it('enums-init passes --catalog and --config', async () => {
    const res = await studio.app.inject({
      method: 'POST',
      url: `/api/easybi/projects/${projectId}/knowledge/enums/init`,
      payload: { draftId: 'd', limit: 100, timeoutMs: 3000 },
    });
    expect(res.statusCode).toBe(200);
    const call = runner.calls.at(-1)!;
    expect(call.args[0]).toBe('enums-init');
    expect(call.args).toContain('--config');
    expect(call.args).toContain('--limit');
    expect(call.args).toContain('100');
  });

  it('enums save (page model) calls enums-import-json with a temp file', async () => {
    const res = await studio.app.inject({
      method: 'PUT',
      url: `/api/easybi/projects/${projectId}/knowledge/enums`,
      payload: { draftId: 'd', model: { bindings: [], dictionaries: [] }, dryRun: true },
    });
    expect(res.statusCode).toBe(200);
    const call = runner.calls.at(-1)!;
    expect(call.args[0]).toBe('enums-import-json');
    expect(call.args).toContain('--file');
    expect(call.args).toContain('--dry-run');
  });

  it('enums import (uploaded xlsx base64) calls enums-import', async () => {
    const res = await studio.app.inject({
      method: 'POST',
      url: `/api/easybi/projects/${projectId}/knowledge/enums/import`,
      payload: { draftId: 'd', base64: Buffer.from('x').toString('base64'), dryRun: true },
    });
    expect(res.statusCode).toBe(200);
    const call = runner.calls.at(-1)!;
    expect(call.args[0]).toBe('enums-import');
    expect(call.args).toContain('--file');
    expect(call.args).toContain('--dry-run');
  });
});
