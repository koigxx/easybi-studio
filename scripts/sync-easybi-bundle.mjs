#!/usr/bin/env node
/**
 * sync-easybi-bundle.mjs (plan §8.6)
 *
 * Snapshots the whitelisted Easy BI bundle from the canonical source into the
 * product's immutable cache and refreshes vendor/easybi-bundle atomically.
 * Validates the current manifest and file hashes. Never writes to the canonical
 * source; never auto-copies into existing workspaces.
 *
 * Usage:
 *   node scripts/sync-easybi-bundle.mjs [--source <skill-source-dir>]
 * Default source is the in-repo skill-source/ directory (skills/ + toolkit/).
 */
import { cp, rm, mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { LocalDirectorySource } from '../packages/skill-bundle-source/dist/index.js';
import { SkillVersionCache } from '../packages/skill-bundle-manager/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRODUCT_ROOT = join(__dirname, '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (key) args[key] = argv[i + 1];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceDir = args.source ?? join(PRODUCT_ROOT, 'skill-source', 'easy-bi');
  const cacheRoot = args['cache-root'] ?? join(homedir(), '.easybi-studio', 'skill-cache');

  const source = new LocalDirectorySource(sourceDir);
  const health = await source.healthCheck();
  if (!health.available) {
    console.error(`来源不可用：${health.note}`);
    process.exit(1);
  }

  const cache = new SkillVersionCache(cacheRoot);
  // fetchAndCache runs manifest validation, whitelist copy, and SHA-256.
  const entry = await cache.fetchAndCache(source, 'easybi', 'current');

  // Atomically refresh vendor/easybi-bundle from the immutable cache version.
  const vendorDir = join(PRODUCT_ROOT, 'vendor', 'easybi-bundle');
  const tmp = `${vendorDir}.tmp-${process.pid}-${Date.now()}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(dirname(vendorDir), { recursive: true });
  await cp(entry.path, tmp, { recursive: true });
  await rm(vendorDir, { recursive: true, force: true });
  await rename(tmp, vendorDir);

  console.log(
    JSON.stringify(
      {
        bundleId: entry.bundleId,
        version: entry.version,
        bundleSha256: entry.bundleSha256,
        cacheReused: entry.reused,
        cachePath: entry.path,
        vendorPath: vendorDir,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
