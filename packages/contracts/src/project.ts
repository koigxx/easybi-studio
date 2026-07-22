/**
 * Project (registered workspace) contracts.
 *
 * A Project is Studio's registration record pointing at an on-disk workspace.
 * Studio SQLite stores only registration + UI state, never workspace business facts.
 */

/** High-level workflow/state phases computed from disk facts (plan §10.8). */
export type ProjectStage =
  | 'WORKSPACE_READY'
  | 'BUILD_CONFIG_READY'
  | 'KNOWLEDGE_MISSING'
  | 'KNOWLEDGE_DRAFT'
  | 'KNOWLEDGE_REVIEW_REQUIRED'
  | 'KNOWLEDGE_PUBLISHED'
  | 'REPORT_REQUIREMENT_READY'
  | 'REPORT_PLAN_WAITING_APPROVAL'
  | 'REPORT_PACKAGE_READY'
  | 'RUNTIME_TEST_REQUIRED'
  | 'RUNTIME_TEST_PASSED'
  | 'TEST_ARTIFACT_READY';

/** Skill bundle source type (plan §8.1.3). */
export type SkillSourceType = 'local-directory' | 'local-archive' | 'built-in' | 'http-registry';

/** A registered project. */
export interface Project {
  id: string;
  name: string;
  /** Absolute, normalized workspace root path (validated against the allowed root). */
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
  /** Last observed skill source type for this workspace, if known. */
  skillSourceType?: SkillSourceType;
  /** Installed bundle version from bundle.lock.json, if present. */
  bundleVersion?: string;
}

/** Input to register a project (existing directory). */
export interface RegisterProjectInput {
  name: string;
  workspaceRoot: string;
  /** Optional explicit id; generated when omitted. */
  id?: string;
}

/** Read-only structural validation result for a workspace directory. */
export interface WorkspaceStructureCheck {
  workspaceRoot: string;
  exists: boolean;
  isDirectory: boolean;
  /** True when workspace.json is present. */
  hasWorkspaceManifest: boolean;
  /** True when skills/bundle.manifest.json is present. */
  hasBundleManifest: boolean;
  /** True when skills/bundle.lock.json is present. */
  hasBundleLock: boolean;
  /** Presence of each expected top-level logical directory. */
  presentDirectories: string[];
  missingDirectories: string[];
  /** Overall verdict: can this path be registered as a workspace at all. */
  registrable: boolean;
  /** Human-readable notes (Chinese). */
  notes: string[];
}
