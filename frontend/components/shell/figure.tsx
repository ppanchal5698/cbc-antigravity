import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

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
    <div className={cn('min-w-0 p-4', className)}>
      <p className="t-label mb-2.5">{label}</p>
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

export function FigureRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'panel grid sm:grid-cols-2 lg:grid-cols-4 [&>*]:border-rule [&>*:not(:last-child)]:border-b lg:[&>*:not(:last-child)]:border-b-0 lg:[&>*:not(:last-child)]:border-r',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function count(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

export function money(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
