import { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  SlidersHorizontal,
  Database,
  FileBarChart,
  FolderOpen,
  FlaskConical,
  PackageCheck,
  Stethoscope,
  Sun,
  Moon,
} from 'lucide-react';
import { api, type Project } from './api.js';
import { getTheme, toggleTheme, type Theme } from './theme.js';
import { OverviewPanel } from './panels/OverviewPanel.js';
import { ConfigPanel } from './panels/ConfigPanel.js';
import { DiagnosticsPanel } from './panels/DiagnosticsPanel.js';
import { KnowledgePanel } from './panels/KnowledgePanel.js';
import { ReportsPanel } from './panels/ReportsPanel.js';
import { TestPanel } from './panels/TestPanel.js';
import { PublishPanel } from './panels/PublishPanel.js';
import { FilesPanel } from './panels/FilesPanel.js';
import { NewWorkspaceForm } from './NewWorkspaceForm.js';
import { AgentDrawerProvider } from './AgentDrawer.js';
import { NavContext, type Tab } from './nav.js';

const NAV: Array<{ tab: Tab; label: string; icon: JSX.Element }> = [
  { tab: 'overview', label: '总览', icon: <LayoutDashboard className="w-4 h-4" /> },
  { tab: 'config', label: '配置', icon: <SlidersHorizontal className="w-4 h-4" /> },
  { tab: 'knowledge', label: '知识库', icon: <Database className="w-4 h-4" /> },
  { tab: 'reports', label: '报表', icon: <FileBarChart className="w-4 h-4" /> },
  { tab: 'files', label: '文件', icon: <FolderOpen className="w-4 h-4" /> },
  { tab: 'test', label: '测试', icon: <FlaskConical className="w-4 h-4" /> },
  { tab: 'publish', label: '发布', icon: <PackageCheck className="w-4 h-4" /> },
  { tab: 'diagnostics', label: '诊断', icon: <Stethoscope className="w-4 h-4" /> },
];

export function App(): JSX.Element {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [error, setError] = useState<string | null>(null);
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [showNew, setShowNew] = useState(false);

  function refreshProjects(selectId?: string): void {
    api
      .listProjects()
      .then((d) => {
        setProjects(d.projects);
        if (selectId) setSelected(selectId);
        else if (!selected && d.projects[0]) setSelected(d.projects[0].id);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }

  useEffect(() => {
    refreshProjects();
  }, []);

  const current = projects?.find((p) => p.id === selected) ?? null;

  return (
    <AgentDrawerProvider currentProjectId={current?.id ?? null}>
    <NavContext.Provider value={setTab}>
    <div className="innos-app">
      {/* ========== SIDEBAR ========== */}
      <aside className="sidebar">
        <div className="sb-top">
          <div className="brand-mark">BI</div>
          <div className="min-w-0">
            <div className="brand-name ide-truncate">Easy BI Studio</div>
            <div className="brand-sub">本地工作台</div>
          </div>
        </div>

        <div className="sb-section">
          <div className="sb-label">工作区</div>
          {projects && projects.length > 0 && (
            <select
              className="ide-select"
              value={selected ?? ''}
              onChange={(e) => setSelected(e.target.value)}
              style={{ marginBottom: 8 }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <button className="ide-btn ide-btn-sm" style={{ width: '100%' }} onClick={() => setShowNew(true)}>
            + 新建工作区
          </button>
        </div>

        <nav className="sb-section" style={{ flex: '0 0 auto' }}>
          <div className="sb-label">导航</div>
          {NAV.map((n) => (
            <button
              key={n.tab}
              className={'sb-nav-item' + (tab === n.tab ? ' active' : '')}
              onClick={() => setTab(n.tab)}
              disabled={!current}
            >
              {n.icon}
              <span>{n.label}</span>
            </button>
          ))}
        </nav>

        <div className="sb-spacer" />

        <div className="sb-bottom">
          <button
            className="sb-nav-item"
            onClick={() => setThemeState(toggleTheme())}
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            <span>切换主题</span>
          </button>
        </div>
      </aside>

      {/* ========== MAIN ========== */}
      <div className="canvas">
        {!current && (
          <>
            <div className="topbar">
              <span className="crumb">Easy BI Studio</span>
            </div>
            <main className="page-body ide-scroll">
              {error && (
                <div
                  className="mb-4"
                  style={{ color: 'var(--state-error)', fontSize: 13 }}
                >
                  {error}
                </div>
              )}
              {projects !== null && projects.length === 0 && (
                <div style={{ maxWidth: 520 }}>
                  <NewWorkspaceForm onCreated={(id) => refreshProjects(id)} />
                </div>
              )}
            </main>
          </>
        )}

        {current && (
          <>
            {tab === 'overview' && <OverviewPanel project={current} />}
            {tab === 'config' && <ConfigPanel project={current} />}
            {tab === 'knowledge' && <KnowledgePanel project={current} />}
            {tab === 'reports' && <ReportsPanel project={current} />}
            {tab === 'files' && <FilesPanel project={current} />}
            {tab === 'test' && <TestPanel project={current} />}
            {tab === 'publish' && <PublishPanel project={current} />}
            {tab === 'diagnostics' && <DiagnosticsPanel project={current} />}
          </>
        )}
      </div>

      {/* New workspace modal */}
      {showNew && (
        <div
          onClick={() => setShowNew(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: 16,
          }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ width: 480, maxWidth: '92vw' }}>
            <NewWorkspaceForm
              onCreated={(id) => {
                refreshProjects(id);
                setShowNew(false);
              }}
            />
          </div>
        </div>
      )}
    </div>
    </NavContext.Provider>
    </AgentDrawerProvider>
  );
}
