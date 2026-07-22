import { useCallback, useEffect, useState } from 'react';
import { Folder, FileText, Package, CornerLeftUp } from 'lucide-react';
import { workspaceApi, type Project, type FileNode, type FileContent } from '../api.js';
import { TopBar, PageBody, ErrorBanner } from '../components/ui/common.js';

/**
 * 只读工作区文件浏览 + 预览。用于查看生成的知识库/报表/输出等产物。
 * 与 provider 无关：无论 Claude 还是 Agent 平台生成的文件都能看。
 */
export function FilesPanel({ project }: { project: Project }): JSX.Element {
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<FileNode[]>([]);
  const [selected, setSelected] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (d: string) => {
      setError(null);
      try {
        const tree = await workspaceApi.listFiles(project.id, d);
        setDir(tree.dir);
        setEntries(tree.entries);
      } catch (e) {
        setError(String((e as Error).message ?? e));
      }
    },
    [project.id],
  );

  useEffect(() => {
    setSelected(null);
    void load('');
  }, [load]);

  async function openFile(node: FileNode): Promise<void> {
    setError(null);
    try {
      setSelected(await workspaceApi.readFile(project.id, node.path));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }

  const parentDir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';

  return (
    <>
      <TopBar
        title={
          <span>
            工作区文件
            <span className="ide-text-mono" style={{ color: 'var(--ide-text-tertiary)', fontSize: 12, marginLeft: 8 }}>
              /{dir || ''}
            </span>
          </span>
        }
      />
      <PageBody>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          {/* Tree */}
          <div className="ide-card ide-scroll" style={{ flex: '0 0 300px', padding: 6, maxHeight: '70vh', overflow: 'auto' }}>
            {dir && (
              <div className="sb-nav-item" onClick={() => void load(parentDir)} style={{ height: 30 }}>
                <CornerLeftUp className="w-4 h-4" />
                <span>上级目录</span>
              </div>
            )}
            {entries.length === 0 && (
              <div style={{ color: 'var(--ide-text-tertiary)', padding: 8, fontSize: 12.5 }}>（空目录）</div>
            )}
            {entries.map((e) => (
              <div
                key={e.path}
                className="sb-nav-item"
                onClick={() => (e.kind === 'dir' ? void load(e.path) : void openFile(e))}
                style={{
                  height: 30,
                  background: selected?.path === e.path ? 'var(--ide-accent-soft)' : undefined,
                }}
              >
                {e.kind === 'dir' ? (
                  <Folder className="w-4 h-4" style={{ color: 'var(--ide-text-tertiary)' }} />
                ) : e.textPreviewable ? (
                  <FileText className="w-4 h-4" style={{ color: 'var(--ide-text-tertiary)' }} />
                ) : (
                  <Package className="w-4 h-4" style={{ color: 'var(--ide-text-tertiary)' }} />
                )}
                <span className="ide-truncate">{e.name}</span>
                {e.kind === 'file' && (
                  <span className="ide-num" style={{ marginLeft: 'auto', color: 'var(--ide-text-muted)', fontSize: 11 }}>
                    {e.size ?? 0}B
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* Preview */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {!selected && (
              <div style={{ color: 'var(--ide-text-tertiary)', fontSize: 13 }}>选择左侧文件查看内容</div>
            )}
            {selected && (
              <>
                <div className="ide-text-mono" style={{ fontSize: 12, color: 'var(--ide-text-tertiary)', marginBottom: 6 }}>
                  {selected.path}（{selected.size} 字节）
                </div>
                {selected.content === null ? (
                  <div style={{ color: 'var(--state-warning)', fontSize: 12.5 }}>{selected.reason ?? '无法预览'}</div>
                ) : (
                  <pre
                    className="ide-text-mono ide-scroll"
                    style={{
                      margin: 0,
                      padding: 14,
                      background: 'var(--ide-bg-chrome)',
                      border: '1px solid var(--ide-border)',
                      color: 'var(--ide-text-primary)',
                      borderRadius: 'var(--ide-radius-md)',
                      overflow: 'auto',
                      maxHeight: '68vh',
                      fontSize: 12,
                      lineHeight: 1.55,
                    }}
                  >
                    {selected.content}
                  </pre>
                )}
              </>
            )}
          </div>
        </div>
      </PageBody>
    </>
  );
}
