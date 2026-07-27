import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalDirectorySource } from './sources/local-directory.js';
import { isSkillFileIncluded } from './whitelist.js';

const SOURCE = fileURLToPath(new URL('../../../skill-source/easy-bi', import.meta.url));

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('whitelist', () => {
  it('includes SKILL.md, usage guide, dist/scripts, references, bootstrap script', () => {
    expect(isSkillFileIncluded('SKILL.md')).toBe(true);
    expect(isSkillFileIncluded('使用说明.md')).toBe(true);
    expect(isSkillFileIncluded('dist/scripts/catalog-cli.js')).toBe(true);
    expect(isSkillFileIncluded('references/知识库技术规范.md')).toBe(true);
    expect(isSkillFileIncluded('scripts/bootstrap-dependencies.mjs')).toBe(true);
    expect(isSkillFileIncluded('npm-shrinkwrap.json')).toBe(true);
  });

  it('excludes node_modules, tests, dist/tests, tsconfig, ts sources', () => {
    expect(isSkillFileIncluded('node_modules/x/index.js')).toBe(false);
    expect(isSkillFileIncluded('tests/catalog-cli.test.ts')).toBe(false);
    expect(isSkillFileIncluded('dist/tests/catalog-cli.test.js')).toBe(false);
    expect(isSkillFileIncluded('tsconfig.json')).toBe(false);
    expect(isSkillFileIncluded('scripts/catalog-cli.ts')).toBe(false);
  });
});

describe('LocalDirectorySource against the canonical Easy BI source', () => {
  let dest: string;

  beforeAll(async () => {
    dest = await mkdtemp(join(tmpdir(), 'easybi-snap-'));
  });

  afterAll(async () => {
    await rm(dest, { recursive: true, force: true });
  });

  it('reports healthy and lists the current bundle version', async () => {
    const src = new LocalDirectorySource(SOURCE);
    const health = await src.healthCheck();
    expect(health.available).toBe(true);
    const versions = await src.listVersions('easybi');
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe('1.35.3');
  });

  it('fetches a whitelisted snapshot with manifest + SHA-256 and no forbidden content', async () => {
    const src = new LocalDirectorySource(SOURCE);
    const snapshotDir = join(dest, 'snap');
    const fetched = await src.fetch('easybi', 'current', snapshotDir);

    expect(fetched.bundleId).toBe('easybi');
    expect(fetched.version).toBe('1.35.3');
    expect(fetched.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fetched.manifest.files && fetched.manifest.files.length).toBeGreaterThan(0);

    // Required content present.
    expect(await exists(join(snapshotDir, 'skills', 'bundle.manifest.json'))).toBe(true);
    expect(await exists(join(snapshotDir, 'skills', '目录与项目兼容性规范.md'))).toBe(true);
    expect(
      await exists(join(snapshotDir, 'skills', 'initialize-report-knowledge', 'SKILL.md')),
    ).toBe(true);
    expect(
      await exists(join(snapshotDir, 'skills', 'initialize-report-knowledge', '使用说明.md')),
    ).toBe(true);
    expect(
      await exists(join(snapshotDir, 'skills', 'create-report-package', '使用说明.md')),
    ).toBe(true);
    expect(
      await exists(
        join(snapshotDir, 'skills', 'initialize-report-knowledge', 'dist', 'scripts', 'catalog-cli.js'),
      ),
    ).toBe(true);
    expect(
      await exists(join(snapshotDir, 'skills', 'create-report-package', 'dist', 'scripts', 'runtime-cli.js')),
    ).toBe(true);
    expect(await exists(join(snapshotDir, 'toolkit', 'contracts', '统一接口契约.md'))).toBe(true);
    expect(await exists(join(snapshotDir, 'skills', '兼容性变更记录'))).toBe(false);

    // Forbidden content absent.
    expect(await exists(join(snapshotDir, 'skills', 'initialize-report-knowledge', 'node_modules'))).toBe(false);
    expect(await exists(join(snapshotDir, 'skills', 'initialize-report-knowledge', 'tests'))).toBe(false);
    expect(await exists(join(snapshotDir, 'skills', 'initialize-report-knowledge', 'dist', 'tests'))).toBe(false);
    expect(await exists(join(snapshotDir, 'skills', 'initialize-report-knowledge', 'tsconfig.json'))).toBe(false);
    expect(await exists(join(snapshotDir, 'docs'))).toBe(false);
    expect(await exists(join(snapshotDir, 'knowledge'))).toBe(false);

    // Manifest carries source provenance and hashes.
    const productManifest = JSON.parse(
      await readFile(join(snapshotDir, 'skills', 'bundle.manifest.json'), 'utf8'),
    );
    expect(productManifest.source.type).toBe('local-directory');
    expect(Array.isArray(productManifest.files)).toBe(true);
    expect(
      productManifest.files.some(
        (file: { path: string }) => file.path === 'skills/bundle.manifest.json',
      ),
    ).toBe(false);
    for (const file of productManifest.files as Array<{ path: string; sha256: string }>) {
      const actual = createHash('sha256')
        .update(await readFile(join(snapshotDir, file.path)))
        .digest('hex');
      expect(actual, file.path).toBe(file.sha256);
    }
  });

  it('does not modify the canonical source (manifest mtime stable)', async () => {
    const before = await stat(join(SOURCE, 'skills', 'bundle.manifest.json'));
    const src = new LocalDirectorySource(SOURCE);
    await src.fetch('easybi', 'current', join(dest, 'snap2'));
    const after = await stat(join(SOURCE, 'skills', 'bundle.manifest.json'));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
