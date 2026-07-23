import type { FastifyInstance } from 'fastify';
import { ok, fail } from '@easybi-studio/contracts';
import { readConfig, writeConfig, ConfigConflictError } from '@easybi-studio/config-sdk';
import { WorkspaceSkillAdapter, type SkillPromptPreset } from '@easybi-studio/workspace-sdk';
import type { ProjectService } from '../projects/service.js';

const CONFIG_PATH = 'config/easy-bi.json';

/** One configurable preset prompt, as stored under config.agent_prompts.presets. */
interface PromptPreset {
  action: string;
  label: string;
  hint: string;
  write: boolean;
  prompt: string;
  skillId?: string;
}

interface SaveBody {
  presets?: PromptPreset[];
  expectedRevision?: string;
}

const COMPAT_SPLIT_REPORT_PRESETS: PromptPreset[] = [
  {
    action: 'model-report',
    label: '构建报表建模',
    hint: '分析字段和关联关系，把不清晰事项一次统一确认，生成唯一当前模型',
    write: true,
    prompt:
      '阅读 skills/create-report-package/SKILL.md，只执行报表建模。分析结果粒度、来源表字段、关联字段、关系基数、筛选分组和指标口径，把所有不清晰事项整理为一次统一确认；禁止生成 SQL、脚本或报表包。',
    skillId: 'create-report-package',
  },
  {
    action: 'build-report-package',
    label: '生成报表',
    hint: '只使用已确认的当前模型生成唯一当前报表包',
    write: true,
    prompt:
      '阅读 skills/create-report-package/SKILL.md，只从该报表已确认的唯一当前模型生成报表包；不得重新分析知识库、改变字段或关联关系、再次确认业务口径。',
    skillId: 'create-report-package',
  },
];

function toPreset(p: SkillPromptPreset): PromptPreset {
  return {
    action: p.action,
    label: p.label,
    hint: p.hint,
    write: p.write,
    prompt: p.prompt,
    ...(p.skillId ? { skillId: p.skillId } : {}),
  };
}

/** Read config.agent_prompts.presets if present and well-formed. */
function readConfiguredPresets(value: unknown): PromptPreset[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const block = (value as Record<string, unknown>).agent_prompts;
  if (typeof block !== 'object' || block === null) return null;
  const presets = (block as Record<string, unknown>).presets;
  if (!Array.isArray(presets)) return null;
  const out: PromptPreset[] = [];
  for (const p of presets) {
    if (typeof p !== 'object' || p === null) continue;
    const rec = p as Record<string, unknown>;
    if (typeof rec.action !== 'string' || typeof rec.prompt !== 'string') continue;
    out.push({
      action: rec.action,
      label: typeof rec.label === 'string' ? rec.label : rec.action,
      hint: typeof rec.hint === 'string' ? rec.hint : '',
      write: rec.write !== false,
      prompt: rec.prompt,
      ...(typeof rec.skillId === 'string' ? { skillId: rec.skillId } : {}),
    });
  }
  return out;
}

function migrateLegacyReportPresets(
  configured: PromptPreset[],
  defaults: PromptPreset[],
): PromptPreset[] {
  const hasLegacy = configured.some(
    (preset) => preset.action === 'create-report' || preset.action === 'modify-report',
  );
  const hasSplit = configured.some(
    (preset) => preset.action === 'model-report' || preset.action === 'build-report-package',
  );
  if (!hasLegacy || hasSplit) return configured;
  const retained = configured.filter(
    (preset) => preset.action !== 'create-report' && preset.action !== 'modify-report',
  );
  const splitDefaults = defaults.filter(
    (preset) => preset.action === 'model-report' || preset.action === 'build-report-package',
  );
  return [
    ...retained,
    ...(splitDefaults.length === 2 ? splitDefaults : COMPAT_SPLIT_REPORT_PRESETS),
  ];
}

/**
 * Configurable agent preset prompts (per workspace).
 *
 * GET returns the workspace's configured presets from config/easy-bi.json, or —
 * if none are configured yet — the defaults initialized from the installed
 * skills' prompts.json (so a fresh workspace already has sensible presets).
 * PUT saves the edited presets back into the optional `agent_prompts` config
 * block (compatible extension; no config_version change), using the same
 * revision optimistic-lock + atomic write as other config.
 */
export function registerAgentPromptRoutes(app: FastifyInstance, service: ProjectService): void {
  app.get<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/agent-prompts',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));

      const cfg = await readConfig(project.workspaceRoot, CONFIG_PATH).catch(() => null);
      const configured = cfg ? readConfiguredPresets(cfg.value) : null;
      let defaults: PromptPreset[] = [];
      try {
        const adapter = new WorkspaceSkillAdapter(project.workspaceRoot);
        defaults = (await adapter.readSkillPromptPresets()).map(toPreset);
      } catch {
        defaults = [];
      }
      if (configured && configured.length > 0) {
        const presets = migrateLegacyReportPresets(configured, defaults);
        return ok(request.requestId, {
          presets,
          revision: cfg!.revision,
          source: presets === configured ? 'config' : 'config-with-compatible-defaults',
        });
      }

      // Fall back to the installed skills' defaults (not yet persisted).
      return ok(request.requestId, {
        presets: defaults,
        revision: cfg?.revision ?? null,
        source: 'skill-defaults',
      });
    },
  );

  app.put<{ Params: { projectId: string } }>(
    '/api/easybi/projects/:projectId/agent-prompts',
    async (request, reply) => {
      const project = service.get(request.params.projectId);
      if (!project) return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '项目不存在'));
      const body = (request.body ?? {}) as SaveBody;
      if (!Array.isArray(body.presets)) {
        return reply.code(400).send(fail(request.requestId, 'VALIDATION_FAILED', '缺少 presets'));
      }
      // Validate each preset minimally.
      for (const p of body.presets) {
        if (!p || typeof p.action !== 'string' || !p.action.trim()) {
          return reply
            .code(400)
            .send(fail(request.requestId, 'VALIDATION_FAILED', '每个预置提示词需要 action'));
        }
        if (typeof p.prompt !== 'string' || !p.prompt.trim()) {
          return reply
            .code(400)
            .send(fail(request.requestId, 'VALIDATION_FAILED', `预置「${p.action}」缺少提示词内容`));
        }
      }

      const current = await readConfig(project.workspaceRoot, CONFIG_PATH).catch(() => null);
      if (!current) {
        return reply.code(404).send(fail(request.requestId, 'NOT_FOUND', '工作区配置不存在'));
      }
      const base = (typeof current.value === 'object' && current.value !== null
        ? { ...(current.value as Record<string, unknown>) }
        : {}) as Record<string, unknown>;
      // Only touch the agent_prompts block; preserve every other field + unknown keys.
      const normalized = body.presets.map((p) => ({
        action: p.action,
        label: typeof p.label === 'string' && p.label ? p.label : p.action,
        hint: typeof p.hint === 'string' ? p.hint : '',
        write: p.write !== false,
        prompt: p.prompt,
        ...(typeof p.skillId === 'string' ? { skillId: p.skillId } : {}),
      }));
      base.agent_prompts = { schema_version: '1', presets: normalized };

      try {
        const res = await writeConfig({
          workspaceRoot: project.workspaceRoot,
          relativePath: CONFIG_PATH,
          value: base,
          expectedRevision: body.expectedRevision ?? current.revision,
          backupDir: 'work/config-backups',
        });
        return ok(request.requestId, { presets: normalized, revision: res.revision });
      } catch (err) {
        if (err instanceof ConfigConflictError) {
          return reply.code(409).send(fail(request.requestId, err.code, err.message));
        }
        throw err;
      }
    },
  );
}
