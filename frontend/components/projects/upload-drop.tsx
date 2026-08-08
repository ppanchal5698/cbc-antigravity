'use client';

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { ALLOWED_EXTENSIONS } from '@/lib/uploads';
import { cn } from '@/lib/utils';

/**
 * Uploading is the trigger. There is deliberately no run button: the file
 * lands in the project folder and the estimate is enqueued in the same request.
 */
export function UploadDrop({
  projectId,
  onUploaded,
}: {
  projectId: string;
  onUploaded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | null) => {
    if (!files?.length || busy) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append('file', file);
        const response = await fetch(`/api/projects/${projectId}/files`, {
          method: 'POST',
          body: form,
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `Upload failed (${response.status})`);
        }
        toast.success(`Uploaded ${file.name}`, { description: 'Estimate started.' });
      }
      onUploaded();
    } catch (err) {
      toast.error('Upload failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void upload(e.dataTransfer.files);
      }}
      className={cn(
        'border-rule border border-dashed px-4 py-8 text-center transition-colors',
        over && 'border-signal bg-signal-wash',
      )}
    >
      <input
        ref={input}
        type="file"
        multiple
        className="sr-only"
        accept={ALLOWED_EXTENSIONS.join(',')}
        onChange={(e) => void upload(e.target.files)}
      />
      <p className="text-[13px]">
        {busy ? (
          'Uploading…'
        ) : (
          <>
            Drop a bid set here, or{' '}
            <button
              type="button"
              onClick={() => input.current?.click()}
              className="text-signal cursor-pointer underline underline-offset-2"
            >
              choose a file
            </button>
            .
          </>
        )}
      </p>
      <p className="text-ink-muted mt-1.5 text-[12px]">
        The estimate starts the moment the upload finishes.
      </p>
    </div>
  );
}
