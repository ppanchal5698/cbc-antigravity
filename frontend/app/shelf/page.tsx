import Link from 'next/link';
import { getShelfStats } from '@/lib/catalog';
import { formatTier, getEngineReference, tierFor } from '@/lib/engine-reference';
import { CoverageBar } from '@/components/shelf/coverage-bar';
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
        filename. A text-only book&apos;s silence is not evidence a vendor does not carry a part.
      </p>

      <div className="border-rule border-t">
        {vendors.map((vendor) => {
          const matched = tierFor(reference, vendor.folder);
          const textOnly = vendor.coverage === 'text_only';
          return (
            <Link
              key={vendor.folder}
              href={`/shelf/${encodeURIComponent(vendor.folder)}`}
              className="border-rule group grid grid-cols-1 gap-x-8 gap-y-4 border-b py-5 no-underline md:grid-cols-12"
            >
              <div className="md:col-span-4">
                <h2 className="group-hover:text-signal text-[17px] font-semibold tracking-[-0.01em] transition-colors">
                  {vendor.folder}
                </h2>
                <p className="text-ink-muted mt-1 text-[12px]">
                  {matched?.tier.vendor_name ?? vendor.vendor}
                </p>
                <p className="mt-2.5">
                  <Marker tone={matched?.tier.multiplier === null ? 'alert' : 'ink'}>
                    {formatTier(matched?.tier)}
                  </Marker>
                </p>
              </div>

              <div className="md:col-span-4">
                <CoverageBar
                  coverage={vendor.coverage}
                  pagesParsed={vendor.books.reduce((n, b) => n + b.pagesParsed, 0)}
                  pages={vendor.pages}
                />
                <ul className="text-ink-muted mt-3 space-y-1 text-[12px]">
                  {vendor.books.map((book) => (
                    <li key={book.catalogId} className="truncate" title={book.file}>
                      {book.file}
                    </li>
                  ))}
                </ul>
                {textOnly ? (
                  <p className="text-signal mt-3 text-[12px] group-hover:underline">
                    Open book pages — needs structured parse (silence ≠ not carried)
                  </p>
                ) : null}
              </div>

              <div className="grid grid-cols-3 gap-6 md:col-span-4">
                <Stat label="Books" value={count(vendor.books.length)} />
                <Stat label="Models" value={count(vendor.models)} />
                {textOnly ? (
                  <div className="text-right">
                    <p className="t-label mb-1.5">Price rows</p>
                    <Marker tone="muted">Text only</Marker>
                  </div>
                ) : (
                  <Stat label="Price rows" value={count(vendor.priceRows)} />
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </Page>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right">
      <p className="t-label mb-1.5">{label}</p>
      <p className="font-mono text-[15px] leading-none">{value}</p>
    </div>
  );
}
