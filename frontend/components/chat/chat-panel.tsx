'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { toast } from 'sonner';
import { Markdown } from '@/components/chat/markdown';
import { StatusFeed } from '@/components/chat/status-feed';
import { ErrorBoundary } from '@/components/error-boundary';
import { readSse } from '@/lib/sse';
import {
  CHAT_SCOPES,
  sessionKey,
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
  // One conversation per scope and subject, so the bid set you were discussing is not
  // still in context when you ask about a vendor's multiplier.
  const storageKey = useMemo(() => sessionKey(scope, context), [scope, context]);
  const PROMPTS = definition.prompts;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const sessionRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const columnResize = useChatWidth();
  const width = fill ? undefined : columnResize.width;
  const dragging = fill ? false : columnResize.dragging;
  const onHandlePointerDown = columnResize.onHandlePointerDown;

  // localStorage is read in an effect, not during render, because this component is
  // server-rendered first. Callers key the element on the scope, so switching subject
  // remounts and clears the transcript rather than needing to reset it here.
  useEffect(() => {
    sessionRef.current = window.localStorage.getItem(storageKey);
  }, [storageKey]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const patch = useCallback((id: string, update: (m: Message) => Message) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? update(m) : m)));
  }, []);

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
              // The final response replaces the streamed text, so the rendered
              // answer is always complete, well-formed markdown.
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
    [busy, patch, scope, context, storageKey],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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

          {messages.length === 0 ? (
            <div className="pt-10 pb-8">
              <p className="mb-1 text-[13px] font-semibold">{definition.title}</p>
              {/* Say up front what this chat covers, so a question that belongs to a
                  different surface is redirected before it is asked. */}
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
                Every answer is a draft for estimator review. Prices come from the price books and
                the engine, never from the copilot&apos;s memory.
              </p>
            </div>
          ) : null}

          <div className="py-6">
            {messages.map((message) =>
              message.role === 'user' ? (
                <div key={message.id} className="mt-8 first:mt-0">
                  <div className="bg-signal-wash rounded-lg px-4 py-3">
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
                      className={cn(
                        'panel p-4',
                        message.failed && 'border-alert/40',
                      )}
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
  );
}
