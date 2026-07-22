/** Environment diagnostics contracts (plan §10.11). */

export type DiagnosticStatus = 'PASS' | 'WARNING' | 'FAIL' | 'NOT_CONFIGURED';

export interface DiagnosticItem {
  /** Stable diagnostic key, e.g. 'node.version'. */
  key: string;
  /** Chinese human-readable label. */
  label: string;
  status: DiagnosticStatus;
  /** Chinese explanation. */
  message: string;
  /** Actual detected value (secret-free). */
  actual?: string;
  /** Expected value or range. */
  expected?: string;
  /** Whether this item blocks the current guided step. */
  blocking: boolean;
  /** Suggested remediation (navigation or copyable command only in v1). */
  suggestion?: string;
  /** Related file path or page link. */
  link?: string;
}

export interface DiagnosticRun {
  runId: string;
  projectId?: string;
  startedAt: string;
  finishedAt?: string;
  items: DiagnosticItem[];
  /** Rolled-up worst status across items. */
  overall: DiagnosticStatus;
}
