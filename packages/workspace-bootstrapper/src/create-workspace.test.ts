import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalDirectorySource } from '@easybi-studio/skill-bundle-source';
import { SkillVersionCache } from '@easybi-studio/skill-bundle-manager';
import { createOrOpenWorkspace } from './create-workspace.js';

const SOURCE = fileURLToPath(new URL('../../../skill-source/easy-bi', import.meta.url));

let base: string;
let cacheRoot: string;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'easybi-ws2-'));
  cacheRoot = join(base, 'cache');
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('create-or-open workspace (source -> cache -> install -> lock -> bootstrap)', () => {
  it('creates a fresh workspace, installs skills, writes lock, initializes structure', async () => {
    const source = new LocalDirectorySource(SOURCE);
    const cache = new SkillVersionCache(cacheRoot);
    const ws = join(base, 'ws-a');

    const result = await createOrOpenWorkspace({
      workspaceRoot: ws,
      source,
      cache,
      bundleId: 'easybi',
      systemId: 'sys-a',
      systemName: '系统A',
    });

    expect(result.installed).toBe(true);
    expect(result.cacheReused).toBe(false);
    expect(result.bundleVersion).toBe('1.35.7');
    expect(result.bootstrap.ok).toBe(true);

    // Skills installed, lock + manifest present.
    expect(await exists(join(ws, 'skills', 'bundle.manifest.json'))).toBe(true);
    expect(await exists(join(ws, 'skills', 'bundle.lock.json'))).toBe(true);
    expect(await exists(join(ws, 'skills', 'initialize-report-knowledge', 'SKILL.md'))).toBe(true);
    // Bootstrap-created structure.
    expect(await exists(join(ws, 'workspace.json'))).toBe(true);
    expect(await exists(join(ws, 'knowledge', 'index.json'))).toBe(true);
    expect(await exists(join(ws, 'reports', 'index.json'))).toBe(true);
    expect(await exists(join(ws, 'outputs', 'index.json'))).toBe(true);
    expect(await exists(join(ws, 'config', 'easy-bi.json'))).toBe(true);
    expect(await exists(join(ws, 'toolkit', 'config', 'runtime.json'))).toBe(true);
    expect(await exists(join(ws, 'CLAUDE.md'))).toBe(true);

    // Lock is secret-free and well-formed.
    const lock = JSON.parse(await readFile(join(ws, 'skills', 'bundle.lock.json'), 'utf8'));
    expect(lock.bundle_id).toBe('easybi');
    expect(lock.bundle_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(lock).toLowerCase()).not.toContain('password');
  });

  it('reuses the immutable cache on a second workspace without re-copying the source', async () => {
    const source = new LocalDirectorySource(SOURCE);
    const cache = new SkillVersionCache(cacheRoot);
    const ws = join(base, 'ws-b');

    const result = await createOrOpenWorkspace({
      workspaceRoot: ws,
      source,
      cache,
      bundleId: 'easybi',
    });

    expect(result.cacheReused).toBe(true);
    expect(result.installed).toBe(true);
    expect(await exists(join(ws, 'skills', 'bundle.lock.json'))).toBe(true);
  });

  it('opening an already-initialized workspace is idempotent and preserves user files', async () => {
    const source = new LocalDirectorySource(SOURCE);
    const cache = new SkillVersionCache(cacheRoot);
    const ws = join(base, 'ws-a');

    // Simulate user edits to config and a published knowledge version.
    const userConfig = join(ws, 'config', 'easy-bi.json');
    await writeFile(userConfig, '{"config_version":"4","MINE":true}', 'utf8');

    const result = await createOrOpenWorkspace({ workspaceRoot: ws, source, cache, bundleId: 'easybi' });

    expect(result.installed).toBe(false); // lock exists -> no reinstall
    expect(result.bootstrap.alreadyReady).toBe(true);
    // User config untouched.
    const cfg = JSON.parse(await readFile(userConfig, 'utf8'));
    expect(cfg.MINE).toBe(true);
  });

  it('does not affect another workspace when installing/opening', async () => {
    const source = new LocalDirectorySource(SOURCE);
    const cache = new SkillVersionCache(cacheRoot);
    const wsB = join(base, 'ws-b');
    const lockBefore = await readFile(join(wsB, 'skills', 'bundle.lock.json'), 'utf8');

    // Operate on a third workspace.
    await createOrOpenWorkspace({ workspaceRoot: join(base, 'ws-c'), source, cache, bundleId: 'easybi' });

    const lockAfter = await readFile(join(wsB, 'skills', 'bundle.lock.json'), 'utf8');
    expect(lockAfter).toBe(lockBefore);
  });

  it('compat-backfills a legacy workspace that has data but no manifest/lock', async () => {
    const source = new LocalDirectorySource(SOURCE);
    const cache = new SkillVersionCache(cacheRoot);
    const ws = join(base, 'ws-legacy');

    // Simulate a legacy workspace: user config + a published knowledge version,
    // but no skills/ manifest and no lock.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(ws, 'config'), { recursive: true });
    await mkdir(join(ws, 'knowledge', 'versions', '1.0.0'), { recursive: true });
    await writeFile(join(ws, 'config', 'easy-bi.json'), '{"config_version":"4","LEGACY":true}', 'utf8');
    await writeFile(join(ws, 'knowledge', 'versions', '1.0.0', 'manifest.json'), '{"v":"1.0.0"}', 'utf8');

    const result = await createOrOpenWorkspace({ workspaceRoot: ws, source, cache, bundleId: 'easybi' });

    // Manifest + lock are now present (backfilled), skills installed.
    expect(await exists(join(ws, 'skills', 'bundle.manifest.json'))).toBe(true);
    expect(await exists(join(ws, 'skills', 'bundle.lock.json'))).toBe(true);
    expect(result.installed).toBe(true);

    // Legacy user data preserved untouched.
    const cfg = JSON.parse(await readFile(join(ws, 'config', 'easy-bi.json'), 'utf8'));
    expect(cfg.LEGACY).toBe(true);
    const ver = JSON.parse(await readFile(join(ws, 'knowledge', 'versions', '1.0.0', 'manifest.json'), 'utf8'));
    expect(ver.v).toBe('1.0.0');
  });

  it('auto-repairs a missing rebuildable index without overwriting others', async () => {
    const source = new LocalDirectorySource(SOURCE);
    const cache = new SkillVersionCache(cacheRoot);
    const ws = join(base, 'ws-a');

    // Delete the reports index to simulate a missing rebuildable file.
    await rm(join(ws, 'reports', 'index.json'), { force: true });
    const result = await createOrOpenWorkspace({ workspaceRoot: ws, source, cache, bundleId: 'easybi' });

    expect(await exists(join(ws, 'reports', 'index.json'))).toBe(true);
    const repaired = result.bootstrap.actions.find((a) => a.target === 'reports/index.json');
    expect(repaired).toBeTruthy();
  });
});
