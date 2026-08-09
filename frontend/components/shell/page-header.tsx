import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Page title block: quieter labels, soft-industrial hierarchy. */
export function PageHeader({
  eyebrow,
  title,
  meta,
  actions,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('pt-6 pb-5', className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          {eyebrow ? <p className="t-eyebrow mb-2">{eyebrow}</p> : null}
          <h1 className="t-display min-w-0 break-words">{title}</h1>
        </div>
        {meta || actions ? (
          <div className="flex flex-wrap items-end gap-4">
            {meta ? <div className="flex items-end gap-5">{meta}</div> : null}
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function HeaderStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="text-right">
      <p className="t-label mb-1.5">{label}</p>
      <p className="font-mono text-[13px] leading-none">{value}</p>
    </div>
  );
}

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('mx-auto w-full max-w-[1600px] px-4 pb-16 sm:px-6', className)}>
      {children}
    </div>
  );
}

/** Section with optional panel chrome for interactive or metric blocks. */
export function Section({
  label,
  aside,
  children,
  className,
  panel = false,
}: {
  label: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  panel?: boolean;
}) {
  return (
    <section className={cn('pt-8', className)}>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-[13px] font-semibold tracking-[-0.01em]">{label}</h2>
        {aside ? <div className="t-label">{aside}</div> : null}
      </div>
      {panel ? <div className="panel overflow-hidden">{children}</div> : children}
    </section>
  );
}
