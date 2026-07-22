import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BundleManifest } from '@easybi-studio/contracts';
import { normalizeAbsolute, resolveWithinWorkspace } from './paths.js';

/**
 * Workspace/Skill Adapter (plan §7, §17).
 *
 * The single place that resolves Skill commands and logical workspace paths from
 * the installed bundle.manifest.json. Pages and business services must go through
 * this adapter and never hardcode deep Skill directories.
 */
export class WorkspaceSkillAdapter {
  private manifest: BundleManifest | null = null;

  constructor(private readonly workspaceRoot: string) {
    this.workspaceRoot = normalizeAbsolute(workspaceRoot);
  }

  async load(): Promise<BundleManifest> {
    if (this.manifest) return this.manifest;
    const raw = await readFile(
      join(this.workspaceRoot, 'skills', 'bundle.manifest.json'),
      'utf8',
    );
    this.manifest = JSON.parse(raw) as BundleManifest;
    return this.manifest;
  }

  /** Resolve a logical workspace path key (e.g. 'knowledge_index') to an absolute path. */
  async resolveLogicalPath(key: string): Promise<string> {
    const m = await this.load();
    const rel = m.workspace_contract.paths[key];
    if (!rel) throw new Error(`Manifest 未声明逻辑路径：${key}`);
    return resolveWithinWorkspace(this.workspaceRoot, rel);
  }

  /** Resolve a skill command (e.g. skill 'initialize-report-knowledge', cmd 'cli'). */
  async resolveCommand(skillId: string, commandKey: string): Promise<string> {
    const m = await this.load();
    const skill = m.skills.find((s) => s.id === skillId);
    if (!skill) throw new Error(`Manifest 未声明 Skill：${skillId}`);
    const rel = skill.commands[commandKey];
    if (!rel) throw new Error(`Skill ${skillId} 未声明命令：${commandKey}`);
    // Skill commands are relative to the bundle root (skills/).
    return resolveWithinWorkspace(this.workspaceRoot, join('skills', rel));
  }

  /** Resolve the bootstrap-dependencies script for a skill, if declared. */
  async resolveBootstrap(skillId: string): Promise<string | null> {
    const m = await this.load();
    const skill = m.skills.find((s) => s.id === skillId);
    const rel = skill?.commands['bootstrap_dependencies'];
    if (!rel) return null;
    return resolveWithinWorkspace(this.workspaceRoot, join('skills', rel));
  }

  /**
   * Read every installed skill's preset prompts (from each skill's declared
   * `agent_prompts` file). Returns the flattened list of presets, tagged with
   * their source skill. Missing/unreadable files are skipped (the feature is an
   * optional compatible extension; older bundles simply yield no presets).
   */
  async readSkillPromptPresets(): Promise<SkillPromptPreset[]> {
    const m = await this.load();
    const out: SkillPromptPreset[] = [];
    for (const skill of m.skills) {
      if (!skill.agent_prompts) continue;
      try {
        const abs = resolveWithinWorkspace(this.workspaceRoot, join('skills', skill.agent_prompts));
        const raw = await readFile(abs, 'utf8');
        const parsed = JSON.parse(raw) as { presets?: SkillPromptPreset[] };
        for (const p of parsed.presets ?? []) {
          if (p && typeof p.action === 'string' && typeof p.prompt === 'string') {
            out.push({
              action: p.action,
              label: p.label ?? p.action,
              hint: p.hint ?? '',
              write: p.write ?? true,
              prompt: p.prompt,
              skillId: skill.id,
            });
          }
        }
      } catch {
        // Skill declares prompts but file is missing/invalid: skip, don't fail.
      }
    }
    return out;
  }

  /**
   * Read every installed skill's config help (from each skill's declared
   * `config_help` file). Returns the flattened list of config docs, tagged with
   * their source skill. Missing/unreadable files are skipped.
   */
  async readConfigHelp(): Promise<ConfigHelpDoc[]> {
    const m = await this.load();
    const out: ConfigHelpDoc[] = [];
    for (const skill of m.skills) {
      if (!skill.config_help) continue;
      try {
        const abs = resolveWithinWorkspace(this.workspaceRoot, join('skills', skill.config_help));
        const raw = await readFile(abs, 'utf8');
        const parsed = JSON.parse(raw) as { configs?: ConfigHelpDoc[] };
        for (const c of parsed.configs ?? []) {
          if (c && typeof c.target === 'string' && typeof c.title === 'string') {
            out.push({ ...c, skillId: skill.id });
          }
        }
      } catch {
        // Skill declares config help but file is missing/invalid: skip, don't fail.
      }
    }
    return out;
  }

  get root(): string {
    return this.workspaceRoot;
  }
}

/** A preset prompt sourced from a skill's prompts.json. */
export interface SkillPromptPreset {
  action: string;
  label: string;
  hint: string;
  write: boolean;
  prompt: string;
  /** Source skill id (for provenance). */
  skillId?: string;
}

/** One config section's help text. */
export interface ConfigHelpSection {
  key: string;
  label: string;
  desc: string;
}

/** Help for one config file, sourced from a skill's config-help.json. */
export interface ConfigHelpDoc {
  /** Which Studio config editor this maps to: 'build' | 'runtime'. */
  target: string;
  file: string;
  title: string;
  summary: string;
  sections: ConfigHelpSection[];
  skillId?: string;
}
