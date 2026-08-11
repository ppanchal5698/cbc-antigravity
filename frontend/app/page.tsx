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

type AttentionRun = {
  id: string;
  status: RunStatus;
  created_at: string;
  project_id: string;
  project_name: string;
  filename: string | null;
  pending_lines: number;
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
  const [totals, attention] = await Promise.all([
    loadTotals().catch(() => EMPTY_TOTALS),
    query<AttentionRun>(
      `SELECT r.id, r.status, r.created_at::text, r.project_id,
              p.name AS project_name, f.filename,
              COALESCE((
                SELECT count(*)::int FROM quote_lines l
                  JOIN quote_drafts d ON d.id = l.draft_id
                 WHERE d.run_id = r.id
                   AND l.acceptance = 'pending'
                   AND l.deleted_at IS NULL
                   AND d.status = 'draft'
              ), 0) AS pending_lines
         FROM workflow_runs r
         JOIN projects p ON p.id = r.project_id
         LEFT JOIN files f ON f.id = r.file_id
        WHERE r.status IN ('pending', 'running', 'failed')
           OR (
             r.status = 'completed'
             AND EXISTS (
               SELECT 1 FROM quote_drafts d
                 JOIN quote_lines l ON l.draft_id = d.id
                WHERE d.run_id = r.id
                  AND d.status = 'draft'
                  AND l.acceptance = 'pending'
                  AND l.deleted_at IS NULL
             )
           )
        ORDER BY
          CASE r.status
            WHEN 'running' THEN 0
            WHEN 'pending' THEN 1
            WHEN 'failed' THEN 2
            ELSE 3
          END,
          r.created_at DESC
        LIMIT 12`,
    ).catch(() => [] as AttentionRun[]),
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
        eyebrow="Resume desk"
        title="Overview"
        meta={
          <>
            <HeaderStat label="In flight" value={totals.running ? count(totals.running) : '—'} />
            <HeaderStat
              label="Awaiting review"
              value={totals.awaiting_review ? count(totals.awaiting_review) : '—'}
            />
            <HeaderStat label="Projects" value={count(totals.projects)} />
          </>
        }
        actions={
          <Link
            href="/projects"
            className="bg-signal text-primary-foreground hover:bg-signal/90 rounded-md px-3 py-1.5 text-[12px] font-medium no-underline transition-colors"
          >
            Open projects
          </Link>
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
        <>
          <Section
            label="Needs attention"
            panel
            aside={
              <Link href="/downloads" className="hover:text-ink transition-colors">
                All downloads
              </Link>
            }
          >
            {attention.length ? (
              <div className="scroll-x">
                <table className="ledger">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Document</th>
                      <th>State</th>
                      <th className="text-right">When</th>
                      <th className="text-right">Next</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attention.map((run) => (
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
                          <span className="flex flex-wrap items-center gap-1.5">
                            <Marker tone={TONE[run.status]}>{run.status}</Marker>
                            {run.pending_lines > 0 ? (
                              <Marker tone="alert">{run.pending_lines} pending</Marker>
                            ) : null}
                          </span>
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
                              className="bg-signal text-primary-foreground hover:bg-signal/90 inline-block rounded-md px-2 py-0.5 text-[11px] font-medium no-underline"
                            >
                              Review
                            </Link>
                          ) : run.status === 'failed' ? (
                            <Link
                              href={`/projects/${run.project_id}`}
                              className="text-alert hover:text-ink text-[12px] font-medium no-underline"
                            >
                              Open project
                            </Link>
                          ) : (
                            <Link
                              href={`/projects/${run.project_id}`}
                              className="text-signal hover:text-ink text-[12px] font-medium no-underline"
                            >
                              Watch
                            </Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-6">
                <Empty title="Nothing waiting. Start a new estimate from a project." />
              </div>
            )}
          </Section>

          <Section label="Desk totals">
            <FigureRow>
              <Figure
                label="Bid documents"
                value={count(totals.files)}
                note={`across ${totals.projects} ${totals.projects === 1 ? 'project' : 'projects'}`}
              />
              <Figure
                label="Estimates completed"
                value={count(totals.completed)}
                note={totals.failed ? `${totals.failed} failed` : 'settled runs'}
                tone={totals.failed ? 'alert' : 'ink'}
              />
              <Figure
                label="Lines awaiting review"
                value={count(totals.awaiting_review)}
                note={`${totals.drafts} drafts · ${totals.approved} approved`}
                tone={totals.awaiting_review ? 'alert' : 'ink'}
              />
              <Figure
                label="Quoted (active lines)"
                value={money(totals.quoted ?? 0)}
                note="draft total, before tax and freight"
                tone="signal"
              />
            </FigureRow>
          </Section>
        </>
      )}

      <Section
        label="Reference health"
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

      {active ? (
        <Section
          label="Agent job record"
          aside={
            active.gateGapsAtPhase6.length
              ? `Phase ${active.phaseCompleted} of 6 — claimed`
              : `Phase ${active.phaseCompleted} of 6`
          }
        >
          {/* The phase is a number the agent wrote. Where its exit gate leaves artifacts
              behind, we can check, and the record has been wrong: it claimed Phase 6 with
              nothing archived and no learning pass run. Say so next to the claim. */}
          {active.gateGapsAtPhase6.length ? (
            <div className="panel border-alert/40 mb-3 p-4">
              <p className="text-[13px] font-medium">
                This record claims Phase {active.phaseCompleted}, but the Phase 6 exit gate is
                not met:
              </p>
              <ul className="text-ink-muted mt-2 list-disc space-y-1 pl-5 text-[12px]">
                {active.gateGapsAtPhase6.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
              <p className="text-ink-muted mt-2 text-[12px]">
                The subtotals below may still be correct — what did not happen is the archive
                and the learning pass that close the phase.
              </p>
            </div>
          ) : null}
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
              <FigureRow className="border-0 pt-4 shadow-none">
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
