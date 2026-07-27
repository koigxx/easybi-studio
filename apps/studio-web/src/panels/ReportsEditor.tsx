import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FilePenLine, FileUp, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { api, type Project } from '../api.js';
import { EmptyState, ErrorBanner, SectionTitle } from '../components/ui/common.js';
import {
  exportReportsJson,
  extractReportConfig,
  mergeReportConfig,
  parseImportedReports,
  previewReportImport,
  validateReportConfig,
  type ReportConfigDraft,
} from './reports-config.js';
import { RequirementEditor } from './RequirementEditor.js';

/**
 * Configuration-page report management. Detailed editing deliberately reuses the
 * same RequirementEditor as the Reports page: there is one user-visible report
 * contract, not a second, divergent field editor.
 */
export function ReportsEditor({ project }: { project: Project }): JSX.Element {
  const [draft, setDraft] = useState<ReportConfigDraft | null>(null);
  const [rawConfig, setRawConfig] = useState<unknown>(null);
  const [revision, setRevision] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importPreview, setImportPreview] = useState<ReturnType<typeof previewReportImport> | null>(null);
  const [importAction, setImportAction] = useState<'create' | 'overwrite'>('create');
  const [importTargetId, setImportTargetId] = useState('');
  const [importTargetSearch, setImportTargetSearch] = useState('');
  const [importSourceIndex, setImportSourceIndex] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportReportId, setExportReportId] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const config = await api.getBuildConfig(project.id);
      setRawConfig(config.value); setRevision(config.revision); setDraft(extractReportConfig(config.value));
    } catch (cause) { setError(String((cause as Error).message ?? cause)); }
  }, [project.id]);
  useEffect(() => { void load(); }, [load]);

  async function persist(next: ReportConfigDraft, message: string): Promise<boolean> {
    const invalid = validateReportConfig(next);
    if (invalid) { setError(invalid); return false; }
    try {
      const result = await api.saveBuildConfig(project.id, mergeReportConfig(rawConfig, next), revision);
      setRevision(result.revision); setDraft(next); setStatus(message); return true;
    } catch (cause) { setError(String((cause as Error).message ?? cause)); return false; }
  }

  async function addReport(): Promise<void> {
    if (!draft) return;
    const id = newId.trim(); const name = newName.trim();
    if (!id || !name) { setError('请填写报表 ID 和名称'); return; }
    if (draft.requirements.some((item) => item.id === id)) { setError(`报表 ID 已存在：${id}`); return; }
    const next = { ...draft, requirements: [...draft.requirements, { id, name, description: '', requiredFields: [] }] };
    if (await persist(next, `已创建报表需求「${name}」`)) { setNewOpen(false); setNewId(''); setNewName(''); setEditingId(id); }
  }

  async function removeReport(id: string, name: string): Promise<void> {
    if (!draft || !window.confirm(`确认删除报表需求「${name || id}」？相关旧模型和报表包不会自动保留。`)) return;
    await persist({ ...draft, requirements: draft.requirements.filter((item) => item.id !== id) }, `已删除报表需求「${name || id}」`);
  }

  function uniqueImportedId(id: string, occupied: Set<string>): string {
    const base = id.trim() || 'imported-report';
    if (!occupied.has(base)) return base;
    let sequence = 2;
    while (occupied.has(`${base}-copy-${sequence}`)) sequence += 1;
    return `${base}-copy-${sequence}`;
  }
  function importPlan() {
    if (!draft) return null;
    const imported = parseImportedReports(importText);
    const source = imported.requirements[importSourceIndex];
    if (importAction === 'overwrite' && !importTargetId) throw new Error('请选择要覆盖的现有报表');
    if (importAction === 'overwrite' && !source) throw new Error('请选择要导入的源报表');
    if (importAction === 'overwrite') {
      const target = draft.requirements.find((item) => item.id === importTargetId);
      if (!target) throw new Error('目标报表不存在，请重新选择');
      const replacement = { ...source!, id: target.id };
      return {
        imported,
        next: { ...draft, requirements: draft.requirements.map((item) => item.id === target.id ? replacement : item) },
        preview: { create: [], update: [target.name], fields: replacement.requiredFields.length, metrics: replacement.requiredFields.filter((field) => field.kind === 'metric' || field.roles.includes('metric')).length, scenarios: 0 },
      };
    }
    const occupied = new Set(draft.requirements.map((item) => item.id));
    const additions = imported.requirements.map((item) => {
      const id = uniqueImportedId(item.id, occupied); occupied.add(id);
      return { ...item, id };
    });
    return { imported, next: { ...draft, requirements: [...draft.requirements, ...additions], scenarios: [...draft.scenarios, ...imported.scenarios.filter((item) => !draft.scenarios.includes(item))] }, preview: previewReportImport({ requirements: [], scenarios: [] }, { requirements: additions, scenarios: imported.scenarios }) };
  }
  async function importReports(): Promise<void> {
    if (!draft) return;
    try {
      const plan = importPlan();
      if (!plan) return;
      if (!importPreview) { setImportPreview(plan.preview); return; }
      if (await persist(plan.next, importAction === 'overwrite' ? `已覆盖报表「${plan.preview.update[0]}」` : `已新增 ${plan.preview.create.length} 条报表需求`)) { setImportOpen(false); setImportText(''); setImportPreview(null); }
    } catch (cause) { setError(String((cause as Error).message ?? cause)); }
  }

  function downloadExport(): void {
    if (!draft || !exportReportId) { setError('请选择要导出的报表'); return; }
    const selected = draft.requirements.find((item) => item.id === exportReportId);
    if (!selected) { setError('要导出的报表不存在'); return; }
    const blob = new Blob([exportReportsJson({ requirements: [selected], scenarios: [] })], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `easybi-report-${selected.id}-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); URL.revokeObjectURL(url);
    setExportOpen(false); setStatus(`已导出报表「${selected.name}」的可回导 JSON 文件`);
  }
  async function readImportFile(file: File | undefined): Promise<void> {
    if (!file) return;
    try { setImportText(await file.text()); setImportPreview(null); setStatus(`已读取文件：${file.name}，请先预览导入变更。`); }
    catch (cause) { setError(String((cause as Error).message ?? cause)); }
  }

  if (!draft) return <div style={{ maxWidth: 900 }}>{error ? <ErrorBanner>{error}</ErrorBanner> : '加载中…'}</div>;
  return <div style={{ maxWidth: 900, display: 'flex', flexDirection: 'column', gap: 18 }}>
    {error && <ErrorBanner>{error}</ErrorBanner>}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <button className="ide-btn ide-btn-primary ide-btn-sm" onClick={() => setNewOpen(true)}><Plus className="w-3.5 h-3.5" />新增报表</button>
      <button className="ide-btn ide-btn-sm" onClick={() => { setImportText(''); setImportAction('create'); setImportTargetId(''); setImportTargetSearch(''); setImportSourceIndex(0); setImportPreview(null); setImportOpen(true); }}><Upload className="w-3.5 h-3.5" />导入</button>
      <button className="ide-btn ide-btn-sm" onClick={() => { setExportReportId(draft.requirements[0]?.id ?? ''); setExportOpen(true); }}><Download className="w-3.5 h-3.5" />导出报表</button>
      <button className="ide-btn ide-btn-sm" onClick={() => void load()}><RefreshCw className="w-3.5 h-3.5" />重新加载</button>
      <span style={{ fontSize: 11, color: 'var(--ide-text-tertiary)' }}>config/easy-bi.json · revision {revision.slice(0, 12)}…</span>
      {status && <span style={{ fontSize: 12, color: 'var(--state-success)' }}>{status}</span>}
    </div>
    <section>
      <SectionTitle>报表需求</SectionTitle>
      <div style={{ fontSize: 12, color: 'var(--ide-text-tertiary)', marginBottom: 8 }}>在此管理报表清单；点击“维护”使用和报表页完全一致的业务字段、指标与人工兜底配置。</div>
      {draft.requirements.length === 0 ? <EmptyState title="暂无报表需求" hint="新增报表，或导入已有配置。" /> :
        <div className="ide-card" style={{ padding: 0, overflow: 'hidden' }}><table className="ide-table"><thead><tr><th>报表</th><th>结果粒度</th><th>字段</th><th>业务指标</th><th style={{ textAlign: 'right' }}>操作</th></tr></thead><tbody>{draft.requirements.map((item) => {
          const metrics = item.requiredFields.filter((field) => field.kind === 'metric' || field.roles.includes('metric')).length;
          return <tr key={item.id}><td><div>{item.name}</div><div className="ide-text-mono" style={{ fontSize: 10.5, color: 'var(--ide-text-tertiary)' }}>{item.id}</div></td><td style={{ color: 'var(--ide-text-secondary)' }}>{item.resultGrain?.description || '自动判断'}</td><td className="ide-num">{item.requiredFields.length}</td><td className="ide-num">{metrics}</td><td style={{ textAlign: 'right' }}><div style={{ display: 'inline-flex', gap: 4 }}><button className="ide-btn ide-btn-sm ide-btn-ghost" onClick={() => setEditingId(item.id)} title="维护报表需求"><FilePenLine className="w-3.5 h-3.5" />维护</button><button className="ide-btn ide-btn-sm ide-btn-ghost" onClick={() => void removeReport(item.id, item.name)} title="删除报表"><Trash2 className="w-3.5 h-3.5" /></button></div></td></tr>;
        })}</tbody></table></div>}
    </section>
    <section><SectionTitle>报表场景</SectionTitle><textarea className="ide-textarea ide-scroll" value={draft.scenarios.join('\n')} onChange={(event) => setDraft({ ...draft, scenarios: event.target.value.split('\n') })} placeholder={'运输订单明细\n承运商结算明细'} style={{ minHeight: 100 }} /><button className="ide-btn ide-btn-sm" style={{ marginTop: 8 }} onClick={() => void persist(draft, '已保存报表场景')}>保存场景</button></section>
    {editingId && <RequirementEditor project={project} requirementId={editingId} onClose={(changed) => { setEditingId(null); if (changed) void load(); }} />}
    {newOpen && <div className="ide-modal-backdrop" onClick={() => setNewOpen(false)}><div className="ide-modal" onClick={(event) => event.stopPropagation()} style={{ width: 'min(460px, 92vw)' }}><div className="ide-modal-header"><span>新增报表</span><button className="ide-btn ide-btn-sm ide-btn-ghost" onClick={() => setNewOpen(false)}><X className="w-3.5 h-3.5" /></button></div><div className="ide-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}><label>报表 ID<input className="ide-input" value={newId} placeholder="transport-order-detail" onChange={(event) => setNewId(event.target.value)} /></label><label>报表名称<input className="ide-input" value={newName} placeholder="运输订单明细" onChange={(event) => setNewName(event.target.value)} /></label><button className="ide-btn ide-btn-primary" onClick={() => void addReport()}>创建并维护</button></div></div></div>}
    {importOpen && <div className="ide-modal-backdrop" onClick={() => setImportOpen(false)}><div className="ide-modal" onClick={(event) => event.stopPropagation()} style={{ width: 'min(720px, 92vw)' }}><div className="ide-modal-header"><span>导入报表需求</span><button className="ide-btn ide-btn-sm ide-btn-ghost" onClick={() => setImportOpen(false)}><X className="w-3.5 h-3.5" /></button></div><div className="ide-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}><div style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>先选择导入方式。新增导入不会覆盖现有报表；覆盖导入必须选择一张现有报表。</div><div style={{ display: 'flex', gap: 6 }}><button className={'ide-chip-toggle' + (importAction === 'create' ? ' ide-chip-toggle-on' : '')} onClick={() => { setImportAction('create'); setImportTargetId(''); setImportPreview(null); }}>新增导入</button><button className={'ide-chip-toggle' + (importAction === 'overwrite' ? ' ide-chip-toggle-on' : '')} onClick={() => { setImportAction('overwrite'); setImportPreview(null); }}>覆盖导入</button></div>{importAction === 'overwrite' && <div className="ide-card" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 7 }}><label style={{ fontSize: 12 }}>搜索现有报表<input className="ide-input" value={importTargetSearch} placeholder="按报表名称或 ID 搜索" onChange={(event) => { setImportTargetSearch(event.target.value); setImportTargetId(''); setImportPreview(null); }} /></label><div className="ide-scroll" style={{ maxHeight: 150, display: 'flex', flexDirection: 'column', gap: 3 }}>{draft.requirements.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(importTargetSearch.trim().toLowerCase())).map((item) => <button key={item.id} className={'ide-btn ide-btn-sm ide-btn-ghost' + (importTargetId === item.id ? ' ide-chip-toggle-on' : '')} style={{ justifyContent: 'flex-start' }} onClick={() => { setImportTargetId(item.id); setImportPreview(null); }}>{item.name} <span className="ide-text-mono" style={{ color: 'var(--ide-text-tertiary)' }}>({item.id})</span></button>)}{draft.requirements.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(importTargetSearch.trim().toLowerCase())).length === 0 && <span style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>未找到匹配的报表</span>}</div></div>}<div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(event) => void readImportFile(event.target.files?.[0])} /><button className="ide-btn ide-btn-sm" onClick={() => fileInput.current?.click()}><FileUp className="w-3.5 h-3.5" />选择 JSON 文件</button></div><textarea className="ide-textarea ide-scroll" value={importText} onChange={(event) => { setImportText(event.target.value); setImportPreview(null); }} placeholder="粘贴 JSON" style={{ minHeight: 190 }} />{importAction === 'overwrite' && importText && <label>源报表<select className="ide-input" value={importSourceIndex} onChange={(event) => { setImportSourceIndex(Number(event.target.value)); setImportPreview(null); }}>{(() => { try { return parseImportedReports(importText).requirements.map((item, index) => <option key={`${item.id}-${index}`} value={index}>{item.name || item.id}</option>); } catch { return <option value={0}>请先填写合法 JSON</option>; } })()}</select></label>}{importPreview && <div className="ide-card" style={{ padding: 10, fontSize: 12 }}><strong>导入预览</strong><div style={{ marginTop: 5 }}>新增 {importPreview.create.length} 条；覆盖 {importPreview.update.length} 条；共 {importPreview.fields} 个字段、{importPreview.metrics} 个业务指标、{importPreview.scenarios} 个场景。</div>{importPreview.update.length > 0 && <div style={{ color: 'var(--state-warning)', marginTop: 4 }}>将覆盖：{importPreview.update.join('、')}</div>}</div>}<button className="ide-btn ide-btn-primary" onClick={() => void importReports()}>{importPreview ? '确认导入并保存' : '预览导入变更'}</button></div></div></div>}
    {exportOpen && <div className="ide-modal-backdrop" onClick={() => setExportOpen(false)}><div className="ide-modal" onClick={(event) => event.stopPropagation()} style={{ width: 'min(460px, 92vw)' }}><div className="ide-modal-header"><span>导出报表</span><button className="ide-btn ide-btn-sm ide-btn-ghost" onClick={() => setExportOpen(false)}><X className="w-3.5 h-3.5" /></button></div><div className="ide-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}><div style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>导出单个报表的完整可回导配置，不包含其他报表。</div><label>选择报表<select className="ide-input" value={exportReportId} onChange={(event) => setExportReportId(event.target.value)}>{draft.requirements.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.id}）</option>)}</select></label><button className="ide-btn ide-btn-primary" onClick={() => downloadExport()}><Download className="w-3.5 h-3.5" />下载 JSON 文件</button></div></div></div>}
  </div>;
}
