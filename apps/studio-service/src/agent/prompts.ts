import type { AgentActionType, ReportWorkflowPhase } from '@easybi-studio/contracts';

/**
 * Agent action prompt templates (plan §10.3, §10.4, §12.3).
 *
 * Each template instructs Claude to read the relevant SKILL.md and use the
 * bundled deterministic CLI, follow approval gates, and never touch the
 * canonical source or run DDL/DML. Paths are workspace-relative; Claude runs
 * with cwd = workspace root, so it resolves commands from the installed bundle.
 */
const COMMON_TAIL =
  '严格遵循 SKILL.md 的审核门禁；使用 dist/scripts 下的确定性 CLI；' +
  '数据库只读、禁止 DDL/DML；不要修改 /Users/admin/innos/easy-bi-workspace/easy-bi；' +
  '涉及业务判断（热温冷分层、枚举语义、报表计划、发布）时先输出待确认内容并停下等待用户确认，不要自行批准。';

// Minimal boundary reminder appended to free-form chats (no task template).
const FREE_CHAT_TAIL =
  '\n\n（边界：只读优先，不要执行写操作或 DDL/DML；不要修改 /Users/admin/innos/easy-bi-workspace/easy-bi 正式来源；不要输出数据库密码/密钥/Token。）';

const TEMPLATES: Record<Exclude<AgentActionType, 'free-chat'>, string> = {
  'initialize-knowledge':
    '你在一个 Easy BI 工作区中。请阅读 skills/initialize-report-knowledge/SKILL.md，' +
    '根据 config/easy-bi.json 引导初始化知识库：校验配置、（在获得授权且有连接时）扫描、提出热温冷分层方案。' +
    COMMON_TAIL,
  'continue-knowledge':
    '继续完善当前知识库草稿：处理 reviews/blocking-issues.json 中的阻塞项，完成一次批量语义审阅。' +
    COMMON_TAIL,
  'rescan-knowledge':
    '在获得授权后重新扫描并与上一快照对比，展示新增/删除/变化的表，不覆盖人工语义。' + COMMON_TAIL,
  'review-enums':
    '导出枚举 Excel 候选，说明绑定与值映射的完整性要求，等待用户维护后再干跑导入。' + COMMON_TAIL,
  'publish-knowledge':
    '在语义审阅通过后发布知识库版本到 knowledge/versions，并更新 knowledge/index.json；发布前请输出待确认摘要。' +
    COMMON_TAIL,
  'create-report':
    '阅读 skills/create-report-package/SKILL.md，只执行基础建模阶段：运行 inspect 和 discovery context，' +
    '梳理结果粒度、所需表字段、关系基数、指标去重键、时间与排除口径，写入 report discovery model；' +
    '只提出一个合并确认问题。本阶段禁止生成 SQL、脚本或报表包。' +
    COMMON_TAIL,
  'modify-report':
    '阅读 skills/create-report-package/SKILL.md，只执行已有报表的基础建模阶段：读取现有计划作为参考，' +
    '重新检查结果粒度、字段白名单、关系基数、指标去重键与变更需求，写入新的 discovery model；' +
    '保留旧版本，只提出一个合并确认问题。本阶段禁止生成 SQL、脚本或报表包。' +
    COMMON_TAIL,
  'validate-report':
    '对指定报表包运行静态校验（结构、绑定、参数、校验和），报告问题；不要把静态校验当作真实导出成功。' +
    COMMON_TAIL,
};

export interface BuildPromptOptions {
  /** Free-text note (free-chat: the whole message; others: appended supplement). */
  extra?: string;
  /**
   * Full configured preset prompt (from config.agent_prompts). When provided for
   * a non-free-chat action, it REPLACES the built-in template (the workspace has
   * customized it), while the action verb still drives write-mutex/checkpoint.
   */
  fullPrompt?: string;
}

export function buildActionPrompt(action: AgentActionType, options: BuildPromptOptions = {}): string {
  const { extra, fullPrompt } = options;
  // Free-form chat: send the user's text verbatim (plus a short boundary note),
  // with no preset task template.
  if (action === 'free-chat') {
    return `${(extra ?? fullPrompt ?? '').trim()}${FREE_CHAT_TAIL}`;
  }
  // A configured preset prompt replaces the built-in default template.
  const base = fullPrompt?.trim() ? fullPrompt.trim() : TEMPLATES[action];
  return extra ? `${base}\n\n补充说明：${extra}` : base;
}

export function buildReportPhasePrompt(
  phase: ReportWorkflowPhase,
  userConfirmation?: string,
  reportId?: string,
  reportRevision?: string,
  unitId?: string,
  strategy?: string,
): string {
  const root = reportId && reportRevision
    ? `work/report-build/${reportId}/${reportRevision}`
    : 'work/report-build/<report-id>/<revision>';
  const common =
    '这是同一前端逻辑对话中的全新 Agent 会话，不得恢复或依赖上一会话内容。' +
    `本阶段报表为 ${reportId ?? '<report-id>'}，阶段目录固定为 ${root}。` +
    '只读取阶段目录中 context.json 的 context_manifest 所允许输入；禁止递归读取 knowledge、历史聊天、扫描样本和无关报表。';
  if (phase === 'MODELING') {
    return `${common} 阅读已生成的 discovery model 和用户确认，运行确定建模阶段命令，` +
      `生成并校验 ${root}/report-model.json、semantic-plan.json、execution-plan.json 和模型内逐查询 query contracts。` +
      `若 recommended_strategy 不是 script，同时生成 ${root}/declarative-configuration.json；只输出模型审阅摘要，不生成 SQL、report.ts 或报表包。` +
      (userConfirmation ? ` 用户确认：${userConfirmation}` : '');
  }
  if (phase === 'QUERY_COMPILATION') {
    if (strategy && strategy !== 'script') {
      return `${common} 当前执行策略为 ${strategy}，只校验并完善 ${root}/declarative-configuration.json；不得生成 report.ts 或 script_report。` +
        '配置必须严格使用已批准模型的字段、关系、过滤和聚合口径，不得扩展知识范围。';
    }
    return `${common} 本次只处理查询契约 ${unitId ?? '<query-id>'}，只读取该契约及其精确知识切片。` +
      `只生成 ${root}/queries/${unitId ?? '<query-id>'}.sql 和 ${root}/query-outputs/${unitId ?? '<query-id>'}.json；SELECT 输出必须逐列显式 AS 为契约列名，不得处理其他查询或编写 report.ts。` +
      '如果模型缺字段，写 failure.json 并停止，不得扩大知识范围。';
  }
  if (phase === 'SCRIPT_COMPILATION') {
    return `${common} 只读取已批准语义/执行计划与 query-output contracts，不读取物理知识库或早期探索记录。` +
      `只编写 ${root}/scripts/report.ts，使用 queryStream/loadIndex/batchLookup/emit；组包、批准与静态校验由 Studio 的确定性门禁执行。` +
      '发现查询输出不匹配时写 failure.json，不得修改业务模型。';
  }
  return `${common} 执行阶段 ${phase}，保持现有审批、只读和安全门禁。`;
}
