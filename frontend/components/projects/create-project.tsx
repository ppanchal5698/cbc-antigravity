'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { Project } from '@/types/events';

export function CreateProject() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const body = (await response.json()) as { project?: Project; error?: string };
      if (!response.ok || !body.project) throw new Error(body.error || 'Could not create project');
      setName('');
      toast.success(`Created ${body.project.name}`, {
        description: `Folder: plans/${body.project.slug}`,
      });
      router.push(`/projects/${body.project.id}`);
      router.refresh();
    } catch (err) {
      toast.error('Could not create project', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-end gap-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void create();
        }}
        placeholder="New project name"
        aria-label="New project name"
        className="border-rule bg-panel focus:border-signal placeholder:text-ink-muted w-56 rounded-md border px-2.5 py-1.5 text-[13px] outline-none"
      />
      <button
        type="button"
        onClick={() => void create()}
        disabled={!name.trim() || busy}
        className="bg-signal text-primary-foreground hover:bg-signal/90 cursor-pointer rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
      >
        {busy ? 'Creating…' : 'Create'}
      </button>
    </div>
  );
}
