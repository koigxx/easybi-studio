import { useCallback, useEffect, useState } from 'react';
import { Save, Plus, Trash2, RotateCcw, ChevronRight } from 'lucide-react';
import { promptApi, type Project, type PromptPreset } from '../api.js';
import { ErrorBanner, Loading } from '../components/ui/common.js';

/**
 * Editor for the workspace's configurable AI preset prompts (config.agent_prompts).
 * Loads the configured presets, or the skill defaults if none are saved yet, and
 * saves edits back to config/easy-bi.json (revision optimistic-lock). The drawer
 * quick-start reads these; editing here changes what actions appear and what
 * prompt text each sends.
 */
export function PromptsEditor({ project }: { project: Project }): JSX.Element {
  const [presets, setPresets] = useState<PromptPreset[] | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [source, setSource] = useState<'config' | 'skill-defaults' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setStatus(null);
    setPresets(null);
    try {
      const d = await promptApi.get(project.id);
      setPresets(d.presets);
      setRevision(d.revision);
      setSource(d.source);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  function update(i: number, patch: Partial<PromptPreset>): void {
    setPresets((ps) => (ps ? ps.map((p, idx) => (idx === i ? { ...p, ...patch } : p)) : ps));
  }
  function remove(i: number): void {
    setPresets((ps) => (ps ? ps.filter((_, idx) => idx !== i) : ps));
  }
  function add(): void {
    setPresets((ps) => {
      const next = [
        ...(ps ?? []),
        { action: '', label: '', hint: '', write: true, prompt: '' },
      ];
      setExpandedIndex(next.length - 1);
      return next;
    });
  }

  async function save(): Promise<void> {
    if (!presets) return;
    setError(null);
    setStatus(null);
    for (const p of presets) {
      if (!p.action.trim()) return setError('每个预置需要一个动作标识（action）');
      if (!p.prompt.trim()) return setError(`预置「${p.label || p.action}」缺少提示词内容`);
    }
    setSaving(true);
    try {
      const r = await promptApi.save(project.id, presets, revision);
      setRevision(r.revision);
      setSource('config');
      setStatus('已保存（写入 config/easy-bi.json，已备份上一版本）');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  }

  if (presets === null && !error) return <Loading text="加载预置提示词…" />;

  return (
    <div style={{ maxWidth: 900 }}>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div style={{ fontSize: 12, color: 'var(--ide-text-tertiary)', marginBottom: 10 }}>
        这些预置提示词出现在知识库/报表页的「AI 助手」下拉里。
        {source === 'skill-defaults'
          ? '当前为技能包默认值（尚未保存到本工作区）——保存后即成为本工作区的定制。'
          : '当前为本工作区已保存的配置。'}
      </div>

      {(presets ?? []).map((p, i) => {
        const isExpanded = expandedIndex === i;
        return (
        <div key={i} className="ide-card" style={{ marginBottom: 8, cursor: 'pointer', padding: 12 }} onClick={() => setExpandedIndex(isExpanded ? null : i)}>
          {/* Summary row — always visible */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <ChevronRight
              className="w-3.5 h-3.5"
              style={{
                color: 'var(--ide-text-tertiary)',
                flexShrink: 0,
                transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.15s',
              }}
            />
            <span className="ide-text-mono" style={{ fontSize: 12, color: 'var(--ide-text-tertiary)', flexShrink: 0, minWidth: 140 }}>
              {p.action || '（未设置 action）'}
            </span>
            <span style={{ fontSize: 12.5, flex: 1 }}>
              {p.label || <span style={{ color: 'var(--ide-text-tertiary)' }}>（未命名）</span>}
            </span>
            {p.hint && (
              <span style={{ fontSize: 11.5, color: 'var(--ide-text-secondary)', flex: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.hint}
              </span>
            )}
            {p.write && <span className="ide-badge ide-badge-warning" style={{ flexShrink: 0 }}>写</span>}
            {p.skillId && (
              <span style={{ fontSize: 11, color: 'var(--ide-text-tertiary)', flexShrink: 0 }}>
                {p.skillId}
              </span>
            )}
            <button
              className="ide-btn ide-btn-sm ide-btn-ghost"
              title="删除该预置"
              onClick={(e) => { e.stopPropagation(); remove(i); }}
              style={{ flexShrink: 0 }}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Expanded detail — only shown when clicked */}
          {isExpanded && (
            <>
              <div style={{ height: 1, backgroundColor: 'var(--ide-border-subtle)', margin: '10px 0' }} />
              <div style={{ display: 'grid', gap: 8 }} onClick={(e) => e.stopPropagation()}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <label style={{ flex: 1, fontSize: 12 }}>
                    <div className="ide-label">动作标识 action</div>
                    <input
                      className="ide-input"
                      value={p.action}
                      placeholder="如 initialize-knowledge / model-report / build-report-package"
                      onChange={(e) => update(i, { action: e.target.value })}
                    />
                  </label>
                  <label style={{ flex: 1, fontSize: 12 }}>
                    <div className="ide-label">显示名 label</div>
                    <input
                      className="ide-input"
                      value={p.label}
                      placeholder="如 初始化知识库"
                      onChange={(e) => update(i, { label: e.target.value })}
                    />
                  </label>
                </div>
                <label style={{ fontSize: 12 }}>
                  <div className="ide-label">一句话说明 hint</div>
                  <input
                    className="ide-input"
                    value={p.hint}
                    placeholder="下拉里显示的简短说明"
                    onChange={(e) => update(i, { hint: e.target.value })}
                  />
                </label>
                <label style={{ fontSize: 12 }}>
                  <div className="ide-label">提示词内容 prompt（发给 AI 的完整指令）</div>
                  <textarea
                    className="ide-textarea ide-scroll"
                    value={p.prompt}
                    onChange={(e) => update(i, { prompt: e.target.value })}
                    spellCheck={false}
                    style={{ minHeight: 120, fontSize: 12.5 }}
                  />
                </label>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}>
                  <input
                    type="checkbox"
                    checked={p.write}
                    onChange={(e) => update(i, { write: e.target.checked })}
                  />
                  写任务（生成前建检查点、占用工作区写锁）
                </label>
              </div>
            </>
          )}
        </div>
        );
      })}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4 }}>
        <button className="ide-btn ide-btn-sm" onClick={add}>
          <Plus className="w-3.5 h-3.5" />
          新增预置
        </button>
        <button className="ide-btn ide-btn-sm" onClick={() => void load()} title="放弃改动，重新加载">
          <RotateCcw className="w-3.5 h-3.5" />
          重新加载
        </button>
        <div style={{ flex: 1 }} />
        <button className="ide-btn ide-btn-primary" onClick={() => void save()} disabled={saving}>
          <Save className="w-3.5 h-3.5" />
          {saving ? '保存中…' : '保存'}
        </button>
        {status && <span style={{ color: 'var(--state-success)', fontSize: 12.5 }}>{status}</span>}
      </div>
    </div>
  );
}
