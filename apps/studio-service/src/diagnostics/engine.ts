import { randomUUID } from 'node:crypto';
import { arch, platform } from 'node:os';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import type { DiagnosticItem, DiagnosticRun, DiagnosticStatus } from '@easybi-studio/contracts';
import { readBundleLock } from '@easybi-studio/skill-bundle-manager';
import { LocalDirectorySource } from '@easybi-studio/skill-bundle-source';

/**
 * Environment diagnostics (plan §10.11). Read-only checks that never mutate the
 * canonical source or the workspace. Results are graded PASS/WARNING/FAIL/NOT_CONFIGURED.
 *
 * Stage 3 covers OS/Node, Skill source, Bundle Manifest/Lock, local cache and
 * workspace structure. MySQL / Runtime / OSS deep checks arrive in later stages.
 */

export interface DiagnosticContext {
  skillSourceDir: string;
  cacheRoot: string;
  workspaceRoot?: string;
  claudePath?: string;
  claudeVersion?: string;
}

function worst(items: DiagnosticItem[]): DiagnosticStatus {
  const order: DiagnosticStatus[] = ['FAIL', 'WARNING', 'NOT_CONFIGURED', 'PASS'];
  for (const s of order) {
    if (items.some((i) => i.status === s)) return s;
  }
  return 'PASS';
}

async function isReadable(p: string): Promise<boolean> {
  try {
    await access(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function runDiagnostics(ctx: DiagnosticContext): Promise<DiagnosticRun> {
  const items: DiagnosticItem[] = [];
  const startedAt = new Date().toISOString();

  // OS / arch.
  items.push({
    key: 'os.platform',
    label: '操作系统与架构',
    status: 'PASS',
    message: '已检测运行平台',
    actual: `${platform()} ${arch()}`,
    blocking: false,
  });

  // Node version.
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  items.push({
    key: 'node.version',
    label: 'Node.js 版本',
    status: nodeMajor >= 24 ? 'PASS' : 'FAIL',
    message: nodeMajor >= 24 ? '满足 Node 24 要求' : '需要 Node.js 24 或更高',
    actual: process.versions.node,
    expected: '>=24',
    blocking: nodeMajor < 24,
  });

  // Claude CLI.
  if (ctx.claudePath) {
    items.push({
      key: 'claude.cli',
      label: 'Claude Code 命令',
      status: 'PASS',
      message: '已找到 Claude Code',
      actual: ctx.claudeVersion ? `${ctx.claudePath} (${ctx.claudeVersion})` : ctx.claudePath,
      blocking: false,
    });
  } else {
    items.push({
      key: 'claude.cli',
      label: 'Claude Code 命令',
      status: 'NOT_CONFIGURED',
      message: '未检测到 Claude Code，Agent 能力将不可用（阶段 5 接入）',
      blocking: false,
      suggestion: '安装并登录 Claude Code CLI',
    });
  }

  // Canonical Easy BI source readable + read-only (not written by Studio).
  const sourceReadable = await isReadable(ctx.skillSourceDir);
  const sourceManifest = join(ctx.skillSourceDir, 'skills', 'bundle.manifest.json');
  if (!sourceReadable) {
    items.push({
      key: 'skill.source',
      label: '正式 Easy BI 来源',
      status: 'FAIL',
      message: '来源目录不可读',
      actual: ctx.skillSourceDir,
      blocking: true,
      suggestion: '检查 EASYBI_SKILL_SOURCE_DIR 配置',
    });
  } else {
    const src = new LocalDirectorySource(ctx.skillSourceDir);
    const health = await src.healthCheck();
    items.push({
      key: 'skill.source',
      label: '正式 Easy BI 来源',
      status: health.available ? 'PASS' : 'FAIL',
      message: health.available ? '来源可读且 Manifest 有效（Studio 只读）' : `来源无效：${health.note}`,
      actual: ctx.skillSourceDir,
      link: sourceManifest,
      blocking: !health.available,
    });
  }

  // Local immutable cache.
  const cacheOk = await isDir(ctx.cacheRoot);
  items.push({
    key: 'skill.cache',
    label: '本地版本缓存',
    status: cacheOk ? 'PASS' : 'NOT_CONFIGURED',
    message: cacheOk ? '本地不可变缓存已存在' : '尚未同步任何 Bundle 到本地缓存',
    actual: ctx.cacheRoot,
    blocking: false,
    suggestion: cacheOk ? undefined : '运行 sync-easybi-bundle 或新建工作区',
  });

  // Workspace-scoped checks.
  if (ctx.workspaceRoot) {
    const manifestPath = join(ctx.workspaceRoot, 'skills', 'bundle.manifest.json');
    const hasManifest = await isReadable(manifestPath);
    items.push({
      key: 'workspace.manifest',
      label: '工作区 Bundle Manifest',
      status: hasManifest ? 'PASS' : 'WARNING',
      message: hasManifest ? '已安装 Manifest' : '缺少 Manifest（打开时可兼容补齐）',
      link: manifestPath,
      blocking: false,
    });

    const lock = await readBundleLock(ctx.workspaceRoot);
    items.push({
      key: 'workspace.lock',
      label: '工作区 Bundle Lock',
      status: lock ? 'PASS' : 'WARNING',
      message: lock
        ? `已锁定 ${lock.bundle_id} ${lock.bundle_version}`
        : '缺少 Lock（旧工作区可兼容补齐）',
      actual: lock ? `${lock.bundle_id}@${lock.bundle_version}` : undefined,
      blocking: false,
    });
  }

  return {
    runId: `diag_${randomUUID()}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    items,
    overall: worst(items),
  };
}
