import { query } from '@/lib/db';
import {
  DownloadsLedger,
  type DownloadRow,
} from '@/components/downloads/downloads-ledger';
import { Page, PageHeader, HeaderStat } from '@/components/shell/page-header';
import { count } from '@/components/shell/figure';
import { Empty, Failure } from '@/components/shell/state';

export const dynamic = 'force-dynamic';

export default async function DownloadsPage() {
  let rows: DownloadRow[] = [];
  let failure: string | null = null;

  try {
    rows = await query<DownloadRow>(
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
        eyebrow="Export shelf"
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
        <DownloadsLedger rows={rows} />
      )}
    </Page>
  );
}
