'use client';

import dynamic from 'next/dynamic';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  previewKind,
  type FilePreviewTarget,
  type PreviewKind,
} from '@/lib/file-preview';

const ExcelPreview = dynamic(
  () => import('@/components/projects/excel-preview').then((m) => m.ExcelPreview),
  {
    ssr: false,
    loading: () => (
      <p className="text-ink-muted flex h-[min(70vh,640px)] items-center justify-center text-[13px]">
        Loading spreadsheet engine…
      </p>
    ),
  },
);

const btn =
  'cursor-pointer rounded-md border border-rule bg-panel px-2.5 py-1 text-[12px] font-medium transition-colors hover:border-signal hover:text-signal disabled:opacity-40';

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function PreviewBody({
  kind,
  url,
  filename,
}: {
  kind: PreviewKind;
  url: string;
  filename: string;
}) {
  if (kind === 'pdf') {
    return (
      <iframe
        title={filename}
        src={url}
        className="bg-panel h-[min(70vh,640px)] w-full rounded-md border border-rule"
      />
    );
  }
  if (kind === 'image') {
    return (
      <div className="flex max-h-[min(70vh,640px)] items-center justify-center overflow-auto rounded-md border border-rule bg-black/5 p-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={filename} className="max-h-[min(65vh,600px)] max-w-full object-contain" />
      </div>
    );
  }
  if (kind === 'spreadsheet') {
    return <ExcelPreview url={url} filename={filename} />;
  }
  return (
    <div className="text-ink-muted flex h-[200px] flex-col items-start justify-center gap-2 rounded-md border border-rule px-4 py-6 text-[13px]">
      <p>In-browser preview is not available for this file type.</p>
      <p>Use Download to open it locally.</p>
    </div>
  );
}

export function FilePreviewModal({
  target,
  onClose,
}: {
  target: FilePreviewTarget | null;
  onClose: () => void;
}) {
  const open = Boolean(target);
  const kind = target ? previewKind(target.filename, target.mime) : 'unsupported';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-[calc(100%-2rem)] flex-col gap-3 sm:max-w-5xl"
        showCloseButton
      >
        {target ? (
          <>
            <DialogHeader className="pr-8">
              <DialogTitle className="truncate font-mono text-[14px]">{target.filename}</DialogTitle>
              <DialogDescription>
                {[
                  kind === 'unsupported' ? target.mime || 'Unknown type' : kind,
                  target.sizeBytes != null ? bytes(target.sizeBytes) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </DialogDescription>
            </DialogHeader>

            <PreviewBody kind={kind} url={target.inlineUrl} filename={target.filename} />

            <DialogFooter className="sm:justify-between">
              <a href={target.downloadUrl} className={btn}>
                Download
              </a>
              <button type="button" className={btn} onClick={onClose}>
                Close
              </button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
