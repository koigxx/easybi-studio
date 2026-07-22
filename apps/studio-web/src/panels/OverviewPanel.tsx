import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, CheckCircle2, Circle, ArrowRight } from 'lucide-react';
import { api, type Project, type WorkflowState } from '../api.js';
import { TopBar, PageBody, Card, ErrorBanner, Loading } from '../components/ui/common.js';
import { useNavigate, type Tab } from '../nav.js';
import { useAgentRefresh } from '../AgentDrawer.js';

/** Which tab addresses each workflow stage — makes the checklist navigable. */
const STAGE_TAB: Record<string, Tab> = {
  WORKSPACE_READY: 'overview',
  BUILD_CONFIG_READY: 'config',
  KNOWLEDGE_MISSING: 'knowledge',
  KNOWLEDGE_DRAFT: 'knowledge',
  KNOWLEDGE_REVIEW_REQUIRED: 'knowledge',
  KNOWLEDGE_PUBLISHED: 'knowledge',
  REPORT_REQUIREMENT_READY: 'reports',
  REPORT_PLAN_WAITING_APPROVAL: 'reports',
  REPORT_PACKAGE_READY: 'reports',
  RUNTIME_TEST_REQUIRED: 'test',
  RUNTIME_TEST_PASSED: 'test',
  TEST_ARTIFACT_READY: 'publish',
};

function tabForStage(stage: string): Tab {
  return STAGE_TAB[stage] ?? 'overview';
}

export function OverviewPanel({ project }: { project: Project }): JSX.Element {
  const [state, setState] = useState<WorkflowState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const refreshNonce = useAgentRefresh();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setState(await api.getWorkflow(project.id));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  return (
    <>
      <TopBar
        title="项目总览"
        right={
          <button className="ide-btn ide-btn-sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="w-3.5 h-3.5" />
            {loading ? '刷新中…' : '刷新'}
          </button>
        }
      />
      <PageBody>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {!state && !error && <Loading text="正在计算项目流程状态…" />}
        {state && (
          <div style={{ maxWidth: 720 }}>
            <Card style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: 'var(--ide-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  当前阶段
                </div>
                <div style={{ fontSize: 15, fontWeight: 600, marginTop: 4 }}>
                  {state.currentLabel ?? state.current}
                </div>
                <div className="ide-text-mono" style={{ fontSize: 11, color: 'var(--ide-text-tertiary)', marginTop: 2 }}>
                  {state.current}
                </div>
              </div>
              <button
                className="ide-btn ide-btn-sm ide-btn-primary"
                onClick={() => navigate(tabForStage(state.current))}
                title="前往处理当前阶段"
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                {state.nextAction}
                <ArrowRight className="w-4 h-4" />
              </button>
            </Card>

            <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {state.steps.map((s) => (
                <li
                  key={s.stage}
                  className="ide-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(tabForStage(s.stage))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') navigate(tabForStage(s.stage));
                  }}
                  title="前往对应页面"
                  style={{
                    padding: '12px 14px',
                    display: 'flex',
                    gap: 10,
                    alignItems: 'center',
                    cursor: 'pointer',
                  }}
                >
                  {s.done ? (
                    <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: 'var(--state-success)' }} />
                  ) : (
                    <Circle className="w-4 h-4 shrink-0" style={{ color: 'var(--ide-text-muted)' }} />
                  )}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500, color: 'var(--ide-text-primary)' }}>{s.label}</div>
                    {!s.done && s.blockedReason && (
                      <div style={{ color: 'var(--state-warning)', fontSize: 12 }}>阻塞：{s.blockedReason}</div>
                    )}
                  </div>
                  <ArrowRight className="w-4 h-4 shrink-0" style={{ color: 'var(--ide-text-tertiary)' }} />
                </li>
              ))}
            </ol>
          </div>
        )}
      </PageBody>
    </>
  );
}
