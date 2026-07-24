import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshCw,
  Flame,
  Thermometer,
  Snowflake,
  Table2,
  Search,
  Pencil,
  Save,
  X,
  ShieldCheck,
  PackageCheck,
  ArrowRightLeft,
  Database,
} from 'lucide-react';
import {
  workspaceApi,
  type Project,
  type CatalogKind,
  type CatalogList,
  type CatalogOverview,
  type TableDetail,
  type TableOverview,
  type Tier,
  type TableSemanticPatch,
  type FieldSemanticPatch,
} from '../api.js';
import { TopBar, PageBody, Card, ErrorBanner, Loading, Badge } from '../components/ui/common.js';
import {
  allTables,
  filterTables,
  extractFields,
  extractHeader,
  TIER_LABEL,
  type FieldRow,
} from './knowledge-view.js';
import { AgentQuickStart } from './AgentQuickStart.js';
import { KNOWLEDGE_ACTION_VERBS } from './agent-chat.js';
import { useAgentDrawer, useAgentRefresh } from '../AgentDrawer.js';

const TIER_ICON: Record<Tier, JSX.Element> = {
  hot: <Flame className="w-3.5 h-3.5" style={{ color: 'var(--state-error)' }} />,
  warm: <Thermometer className="w-3.5 h-3.5" style={{ color: 'var(--state-warning)' }} />,
  cold: <Snowflake className="w-3.5 h-3.5" style={{ color: 'var(--state-info)' }} />,
};
const TIER_BADGE: Record<Tier, 'error' | 'warning' | 'info'> = {
  hot: 'error',
  warm: 'warning',
  cold: 'info',
};

interface Selection {
  kind: CatalogKind;
  id: string;
}

export function KnowledgePanel({ project }: { project: Project }): JSX.Element {
  const [catalogs, setCatalogs] = useState<CatalogList | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [overview, setOverview] = useState<CatalogOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { startAction } = useAgentDrawer();
  const refreshNonce = useAgentRefresh();

  const loadCatalogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await workspaceApi.getCatalogs(project.id);
      setCatalogs(list);
      if (list.latestDraftId) setSelection({ kind: 'draft', id: list.latestDraftId });
      else if (list.currentVersion) setSelection({ kind: 'version', id: list.currentVersion });
      else if (list.versions[0]) setSelection({ kind: 'version', id: list.versions[0].id });
      else setSelection(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    void loadCatalogs();
  }, [loadCatalogs, refreshNonce]);

  useEffect(() => {
    let cancelled = false;
    if (!selection) {
      setOverview(null);
      return;
    }
    setOverview(null);
    workspaceApi
      .getCatalog(project.id, selection.kind, selection.id)
      .then((o) => {
        if (!cancelled) setOverview(o);
      })
      .catch((e) => {
        if (!cancelled) setError(String((e as Error).message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, selection]);

  const hasAny = catalogs && (catalogs.drafts.length > 0 || catalogs.versions.length > 0);

  return (
    <>
      <TopBar
        title="知识库"
        right={
          <>
            {catalogs && hasAny && (
              <div className="ws-tabs">
                {catalogs.drafts.map((d) => (
                  <button
                    key={`d-${d.id}`}
                    className={
                      'ws-tab' +
                      (selection?.kind === 'draft' && selection.id === d.id ? ' active' : '')
                    }
                    onClick={() => setSelection({ kind: 'draft', id: d.id })}
                    title={d.id}
                  >
                    草稿
                  </button>
                ))}
                {catalogs.versions.map((v) => (
                  <button
                    key={`v-${v.id}`}
                    className={
                      'ws-tab' +
                      (selection?.kind === 'version' && selection.id === v.id ? ' active' : '')
                    }
                    onClick={() => setSelection({ kind: 'version', id: v.id })}
                    title={v.id}
                  >
                    发布 {v.id}
                    {v.isCurrent ? ' ✓' : ''}
                  </button>
                ))}
              </div>
            )}
            <button
              className="ide-btn ide-btn-sm"
              onClick={() => void loadCatalogs()}
              disabled={loading}
            >
              <RefreshCw className="w-3.5 h-3.5" />
              {loading ? '刷新中…' : '刷新'}
            </button>
            <AgentQuickStart projectId={project.id} actions={KNOWLEDGE_ACTION_VERBS} />
          </>
        }
      />
      <PageBody>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {!catalogs && !error && <Loading text="正在读取知识库…" />}
        {catalogs && !hasAny && (
          <Card>
            <div style={{ fontSize: 12.5, color: 'var(--ide-text-secondary)', lineHeight: 1.6, marginBottom: 12 }}>
              尚无知识库草稿或已发布版本。点下方按钮让 AI 扫描数据库并生成知识库草稿（默认为{' '}
              <Badge kind="neutral">draft</Badge> 状态），生成后本页会自动刷新。
            </div>
            <button
              className="ide-btn ide-btn-primary ide-btn-sm"
              onClick={() =>
                startAction(project.id, 'initialize-knowledge', undefined)
              }
            >
              <Database className="w-3.5 h-3.5" />
              用 AI 初始化知识库
            </button>
          </Card>
        )}
        {selection && (
          <CatalogViewer
            project={project}
            selection={selection}
            overview={overview}
            isCurrentVersion={
              selection.kind === 'version' && catalogs?.currentVersion === selection.id
            }
            onReload={() => void loadCatalogs()}
          />
        )}
      </PageBody>
    </>
  );
}

function CatalogViewer({
  project,
  selection,
  overview,
  isCurrentVersion,
  onReload,
}: {
  project: Project;
  selection: Selection;
  overview: CatalogOverview | null;
  isCurrentVersion?: boolean;
  onReload: () => void;
}): JSX.Element {
  const isDraft = selection.kind === 'draft';
  const tables = useMemo(() => allTables(overview), [overview]);
  const { startAction } = useAgentDrawer();

  const [tiers, setTiers] = useState<Set<Tier>>(new Set<Tier>(['hot', 'warm']));
  const [query, setQuery] = useState('');
  const [dbFilter, setDbFilter] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [detailKey, setDetailKey] = useState(0);
  const [opMsg, setOpMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  // Publish readiness failure, shown inside the dialog (kept open so the user
  // reads what's blocking and how to fix it — not a raw JSON toast behind it).
  const [publishError, setPublishError] = useState<string | null>(null);

  const filtered = useMemo(
    () => filterTables(tables, { tiers, query, database: dbFilter }),
    [tables, tiers, query, dbFilter],
  );

  function toggleTier(t: Tier): void {
    const next = new Set(tiers);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setTiers(next);
  }

  async function validate(): Promise<void> {
    setBusy(true);
    setOpMsg(null);
    try {
      const r = await workspaceApi.validateCatalog(project.id, selection.id);
      const j = r.json as { ok?: boolean; errors?: unknown[]; warnings?: unknown[] } | null;
      if (r.ok && j?.ok) {
        const warn = Array.isArray(j.warnings) ? j.warnings.length : 0;
        setOpMsg({ kind: 'ok', text: `校验通过${warn ? `（${warn} 条警告）` : ''}` });
      } else {
        const errs = Array.isArray(j?.errors) ? j!.errors!.map((e) => String(e)).join('；') : r.stderr;
        setOpMsg({ kind: 'err', text: `校验未通过：${errs || '见 CLI 输出'}` });
      }
    } catch (e) {
      setOpMsg({ kind: 'err', text: String((e as Error).message ?? e) });
    } finally {
      setBusy(false);
    }
  }

  async function promote(tableId: string, to: Tier, reason: string): Promise<void> {
    setBusy(true);
    setOpMsg(null);
    try {
      await workspaceApi.promoteTable(project.id, selection.id, tableId, to, reason);
      setOpMsg({ kind: 'ok', text: `已将表切换为「${TIER_LABEL[to]}」并重生成索引` });
      onReload();
      setDetailKey((k) => k + 1);
    } catch (e) {
      setOpMsg({ kind: 'err', text: String((e as Error).message ?? e) });
    } finally {
      setBusy(false);
    }
  }

  async function publish(version: string, publishedBy: string, decision: string): Promise<void> {
    setBusy(true);
    setOpMsg(null);
    setPublishError(null);
    try {
      await workspaceApi.publishCatalog(project.id, selection.id, version, publishedBy, decision);
      setShowPublish(false);
      setOpMsg({ kind: 'ok', text: `已发布版本 ${version}` });
      onReload();
    } catch (e) {
      // Keep the dialog open and show the reason INSIDE it (readiness failures
      // like unapproved review / unresolved questions need context, not a toast).
      setPublishError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  if (!overview) return <Loading text="正在读取目录…" />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge kind={isDraft ? 'warning' : isCurrentVersion ? 'success' : 'neutral'} dot>
          {isDraft ? '草稿（可编辑）' : isCurrentVersion ? '已发布 · 当前' : '已发布'}
        </Badge>
        <span style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>{selection.id}</span>
        {overview.system?.name && (
          <span style={{ fontSize: 12.5, color: 'var(--ide-text-secondary)' }}>
            {overview.system.name}
          </span>
        )}
        {overview.counts && (
          <span
            style={{
              display: 'inline-flex',
              gap: 10,
              marginLeft: 'auto',
              fontSize: 12,
              alignItems: 'center',
            }}
          >
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              {TIER_ICON.hot} 热 {overview.counts.hot}
            </span>
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              {TIER_ICON.warm} 温 {overview.counts.warm}
            </span>
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              {TIER_ICON.cold} 冷 {overview.counts.cold}
            </span>
            <span style={{ color: 'var(--ide-text-tertiary)' }}>共 {overview.counts.total}</span>
          </span>
        )}
      </div>

      {isDraft && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="ide-btn ide-btn-sm" onClick={() => void validate()} disabled={busy}>
            <ShieldCheck className="w-3.5 h-3.5" />
            校验
          </button>
          <button
            className="ide-btn ide-btn-sm ide-btn-primary"
            onClick={() => {
              setPublishError(null);
              setShowPublish(true);
            }}
            disabled={busy}
          >
            <PackageCheck className="w-3.5 h-3.5" />
            发布
          </button>
          {opMsg && (
            <span
              style={{
                fontSize: 12.5,
                color: opMsg.kind === 'ok' ? 'var(--state-success)' : 'var(--state-error)',
              }}
            >
              {opMsg.text}
            </span>
          )}
        </div>
      )}

      {showPublish && (
        <PublishDialog
          busy={busy}
          error={publishError}
          onCancel={() => {
            setShowPublish(false);
            setPublishError(null);
          }}
          onFix={() => {
            setShowPublish(false);
            setPublishError(null);
            startAction(project.id, 'initialize-knowledge', undefined);
          }}
          onSubmit={publish}
        />
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 380px) 1fr', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <div style={{ position: 'relative' }}>
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
              placeholder="搜索表名 / 业务名 / 注释"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ paddingLeft: 30 }}
            />
          </div>

          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {(['hot', 'warm', 'cold'] as Tier[]).map((t) => (
              <button
                key={t}
                className="ide-chip"
                onClick={() => toggleTier(t)}
                style={{ opacity: tiers.has(t) ? 1 : 0.4, cursor: 'pointer' }}
              >
                {TIER_ICON[t]} {TIER_LABEL[t]}
              </button>
            ))}
            <select
              className="ide-input"
              value={dbFilter ?? ''}
              onChange={(e) => setDbFilter(e.target.value || null)}
              style={{ marginLeft: 'auto', maxWidth: 200, fontSize: 12 }}
            >
              <option value="">全部数据库</option>
              {overview.databases.map((g) => (
                <option key={`${g.profileId}/${g.database}`} value={`${g.profileId}/${g.database}`}>
                  {g.database}
                </option>
              ))}
            </select>
          </div>

          <div style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>
            {filtered.length} / {tables.length} 张表
          </div>

          <div
            className="ide-card ide-scroll"
            style={{ padding: 4, maxHeight: 560, overflow: 'auto' }}
          >
            {filtered.length === 0 ? (
              <div style={{ padding: 12, fontSize: 12, color: 'var(--ide-text-tertiary)' }}>
                无匹配的表
              </div>
            ) : (
              filtered.map((t) => (
                <TableRow
                  key={t.tableId}
                  t={t}
                  active={selectedTable === t.tableId}
                  onClick={() => setSelectedTable(t.tableId)}
                />
              ))
            )}
          </div>
        </div>

        <div style={{ minWidth: 0 }}>
          {selectedTable ? (
            <TableDetailView
              key={`${selectedTable}-${detailKey}`}
              project={project}
              selection={selection}
              tableId={selectedTable}
              editable={isDraft}
              onPromote={isDraft ? (to, reason) => promote(selectedTable, to, reason) : undefined}
              busy={busy}
            />
          ) : (
            <Card>
              <div style={{ fontSize: 12.5, color: 'var(--ide-text-secondary)' }}>
                从左侧选择一张表查看详情
                {isDraft ? '（草稿可编辑表/字段语义）' : ''}。
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function TableRow({
  t,
  active,
  onClick,
}: {
  t: TableOverview;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        padding: '7px 8px',
        borderRadius: 6,
        background: active ? 'var(--ide-bg-elevated)' : 'transparent',
        border: 'none',
        cursor: 'pointer',
      }}
    >
      {TIER_ICON[t.tier]}
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
        <span
          className="ide-text-mono"
          style={{
            fontSize: 12.5,
            color: 'var(--ide-text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {t.table}
        </span>
        {t.name && (
          <span
            style={{
              fontSize: 11.5,
              color: 'var(--ide-text-tertiary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {t.name}
          </span>
        )}
      </span>
      {t.overrideSource && (
        <Badge kind="neutral" title="该表的冷热温分层是用户手动设置的（非自动推断）">
          手动分层
        </Badge>
      )}
      {t.fieldCount != null && (
        <span className="ide-num" style={{ fontSize: 11, color: 'var(--ide-text-tertiary)' }}>
          {t.fieldCount}
        </span>
      )}
    </button>
  );
}

const OPERATORS = ['eq', 'in', 'contains', 'between', 'gt', 'gte', 'lt', 'lte'];

interface EditState {
  name: string;
  description: string;
  domain: string;
  fields: Record<string, FieldRow>;
}

function buildEditState(header: ReturnType<typeof extractHeader>, fields: FieldRow[]): EditState {
  const byName: Record<string, FieldRow> = {};
  for (const f of fields) byName[f.name] = { ...f };
  return {
    name: header.name ?? '',
    description: header.description ?? '',
    domain: header.domain ?? '',
    fields: byName,
  };
}

function TableDetailView({
  project,
  selection,
  tableId,
  editable,
  onPromote,
  busy,
}: {
  project: Project;
  selection: Selection;
  tableId: string;
  editable: boolean;
  onPromote?: (to: Tier, reason: string) => void;
  busy?: boolean;
}): JSX.Element {
  const [detail, setDetail] = useState<TableDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    setEditing(false);
    setStatus(null);
    workspaceApi
      .getCatalogTable(project.id, selection.kind, selection.id, tableId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String((e as Error).message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, selection, tableId, reloadKey]);

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (!detail) return <Loading text="正在读取表详情…" />;

  const header = extractHeader(detail.data);
  const fields = detail.hasFields ? extractFields(detail.data) : [];

  function beginEdit(): void {
    setEdit(buildEditState(header, fields));
    setEditing(true);
    setStatus(null);
  }

  function buildPatch(e: EditState): TableSemanticPatch {
    const patch: TableSemanticPatch = {};
    if (e.name !== (header.name ?? '')) patch.name = e.name || null;
    if (e.description !== (header.description ?? '')) patch.description = e.description || null;
    if (e.domain !== (header.domain ?? '')) patch.domain = e.domain || null;
    const fieldPatches: FieldSemanticPatch[] = [];
    for (const orig of fields) {
      const ed = e.fields[orig.name];
      if (!ed) continue;
      const fp: FieldSemanticPatch = { field: orig.name };
      let changed = false;
      if ((ed.semanticName ?? '') !== (orig.semanticName ?? '')) {
        fp.name = ed.semanticName || null;
        changed = true;
      }
      if ((ed.semanticDescription ?? '') !== (orig.semanticDescription ?? '')) {
        fp.description = ed.semanticDescription || null;
        changed = true;
      }
      if (ed.reportExposed !== orig.reportExposed) {
        fp.reportExposed = ed.reportExposed;
        changed = true;
      }
      if (ed.filterEnabled !== orig.filterEnabled) {
        fp.filterEnabled = ed.filterEnabled;
        changed = true;
      }
      if ((ed.filterRole ?? '') !== (orig.filterRole ?? '')) {
        fp.filterRole = ed.filterRole || null;
        changed = true;
      }
      if ((ed.defaultOperator ?? '') !== (orig.defaultOperator ?? '')) {
        fp.defaultOperator = ed.defaultOperator || null;
        changed = true;
      }
      if (changed) fieldPatches.push(fp);
    }
    if (fieldPatches.length > 0) patch.fields = fieldPatches;
    return patch;
  }

  async function save(): Promise<void> {
    if (!edit || !detail) return;
    const patch = buildPatch(edit);
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      setStatus('未检测到修改');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await workspaceApi.saveTableSemantics(
        project.id,
        selection.id,
        tableId,
        patch,
        detail.revision ?? '',
      );
      setEditing(false);
      setStatus('已保存到草稿（原子写入，已备份上一版本）');
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  }

  function patchField(name: string, next: Partial<FieldRow>): void {
    if (!edit) return;
    setEdit({ ...edit, fields: { ...edit.fields, [name]: { ...edit.fields[name]!, ...next } } });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="ide-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Table2 className="w-4 h-4" style={{ color: 'var(--ide-text-tertiary)' }} />
          <span className="ide-text-mono" style={{ fontSize: 14, fontWeight: 600 }}>
            {splitTable(tableId)}
          </span>
          <Badge kind={TIER_BADGE[detail.tier]} dot>
            {TIER_LABEL[detail.tier]}表
          </Badge>
          {header.estimatedRows != null && (
            <span style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>
              ≈ {header.estimatedRows.toLocaleString()} 行
            </span>
          )}
          {editable && detail.hasFields && (
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              {editing ? (
                <>
                  <button
                    className="ide-btn ide-btn-sm ide-btn-ghost"
                    onClick={() => setEditing(false)}
                    disabled={saving}
                  >
                    <X className="w-3.5 h-3.5" />
                    取消
                  </button>
                  <button
                    className="ide-btn ide-btn-sm ide-btn-primary"
                    onClick={() => void save()}
                    disabled={saving}
                  >
                    <Save className="w-3.5 h-3.5" />
                    {saving ? '保存中…' : '保存'}
                  </button>
                </>
              ) : (
                <button className="ide-btn ide-btn-sm" onClick={beginEdit}>
                  <Pencil className="w-3.5 h-3.5" />
                  编辑语义
                </button>
              )}
            </span>
          )}
        </div>

        {onPromote && !editing && (
          <TierSwitch current={detail.tier} busy={busy} onPromote={onPromote} />
        )}

        {editing && edit ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ fontSize: 12 }}>
              <div style={{ color: 'var(--ide-text-tertiary)', marginBottom: 4 }}>业务名称</div>
              <input
                className="ide-input"
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                placeholder={header.comment ?? '表业务名'}
              />
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <label style={{ fontSize: 12, flex: 1 }}>
                <div style={{ color: 'var(--ide-text-tertiary)', marginBottom: 4 }}>业务描述</div>
                <input
                  className="ide-input"
                  value={edit.description}
                  onChange={(e) => setEdit({ ...edit, description: e.target.value })}
                />
              </label>
              <label style={{ fontSize: 12, flex: '0 0 200px' }}>
                <div style={{ color: 'var(--ide-text-tertiary)', marginBottom: 4 }}>业务域</div>
                <input
                  className="ide-input"
                  value={edit.domain}
                  onChange={(e) => setEdit({ ...edit, domain: e.target.value })}
                />
              </label>
            </div>
          </div>
        ) : (
          <>
            {header.name && <div style={{ fontSize: 13 }}>{header.name}</div>}
            {(header.description || header.comment) && (
              <div style={{ fontSize: 12.5, color: 'var(--ide-text-secondary)' }}>
                {header.description ?? header.comment}
              </div>
            )}
            {header.domain && (
              <div style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>
                业务域：{header.domain}
              </div>
            )}
            {header.activityNote && (
              <div style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>
                活跃度：{header.activityNote}
              </div>
            )}
            {header.overrideReason && (
              <div style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>
                分层调整原因：{header.overrideReason}
              </div>
            )}
          </>
        )}
        {status && <div style={{ fontSize: 12, color: 'var(--state-success)' }}>{status}</div>}
      </div>

      {detail.hasFields ? (
        <div className="ide-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ maxHeight: 460, overflow: 'auto' }} className="ide-scroll">
            <table className="ide-table">
              <thead>
                <tr>
                  <th>字段</th>
                  <th>类型</th>
                  <th>业务语义</th>
                  <th>报表字段</th>
                  <th>筛选</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((f) => {
                  const e = editing && edit ? edit.fields[f.name]! : f;
                  return (
                    <tr key={f.name}>
                      <td className="ide-text-mono" style={{ whiteSpace: 'nowrap' }}>
                        {f.name}
                        {f.primaryKey && (
                          <Badge kind="neutral" title="主键">
                            PK
                          </Badge>
                        )}
                      </td>
                      <td style={{ color: 'var(--ide-text-tertiary)', whiteSpace: 'nowrap' }}>
                        {f.dataType}
                      </td>
                      {editing ? (
                        <>
                          <td style={{ minWidth: 220 }}>
                            <input
                              className="ide-input"
                              value={e.semanticName ?? ''}
                              placeholder={f.comment ?? '业务名'}
                              onChange={(ev) => patchField(f.name, { semanticName: ev.target.value })}
                              style={{ marginBottom: 4 }}
                            />
                            <input
                              className="ide-input"
                              value={e.semanticDescription ?? ''}
                              placeholder="描述（可选）"
                              onChange={(ev) =>
                                patchField(f.name, { semanticDescription: ev.target.value })
                              }
                            />
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              title="勾选表示该字段可用于报表"
                              checked={e.reportExposed}
                              onChange={(ev) =>
                                patchField(f.name, { reportExposed: ev.target.checked })
                              }
                            />
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                              <input
                                type="checkbox"
                                checked={e.filterEnabled}
                                onChange={(ev) =>
                                  patchField(f.name, { filterEnabled: ev.target.checked })
                                }
                              />
                              启用
                            </label>
                            {e.filterEnabled && (
                              <select
                                className="ide-input"
                                value={e.defaultOperator ?? ''}
                                onChange={(ev) =>
                                  patchField(f.name, { defaultOperator: ev.target.value })
                                }
                                style={{ marginTop: 4, fontSize: 12 }}
                              >
                                <option value="">（默认算子）</option>
                                {OPERATORS.map((op) => (
                                  <option key={op} value={op}>
                                    {op}
                                  </option>
                                ))}
                              </select>
                            )}
                          </td>
                        </>
                      ) : (
                        <>
                          <td>
                            <div>{f.semanticName ?? f.comment ?? '—'}</div>
                            {f.semanticDescription && (
                              <div style={{ fontSize: 11.5, color: 'var(--ide-text-tertiary)' }}>
                                {f.semanticDescription}
                              </div>
                            )}
                          </td>
                          <td>
                            {f.reportExposed ? (
                              <Badge kind="success" title="该字段可用于报表">命中</Badge>
                            ) : (
                              <span style={{ color: 'var(--ide-text-tertiary)' }} title="该字段不用于报表">
                                —
                              </span>
                            )}
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {f.filterEnabled ? (
                              <span style={{ fontSize: 12 }}>
                                {f.filterRole ?? ''}
                                {f.defaultOperator ? ` · ${f.defaultOperator}` : ''}
                              </span>
                            ) : (
                              <span style={{ color: 'var(--ide-text-tertiary)' }}>关闭</span>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <Card>
          <div style={{ fontSize: 12.5, color: 'var(--ide-text-secondary)', lineHeight: 1.6 }}>
            冷表不保存字段明细。若该表实际用于报表，可将其切换为热/温表（下一步启用分层切换后，会从扫描快照恢复字段）。
          </div>
        </Card>
      )}
    </div>
  );
}

function TierSwitch({
  current,
  busy,
  onPromote,
}: {
  current: Tier;
  busy?: boolean;
  onPromote: (to: Tier, reason: string) => void;
}): JSX.Element {
  const [target, setTarget] = useState<Tier | null>(null);
  const [reason, setReason] = useState('');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <ArrowRightLeft className="w-3.5 h-3.5" style={{ color: 'var(--ide-text-tertiary)' }} />
        <span style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>切换分层：</span>
        {(['hot', 'warm', 'cold'] as Tier[]).map((t) => (
          <button
            key={t}
            className={'ide-btn ide-btn-sm' + (target === t ? ' ide-btn-primary' : '')}
            disabled={t === current || busy}
            onClick={() => setTarget(t === target ? null : t)}
          >
            {TIER_ICON[t]} {TIER_LABEL[t]}
          </button>
        ))}
      </div>
      {target && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="ide-input"
            placeholder={
              (current === 'cold' ? '冷→' : '') + `切换为「${TIER_LABEL[target]}」的原因（必填）`
            }
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={{ flex: 1, minWidth: 220 }}
          />
          <button
            className="ide-btn ide-btn-sm ide-btn-primary"
            disabled={!reason.trim() || busy}
            onClick={() => {
              onPromote(target, reason.trim());
              setTarget(null);
              setReason('');
            }}
          >
            确认切换
          </button>
          {current === 'cold' && target !== 'cold' && (
            <span style={{ fontSize: 11.5, color: 'var(--ide-text-tertiary)' }}>
              将从扫描快照恢复字段明细
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Turn a raw publish-readiness error string into human-friendly reasons + fixes.
 * The CLI joins failures with "; " after a "Catalog is not publishable:" prefix;
 * we split them and map each known blocker to a 中文 explanation and how to
 * resolve it (usually via the AI assistant or the semantic/enum editors).
 */
interface PublishBlocker {
  reason: string;
  fix: string;
}
function explainPublishError(raw: string): { blockers: PublishBlocker[]; raw: string } {
  const stripped = raw.replace(/^.*?Catalog is not publishable:\s*/i, '').trim();
  const parts = (stripped || raw)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  const blockers: PublishBlocker[] = parts.map((part) => {
    if (/Semantic review is not approved/i.test(part)) {
      return {
        reason: '语义审阅尚未批准。',
        fix: '点右上「AI 助手 → 初始化知识库」继续该草稿的对话，让 AI 完成一次批量语义审阅并在你确认后标记为已批准（approved）。',
      };
    }
    const qs = part.match(/has\s+(\d+)\s+unresolved table questions/i);
    if (qs) {
      return {
        reason: `还有 ${qs[1]} 个表的语义问题未解决（reviews/blocking-issues.json）。`,
        fix: '点右上「AI 助手 → 初始化知识库」继续对话，让 AI 逐项处理这些阻塞问题；也可在下方表语义中补全业务名称/说明后再让 AI 重新审阅。',
      };
    }
    const hotName = part.match(/Hot table business semantics are not usable:\s*(.+)/i);
    if (hotName) {
      return {
        reason: `热表业务语义未就绪：${hotName[1]}（缺业务名或状态仍为 unverified）。`,
        fix: '为该表填写业务名称并将状态提升为 inferred/confirmed；若暂不需要，可将其降级为 warm/cold。',
      };
    }
    const hotScope = part.match(/Hot table security scope is not usable:\s*(.+)/i);
    if (hotScope) {
      return {
        reason: `热表安全范围未就绪：${hotScope[1]}。`,
        fix: '补全该表的安全范围（scope_status 为 inferred/confirmed/not_applicable）。',
      };
    }
    // Unknown blocker — surface verbatim so nothing is hidden.
    return { reason: part, fix: '' };
  });
  return { blockers, raw };
}

function PublishDialog({
  busy,
  error,
  onCancel,
  onFix,
  onSubmit,
}: {
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  /** Open the AI assistant to resolve readiness blockers. */
  onFix: () => void;
  onSubmit: (version: string, publishedBy: string, decision: string) => void;
}): JSX.Element {
  const [version, setVersion] = useState('1.0.0');
  const [publishedBy, setPublishedBy] = useState('studio');
  const [decision, setDecision] = useState('');
  const valid = /^\d+\.\d+\.\d+$/.test(version.trim());
  const explained = error ? explainPublishError(error) : null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
      onClick={onCancel}
    >
      <div
        className="ide-card"
        style={{ width: 460, maxWidth: '90vw', display: 'flex', flexDirection: 'column', gap: 12 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 14, fontWeight: 600 }}>发布知识库版本</div>
        <div style={{ fontSize: 12, color: 'var(--ide-text-secondary)', lineHeight: 1.6 }}>
          发布会先校验就绪度，然后把草稿拷贝为不可变版本 knowledge/versions/&lt;版本&gt; 并更新
          index.json。草稿保留，可继续迭代。
        </div>
        <label style={{ fontSize: 12 }}>
          <div style={{ color: 'var(--ide-text-tertiary)', marginBottom: 4 }}>版本号（x.y.z）</div>
          <input className="ide-input" value={version} onChange={(e) => setVersion(e.target.value)} />
        </label>
        <label style={{ fontSize: 12 }}>
          <div style={{ color: 'var(--ide-text-tertiary)', marginBottom: 4 }}>发布人</div>
          <input
            className="ide-input"
            value={publishedBy}
            onChange={(e) => setPublishedBy(e.target.value)}
          />
        </label>
        <label style={{ fontSize: 12 }}>
          <div style={{ color: 'var(--ide-text-tertiary)', marginBottom: 4 }}>决策摘要</div>
          <input
            className="ide-input"
            value={decision}
            placeholder="本次发布的审批/决策说明"
            onChange={(e) => setDecision(e.target.value)}
          />
        </label>
        {explained && (
          <div
            className="ide-card"
            style={{
              borderColor: 'var(--state-error)',
              background: 'var(--ide-bg-chrome)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                color: 'var(--state-error)',
                fontWeight: 600,
                fontSize: 13,
              }}
            >
              <PackageCheck className="w-4 h-4" />
              发布未通过就绪校验
            </div>
            <div style={{ fontSize: 12, color: 'var(--ide-text-secondary)' }}>
              发布前必须通过以下检查，请先解决后再发布：
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {explained.blockers.map((b, i) => (
                <li key={i} style={{ fontSize: 12.5, lineHeight: 1.6 }}>
                  <div style={{ color: 'var(--ide-text-primary)' }}>{b.reason}</div>
                  {b.fix && (
                    <div style={{ color: 'var(--ide-text-tertiary)' }}>解决办法：{b.fix}</div>
                  )}
                </li>
              ))}
            </ul>
            <details style={{ fontSize: 11 }}>
              <summary style={{ cursor: 'pointer', color: 'var(--ide-text-tertiary)' }}>
                查看原始错误
              </summary>
              <div
                className="ide-text-mono"
                style={{ marginTop: 4, color: 'var(--ide-text-tertiary)', wordBreak: 'break-all' }}
              >
                {explained.raw}
              </div>
            </details>
            <div>
              <button className="ide-btn ide-btn-sm ide-btn-primary" onClick={onFix} disabled={busy}>
                <Database className="w-3.5 h-3.5" />
                去 AI 助手处理
              </button>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="ide-btn ide-btn-sm ide-btn-ghost" onClick={onCancel} disabled={busy}>
            {explained ? '关闭' : '取消'}
          </button>
          <button
            className="ide-btn ide-btn-sm ide-btn-primary"
            disabled={!valid || busy}
            onClick={() => onSubmit(version.trim(), publishedBy.trim() || 'studio', decision.trim())}
          >
            {busy ? '发布中…' : explained ? '重试发布' : '确认发布'}
          </button>
        </div>
      </div>
    </div>
  );
}

function splitTable(tableId: string): string {
  const parts = tableId.split('/');
  return parts[parts.length - 1] ?? tableId;
}
