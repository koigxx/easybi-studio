import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePrecheck, buildArtifact, ArtifactBuildError } from '@easybi-studio/artifact-exporter';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE = join(homedir(), '.easybi-studio', 'skill-cache', 'easybi', '1.2.0');
const REPORT_CLI = join(CACHE, 'skills', 'create-report-package', 'dist', 'scripts', 'report-package-cli.js');
const KNOWLEDGE = join(__dirname, 'fixtures', 'knowledge-sample');
const available = existsSync(REPORT_CLI);
const maybe = available ? describe : describe.skip;

let ws: string;

function cli(args: string[]): number {
  return spawnSync(process.execPath, [REPORT_CLI, ...args], { encoding: 'utf8' }).status ?? -1;
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'easybi-art-'));
  await mkdir(join(ws, 'config'), { recursive: true });
  await mkdir(join(ws, 'reports', 'plans'), { recursive: true });
  // A published knowledge version (required by the hard gate) + a draft alongside.
  await mkdir(join(ws, 'knowledge', 'versions', 'v1'), { recursive: true });
  await writeFile(join(ws, 'knowledge', 'versions', 'v1', 'manifest.json'), '{"catalog_status":"published"}');
  await mkdir(join(ws, 'knowledge', 'drafts', 'd1'), { recursive: true });
  await writeFile(join(ws, 'knowledge', 'drafts', 'd1', 'manifest.json'), '{"catalog_status":"draft"}');
  // Config with a secret that must be redacted in the artifact.
  await writeFile(
    join(ws, 'config', 'easy-bi.json'),
    JSON.stringify({
      config_version: '4',
      connections: { database_profiles: [{ id: 'p', password: 'SUPER-SECRET', settings: { host: 'h', port: 3306, username: 'u', databases: ['demo_db'] } }] },
      knowledge: {
        report_requirements: [
          {
            id: 'driver-basic-detail',
            name: '司机基础信息明细',
            required_fields: [{ field: 'base_primary_driver.code', label: '司机编码' }],
          },
        ],
      },
    }),
  );
  if (available) {
    const plan = join(ws, 'reports', 'plans', 'driver-basic-detail.json');
    cli(['inspect', '--workspace', ws, '--knowledge', KNOWLEDGE, '--report-id', 'driver-basic-detail', '--out', plan]);
    cli(['approve-plan', '--plan', plan, '--reviewed-by', 't']);
    cli(['generate', '--workspace', ws, '--plan', plan]);
  }
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

maybe('artifact precheck and development build', () => {
  it('development is buildable with published knowledge; candidate/production are not', async () => {
    const dev = await computePrecheck(ws, 'development');
    expect(dev.buildable).toBe(true);
    // Published knowledge present -> not development-only.
    expect(dev.developmentOnly).toBe(false);
    expect(dev.items.find((i) => i.key === 'published-knowledge')?.ok).toBe(true);
    const cand = await computePrecheck(ws, 'candidate');
    expect(cand.buildable).toBe(false);
    expect(cand.missing).toContain('真实导出验收');
    const prod = await computePrecheck(ws, 'production');
    expect(prod.buildable).toBe(false);
    expect(prod.missing.join('')).toContain('生产签名');
  });

  it('requires published knowledge to build (hard gate)', async () => {
    const draftWs = await mkdtemp(join(tmpdir(), 'easybi-art-draft-'));
    await mkdir(join(draftWs, 'config'), { recursive: true });
    await writeFile(join(draftWs, 'config', 'easy-bi.json'), '{}');
    await mkdir(join(draftWs, 'knowledge', 'drafts', 'd1'), { recursive: true });
    await writeFile(join(draftWs, 'knowledge', 'drafts', 'd1', 'manifest.json'), '{"catalog_status":"draft"}');
    await mkdir(join(draftWs, 'reports', 'packages', 'r', '0.1.0-draft'), { recursive: true });
    const pc = await computePrecheck(draftWs, 'development');
    expect(pc.buildable).toBe(false);
    expect(pc.missing).toContain('已发布知识库');
    await rm(draftWs, { recursive: true, force: true });
  });

  it('builds a development tar.gz with checksums and redacted secrets', async () => {
    const rec = await buildArtifact({
      workspaceRoot: ws,
      projectId: 'art',
      level: 'development',
      version: '0.1.0',
      now: '2026-07-18T00:00:00.000Z',
    });
    expect(rec.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.file).toContain('outputs/artifacts/easybi-development-0.1.0.tar.gz');

    // The tar exists.
    const files = await readdir(join(ws, 'outputs', 'artifacts'));
    expect(files).toContain('easybi-development-0.1.0.tar.gz');

    // The staged config secret must NOT appear anywhere in the archive bytes.
    const buf = await readFile(join(ws, 'outputs', 'artifacts', 'easybi-development-0.1.0.tar.gz'));
    expect(buf.includes(Buffer.from('SUPER-SECRET'))).toBe(false);
  });

  it('refuses to overwrite an existing version', async () => {
    await expect(
      buildArtifact({
        workspaceRoot: ws,
        projectId: 'art',
        level: 'development',
        version: '0.1.0',
        now: '2026-07-18T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ArtifactBuildError);
  });

  it('refuses non-development levels', async () => {
    await expect(
      buildArtifact({ workspaceRoot: ws, projectId: 'art', level: 'candidate', version: '0.2.0', now: 'x' }),
    ).rejects.toBeInstanceOf(ArtifactBuildError);
  });
});

// Selection test runs unconditionally (no report CLI needed — packages are
// hand-seeded to exercise the ship-only-selected logic).
describe('artifact selection ships only chosen report packages', () => {
  it('copies only selected packages and prunes reports/index.json', async () => {
    const w = await mkdtemp(join(tmpdir(), 'easybi-art-sel-'));
    await mkdir(join(w, 'config'), { recursive: true });
    await writeFile(join(w, 'config', 'easy-bi.json'), '{}');
    await mkdir(join(w, 'knowledge', 'versions', 'v1'), { recursive: true });
    await writeFile(join(w, 'knowledge', 'versions', 'v1', 'manifest.json'), '{"catalog_status":"published"}');
    // Two report packages; we'll ship only report-1.
    await mkdir(join(w, 'reports', 'packages', 'report-1', '0.1.0-draft'), { recursive: true });
    await writeFile(join(w, 'reports', 'packages', 'report-1', '0.1.0-draft', 'f.txt'), 'one');
    await mkdir(join(w, 'reports', 'packages', 'report-2', '0.1.0-draft'), { recursive: true });
    await writeFile(join(w, 'reports', 'packages', 'report-2', '0.1.0-draft', 'f.txt'), 'two');
    await writeFile(
      join(w, 'reports', 'index.json'),
      JSON.stringify({
        reports: [
          { id: 'report-1', name: '报表一', version: '0.1.0-draft', path: 'packages/report-1/0.1.0-draft' },
          { id: 'report-2', name: '报表二', version: '0.1.0-draft', path: 'packages/report-2/0.1.0-draft' },
        ],
      }),
    );

    await buildArtifact({
      workspaceRoot: w,
      projectId: 'sel',
      level: 'development',
      version: '0.9.0',
      reportVersions: { 'report-1': '0.1.0-draft' },
      now: '2026-07-18T00:00:00.000Z',
    });

    const out = join(w, 'unpacked');
    await mkdir(out, { recursive: true });
    spawnSync('tar', ['-xzf', join(w, 'outputs', 'artifacts', 'easybi-development-0.9.0.tar.gz'), '-C', out]);

    // Only report-1 shipped.
    expect(existsSync(join(out, 'reports', 'packages', 'report-1', '0.1.0-draft', 'f.txt'))).toBe(true);
    expect(existsSync(join(out, 'reports', 'packages', 'report-2'))).toBe(false);
    // index.json pruned to the selection.
    const idx = JSON.parse(await readFile(join(out, 'reports', 'index.json'), 'utf8')) as {
      reports: Array<{ id: string }>;
    };
    expect(idx.reports.map((r) => r.id)).toEqual(['report-1']);

    await rm(w, { recursive: true, force: true });
  });
});
