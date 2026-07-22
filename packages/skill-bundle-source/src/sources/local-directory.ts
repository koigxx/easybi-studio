import { stat, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BundleManifest,
  FetchedBundle,
  SkillBundleSource,
  SkillBundleVersion,
  SkillSourceHealth,
} from '@easybi-studio/contracts';
import { normalizeAbsolute } from '@easybi-studio/workspace-sdk';
import { readSourceManifest, materializeSnapshot } from '../snapshot.js';
import { validateManifestShape, validateSourceEntries, BundleValidationError } from '../validate.js';
import { hashDirectory, aggregateBundleHash } from '../hash.js';

/**
 * First-release Skill source: reads the canonical Easy BI directory (read-only).
 *
 * It implements the full SkillBundleSource contract. Even though it returns only
 * the current version of the local directory, the interface is identical to the
 * reserved remote/archive sources so business code never depends on this class.
 *
 * The canonical source is NEVER written to. `fetch` copies the whitelisted
 * snapshot into a caller-provided destination and writes a product manifest
 * (with per-file SHA-256) there.
 */
export class LocalDirectorySource implements SkillBundleSource {
  readonly type = 'local-directory' as const;
  private readonly sourceDir: string;

  constructor(sourceDir: string) {
    this.sourceDir = normalizeAbsolute(sourceDir);
  }

  async healthCheck(): Promise<SkillSourceHealth> {
    try {
      const s = await stat(this.sourceDir);
      if (!s.isDirectory()) {
        return { type: this.type, available: false, note: '来源不是目录', location: this.sourceDir };
      }
      const manifest = await readSourceManifest(this.sourceDir);
      validateManifestShape(manifest);
      return {
        type: this.type,
        available: true,
        note: `Bundle ${manifest.bundle_id} ${manifest.bundle_version}`,
        location: this.sourceDir,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { type: this.type, available: false, note: message, location: this.sourceDir };
    }
  }

  async listVersions(bundleId: string): Promise<SkillBundleVersion[]> {
    const manifest = await readSourceManifest(this.sourceDir);
    if (manifest.bundle_id !== bundleId) return [];
    return [{ bundleId: manifest.bundle_id, version: manifest.bundle_version }];
  }

  async getManifest(bundleId: string, version: string): Promise<BundleManifest> {
    const manifest = await readSourceManifest(this.sourceDir);
    validateManifestShape(manifest);
    if (manifest.bundle_id !== bundleId) {
      throw new BundleValidationError(`来源 Bundle ID 不匹配：${manifest.bundle_id} != ${bundleId}`);
    }
    if (version !== 'current' && manifest.bundle_version !== version) {
      throw new BundleValidationError(
        `来源仅提供当前版本 ${manifest.bundle_version}，无法提供 ${version}`,
      );
    }
    return manifest;
  }

  /**
   * Materialize the whitelisted snapshot into `destination` and produce a
   * product manifest with SHA-256 hashes and source provenance.
   */
  async fetch(bundleId: string, version: string, destination: string): Promise<FetchedBundle> {
    const dest = normalizeAbsolute(destination);
    const manifest = await this.getManifest(bundleId, version);
    await validateSourceEntries(this.sourceDir, manifest);

    // Clean destination for a deterministic snapshot.
    await rm(dest, { recursive: true, force: true });
    await materializeSnapshot(this.sourceDir, dest, manifest);

    // A manifest cannot contain the hash of its final own bytes without a
    // circular definition. files[] therefore covers every whitelisted payload
    // except the manifest itself; the aggregate bundle hash below still covers
    // the final manifest bytes.
    const preHashes = (await hashDirectory(dest)).filter(
      (file) => file.path !== 'skills/bundle.manifest.json',
    );
    const productManifest: BundleManifest = {
      ...manifest,
      source: { type: this.type, location: this.sourceDir },
      generated_at: new Date().toISOString(),
      files: preHashes,
    };
    const manifestPath = join(dest, 'skills', 'bundle.manifest.json');
    await writeFile(manifestPath, JSON.stringify(productManifest, null, 2) + '\n', 'utf8');

    const files = await hashDirectory(dest);
    const bundleSha256 = aggregateBundleHash(files);

    return {
      bundleId: manifest.bundle_id,
      version: manifest.bundle_version,
      destination: dest,
      manifest: productManifest,
      bundleSha256,
    };
  }
}
