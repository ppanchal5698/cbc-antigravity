'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SearchHit } from '@/app/api/search/route';
import { cn } from '@/lib/utils';

/**
 * One input over projects, vendors, price rows, plan sheets and book pages.
 * This is what makes 12,914 product rows and 512 sheets feel small.
 *
 * The dialog's state lives in an inner component that only mounts while open,
 * so closing resets the query and results with no teardown effect.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((prev) => !prev);
      } else if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!open) return null;
  return <Dialog onClose={() => setOpen(false)} />;
}

function Dialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  const search = useCallback(async (term: string) => {
    const id = ++requestId.current;
    if (term.trim().length < 2) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(term)}`);
      const body = (await response.json()) as { hits?: SearchHit[] };
      // A slower earlier request must not overwrite a newer one.
      if (id === requestId.current) {
        setHits(body.hits ?? []);
        setActive(0);
      }
    } catch {
      if (id === requestId.current) setHits([]);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void search(q), 160);
    return () => clearTimeout(timer);
  }, [q, search]);

  const go = useCallback(
    (hit: SearchHit | undefined) => {
      if (!hit) return;
      onClose();
      router.push(hit.href);
    },
    [onClose, router],
  );

  let lastGroup = '';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 px-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="border-rule-strong bg-paper w-full max-w-2xl border"
      >
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((i) => Math.min(i + 1, hits.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              go(hits[active]);
            }
          }}
          placeholder="Search projects, vendors, models, sheets"
          aria-label="Search projects, vendors, models and sheets"
          className="border-rule placeholder:text-ink-muted w-full border-b bg-transparent px-4 py-3.5 text-[15px] outline-none"
        />

        <div className="max-h-[52vh] overflow-y-auto">
          {q.trim().length < 2 ? (
            <p className="text-ink-muted px-4 py-6 text-center text-[12px]">
              Type at least two characters. Enter opens, Esc closes.
            </p>
          ) : hits.length === 0 ? (
            <p className="text-ink-muted px-4 py-6 text-center text-[12px]">
              {loading ? 'Searching…' : `Nothing matches "${q}".`}
            </p>
          ) : (
            hits.map((hit, i) => {
              const header = hit.group !== lastGroup ? hit.group : null;
              lastGroup = hit.group;
              return (
                <div key={`${hit.href}-${i}`}>
                  {header ? (
                    <p className="t-label border-rule bg-sunken border-b px-4 py-1.5">{header}</p>
                  ) : null}
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(hit)}
                    className={cn(
                      'border-rule/60 flex w-full cursor-pointer items-baseline gap-3 border-b px-4 py-2.5 text-left',
                      i === active && 'bg-signal-wash',
                    )}
                  >
                    <span className="shrink-0 font-mono text-[13px] font-medium">{hit.label}</span>
                    {hit.detail ? (
                      <span className="text-ink-muted min-w-0 truncate text-[12px]">
                        {hit.detail}
                      </span>
                    ) : null}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
