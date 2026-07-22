import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkWorkspaceStructure } from './structure.js';

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'easybi-ws-'));
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('checkWorkspaceStructure', () => {
  it('reports non-existent path as not registrable', async () => {
    const r = await checkWorkspaceStructure(join(tmpRoot, 'does-not-exist'));
    expect(r.exists).toBe(false);
    expect(r.registrable).toBe(false);
  });

  it('reports an empty directory as registrable but incomplete', async () => {
    const dir = join(tmpRoot, 'empty');
    await mkdir(dir);
    const r = await checkWorkspaceStructure(dir);
    expect(r.exists).toBe(true);
    expect(r.isDirectory).toBe(true);
    expect(r.registrable).toBe(true);
    expect(r.hasWorkspaceManifest).toBe(false);
    expect(r.missingDirectories).toContain('config');
  });

  it('detects a full workspace layout', async () => {
    const dir = join(tmpRoot, 'full');
    await mkdir(dir);
    for (const d of ['config', 'skills', 'toolkit', 'knowledge', 'reports', 'outputs', 'work']) {
      await mkdir(join(dir, d));
    }
    await writeFile(join(dir, 'workspace.json'), '{}');
    await writeFile(join(dir, 'skills', 'bundle.manifest.json'), '{}');
    await writeFile(join(dir, 'skills', 'bundle.lock.json'), '{}');
    const r = await checkWorkspaceStructure(dir);
    expect(r.hasWorkspaceManifest).toBe(true);
    expect(r.hasBundleManifest).toBe(true);
    expect(r.hasBundleLock).toBe(true);
    expect(r.missingDirectories).toHaveLength(0);
    expect(r.notes).toContain('工作区结构完整');
  });
});
