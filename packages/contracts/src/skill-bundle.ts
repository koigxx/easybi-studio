/**
 * Skill bundle source, manifest, and lock contracts (plan §8.1.3, §12.1.1).
 *
 * All Skill acquisition goes through SkillBundleSource. Business code must not
 * depend on a concrete source's private types. Paths are resolved through the
 * Bundle Manifest's logical path map — never hardcoded deep Skill directories.
 */

import type { SkillSourceType } from './project.js';

export interface SkillSourceHealth {
  type: SkillSourceType;
  available: boolean;
  /** Chinese human-readable note (secret-free; no tokens). */
  note?: string;
  /** For local-directory: the resolved source location. */
  location?: string;
}

export interface SkillBundleVersion {
  bundleId: string;
  version: string;
}

/** Machine-readable bundle manifest (mirrors easy-bi skills/bundle.manifest.json). */
export interface BundleManifest {
  bundle_format_version: string;
  bundle_id: string;
  bundle_version: string;
  display_name?: string;
  compatibility: {
    workspace_formats: string[];
    config_formats: string[];
    catalog_formats: string[];
    report_plan_formats?: string[];
    report_package_formats: string[];
    runtime_config_formats?: string[];
    runtime_api_versions: string[];
  };
  skills: BundleSkillEntry[];
  workspace_contract: WorkspaceContract;
  distribution: {
    supported_source_types: SkillSourceType[];
    immutable_versions: boolean;
    verify_file_hashes: boolean;
    silent_workspace_upgrade: boolean;
  };
  contracts: {
    directory_compatibility: string;
  };
  /** Present in product/workspace snapshots: source provenance. */
  source?: {
    type: SkillSourceType;
    location?: string;
  };
  /** Present in product/workspace snapshots: generation time. */
  generated_at?: string;
  /** Present in product/workspace snapshots: per-file SHA-256 list. */
  files?: BundleFileHash[];
}

export interface BundleSkillEntry {
  id: string;
  version: string;
  path: string;
  agent_entry: string;
  /** Optional bundle-relative path to the skill's preset-prompts file (prompts.json). */
  agent_prompts?: string;
  /** Optional bundle-relative path to the skill's config help file (config-help.json). */
  config_help?: string;
  commands: Record<string, string>;
}

export interface WorkspaceContract {
  bootstrap_contract_version: string;
  supported_modes: string[];
  path_bases: Record<string, string>;
  /** Logical path key -> workspace-relative path. */
  paths: Record<string, string>;
  templates: Record<string, { source: string; target: string }>;
  empty_indexes: Record<string, unknown>;
  bootstrap_policy: Record<string, boolean>;
}

export interface BundleFileHash {
  path: string;
  sha256: string;
}

/** Result of fetching a bundle into a destination directory. */
export interface FetchedBundle {
  bundleId: string;
  version: string;
  /** Directory the bundle was materialized into. */
  destination: string;
  manifest: BundleManifest;
  /** Aggregate SHA-256 over the ordered file hash list. */
  bundleSha256: string;
}

/** The provider-agnostic source every Skill origin must implement (plan §8.1.3). */
export interface SkillBundleSource {
  readonly type: SkillSourceType;
  healthCheck(): Promise<SkillSourceHealth>;
  listVersions(bundleId: string): Promise<SkillBundleVersion[]>;
  getManifest(bundleId: string, version: string): Promise<BundleManifest>;
  fetch(bundleId: string, version: string, destination: string): Promise<FetchedBundle>;
}

/** Workspace install lock (plan §8.1.3). Never stores secrets/tokens. */
export interface BundleLock {
  lock_format_version: string;
  bundle_id: string;
  bundle_version: string;
  bundle_sha256: string;
  source_type: SkillSourceType;
  installed_manifest: string;
  installed_at: string;
  /** Concurrency-control revision (sha256). */
  revision: string;
}
