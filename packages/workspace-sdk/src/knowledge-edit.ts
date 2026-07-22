import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, rename, mkdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalizeAbsolute } from './paths.js';
import { splitTableId, type Tier } from './knowledge-catalog.js';

/**
 * Draft semantic editing. Only editable branches are written:
 *   table-level: business.name / description / domain
 *   per-field:   semantic.name / description / report_exposed / filter_candidate
 *                filter.enabled / role / default_operator
 * Physical schema, classification, activity, tier, etc. are never touched here —
 * tier changes go through the skill CLI (promote), not this writer.
 *
 * Uses the same concurrency model as the config store: a revision (SHA-256 of the
 * on-disk file) must be presented, atomic write via temp+rename, previous content
 * backed up. Published versions are never editable (caller must pass a draft).
 */

export class CatalogConflictError extends Error {
  readonly code = 'CATALOG_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'CatalogConflictError';
  }
}
export class CatalogNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'CatalogNotFoundError';
  }
}

export interface FieldSemanticPatch {
  field: string;
  name?: string | null;
  description?: string | null;
  reportExposed?: boolean;
  filterEnabled?: boolean;
  filterRole?: string | null;
  defaultOperator?: string | null;
}

export interface TableSemanticPatch {
  /** table-level business identity */
  name?: string | null;
  description?: string | null;
  domain?: string | null;
  /** per-field edits, keyed by physical field name */
  fields?: FieldSemanticPatch[];
}

export interface TableFileLocation {
  abs: string;
  tier: 'hot' | 'warm';
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function computeRevision(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function listFiles(p: string): Promise<string[]> {
  try {
    const entries = await readdir(p, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/** Locate the hot/warm table file for a draft table. Cold tables have no file. */
export async function locateTableFile(
  workspaceRoot: string,
  draftId: string,
  tableId: string,
): Promise<TableFileLocation | null> {
  const root = normalizeAbsolute(workspaceRoot);
  const { profileId, database } = splitTableId(tableId);
  const dbDir = join(root, 'knowledge', 'drafts', draftId, 'databases', profileId, database);
  for (const tier of ['hot', 'warm'] as const) {
    const dir = join(dbDir, tier, 'tables');
    for (const f of await listFiles(dir)) {
      if (!f.endsWith('.json')) continue;
      const abs = join(dir, f);
      try {
        const data = JSON.parse(await readFile(abs, 'utf8')) as { table_id?: string };
        if (data.table_id === tableId) return { abs, tier };
      } catch {
        // skip unreadable
      }
    }
  }
  return null;
}

/** Apply the whitelisted patch onto a parsed table object (mutates a copy). */
export function applyTablePatch(
  data: Record<string, unknown>,
  patch: TableSemanticPatch,
): Record<string, unknown> {
  const next = structuredClone(data);

  // Table-level business identity.
  const business = { ...rec(next.business) };
  if (patch.name !== undefined) business.name = patch.name;
  if (patch.description !== undefined) business.description = patch.description;
  if (patch.domain !== undefined) business.domain = patch.domain;
  // A human edit promotes status to confirmed for the touched identity.
  if (patch.name !== undefined || patch.description !== undefined || patch.domain !== undefined) {
    business.status = 'confirmed';
    business.source = 'user';
  }
  next.business = business;

  // Per-field edits.
  if (patch.fields && patch.fields.length > 0) {
    const byName = new Map(patch.fields.map((f) => [f.field, f]));
    const fields = Array.isArray(next.physical_fields) ? next.physical_fields : [];
    next.physical_fields = fields.map((raw) => {
      const f = rec(raw);
      const physical = rec(f.physical);
      const fieldName = String(physical.name ?? '');
      const p = byName.get(fieldName);
      if (!p) return f;

      const semantic = { ...rec(f.semantic) };
      let semanticTouched = false;
      if (p.name !== undefined) {
        semantic.name = p.name;
        semanticTouched = true;
      }
      if (p.description !== undefined) {
        semantic.description = p.description;
        semanticTouched = true;
      }
      if (p.reportExposed !== undefined) {
        semantic.report_exposed = p.reportExposed;
        semanticTouched = true;
      }
      if (semanticTouched) {
        semantic.status = 'confirmed';
      }
      f.semantic = semantic;

      const filter = { ...rec(f.filter) };
      let filterTouched = false;
      if (p.filterEnabled !== undefined) {
        filter.enabled = p.filterEnabled;
        filterTouched = true;
      }
      if (p.filterRole !== undefined) {
        filter.role = p.filterRole;
        filterTouched = true;
      }
      if (p.defaultOperator !== undefined) {
        filter.default_operator = p.defaultOperator;
        filterTouched = true;
      }
      if (filterTouched) {
        filter.status = 'confirmed';
        filter.source = 'user';
      }
      f.filter = filter;

      return f;
    });
  }

  return next;
}

/** Rebuild by-field.json semantic_name entries for a single table after an edit. */
export function updateByFieldIndex(
  index: unknown,
  tableId: string,
  tier: Tier,
  data: Record<string, unknown>,
): { fields: Array<{ table_id: string; field: string; semantic_name: string | null; tier: Tier }> } {
  const existing = Array.isArray(rec(index).fields)
    ? (rec(index).fields as Array<Record<string, unknown>>)
    : [];
  // Drop the table's old entries, keep others as-is.
  const kept = existing
    .filter((e) => e.table_id !== tableId)
    .map((e) => ({
      table_id: String(e.table_id ?? ''),
      field: String(e.field ?? ''),
      semantic_name: (e.semantic_name as string) ?? null,
      tier: (e.tier as Tier) ?? tier,
    }));

  const fields = Array.isArray(data.physical_fields) ? data.physical_fields : [];
  const fresh = fields.map((raw) => {
    const f = rec(raw);
    const physical = rec(f.physical);
    const semantic = rec(f.semantic);
    return {
      table_id: tableId,
      field: String(physical.name ?? ''),
      semantic_name: (semantic.name as string) ?? null,
      tier,
    };
  });

  return { fields: [...kept, ...fresh] };
}

async function atomicWriteJson(abs: string, value: unknown): Promise<string> {
  const serialized = JSON.stringify(value, null, 2) + '\n';
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, serialized, 'utf8');
  await rename(tmp, abs);
  return computeRevision(serialized);
}

export interface WriteTableSemanticsOptions {
  workspaceRoot: string;
  draftId: string;
  tableId: string;
  patch: TableSemanticPatch;
  /** Revision (SHA-256) of the table file the caller read. */
  expectedRevision: string;
}

export interface WriteTableSemanticsResult {
  revision: string;
  backupPath: string;
  tier: 'hot' | 'warm';
}

export async function readTableFileRaw(
  workspaceRoot: string,
  draftId: string,
  tableId: string,
): Promise<{ data: Record<string, unknown>; revision: string; tier: 'hot' | 'warm' } | null> {
  const loc = await locateTableFile(workspaceRoot, draftId, tableId);
  if (!loc) return null;
  const raw = await readFile(loc.abs, 'utf8');
  return { data: JSON.parse(raw) as Record<string, unknown>, revision: computeRevision(raw), tier: loc.tier };
}

/**
 * Write semantic edits to a draft table file, backing up the previous content and
 * synchronizing the by-field index. Rejects on revision conflict or missing table.
 */
export async function writeTableSemantics(
  options: WriteTableSemanticsOptions,
): Promise<WriteTableSemanticsResult> {
  const { workspaceRoot, draftId, tableId, patch, expectedRevision } = options;
  const root = normalizeAbsolute(workspaceRoot);

  const loc = await locateTableFile(root, draftId, tableId);
  if (!loc) throw new CatalogNotFoundError(`草稿中未找到可编辑的表：${tableId}（冷表无字段明细）`);

  const current = await readFile(loc.abs, 'utf8');
  const currentRevision = computeRevision(current);
  if (currentRevision !== expectedRevision) {
    throw new CatalogConflictError(
      `表已被其他任务修改（期望 ${expectedRevision.slice(0, 8)}，实际 ${currentRevision.slice(
        0,
        8,
      )}），已阻止覆盖`,
    );
  }

  const data = JSON.parse(current) as Record<string, unknown>;
  const next = applyTablePatch(data, patch);

  // Backup previous content.
  const backupRel = join(
    'work',
    'knowledge-backups',
    `${tableId.replace(/[\\/]/g, '_')}.${currentRevision.slice(0, 8)}.bak`,
  );
  const backupAbs = join(root, backupRel);
  await mkdir(dirname(backupAbs), { recursive: true });
  await copyFile(loc.abs, backupAbs);

  const revision = await atomicWriteJson(loc.abs, next);

  // Synchronize by-field index (best-effort; a stale index is non-fatal).
  const indexAbs = join(root, 'knowledge', 'drafts', draftId, 'indexes', 'by-field.json');
  try {
    const idxRaw = await readFile(indexAbs, 'utf8');
    const updated = updateByFieldIndex(JSON.parse(idxRaw), tableId, loc.tier, next);
    await atomicWriteJson(indexAbs, updated);
  } catch {
    // index missing or unreadable — skip
  }

  return { revision, backupPath: backupAbs, tier: loc.tier };
}
