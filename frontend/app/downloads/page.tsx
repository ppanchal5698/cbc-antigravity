import Link from 'next/link';
import { query } from '@/lib/db';
import { Page, PageHeader, HeaderStat } from '@/components/shell/page-header';
import { count } from '@/components/shell/figure';
import { Empty, Failure, Marker } from '@/components/shell/state';
import type { RunStatus } from '@/types/events';

export const dynamic = 'force-dynamic';

type Row = {
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

export default async function DownloadsPage() {
  let rows: Row[] = [];
  let failure: string | null = null;

  try {
    rows = await query<Row>(
      `SELECT r.id, r.status, r.output_path, r.error, r.created_at::text, r.finished_at::text,
              r.project_id,
              p.name AS project_name, p.slug,
              f.filename
         FROM workflow_runs r
         JOIN projects p ON p.id = r.project_id
         LEFT JOIN files f ON f.id = r.file_id
        ORDER BY r.created_at DESC
        LIMIT 200`,
    );
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  const ready = rows.filter((row) => row.status === 'completed' && row.output_path);

  return (
    <Page>
      <PageHeader
        eyebrow="Generated estimates"
        title="Downloads"
        meta={
          <>
            <HeaderStat label="Ready" value={count(ready.length)} />
            <HeaderStat label="Runs" value={count(rows.length)} />
          </>
        }
      />

      <p className="text-ink-muted max-w-prose pb-5 text-[13px] leading-relaxed">
        Review lines in the app first. Download exports the approved (or current draft) workbook —
        same fixed CBC template, values only change.
      </p>

      {failure ? (
        <Failure title="Could not reach the database." detail={failure} />
      ) : rows.length === 0 ? (
        <Empty title="No estimates yet. Upload a bid set to a project and one starts automatically." />
      ) : (
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
              {rows.map((row) => (
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
                          className="text-signal hover:text-ink font-medium no-underline"
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
      )}
    </Page>
  );
}
