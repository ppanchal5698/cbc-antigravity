import { query } from '@/lib/db';
import { catalogIndexReady, listVendors } from '@/lib/catalog';
import { ScopedChat } from '@/components/chat/scoped-chat';
import { CreateProject } from '@/components/projects/create-project';
import { ProjectList, type ProjectListRow } from '@/components/projects/project-list';
import { Page, PageHeader, HeaderStat } from '@/components/shell/page-header';
import { count } from '@/components/shell/figure';
import { Empty, Failure } from '@/components/shell/state';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  let rows: ProjectListRow[] = [];
  let failure: string | null = null;

  try {
    rows = await query<ProjectListRow>(
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

  const vendorFolders = catalogIndexReady()
    ? listVendors().map((vendor) => vendor.folder)
    : [];

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
        <ProjectList rows={rows} />
      )}

      <ScopedChat scope="general" vendorFolders={vendorFolders} />
    </Page>
  );
}
