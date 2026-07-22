import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listWorkspaceDir, readWorkspaceFile } from './files.js';

let ws: string;

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'easybi-files-'));
  await mkdir(join(ws, 'knowledge', 'drafts'), { recursive: true });
  await mkdir(join(ws, 'node_modules'), { recursive: true });
  await writeFile(join(ws, 'knowledge', 'index.json'), '{"versions":[]}');
  await writeFile(join(ws, 'config-note.md'), '# hello');
  await writeFile(join(ws, 'node_modules', 'junk.js'), 'x');
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('listWorkspaceDir', () => {
  it('lists root, dirs first, hides node_modules', async () => {
    const tree = await listWorkspaceDir(ws, '');
    const names = tree.entries.map((e) => e.name);
    expect(names).toContain('knowledge');
    expect(names).toContain('config-note.md');
    expect(names).not.toContain('node_modules');
    // dir before file
    expect(tree.entries[0]?.kind).toBe('dir');
  });

  it('lists a subdirectory', async () => {
    const tree = await listWorkspaceDir(ws, 'knowledge');
    expect(tree.entries.map((e) => e.name)).toContain('index.json');
  });

  it('rejects path traversal', async () => {
    await expect(listWorkspaceDir(ws, '../..')).rejects.toThrow();
  });
});

describe('readWorkspaceFile', () => {
  it('reads text content of a previewable file', async () => {
    const f = await readWorkspaceFile(ws, 'knowledge/index.json');
    expect(f.content).toContain('versions');
  });

  it('rejects escaping the workspace', async () => {
    await expect(readWorkspaceFile(ws, '../secret')).rejects.toThrow();
  });
});
