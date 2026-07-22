import { useCallback, useEffect, useState } from 'react';
import { PackageCheck, Download, Check, X, Trash2 } from 'lucide-react';
import { publishApi, workspaceApi, type Project, type ArtifactPrecheck } from '../api.js';
import { TopBar, PageBody, Card, SectionTitle, ErrorBanner, EmptyState } from '../components/ui/common.js';

interface ReportOption {
  id: string;
  version: string;
  name: string;
}

export function PublishPanel({ project }: { project: Project }): JSX.Element {
  const [precheck, setPrecheck] = useState<ArtifactPrecheck | null>(null);
  const [version, setVersion] = useState('0.1.0');
  const [artifacts, setArtifacts] = useState<Array<{ file: string; sizeBytes: number }>>([]);
  // Available report packages + the subset the user selected to ship.
  const [reportOptions, setReportOptions] = useState<ReportOption[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const loadArtifacts = useCallback(async () => {
    try {
      const r = await publishApi.artifacts(project.id);
      setArtifacts(r.artifacts);
    } catch {
      /* ignore */
    }
  }, [project.id]);

  const loadReports = useCallback(async () => {
    try {
      const state = await workspaceApi.getReports(project.id);
      const opts: ReportOption[] = state.reports
        .map((r) => ({
          id: r.id,
          version: r.version ?? r.currentVersion ?? '',
          name: r.name ?? r.id,
        }))
        .filter((o) => o.version);
      setReportOptions(opts);
      // Default: select every package.
      setSelected(new Set(opts.map((o) => `${o.id}@${o.version}`)));
    } catch {
      setReportOptions([]);
      setSelected(new Set());
    }
  }, [project.id]);

  useEffect(() => {
    setError(null);
    publishApi
      .plan(project.id, 'development')
      .then((r) => setPrecheck(r.precheck))
      .catch((e) => setError(String((e as Error).message ?? e)));
    void loadArtifacts();
    void loadReports();
  }, [project.id, loadArtifacts, loadReports]);

  function toggle(key: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function build(): Promise<void> {
    setError(null);
    setMsg(null);
    // Assemble reportId -> version from the selection.
    const reportVersions: Record<string, string> = {};
    for (const o of reportOptions) {
      if (selected.has(`${o.id}@${o.version}`)) reportVersions[o.id] = o.version;
    }
    if (Object.keys(reportVersions).length === 0) {
      setError('请至少选择一个报表包再构建。');
      return;
    }
    setBuilding(true);
    try {
      const r = await publishApi.build(project.id, version, reportVersions);
      setMsg(
        `已生成：${r.artifact.file}（${r.artifact.sizeBytes} 字节，sha256 ${r.artifact.sha256.slice(0, 12)}…）`,
      );
      await loadArtifacts();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBuilding(false);
    }
  }

  async function removeArtifact(name: string): Promise<void> {
    if (!window.confirm(`确认删除制品「${name}」？此操作不可恢复。`)) return;
    setDeleting(name);
    setError(null);
    setMsg(null);
    try {
      await publishApi.deleteArtifact(project.id, name);
      await loadArtifacts();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setDeleting(null);
    }
  }

  const selectedCount = reportOptions.filter((o) => selected.has(`${o.id}@${o.version}`)).length;

  return (
    <>
      <TopBar title="发布中心 · 开发测试制品" />
      <PageBody>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {precheck && (
            <>
              {precheck.developmentOnly && (
                <div
                  style={{
                    background: 'var(--state-warning-soft)',
                    border: '1px solid var(--state-warning)',
                    borderRadius: 'var(--ide-radius-md)',
                    padding: '10px 12px',
                    fontWeight: 600,
                    fontSize: 12.5,
                    color: 'var(--state-warning)',
                  }}
                >
                  ⚠ development-only：基于草稿知识库 / 开发报表，仅用于本机或测试服务器验证
                </div>
              )}

              <section>
                <SectionTitle>预检</SectionTitle>
                <Card>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {precheck.items.map((i) => (
                      <div key={i.key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                        {i.ok ? (
                          <Check className="w-4 h-4 shrink-0" style={{ color: 'var(--state-success)' }} />
                        ) : (
                          <X className="w-4 h-4 shrink-0" style={{ color: 'var(--state-warning)' }} />
                        )}
                        <span style={{ color: 'var(--ide-text-primary)' }}>{i.label}</span>
                        <span style={{ color: 'var(--ide-text-tertiary)', fontSize: 12 }}>· {i.detail}</span>
                      </div>
                    ))}
                  </div>
                  {precheck.missing.length > 0 && (
                    <div style={{ marginTop: 10, color: 'var(--state-warning)', fontSize: 12.5 }}>
                      缺失：{precheck.missing.join('、')}
                    </div>
                  )}
                </Card>
              </section>

              {precheck.buildable ? (
                <section>
                  <SectionTitle>选择报表包</SectionTitle>
                  {reportOptions.length === 0 ? (
                    <EmptyState title="没有可选的报表包" hint="请先在「报表」页生成报表包。" />
                  ) : (
                    <Card>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {reportOptions.map((o) => {
                          const key = `${o.id}@${o.version}`;
                          return (
                            <label
                              key={key}
                              style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}
                            >
                              <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} />
                              <span style={{ color: 'var(--ide-text-primary)' }}>{o.name}</span>
                              <span className="ide-text-mono" style={{ color: 'var(--ide-text-tertiary)', fontSize: 12 }}>
                                {o.id} · {o.version}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                      <div style={{ marginTop: 8, color: 'var(--ide-text-tertiary)', fontSize: 11.5 }}>
                        已选 {selectedCount} / {reportOptions.length} 个报表包，仅构建选中的报表包。
                      </div>
                    </Card>
                  )}
                </section>
              ) : null}

              {precheck.buildable ? (
                <section>
                  <SectionTitle>构建</SectionTitle>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <label style={{ fontSize: 12.5, color: 'var(--ide-text-secondary)' }}>
                      版本
                      <input
                        className="ide-input"
                        value={version}
                        onChange={(e) => setVersion(e.target.value)}
                        style={{ width: 140, marginLeft: 8, display: 'inline-block' }}
                      />
                    </label>
                    <button
                      className="ide-btn ide-btn-primary"
                      onClick={() => void build()}
                      disabled={building || selectedCount === 0}
                    >
                      <PackageCheck className="w-3.5 h-3.5" />
                      {building ? '构建中…' : '构建开发测试制品'}
                    </button>
                  </div>
                  {msg && <p style={{ color: 'var(--state-success)', fontSize: 12.5, marginTop: 8 }}>{msg}</p>}
                </section>
              ) : (
                <div style={{ color: 'var(--ide-text-tertiary)', fontSize: 12.5 }}>
                  预检未通过，暂不可构建。请补齐上面「缺失」列出的项。
                </div>
              )}
            </>
          )}

          <section>
            <SectionTitle>已生成制品</SectionTitle>
            {artifacts.length === 0 ? (
              <EmptyState title="暂无制品" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {artifacts.map((a) => {
                  const name = a.file.split('/').pop() ?? a.file;
                  return (
                    <div
                      key={a.file}
                      className="ide-card"
                      style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}
                    >
                      <PackageCheck className="w-4 h-4" style={{ color: 'var(--ide-text-tertiary)' }} />
                      <span className="ide-text-mono" style={{ fontSize: 12.5 }}>{name}</span>
                      <span className="ide-num" style={{ marginLeft: 'auto', color: 'var(--ide-text-tertiary)', fontSize: 12 }}>
                        {a.sizeBytes} B
                      </span>
                      <a
                        className="ide-btn ide-btn-sm"
                        href={`/api/easybi/projects/${project.id}/artifacts/${name}/download`}
                      >
                        <Download className="w-3.5 h-3.5" />
                        下载
                      </a>
                      <button
                        className="ide-btn ide-btn-sm ide-btn-ghost"
                        onClick={() => void removeArtifact(name)}
                        disabled={deleting === name}
                        title="删除该制品"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        {deleting === name ? '删除中…' : '删除'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </PageBody>
    </>
  );
}
