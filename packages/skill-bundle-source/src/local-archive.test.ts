import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, cp, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { c as tarCreate } from 'tar';
import { LocalArchiveSource } from './sources/local-archive.js';

/**
 * LocalArchiveSource installs a bundle from a .tar.gz archive — the canonical
 * cloud distribution format. We build an archive from the synced cache (the
 * whitelisted bundle) and verify install parity with the directory source.
 */
const CACHE = join(homedir(), '.easybi-studio', 'skill-cache', 'easybi', '0.1.1');
const available = existsSync(join(CACHE, 'skills', 'bundle.manifest.json'));
const maybe = available ? describe : describe.skip;

let base: string;
let archivePath: string;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'easybi-arc-'));
  if (available) {
    // Pack the cached bundle (skills/ + toolkit/) into a wrapping folder, gzipped.
    const stage = join(base, 'bundle');
    await mkdir(stage, { recursive: true });
    await cp(join(CACHE, 'skills'), join(stage, 'skills'), { recursive: true });
    if (await exists(join(CACHE, 'toolkit'))) {
      await cp(join(CACHE, 'toolkit'), join(stage, 'toolkit'), { recursive: true });
    }
    archivePath = join(base, 'easybi-0.1.1.tar.gz');
    await tarCreate({ gzip: true, cwd: base, file: archivePath }, ['bundle']);
  }
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

maybe('LocalArchiveSource (.tar.gz)', () => {
  it('reports healthy and lists the bundle version from the archive', async () => {
    const src = new LocalArchiveSource(archivePath);
    const health = await src.healthCheck();
    expect(health.available).toBe(true);
    expect(health.type).toBe('local-archive');
    const versions = await src.listVersions('easybi');
    expect(versions[0]?.version).toBe('0.1.1');
  });

  it('fetches (extract → install) with archive provenance and hashes', async () => {
    const src = new LocalArchiveSource(archivePath);
    const dest = join(base, 'installed');
    const fetched = await src.fetch('easybi', 'current', dest);

    expect(fetched.bundleId).toBe('easybi');
    expect(fetched.version).toBe('0.1.1');
    expect(fetched.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fetched.manifest.source?.type).toBe('local-archive');

    // Installed content present.
    expect(await exists(join(dest, 'skills', 'initialize-report-knowledge', 'SKILL.md'))).toBe(true);
    // On-disk manifest records archive provenance.
    const onDisk = JSON.parse(await readFile(join(dest, 'skills', 'bundle.manifest.json'), 'utf8'));
    expect(onDisk.source.type).toBe('local-archive');
  });

  it('reports unavailable for a missing archive', async () => {
    const src = new LocalArchiveSource(join(base, 'nope.tar.gz'));
    const health = await src.healthCheck();
    expect(health.available).toBe(false);
  });
});
