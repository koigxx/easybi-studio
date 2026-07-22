import { mkdir, stat } from 'node:fs/promises';
import type { BootstrapResult, BundleLock, SkillBundleSource } from '@easybi-studio/contracts';
import { SkillVersionCache, buildBundleLock, writeBundleLock, readBundleLock } from '@easybi-studio/skill-bundle-manager';
import { bootstrapWorkspace } from './bootstrapper.js';

/**
 * High-level orchestration for creating / opening a Skill workspace (plan §9.1, §9.2).
 *
 *   source -> immutable version cache -> independent workspace install
 *          -> write bundle.lock.json -> idempotent bootstrap (init/check)
 *
 * Installing or upgrading one workspace never touches another workspace or the
 * cached immutable versions of other bundles.
 */
export interface CreateWorkspaceOptions {
  workspaceRoot: string;
  source: SkillBundleSource;
  cache: SkillVersionCache;
  bundleId: string;
  /** Bundle version or 'current' for the local-directory source. */
  version?: string;
  projectId?: string;
  systemId?: string;
  systemName?: string;
}

export interface CreateWorkspaceResult {
  bootstrap: BootstrapResult;
  lock: BundleLock;
  bundleVersion: string;
  bundleSha256: string;
  cacheReused: boolean;
  /** True when a fresh install happened; false when the workspace already had this bundle. */
  installed: boolean;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function createOrOpenWorkspace(
  options: CreateWorkspaceOptions,
): Promise<CreateWorkspaceResult> {
  const { workspaceRoot, source, cache, bundleId } = options;
  const version = options.version ?? 'current';

  await mkdir(workspaceRoot, { recursive: true });

  // 1. Ensure the requested version is present in the immutable cache.
  const entry = await cache.fetchAndCache(source, bundleId, version);

  // 2. Decide install vs. open based on an existing lock.
  const existingLock = await readBundleLock(workspaceRoot);
  let installed = false;
  if (!existingLock) {
    // Fresh install: copy skills/ + toolkit/ from the immutable cache.
    await cache.installInto(bundleId, entry.version, workspaceRoot);
    installed = true;
  }
  // If a lock exists, we do NOT silently upgrade (plan §9.2). Opening just runs check.

  // 3. Write / preserve the bundle lock.
  let lock: BundleLock;
  if (existingLock) {
    lock = existingLock;
  } else {
    lock = buildBundleLock({
      bundleId: entry.bundleId,
      bundleVersion: entry.version,
      bundleSha256: entry.bundleSha256,
      sourceType: source.type,
    });
    await writeBundleLock(workspaceRoot, lock);
  }

  // 4. Idempotent bootstrap (init when no workspace.json, else check).
  const bootstrap = await bootstrapWorkspace({
    workspaceRoot,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.systemId ? { systemId: options.systemId } : {}),
    ...(options.systemName ? { systemName: options.systemName } : {}),
  });

  return {
    bootstrap,
    lock,
    bundleVersion: entry.version,
    bundleSha256: entry.bundleSha256,
    cacheReused: entry.reused,
    installed,
  };
}

/** Guard used by callers: refuse to treat an existing workspace as a brand-new create. */
export async function workspaceAlreadyInstalled(workspaceRoot: string): Promise<boolean> {
  return (await isDir(workspaceRoot)) && (await readBundleLock(workspaceRoot)) !== null;
}
