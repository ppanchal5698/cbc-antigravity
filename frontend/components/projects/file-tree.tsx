'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import type { TreeEntry } from '@/app/api/projects/[id]/tree/route';
import { FilePreviewModal } from '@/components/projects/file-preview-modal';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Empty, LoadingRows } from '@/components/shell/state';
import {
  projectFilePreview,
  runOutputPreview,
  type FilePreviewTarget,
} from '@/lib/file-preview';
import { cn } from '@/lib/utils';
import type { ProjectFile } from '@/types/events';

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('en-GB', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
}

const btn =
  'cursor-pointer rounded-md border border-rule bg-panel px-2 py-0.5 text-[11px] font-medium transition-colors hover:border-signal hover:text-signal disabled:opacity-40';
const danger =
  'cursor-pointer rounded-md border border-rule bg-panel px-2 py-0.5 text-[11px] font-medium text-alert transition-colors hover:border-alert disabled:opacity-40';

/** The project folder as it exists on disk - the same tree the agent reads. */
export function FileTree({
  projectId,
  entries,
  files,
  outputPaths,
  outputRunIds,
  onChanged,
}: {
  projectId: string;
  entries: TreeEntry[] | null;
  files: ProjectFile[];
  /** Generated estimates, marked so they are not mistaken for inputs. */
  outputPaths: Set<string>;
  /** Basename of a generated .xlsx → completed run id (for preview/download). */
  outputRunIds: Map<string, string>;
  onChanged: () => void;
}) {
  const byName = new Map(files.map((file) => [file.filename, file]));
  const [preview, setPreview] = useState<FilePreviewTarget | null>(null);
  const [renameFile, setRenameFile] = useState<ProjectFile | null>(null);
  const [deleteFile, setDeleteFile] = useState<ProjectFile | null>(null);
  const [nextName, setNextName] = useState('');
  const [busy, setBusy] = useState(false);

  const rename = async () => {
    if (!renameFile || busy) return;
    const trimmed = nextName.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/files/${renameFile.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: trimmed }),
      });
      const body = (await response.json()) as { file?: ProjectFile; error?: string };
      if (!response.ok || !body.file) throw new Error(body.error || 'Could not rename');
      setRenameFile(null);
      toast.success('File renamed', { description: body.file.filename });
      onChanged();
    } catch (err) {
      toast.error('Could not rename file', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleteFile || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/files/${deleteFile.id}`, {
        method: 'DELETE',
      });
      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok) throw new Error(body.error || 'Could not delete');
      toast.success('File deleted', { description: deleteFile.filename });
      setDeleteFile(null);
      onChanged();
    } catch (err) {
      toast.error('Could not delete file', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  if (entries === null) return <LoadingRows rows={4} />;
  if (!entries.length) {
    return <Empty title="This folder is empty. Upload a bid set to start an estimate." />;
  }

  return (
    <>
      <div className="scroll-x">
        <table className="ledger">
          <thead>
            <tr>
              <th>Name</th>
              <th className="text-right">Size</th>
              <th className="text-right">Modified</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const output = outputPaths.has(entry.name);
              const tracked = entry.kind === 'file' ? byName.get(entry.name) : undefined;
              const outputRunId =
                entry.kind === 'file' ? outputRunIds.get(entry.name) : undefined;
              const openPreview = () => {
                if (tracked) {
                  setPreview(projectFilePreview(projectId, tracked));
                  return;
                }
                if (outputRunId) {
                  setPreview(runOutputPreview(outputRunId, entry.name));
                }
              };
              const canPreview = Boolean(tracked || outputRunId);
              return (
                <tr key={entry.path}>
                  <td>
                    <span
                      className="inline-flex items-baseline gap-2"
                      style={{ paddingLeft: `${entry.depth * 16}px` }}
                    >
                      <span
                        className={cn(
                          'font-mono text-[11px]',
                          entry.kind === 'directory' ? 'text-signal' : 'text-rule-strong',
                        )}
                        aria-hidden
                      >
                        {entry.kind === 'directory' ? '▸' : '·'}
                      </span>
                      {canPreview ? (
                        <button
                          type="button"
                          className="hover:text-signal cursor-pointer text-left text-[13px] underline-offset-2 hover:underline"
                          onClick={openPreview}
                        >
                          {entry.name}
                        </button>
                      ) : (
                        <span
                          className={cn('text-[13px]', entry.kind === 'directory' && 'font-medium')}
                        >
                          {entry.name}
                        </span>
                      )}
                      {output ? <span className="t-label text-signal">Generated</span> : null}
                    </span>
                  </td>
                  <td className="num text-ink-muted">
                    {entry.kind === 'directory' ? '—' : bytes(entry.size)}
                  </td>
                  <td className="num text-ink-muted">{when(entry.modified)}</td>
                  <td className="text-right">
                    {tracked ? (
                      <div className="inline-flex items-center justify-end gap-1.5">
                        <a
                          href={`/api/projects/${projectId}/files/${tracked.id}/download`}
                          className={btn}
                        >
                          Download
                        </a>
                        <button
                          type="button"
                          className={btn}
                          onClick={() => {
                            setNextName(tracked.filename);
                            setRenameFile(tracked);
                          }}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className={danger}
                          onClick={() => setDeleteFile(tracked)}
                        >
                          Delete
                        </button>
                      </div>
                    ) : outputRunId ? (
                      <div className="inline-flex items-center justify-end gap-1.5">
                        <a href={`/api/runs/${outputRunId}/download`} className={btn}>
                          Download
                        </a>
                      </div>
                    ) : (
                      <span className="text-ink-muted text-[11px]">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <FilePreviewModal target={preview} onClose={() => setPreview(null)} />

      <Dialog
        open={Boolean(renameFile)}
        onOpenChange={(open) => {
          if (!open) setRenameFile(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename file</DialogTitle>
            <DialogDescription>
              Renames the file on disk and in the project record.
            </DialogDescription>
          </DialogHeader>
          <input
            value={nextName}
            onChange={(e) => setNextName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void rename();
            }}
            aria-label="Filename"
            className="border-rule bg-panel focus:border-signal w-full rounded-md border px-2.5 py-1.5 text-[13px] outline-none"
            autoFocus
          />
          <DialogFooter>
            <button
              type="button"
              className={btn}
              disabled={busy}
              onClick={() => setRenameFile(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="bg-signal text-primary-foreground hover:bg-signal/90 cursor-pointer rounded-md px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
              disabled={
                !nextName.trim() ||
                busy ||
                nextName.trim() === renameFile?.filename
              }
              onClick={() => void rename()}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteFile)}
        onOpenChange={(open) => {
          if (!open) setDeleteFile(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete file</DialogTitle>
            <DialogDescription>
              Permanently deletes{' '}
              <span className="font-medium text-foreground">{deleteFile?.filename}</span> from
              the project and from disk.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              className={btn}
              disabled={busy}
              onClick={() => setDeleteFile(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="bg-destructive/15 text-destructive hover:bg-destructive/25 cursor-pointer rounded-md px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? 'Deleting…' : 'Delete permanently'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
