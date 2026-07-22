import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X,
  Save,
  ShieldCheck,
  FileCode,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Info,
  Lock,
  Wand2,
  FlaskConical,
} from 'lucide-react';
import { workspaceApi, type ReportPackageDetail } from '../api.js';
import { useNavigate } from '../nav.js';

/**
 * Per-file guidance shown in the editor so a human knows what each package file
 * is for, whether it's editable, and how to change it. Keyed by package-relative
 * path. `group` clusters the file tree by purpose; `title` is a short 中文 label.
 */
interface FileGuide {
  group: string;
  title: string;
  purpose: string;
  /** Shown when editable: how to safely change it. */
  editHint?: string;
  /** Shown when read-only: why it can't be edited here. */
  readonlyReason?: string;
}

const GROUP_ORDER = ['查询', '字段与表头', '筛选参数', '计算脚本', '测试', '元数据'] as const;

const FILE_GUIDE: Record<string, FileGuide> = {
  'queries/main.sql': {
    group: '查询',
    title: '主查询 SQL',
    purpose: '报表的参数化 SQL。运行时把筛选条件填进 /* EASYBI_FILTERS */ 标记处执行。',
    editHint:
      '只改 SELECT/JOIN/WHERE 的固定部分；保留 /* EASYBI_FILTERS */、/* EASYBI_HAVING_FILTERS */ 标记，不要写死筛选值或引号字面量。',
  },
  'queries/bindings.json': {
    group: '筛选参数',
    title: '筛选 SQL 绑定',
    purpose: '每个筛选参数如何拼进 SQL（列表达式、where/having/exists 子句、操作符）。',
    editHint: '改绑定表达式需与 main.sql 的列别名一致；一般由生成流程维护，谨慎手改。',
  },
  'parameters.schema.json': {
    group: '筛选参数',
    title: '筛选项定义',
    purpose: '前端筛选表单的字段：标签、类型、操作符、是否必填、枚举选项。',
    editHint: '改标签/必填/默认操作符较安全；参数 id 必须与 bindings.json 对应。',
  },
  'fields.json': {
    group: '字段与表头',
    title: '输出字段与表头',
    purpose: '报表输出列：id、中文表头 label、顺序、类型（预览/导出的表头来自这里）。',
    editHint: '改 label/order/description 较安全；字段 id 要与 SQL 输出列或计算脚本产出一致。',
  },
  'transforms/index.ts': {
    group: '计算脚本',
    title: '计算脚本（TypeScript 源）',
    purpose:
      '对查询结果做逐行(transformRow)或分组(transformGroup)计算，产出计算/派生列（如环比/同比）。这是你手改复杂报表的主战场。',
    editHint:
      '改这里即可；保存时会自动生成 index.mjs（无需手动同步）。分组计算用 rows/preparedRows，依赖列以 raw_* 命名。',
  },
  'transforms/index.mjs': {
    group: '计算脚本',
    title: '计算脚本（运行时产物）',
    purpose: '由 index.ts 自动编译（去类型）生成，运行时实际执行的就是它。',
    readonlyReason: '自动生成，请改 index.ts —— 保存 index.ts 时会自动重新生成本文件。',
  },
  'tests/cases.json': {
    group: '测试',
    title: '测试用例',
    purpose: '记录该报表包的测试用例/期望（供回归参考）。',
    editHint: '按现有结构增改用例即可。',
  },
  'report.manifest.json': {
    group: '元数据',
    title: '报表包清单',
    purpose: '报表身份与出处（id、版本、执行策略、comparison、knowledge 快照等）。',
    readonlyReason: '身份/出处信息，由封包流程维护，编辑器只读。',
  },
  'knowledge.lock.json': {
    group: '元数据',
    title: '知识血缘锁',
    purpose: '锁定该报表用到的表/字段/JOIN/知识版本，保证血缘可追溯。',
    readonlyReason: '血缘锁，由封包流程维护，编辑器只读。',
  },
  'checksums.sha256': {
    group: '元数据',
    title: '校验和',
    purpose: '所有文件的 SHA-256，"重新封包"时自动重算。',
    readonlyReason: '由"重新封包"自动重算，不可手改。',
  },
};

/** Fallback guide for any unlisted file so nothing is a mystery. */
function guideFor(path: string): FileGuide {
  return (
    FILE_GUIDE[path] ?? {
      group: '元数据',
      title: path.split('/').pop() ?? path,
      purpose: '报表包文件。',
      readonlyReason: '未在可编辑白名单内，编辑器只读。',
    }
  );
}

const TS_TRANSFORM = 'transforms/index.ts';
const FIELDS_FILE = 'fields.json';

/** Save state of the currently-open file / the package as a whole. */
type Phase = 'clean' | 'dirty' | 'saved' | 'sealed';

/**
 * In-page editor for a development report package. Lets a human fix the
 * AI-generated SQL / transform / bindings / parameters, save each file, then
 * reseal (recompute checksums + re-validate). Published packages are not
 * editable — the caller only opens this for development-only packages.
 *
 * Editing transforms/index.ts auto-generates transforms/index.mjs on save, so
 * the runtime never runs a stale compiled transform.
 */
export function PackageEditor({
  projectId,
  reportId,
  version,
  name,
  onClose,
}: {
  projectId: string;
  reportId: string;
  version: string;
  name: string;
  onClose: (changed: boolean) => void;
}): JSX.Element {
  const [detail, setDetail] = useState<ReportPackageDetail | null>(null);
  const [active, setActive] = useState<string>('');
  const [content, setContent] = useState<string>('');
  const [editable, setEditable] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [resealErrors, setResealErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [savedAny, setSavedAny] = useState(false);
  const [phase, setPhase] = useState<Phase>('clean');
  // Dependency (raw_*) columns available to the transform, read from fields.json.
  const [depColumns, setDepColumns] = useState<string[]>([]);
  const [showDeps, setShowDeps] = useState(false);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const navigate = useNavigate();

  const openFile = useCallback(
    async (path: string) => {
      if (dirty && !window.confirm('当前文件有未保存的修改，切换将丢弃。继续？')) return;
      setError(null);
      setStatus(null);
      setResealErrors([]);
      try {
        const f = await workspaceApi.readPackageFile(projectId, reportId, version, path);
        setActive(path);
        setContent(f.content);
        setEditable(f.editable);
        setDirty(false);
        setPhase('clean');
      } catch (e) {
        setError(String((e as Error).message ?? e));
      }
    },
    [projectId, reportId, version, dirty],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await workspaceApi.getPackageDetail(projectId, reportId, version);
        if (cancelled) return;
        setDetail(d);
        // Prefer opening the transform source — it's the main hand-edit target.
        const first =
          d.files.find((f) => f.path === TS_TRANSFORM && f.editable) ??
          d.files.find((f) => f.editable) ??
          d.files[0];
        if (!first) return;
        const f = await workspaceApi.readPackageFile(projectId, reportId, version, first.path);
        if (cancelled) return;
        setActive(f.path);
        setContent(f.content);
        setEditable(f.editable);
        setDirty(false);
        setPhase('clean');
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, reportId, version]);

  // Load the transform's available dependency columns (raw_*) from fields.json,
  // so editing the script shows exactly which row.* fields exist.
  useEffect(() => {
    let cancelled = false;
    if (active !== TS_TRANSFORM) return;
    void (async () => {
      try {
        const f = await workspaceApi.readPackageFile(projectId, reportId, version, FIELDS_FILE);
        if (cancelled) return;
        const parsed = JSON.parse(f.content) as {
          fields?: Array<{ id?: string; source?: { dependencies?: Array<{ id?: string }> } }>;
        };
        const cols = new Set<string>();
        for (const field of parsed.fields ?? []) {
          for (const dep of field.source?.dependencies ?? []) {
            if (dep.id) cols.add(String(dep.id));
          }
        }
        setDepColumns([...cols].sort());
      } catch {
        if (!cancelled) setDepColumns([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, projectId, reportId, version]);

  async function save(): Promise<boolean> {
    if (!active || !editable) return false;
    setBusy(true);
    setError(null);
    setStatus(null);
    setResealErrors([]);
    try {
      const r = await workspaceApi.writePackageFile(projectId, reportId, version, active, content);
      setDirty(false);
      setSavedAny(true);
      setPhase('saved');
      const gen = r.generated?.length ? `，已自动生成 ${r.generated.join('、')}` : '';
      setStatus(`已保存 ${active}${gen}。记得点"重新封包"重算校验和。`);
      return true;
    } catch (e) {
      setError(String((e as Error).message ?? e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function reseal(): Promise<void> {
    if (dirty && !window.confirm('当前文件有未保存的修改，将不计入本次封包。继续？')) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    setResealErrors([]);
    try {
      const r = await workspaceApi.resealPackage(projectId, reportId, version);
      if (r.resealed) {
        setSavedAny(true);
        setPhase('sealed');
        setStatus(
          `重新封包成功，校验通过${r.warnings.length ? `（提示：${r.warnings.join('；')}）` : ''}。可点「去测试」验证；若 Runtime 已在运行，需重启后才会加载本次改动。`,
        );
      } else {
        setResealErrors(r.errors.length ? r.errors : ['结构校验未通过']);
      }
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  /** Save the current file (if dirty & editable) then reseal — the common flow. */
  async function saveAndSeal(): Promise<void> {
    if (dirty && editable) {
      const ok = await save();
      if (!ok) return; // save failed (error surfaced) — don't reseal a bad edit.
    }
    await reseal();
  }

  // Tab inserts two spaces instead of moving focus (basic code-editing nicety).
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const next = `${content.slice(0, start)}  ${content.slice(end)}`;
      setContent(next);
      setDirty(true);
      setPhase('dirty');
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + 2;
      });
    }
  }

  const activeGuide = active ? guideFor(active) : null;
  const lineCount = useMemo(() => content.split('\n').length, [content]);

  // Group files by purpose for the tree, preserving GROUP_ORDER.
  const grouped = useMemo(() => {
    const map = new Map<string, ReportPackageDetail['files']>();
    for (const f of detail?.files ?? []) {
      const g = guideFor(f.path).group;
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(f);
    }
    const order = [...GROUP_ORDER, ...[...map.keys()].filter((g) => !GROUP_ORDER.includes(g as never))];
    return order.filter((g) => map.has(g)).map((g) => ({ group: g, files: map.get(g)! }));
  }, [detail]);

  return (
    <div className="pkg-editor-backdrop" onClick={() => onClose(savedAny)}>
      <div className="pkg-editor" onClick={(e) => e.stopPropagation()}>
        <div className="pkg-editor-head">
          <FileCode className="w-4 h-4" style={{ color: 'var(--ide-accent, var(--ide-text-primary))' }} />
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>
            编辑报表包 · {name}{' '}
            <span className="ide-text-mono" style={{ color: 'var(--ide-text-tertiary)' }}>
              {version}
            </span>
          </div>
          <div style={{ flex: 1 }} />
          {detail && !detail.editable && (
            <span className="ide-badge ide-badge-warning" title={`状态：${detail.status || '未知'}`}>
              只读（已发布）
            </span>
          )}
          <button
            className="ide-btn ide-btn-sm"
            onClick={() => void save()}
            disabled={!editable || !dirty || busy}
            title={editable ? '保存当前文件' : '该文件只读'}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            保存
          </button>
          <button
            className="ide-btn ide-btn-sm ide-btn-primary"
            onClick={() => void saveAndSeal()}
            disabled={busy || (detail ? !detail.editable : true)}
            title={detail && !detail.editable ? '已发布/生产报表包为只读，请另存新版本' : '保存当前文件并重算校验、重新校验'}
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            保存并封包
          </button>
          {phase === 'sealed' && (
            <button
              className="ide-btn ide-btn-sm"
              onClick={() => {
                onClose(savedAny);
                navigate('test');
              }}
              title="关闭编辑器并前往测试页（记得在测试页重启 Runtime 以加载改动）"
            >
              <FlaskConical className="w-3.5 h-3.5" />
              去测试
            </button>
          )}
          <button className="ide-btn ide-btn-sm" onClick={() => onClose(savedAny)} title="关闭">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="pkg-editor-banner" style={{ color: 'var(--state-error)' }}>
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span className="min-w-0 break-all">{error}</span>
          </div>
        )}
        {resealErrors.length > 0 && (
          <div className="pkg-editor-banner" style={{ color: 'var(--state-error)', alignItems: 'flex-start' }}>
            <AlertCircle className="w-3.5 h-3.5 shrink-0" style={{ marginTop: 2 }} />
            <div className="min-w-0" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontWeight: 600 }}>重新封包失败：</span>
              {resealErrors.map((msg, i) => (
                <span key={i} className="break-all">
                  · {msg}
                </span>
              ))}
            </div>
          </div>
        )}
        {status && (
          <div className="pkg-editor-banner" style={{ color: 'var(--state-success)' }}>
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            <span className="min-w-0 break-all">{status}</span>
          </div>
        )}

        <div className="pkg-editor-body">
          <div className="pkg-editor-files ide-scroll">
            {grouped.map(({ group, files }) => (
              <div key={group} style={{ marginBottom: 6 }}>
                <div className="pkg-editor-group">{group}</div>
                {files.map((f) => {
                  const g = guideFor(f.path);
                  return (
                    <button
                      key={f.path}
                      className={'pkg-editor-file' + (f.path === active ? ' pkg-editor-file-active' : '')}
                      onClick={() => void openFile(f.path)}
                      title={g.purpose}
                    >
                      <span className="ide-truncate">{g.title}</span>
                      {f.generated ? (
                        <span className="pkg-editor-ro" title="由源文件自动生成">
                          <Wand2 className="w-3 h-3" />
                        </span>
                      ) : !f.editable ? (
                        <span className="pkg-editor-ro">
                          <Lock className="w-3 h-3" />
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))}
            {!detail && <div style={{ padding: 10, fontSize: 12 }}>正在载入…</div>}
          </div>
          <div className="pkg-editor-main">
            {activeGuide && (
              <div className="pkg-editor-desc">
                <div className="pkg-editor-desc-title">
                  <Info className="w-3.5 h-3.5 shrink-0" />
                  <span style={{ fontWeight: 600 }}>{activeGuide.title}</span>
                  <span className="ide-text-mono" style={{ color: 'var(--ide-text-tertiary)', fontSize: 11 }}>
                    {active}
                  </span>
                  {!editable && <span className="pkg-editor-tag">只读</span>}
                </div>
                <div className="pkg-editor-desc-body">{activeGuide.purpose}</div>
                {editable && activeGuide.editHint && (
                  <div className="pkg-editor-desc-hint">改法：{activeGuide.editHint}</div>
                )}
                {!editable && activeGuide.readonlyReason && (
                  <div className="pkg-editor-desc-hint">{activeGuide.readonlyReason}</div>
                )}
              </div>
            )}

            {active === TS_TRANSFORM && (
              <div className="pkg-editor-deps">
                <button className="pkg-editor-deps-toggle" onClick={() => setShowDeps((v) => !v)}>
                  {showDeps ? '▾' : '▸'} 可用依赖列与函数签名（{depColumns.length} 个 raw_* 列）
                </button>
                {showDeps && (
                  <div className="pkg-editor-deps-body ide-text-mono">
                    <div>{'// 逐行：transformRow(row) → row  ；分组：transformGroup(rows, context) → row'}</div>
                    <div>{'// 分组内已按 transformRow 处理好的行在 preparedRows；context.groupKey 是分组键'}</div>
                    {depColumns.length ? (
                      <div style={{ marginTop: 4 }}>
                        依赖列：{depColumns.map((c) => `row.${c}`).join('  ·  ')}
                      </div>
                    ) : (
                      <div style={{ marginTop: 4, color: 'var(--ide-text-tertiary)' }}>
                        （fields.json 未声明 raw_* 依赖列；计算字段的 dependencies 决定这里可用哪些 row.* 字段）
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <textarea
              ref={textRef}
              className="ide-input pkg-editor-text ide-text-mono"
              value={content}
              readOnly={!editable}
              spellCheck={false}
              onKeyDown={onKeyDown}
              onChange={(e) => {
                setContent(e.target.value);
                setDirty(true);
                setPhase('dirty');
              }}
              placeholder={active ? '' : '选择左侧文件开始编辑'}
            />
            <div className="pkg-editor-foot">
              <span style={{ fontSize: 11.5, color: 'var(--ide-text-tertiary)' }}>
                {active || '未选择文件'} · {lineCount} 行
              </span>
              <span className="pkg-editor-phase" data-phase={phase}>
                {!editable && active
                  ? '只读'
                  : phase === 'dirty'
                    ? '未保存'
                    : phase === 'saved'
                      ? '已保存待封包'
                      : phase === 'sealed'
                        ? '已封包 · 校验通过'
                        : ''}
              </span>
              <div style={{ flex: 1 }} />
              <button
                className="ide-btn ide-btn-sm ide-btn-primary"
                onClick={() => void save()}
                disabled={!editable || !dirty || busy}
                title={editable ? '保存该文件' : '该文件只读'}
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                保存
              </button>
            </div>
          </div>
        </div>

        <div className="pkg-editor-hint">
          手改流程：选文件 → 看顶部说明 → 改 → 「保存」或直接「保存并封包」。改
          <span className="ide-text-mono"> transforms/index.ts </span>
          保存时会<b>自动生成</b> index.mjs（不必手动同步）。仅 development 包可编辑，已发布包请另存新版本。
        </div>
      </div>
    </div>
  );
}
