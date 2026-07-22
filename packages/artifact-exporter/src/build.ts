import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, readdir, cp, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { create as tarCreate } from 'tar';
import type { ArtifactLevel, ArtifactRecord } from '@easybi-studio/contracts';
import { computePrecheck } from './precheck.js';

export class ArtifactBuildError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactBuildError';
  }
}

/** Files/dirs never included in an artifact (secrets/logs/tests/caches). */
const STAGE_EXCLUDE = /(?:^|[\\/])(?:node_modules|work|\.checkpoints|tests|dist[\\/]tests)(?:[\\/]|$)|\.log$|\.DS_Store$/;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function copyTree(src: string, dest: string): Promise<void> {
  if (!(await exists(src))) return;
  await cp(src, dest, {
    recursive: true,
    filter: (s) => !STAGE_EXCLUDE.test(s),
  });
}

/** Redact secret-bearing config into the staged copy (never ship raw secrets). */
async function stageConfig(srcFile: string, destFile: string): Promise<void> {
  if (!(await exists(srcFile))) return;
  const raw = await readFile(srcFile, 'utf8');
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return;
  }
  redactSecretsDeep(obj);
  await mkdir(join(destFile, '..'), { recursive: true });
  await writeFile(destFile, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

const SECRET_KEYS = /^(password|access_key_secret|access_key_id|secret|token|api_key)$/i;
function redactSecretsDeep(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(redactSecretsDeep);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (SECRET_KEYS.test(k) && typeof v === 'string' && v.length > 0) {
        (node as Record<string, unknown>)[k] = '***REDACTED***';
      } else {
        redactSecretsDeep(v);
      }
    }
  }
}

async function listFilesRec(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) out.push(relative(root, abs).split(sep).join('/'));
    }
  }
  await walk(root);
  return out.sort();
}

export interface BuildArtifactOptions {
  workspaceRoot: string;
  projectId: string;
  level: ArtifactLevel;
  version: string;
  knowledgeVersion?: string;
  reportVersions?: Record<string, string>;
  /** Provide a deterministic timestamp (scripts pass this; avoids Date in libs). */
  now: string;
}

/**
 * Build a development test artifact (plan §10.6, §10.14). Refuses non-development
 * levels and duplicate versions. Stages a redacted, whitelisted copy, writes a
 * checksum manifest, and packs a tar.gz under outputs/artifacts.
 */
export async function buildArtifact(options: BuildArtifactOptions): Promise<ArtifactRecord> {
  const { workspaceRoot, projectId, level, version, now } = options;

  if (level !== 'development') {
    throw new ArtifactBuildError('LEVEL_NOT_BUILDABLE', `第一版仅支持构建 development 制品，收到 ${level}`);
  }

  const precheck = await computePrecheck(workspaceRoot, 'development');
  if (!precheck.buildable) {
    throw new ArtifactBuildError('PRECHECK_FAILED', `预检未通过，缺失：${precheck.missing.join('、')}`);
  }

  const artifactsDir = join(workspaceRoot, 'outputs', 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  const tarName = `easybi-${level}-${version}.tar.gz`;
  const tarPath = join(artifactsDir, tarName);
  if (await exists(tarPath)) {
    throw new ArtifactBuildError('VERSION_EXISTS', `制品版本已存在，不覆盖：${tarName}`);
  }

  // Stage into a temp dir.
  const stageRoot = join(workspaceRoot, 'work', `artifact-stage-${version}`);
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageRoot, { recursive: true });

  await stageConfig(join(workspaceRoot, 'config', 'easy-bi.json'), join(stageRoot, 'config', 'easy-bi.json'));
  await stageConfig(
    join(workspaceRoot, 'toolkit', 'config', 'runtime.json'),
    join(stageRoot, 'toolkit', 'config', 'runtime.json'),
  );
  await copyTree(join(workspaceRoot, 'knowledge', 'versions'), join(stageRoot, 'knowledge', 'versions'));
  await copyTree(join(workspaceRoot, 'knowledge', 'drafts'), join(stageRoot, 'knowledge', 'drafts'));
  await copyTree(join(workspaceRoot, 'reports', 'packages'), join(stageRoot, 'reports', 'packages'));
  await copyTree(join(workspaceRoot, 'skills'), join(stageRoot, 'skills'));

  // Artifact metadata + checksum manifest.
  const meta = {
    artifact_format_version: '1',
    level,
    version,
    development_only: precheck.developmentOnly,
    project_id: projectId,
    knowledge_version: options.knowledgeVersion ?? null,
    report_versions: options.reportVersions ?? {},
    generated_at: now,
  };
  await writeFile(join(stageRoot, 'artifact.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');

  const files = await listFilesRec(stageRoot);
  const checksumLines: string[] = [];
  for (const rel of files) {
    const buf = await readFile(join(stageRoot, rel));
    checksumLines.push(`${createHash('sha256').update(buf).digest('hex')}  ${rel}`);
  }
  await writeFile(join(stageRoot, 'checksums.sha256'), checksumLines.join('\n') + '\n', 'utf8');

  // Pack tar.gz.
  await tarCreate({ gzip: true, cwd: stageRoot, file: tarPath }, ['.']);
  await rm(stageRoot, { recursive: true, force: true });

  const tarBuf = await readFile(tarPath);
  const sha256 = createHash('sha256').update(tarBuf).digest('hex');

  return {
    id: `art_${version}_${now.replace(/[^0-9]/g, '').slice(0, 14)}`,
    projectId,
    level,
    developmentOnly: precheck.developmentOnly,
    createdAt: now,
    file: relative(workspaceRoot, tarPath).split(sep).join('/'),
    sha256,
    sizeBytes: tarBuf.length,
    ...(options.knowledgeVersion ? { knowledgeVersion: options.knowledgeVersion } : {}),
    ...(options.reportVersions ? { reportVersions: options.reportVersions } : {}),
  };
}
