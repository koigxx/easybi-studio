import { mkdir, rm, rename, stat, readFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import type { BundleManifest, FetchedBundle, SkillBundleSource } from '@easybi-studio/contracts';
import { hashDirectory, aggregateBundleHash } from '@easybi-studio/skill-bundle-source';

/**
 * Immutable, per-version local bundle cache (plan §8.1.1).
 *
 * Layout:  <cacheRoot>/<bundle-id>/<version>/  (immutable snapshot)
 *          <cacheRoot>/<bundle-id>/<version>.sha256  (aggregate hash marker)
 *
 * fetchAndCache uses "source -> temp -> atomic rename into cache". If a version
 * is already cached, it is reused without re-copying from the source. A cached
 * version is never mutated; upgrading one workspace cannot change it.
 */
export interface CacheEntry {
  bundleId: string;
  version: string;
  path: string;
  bundleSha256: string;
  manifest: BundleManifest;
  /** True when this call reused an existing cache entry. */
  reused: boolean;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export class SkillVersionCache {
  constructor(private readonly cacheRoot: string) {}

  private versionDir(bundleId: string, version: string): string {
    return join(this.cacheRoot, bundleId, version);
  }

  private shaMarker(bundleId: string, version: string): string {
    return join(this.cacheRoot, bundleId, `${version}.sha256`);
  }

  async has(bundleId: string, version: string): Promise<boolean> {
    return isDir(this.versionDir(bundleId, version));
  }

  async readManifest(bundleId: string, version: string): Promise<BundleManifest> {
    const p = join(this.versionDir(bundleId, version), 'skills', 'bundle.manifest.json');
    return JSON.parse(await readFile(p, 'utf8')) as BundleManifest;
  }

  /**
   * Ensure a bundle version is present in the immutable cache. Reuses the cache
   * when present. Otherwise fetches from the source into a temp dir and
   * atomically moves the validated snapshot into place.
   */
  async fetchAndCache(
    source: SkillBundleSource,
    bundleId: string,
    version: string,
  ): Promise<CacheEntry> {
    // Resolve the concrete version first (source may accept 'current').
    const manifest = await source.getManifest(bundleId, version);
    const resolvedVersion = manifest.bundle_version;
    const finalDir = this.versionDir(bundleId, resolvedVersion);

    if (await this.has(bundleId, resolvedVersion)) {
      const cachedManifest = await this.readManifest(bundleId, resolvedVersion);
      const bundleSha256 = await this.readShaMarker(bundleId, resolvedVersion, finalDir);
      return {
        bundleId,
        version: resolvedVersion,
        path: finalDir,
        bundleSha256,
        manifest: cachedManifest,
        reused: true,
      };
    }

    await mkdir(join(this.cacheRoot, bundleId), { recursive: true });
    const tempDir = `${finalDir}.tmp-${process.pid}-${Date.now()}`;
    await rm(tempDir, { recursive: true, force: true });

    let fetched: FetchedBundle;
    try {
      fetched = await source.fetch(bundleId, version, tempDir);

      // Atomic move into the immutable location.
      await rename(tempDir, finalDir);
    } catch (err) {
      await rm(tempDir, { recursive: true, force: true });
      throw err;
    }

    await this.writeShaMarker(bundleId, resolvedVersion, fetched.bundleSha256);

    return {
      bundleId,
      version: resolvedVersion,
      path: finalDir,
      bundleSha256: fetched.bundleSha256,
      manifest: fetched.manifest,
      reused: false,
    };
  }

  private async readShaMarker(
    bundleId: string,
    version: string,
    dir: string,
  ): Promise<string> {
    try {
      return (await readFile(this.shaMarker(bundleId, version), 'utf8')).trim();
    } catch {
      // Recompute if the marker is missing.
      const files = await hashDirectory(dir);
      return aggregateBundleHash(files);
    }
  }

  private async writeShaMarker(bundleId: string, version: string, sha: string): Promise<void> {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(this.shaMarker(bundleId, version), sha + '\n', 'utf8');
  }

  /** Copy an immutable cache version into a workspace destination (independent copy). */
  async installInto(bundleId: string, version: string, workspaceRoot: string): Promise<void> {
    const src = this.versionDir(bundleId, version);
    if (!(await isDir(src))) {
      throw new Error(`缓存中不存在版本：${bundleId}@${version}`);
    }
    // Copy skills/ and toolkit/ from cache into the workspace.
    await cp(join(src, 'skills'), join(workspaceRoot, 'skills'), { recursive: true });
    await cp(join(src, 'toolkit'), join(workspaceRoot, 'toolkit'), { recursive: true });
  }
}
