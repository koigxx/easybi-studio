import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { BundleFileHash } from '@easybi-studio/contracts';

/** Compute SHA-256 of a file. */
export async function sha256File(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

/** Recursively list files under a directory, returned as posix-relative paths. */
export async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        out.push(relative(root, abs).split(sep).join('/'));
      }
    }
  }
  const s = await stat(root);
  if (s.isDirectory()) await walk(root);
  return out.sort();
}

/** Build a sorted per-file SHA-256 list for all files under a directory. */
export async function hashDirectory(root: string): Promise<BundleFileHash[]> {
  const files = await listFilesRecursive(root);
  const result: BundleFileHash[] = [];
  for (const rel of files) {
    result.push({ path: rel, sha256: await sha256File(join(root, rel)) });
  }
  return result;
}

/** Aggregate a stable bundle hash over an ordered file-hash list. */
export function aggregateBundleHash(files: BundleFileHash[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(f.path);
    h.update('\0');
    h.update(f.sha256);
    h.update('\n');
  }
  return h.digest('hex');
}
