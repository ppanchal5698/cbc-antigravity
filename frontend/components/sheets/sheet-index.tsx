'use client';

import { useMemo, useState } from 'react';
import type { PlanDoc, PlanSheet } from '@/lib/sheets';
import { Marker, Empty } from '@/components/shell/state';
import { cn } from '@/lib/utils';

/**
 * The indexed sheets. 512 rows is small enough to filter in the browser, so
 * this needs no endpoint - typing is instant instead of debounced.
 */
export function SheetIndex({
  docs,
  sheets,
  initialQuery = '',
}: {
  docs: PlanDoc[];
  sheets: PlanSheet[];
  initialQuery?: string;
}) {
  const [q, setQ] = useState(initialQuery);
  const [docId, setDocId] = useState<string>('');
  const [visionOnly, setVisionOnly] = useState(false);

  const disciplines = useMemo(() => {
    const counts = new Map<string, number>();
    for (const sheet of sheets) {
      const key = sheet.discipline || 'Unknown';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [sheets]);

  const filtered = useMemo(() => {
    const term = q.trim().toUpperCase();
    return sheets.filter((sheet) => {
      if (docId && sheet.docId !== docId) return false;
      // `identity` and `full` both mean a human or a vision pass is still owed.
      if (visionOnly && (!sheet.visionNeed || sheet.visionNeed === 'none')) return false;
      if (!term) return true;
      return (
        (sheet.sheetNo ?? '').toUpperCase().includes(term) ||
        (sheet.title ?? '').toUpperCase().includes(term) ||
        (sheet.discipline ?? '').toUpperCase().includes(term)
      );
    });
  }, [sheets, q, docId, visionOnly]);

  const docName = (id: string) => docs.find((doc) => doc.docId === id)?.file ?? id;

  return (
    <div>
      <div className="panel mb-4 flex flex-wrap items-center gap-x-4 gap-y-3 p-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Sheet number, title or discipline"
          aria-label="Filter sheets"
          className="border-rule focus:border-signal placeholder:text-ink-muted w-full max-w-xs rounded-md border bg-transparent px-2.5 py-1.5 font-mono text-[13px] outline-none"
        />

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <button
            type="button"
            onClick={() => setDocId('')}
            className={cn(
              'cursor-pointer rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
              docId === '' ? 'bg-signal-wash text-signal' : 'text-ink-muted hover:bg-sunken',
            )}
          >
            All sets
          </button>
          {docs.map((doc) => (
            <button
              key={doc.docId}
              type="button"
              onClick={() => setDocId(doc.docId)}
              title={doc.path}
              className={cn(
                'max-w-[16rem] cursor-pointer truncate rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                docId === doc.docId ? 'bg-signal-wash text-signal' : 'text-ink-muted hover:bg-sunken',
              )}
            >
              {doc.file}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setVisionOnly((prev) => !prev)}
          className={cn(
            'cursor-pointer rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
            visionOnly ? 'bg-signal-wash text-signal' : 'text-ink-muted hover:bg-sunken',
          )}
        >
          Needs vision
        </button>

        <p className="text-ink-muted ml-auto font-mono text-[12px]">
          {filtered.length.toLocaleString('en-US')} / {sheets.length.toLocaleString('en-US')}
        </p>
      </div>

      <div className="text-ink-muted mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        {disciplines.map(([discipline, n]) => (
          <span key={discipline}>
            {discipline}
            <span className="ml-1 font-mono opacity-70">{n}</span>
          </span>
        ))}
      </div>

      {filtered.length === 0 ? (
        <Empty title="No sheets match that filter." />
      ) : (
        <div className="panel scroll-x overflow-hidden">
          <table className="ledger">
            <thead>
              <tr>
                <th>Sheet</th>
                <th>Title</th>
                <th>Discipline</th>
                <th>Identified by</th>
                <th>Vision</th>
                <th className="text-right">Page</th>
                <th>Set</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((sheet) => (
                <tr key={`${sheet.docId}-${sheet.page}`}>
                  <td className="code font-medium">{sheet.sheetNo || '—'}</td>
                  <td className="min-w-[18rem]">{sheet.title || '—'}</td>
                  <td className="text-ink-muted">{sheet.discipline || 'Unknown'}</td>
                  <td>
                    <Marker tone={sheet.confidence === 'title_block' ? 'ink' : 'muted'}>
                      {sheet.confidence || 'none'}
                    </Marker>
                  </td>
                  <td>
                    {sheet.visionNeed && sheet.visionNeed !== 'none' ? (
                      <Marker tone="signal">{sheet.visionNeed}</Marker>
                    ) : (
                      <span className="text-ink-muted text-[12px]">—</span>
                    )}
                  </td>
                  <td className="num">{sheet.page}</td>
                  <td className="text-ink-muted max-w-[14rem] truncate text-[12px]">
                    {docName(sheet.docId)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
