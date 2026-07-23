import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Link2,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import {
  workspaceApi,
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
        source.fields
          .filter((field) => field.selected)
          .map((field) => ({
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

  function toggleField(sourceId: string, fieldName: string): void {
    if (
      model?.relationships.some(
        (relationship) =>
          relationship.from === `${sourceId}.${fieldName}` ||
          relationship.to === `${sourceId}.${fieldName}`,
      ) &&
      model.sources
        .find((source) => source.id === sourceId)
        ?.fields.find((field) => field.name === fieldName)?.selected
    ) {
      setError(`字段 ${sourceId}.${fieldName} 正被关联关系使用，请先删除或修改关联`);
      return;
    }
    mutate((draft) => {
      const source = draft.sources.find((item) => item.id === sourceId);
      const field = source?.fields.find((item) => item.name === fieldName);
      if (!field) return;
      field.selected = !field.selected;
    });
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
    const empty = model.sources.find((source) => !source.fields.some((field) => field.selected));
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
        model.sources.map((source) => ({
          id: source.id,
          fields: source.fields
            .filter((field) => field.selected)
            .map((field) => ({ name: field.name, role: field.role })),
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
                    勾选生成报表允许使用的物理字段。表的物理定位由模型锁定，不能在此改换数据源。
                  </div>
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                    gap: 10,
                  }}
                >
                  {model.sources.map((source) => (
                    <div key={source.id} className="ide-card" style={{ padding: 0, overflow: 'hidden' }}>
                      <div
                        style={{
                          padding: '10px 12px',
                          borderBottom: '1px solid var(--ide-border-subtle)',
                          background: 'var(--ide-bg-chrome)',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                          <Database className="w-3.5 h-3.5" style={{ color: 'var(--ide-text-tertiary)' }} />
                          <strong style={{ fontSize: 12.5 }}>{source.alias || source.id}</strong>
                          <span className="ide-badge ide-badge-neutral">
                            {source.fields.filter((field) => field.selected).length}/{source.fields.length}
                          </span>
                        </div>
                        <div
                          className="ide-text-mono"
                          style={{ marginTop: 3, fontSize: 10.5, color: 'var(--ide-text-tertiary)' }}
                        >
                          {source.profileId} / {source.database}.{source.table}
                        </div>
                      </div>
                      <div className="ide-scroll" style={{ maxHeight: 250, padding: 7 }}>
                        {source.fields.map((field) => (
                          <label
                            key={field.name}
                            style={{
                              display: 'grid',
                              gridTemplateColumns: '18px minmax(0, 1fr)',
                              gap: 6,
                              alignItems: 'start',
                              padding: '5px 4px',
                              cursor: 'pointer',
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={field.selected}
                              onChange={() => toggleField(source.id, field.name)}
                            />
                            <span style={{ minWidth: 0 }}>
                              <span style={{ display: 'block', fontSize: 12 }}>{field.label || field.name}</span>
                              <span
                                className="ide-text-mono"
                                style={{ display: 'block', fontSize: 10.5, color: 'var(--ide-text-tertiary)' }}
                              >
                                {field.name}
                              </span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
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
                      每条关系直接连接两个已选字段；基数会影响去重和扇出风险判断。
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
                    {model.relationships.map((relationship, index) => (
                      <div
                        key={`${index}-${relationship.from}-${relationship.to}`}
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
                          value={relationship.from}
                          onChange={(event) => updateRelationship(index, { from: event.target.value })}
                        >
                          {endpoints.map((endpoint) => (
                            <option key={endpoint.value} value={endpoint.value}>{endpoint.label}</option>
                          ))}
                        </select>
                        <Link2 className="w-4 h-4" style={{ color: 'var(--ide-text-tertiary)' }} />
                        <select
                          className="ide-select"
                          value={relationship.to}
                          onChange={(event) => updateRelationship(index, { to: event.target.value })}
                        >
                          {endpoints.map((endpoint) => (
                            <option key={endpoint.value} value={endpoint.value}>{endpoint.label}</option>
                          ))}
                        </select>
                        <select
                          className="ide-select"
                          value={relationship.type}
                          onChange={(event) => updateRelationship(index, { type: event.target.value })}
                        >
                          {RELATION_TYPES.map(([value, label]) => (
                            <option key={value} value={value}>{label}</option>
                          ))}
                        </select>
                        <select
                          className="ide-select ide-text-mono"
                          value={relationship.cardinality}
                          onChange={(event) =>
                            updateRelationship(index, {
                              cardinality: event.target.value,
                              fanoutRisk: event.target.value === '1:n' || event.target.value === 'n:n',
                            })
                          }
                        >
                          {CARDINALITIES.map((value) => <option key={value}>{value}</option>)}
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
