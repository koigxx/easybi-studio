import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, writeConfig, computeRevision, ConfigConflictError, ConfigNotFoundError } from './store.js';

let ws: string;

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'easybi-cfg-'));
  await mkdir(join(ws, 'config'), { recursive: true });
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('config store', () => {
  it('throws NOT_FOUND for a missing file', async () => {
    await expect(readConfig(ws, 'config/easy-bi.json')).rejects.toBeInstanceOf(ConfigNotFoundError);
  });

  it('writes then reads back with a stable revision', async () => {
    // First write against empty file (expectedRevision '').
    const w1 = await writeConfig({
      workspaceRoot: ws,
      relativePath: 'config/easy-bi.json',
      value: { config_version: '4', a: 1 },
      expectedRevision: '',
    });
    const r1 = await readConfig(ws, 'config/easy-bi.json');
    expect(r1.revision).toBe(w1.revision);
    expect((r1.value as { a: number }).a).toBe(1);
  });

  it('rejects a save with a stale revision (concurrent modification)', async () => {
    await writeConfig({
      workspaceRoot: ws,
      relativePath: 'config/easy-bi.json',
      value: { v: 1 },
      expectedRevision: '',
    });
    const read = await readConfig(ws, 'config/easy-bi.json');

    // Someone else modifies the file in between.
    await writeConfig({
      workspaceRoot: ws,
      relativePath: 'config/easy-bi.json',
      value: { v: 2 },
      expectedRevision: read.revision,
    });

    // Our save with the OLD revision must be rejected.
    await expect(
      writeConfig({
        workspaceRoot: ws,
        relativePath: 'config/easy-bi.json',
        value: { v: 3 },
        expectedRevision: read.revision,
      }),
    ).rejects.toBeInstanceOf(ConfigConflictError);
  });

  it('creates a backup of the previous content before overwriting', async () => {
    await writeConfig({
      workspaceRoot: ws,
      relativePath: 'config/easy-bi.json',
      value: { v: 1 },
      expectedRevision: '',
    });
    const read = await readConfig(ws, 'config/easy-bi.json');
    const w2 = await writeConfig({
      workspaceRoot: ws,
      relativePath: 'config/easy-bi.json',
      value: { v: 2 },
      expectedRevision: read.revision,
    });
    expect(w2.backupPath).toBeTruthy();
    const backups = await readdir(join(ws, 'work', 'config-backups'));
    expect(backups.length).toBeGreaterThan(0);
  });

  it('rejects a path escaping the workspace', async () => {
    await expect(
      writeConfig({
        workspaceRoot: ws,
        relativePath: '../escape.json',
        value: {},
        expectedRevision: '',
      }),
    ).rejects.toThrow();
  });

  it('computeRevision is deterministic', () => {
    expect(computeRevision('abc')).toBe(computeRevision('abc'));
    expect(computeRevision('abc')).not.toBe(computeRevision('abd'));
  });
});
