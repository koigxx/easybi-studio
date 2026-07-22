import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp, type StudioApp } from '../app.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE = join(homedir(), '.easybi-studio', 'skill-cache', 'easybi', '1.2.0');
const REPORT_CLI = join(CACHE, 'skills', 'create-report-package', 'dist', 'scripts', 'report-package-cli.js');
const KNOWLEDGE = join(__dirname, '..', '..', '..', '..', 'tests', 'fixtures', 'knowledge-sample');

const available = existsSync(REPORT_CLI) && existsSync(KNOWLEDGE);
const maybe = available ? describe : describe.skip;

let root: string;
let ws: string;
let studio: StudioApp;

function cli(args: string[]): number {
  return spawnSync(process.execPath, [REPORT_CLI, ...args], { encoding: 'utf8' }).status ?? -1;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'easybi-rt-'));
  ws = join(root, 'rtws');
  await mkdir(join(ws, 'config'), { recursive: true });
  await mkdir(join(ws, 'reports', 'plans'), { recursive: true });
  await mkdir(join(ws, 'toolkit', 'config'), { recursive: true });
  await mkdir(join(ws, 'outputs', 'files'), { recursive: true });
  // Install the whitelisted skills so the supervisor can resolve runtime_cli.
  if (available) {
    await cp(join(CACHE, 'skills'), join(ws, 'skills'), { recursive: true });
    // Pre-bootstrap runtime deps (local-first) so the supervisor health check
    // does not race a first-time npm install.
    const bootstrap = join(ws, 'skills', 'create-report-package', 'scripts', 'bootstrap-dependencies.mjs');
    const cleanEnv: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('npm_')) continue;
      cleanEnv[k] = v;
    }
    spawnSync(process.execPath, [bootstrap, 'runtime'], {
      cwd: join(ws, 'skills', 'create-report-package'),
      encoding: 'utf8',
      env: cleanEnv,
    });
  }

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
            ],
          },
        ],
      },
    }),
  );
  // runtime.json with OSS disabled (async should return OSS_PROFILE_UNAVAILABLE).
  await writeFile(
    join(ws, 'toolkit', 'config', 'runtime.json'),
    JSON.stringify({
      config_version: '1',
      http: { host: '127.0.0.1', port: 39080, always_http_200: true },
      execution_strategy: {
        supported_modes: ['sync', 'async'],
        default_mode: 'sync',
        request_field: 'executionMode',
        never_auto_switch_mode: true,
        sync: { enabled: true, query_timeout_seconds: 600, total_timeout_seconds: 900, max_rows_per_sheet: 1048575, max_sheets_per_workbook: 2, max_columns: 16384, max_file_bytes: 2147483648, sheet_overflow: 'split', build_to_temp_file_before_response: true },
        async: { enabled: true, query_timeout_seconds: 3600, worker_concurrency: 2, max_queue_size: 1000, requires_object_storage: true, requires_business_task_integration: true },
      },
      aliyun_oss: { enabled: false, endpoint: '', region: '', bucket: '', access_key_id: '', access_key_secret: '', object_prefix: 'easybi', url_mode: 'signed', signed_url_expires_seconds: 86400 },
      business_task_integration: { enabled: false, base_url: '', create_task: { method: 'POST', path: '/t', timeout_seconds: 10 }, update_task: { method: 'POST', path: '/t/{taskId}', timeout_seconds: 10 }, auth: { type: 'none' } },
      storage: { temp_dir: 'work', output_dir: 'outputs/files' },
    }),
  );

  if (available) {
    const plan = join(ws, 'reports', 'plans', 'driver-basic-detail.json');
    cli(['inspect', '--workspace', ws, '--knowledge', KNOWLEDGE, '--report-id', 'driver-basic-detail', '--out', plan]);
    cli(['approve-plan', '--plan', plan, '--reviewed-by', 't']);
    cli(['generate', '--workspace', ws, '--plan', plan]);
  }

  studio = buildApp({ dbFile: ':memory:', allowedWorkspaceRoots: [root], claude: {} });
  await studio.app.inject({
    method: 'POST',
    url: '/api/easybi/projects',
    payload: { name: 'rtws', workspaceRoot: ws, id: 'rtws' },
  });
});

afterAll(async () => {
  await studio.app.close();
  await rm(root, { recursive: true, force: true });
});

maybe('Runtime supervisor + proxy (no database)', () => {
  it('starts the runtime, proxies list & parameters, async returns OSS error, then stops', async () => {
    const start = await studio.app.inject({ method: 'POST', url: '/api/easybi/projects/rtws/runtime/start' });
    if (start.statusCode !== 200) {
      throw new Error(`runtime start failed: ${start.body}`);
    }
    expect(start.statusCode).toBe(200);
    const info = start.json().data.runtime;
    expect(info.status).toBe('running');
    const pid = info.pid;

    // Proxy: list
    const reports = await studio.app.inject({
      method: 'GET',
      url: '/api/easybi/projects/rtws/runtime/api/v1/reports',
    });
    expect(reports.statusCode).toBe(200);
    expect(reports.headers['content-type']).toContain('application/json');
    expect(reports.body).toContain('driver-basic-detail');

    // Proxy: parameters
    const params = await studio.app.inject({
      method: 'GET',
      url: '/api/easybi/projects/rtws/runtime/api/v1/reports/driver-basic-detail/parameters',
    });
    expect(params.statusCode).toBe(200);
    expect(params.body).toContain('code');

    // Proxy: async export without OSS -> standard HTTP-200 JSON error.
    const asyncExport = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects/rtws/runtime/api/v1/exports',
      payload: { reportId: 'driver-basic-detail', executionMode: 'async', filters: {} },
    });
    expect(asyncExport.statusCode).toBe(200);
    expect(asyncExport.headers['content-type']).toContain('application/json');
    expect(asyncExport.body).toContain('OSS_PROFILE_UNAVAILABLE');

    // Stop and confirm the process is gone.
    const stop = await studio.app.inject({ method: 'POST', url: '/api/easybi/projects/rtws/runtime/stop' });
    expect(stop.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 60_000);

  it('records a static-validation test that is NOT a real export', async () => {
    const res = await studio.app.inject({
      method: 'POST',
      url: '/api/easybi/projects/rtws/report-tests/static',
      payload: { reportId: 'driver-basic-detail', ok: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.test.testType).toBe('STATIC_VALIDATION');

    const list = await studio.app.inject({ method: 'GET', url: '/api/easybi/projects/rtws/report-tests' });
    const types = list.json().data.tests.map((t: { testType: string }) => t.testType);
    expect(types).toContain('STATIC_VALIDATION');
    expect(types).not.toContain('REAL_SYNC_EXPORT');
  });
});
