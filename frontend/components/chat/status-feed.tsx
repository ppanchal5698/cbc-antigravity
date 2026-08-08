'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import type { StatusEvent, StatusType } from '@/types/events';

const LABELS: Record<StatusType, string> = {
  starting: 'Starting',
  tool_use: 'Tool',
  tool_result: 'Returned',
  tool_error: 'Tool failed',
  crafting_response: 'Writing',
  finalizing: 'Checkpoint',
  done: 'Done',
  error: 'Failed',
};

function clock(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString('en-GB', { hour12: false });
}

/** Tool errors often dump a traceback; the first sentence is what the estimator needs. */
function firstSentence(detail: string): string {
  const trimmed = detail.trim();
  const cut = trimmed.search(/[\n.]/);
  if (cut === -1) return trimmed.length > 160 ? `${trimmed.slice(0, 157)}…` : trimmed;
  const end = trimmed[cut] === '.' ? cut + 1 : cut;
  const head = trimmed.slice(0, end).trim();
  return head.length > 160 ? `${head.slice(0, 157)}…` : head || trimmed.slice(0, 160);
}

/**
 * Live activity from the Antigravity CLI.
 *
 * Every row is a real event off the agent's stream, stamped when it arrived.
 * Nothing here is simulated or delayed, and the feed is replaced by the answer
 * once the run completes.
 */
export function StatusFeed({
  events,
  className,
  dense = false,
}: {
  events: StatusEvent[];
  className?: string;
  dense?: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [events.length]);

  if (!events.length) {
    return (
      <p className={cn('text-ink-muted font-mono text-[12px]', className)}>
        Waiting for the agent…
      </p>
    );
  }

  const latest = events[events.length - 1];

  return (
    <div className={cn('border-rule border-y', className)}>
      <div className="border-rule flex items-center gap-2 border-b py-2">
        <span className="relative flex size-1.5" aria-hidden>
          <span className="bg-signal absolute inline-flex size-full animate-ping opacity-60" />
          <span className="bg-signal relative inline-flex size-1.5" />
        </span>
        <span className="t-label">Antigravity · {LABELS[latest.type]}</span>
        <span className="text-ink-muted ml-auto font-mono text-[11px]">
          {events.length} events
        </span>
      </div>

      <ol
        className={cn('overflow-y-auto', dense ? 'max-h-40' : 'max-h-64')}
        aria-live="polite"
        aria-label="Agent activity"
      >
        {events.map((event, i) => (
          <li
            key={`${event.ts}-${i}`}
            className="border-rule/50 flex items-baseline gap-3 border-b py-1 font-mono text-[11px] last:border-b-0"
          >
            <span className="text-rule-strong shrink-0 tabular-nums">{clock(event.ts)}</span>
            <span
              className={cn(
                'w-20 shrink-0',
                event.type === 'tool_error' || event.type === 'error'
                  ? 'text-alert'
                  : event.type === 'done'
                    ? 'text-signal'
                    : 'text-ink-muted',
              )}
            >
              {LABELS[event.type]}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {event.mcpTool || event.tool ? (
                <span className="text-ink">{event.mcpTool || event.tool}</span>
              ) : null}
              {event.detail ? (
                <span className="text-ink-muted ml-2" title={event.detail}>
                  {event.type === 'tool_error' || event.type === 'error'
                    ? firstSentence(event.detail)
                    : event.detail}
                </span>
              ) : null}
            </span>
          </li>
        ))}
        <div ref={endRef} />
      </ol>
    </div>
  );
}
