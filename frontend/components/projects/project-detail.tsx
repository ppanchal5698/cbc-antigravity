'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { TreeEntry } from '@/app/api/projects/[id]/tree/route';
import { FileTree } from '@/components/projects/file-tree';
import { RunRow, type RunSummary } from '@/components/projects/run-row';
import { UploadDrop } from '@/components/projects/upload-drop';
import { Section } from '@/components/shell/page-header';
import { Empty } from '@/components/shell/state';
import type { ProjectFile } from '@/types/events';

export function ProjectDetail({ projectId }: { projectId: string }) {
  const [entries, setEntries] = useState<TreeEntry[] | null>(null);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);

  const load = useCallback(async () => {
    try {
      const [treeResponse, filesResponse] = await Promise.all([
        fetch(`/api/projects/${projectId}/tree`),
        fetch(`/api/projects/${projectId}/files`),
      ]);
      if (treeResponse.ok) {
        const body = (await treeResponse.json()) as { entries: TreeEntry[] };
        setEntries(body.entries);
      } else {
        setEntries([]);
      }
      if (filesResponse.ok) {
        const body = (await filesResponse.json()) as {
          files: ProjectFile[];
          runs: RunSummary[];
        };
        setFiles(body.files);
        setRuns(body.runs);
      }
    } catch (err) {
      setEntries([]);
      toast.error('Could not read the project folder', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (!cancelled) await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const outputs = new Set(
    runs
      .map((run) => run.output_path)
      .filter((path): path is string => Boolean(path))
      .map((path) => path.split(/[\\/]/).pop() ?? path),
  );

  const outputRunIds = new Map<string, string>();
  for (const run of runs) {
    if (run.status !== 'completed' || !run.output_path) continue;
    const name = run.output_path.split(/[\\/]/).pop() ?? run.output_path;
    outputRunIds.set(name, run.id);
  }

  const filenameFor = (run: RunSummary): string =>
    files.find((file) => file.id === run.file_id)?.filename ?? 'Whole project folder';

  const ready = runs.filter((r) => r.status === 'completed');
  const active = runs.filter((r) => r.status === 'pending' || r.status === 'running');

  return (
    <>
      <Section
        label="1 · Upload"
        aside={files.length === 0 ? 'Start here' : undefined}
      >
        <UploadDrop projectId={projectId} onUploaded={() => void load()} />
      </Section>

      <Section
        label="2 · Estimates"
        panel
        aside={
          ready.length
            ? `${ready.length} ready for review`
            : active.length
              ? `${active.length} in flight`
              : runs.length
                ? `${runs.length} runs`
                : undefined
        }
      >
        {runs.length ? (
          <div>
            {runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                filename={filenameFor(run)}
                projectId={projectId}
                onSettled={() => void load()}
              />
            ))}
          </div>
        ) : (
          <div className="p-6">
            <Empty title="No estimates yet. Upload a bid set and one starts automatically." />
          </div>
        )}
      </Section>

      <Section label="3 · Folder" panel aside="plans/…">
        <div className="p-3">
          <FileTree
            projectId={projectId}
            entries={entries}
            files={files}
            outputPaths={outputs}
            outputRunIds={outputRunIds}
            onChanged={() => void load()}
          />
        </div>
      </Section>
    </>
  );
}
