import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Empty({
  title,
  action,
  className,
}: {
  title: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('rounded-lg border border-dashed border-rule py-14 text-center', className)}>
      <p className="text-ink-muted text-[13px]">{title}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function Failure({
  title,
  detail,
  className,
}: {
  title: string;
  detail?: string;
  className?: string;
}) {
  return (
    <div className={cn('border-alert/30 bg-alert-wash rounded-md border px-4 py-3', className)}>
      <p className="text-alert text-[13px] font-medium">{title}</p>
      {detail ? <p className="text-ink-muted mt-1 text-[12px] break-words">{detail}</p> : null}
    </div>
  );
}

export function Marker({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'muted' | 'signal' | 'alert' | 'ink';
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-[1.4] whitespace-nowrap',
        tone === 'signal' && 'border-signal/30 bg-signal-wash text-signal',
        tone === 'alert' && 'border-alert/30 bg-alert-wash text-alert',
        tone === 'ink' && 'border-rule-strong bg-sunken text-ink',
        tone === 'muted' && 'border-rule bg-sunken text-ink-muted',
      )}
    >
      {children}
    </span>
  );
}

export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-0">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="border-rule/70 flex items-center gap-4 border-b px-3 py-2.5">
          <span className="bg-sunken h-3 w-24 animate-pulse rounded-sm" />
          <span className="bg-sunken h-3 flex-1 animate-pulse rounded-sm" />
          <span className="bg-sunken h-3 w-16 animate-pulse rounded-sm" />
        </div>
      ))}
    </div>
  );
}
