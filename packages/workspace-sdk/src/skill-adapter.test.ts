import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceSkillAdapter } from './skill-adapter.js';

let ws: string;

const MANIFEST = {
  bundle_format_version: '1',
  bundle_id: 'easybi',
  bundle_version: '0.1.1',
  compatibility: {
    workspace_formats: ['1'],
    config_formats: ['4'],
    catalog_formats: ['3'],
    report_package_formats: ['1'],
    runtime_api_versions: ['v1'],
  },
  skills: [
    {
      id: 'initialize-report-knowledge',
      version: '0.9.3',
      path: 'initialize-report-knowledge',
      agent_entry: 'initialize-report-knowledge/SKILL.md',
      commands: { cli: 'initialize-report-knowledge/dist/scripts/catalog-cli.js' },
    },
    {
      id: 'create-report-package',
      version: '0.2.1',
      path: 'create-report-package',
      agent_entry: 'create-report-package/SKILL.md',
      commands: { runtime_cli: 'create-report-package/dist/scripts/runtime-cli.js' },
    },
  ],
  workspace_contract: {
    bootstrap_contract_version: '1',
    supported_modes: ['init', 'check'],
    path_bases: {},
    paths: { knowledge_index: 'knowledge/index.json', runtime_config: 'toolkit/config/runtime.json' },
    templates: {},
    empty_indexes: {},
    bootstrap_policy: {},
  },
  distribution: {
    supported_source_types: ['local-directory'],
    immutable_versions: true,
    verify_file_hashes: true,
    silent_workspace_upgrade: false,
  },
  contracts: { directory_compatibility: '目录与项目兼容性规范.md' },
};

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'easybi-adapter-'));
  await mkdir(join(ws, 'skills'), { recursive: true });
  await writeFile(join(ws, 'skills', 'bundle.manifest.json'), JSON.stringify(MANIFEST));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('WorkspaceSkillAdapter', () => {
  it('resolves logical workspace paths from the manifest', async () => {
    const a = new WorkspaceSkillAdapter(ws);
    expect(await a.resolveLogicalPath('knowledge_index')).toBe(join(ws, 'knowledge/index.json'));
    expect(await a.resolveLogicalPath('runtime_config')).toBe(join(ws, 'toolkit/config/runtime.json'));
  });

  it('resolves skill commands relative to the bundle root', async () => {
    const a = new WorkspaceSkillAdapter(ws);
    const cli = await a.resolveCommand('initialize-report-knowledge', 'cli');
    expect(cli).toBe(join(ws, 'skills/initialize-report-knowledge/dist/scripts/catalog-cli.js'));
    const rt = await a.resolveCommand('create-report-package', 'runtime_cli');
    expect(rt).toContain('create-report-package/dist/scripts/runtime-cli.js');
  });

  it('throws for unknown keys', async () => {
    const a = new WorkspaceSkillAdapter(ws);
    await expect(a.resolveLogicalPath('nope')).rejects.toThrow();
    await expect(a.resolveCommand('unknown', 'cli')).rejects.toThrow();
  });
});
