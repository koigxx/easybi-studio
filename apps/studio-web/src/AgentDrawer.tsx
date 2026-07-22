import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Bot,
  X,
  Send,
  Square,
  Loader2,
  Wrench,
  CheckCircle2,
  AlertCircle,
  History,
  Plus,
  Trash2,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { agentApi, type AgentActionType, type AgentHealth, type AgentJob, type JobEvent } from './api.js';
import {
  emptyChat,
  reduceEvent,
  reduceEvents,
  isTerminal,
  actionLabel,
  groupRows,
  toolGroupSummary,
  type ChatModel,
  type ChatLine,
  type ChatToolLine,
} from './panels/agent-chat.js';
import { ChatMarkdown } from './panels/ChatMarkdown.js';

/**
 * Global AI chat drawer (revives the stage-4 AgentDrawer, now provider-agnostic).
 *
 * Talks only to /api/easybi/* and the frozen JobEvent contract, so switching the
 * backend provider (local Claude → Innos) is env-only and needs no change here.
 * Front-end never connects to any AI vendor API directly.
 *
 * Multi-turn: real Claude ends each turn as SUCCEEDED and closes the SSE stream.
 * A reply resumes the job on the backend (--resume) and re-pumps a fresh stream,
 * so the drawer re-subscribes after sending a reply.
 */

interface AgentDrawerContextValue {
  /** Start a preset action (prompt = the configured full prompt) or free-chat. */
  startAction: (projectId: string, action: string, prompt?: string, reportId?: string) => void;
  /** Open the drawer on a fresh blank free-chat (plain conversation). */
  newChat: () => void;
  open: () => void;
  /**
   * Bumped whenever the agent writes artifacts / a turn completes, so panels can
   * auto-reload disk-derived state instead of forcing the user to hit 刷新.
   * Panels subscribe via `useAgentRefresh()` in an effect dependency.
   */
  refreshNonce: number;
}

const AgentDrawerContext = createContext<AgentDrawerContextValue | null>(null);

export function useAgentDrawer(): AgentDrawerContextValue {
  const ctx = useContext(AgentDrawerContext);
  if (!ctx) throw new Error('useAgentDrawer 必须在 AgentDrawerProvider 内使用');
  return ctx;
}

/**
 * Subscribe to agent-driven refreshes. Use the returned number in an effect's
 * dependency array; it changes each time the agent writes artifacts or a turn
 * finishes, prompting the panel to reload its disk-derived state.
 */
export function useAgentRefresh(): number {
  return useAgentDrawer().refreshNonce;
}

export const SSE_EVENT_NAMES: JobEvent['type'][] = [
  'job_started',
  'run_started',
  'run_completed',
  'user_message',
  'phase_changed',
  'message_delta',
  'tool_started',
  'tool_finished',
  'waiting_for_user',
  'artifact_changed',
  'checkpoint_created',
  'change_summary_ready',
  'job_completed',
  'job_failed',
];

export function AgentDrawerProvider({
  children,
  currentProjectId,
}: {
  children: ReactNode;
  currentProjectId?: string | null;
}): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatModel>(() => emptyChat());
  const [health, setHealth] = useState<AgentHealth | null>(null);
  const [starting, setStarting] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const [history, setHistory] = useState<AgentJob[] | null>(null);
  // Bumped on artifact/checkpoint/completion events so panels auto-reload.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const esRef = useRef<EventSource | null>(null);
  // Mirror of chat.eventCount readable synchronously inside callbacks, so a reply's
  // re-subscribe knows how many server events were already consumed (the SSE `since`).
  const eventCountRef = useRef(0);
  useEffect(() => {
    eventCountRef.current = chat.eventCount;
  }, [chat.eventCount]);

  useEffect(() => {
    agentApi.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  const loadHistory = useCallback(() => {
    setHistory(null);
    const pid = currentProjectId ?? undefined;
    agentApi
      .list(pid)
      .then((d) => setHistory(d.jobs.filter((j) => j.type === 'agent')))
      .catch((e) => setBanner(String(e?.message ?? e)));
  }, [currentProjectId]);

  const closeStream = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  useEffect(() => closeStream, [closeStream]);

  const subscribe = useCallback(
    (id: string, since = 0) => {
      closeStream();
      const es = new EventSource(agentApi.eventsUrl(id, since));
      esRef.current = es;
      const onEvent = (ev: MessageEvent): void => {
        try {
          const parsed = JSON.parse(ev.data) as JobEvent;
          setChat((m) => reduceEvent(m, parsed));
          // Any disk-affecting event → let panels know to reload. `artifact_changed`
          // and `checkpoint_created` fire mid-turn (e.g. after the agent writes a
          // catalog / report package); `job_completed` covers the final flush.
          if (
            parsed.type === 'artifact_changed' ||
            parsed.type === 'checkpoint_created' ||
            parsed.type === 'job_completed'
          ) {
            setRefreshNonce((n) => n + 1);
          }
          if (parsed.type === 'job_completed' || parsed.type === 'job_failed') closeStream();
        } catch {
          /* ignore malformed frame */
        }
      };
      SSE_EVENT_NAMES.forEach((n) => es.addEventListener(n, onEvent as EventListener));
      es.onmessage = onEvent;
      es.onerror = () => {
        // The server closes the stream when the turn ends; nothing to do.
      };
    },
    [closeStream],
  );

  const startAction = useCallback(
    (projectId: string, action: string, prompt?: string, reportId?: string) => {
      setIsOpen(true);
      setView('chat');
      setStarting(true);
      setBanner(null);
      setReply('');
      setActiveAction(action);
      setChat(emptyChat('QUEUED'));
      agentApi
        .start(projectId, action as AgentActionType, prompt, reportId)
        .then(({ job }) => {
          setJobId(job.id);
          setChat((m) => ({ ...m, status: job.status }));
          subscribe(job.id);
        })
        .catch((e) => setBanner(String(e?.message ?? e)))
        .finally(() => setStarting(false));
    },
    [subscribe],
  );

  // Start a fresh blank conversation (free-chat): the user types the first message.
  // `openDrawer` = true when triggered from outside (the toolbar button) so a
  // direct click both opens the drawer and lands on a blank chat.
  const startFreeChat = useCallback(
    (openDrawer = false) => {
      if (openDrawer) setIsOpen(true);
      setView('chat');
      setActiveAction('free-chat');
      setJobId(null);
      setChat(emptyChat('SUCCEEDED')); // idle so the input box is enabled immediately
      setBanner(null);
      setReply('');
      closeStream();
    },
    [closeStream],
  );

  const deleteConversation = useCallback(
    (job: AgentJob) => {
      agentApi
        .delete(job.id)
        .then(() => {
          setHistory((h) => (h ? h.filter((j) => j.id !== job.id) : h));
          if (jobId === job.id) {
            setJobId(null);
            setChat(emptyChat());
          }
        })
        .catch((e) => setBanner(String(e?.message ?? e)));
    },
    [jobId],
  );

  const open = useCallback(() => {
    setIsOpen(true);
    // Opening with no active chat lands on history so past conversations are found.
    if (!jobId) {
      setView('history');
      loadHistory();
    }
  }, [jobId, loadHistory]);

  // Reopen a past conversation: rebuild server state, load its events, show it.
  const openConversation = useCallback(
    (job: AgentJob) => {
      setBanner(null);
      setStarting(true);
      setView('chat');
      setActiveAction(null);
      setChat(emptyChat(job.status));
      setJobId(job.id);
      closeStream();
      agentApi
        .reopen(job.id)
        .then(({ job: reopened, events }) => {
          setChat(reduceEvents(emptyChat(reopened.status), events));
          // Live-subscribe only if it's somehow still active; finished chats stay static.
          // Start the cursor past the events we already rendered.
          if (reopened.status === 'RUNNING' || reopened.status === 'QUEUED')
            subscribe(job.id, events.length);
        })
        .catch((e) => setBanner(String(e?.message ?? e)))
        .finally(() => setStarting(false));
    },
    [subscribe, closeStream],
  );

  const showHistory = useCallback(() => {
    setView('history');
    loadHistory();
  }, [loadHistory]);

  const sendReply = useCallback(() => {
    const intent =
      chat.phase === 'AWAITING_DISCOVERY_CONFIRMATION'
        ? 'confirm_discovery'
        : chat.phase === 'AWAITING_MODEL_APPROVAL'
          ? 'approve_model'
          : 'chat';
    const text =
      reply.trim() ||
      (intent === 'confirm_discovery'
        ? '确认基础模型，按已说明的业务口径继续确定建模。'
        : intent === 'approve_model'
          ? '批准确定模型，开始编译报表。'
          : '');
    if (!text) return;
    if (!jobId && !currentProjectId) {
      setBanner('请先在左侧选择一个工作区');
      return;
    }
    const projectId = currentProjectId;
    const previousChat = chat;
    const restoreAfterFailure = (error: unknown) => {
      setChat(previousChat);
      setReply(text);
      setBanner(String((error as { message?: unknown })?.message ?? error));
    };
    setReply('');
    setBanner(null);
    // Optimistically show the user's turn.
    setChat((m) => ({
      ...m,
      status: 'RUNNING',
      waitingQuestion: undefined,
      lines: [...m.lines, { kind: 'user', text }],
    }));
    if (jobId) {
      // Existing conversation: resume it (real Claude opens a fresh stream).
      // Pass the already-consumed event count as `since` so the resumed turn's
      // stream doesn't replay the prior turn's job_completed (which would close
      // the stream immediately and leave the reply unanswered).
      const since = eventCountRef.current;
      agentApi
        .reply(jobId, text, intent)
        .then(() => subscribe(jobId, since))
        .catch(restoreAfterFailure);
      return;
    }
    // New free-chat: the first message starts the job.
    setStarting(true);
    agentApi
      .start(projectId!, 'free-chat' as AgentActionType, text)
      .then(({ job }) => {
        setJobId(job.id);
        subscribe(job.id);
      })
      .catch(restoreAfterFailure)
      .finally(() => setStarting(false));
  }, [jobId, reply, subscribe, currentProjectId, chat]);

  // "终止" stops the current turn but keeps the conversation alive: the backend
  // settles the job to SUCCEEDED (resumable) and streams a job_completed, which
  // re-enables the input so the user can send another message. We deliberately
  // do NOT set CANCELED or close the stream here — the pump's completion event
  // does that, keeping the model in sync.
  const interrupt = useCallback(() => {
    if (!jobId) return;
    agentApi.interrupt(jobId).catch((e) => setBanner(String(e?.message ?? e)));
  }, [jobId]);

  const ctxValue = useMemo<AgentDrawerContextValue>(
    () => ({ startAction, open, newChat: () => startFreeChat(true), refreshNonce }),
    [startAction, open, startFreeChat, refreshNonce],
  );

  return (
    <AgentDrawerContext.Provider value={ctxValue}>
      {children}
      {isOpen && (
        <>
          {/* Backdrop: closes on click; also stops the drawer looking transparent
              over the knowledge tier tables underneath (issue #2). */}
          <div className="chat-backdrop" onClick={() => setIsOpen(false)} />
          <DrawerView
            view={view}
            chat={chat}
            activeAction={activeAction}
            health={health}
            starting={starting}
            banner={banner}
            reply={reply}
            hasJob={jobId !== null}
            isFreeChat={activeAction === 'free-chat'}
            history={history}
            onReply={setReply}
            onSend={sendReply}
            onCancel={interrupt}
            onClose={() => setIsOpen(false)}
            onShowHistory={showHistory}
            onNewChat={startFreeChat}
            onOpenConversation={openConversation}
            onDeleteConversation={deleteConversation}
          />
        </>
      )}
    </AgentDrawerContext.Provider>
  );
}

function statusText(s: ChatModel['status']): string {
  switch (s) {
    case 'QUEUED':
      return '排队中';
    case 'RUNNING':
      return '进行中';
    case 'WAITING_FOR_USER':
      return '等待你的确认';
    case 'SUCCEEDED':
      return '本轮完成';
    case 'FAILED':
      return '已失败';
    case 'CANCELED':
      return '已取消';
  }
}

function DrawerView({
  view,
  chat,
  activeAction,
  health,
  starting,
  banner,
  reply,
  hasJob,
  isFreeChat,
  history,
  onReply,
  onSend,
  onCancel,
  onClose,
  onShowHistory,
  onNewChat,
  onOpenConversation,
  onDeleteConversation,
}: {
  view: 'chat' | 'history';
  chat: ChatModel;
  activeAction: string | null;
  health: AgentHealth | null;
  starting: boolean;
  banner: string | null;
  reply: string;
  hasJob: boolean;
  isFreeChat: boolean;
  history: AgentJob[] | null;
  onReply: (v: string) => void;
  onSend: () => void;
  onCancel: () => void;
  onClose: () => void;
  onShowHistory: () => void;
  onNewChat: () => void;
  onOpenConversation: (job: AgentJob) => void;
  onDeleteConversation: (job: AgentJob) => void;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat.lines, chat.status, view]);

  const busy = chat.status === 'RUNNING' || chat.status === 'QUEUED' || starting;
  // Reply is allowed whenever the task is idle (finished a turn / waiting), and
  // for a brand-new free-chat before its first message (hasJob is still false).
  const canType = view === 'chat' && (hasJob || isFreeChat) && !busy;
  const approvalPhase =
    chat.phase === 'AWAITING_DISCOVERY_CONFIRMATION' ||
    chat.phase === 'AWAITING_MODEL_APPROVAL';
  const statusKind = busy
    ? 'warning'
    : chat.status === 'FAILED'
      ? 'error'
      : chat.status === 'SUCCEEDED'
        ? 'success'
        : 'neutral';

  return (
    <aside className="chat-drawer">
      {/* Header */}
      <div className="chat-header">
        <Bot className="w-4 h-4" style={{ color: 'var(--ide-accent, var(--ide-text-primary))' }} />
        <div style={{ fontWeight: 600, fontSize: 13.5 }}>AI 助手</div>
        {view === 'chat' && activeAction && (
          <span className="ide-badge ide-badge-info">{actionLabel(activeAction)}</span>
        )}
        {view === 'chat' && hasJob && (
          <span className={`ide-badge ide-badge-${statusKind}`}>{statusText(chat.status)}</span>
        )}
        <div style={{ flex: 1 }} />
        <button
          className={'ide-btn ide-btn-sm' + (view === 'history' ? ' ide-btn-primary' : '')}
          title="历史对话"
          onClick={onShowHistory}
        >
          <History className="w-4 h-4" />
        </button>
        <button className="ide-btn ide-btn-sm" title="收起（任务继续后台）" onClick={onClose}>
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Provider line */}
      <div className="chat-provider">
        Provider：{health ? `${health.provider}${health.available ? '' : ' · 不可用'}` : '检测中…'}
        {health?.note ? ` · ${health.note}` : ''}
      </div>

      {view === 'history' ? (
        <HistoryView
          history={history}
          banner={banner}
          onOpen={onOpenConversation}
          onNewChat={onNewChat}
          onDelete={onDeleteConversation}
        />
      ) : (
        <>
          {/* Body */}
          <div ref={scrollRef} className="chat-body ide-scroll">
            {banner && (
              <div className="chat-error">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span className="min-w-0 break-all">{banner}</span>
              </div>
            )}
            {chat.lines.length === 0 && !banner && (
              <div className="chat-empty">
                {starting
                  ? '正在载入…'
                  : isFreeChat && !hasJob
                    ? '新对话：在下方直接输入你的问题，Enter 发送。'
                    : hasJob
                      ? '这段对话没有可显示的内容。'
                      : '从右上角「历史」选择过去的对话，或在页面上用「AI 助手」发起新任务。'}
              </div>
            )}
            {groupRows(chat.lines).map((row, i) =>
              row.kind === 'tool-group' ? (
                <ToolGroupView key={i} tools={row.tools} />
              ) : (
                <ChatLineView key={i} line={row} />
              ),
            )}
            {busy && (
              <div className="chat-typing">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                处理中…
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="chat-footer">
        {chat.status === 'WAITING_FOR_USER' && chat.waitingQuestion && (
          <div className="chat-waiting">{chat.waitingQuestion}</div>
        )}
        {approvalPhase && (
          <div className="chat-waiting">
            {chat.phase === 'AWAITING_DISCOVERY_CONFIRMATION'
              ? '请补充或确认基础模型；确认后将使用全新上下文进行确定建模。'
              : '请审阅确定模型；批准后将使用全新上下文编译查询和脚本。'}
            <button className="ide-btn ide-btn-primary ide-btn-sm" onClick={onSend}>
              {chat.phase === 'AWAITING_DISCOVERY_CONFIRMATION' ? '确认并确定建模' : '批准并开始编译'}
            </button>
          </div>
        )}
        <div className="chat-input-row">
          <textarea
            className="ide-input chat-input"
            rows={2}
            placeholder={
              canType
                ? approvalPhase
                  ? '可填写补充口径；也可直接点击确认按钮…'
                  : '输入你的回复，Enter 发送、Shift+Enter 换行…'
                : busy
                  ? 'AI 正在处理，稍候…'
                  : '任务启动后可在此追问'
            }
            value={reply}
            disabled={!canType}
            onChange={(e) => onReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
          />
          {busy ? (
            <button
              className="ide-btn chat-send"
              onClick={onCancel}
              disabled={isTerminal(chat.status)}
              title="终止本次回复（可继续对话）"
            >
              <Square className="w-4 h-4" />
            </button>
          ) : (
            <button
              className="ide-btn ide-btn-primary chat-send"
              onClick={onSend}
              disabled={!canType || (!reply.trim() && !approvalPhase)}
              title="发送"
            >
              <Send className="w-4 h-4" />
            </button>
          )}
            </div>
          </div>
        </>
      )}
    </aside>
  );
}

function HistoryView({
  history,
  banner,
  onOpen,
  onNewChat,
  onDelete,
}: {
  history: AgentJob[] | null;
  banner: string | null;
  onOpen: (job: AgentJob) => void;
  onNewChat: () => void;
  onDelete: (job: AgentJob) => void;
}): JSX.Element {
  return (
    <div className="chat-body ide-scroll">
      <button className="ide-btn ide-btn-sm chat-newchat" onClick={onNewChat}>
        <Plus className="w-3.5 h-3.5" />
        新建对话
      </button>
      {banner && (
        <div className="chat-error">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="min-w-0 break-all">{banner}</span>
        </div>
      )}
      {history === null && !banner && <div className="chat-empty">正在载入历史…</div>}
      {history !== null && history.length === 0 && (
        <div className="chat-empty">还没有对话记录。点「新建对话」直接提问，或在页面上用「AI 助手」发起任务。</div>
      )}
      {history?.map((job) => (
        <div key={job.id} className="chat-history-item" onClick={() => onOpen(job)}>
          <div className="chat-history-top">
            <span className="chat-history-title ide-truncate">{historyTitle(job)}</span>
            <span className={`ide-badge ide-badge-${historyKind(job.status)}`}>
              {statusText(job.status)}
            </span>
            <button
              className="chat-history-del"
              title="删除这条对话"
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(`删除对话「${historyTitle(job)}」？此操作不可恢复。`)) {
                  onDelete(job);
                }
              }}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="chat-history-sub">
            {job.createdAt ? new Date(job.createdAt).toLocaleString('zh-CN') : job.id}
            {job.agentProvider ? ` · ${job.agentProvider}` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}

function historyTitle(job: AgentJob): string {
  // The action verb is encoded in the taskId (e.g. claude_3_create-report).
  const m = /_(?:[0-9]+)_(.+)$/.exec(job.id);
  const action = m?.[1];
  return action ? actionLabel(action) : job.id;
}

function historyKind(s: AgentJob['status']): string {
  if (s === 'FAILED') return 'error';
  if (s === 'SUCCEEDED') return 'success';
  if (s === 'CANCELED') return 'neutral';
  return 'warning';
}

function ChatLineView({ line }: { line: ChatLine }): JSX.Element {
  if (line.kind === 'user') {
    return (
      <div className="chat-line-user">
        <div className="chat-bubble-user">{line.text}</div>
      </div>
    );
  }
  if (line.kind === 'assistant') {
    return (
      <div className="chat-bubble-assistant">
        <ChatMarkdown text={line.text} />
      </div>
    );
  }
  if (line.kind === 'tool') {
    return <ToolRow tool={line} />;
  }
  return <div className="chat-notice">{line.text}</div>;
}

function ToolRow({ tool }: { tool: ChatToolLine }): JSX.Element {
  return (
    <div className="chat-tool">
      {tool.running ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
      ) : tool.ok === false ? (
        <AlertCircle className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--state-error)' }} />
      ) : tool.ok ? (
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--state-success)' }} />
      ) : (
        <Wrench className="w-3.5 h-3.5 shrink-0" />
      )}
      <span className="ide-truncate">
        {tool.tool}
        {tool.detail ? ` · ${tool.detail}` : ''}
      </span>
    </div>
  );
}

/**
 * A run of tool calls, collapsed into one foldable row so a long Read/Grep/…
 * sequence doesn't flood the transcript. Auto-expands while any step is still
 * running so live progress stays visible; collapses once the run settles.
 */
function ToolGroupView({ tools }: { tools: ChatToolLine[] }): JSX.Element {
  const anyRunning = tools.some((t) => t.running);
  const [open, setOpen] = useState(false);
  const expanded = open || anyRunning;
  const anyFailed = tools.some((t) => t.ok === false);
  return (
    <div className="chat-tool-group">
      <button
        type="button"
        className="chat-tool-group-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 shrink-0" />
        )}
        {anyRunning ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
        ) : anyFailed ? (
          <AlertCircle className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--state-error)' }} />
        ) : (
          <Wrench className="w-3.5 h-3.5 shrink-0" />
        )}
        <span className="ide-truncate">{toolGroupSummary(tools)}</span>
      </button>
      {expanded && (
        <div className="chat-tool-group-body">
          {tools.map((t, i) => (
            <ToolRow key={i} tool={t} />
          ))}
        </div>
      )}
    </div>
  );
}
