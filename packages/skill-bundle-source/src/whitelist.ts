/**
 * Skill snapshot whitelist (plan §8.3, §8.4).
 *
 * Only these paths are copied from the canonical Easy BI source into an
 * immutable bundle snapshot. docs, secrets, business artifacts, tests and
 * node_modules are never included.
 */

/** Per-skill runtime whitelist relative to a skill directory (plan §8.3). */
export const SKILL_INCLUDE_PATTERNS: readonly string[] = [
  'SKILL.md',
  '使用说明.md',
  'prompts.json',
  'config-help.json',
  'agents/',
  'assets/',
  'dist/scripts/',
  'npm-shrinkwrap.json',
  'package.json',
  'scripts/bootstrap-dependencies.mjs',
  'references/',
];

/** Explicitly excluded from a skill snapshot (plan §8.3). */
export const SKILL_EXCLUDE_PATTERNS: readonly string[] = [
  'node_modules/',
  'tests/',
  'dist/tests/',
  'tsconfig.json',
  '.log',
  '.DS_Store',
];

/** Bundle-level (skills/) common files that must be included (plan §8.4). */
export const BUNDLE_COMMON_FILES: readonly string[] = [
  'index.json',
  'bundle.manifest.json',
  '目录与项目兼容性规范.md',
];

/** Toolkit files extracted into the bundle (plan §8.4). */
export const TOOLKIT_FILES: readonly string[] = [
  'toolkit/config/runtime.example.json',
  'toolkit/config/runtime.schema.json',
  'toolkit/contracts/统一接口契约.md',
];

/** Paths that must NEVER be copied (plan §8.5). Matched as path prefixes. */
export const FORBIDDEN_PREFIXES: readonly string[] = [
  'docs/',
  'knowledge/scans/',
  'knowledge/drafts/',
  'knowledge/versions/',
  'reports/packages/',
  'reports/plans/',
  'outputs/files/',
  'work/',
  'node_modules/',
];

/** Determine whether a skill-relative path is allowed by the include list. */
export function isSkillFileIncluded(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/');
  // Exclusions win.
  for (const ex of SKILL_EXCLUDE_PATTERNS) {
    if (ex.endsWith('/')) {
      if (norm === ex.slice(0, -1) || norm.startsWith(ex)) return false;
    } else if (ex.startsWith('.')) {
      if (norm.endsWith(ex)) return false;
    } else if (norm === ex) {
      return false;
    }
  }
  for (const inc of SKILL_INCLUDE_PATTERNS) {
    if (inc.endsWith('/')) {
      if (norm === inc.slice(0, -1) || norm.startsWith(inc)) return true;
    } else if (norm === inc) {
      return true;
    }
  }
  return false;
}
