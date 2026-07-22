/** Workspace bootstrap contracts (plan §9, §12.1.1). */

export type BootstrapMode = 'init' | 'check' | 'upgrade';

export interface BootstrapAction {
  /** e.g. 'create-directory', 'create-index', 'create-template', 'fill-default', 'compat-manifest'. */
  kind: string;
  /** Workspace-relative target path. */
  target: string;
  /** Chinese human-readable description of what was done. */
  description: string;
}

export interface BootstrapResult {
  projectId?: string;
  workspaceRoot: string;
  mode: BootstrapMode;
  /** True when the workspace was already ready and nothing had to change. */
  alreadyReady: boolean;
  /** Actions Studio performed automatically (create dirs/indexes/templates/defaults). */
  actions: BootstrapAction[];
  /** Files explicitly preserved (never overwritten). */
  preserved: string[];
  bundleVersion?: string;
  /** Doctor / structure check results (Chinese notes). */
  notes: string[];
  /** Next suggested step for the guided flow. */
  nextStep?: string;
  ok: boolean;
}
