'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Marker } from '@/components/shell/state';
import { cn } from '@/lib/utils';
import type { RunStatus } from '@/types/events';

export type DownloadRow = {
  id: string;
  status: RunStatus;
  output_path: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  project_id: string;
  project_name: string;
  slug: string;
  filename: string | null;
};

const TONE: Record<RunStatus, 'muted' | 'signal' | 'alert' | 'ink'> = {
  pending: 'muted',
  running: 'signal',
  completed: 'ink',
  failed: 'alert',
};

type StatusFilter = 'all' | RunStatus;

function stamp(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
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

export function DownloadsLedger({ rows }: { rows: DownloadRow[] }) {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [project, setProject] = useState('all');

  const projects = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of rows) map.set(row.project_id, row.project_name);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const visible = useMemo(() => {
    return rows.filter((row) => {
      if (status !== 'all' && row.status !== status) return false;
      if (project !== 'all' && row.project_id !== project) return false;
      return true;
    });
  }, [rows, status, project]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {(
          [
            ['all', 'All'],
            ['completed', 'Completed'],
            ['running', 'Running'],
            ['pending', 'Pending'],
            ['failed', 'Failed'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setStatus(id)}
            className={cn(
              'rounded-md px-2.5 py-1 text-[11px]',
              status === id ? 'bg-sunken text-ink font-medium' : 'text-ink-muted',
            )}
          >
            {label}
          </button>
        ))}
        <span className="bg-rule mx-1 hidden h-4 w-px sm:block" aria-hidden />
        <label className="text-ink-muted flex items-center gap-2 text-[11px]">
          Project
          <select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            className="border-rule bg-panel rounded-md border px-2 py-1 text-[12px] text-ink outline-none"
          >
            <option value="all">All projects</option>
            {projects.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="panel scroll-x overflow-hidden">
        <table className="ledger">
          <thead>
            <tr>
              <th>Project</th>
              <th>Source document</th>
              <th>State</th>
              <th className="text-right">Started</th>
              <th className="text-right">Finished</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.id}>
                <td className="min-w-[12rem]">
                  <Link
                    href={`/projects/${row.project_id}`}
                    className="hover:text-signal font-medium transition-colors"
                  >
                    {row.project_name}
                  </Link>
                </td>
                <td className="text-ink-muted min-w-[14rem]">
                  {row.filename ?? 'Whole project folder'}
                  {row.status === 'failed' && row.error ? (
                    <span className="text-alert mt-0.5 block text-[11px]">{row.error}</span>
                  ) : null}
                </td>
                <td>
                  <Marker tone={TONE[row.status]}>{row.status}</Marker>
                </td>
                <td className="num text-ink-muted">{stamp(row.created_at)}</td>
                <td className="num text-ink-muted">{stamp(row.finished_at)}</td>
                <td className="num">
                  {row.status === 'completed' ? (
                    <span className="inline-flex items-center gap-3">
                      <Link
                        href={`/projects/${row.project_id}/runs/${row.id}/review`}
                        className="bg-signal text-primary-foreground hover:bg-signal/90 rounded-md px-2 py-0.5 text-[11px] font-medium no-underline"
                      >
                        Review
                      </Link>
                      {row.output_path ? (
                        <a
                          href={`/api/runs/${row.id}/download`}
                          download
                          className="text-ink-muted hover:text-ink no-underline"
                        >
                          .xlsx
                        </a>
                      ) : null}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visible.length === 0 ? (
        <p className="text-ink-muted mt-3 text-center text-[12px]">No runs match these filters.</p>
      ) : null}
    </div>
  );
}
