import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointManager } from './manager.js';

let ws: string;
const cm = new CheckpointManager();

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'easybi-ckpt-'));
  await mkdir(join(ws, 'config'), { recursive: true });
  await mkdir(join(ws, 'knowledge', 'versions', '1.0.0'), { recursive: true });
  await writeFile(join(ws, 'config', 'easy-bi.json'), '{"v":1}');
  await writeFile(join(ws, 'knowledge', 'versions', '1.0.0', 'manifest.json'), '{"published":true}');
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('CheckpointManager', () => {
  it('captures managed files (excluding node_modules/work/skills)', async () => {
    await mkdir(join(ws, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(ws, 'node_modules', 'x', 'a.js'), 'x');
    const ckpt = await cm.create({ workspaceRoot: ws, projectId: 'p' });
    const paths = ckpt.files.map((f) => f.path);
    expect(paths).toContain('config/easy-bi.json');
    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false);
  });

  it('summarizes added / modified / deleted files', async () => {
    const ckpt = await cm.create({ workspaceRoot: ws, projectId: 'p' });
    await writeFile(join(ws, 'config', 'easy-bi.json'), '{"v":2}'); // modified
    await writeFile(join(ws, 'config', 'new.json'), '{"n":1}'); // added
    const summary = await cm.summarize(ws, ckpt);
    expect(summary.modifiedFiles).toContain('config/easy-bi.json');
    expect(summary.addedFiles).toContain('config/new.json');
  });

  it('produces a text diff for a modified file', async () => {
    const ckpt = await cm.create({ workspaceRoot: ws, projectId: 'p' });
    await writeFile(join(ws, 'config', 'easy-bi.json'), '{"v":2}');
    const diff = await cm.diffFile(ws, ckpt, 'config/easy-bi.json');
    expect(diff.binary).toBe(false);
    expect(diff.unifiedDiff).toContain('-{"v":1}');
    expect(diff.unifiedDiff).toContain('+{"v":2}');
  });

  it('rolls back an un-conflicted change (restore modified, remove added)', async () => {
    const ckpt = await cm.create({ workspaceRoot: ws, projectId: 'p' });
    // Task modifies + adds.
    await writeFile(join(ws, 'config', 'easy-bi.json'), '{"v":2}');
    await writeFile(join(ws, 'config', 'new.json'), '{"n":1}');
    const postTaskHashes = await cm.snapshotHashes(ws);

    const result = await cm.rollback({ workspaceRoot: ws, checkpoint: ckpt, postTaskHashes });
    expect(result.ok).toBe(true);
    expect(await readFile(join(ws, 'config', 'easy-bi.json'), 'utf8')).toBe('{"v":1}');
    expect(await exists(join(ws, 'config', 'new.json'))).toBe(false);
  });

  it('refuses to roll back a file modified again after the task (conflict)', async () => {
    const ckpt = await cm.create({ workspaceRoot: ws, projectId: 'p' });
    await writeFile(join(ws, 'config', 'easy-bi.json'), '{"v":2}');
    const postTaskHashes = await cm.snapshotHashes(ws);
    // Another task modifies the same file afterwards.
    await writeFile(join(ws, 'config', 'easy-bi.json'), '{"v":3}');

    const result = await cm.rollback({ workspaceRoot: ws, checkpoint: ckpt, postTaskHashes });
    expect(result.ok).toBe(false);
    expect(result.conflicted).toContain('config/easy-bi.json');
    // File left as-is (not clobbered).
    expect(await readFile(join(ws, 'config', 'easy-bi.json'), 'utf8')).toBe('{"v":3}');
  });

  it('never rolls back published knowledge versions', async () => {
    const ckpt = await cm.create({ workspaceRoot: ws, projectId: 'p' });
    // Task (incorrectly) alters a published version file.
    await writeFile(join(ws, 'knowledge', 'versions', '1.0.0', 'manifest.json'), '{"tampered":true}');
    const postTaskHashes = await cm.snapshotHashes(ws);
    const result = await cm.rollback({ workspaceRoot: ws, checkpoint: ckpt, postTaskHashes });
    // Protected path is not restored/removed by rollback.
    expect(result.restored).not.toContain('knowledge/versions/1.0.0/manifest.json');
  });
});
