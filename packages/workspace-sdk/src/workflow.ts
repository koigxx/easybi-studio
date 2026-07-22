import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectStage } from '@easybi-studio/contracts';
import { normalizeAbsolute } from './paths.js';

/**
 * Guided-flow state computed from DISK FACTS (plan §10.8).
 *
 * State must be derived from config, indexes, manifest and validation results —
 * never from Studio SQLite button-click history.
 */

export interface WorkflowStep {
  stage: ProjectStage;
  /** Whether this step is satisfied. */
  done: boolean;
  /** Chinese label. */
  label: string;
  /** Chinese blocking reason when not done. */
  blockedReason?: string;
}

export interface WorkflowState {
  /** The furthest satisfied stage / current position. */
  current: ProjectStage;
  /** Human-readable Chinese label for `current`. */
  currentLabel: string;
  steps: WorkflowStep[];
  /** Suggested next action (Chinese). */
  nextAction: string;
}

/** Chinese labels for every project stage (single source of truth for the UI). */
export const STAGE_LABELS: Record<ProjectStage, string> = {
  WORKSPACE_READY: '工作区就绪',
  BUILD_CONFIG_READY: '配置就绪',
  KNOWLEDGE_MISSING: '待初始化知识库',
  KNOWLEDGE_DRAFT: '知识库草稿待审阅',
  KNOWLEDGE_REVIEW_REQUIRED: '知识库待审阅',
  KNOWLEDGE_PUBLISHED: '知识库已发布',
  REPORT_REQUIREMENT_READY: '待生成报表包',
  REPORT_PLAN_WAITING_APPROVAL: '报表计划待批准',
  REPORT_PACKAGE_READY: '报表包已生成',
  RUNTIME_TEST_REQUIRED: '待运行真实导出测试',
  RUNTIME_TEST_PASSED: '导出测试通过',
  TEST_ARTIFACT_READY: '测试制品就绪',
};

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

type Json = Record<string, unknown>;

async function readJson(p: string): Promise<Json | null> {
  try {
    const v = JSON.parse(await readFile(p, 'utf8')) as unknown;
    return typeof v === 'object' && v !== null ? (v as Json) : null;
  } catch {
    return null;
  }
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function getObj(v: Json | null, key: string): Json | null {
  const inner = v?.[key];
  return typeof inner === 'object' && inner !== null ? (inner as Json) : null;
}

async function countDirEntries(p: string): Promise<number> {
  try {
    return (await readdir(p)).length;
  } catch {
    return 0;
  }
}

export async function computeWorkflowState(workspaceRoot: string): Promise<WorkflowState> {
  const root = normalizeAbsolute(workspaceRoot);

  const hasManifest = await exists(join(root, 'skills', 'bundle.manifest.json'));
  const hasLock = await exists(join(root, 'skills', 'bundle.lock.json'));
  const workspaceReady = hasManifest && hasLock;

  // Build config readiness: config exists and has at least one db profile + a report requirement.
  const buildCfg = await readJson(join(root, 'config', 'easy-bi.json'));
  const connections = getObj(buildCfg, 'connections');
  const knowledgeCfg = getObj(buildCfg, 'knowledge');
  const dbProfiles = asArray(connections?.['database_profiles']);
  const reportReqs = knowledgeCfg?.['report_requirements'];
  const buildConfigReady = dbProfiles.length > 0 && Array.isArray(reportReqs);

  // Knowledge state.
  const knowledgeIndex = await readJson(join(root, 'knowledge', 'index.json'));
  const publishedVersions = asArray(knowledgeIndex?.['versions']).length;
  const draftCount = await countDirEntries(join(root, 'knowledge', 'drafts'));
  const knowledgePublished = publishedVersions > 0;
  const knowledgeDraft = draftCount > 0;

  // Report state.
  const reportsIndex = await readJson(join(root, 'reports', 'index.json'));
  const reportCount = asArray(reportsIndex?.['reports']).length;
  const reportPackageReady = reportCount > 0;

  const steps: WorkflowStep[] = [];
  const step = (
    stage: ProjectStage,
    done: boolean,
    label: string,
    blockedReason?: string,
  ): void => {
    steps.push(blockedReason && !done ? { stage, done, label, blockedReason } : { stage, done, label });
  };

  step('WORKSPACE_READY', workspaceReady, '工作区已适配 Skill', '缺少 Manifest 或 Lock');
  step('BUILD_CONFIG_READY', buildConfigReady, '完成构建配置', '需配置数据库连接和预期报表');
  step(
    'KNOWLEDGE_PUBLISHED',
    knowledgePublished,
    '发布知识库',
    knowledgeDraft ? '知识库仍为草稿，需完成审阅后发布' : '尚未生成知识库草稿',
  );
  step('REPORT_PACKAGE_READY', reportPackageReady, '生成报表包', '尚未生成报表包');

  // Determine current position.
  let current: ProjectStage = 'WORKSPACE_READY';
  let nextAction = '打开或新建工作区并自动适配 Skill';
  if (!workspaceReady) {
    current = 'WORKSPACE_READY';
    nextAction = '完成工作区 Skill 适配（Bootstrap）';
  } else if (!buildConfigReady) {
    current = 'BUILD_CONFIG_READY';
    nextAction = '在配置页填写数据库连接与预期报表';
  } else if (!knowledgePublished) {
    current = knowledgeDraft ? 'KNOWLEDGE_DRAFT' : 'KNOWLEDGE_MISSING';
    nextAction = knowledgeDraft ? '完成知识库审阅并发布' : '通过 Claude 初始化知识库';
  } else if (!reportPackageReady) {
    current = 'REPORT_REQUIREMENT_READY';
    nextAction = '创建并批准报表计划，生成报表包';
  } else {
    current = 'RUNTIME_TEST_REQUIRED';
    nextAction = '启动 Runtime 并完成真实导出测试';
  }

  return { current, currentLabel: STAGE_LABELS[current], steps, nextAction };
}
