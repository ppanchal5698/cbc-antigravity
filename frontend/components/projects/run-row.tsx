'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { StatusFeed } from '@/components/chat/status-feed';
import { Marker } from '@/components/shell/state';
import type { RunStatus, StatusEvent, StreamFrame } from '@/types/events';

export type RunSummary = {
  id: string;
  file_id: string | null;
  status: RunStatus;
  output_path: string | null;
  error: string | null;
  created_at: string;
};

const TONE: Record<RunStatus, 'muted' | 'signal' | 'alert' | 'ink'> = {
  pending: 'muted',
  running: 'signal',
  completed: 'ink',
  failed: 'alert',
};

/**
 * One background estimate.
 *
 * EventSource handles reconnection and replays missed events via Last-Event-ID,
 * so a dropped connection resumes the feed rather than restarting the run.
 */
export function RunRow({
  run,
  filename,
  onSettled,
}: {
  run: RunSummary;
  filename: string;
  onSettled?: () => void;
}) {
  const [status, setStatus] = useState<RunStatus>(run.status);
  const [events, setEvents] = useState<StatusEvent[]>([]);
  const [error, setError] = useState<string | null>(run.error);

  useEffect(() => {
    if (run.status === 'completed' || run.status === 'failed') return;

    const source = new EventSource(`/api/runs/${run.id}/events`);
    let settled = false;

    const finish = async (fallback: RunStatus, message?: string) => {
      if (settled) return;
      settled = true;
      source.close();
      setStatus(fallback);
      if (message) setError(message);
      // Re-read the row so the download link reflects what the worker wrote.
      const response = await fetch(`/api/runs/${run.id}`).catch(() => null);
      if (response?.ok) {
        const body = (await response.json()) as { run: RunSummary };
        setStatus(body.run.status);
        setError(body.run.error);
      }
      onSettled?.();
    };

    const onFrame = (raw: string) => {
      const frame = JSON.parse(raw) as StreamFrame;
      if (frame.kind === 'status') {
        setStatus('running');
        setEvents((prev) => [...prev, frame.event]);
      } else if (frame.kind === 'done') {
        void finish('completed');
      } else if (frame.kind === 'error') {
        toast.error(`Estimate failed for ${filename}`, { description: frame.message });
        void finish('failed', frame.message);
      }
    };

    for (const kind of ['status', 'token', 'done', 'error', 'conversation'] as const) {
      source.addEventListener(kind, (event) => onFrame((event as MessageEvent<string>).data));
    }
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED && !settled) void finish('failed');
    };

    return () => {
      settled = true;
      source.close();
    };
    // One subscription per run; `status` is written here, never read as a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, run.status, filename]);

  const active = status === 'pending' || status === 'running';
  const downloadHref = status === 'completed' ? `/api/runs/${run.id}/download` : null;

  return (
    <div className="border-rule border-b py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        {downloadHref ? (
          <a
            href={downloadHref}
            download
            className="text-signal min-w-0 truncate text-[13px] font-medium hover:underline"
            title={`Download ${filename}`}
          >
            {filename}
          </a>
        ) : (
          <span className="text-ink-muted min-w-0 truncate text-[13px] font-normal" title={filename}>
            {filename}
          </span>
        )}
        <div className="flex items-center gap-4">
          <Marker tone={TONE[status]}>{status}</Marker>
          {downloadHref ? (
            <a
              href={downloadHref}
              download
              className="t-label text-signal hover:text-ink transition-colors"
            >
              Download .xlsx
            </a>
          ) : null}
        </div>
      </div>

      {active ? <StatusFeed events={events} className="mt-3" dense /> : null}

      {status === 'failed' && error ? (
        <p className="text-alert mt-2 text-[12px] break-words">{error}</p>
      ) : null}
    </div>
  );
}
