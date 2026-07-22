import { useCallback, useEffect, useState } from 'react';
import { Play, Square, Download, Table2, FileBarChart } from 'lucide-react';
import { runtimeApi, type Project, type RuntimeInfo, type QueryResult } from '../api.js';
import { TopBar, PageBody, Card, SectionTitle, ErrorBanner, Badge, EmptyState } from '../components/ui/common.js';
import { useNavigate } from '../nav.js';
import { useAgentRefresh } from '../AgentDrawer.js';

interface EnumOption {
  code: string;
  label: string;
}

interface Param {
  id: string;
  label: string;
  valueType: string;
  /** Stable data-type tag from the runtime: string | number | datetime | date |
   * enum | boolean | datetime_range | date_range | number_range. */
  dataType?: string;
  component: string;
  operators: string[];
  defaultOperator: string;
  required: boolean;
  /** Enum filters: selectable {code, label} (code + 中文). */
  enumOptions?: EnumOption[];
}

/** Range param value: two bounds. Single-value params keep a plain string. */
interface RangeValue {
  from: string;
  to: string;
}
type FilterValue = string | RangeValue;

const RANGE_TYPES = new Set(['date_range', 'datetime_range', 'number_range']);
function isRangeParam(p: Param): boolean {
  return RANGE_TYPES.has(p.valueType);
}
function isEnumParam(p: Param): boolean {
  return (p.dataType ?? p.valueType) === 'enum' && (p.enumOptions?.length ?? 0) > 0;
}
/** Boolean-flag filter (是/否 over a folded numeric/status column, e.g. 是否上传). */
function isBooleanParam(p: Param): boolean {
  return (p.dataType ?? p.valueType) === 'boolean';
}
function isRangeValue(v: FilterValue | undefined): v is RangeValue {
  return typeof v === 'object' && v !== null;
}
/** HTML input type for a range bound based on the param's value type. */
function rangeInputType(valueType: string): string {
  if (valueType === 'datetime_range') return 'datetime-local';
  if (valueType === 'date_range') return 'date';
  return 'number';
}

/** `<input type=datetime-local>` yields `2026-01-01T00:00` — normalise to a SQL
 * datetime `2026-01-01 00:00:00` the Runtime/MySQL accepts. Non-datetime values
 * pass through. Empty stays empty. */
function normalizeDateTime(value: string): string {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) {
    const withSeconds = value.length === 16 ? `${value}:00` : value;
    return withSeconds.replace('T', ' ');
  }
  return value;
}

const EXCEL_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function TestPanel({ project }: { project: Project }): JSX.Element {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [reports, setReports] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedReport, setSelectedReport] = useState<string>('');
  const [params, setParams] = useState<Param[]>([]);
  const [values, setValues] = useState<Record<string, FilterValue>>({});
  const [tests, setTests] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<QueryResult | null>(null);
  const navigate = useNavigate();
  const refreshNonce = useAgentRefresh();

  const refresh = useCallback(async () => {
    try {
      const s = await runtimeApi.status(project.id);
      setRuntime(s.runtime);
      if (s.runtime?.status === 'running') {
        const list = (await runtimeApi.reports(project.id)) as { items?: Array<{ id: string; name: string }> };
        setReports(list.items ?? []);
      }
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [project.id]);

  useEffect(() => {
    setRuntime(null);
    setReports([]);
    setParams([]);
    setSelectedReport('');
    void refresh();
    void runtimeApi
      .tests(project.id)
      .then((t) => setTests(t.tests))
      .catch(() => undefined);
  }, [project.id, refresh, refreshNonce]);

  async function start(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await runtimeApi.start(project.id);
      setRuntime(r.runtime);
      const list = (await runtimeApi.reports(project.id)) as { items?: Array<{ id: string; name: string }> };
      setReports(list.items ?? []);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function stop(): Promise<void> {
    setBusy(true);
    try {
      await runtimeApi.stop(project.id);
      setRuntime(null);
      setReports([]);
      setParams([]);
      setSelectedReport('');
    } finally {
      setBusy(false);
    }
  }

  async function loadParams(reportId: string): Promise<void> {
    setSelectedReport(reportId);
    setParams([]);
    setValues({});
    setPreview(null);
    setStatus(null);
    setError(null);
    if (!reportId) return;
    try {
      const p = (await runtimeApi.parameters(project.id, reportId)) as { parameters?: Param[] };
      const list = p.parameters ?? [];
      setParams(list);
      // Seed range params with an empty {from,to} so their two pickers are controlled.
      const seed: Record<string, FilterValue> = {};
      for (const param of list) if (isRangeParam(param)) seed[param.id] = { from: '', to: '' };
      setValues(seed);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }

  /**
   * 组装 filters：单值按默认操作符；范围（起/止）用 between + {from,to}。
   * 必填项缺失返回 { error }；否则返回 { filters }。导出与预览共用。
   */
  function buildFilters(): { filters?: Record<string, unknown>; error?: string } {
    const filters: Record<string, unknown> = {};
    for (const p of params) {
      const v = values[p.id];
      if (isRangeParam(p)) {
        const range = isRangeValue(v) ? v : { from: '', to: '' };
        const from = normalizeDateTime(range.from.trim());
        const to = normalizeDateTime(range.to.trim());
        if (!from && !to) {
          if (p.required) return { error: `「${p.label}」为必填项，请选择时间范围。` };
          continue;
        }
        filters[p.id] = { operator: 'between', value: { from, to } };
      } else {
        const s = typeof v === 'string' ? v.trim() : '';
        if (!s) {
          if (p.required) return { error: `「${p.label}」为必填项。` };
          continue;
        }
        filters[p.id] = { operator: p.defaultOperator, value: s };
      }
    }
    return { filters };
  }

  async function previewData(): Promise<void> {
    if (!selectedReport) return;
    setPreviewing(true);
    setError(null);
    setStatus(null);
    const built = buildFilters();
    if (built.error) {
      setError(built.error);
      setPreviewing(false);
      return;
    }
    try {
      const result = await runtimeApi.query(project.id, selectedReport, built.filters ?? {});
      setPreview(result);
      setStatus(
        `预览 ${result.rowCount} 行${result.truncated ? `（已截断至前 ${result.limit} 行）` : ''}。`,
      );
    } catch (e) {
      // 未配置数据库连接等业务错误在此以标准错误返回。
      setError(String((e as Error).message ?? e));
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  }

  async function exportExcel(): Promise<void> {
    if (!selectedReport) return;
    setExporting(true);
    setError(null);
    setStatus(null);
    const built = buildFilters();
    if (built.error) {
      setError(built.error);
      setExporting(false);
      return;
    }
    const filters = built.filters ?? {};
    try {
      const res = await runtimeApi.exportSync(project.id, selectedReport, filters);
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes(EXCEL_CT)) {
        // 真实 Excel：触发下载。
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${selectedReport}.xlsx`;
        a.click();
        URL.revokeObjectURL(url);
        setStatus('导出成功，Excel 已下载。');
      } else {
        // HTTP 200 JSON 业务错误（如未配置数据库/OSS）。
        const body = await res.json().catch(() => null);
        const msg = body?.error?.message ?? body?.error?.code ?? '导出未返回 Excel（可能未配置数据库连接）';
        setError(`导出未生成 Excel：${msg}`);
      }
      void runtimeApi.tests(project.id).then((t) => setTests(t.tests)).catch(() => undefined);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setExporting(false);
    }
  }

  const running = runtime?.status === 'running';

  return (
    <>
      <TopBar
        title="报表测试（Runtime）"
        right={
          running ? (
            <>
              <Badge kind="success" dot>
                运行中 · 端口 {runtime.port}
              </Badge>
              <button className="ide-btn ide-btn-sm" onClick={() => void stop()} disabled={busy}>
                <Square className="w-3.5 h-3.5" />
                停止
              </button>
            </>
          ) : (
            <button className="ide-btn ide-btn-primary ide-btn-sm" onClick={() => void start()} disabled={busy}>
              <Play className="w-3.5 h-3.5" />
              {busy ? '启动中…' : '启动 Runtime'}
            </button>
          )
        }
      />
      <PageBody>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <div style={{ maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {!running && (
            <EmptyState
              title="Runtime 未启动"
              hint="点击右上角「启动 Runtime」后，即可选择报表、预览数据或同步导出 Excel。编辑过报表包后需重启 Runtime 才会生效。"
            />
          )}

          {running && reports.length === 0 && (
            <EmptyState
              title="Runtime 已启动，但没有可测试的报表包"
              hint={
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                  <span>请先在「报表」页用 AI 生成报表包，生成后回到本页选择。</span>
                  <button className="ide-btn ide-btn-sm" onClick={() => navigate('reports')}>
                    <FileBarChart className="w-3.5 h-3.5" />
                    去报表页
                  </button>
                </div>
              }
            />
          )}

          {running && reports.length > 0 && (
            <section>
              <SectionTitle>选择报表</SectionTitle>
              <select
                className="ide-select"
                value={selectedReport}
                onChange={(e) => void loadParams(e.target.value)}
                style={{ maxWidth: 360 }}
              >
                <option value="">选择报表…</option>
                {reports.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </section>
          )}

          {params.length > 0 && (
            <section>
              <SectionTitle>动态筛选表单</SectionTitle>
              <Card>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {params.map((p) => {
                    const v = values[p.id];
                    const range = isRangeValue(v) ? v : { from: '', to: '' };
                    return (
                      <label key={p.id} style={{ fontSize: 12.5, color: 'var(--ide-text-secondary)' }}>
                        {p.label}
                        {p.required && <span style={{ color: 'var(--state-error)', marginLeft: 4 }}>*</span>}
                        <span className="ide-text-mono" style={{ color: 'var(--ide-text-tertiary)', marginLeft: 6, fontSize: 11 }}>
                          {p.valueType} · {p.defaultOperator}
                        </span>
                        {isBooleanParam(p) ? (
                          <select
                            className="ide-select"
                            value={typeof v === 'string' ? v : ''}
                            onChange={(e) => setValues((prev) => ({ ...prev, [p.id]: e.target.value }))}
                            style={{ marginTop: 4 }}
                          >
                            <option value="">（不筛选）</option>
                            <option value="true">是</option>
                            <option value="false">否</option>
                          </select>
                        ) : isEnumParam(p) ? (
                          <select
                            className="ide-select"
                            multiple={p.defaultOperator === 'in'}
                            value={
                              p.defaultOperator === 'in'
                                ? (typeof v === 'string' && v ? v.split(',') : [])
                                : (typeof v === 'string' ? v : '')
                            }
                            onChange={(e) => {
                              const next =
                                p.defaultOperator === 'in'
                                  ? Array.from(e.target.selectedOptions, (o) => o.value).join(',')
                                  : e.target.value;
                              setValues((prev) => ({ ...prev, [p.id]: next }));
                            }}
                            style={{ marginTop: 4, minHeight: p.defaultOperator === 'in' ? 84 : undefined }}
                          >
                            {p.defaultOperator !== 'in' && <option value="">（不筛选）</option>}
                            {(p.enumOptions ?? []).map((o) => (
                              <option key={o.code} value={o.code}>
                                {o.label}（{o.code}）
                              </option>
                            ))}
                          </select>
                        ) : isRangeParam(p) ? (
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                            <input
                              className="ide-input"
                              type={rangeInputType(p.valueType)}
                              value={range.from}
                              step={p.valueType === 'datetime_range' ? 1 : undefined}
                              onChange={(e) =>
                                setValues((prev) => ({ ...prev, [p.id]: { ...range, from: e.target.value } }))
                              }
                              aria-label={`${p.label} 起`}
                              style={{ flex: 1 }}
                            />
                            <span style={{ color: 'var(--ide-text-tertiary)' }}>至</span>
                            <input
                              className="ide-input"
                              type={rangeInputType(p.valueType)}
                              value={range.to}
                              step={p.valueType === 'datetime_range' ? 1 : undefined}
                              onChange={(e) =>
                                setValues((prev) => ({ ...prev, [p.id]: { ...range, to: e.target.value } }))
                              }
                              aria-label={`${p.label} 止`}
                              style={{ flex: 1 }}
                            />
                          </div>
                        ) : (
                          <input
                            className="ide-input"
                            value={typeof v === 'string' ? v : ''}
                            onChange={(e) => setValues((prev) => ({ ...prev, [p.id]: e.target.value }))}
                            placeholder={
                              p.required
                                ? `按 ${p.defaultOperator} 过滤（必填）`
                                : `按 ${p.defaultOperator} 过滤（留空则不筛选）`
                            }
                            style={{ marginTop: 4 }}
                          />
                        )}
                      </label>
                    );
                  })}
                </div>
                <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
                  <button
                    className="ide-btn"
                    onClick={() => void previewData()}
                    disabled={previewing || exporting}
                  >
                    <Table2 className="w-3.5 h-3.5" />
                    {previewing ? '查询中…' : '预览数据'}
                  </button>
                  <button className="ide-btn ide-btn-primary" onClick={() => void exportExcel()} disabled={exporting || previewing}>
                    <Download className="w-3.5 h-3.5" />
                    {exporting ? '导出中…' : '同步导出 Excel'}
                  </button>
                  {status && <span style={{ color: 'var(--state-success)', fontSize: 12.5 }}>{status}</span>}
                </div>
                <div style={{ marginTop: 8, color: 'var(--ide-text-tertiary)', fontSize: 11.5, lineHeight: 1.6 }}>
                  预览与同步导出都需要工作区已配置可连的 MySQL；未配置时返回标准错误。预览直接返回中文表头与数据（默认最多前 1000 行，滚动查看），只有真实生成并下载 Excel 才计入 REAL_SYNC_EXPORT。
                </div>
              </Card>
            </section>
          )}

          {preview && (
            <section>
              <SectionTitle>
                数据预览 · {preview.rowCount} 行{preview.truncated ? `（已截断至前 ${preview.limit} 行）` : ''}
              </SectionTitle>
              {preview.columns.length === 0 ? (
                <EmptyState title="该报表无输出列" hint="请先在报表配置中为该报表添加字段。" />
              ) : preview.rows.length === 0 ? (
                <EmptyState title="查询无数据" hint="当前筛选条件下没有匹配的行。" />
              ) : (
                <div
                  className="ide-card"
                  style={{ padding: 0, overflow: 'auto', maxHeight: 460 }}
                >
                  <table className="ide-table" style={{ minWidth: '100%' }}>
                    <thead>
                      <tr>
                        {preview.columns.map((c) => (
                          <th key={c.id} title={c.description ?? c.label} style={{ whiteSpace: 'nowrap' }}>
                            {c.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row, ri) => (
                        <tr key={ri}>
                          {preview.columns.map((c) => {
                            const cell = row[c.id];
                            return (
                              <td key={c.id} style={{ whiteSpace: 'nowrap' }}>
                                {cell == null ? '' : String(cell)}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          <section>
            <SectionTitle>测试记录</SectionTitle>
            {tests.length === 0 ? (
              <EmptyState title="暂无测试记录" hint="启动 Runtime 并同步导出后，这里会记录测试类型与结果。" />
            ) : (
              <div className="ide-card" style={{ padding: 0, overflow: 'hidden' }}>
                <table className="ide-table">
                  <thead>
                    <tr>
                      <th>类型</th>
                      <th>报表</th>
                      <th>结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tests.map((t, i) => (
                      <tr key={i}>
                        <td>
                          <Badge kind={String(t.testType).startsWith('REAL') ? 'success' : 'neutral'}>
                            {String(t.testType)}
                          </Badge>
                        </td>
                        <td className="ide-text-mono" style={{ color: 'var(--ide-text-tertiary)' }}>
                          {String(t.reportId)}
                        </td>
                        <td>{t.ok ? '成功' : '失败'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </PageBody>
    </>
  );
}
