'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Markdown } from '@/components/chat/markdown';
import { StatusFeed } from '@/components/chat/status-feed';
import { ErrorBoundary } from '@/components/error-boundary';
import { readSse } from '@/lib/sse';
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

const SESSION_KEY = 'cbc.chat.session';

const PROMPTS = [
  'Which vendors cover Division 10 28 00, and which part of it does nobody cover?',
  'What throat depth does a 3-5/8 stud with 1/2 drywall both sides need?',
  'Expand hardware set HW-2 and cite every catalog page.',
];

export function ChatPanel({ vendorFolders }: { vendorFolders: string[] }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const sessionRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    sessionRef.current = window.localStorage.getItem(SESSION_KEY);
  }, []);

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
          body: JSON.stringify({ message, sessionId: sessionRef.current }),
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
            window.localStorage.setItem(SESSION_KEY, sessionId);
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
    [busy, patch],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[900px] px-4 sm:px-6">
          {messages.length === 0 ? (
            <div className="pt-16 pb-8">
              <p className="t-label mb-4">Ask the copilot</p>
              <ul className="border-rule border-t">
                {PROMPTS.map((prompt) => (
                  <li key={prompt}>
                    <button
                      type="button"
                      onClick={() => void send(prompt)}
                      className="border-rule hover:text-signal w-full cursor-pointer border-b py-3 text-left text-[14px] transition-colors"
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
                <div key={message.id} className="border-rule mt-8 border-t pt-3 first:mt-0">
                  <p className="t-label mb-2">You</p>
                  <p className="text-[15px] leading-relaxed whitespace-pre-wrap">
                    {message.content}
                  </p>
                </div>
              ) : (
                <div key={message.id} className="mt-5">
                  {message.streaming ? (
                    <StatusFeed events={message.status} className="mb-4" />
                  ) : message.status.length ? (
                    <details className="border-rule mb-4 border-b pb-2">
                      <summary className="t-label hover:text-ink cursor-pointer list-none py-1">
                        Activity
                        <span className="text-rule-strong ml-2 font-mono normal-case">
                          {message.status.length} events
                          {message.seconds ? ` · ${message.seconds.toFixed(1)}s` : ''}
                        </span>
                      </summary>
                      <StatusFeed events={message.status} className="mt-2 border-t-0" dense />
                    </details>
                  ) : null}

                  {message.content ? (
                    <div className={cn(message.failed && 'border-alert border-l-2 pl-3')}>
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

      <div className="border-rule bg-paper border-t">
        <div className="mx-auto flex w-full max-w-[900px] items-end gap-4 px-4 py-3 sm:px-6">
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
            placeholder="Ask about the drawings, the shelf, or the math"
            rows={1}
            aria-label="Message"
            className="border-rule focus:border-signal placeholder:text-ink-muted max-h-40 min-h-9 flex-1 resize-y border-b bg-transparent py-1.5 text-[14px] outline-none"
          />
          {busy ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="t-label hover:text-alert cursor-pointer py-2 transition-colors"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void send(input)}
              disabled={!input.trim()}
              className="t-label hover:text-signal cursor-pointer py-2 transition-colors disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
