import { mkdir, writeFile, readFile, copyFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  BootstrapAction,
  BootstrapMode,
  BootstrapResult,
  BundleManifest,
  WorkspaceContract,
} from '@easybi-studio/contracts';
import { WORKSPACE_CLAUDE_MD, defaultWorkspaceManifest } from './templates.js';

/**
 * Idempotent workspace Bootstrapper (plan §9).
 *
 * Drives everything from the installed bundle manifest's workspace_contract:
 * logical paths, templates, empty indexes and bootstrap policy. It never
 * hardcodes deep Skill paths. It creates only what is missing and NEVER
 * overwrites existing user config, knowledge drafts, published versions,
 * report packages or outputs.
 */

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function readManifest(workspaceRoot: string): Promise<BundleManifest | null> {
  const p = join(workspaceRoot, 'skills', 'bundle.manifest.json');
  try {
    return JSON.parse(await readFile(p, 'utf8')) as BundleManifest;
  } catch {
    return null;
  }
}

/** Directory logical keys whose values point at directories (not files). */
const DIRECTORY_PATH_KEYS = new Set([
  'knowledge_scans',
  'knowledge_drafts',
  'knowledge_versions',
  'report_plans',
  'report_packages',
  'output_files',
  'work',
]);

/** Directory keys derived from index file locations (parent dirs). */
function directoriesFromContract(contract: WorkspaceContract): string[] {
  const dirs = new Set<string>();
  for (const [key, rel] of Object.entries(contract.paths)) {
    if (DIRECTORY_PATH_KEYS.has(key)) {
      dirs.add(rel);
    }
  }
  // Ensure standard top-level dirs exist too.
  ['config', 'knowledge', 'reports', 'outputs', 'toolkit', 'work'].forEach((d) => dirs.add(d));
  // Parent dirs of declared index files.
  for (const key of ['knowledge_index', 'reports_index', 'outputs_index']) {
    const rel = contract.paths[key];
    if (rel) dirs.add(dirname(rel));
  }
  return [...dirs].filter((d) => d && d !== '.');
}

export interface BootstrapOptions {
  workspaceRoot: string;
  projectId?: string;
  /** Force a mode; otherwise chosen automatically from workspace.json presence. */
  mode?: BootstrapMode;
  systemId?: string;
  systemName?: string;
}

export async function bootstrapWorkspace(options: BootstrapOptions): Promise<BootstrapResult> {
  const { workspaceRoot } = options;
  const actions: BootstrapAction[] = [];
  const preserved: string[] = [];
  const notes: string[] = [];

  const hasWorkspaceManifest = await isFile(join(workspaceRoot, 'workspace.json'));
  const mode: BootstrapMode = options.mode ?? (hasWorkspaceManifest ? 'check' : 'init');

  const manifest = await readManifest(workspaceRoot);
  if (!manifest) {
    // No installed manifest -> cannot bootstrap; the caller (Skill Manager) must
    // install a bundle first, or perform compat backfill for a legacy workspace.
    return {
      workspaceRoot,
      mode,
      alreadyReady: false,
      actions,
      preserved,
      notes: ['缺少 skills/bundle.manifest.json，无法自动初始化；需先安装 Bundle 或进行兼容补齐'],
      ok: false,
      ...(options.projectId ? { projectId: options.projectId } : {}),
    };
  }

  const contract = manifest.workspace_contract;
  const policy = contract.bootstrap_policy ?? {};

  // 1. workspace.json (never overwrite an existing one).
  const wsManifestPath = join(workspaceRoot, 'workspace.json');
  if (!(await exists(wsManifestPath))) {
    await writeFile(
      wsManifestPath,
      JSON.stringify(defaultWorkspaceManifest(options.systemId, options.systemName), null, 2) + '\n',
      'utf8',
    );
    actions.push({ kind: 'create-template', target: 'workspace.json', description: '生成工作区清单' });
  } else {
    preserved.push('workspace.json');
  }

  // 2. Directories from the contract.
  if (policy.create_missing_directories !== false) {
    for (const dir of directoriesFromContract(contract)) {
      const abs = join(workspaceRoot, dir);
      if (!(await exists(abs))) {
        await mkdir(abs, { recursive: true });
        actions.push({ kind: 'create-directory', target: dir, description: '创建缺失目录' });
      }
    }
  }

  // 3. Empty indexes (never overwrite existing).
  if (policy.create_missing_indexes !== false) {
    for (const [rel, content] of Object.entries(contract.empty_indexes ?? {})) {
      const abs = join(workspaceRoot, rel);
      if (!(await exists(abs))) {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, JSON.stringify(content, null, 2) + '\n', 'utf8');
        actions.push({ kind: 'create-index', target: rel, description: '创建空索引' });
      } else {
        preserved.push(rel);
      }
    }
  }

  // 4. Templates (config/easy-bi.json, toolkit/config/runtime.json). Never overwrite.
  if (policy.create_missing_templates !== false) {
    for (const [name, tpl] of Object.entries(contract.templates ?? {})) {
      if (name === 'workspace_manifest') {
        // Already handled above (workspace.json).
        continue;
      }
      const targetAbs = join(workspaceRoot, tpl.target);
      const sourceAbs = join(workspaceRoot, tpl.source);
      if (await exists(targetAbs)) {
        preserved.push(tpl.target);
        continue;
      }
      if (await isFile(sourceAbs)) {
        await mkdir(dirname(targetAbs), { recursive: true });
        await copyFile(sourceAbs, targetAbs);
        actions.push({
          kind: 'create-template',
          target: tpl.target,
          description: `从模板生成 ${tpl.target}`,
        });
      } else {
        notes.push(`模板来源缺失，跳过：${tpl.source}`);
      }
    }
  }

  // 5. Workspace CLAUDE.md (never overwrite).
  const claudePath = join(workspaceRoot, 'CLAUDE.md');
  if (!(await exists(claudePath))) {
    await writeFile(claudePath, WORKSPACE_CLAUDE_MD, 'utf8');
    actions.push({ kind: 'create-template', target: 'CLAUDE.md', description: '生成工作区 CLAUDE.md' });
  } else {
    preserved.push('CLAUDE.md');
  }

  const alreadyReady = actions.length === 0;
  if (alreadyReady) notes.push('工作区已就绪，无需修改');

  return {
    workspaceRoot,
    mode,
    alreadyReady,
    actions,
    preserved,
    bundleVersion: manifest.bundle_version,
    notes,
    nextStep: 'BUILD_CONFIG',
    ok: true,
    ...(options.projectId ? { projectId: options.projectId } : {}),
  };
}
