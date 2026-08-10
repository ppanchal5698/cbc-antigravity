'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Project } from '@/types/events';

type Props = {
  projectId: string;
  name: string;
  /** After delete, navigate here (defaults to staying and refreshing). */
  afterDeleteHref?: string;
  compact?: boolean;
};

export function ProjectActions({ projectId, name, afterDeleteHref, compact }: Props) {
  const router = useRouter();
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [nextName, setNextName] = useState(name);
  const [busy, setBusy] = useState(false);

  const rename = async () => {
    const trimmed = nextName.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const body = (await response.json()) as { project?: Project; error?: string };
      if (!response.ok || !body.project) throw new Error(body.error || 'Could not rename');
      setRenameOpen(false);
      toast.success('Project renamed', { description: body.project.name });
      router.refresh();
    } catch (err) {
      toast.error('Could not rename project', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok) throw new Error(body.error || 'Could not delete');
      setDeleteOpen(false);
      toast.success('Project deleted', { description: name });
      if (afterDeleteHref) router.push(afterDeleteHref);
      router.refresh();
    } catch (err) {
      toast.error('Could not delete project', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const btn =
    'cursor-pointer rounded-md border border-rule bg-panel px-2.5 py-1 text-[12px] font-medium transition-colors hover:border-signal hover:text-signal disabled:opacity-40';
  const danger =
    'cursor-pointer rounded-md border border-rule bg-panel px-2.5 py-1 text-[12px] font-medium text-alert transition-colors hover:border-alert disabled:opacity-40';

  return (
    <>
      <div className={compact ? 'flex items-center gap-1.5' : 'flex items-center gap-2'}>
        <button
          type="button"
          className={btn}
          onClick={() => {
            setNextName(name);
            setRenameOpen(true);
          }}
        >
          Rename
        </button>
        <button type="button" className={danger} onClick={() => setDeleteOpen(true)}>
          Delete
        </button>
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
            <DialogDescription>
              Changes the display name only. The folder under plans/ stays the same.
            </DialogDescription>
          </DialogHeader>
          <input
            value={nextName}
            onChange={(e) => setNextName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void rename();
            }}
            aria-label="Project name"
            className="border-rule bg-panel focus:border-signal w-full rounded-md border px-2.5 py-1.5 text-[13px] outline-none"
            autoFocus
          />
          <DialogFooter>
            <button
              type="button"
              className={btn}
              disabled={busy}
              onClick={() => setRenameOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="bg-signal text-primary-foreground hover:bg-signal/90 cursor-pointer rounded-md px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
              disabled={!nextName.trim() || busy || nextName.trim() === name}
              onClick={() => void rename()}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete project</DialogTitle>
            <DialogDescription>
              Permanently deletes <span className="font-medium text-foreground">{name}</span>,
              its uploaded files, estimate runs, and the folder on disk. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              className={btn}
              disabled={busy}
              onClick={() => setDeleteOpen(false)}
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
