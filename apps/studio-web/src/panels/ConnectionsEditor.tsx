import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Save, Plus, Trash2, X, Database, Cloud, PlugZap, AlertTriangle } from 'lucide-react';
import { api, type Project, type MysqlTestResult } from '../api.js';
import { SectionTitle, ErrorBanner, EmptyState, Badge } from '../components/ui/common.js';
import {
  extractConnections,
  mergeConnections,
  validateConnections,
  toTestProfile,
  newDbProfile,
  newOssProfile,
  newEnvDraft,
  type ConnectionsDraft,
  type DbProfileDraft,
  type EnvDraft,
  type OssProfileDraft,
} from './connections-config.js';

type TestState = { loading: boolean; result?: MysqlTestResult; error?: string };

export function ConnectionsEditor({ project }: { project: Project }): JSX.Element {
  const [draft, setDraft] = useState<ConnectionsDraft | null>(null);
  const [rawConfig, setRawConfig] = useState<unknown>(null);
  const [revision, setRevision] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const load = useCallback(
    async (opts: { keepTests?: boolean } = {}) => {
      setError(null);
      setStatus(null);
      // Preserve "可连接" confirmations across a save (opts.keepTests); a manual
      // reload / workspace switch still clears them since the config may differ.
      if (!opts.keepTests) setTests({});
      try {
        const cfg = await api.getBuildConfig(project.id);
        setRawConfig(cfg.value);
        setRevision(cfg.revision);
        setDraft(extractConnections(cfg.value));
      } catch (e) {
        setError(String((e as Error).message ?? e));
      }
    },
    [project.id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  function patch(next: Partial<ConnectionsDraft>): void {
    if (!draft) return;
    setDraft({ ...draft, ...next });
    setStatus(null);
  }

  async function save(): Promise<void> {
    if (!draft) return;
    setError(null);
    setStatus(null);
    const invalid = validateConnections(draft);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    try {
      const merged = mergeConnections(rawConfig, draft);
      const r = await api.saveBuildConfig(project.id, merged, revision);
      setRevision(r.revision);
      setStatus('连接配置已保存至 config/easy-bi.json（原子写入，已备份上一版本）');
      // Re-read so _raw baselines and revision stay in sync for the next edit,
      // but keep the just-run test results so "可连接" doesn't vanish on save.
      await load({ keepTests: true });
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  }

  async function testDb(index: number, db: DbProfileDraft): Promise<void> {
    const key = `${index}`;
    setTests((t) => ({ ...t, [key]: { loading: true } }));
    try {
      const resp = await api.testMysql(project.id, toTestProfile(db));
      const result = resp.results[0];
      setTests((t) => ({ ...t, [key]: { loading: false, result } }));
    } catch (e) {
      setTests((t) => ({ ...t, [key]: { loading: false, error: String((e as Error).message ?? e) } }));
    }
  }

  if (!draft) {
    return (
      <div style={{ maxWidth: 900 }}>
        {error ? <ErrorBanner>{error}</ErrorBanner> : <span>加载中…</span>}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900, display: 'flex', flexDirection: 'column', gap: 20 }}>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div
        className="ide-card"
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'flex-start',
          borderColor: 'var(--state-warning)',
          background: 'var(--ide-bg-chrome)',
          fontSize: 12,
          color: 'var(--ide-text-secondary)',
          lineHeight: 1.6,
        }}
      >
        <AlertTriangle
          className="w-4 h-4 shrink-0"
          style={{ color: 'var(--state-warning)', marginTop: 1 }}
        />
        <span>
          密码 / AccessKey 将以<b>明文</b>写入 config/easy-bi.json。请勿将含密钥的配置文件提交到版本库或外发。
          配置齐全后，Claude Code 生成报表时会直接读取，无需再逐项询问；留空则仍会照常询问。
        </span>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className="ide-btn ide-btn-primary ide-btn-sm" onClick={() => void save()} disabled={saving}>
          <Save className="w-3.5 h-3.5" />
          {saving ? '保存中…' : '保存连接配置'}
        </button>
        <button className="ide-btn ide-btn-sm" onClick={() => void load()} disabled={saving}>
          <RefreshCw className="w-3.5 h-3.5" />
          重新加载
        </button>
        <span style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>
          写入 config/easy-bi.json · connections · revision{' '}
          <code className="ide-chip">{revision.slice(0, 12)}…</code>
        </span>
        {status && <span style={{ color: 'var(--state-success)', fontSize: 12.5 }}>{status}</span>}
      </div>

      {/* Database profiles */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <SectionTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Database className="w-4 h-4" /> 数据库连接
            </span>
          </SectionTitle>
          <button
            className="ide-btn ide-btn-sm"
            onClick={() => patch({ databases: [...draft.databases, newDbProfile()] })}
          >
            <Plus className="w-3.5 h-3.5" /> 新增数据库
          </button>
        </div>
        {draft.databases.length === 0 ? (
          <EmptyState title="暂无数据库连接" hint="点击「新增数据库」添加。" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {draft.databases.map((db, i) => (
              <DbCard
                key={i}
                db={db}
                test={tests[`${i}`]}
                onChange={(next) =>
                  patch({ databases: draft.databases.map((d, j) => (j === i ? next : d)) })
                }
                onRemove={() =>
                  patch({ databases: draft.databases.filter((_, j) => j !== i) })
                }
                onTest={() => void testDb(i, db)}
              />
            ))}
          </div>
        )}
      </section>

      {/* OSS profiles */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <SectionTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Cloud className="w-4 h-4" /> 阿里云 OSS（对象存储）
            </span>
          </SectionTitle>
          <button
            className="ide-btn ide-btn-sm"
            onClick={() => patch({ ossProfiles: [...draft.ossProfiles, newOssProfile()] })}
          >
            <Plus className="w-3.5 h-3.5" /> 新增 OSS
          </button>
        </div>
        {draft.ossProfiles.length === 0 ? (
          <EmptyState title="暂无 OSS 配置" hint="报表交付到对象存储时需要；点击「新增 OSS」添加。" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {draft.ossProfiles.map((oss, i) => (
              <OssCard
                key={i}
                oss={oss}
                onChange={(next) =>
                  patch({ ossProfiles: draft.ossProfiles.map((o, j) => (j === i ? next : o)) })
                }
                onRemove={() =>
                  patch({ ossProfiles: draft.ossProfiles.filter((_, j) => j !== i) })
                }
              />
            ))}
          </div>
        )}
      </section>

    </div>
  );
}

function labeledInput(
  label: string,
  value: string,
  onChange: (v: string) => void,
  opts: { placeholder?: string; type?: string; flex?: string | number } = {},
): JSX.Element {
  return (
    <label style={{ flex: opts.flex ?? 1, fontSize: 12, minWidth: 120 }}>
      <div style={{ color: 'var(--ide-text-tertiary)', marginBottom: 4 }}>{label}</div>
      <input
        className="ide-input"
        type={opts.type ?? 'text'}
        value={value}
        placeholder={opts.placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </label>
  );
}

function DbCard({
  db,
  test,
  onChange,
  onRemove,
  onTest,
}: {
  db: DbProfileDraft;
  test?: TestState;
  onChange: (d: DbProfileDraft) => void;
  onRemove: () => void;
  onTest: () => void;
}): JSX.Element {
  const isEnvMode = Boolean(db.activeEnvironment);
  const activeEnv = isEnvMode ? db.environments.find((e) => e.name === db.activeEnvironment) : undefined;

  // When in env mode, read/write through the active environment.
  const envHost = activeEnv?.host ?? db.host;
  const envPort = activeEnv?.port ?? db.port;
  const envUsername = activeEnv?.username ?? db.username;
  const envPassword = activeEnv?.password ?? db.password;
  const envDatabases = activeEnv?.databases ?? db.databases;

  function updateHost(v: string): void {
    if (isEnvMode && activeEnv) {
      onChange({ ...db, environments: db.environments.map((e) => (e.name === activeEnv.name ? { ...e, host: v } : e)) });
    } else onChange({ ...db, host: v });
  }
  function updatePort(v: number): void {
    if (isEnvMode && activeEnv) {
      onChange({ ...db, environments: db.environments.map((e) => (e.name === activeEnv.name ? { ...e, port: v } : e)) });
    } else onChange({ ...db, port: v });
  }
  function updateUsername(v: string): void {
    if (isEnvMode && activeEnv) {
      onChange({ ...db, environments: db.environments.map((e) => (e.name === activeEnv.name ? { ...e, username: v } : e)) });
    } else onChange({ ...db, username: v });
  }
  function updatePassword(v: string): void {
    if (isEnvMode && activeEnv) {
      onChange({ ...db, environments: db.environments.map((e) => (e.name === activeEnv.name ? { ...e, password: v } : e)) });
    } else onChange({ ...db, password: v });
  }
  function updateDatabases(v: string[]): void {
    if (isEnvMode && activeEnv) {
      onChange({ ...db, environments: db.environments.map((e) => (e.name === activeEnv.name ? { ...e, databases: v } : e)) });
    } else onChange({ ...db, databases: v });
  };

  // Toggle env mode on: migrate current settings into a "qa" environment.
  function enableEnvMode(): void {
    const initialEnv = newEnvDraft('qa');
    initialEnv.host = db.host;
    initialEnv.port = db.port;
    initialEnv.username = db.username;
    initialEnv.password = db.password;
    initialEnv.databases = [...db.databases];
    onChange({ ...db, activeEnvironment: 'qa', environments: [initialEnv] });
  }
  function disableEnvMode(): void {
    if (activeEnv) {
      onChange({ ...db, activeEnvironment: '', environments: [], host: activeEnv.host, port: activeEnv.port, username: activeEnv.username, password: activeEnv.password, databases: [...activeEnv.databases] });
    }
  }
  function addEnv(): void {
    const name = prompt('新环境名称（如 production）：');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    if (db.environments.some((e) => e.name === trimmed)) return;
    onChange({ ...db, environments: [...db.environments, newEnvDraft(trimmed)] });
  }
  function removeEnv(name: string): void {
    if (db.environments.length <= 1) return;
    const next = db.environments.filter((e) => e.name !== name);
    const active = db.activeEnvironment === name ? (next[0]?.name ?? '') : db.activeEnvironment;
    onChange({ ...db, environments: next, activeEnvironment: active });
  }

  return (
    <div className="ide-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Row 0: ID + engine type + env toggle */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        {labeledInput('ID', db.id, (v) => onChange({ ...db, id: v }), {
          placeholder: 'transport-main-mysql',
          flex: '0 0 200px',
        })}
        <label style={{ flex: '0 0 150px', fontSize: 12 }}>
          <div style={{ color: 'var(--ide-text-tertiary)', marginBottom: 4 }}>数据库类型</div>
          <select
            className="ide-select"
            value={db.connectorId === 'postgresql' || db.connectorId === 'postgres' ? 'postgresql' : 'mysql'}
            onChange={(e) => {
              const connectorId = e.target.value;
              const nextPort =
                connectorId === 'postgresql' && (db.port === 3306 || !db.port)
                  ? 5432
                  : connectorId === 'mysql' && (db.port === 5432 || !db.port)
                    ? 3306
                    : db.port;
              onChange({ ...db, connectorId, port: nextPort });
            }}
          >
            <option value="mysql">MySQL</option>
            <option value="postgresql">PostgreSQL</option>
          </select>
        </label>
        <label style={{ flex: '0 0 auto', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={isEnvMode}
            onChange={(e) => { if (e.target.checked) enableEnvMode(); else disableEnvMode(); }}
            style={{ cursor: 'pointer' }}
          />
          <span style={{ color: 'var(--ide-text-tertiary)' }}>多环境配置</span>
        </label>
        <div style={{ flex: 1 }} />
        <button className="ide-btn ide-btn-sm ide-btn-danger" onClick={onRemove} title="删除该连接">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Environment tabs (only when env mode is on) */}
      {isEnvMode && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {db.environments.map((env) => (
            <span
              key={env.name}
              onClick={() => onChange({ ...db, activeEnvironment: env.name })}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 10px',
                borderRadius: 4,
                fontSize: 12,
                cursor: 'pointer',
                background: env.name === db.activeEnvironment ? 'var(--ide-accent)' : 'var(--ide-bg-chrome)',
                color: env.name === db.activeEnvironment ? '#fff' : 'var(--ide-text-secondary)',
                fontWeight: env.name === db.activeEnvironment ? 600 : 400,
              }}
            >
              {env.name}
              {db.environments.length > 1 && (
                <X
                  className="w-3 h-3"
                  style={{ marginLeft: 4, opacity: 0.6 }}
                  onClick={(e) => { e.stopPropagation(); removeEnv(env.name); }}
                />
              )}
            </span>
          ))}
          <button className="ide-btn ide-btn-sm ide-btn-ghost" onClick={addEnv} title="添加环境">
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Connection fields */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        {labeledInput('host', envHost, updateHost, { placeholder: '127.0.0.1' })}
        <label style={{ flex: '0 0 110px', fontSize: 12 }}>
          <div style={{ color: 'var(--ide-text-tertiary)', marginBottom: 4 }}>port</div>
          <input
            className="ide-input"
            type="number"
            value={Number.isFinite(envPort) ? envPort : 0}
            onChange={(e) => updatePort(Number(e.target.value))}
          />
        </label>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        {labeledInput('username', envUsername, updateUsername, { placeholder: 'report_reader' })}
        {labeledInput('password（明文）', envPassword, updatePassword, {
          placeholder: '直接填写明文密码',
          type: 'password',
        })}
      </div>

      {/* Databases list */}
      <div>
        <div
          style={{
            fontSize: 12,
            color: 'var(--ide-text-tertiary)',
            marginBottom: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>
            {db.connectorId === 'postgresql' || db.connectorId === 'postgres'
              ? 'databases（PostgreSQL：填 schema 名）'
              : 'databases（数据库名）'}
          </span>
          <button
            className="ide-btn ide-btn-sm ide-btn-ghost"
            onClick={() => updateDatabases([...envDatabases, ''])}
          >
            <Plus className="w-3.5 h-3.5" /> 添加库
          </button>
        </div>
        {envDatabases.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>暂无数据库</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {envDatabases.map((name, di) => (
              <div key={di} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  className="ide-input"
                  value={name}
                  placeholder="transport_order"
                  onChange={(e) =>
                    updateDatabases(envDatabases.map((d, j) => (j === di ? e.target.value : d)))
                  }
                  style={{ flex: 1 }}
                />
                <button
                  className="ide-btn ide-btn-sm ide-btn-ghost"
                  onClick={() => updateDatabases(envDatabases.filter((_, j) => j !== di))}
                  title="删除"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className="ide-btn ide-btn-sm"
          onClick={onTest}
          disabled={test?.loading}
          title="只读连接：仅执行 SELECT 1 与 SHOW DATABASES"
        >
          <PlugZap className="w-3.5 h-3.5" />
          {test?.loading ? '测试中…' : '测试连接'}
        </button>
        {test?.result && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
            <Badge kind={test.result.reachable ? 'success' : 'error'} dot>
              {test.result.reachable ? '可连接' : '不可达'}
            </Badge>
            {test.result.adapter === 'fake' && <Badge kind="warning">未真实连接</Badge>}
            <span style={{ color: 'var(--ide-text-secondary)' }}>{test.result.note}</span>
          </span>
        )}
        {test?.error && (
          <span style={{ color: 'var(--state-error)', fontSize: 12.5 }}>{test.error}</span>
        )}
      </div>
    </div>
  );
}

function OssCard({
  oss,
  onChange,
  onRemove,
}: {
  oss: OssProfileDraft;
  onChange: (o: OssProfileDraft) => void;
  onRemove: () => void;
}): JSX.Element {
  return (
    <div className="ide-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        {labeledInput('ID', oss.id, (v) => onChange({ ...oss, id: v }), {
          placeholder: 'transport-report-oss',
          flex: '0 0 220px',
        })}
        {labeledInput('bucket', oss.bucket, (v) => onChange({ ...oss, bucket: v }), {
          placeholder: 'transport-report-files',
        })}
        <button className="ide-btn ide-btn-sm ide-btn-danger" onClick={onRemove} title="删除该配置">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        {labeledInput('endpoint', oss.endpoint, (v) => onChange({ ...oss, endpoint: v }), {
          placeholder: 'https://oss-cn-hangzhou.aliyuncs.com',
        })}
        {labeledInput('region', oss.region, (v) => onChange({ ...oss, region: v }), {
          placeholder: 'cn-hangzhou',
          flex: '0 0 160px',
        })}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        {labeledInput('access_key_id（明文）', oss.accessKeyId, (v) =>
          onChange({ ...oss, accessKeyId: v }),
        )}
        {labeledInput(
          'access_key_secret（明文）',
          oss.accessKeySecret,
          (v) => onChange({ ...oss, accessKeySecret: v }),
          { type: 'password' },
        )}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        {labeledInput('object_key_prefix', oss.objectKeyPrefix, (v) =>
          onChange({ ...oss, objectKeyPrefix: v }),
        )}
        <label style={{ flex: '0 0 200px', fontSize: 12 }}>
          <div style={{ color: 'var(--ide-text-tertiary)', marginBottom: 4 }}>
            signed_url_expires_seconds
          </div>
          <input
            className="ide-input"
            type="number"
            value={Number.isFinite(oss.signedUrlExpiresSeconds) ? oss.signedUrlExpiresSeconds : 0}
            onChange={(e) => onChange({ ...oss, signedUrlExpiresSeconds: Number(e.target.value) })}
          />
        </label>
      </div>
    </div>
  );
}
