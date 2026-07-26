import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
  const cli = join(root, 'skills', 'create-report-package', 'dist', 'scripts', 'report-package-cli.js');
  await mkdir(join(root, 'skills', 'create-report-package', 'dist', 'scripts'), { recursive: true });
  await writeFile(join(root, 'skills', 'bundle.manifest.json'), JSON.stringify({
    skills: [{
      id: 'create-report-package',
      commands: { package_cli: 'create-report-package/dist/scripts/report-package-cli.js' },
    }],
    workspace_contract: { paths: {} },
  }));
  await writeFile(cli, [
    "const command = process.argv[2];",
    "const payload = { ok: true, command, args: process.argv.slice(3), staged_workflow_version: 2 };",
    "if (command === 'approve-staged-model') { payload.model_hash = 'model-hash'; payload.strategy = 'script'; payload.query_ids = ['q1']; }",
    "console.log(JSON.stringify(payload));",
  ].join('\n'));
  return root;
}

describe('StagedReportWorkflow', () => {
  it('checks staged workflow commands before the first Agent starts', async () => {
    const workspaceRoot = await fakeWorkspace();
    const workflow = new StagedReportWorkflow();
    await expect(workflow.ensureCapabilities({
      projectId: 'p', workspaceRoot, reportId: 'customer-volume', reportRevision: 'rev-1', phase: 'DISCOVERY',
    })).resolves.toEqual({ ok: true });
  });

  it('approves before query compilation and finalizes after script compilation', async () => {
    const workspaceRoot = await fakeWorkspace();
    const workflow = new StagedReportWorkflow();
    const base = { projectId: 'p', workspaceRoot, reportId: 'customer-volume', reportRevision: 'rev-1' };
    const prepared = await workflow.prepare({ ...base, phase: 'QUERY_COMPILATION' });
    expect(prepared).toMatchObject({ ok: true, modelHash: 'model-hash' });
    expect(prepared.details?.command).toBe('approve-staged-model');
    expect(prepared.details?.args).toContain(join(workspaceRoot, 'work', 'report-build', 'customer-volume', 'rev-1'));
    const completed = await workflow.complete({ ...base, phase: 'SCRIPT_COMPILATION' });
    expect(completed.ok).toBe(true);
    expect(completed.details?.command).toBe('finalize-staged');
  });

  it('rejects a report id that could escape the staged artifact directory', async () => {
    const workspaceRoot = await fakeWorkspace();
    const workflow = new StagedReportWorkflow();
    await expect(workflow.complete({
      projectId: 'p',
      workspaceRoot,
      reportId: '../escape',
      reportRevision: 'rev-1',
      phase: 'DISCOVERY',
    })).rejects.toThrow(/非法 reportId/);
  });
});
