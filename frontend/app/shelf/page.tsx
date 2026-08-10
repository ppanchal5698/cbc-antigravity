import Link from 'next/link';
import { getShelfStats } from '@/lib/catalog';
import { formatTier, getEngineReference, tierFor } from '@/lib/engine-reference';
import { CoverageBar } from '@/components/shelf/coverage-bar';
import { ScopedChat } from '@/components/chat/scoped-chat';
import { Page, PageHeader, HeaderStat } from '@/components/shell/page-header';
import { count } from '@/components/shell/figure';
import { Empty, Marker } from '@/components/shell/state';

export const dynamic = 'force-dynamic';

export default async function ShelfPage() {
  const shelf = getShelfStats();

  if (!shelf.ready) {
    return (
      <Page>
        <PageHeader eyebrow="Vendors and price books" title="Shelf" />
        <Empty title="The catalog index has not been built. Run vendor-catalog-intake to index the books, then reload." />
      </Page>
    );
  }

  const { vendors, vendorCount, bookCount, priceRows } = shelf;
  const reference = await getEngineReference();

  return (
    <Page>
      <PageHeader
        eyebrow="Vendors and price books"
        title="Shelf"
        meta={
          <>
            <HeaderStat label="Vendors" value={count(vendorCount)} />
            <HeaderStat label="Books" value={count(bookCount)} />
            <HeaderStat label="Price rows" value={count(priceRows)} />
          </>
        }
      />

      <p className="text-ink-muted max-w-prose py-5 text-[13px] leading-relaxed">
        Every price in this index is a <strong className="text-ink font-medium">list</strong> price
        unless the book states otherwise. Multipliers come from the estimating engine, not from the
        filename. A text-only or partial book&apos;s silence is not evidence a vendor does not carry
        a part — open the book pages.
      </p>

      <div className="panel scroll-x overflow-hidden">
        <table className="ledger">
          <thead>
            <tr>
              <th>Vendor</th>
              <th>Cost basis</th>
              <th>Coverage</th>
              <th>Books</th>
              <th className="text-right">Models</th>
              <th className="text-right">Price rows</th>
              <th className="text-right">Open</th>
            </tr>
          </thead>
          <tbody>
            {vendors.map((vendor) => {
              const matched = tierFor(reference, vendor.folder);
              const textOnly = vendor.coverage === 'text_only';
              const partial = vendor.coverage === 'partial';
              return (
                <tr key={vendor.folder}>
                  <td className="min-w-[10rem]">
                    <Link
                      href={`/shelf/${encodeURIComponent(vendor.folder)}`}
                      className="hover:text-signal text-[14px] font-medium transition-colors"
                    >
                      {vendor.folder}
                    </Link>
                    <p className="text-ink-muted mt-0.5 text-[11px]">
                      {matched?.tier.vendor_name ?? vendor.vendor}
                    </p>
                  </td>
                  <td>
                    <Marker tone={matched?.tier.multiplier === null ? 'alert' : 'ink'}>
                      {formatTier(matched?.tier)}
                    </Marker>
                  </td>
                  <td className="min-w-[11rem]">
                    <CoverageBar
                      coverage={vendor.coverage}
                      pagesParsed={vendor.books.reduce((n, b) => n + b.pagesParsed, 0)}
                      pages={vendor.pages}
                    />
                    {textOnly || partial ? (
                      <p className="text-signal mt-1.5 text-[11px]">
                        Inspection needed — silence ≠ not carried
                      </p>
                    ) : null}
                  </td>
                  <td className="text-ink-muted max-w-[14rem] text-[12px]">
                    <ul className="space-y-0.5">
                      {vendor.books.map((book) => (
                        <li key={book.catalogId} className="truncate" title={book.file}>
                          {book.file}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="num">{count(vendor.models)}</td>
                  <td className="num">
                    {textOnly ? (
                      <Marker tone="muted">Text only</Marker>
                    ) : (
                      count(vendor.priceRows)
                    )}
                  </td>
                  <td className="num">
                    <Link
                      href={`/shelf/${encodeURIComponent(vendor.folder)}`}
                      className="text-signal hover:text-ink text-[12px] font-medium no-underline"
                    >
                      Browse
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ScopedChat scope="shelf" vendorFolders={vendors.map((vendor) => vendor.folder)} />
    </Page>
  );
}
