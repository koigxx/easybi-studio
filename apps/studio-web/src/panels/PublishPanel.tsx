import { useCallback, useEffect, useState } from 'react';
import { PackageCheck, Download, Check, X } from 'lucide-react';
import { publishApi, type Project, type ArtifactPrecheck } from '../api.js';
import { TopBar, PageBody, Card, SectionTitle, ErrorBanner, EmptyState } from '../components/ui/common.js';

const LEVELS = [
  { key: 'development', label: '开发测试制品' },
  { key: 'candidate', label: '候选制品' },
  { key: 'production', label: '生产制品' },
] as const;

export function PublishPanel({ project }: { project: Project }): JSX.Element {
  const [level, setLevel] = useState<string>('development');
  const [precheck, setPrecheck] = useState<ArtifactPrecheck | null>(null);
  const [version, setVersion] = useState('0.1.0');
  const [artifacts, setArtifacts] = useState<Array<{ file: string; sizeBytes: number }>>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadArtifacts = useCallback(async () => {
    try {
      const r = await publishApi.artifacts(project.id);
      setArtifacts(r.artifacts);
    } catch {
      /* ignore */
    }
  }, [project.id]);

  useEffect(() => {
    setError(null);
    publishApi
      .plan(project.id, level)
      .then((r) => setPrecheck(r.precheck))
      .catch((e) => setError(String((e as Error).message ?? e)));
    void loadArtifacts();
  }, [project.id, level, loadArtifacts]);

  async function build(): Promise<void> {
    setError(null);
    setMsg(null);
    try {
      const r = await publishApi.build(project.id, version);
      setMsg(`已生成：${r.artifact.file}（${r.artifact.sizeBytes} 字节，sha256 ${r.artifact.sha256.slice(0, 12)}…）`);
      await loadArtifacts();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }

  return (
    <>
      <TopBar
        title="发布中心"
        right={
          <div className="ws-tabs">
            {LEVELS.map((l) => (
              <button
                key={l.key}
                className={'ws-tab' + (level === l.key ? ' active' : '')}
                onClick={() => setLevel(l.key)}
              >
                {l.label}
              </button>
            ))}
          </div>
        }
      />
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
                    <button className="ide-btn ide-btn-primary" onClick={() => void build()}>
                      <PackageCheck className="w-3.5 h-3.5" />
                      构建开发测试制品
                    </button>
                  </div>
                  {msg && <p style={{ color: 'var(--state-success)', fontSize: 12.5, marginTop: 8 }}>{msg}</p>}
                </section>
              ) : (
                <div style={{ color: 'var(--ide-text-tertiary)', fontSize: 12.5 }}>
                  该等级第一版不支持构建，仅展示预检。
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
