import { readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { join, relative } from 'node:path';
import { normalizeAbsolute, resolveWithinWorkspace } from './paths.js';

/**
 * Transpile the TypeScript transform source into the runtime `.mjs` by stripping
 * type annotations (Node 24 built-in). The transform files are plain TS — type
 * annotations only, no enums/namespaces/decorators — so type-stripping yields a
 * faithful ESM module. Keeps `transforms/index.ts` the single source a human
 * edits and `transforms/index.mjs` an always-in-sync generated artifact, so the
 * runtime never executes a stale compiled file.
 */
export function transpileTransformSource(tsSource: string): string {
  return stripTypeScriptTypes(tsSource, { mode: 'strip' });
}

/** Report status read from disk facts (plan §10.4). */
export interface ReportSummary {
  id: string;
  name?: string;
  version?: string;
  currentVersion?: string;
  status?: string;
  developmentOnly?: boolean;
  /** Workspace-relative package path, e.g. "packages/<id>/<version>". */
  path?: string;
}

export interface ReportState {
  /** Report requirements declared in config (names only for the page). */
  requirements: Array<{ id: string; name: string; fieldCount: number }>;
  plans: string[];
  reports: ReportSummary[];
  notes: string[];
}

async function readJson(p: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

async function listFiles(p: string): Promise<string[]> {
  try {
    const entries = await readdir(p, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

export async function readReportState(workspaceRoot: string): Promise<ReportState> {
  const root = normalizeAbsolute(workspaceRoot);
  const notes: string[] = [];

  // Requirements from build config.
  const cfg = (await readJson(join(root, 'config', 'easy-bi.json'))) as
    | { knowledge?: { report_requirements?: Array<Record<string, unknown>> } }
    | null;
  const reqs = cfg?.knowledge?.report_requirements ?? [];
  const requirements = reqs.map((r, i) => {
    const rf = r.required_fields;
    return {
      id: String(r.id ?? `req-${i}`),
      name: String(r.name ?? r.id ?? `报表${i + 1}`),
      fieldCount: Array.isArray(rf) ? rf.length : 0,
    };
  });

  const plans = await listFiles(join(root, 'reports', 'plans'));

  const index = (await readJson(join(root, 'reports', 'index.json'))) as
    | { reports?: Array<Record<string, unknown>> }
    | null;
  const reports: ReportSummary[] = (index?.reports ?? []).map((r) => {
    const s: ReportSummary = { id: String(r.id ?? '') };
    if (r.name !== undefined) s.name = String(r.name);
    if (r.version !== undefined) s.version = String(r.version);
    if (r.current_version !== undefined) s.currentVersion = String(r.current_version);
    if (r.status !== undefined) s.status = String(r.status);
    if (r.development_only !== undefined) s.developmentOnly = Boolean(r.development_only);
    if (r.path !== undefined) s.path = String(r.path);
    return s;
  });

  if (requirements.length === 0) notes.push('构建配置未声明报表需求');
  if (reports.length === 0) notes.push('尚未生成任何报表包');

  return { requirements, plans, reports, notes };
}

export class ReportPackageError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'PROTECTED' | 'INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'ReportPackageError';
  }
}

export interface DeleteReportResult {
  id: string;
  version: string;
  removedDir: boolean;
}

/**
 * Delete a development-only report package: remove its directory under
 * reports/packages and deregister it from reports/index.json. Published /
 * production packages are protected (never deleted here). Idempotent on the
 * directory (missing dir still deregisters).
 */
export async function deleteReportPackage(
  workspaceRoot: string,
  id: string,
  version: string,
): Promise<DeleteReportResult> {
  const root = normalizeAbsolute(workspaceRoot);
  if (!id || !version) throw new ReportPackageError('INVALID', '缺少报表 id 或版本');

  const indexPath = join(root, 'reports', 'index.json');
  const index = (await readJson(indexPath)) as { reports?: Array<Record<string, unknown>> } | null;
  const entries = index?.reports ?? [];
  const entry = entries.find((r) => String(r.id) === id && String(r.version) === version);
  if (!entry) {
    throw new ReportPackageError('NOT_FOUND', `未找到报表包：${id} ${version}`);
  }
  if (!entry.development_only) {
    throw new ReportPackageError(
      'PROTECTED',
      `报表包 ${id} ${version} 非 development-only，禁止删除已发布/生产版本`,
    );
  }

  // Resolve the package dir strictly under the workspace (guard traversal).
  const rel = typeof entry.path === 'string' && entry.path ? entry.path : `packages/${id}/${version}`;
  const abs = resolveWithinWorkspace(root, join('reports', rel));
  const packagesRoot = resolveWithinWorkspace(root, join('reports', 'packages'));
  let removedDir = false;
  if (abs.startsWith(packagesRoot)) {
    await rm(abs, { recursive: true, force: true });
    removedDir = true;
    // Remove the now-empty per-report parent dir (packages/<id>) if this was its
    // last version, so no orphan shell is left behind.
    const parent = join(packagesRoot, id);
    if (parent.startsWith(packagesRoot)) {
      const remaining = await readdir(parent).catch(() => [] as string[]);
      if (remaining.length === 0) await rm(parent, { recursive: true, force: true });
    }
  }

  const next = entries.filter((r) => !(String(r.id) === id && String(r.version) === version));
  await writeJson(indexPath, { reports: next });

  return { id, version, removedDir };
}

async function writeJson(p: string, value: unknown): Promise<void> {
  const { writeFile: wf, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(p), { recursive: true });
  await wf(p, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// ---- Report package editing (development-only) ----

/**
 * Files a human may edit in place. `checksums.sha256` is regenerated by reseal
 * (never hand-edited); `report.manifest.json` / `knowledge.lock.json` are
 * identity/provenance and stay read-only from the editor.
 */
const EDITABLE_PACKAGE_FILES = new Set([
  'queries/main.sql',
  'queries/bindings.json',
  'parameters.schema.json',
  'fields.json',
  'transforms/index.ts',
  'transforms/index.mjs',
  'tests/cases.json',
]);

export interface ReportPackageFile {
  /** Package-relative path, e.g. "queries/main.sql". */
  path: string;
  /** Whether the editor may write this file. */
  editable: boolean;
  /** True for artifacts derived from another file (e.g. index.mjs from index.ts). */
  generated?: boolean;
}

export interface ReportPackageDetail {
  id: string;
  version: string;
  /** Workspace-relative package dir. */
  path: string;
  developmentOnly: boolean;
  /** Whether this package may be edited in place (development lifecycle). */
  editable: boolean;
  /** The package's own lifecycle status from its manifest (draft/approved/…). */
  status: string;
  files: ReportPackageFile[];
}

/** Released statuses are immutable and must never be edited in place. */
const RELEASED_STATUSES = new Set(['published', 'production', 'released', 'signed']);

/**
 * A package is editable when it's still in the development lifecycle — i.e. its
 * own manifest status is NOT a released one. This is independent of whether the
 * underlying knowledge was published (`development_only`): a draft report package
 * built against published knowledge is still a work-in-progress a human may fix.
 */
function isPackageEditable(manifestStatus: unknown, developmentOnly: unknown): boolean {
  const status = String(manifestStatus ?? '').toLowerCase();
  if (status && RELEASED_STATUSES.has(status)) return false;
  if (status) return true; // any non-released known status (draft/approved) is editable
  // No status on the manifest: fall back to the index's development_only flag.
  return developmentOnly === true;
}

/** Read a package manifest's `status`, tolerating a missing/unreadable file. */
async function readPackageStatus(packageDir: string): Promise<string> {
  const manifest = (await readJson(join(packageDir, 'report.manifest.json'))) as
    | { status?: unknown }
    | null;
  return typeof manifest?.status === 'string' ? manifest.status : '';
}

/** Locate an index entry + resolve its package dir strictly within the workspace. */
async function locatePackage(
  root: string,
  id: string,
  version: string,
): Promise<{ entry: Record<string, unknown>; abs: string; rel: string }> {
  if (!id || !version) throw new ReportPackageError('INVALID', '缺少报表 id 或版本');
  const indexPath = join(root, 'reports', 'index.json');
  const index = (await readJson(indexPath)) as { reports?: Array<Record<string, unknown>> } | null;
  const entry = (index?.reports ?? []).find(
    (r) => String(r.id) === id && String(r.version) === version,
  );
  if (!entry) throw new ReportPackageError('NOT_FOUND', `未找到报表包：${id} ${version}`);
  const rel = typeof entry.path === 'string' && entry.path ? entry.path : `packages/${id}/${version}`;
  const abs = resolveWithinWorkspace(root, join('reports', rel));
  const packagesRoot = resolveWithinWorkspace(root, join('reports', 'packages'));
  if (!abs.startsWith(packagesRoot)) {
    throw new ReportPackageError('INVALID', '报表包路径越界');
  }
  return { entry, abs, rel: join('reports', rel) };
}

async function listPackageFilesRel(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = join(current, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.push(relative(dir, full).split('\\').join('/'));
    }
  }
  await walk(dir);
  return out.sort();
}

/** Read a package's file listing + manifest facts (for the editor's file tree). */
export async function readReportPackageDetail(
  workspaceRoot: string,
  id: string,
  version: string,
): Promise<ReportPackageDetail> {
  const root = normalizeAbsolute(workspaceRoot);
  const { entry, abs, rel } = await locatePackage(root, id, version);
  const status = await readPackageStatus(abs);
  const editable = isPackageEditable(status, entry.development_only);
  const listed = await listPackageFilesRel(abs);
  // When a TS transform source exists, its compiled `.mjs` is a generated
  // artifact — surface it read-only so the editor steers edits to `index.ts`.
  const hasTsTransform = listed.includes('transforms/index.ts');
  const files = listed.map((p) => ({
    // A file is editable only if the package is editable AND it's whitelisted,
    // and it's not the auto-generated `.mjs` (when a `.ts` source is present).
    path: p,
    editable:
      editable &&
      EDITABLE_PACKAGE_FILES.has(p) &&
      !(p === 'transforms/index.mjs' && hasTsTransform),
    // Generated artifacts are shown but explained as auto-produced (read-only).
    ...(p === 'transforms/index.mjs' && hasTsTransform ? { generated: true } : {}),
  }));
  return {
    id,
    version,
    path: rel.split('\\').join('/'),
    developmentOnly: Boolean(entry.development_only),
    editable,
    status,
    files,
  };
}

/** Read a single package file's text content. */
export async function readReportPackageFile(
  workspaceRoot: string,
  id: string,
  version: string,
  filePath: string,
): Promise<{ path: string; content: string; editable: boolean }> {
  const root = normalizeAbsolute(workspaceRoot);
  const { abs } = await locatePackage(root, id, version);
  const target = resolveWithinWorkspace(root, join(relative(root, abs), filePath));
  if (!target.startsWith(abs)) throw new ReportPackageError('INVALID', '文件路径越界');
  try {
    const content = await readFile(target, 'utf8');
    const relPath = relative(abs, target).split('\\').join('/');
    return { path: relPath, content, editable: EDITABLE_PACKAGE_FILES.has(relPath) };
  } catch {
    throw new ReportPackageError('NOT_FOUND', `文件不存在：${filePath}`);
  }
}

/**
 * Write a single package file (development-only, whitelisted files). Does NOT
 * reseal — the caller reseals after a batch of edits so checksums are recomputed
 * once. Guards: dev-only package, editable whitelist, traversal-safe, file must
 * already exist (no creating arbitrary files).
 */
export async function writeReportPackageFile(
  workspaceRoot: string,
  id: string,
  version: string,
  filePath: string,
  content: string,
): Promise<{ path: string; generated: string[] }> {
  const root = normalizeAbsolute(workspaceRoot);
  const { entry, abs } = await locatePackage(root, id, version);
  if (!isPackageEditable(await readPackageStatus(abs), entry.development_only)) {
    throw new ReportPackageError('PROTECTED', '已发布/生产报表包不可编辑，请另存新版本');
  }
  const normalized = filePath.split('\\').join('/');
  if (!EDITABLE_PACKAGE_FILES.has(normalized)) {
    throw new ReportPackageError('INVALID', `该文件不可编辑：${filePath}`);
  }
  // `transforms/index.mjs` is a generated artifact: it's derived from
  // `transforms/index.ts` by type-stripping. Reject direct edits when a `.ts`
  // source exists so the two never drift; if a package has ONLY the `.mjs`
  // (older/hand-authored packages have no `.ts`), fall through and allow it.
  const tsRel = 'transforms/index.ts';
  const mjsRel = 'transforms/index.mjs';
  if (normalized === mjsRel) {
    const tsAbs = resolveWithinWorkspace(root, join(relative(root, abs), tsRel));
    const hasTs = await stat(tsAbs).then(() => true).catch(() => false);
    if (hasTs) {
      throw new ReportPackageError(
        'PROTECTED',
        'transforms/index.mjs 由 transforms/index.ts 自动生成，请改 index.ts（保存时会自动生成 index.mjs）',
      );
    }
  }
  const target = resolveWithinWorkspace(root, join(relative(root, abs), normalized));
  if (!target.startsWith(abs)) throw new ReportPackageError('INVALID', '文件路径越界');
  // Must already exist — the editor edits generated files, never creates new ones.
  await stat(target).catch(() => {
    throw new ReportPackageError('NOT_FOUND', `文件不存在：${filePath}`);
  });
  await writeFile(target, content, 'utf8');
  const generated: string[] = [];
  // Editing the TS source regenerates the runtime `.mjs` so they stay in sync —
  // the human never has to hand-mirror the change (the classic footgun).
  if (normalized === tsRel) {
    const mjsAbs = resolveWithinWorkspace(root, join(relative(root, abs), mjsRel));
    if (mjsAbs.startsWith(abs)) {
      try {
        await writeFile(mjsAbs, transpileTransformSource(content), 'utf8');
        generated.push(mjsRel);
      } catch (err) {
        // A syntax error in the TS surfaces here — report it so the human fixes
        // the source rather than silently leaving a stale .mjs behind.
        throw new ReportPackageError(
          'INVALID',
          `transforms/index.ts 语法错误，无法生成 index.mjs：${(err as Error).message}`,
        );
      }
    }
  }
  return { path: normalized, generated };
}

export interface ResealResult {
  resealed: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Reseal a development package after edits by invoking the skill's
 * report-package-cli `reseal` command (recomputes checksums + re-validates).
 * `cliPath` is resolved by the caller via the WorkspaceSkillAdapter/manifest —
 * we never hardcode the skill's deep path here.
 */
export async function resealReportPackage(
  workspaceRoot: string,
  id: string,
  version: string,
  cliPath: string,
  nodePath: string = process.execPath,
): Promise<ResealResult> {
  const root = normalizeAbsolute(workspaceRoot);
  const { entry, abs } = await locatePackage(root, id, version);
  if (!isPackageEditable(await readPackageStatus(abs), entry.development_only)) {
    throw new ReportPackageError('PROTECTED', '已发布/生产报表包不可重新封包');
  }
  const res = spawnSync(nodePath, [cliPath, 'reseal', '--package', abs], {
    cwd: workspaceRoot,
    shell: false,
    encoding: 'utf8',
  });
  const stdout = (res.stdout ?? '').trim();
  let parsed: ResealResult | null = null;
  try {
    parsed = JSON.parse(stdout) as ResealResult;
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed.resealed === 'boolean') return parsed;
  return {
    resealed: false,
    errors: [stdout || (res.stderr ?? '').trim() || 'reseal 未返回结果'],
    warnings: [],
  };
}
