'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { History, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ChatHistory, type ChatSessionSummary } from '@/components/chat/chat-history';
import { Markdown } from '@/components/chat/markdown';
import { StatusFeed } from '@/components/chat/status-feed';
import { ErrorBoundary } from '@/components/error-boundary';
import { readSse } from '@/lib/sse';
import {
  CHAT_SCOPES,
  sessionKey,
  subjectKey,
  type ChatContext,
  type ChatScopeId,
} from '@/lib/chat-scopes';
import { cn } from '@/lib/utils';
import type { StatusEvent, StreamFrame } from '@/types/events';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: StatusEvent[];
  streaming: boolean;
  failed?: boolean;
  seconds?: number;
};

/** The placeholder says what this surface answers, so the scope is obvious before asking. */
const PLACEHOLDER: Record<ChatScopeId, string> = {
  general: 'Ask about the drawings, the shelf, or the math',
  project: 'Ask about this bid set',
  shelf: 'Ask about the vendors and their price books',
  vendor: "Ask about this vendor's books and pricing",
  memory: 'Ask how the workspace remembers things',
};

const WIDTH_KEY = 'cbc.chat.width';
const WIDTH_MIN = 520;
const WIDTH_MAX = 1600;
const WIDTH_DEFAULT = 900;

function clampWidth(n: number): number {
  return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(n)));
}

/** Drag the right edge of the chat column to widen or narrow it. */
function useChatWidth() {
  const [width, setWidth] = useState(WIDTH_DEFAULT);
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startW = useRef(WIDTH_DEFAULT);

  useEffect(() => {
    const saved = Number(window.localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= WIDTH_MIN && saved <= WIDTH_MAX) {
      setWidth(saved);
    }
  }, []);

  useEffect(() => {
    if (!dragging) return;

    const onMove = (event: PointerEvent) => {
      const next = clampWidth(startW.current + (event.clientX - startX.current));
      setWidth(next);
    };
    const onUp = (event: PointerEvent) => {
      setDragging(false);
      const next = clampWidth(startW.current + (event.clientX - startX.current));
      setWidth(next);
      window.localStorage.setItem(WIDTH_KEY, String(next));
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging]);

  const onHandlePointerDown = (event: ReactPointerEvent) => {
    event.preventDefault();
    startX.current = event.clientX;
    startW.current = width;
    setDragging(true);
  };

  return { width, dragging, onHandlePointerDown };
}

export function ChatPanel({
  vendorFolders,
  scope = 'general',
  context,
  fill = false,
}: {
  vendorFolders: string[];
  /** Which surface this is. Decides the contract, the starter prompts and the session. */
  scope?: ChatScopeId;
  context?: ChatContext;
  /** Fill the parent (docked side panel) instead of a centered resizable column. */
  fill?: boolean;
}) {
  const definition = CHAT_SCOPES[scope];
  const storageKey = useMemo(() => sessionKey(scope, context), [scope, context]);
  const subject = useMemo(() => subjectKey(context), [context]);
  const PROMPTS = definition.prompts;

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [hydrating, setHydrating] = useState(true);

  const sessionRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const columnResize = useChatWidth();
  const width = fill ? undefined : columnResize.width;
  const dragging = fill ? false : columnResize.dragging;
  const onHandlePointerDown = columnResize.onHandlePointerDown;

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const qs = new URLSearchParams({ scope, subject });
      const response = await fetch(`/api/chat/sessions?${qs}`, { cache: 'no-store' });
      const body = (await response.json()) as {
        sessions?: ChatSessionSummary[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || 'Could not load history');
      setSessions(body.sessions ?? []);
    } catch (err) {
      toast.error('Could not load chat history', {
        description: err instanceof Error ? err.message : String(err),
      });
      setSessions([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [scope, subject]);

  const loadSession = useCallback(
    async (id: string) => {
      try {
        const response = await fetch(`/api/chat/sessions/${id}`, { cache: 'no-store' });
        const body = (await response.json()) as {
          messages?: { id: string; role: 'user' | 'assistant'; content: string }[];
          error?: string;
        };
        if (!response.ok) throw new Error(body.error || 'Could not open chat');
        sessionRef.current = id;
        setActiveId(id);
        window.localStorage.setItem(storageKey, id);
        setMessages(
          (body.messages ?? []).map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            status: [],
            streaming: false,
          })),
        );
      } catch (err) {
        toast.error('Could not open chat', {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [storageKey],
  );

  // Restore the active pointer and its transcript when the surface mounts.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = window.localStorage.getItem(storageKey);
      sessionRef.current = saved;
      setActiveId(saved);
      if (saved) {
        try {
          const response = await fetch(`/api/chat/sessions/${saved}`, { cache: 'no-store' });
          if (response.ok) {
            const body = (await response.json()) as {
              messages?: { id: string; role: 'user' | 'assistant'; content: string }[];
            };
            if (!cancelled) {
              setMessages(
                (body.messages ?? []).map((m) => ({
                  id: m.id,
                  role: m.role,
                  content: m.content,
                  status: [],
                  streaming: false,
                })),
              );
            }
          } else if (!cancelled) {
            // Stale localStorage pointer — start clean.
            window.localStorage.removeItem(storageKey);
            sessionRef.current = null;
            setActiveId(null);
          }
        } catch {
          /* offline / gateway down — keep empty transcript, still hold the pointer */
        }
      }
      if (!cancelled) setHydrating(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  useEffect(() => {
    if (!historyOpen) return;
    void refreshHistory();
  }, [historyOpen, refreshHistory]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const patch = useCallback((id: string, update: (m: Message) => Message) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? update(m) : m)));
  }, []);

  const startNewChat = useCallback(() => {
    if (busy) return;
    abortRef.current?.abort();
    sessionRef.current = null;
    setActiveId(null);
    window.localStorage.removeItem(storageKey);
    setMessages([]);
    setInput('');
    setHistoryOpen(false);
    boxRef.current?.focus();
  }, [busy, storageKey]);

  const deleteSession = useCallback(
    async (id: string) => {
      try {
        const response = await fetch(`/api/chat/sessions/${id}`, { method: 'DELETE' });
        const body = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(body.error || 'Could not delete');
        if (sessionRef.current === id) {
          sessionRef.current = null;
          setActiveId(null);
          window.localStorage.removeItem(storageKey);
          setMessages([]);
        }
        setSessions((prev) => prev.filter((s) => s.id !== id));
        toast.success('Chat deleted');
      } catch (err) {
        toast.error('Could not delete chat', {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [storageKey],
  );

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || busy) return;

      const userId = crypto.randomUUID();
      const replyId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        { id: userId, role: 'user', content: message, status: [], streaming: false },
        { id: replyId, role: 'assistant', content: '', status: [], streaming: true },
      ]);
      setInput('');
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, sessionId: sessionRef.current, scope, context }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => '');
          throw new Error(detail || `Request failed (${response.status})`);
        }

        for await (const frame of readSse(response.body)) {
          if (frame.event === 'session') {
            const { sessionId } = JSON.parse(frame.data) as { sessionId: string };
            sessionRef.current = sessionId;
            setActiveId(sessionId);
            window.localStorage.setItem(storageKey, sessionId);
            continue;
          }
          const payload = JSON.parse(frame.data) as StreamFrame;
          switch (payload.kind) {
            case 'status':
              patch(replyId, (m) => ({ ...m, status: [...m.status, payload.event] }));
              break;
            case 'token':
              patch(replyId, (m) => ({ ...m, content: m.content + payload.text }));
              break;
            case 'done':
              patch(replyId, (m) => ({
                ...m,
                content: payload.response || m.content,
                streaming: false,
                seconds: payload.durationSeconds,
              }));
              break;
            case 'error':
              toast.error('Antigravity run failed', { description: payload.message });
              patch(replyId, (m) => ({ ...m, streaming: false, failed: true }));
              break;
            default:
              break;
          }
        }
        patch(replyId, (m) => ({ ...m, streaming: false }));
        if (historyOpen) void refreshHistory();
      } catch (err) {
        if (controller.signal.aborted) {
          patch(replyId, (m) => ({ ...m, streaming: false }));
        } else {
          toast.error('Lost connection to Antigravity', {
            description: err instanceof Error ? err.message : String(err),
          });
          patch(replyId, (m) => ({ ...m, streaming: false, failed: true }));
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
        boxRef.current?.focus();
      }
    },
    [busy, patch, scope, context, storageKey, historyOpen, refreshHistory],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-rule bg-panel flex items-center gap-2 border-b px-3 py-2">
        <button
          type="button"
          onClick={() => setHistoryOpen((o) => !o)}
          aria-pressed={historyOpen}
          className={cn(
            'inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors',
            historyOpen
              ? 'bg-signal-wash text-signal'
              : 'border-rule text-ink-muted hover:bg-sunken hover:text-ink border',
          )}
        >
          <History className="size-3.5" aria-hidden />
          History
        </button>
        <button
          type="button"
          onClick={startNewChat}
          disabled={busy}
          className="border-rule text-ink-muted hover:bg-sunken hover:text-ink inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
        >
          <Plus className="size-3.5" aria-hidden />
          New chat
        </button>
        <span className="text-ink-muted ml-auto hidden truncate text-[11px] sm:inline">
          {definition.title}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        {historyOpen ? (
          <ChatHistory
            sessions={sessions}
            activeId={activeId}
            loading={historyLoading}
            onSelect={(id) => {
              void loadSession(id);
              setHistoryOpen(false);
            }}
            onDelete={(id) => void deleteSession(id)}
            onClose={() => setHistoryOpen(false)}
          />
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div
              className={cn('relative mx-auto w-full px-4 pt-4 sm:px-6', fill && 'max-w-none')}
              style={fill ? undefined : { maxWidth: width }}
            >
              {!fill ? (
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize chat panel"
                  aria-valuenow={width}
                  aria-valuemin={WIDTH_MIN}
                  aria-valuemax={WIDTH_MAX}
                  title="Drag to resize chat width"
                  onPointerDown={onHandlePointerDown}
                  className={cn(
                    'absolute top-0 right-0 bottom-0 z-10 hidden w-3 cursor-col-resize touch-none sm:block',
                    'after:bg-rule after:absolute after:inset-y-0 after:right-1 after:w-px after:transition-colors',
                    'hover:after:bg-signal',
                    dragging && 'after:bg-signal',
                  )}
                />
              ) : null}

              {hydrating ? (
                <p className="text-ink-muted py-10 text-center text-[12px]">Loading chat…</p>
              ) : null}

              {!hydrating && messages.length === 0 ? (
                <div className="pt-10 pb-8">
                  <p className="mb-1 text-[13px] font-semibold">{definition.title}</p>
                  <p className="text-ink-muted mb-4 max-w-prose text-[12px] leading-relaxed">
                    {definition.blurb}
                  </p>
                  <ul className="panel overflow-hidden">
                    {PROMPTS.map((prompt) => (
                      <li key={prompt} className="border-rule border-b last:border-0">
                        <button
                          type="button"
                          onClick={() => void send(prompt)}
                          className="hover:bg-sunken w-full cursor-pointer px-4 py-3 text-left text-[14px] transition-colors"
                        >
                          {prompt}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <p className="text-ink-muted mt-6 text-[12px] leading-relaxed">
                    Every answer is a draft for estimator review. Prices come from the price books
                    and the engine, never from the copilot&apos;s memory.
                  </p>
                </div>
              ) : null}

              <div className="py-6">
                {messages.map((message) =>
                  message.role === 'user' ? (
                    <div key={message.id} className="mt-8 first:mt-0">
                      <div className="bg-signal-wash rounded-md px-4 py-3">
                        <p className="t-label mb-1.5 text-signal">You</p>
                        <p className="text-[15px] leading-relaxed whitespace-pre-wrap">
                          {message.content}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div key={message.id} className="mt-5">
                      {message.streaming ? (
                        <StatusFeed events={message.status} className="mb-4" />
                      ) : message.status.length ? (
                        <details className="panel mb-4 px-3 py-2">
                          <summary className="t-label hover:text-ink cursor-pointer list-none py-1">
                            Activity
                            <span className="text-ink-muted ml-2 font-mono">
                              {message.status.length} events
                              {message.seconds ? ` · ${message.seconds.toFixed(1)}s` : ''}
                            </span>
                          </summary>
                          <StatusFeed events={message.status} className="mt-2" dense />
                        </details>
                      ) : null}

                      {message.content ? (
                        <div
                          className={cn('panel p-4', message.failed && 'border-alert/40')}
                        >
                          <ErrorBoundary label="This reply">
                            <Markdown content={message.content} vendorFolders={vendorFolders} />
                          </ErrorBoundary>
                        </div>
                      ) : message.failed ? (
                        <p className="text-alert text-[13px]">The run did not produce an answer.</p>
                      ) : null}
                    </div>
                  ),
                )}
                <div ref={endRef} />
              </div>
            </div>
          </div>

          <div className="border-rule bg-panel border-t">
            <div
              className={cn(
                'relative mx-auto flex w-full items-end gap-3 px-4 py-3 sm:px-6',
                fill && 'max-w-none',
              )}
              style={fill ? undefined : { maxWidth: width }}
            >
              <textarea
                ref={boxRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
                placeholder={PLACEHOLDER[scope]}
                rows={1}
                aria-label="Message"
                className="border-rule focus:border-signal placeholder:text-ink-muted max-h-40 min-h-9 flex-1 resize-y rounded-md border bg-transparent px-3 py-2 text-[14px] outline-none"
              />
              {busy ? (
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className="text-alert hover:bg-alert-wash cursor-pointer rounded-md px-3 py-2 text-[12px] font-medium transition-colors"
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void send(input)}
                  disabled={!input.trim()}
                  className="bg-signal text-primary-foreground hover:bg-signal/90 cursor-pointer rounded-md px-3 py-2 text-[12px] font-medium transition-colors disabled:opacity-40"
                >
                  Send
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
