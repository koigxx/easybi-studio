import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, copyFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveWithinWorkspace } from '@easybi-studio/workspace-sdk';

/**
 * Config store with revision concurrency control, atomic write, and pre-write
 * backup (plan §10.2, §17).
 *
 * `revision` is the SHA-256 of the on-disk file content. A save must present the
 * revision it read; if the file changed since (e.g. Claude Code edited it), the
 * save is rejected with a conflict rather than silently overwriting.
 */

export class ConfigConflictError extends Error {
  readonly code = 'CONFIG_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'ConfigConflictError';
  }
}

export class ConfigNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'ConfigNotFoundError';
  }
}

export function computeRevision(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface ConfigRead {
  /** Parsed JSON value. */
  value: unknown;
  /** Raw file content. */
  raw: string;
  /** Revision (content hash) to present on the next save. */
  revision: string;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Read a workspace-relative config file. Throws ConfigNotFoundError if absent. */
export async function readConfig(workspaceRoot: string, relativePath: string): Promise<ConfigRead> {
  const abs = resolveWithinWorkspace(workspaceRoot, relativePath);
  if (!(await fileExists(abs))) {
    throw new ConfigNotFoundError(`配置文件不存在：${relativePath}`);
  }
  const raw = await readFile(abs, 'utf8');
  return { value: JSON.parse(raw), raw, revision: computeRevision(raw) };
}

export interface WriteConfigOptions {
  workspaceRoot: string;
  relativePath: string;
  /** New JSON value to persist. */
  value: unknown;
  /** Revision the caller read; must match the current on-disk revision. */
  expectedRevision: string;
  /** Directory (workspace-relative) to store timestamped backups. */
  backupDir?: string;
}

export interface WriteConfigResult {
  revision: string;
  backupPath?: string;
}

/**
 * Atomically write a config file after verifying the expected revision.
 * Backs up the previous content before replacing.
 */
export async function writeConfig(options: WriteConfigOptions): Promise<WriteConfigResult> {
  const { workspaceRoot, relativePath, value, expectedRevision } = options;
  const abs = resolveWithinWorkspace(workspaceRoot, relativePath);

  const exists = await fileExists(abs);
  const current = exists ? await readFile(abs, 'utf8') : '';
  const currentRevision = exists ? computeRevision(current) : '';

  if (currentRevision !== expectedRevision) {
    throw new ConfigConflictError(
      `配置已被其他任务修改（期望 revision ${expectedRevision.slice(0, 8)}，实际 ${
        currentRevision ? currentRevision.slice(0, 8) : '不存在'
      }），已阻止覆盖`,
    );
  }

  const serialized = JSON.stringify(value, null, 2) + '\n';

  // Backup previous content.
  let backupPath: string | undefined;
  if (exists) {
    const backupDir = options.backupDir ?? 'work/config-backups';
    const backupAbs = resolveWithinWorkspace(
      workspaceRoot,
      join(backupDir, `${relativePath.replace(/[\\/]/g, '_')}.${currentRevision.slice(0, 8)}.bak`),
    );
    await mkdir(dirname(backupAbs), { recursive: true });
    await copyFile(abs, backupAbs);
    backupPath = backupAbs;
  }

  // Atomic write: temp file in the same dir, then rename.
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, serialized, 'utf8');
  await rename(tmp, abs);

  const result: WriteConfigResult = { revision: computeRevision(serialized) };
  if (backupPath !== undefined) result.backupPath = backupPath;
  return result;
}
