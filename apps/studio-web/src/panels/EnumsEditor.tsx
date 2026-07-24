import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshCw,
  Save,
  Wand2,
  Plus,
  X,
  Search,
  Download,
  Upload,
  Braces,
  Table2,
  ChevronRight,
  ArrowLeft,
  ShieldCheck,
} from 'lucide-react';
import { workspaceApi, type Project, type EnumsDocument, type EnumValue } from '../api.js';
import { SectionTitle, ErrorBanner, EmptyState, Badge, Loading } from '../components/ui/common.js';
import { useAgentDrawer, useAgentRefresh } from '../AgentDrawer.js';
import {
  bindingRows,
  dictionaryNames,
  dictionaryByName,
  completeness,
  renameDictionary,
  rebindDictionary,
  addBinding,
  removeBinding,
  setDictionaryValues,
  type EnumBindingRow,
} from './enums-view.js';

/**
 * Visual editor for the draft's enum bindings + code→中文 dictionaries.
 * Mounted as a tab in the Config page. Loads the latest draft's enums.json,
 * lets the user init/edit, and saves via the skill CLI (enums-import-json)
 * through studio-service — the front-end never assembles paths or CLI logic.
 */
export function EnumsEditor({ project }: { project: Project }): JSX.Element {
  const [draftId, setDraftId] = useState<string | null>(null);
  const [doc, setDoc] = useState<EnumsDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedDict, setSelectedDict] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [pendingUpload, setPendingUpload] = useState<File | null>(null);
  const [view, setView] = useState<'table' | 'json'>('table');
  const [tableTab, setTableTab] = useState<'bindings' | 'dicts'>('bindings');
  const [jsonDraft, setJsonDraft] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  // Strict-validation result panel (from the 校验 button), dismissable.
  const [checkIssues, setCheckIssues] = useState<string[] | null>(null);
  // New binding form state.
  const [showNewBinding, setShowNewBinding] = useState(false);
  const [newBinding, setNewBinding] = useState({ profileId: '', database: '', table: '', field: '', note: '', dictionary_name: '' });
  const { startAction } = useAgentDrawer();
  const refreshNonce = useAgentRefresh();

  const loadDoc = useCallback(
    async (id: string) => {
      setError(null);
      try {
        setDoc(await workspaceApi.getEnums(project.id, id));
      } catch (e) {
        setError(String((e as Error).message ?? e));
      }
    },
    [project.id],
  );

  const bootstrap = useCallback(async () => {
    setError(null);
    setStatus(null);
    try {
      const catalogs = await workspaceApi.getCatalogs(project.id);
      const id = catalogs.latestDraftId;
      setDraftId(id);
      if (id) await loadDoc(id);
      else setDoc(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [project.id, loadDoc]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap, refreshNonce]);

  const rows = useMemo(() => (doc ? bindingRows(doc) : []), [doc]);
  const names = useMemo(() => (doc ? dictionaryNames(doc) : []), [doc]);

  // Filtered binding rows for the Excel-like table (search by table/field/note/enum).
  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      `${r.database} ${r.table} ${r.field} ${r.note} ${r.dictionary_name}`
        .toLowerCase()
        .includes(q),
    );
  }, [rows, query]);

  function enterJsonView(): void {
    if (!doc) return;
    setJsonDraft(JSON.stringify(doc, null, 2));
    setJsonError(null);
    setView('json');
  }

  function applyJson(): void {
    try {
      const parsed = JSON.parse(jsonDraft) as EnumsDocument;
      if (!Array.isArray(parsed.dictionaries) || !Array.isArray(parsed.bindings)) {
        setJsonError('JSON 必须包含 dictionaries[] 与 bindings[]');
        return;
      }
      setDoc(parsed);
      setJsonError(null);
      setView('table');
      setStatus('已从 JSON 应用到编辑器（尚未保存到草稿）');
    } catch (e) {
      setJsonError('JSON 解析失败：' + String((e as Error).message ?? e));
    }
  }

  async function runInit(): Promise<void> {
    if (!draftId) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const r = await workspaceApi.initEnums(project.id, draftId);
      const j = r.json as { bindings?: number; prefilled?: number; skipped?: unknown[] } | null;
      setStatus(
        `初始化完成：${j?.bindings ?? 0} 个绑定，预填 ${j?.prefilled ?? 0} 个字典（跳过 ${
          Array.isArray(j?.skipped) ? j!.skipped!.length : 0
        }）`,
      );
      await loadDoc(draftId);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  function downloadExcel(): void {
    if (!draftId) return;
    window.open(workspaceApi.enumsExportUrl(project.id, draftId), '_blank');
  }

  async function uploadExcel(file: File, dryRun: boolean): Promise<void> {
    if (!draftId) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const buffer = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
      const base64 = btoa(binary);
      const r = await workspaceApi.importEnumsExcel(project.id, draftId, base64, dryRun);
      const j = r.json as { changes?: number; errors?: string[] } | null;
      setStatus(
        (dryRun ? '上传预览：' : '导入完成：') +
          `${j?.changes ?? 0} 处变更` +
          (j?.errors?.length ? `，${j.errors.length} 个待解决项` : '，无阻塞'),
      );
      if (dryRun) setPendingUpload(file);
      else {
        setPendingUpload(null);
        await loadDoc(draftId);
      }
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    if (!draftId || !doc) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      // WIP save: allowed to be incomplete (unfilled labels persist).
      const r = await workspaceApi.saveEnums(project.id, draftId, doc, {});
      const j = r.json as { changes?: number; warnings?: string[] } | null;
      setStatus(
        `已保存到草稿（${j?.changes ?? 0} 处变更` +
          (j?.warnings?.length ? `，${j.warnings.length} 项待补全` : '') +
          '）',
      );
      await loadDoc(draftId);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function check(): Promise<void> {
    if (!draftId || !doc) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    setCheckIssues(null);
    try {
      // Strict dry-run surfaces every completeness issue without writing.
      const r = await workspaceApi.saveEnums(project.id, draftId, doc, {
        dryRun: true,
        strict: true,
      });
      const j = r.json as { errors?: string[] } | null;
      const issues = j?.errors ?? [];
      setCheckIssues(issues);
      if (issues.length === 0) setStatus('校验通过：所有枚举绑定与映射均完整');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  if (!doc && !error) return <Loading text="正在读取枚举配置…" />;
  if (!draftId) {
    return (
      <EmptyState
        title="尚无知识库草稿"
        hint={
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <span>枚举配置基于知识库草稿。请先生成知识库草稿，再回到此页初始化枚举。</span>
            <button
              className="ide-btn ide-btn-primary ide-btn-sm"
              onClick={() => startAction(project.id, 'initialize-knowledge', undefined)}
            >
              <Wand2 className="w-3.5 h-3.5" />
              用 AI 初始化知识库
            </button>
          </div>
        }
      />
    );
  }

  return (
    <div style={{ maxWidth: 960, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <ErrorBanner>{error}</ErrorBanner>
          </div>
          <button
            className="ide-btn ide-btn-sm ide-btn-ghost"
            onClick={() => setError(null)}
            title="关闭"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {checkIssues && checkIssues.length > 0 && (
        <div className="ide-card" style={{ borderColor: 'var(--state-warning)' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 6,
            }}
          >
            <span style={{ fontSize: 12.5, color: 'var(--state-warning)' }}>
              校验发现 {checkIssues.length} 项待补全（不影响保存草稿，发布前需解决）
            </span>
            <button
              className="ide-btn ide-btn-sm ide-btn-ghost"
              onClick={() => setCheckIssues(null)}
              title="关闭"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div
            className="ide-scroll"
            style={{ maxHeight: 160, overflow: 'auto', fontSize: 12, lineHeight: 1.7 }}
          >
            {checkIssues.slice(0, 100).map((m, i) => (
              <div key={i} style={{ color: 'var(--ide-text-secondary)' }}>
                {m}
              </div>
            ))}
            {checkIssues.length > 100 && (
              <div style={{ color: 'var(--ide-text-tertiary)' }}>
                … 其余 {checkIssues.length - 100} 项省略
              </div>
            )}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="ide-btn ide-btn-sm" onClick={() => void runInit()} disabled={busy}>
          <Wand2 className="w-3.5 h-3.5" />
          初始化枚举
        </button>
        <button className="ide-btn ide-btn-sm" onClick={() => void check()} disabled={busy}>
          <ShieldCheck className="w-3.5 h-3.5" />
          校验
        </button>
        <button
          className="ide-btn ide-btn-sm ide-btn-primary"
          onClick={() => void save()}
          disabled={busy}
        >
          <Save className="w-3.5 h-3.5" />
          保存
        </button>
        <button className="ide-btn ide-btn-sm" onClick={downloadExcel} disabled={busy}>
          <Download className="w-3.5 h-3.5" />
          下载 Excel
        </button>
        <label className="ide-btn ide-btn-sm" style={{ cursor: busy ? 'default' : 'pointer' }}>
          <Upload className="w-3.5 h-3.5" />
          上传 Excel
          <input
            type="file"
            accept=".xlsx"
            style={{ display: 'none' }}
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void uploadExcel(file, true);
            }}
          />
        </label>
        <button className="ide-btn ide-btn-sm" onClick={() => void bootstrap()} disabled={busy}>
          <RefreshCw className="w-3.5 h-3.5" />
          重新加载
        </button>
        <div className="ws-tabs" style={{ marginLeft: 4 }}>
          <button
            className={'ws-tab' + (view === 'table' ? ' active' : '')}
            onClick={() => setView('table')}
          >
            <Table2 className="w-3.5 h-3.5" style={{ display: 'inline', marginRight: 4 }} />
            表格
          </button>
          <button
            className={'ws-tab' + (view === 'json' ? ' active' : '')}
            onClick={enterJsonView}
          >
            <Braces className="w-3.5 h-3.5" style={{ display: 'inline', marginRight: 4 }} />
            JSON
          </button>
        </div>
        <span style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>
          草稿 {draftId} · {rows.length} 个绑定 · {names.length} 个枚举
        </span>
        {status && <span style={{ color: 'var(--state-success)', fontSize: 12.5 }}>{status}</span>}
      </div>

      {pendingUpload && (
        <div
          className="ide-card"
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            borderColor: 'var(--state-warning)',
          }}
        >
          <span style={{ fontSize: 12.5, flex: 1 }}>
            已预览上传的 Excel「{pendingUpload.name}」。确认后将按其内容覆盖草稿枚举配置。
          </span>
          <button
            className="ide-btn ide-btn-sm ide-btn-primary"
            onClick={() => void uploadExcel(pendingUpload, false)}
            disabled={busy}
          >
            确认导入
          </button>
          <button
            className="ide-btn ide-btn-sm ide-btn-ghost"
            onClick={() => setPendingUpload(null)}
            disabled={busy}
          >
            取消
          </button>
        </div>
      )}

      {view === 'json' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>
            直接预览 / 编辑 global/enums.json。点「应用到编辑器」解析回表格（仍需「保存」写入草稿）。
          </div>
          {jsonError && <ErrorBanner>{jsonError}</ErrorBanner>}
          <textarea
            className="ide-textarea ide-scroll ide-text-mono"
            value={jsonDraft}
            onChange={(e) => setJsonDraft(e.target.value)}
            spellCheck={false}
            style={{ minHeight: 460, fontSize: 12.5 }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="ide-btn ide-btn-sm ide-btn-primary" onClick={applyJson}>
              应用到编辑器
            </button>
            <button className="ide-btn ide-btn-sm" onClick={() => setView('table')}>
              取消
            </button>
          </div>
        </div>
      ) : selectedDict ? (
        <DictionaryEditor
          key={selectedDict}
          doc={doc!}
          name={selectedDict}
          onBack={() => setSelectedDict(null)}
          onChange={setDoc}
          onRename={(to) => {
            setDoc(renameDictionary(doc!, selectedDict, to));
            setSelectedDict(to.trim() || selectedDict);
          }}
        />
      ) : (
        <>
          <div className="ws-tabs" style={{ alignSelf: 'flex-start' }}>
            <button
              className={'ws-tab' + (tableTab === 'bindings' ? ' active' : '')}
              onClick={() => setTableTab('bindings')}
            >
              字段绑定
            </button>
            <button
              className={'ws-tab' + (tableTab === 'dicts' ? ' active' : '')}
              onClick={() => setTableTab('dicts')}
            >
              枚举字典
            </button>
          </div>
          <div
            className="ide-card"
            style={{ fontSize: 12.5, color: 'var(--ide-text-secondary)', lineHeight: 1.7 }}
          >
            {tableTab === 'bindings'
              ? '「字段绑定」对应 Excel 的第一张表：连接 / 数据库 / 表 / 字段 / 字段说明 / 枚举名称。点任意一行进入该枚举的 code→中文 配置。'
              : '「枚举字典」集中维护所有枚举名称及其 code→中文 映射（对应 Excel 第二张表）。点任意枚举进入配置。'}
          </div>
          <div style={{ position: 'relative', maxWidth: 420 }}>
            <Search
              className="w-3.5 h-3.5"
              style={{
                position: 'absolute',
                left: 10,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--ide-text-tertiary)',
              }}
            />
            <input
              className="ide-input"
              placeholder={
                tableTab === 'bindings' ? '搜索 数据库 / 表 / 字段 / 说明 / 枚举名称' : '搜索枚举名称'
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ paddingLeft: 30 }}
            />
          </div>
          {tableTab === 'dicts' ? (
            <DictionaryList
              doc={doc!}
              query={query}
              onSelect={(name) => setSelectedDict(name)}
            />
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>
                  {filteredRows.length} / {rows.length} 条绑定
                </span>
                <button
                  className="ide-btn ide-btn-sm"
                  onClick={() => {
                    setShowNewBinding(!showNewBinding);
                    if (showNewBinding) setNewBinding({ profileId: '', database: '', table: '', field: '', note: '', dictionary_name: '' });
                  }}
                >
                  <Plus className="w-3.5 h-3.5" />
                  新增绑定
                </button>
              </div>
              {showNewBinding && (
                <div className="ide-card" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10 }}>
                  <div style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>新增字段绑定</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                    <label style={{ fontSize: 12 }}>
                      <span style={{ color: 'var(--ide-text-tertiary)' }}>连接</span>
                      <input className="ide-input" value={newBinding.profileId} placeholder="连接名" onChange={(e) => setNewBinding({ ...newBinding, profileId: e.target.value })} />
                    </label>
                    <label style={{ fontSize: 12 }}>
                      <span style={{ color: 'var(--ide-text-tertiary)' }}>数据库</span>
                      <input className="ide-input" value={newBinding.database} placeholder="数据库名" onChange={(e) => setNewBinding({ ...newBinding, database: e.target.value })} />
                    </label>
                    <label style={{ fontSize: 12 }}>
                      <span style={{ color: 'var(--ide-text-tertiary)' }}>表</span>
                      <input className="ide-input" value={newBinding.table} placeholder="表名" onChange={(e) => setNewBinding({ ...newBinding, table: e.target.value })} />
                    </label>
                    <label style={{ fontSize: 12 }}>
                      <span style={{ color: 'var(--ide-text-tertiary)' }}>字段</span>
                      <input className="ide-input" value={newBinding.field} placeholder="字段名" onChange={(e) => setNewBinding({ ...newBinding, field: e.target.value })} />
                    </label>
                    <label style={{ fontSize: 12 }}>
                      <span style={{ color: 'var(--ide-text-tertiary)' }}>字段说明</span>
                      <input className="ide-input" value={newBinding.note} placeholder="可选" onChange={(e) => setNewBinding({ ...newBinding, note: e.target.value })} />
                    </label>
                    <label style={{ fontSize: 12 }}>
                      <span style={{ color: 'var(--ide-text-tertiary)' }}>枚举名称</span>
                      <input className="ide-input" value={newBinding.dictionary_name} placeholder="选择或输入枚举名" list="enum-names-list" onChange={(e) => setNewBinding({ ...newBinding, dictionary_name: e.target.value })} />
                    </label>
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button className="ide-btn ide-btn-sm" onClick={() => { setShowNewBinding(false); setNewBinding({ profileId: '', database: '', table: '', field: '', note: '', dictionary_name: '' }); }}>取消</button>
                    <button
                      className="ide-btn ide-btn-sm ide-btn-primary"
                      disabled={!newBinding.profileId || !newBinding.database || !newBinding.table || !newBinding.field || !newBinding.dictionary_name}
                      onClick={() => {
                        const tableId = `${newBinding.profileId}/${newBinding.database}/${newBinding.table}`;
                        setDoc(addBinding(doc!, { table_id: tableId, field: newBinding.field, dictionary_name: newBinding.dictionary_name, note: newBinding.note || undefined }));
                        setShowNewBinding(false);
                        setNewBinding({ profileId: '', database: '', table: '', field: '', note: '', dictionary_name: '' });
                        setStatus(`已添加绑定 ${tableId}.${newBinding.field} → ${newBinding.dictionary_name}（尚未保存）`);
                      }}
                    >
                      <Plus className="w-3.5 h-3.5" />
                      添加
                    </button>
                  </div>
                </div>
              )}
              {filteredRows.length === 0 && !showNewBinding ? (
                <EmptyState
                  title="暂无枚举绑定"
                  hint="点上方「初始化枚举」从数据库生成绑定与候选 code，或点「新增绑定」手动添加。"
                />
              ) : (
            <div className="ide-card ide-scroll" style={{ padding: 0, overflow: 'auto', maxHeight: 560 }}>
              {/* Datalist for enum name autocomplete */}
              <datalist id="enum-names-list">
                {names.map((n) => <option key={n} value={n} />)}
              </datalist>
              <table className="ide-table">
                <thead>
                  <tr>
                    <th>连接</th>
                    <th>数据库</th>
                    <th>表</th>
                    <th>字段</th>
                    <th>字段说明</th>
                    <th style={{ minWidth: 120 }}>枚举名称</th>
                    <th style={{ textAlign: 'right' }}>映射</th>
                    <th style={{ width: 60 }} />
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((r) => {
                    const c = completeness(dictionaryByName(doc!, r.dictionary_name));
                    return (
                      <tr
                        key={`${r.table_id} ${r.field}`}
                        style={{ cursor: 'pointer' }}
                        title="点击配置该枚举的 code→中文 映射"
                      >
                        <td style={{ color: 'var(--ide-text-tertiary)' }}>{r.profileId}</td>
                        <td>{r.database}</td>
                        <td className="ide-text-mono">{r.table}</td>
                        <td className="ide-text-mono">{r.field}</td>
                        <td style={{ color: 'var(--ide-text-secondary)' }}>{r.note || '—'}</td>
                        <td onClick={(event) => event.stopPropagation()}>
                          <input
                            key={`${r.table_id}/${r.field}/${r.dictionary_name}`}
                            className="ide-input"
                            defaultValue={r.dictionary_name}
                            list="enum-names-list"
                            title="修改枚举名称可拆分/合并字典；输入时可搜索已有枚举"
                            style={{ minWidth: 110 }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') event.currentTarget.blur();
                            }}
                            onBlur={(event) => {
                              const nextName = event.currentTarget.value.trim();
                              if (nextName && nextName !== r.dictionary_name) {
                                setDoc(
                                  rebindDictionary(
                                    doc!,
                                    r.table_id,
                                    r.field,
                                    nextName,
                                  ),
                                );
                                setStatus(
                                  `字段 ${r.table}.${r.field} 已改绑到「${nextName}」（尚未保存）`,
                                );
                              } else {
                                event.currentTarget.value = r.dictionary_name;
                              }
                            }}
                          />
                        </td>
                        <td style={{ textAlign: 'right' }} onClick={() => setSelectedDict(r.dictionary_name)}>
                          <Badge kind={c.total > 0 && c.filled === c.total ? 'success' : 'warning'}>
                            {c.filled}/{c.total}
                          </Badge>
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button
                            className="ide-btn ide-btn-sm ide-btn-ghost"
                            onClick={() => setSelectedDict(r.dictionary_name)}
                            title="编辑 code→中文 映射"
                            style={{ padding: '2px 4px' }}
                          >
                            <ChevronRight className="w-3.5 h-3.5" style={{ color: 'var(--ide-text-tertiary)' }} />
                          </button>
                          <button
                            className="ide-btn ide-btn-sm ide-btn-ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!window.confirm(`确认删除绑定「${r.table}.${r.field} → ${r.dictionary_name}」？\n不会删除字典本身。`)) return;
                              setDoc(removeBinding(doc!, r.table_id, r.field));
                              setStatus(`已移除绑定 ${r.table}.${r.field}（尚未保存）`);
                            }}
                            title="删除该绑定（不删除字典）"
                            style={{ padding: '2px 4px' }}
                          >
                            <X className="w-3 h-3" style={{ color: 'var(--ide-text-tertiary)' }} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function DictionaryList({
  doc,
  query,
  onSelect,
}: {
  doc: EnumsDocument;
  query: string;
  onSelect: (name: string) => void;
}): JSX.Element {
  const q = query.trim().toLowerCase();
  const names = dictionaryNames(doc).filter((n) => !q || n.toLowerCase().includes(q));
  const countByDict = new Map<string, number>();
  for (const b of doc.bindings ?? [])
    countByDict.set(b.dictionary_name, (countByDict.get(b.dictionary_name) ?? 0) + 1);

  if (names.length === 0) {
    return <EmptyState title="暂无枚举字典" hint="点上方「初始化枚举」生成，或在字段绑定中指定枚举名称。" />;
  }
  return (
    <div className="ide-card" style={{ padding: 0, overflow: 'auto', maxHeight: 560 }}>
      <table className="ide-table">
        <thead>
          <tr>
            <th>枚举名称</th>
            <th style={{ textAlign: 'right' }}>绑定字段</th>
            <th style={{ textAlign: 'right' }}>映射完成度</th>
            <th style={{ width: 28 }} />
          </tr>
        </thead>
        <tbody>
          {names.map((name) => {
            const c = completeness(dictionaryByName(doc, name));
            return (
              <tr
                key={name}
                onClick={() => onSelect(name)}
                style={{ cursor: 'pointer' }}
                title="点击配置该枚举的 code→中文 映射"
              >
                <td>{name}</td>
                <td className="ide-num" style={{ textAlign: 'right' }}>
                  {countByDict.get(name) ?? 0}
                </td>
                <td style={{ textAlign: 'right' }}>
                  <Badge kind={c.total > 0 && c.filled === c.total ? 'success' : 'warning'}>
                    {c.filled}/{c.total}
                  </Badge>
                </td>
                <td>
                  <ChevronRight
                    className="w-3.5 h-3.5"
                    style={{ color: 'var(--ide-text-tertiary)' }}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DictionaryEditor({
  doc,
  name,
  onChange,
  onRename,
  onBack,
}: {
  doc: EnumsDocument;
  name: string;
  onChange: (doc: EnumsDocument) => void;
  onRename: (to: string) => void;
  onBack: () => void;
}): JSX.Element {
  const dict = dictionaryByName(doc, name);
  const boundFields: EnumBindingRow[] = bindingRows(doc).filter(
    (b) => b.dictionary_name === name,
  );
  const [nameDraft, setNameDraft] = useState(name);

  function setValues(values: EnumValue[]): void {
    onChange(setDictionaryValues(doc, name, values));
  }
  function updateValue(index: number, next: Partial<EnumValue>): void {
    setValues(dict.values.map((v, i) => (i === index ? { ...v, ...next } : v)));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <button
        className="ide-btn ide-btn-sm ide-btn-ghost"
        onClick={onBack}
        style={{ alignSelf: 'flex-start' }}
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        返回绑定列表
      </button>
      <div className="ide-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label style={{ fontSize: 12 }}>
          <div style={{ color: 'var(--ide-text-tertiary)', marginBottom: 4 }}>枚举名称</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="ide-input"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              className="ide-btn ide-btn-sm"
              onClick={() => onRename(nameDraft)}
              disabled={nameDraft.trim() === name || !nameDraft.trim()}
              title="重命名会同步所有绑定；与已有枚举同名则合并"
            >
              重命名
            </button>
          </div>
        </label>
        <div>
          <div style={{ fontSize: 12, color: 'var(--ide-text-tertiary)', marginBottom: 6 }}>
            绑定字段（{boundFields.length}）
          </div>
          <div className="ide-card" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="ide-table">
              <thead>
                <tr>
                  <th>连接</th>
                  <th>数据库</th>
                  <th>表</th>
                  <th>字段</th>
                  <th>字段说明</th>
                </tr>
              </thead>
              <tbody>
                {boundFields.map((b) => (
                  <tr key={`${b.table_id} ${b.field}`}>
                    <td style={{ color: 'var(--ide-text-tertiary)' }}>{b.profileId}</td>
                    <td>{b.database}</td>
                    <td className="ide-text-mono">{b.table}</td>
                    <td className="ide-text-mono">{b.field}</td>
                    <td style={{ color: 'var(--ide-text-secondary)' }}>{b.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <SectionTitle>code → 中文映射</SectionTitle>
          <button
            className="ide-btn ide-btn-sm"
            onClick={() => setValues([...dict.values, { value: '', label: '', description: '' }])}
          >
            <Plus className="w-3.5 h-3.5" />
            添加映射
          </button>
        </div>
        {dict.values.length === 0 ? (
          <EmptyState title="暂无映射" hint="点「添加映射」或用「初始化枚举」从数据库预填 code。" />
        ) : (
          <div className="ide-card" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="ide-table">
              <thead>
                <tr>
                  <th style={{ width: '30%' }}>枚举code</th>
                  <th style={{ width: '35%' }}>中文名称</th>
                  <th>说明</th>
                  <th style={{ width: 40 }} />
                </tr>
              </thead>
              <tbody>
                {dict.values.map((v, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        className="ide-input ide-text-mono"
                        value={v.value}
                        placeholder="CODE"
                        onChange={(e) => updateValue(i, { value: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className="ide-input"
                        value={v.label}
                        placeholder="中文名称"
                        onChange={(e) => updateValue(i, { label: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className="ide-input"
                        value={v.description ?? ''}
                        placeholder="可选"
                        onChange={(e) => updateValue(i, { description: e.target.value })}
                      />
                    </td>
                    <td>
                      <button
                        className="ide-btn ide-btn-sm ide-btn-ghost"
                        onClick={() => setValues(dict.values.filter((_, j) => j !== i))}
                        title="删除该映射"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
