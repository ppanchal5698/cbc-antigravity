import Link from 'next/link';
import { notFound } from 'next/navigation';
import { query } from '@/lib/db';
import { catalogIndexReady, listVendors } from '@/lib/catalog';
import { ScopedChat } from '@/components/chat/scoped-chat';
import { ProjectDetail } from '@/components/projects/project-detail';
import { Page, PageHeader, HeaderStat } from '@/components/shell/page-header';
import type { Project } from '@/types/events';

export const dynamic = 'force-dynamic';

export default async function ProjectPage({ params }: PageProps<'/projects/[id]'>) {
  const { id } = await params;

  let project: Project | undefined;
  try {
    const rows = await query<Project>('SELECT * FROM projects WHERE id = $1', [id]);
    project = rows[0];
  } catch {
    project = undefined;
  }
  if (!project) notFound();

  const vendorFolders = catalogIndexReady()
    ? listVendors().map((vendor) => vendor.folder)
    : [];

  return (
    <Page>
      <PageHeader
        eyebrow={
          <Link href="/projects" className="hover:text-ink transition-colors">
            Projects
          </Link>
        }
        title={project.name}
        meta={
          <>
            <HeaderStat label="Folder" value={`plans/${project.slug}`} />
            <HeaderStat
              label="Created"
              value={new Date(project.created_at).toLocaleDateString('en-GB')}
            />
          </>
        }
      />
      <ProjectDetail projectId={project.id} />
      <ScopedChat
        scope="project"
        vendorFolders={vendorFolders}
        context={{
          projectId: project.id,
          projectName: project.name,
          projectFolder: project.folder_path,
        }}
      />
    </Page>
  );
}
