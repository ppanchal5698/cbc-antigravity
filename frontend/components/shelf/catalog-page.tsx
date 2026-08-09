import Link from 'next/link';
import type { CatalogPage } from '@/lib/catalog';
import { Marker } from '@/components/shell/state';

/**
 * One page of a price book - what a `[catalog] Hager p.18` citation resolves
 * to. Parsed rows first, then the raw page text, because a partial book's
 * unparsed text is often the only place a price lives.
 */
export function CatalogPageView({ folder, page }: { folder: string; page: CatalogPage }) {
  return (
    <div className="border-signal/30 bg-signal-wash/40 border-l-2 py-4 pl-4">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className="t-label mb-1">Page {page.page}</p>
          <p className="text-[15px] font-medium">{page.section || 'Unsectioned'}</p>
          {page.subsection ? (
            <p className="text-ink-muted text-[12px]">{page.subsection}</p>
          ) : null}
          {/* Which book, always. A page number on its own does not identify one, and
              this vendor may have several. */}
          <p className="text-ink-muted mt-1 text-[12px]">{page.book.file}</p>
        </div>
        <div className="flex items-center gap-3">
          {page.printedPageNo ? (
            <Marker>Printed {page.printedPageNo}</Marker>
          ) : null}
          <Link
            href={`/shelf/${encodeURIComponent(folder)}`}
            className="t-label hover:text-ink transition-colors"
          >
            Close
          </Link>
        </div>
      </div>

      {page.alsoIn.length ? (
        <p className="text-alert mb-4 max-w-prose text-[12px] leading-relaxed">
          This vendor has {page.alsoIn.length + 1} books with a page {page.page}. Showing{' '}
          <span className="font-medium">{page.book.file}</span>. If the citation meant{' '}
          {page.alsoIn.map((other, i) => (
            <span key={other.catalogId}>
              {i > 0 ? ' or ' : ''}
              <Link
                href={`/shelf/${encodeURIComponent(folder)}?page=${page.page}&book=${encodeURIComponent(other.file)}`}
                className="underline underline-offset-2"
              >
                {other.file}
              </Link>
            </span>
          ))}
          , open that instead — page numbers are per book.
        </p>
      ) : null}

      {page.products.length ? (
        <div className="scroll-x mb-5">
          <table className="ledger">
            <thead>
              <tr>
                <th>Model</th>
                <th>Description</th>
                <th>Size</th>
                <th>Finish</th>
                <th className="text-right">List</th>
              </tr>
            </thead>
            <tbody>
              {page.products.map((row, i) => (
                <tr key={`${row.model}-${row.finish}-${i}`}>
                  <td className="code font-medium">{row.model || '—'}</td>
                  <td className="max-w-lg">{row.description || '—'}</td>
                  <td className="code text-ink-muted">{row.size || '—'}</td>
                  <td className="code">{row.finish || '—'}</td>
                  <td className="num">{row.listPrice === null ? '—' : row.listPrice.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-ink-muted mb-5 text-[13px]">
          No price rows were parsed from this page. The text below is what the book actually says.
        </p>
      )}

      {page.textRows.length ? (
        <details className="group" open={page.products.length === 0}>
          <summary className="t-label hover:text-ink cursor-pointer list-none">
            Page text
            <span className="text-rule-strong ml-2 font-mono normal-case">
              {page.textRows.length} lines
            </span>
          </summary>
          <pre className="border-rule bg-paper text-ink-muted mt-3 max-h-96 overflow-auto border p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {page.textRows.join('\n')}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
