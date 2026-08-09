import { basename } from 'node:path';
import {
  CATALOG_DB,
  ftsQuery,
  invalidateIndex,
  memoizeOnIndex,
  openIndex,
  queryIndex,
} from './workspace-db';

/**
 * The vendor shelf, read straight from catalog-intelligence's index.
 *
 * Two facts about this data drive everything below:
 * - `catalog_id` is a hash of path + mtime + parser version, so it changes
 *   whenever a book is re-indexed. Never key the UI on it; key on `folder`.
 * - a product row is one model x size x finish. A model has a price *range*,
 *   never a price.
 */

export type Coverage = 'structured' | 'partial' | 'text_only';

export type CatalogBook = {
  catalogId: string;
  vendor: string;
  folder: string;
  file: string;
  path: string;
  /** MM/DD/YYYY when the book states one. NULL on 15 of 17 books. */
  effective: string | null;
  /** Parsed out of the filename, so present on only a few books. */
  multiplierInFilename: string | null;
  pages: number;
  pagesParsed: number;
  priceRows: number;
  models: number;
  coverage: Coverage;
  csiSections: { section: string; name: string | null; models: number }[];
};

export type Vendor = {
  folder: string;
  vendor: string;
  books: CatalogBook[];
  pages: number;
  priceRows: number;
  models: number;
  /** Best coverage across the vendor's books - what the agent can actually see. */
  coverage: Coverage;
};

export type ProductRow = {
  vendor: string;
  folder: string;
  model: string;
  description: string | null;
  size: string | null;
  finish: string | null;
  listPrice: number | null;
  page: number;
  section: string | null;
  division: string | null;
  csiSection: string | null;
  csiName: string | null;
};

/** Mirrors catint's own query-time derivation (`server.py:_coverage`). */
export function deriveCoverage(pagesParsed: number, pages: number): Coverage {
  if (pagesParsed === 0) return 'text_only';
  if (pages > 0 && pagesParsed / pages >= 0.3) return 'structured';
  return 'partial';
}

export const COVERAGE_LABEL: Record<Coverage, string> = {
  structured: 'Structured',
  partial: 'Partial',
  text_only: 'Text only',
};

/** From catint's index.py; the printed CSI division names. */
export const DIVISION_NAMES: Record<string, string> = {
  '06': 'Wood, Plastics, and Composites',
  '07': 'Thermal and Moisture Protection',
  '08': 'Openings',
  '09': 'Finishes',
  '10': 'Specialties',
  '22': 'Plumbing',
};

export function catalogIndexReady(): boolean {
  return openIndex(CATALOG_DB) !== null;
}

/** Shared counters for Overview and Shelf so the two pages cannot drift. */
export function getShelfStats(): {
  ready: boolean;
  vendors: Vendor[];
  vendorCount: number;
  bookCount: number;
  priceRows: number;
  uncovered: number;
} {
  if (!catalogIndexReady()) {
    return {
      ready: false,
      vendors: [],
      vendorCount: 0,
      bookCount: 0,
      priceRows: 0,
      uncovered: 0,
    };
  }

  let vendors = listVendors();
  // A forever-cached handle opened against an empty/replaced DB looks "ready"
  // but returns zero rows. Force one reopen before believing the shelf is empty.
  if (vendors.length === 0) {
    console.warn('[catalog] index ready but listVendors empty — reopening handle');
    invalidateIndex(CATALOG_DB);
    if (!catalogIndexReady()) {
      return {
        ready: false,
        vendors: [],
        vendorCount: 0,
        bookCount: 0,
        priceRows: 0,
        uncovered: 0,
      };
    }
    vendors = listVendors();
  }

  const bookCount = vendors.reduce((total, vendor) => total + vendor.books.length, 0);
  const priceRows = vendors.reduce((total, vendor) => total + vendor.priceRows, 0);
  const uncovered = vendors.filter((vendor) => vendor.coverage === 'text_only').length;

  return {
    ready: true,
    vendors,
    vendorCount: vendors.length,
    bookCount,
    priceRows,
    uncovered,
  };
}

type BookRow = {
  catalog_id: string;
  vendor: string;
  folder: string | null;
  path: string;
  effective: string | null;
  multiplier: string | null;
  pages: number;
  price_rows: number;
  pages_parsed: number;
  models: number;
};

/**
 * Every indexed book with its counts.
 *
 * Two queries, both grouped, and the result is cached until the index file changes.
 * This was three correlated subqueries per catalog plus a full products GROUP BY, run
 * from `listVendors` / `getVendor` / `getShelfStats` - so every page render and every
 * keystroke in the command palette re-aggregated the whole products table.
 */
export function listBooks(): CatalogBook[] {
  return memoizeOnIndex(CATALOG_DB, 'books', () => {
    const rows = queryIndex<BookRow>(
      CATALOG_DB,
      `SELECT c.catalog_id, c.vendor, c.folder, c.path, c.effective, c.multiplier, c.pages,
              COUNT(p.catalog_id)        AS price_rows,
              COUNT(DISTINCT p.page)     AS pages_parsed,
              COUNT(DISTINCT p.model)    AS models
         FROM catalogs c
         LEFT JOIN products p ON p.catalog_id = c.catalog_id
        GROUP BY c.catalog_id
        ORDER BY c.folder, c.path`,
    );

    const sections = queryIndex<{
      catalog_id: string;
      csi_section: string;
      csi_name: string | null;
      models: number;
    }>(
      CATALOG_DB,
      `SELECT catalog_id, csi_section, csi_name, COUNT(DISTINCT model) AS models
         FROM products
        WHERE csi_section IS NOT NULL AND csi_section <> ''
        GROUP BY catalog_id, csi_section
        ORDER BY csi_section`,
    );

    const byCatalog = new Map<string, CatalogBook['csiSections']>();
    for (const row of sections) {
      const list = byCatalog.get(row.catalog_id) ?? [];
      list.push({ section: row.csi_section, name: row.csi_name, models: row.models });
      byCatalog.set(row.catalog_id, list);
    }

    return rows.map((row) => ({
      catalogId: row.catalog_id,
      vendor: row.vendor,
      folder: row.folder || row.vendor,
      path: row.path,
      file: basename(row.path),
      effective: row.effective,
      multiplierInFilename: row.multiplier,
      pages: row.pages,
      pagesParsed: row.pages_parsed,
      priceRows: row.price_rows,
      models: row.models,
      coverage: deriveCoverage(row.pages_parsed, row.pages),
      csiSections: byCatalog.get(row.catalog_id) ?? [],
    }));
  });
}

const COVERAGE_RANK: Record<Coverage, number> = { text_only: 0, partial: 1, structured: 2 };

export function listVendors(): Vendor[] {
  return memoizeOnIndex(CATALOG_DB, 'vendors', buildVendors);
}

function buildVendors(): Vendor[] {
  const grouped = new Map<string, Vendor>();

  for (const book of listBooks()) {
    const vendor = grouped.get(book.folder) ?? {
      folder: book.folder,
      vendor: book.vendor,
      books: [],
      pages: 0,
      priceRows: 0,
      models: 0,
      coverage: 'text_only' as Coverage,
    };
    vendor.books.push(book);
    vendor.pages += book.pages;
    vendor.priceRows += book.priceRows;
    vendor.models += book.models;
    if (COVERAGE_RANK[book.coverage] > COVERAGE_RANK[vendor.coverage]) {
      vendor.coverage = book.coverage;
    }
    grouped.set(book.folder, vendor);
  }

  return [...grouped.values()].sort((a, b) => b.priceRows - a.priceRows || a.folder.localeCompare(b.folder));
}

export function getVendor(folder: string): Vendor | null {
  const match = listVendors().find((v) => v.folder.toLowerCase() === folder.toLowerCase());
  return match ?? null;
}

export type ProductQuery = {
  folder?: string;
  /** "08" or a full section like "08 71 00". */
  division?: string;
  q?: string;
  limit?: number;
  offset?: number;
};

export function listProducts(query: ProductQuery): { rows: ProductRow[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.folder) {
    where.push('LOWER(COALESCE(c.folder, c.vendor)) = ?');
    params.push(query.folder.toLowerCase());
  }
  if (query.division) {
    const division = query.division.trim();
    if (division.length <= 2) {
      where.push('p.division = ?');
      params.push(division.padStart(2, '0'));
    } else {
      where.push('p.csi_section = ?');
      params.push(division);
    }
  }
  if (query.q?.trim()) {
    // The model index makes the leading-anchored term cheap; description is a scan.
    where.push('(UPPER(p.model) LIKE ? OR UPPER(p.description) LIKE ?)');
    const term = `%${query.q.trim().toUpperCase()}%`;
    params.push(term, term);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);

  const total =
    queryIndex<{ n: number }>(
      CATALOG_DB,
      `SELECT COUNT(*) AS n FROM products p JOIN catalogs c ON c.catalog_id = p.catalog_id ${clause}`,
      params,
    )[0]?.n ?? 0;

  const rows = queryIndex<{
    vendor: string;
    folder: string | null;
    model: string;
    description: string | null;
    size: string | null;
    finish: string | null;
    list_price: number | null;
    page: number;
    section: string | null;
    division: string | null;
    csi_section: string | null;
    csi_name: string | null;
  }>(
    CATALOG_DB,
    `SELECT c.vendor, c.folder, p.model, p.description, p.size, p.finish, p.list_price,
            p.page, p.section, p.division, p.csi_section, p.csi_name
       FROM products p JOIN catalogs c ON c.catalog_id = p.catalog_id
       ${clause}
      ORDER BY (p.model IS NULL OR p.model = ''), p.model, p.size, p.finish
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return {
    total,
    rows: rows.map((row) => ({
      vendor: row.vendor,
      folder: row.folder || row.vendor,
      model: row.model,
      description: row.description,
      size: row.size || null,
      finish: row.finish || null,
      listPrice: row.list_price,
      page: row.page,
      section: row.section,
      division: row.division,
      csiSection: row.csi_section,
      csiName: row.csi_name,
    })),
  };
}

export function divisionsForVendor(folder: string): { division: string; section: string; models: number }[] {
  return queryIndex<{ division: string; section: string; models: number }>(
    CATALOG_DB,
    `SELECT p.division AS division, p.csi_section AS section, COUNT(DISTINCT p.model) AS models
       FROM products p JOIN catalogs c ON c.catalog_id = p.catalog_id
      WHERE LOWER(COALESCE(c.folder, c.vendor)) = ? AND p.csi_section IS NOT NULL
      GROUP BY p.csi_section
      ORDER BY p.csi_section`,
    [folder.toLowerCase()],
  );
}

export type BookRef = { catalogId: string; file: string };

export type CatalogPage = {
  page: number;
  section: string | null;
  subsection: string | null;
  /** The number the book prints on itself, which rarely matches the PDF page. */
  printedPageNo: string | null;
  products: ProductRow[];
  /** Spatially ordered text; catint marks column breaks with a double pipe. */
  textRows: string[];
  /** Which book this page came from. A page number alone never identifies one. */
  book: BookRef;
  /** The vendor's other books that also have a page this deep - i.e. the ambiguity. */
  alsoIn: BookRef[];
};

const ref = (book: CatalogBook): BookRef => ({ catalogId: book.catalogId, file: book.file });

/**
 * Best book for a free-text hint ("#18", "Accessories", "2020 price list"), or null.
 * Scores on how many of the hint's tokens appear in the filename.
 */
function matchBook(books: CatalogBook[], hint: string): CatalogBook | null {
  const tokens = (hint.toUpperCase().match(/[A-Z0-9#.]{2,}/g) ?? []).filter(
    (token) => token !== 'PAGE' && token !== 'PG',
  );
  let best: CatalogBook | null = null;
  let bestScore = 0;
  for (const book of books) {
    const file = book.file.toUpperCase();
    const score = tokens.filter((token) => file.includes(token)).length;
    if (score > bestScore) {
      best = book;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * One page of a price book. This is what a `[catalog] Hager p.18` citation
 * resolves to, so it reads from the index rather than reopening the PDF -
 * no PyMuPDF, no MCP round trip.
 */
export function getCatalogPage(
  folder: string,
  page: number,
  bookHint?: string,
): CatalogPage | null {
  const vendor = getVendor(folder);
  if (!vendor) return null;

  // Only books long enough to have this page are candidates. Picking the first book
  // that merely had price rows meant a `[catalog] ROCKWOOD p.212` citation - and
  // ROCKWOOD has four books - opened whichever one happened to be long enough, showing
  // a real page from the wrong catalog under the vendor's name.
  const candidates = vendor.books.filter((b) => b.pages >= page);
  if (!candidates.length) return null;

  const book =
    (bookHint ? matchBook(candidates, bookHint) : null) ??
    candidates.find((b) => b.priceRows > 0) ??
    candidates[0]!;

  const meta = queryIndex<{ section: string | null; subsection: string | null; cat_page: string | null }>(
    CATALOG_DB,
    'SELECT section, subsection, cat_page FROM pages WHERE catalog_id = ? AND page = ?',
    [book.catalogId, page],
  )[0];

  const products = queryIndex<{
    model: string;
    description: string | null;
    size: string | null;
    finish: string | null;
    list_price: number | null;
    section: string | null;
    division: string | null;
    csi_section: string | null;
    csi_name: string | null;
  }>(
    CATALOG_DB,
    `SELECT model, description, size, finish, list_price, section, division, csi_section, csi_name
       FROM products WHERE catalog_id = ? AND page = ? ORDER BY model, size, finish`,
    [book.catalogId, page],
  );

  const body =
    queryIndex<{ body: string }>(
      CATALOG_DB,
      'SELECT body FROM page_text WHERE catalog_id = ? AND page = ? LIMIT 1',
      [book.catalogId, page],
    )[0]?.body ?? '';

  return {
    page,
    section: meta?.section ?? null,
    subsection: meta?.subsection ?? null,
    printedPageNo: meta?.cat_page ?? null,
    book: ref(book),
    alsoIn: candidates.filter((b) => b.catalogId !== book.catalogId).map(ref),
    textRows: body ? body.split('\n').filter((line) => line.trim()) : [],
    products: products.map((row) => ({
      vendor: book.vendor,
      folder: book.folder,
      model: row.model,
      description: row.description,
      size: row.size || null,
      finish: row.finish || null,
      listPrice: row.list_price,
      page,
      section: row.section,
      division: row.division,
      csiSection: row.csi_section,
      csiName: row.csi_name,
    })),
  };
}

/** Full-text hit inside a price book. Used by the command palette. */
export function searchBookText(q: string, limit = 8): { folder: string; vendor: string; page: number; snippet: string }[] {
  const expression = ftsQuery(q);
  if (!expression) return [];
  return queryIndex<{ folder: string; vendor: string; page: number; snippet: string }>(
    CATALOG_DB,
    `SELECT COALESCE(c.folder, c.vendor) AS folder, c.vendor, t.page,
            snippet(page_text, 3, '', '', '…', 12) AS snippet
       FROM page_text t JOIN catalogs c ON c.catalog_id = t.catalog_id
      WHERE page_text MATCH ?
      ORDER BY rank
      LIMIT ?`,
    [expression, limit],
  );
}
