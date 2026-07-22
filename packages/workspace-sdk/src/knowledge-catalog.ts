import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAbsolute } from './paths.js';

/**
 * Read-only readers for the knowledge catalog (drafts and published versions).
 *
 * Layout (see references/知识库技术规范.md in the skill bundle):
 *   knowledge/drafts/<draft-id>/           editable draft
 *   knowledge/versions/<semver>/           immutable published version
 *   knowledge/scans/<scan-id>/             raw snapshot
 *   <catalog>/manifest.json
 *   <catalog>/indexes/by-tier.json         { hot:[id], warm:[id], cold:[id] }
 *   <catalog>/indexes/by-field.json        { fields:[{table_id,field,semantic_name,tier}] }
 *   <catalog>/databases/<profile>/<db>/{database.json,hot/tables/*.json,warm/tables/*.json,cold/tables.json}
 *
 * All functions are read-only and never open a database connection.
 */

export type CatalogKind = 'draft' | 'version';
export type Tier = 'hot' | 'warm' | 'cold';

export interface CatalogSummary {
  kind: CatalogKind;
  id: string;
  status: string | null;
  system: { id?: string; name?: string; description?: string } | null;
  counts: { total: number; hot: number; warm: number; cold: number } | null;
  generatedAt: string | null;
  /** True when this version equals knowledge/index.json current_version. */
  isCurrent?: boolean;
}

export interface CatalogList {
  drafts: CatalogSummary[];
  versions: CatalogSummary[];
  currentVersion: string | null;
  /** Newest draft id (drafts sorted ascending), for a sensible default selection. */
  latestDraftId: string | null;
}

/** One compact per-table entry for the overview (no field detail). */
export interface TableOverview {
  tableId: string;
  profileId: string;
  database: string;
  table: string;
  tier: Tier;
  name: string | null;
  comment: string | null;
  estimatedRows: number | null;
  fieldCount: number | null;
  /** Present when the tier was set by a user override. */
  overrideSource: string | null;
}

export interface DatabaseGroup {
  profileId: string;
  database: string;
  tables: TableOverview[];
}

export interface CatalogOverview {
  kind: CatalogKind;
  id: string;
  status: string | null;
  system: CatalogSummary['system'];
  counts: CatalogSummary['counts'];
  databases: DatabaseGroup[];
}

async function listDirs(p: string): Promise<string[]> {
  try {
    const entries = await readdir(p, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function listFiles(p: string): Promise<string[]> {
  try {
    const entries = await readdir(p, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function readJson<T = unknown>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

interface ManifestShape {
  catalog_status?: string;
  generated_at?: string;
  system?: { id?: string; name?: string; description?: string };
  counts?: { total?: number; hot?: number; warm?: number; cold?: number };
}

function catalogDir(root: string, kind: CatalogKind, id: string): string {
  return join(root, 'knowledge', kind === 'draft' ? 'drafts' : 'versions', id);
}

async function summarize(
  root: string,
  kind: CatalogKind,
  id: string,
): Promise<CatalogSummary> {
  const manifest = await readJson<ManifestShape>(join(catalogDir(root, kind, id), 'manifest.json'));
  const counts = manifest?.counts
    ? {
        total: Number(manifest.counts.total ?? 0),
        hot: Number(manifest.counts.hot ?? 0),
        warm: Number(manifest.counts.warm ?? 0),
        cold: Number(manifest.counts.cold ?? 0),
      }
    : null;
  return {
    kind,
    id,
    status: manifest?.catalog_status ?? null,
    system: manifest?.system ?? null,
    counts,
    generatedAt: manifest?.generated_at ?? null,
  };
}

export async function listCatalogs(workspaceRoot: string): Promise<CatalogList> {
  const root = normalizeAbsolute(workspaceRoot);
  const draftIds = await listDirs(join(root, 'knowledge', 'drafts'));
  const versionIds = await listDirs(join(root, 'knowledge', 'versions'));

  const index = await readJson<{ current_version?: string | null }>(
    join(root, 'knowledge', 'index.json'),
  );
  const currentVersion = index?.current_version ?? null;

  const drafts = await Promise.all(draftIds.map((id) => summarize(root, 'draft', id)));
  const versions = await Promise.all(
    versionIds.map(async (id) => {
      const s = await summarize(root, 'version', id);
      s.isCurrent = currentVersion === id;
      return s;
    }),
  );

  return {
    drafts,
    versions,
    currentVersion,
    latestDraftId: draftIds.length > 0 ? draftIds[draftIds.length - 1]! : null,
  };
}

/** Parse a "profile/database/table" table_id into parts. */
export function splitTableId(tableId: string): {
  profileId: string;
  database: string;
  table: string;
} {
  const [profileId = '', database = '', table = ''] = tableId.split('/');
  return { profileId, database, table };
}

async function overviewForTable(
  dbDir: string,
  tableId: string,
  tier: Tier,
): Promise<TableOverview | null> {
  const { profileId, database, table } = splitTableId(tableId);
  const base: TableOverview = {
    tableId,
    profileId,
    database,
    table,
    tier,
    name: null,
    comment: null,
    estimatedRows: null,
    fieldCount: null,
    overrideSource: null,
  };

  if (tier === 'cold') {
    // Cold entries live inside cold/tables.json (no field detail).
    const cold = await readJson<{ tables?: unknown[] }>(join(dbDir, 'cold', 'tables.json'));
    const entry = (cold?.tables ?? []).map(rec).find((t) => t.table_id === tableId);
    if (!entry) return base;
    const cls = rec(entry.classification);
    return {
      ...base,
      name: (rec(entry.business).name as string) ?? null,
      comment: (entry.comment as string) ?? null,
      estimatedRows: typeof entry.estimated_rows === 'number' ? entry.estimated_rows : null,
      overrideSource: cls.override ? String(rec(cls.override).source ?? 'user') : null,
    };
  }

  // Hot/warm: a per-table file whose name starts with the sanitized id.
  const detail = await readTableFile(dbDir, tier, tableId);
  if (!detail) return base;
  const cls = rec(detail.classification);
  return {
    ...base,
    name: (rec(detail.business).name as string) ?? (detail.comment as string) ?? null,
    comment: (detail.comment as string) ?? null,
    estimatedRows: typeof detail.estimated_rows === 'number' ? detail.estimated_rows : null,
    fieldCount: Array.isArray(detail.physical_fields) ? detail.physical_fields.length : null,
    overrideSource: cls.override ? String(rec(cls.override).source ?? 'user') : null,
  };
}

/** Load a hot/warm table file by scanning the tier directory for a matching table_id. */
async function readTableFile(
  dbDir: string,
  tier: 'hot' | 'warm',
  tableId: string,
): Promise<Record<string, unknown> | null> {
  const dir = join(dbDir, tier, 'tables');
  const files = await listFiles(dir);
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const data = await readJson<Record<string, unknown>>(join(dir, f));
    if (data && data.table_id === tableId) return data;
  }
  return null;
}

export async function readCatalogOverview(
  workspaceRoot: string,
  kind: CatalogKind,
  id: string,
): Promise<CatalogOverview | null> {
  const root = normalizeAbsolute(workspaceRoot);
  const dir = catalogDir(root, kind, id);
  if (!(await exists(join(dir, 'manifest.json')))) return null;

  const summary = await summarize(root, kind, id);
  const byTier = await readJson<{ hot?: string[]; warm?: string[]; cold?: string[] }>(
    join(dir, 'indexes', 'by-tier.json'),
  );

  const tierOf = new Map<string, Tier>();
  for (const t of byTier?.hot ?? []) tierOf.set(t, 'hot');
  for (const t of byTier?.warm ?? []) tierOf.set(t, 'warm');
  for (const t of byTier?.cold ?? []) tierOf.set(t, 'cold');

  // Group by profile/database.
  const groups = new Map<string, DatabaseGroup>();
  for (const [tableId, tier] of tierOf) {
    const { profileId, database } = splitTableId(tableId);
    const key = `${profileId}/${database}`;
    let g = groups.get(key);
    if (!g) {
      g = { profileId, database, tables: [] };
      groups.set(key, g);
    }
    const dbDir = join(dir, 'databases', profileId, database);
    const ov = await overviewForTable(dbDir, tableId, tier);
    if (ov) g.tables.push(ov);
  }

  const tierRank: Record<Tier, number> = { hot: 0, warm: 1, cold: 2 };
  const databases = [...groups.values()].sort((a, b) =>
    `${a.profileId}/${a.database}`.localeCompare(`${b.profileId}/${b.database}`),
  );
  for (const g of databases) {
    g.tables.sort(
      (a, b) => tierRank[a.tier] - tierRank[b.tier] || a.table.localeCompare(b.table),
    );
  }

  return {
    kind,
    id,
    status: summary.status,
    system: summary.system,
    counts: summary.counts,
    databases,
  };
}

export interface TableDetail {
  kind: CatalogKind;
  catalogId: string;
  tableId: string;
  tier: Tier;
  /** The raw table object (hot/warm) or the cold list entry. Cold has no fields. */
  data: Record<string, unknown>;
  hasFields: boolean;
  /** SHA-256 of the on-disk table file (hot/warm only); present the on next save. */
  revision?: string;
}

export async function readTableDetail(
  workspaceRoot: string,
  kind: CatalogKind,
  id: string,
  tableId: string,
): Promise<TableDetail | null> {
  const root = normalizeAbsolute(workspaceRoot);
  const dir = catalogDir(root, kind, id);
  const { profileId, database } = splitTableId(tableId);
  const dbDir = join(dir, 'databases', profileId, database);

  // Determine tier from by-tier index.
  const byTier = await readJson<{ hot?: string[]; warm?: string[]; cold?: string[] }>(
    join(dir, 'indexes', 'by-tier.json'),
  );
  let tier: Tier | null = null;
  if ((byTier?.hot ?? []).includes(tableId)) tier = 'hot';
  else if ((byTier?.warm ?? []).includes(tableId)) tier = 'warm';
  else if ((byTier?.cold ?? []).includes(tableId)) tier = 'cold';
  if (!tier) return null;

  if (tier === 'cold') {
    const cold = await readJson<{ tables?: unknown[] }>(join(dbDir, 'cold', 'tables.json'));
    const entry = (cold?.tables ?? []).map(rec).find((t) => t.table_id === tableId);
    if (!entry) return null;
    return { kind, catalogId: id, tableId, tier, data: entry, hasFields: false };
  }

  const found = await readTableFileWithPath(dbDir, tier, tableId);
  if (!found) return null;
  const revision = createHash('sha256').update(found.raw, 'utf8').digest('hex');
  return { kind, catalogId: id, tableId, tier, data: found.data, hasFields: true, revision };
}

/** Like readTableFile but also returns raw content (for revision hashing). */
async function readTableFileWithPath(
  dbDir: string,
  tier: 'hot' | 'warm',
  tableId: string,
): Promise<{ data: Record<string, unknown>; raw: string } | null> {
  const dir = join(dbDir, tier, 'tables');
  for (const f of await listFiles(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(dir, f), 'utf8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (data.table_id === tableId) return { data, raw };
    } catch {
      // skip unreadable
    }
  }
  return null;
}
