import { COVERAGE_LABEL, type Coverage } from '@/lib/catalog';
import { cn } from '@/lib/utils';

/**
 * How much of a price book the agent can actually read.
 *
 * This is the single most important fact about the shelf and it is invisible
 * everywhere else: a `text_only` book's silence is not evidence the vendor
 * does not carry a part, and quoting from one requires opening the page by
 * hand. The bar turns that from a paragraph in a README into a glance.
 */
export function CoverageBar({
  coverage,
  pagesParsed,
  pages,
  className,
}: {
  coverage: Coverage;
  pagesParsed: number;
  pages: number;
  className?: string;
}) {
  const ratio = pages > 0 ? Math.min(pagesParsed / pages, 1) : 0;
  const percent = Math.round(ratio * 100);

  return (
    <div className={cn('min-w-0', className)}>
      <div
        className="bg-rule relative h-1 w-full"
        role="img"
        aria-label={`${COVERAGE_LABEL[coverage]}: ${pagesParsed} of ${pages} pages parsed`}
      >
        <div
          className={cn(
            'absolute inset-y-0 left-0',
            coverage === 'text_only' ? 'bg-transparent' : 'bg-signal',
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-ink-muted mt-1.5 font-mono text-[11px] whitespace-nowrap">
        {COVERAGE_LABEL[coverage]}
        <span className="text-rule-strong mx-1.5">·</span>
        {coverage === 'text_only'
          ? 'no price rows parsed'
          : `${pagesParsed.toLocaleString('en-US')}/${pages.toLocaleString('en-US')} pp`}
      </p>
    </div>
  );
}
