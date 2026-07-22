import { stat, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceStructureCheck } from '@easybi-studio/contracts';
import { normalizeAbsolute } from './paths.js';

/**
 * Read-only workspace structure validation (plan §1 stage 1).
 *
 * This never creates or modifies files. It reports what exists so the service
 * can decide whether a directory is registrable and later whether bootstrap
 * init/check is needed. Auto-repair belongs to the Bootstrapper (stage 2).
 */

/** Top-level logical directories expected in a full workspace (from the manifest). */
const EXPECTED_DIRECTORIES = [
  'config',
  'skills',
  'toolkit',
  'knowledge',
  'reports',
  'outputs',
  'work',
];

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

export async function checkWorkspaceStructure(workspaceRoot: string): Promise<WorkspaceStructureCheck> {
  const root = normalizeAbsolute(workspaceRoot);
  const notes: string[] = [];

  const rootExists = await exists(root);
  const rootIsDir = rootExists && (await isDir(root));

  if (!rootExists) {
    notes.push('目标路径不存在');
    return {
      workspaceRoot: root,
      exists: false,
      isDirectory: false,
      hasWorkspaceManifest: false,
      hasBundleManifest: false,
      hasBundleLock: false,
      presentDirectories: [],
      missingDirectories: [...EXPECTED_DIRECTORIES],
      registrable: false,
      notes,
    };
  }

  if (!rootIsDir) {
    notes.push('目标路径不是目录');
    return {
      workspaceRoot: root,
      exists: true,
      isDirectory: false,
      hasWorkspaceManifest: false,
      hasBundleManifest: false,
      hasBundleLock: false,
      presentDirectories: [],
      missingDirectories: [...EXPECTED_DIRECTORIES],
      registrable: false,
      notes,
    };
  }

  const hasWorkspaceManifest = await isFile(join(root, 'workspace.json'));
  const hasBundleManifest = await isFile(join(root, 'skills', 'bundle.manifest.json'));
  const hasBundleLock = await isFile(join(root, 'skills', 'bundle.lock.json'));

  const presentDirectories: string[] = [];
  const missingDirectories: string[] = [];
  for (const d of EXPECTED_DIRECTORIES) {
    if (await isDir(join(root, d))) {
      presentDirectories.push(d);
    } else {
      missingDirectories.push(d);
    }
  }

  // A directory is registrable as a workspace target as long as it is a real
  // directory. Whether it needs init or check is decided by the Bootstrapper.
  const registrable = true;

  if (!hasWorkspaceManifest) {
    notes.push('缺少 workspace.json（可在打开时通过 init/兼容补齐生成）');
  }
  if (!hasBundleManifest) {
    notes.push('缺少 skills/bundle.manifest.json（旧工作区可兼容补齐）');
  }
  if (missingDirectories.length > 0) {
    notes.push(`缺少可重建目录：${missingDirectories.join(', ')}`);
  }
  if (notes.length === 0) {
    notes.push('工作区结构完整');
  }

  return {
    workspaceRoot: root,
    exists: true,
    isDirectory: true,
    hasWorkspaceManifest,
    hasBundleManifest,
    hasBundleLock,
    presentDirectories,
    missingDirectories,
    registrable,
    notes,
  };
}
