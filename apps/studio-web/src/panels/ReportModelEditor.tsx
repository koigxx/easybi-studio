import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Link2,
  Plus,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  workspaceApi,
  type AvailableField,
  type ReportModelDetail,
  type ReportModelRelationship,
} from '../api.js';

const RELATION_TYPES = [
  ['left', '左连接'],
  ['inner', '内连接'],
  ['right', '右连接'],
  ['full', '全连接'],
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
  // Per-source add-field picker state: sourceId -> { loading, fields, open, search }
  const [pickers, setPickers] = useState<
    Record<string, { loading: boolean; fields: AvailableField[]; open: boolean; search: string }>
  >({});

  const load = useCallback(async () => {
    setError(null);
    try {
      setModel(await workspaceApi.getReportModel(projectId, reportId));
      setChanged(false);
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
          label: `${source.alias || source.id}.${field.label || field.name}`,
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
      );
      setModel(saved);
      setChanged(false);
      setSavedAny(true);
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
              disabled={!model || saving || !changed}
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? '校验中…' : '保存并确认模型'}
            </button>
            <button
              className="ide-btn ide-btn-sm ide-btn-ghost"
              onClick={() => onClose(savedAny)}
              title={changed ? '有未保存修改' : '关闭'}
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

              <section>
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>表与字段</div>
                  <div style={{ marginTop: 2, fontSize: 11.5, color: 'var(--ide-text-tertiary)' }}>
                    管理该报表使用的物理字段。可从知识库添加新字段，或删除已选字段。
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

                        {/* Add-field picker — slides out to the right */}
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
                                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 10px', lineHeight: 1.3 , marginBottom: '20px',}}
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

                        {/* Selected fields */}
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
                              <span style={{ minWidth: 0 }}>
                                <span style={{ display: 'block', fontSize: 12 }}>{field.label || field.name}</span>
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

              <section>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>筛选与指标（模型摘要）</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div className="ide-card">
                    <div style={{ fontSize: 11, color: 'var(--ide-text-tertiary)', marginBottom: 5 }}>筛选条件</div>
                    <div style={{ fontSize: 12 }}>
                      {model.filters.length ? `${model.filters.length} 项，沿用建模确认口径` : '无'}
                    </div>
                  </div>
                  <div className="ide-card">
                    <div style={{ fontSize: 11, color: 'var(--ide-text-tertiary)', marginBottom: 5 }}>指标</div>
                    <div style={{ fontSize: 12 }}>
                      {model.metrics.length ? `${model.metrics.length} 项，沿用建模确认口径` : '无'}
                    </div>
                  </div>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
