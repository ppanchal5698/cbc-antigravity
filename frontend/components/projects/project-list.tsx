'use client';

import Link from 'next/link';
import { ProjectActions } from '@/components/projects/project-actions';
import { count } from '@/components/shell/figure';
import { Marker } from '@/components/shell/state';
import type { Project } from '@/types/events';

export type ProjectListRow = Project & {
  file_count: number;
  run_count: number;
  completed: number;
  failed: number;
  running: number;
  last_run: string | null;
};

export function ProjectList({ rows }: { rows: ProjectListRow[] }) {
  return (
    <div className="panel scroll-x mt-4 overflow-hidden">
      <table className="ledger">
        <thead>
          <tr>
            <th>Project</th>
            <th>Folder</th>
            <th className="text-right">Files</th>
            <th className="text-right">Runs</th>
            <th>State</th>
            <th className="text-right">Updated</th>
            <th className="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((project) => {
            const updated = project.last_run ?? project.created_at;
            return (
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
                  {new Date(updated).toLocaleDateString('en-GB')}
                </td>
                <td className="text-right">
                  <div className="inline-flex justify-end">
                    <ProjectActions projectId={project.id} name={project.name} compact />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
