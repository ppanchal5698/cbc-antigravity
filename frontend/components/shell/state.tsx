import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * An empty screen is an invitation to act, not an apology. Every empty state
 * says what is missing and what to do about it.
 */
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
    <div className={cn('border-rule border-b py-14 text-center', className)}>
      <p className="text-ink-muted text-[13px]">{title}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

/** A failure. States what went wrong and how to fix it, in the app's voice. */
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
    <div className={cn('border-alert/40 bg-alert-wash border-l-2 px-4 py-3', className)}>
      <p className="text-alert text-[13px] font-medium">{title}</p>
      {detail ? <p className="text-ink-muted mt-1 text-[12px] break-words">{detail}</p> : null}
    </div>
  );
}

/** Small uppercase state marker. Two inks only: signal for live, alert for failed. */
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
        't-label border px-1.5 py-0.5 leading-[1.4] whitespace-nowrap',
        tone === 'signal' && 'border-signal/40 text-signal',
        tone === 'alert' && 'border-alert/40 text-alert',
        tone === 'ink' && 'border-rule-strong text-ink',
        tone === 'muted' && 'border-rule text-ink-muted',
      )}
    >
      {children}
    </span>
  );
}

/** Loading placeholder that keeps the ledger's row rhythm instead of pulsing boxes. */
export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="border-rule/70 flex items-center gap-4 border-b py-2.5">
          <span className="bg-sunken h-3 w-24" />
          <span className="bg-sunken h-3 flex-1" />
          <span className="bg-sunken h-3 w-16" />
        </div>
      ))}
    </div>
  );
}
