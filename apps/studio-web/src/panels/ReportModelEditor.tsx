import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Calculator,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  Edit3,
  FileText,
  Link2,
  Plus,
  Save,
  Search,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import {
  workspaceApi,
  type AvailableField,
  type ReportModelCalculationGraph,
  type ReportModelCalculationKind,
  type ReportModelCalculationNode,
  type ReportModelComparison,
  type ReportModelDetail,
  type ReportModelFilter,
  type ReportModelMetric,
  type ReportModelRelationship,
} from '../api.js';

type EditorTab = 'fields' | 'calculations' | 'sources' | 'comparison';

const TAB_DEFS: { id: EditorTab; label: string; icon: typeof Table2 }[] = [
  { id: 'fields', label: '字段目录', icon: FileText },
  { id: 'calculations', label: '计算模型', icon: Calculator },
  { id: 'sources', label: '数据源', icon: Database },
  { id: 'comparison', label: '环比/同比', icon: Edit3 },
];

const ROLE_TAG_LABEL: Record<string, string> = {
  dedup_key: '主键',
  join_key: '关联键',
  time_filter: '时间列',
  system_condition: '系统条件',
  metric_source: '指标来源',
  tenant_scope: '租户',
  confirmed_reference: '已确认',
  exclusion_filter: '排除规则',
};
const ROLE_TAG_STYLE: Record<string, string> = {
  dedup_key: 'ide-badge-info',
  join_key: 'ide-badge-success',
  time_filter: 'ide-badge-warning',
  system_condition: 'ide-badge-neutral',
  metric_source: 'ide-badge-info',
  tenant_scope: 'ide-badge-neutral',
  exclusion_filter: 'ide-badge-warning',
};

const RELATION_TYPES = [
  ['left', '左连接'],
  ['inner', '内连接'],
] as const;
const CARDINALITIES = ['1:1', '1:n', 'n:1', 'n:n', 'unknown'] as const;

function cloneModel(model: ReportModelDetail): ReportModelDetail {
  return structuredClone(model);
}

export function ReportModelEditor({
  projectId,
  reportId,
  onClose,
}: {
  projectId: string;
  reportId: string;
  onClose: (changed: boolean) => void;
}): JSX.Element {
  const [model, setModel] = useState<ReportModelDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [changed, setChanged] = useState(false);
  const [savedAny, setSavedAny] = useState(false);
  const [activeTab, setActiveTab] = useState<EditorTab>('fields');
  // Per-source add-field picker state: sourceId -> { loading, fields, open, search }
  const [metricEdits, setMetricEdits] = useState<
    Array<{ id: string; sourceField?: string; sourceAlias?: string; dedupKey?: string }>
  >([]);
  const [filterEditsDirty, setFilterEditsDirty] = useState(false);
  const [calculationDirty, setCalculationDirty] = useState(false);
  // Working copy of filters for the FiltersTab (mutated in place, saved on submit)
  const [filterEdits, setFilterEdits] = useState<ReportModelFilter[]>([]);
  useEffect(() => {
    if (model && !filterEditsDirty) setFilterEdits(structuredClone(model.filters));
  }, [model, filterEditsDirty]);
  // Track merged state (metricEdits + filterEditsDirty count as changes)
  const hasMetricOrFilterEdits =
    metricEdits.length > 0 || filterEditsDirty || calculationDirty;
  const effectiveChanged = changed || hasMetricOrFilterEdits;
  const [pickers, setPickers] = useState<
    Record<string, { loading: boolean; fields: AvailableField[]; open: boolean; search: string }>
  >({});

  const load = useCallback(async () => {
    setError(null);
    try {
      setModel(await workspaceApi.getReportModel(projectId, reportId));
      setChanged(false);
      setCalculationDirty(false);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [projectId, reportId]);

  useEffect(() => {
    void load();
  }, [load]);

  const endpoints = useMemo(
    () =>
      (model?.sources ?? []).flatMap((source) =>
        source.fields.map((field) => ({
          value: `${source.id}.${field.name}`,
          label: `${source.id}.${field.name}(${field.label || field.name})`,
        })),
      ),
    [model],
  );

  function mutate(update: (draft: ReportModelDetail) => void): void {
    setModel((current) => {
      if (!current) return current;
      const next = cloneModel(current);
      update(next);
      return next;
    });
    setChanged(true);
    setStatus(null);
  }

  function removeField(sourceId: string, fieldName: string): void {
    if (
      model?.relationships.some(
        (r) => r.from === `${sourceId}.${fieldName}` || r.to === `${sourceId}.${fieldName}`,
      )
    ) {
      setError(`字段 ${sourceId}.${fieldName} 正被关联关系使用，请先删除或修改关联`);
      return;
    }
    mutate((draft) => {
      const source = draft.sources.find((s) => s.id === sourceId);
      if (!source) return;
      source.fields = source.fields.filter((f) => f.name !== fieldName);
    });
  }

  function addField(sourceId: string, field: AvailableField): void {
    mutate((draft) => {
      const source = draft.sources.find((s) => s.id === sourceId);
      if (!source) return;
      if (source.fields.some((f) => f.name === field.name)) return;
      source.fields.push({
        name: field.name,
        label: field.label || field.name,
        role: 'source',
        selected: true,
      });
    });
    setPickers((prev) => ({ ...prev, [sourceId]: { ...prev[sourceId]!, open: false, search: '' } }));
  }

  async function openPicker(sourceId: string): Promise<void> {
    const current = pickers[sourceId];
    if (current?.open) {
      setPickers((prev) => ({ ...prev, [sourceId]: { ...current, open: false, search: '' } }));
      return;
    }
    setPickers((prev) => ({
      ...prev,
      [sourceId]: { loading: true, fields: [], open: true, search: '' },
    }));
    try {
      const fields = await workspaceApi.getAvailableFields(projectId, reportId, sourceId);
      setPickers((prev) => ({ ...prev, [sourceId]: { loading: false, fields, open: true, search: '' } }));
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setPickers((prev) => ({ ...prev, [sourceId]: { loading: false, fields: [], open: false, search: '' } }));
    }
  }

  function updateRelationship(index: number, patch: Partial<ReportModelRelationship>): void {
    mutate((draft) => {
      draft.relationships[index] = { ...draft.relationships[index]!, ...patch };
    });
  }

  function addRelationship(): void {
    if (endpoints.length < 2) {
      setError('至少需要两个已选字段才能添加关联');
      return;
    }
    mutate((draft) => {
      draft.relationships.push({
        from: endpoints[0]!.value,
        to: endpoints[1]!.value,
        type: 'left',
        cardinality: 'n:1',
        fanoutRisk: false,
      });
    });
  }

  async function save(): Promise<void> {
    if (!model) return;
    setError(null);
    setStatus(null);
    const empty = model.sources.find((s) => !s.fields.length);
    if (empty) {
      setError(`表 ${empty.alias || empty.id} 至少需要保留一个字段`);
      return;
    }
    setSaving(true);
    try {
      const saved = await workspaceApi.saveReportModel(
        projectId,
        reportId,
        model.revision,
        model.sources.map((s) => ({
          id: s.id,
          fields: s.fields.map((f) => ({ name: f.name, role: f.role })),
        })),
        model.relationships,
        model.comparison,
        calculationDirty
          ? { version: '1', nodes: model.calculationGraph.nodes }
          : undefined,
        metricEdits.length ? metricEdits : undefined,
        filterEditsDirty
          ? [
              ...filterEdits.map((filter) => ({
                id: filter.id,
                label: filter.label,
                valueType: filter.valueType,
                operators: filter.operators,
                defaultOperator: filter.defaultOperator,
                required: filter.required,
                expression: filter.sqlBinding.expression,
                clause: filter.sqlBinding.clause,
                valueAdapter: filter.sqlBinding.valueAdapter,
                component: filter.component,
              })),
              ...model.filters
                .filter(
                  (original) =>
                    !filterEdits.some((current) => current.id === original.id),
                )
                .map((original) => ({ id: original.id, delete: true })),
            ]
          : undefined,
      );
      setModel(saved);
      setChanged(false);
      setSavedAny(true);
      setMetricEdits([]);
      setFilterEditsDirty(false);
      setCalculationDirty(false);
      setStatus('模型已校验并重新确认；后续生成报表将使用此模型');
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
        onClick={(event) => event.stopPropagation()}
        style={{ width: 'min(1100px, 96vw)', maxHeight: '92vh' }}
      >
        <div className="ide-modal-header">
          <span>报表建模 · {model?.reportName || reportId}</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              className="ide-btn ide-btn-sm ide-btn-primary"
              onClick={() => void save()}
              disabled={!model || saving || !effectiveChanged}
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? '校验中…' : '保存并确认模型'}
            </button>
            <button
              className="ide-btn ide-btn-sm ide-btn-ghost"
              onClick={() => onClose(savedAny)}
              title={effectiveChanged ? '有未保存修改' : '关闭'}
            >
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
            <span>{status}</span>
          </div>
        )}

        <div className="ide-modal-body ide-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {!model ? (
            <span style={{ fontSize: 12.5, color: 'var(--ide-text-tertiary)' }}>加载模型中…</span>
          ) : (
            <>
              {model.errors.length > 0 && (
                <div className="pkg-editor-banner" style={{ color: 'var(--state-error)' }}>
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>{model.errors.join('；')}</span>
                </div>
              )}
              <div
                className="ide-card"
                style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}
              >
                <div>
                  <div style={{ fontSize: 11, color: 'var(--ide-text-tertiary)' }}>模型状态</div>
                  <div style={{ marginTop: 4 }}>
                    <span className={`ide-badge ${model.status === 'approved' ? 'ide-badge-success' : 'ide-badge-warning'}`}>
                      {model.status === 'approved' ? '已确认' : model.status}
                    </span>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--ide-text-tertiary)' }}>结果粒度</div>
                  <div style={{ marginTop: 4, fontSize: 12.5 }}>{model.resultGrain.description || '—'}</div>
                  <div className="ide-text-mono" style={{ marginTop: 2, fontSize: 11, color: 'var(--ide-text-tertiary)' }}>
                    {model.resultGrain.keys.join(', ') || '无稳定键'}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--ide-text-tertiary)' }}>执行策略</div>
                  <div className="ide-text-mono" style={{ marginTop: 4, fontSize: 12.5 }}>{model.strategy}</div>
                </div>
              </div>

              {/* Tab navigation */}
              <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--ide-border-subtle)' }}>
                {TAB_DEFS.map((tab) => {
                  const Icon = tab.icon;
                  const active = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      className="ide-btn ide-btn-ghost ide-btn-sm"
                      style={{
                        padding: '7px 14px',
                        borderRadius: 0,
                        borderBottom: active ? '2px solid var(--ide-text-primary)' : '2px solid transparent',
                        color: active ? 'var(--ide-text-primary)' : 'var(--ide-text-tertiary)',
                        fontWeight: active ? 600 : 400,
                        fontSize: 12,
                      }}
                      onClick={() => setActiveTab(tab.id)}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      {tab.label}
                    </button>
                  );
                })}
              </div>

              {/* Tab 1: 字段目录 — 统一展示所有输出字段的映射 */}
              {activeTab === 'fields' && model.queryContracts && (
                <FieldDirectoryTab
                  model={model}
                  metricEdits={metricEdits}
                  filterEdits={filterEdits}
                  onMetricEdit={(edit) => {
                    setMetricEdits((prev) => {
                      const existing = prev.findIndex((e) => e.id === edit.id);
                      if (existing >= 0) {
                        const next = [...prev];
                        next[existing] = { ...next[existing]!, ...edit };
                        return next;
                      }
                      return [...prev, edit];
                    });
                  }}
                  onFiltersChange={(next) => {
                    setFilterEdits(next);
                    setFilterEditsDirty(true);
                  }}
                />
              )}

              {/* Tab 2: 结构化复杂计算 DAG */}
              {activeTab === 'calculations' && (
                <CalculationGraphTab
                  model={model}
                  onChange={(graph) => {
                    mutate((draft) => {
                      draft.calculationGraph = graph;
                    });
                    setCalculationDirty(true);
                  }}
                />
              )}

              {/* Tab 3: 数据源 — 表字段管理 + 关联关系 */}
              {activeTab === 'sources' && (
                <>
                  <section>
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>表与字段</div>
                      <div style={{ marginTop: 2, fontSize: 11.5, color: 'var(--ide-text-tertiary)' }}>
                        管理该报表使用的物理字段。可从知识库添加新字段，或修改字段角色。
                      </div>
                    </div>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                        gap: 10,
                      }}
                    >
                      {model.sources.map((source) => {
                        const picker = pickers[source.id];
                        const searchFilter = (picker?.search ?? '').trim().toLowerCase();
                        const visible = (picker?.fields ?? []).filter(
                          (f) => !searchFilter || f.name.toLowerCase().includes(searchFilter) || f.label.includes(searchFilter),
                        );
                        return (
                          <div key={source.id} className="ide-card" style={{ padding: 0, overflow: 'visible', position: 'relative' }}>
                            <div
                              style={{
                                padding: '10px 12px',
                                borderBottom: '1px solid var(--ide-border-subtle)',
                                background: 'var(--ide-bg-chrome)',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                gap: 8,
                              }}
                            >
                              <div style={{ minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                                  <Database className="w-3.5 h-3.5" style={{ color: 'var(--ide-text-tertiary)' }} />
                                  <strong style={{ fontSize: 12.5 }}>{source.alias || source.id}</strong>
                                  <span className="ide-badge ide-badge-neutral">{source.fields.length}</span>
                                </div>
                                <div
                                  className="ide-text-mono"
                                  style={{ marginTop: 3, fontSize: 10.5, color: 'var(--ide-text-tertiary)' }}
                                >
                                  {source.profileId} / {source.database}.{source.table}
                                </div>
                              </div>
                              <button
                                className="ide-btn ide-btn-sm"
                                onClick={() => void openPicker(source.id)}
                                title="从知识库添加字段"
                              >
                                <Plus className="w-3.5 h-3.5" />
                              </button>
                            </div>

                            {/* Add-field picker */}
                            {picker?.open && (
                              <div
                                style={{
                                  position: 'absolute',
                                  top: 0,
                                  left: 'calc(100% + 8px)',
                                  width: 280,
                                  maxHeight: 360,
                                  zIndex: 50,
                                  background: '#fff',
                                  border: '1px solid var(--ide-border-default)',
                                  borderRadius: 6,
                                  boxShadow: '0 8px 24px rgba(0,0,0,.2)',
                                  display: 'flex',
                                  flexDirection: 'column',
                                  overflow: 'hidden',
                                }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 10px 8px', borderBottom: '1px solid var(--ide-border-subtle)', flexShrink: 0 }}>
                                  <Search className="w-3.5 h-3.5" style={{ color: 'var(--ide-text-tertiary)', flexShrink: 0 }} />
                                  <input
                                    className="ide-input"
                                    style={{ flex: 1, fontSize: 12, padding: '3px 6px' }}
                                    placeholder="搜索字段名或中文名…"
                                    value={picker.search}
                                    onChange={(e) =>
                                      setPickers((prev) => ({
                                        ...prev,
                                        [source.id]: { ...prev[source.id]!, search: e.target.value },
                                      }))
                                    }
                                    autoFocus
                                  />
                                  <button
                                    className="ide-btn ide-btn-sm ide-btn-ghost"
                                    onClick={() =>
                                      setPickers((prev) => ({
                                        ...prev,
                                        [source.id]: { ...prev[source.id]!, open: false, search: '' },
                                      }))
                                    }
                                    title="关闭"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                                {picker.loading ? (
                                  <span style={{ fontSize: 12, color: 'var(--ide-text-tertiary)', padding: '8px 10px', display: 'block' }}>
                                    加载中…
                                  </span>
                                ) : (
                                  <div className="ide-scroll" style={{ flex: 1, overflowY: 'auto', padding: '4px 6px' }}>
                                    {visible.length === 0 ? (
                                      <span style={{ fontSize: 12, color: 'var(--ide-text-tertiary)', padding: '4px 6px', display: 'block' }}>
                                        {picker.search ? '无匹配字段' : '该表全部字段已添加'}
                                      </span>
                                    ) : (
                                      visible.map((f) => (
                                        <button
                                          key={f.name}
                                          className="ide-btn ide-btn-ghost ide-btn-sm"
                                          style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 10px', lineHeight: 1.3, marginBottom: '20px' }}
                                          onClick={() => addField(source.id, f)}
                                        >
                                          <span style={{ display: 'block', fontSize: 12 }}>{f.label}</span>
                                          <span style={{ display: 'block', fontSize: 10.5, color: 'var(--ide-text-tertiary)' }}>
                                            <span className="ide-text-mono">{f.name}</span>
                                            {f.nativeType && <span style={{ marginLeft: 6 }}>{f.nativeType}</span>}
                                          </span>
                                        </button>
                                      ))
                                    )}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Selected fields with role badges */}
                            <div className="ide-scroll" style={{ maxHeight: 260, overflowY: 'auto' }}>
                              {source.fields.map((field) => (
                                <div
                                  key={field.name}
                                  style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    padding: '5px 10px',
                                  }}
                                >
                                  <span style={{ minWidth: 0, flex: 1 }}>
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                      <span style={{ fontSize: 12 }}>{field.label || field.name}</span>
                                      {field.role && field.role !== 'source' && (
                                        <span className={`ide-badge ${ROLE_TAG_STYLE[field.role] ?? 'ide-badge-neutral'}`} style={{ fontSize: 9, padding: '0 4px', lineHeight: '16px' }}>
                                          {ROLE_TAG_LABEL[field.role] ?? field.role}
                                        </span>
                                      )}
                                    </span>
                                    <span
                                      className="ide-text-mono"
                                      style={{ display: 'block', fontSize: 10.5, color: 'var(--ide-text-tertiary)' }}
                                    >
                                      {field.name}
                                    </span>
                                  </span>
                                  <button
                                    className="ide-btn ide-btn-sm ide-btn-ghost"
                                    title="删除字段"
                                    onClick={() => removeField(source.id, field.name)}
                                  >
                                    <Trash2 className="w-3.5 h-3.5" style={{ color: 'var(--state-error)' }} />
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>

                  <section>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 8,
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>关联关系</div>
                        <div style={{ marginTop: 2, fontSize: 11.5, color: 'var(--ide-text-tertiary)' }}>
                          每条关系连接两个已选字段；基数影响去重和扇出风险判断。
                        </div>
                      </div>
                      <button className="ide-btn ide-btn-sm" onClick={addRelationship}>
                        <Plus className="w-3.5 h-3.5" />
                        添加关联
                      </button>
                    </div>
                    {model.relationships.length === 0 ? (
                      <div className="ide-card" style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>
                        单表模型或暂未配置关联关系。
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                        {model.relationships.map((rel, index) => (
                          <div
                            key={`${index}-${rel.from}-${rel.to}`}
                            className="ide-card"
                            style={{
                              display: 'grid',
                              gridTemplateColumns: 'minmax(180px, 1fr) 24px minmax(180px, 1fr) 110px 90px 30px',
                              gap: 7,
                              alignItems: 'center',
                              padding: 8,
                            }}
                          >
                            <select
                              className="ide-select"
                              value={rel.from}
                              onChange={(e) => updateRelationship(index, { from: e.target.value })}
                            >
                              {endpoints.map((ep) => (
                                <option key={ep.value} value={ep.value}>{ep.label}</option>
                              ))}
                            </select>
                            <Link2 className="w-4 h-4" style={{ color: 'var(--ide-text-tertiary)' }} />
                            <select
                              className="ide-select"
                              value={rel.to}
                              onChange={(e) => updateRelationship(index, { to: e.target.value })}
                            >
                              {endpoints.map((ep) => (
                                <option key={ep.value} value={ep.value}>{ep.label}</option>
                              ))}
                            </select>
                            <select
                              className="ide-select"
                              value={rel.type}
                              onChange={(e) => updateRelationship(index, { type: e.target.value })}
                            >
                              {RELATION_TYPES.map(([value, label]) => (
                                <option key={value} value={value}>{label}</option>
                              ))}
                            </select>
                            <select
                              className="ide-select ide-text-mono"
                              value={rel.cardinality}
                              onChange={(e) =>
                                updateRelationship(index, {
                                  cardinality: e.target.value,
                                  fanoutRisk: e.target.value === '1:n' || e.target.value === 'n:n',
                                })
                              }
                            >
                              {CARDINALITIES.map((v) => <option key={v}>{v}</option>)}
                            </select>
                            <button
                              className="ide-btn ide-btn-sm ide-btn-ghost"
                              title="删除关联"
                              onClick={() => mutate((draft) => void draft.relationships.splice(index, 1))}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                </>
              )}

              {/* Tab 4: 环比/同比 */}
              {activeTab === 'comparison' && (
                <ComparisonSection
                  model={model}
                  onChange={(comparison) => mutate((draft) => { draft.comparison = comparison; })}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

type MetricEdit = { id: string; sourceField?: string; sourceAlias?: string; dedupKey?: string };

function formatSqlFormula(m: ReportModelMetric): string {
  const agg = m.aggregation === 'count_distinct' ? 'COUNT(DISTINCT' : m.aggregation.toUpperCase() + '(';
  const end = m.aggregation === 'count_distinct' ? ')' : ')';
  const dedup = m.dedupKey || `${m.sourceAlias}.${m.sourceField}`;
  let formula = `${agg} ${dedup}${end}`;
  if (m.condition) formula += ` WHERE ${m.condition}`;
  return formula;
}

const CALCULATION_KIND_OPTIONS: Array<[ReportModelCalculationKind, string]> = [
  ['aggregate', '基础指标'],
  ['formula', '公式指标'],
  ['comparison', '同比 / 环比'],
  ['window', '排名 / 累计'],
  ['merge', '跨数据计算'],
];

function calculationKindLabel(kind: ReportModelCalculationKind): string {
  return CALCULATION_KIND_OPTIONS.find(([value]) => value === kind)?.[1] ?? kind;
}

function CalculationGraphTab({
  model,
  onChange,
}: {
  model: ReportModelDetail;
  onChange: (graph: ReportModelCalculationGraph) => void;
}): JSX.Element {
  const graph = model.calculationGraph;
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const [advancedNodeId, setAdvancedNodeId] = useState<string | null>(null);
  const fieldOptions = model.sources.flatMap((source) =>
    source.fields.map((field) => ({
      value: `${source.alias}.${field.name}`,
      label: `${source.alias}.${field.name}（${field.label || field.name}）`,
    })),
  );
  const fieldLabelByValue = new Map(fieldOptions.map((field) => [field.value, field.label]));
  const nodeLabelById = new Map([
    ...model.metrics.map((metric) => [metric.id, metric.label] as const),
    ...(model.queryContracts ?? []).flatMap((contract) =>
      contract.outputColumns.map((column) => [column.name, column.label] as const),
    ),
    ...graph.nodes.map((node) => [node.id, node.label] as const),
  ]);

  function nodeSummary(node: ReportModelCalculationNode): string {
    const dependencyLabels = node.dependencies.map(
      (dependency) => nodeLabelById.get(dependency) ?? dependency,
    );
    if (node.kind === 'aggregate') {
      const aggregation = {
        sum: '求和',
        count: '计数',
        count_distinct: '去重计数',
        avg: '计算平均值',
        min: '取最小值',
        max: '取最大值',
        first: '取首值',
        last: '取末值',
      }[node.aggregation] ?? '汇总';
      const field = fieldLabelByValue.get(node.sourceField) ?? node.sourceField ?? '未选择字段';
      return `${field} · ${aggregation}${node.condition ? ' · 有筛选条件' : ''}`;
    }
    if (node.kind === 'formula') return node.expression || '尚未填写计算公式';
    if (node.kind === 'comparison') {
      const mode = { difference: '差额', rate: '变化率', chain: '环比', yoy: '同比' }[
        node.comparisonMode
      ] ?? '时间对比';
      return `${dependencyLabels[0] ?? '未选择基础指标'} · ${mode}`;
    }
    if (node.kind === 'window') {
      const operation = {
        running_sum: '累计求和',
        moving_avg: '移动平均',
        row_number: '行号',
        rank: '排名',
        dense_rank: '密集排名',
        lag: '前一期值',
        lead: '后一期值',
      }[node.windowFunction] ?? '窗口计算';
      return `${dependencyLabels[0] ?? '未选择基础指标'} · ${operation}`;
    }
    const operation = {
      add: '相加',
      subtract: '相减',
      multiply: '相乘',
      divide: '相除',
      coalesce: '取首个非空值',
    }[node.mergeOperation] ?? '跨数据计算';
    return `${dependencyLabels.join('、') || '未选择指标'} · ${operation}`;
  }

  function replaceNodes(nodes: ReportModelCalculationNode[]): void {
    onChange({ version: '1', nodes, persisted: true });
  }

  function patchNode(index: number, patch: Partial<ReportModelCalculationNode>): void {
    const previous = graph.nodes[index];
    if (!previous) return;
    const next = graph.nodes.map((node, nodeIndex) =>
      nodeIndex === index ? { ...node, ...patch } : { ...node },
    );
    if (patch.id && patch.id !== previous.id) {
      for (const node of next) {
        node.dependencies = node.dependencies.map((dependency) =>
          dependency === previous.id ? patch.id! : dependency,
        );
        node.expression = node.expression.replaceAll(`{${previous.id}}`, `{${patch.id}}`);
      }
    }
    replaceNodes(next);
  }

  function toggleDependency(index: number, dependency: string): void {
    const node = graph.nodes[index];
    if (!node || dependency === node.id) return;
    const dependencies = node.dependencies.includes(dependency)
      ? node.dependencies.filter((item) => item !== dependency)
      : [...node.dependencies, dependency];
    if (node.kind === 'formula') {
      const selected = node.dependencies.includes(dependency);
      const expression = selected
        ? node.expression
            .replaceAll(`{${dependency}}`, '')
            .replace(/\s{2,}/g, ' ')
            .trim()
        : `${node.expression}${node.expression.trim() ? ' ' : ''}{${dependency}}`;
      patchNode(index, { dependencies, expression });
      return;
    }
    patchNode(index, { dependencies });
  }

  function addNode(kind: ReportModelCalculationKind): void {
    let sequence = graph.nodes.length + 1;
    while (graph.nodes.some((node) => node.id === `calc_${sequence}`)) sequence += 1;
    const dependency = graph.nodes.at(-1)?.id ?? model.metrics[0]?.id;
    replaceNodes([
      ...graph.nodes,
      {
        id: `calc_${sequence}`,
        label: kind === 'aggregate' ? `基础指标 ${sequence}` : `计算指标 ${sequence}`,
        kind,
        outputType: 'number',
        dependencies: kind === 'aggregate' || !dependency ? [] : [dependency],
        expression: kind === 'formula' && dependency ? `{${dependency}}` : '',
        sourceField: '',
        aggregation: 'sum',
        condition: '',
        comparisonMode: 'difference',
        comparisonOffset: 1,
        windowFunction: 'running_sum',
        partitionBy: [],
        orderBy: [],
        frame: '',
        mergeOperation: 'add',
        joinKeys: [],
        executionHint: 'auto',
        output: true,
        description: '',
      },
    ]);
    setExpandedNodeId(`calc_${sequence}`);
  }

  function removeNode(index: number): void {
    const removed = graph.nodes[index];
    if (!removed) return;
    replaceNodes(
      graph.nodes
        .filter((_, nodeIndex) => nodeIndex !== index)
        .map((node) => ({
          ...node,
          dependencies: node.dependencies.filter((dependency) => dependency !== removed.id),
        })),
    );
  }

  const graphLabels = new Set(graph.nodes.map((node) => node.label));
  const metricLabels = new Set(model.metrics.map((metric) => metric.label));
  const dependencyOptions = [
    ...graph.nodes.map((node) => ({ id: node.id, label: node.label, legacy: false })),
    ...model.metrics
      .filter((metric) => !graphLabels.has(metric.label))
      .map((metric) => ({ id: metric.id, label: metric.label, legacy: true })),
    ...(model.queryContracts ?? []).flatMap((contract) =>
      contract.outputColumns
        .filter(
          (column) =>
            column.role !== 'group_key' &&
            ['number', 'integer', 'bigint', 'decimal', 'float', 'double', 'percentage'].includes(
              column.type.toLowerCase(),
            ) &&
            !graphLabels.has(column.label) &&
            !metricLabels.has(column.label),
        )
        .map((column) => ({
          id: column.name,
          label: `${column.label} · ${contract.id}`,
          legacy: true,
        })),
    ),
  ].filter((item, index, all) =>
    all.findIndex((candidate) => candidate.id === item.id) === index,
  );

  return (
    <section
      data-testid="calculation-model"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ide-sp-3)' }}
    >
      <div
        className="ide-card"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 'var(--ide-sp-3)',
        }}
      >
        <div style={{ minWidth: 0, flex: '1 1 420px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 'var(--ide-sp-2)',
            }}
          >
            <strong style={{ fontSize: 'var(--ide-fz-sm)' }}>指标计算</strong>
            <span className="ide-badge ide-badge-neutral">{graph.nodes.length} 个指标</span>
            {!graph.persisted && graph.nodes.length > 0 && (
              <span className="ide-badge ide-badge-neutral">已整理原有指标</span>
            )}
          </div>
          <div
            style={{
              marginTop: 'var(--ide-sp-1)',
              color: 'var(--ide-text-tertiary)',
              fontSize: 'var(--ide-fz-xs)',
            }}
          >
            基础指标负责汇总数据库字段；公式指标基于已有指标继续计算。点击一行即可修改。
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--ide-sp-2)',
            flexShrink: 0,
          }}
        >
          <button
            className="ide-btn ide-btn-sm"
            onClick={() => addNode('aggregate')}
            title="直接对数据库字段求和、计数或取平均值"
          >
            <Plus className="w-3.5 h-3.5" />
            基础指标
          </button>
          <button
            className="ide-btn ide-btn-sm ide-btn-primary"
            onClick={() => addNode('formula')}
            title="用已有指标计算占比、差额或其他公式"
          >
            <Plus className="w-3.5 h-3.5" />
            公式指标
          </button>
        </div>
      </div>

      {graph.nodes.length === 0 ? (
        <div
          className="ide-card"
          style={{ color: 'var(--ide-text-tertiary)', fontSize: 'var(--ide-fz-sm)' }}
        >
          当前报表只有直接展示的字段。需要求和、计数、占比或排名时，再添加指标。
        </div>
      ) : (
        graph.nodes.map((node, index) => {
          const availableDependencies = dependencyOptions.filter((item) => item.id !== node.id);
          return (
            <div
              key={`${node.id}-${index}`}
              className="ide-card"
              data-testid={`calculation-node-${node.id}`}
              style={{ padding: 0, overflow: 'hidden' }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 'var(--ide-sp-3)',
                  padding: 'var(--ide-sp-3) var(--ide-sp-4)',
                  borderBottom:
                    expandedNodeId === node.id
                      ? '1px solid var(--ide-border-subtle)'
                      : '1px solid transparent',
                }}
              >
                <span
                  className="ide-badge ide-badge-neutral"
                  style={{ flexShrink: 0 }}
                >
                  {index + 1}
                </span>
                <button
                  className="ide-btn ide-btn-ghost"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    justifyContent: 'flex-start',
                    padding: 0,
                    textAlign: 'left',
                    alignItems: 'flex-start',
                    height: 'auto',
                    minHeight: 0,
                  }}
                  onClick={() =>
                    setExpandedNodeId((current) => current === node.id ? null : node.id)
                  }
                  aria-expanded={expandedNodeId === node.id}
                >
                  {expandedNodeId === node.id ? (
                    <ChevronDown className="w-3.5 h-3.5" style={{ flexShrink: 0 }} />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5" style={{ flexShrink: 0 }} />
                  )}
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: 'var(--ide-sp-2)',
                        lineHeight: 1.4,
                      }}
                    >
                      <strong
                        style={{
                          minWidth: 0,
                          overflowWrap: 'anywhere',
                          fontSize: 'var(--ide-fz-sm)',
                        }}
                      >
                        {node.label}
                      </strong>
                      <span className="ide-badge ide-badge-neutral">
                        {calculationKindLabel(node.kind)}
                      </span>
                      {node.output && <span className="ide-badge ide-badge-success">报表输出</span>}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        marginTop: 'var(--ide-sp-1)',
                        color: 'var(--ide-text-tertiary)',
                        fontSize: 'var(--ide-fz-xs)',
                        lineHeight: 1.5,
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {nodeSummary(node)}
                    </span>
                  </span>
                </button>
                <span
                  className="ide-badge ide-badge-neutral"
                  title="系统会根据模型自动选择 SQL 或脚本"
                  style={{ flexShrink: 0 }}
                >
                  {node.executionHint === 'sql'
                    ? 'SQL'
                    : node.executionHint === 'script'
                      ? '脚本'
                      : '自动'}
                </span>
                <button
                  className="ide-btn ide-btn-sm ide-btn-ghost"
                  title="删除指标"
                  onClick={() => removeNode(index)}
                  style={{ flexShrink: 0 }}
                >
                  <Trash2 className="w-3.5 h-3.5" style={{ color: 'var(--state-error)' }} />
                </button>
              </div>

              {expandedNodeId === node.id && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr)',
                  gap: 'var(--ide-sp-4)',
                  padding: 'var(--ide-sp-4)',
                  background: 'var(--ide-bg-chrome)',
                }}
              >
                <div>
                  <label style={{ display: 'block' }}>
                    <span style={{ color: 'var(--ide-text-secondary)', fontSize: 'var(--ide-fz-xs)', fontWeight: 600 }}>
                      指标名称
                    </span>
                    <input
                      className="ide-input"
                      style={{ width: '100%', marginTop: 'var(--ide-sp-1)' }}
                      value={node.label}
                      onChange={(event) => patchNode(index, { label: event.target.value })}
                      aria-label={`指标 ${index + 1} 名称`}
                    />
                  </label>
                  <label style={{ display: 'block', marginTop: 'var(--ide-sp-3)' }}>
                    <span style={{ color: 'var(--ide-text-secondary)', fontSize: 'var(--ide-fz-xs)', fontWeight: 600 }}>
                      怎么计算
                    </span>
                    <select
                      className="ide-select"
                      style={{ width: '100%', marginTop: 'var(--ide-sp-1)' }}
                      value={node.kind}
                      onChange={(event) =>
                        patchNode(index, {
                          kind: event.target.value as ReportModelCalculationKind,
                        })
                      }
                    >
                      {CALCULATION_KIND_OPTIONS.map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="ide-btn ide-btn-sm ide-btn-ghost"
                    style={{ marginTop: 'var(--ide-sp-3)' }}
                    onClick={() =>
                      setAdvancedNodeId((current) => current === node.id ? null : node.id)
                    }
                  >
                    {advancedNodeId === node.id ? (
                      <ChevronDown className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5" />
                    )}
                    高级设置
                  </button>
                  {advancedNodeId === node.id && (
                    <div style={{ marginTop: 'var(--ide-sp-2)', display: 'flex', flexDirection: 'column', gap: 'var(--ide-sp-2)' }}>
                      <label>
                        <span style={{ color: 'var(--ide-text-tertiary)', fontSize: 'var(--ide-fz-xs)' }}>指标 ID（通常无需修改）</span>
                        <input
                          className="ide-input ide-text-mono"
                          style={{ width: '100%', marginTop: 'var(--ide-sp-1)' }}
                          value={node.id}
                          onChange={(event) => patchNode(index, { id: event.target.value })}
                        />
                      </label>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0, 1fr)',
                          gap: 'var(--ide-sp-2)',
                        }}
                      >
                        <select
                          className="ide-select"
                          value={node.outputType}
                          onChange={(event) => patchNode(index, { outputType: event.target.value })}
                          aria-label="结果格式"
                        >
                          <option value="number">数值</option>
                          <option value="integer">整数</option>
                          <option value="percentage">百分比</option>
                          <option value="string">文本</option>
                          <option value="datetime">时间</option>
                        </select>
                        <select
                          className="ide-select"
                          value={node.executionHint}
                          onChange={(event) =>
                            patchNode(index, {
                              executionHint: event.target.value as 'auto' | 'sql' | 'script',
                            })
                          }
                          aria-label="执行方式"
                        >
                          <option value="auto">系统自动选择</option>
                          <option value="sql">优先使用 SQL</option>
                          <option value="script">使用复杂脚本</option>
                        </select>
                      </div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--ide-sp-2)', fontSize: 'var(--ide-fz-xs)' }}>
                        <input
                          type="checkbox"
                          checked={node.output}
                          onChange={(event) => patchNode(index, { output: event.target.checked })}
                        />
                        在最终报表中显示这个指标
                      </label>
                      <textarea
                        className="ide-input"
                        style={{ width: '100%', minHeight: 52 }}
                        value={node.description}
                        onChange={(event) => patchNode(index, { description: event.target.value })}
                        placeholder="可选：补充统计口径或用途"
                      />
                    </div>
                  )}
                </div>

                <div
                  style={{
                    minWidth: 0,
                    paddingTop: 'var(--ide-sp-4)',
                    borderTop: '1px solid var(--ide-border-subtle)',
                  }}
                >
                  <div
                    style={{
                      marginBottom: 'var(--ide-sp-2)',
                      fontSize: 'var(--ide-fz-xs)',
                      fontWeight: 600,
                      color: 'var(--ide-text-secondary)',
                    }}
                  >
                    {node.kind === 'aggregate' ? '选择统计字段和方式' : '设置计算规则'}
                  </div>
                  {(node.kind === 'comparison' || node.kind === 'window') && (
                    <label style={{ display: 'block', marginBottom: 'var(--ide-sp-3)' }}>
                      <span style={{ color: 'var(--ide-text-tertiary)', fontSize: 'var(--ide-fz-xs)' }}>
                        基于哪个指标
                      </span>
                      <select
                        className="ide-select"
                        style={{ width: '100%', marginTop: 'var(--ide-sp-1)' }}
                        value={node.dependencies[0] ?? ''}
                        onChange={(event) =>
                          patchNode(index, {
                            dependencies: event.target.value ? [event.target.value] : [],
                          })
                        }
                      >
                        <option value="">请选择已有指标…</option>
                        {availableDependencies.map((dependency) => (
                          <option key={dependency.id} value={dependency.id}>
                            {dependency.label || dependency.id}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {(node.kind === 'formula' || node.kind === 'merge') && (
                    <div style={{ marginBottom: 'var(--ide-sp-3)' }}>
                      <div style={{ color: 'var(--ide-text-tertiary)', fontSize: 'var(--ide-fz-xs)', marginBottom: 'var(--ide-sp-1)' }}>
                        {node.kind === 'formula'
                          ? '点击参与计算的指标，再在公式中使用它'
                          : '选择两个或更多需要合并计算的指标'}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--ide-sp-1)' }}>
                        {availableDependencies.map((dependency) => {
                          const selected = node.dependencies.includes(dependency.id);
                          return (
                            <button
                              key={dependency.id}
                              className={`ide-btn ide-btn-sm ${selected ? 'ide-btn-primary' : 'ide-btn-ghost'}`}
                              onClick={() => toggleDependency(index, dependency.id)}
                            >
                              {dependency.label || dependency.id}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {node.kind === 'aggregate' && (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'minmax(0, 1fr)',
                        gap: 'var(--ide-sp-3)',
                      }}
                    >
                      <label>
                        <span style={{ color: 'var(--ide-text-tertiary)', fontSize: 'var(--ide-fz-xs)' }}>统计字段</span>
                      <select
                        className="ide-select"
                        style={{ width: '100%', marginTop: 'var(--ide-sp-1)' }}
                        value={node.sourceField}
                        onChange={(event) => patchNode(index, { sourceField: event.target.value })}
                      >
                        <option value="">选择来源字段…</option>
                        {fieldOptions.map((field) => (
                          <option key={field.value} value={field.value}>{field.label}</option>
                        ))}
                      </select>
                      </label>
                      <label>
                        <span style={{ color: 'var(--ide-text-tertiary)', fontSize: 'var(--ide-fz-xs)' }}>统计方式</span>
                      <select
                        className="ide-select"
                        style={{ width: '100%', marginTop: 'var(--ide-sp-1)' }}
                        value={node.aggregation}
                        onChange={(event) => patchNode(index, { aggregation: event.target.value })}
                      >
                        <option value="sum">求和</option>
                        <option value="count">计数</option>
                        <option value="count_distinct">去重计数</option>
                        <option value="avg">平均</option>
                        <option value="min">最小值</option>
                        <option value="max">最大值</option>
                        <option value="first">首值</option>
                        <option value="last">末值</option>
                      </select>
                      </label>
                      <label>
                        <span style={{ color: 'var(--ide-text-tertiary)', fontSize: 'var(--ide-fz-xs)' }}>
                          筛选条件（可选，不熟悉可留空）
                        </span>
                      <input
                        className="ide-input ide-text-mono"
                        style={{ width: '100%', marginTop: 'var(--ide-sp-1)' }}
                        value={node.condition}
                        onChange={(event) => patchNode(index, { condition: event.target.value })}
                        placeholder="可选条件，如 t0.status = 'DONE'"
                      />
                      </label>
                    </div>
                  )}
                  {node.kind === 'formula' && (
                    <label style={{ display: 'block' }}>
                      <span style={{ color: 'var(--ide-text-tertiary)', fontSize: 'var(--ide-fz-xs)' }}>
                        计算公式
                      </span>
                      <textarea
                        className="ide-input ide-text-mono"
                        style={{ width: '100%', minHeight: 76, marginTop: 'var(--ide-sp-1)' }}
                        value={node.expression}
                        onChange={(event) => {
                          const expression = event.target.value;
                          const known = new Set(availableDependencies.map((dependency) => dependency.id));
                          const dependencies = [
                            ...new Set(
                              [...expression.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
                                .map((match) => match[1]!)
                                .filter((dependency) => known.has(dependency)),
                            ),
                          ];
                          patchNode(index, { expression, dependencies });
                        }}
                        placeholder="例如：{收入} - {成本}，或 {完成量} / {目标量}"
                      />
                      <span style={{ display: 'block', marginTop: 'var(--ide-sp-1)', color: 'var(--ide-text-tertiary)', fontSize: 'var(--ide-fz-2xs)' }}>
                        公式中的大括号内容是指标 ID。一般由 AI 生成；人工修改运算符和数字即可。
                      </span>
                    </label>
                  )}
                  {node.kind === 'comparison' && (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'minmax(0, 1fr)',
                        gap: 'var(--ide-sp-2)',
                      }}
                    >
                      <select
                        className="ide-select"
                        value={node.comparisonMode}
                        onChange={(event) => patchNode(index, { comparisonMode: event.target.value })}
                      >
                        <option value="difference">差额</option>
                        <option value="rate">变化率</option>
                        <option value="chain">环比</option>
                        <option value="yoy">同比</option>
                      </select>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--ide-sp-2)' }}>
                        <span style={{ fontSize: 'var(--ide-fz-xs)', color: 'var(--ide-text-tertiary)' }}>
                          偏移期数
                        </span>
                        <input
                          className="ide-input"
                          type="number"
                          min={1}
                          value={node.comparisonOffset}
                          onChange={(event) =>
                            patchNode(index, { comparisonOffset: Number(event.target.value || 1) })
                          }
                        />
                      </label>
                    </div>
                  )}
                  {node.kind === 'window' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ide-sp-2)' }}>
                      <select
                        className="ide-select"
                        value={node.windowFunction}
                        onChange={(event) => patchNode(index, { windowFunction: event.target.value })}
                      >
                        <option value="running_sum">累计求和</option>
                        <option value="moving_avg">移动平均</option>
                        <option value="row_number">行号</option>
                        <option value="rank">排名</option>
                        <option value="dense_rank">密集排名</option>
                        <option value="lag">前值</option>
                        <option value="lead">后值</option>
                      </select>
                      <input
                        className="ide-input ide-text-mono"
                        value={node.partitionBy.join(', ')}
                        onChange={(event) =>
                          patchNode(index, {
                            partitionBy: event.target.value.split(',').map((item) => item.trim()).filter(Boolean),
                          })
                        }
                        placeholder="分区字段：t0.customer_id, t0.region"
                      />
                      <input
                        className="ide-input ide-text-mono"
                        value={node.orderBy.join(', ')}
                        onChange={(event) =>
                          patchNode(index, {
                            orderBy: event.target.value.split(',').map((item) => item.trim()).filter(Boolean),
                          })
                        }
                        placeholder="排序字段：t0.create_time desc"
                      />
                      <input
                        className="ide-input ide-text-mono"
                        value={node.frame}
                        onChange={(event) => patchNode(index, { frame: event.target.value })}
                        placeholder="可选窗口：rows between 6 preceding and current row"
                      />
                    </div>
                  )}
                  {node.kind === 'merge' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ide-sp-2)' }}>
                      <select
                        className="ide-select"
                        value={node.mergeOperation}
                        onChange={(event) => patchNode(index, { mergeOperation: event.target.value })}
                      >
                        <option value="add">相加</option>
                        <option value="subtract">相减</option>
                        <option value="multiply">相乘</option>
                        <option value="divide">相除</option>
                        <option value="coalesce">取首个非空值</option>
                      </select>
                      <input
                        className="ide-input ide-text-mono"
                        value={node.joinKeys.join(', ')}
                        onChange={(event) =>
                          patchNode(index, {
                            joinKeys: event.target.value.split(',').map((item) => item.trim()).filter(Boolean),
                          })
                        }
                        placeholder="跨查询合并键：customer_id, month"
                      />
                    </div>
                  )}
                </div>
              </div>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}

/** Unified field directory — the primary view showing all output fields, their DB mappings, and filters. */
function FieldDirectoryTab({
  model,
  metricEdits,
  filterEdits,
  onMetricEdit,
  onFiltersChange,
}: {
  model: ReportModelDetail;
  metricEdits: MetricEdit[];
  filterEdits: ReportModelFilter[];
  onMetricEdit: (edit: MetricEdit) => void;
  onFiltersChange: (next: ReportModelFilter[]) => void;
}): JSX.Element {
  const [editingMetricId, setEditingMetricId] = useState<string | null>(null);
  const [showNewFilter, setShowNewFilter] = useState(false);
  const [draftFilter, setDraftFilter] = useState<Partial<ReportModelFilter>>({});

  const fieldOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (const s of model.sources) {
      for (const f of s.fields) {
        const val = `${s.alias}.${f.name}`;
        if (!opts.some((o) => o.value === val)) {
          opts.push({ value: val, label: `${s.alias}.${f.name} (${f.label || f.name})` });
        }
      }
    }
    return opts.sort((a, b) => a.label.localeCompare(b.label));
  }, [model.sources]);

  function addFilter(): void {
    if (!draftFilter.id || !draftFilter.label) return;
    const vt = draftFilter.valueType ?? 'datetime_range';
    const isString = vt === 'string';
    onFiltersChange([...filterEdits, {
      id: draftFilter.id,
      label: draftFilter.label ?? draftFilter.id,
      valueType: vt,
      operators: draftFilter.operators ?? (isString ? ['contains'] : ['between']),
      defaultOperator: draftFilter.defaultOperator ?? (isString ? 'contains' : 'between'),
      required: draftFilter.required ?? false,
      sqlBinding: {
        expression: draftFilter.sqlBinding?.expression ?? '',
        clause: draftFilter.sqlBinding?.clause ?? 'where',
        valueAdapter: draftFilter.sqlBinding?.valueAdapter ?? (isString ? 'contains' : 'direct'),
      },
      component: draftFilter.component ?? (isString ? 'text-contains' : 'datetime-range'),
    }]);
    setShowNewFilter(false);
    setDraftFilter({});
  }

  function removeFilter(index: number): void {
    onFiltersChange(filterEdits.filter((_, i) => i !== index));
  }

  // Build a unified list of all output fields: group keys first, then metrics,
  // matching the natural output order from the query contracts.
  const outputFields = useMemo(() => {
    const seen = new Set<string>();
    const fields: Array<{
      name: string;
      label: string;
      type: string;
      source: string;
      kind: 'dimension' | 'metric' | 'timeshifted';
      formula?: string;
      metric?: ReportModelMetric;
    }> = [];
    for (const qc of model.queryContracts ?? []) {
      for (const col of qc.outputColumns) {
        if (seen.has(col.name)) continue;
        seen.add(col.name);
        if (col.role === 'group_key') {
          fields.push({ name: col.name, label: col.label, type: col.type, source: col.source, kind: 'dimension' });
        } else {
          const m = model.metrics.find((mm) => mm.label === col.label || mm.id === col.name);
          fields.push({
            name: col.name,
            label: col.label,
            type: col.type,
            source: col.source,
            kind: 'metric',
            formula: m ? formatSqlFormula(m) : undefined,
            metric: m,
          });
        }
      }
    }
    // 2. Time-shifted comparison fields (环比/同比) — derived from comparison config
    const comp = model.comparison;
    if (comp?.enabled && comp.modes.length) {
      for (const m of model.metrics) {
        for (const mode of comp.modes) {
          const label = mode === 'chain' ? '环比' : '同比';
          const lookback = mode === 'chain' ? (comp.lookback_months ?? 1) : 12;
          const unit = lookback === 1 ? '前1月' : `前${lookback}月`;
          const name = `${m.id}_${mode}_subtract`;
          if (seen.has(name)) continue;
          seen.add(name);
          fields.push({
            name,
            label: `${label}${m.label}`,
            type: 'number',
            source: `${m.id} (${m.label})`,
            kind: 'timeshifted',
            formula: `${m.label}(本期) - ${m.label}(${unit})`,
          });
        }
      }
    }
    return fields;
  }, [model.queryContracts, model.metrics, model.comparison]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* ===== 输出字段 ===== */}
      <section>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2, color: 'var(--ide-text-secondary)' }}>
          输出字段
        </div>
        <div style={{ fontSize: 11, color: 'var(--ide-text-tertiary)', marginBottom: 8 }}>
          报表会输出以下 {outputFields.length} 个字段，展示每个字段的来源表和列。
          {model.queryContracts && model.queryContracts.length > 0 && (
            <span style={{ marginLeft: 8 }}>
              {model.queryContracts.map((qc) => (
                <span key={qc.id} className="ide-badge ide-badge-neutral" style={{ fontSize: 9.5, marginRight: 4 }}>
                  {qc.id}: {qc.purpose}
                </span>
              ))}
            </span>
          )}
        </div>
        {outputFields.length === 0 ? (
          <div className="ide-card" style={{ fontSize: 12, color: 'var(--ide-text-tertiary)', padding: 10 }}>加载中…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {/* Table header */}
            <div style={{
              display: 'grid', gridTemplateColumns: '40px 140px 70px 200px 1fr', gap: 10, alignItems: 'center',
              padding: '4px 12px', fontSize: 10.5, color: 'var(--ide-text-tertiary)', fontWeight: 600,
            }}>
              <span>#</span><span>字段名</span><span>类型</span><span>来源列</span><span>计算方式 / 说明</span>
            </div>
            {outputFields.map((f, i) => (
              <div key={f.name} className="ide-card" style={{
                display: 'grid', gridTemplateColumns: '40px 140px 70px 200px 1fr', gap: 10, alignItems: 'flex-start',
                padding: '7px 12px', fontSize: 12,
              }}>
                <span style={{ color: 'var(--ide-text-tertiary)', fontSize: 10.5 }}>{i + 1}</span>
                <div>
                  <div style={{ fontWeight: 500 }}>{f.label}</div>
                  <div className="ide-text-mono" style={{ fontSize: 10, color: 'var(--ide-text-tertiary)' }}>{f.name}</div>
                </div>
                <span className="ide-text-mono" style={{ fontSize: 10.5, color: 'var(--ide-text-tertiary)' }}>{f.type}</span>
                <div>
                  {f.kind === 'dimension' ? (
                    <>
                      <span className="ide-text-mono" style={{ fontSize: 11 }}>{f.source || '—'}</span>
                      <button className="ide-btn ide-btn-sm ide-btn-ghost" style={{ marginLeft: 6, padding: '0 4px' }}
                        onClick={() => {
                          const dimId = `_dim_${f.name}`;
                          setEditingMetricId(editingMetricId === dimId ? null : dimId);
                        }}
                        title="编辑来源列">
                        <Edit3 className="w-3 h-3" />
                      </button>
                      {/* Dimension edit: single source field selector only */}
                      {editingMetricId === `_dim_${f.name}` && (
                        <div style={{ marginTop: 6 }}>
                          <select className="ide-select" style={{ fontSize: 10.5, width: '100%' }}
                            value={f.source || ''}
                            onChange={(e) => {
                              if (!e.target.value) return;
                              const parts = e.target.value.split('.');
                              // Persist dimension edit via metricEdits with a synthetic ID
                              onMetricEdit({ id: f.name, sourceAlias: parts[0], sourceField: parts.slice(1).join('.') });
                            }}>
                            <option value="">选择来源列…</option>
                            {fieldOptions.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                          </select>
                        </div>
                      )}
                    </>
                  ) : f.kind === 'timeshifted' ? (
                    <span className="ide-text-mono" style={{ fontSize: 10.5, color: 'var(--ide-text-tertiary)' }}>
                      基于 {f.source}
                    </span>
                  ) : (
                    <>
                      {f.source || (f.metric?.sourceAlias && f.metric?.sourceField) ? (
                        <span className="ide-text-mono" style={{ fontSize: 10.5, color: 'var(--ide-text-tertiary)' }}>
                          {f.source || `${f.metric!.sourceAlias}.${f.metric!.sourceField}`}
                        </span>
                      ) : (
                        <span style={{ fontSize: 10.5, color: 'var(--state-warning)', fontStyle: 'italic' }}>
                          未映射 — 点击右侧 ✏️ 补充
                        </span>
                      )}
                      <button className="ide-btn ide-btn-sm ide-btn-ghost" style={{ marginLeft: 6, padding: '0 4px' }}
                        onClick={() => {
                          if (f.metric) {
                            setEditingMetricId(editingMetricId === f.metric.id ? null : f.metric.id);
                          } else {
                            // No metric model entry — create a synthetic one for editing
                            const syntheticId = `_synth_${f.name}`;
                            setEditingMetricId(editingMetricId === syntheticId ? null : syntheticId);
                          }
                        }}
                        title="编辑来源映射">
                        <Edit3 className="w-3 h-3" />
                      </button>
                    </>
                  )}
                </div>
                <div>
                  {f.kind === 'dimension' ? (
                    <span style={{ fontSize: 10.5, color: 'var(--ide-text-tertiary)' }}>直接引用</span>
                  ) : f.kind === 'timeshifted' ? (
                    <div style={{ fontSize: 10.5 }}>
                      <span className="ide-badge ide-badge-info" style={{ fontSize: 9.5, marginRight: 6 }}>脚本计算</span>
                      <span>{f.formula}</span>
                    </div>
                  ) : (
                    <>
                      <div className="ide-text-mono" style={{ fontSize: 10.5, lineHeight: 1.4 }}>{f.formula}</div>
                      {f.metric?.evidence && (
                        <div style={{ fontSize: 10, color: 'var(--ide-text-tertiary)', marginTop: 2, fontStyle: 'italic' }}>
                          依据: {f.metric.evidence}
                        </div>
                      )}
                      {editingMetricId === f.metric?.id && f.metric && (() => {
                        const m = f.metric;
                        const edit = metricEdits.find((e) => e.id === m.id);
                        const srcAlias = edit?.sourceAlias ?? m.sourceAlias;
                        const srcField = edit?.sourceField ?? m.sourceField;
                        const dedup = edit?.dedupKey ?? m.dedupKey;
                        const srcValue = srcAlias && srcField ? `${srcAlias}.${srcField}` : '';
                        const needsDedup = m.aggregation === 'count_distinct';
                        return (
                          <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: needsDedup ? '1fr 1fr' : '1fr', gap: 6 }}>
                            <select className="ide-select" style={{ fontSize: 10.5 }}
                              value={srcValue}
                              onChange={(e) => {
                                if (!e.target.value) return;
                                const parts = e.target.value.split('.');
                                onMetricEdit({ id: m.id, sourceAlias: parts[0], sourceField: parts.slice(1).join('.') });
                              }}>
                              <option value="">选择来源字段…</option>
                              {fieldOptions.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                            </select>
                            {needsDedup && (
                              <select className="ide-select" style={{ fontSize: 10.5 }}
                                value={dedup ?? ''}
                                onChange={(e) => { if (e.target.value) onMetricEdit({ id: m.id, dedupKey: e.target.value }); }}>
                                <option value="">选择去重键…</option>
                                {fieldOptions.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                              </select>
                            )}
                          </div>
                        );
                      })()}
                      {/* Edit section for fields without a model metric entry — synthetic edit */}
                      {!f.metric && editingMetricId === `_synth_${f.name}` && (
                        <div style={{ marginTop: 6 }}>
                          <select className="ide-select" style={{ fontSize: 10.5, width: '100%' }}
                            value=""
                            onChange={(e) => {
                              if (!e.target.value) return;
                              const parts = e.target.value.split('.');
                              onMetricEdit({ id: f.name, sourceAlias: parts[0], sourceField: parts.slice(1).join('.') });
                            }}>
                            <option value="">选择来源字段…</option>
                            {fieldOptions.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                          </select>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ===== 筛选器 ===== */}
      <section>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2, color: 'var(--ide-text-secondary)' }}>
          筛选器
        </div>
        <div style={{ fontSize: 11, color: 'var(--ide-text-tertiary)', marginBottom: 8 }}>
          查询时可用的筛选条件。时间类型可指定粒度（精确到秒 / 天 / 月）。
        </div>

        {filterEdits.length === 0 && !showNewFilter ? (
          <div className="ide-card" style={{ fontSize: 12, color: 'var(--ide-text-tertiary)', padding: 10 }}>
            暂无筛选器。
            <button className="ide-btn ide-btn-sm ide-btn-ghost" style={{ marginLeft: 8 }}
              onClick={() => setShowNewFilter(true)}><Plus className="w-3 h-3" />添加</button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {/* Header */}
            <div style={{
              display: 'grid', gridTemplateColumns: '130px 180px 80px 100px 110px 70px 30px', gap: 8, alignItems: 'center',
              padding: '4px 12px', fontSize: 10.5, color: 'var(--ide-text-tertiary)', fontWeight: 600,
            }}>
              <span>名称</span><span>来源列</span><span>类型</span><span>匹配方式</span><span>操作符</span><span>必填</span><span></span>
            </div>
            {filterEdits.map((f, i) => (
              <div key={f.id} className="ide-card" style={{
                display: 'grid', gridTemplateColumns: '130px 180px 80px 100px 110px 70px 30px', gap: 8, alignItems: 'center',
                padding: '7px 12px', fontSize: 11.5,
              }}>
                <div>
                  <div style={{ fontWeight: 500 }}>{f.label}</div>
                  <div className="ide-text-mono" style={{ fontSize: 10, color: 'var(--ide-text-tertiary)' }}>{f.id}</div>
                </div>
                <div className="ide-text-mono" style={{ fontSize: 10.5 }}>{f.sqlBinding.expression || '(未设置)'}</div>
                <div>
                  <select className="ide-select" style={{ fontSize: 10.5, width: '100%' }}
                    value={f.valueType}
                    onChange={(e) => {
                      const vt = e.target.value;
                      const isTime = vt === 'datetime_range' || vt === 'date_range';
                      onFiltersChange(filterEdits.map((ff, ii) => ii === i ? {
                        ...ff,
                        valueType: vt,
                        // Reset operators+component when switching type category
                        operators: isTime ? ['between', 'gte', 'lte'] : vt === 'string' ? ['contains'] : ['eq'],
                        defaultOperator: isTime ? 'between' : vt === 'string' ? 'contains' : 'eq',
                        component: isTime ? 'datetime-range' : vt === 'string' ? 'text-contains' : 'text',
                      } as ReportModelFilter : ff));
                    }}>
                    <option value="datetime_range">时间范围</option>
                    <option value="date_range">日期范围</option>
                    <option value="string">文本</option>
                    <option value="number">数值</option>
                  </select>
                </div>
                <div>
                  <select className="ide-select" style={{ fontSize: 10.5, width: '100%' }}
                    value={f.component ?? (f.valueType === 'string' ? 'text-contains' : 'datetime-range')}
                    onChange={(e) => {
                      const comp = e.target.value;
                      const isFuzzy = comp === 'text-contains' || comp === 'text-fuzzy';
                      const isTimeGranularity = comp === 'date-range-day' || comp === 'date-range-month';
                      onFiltersChange(filterEdits.map((ff, ii) => ii === i ? {
                        ...ff,
                        component: comp,
                        ...(comp === 'text-exact' ? { operators: ['eq'], defaultOperator: 'eq' } : {}),
                        ...(isFuzzy ? { operators: ['contains', 'eq'], defaultOperator: 'contains' } : {}),
                        ...(isTimeGranularity ? { operators: ['between'], defaultOperator: 'between' } : {}),
                      } as ReportModelFilter : ff));
                    }}>
                    {f.valueType === 'datetime_range' ? (
                      <>
                        <option value="datetime-range">精确到秒</option>
                        <option value="date-range-day">精确到天</option>
                        <option value="date-range-month">精确到月</option>
                      </>
                    ) : f.valueType === 'date_range' ? (
                      <>
                        <option value="date-range-day">精确到天</option>
                        <option value="date-range-month">精确到月</option>
                      </>
                    ) : f.valueType === 'string' ? (
                      <>
                        <option value="text-contains">模糊匹配</option>
                        <option value="text-exact">精确匹配</option>
                      </>
                    ) : (
                      <option value={f.component}>{f.component || '默认'}</option>
                    )}
                  </select>
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--ide-text-tertiary)' }}>
                  {f.operators.join(', ')}
                </div>
                <div>
                  <input type="checkbox" checked={f.required}
                    onChange={(e) => onFiltersChange(filterEdits.map((ff, ii) => ii === i ? { ...ff, required: e.target.checked } as ReportModelFilter : ff))}
                    style={{ cursor: 'pointer' }} />
                </div>
                <button className="ide-btn ide-btn-sm ide-btn-ghost" title="删除" onClick={() => removeFilter(i)}>
                  <Trash2 className="w-3.5 h-3.5" style={{ color: 'var(--state-error)' }} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* New filter form */}
        {showNewFilter && (
          <div className="ide-card" style={{ padding: 10, marginTop: 6, border: '1px solid var(--ide-border-default)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, fontSize: 11 }}>
              <label>
                <span style={{ color: 'var(--ide-text-tertiary)' }}>参数 ID</span>
                <input className="ide-input" style={{ width: '100%', marginTop: 2, fontSize: 11 }} value={draftFilter.id ?? ''} onChange={(e) => setDraftFilter((p) => ({ ...p, id: e.target.value }))} placeholder="如 create_time" />
              </label>
              <label>
                <span style={{ color: 'var(--ide-text-tertiary)' }}>标签</span>
                <input className="ide-input" style={{ width: '100%', marginTop: 2, fontSize: 11 }} value={draftFilter.label ?? ''} onChange={(e) => setDraftFilter((p) => ({ ...p, label: e.target.value }))} placeholder="如 创建时间" />
              </label>
              <label>
                <span style={{ color: 'var(--ide-text-tertiary)' }}>来源列</span>
                <select className="ide-select" style={{ width: '100%', marginTop: 2, fontSize: 11 }} value={draftFilter.sqlBinding?.expression ?? ''} onChange={(e) => setDraftFilter((p) => ({ ...p, sqlBinding: { ...(p.sqlBinding ?? { expression: '', clause: 'where', valueAdapter: 'direct' }), expression: e.target.value } }))}>
                  <option value="">请选择</option>
                  {fieldOptions.map((o) => (<option key={o.value} value={`${o.value.split('.')[0]}.\`${o.value.split('.').slice(1).join('.')}\``}>{o.label}</option>))}
                </select>
              </label>
            </div>
            <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
              <button className="ide-btn ide-btn-sm ide-btn-primary" onClick={addFilter}>添加</button>
              <button className="ide-btn ide-btn-sm ide-btn-ghost" onClick={() => { setShowNewFilter(false); setDraftFilter({}); }}>取消</button>
            </div>
          </div>
        )}

        {!showNewFilter && (
          <button className="ide-btn ide-btn-sm ide-btn-ghost" style={{ alignSelf: 'flex-start', marginTop: 4 }}
            onClick={() => setShowNewFilter(true)}>
            <Plus className="w-3.5 h-3.5" />添加筛选器
          </button>
        )}
      </section>

      {/* ===== 系统条件 ===== */}
      <section>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2, color: 'var(--ide-text-secondary)' }}>
          系统条件（自动注入，只读）
        </div>
        <div style={{ fontSize: 11, color: 'var(--ide-text-tertiary)', marginBottom: 6 }}>
          AI 从知识库自动识别并注入的过滤条件，确保查询结果正确。
        </div>
        <div className="ide-card" style={{ padding: '8px 12px', fontSize: 11.5, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {/* Logical delete */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="ide-badge ide-badge-neutral" style={{ fontSize: 9.5 }}>逻辑删除</span>
            {model.sources.flatMap((s) =>
              s.fields.filter((f) => f.role === 'system_condition').map((f) => `${s.alias}.${f.name} = 0`)
            ).length > 0 ? (
              model.sources.flatMap((s) =>
                s.fields.filter((f) => f.role === 'system_condition').map((f) => (
                  <span key={`${s.alias}.${f.name}`} className="ide-text-mono" style={{ fontSize: 11 }}>
                    {s.alias}.{f.name} = 0
                  </span>
                ))
              )
            ) : (
              <span className="ide-text-mono" style={{ fontSize: 11, color: 'var(--ide-text-tertiary)' }}>is_delete = 0</span>
            )}
          </div>
          {/* Tenant isolation */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="ide-badge ide-badge-neutral" style={{ fontSize: 9.5 }}>租户隔离</span>
            {model.sources.flatMap((s) =>
              s.fields.filter((f) => f.role === 'tenant_scope').map((f) => `${s.alias}.${f.name}`)
            ).length > 0 ? (
              <span className="ide-text-mono" style={{ fontSize: 11 }}>
                {model.sources.flatMap((s) =>
                  s.fields.filter((f) => f.role === 'tenant_scope').map((f) => `${s.alias}.${f.name}`)
                ).join(', ')} = :tenantId
              </span>
            ) : (
              <span className="ide-text-mono" style={{ fontSize: 11, color: 'var(--ide-text-tertiary)' }}>tenant_id = :tenantId（请求上下文注入）</span>
            )}
          </div>
          {/* Exclusion rules */}
          {model.sources.flatMap((s) =>
            s.fields.filter((f) => f.role === 'exclusion_filter')
          ).length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="ide-badge ide-badge-warning" style={{ fontSize: 9.5 }}>排除规则</span>
              {model.sources.flatMap((s) =>
                s.fields.filter((f) => f.role === 'exclusion_filter').map((f) => (
                  <span key={`${s.alias}.${f.name}`} className="ide-text-mono" style={{ fontSize: 11 }}>
                    {s.alias}.{f.name} = 0
                  </span>
                ))
              )}
            </div>
          )}
          {/* Time semantics */}
          {model.timeSemantics && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="ide-badge ide-badge-info" style={{ fontSize: 9.5 }}>时间筛选列</span>
              <span className="ide-text-mono" style={{ fontSize: 11 }}>
                {model.timeSemantics.alias}.{model.timeSemantics.field}
              </span>
              <span style={{ fontSize: 10.5, color: 'var(--ide-text-tertiary)' }}>
                ({model.timeSemantics.nativeType}{model.timeSemantics.required ? ', 必填' : ', 可选'})
              </span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/** Extract candidate time columns from the primary source (t0) fields. */
function candidateTimeColumns(model: ReportModelDetail): Array<{ name: string; label: string }> {
  const primary = model.sources.find((s) => s.id === 't0') ?? model.sources[0];
  if (!primary) return [];
  return primary.fields.map((f) => ({ name: f.name, label: f.label || f.name }));
}

function ComparisonSection({
  model,
  onChange,
}: {
  model: ReportModelDetail;
  onChange: (c: ReportModelComparison | null) => void;
}): JSX.Element {
  const comp = model.comparison;
  const enabled = comp?.enabled ?? false;
  const modes = comp?.modes ?? [];
  const periodParam = comp?.period_param ?? '';
  const candidates = candidateTimeColumns(model);
  const canUse = model.strategy !== 'group_queries';

  function update(patch: Partial<ReportModelComparison>): void {
    const next: ReportModelComparison = {
      enabled: enabled,
      modes: [...modes],
      period_param: periodParam,
      lookback_months: 1,
      ...comp,
      ...patch,
    };
    onChange(next.enabled || comp ? next : null);
  }

  return (
    <section>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>环比/同比</div>
      <div className="ide-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={!canUse}
            onChange={(e) => {
              if (e.target.checked) {
                onChange({
                  enabled: true,
                  modes: ['chain'],
                  period_param: candidates.find((c) => c.name === 'create_time')?.name ?? candidates[0]?.name ?? '',
                  lookback_months: 1,
                });
              } else {
                onChange(null);
              }
            }}
            style={{ cursor: 'pointer' }}
          />
          <span style={{ color: 'var(--ide-text-secondary)' }}>启用环比/同比</span>
          {!canUse && (
            <span style={{ fontSize: 11, color: 'var(--ide-text-tertiary)' }}>
              （当前策略 group_queries 暂不支持环比/同比）
            </span>
          )}
        </label>

        {enabled && (
          <>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ fontSize: 12 }}>
                <div style={{ color: 'var(--ide-text-tertiary)', marginBottom: 4 }}>对比模式</div>
                <div style={{ display: 'flex', gap: 12 }}>
                  {(['chain', 'yoy'] as const).map((mode) => (
                    <label key={mode} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={modes.includes(mode)}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...modes, mode]
                            : modes.filter((m) => m !== mode);
                          if (next.length) update({ modes: next });
                        }}
                        style={{ cursor: 'pointer' }}
                      />
                      {mode === 'chain' ? '环比' : '同比'}
                    </label>
                  ))}
                </div>
              </label>

              <label style={{ flex: '0 0 220px', fontSize: 12 }}>
                <div style={{ color: 'var(--ide-text-tertiary)', marginBottom: 4 }}>基准时间列</div>
                <select
                  className="ide-select"
                  value={periodParam}
                  onChange={(e) => update({ period_param: e.target.value })}
                >
                  {candidates.map((c) => (
                    <option key={c.name} value={c.name}>{c.label} ({c.name})</option>
                  ))}
                </select>
              </label>
            </div>
            <div style={{ fontSize: 11, color: 'var(--ide-text-tertiary)', lineHeight: 1.5 }}>
              环比对比前一等长周期，同比对比去年同周期。对比窗口会自动根据筛选时间范围扩展，无需手动配置回溯月数。
            </div>
          </>
        )}
      </div>
    </section>
  );
}
