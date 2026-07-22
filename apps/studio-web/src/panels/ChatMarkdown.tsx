import { Component, useMemo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Markdown renderer for assistant messages, adapted from Innos IdeChatMarkdown
 * (react-markdown + remark-gfm + a streaming-safe error boundary). No syntax
 * highlighter dependency: code blocks use a styled <pre> with a copy button,
 * which is enough for Studio and keeps the bundle small. Styling uses `.chat-md`
 * classes defined in styles.css (IDE-Mono tokens).
 */

// Streamed markdown can be transiently invalid (unclosed ``` etc.), which makes
// react-markdown throw. Fall back to plain text instead of blanking the message;
// reset on the next chunk so the next frame retries markdown.
class MdBoundary extends Component<{ fallback: string; children: ReactNode }, { hasError: boolean }> {
  constructor(props: { fallback: string; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }
  override componentDidUpdate(prev: { fallback: string }): void {
    if (prev.fallback !== this.props.fallback && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }
  override render(): ReactNode {
    if (this.state.hasError) return <div className="chat-md-fallback">{this.props.fallback}</div>;
    return this.props.children;
  }
}

export function ChatMarkdown({ text }: { text: string }): JSX.Element {
  const components = useMemo(
    () => ({
      code({ className, children, ...props }: { className?: string; children?: ReactNode }) {
        const match = /language-(\w+)/.exec(className || '');
        const codeString = String(children).replace(/\n$/, '');
        const isInline = !match && !codeString.includes('\n');
        if (isInline) {
          return (
            <code className="chat-inline-code" {...props}>
              {children}
            </code>
          );
        }
        const lang = match ? match[1] : 'text';
        return (
          <div className="chat-code-block">
            <div className="chat-code-head">
              <span className="chat-code-lang">{lang}</span>
              <button
                type="button"
                className="chat-code-copy"
                title="复制代码"
                onClick={() => void navigator.clipboard?.writeText(codeString)}
              >
                复制
              </button>
            </div>
            <pre className="chat-code-body">
              <code>{codeString}</code>
            </pre>
          </div>
        );
      },
    }),
    [],
  );

  return (
    <div className="chat-md">
      <MdBoundary fallback={text}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {text}
        </ReactMarkdown>
      </MdBoundary>
    </div>
  );
}
