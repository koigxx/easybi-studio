import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, mkdir, cp, readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { c as tarCreate } from 'tar';
import { HttpRegistrySource } from './sources/http-registry.js';

/**
 * HttpRegistrySource downloads an immutable archive from a registry and installs
 * it via the shared archive path. We stand up a tiny local HTTP server that
 * serves the three registry endpoints from the synced cache — no real cloud.
 */
const CACHE = join(homedir(), '.easybi-studio', 'skill-cache', 'easybi', '0.1.1');
const available = existsSync(join(CACHE, 'skills', 'bundle.manifest.json'));
const maybe = available ? describe : describe.skip;

let base: string;
let archivePath: string;
let manifestJson: string;
let server: Server;
let baseUrl: string;
let sawAuthHeader: string | undefined;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'easybi-reg-'));
  if (available) {
    const stage = join(base, 'bundle');
    await mkdir(stage, { recursive: true });
    await cp(join(CACHE, 'skills'), join(stage, 'skills'), { recursive: true });
    if (await exists(join(CACHE, 'toolkit'))) {
      await cp(join(CACHE, 'toolkit'), join(stage, 'toolkit'), { recursive: true });
    }
    archivePath = join(base, 'easybi-0.1.1.tar.gz');
    await tarCreate({ gzip: true, cwd: base, file: archivePath }, ['bundle']);
    manifestJson = await readFile(join(CACHE, 'skills', 'bundle.manifest.json'), 'utf8');
  }

  server = createServer((req, res) => {
    sawAuthHeader = req.headers['authorization'] as string | undefined;
    const url = req.url ?? '';
    if (url.endsWith('/versions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ versions: [{ version: '0.1.1' }] }));
    } else if (url.endsWith('/manifest')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(manifestJson);
    } else if (url.endsWith('/archive')) {
      readFile(archivePath).then((buf) => {
        res.writeHead(200, { 'content-type': 'application/gzip' });
        res.end(buf);
      });
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}/easybi`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(base, { recursive: true, force: true });
});

maybe('HttpRegistrySource (download → extract → install)', () => {
  it('lists versions and reads the manifest over HTTP', async () => {
    const src = new HttpRegistrySource({ baseUrl });
    const versions = await src.listVersions('easybi');
    expect(versions[0]?.version).toBe('0.1.1');
    const manifest = await src.getManifest('easybi', '0.1.1');
    expect(manifest.bundle_id).toBe('easybi');
  });

  it('fetches the archive and installs with registry provenance', async () => {
    const src = new HttpRegistrySource({ baseUrl, authTokenEnv: 'EASYBI_TEST_TOKEN' });
    process.env.EASYBI_TEST_TOKEN = 'secret-token-value';
    try {
      const dest = join(base, 'installed');
      const fetched = await src.fetch('easybi', 'current', dest);

      expect(fetched.version).toBe('0.1.1');
      expect(fetched.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(fetched.manifest.source?.type).toBe('http-registry');
      expect(await exists(join(dest, 'skills', 'initialize-report-knowledge', 'SKILL.md'))).toBe(
        true,
      );

      // Auth header was sent; token value is never written into the manifest.
      expect(sawAuthHeader).toBe('Bearer secret-token-value');
      const onDisk = await readFile(join(dest, 'skills', 'bundle.manifest.json'), 'utf8');
      expect(onDisk).not.toContain('secret-token-value');
      expect(JSON.parse(onDisk).source.type).toBe('http-registry');

      // Forbidden content still excluded (whitelist reused via archive path).
      const initDir = await readdir(join(dest, 'skills', 'initialize-report-knowledge'));
      expect(initDir).not.toContain('node_modules');
    } finally {
      delete process.env.EASYBI_TEST_TOKEN;
    }
  });
});
