import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StagedReportWorkflow } from './staged-workflow.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fakeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'easybi-staged-runner-'));
  roots.push(root);
  const cli = join(
    root,
    'skills',
    'create-report-package',
    'dist',
    'scripts',
    'report-package-cli.js',
  );
  await mkdir(join(root, 'skills', 'create-report-package', 'dist', 'scripts'), {
    recursive: true,
  });
  await mkdir(join(root, 'knowledge', 'drafts', 'draft-1'), { recursive: true });
  await mkdir(join(root, 'knowledge', 'versions'), { recursive: true });
  await mkdir(join(root, 'reports', 'plans'), { recursive: true });
  await mkdir(join(root, 'reports', 'models'), { recursive: true });
  await mkdir(join(root, 'work'), { recursive: true });
  await writeFile(
    join(root, 'knowledge', 'index.json'),
    JSON.stringify({ current_version: null, versions: [] }),
  );
  await writeFile(
    join(root, 'skills', 'bundle.manifest.json'),
    JSON.stringify({
      skills: [
        {
          id: 'create-report-package',
          commands: {
            package_cli: 'create-report-package/dist/scripts/report-package-cli.js',
          },
        },
      ],
      workspace_contract: {
        paths: {
          report_plans: 'reports/plans',
          report_models: 'reports/models',
          work: 'work',
          knowledge_index: 'knowledge/index.json',
          knowledge_versions: 'knowledge/versions',
          knowledge_drafts: 'knowledge/drafts',
        },
      },
    }),
  );
  await writeFile(
    cli,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const command = process.argv[2];",
      "fs.appendFileSync(path.join(process.cwd(), 'cli.log'), JSON.stringify({ command, args: process.argv.slice(3) }) + '\\n');",
      "const payload = { ok: true, command, args: process.argv.slice(3), staged_workflow_version: 3 };",
      "if (command === 'validate-stage' && process.argv.includes('discovery')) payload.confirmation = { questions: [] };",
      "if (command === 'finalize-staged-model') payload.model_hash = 'model-hash';",
      "if (command === 'finalize-staged') payload.package = 'reports/packages/r1/0.1.0-draft';",
      "console.log(JSON.stringify(payload));",
    ].join('\n'),
  );
  return root;
}

async function commands(root: string): Promise<Array<{ command: string; args: string[] }>> {
  return (await readFile(join(root, 'cli.log'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { command: string; args: string[] });
}

describe('StagedReportWorkflow', () => {
  it('prepares discovery deterministically under work/report-model', async () => {
    const workspaceRoot = await fakeWorkspace();
    const workflow = new StagedReportWorkflow();
    await expect(
      workflow.ensureCapabilities({
        projectId: 'p',
        workspaceRoot,
        reportId: 'customer-volume',
        reportRevision: 'rev-1',
        phase: 'DISCOVERY',
      }),
    ).resolves.toEqual({ ok: true });
    const calls = await commands(workspaceRoot);
    expect(calls.map((call) => call.command)).toEqual([
      'doctor',
      'inspect',
      'init-model',
      'build-phase-context',
    ]);
    expect(calls[2]!.args).toContain(
      join(
        workspaceRoot,
        'work',
        'report-model',
        'customer-volume',
        'rev-1',
        'discovery-model.json',
      ),
    );
  });

  it('validates discovery and finalizes modeling into the current model package', async () => {
    const workspaceRoot = await fakeWorkspace();
    const workflow = new StagedReportWorkflow();
    const base = {
      projectId: 'p',
      workspaceRoot,
      reportId: 'customer-volume',
      reportRevision: 'rev-1',
    };
    const discovered = await workflow.complete({ ...base, phase: 'DISCOVERY' });
    expect(discovered).toMatchObject({
      ok: true,
      details: { model_confirmation: { questions: [] } },
    });
    const modeled = await workflow.complete({
      ...base,
      phase: 'MODELING',
      reviewedBy: 'reviewer',
    });
    expect(modeled).toMatchObject({
      ok: true,
      modelHash: 'model-hash',
      details: { workflow_complete: true },
    });
    const calls = await commands(workspaceRoot);
    const finalized = calls.find((call) => call.command === 'finalize-staged-model');
    expect(finalized?.args).toContain(
      join(workspaceRoot, 'work', 'report-model', 'customer-volume', 'rev-1'),
    );
    expect(finalized?.args).toContain(
      join(workspaceRoot, 'reports', 'models', 'customer-volume'),
    );
  });

  it('copies an approved current model and prepares script query compilation', async () => {
    const workspaceRoot = await fakeWorkspace();
    const current = join(workspaceRoot, 'reports', 'models', 'customer-volume');
    await mkdir(current, { recursive: true });
    await writeFile(
      join(current, 'report-model.json'),
      JSON.stringify({
        recommended_strategy: 'script',
        approval: { model_hash: 'model-hash' },
        query_contracts: [{ id: 'q1' }, { id: 'q2' }],
      }),
    );
    const workflow = new StagedReportWorkflow();
    const prepared = await workflow.ensureCapabilities({
      projectId: 'p',
      workspaceRoot,
      reportId: 'customer-volume',
      reportRevision: 'rev-1',
      phase: 'QUERY_COMPILATION',
    });
    expect(prepared).toMatchObject({
      ok: true,
      modelHash: 'model-hash',
      details: { strategy: 'script', query_ids: ['q1', 'q2'] },
    });
    await expect(
      readFile(
        join(
          workspaceRoot,
          'work',
          'report-build',
          'customer-volume',
          'rev-1',
          'report-model.json',
        ),
        'utf8',
      ),
    ).resolves.toContain('"recommended_strategy":"script"');
  });

  it('rejects a report id that could escape the staged artifact directory', async () => {
    const workspaceRoot = await fakeWorkspace();
    const workflow = new StagedReportWorkflow();
    await expect(
      workflow.complete({
        projectId: 'p',
        workspaceRoot,
        reportId: '../escape',
        reportRevision: 'rev-1',
        phase: 'DISCOVERY',
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/非法报表 ID/) });
  });
});
