import type { AgentActionType } from '@easybi-studio/contracts';

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
    '阅读 skills/create-report-package/SKILL.md，根据 knowledge.report_requirements 生成报表计划；' +
    '仅在有阻塞或缺失业务逻辑时提出一个合并问题，批准后生成报表包并静态校验。' +
    COMMON_TAIL,
  'modify-report':
    '修改一个已有报表：重新检查需求与知识库，选择新语义版本，生成新版本目录，保留旧版本。' + COMMON_TAIL,
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
