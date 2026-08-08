import Link from 'next/link';
import { getShelfStats } from '@/lib/catalog';
import { listDocs, listSheets, planIndexReady } from '@/lib/sheets';
import { readActiveProject, readKnowledgeGraph } from '@/lib/graph';
import { query } from '@/lib/db';
import { Page, PageHeader, HeaderStat, Section } from '@/components/shell/page-header';
import { Figure, FigureRow, count, money } from '@/components/shell/figure';
import { Empty, Marker } from '@/components/shell/state';
import type { RunStatus } from '@/types/events';

export const dynamic = 'force-dynamic';

type RecentRun = {
  id: string;
  status: RunStatus;
  created_at: string;
  project_id: string;
  project_name: string;
  filename: string | null;
};

const TONE: Record<RunStatus, 'muted' | 'signal' | 'alert' | 'ink'> = {
  pending: 'muted',
  running: 'signal',
  completed: 'ink',
  failed: 'alert',
};

export default async function OverviewPage() {
  const active = await readActiveProject();
  const graph = await readKnowledgeGraph();
  const shelf = getShelfStats();

  const sheets = planIndexReady() ? listSheets() : [];
  const docs = planIndexReady() ? listDocs() : [];

  let runs: RecentRun[] = [];
  try {
    runs = await query<RecentRun>(
      `SELECT r.id, r.status, r.created_at::text, r.project_id,
              p.name AS project_name, f.filename
         FROM workflow_runs r
         JOIN projects p ON p.id = r.project_id
         LEFT JOIN files f ON f.id = r.file_id
        ORDER BY r.created_at DESC
        LIMIT 6`,
    );
  } catch {
    runs = [];
  }

  return (
    <Page>
      <PageHeader
        eyebrow="CBC commercial estimating"
        title={active?.projectName ?? 'No active project'}
        meta={
          active ? (
            <>
              <HeaderStat label="Phase" value={`${active.phaseCompleted} of 6`} />
              <HeaderStat label="State" value={active.projectState ?? '—'} />
              <HeaderStat label="Mode" value={active.mode ?? '—'} />
            </>
          ) : undefined
        }
      />

      {active?.pricing ? (
        <FigureRow className="mt-8">
          <Figure
            label="Division 08 doors"
            value={money(active.pricing.doors)}
            note={`${active.doorLines} openings`}
          />
          <Figure
            label="Division 10 accessories"
            value={money(active.pricing.accessories)}
            note={`${active.accessoryLines} items`}
          />
          <Figure
            label="Division 06 FRP"
            value={money(active.pricing.frp)}
            note={active.frpProvisional ? 'Provisional — Open Item 5' : undefined}
            tone={active.frpProvisional ? 'muted' : 'ink'}
          />
          <Figure
            label="Grand total"
            value={money(active.pricing.grandTotal)}
            note={`Freight ${active.pricing.freight.toLowerCase()}`}
            tone="signal"
          />
        </FigureRow>
      ) : (
        <Empty
          className="mt-8"
          title="No job record yet. Create a project and upload a bid set to start Phase 0."
          action={
            <Link href="/projects" className="t-label text-signal hover:text-ink transition-colors">
              Go to projects
            </Link>
          }
        />
      )}

      {active ? (
        <div className="grid gap-10 pt-10 md:grid-cols-2">
          <div>
            <h2 className="t-label border-rule mb-3 border-b pb-2">
              Open questions
              <span className="text-rule-strong ml-2 font-mono normal-case">
                {active.unresolvedRfis.length}
              </span>
            </h2>
            {active.unresolvedRfis.length ? (
              <ul className="space-y-2">
                {active.unresolvedRfis.map((rfi) => (
                  <li key={rfi} className="border-rule/70 border-b pb-2 text-[13px] leading-snug">
                    {rfi}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-muted text-[13px]">Nothing outstanding.</p>
            )}
          </div>

          <div>
            <h2 className="t-label border-rule mb-3 border-b pb-2">
              Awaiting vendor quote
              <span className="text-rule-strong ml-2 font-mono normal-case">
                {active.pendingRfqs.length}
              </span>
            </h2>
            {active.pendingRfqs.length ? (
              <ul className="space-y-2">
                {active.pendingRfqs.map((rfq) => (
                  <li key={rfq} className="border-rule/70 border-b pb-2 text-[13px] leading-snug">
                    {rfq}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-muted text-[13px]">Nothing outstanding.</p>
            )}
          </div>
        </div>
      ) : null}

      <Section
        label="Recent estimates"
        aside={
          <Link href="/downloads" className="hover:text-ink transition-colors">
            All downloads
          </Link>
        }
      >
        {runs.length ? (
          <table className="ledger">
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td className="min-w-[12rem]">
                    <Link
                      href={`/projects/${run.project_id}`}
                      className="hover:text-signal font-medium transition-colors"
                    >
                      {run.project_name}
                    </Link>
                  </td>
                  <td className="text-ink-muted">{run.filename ?? 'Whole project folder'}</td>
                  <td>
                    <Marker tone={TONE[run.status]}>{run.status}</Marker>
                  </td>
                  <td className="num text-ink-muted">
                    {new Date(run.created_at).toLocaleString('en-GB', {
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="No estimate runs yet." />
        )}
      </Section>

      <Section
        label="What the copilot can see"
        aside={
          <Link href="/shelf" className="hover:text-ink transition-colors">
            Open the shelf
          </Link>
        }
      >
        <FigureRow>
          <Figure
            label="Vendors on the shelf"
            value={count(shelf.vendorCount)}
            note={
              !shelf.ready
                ? 'Catalog index not built yet'
                : shelf.uncovered
                  ? `${shelf.uncovered} carry no parsed price rows`
                  : 'Every book has parsed rows'
            }
          />
          <Figure label="Price rows indexed" value={count(shelf.priceRows)} />
          <Figure
            label="Plan sheets"
            value={count(sheets.length)}
            note={`${docs.length} bid ${docs.length === 1 ? 'set' : 'sets'}`}
          />
          <Figure
            label="Graph nodes"
            value={count(graph?.nodes.length ?? 0)}
            note={graph ? `${graph.edges.length} relations` : 'No graph found'}
          />
        </FigureRow>
      </Section>

      <p className="text-ink-muted border-rule mt-10 border-t pt-4 text-[12px] leading-relaxed">
        Every output is a draft for estimator review. Nothing here is sent to a customer.
      </p>
    </Page>
  );
}
