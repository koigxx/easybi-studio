import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ReportPhaseHookInput,
  ReportPhaseHookResult,
} from '@easybi-studio/job-manager';
import { WorkspaceSkillAdapter } from '@easybi-studio/workspace-sdk';

const REPORT_SKILL_ID = 'create-report-package';
const SAFE_REPORT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface CliResult {
  ok: boolean;
  json: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
  code: number | null;
}

interface WorkflowPaths {
  cli: string;
  plan: string;
  currentModel: string;
  modelStage: string;
  buildStage: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function cliError(result: CliResult, fallback: string): string {
  const value = result.json?.error;
  if (typeof value === 'string' && value.trim()) return value;
  const errors = result.json?.errors;
  if (Array.isArray(errors) && errors.length) return errors.map(String).join('；');
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

async function resolvePaths(input: ReportPhaseHookInput): Promise<WorkflowPaths> {
  if (!SAFE_REPORT_ID.test(input.reportId)) {
    throw new Error(`非法报表 ID：${input.reportId}`);
  }
  if (!SAFE_REPORT_ID.test(input.reportRevision)) {
    throw new Error(`非法构建修订号：${input.reportRevision}`);
  }
  const adapter = new WorkspaceSkillAdapter(input.workspaceRoot);
  const [cli, reportPlans, reportModels, work] = await Promise.all([
    adapter.resolveCommand(REPORT_SKILL_ID, 'package_cli'),
    adapter.resolveLogicalPath('report_plans'),
    adapter.resolveLogicalPath('report_models'),
    adapter.resolveLogicalPath('work'),
  ]);
  return {
    cli,
    plan: join(reportPlans, `${input.reportId}.json`),
    currentModel: join(reportModels, input.reportId),
    modelStage: join(work, 'report-model', input.reportId, input.reportRevision),
    buildStage: join(work, 'report-build', input.reportId, input.reportRevision),
  };
}

async function latestKnowledgePath(workspaceRoot: string): Promise<string> {
  const adapter = new WorkspaceSkillAdapter(workspaceRoot);
  const [indexPath, versionsPath, draftsPath] = await Promise.all([
    adapter.resolveLogicalPath('knowledge_index'),
    adapter.resolveLogicalPath('knowledge_versions'),
    adapter.resolveLogicalPath('knowledge_drafts'),
  ]);
  try {
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
      current_version?: unknown;
    };
    if (typeof index.current_version === 'string' && index.current_version.trim()) {
      const current = join(versionsPath, index.current_version);
      if (await exists(current)) return current;
    }
  } catch {
    // Fall back to the newest editable draft.
  }
  const drafts = (await readdir(draftsPath, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const latest = drafts[drafts.length - 1];
  if (!latest) throw new Error('没有可用于报表建模的知识库版本或草稿');
  return join(draftsPath, latest);
}

async function readModel(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(path, 'report-model.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function modelStrategy(model: Record<string, unknown>): string {
  const strategy = String(model.recommended_strategy ?? '');
  if (!['sql', 'enrichment', 'group_queries', 'script'].includes(strategy)) {
    throw new Error(`模型执行策略无效：${strategy || '未设置'}`);
  }
  return strategy;
}

function modelQueryIds(model: Record<string, unknown>, strategy: string): string[] {
  if (strategy !== 'script') return ['declarative'];
  const contracts = Array.isArray(model.query_contracts) ? model.query_contracts : [];
  const ids = contracts
    .map((value) =>
      value && typeof value === 'object'
        ? String((value as Record<string, unknown>).id ?? '')
        : '',
    )
    .filter(Boolean);
  if (!ids.length) throw new Error('已确认模型没有查询契约');
  return ids;
}

export class StagedReportWorkflow {
  constructor(
    private readonly nodePath = process.execPath,
    private readonly timeoutMs = 120_000,
  ) {}

  async ensureCapabilities(input: ReportPhaseHookInput): Promise<ReportPhaseHookResult> {
    try {
      const paths = await resolvePaths(input);
      const doctor = await this.run(input.workspaceRoot, paths.cli, ['doctor']);
      if (!doctor.ok || Number(doctor.json?.staged_workflow_version ?? 0) < 3) {
        return {
          ok: false,
          error: '当前工作区的报表 Skill 不支持独立模型流程，请先显式升级工作区 Skill',
        };
      }

      if (input.phase === 'DISCOVERY') {
        const knowledge = await latestKnowledgePath(input.workspaceRoot);
        await rm(paths.modelStage, { recursive: true, force: true });
        await mkdir(paths.modelStage, { recursive: true });
        const inspect = await this.run(input.workspaceRoot, paths.cli, [
          'inspect',
          '--workspace',
          input.workspaceRoot,
          '--knowledge',
          knowledge,
          '--report-id',
          input.reportId,
          '--out',
          paths.plan,
        ]);
        if (!inspect.ok) {
          return { ok: false, error: cliError(inspect, '生成报表计划失败') };
        }
        const init = await this.run(input.workspaceRoot, paths.cli, [
          'init-model',
          '--plan',
          paths.plan,
          '--out',
          join(paths.modelStage, 'discovery-model.json'),
        ]);
        if (!init.ok) return { ok: false, error: cliError(init, '初始化报表模型失败') };
        const context = await this.run(input.workspaceRoot, paths.cli, [
          'build-phase-context',
          '--phase',
          'discovery',
          '--plan',
          paths.plan,
          '--out',
          join(paths.modelStage, 'discovery', 'context.json'),
        ]);
        if (!context.ok) {
          return { ok: false, error: cliError(context, '生成基础建模上下文失败') };
        }
        return { ok: true };
      }

      if (input.phase === 'QUERY_COMPILATION') {
        const validation = await this.run(input.workspaceRoot, paths.cli, [
          'validate-model',
          '--model',
          join(paths.currentModel, 'report-model.json'),
          '--require-approved',
          'true',
        ]);
        if (!validation.ok) {
          return {
            ok: false,
            error: `当前报表模型不可用于生成：${cliError(validation, '模型校验失败')}`,
          };
        }
        await rm(paths.buildStage, { recursive: true, force: true });
        await mkdir(paths.buildStage, { recursive: true });
        await cp(paths.currentModel, paths.buildStage, { recursive: true });
        const model = await readModel(paths.buildStage);
        const strategy = modelStrategy(model);
        const queryIds = modelQueryIds(model, strategy);
        await this.buildQueryContext(input, paths, queryIds[0]!, strategy);
        return {
          ok: true,
          modelHash:
            typeof (model.approval as Record<string, unknown> | undefined)?.model_hash === 'string'
              ? String((model.approval as Record<string, unknown>).model_hash)
              : undefined,
          details: { strategy, query_ids: queryIds },
        };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String((error as Error).message ?? error) };
    }
  }

  async prepare(input: ReportPhaseHookInput): Promise<ReportPhaseHookResult> {
    try {
      const paths = await resolvePaths(input);
      if (input.phase === 'MODELING') {
        const confirmationInput = join(paths.modelStage, 'confirmation-input.json');
        await writeFile(
          confirmationInput,
          `${JSON.stringify(
            input.modelConfirmation ?? {
              accept_recommended: true,
              note: input.userConfirmation ?? '',
              answers: {},
            },
            null,
            2,
          )}\n`,
          'utf8',
        );
        const confirmation = await this.run(input.workspaceRoot, paths.cli, [
          'confirm-discovery',
          '--model',
          join(paths.modelStage, 'discovery-model.json'),
          '--input',
          confirmationInput,
          '--out',
          join(paths.modelStage, 'confirmation.json'),
          '--reviewed-by',
          input.reviewedBy ?? 'local-user',
        ]);
        if (!confirmation.ok) {
          return { ok: false, error: cliError(confirmation, '保存统一确认结果失败') };
        }
        await mkdir(join(paths.modelStage, 'modeling'), { recursive: true });
        const context = await this.run(input.workspaceRoot, paths.cli, [
          'build-phase-context',
          '--phase',
          'modeling',
          '--plan',
          paths.plan,
          '--model',
          join(paths.modelStage, 'discovery-model.json'),
          '--confirmation',
          join(paths.modelStage, 'confirmation.json'),
          '--out',
          join(paths.modelStage, 'modeling', 'context.json'),
        ]);
        if (!context.ok) {
          return { ok: false, error: cliError(context, '生成确定建模上下文失败') };
        }
        return { ok: true };
      }
      if (input.phase === 'QUERY_COMPILATION') {
        if (!input.unitId || !input.strategy) {
          return { ok: false, error: '查询编译缺少模型策略或查询契约 ID' };
        }
        await this.buildQueryContext(input, paths, input.unitId, input.strategy);
        return { ok: true };
      }
      if (input.phase === 'SCRIPT_COMPILATION') {
        const context = await this.run(input.workspaceRoot, paths.cli, [
          'build-phase-context',
          '--phase',
          'script',
          '--plan',
          paths.plan,
          '--model',
          join(paths.buildStage, 'report-model.json'),
          '--query-outputs',
          join(paths.buildStage, 'query-outputs'),
          '--out',
          join(paths.buildStage, 'contexts', 'script.json'),
        ]);
        if (!context.ok) {
          return { ok: false, error: cliError(context, '生成脚本编译上下文失败') };
        }
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String((error as Error).message ?? error) };
    }
  }

  async complete(input: ReportPhaseHookInput): Promise<ReportPhaseHookResult> {
    try {
      const paths = await resolvePaths(input);
      if (input.phase === 'DISCOVERY') {
        const validation = await this.run(input.workspaceRoot, paths.cli, [
          'validate-stage',
          '--phase',
          'discovery',
          '--plan',
          paths.plan,
          '--root',
          paths.modelStage,
        ]);
        return validation.ok
          ? {
              ok: true,
              details:
                validation.json?.confirmation &&
                typeof validation.json.confirmation === 'object'
                  ? { model_confirmation: validation.json.confirmation }
                  : undefined,
            }
          : { ok: false, error: cliError(validation, '基础模型校验失败') };
      }

      if (input.phase === 'MODELING') {
        const finalized = await this.run(input.workspaceRoot, paths.cli, [
          'finalize-staged-model',
          '--plan',
          paths.plan,
          '--root',
          paths.modelStage,
          '--out',
          paths.currentModel,
          '--reviewed-by',
          input.reviewedBy ?? 'local-user',
        ]);
        if (!finalized.ok) {
          return { ok: false, error: cliError(finalized, '确认报表模型失败') };
        }
        return {
          ok: true,
          modelHash:
            typeof finalized.json?.model_hash === 'string'
              ? finalized.json.model_hash
              : undefined,
          details: {
            workflow_complete: true,
            model: paths.currentModel,
          },
        };
      }

      if (input.phase === 'QUERY_COMPILATION') {
        const validation = await this.run(input.workspaceRoot, paths.cli, [
          'validate-stage',
          '--phase',
          'query',
          '--plan',
          paths.plan,
          '--root',
          paths.buildStage,
          ...(input.strategy === 'script' && input.unitId
            ? ['--query-id', input.unitId]
            : []),
          '--require-approved-model',
          'true',
        ]);
        if (!validation.ok) {
          return { ok: false, error: cliError(validation, '查询编译产物校验失败') };
        }
        if (input.strategy !== 'script') {
          return this.finalizeReportPackage(input, paths);
        }
        return { ok: true };
      }

      if (input.phase === 'SCRIPT_COMPILATION') {
        const validation = await this.run(input.workspaceRoot, paths.cli, [
          'validate-stage',
          '--phase',
          'script',
          '--plan',
          paths.plan,
          '--root',
          paths.buildStage,
          '--require-approved-model',
          'true',
        ]);
        if (!validation.ok) {
          return { ok: false, error: cliError(validation, '脚本编译产物校验失败') };
        }
        return this.finalizeReportPackage(input, paths);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String((error as Error).message ?? error) };
    }
  }

  private async buildQueryContext(
    input: ReportPhaseHookInput,
    paths: WorkflowPaths,
    queryId: string,
    strategy: string,
  ): Promise<void> {
    await mkdir(join(paths.buildStage, 'contexts'), { recursive: true });
    if (strategy !== 'script') {
      const [model, semanticPlan, executionPlan, configuration, sourceLock] =
        await Promise.all([
          readModel(paths.buildStage),
          readFile(join(paths.buildStage, 'semantic-plan.json'), 'utf8').then(JSON.parse),
          readFile(join(paths.buildStage, 'execution-plan.json'), 'utf8').then(JSON.parse),
          readFile(join(paths.buildStage, 'declarative-configuration.json'), 'utf8').then(
            JSON.parse,
          ),
          readFile(join(paths.buildStage, 'source.lock.json'), 'utf8').then(JSON.parse),
        ]);
      await writeFile(
        join(paths.buildStage, 'contexts', 'declarative.json'),
        `${JSON.stringify(
          {
            context_manifest: {
              context_format_version: '1',
              phase: 'query',
              fresh_session: true,
              forbidden_inputs: ['knowledge', '连接配置', '历史聊天', '无关报表'],
              expected_outputs: ['declarative-configuration.json'],
            },
            payload: {
              report_model: model,
              semantic_plan: semanticPlan,
              execution_plan: executionPlan,
              declarative_configuration: configuration,
              source_lock: sourceLock,
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      return;
    }
    const result = await this.run(input.workspaceRoot, paths.cli, [
      'build-phase-context',
      '--phase',
      'query',
      '--plan',
      paths.plan,
      '--model',
      join(paths.buildStage, 'report-model.json'),
      '--query-id',
      queryId,
      '--out',
      join(paths.buildStage, 'contexts', `${queryId}.json`),
    ]);
    if (!result.ok) {
      throw new Error(cliError(result, `无法构建查询 ${queryId} 的上下文`));
    }
  }

  private async finalizeReportPackage(
    input: ReportPhaseHookInput,
    paths: WorkflowPaths,
  ): Promise<ReportPhaseHookResult> {
    const result = await this.run(input.workspaceRoot, paths.cli, [
      'finalize-staged',
      '--workspace',
      input.workspaceRoot,
      '--plan',
      paths.plan,
      '--root',
      paths.buildStage,
      '--reviewed-by',
      input.reviewedBy ?? 'local-user',
    ]);
    if (!result.ok) {
      return { ok: false, error: cliError(result, '报表包组装失败') };
    }
    return {
      ok: true,
      details: {
        workflow_complete: true,
        package: typeof result.json?.package === 'string' ? result.json.package : '',
        strategy: input.strategy,
      },
    };
  }

  private run(workspaceRoot: string, cliPath: string, args: string[]): Promise<CliResult> {
    return new Promise<CliResult>((resolve) => {
      const child = spawn(this.nodePath, [cliPath, ...args], {
        cwd: workspaceRoot,
        shell: false,
        env: process.env,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (value: CliResult): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timer = setTimeout(() => child.kill('SIGKILL'), this.timeoutMs);
      child.stdout.on('data', (data: Buffer) => (stdout += data.toString()));
      child.stderr.on('data', (data: Buffer) => (stderr += data.toString()));
      child.on('error', (error) => {
        clearTimeout(timer);
        finish({
          ok: false,
          json: null,
          stdout,
          stderr: String(error.message ?? error),
          code: null,
        });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        let json: Record<string, unknown> | null = null;
        try {
          const parsed = JSON.parse(stdout) as unknown;
          if (parsed && typeof parsed === 'object') {
            json = parsed as Record<string, unknown>;
          }
        } catch {
          json = null;
        }
        const jsonOk = json && 'ok' in json ? json.ok === true : code === 0;
        finish({ ok: code === 0 && jsonOk, json, stdout, stderr, code });
      });
    });
  }
}
