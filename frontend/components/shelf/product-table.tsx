'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import type { ProductRow } from '@/lib/catalog';
import { LoadingRows, Empty } from '@/components/shell/state';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 100;

export type DivisionOption = { division: string; section: string; models: number };

/**
 * The price book itself: one row per model x size x finish, which is the grain
 * the index actually stores. A model has a price range, never a price, and
 * flattening that would hide the finish premium an estimator is looking for.
 */
export function ProductTable({
  folder,
  divisions,
  initialQuery = '',
}: {
  folder: string;
  divisions: DivisionOption[];
  initialQuery?: string;
}) {
  const [q, setQ] = useState(initialQuery);
  const [division, setDivision] = useState('');
  const [rows, setRows] = useState<ProductRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(
    async (nextOffset: number, append: boolean, search: string, div: string) => {
      const id = ++requestId.current;
      setLoading(true);
      try {
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(nextOffset),
        });
        if (search.trim()) params.set('q', search.trim());
        if (div) params.set('division', div);

        const response = await fetch(
          `/api/shelf/${encodeURIComponent(folder)}/products?${params}`,
        );
        if (!response.ok) throw new Error(`Request failed (${response.status})`);
        const body = (await response.json()) as { rows: ProductRow[]; total: number };
        // A slower earlier request must not overwrite a newer one.
        if (id !== requestId.current) return;
        setTotal(body.total);
        setOffset(nextOffset);
        setRows((prev) => (append && prev ? [...prev, ...body.rows] : body.rows));
      } catch (err) {
        if (id === requestId.current) {
          toast.error('Could not load price rows', {
            description: err instanceof Error ? err.message : String(err),
          });
          setRows([]);
        }
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [folder],
  );

  useEffect(() => {
    const timer = setTimeout(() => void load(0, false, q, division), q ? 220 : 0);
    return () => clearTimeout(timer);
  }, [q, division, load]);

  const shown = rows?.length ?? 0;

  return (
    <div>
      <div className="border-rule flex flex-wrap items-center gap-x-6 gap-y-3 border-b py-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Model or description"
          aria-label="Search this vendor's price rows"
          className="border-rule focus:border-signal placeholder:text-ink-muted w-full max-w-xs border-b bg-transparent py-1 font-mono text-[13px] outline-none"
        />

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            onClick={() => setDivision('')}
            className={cn(
              't-label cursor-pointer transition-colors',
              division === '' ? 'text-ink' : 'hover:text-ink',
            )}
          >
            All
          </button>
          {divisions.map((option) => (
            <button
              key={option.section}
              type="button"
              onClick={() => setDivision(option.section)}
              className={cn(
                't-label cursor-pointer transition-colors',
                division === option.section ? 'text-ink' : 'hover:text-ink',
              )}
            >
              {option.section}
              <span className="text-rule-strong ml-1.5 font-mono normal-case">{option.models}</span>
            </button>
          ))}
        </div>

        <p className="text-ink-muted ml-auto font-mono text-[12px]">
          {rows === null ? '—' : `${shown.toLocaleString('en-US')} / ${total.toLocaleString('en-US')}`}
        </p>
      </div>

      {rows === null ? (
        <LoadingRows rows={8} />
      ) : rows.length === 0 ? (
        <Empty title={q || division ? 'No price rows match that filter.' : 'This book has no parsed price rows. Open a page to read it.'} />
      ) : (
        <div className="scroll-x">
          <table className="ledger">
            <thead>
              <tr>
                <th>Model</th>
                <th>Description</th>
                <th>Size</th>
                <th>Finish</th>
                <th className="text-right">List</th>
                <th className="text-right">Page</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={`${row.model}-${row.size}-${row.finish}-${i}`}>
                  <td className="code font-medium">{row.model || '—'}</td>
                  <td className="max-w-lg min-w-[16rem]">
                    <span className="line-clamp-2">{row.description || '—'}</span>
                    {row.section ? (
                      <span className="text-ink-muted mt-0.5 block text-[11px]">{row.section}</span>
                    ) : null}
                  </td>
                  <td className="code text-ink-muted">{row.size || '—'}</td>
                  <td className="code">{row.finish || '—'}</td>
                  <td className="num">
                    {row.listPrice === null ? '—' : row.listPrice.toFixed(2)}
                  </td>
                  <td className="num">
                    <Link
                      href={`/shelf/${encodeURIComponent(folder)}?page=${row.page}`}
                      className="hover:text-signal underline underline-offset-2"
                    >
                      {row.page}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows && shown < total ? (
        <button
          type="button"
          disabled={loading}
          onClick={() => void load(offset + PAGE_SIZE, true, q, division)}
          className="border-rule hover:border-signal hover:text-signal t-label w-full cursor-pointer border-b py-3 transition-colors disabled:opacity-50"
        >
          {loading ? 'Loading…' : `Load ${Math.min(PAGE_SIZE, total - shown)} more`}
        </button>
      ) : null}
    </div>
  );
}
