import { mkdtemp, rm, stat, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { x as tarExtract } from 'tar';
import type {
  BundleManifest,
  FetchedBundle,
  SkillBundleSource,
  SkillBundleVersion,
  SkillSourceHealth,
} from '@easybi-studio/contracts';
import { normalizeAbsolute } from '@easybi-studio/workspace-sdk';
import { LocalDirectorySource } from './local-directory.js';

/**
 * Install a Skill bundle from a local .tar.gz archive (plan §8.1).
 *
 * The archive is the canonical distribution format — a cloud HTTP registry only
 * needs to download such an archive and hand its path here. This source:
 *   1. extracts the archive into a temp directory,
 *   2. locates the extracted bundle root (the dir containing skills/bundle.manifest.json),
 *   3. delegates to LocalDirectorySource so whitelist / hashing / snapshot logic
 *      is shared with the directory source,
 *   4. cleans up the temp extraction.
 *
 * The archive file itself is never modified.
 */
export class LocalArchiveSource implements SkillBundleSource {
  readonly type = 'local-archive' as const;
  private readonly archivePath: string;

  constructor(archivePath: string) {
    this.archivePath = normalizeAbsolute(archivePath);
  }

  private async extractToTemp(): Promise<{ dir: string; bundleRoot: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'easybi-archive-'));
    await tarExtract({ file: this.archivePath, cwd: dir });
    const bundleRoot = await this.findBundleRoot(dir);
    return { dir, bundleRoot };
  }

  /** Find the directory containing skills/bundle.manifest.json (handles a wrapping top-level folder). */
  private async findBundleRoot(root: string): Promise<string> {
    const direct = join(root, 'skills', 'bundle.manifest.json');
    if (await this.isFile(direct)) return root;
    // Look one level down (archives often wrap content in a single folder).
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const nested = join(root, entry.name);
        if (await this.isFile(join(nested, 'skills', 'bundle.manifest.json'))) return nested;
      }
    }
    throw new Error('压缩包中未找到 skills/bundle.manifest.json');
  }

  private async isFile(p: string): Promise<boolean> {
    try {
      return (await stat(p)).isFile();
    } catch {
      return false;
    }
  }

  async healthCheck(): Promise<SkillSourceHealth> {
    try {
      if (!(await this.isFile(this.archivePath))) {
        return { type: this.type, available: false, note: '压缩包不存在', location: this.archivePath };
      }
      const { dir, bundleRoot } = await this.extractToTemp();
      try {
        const health = await new LocalDirectorySource(bundleRoot).healthCheck();
        return { ...health, type: this.type, location: this.archivePath };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } catch (err) {
      return {
        type: this.type,
        available: false,
        note: err instanceof Error ? err.message : String(err),
        location: this.archivePath,
      };
    }
  }

  async listVersions(bundleId: string): Promise<SkillBundleVersion[]> {
    const { dir, bundleRoot } = await this.extractToTemp();
    try {
      return await new LocalDirectorySource(bundleRoot).listVersions(bundleId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async getManifest(bundleId: string, version: string): Promise<BundleManifest> {
    const { dir, bundleRoot } = await this.extractToTemp();
    try {
      return await new LocalDirectorySource(bundleRoot).getManifest(bundleId, version);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async fetch(bundleId: string, version: string, destination: string): Promise<FetchedBundle> {
    const { dir, bundleRoot } = await this.extractToTemp();
    try {
      const fetched = await new LocalDirectorySource(bundleRoot).fetch(bundleId, version, destination);
      // Record archive provenance (both the returned object and the on-disk manifest).
      const manifest: BundleManifest = {
        ...fetched.manifest,
        source: { type: this.type, location: this.archivePath },
      };
      const manifestPath = join(destination, 'skills', 'bundle.manifest.json');
      const onDisk = JSON.parse(await readFile(manifestPath, 'utf8')) as BundleManifest;
      onDisk.source = { type: this.type, location: this.archivePath };
      await writeFile(manifestPath, JSON.stringify(onDisk, null, 2) + '\n', 'utf8');
      return { ...fetched, manifest };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
