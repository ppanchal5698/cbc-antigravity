'use client';

import type { TreeEntry } from '@/app/api/projects/[id]/tree/route';
import { Empty, LoadingRows } from '@/components/shell/state';
import { cn } from '@/lib/utils';

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('en-GB', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
}

/** The project folder as it exists on disk - the same tree the agent reads. */
export function FileTree({
  entries,
  outputPaths,
}: {
  entries: TreeEntry[] | null;
  /** Generated estimates, marked so they are not mistaken for inputs. */
  outputPaths: Set<string>;
}) {
  if (entries === null) return <LoadingRows rows={4} />;
  if (!entries.length) {
    return <Empty title="This folder is empty. Upload a bid set to start an estimate." />;
  }

  return (
    <div className="scroll-x">
      <table className="ledger">
        <thead>
          <tr>
            <th>Name</th>
            <th className="text-right">Size</th>
            <th className="text-right">Modified</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const output = outputPaths.has(entry.name);
            return (
              <tr key={entry.path}>
                <td>
                  <span
                    className="inline-flex items-baseline gap-2"
                    style={{ paddingLeft: `${entry.depth * 16}px` }}
                  >
                    <span
                      className={cn(
                        'font-mono text-[11px]',
                        entry.kind === 'directory' ? 'text-signal' : 'text-rule-strong',
                      )}
                      aria-hidden
                    >
                      {entry.kind === 'directory' ? '▸' : '·'}
                    </span>
                    <span className={cn('text-[13px]', entry.kind === 'directory' && 'font-medium')}>
                      {entry.name}
                    </span>
                    {output ? <span className="t-label text-signal">Generated</span> : null}
                  </span>
                </td>
                <td className="num text-ink-muted">
                  {entry.kind === 'directory' ? '—' : bytes(entry.size)}
                </td>
                <td className="num text-ink-muted">{when(entry.modified)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
