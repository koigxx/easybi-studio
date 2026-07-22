/** Checkpoint / diff / rollback contracts (plan §10.10, §12.4). */

export interface CheckpointFileEntry {
  /** Workspace-relative path. */
  path: string;
  sha256: string;
  size: number;
  /** True when a recoverable copy of the content was stored. */
  hasBackup: boolean;
}

export interface Checkpoint {
  id: string;
  projectId: string;
  jobId?: string;
  createdAt: string;
  /** Managed files captured at checkpoint time. */
  files: CheckpointFileEntry[];
  /** Directories excluded from management (e.g. node_modules, work). */
  excludedDirectories: string[];
  /** Bundle + config version fingerprint at checkpoint time. */
  bundleVersion?: string;
}

export interface ChangeSummary {
  checkpointId: string;
  jobId?: string;
  addedFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
  unchangedFiles: string[];
  binaryArtifacts: string[];
}

export interface FileDiff {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
  /** Unified text diff when both sides are text; absent for binary. */
  unifiedDiff?: string;
  binary: boolean;
}

export interface RollbackResult {
  checkpointId: string;
  restored: string[];
  /** Files that could not be rolled back due to a post-task conflict. */
  conflicted: string[];
  ok: boolean;
}
