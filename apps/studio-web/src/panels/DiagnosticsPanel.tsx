import { useState } from 'react';
import { Stethoscope } from 'lucide-react';
import { api, type Project, type DiagnosticRun } from '../api.js';
import { TopBar, PageBody, ErrorBanner, Badge, type BadgeKind } from '../components/ui/common.js';

const KIND: Record<string, BadgeKind> = {
  PASS: 'success',
  WARNING: 'warning',
  FAIL: 'error',
  NOT_CONFIGURED: 'neutral',
};

export function DiagnosticsPanel({ project }: { project: Project }): JSX.Element {
  const [run, setRun] = useState<DiagnosticRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setRun(await api.runDiagnostics(project.id));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <TopBar
        title="环境诊断"
        right={
          <button className="ide-btn ide-btn-primary ide-btn-sm" onClick={() => void go()} disabled={loading}>
            <Stethoscope className="w-3.5 h-3.5" />
            {loading ? '诊断中…' : '一键诊断'}
          </button>
        }
      />
      <PageBody>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {!run && !error && (
          <div style={{ color: 'var(--ide-text-tertiary)', fontSize: 13 }}>点击「一键诊断」检查环境。</div>
        )}
        {run && (
          <div style={{ maxWidth: 820 }}>
            <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, color: 'var(--ide-text-secondary)' }}>总体：</span>
              <Badge kind={KIND[run.overall] ?? 'neutral'} dot>
                {run.overall}
              </Badge>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {run.items.map((i) => (
                <div key={i.key} className="ide-card" style={{ padding: '12px 14px' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Badge kind={KIND[i.status] ?? 'neutral'} dot>
                      {i.status}
                    </Badge>
                    <span style={{ fontWeight: 500 }}>{i.label}</span>
                    {i.blocking && (
                      <span style={{ color: 'var(--state-error)', fontSize: 11.5 }}>（阻塞）</span>
                    )}
                  </div>
                  <div style={{ color: 'var(--ide-text-secondary)', fontSize: 12.5, marginTop: 4 }}>
                    {i.message}
                  </div>
                  {i.actual && (
                    <div className="ide-text-mono" style={{ color: 'var(--ide-text-tertiary)', fontSize: 11.5, marginTop: 2 }}>
                      实测：{i.actual}
                    </div>
                  )}
                  {i.suggestion && (
                    <div style={{ color: 'var(--ide-text-secondary)', fontSize: 11.5, marginTop: 2 }}>
                      建议：{i.suggestion}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </PageBody>
    </>
  );
}
