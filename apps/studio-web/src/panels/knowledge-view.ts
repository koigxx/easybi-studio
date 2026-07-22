// Pure helpers for the knowledge catalog view (filtering, field extraction).
import type { CatalogOverview, TableOverview, Tier } from '../api.js';

export const TIER_LABEL: Record<Tier, string> = { hot: '热', warm: '温', cold: '冷' };

/** Flatten all tables across databases. */
export function allTables(overview: CatalogOverview | null): TableOverview[] {
  if (!overview) return [];
  return overview.databases.flatMap((g) => g.tables);
}

export interface TableFilter {
  tiers: Set<Tier>;
  query: string;
  database: string | null; // "profile/database" or null for all
}

export function filterTables(tables: TableOverview[], f: TableFilter): TableOverview[] {
  const q = f.query.trim().toLowerCase();
  return tables.filter((t) => {
    if (!f.tiers.has(t.tier)) return false;
    if (f.database && `${t.profileId}/${t.database}` !== f.database) return false;
    if (q) {
      const hay = `${t.table} ${t.name ?? ''} ${t.comment ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export interface FieldRow {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  comment: string | null;
  semanticName: string | null;
  semanticDescription: string | null;
  reportExposed: boolean;
  filterEnabled: boolean;
  filterRole: string | null;
  defaultOperator: string | null;
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

/** Extract a flat, display-friendly field list from a hot/warm table detail object. */
export function extractFields(data: Record<string, unknown>): FieldRow[] {
  const fields = Array.isArray(data.physical_fields) ? data.physical_fields : [];
  return fields.map((f) => {
    const r = rec(f);
    const p = rec(r.physical);
    const s = rec(r.semantic);
    const flt = rec(r.filter);
    return {
      name: String(p.name ?? ''),
      dataType: String(p.native_type ?? p.data_type ?? ''),
      nullable: Boolean(p.nullable),
      primaryKey: Boolean(p.primary_key),
      comment: (p.comment as string) ?? null,
      semanticName: (s.name as string) ?? null,
      semanticDescription: (s.description as string) ?? null,
      reportExposed: Boolean(s.report_exposed),
      filterEnabled: Boolean(flt.enabled),
      filterRole: (flt.role as string) ?? null,
      defaultOperator: (flt.default_operator as string) ?? null,
    };
  });
}

/** Read the table-level business identity for the detail header. */
export interface TableHeader {
  name: string | null;
  description: string | null;
  domain: string | null;
  comment: string | null;
  estimatedRows: number | null;
  overrideReason: string | null;
  activityNote: string | null;
}

export function extractHeader(data: Record<string, unknown>): TableHeader {
  const business = rec(data.business);
  const cls = rec(data.classification);
  const override = cls.override ? rec(cls.override) : null;
  const activity = rec(data.activity);
  const activityNote =
    activity.status || activity.field
      ? `${activity.status ?? ''}${activity.field ? ` · ${activity.field}` : ''}${
          activity.last_data_at ? ` · 最近 ${activity.last_data_at}` : ''
        }`
      : null;
  return {
    name: (business.name as string) ?? null,
    description: (business.description as string) ?? null,
    domain: (business.domain as string) ?? null,
    comment: (data.comment as string) ?? null,
    estimatedRows: typeof data.estimated_rows === 'number' ? data.estimated_rows : null,
    overrideReason: override ? ((override.reason as string) ?? null) : null,
    activityNote,
  };
}
