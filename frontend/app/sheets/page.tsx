import { listDocs, listSheets, planIndexReady } from '@/lib/sheets';
import { SheetIndex } from '@/components/sheets/sheet-index';
import { Page, PageHeader, HeaderStat } from '@/components/shell/page-header';
import { count } from '@/components/shell/figure';
import { Empty } from '@/components/shell/state';

export const dynamic = 'force-dynamic';

export default async function SheetsPage({ searchParams }: PageProps<'/sheets'>) {
  if (!planIndexReady()) {
    return (
      <Page>
        <PageHeader eyebrow="Indexed bid sets" title="Sheets" />
        <Empty title="No plan index yet. Run plan-set-intake on a bid set, then reload." />
      </Page>
    );
  }

  const docs = listDocs();
  const sheets = listSheets();
  const query = await searchParams;
  const initialQuery = Array.isArray(query.q) ? query.q[0] : (query.q ?? '');
  const needsVision = sheets.filter(
    (sheet) => sheet.visionNeed && sheet.visionNeed !== 'none',
  ).length;

  return (
    <Page>
      <PageHeader
        eyebrow="Indexed bid sets"
        title="Sheets"
        meta={
          <>
            <HeaderStat label="Sets" value={count(docs.length)} />
            <HeaderStat label="Sheets" value={count(sheets.length)} />
            <HeaderStat label="Needs vision" value={count(needsVision)} />
          </>
        }
      />

      <p className="text-ink-muted max-w-prose py-5 text-[13px] leading-relaxed">
        A sheet identified by its title block is trustworthy; one identified by a bookmark, or not
        at all, is a guess. Sheets marked for vision still need a rendering pass before anything on
        them is quoted.
      </p>

      <SheetIndex docs={docs} sheets={sheets} initialQuery={initialQuery} />
    </Page>
  );
}
