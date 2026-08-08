import { listProducts, listVendors, searchBookText } from '@/lib/catalog';
import { findSheets } from '@/lib/sheets';
import { query } from '@/lib/db';
import type { Project } from '@/types/events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export type SearchHit = {
  group: 'Projects' | 'Vendors' | 'Products' | 'Sheets' | 'Pages';
  label: string;
  detail?: string;
  href: string;
};

/** One input over everything: projects, the shelf, price rows, plan sheets. */
export async function GET(request: Request): Promise<Response> {
  const q = new URL(request.url).searchParams.get('q')?.trim() ?? '';
  if (q.length < 2) return Response.json({ hits: [] });

  const hits: SearchHit[] = [];
  const lower = q.toLowerCase();

  try {
    const projects = await query<Project>(
      'SELECT * FROM projects WHERE name ILIKE $1 ORDER BY created_at DESC LIMIT 5',
      [`%${q}%`],
    );
    for (const project of projects) {
      hits.push({
        group: 'Projects',
        label: project.name,
        detail: `plans/${project.slug}`,
        href: `/projects/${project.id}`,
      });
    }
  } catch {
    // The shelf is still worth searching when Postgres is down.
  }

  for (const vendor of listVendors()) {
    if (vendor.folder.toLowerCase().includes(lower) || vendor.vendor.toLowerCase().includes(lower)) {
      hits.push({
        group: 'Vendors',
        label: vendor.folder,
        detail: `${vendor.books.length} books · ${vendor.priceRows.toLocaleString('en-US')} rows`,
        href: `/shelf/${encodeURIComponent(vendor.folder)}`,
      });
    }
  }

  for (const row of listProducts({ q, limit: 6 }).rows) {
    hits.push({
      group: 'Products',
      label: `${row.model}${row.finish ? ` · ${row.finish}` : ''}`,
      detail: [row.vendor, row.description].filter(Boolean).join(' — ').slice(0, 110),
      href: `/shelf/${encodeURIComponent(row.folder)}?page=${row.page}`,
    });
  }

  for (const sheet of findSheets(q, 5)) {
    hits.push({
      group: 'Sheets',
      label: sheet.sheetNo || `Page ${sheet.page}`,
      detail: [sheet.discipline, sheet.title].filter(Boolean).join(' — '),
      href: `/sheets?q=${encodeURIComponent(sheet.sheetNo || String(sheet.page))}`,
    });
  }

  for (const hit of searchBookText(q, 5)) {
    hits.push({
      group: 'Pages',
      label: `${hit.folder} p.${hit.page}`,
      detail: hit.snippet.replace(/\s+/g, ' ').slice(0, 110),
      href: `/shelf/${encodeURIComponent(hit.folder)}?page=${hit.page}`,
    });
  }

  return Response.json({ hits: hits.slice(0, 24) });
}
