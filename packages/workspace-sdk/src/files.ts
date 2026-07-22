import { readdir, stat, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { normalizeAbsolute, resolveWithinWorkspace } from './paths.js';

/**
 * Read-only workspace file browsing (for the UI file/knowledge preview).
 *
 * Everything is confined to the workspace root (path traversal rejected).
 * Directories that are noise or heavy are hidden; binary/large files are listed
 * but their content is not returned as text.
 */

const HIDDEN_DIRS = new Set(['node_modules', '.git', '.checkpoints']);
const MAX_TEXT_BYTES = 512 * 1024;
/** Extensions treated as previewable text. */
const TEXT_EXT = /\.(json|md|txt|sql|ts|tsx|js|mjs|cjs|csv|ya?ml|xml|html?|log|sha256|lock)$/i;

export interface FileNode {
  /** Workspace-relative posix path. */
  path: string;
  name: string;
  kind: 'dir' | 'file';
  /** File size in bytes (files only). */
  size?: number;
  /** Whether the file looks previewable as text. */
  textPreviewable?: boolean;
}

export interface FileTree {
  workspaceRoot: string;
  /** The directory this listing is for (workspace-relative; '' = root). */
  dir: string;
  entries: FileNode[];
}

/** List one directory level under the workspace (not recursive). */
export async function listWorkspaceDir(
  workspaceRoot: string,
  relDir = '',
): Promise<FileTree> {
  const root = normalizeAbsolute(workspaceRoot);
  const abs = relDir ? resolveWithinWorkspace(root, relDir) : root;
  const entries: FileNode[] = [];
  let dirents;
  try {
    dirents = await readdir(abs, { withFileTypes: true });
  } catch {
    return { workspaceRoot: root, dir: relDir, entries };
  }
  for (const d of dirents) {
    if (d.isDirectory() && HIDDEN_DIRS.has(d.name)) continue;
    const childAbs = join(abs, d.name);
    const relPath = relative(root, childAbs).split(sep).join('/');
    if (d.isDirectory()) {
      entries.push({ path: relPath, name: d.name, kind: 'dir' });
    } else if (d.isFile()) {
      let size = 0;
      try {
        size = (await stat(childAbs)).size;
      } catch {
        /* ignore */
      }
      entries.push({
        path: relPath,
        name: d.name,
        kind: 'file',
        size,
        textPreviewable: TEXT_EXT.test(d.name) && size <= MAX_TEXT_BYTES,
      });
    }
  }
  // Directories first, then files, both alphabetical.
  entries.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name),
  );
  return { workspaceRoot: root, dir: relDir, entries };
}

export interface FileContent {
  path: string;
  size: number;
  /** UTF-8 text content when previewable; null for binary/oversized. */
  content: string | null;
  /** Reason content is null. */
  reason?: string;
}

/** Read a single workspace file's text content (guarded). */
export async function readWorkspaceFile(
  workspaceRoot: string,
  relPath: string,
): Promise<FileContent> {
  const abs = resolveWithinWorkspace(normalizeAbsolute(workspaceRoot), relPath);
  const st = await stat(abs);
  if (!st.isFile()) {
    return { path: relPath, size: 0, content: null, reason: '不是文件' };
  }
  if (st.size > MAX_TEXT_BYTES) {
    return { path: relPath, size: st.size, content: null, reason: '文件过大，未加载正文' };
  }
  if (!TEXT_EXT.test(relPath)) {
    return { path: relPath, size: st.size, content: null, reason: '非文本文件，仅列出' };
  }
  const buf = await readFile(abs);
  if (buf.includes(0)) {
    return { path: relPath, size: st.size, content: null, reason: '二进制文件，未加载正文' };
  }
  return { path: relPath, size: st.size, content: buf.toString('utf8') };
}
