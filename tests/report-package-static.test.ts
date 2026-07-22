import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Stage 6 exit criterion: a report package can be GENERATED and VALIDATED from a
 * sample (draft) knowledge catalog using the bundled report CLI — no database.
 * The result must be flagged development-only (never presented as production).
 *
 * Uses the synced immutable cache CLI. Skips when the bundle has not been synced.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(
  homedir(),
  '.easybi-studio',
  'skill-cache',
  'easybi',
  '1.2.0',
  'skills',
  'create-report-package',
  'dist',
  'scripts',
  'report-package-cli.js',
);
const KNOWLEDGE = join(__dirname, 'fixtures', 'knowledge-sample');

const available = existsSync(CLI);
const maybe = available ? describe : describe.skip;

let ws: string;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'easybi-rpstatic-'));
  await mkdir(join(ws, 'config'), { recursive: true });
  await mkdir(join(ws, 'reports', 'plans'), { recursive: true });
  await writeFile(
    join(ws, 'config', 'easy-bi.json'),
    JSON.stringify({
      config_version: '4',
      knowledge: {
        report_requirements: [
          {
            id: 'driver-basic-detail',
            name: '司机基础信息明细',
            required_fields: [
              { field: 'base_primary_driver.code', label: '司机编码' },
              { field: 'base_primary_driver.name', label: '司机姓名' },
              { field: 'base_primary_driver.create_time', label: '创建时间' },
            ],
          },
        ],
      },
    }),
  );
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

function run(args: string[]): { code: number; stdout: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: res.status ?? -1, stdout: res.stdout ?? '' };
}

maybe('report package static pipeline (no database)', () => {
  it('inspects, approves, generates, and validates a development-only package', async () => {
    const plan = join(ws, 'reports', 'plans', 'driver-basic-detail.json');

    const inspect = run([
      'inspect',
      '--workspace',
      ws,
      '--knowledge',
      KNOWLEDGE,
      '--report-id',
      'driver-basic-detail',
      '--out',
      plan,
    ]);
    expect(inspect.code).toBe(0);
    expect(JSON.parse(inspect.stdout).blockers).toEqual([]);

    expect(run(['approve-plan', '--plan', plan, '--reviewed-by', 'tester']).code).toBe(0);

    const gen = run(['generate', '--workspace', ws, '--plan', plan]);
    expect(gen.code).toBe(0);
    const pkgDir = JSON.parse(gen.stdout).package as string;
    expect(await stat(pkgDir).then(() => true)).toBe(true);

    // Generated SQL contains the filter marker and system condition.
    const sql = await readFile(join(pkgDir, 'queries', 'main.sql'), 'utf8');
    expect(sql).toContain('/* EASYBI_FILTERS */');
    expect(sql).toContain('is_delete');

    // Manifest is development-only.
    const manifest = JSON.parse(await readFile(join(pkgDir, 'report.manifest.json'), 'utf8'));
    expect(manifest.development_only).toBe(true);

    const validate = run(['validate', '--package', pkgDir]);
    expect(validate.code).toBe(0);
    expect(JSON.parse(validate.stdout).valid).toBe(true);
  });
});
