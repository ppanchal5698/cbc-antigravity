export type PreviewKind = 'pdf' | 'image' | 'spreadsheet' | 'unsupported';

/** Anything the preview modal can open — project uploads or generated run outputs. */
export type FilePreviewTarget = {
  filename: string;
  sizeBytes?: number | null;
  mime?: string | null;
  inlineUrl: string;
  downloadUrl: string;
};

function extensionOf(filename: string): string {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot >= 0 ? lower.slice(dot) : '';
}

/** How the preview modal should render a file. */
export function previewKind(filename: string, mime: string | null | undefined): PreviewKind {
  const ext = extensionOf(filename);
  const type = (mime || '').toLowerCase();

  if (ext === '.pdf' || type === 'application/pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg'].includes(ext) || type.startsWith('image/')) {
    return 'image';
  }
  if (ext === '.xlsx' || ext === '.csv' || type.includes('spreadsheet') || type === 'text/csv') {
    return 'spreadsheet';
  }
  return 'unsupported';
}

export function projectFilePreview(
  projectId: string,
  file: { id: string; filename: string; size_bytes: number; mime: string | null },
): FilePreviewTarget {
  return {
    filename: file.filename,
    sizeBytes: file.size_bytes,
    mime: file.mime,
    inlineUrl: `/api/projects/${projectId}/files/${file.id}/download?disposition=inline`,
    downloadUrl: `/api/projects/${projectId}/files/${file.id}/download`,
  };
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function runOutputPreview(runId: string, filename: string): FilePreviewTarget {
  return {
    filename,
    mime: XLSX_MIME,
    inlineUrl: `/api/runs/${runId}/download?disposition=inline`,
    downloadUrl: `/api/runs/${runId}/download`,
  };
}
