import { useState } from 'react';
import { api } from './api.js';

/**
 * 新建工作区表单：在工作区根目录下创建目录，安装本地技能包（来源→缓存→独立安装→bootstrap），
 * 完成后回调刷新项目列表并选中。
 */
export function NewWorkspaceForm({
  onCreated,
}: {
  onCreated: (projectId: string) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  async function submit(): Promise<void> {
    if (!name.trim()) {
      setError('请填写工作区名称');
      return;
    }
    setBusy(true);
    setError(null);
    setLog([]);
    try {
      const r = await api.createWorkspace(name.trim(), id.trim() || undefined);
      setLog(r.bootstrap.actions.map((a) => a.description));
      setName('');
      setId('');
      onCreated(r.project.id);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ide-card" style={{ padding: 20 }}>
      <h3 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600, color: 'var(--ide-text-primary)' }}>
        新建工作区
      </h3>
      <p style={{ margin: '0 0 14px', color: 'var(--ide-text-tertiary)', fontSize: 12.5, lineHeight: 1.6 }}>
        将在工作区根目录下创建目录，并把当前本地技能包安装进去（来源 → 本地缓存 → 独立安装 → 初始化）。
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ fontSize: 12.5, color: 'var(--ide-text-secondary)' }}>
          名称
          <input
            className="ide-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：运输管理系统"
            style={{ marginTop: 4 }}
          />
        </label>
        <label style={{ fontSize: 12.5, color: 'var(--ide-text-secondary)' }}>
          ID（可选，留空自动生成；仅小写字母/数字/连字符）
          <input
            className="ide-input"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="例如：transport"
            style={{ marginTop: 4 }}
          />
        </label>
        <div>
          <button className="ide-btn ide-btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '创建中…' : '创建并加载技能包'}
          </button>
        </div>
      </div>
      {error && <p style={{ color: 'var(--state-error)', fontSize: 12.5, marginTop: 10 }}>{error}</p>}
      {log.length > 0 && (
        <ul style={{ color: 'var(--state-success)', fontSize: 12, marginTop: 10, paddingLeft: 18 }}>
          {log.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
