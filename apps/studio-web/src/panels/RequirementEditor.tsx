import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  GripVertical,
  Link2,
  Plus,
  Save,
  Sigma,
  SlidersHorizontal,
  X,
} from 'lucide-react';
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
  METRIC_AGGREGATIONS,
  type FieldRole,
  type MetricAggregation,
  type ReportFieldDraft,
  type ReportFieldKind,
  type ReportRequirementDraft,
} from './reports-config.js';

const ROLE_LABELS: Record<FieldRole, string> = { output: '输出', filter: '筛选', group: '分组', metric: '指标' };
const ROLE_HINTS: Record<FieldRole, string> = {
  output: '显示在报表结果中', filter: '可作为筛选条件', group: '决定汇总粒度', metric: '作为业务指标参与计算',
};
const AGGREGATION_LABELS: Record<MetricAggregation, string> = {
  count: '计数', count_distinct: '去重计数', sum: '求和', avg: '平均值', min: '最小值', max: '最大值', first: '首值', last: '末值', ratio: '比率',
};
const KIND_LABELS: Record<ReportFieldKind, string> = {
  data: '数据字段', metric: '业务指标', formula: '计算字段', comparison: '对比指标', window: '窗口指标', merge: '合并结果',
};
const KIND_HINTS: Record<ReportFieldKind, string> = {
  data: '直接展示或筛选知识库中的业务字段。',
  metric: '按业务口径对数据进行计数、求和、去重或其他汇总。',
  formula: '由已确定的基础指标或字段计算得出。',
  comparison: '用于环比、同比、差额或变化率等跨期对比。',
  window: '用于排名、累计、移动平均等窗口计算。',
  merge: '用于合并多个查询或数据来源的计算结果。',
};

function makeField(kind: 'data' | 'metric'): ReportFieldDraft {
  const field = newField();
  return kind === 'metric'
    ? { ...field, kind, roles: ['output', 'metric'], aggregation: 'count_distinct', metric: { aggregation: 'count_distinct' } }
    : { ...field, kind, roles: ['output', 'filter'] };
}

/** A business-first editor. Advanced physical bindings stay available, but never crowd ordinary field maintenance. */
export function RequirementEditor({ project, requirementId, onClose }: {
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
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const cfg = await api.getBuildConfig(project.id);
      setRawConfig(cfg.value); setRevision(cfg.revision);
      const found = extractReportConfig(cfg.value).requirements.find((r) => r.id === requirementId);
      if (!found) setError(`未找到报表需求：${requirementId}`);
      else setDraft(found);
    } catch (e) { setError(String((e as Error).message ?? e)); }
  }, [project.id, requirementId]);
  useEffect(() => { void load(); }, [load]);

  function patch(next: Partial<ReportRequirementDraft>): void { setDraft((d) => d ? { ...d, ...next } : d); setStatus(null); }
  function updateField(index: number, next: Partial<ReportFieldDraft>): void {
    if (!draft) return;
    patch({ requiredFields: draft.requiredFields.map((field, i) => i === index ? { ...field, ...next } : field) });
  }
  function updateBinding(index: number, binding: string): void {
    if (!draft) return;
    patch({ requiredFields: draft.requiredFields.map((field, i) => i === index ? setFieldBinding(field, binding) : field) });
  }
  function moveField(from: number, to: number): void {
    if (!draft || from === to || to < 0 || to >= draft.requiredFields.length) return;
    const fields = [...draft.requiredFields];
    const [moved] = fields.splice(from, 1);
    if (!moved) return;
    fields.splice(to, 0, moved);
    patch({ requiredFields: fields });
  }
  async function save(): Promise<void> {
    if (!draft) return;
    const invalid = validateRequirement(draft);
    if (invalid) { setError(invalid); return; }
    setSaving(true); setError(null); setStatus(null);
    try {
      const response = await api.saveBuildConfig(project.id, upsertRequirementIntoConfig(rawConfig, draft, requirementId), revision);
      setRevision(response.revision); setSavedAny(true); setStatus('已保存。AI 建模会读取这份报表需求和知识库快照。');
    } catch (e) { setError(String((e as Error).message ?? e)); }
    finally { setSaving(false); }
  }

  return <div className="ide-modal-backdrop" onClick={() => onClose(savedAny)}>
    <div className="ide-modal" onClick={(e) => e.stopPropagation()} style={{ width: 'min(900px, 96vw)', maxHeight: '90vh' }}>
      <div className="ide-modal-header">
        <span>维护报表需求 · {draft?.name || requirementId}</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button className="ide-btn ide-btn-sm ide-btn-primary" onClick={() => void save()} disabled={saving || !draft}>
            <Save className="w-3.5 h-3.5" />{saving ? '保存中…' : '保存'}
          </button>
          <button className="ide-btn ide-btn-sm ide-btn-ghost" onClick={() => onClose(savedAny)} aria-label="关闭"><X className="w-4 h-4" /></button>
        </div>
      </div>
      {error && <div className="pkg-editor-banner" style={{ color: 'var(--state-error)' }}><AlertCircle className="w-3.5 h-3.5 shrink-0" /><span>{error}</span></div>}
      {status && <div className="pkg-editor-banner" style={{ color: 'var(--state-success)' }}><CheckCircle2 className="w-3.5 h-3.5 shrink-0" /><span>{status}</span></div>}
      <div className="ide-modal-body ide-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {!draft ? <span style={{ fontSize: 12.5, color: 'var(--ide-text-tertiary)' }}>加载中…</span> : <>
          <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>基本信息</div>
            <label style={{ fontSize: 12 }}><div style={{ marginBottom: 4 }}>报表名称</div><input className="ide-input" value={draft.name} placeholder="例如：运输订单明细" onChange={(e) => patch({ name: e.target.value })} /></label>
            <label style={{ fontSize: 12 }}><div style={{ marginBottom: 4 }}>业务说明 / 统计口径</div><textarea className="ide-textarea" value={draft.description} placeholder="例如：仅统计签收复核后的数据；毛利 = 应收 − 各方应付 − 内部成本" onChange={(e) => patch({ description: e.target.value })} style={{ minHeight: 58, fontSize: 12.5 }} /></label>
            <label style={{ fontSize: 12 }}><div style={{ marginBottom: 4 }}>结果粒度（可选）</div><input className="ide-input" value={draft.resultGrain?.description ?? ''} placeholder="例如：每个运输订单一行；按月份、客户汇总" onChange={(e) => patch({ resultGrain: { ...draft.resultGrain, description: e.target.value } })} /></label>
          </section>

          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div><div style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>报表字段</div><div style={{ fontSize: 11, color: 'var(--ide-text-tertiary)', marginTop: 3 }}>新增字段默认是数据字段；统计数值时改为业务指标，复杂类型通常由 AI 建模后生成。</div></div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="ide-btn ide-btn-sm ide-btn-primary" onClick={() => { patch({ requiredFields: [...draft.requiredFields, makeField('data')] }); setExpanded(draft.requiredFields.length); }} data-tooltip="新增默认数据字段；需要求和、计数等统计时，在字段详情中改为业务指标。"><Plus className="w-3.5 h-3.5" />添加字段</button>
              </div>
            </div>
            {draft.requiredFields.length === 0 ? <div className="ide-empty-state" style={{ padding: 22 }}>尚未定义字段。添加数据字段或业务指标后，AI 才能生成可核验的建模。</div> :
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{draft.requiredFields.map((field, index) => {
                const isOpen = expanded === index;
                const kind = field.kind ?? (hasRole(field, 'metric') ? 'metric' : 'data');
                const binding = fieldBinding(field);
                const roles = field.roles.length ? field.roles.map((role) => ROLE_LABELS[role]).join(' · ') : '输出';
                return <div key={field.id ?? `${field.text}-${index}`} className="ide-card" style={{ padding: 0, opacity: draggingIndex === index ? .55 : 1 }} onDragOver={(event) => { event.preventDefault(); setDragOverIndex(index); }} onDragLeave={() => setDragOverIndex(null)} onDrop={(event) => { event.preventDefault(); if (draggingIndex !== null) moveField(draggingIndex, index); setDraggingIndex(null); setDragOverIndex(null); }}>
                  {dragOverIndex === index && draggingIndex !== index && <div style={{ height: 2, background: 'var(--ide-accent)' }} />}
                  <div style={{ display: 'flex', alignItems: 'center' }}><span draggable onDragStart={(event) => { setDraggingIndex(index); event.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => { setDraggingIndex(null); setDragOverIndex(null); }} title="拖拽调整字段顺序" style={{ display: 'inline-flex', alignItems: 'center', cursor: 'grab', color: 'var(--ide-text-tertiary)', padding: '0 3px 0 8px' }}><GripVertical className="w-4 h-4" /></span><button type="button" className="ide-btn ide-btn-ghost" onClick={() => setExpanded(isOpen ? null : index)} style={{ flex: 1, minWidth: 0, minHeight: 42, justifyContent: 'flex-start', padding: '8px 6px', textAlign: 'left' }}>
                    {isOpen ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
                    {kind === 'metric' ? <Sigma className="w-3.5 h-3.5 shrink-0" /> : <Database className="w-3.5 h-3.5 shrink-0" />}
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{field.text || '未命名字段'}</span>
                    <span className="ide-badge" data-tooltip={KIND_HINTS[kind]} style={{ flexShrink: 0 }}>{KIND_LABELS[kind]}</span><span data-tooltip={field.roles.length ? field.roles.map((role) => `${ROLE_LABELS[role]}：${ROLE_HINTS[role]}`).join('\n') : ROLE_HINTS.output} style={{ fontSize: 11, color: 'var(--ide-text-tertiary)', flexShrink: 0 }}>{roles}</span>
                  </button></div>
                  {isOpen && <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 12px 12px', borderTop: '1px solid var(--ide-border)' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 150px auto', gap: 8, paddingTop: 10, alignItems: 'end' }}>
                      <label style={{ fontSize: 12 }}><div style={{ marginBottom: 4 }}>字段名称</div><input className="ide-input" value={field.text} placeholder="例如：订单数量" onChange={(e) => updateField(index, { text: e.target.value })} /></label>
                      <label style={{ fontSize: 12 }}><div style={{ marginBottom: 4 }}>类型</div><select className="ide-input" value={kind} onChange={(e) => updateField(index, { kind: e.target.value as ReportFieldKind })}>{Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                      <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}><span draggable onDragStart={(event) => { event.stopPropagation(); setDraggingIndex(index); event.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => { setDraggingIndex(null); setDragOverIndex(null); }} title="拖拽调整字段顺序" style={{ display: 'inline-flex', alignItems: 'center', cursor: 'grab', color: 'var(--ide-text-tertiary)', padding: '0 4px' }}><GripVertical className="w-4 h-4" /></span><button className="ide-btn ide-btn-sm ide-btn-ghost" onClick={() => moveField(index, index - 1)} disabled={index === 0} title="上移">↑</button><button className="ide-btn ide-btn-sm ide-btn-ghost" onClick={() => moveField(index, index + 1)} disabled={index === draft.requiredFields.length - 1} title="下移">↓</button><button className="ide-btn ide-btn-sm ide-btn-ghost" onClick={() => { patch({ requiredFields: draft.requiredFields.filter((_, i) => i !== index) }); setExpanded(null); }} title="删除字段"><X className="w-3.5 h-3.5" />删除</button></div>
                    </div>
                    <label style={{ fontSize: 12 }}><div style={{ marginBottom: 4 }}>业务说明 / 计算口径</div><textarea className="ide-textarea" value={field.description ?? ''} placeholder={kind === 'metric' ? '例如：已完成订单数，不含已取消订单' : '例如：客户在订单上的显示名称'} onChange={(e) => updateField(index, { description: e.target.value })} style={{ minHeight: 48, fontSize: 12 }} /></label>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}><span style={{ fontSize: 12, marginRight: 2 }}>用途</span>{FIELD_ROLES.map((role) => <button key={role} type="button" className={'ide-chip-toggle' + (hasRole(field, role) ? ' ide-chip-toggle-on' : '')} data-tooltip={ROLE_HINTS[role]} onClick={() => { if (!draft) return; patch({ requiredFields: draft.requiredFields.map((item, i) => i === index ? toggleRole(item, role) : item) }); }}>{ROLE_LABELS[role]}</button>)}</div>
                    {(kind === 'metric' || hasRole(field, 'metric')) && <div style={{ display: 'grid', gridTemplateColumns: '180px minmax(0, 1fr) minmax(0, 1fr)', gap: 8 }}>
                      <label style={{ fontSize: 12 }} data-tooltip="决定指标如何汇总。建模会结合统计来源、去重字段与业务口径生成计算。"><div style={{ marginBottom: 4 }}>汇总方式</div><select className="ide-input" value={field.metric?.aggregation ?? field.aggregation ?? 'count_distinct'} onChange={(e) => { const aggregation = e.target.value as MetricAggregation; updateField(index, { aggregation, metric: { ...field.metric, aggregation } }); }}>{METRIC_AGGREGATIONS.map((aggregation) => <option key={aggregation} value={aggregation}>{AGGREGATION_LABELS[aggregation]}</option>)}</select></label>
                      <label style={{ fontSize: 12 }}><div style={{ marginBottom: 4 }}>统计来源（可选）</div><input className="ide-input" value={field.metric?.sourceField ?? ''} placeholder="例如：订单金额 / 订单号" onChange={(e) => updateField(index, { metric: { ...field.metric, sourceField: e.target.value } })} /></label>
                      <label style={{ fontSize: 12 }}><div style={{ marginBottom: 4 }}>去重字段（可选）</div><input className="ide-input" value={field.metric?.distinctField ?? ''} placeholder="例如：订单号" onChange={(e) => updateField(index, { metric: { ...field.metric, distinctField: e.target.value } })} /></label>
                    </div>}
                    <details><summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--ide-text-secondary)' }}><Link2 className="w-3.5 h-3.5 inline-block" /> AI 无法消歧时的数据绑定</summary><div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}><input className="ide-input" value={binding} placeholder="例如：crm.orders.order_no（可留空，让 AI 依据知识库匹配）" onChange={(e) => updateBinding(index, e.target.value)} /><button className="ide-btn ide-btn-sm ide-btn-ghost" onClick={() => updateBinding(index, '')} disabled={!binding}>清除</button></div><div style={{ fontSize: 11, color: 'var(--ide-text-tertiary)', marginTop: 5 }}>这只是人工兜底，优先使用知识库中的业务语义，不需要填写 SQL 或表别名。</div></details>
                  </div>}
                </div>;
              })}</div>}
          </section>

          <details open={showAdvanced} onToggle={(event) => setShowAdvanced((event.target as HTMLDetailsElement).open)}>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--ide-text-secondary)' }}><SlidersHorizontal className="w-3.5 h-3.5 inline-block" /> 高级建模提示（可选）</summary>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
              <label style={{ fontSize: 12 }}><div style={{ marginBottom: 4 }}>纳入范围</div><textarea className="ide-textarea" value={draft.scope?.include ?? ''} placeholder="例如：已完成、已审核的订单" onChange={(e) => patch({ scope: { ...draft.scope, include: e.target.value } })} style={{ minHeight: 50, fontSize: 12 }} /></label>
              <label style={{ fontSize: 12 }}><div style={{ marginBottom: 4 }}>排除范围</div><textarea className="ide-textarea" value={draft.scope?.exclude ?? ''} placeholder="例如：测试单、已取消订单" onChange={(e) => patch({ scope: { ...draft.scope, exclude: e.target.value } })} style={{ minHeight: 50, fontSize: 12 }} /></label>
              <label style={{ fontSize: 12 }}><div style={{ marginBottom: 4 }}>报表 ID</div><input className="ide-input" value={draft.id} placeholder="transport-order-detail" onChange={(e) => patch({ id: e.target.value })} /></label>
              <label style={{ fontSize: 12 }}><div style={{ marginBottom: 4 }}>默认时间字段</div><input className="ide-input" value={draft.timeSemantics?.field ?? ''} placeholder="留空时默认优先 create_time" onChange={(e) => patch({ timeSemantics: { ...draft.timeSemantics, field: e.target.value, granularity: draft.timeSemantics?.granularity ?? 'auto' } })} /></label>
            </div>
          </details>
        </>}
      </div>
    </div>
  </div>;
}
