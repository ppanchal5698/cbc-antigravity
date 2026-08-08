'use client';

import { memo, useMemo } from 'react';
import Link from 'next/link';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { PluggableList } from 'unified';
import { completeMarkdown } from '@/lib/markdown';
import { rehypeCitations } from '@/lib/rehype-citations';
import { cn } from '@/lib/utils';

/**
 * Internal links go through next/link so a citation navigates without a full
 * page load; external links open in a new tab with the usual rel guard.
 */
const components: Components = {
  a({ href, children, ...props }) {
    const target = typeof href === 'string' ? href : '';
    if (target.startsWith('/')) {
      return (
        <Link href={target} {...props}>
          {children}
        </Link>
      );
    }
    return (
      <a href={target} target="_blank" rel="noreferrer noopener" {...props}>
        {children}
      </a>
    );
  },
  table({ children, ...props }) {
    // Wide tables scroll inside the bubble; the page never scrolls sideways.
    return (
      <div className="scroll-x">
        <table {...props}>{children}</table>
      </div>
    );
  },
};

/**
 * Markdown block, memoised on the raw string so a token landing in a later
 * block does not force earlier blocks to re-parse. That, plus closing open
 * fences before render, is what makes streaming smooth instead of flickering.
 */
export const Markdown = memo(function Markdown({
  content,
  vendorFolders = [],
  className,
}: {
  content: string;
  /** The live shelf, so a catalog citation only links to a vendor that exists. */
  vendorFolders?: string[];
  className?: string;
}) {
  const rehypePlugins = useMemo(
    // Tuple form: unified calls rehypeCitations(vendorFolders) itself.
    // Passing rehypeCitations(vendorFolders) pre-bound double-invokes and crashes.
    (): PluggableList => [rehypeHighlight, [rehypeCitations, vendorFolders]],
    [vendorFolders],
  );

  return (
    <div className={cn('prose-cbc max-w-none', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins} components={components}>
        {completeMarkdown(content)}
      </ReactMarkdown>
    </div>
  );
});
