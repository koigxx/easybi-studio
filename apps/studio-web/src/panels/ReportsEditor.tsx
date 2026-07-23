import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Save, Plus, Trash2, X, Link2, Upload, Copy, ArrowLeft, Pencil, ChevronRight } from 'lucide-react';
import { api, type Project } from '../api.js';
import { SectionTitle, ErrorBanner, EmptyState } from '../components/ui/common.js';
import {
  extractReportConfig,
  mergeReportConfig,
  validateReportConfig,
  parseImportedReports,
  applyImport,
  exportReportsJson,
  newField,
  fieldBinding,
  setFieldBinding,
  hasRole,
  toggleRole,
  FIELD_ROLES,
  METRIC_AGGREGATIONS,
  type FieldRole,
  type MetricAggregation,
  type ReportConfigDraft,
} from './reports-config.js';

const ROLE_LABELS: Record<FieldRole, string> = {
  output: '输出',
  filter: '筛选',
  group: '分组',
  metric: '指标',
};
const ROLE_HINTS: Record<FieldRole, string> = {
  output: '作为报表输出列',
  filter: '作为可筛选项（操作符/控件由知识库语义自动推断）',
  group: '作为分组维度（按此字段分组汇总，几组几行）',
  metric: '作为聚合指标，由建模阶段确定来源、状态条件和去重键',
};
const AGGREGATION_LABELS: Record<MetricAggregation, string> = {
  count: '计数',
  count_distinct: '去重计数',
  sum: '求和',
  avg: '平均值',
  ratio: '比率',
};

/**
 * Report information editor (report_requirements + report_scenarios), mounted as
 * a tab inside the Config page. Self-loading: reads the full build config, edits
 * only the report branches, and merges back with an optimistic revision.
 */
export function ReportsEditor({ project }: { project: Project }): JSX.Element {
  const [draft, setDraft] = useState<ReportConfigDraft | null>(null);
  const [rawConfig, setRawConfig] = useState<unknown>(null);
  const [revision, setRevision] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Master/detail: which report is open for editing (null = list view).
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  // Which field row is focused, and which rows have their binding box opened.
  const [selected, setSelected] = useState<string | null>(null);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  // Import dialog state.
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [importError, setImportError] = useState<string | null>(null);

  const fieldKey = (ri: number, fi: number): string => `${ri}:${fi}`;

  const load = useCallback(async () => {
    setError(null);
    setStatus(null);
    try {
      const cfg = await api.getBuildConfig(project.id);
      setRawConfig(cfg.value);
      setRevision(cfg.revision);
      setDraft(extractReportConfig(cfg.value));
      setEditingIndex(null); // Reloading resets to the list view.
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  function patch(next: Partial<ReportConfigDraft>): void {
    if (!draft) return;
    setDraft({ ...draft, ...next });
    setStatus(null);
  }

  async function save(): Promise<void> {
    if (!draft) return;
    setError(null);
    setStatus(null);
    const invalid = validateReportConfig(draft);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    try {
      const merged = mergeReportConfig(rawConfig, draft);
      const r = await api.saveBuildConfig(project.id, merged, revision);
      setRevision(r.revision);
      setStatus('报表配置已保存至 config/easy-bi.json（原子写入，已备份上一版本）');
      await load();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  }

  function runImport(): void {
    if (!draft) return;
    setImportError(null);
    try {
      const imported = parseImportedReports(importText);
      patch(applyImport(draft, imported, importMode));
      setImportOpen(false);
      setImportText('');
      setStatus(
        `已导入 ${imported.requirements.length} 条报表需求（${
          importMode === 'merge' ? '合并，同 ID 覆盖' : '替换现有'
        }）。请检查后点击「保存报表配置」写入。`,
      );
    } catch (e) {
      setImportError(String((e as Error).message ?? e));
    }
  }

  async function copyExport(): Promise<void> {
    if (!draft) return;
    const json = exportReportsJson(draft);
    try {
      await navigator.clipboard.writeText(json);
      setStatus('已复制当前报表配置 JSON 到剪贴板');
    } catch {
      // Clipboard unavailable (insecure context): fall back to opening the
      // import box prefilled so the user can copy it manually.
      setImportText(json);
      setImportOpen(true);
      setStatus('剪贴板不可用，已在导入框中填入当前配置 JSON，可手动复制');
    }
  }

  if (!draft) {
    return (
      <div style={{ maxWidth: 900 }}>
        {error ? <ErrorBanner>{error}</ErrorBanner> : <span>加载中…</span>}
      </div>
    );
  }

  function updateReq(
    index: number,
    next: Partial<ReportConfigDraft['requirements'][number]>,
  ): void {
    patch({ requirements: draft!.requirements.map((r, i) => (i === index ? { ...r, ...next } : r)) });
  }
  function updateField(reqIndex: number, fieldIndex: number, value: string): void {
    patch({
      requirements: draft!.requirements.map((r, i) =>
        i === reqIndex
          ? {
              ...r,
              requiredFields: r.requiredFields.map((f, j) =>
                j === fieldIndex ? setFieldBinding({ ...f, text: value }, fieldBinding(f)) : f,
              ),
            }
          : r,
      ),
    });
  }
  function updateFieldBinding(reqIndex: number, fieldIndex: number, binding: string): void {
    patch({
      requirements: draft!.requirements.map((r, i) =>
        i === reqIndex
          ? {
              ...r,
              requiredFields: r.requiredFields.map((f, j) =>
                j === fieldIndex ? setFieldBinding(f, binding) : f,
              ),
            }
          : r,
      ),
    });
  }
  function updateFieldDescription(reqIndex: number, fieldIndex: number, value: string): void {
    patch({
      requirements: draft!.requirements.map((r, i) =>
        i === reqIndex
          ? {
              ...r,
              requiredFields: r.requiredFields.map((f, j) =>
                j === fieldIndex ? { ...f, description: value } : f,
              ),
            }
          : r,
      ),
    });
  }
  function toggleFieldRole(reqIndex: number, fieldIndex: number, role: FieldRole): void {
    patch({
      requirements: draft!.requirements.map((r, i) =>
        i === reqIndex
          ? {
              ...r,
              requiredFields: r.requiredFields.map((f, j) =>
                j === fieldIndex ? toggleRole(f, role) : f,
              ),
            }
          : r,
      ),
    });
  }
  function updateFieldAggregation(
    reqIndex: number,
    fieldIndex: number,
    aggregation: MetricAggregation,
  ): void {
    patch({
      requirements: draft!.requirements.map((requirement, index) =>
        index === reqIndex
          ? {
              ...requirement,
              requiredFields: requirement.requiredFields.map((field, position) =>
                position === fieldIndex ? { ...field, aggregation } : field,
              ),
            }
          : requirement,
      ),
    });
  }

  return (
    <div style={{ maxWidth: 900, display: 'flex', flexDirection: 'column', gap: 20 }}>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className="ide-btn ide-btn-primary ide-btn-sm"
          onClick={() => void save()}
          disabled={saving}
        >
          <Save className="w-3.5 h-3.5" />
          {saving ? '保存中…' : '保存报表配置'}
        </button>
        <button className="ide-btn ide-btn-sm" onClick={() => void load()} disabled={saving}>
          <RefreshCw className="w-3.5 h-3.5" />
          重新加载
        </button>
        <button
          className="ide-btn ide-btn-sm"
          onClick={() => {
            setImportError(null);
            setImportText('');
            setImportMode('merge');
            setImportOpen(true);
          }}
          disabled={saving}
          title="从 JSON 批量导入报表需求（支持粘贴或上传文件）"
        >
          <Upload className="w-3.5 h-3.5" />
          导入
        </button>
        <button
          className="ide-btn ide-btn-sm"
          onClick={() => void copyExport()}
          disabled={saving}
          title="复制当前报表配置为 JSON（可用于备份或迁移）"
        >
          <Copy className="w-3.5 h-3.5" />
          导出
        </button>
        <span style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>
          写入 config/easy-bi.json · knowledge.report_requirements / report_scenarios · revision{' '}
          <code className="ide-chip">{revision.slice(0, 12)}…</code>
        </span>
        {status && <span style={{ color: 'var(--state-success)', fontSize: 12.5 }}>{status}</span>}
      </div>

      {editingIndex === null || !draft.requirements[editingIndex] ? (
        <>
          {/* ── List view: only report names, click to edit ── */}
          <section>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <SectionTitle>报表需求</SectionTitle>
              <button
                className="ide-btn ide-btn-sm"
                onClick={() => {
                  const next = [
                    ...draft.requirements,
                    { id: '', name: '', description: '', requiredFields: [] },
                  ];
                  patch({ requirements: next });
                  setEditingIndex(next.length - 1); // Open the new report immediately.
                  setSelected(null);
                  setOpened(new Set());
                }}
              >
                <Plus className="w-3.5 h-3.5" />
                新增报表
              </button>
            </div>
            {draft.requirements.length === 0 ? (
              <EmptyState title="暂无报表需求" hint="点击「新增报表」添加第一条。" />
            ) : (
              <div className="ide-card" style={{ padding: 0, overflow: 'hidden' }}>
                <table className="ide-table">
                  <thead>
                    <tr>
                      <th>报表</th>
                      <th>ID</th>
                      <th style={{ textAlign: 'right', width: 72 }}>字段数</th>
                      <th style={{ width: 88, textAlign: 'right' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.requirements.map((r, ri) => (
                      <tr
                        key={ri}
                        onClick={() => {
                          setEditingIndex(ri);
                          setSelected(null);
                          setOpened(new Set());
                        }}
                        style={{ cursor: 'pointer' }}
                        title="点击编辑该报表"
                      >
                        <td>{r.name || <span style={{ color: 'var(--ide-text-tertiary)' }}>（未命名）</span>}</td>
                        <td className="ide-text-mono" style={{ color: 'var(--ide-text-tertiary)' }}>
                          {r.id || '—'}
                        </td>
                        <td className="ide-num" style={{ textAlign: 'right' }}>
                          {r.requiredFields.length}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'inline-flex', gap: 4 }}>
                            <button
                              className="ide-btn ide-btn-sm ide-btn-ghost"
                              title="编辑该报表"
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingIndex(ri);
                                setSelected(null);
                                setOpened(new Set());
                              }}
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              className="ide-btn ide-btn-sm ide-btn-ghost"
                              title="删除该报表需求"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!window.confirm(`确认删除报表需求「${r.name || r.id || '未命名'}」？`)) return;
                                patch({ requirements: draft.requirements.filter((_, i) => i !== ri) });
                              }}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                            <ChevronRight
                              className="w-4 h-4"
                              style={{ color: 'var(--ide-text-tertiary)', alignSelf: 'center' }}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <SectionTitle>报表场景（report_scenarios）</SectionTitle>
            <div style={{ fontSize: 12, color: 'var(--ide-text-tertiary)', marginBottom: 6 }}>
              每行一个场景名。
            </div>
            <textarea
              className="ide-textarea ide-scroll"
              value={draft.scenarios.join('\n')}
              onChange={(e) => patch({ scenarios: e.target.value.split('\n') })}
              spellCheck={false}
              style={{ minHeight: 120, fontSize: 12.5 }}
              placeholder={'运输订单明细\n承运商结算明细'}
            />
          </section>
        </>
      ) : (
        (() => {
          const ri = editingIndex;
          const r = draft.requirements[ri]!; // Guaranteed by the outer condition.
          return (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  className="ide-btn ide-btn-sm"
                  onClick={() => setEditingIndex(null)}
                  title="返回报表列表"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  返回列表
                </button>
                <SectionTitle>{r.name || '（未命名报表）'}</SectionTitle>
                <div style={{ flex: 1 }} />
                <button
                  className="ide-btn ide-btn-sm ide-btn-danger"
                  onClick={() => {
                    if (!window.confirm(`确认删除报表需求「${r.name || r.id || '未命名'}」？`)) return;
                    patch({ requirements: draft.requirements.filter((_, i) => i !== ri) });
                    setEditingIndex(null);
                  }}
                  title="删除该报表需求"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  删除报表
                </button>
              </div>

              <div className="ide-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                  <label style={{ flex: '0 0 240px', fontSize: 12 }}>
                    <div style={{ color: 'var(--ide-text-tertiary)', marginBottom: 4 }}>ID</div>
                    <input
                      className="ide-input"
                      value={r.id}
                      placeholder="transport-order-detail"
                      onChange={(e) => updateReq(ri, { id: e.target.value })}
                    />
                  </label>
                  <label style={{ flex: 1, fontSize: 12 }}>
                    <div style={{ color: 'var(--ide-text-tertiary)', marginBottom: 4 }}>名称</div>
                    <input
                      className="ide-input"
                      value={r.name}
                      placeholder="运输订单明细"
                      onChange={(e) => updateReq(ri, { name: e.target.value })}
                    />
                  </label>
                </div>

                <label style={{ fontSize: 12 }}>
                  <div style={{ color: 'var(--ide-text-tertiary)', marginBottom: 4 }}>
                    业务说明 / 口径（可选）
                  </div>
                  <textarea
                    className="ide-textarea ide-scroll"
                    value={r.description}
                    placeholder={'例：仅统计签收复核后的数据；毛利 = 应收 − 各方应付 − 内部成本'}
                    onChange={(e) => updateReq(ri, { description: e.target.value })}
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
                    <span>字段名</span>
                    <button
                      className="ide-btn ide-btn-sm ide-btn-ghost"
                      onClick={() =>
                        updateReq(ri, { requiredFields: [...r.requiredFields, newField()] })
                      }
                    >
                      <Plus className="w-3.5 h-3.5" />
                      添加字段
                    </button>
                  </div>
                  {r.requiredFields.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>暂无字段</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {r.requiredFields.map((f, fi) => {
                        const key = fieldKey(ri, fi);
                        const binding = fieldBinding(f);
                        // Binding box shows when opened OR when a binding already exists.
                        const showBinding = opened.has(key) || binding.length > 0;
                        const isSelected = selected === key;
                        return (
                          <div key={fi} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <input
                                className="ide-input"
                                value={f.text}
                                placeholder="字段名，例如：运输订单号"
                                onChange={(e) => updateField(ri, fi, e.target.value)}
                                onFocus={() => setSelected(key)}
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
                                      onClick={() => toggleFieldRole(ri, fi, role)}
                                    >
                                      {ROLE_LABELS[role]}
                                    </button>
                                  );
                                })}
                              </div>
                              {isSelected && !showBinding && (
                                <button
                                  className="ide-btn ide-btn-sm ide-btn-ghost"
                                  onClick={() => setOpened((prev) => new Set(prev).add(key))}
                                  title="为该字段指定数据库绑定（仅歧义字段需要）"
                                >
                                  <Link2 className="w-3.5 h-3.5" />
                                  指定绑定
                                </button>
                              )}
                              <button
                                className="ide-btn ide-btn-sm ide-btn-ghost"
                                onClick={() =>
                                  updateReq(ri, {
                                    requiredFields: r.requiredFields.filter((_, j) => j !== fi),
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
                              onChange={(e) => updateFieldDescription(ri, fi, e.target.value)}
                              onFocus={() => setSelected(key)}
                              style={{
                                marginLeft: 2,
                                fontSize: 11.5,
                                color: 'var(--ide-text-secondary)',
                              }}
                            />
                            {hasRole(f, 'metric') && (
                              <select
                                className="ide-input"
                                value={f.aggregation ?? 'count_distinct'}
                                onChange={(event) =>
                                  updateFieldAggregation(
                                    ri,
                                    fi,
                                    event.target.value as MetricAggregation,
                                  )
                                }
                                style={{ marginLeft: 2, width: 150, fontSize: 11.5 }}
                                title="指标聚合方式"
                              >
                                {METRIC_AGGREGATIONS.map((aggregation) => (
                                  <option key={aggregation} value={aggregation}>
                                    {AGGREGATION_LABELS[aggregation]}
                                  </option>
                                ))}
                              </select>
                            )}
                            {showBinding && (
                              <div
                                style={{
                                  display: 'flex',
                                  gap: 8,
                                  alignItems: 'center',
                                  marginLeft: 2,
                                }}
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
                                  onChange={(e) => updateFieldBinding(ri, fi, e.target.value)}
                                  onFocus={() => setSelected(key)}
                                  style={{ flex: 1, fontSize: 12 }}
                                />
                                <button
                                  className="ide-btn ide-btn-sm ide-btn-ghost"
                                  onClick={() => {
                                    updateFieldBinding(ri, fi, '');
                                    setOpened((prev) => {
                                      const next = new Set(prev);
                                      next.delete(key);
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
              </div>
            </section>
          );
        })()
      )}

      {importOpen && (
        <div className="ide-modal-backdrop" onClick={() => setImportOpen(false)}>
          <div
            className="ide-modal"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(720px, 92vw)', maxHeight: '86vh' }}
          >
            <div className="ide-modal-header">
              <span>导入报表需求</span>
              <button className="ide-btn ide-btn-sm ide-btn-ghost" onClick={() => setImportOpen(false)}>
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div
              className="ide-modal-body"
              style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
            >
              {importError && <ErrorBanner>{importError}</ErrorBanner>}
              <div style={{ fontSize: 12, color: 'var(--ide-text-tertiary)', lineHeight: 1.7 }}>
                粘贴 JSON，或上传文件。最简格式：只写报表名和字段
                <code className="ide-chip">
                  [{'{ "name": "报表名", "fields": ["字段一", "字段二"] }'}]
                </code>
                。ID 会按名称自动生成（可后续修改），每个字段默认同时作为
                <b>输出</b>和<b>筛选</b>（不默认分组，需要分组请导入后在编辑器里点开）。
                字段也可写成对象带上<b>描述</b>，帮助 AI 理解口径：
                <code className="ide-chip">
                  {'{ "label": "订单数总和", "description": "订单数量的总和" }'}
                </code>
              </div>
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}>
                  <input
                    type="radio"
                    checked={importMode === 'merge'}
                    onChange={() => setImportMode('merge')}
                  />
                  合并（同 ID 覆盖，新 ID 追加）
                </label>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}>
                  <input
                    type="radio"
                    checked={importMode === 'replace'}
                    onChange={() => setImportMode('replace')}
                  />
                  替换（丢弃现有需求）
                </label>
                <label className="ide-btn ide-btn-sm" style={{ cursor: 'pointer' }}>
                  <Upload className="w-3.5 h-3.5" />
                  选择文件
                  <input
                    type="file"
                    accept=".json,application/json"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = () => setImportText(String(reader.result ?? ''));
                      reader.readAsText(file);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
              <textarea
                className="ide-textarea ide-scroll"
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                spellCheck={false}
                placeholder={'[\n  { "name": "毛利明细表", "fields": ["运输订单号", "计费金额", "客户"] },\n  { "name": "订单明细表", "fields": ["订单号", "订单状态", "创建时间"] }\n]'}
                style={{ minHeight: 260, fontSize: 12.5, fontFamily: 'var(--ide-font-mono, monospace)' }}
              />
            </div>
            <div className="ide-modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="ide-btn ide-btn-sm" onClick={() => setImportOpen(false)}>
                取消
              </button>
              <button
                className="ide-btn ide-btn-primary ide-btn-sm"
                onClick={() => runImport()}
                disabled={!importText.trim()}
              >
                <Upload className="w-3.5 h-3.5" />
                导入到编辑器
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
