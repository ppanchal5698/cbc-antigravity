import Link from 'next/link';
import { query } from '@/lib/db';
import { CreateProject } from '@/components/projects/create-project';
import { Page, PageHeader, HeaderStat } from '@/components/shell/page-header';
import { count } from '@/components/shell/figure';
import { Empty, Failure, Marker } from '@/components/shell/state';
import type { Project, RunStatus } from '@/types/events';

export const dynamic = 'force-dynamic';

type Row = Project & {
  file_count: number;
  run_count: number;
  completed: number;
  failed: number;
  running: number;
  last_run: string | null;
};

export default async function ProjectsPage() {
  let rows: Row[] = [];
  let failure: string | null = null;

  try {
    rows = await query<Row>(
      `SELECT p.*,
              (SELECT COUNT(*) FROM files f WHERE f.project_id = p.id)::int AS file_count,
              (SELECT COUNT(*) FROM workflow_runs r WHERE r.project_id = p.id)::int AS run_count,
              (SELECT COUNT(*) FROM workflow_runs r WHERE r.project_id = p.id AND r.status = 'completed')::int AS completed,
              (SELECT COUNT(*) FROM workflow_runs r WHERE r.project_id = p.id AND r.status = 'failed')::int AS failed,
              (SELECT COUNT(*) FROM workflow_runs r WHERE r.project_id = p.id AND r.status IN ('pending','running'))::int AS running,
              (SELECT MAX(r.created_at)::text FROM workflow_runs r WHERE r.project_id = p.id) AS last_run
         FROM projects p
        ORDER BY p.created_at DESC`,
    );
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  return (
    <Page>
      <PageHeader
        eyebrow="Bid sets and estimate runs"
        title="Projects"
        meta={<HeaderStat label="Projects" value={count(rows.length)} />}
        actions={<CreateProject />}
      />

      {failure ? (
        <Failure
          className="mt-6"
          title="Could not reach the database."
          detail={failure}
        />
      ) : rows.length === 0 ? (
        <Empty
          className="mt-6"
          title="No projects yet. Name one above and a folder is created under plans/."
        />
      ) : (
        <div className="border-rule scroll-x mt-6 border-t">
          <table className="ledger">
            <thead>
              <tr>
                <th>Project</th>
                <th>Folder</th>
                <th className="text-right">Files</th>
                <th className="text-right">Runs</th>
                <th>State</th>
                <th className="text-right">Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((project) => (
                <tr key={project.id}>
                  <td className="min-w-[14rem]">
                    <Link
                      href={`/projects/${project.id}`}
                      className="hover:text-signal text-[14px] font-medium transition-colors"
                    >
                      {project.name}
                    </Link>
                  </td>
                  <td className="code text-ink-muted">plans/{project.slug}</td>
                  <td className="num">{count(project.file_count)}</td>
                  <td className="num">{count(project.run_count)}</td>
                  <td>
                    <span className="flex flex-wrap gap-1.5">
                      {project.running > 0 ? (
                        <Marker tone="signal">{project.running} running</Marker>
                      ) : null}
                      {project.completed > 0 ? (
                        <Marker tone="ink">{project.completed} complete</Marker>
                      ) : null}
                      {project.failed > 0 ? (
                        <Marker tone="alert">{project.failed} failed</Marker>
                      ) : null}
                      {project.run_count === 0 ? <Marker>No runs</Marker> : null}
                    </span>
                  </td>
                  <td className="num text-ink-muted">
                    {new Date(project.created_at).toLocaleDateString('en-GB')}
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

export type { RunStatus };
