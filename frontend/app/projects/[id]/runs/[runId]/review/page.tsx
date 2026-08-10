import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { catalogIndexReady, listVendors } from '@/lib/catalog';
import { ReviewWorkspace } from '@/components/review/review-workspace';
import type { Project } from '@/types/events';

export const dynamic = 'force-dynamic';

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id, runId } = await params;

  let project: Project | undefined;
  try {
    const rows = await query<Project>('SELECT * FROM projects WHERE id = $1', [id]);
    project = rows[0];
  } catch {
    project = undefined;
  }
  if (!project) notFound();

  const runs = await query<{ id: string; project_id: string }>(
    'SELECT id, project_id FROM workflow_runs WHERE id = $1 AND project_id = $2',
    [runId, id],
  );
  if (!runs[0]) notFound();

  const vendorFolders = catalogIndexReady()
    ? listVendors().map((vendor) => vendor.folder)
    : [];

  return (
    <ReviewWorkspace
      projectId={project.id}
      runId={runId}
      projectName={project.name}
      vendorFolders={vendorFolders}
    />
  );
}
