import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BundleManifest,
  FetchedBundle,
  SkillBundleSource,
  SkillBundleVersion,
  SkillSourceHealth,
} from '@easybi-studio/contracts';
import { SkillVersionCache } from './cache.js';

let root: string;

/**
 * A minimal fake source that materializes a controllable public surface so we
 * can exercise immutable multi-version caching without touching the real source.
 */
class FakeSource implements SkillBundleSource {
  readonly type = 'local-directory' as const;
  constructor(
    private version: string,
    private skillDirs: string[],
  ) {}

  async healthCheck(): Promise<SkillSourceHealth> {
    return { type: this.type, available: true };
  }
  async listVersions(): Promise<SkillBundleVersion[]> {
    return [{ bundleId: 'fake', version: this.version }];
  }
  async getManifest(): Promise<BundleManifest> {
    return this.manifest();
  }
  private manifest(): BundleManifest {
    return {
      bundle_format_version: '1',
      bundle_id: 'fake',
      bundle_version: this.version,
      compatibility: {
        workspace_formats: ['1'],
        config_formats: ['4'],
        catalog_formats: ['3'],
        report_package_formats: ['1'],
        runtime_api_versions: ['v1'],
      },
      skills: [{ id: 's', version: '1', path: 's', agent_entry: 's/SKILL.md', commands: {} }],
      workspace_contract: {
        bootstrap_contract_version: '1',
        supported_modes: ['init', 'check'],
        path_bases: {},
        paths: {},
        templates: {},
        empty_indexes: {},
        bootstrap_policy: {},
      },
      distribution: {
        supported_source_types: ['local-directory'],
        immutable_versions: true,
        verify_file_hashes: true,
        silent_workspace_upgrade: false,
      },
      contracts: { directory_compatibility: '目录与项目兼容性规范.md' },
    };
  }
  async fetch(_b: string, _v: string, destination: string): Promise<FetchedBundle> {
    const skills = join(destination, 'skills');
    await mkdir(skills, { recursive: true });
    for (const d of this.skillDirs) {
      await mkdir(join(skills, d), { recursive: true });
      await writeFile(join(skills, d, '.keep'), '');
    }
    await writeFile(join(skills, 'bundle.manifest.json'), JSON.stringify(this.manifest()));
    return {
      bundleId: 'fake',
      version: this.version,
      destination,
      manifest: this.manifest(),
      bundleSha256: 'deadbeef',
    };
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'easybi-cache-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('SkillVersionCache immutability', () => {
  it('caches a version once and reuses it on the second fetch', async () => {
    const cache = new SkillVersionCache(join(root, 'c1'));
    const src = new FakeSource('1.0.0', ['s']);
    const first = await cache.fetchAndCache(src, 'fake', 'current');
    expect(first.reused).toBe(false);
    const second = await cache.fetchAndCache(src, 'fake', 'current');
    expect(second.reused).toBe(true);
    expect(second.path).toBe(first.path);
  });

  it('caches a new version with a changed public surface without requiring history files', async () => {
    const cache = new SkillVersionCache(join(root, 'c2'));
    await cache.fetchAndCache(new FakeSource('1.0.0', ['s']), 'fake', 'current');
    const up = await cache.fetchAndCache(
      new FakeSource('1.1.0', ['s', 'extra']),
      'fake',
      'current',
    );
    expect(up.version).toBe('1.1.0');
    expect(await exists(join(root, 'c2', 'fake', '1.0.0'))).toBe(true);
    expect(await exists(join(root, 'c2', 'fake', '1.1.0'))).toBe(true);
  });
});
