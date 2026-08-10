'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export type ChatSessionSummary = {
  id: string;
  title: string;
  preview: string | null;
  updatedAt: string;
  createdAt: string;
};

function relativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return date.toLocaleDateString('en-GB');
}

type MenuState = { sessionId: string; x: number; y: number } | null;

export function ChatHistory({
  sessions,
  activeId,
  loading,
  onSelect,
  onDelete,
  onClose,
}: {
  sessions: ChatSessionSummary[];
  activeId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [menu, setMenu] = useState<MenuState>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu || !menuRef.current) return;

    const el = menuRef.current;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let x = menu.x;
    let y = menu.y;
    if (x + rect.width > window.innerWidth - pad) x = window.innerWidth - rect.width - pad;
    if (y + rect.height > window.innerHeight - pad) y = window.innerHeight - rect.height - pad;
    if (x < pad) x = pad;
    if (y < pad) y = pad;
    if (x !== menu.x || y !== menu.y) {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }

    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onPointer = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      close();
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  return (
    <aside
      className="border-rule bg-panel flex h-full w-full flex-col border-r sm:w-64"
      aria-label="Chat history"
    >
      <div className="border-rule flex items-center justify-between gap-2 border-b px-3 py-2.5">
        <p className="text-[13px] font-semibold">History</p>
        <button
          type="button"
          onClick={onClose}
          className="text-ink-muted hover:text-ink cursor-pointer text-[11px] font-medium"
        >
          Close
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p className="text-ink-muted px-3 py-6 text-center text-[12px]">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="text-ink-muted px-3 py-6 text-center text-[12px] leading-relaxed">
            No earlier chats on this desk.
          </p>
        ) : (
          <ul>
            {sessions.map((session) => {
              const active = session.id === activeId;
              return (
                <li key={session.id} className="border-rule/60 border-b">
                  <button
                    type="button"
                    onClick={() => onSelect(session.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setMenu({
                        sessionId: session.id,
                        x: event.clientX,
                        y: event.clientY,
                      });
                    }}
                    className={cn(
                      'w-full cursor-pointer px-3 py-2.5 text-left transition-colors',
                      active ? 'bg-signal-wash' : 'hover:bg-sunken',
                      menu?.sessionId === session.id && 'bg-sunken',
                    )}
                  >
                    <span
                      className={cn(
                        'block truncate text-[12px] font-medium',
                        active && 'text-signal',
                      )}
                    >
                      {session.title}
                    </span>
                    {session.preview && session.preview !== session.title ? (
                      <span className="text-ink-muted mt-0.5 block truncate text-[11px]">
                        {session.preview}
                      </span>
                    ) : null}
                    <span className="text-ink-muted mt-1 block font-mono text-[10px]">
                      {relativeTime(session.updatedAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {menu ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Chat actions"
          className="border-rule bg-panel fixed z-50 min-w-[10rem] overflow-hidden rounded-md border py-1"
          style={{
            left: menu.x,
            top: menu.y,
            boxShadow: 'var(--elev-overlay)',
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="text-alert hover:bg-alert-wash w-full cursor-pointer px-3 py-2 text-left text-[12px] font-medium"
            onClick={() => {
              const id = menu.sessionId;
              setMenu(null);
              onDelete(id);
            }}
          >
            Delete chat
          </button>
        </div>
      ) : null}
    </aside>
  );
}
