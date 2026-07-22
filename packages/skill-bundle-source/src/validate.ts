import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BundleManifest } from '@easybi-studio/contracts';

export class BundleValidationError extends Error {
  readonly code = 'BUNDLE_VALIDATION_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'BundleValidationError';
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

/** Validate the structural shape of a source manifest (plan §8.1.2, §12). */
export function validateManifestShape(manifest: BundleManifest): void {
  if (!manifest.bundle_id) throw new BundleValidationError('Manifest 缺少 bundle_id');
  if (!manifest.bundle_version) throw new BundleValidationError('Manifest 缺少 bundle_version');
  if (!manifest.compatibility) throw new BundleValidationError('Manifest 缺少 compatibility');
  if (!Array.isArray(manifest.skills) || manifest.skills.length === 0) {
    throw new BundleValidationError('Manifest 未声明任何 Skill');
  }
  for (const skill of manifest.skills) {
    if (!skill.id || !skill.path || !skill.agent_entry) {
      throw new BundleValidationError(`Skill 声明不完整：${skill.id ?? '(未知)'}`);
    }
  }
  if (!manifest.workspace_contract?.paths) {
    throw new BundleValidationError('Manifest 缺少 workspace_contract.paths');
  }
  if (!manifest.contracts?.directory_compatibility) {
    throw new BundleValidationError('Manifest 缺少目录兼容规范引用');
  }
}

/**
 * Verify the required Skill entries physically exist under the source directory:
 * SKILL.md (agent_entry), compiled CLIs, dependency lock, and bootstrap script.
 */
export async function validateSourceEntries(
  sourceDir: string,
  manifest: BundleManifest,
): Promise<void> {
  const skillsDir = join(sourceDir, 'skills');
  for (const skill of manifest.skills) {
    const agentEntry = join(skillsDir, skill.agent_entry);
    if (!(await fileExists(agentEntry))) {
      throw new BundleValidationError(`缺少 Skill 入口：${skill.agent_entry}`);
    }
    for (const [name, rel] of Object.entries(skill.commands)) {
      const abs = join(skillsDir, rel);
      if (!(await fileExists(abs))) {
        throw new BundleValidationError(`Skill ${skill.id} 命令 ${name} 缺少文件：${rel}`);
      }
    }
    const shrinkwrap = join(skillsDir, skill.path, 'npm-shrinkwrap.json');
    if (!(await fileExists(shrinkwrap))) {
      throw new BundleValidationError(`Skill ${skill.id} 缺少 npm-shrinkwrap.json`);
    }
  }

  // Compatibility contract file must exist under skills/.
  const contractPath = join(skillsDir, manifest.contracts.directory_compatibility);
  if (!(await fileExists(contractPath))) {
    throw new BundleValidationError(
      `缺少目录兼容规范：${manifest.contracts.directory_compatibility}`,
    );
  }
}
