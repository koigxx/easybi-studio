import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';

/** 顶栏：左标题(面包屑) + 右操作区。 */
export function TopBar({ title, right }: { title: ReactNode; right?: ReactNode }): JSX.Element {
  return (
    <header className="topbar">
      <span className="crumb">{title}</span>
      {right && <div className="topbar-right">{right}</div>}
    </header>
  );
}

/** 页面主体（滚动内容区）。 */
export function PageBody({ children }: { children: ReactNode }): JSX.Element {
  return <main className="page-body ide-scroll">{children}</main>;
}

/** 卡片容器。 */
export function Card({
  children,
  style,
  className,
}: {
  children: ReactNode;
  style?: React.CSSProperties;
  className?: string;
}): JSX.Element {
  return (
    <div className={'ide-card' + (className ? ' ' + className : '')} style={{ padding: 16, ...style }}>
      {children}
    </div>
  );
}

/** 区块标题（带左侧竖条）。 */
export function SectionTitle({ children }: { children: ReactNode }): JSX.Element {
  return <div className="ide-section-title">{children}</div>;
}

/** 错误横幅。 */
export function ErrorBanner({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      className="flex items-center gap-2 mb-4"
      style={{
        background: 'var(--state-error-soft)',
        color: 'var(--state-error)',
        borderRadius: 'var(--ide-radius-md)',
        fontSize: 13,
        padding: '10px 12px',
      }}
    >
      <AlertCircle className="w-4 h-4 shrink-0" />
      <span className="min-w-0 break-all">{children}</span>
    </div>
  );
}

/** 加载态。 */
export function Loading({ text = '加载中…' }: { text?: string }): JSX.Element {
  return (
    <div style={{ padding: 16, color: 'var(--ide-text-tertiary)', fontSize: 13 }}>{text}</div>
  );
}

/** 空状态。 */
export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }): JSX.Element {
  return (
    <div
      style={{
        padding: '2rem',
        border: '1px dashed var(--ide-border-strong)',
        borderRadius: 'var(--ide-radius-lg)',
        background: 'var(--ide-bg-chrome)',
        textAlign: 'center',
        color: 'var(--ide-text-secondary)',
      }}
    >
      <div style={{ fontWeight: 600, color: 'var(--ide-text-primary)' }}>{title}</div>
      {hint && <div style={{ marginTop: 8, fontSize: 12.5 }}>{hint}</div>}
    </div>
  );
}

export type BadgeKind = 'neutral' | 'success' | 'warning' | 'error' | 'info';

/** 状态徽章。 */
export function Badge({
  kind = 'neutral',
  dot,
  title,
  children,
}: {
  kind?: BadgeKind;
  dot?: boolean;
  title?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <span className={`ide-badge ide-badge-${kind}${dot ? ' ide-badge-dot' : ''}`} title={title}>
      {children}
    </span>
  );
}
