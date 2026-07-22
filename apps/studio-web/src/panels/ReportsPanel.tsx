import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, FileBarChart, Trash2, Pencil } from 'lucide-react';
import { workspaceApi, type Project, type ReportState } from '../api.js';
import {
  TopBar,
  PageBody,
  Card,
  SectionTitle,
  ErrorBanner,
  Loading,
  Badge,
  EmptyState,
} from '../components/ui/common.js';
import { AgentQuickStart } from './AgentQuickStart.js';
import { REPORT_ACTION_VERBS } from './agent-chat.js';
import { PackageEditor } from './PackageEditor.js';
import { RequirementEditor } from './RequirementEditor.js';
import { useAgentRefresh } from '../AgentDrawer.js';

export function ReportsPanel({ project }: { project: Project }): JSX.Element {
  const [state, setState] = useState<ReportState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; version: string; name: string } | null>(null);
  // The report requirement selected for AI build; and the one being edited.
  const [selectedReqId, setSelectedReqId] = useState<string | null>(null);
  const [editingReq, setEditingReq] = useState<string | null>(null);
  const refreshNonce = useAgentRefresh();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setState(await workspaceApi.getReports(project.id));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  async function removePackage(reportId: string, version: string, name: string): Promise<void> {
    if (
      !window.confirm(
        `确认删除报表包「${name}」版本 ${version}？\n将删除其目录并从登记中移除，不可恢复。`,
      )
    ) {
      return;
    }
    const key = `${reportId}@${version}`;
    setDeleting(key);
    setError(null);
    setStatus(null);
    try {
      await workspaceApi.deleteReportPackage(project.id, reportId, version);
      setStatus(`已删除报表包「${name}」版本 ${version}`);
      await load();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setDeleting(null);
    }
  }

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  // Drop a stale selection if the requirement no longer exists (deleted/renamed).
  useEffect(() => {
    if (!state) return;
    if (selectedReqId && !state.requirements.some((r) => r.id === selectedReqId)) {
      setSelectedReqId(null);
    }
  }, [state, selectedReqId]);

  const selectedRequirement = state?.requirements.find((r) => r.id === selectedReqId) ?? null;
  const selectedReport = selectedRequirement
    ? { id: selectedRequirement.id, name: selectedRequirement.name }
    : null;

  return (
    <>
      <TopBar
        title="报表"
        right={
          <>
            <button className="ide-btn ide-btn-sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className="w-3.5 h-3.5" />
              {loading ? '刷新中…' : '刷新'}
            </button>
            <AgentQuickStart
              projectId={project.id}
              actions={REPORT_ACTION_VERBS}
              selectedReport={selectedReport}
              gateActions={['create-report']}
            />
          </>
        }
      />
      <PageBody>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {status && (
          <div
            className="ide-card"
            style={{ borderColor: 'var(--state-success)', color: 'var(--state-success)', fontSize: 12.5 }}
          >
            {status}
          </div>
        )}
        {!state && !error && <Loading text="正在读取报表状态…" />}
        {state && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 860 }}>
            <section>
              <SectionTitle>报表需求（来自构建配置）</SectionTitle>
              {state.requirements.length === 0 ? (
                <EmptyState
                  title="构建配置未声明报表需求"
                  hint="到「配置」页的「报表」页签新增，或用导入批量添加，保存后会写回 config/easy-bi.json。"
                />
              ) : (
                <>
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--ide-text-tertiary)',
                      marginBottom: 6,
                    }}
                  >
                    点击选择一张报表后，可点右上「AI 助手 → 构建报表」为其生成报表包；点铅笔可编辑该报表需求。
                  </div>
                  <div className="ide-card" style={{ padding: 0, overflow: 'hidden' }}>
                    <table className="ide-table">
                      <thead>
                        <tr>
                          <th style={{ width: 32 }}></th>
                          <th>报表</th>
                          <th>ID</th>
                          <th style={{ textAlign: 'right' }}>字段数</th>
                          <th style={{ width: 48, textAlign: 'right' }}>编辑</th>
                        </tr>
                      </thead>
                      <tbody>
                        {state.requirements.map((r) => {
                          const active = selectedReqId === r.id;
                          return (
                            <tr
                              key={r.id}
                              onClick={() => setSelectedReqId(active ? null : r.id)}
                              style={{
                                cursor: 'pointer',
                                background: active ? 'var(--ide-bg-chrome)' : undefined,
                              }}
                              title={active ? '已选中（再次点击取消）' : '点击选择该报表'}
                            >
                              <td style={{ textAlign: 'center' }}>
                                <input
                                  type="radio"
                                  checked={active}
                                  onChange={() => setSelectedReqId(r.id)}
                                  onClick={(e) => e.stopPropagation()}
                                />
                              </td>
                              <td>{r.name}</td>
                              <td
                                className="ide-text-mono"
                                style={{ color: 'var(--ide-text-tertiary)' }}
                              >
                                {r.id}
                              </td>
                              <td className="ide-num" style={{ textAlign: 'right' }}>
                                {r.fieldCount}
                              </td>
                              <td style={{ textAlign: 'right' }}>
                                <button
                                  className="ide-btn ide-btn-sm ide-btn-ghost"
                                  title="编辑该报表需求（名称/说明/字段/角色/绑定）"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditingReq(r.id);
                                  }}
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>

            <section>
              <SectionTitle>报表包</SectionTitle>
              {state.reports.length === 0 ? (
                <EmptyState
                  title="尚未生成任何报表包"
                  hint="报表包在 Claude Code 中生成；生成后在此展示，并可在「测试」页启动 Runtime 导出。"
                />
              ) : (
                <div className="ide-card" style={{ padding: 0, overflow: 'hidden' }}>
                  <table className="ide-table">
                    <thead>
                      <tr>
                        <th>报表</th>
                        <th>版本</th>
                        <th>状态</th>
                        <th style={{ width: 60, textAlign: 'right' }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.reports.map((r) => {
                        const ver = r.version ?? r.currentVersion ?? '';
                        const key = `${r.id}@${ver}`;
                        // Report packages are unrestricted: any versioned package
                        // may be edited or deleted (drafts and released alike).
                        const canDelete = Boolean(ver);
                        const canEdit = Boolean(ver);
                        return (
                          <tr key={key}>
                            <td>{r.name ?? r.id}</td>
                            <td
                              className="ide-text-mono"
                              style={{ color: 'var(--ide-text-tertiary)' }}
                            >
                              {ver || '—'}
                            </td>
                            <td>
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <Badge kind="neutral" dot>
                                  {r.status ?? '—'}
                                </Badge>
                                {r.developmentOnly && (
                                  <Badge kind="warning">development-only</Badge>
                                )}
                              </div>
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <div style={{ display: 'inline-flex', gap: 4 }}>
                                <button
                                  className="ide-btn ide-btn-sm ide-btn-ghost"
                                  disabled={!canEdit}
                                  title="查看/编辑该报表包（SQL / 脚本 / 筛选配置）；已发布版本为只读"
                                  onClick={() => setEditing({ id: r.id, version: ver, name: r.name ?? r.id })}
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  className="ide-btn ide-btn-sm ide-btn-ghost"
                                  disabled={!canDelete || deleting === key}
                                  title="删除该报表包"
                                  onClick={() => void removePackage(r.id, ver, r.name ?? r.id)}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <Card>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <FileBarChart
                  className="w-4 h-4 shrink-0"
                  style={{ color: 'var(--ide-text-tertiary)', marginTop: 2 }}
                />
                <div style={{ fontSize: 12.5, color: 'var(--ide-text-secondary)', lineHeight: 1.6 }}>
                  报表需求可在本页点铅笔就地编辑，也可在「配置」页的「报表」页签批量编辑/导入（都写回
                  config/easy-bi.json）。选中一张报表后点「AI 助手 → 构建报表」，AI 只为这一张生成报表计划与报表包；生成后到「测试」页启动
                  Runtime、填写筛选并导出 Excel。
                </div>
              </div>
            </Card>
          </div>
        )}
      </PageBody>
      {editing && (
        <PackageEditor
          projectId={project.id}
          reportId={editing.id}
          version={editing.version}
          name={editing.name}
          onClose={(changed) => {
            setEditing(null);
            if (changed) void load();
          }}
        />
      )}
      {editingReq && (
        <RequirementEditor
          project={project}
          requirementId={editingReq}
          onClose={(changed) => {
            setEditingReq(null);
            if (changed) void load();
          }}
        />
      )}
    </>
  );
}
