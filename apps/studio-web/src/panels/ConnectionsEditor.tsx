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
  type ConnectionsDraft,
  type DbProfileDraft,
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
  return (
    <div className="ide-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
              // Nudge the port to the engine default only if it still holds the
              // other engine's default (don't clobber a custom port).
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
        {labeledInput('host', db.host, (v) => onChange({ ...db, host: v }), {
          placeholder: '127.0.0.1',
        })}
        <label style={{ flex: '0 0 110px', fontSize: 12 }}>
          <div style={{ color: 'var(--ide-text-tertiary)', marginBottom: 4 }}>port</div>
          <input
            className="ide-input"
            type="number"
            value={Number.isFinite(db.port) ? db.port : 0}
            onChange={(e) => onChange({ ...db, port: Number(e.target.value) })}
          />
        </label>
        <button className="ide-btn ide-btn-sm ide-btn-danger" onClick={onRemove} title="删除该连接">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        {labeledInput('username', db.username, (v) => onChange({ ...db, username: v }), {
          placeholder: 'report_reader',
        })}
        {labeledInput('password（明文）', db.password, (v) => onChange({ ...db, password: v }), {
          placeholder: '直接填写明文密码',
          type: 'password',
        })}
      </div>
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
            onClick={() => onChange({ ...db, databases: [...db.databases, ''] })}
          >
            <Plus className="w-3.5 h-3.5" /> 添加库
          </button>
        </div>
        {db.databases.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--ide-text-tertiary)' }}>暂无数据库</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {db.databases.map((name, di) => (
              <div key={di} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  className="ide-input"
                  value={name}
                  placeholder="transport_order"
                  onChange={(e) =>
                    onChange({
                      ...db,
                      databases: db.databases.map((d, j) => (j === di ? e.target.value : d)),
                    })
                  }
                  style={{ flex: 1 }}
                />
                <button
                  className="ide-btn ide-btn-sm ide-btn-ghost"
                  onClick={() =>
                    onChange({ ...db, databases: db.databases.filter((_, j) => j !== di) })
                  }
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
