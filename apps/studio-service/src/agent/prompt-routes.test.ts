import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type StudioApp } from '../app.js';

let allowedRoot: string;
let studio: StudioApp;
let ws: string;

beforeAll(async () => {
  allowedRoot = await mkdtemp(join(tmpdir(), 'easybi-prompts-'));
  studio = buildApp({ dbFile: ':memory:', allowedWorkspaceRoots: [allowedRoot], claude: {} });
  ws = join(allowedRoot, 'pws');
  await mkdir(join(ws, 'config'), { recursive: true });
  await mkdir(join(ws, 'skills'), { recursive: true });
  await writeFile(
    join(ws, 'config', 'easy-bi.json'),
    JSON.stringify({ config_version: '4', setup_status: 'draft' }),
    'utf8',
  );
  // Minimal installed manifest declaring one skill with an agent_prompts file.
  await writeFile(
    join(ws, 'skills', 'bundle.manifest.json'),
    JSON.stringify({
      bundle_format_version: '1',
      bundle_id: 'easybi',
      bundle_version: '1.3.0',
      skills: [
        {
          id: 'initialize-report-knowledge',
          version: '0.13.0',
          path: 'initialize-report-knowledge',
          agent_entry: 'initialize-report-knowledge/SKILL.md',
          agent_prompts: 'initialize-report-knowledge/prompts.json',
          commands: {},
        },
      ],
      workspace_contract: { bootstrap_contract_version: '1', supported_modes: [], path_bases: {}, paths: {} },
    }),
    'utf8',
  );
  await mkdir(join(ws, 'skills', 'initialize-report-knowledge'), { recursive: true });
  await writeFile(
    join(ws, 'skills', 'initialize-report-knowledge', 'prompts.json'),
    JSON.stringify({
      schema_version: '1',
      skill_id: 'initialize-report-knowledge',
      presets: [
        { action: 'initialize-knowledge', label: '初始化知识库', hint: 'h', write: true, prompt: '请初始化知识库' },
      ],
    }),
    'utf8',
  );
  await studio.app.inject({
    method: 'POST',
    url: '/api/easybi/projects',
    payload: { name: '提示词测试', workspaceRoot: ws, id: 'pws' },
  });
});

afterAll(async () => {
  await studio.app.close();
  await rm(allowedRoot, { recursive: true, force: true });
});

describe('agent-prompts config routes', () => {
  it('falls back to skill defaults when config has no agent_prompts', async () => {
    const res = await studio.app.inject({ method: 'GET', url: '/api/easybi/projects/pws/agent-prompts' });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.source).toBe('skill-defaults');
    expect(data.presets).toHaveLength(1);
    expect(data.presets[0].action).toBe('initialize-knowledge');
    expect(data.presets[0].skillId).toBe('initialize-report-knowledge');
  });

  it('saves presets into config and reads them back as source=config', async () => {
    const read = await studio.app.inject({ method: 'GET', url: '/api/easybi/projects/pws/agent-prompts' });
    const revision = read.json().data.revision;

    const save = await studio.app.inject({
      method: 'PUT',
      url: '/api/easybi/projects/pws/agent-prompts',
      payload: {
        presets: [
          { action: 'create-report', label: '构建报表', hint: '', write: true, prompt: '生成报表' },
        ],
        expectedRevision: revision,
      },
    });
    expect(save.statusCode).toBe(200);

    const after = await studio.app.inject({ method: 'GET', url: '/api/easybi/projects/pws/agent-prompts' });
    const data = after.json().data;
    expect(data.source).toBe('config');
    expect(data.presets).toHaveLength(1);
    expect(data.presets[0].action).toBe('create-report');
  });

  it('rejects a preset with no prompt text', async () => {
    const read = await studio.app.inject({ method: 'GET', url: '/api/easybi/projects/pws/agent-prompts' });
    const res = await studio.app.inject({
      method: 'PUT',
      url: '/api/easybi/projects/pws/agent-prompts',
      payload: {
        presets: [{ action: 'x', label: 'x', hint: '', write: true, prompt: '' }],
        expectedRevision: read.json().data.revision,
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
