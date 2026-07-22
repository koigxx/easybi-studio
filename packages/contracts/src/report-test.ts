/** Report test records & type marking (plan §10.12). */

/**
 * Test record types. STATIC_VALIDATION and UNIT_TEST must never be presented as
 * a successful real export.
 */
export type ReportTestType =
  | 'STATIC_VALIDATION'
  | 'UNIT_TEST'
  | 'REAL_SYNC_EXPORT'
  | 'REAL_ASYNC_EXPORT';

export interface ReportTestRecord {
  id: string;
  projectId: string;
  reportId: string;
  reportVersion?: string;
  testType: ReportTestType;
  filters?: Record<string, unknown>;
  createdAt: string;
  rowCount?: number;
  sheetCount?: number;
  fileBytes?: number;
  queryMs?: number;
  totalMs?: number;
  /** Workspace-relative output file (for real exports only). */
  outputFile?: string;
  ok: boolean;
  error?: string;
}

/** Only real export types count as a genuine Excel export. */
export function isRealExport(t: ReportTestType): boolean {
  return t === 'REAL_SYNC_EXPORT' || t === 'REAL_ASYNC_EXPORT';
}
