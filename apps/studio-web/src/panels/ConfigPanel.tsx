import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Save, Info } from 'lucide-react';
import { api, type Project, type ConfigHelpDoc } from '../api.js';
import { TopBar, PageBody, ErrorBanner } from '../components/ui/common.js';
import { ConnectionsEditor } from './ConnectionsEditor.js';
import { ReportsEditor } from './ReportsEditor.js';
import { EnumsEditor } from './EnumsEditor.js';
import { PromptsEditor } from './PromptsEditor.js';

type Which = 'connections' | 'reports' | 'enums' | 'prompts' | 'build' | 'runtime';

const SUB_EDITORS: Which[] = ['connections', 'reports', 'enums', 'prompts'];

export function ConfigPanel({ project }: { project: Project }): JSX.Element {
  // Land on the friendly connections editor, not the raw JSON — raw editors are
  // grouped separately as "高级" so a novice isn't dropped into easy-bi.json.
  const [which, setWhich] = useState<Which>('connections');
  const [text, setText] = useState('');
  const [revision, setRevision] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [helpDocs, setHelpDocs] = useState<ConfigHelpDoc[]>([]);
  // On the raw-JSON editors the "…是什么？" guidance is what's most needed, so
  // default it open there.
  const [showHelp, setShowHelp] = useState(true);

  // Load config help (from the installed skills) once per workspace.
  useEffect(() => {
    api
      .getConfigHelp(project.id)
      .then((d) => setHelpDocs(d.docs))
      .catch(() => setHelpDocs([]));
  }, [project.id]);

  const load = useCallback(async () => {
    if (SUB_EDITORS.includes(which)) return; // sub-editors load themselves.
    setError(null);
    setStatus(null);
    try {
      const cfg =
        which === 'build'
          ? await api.getBuildConfig(project.id)
          : await api.getRuntimeConfig(project.id);
      setText(JSON.stringify(cfg.value, null, 2));
      setRevision(cfg.revision);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [project.id, which]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(): Promise<void> {
    setError(null);
    setStatus(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError('JSON 解析失败，请检查语法');
      return;
    }
    try {
      const r =
        which === 'build'
          ? await api.saveBuildConfig(project.id, parsed, revision)
          : await api.saveRuntimeConfig(project.id, parsed, revision);
      setRevision(r.revision);
      setStatus('已保存（原子写入，已备份上一版本）');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }

  return (
    <>
      <TopBar
        title="配置"
        right={
          <>
            <div className="ws-tabs">
              <button
                className={'ws-tab' + (which === 'connections' ? ' active' : '')}
                onClick={() => setWhich('connections')}
              >
                连接
              </button>
              <button
                className={'ws-tab' + (which === 'reports' ? ' active' : '')}
                onClick={() => setWhich('reports')}
              >
                报表
              </button>
              <button
                className={'ws-tab' + (which === 'enums' ? ' active' : '')}
                onClick={() => setWhich('enums')}
              >
                枚举
              </button>
              <button
                className={'ws-tab' + (which === 'prompts' ? ' active' : '')}
                onClick={() => setWhich('prompts')}
              >
                AI 提示词
              </button>
              {/* Separator: everything past here edits raw JSON directly. */}
              <span
                aria-hidden
                title="以下为高级：直接编辑原始 JSON"
                style={{
                  alignSelf: 'center',
                  margin: '0 4px',
                  paddingLeft: 8,
                  borderLeft: '1px solid var(--ide-border)',
                  fontSize: 10.5,
                  color: 'var(--ide-text-tertiary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                高级 · 原始 JSON
              </span>
              <button
                className={'ws-tab' + (which === 'build' ? ' active' : '')}
                onClick={() => setWhich('build')}
                title="直接编辑 config/easy-bi.json（高级）"
              >
                构建配置
              </button>
              <button
                className={'ws-tab' + (which === 'runtime' ? ' active' : '')}
                onClick={() => setWhich('runtime')}
                title="直接编辑 toolkit/config/runtime.json（高级）"
              >
                Runtime 配置
              </button>
            </div>
            {!SUB_EDITORS.includes(which) && (
              <button className="ide-btn ide-btn-sm" onClick={() => void load()}>
                <RefreshCw className="w-3.5 h-3.5" />
                重新加载
              </button>
            )}
          </>
        }
      />
      <PageBody>
        {which === 'connections' ? (
          <ConnectionsEditor project={project} />
        ) : which === 'reports' ? (
          <ReportsEditor project={project} />
        ) : which === 'enums' ? (
          <EnumsEditor project={project} />
        ) : which === 'prompts' ? (
          <PromptsEditor project={project} />
        ) : (
          <>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            <div style={{ maxWidth: 900 }}>
              <ConfigHelp doc={helpDocs.find((d) => d.target === which)} open={showHelp} onToggle={() => setShowHelp((v) => !v)} />
              <div style={{ fontSize: 12, color: 'var(--ide-text-tertiary)', marginBottom: 8 }}>
                {which === 'build' ? 'config/easy-bi.json' : 'toolkit/config/runtime.json'} · revision{' '}
                <code className="ide-chip">{revision.slice(0, 12)}…</code>
                （保存时提交该 revision，若已被其他任务修改会返回冲突）
              </div>
              <textarea
                className="ide-textarea ide-scroll"
                value={text}
                onChange={(e) => setText(e.target.value)}
                spellCheck={false}
                style={{ minHeight: 420, fontSize: 12.5 }}
              />
              <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
                <button className="ide-btn ide-btn-primary" onClick={() => void save()}>
                  <Save className="w-3.5 h-3.5" />
                  保存
                </button>
                {status && (
                  <span style={{ color: 'var(--state-success)', fontSize: 12.5 }}>{status}</span>
                )}
              </div>
            </div>
          </>
        )}
      </PageBody>
    </>
  );
}

/** Collapsible help panel describing what a config file's sections are for. */
function ConfigHelp({
  doc,
  open,
  onToggle,
}: {
  doc?: ConfigHelpDoc;
  open: boolean;
  onToggle: () => void;
}): JSX.Element | null {
  if (!doc) return null;
  return (
    <div
      className="ide-card"
      style={{ marginBottom: 12, padding: '10px 14px', background: 'var(--ide-bg-chrome)' }}
    >
      <button
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          color: 'var(--ide-text-primary)',
          fontWeight: 600,
          fontSize: 13,
        }}
      >
        <Info className="w-4 h-4" style={{ color: 'var(--ide-accent)' }} />
        {doc.title}是什么？
        <span style={{ fontSize: 11, color: 'var(--ide-text-tertiary)', fontWeight: 400 }}>
          {open ? '（点击收起）' : '（点击展开）'}
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12.5, color: 'var(--ide-text-secondary)', lineHeight: 1.6 }}>
            {doc.summary}
          </div>
          {doc.sections.length > 0 && (
            <table className="ide-table" style={{ marginTop: 10, fontSize: 12 }}>
              <tbody>
                {doc.sections.map((s) => (
                  <tr key={s.key}>
                    <td style={{ whiteSpace: 'nowrap', verticalAlign: 'top', fontWeight: 500 }}>
                      {s.label}
                      <div className="ide-text-mono" style={{ fontSize: 10.5, color: 'var(--ide-text-tertiary)' }}>
                        {s.key}
                      </div>
                    </td>
                    <td style={{ color: 'var(--ide-text-secondary)', lineHeight: 1.5 }}>{s.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {doc.skillId && (
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--ide-text-tertiary)' }}>
              说明来自技能包 {doc.skillId}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
