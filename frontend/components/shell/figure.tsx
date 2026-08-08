import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The big numeral. Swiss design earns its calm by letting one number be large
 * and everything around it be small, so this is deliberately sparing: a label,
 * the figure, and at most one line of context.
 */
export function Figure({
  label,
  value,
  unit,
  note,
  tone = 'ink',
  className,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  note?: ReactNode;
  tone?: 'ink' | 'signal' | 'alert' | 'muted';
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <p className="t-label mb-3">{label}</p>
      <p
        className={cn(
          't-figure flex items-baseline gap-1.5',
          tone === 'signal' && 'text-signal',
          tone === 'alert' && 'text-alert',
          tone === 'muted' && 'text-ink-muted',
        )}
      >
        <span className="truncate">{value}</span>
        {unit ? (
          <span className="text-ink-muted text-[13px] font-medium tracking-normal">{unit}</span>
        ) : null}
      </p>
      {note ? <p className="text-ink-muted mt-2 text-[12px] leading-snug">{note}</p> : null}
    </div>
  );
}

/** Figures sit on a rule-separated row, never in boxes. */
export function FigureRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'divide-rule border-rule grid gap-px border-y sm:grid-cols-2 lg:grid-cols-4',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Formats a count with thin grouping. Falls back to an em dash for null. */
export function count(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

/** Money, always two decimals, always tabular. */
export function money(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
