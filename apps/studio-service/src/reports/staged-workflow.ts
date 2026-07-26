import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { WorkspaceSkillAdapter, resolveWithinWorkspace } from '@easybi-studio/workspace-sdk';
import type { ReportPhaseHookInput, ReportPhaseHookResult } from '@easybi-studio/job-manager';

const REPORT_SKILL_ID = 'create-report-package';
const REPORT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
}

export class StagedReportWorkflow {
  constructor(
    private readonly nodePath = process.execPath,
    private readonly timeoutMs = 120_000,
  ) {}

  async ensureCapabilities(input: ReportPhaseHookInput): Promise<ReportPhaseHookResult> {
    const result = await this.run(input.workspaceRoot, ['doctor']);
    return result.code === 0 && result.json?.staged_workflow_version === 2
      ? { ok: true }
      : { ok: false, error: '当前工作区 Skill bundle 不支持 revision 隔离、逐查询 Agent 和原子发布。请显式升级该工作区后重试。' };
  }

  async prepare(input: ReportPhaseHookInput): Promise<ReportPhaseHookResult> {
    if (input.phase !== 'QUERY_COMPILATION') return { ok: true };
    const paths = this.paths(input.workspaceRoot, input.reportId, input.reportRevision);
    const result = await this.run(input.workspaceRoot, [
      'approve-staged-model',
      '--plan', paths.plan,
      '--root', paths.root,
      '--reviewed-by', input.reviewedBy ?? 'local-user',
    ]);
    return this.toHookResult(result);
  }

  async complete(input: ReportPhaseHookInput): Promise<ReportPhaseHookResult> {
    const paths = this.paths(input.workspaceRoot, input.reportId, input.reportRevision);
    const phase = input.phase === 'DISCOVERY'
      ? 'discovery'
      : input.phase === 'MODELING'
        ? 'modeling'
        : input.phase === 'QUERY_COMPILATION'
          ? 'query'
          : input.phase === 'SCRIPT_COMPILATION'
            ? 'script'
            : undefined;
    if (!phase) return { ok: true };
    const finalize = phase === 'script' || (phase === 'query' && input.strategy !== 'script');
    const args = finalize
      ? [
          'finalize-staged',
          '--workspace', input.workspaceRoot,
          '--plan', paths.plan,
          '--root', paths.root,
          '--reviewed-by', input.reviewedBy ?? 'local-user',
        ]
      : [
          'validate-stage',
          '--phase', phase,
          '--plan', paths.plan,
          '--root', paths.root,
          ...(phase === 'query' ? ['--require-approved-model', 'true'] : []),
          ...(phase === 'query' && input.unitId ? ['--query-id', input.unitId] : []),
        ];
    const result = this.toHookResult(await this.run(input.workspaceRoot, args));
    if (result.ok && finalize) result.details = { ...(result.details ?? {}), workflow_complete: true };
    return result;
  }

  private paths(workspaceRoot: string, reportId: string, revision: string): { plan: string; root: string } {
    if (!REPORT_ID_RE.test(reportId)) throw new Error(`非法 reportId：${reportId}`);
    if (!REPORT_ID_RE.test(revision)) throw new Error(`非法构建修订号：${revision}`);
    return {
      plan: resolveWithinWorkspace(workspaceRoot, join('reports', 'plans', `${reportId}.json`)),
      root: resolveWithinWorkspace(workspaceRoot, join('work', 'report-build', reportId, revision)),
    };
  }

  private toHookResult(result: CliResult): ReportPhaseHookResult {
    const ok = result.code === 0 && result.json?.ok !== false;
    return {
      ok,
      ...(typeof result.json?.model_hash === 'string' ? { modelHash: result.json.model_hash } : {}),
      ...(result.json ? { details: result.json } : {}),
      ...(!ok ? { error: this.errorMessage(result) } : {}),
    };
  }

  private errorMessage(result: CliResult): string {
    const errors = result.json?.errors;
    if (Array.isArray(errors) && errors.length) return errors.map(String).join('；');
    return result.stderr.trim() || result.stdout.trim() || `报表阶段 CLI 退出码 ${String(result.code)}`;
  }

  private async run(workspaceRoot: string, args: string[]): Promise<CliResult> {
    const adapter = new WorkspaceSkillAdapter(workspaceRoot);
    const cliPath = await adapter.resolveCommand(REPORT_SKILL_ID, 'package_cli');
    const cwd = dirname(dirname(cliPath));
    return new Promise<CliResult>((resolve) => {
      const child = spawn(this.nodePath, [cliPath, ...args], {
        cwd,
        shell: false,
        env: process.env,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), this.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: error.message, json: null });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        let json: Record<string, unknown> | null = null;
        try {
          json = JSON.parse(stdout) as Record<string, unknown>;
        } catch {
          json = null;
        }
        resolve({ code, stdout, stderr, json });
      });
    });
  }
}
