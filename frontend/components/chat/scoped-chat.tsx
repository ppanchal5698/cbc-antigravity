'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { MessageSquare, X } from 'lucide-react';
import { ChatPanel } from '@/components/chat/chat-panel';
import {
  CHAT_SCOPES,
  sessionKey,
  type ChatContext,
  type ChatScopeId,
} from '@/lib/chat-scopes';
import { cn } from '@/lib/utils';

const WIDTH_KEY = 'cbc.scoped-chat.width';
const WIDTH_MIN = 360;
const WIDTH_MAX = 900;
const WIDTH_DEFAULT = 520;

function clampWidth(n: number, viewport: number): number {
  const max = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.floor(viewport * 0.85)));
  return Math.min(max, Math.max(WIDTH_MIN, Math.round(n)));
}

/**
 * Quote Desk companion dock — same ChatPanel chrome as /chat, opened beside the page.
 */
export function ScopedChat({
  scope,
  context,
  vendorFolders,
}: {
  scope: ChatScopeId;
  context?: ChatContext;
  vendorFolders: string[];
}) {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(WIDTH_DEFAULT);
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startW = useRef(WIDTH_DEFAULT);
  const definition = CHAT_SCOPES[scope];

  useEffect(() => {
    const saved = Number(window.localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= WIDTH_MIN) {
      setWidth(clampWidth(saved, window.innerWidth));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!dragging) return;

    const onMove = (event: PointerEvent) => {
      const next = clampWidth(startW.current + (startX.current - event.clientX), window.innerWidth);
      setWidth(next);
    };
    const onUp = (event: PointerEvent) => {
      setDragging(false);
      const next = clampWidth(startW.current + (startX.current - event.clientX), window.innerWidth);
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

  const onResizePointerDown = (event: ReactPointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    startX.current = event.clientX;
    startW.current = width;
    setDragging(true);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="border-rule bg-panel text-ink hover:border-signal hover:text-signal fixed right-4 bottom-4 z-40 flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-[12px] font-medium shadow-[var(--elev-overlay)] transition-colors"
      >
        <MessageSquare className="size-3.5" aria-hidden />
        {definition.title}
      </button>
    );
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/25 lg:hidden"
        onClick={() => setOpen(false)}
        aria-hidden
      />
      <aside
        className="desk-chrome border-rule fixed top-0 right-0 z-50 flex h-full flex-col border-l"
        style={{ width: `min(100vw, ${width}px)`, boxShadow: 'var(--elev-overlay)' }}
        aria-label={definition.title}
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat panel"
          aria-valuenow={width}
          aria-valuemin={WIDTH_MIN}
          aria-valuemax={WIDTH_MAX}
          title="Drag to resize"
          onPointerDown={onResizePointerDown}
          className={cn(
            'absolute top-0 bottom-0 left-0 z-10 hidden w-1.5 cursor-col-resize touch-none sm:block',
            'hover:bg-signal/30',
            dragging && 'bg-signal/40',
          )}
        />
        <header className="border-rule flex items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <p className="t-eyebrow mb-1">Companion</p>
            <p className="truncate text-[13px] font-semibold">{definition.title}</p>
            <p className="text-ink-muted truncate text-[11px]">
              {context?.projectName || context?.vendorFolder || 'This page only'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close chat"
            className="hover:bg-sunken text-ink-muted hover:text-ink inline-flex size-8 cursor-pointer items-center justify-center rounded-md transition-colors"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="bg-paper flex min-h-0 flex-1 flex-col">
          <ChatPanel
            key={sessionKey(scope, context)}
            scope={scope}
            context={context}
            vendorFolders={vendorFolders}
            fill
          />
        </div>
      </aside>
    </>
  );
}
