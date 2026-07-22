import type Database from 'better-sqlite3';
import type { ReportTestRecord } from '@easybi-studio/contracts';

interface Row {
  id: string;
  project_id: string;
  report_id: string;
  report_version: string | null;
  test_type: string;
  filters_json: string | null;
  created_at: string;
  row_count: number | null;
  sheet_count: number | null;
  file_bytes: number | null;
  query_ms: number | null;
  total_ms: number | null;
  output_file: string | null;
  ok: number | null;
  error: string | null;
}

function toRecord(r: Row): ReportTestRecord {
  const rec: ReportTestRecord = {
    id: r.id,
    projectId: r.project_id,
    reportId: r.report_id,
    testType: r.test_type as ReportTestRecord['testType'],
    createdAt: r.created_at,
    ok: r.ok === 1,
  };
  if (r.report_version) rec.reportVersion = r.report_version;
  if (r.filters_json) rec.filters = JSON.parse(r.filters_json) as Record<string, unknown>;
  if (r.row_count !== null) rec.rowCount = r.row_count;
  if (r.sheet_count !== null) rec.sheetCount = r.sheet_count;
  if (r.file_bytes !== null) rec.fileBytes = r.file_bytes;
  if (r.query_ms !== null) rec.queryMs = r.query_ms;
  if (r.total_ms !== null) rec.totalMs = r.total_ms;
  if (r.output_file) rec.outputFile = r.output_file;
  if (r.error) rec.error = r.error;
  return rec;
}

export class ReportTestStore {
  constructor(private readonly db: Database.Database) {}

  insert(rec: ReportTestRecord): void {
    this.db
      .prepare(
        `INSERT INTO report_tests (id, project_id, report_id, report_version, test_type,
          filters_json, created_at, row_count, sheet_count, file_bytes, query_ms, total_ms,
          output_file, ok, error)
         VALUES (@id,@project_id,@report_id,@report_version,@test_type,@filters_json,@created_at,
          @row_count,@sheet_count,@file_bytes,@query_ms,@total_ms,@output_file,@ok,@error)`,
      )
      .run({
        id: rec.id,
        project_id: rec.projectId,
        report_id: rec.reportId,
        report_version: rec.reportVersion ?? null,
        test_type: rec.testType,
        filters_json: rec.filters ? JSON.stringify(rec.filters) : null,
        created_at: rec.createdAt,
        row_count: rec.rowCount ?? null,
        sheet_count: rec.sheetCount ?? null,
        file_bytes: rec.fileBytes ?? null,
        query_ms: rec.queryMs ?? null,
        total_ms: rec.totalMs ?? null,
        output_file: rec.outputFile ?? null,
        ok: rec.ok ? 1 : 0,
        error: rec.error ?? null,
      });
  }

  list(projectId: string): ReportTestRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM report_tests WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as Row[];
    return rows.map(toRecord);
  }

  get(id: string): ReportTestRecord | undefined {
    const row = this.db.prepare('SELECT * FROM report_tests WHERE id = ?').get(id) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }
}
