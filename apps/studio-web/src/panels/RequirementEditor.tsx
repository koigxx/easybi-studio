import { useCallback, useEffect, useState } from 'react';
import { Save, Plus, X, Link2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { api, type Project } from '../api.js';
import {
  extractReportConfig,
  upsertRequirementIntoConfig,
  validateRequirement,
  newField,
  fieldBinding,
  setFieldBinding,
  hasRole,
  toggleRole,
  FIELD_ROLES,
  type FieldRole,
  type ReportRequirementDraft,
} from './reports-config.js';

const ROLE_LABELS: Record<FieldRole, string> = { output: '输出', filter: '筛选', group: '分组' };
const ROLE_HINTS: Record<FieldRole, string> = {
  output: '作为报表输出列',
  filter: '作为可筛选项（操作符/控件由知识库语义自动推断）',
  group: '作为分组维度（按此字段分组汇总，几组几行）',
};

/**
 * Modal editor for ONE report requirement, opened from the Reports tab. Loads
 * the full build config, edits only the selected requirement (name / 业务说明 /
 * fields / roles / bindings), and saves it back via an in-place upsert so the
 * other requirements and every other config branch are preserved verbatim.
 */
export function RequirementEditor({
  project,
  requirementId,
  onClose,
}: {
  project: Project;
  requirementId: string;
  onClose: (changed: boolean) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<ReportRequirementDraft | null>(null);
  const [rawConfig, setRawConfig] = useState<unknown>(null);
  const [revision, setRevision] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAny, setSavedAny] = useState(false);
  // Which field rows have their db-binding box opened.
  const [opened, setOpened] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    setError(null);
    try {
      const cfg = await api.getBuildConfig(project.id);
      setRawConfig(cfg.value);
      setRevision(cfg.revision);
      const found = extractReportConfig(cfg.value).requirements.find((r) => r.id === requirementId);
      if (!found) {
        setError(`未找到报表需求：${requirementId}`);
        return;
      }
      setDraft(found);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [project.id, requirementId]);

  useEffect(() => {
    void load();
  }, [load]);

  function patch(next: Partial<ReportRequirementDraft>): void {
    setDraft((d) => (d ? { ...d, ...next } : d));
    setStatus(null);
  }

  function updateFieldText(index: number, value: string): void {
    if (!draft) return;
    patch({
      requiredFields: draft.requiredFields.map((f, i) =>
        i === index ? setFieldBinding({ ...f, text: value }, fieldBinding(f)) : f,
      ),
    });
  }
  function updateFieldDescription(index: number, value: string): void {
    if (!draft) return;
    patch({
      requiredFields: draft.requiredFields.map((f, i) =>
        i === index ? { ...f, description: value } : f,
      ),
    });
  }
  function updateFieldBinding(index: number, binding: string): void {
    if (!draft) return;
    patch({
      requiredFields: draft.requiredFields.map((f, i) =>
        i === index ? setFieldBinding(f, binding) : f,
      ),
    });
  }
  function toggleFieldRole(index: number, role: FieldRole): void {
    if (!draft) return;
    patch({
      requiredFields: draft.requiredFields.map((f, i) => (i === index ? toggleRole(f, role) : f)),
    });
  }

  async function save(): Promise<void> {
    if (!draft) return;
    setError(null);
    setStatus(null);
    const invalid = validateRequirement(draft);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    try {
      // Match by the id we loaded, so renaming the id relocates the same entry.
      const merged = upsertRequirementIntoConfig(rawConfig, draft, requirementId);
      const r = await api.saveBuildConfig(project.id, merged, revision);
      setRevision(r.revision);
      setSavedAny(true);
      setStatus('已保存至 config/easy-bi.json（原子写入，已备份上一版本）');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ide-modal-backdrop" onClick={() => onClose(savedAny)}>
      <div
        className="ide-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(760px, 94vw)', maxHeight: '88vh' }}
      >
        <div className="ide-modal-header">
          <span>编辑报表需求 · {draft?.name || requirementId}</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              className="ide-btn ide-btn-sm ide-btn-primary"
              onClick={() => void save()}
              disabled={saving || !draft}
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? '保存中…' : '保存'}
            </button>
            <button className="ide-btn ide-btn-sm ide-btn-ghost" onClick={() => onClose(savedAny)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {error && (
          <div className="pkg-editor-banner" style={{ color: 'var(--state-error)' }}>
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span className="min-w-0 break-all">{error}</span>
          </div>
        )}
        {status && (
          <div className="pkg-editor-banner" style={{ color: 'var(--state-success)' }}>
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            <span className="min-w-0 break-all">{status}</span>
          </div>
        )}

        <div className="ide-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {!draft ? (
            <span style={{ fontSize: 12.5, color: 'var(--ide-text-tertiary)' }}>加载中…</span>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                <label style={{ flex: '0 0 240px', fontSize: 12 }}>
                  <div style={{ color: 'var(--ide-text-tertiary)', marginBottom: 4 }}>ID</div>
                  <input
                    className="ide-input"
                    value={draft.id}
                    placeholder="transport-order-detail"
                    onChange={(e) => patch({ id: e.target.value })}
                  />
                </label>
                <label style={{ flex: 1, fontSize: 12 }}>
                  <div style={{ color: 'var(--ide-text-tertiary)', marginBottom: 4 }}>名称</div>
                  <input
                    className="ide-input"
                    value={draft.name}
                    placeholder="运输订单明细"
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                </label>
              </div>

              <label style={{ fontSize: 12 }}>
                <div style={{ color: 'var(--ide-text-tertiary)', marginBottom: 4 }}>
                  业务说明 / 口径（可选）
                </div>
                <textarea
                  className="ide-textarea ide-scroll"
                  value={draft.description}
                  placeholder={'例：仅统计签收复核后的数据；毛利 = 应收 − 各方应付 − 内部成本'}
                  onChange={(e) => patch({ description: e.target.value })}
                  spellCheck={false}
                  style={{ minHeight: 54, fontSize: 12.5 }}
                />
              </label>

              <div>
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--ide-text-tertiary)',
                    marginBottom: 6,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <span>字段</span>
                  <button
                    className="ide-btn ide-btn-sm ide-btn-ghost"
                    onClick={() => patch({ requiredFields: [...draft.requiredFields, newField()] })}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    添加字段
                  </button>
                </div>
                {draft.requiredFields.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>暂无字段</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {draft.requiredFields.map((f, fi) => {
                      const binding = fieldBinding(f);
                      const showBinding = opened.has(fi) || binding.length > 0;
                      return (
                        <div key={fi} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <input
                              className="ide-input"
                              value={f.text}
                              placeholder="字段名，例如：运输订单号"
                              onChange={(e) => updateFieldText(fi, e.target.value)}
                              style={{ flex: 1 }}
                            />
                            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                              {FIELD_ROLES.map((role) => {
                                const on = hasRole(f, role);
                                return (
                                  <button
                                    key={role}
                                    type="button"
                                    className={'ide-chip-toggle' + (on ? ' ide-chip-toggle-on' : '')}
                                    title={ROLE_HINTS[role]}
                                    onClick={() => toggleFieldRole(fi, role)}
                                  >
                                    {ROLE_LABELS[role]}
                                  </button>
                                );
                              })}
                            </div>
                            {!showBinding && (
                              <button
                                className="ide-btn ide-btn-sm ide-btn-ghost"
                                onClick={() => setOpened((prev) => new Set(prev).add(fi))}
                                title="为该字段指定数据库绑定（仅歧义字段需要）"
                              >
                                <Link2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button
                              className="ide-btn ide-btn-sm ide-btn-ghost"
                              onClick={() =>
                                patch({
                                  requiredFields: draft.requiredFields.filter((_, j) => j !== fi),
                                })
                              }
                              title="删除字段"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          <input
                            className="ide-input"
                            value={f.description}
                            placeholder="字段描述（可选，帮助 AI 理解此字段，例：订单数量的总和）"
                            onChange={(e) => updateFieldDescription(fi, e.target.value)}
                            style={{ marginLeft: 2, fontSize: 11.5, color: 'var(--ide-text-secondary)' }}
                          />
                          {showBinding && (
                            <div
                              style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 2 }}
                            >
                              <span
                                style={{
                                  fontSize: 11,
                                  color: 'var(--ide-text-tertiary)',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                绑定
                              </span>
                              <input
                                className="ide-input"
                                value={binding}
                                placeholder="db.table.column"
                                onChange={(e) => updateFieldBinding(fi, e.target.value)}
                                style={{ flex: 1, fontSize: 12 }}
                              />
                              <button
                                className="ide-btn ide-btn-sm ide-btn-ghost"
                                onClick={() => {
                                  updateFieldBinding(fi, '');
                                  setOpened((prev) => {
                                    const next = new Set(prev);
                                    next.delete(fi);
                                    return next;
                                  });
                                }}
                                title="删除绑定"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
