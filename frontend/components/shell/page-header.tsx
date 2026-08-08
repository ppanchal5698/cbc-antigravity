import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The specimen block every surface opens with: title left, metadata right,
 * one hairline under both. Repeating it exactly is what makes seven separate
 * pages read as one application.
 */
export function PageHeader({
  eyebrow,
  title,
  meta,
  actions,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  /** Right-aligned facts. Kept short: counts, states, dates. */
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('border-rule border-b', className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 pt-8 pb-4">
        <div className="min-w-0">
          {eyebrow ? <p className="t-eyebrow mb-2.5">{eyebrow}</p> : null}
          <h1 className="t-display min-w-0 break-words">{title}</h1>
        </div>
        {meta || actions ? (
          <div className="flex items-end gap-6">
            {meta ? <div className="flex items-end gap-6">{meta}</div> : null}
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** One right-aligned fact in a page header: small label over a value. */
export function HeaderStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="text-right">
      <p className="t-label mb-1.5">{label}</p>
      <p className="font-mono text-[13px] leading-none">{value}</p>
    </div>
  );
}

/** Standard page shell: max width, gutters, and the section rhythm. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('mx-auto w-full max-w-[1600px] px-4 pb-20 sm:px-6', className)}>
      {children}
    </div>
  );
}

/** A ruled block. Replaces the card: a label, a hairline, and content. */
export function Section({
  label,
  aside,
  children,
  className,
}: {
  label: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('pt-10', className)}>
      <div className="border-rule mb-4 flex items-baseline justify-between gap-4 border-b pb-2">
        <h2 className="t-label">{label}</h2>
        {aside ? <div className="t-label normal-case">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}
