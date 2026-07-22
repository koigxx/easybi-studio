#!/usr/bin/env node
/**
 * create-test-workspace.mjs (plan §9.1)
 *
 * Creates or opens an external test workspace using the built product packages:
 *   source -> immutable version cache -> independent workspace install -> lock -> bootstrap
 *
 * Usage:
 *   node scripts/create-test-workspace.mjs --id transport-test --name "运输测试"
 *   [--root <workspaces-dir>] [--bundle-source local-directory] [--bundle-path <skill-source-dir>]
 *
 * Defaults (single-repo layout): --bundle-path = in-repo skill-source/,
 * --root = sibling easybi-studio-workspaces/ next to the repo.
 * Never writes to the canonical Skill source. Refuses to overwrite an
 * already-installed workspace as a brand-new create.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { LocalDirectorySource } from '../packages/skill-bundle-source/dist/index.js';
import { SkillVersionCache } from '../packages/skill-bundle-manager/dist/index.js';
import {
  createOrOpenWorkspace,
  workspaceAlreadyInstalled,
} from '../packages/workspace-bootstrapper/dist/index.js';

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
  const id = args.id;
  const name = args.name ?? id;
  const root = args.root ?? join(PRODUCT_ROOT, '..', 'easybi-studio-workspaces');
  const bundleSource = args['bundle-source'] ?? 'local-directory';
  const bundlePath = args['bundle-path'] ?? join(PRODUCT_ROOT, 'skill-source', 'easy-bi');

  if (!id) {
    console.error('缺少 --id');
    process.exit(1);
  }
  if (bundleSource !== 'local-directory') {
    console.error(`第一版仅支持 local-directory 来源，收到：${bundleSource}`);
    process.exit(1);
  }

  const workspaceRoot = join(root, id);
  const cacheRoot = args['cache-root'] ?? join(homedir(), '.easybi-studio', 'skill-cache');

  const source = new LocalDirectorySource(bundlePath);
  const cache = new SkillVersionCache(cacheRoot);

  const health = await source.healthCheck();
  if (!health.available) {
    console.error(`Skill 来源不可用：${health.note}`);
    process.exit(1);
  }

  const already = await workspaceAlreadyInstalled(workspaceRoot);
  if (already) {
    console.log(`工作区已安装，执行打开检查（check）：${workspaceRoot}`);
  }

  const result = await createOrOpenWorkspace({
    workspaceRoot,
    source,
    cache,
    bundleId: 'easybi',
    projectId: id,
    systemId: id,
    systemName: name,
  });

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        bundleVersion: result.bundleVersion,
        bundleSha256: result.bundleSha256,
        cacheReused: result.cacheReused,
        installed: result.installed,
        mode: result.bootstrap.mode,
        alreadyReady: result.bootstrap.alreadyReady,
        actions: result.bootstrap.actions,
        preserved: result.bootstrap.preserved,
        nextStep: result.bootstrap.nextStep,
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
