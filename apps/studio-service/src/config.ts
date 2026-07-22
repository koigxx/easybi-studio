import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { SkillSourceType } from '@easybi-studio/contracts';

/**
 * Studio runtime configuration resolved from environment with safe defaults.
 * Secrets are never stored here.
 */
export interface StudioConfig {
  host: string;
  port: number;
  /** Absolute allowed workspace root (test workspaces live here). */
  workspacesRoot: string;
  /** Studio data directory (SQLite, caches). */
  dataDir: string;
  /** SQLite database file path. */
  dbFile: string;
  /** Skill source type: local-directory (default) | local-archive | http-registry. */
  skillSourceType: SkillSourceType;
  /**
   * Skill source location:
   *  - local-directory: a directory path
   *  - local-archive: a .tar.gz archive path
   *  - http-registry: the registry base URL (e.g. https://registry/easybi)
   */
  skillSourceDir: string;
  /** For http-registry: env var name holding a bearer token (value never persisted). */
  skillSourceAuthTokenEnv?: string;
}

/**
 * Single-repo layout: Skill bundles live INSIDE this repo under
 * `easybi-studio/skill-source/<bundle>/` — currently `skill-source/easy-bi/`
 * (contains skills/ + toolkit/). The `skill-source/` folder is a container so more
 * bundles can be added later; the active bundle's directory is the source. `git
 * clone` of this one repo brings the skill bundle along. Test workspaces are
 * created in a sibling `easybi-studio-workspaces/` NEXT TO the repo (outside it),
 * so they never pollute the repo and are trivially excluded from git.
 *
 * Both defaults are derived RELATIVE to this file — clone the repo anywhere and it
 * just works, no env vars. This module lives at
 * `easybi-studio/apps/studio-service/{src|dist}/config.*`, i.e. 3 levels below the
 * `easybi-studio/` root in both source and compiled output, so the hop count is
 * identical whether run via tsx (src) or node (dist).
 *
 * Every path stays overridable via env (EASYBI_STUDIO_WORKSPACES_ROOT /
 * EASYBI_SKILL_SOURCE_DIR) for packaged/registry deployments.
 */
const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKSPACE_PARENT = dirname(STUDIO_ROOT);
const DEFAULT_WORKSPACES_ROOT = join(WORKSPACE_PARENT, 'easybi-studio-workspaces');
const DEFAULT_SKILL_SOURCE = join(STUDIO_ROOT, 'skill-source', 'easy-bi');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): StudioConfig {
  const dataDir = env.EASYBI_STUDIO_DATA_DIR ?? join(homedir(), '.easybi-studio');
  const rawType = env.EASYBI_SKILL_SOURCE_TYPE ?? 'local-directory';
  const skillSourceType: SkillSourceType =
    rawType === 'local-archive'
      ? 'local-archive'
      : rawType === 'http-registry'
        ? 'http-registry'
        : 'local-directory';
  return {
    host: env.EASYBI_STUDIO_HOST ?? '127.0.0.1',
    port: Number(env.EASYBI_STUDIO_PORT ?? 8932),
    workspacesRoot: env.EASYBI_STUDIO_WORKSPACES_ROOT ?? DEFAULT_WORKSPACES_ROOT,
    dataDir,
    dbFile: env.EASYBI_STUDIO_DB_FILE ?? join(dataDir, 'studio.db'),
    skillSourceType,
    // For http-registry, EASYBI_SKILL_SOURCE_DIR holds the registry base URL.
    skillSourceDir: env.EASYBI_SKILL_SOURCE_DIR ?? DEFAULT_SKILL_SOURCE,
    ...(env.EASYBI_SKILL_SOURCE_AUTH_TOKEN_ENV
      ? { skillSourceAuthTokenEnv: env.EASYBI_SKILL_SOURCE_AUTH_TOKEN_ENV }
      : {}),
  };
}
