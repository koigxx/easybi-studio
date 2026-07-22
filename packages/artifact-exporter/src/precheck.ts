import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactLevel, ArtifactPrecheck, ArtifactPrecheckItem } from '@easybi-studio/contracts';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function listDirs(p: string): Promise<string[]> {
  try {
    return (await readdir(p, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Compute an artifact precheck for a level (plan §10.14).
 *
 * First release: only 'development' is buildable. 'candidate' and 'production'
 * report missing gates and remain non-buildable.
 */
export async function computePrecheck(
  workspaceRoot: string,
  level: ArtifactLevel,
): Promise<ArtifactPrecheck> {
  const items: ArtifactPrecheckItem[] = [];
  const missing: string[] = [];

  const hasConfig = await exists(join(workspaceRoot, 'config', 'easy-bi.json'));
  items.push({
    key: 'build-config',
    label: '构建配置存在',
    ok: hasConfig,
    detail: hasConfig ? 'config/easy-bi.json 存在' : '缺少 config/easy-bi.json',
  });
  if (!hasConfig) missing.push('构建配置');

  const publishedVersions = await listDirs(join(workspaceRoot, 'knowledge', 'versions'));

  const reportPkgs = await listDirs(join(workspaceRoot, 'reports', 'packages'));
  items.push({
    key: 'reports',
    label: '存在报表包',
    ok: reportPkgs.length > 0,
    detail: reportPkgs.length > 0 ? `报表包 ${reportPkgs.length} 个` : '尚无报表包',
  });
  if (reportPkgs.length === 0) missing.push('报表包');

  // Knowledge must be published to build any artifact (hard gate).
  const knowledgePublished = publishedVersions.length > 0;
  items.push({
    key: 'published-knowledge',
    label: '知识库已发布',
    ok: knowledgePublished,
    detail: knowledgePublished ? `已发布 ${publishedVersions.length} 个版本` : '需要已发布知识库版本',
  });
  if (!knowledgePublished) missing.push('已发布知识库');

  // development-only when the knowledge is not published.
  const developmentOnly = publishedVersions.length === 0;

  // Candidate/production extra gates (not buildable in v1).
  if (level !== 'development') {
    const hasReal = false; // real sync export result would be required
    items.push({
      key: 'real-sync-export',
      label: '真实同步导出通过',
      ok: hasReal,
      detail: '候选/生产制品需要真实同步导出通过（第一版不支持构建）',
    });
    missing.push('真实导出验收');
    if (level === 'production') missing.push('生产签名与 Secret 初始化');
  }

  const baseReady = hasConfig && reportPkgs.length > 0 && knowledgePublished;
  const buildable = level === 'development' ? baseReady : false;

  return { level, buildable, items, missing, developmentOnly };
}
