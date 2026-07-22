import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKnowledgeState } from './knowledge-state.js';
import { readReportState } from './report-state.js';

let ws: string;

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'easybi-krs-'));
  await mkdir(join(ws, 'config'), { recursive: true });
  await mkdir(join(ws, 'knowledge'), { recursive: true });
  await mkdir(join(ws, 'reports', 'plans'), { recursive: true });
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('readKnowledgeState', () => {
  it('reports empty knowledge with notes', async () => {
    const s = await readKnowledgeState(ws);
    expect(s.drafts).toEqual([]);
    expect(s.publishedVersions).toEqual([]);
    expect(s.notes.join('')).toContain('尚无知识库');
  });

  it('reads drafts, versions, tier counts, and blocking issues', async () => {
    await mkdir(join(ws, 'knowledge', 'drafts', 'd1', 'reviews'), { recursive: true });
    await mkdir(join(ws, 'knowledge', 'drafts', 'd1', 'indexes'), { recursive: true });
    await mkdir(join(ws, 'knowledge', 'versions', '1.0.0'), { recursive: true });
    await writeFile(join(ws, 'knowledge', 'index.json'), JSON.stringify({ current_version: '1.0.0' }));
    await writeFile(
      join(ws, 'knowledge', 'drafts', 'd1', 'reviews', 'blocking-issues.json'),
      JSON.stringify({ issues: [{ id: 'x' }, { id: 'y' }] }),
    );
    await writeFile(
      join(ws, 'knowledge', 'drafts', 'd1', 'indexes', 'by-tier.json'),
      JSON.stringify({ hot: [1, 2], warm: [1], cold: [] }),
    );
    const s = await readKnowledgeState(ws);
    expect(s.drafts).toContain('d1');
    expect(s.publishedVersions).toContain('1.0.0');
    expect(s.currentVersion).toBe('1.0.0');
    expect(s.hotTables).toBe(2);
    expect(s.warmTables).toBe(1);
    expect(s.blockingIssues).toBe(2);
  });
});

describe('readReportState', () => {
  it('reads requirements from config and report index', async () => {
    await writeFile(
      join(ws, 'config', 'easy-bi.json'),
      JSON.stringify({
        knowledge: {
          report_requirements: [
            { id: 'r1', name: '报表一', required_fields: ['a', 'b'] },
            { id: 'r2', name: '报表二', required_fields: ['c'] },
          ],
        },
      }),
    );
    await writeFile(
      join(ws, 'reports', 'index.json'),
      JSON.stringify({ reports: [{ id: 'r1', name: '报表一', current_version: '0.1.0', development_only: true }] }),
    );
    await writeFile(join(ws, 'reports', 'plans', 'r1.json'), '{}');

    const s = await readReportState(ws);
    expect(s.requirements).toHaveLength(2);
    expect(s.requirements[0]?.fieldCount).toBe(2);
    expect(s.plans).toContain('r1.json');
    expect(s.reports[0]?.developmentOnly).toBe(true);
  });
});

describe('deleteReportPackage', () => {
  async function seed(): Promise<void> {
    await mkdir(join(ws, 'reports', 'packages', 'r1', '0.1.0-draft'), { recursive: true });
    await writeFile(join(ws, 'reports', 'packages', 'r1', '0.1.0-draft', 'f.txt'), 'x');
    await mkdir(join(ws, 'reports', 'packages', 'r2', '1.0.0'), { recursive: true });
    await writeFile(
      join(ws, 'reports', 'index.json'),
      JSON.stringify({
        reports: [
          { id: 'r1', name: '开发报表', version: '0.1.0-draft', status: 'draft', path: 'packages/r1/0.1.0-draft', development_only: true },
          { id: 'r2', name: '正式报表', version: '1.0.0', status: 'published', path: 'packages/r2/1.0.0', development_only: false },
        ],
      }),
    );
  }

  it('deletes a development-only package: removes dir + deregisters', async () => {
    const { deleteReportPackage, readReportState } = await import('./report-state.js');
    const { existsSync } = await import('node:fs');
    await seed();
    const res = await deleteReportPackage(ws, 'r1', '0.1.0-draft');
    expect(res.removedDir).toBe(true);
    expect(existsSync(join(ws, 'reports', 'packages', 'r1', '0.1.0-draft'))).toBe(false);
    const state = await readReportState(ws);
    expect(state.reports.find((r) => r.id === 'r1')).toBeUndefined();
    expect(state.reports.find((r) => r.id === 'r2')).toBeDefined();
  });

  it('refuses to delete a non development-only (published) package', async () => {
    const { deleteReportPackage, ReportPackageError } = await import('./report-state.js');
    const { existsSync } = await import('node:fs');
    await seed();
    await expect(deleteReportPackage(ws, 'r2', '1.0.0')).rejects.toBeInstanceOf(ReportPackageError);
    // dir intact
    expect(existsSync(join(ws, 'reports', 'packages', 'r2', '1.0.0'))).toBe(true);
  });

  it('404s for an unknown package', async () => {
    const { deleteReportPackage } = await import('./report-state.js');
    await seed();
    await expect(deleteReportPackage(ws, 'nope', '9.9.9')).rejects.toThrow(/未找到/);
  });
});

describe('writeReportPackageFile transform auto-mjs', () => {
  const dir = () => join(ws, 'reports', 'packages', 'r1', '0.1.0-draft');
  async function seedPackage(): Promise<void> {
    await mkdir(join(dir(), 'transforms'), { recursive: true });
    await writeFile(
      join(ws, 'reports', 'index.json'),
      JSON.stringify({
        reports: [
          {
            id: 'r1',
            name: '开发报表',
            version: '0.1.0-draft',
            status: 'draft',
            path: 'packages/r1/0.1.0-draft',
            development_only: true,
          },
        ],
      }),
    );
    await writeFile(join(dir(), 'report.manifest.json'), JSON.stringify({ status: 'draft' }));
    await writeFile(
      join(dir(), 'transforms', 'index.ts'),
      'export function transformRow(row: Record<string, unknown>): Record<string, unknown> { return row; }\n',
    );
    await writeFile(join(dir(), 'transforms', 'index.mjs'), '// stale\n');
  }

  it('regenerates index.mjs (type-stripped) when index.ts is saved', async () => {
    const { writeReportPackageFile } = await import('./report-state.js');
    const { readFile } = await import('node:fs/promises');
    await seedPackage();
    const newTs =
      'export function transformRow(row: Record<string, unknown>): Record<string, unknown> {\n' +
      '  const out = { ...row };\n' +
      '  out.doubled = Number((row as { qty?: unknown }).qty ?? 0) * 2;\n' +
      '  return out;\n}\n';
    const res = await writeReportPackageFile(ws, 'r1', '0.1.0-draft', 'transforms/index.ts', newTs);
    expect(res.generated).toContain('transforms/index.mjs');
    const mjs = await readFile(join(dir(), 'transforms', 'index.mjs'), 'utf8');
    // Type annotations stripped; runtime logic preserved.
    expect(mjs).not.toContain(': Record<string, unknown>');
    expect(mjs).toContain('out.doubled');
    expect(mjs).not.toContain('// stale');
  });

  it('rejects editing index.mjs directly when an index.ts source exists', async () => {
    const { writeReportPackageFile, ReportPackageError } = await import('./report-state.js');
    await seedPackage();
    await expect(
      writeReportPackageFile(ws, 'r1', '0.1.0-draft', 'transforms/index.mjs', '// hand edit\n'),
    ).rejects.toBeInstanceOf(ReportPackageError);
  });

  it('reports a TS syntax error instead of silently leaving a stale mjs', async () => {
    const { writeReportPackageFile } = await import('./report-state.js');
    await seedPackage();
    await expect(
      writeReportPackageFile(
        ws,
        'r1',
        '0.1.0-draft',
        'transforms/index.ts',
        'export function transformRow(row {{{ syntax error\n',
      ),
    ).rejects.toThrow(/index\.ts/);
  });

  it('marks the generated index.mjs read-only in the package detail', async () => {
    const { writeReportPackageFile, readReportPackageDetail } = await import('./report-state.js');
    await seedPackage();
    // Touch the ts so both files exist through the normal path.
    await writeReportPackageFile(
      ws,
      'r1',
      '0.1.0-draft',
      'transforms/index.ts',
      'export function transformRow(row: Record<string, unknown>) { return row; }\n',
    );
    const detail = await readReportPackageDetail(ws, 'r1', '0.1.0-draft');
    const mjs = detail.files.find((f) => f.path === 'transforms/index.mjs');
    const ts = detail.files.find((f) => f.path === 'transforms/index.ts');
    expect(ts?.editable).toBe(true);
    expect(mjs?.editable).toBe(false);
    expect(mjs?.generated).toBe(true);
  });
});
