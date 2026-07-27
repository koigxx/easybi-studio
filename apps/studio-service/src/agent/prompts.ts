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
  'model-report':
    '阅读 skills/create-report-package/SKILL.md，只执行报表建模：根据选中的报表需求和知识库分析结果粒度、表字段、关联关系、关系基数、字段角色、指标去重键、时间和排除口径。' +
    '把所有不清晰事项合并成一个问题写入基础模型后结束当前阶段，不要直接调用交互式提问；Studio 会统一展示且只确认一次。' +
    '本动作只生成唯一当前模型，禁止生成 SQL、脚本或报表包。' +
    COMMON_TAIL +
    '本动作的确认由 Studio 在阶段结束后统一承接，因此不要在 Agent 会话中直接等待用户。',
  'build-report-package':
    '阅读 skills/create-report-package/SKILL.md，只从选中报表已经确认的当前模型生成报表包。' +
    '不得重新分析整个知识库、不得改变字段或关联口径、不得再次发起业务确认；模型不足时输出结构化失败并返回模型修订。' +
    COMMON_TAIL,
  'create-report':
    '这是旧版“构建报表”入口，按“构建报表建模”处理。阅读 skills/create-report-package/SKILL.md，只生成并确认唯一当前报表模型；' +
    '把不清晰事项合并成一个问题，禁止生成 SQL、脚本或报表包。' +
    COMMON_TAIL,
  'modify-report':
    '这是旧版“修改报表”入口，按“构建报表建模”处理。读取当前模型作为参考，重新生成该报表唯一当前模型；' +
    '只提出一个合并确认问题，禁止生成 SQL、脚本或报表包。' +
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
  const phaseBase =
    phase === 'DISCOVERY' || phase === 'MODELING'
      ? 'work/report-model'
      : 'work/report-build';
  const root = reportId && reportRevision
    ? `${phaseBase}/${reportId}/${reportRevision}`
    : `${phaseBase}/<report-id>/<revision>`;
  const common =
    '这是同一前端逻辑对话中的全新 Agent 会话，不得恢复或依赖上一会话内容。' +
    `本阶段报表为 ${reportId ?? '<report-id>'}，阶段目录固定为 ${root}。` +
    '只读取本提示指定的阶段 Context Pack 中 context_manifest 所允许输入；禁止递归读取 knowledge、历史聊天、扫描样本和无关报表。';
  if (phase === 'DISCOVERY') {
    return `${common} 只读取 ${root}/discovery/context.json，在 ${root}/discovery-model.json 中完成基础建模分析。` +
      '必须保留初始化文件的顶层契约：model_format_version 固定为字符串 "1"，report.id/name 不得改名，' +
      'recommended_strategy 只能是 sql、enrichment、group_queries、script 之一；group_transform 是执行步骤而不是策略值。' +
      '按 requirement_intents 和 candidate_sets 为每个指标生成 metric_hypotheses（来源、聚合、条件、去重键、证据、置信度），并生成必要的 relationship_hypotheses。' +
      'selected_tables 只能包含实际采用的来源表，每张表必须至少选择一个 Context Pack 中真实存在的字段；不得加入 excluded/无关表，不得虚构候选字段或关联字段。' +
      '只有未明确的业务口径才写成结构化 open_questions。每个问题必须是 JSON 对象 {id, question, options, recommended, required, affected_metrics, impact}，禁止写成纯字符串。' +
      'id 必须唯一且有语义（如 q_order_semantics），不能为空或重复；options 至少 2 项且每项含 value/label；question 是完整自然语言问题。' +
      '字段是否存在、Context 扩展和执行策略属于技术决策，必须自行验证或推荐，不得向用户提问。' +
      'JSON 字符串值中禁止使用直双引号 " 和中文弯引号 ""，请改用 「」；写完 discovery-model.json 后务必用 python3 -m json.tool 校验一次。' +
      '不要调用交互式提问，也不要等待用户输入，写完产物后结束本阶段。' +
      '不得生成 report-model.json、SQL、脚本或报表包。';
  }
  if (phase === 'MODELING') {
    return `${common} 只读取 ${root}/modeling/context.json，其中包含已生成的 discovery model、带 revision/hash 的 confirmation.json 和最小知识切片，运行确定建模阶段命令，` +
      `生成并校验 ${root}/report-model.json、semantic-plan.json、execution-plan.json 和模型内逐查询 query contracts。` +
      '必须严格沿用 Context Pack 的 model_format_version="1"、report.id/name、input_lock、sources/relationships/query_contracts/output_fields 字段名和四种合法 recommended_strategy；不得自创格式版本或字段名。' +
      'input_lock 必须原样保留。output_fields 必须覆盖每个业务输出字段，并为公式、对比、窗口或跨查询结果关联 calculation_graph 节点；CLI 会据此确定生成路径。' +
      'report-model.json 必须写入 confirmation.discovery_revision 和 confirmation.confirmation_hash，且与 Context Pack 中的统一确认产物完全一致。' +
      `若 recommended_strategy 不是 script，同时生成 ${root}/declarative-configuration.json；不得再提第二轮业务问题，只输出模型摘要，不生成 SQL、report.ts 或报表包。` +
      (userConfirmation ? ' 用户补充说明已经固化在 confirmation.json，不得只依赖本提示文本。' : '');
  }
  if (phase === 'QUERY_COMPILATION') {
    if (strategy && strategy !== 'script') {
      return `${common} 只读取 ${root}/contexts/declarative.json。当前执行策略为 ${strategy}，只校验并完善 ${root}/declarative-configuration.json；不得生成 report.ts 或 script_report。` +
        '配置必须严格使用已批准模型的字段、关系、过滤和聚合口径，不得扩展知识范围。';
    }
    return `${common} 本次只处理查询契约 ${unitId ?? '<query-id>'}，只读取 ${root}/contexts/${unitId ?? '<query-id>'}.json。` +
      `只生成 ${root}/queries/${unitId ?? '<query-id>'}.sql 和 ${root}/query-outputs/${unitId ?? '<query-id>'}.json；SELECT 输出必须逐列显式 AS 为契约列名，不得处理其他查询或编写 report.ts。` +
      '如果模型缺字段，写 failure.json 并停止，不得扩大知识范围。';
  }
  if (phase === 'SCRIPT_COMPILATION') {
    return `${common} 只读取 ${root}/contexts/script.json 中已批准语义/执行计划与 query-output contracts，不读取物理知识库或早期探索记录。` +
      `只编写 ${root}/scripts/report.ts，使用 queryStream/loadIndex/batchLookup/emit；组包、批准与静态校验由 Studio 的确定性门禁执行。` +
      '发现查询输出不匹配时写 failure.json，不得修改业务模型。';
  }
  return `${common} 执行阶段 ${phase}，保持现有审批、只读和安全门禁。`;
}
