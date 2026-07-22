import { createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BundleLock, SkillSourceType } from '@easybi-studio/contracts';

/** Build a workspace bundle lock (plan §8.1.3). Never stores secrets/tokens. */
export function buildBundleLock(input: {
  bundleId: string;
  bundleVersion: string;
  bundleSha256: string;
  sourceType: SkillSourceType;
  installedAt?: string;
}): BundleLock {
  const installedAt = input.installedAt ?? new Date().toISOString();
  const revision = createHash('sha256')
    .update(`${input.bundleId}\0${input.bundleVersion}\0${input.bundleSha256}\0${installedAt}`)
    .digest('hex');
  return {
    lock_format_version: '1',
    bundle_id: input.bundleId,
    bundle_version: input.bundleVersion,
    bundle_sha256: input.bundleSha256,
    source_type: input.sourceType,
    installed_manifest: 'skills/bundle.manifest.json',
    installed_at: installedAt,
    revision,
  };
}

const FORBIDDEN_LOCK_KEYS = ['password', 'token', 'secret', 'access_key', 'apikey', 'api_key'];

/** Guard: a lock must never carry secret-like fields. */
export function assertLockSecretFree(lock: BundleLock): void {
  const json = JSON.stringify(lock).toLowerCase();
  for (const k of FORBIDDEN_LOCK_KEYS) {
    if (json.includes(`"${k}"`)) {
      throw new Error(`Bundle Lock 不得包含敏感字段：${k}`);
    }
  }
}

export async function writeBundleLock(workspaceRoot: string, lock: BundleLock): Promise<string> {
  assertLockSecretFree(lock);
  const path = join(workspaceRoot, 'skills', 'bundle.lock.json');
  await writeFile(path, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  return path;
}

export async function readBundleLock(workspaceRoot: string): Promise<BundleLock | null> {
  const path = join(workspaceRoot, 'skills', 'bundle.lock.json');
  try {
    await stat(path);
    return JSON.parse(await readFile(path, 'utf8')) as BundleLock;
  } catch {
    return null;
  }
}
