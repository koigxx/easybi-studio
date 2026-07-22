import { useEffect, useState } from 'react';
import { Bot, ChevronDown } from 'lucide-react';
import { useAgentDrawer } from '../AgentDrawer.js';
import { promptApi, type PromptPreset } from '../api.js';
import { buildScopedReportPrompt } from './reports-config.js';

/**
 * Toolbar "AI 助手" control: a split button.
 *  - Clicking the main part opens a plain conversation (free-chat) directly.
 *  - Clicking the chevron opens a dropdown of this page's configurable presets
 *    (from config/easy-bi.json → agent_prompts, initialized from skills'
 *    prompts.json). Selecting a preset starts that action.
 * `actions` filters which preset action verbs surface on this page.
 *
 * Selection gating (used by the Reports tab): actions listed in `gateActions`
 * are disabled until a report is selected via `selectedReport`. When a report is
 * selected, the preset prompt is scoped to that single report so the AI builds
 * only that package.
 */
export function AgentQuickStart({
  projectId,
  actions,
  selectedReport,
  gateActions,
}: {
  projectId: string;
  actions: string[];
  /** The currently-selected report, if this page drives a selection. */
  selectedReport?: { id: string; name: string } | null;
  /** Preset actions that require a selected report before they can run. */
  gateActions?: string[];
}): JSX.Element {
  const { startAction, newChat } = useAgentDrawer();
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<PromptPreset[] | null>(null);

  useEffect(() => {
    if (!open || presets) return;
    promptApi
      .get(projectId)
      .then((d) => setPresets(d.presets))
      .catch(() => setPresets([]));
  }, [open, presets, projectId]);

  // Reload when switching workspace.
  useEffect(() => setPresets(null), [projectId]);

  const shown = (presets ?? []).filter((p) => actions.includes(p.action));
  const gated = new Set(gateActions ?? []);

  return (
    <div style={{ position: 'relative' }}>
      <div className="ide-split-btn">
        <button
          className="ide-btn ide-btn-sm ide-btn-primary ide-split-main"
          title="打开对话（直接提问）"
          onClick={() => newChat()}
        >
          <Bot className="w-3.5 h-3.5" />
          AI 助手
        </button>
        <button
          className="ide-btn ide-btn-sm ide-btn-primary ide-split-caret"
          title="使用预置提示词"
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDown className="w-3 h-3" />
        </button>
      </div>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 110 }} onClick={() => setOpen(false)} />
          <div className="agent-quick-menu">
            {presets === null && <div className="chat-empty">加载预置提示词…</div>}
            {presets !== null && shown.length === 0 && (
              <div className="chat-empty">
                没有可用的预置提示词。可在「配置 → AI 提示词」里添加。
              </div>
            )}
            {shown.map((a) => {
              const needsSelection = gated.has(a.action);
              const disabled = needsSelection && !selectedReport;
              const hint = disabled
                ? '请先在下方报表需求列表中选择一张报表'
                : needsSelection && selectedReport
                  ? `将为「${selectedReport.name || selectedReport.id}」生成报表包`
                  : a.hint;
              return (
                <button
                  key={a.action}
                  className="agent-quick-item"
                  disabled={disabled}
                  title={disabled ? '请先选择一张报表' : undefined}
                  onClick={() => {
                    if (disabled) return;
                    setOpen(false);
                    const prompt =
                      needsSelection && selectedReport
                        ? buildScopedReportPrompt(a.prompt, selectedReport)
                        : a.prompt;
                    startAction(projectId, a.action, prompt, selectedReport?.id);
                  }}
                >
                  <span className="aqi-title">
                    {a.label}
                    {a.write && <span className="ide-badge ide-badge-warning">写</span>}
                  </span>
                  {hint && <span className="aqi-hint">{hint}</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
