import Link from 'next/link';
import { getShelfStats } from '@/lib/catalog';
import { countSheets, listDocs, planIndexReady } from '@/lib/sheets';
import { readActiveProject, readKnowledgeGraph } from '@/lib/graph';
import { query } from '@/lib/db';
import { ScopedChat } from '@/components/chat/scoped-chat';
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

type Totals = {
  projects: number;
  files: number;
  runs: number;
  running: number;
  failed: number;
  completed: number;
  drafts: number;
  awaiting_review: number;
  approved: number;
  quoted: number | null;
};

const TONE: Record<RunStatus, 'muted' | 'signal' | 'alert' | 'ink'> = {
  pending: 'muted',
  running: 'signal',
  completed: 'ink',
  failed: 'alert',
};

const EMPTY_TOTALS: Totals = {
  projects: 0, files: 0, runs: 0, running: 0, failed: 0, completed: 0,
  drafts: 0, awaiting_review: 0, approved: 0, quoted: null,
};

/**
 * Everything the overview counts, from the database rather than from a file.
 *
 * The headline figures used to come from `memory/active_project.json` - a record the
 * agent writes during a run - so the dashboard showed whatever the last estimate left
 * behind and never moved when a project or a file was added. These are the real rows.
 */
async function loadTotals(): Promise<Totals> {
  const rows = await query<Totals>(
    `SELECT
       (SELECT count(*) FROM projects)::int                                        AS projects,
       (SELECT count(*) FROM files)::int                                           AS files,
       (SELECT count(*) FROM workflow_runs)::int                                   AS runs,
       (SELECT count(*) FROM workflow_runs
         WHERE status IN ('pending','running'))::int                               AS running,
       (SELECT count(*) FROM workflow_runs WHERE status = 'failed')::int           AS failed,
       (SELECT count(*) FROM workflow_runs WHERE status = 'completed')::int        AS completed,
       (SELECT count(*) FROM quote_drafts)::int                                    AS drafts,
       (SELECT count(*) FROM quote_lines l
          JOIN quote_drafts d ON d.id = l.draft_id
         WHERE l.acceptance = 'pending' AND l.deleted_at IS NULL
           AND d.status = 'draft')::int                                            AS awaiting_review,
       (SELECT count(*) FROM quote_drafts WHERE status = 'approved')::int          AS approved,
       (SELECT COALESCE(sum(l.qty * l.unit_sale), 0) FROM quote_lines l
          JOIN quote_drafts d ON d.id = l.draft_id
         WHERE l.deleted_at IS NULL AND l.acceptance <> 'rejected')                AS quoted`,
  );
  return rows[0] ?? EMPTY_TOTALS;
}

export default async function OverviewPage() {
  const [totals, runs] = await Promise.all([
    loadTotals().catch(() => EMPTY_TOTALS),
    query<RecentRun>(
      `SELECT r.id, r.status, r.created_at::text, r.project_id,
              p.name AS project_name, f.filename
         FROM workflow_runs r
         JOIN projects p ON p.id = r.project_id
         LEFT JOIN files f ON f.id = r.file_id
        ORDER BY r.created_at DESC
        LIMIT 8`,
    ).catch(() => [] as RecentRun[]),
  ]);

  const active = await readActiveProject();
  const graph = await readKnowledgeGraph();
  const shelf = getShelfStats();
  const sheetCount = planIndexReady() ? countSheets() : 0;
  const docs = planIndexReady() ? listDocs() : [];

  const nothingYet = totals.projects === 0;

  return (
    <Page>
      <PageHeader
        eyebrow="CBC commercial estimating"
        title="Overview"
        meta={
          <>
            <HeaderStat label="Projects" value={count(totals.projects)} />
            <HeaderStat label="Runs" value={count(totals.runs)} />
            <HeaderStat
              label="In flight"
              value={totals.running ? count(totals.running) : '—'}
            />
          </>
        }
      />

      {nothingYet ? (
        <Empty
          className="mt-2"
          title="No projects yet. Create one and upload a bid set — the estimate starts as soon as the upload finishes."
          action={
            <Link
              href="/projects"
              className="bg-signal text-primary-foreground hover:bg-signal/90 rounded-md px-3 py-1.5 text-[12px] font-medium no-underline transition-colors"
            >
              Create a project
            </Link>
          }
        />
      ) : (
        <FigureRow className="mt-2">
          <Figure
            label="Bid documents"
            value={count(totals.files)}
            note={`across ${totals.projects} ${totals.projects === 1 ? 'project' : 'projects'}`}
          />
          <Figure
            label="Estimates run"
            value={count(totals.completed)}
            note={
              totals.failed
                ? `${totals.failed} failed`
                : totals.running
                  ? `${totals.running} in flight`
                  : 'all settled'
            }
            tone={totals.failed ? 'alert' : 'ink'}
          />
          <Figure
            label="Lines awaiting review"
            value={count(totals.awaiting_review)}
            note={`${totals.drafts} ${totals.drafts === 1 ? 'draft' : 'drafts'}, ${totals.approved} approved`}
            tone={totals.awaiting_review ? 'alert' : 'ink'}
          />
          <Figure
            label="Quoted (active lines)"
            value={money(totals.quoted ?? 0)}
            note="draft total, before tax and freight"
            tone="signal"
          />
        </FigureRow>
      )}

      <Section
        label="Recent estimates"
        panel
        aside={
          <Link href="/downloads" className="hover:text-ink transition-colors">
            All downloads
          </Link>
        }
      >
        {runs.length ? (
          <div className="scroll-x">
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
                    <td className="num">
                      {run.status === 'completed' ? (
                        <Link
                          href={`/projects/${run.project_id}/runs/${run.id}/review`}
                          className="text-signal hover:text-ink font-medium no-underline"
                        >
                          Review
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-6">
            <Empty title="No estimate runs yet." />
          </div>
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
            tone={shelf.uncovered ? 'muted' : 'ink'}
          />
          <Figure label="Price rows indexed" value={count(shelf.priceRows)} />
          <Figure
            label="Plan sheets"
            value={count(sheetCount)}
            note={
              docs.length
                ? `${docs.length} bid ${docs.length === 1 ? 'set' : 'sets'}`
                : 'No plan set indexed'
            }
          />
          <Figure
            label="Graph nodes"
            value={count(graph?.nodes.length ?? 0)}
            note={graph ? `${graph.edges.length} relations` : 'No graph found'}
          />
        </FigureRow>
      </Section>

      {/* The agent's own job record, kept but clearly separated from the live counts
          above - it reflects the last run the agent wrote, not the current database. */}
      {active ? (
        <Section label="Agent job record" aside={`Phase ${active.phaseCompleted} of 6`}>
          <div className="panel p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
              <p className="text-[15px] font-medium">{active.projectName}</p>
              <p className="text-ink-muted text-[12px]">
                Written by the last estimate run
                {active.lastUpdated
                  ? ` · ${new Date(active.lastUpdated).toLocaleDateString('en-GB')}`
                  : ''}
              </p>
            </div>
            {active.pricing ? (
              <FigureRow className="pt-4">
                <Figure label="Division 08" value={money(active.pricing.doors)} />
                <Figure label="Division 10" value={money(active.pricing.accessories)} />
                <Figure
                  label="Division 06"
                  value={money(active.pricing.frp)}
                  note={active.frpProvisional ? 'Provisional' : undefined}
                  tone={active.frpProvisional ? 'muted' : 'ink'}
                />
                <Figure label="Grand total" value={money(active.pricing.grandTotal)} />
              </FigureRow>
            ) : null}
            {active.unresolvedRfis.length || active.pendingRfqs.length ? (
              <div className="grid gap-4 pt-5 md:grid-cols-2">
                <OpenList title="Open questions" items={active.unresolvedRfis} />
                <OpenList title="Awaiting vendor quote" items={active.pendingRfqs} />
              </div>
            ) : null}
          </div>
        </Section>
      ) : null}

      <p className="text-ink-muted mt-10 text-[12px] leading-relaxed">
        Every output is a draft for estimator review. Nothing here is sent to a customer.
      </p>

      <ScopedChat scope="general" vendorFolders={shelf.vendors.map((v) => v.folder)} />
    </Page>
  );
}

function OpenList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3 className="mb-2 flex items-baseline gap-2 text-[13px] font-semibold">
        {title}
        <span className="text-ink-muted font-mono text-[12px] font-normal">{items.length}</span>
      </h3>
      {items.length ? (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item}
              className="border-rule/70 border-b pb-2 text-[13px] leading-snug last:border-0"
            >
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-muted text-[13px]">Nothing outstanding.</p>
      )}
    </div>
  );
}
