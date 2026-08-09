import Link from 'next/link';
import { notFound } from 'next/navigation';
import { divisionsForVendor, getCatalogPage, getVendor } from '@/lib/catalog';
import { formatTier, getEngineReference, tierFor } from '@/lib/engine-reference';
import { ScopedChat } from '@/components/chat/scoped-chat';
import { CoverageBar } from '@/components/shelf/coverage-bar';
import { CatalogPageView } from '@/components/shelf/catalog-page';
import { ProductTable } from '@/components/shelf/product-table';
import { Page, PageHeader, HeaderStat, Section } from '@/components/shell/page-header';
import { count } from '@/components/shell/figure';
import { Marker } from '@/components/shell/state';

export const dynamic = 'force-dynamic';

export default async function VendorPage({
  params,
  searchParams,
}: PageProps<'/shelf/[folder]'>) {
  const { folder } = await params;
  const query = await searchParams;
  const decoded = decodeURIComponent(folder);

  const vendor = getVendor(decoded);
  if (!vendor) notFound();

  const reference = await getEngineReference();
  const matched = tierFor(reference, vendor.folder);
  const divisions = divisionsForVendor(vendor.folder);

  const pageParam = Array.isArray(query.page) ? query.page[0] : query.page;
  const pageNumber = pageParam ? Number(pageParam) : NaN;
  const bookHint = Array.isArray(query.book) ? query.book[0] : query.book;
  const catalogPage = Number.isFinite(pageNumber)
    ? getCatalogPage(vendor.folder, pageNumber, bookHint)
    : null;

  const initialQuery = Array.isArray(query.q) ? query.q[0] : (query.q ?? '');

  return (
    <Page>
      <PageHeader
        eyebrow={
          <Link href="/shelf" className="hover:text-ink transition-colors">
            Shelf
          </Link>
        }
        title={vendor.folder}
        meta={
          <>
            <HeaderStat label="Books" value={count(vendor.books.length)} />
            <HeaderStat label="Models" value={count(vendor.models)} />
            <HeaderStat label="Price rows" value={count(vendor.priceRows)} />
          </>
        }
      />

      <div className="panel mt-2 flex flex-wrap items-start justify-between gap-x-10 gap-y-5 p-4">
        <div className="min-w-0">
          <p className="t-label mb-2">Cost basis</p>
          <p className="flex flex-wrap items-center gap-2.5">
            <Marker tone={matched?.tier.multiplier === null ? 'alert' : 'ink'}>
              {formatTier(matched?.tier)}
            </Marker>
            {matched ? (
              <span className="text-ink-muted text-[12px]">
                effective {matched.tier.effective_date}
              </span>
            ) : (
              <span className="text-ink-muted text-[12px]">
                No engine tier for this folder — quote requires an RFQ.
              </span>
            )}
          </p>
          {matched?.tier.notes ? (
            <p className="text-ink-muted mt-2 max-w-prose text-[12px] leading-relaxed">
              {matched.tier.notes}
            </p>
          ) : null}
          {matched?.tier.manual_entry_prompt ? (
            <p className="text-alert mt-2 max-w-prose text-[12px] leading-relaxed">
              {matched.tier.manual_entry_prompt}
            </p>
          ) : null}
        </div>

        <div className="w-full max-w-xs">
          <p className="t-label mb-2">What the agent can read</p>
          <CoverageBar
            coverage={vendor.coverage}
            pagesParsed={vendor.books.reduce((n, b) => n + b.pagesParsed, 0)}
            pages={vendor.pages}
          />
        </div>
      </div>

      <Section label="Books" aside={`${vendor.pages.toLocaleString('en-US')} pages`}>
        <div className="scroll-x">
          <table className="ledger">
            <thead>
              <tr>
                <th>File</th>
                <th>Coverage</th>
                <th>CSI sections</th>
                <th className="text-right">Pages</th>
                <th className="text-right">Models</th>
                <th className="text-right">Rows</th>
                <th className="text-right">Effective</th>
              </tr>
            </thead>
            <tbody>
              {vendor.books.map((book) => (
                <tr key={book.catalogId}>
                  <td className="min-w-[16rem] font-medium">{book.file}</td>
                  <td className="w-40">
                    <CoverageBar
                      coverage={book.coverage}
                      pagesParsed={book.pagesParsed}
                      pages={book.pages}
                    />
                  </td>
                  <td className="text-ink-muted min-w-[12rem] text-[12px]">
                    {book.csiSections.length
                      ? book.csiSections.map((s) => s.section).join(', ')
                      : '—'}
                  </td>
                  <td className="num">{count(book.pages)}</td>
                  <td className="num">{count(book.models)}</td>
                  <td className="num">{count(book.priceRows)}</td>
                  <td className="num text-ink-muted">{book.effective || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {catalogPage ? (
        <Section label="Catalog page">
          <CatalogPageView folder={vendor.folder} page={catalogPage} />
        </Section>
      ) : null}

      <Section label="Price rows" aside="model × size × finish">
        <ProductTable folder={vendor.folder} divisions={divisions} initialQuery={initialQuery} />
      </Section>

      <ScopedChat
        scope="vendor"
        vendorFolders={[vendor.folder]}
        context={{
          vendorFolder: vendor.folder,
          vendorBooks: vendor.books.map((book) => book.file),
        }}
      />
    </Page>
  );
}
