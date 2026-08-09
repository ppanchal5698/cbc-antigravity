import { basename } from 'node:path';
import { ftsQuery, openIndex, PLAN_DB, queryIndex } from './workspace-db';

/**
 * The indexed plan sets, read from building-plan-intelligence's index.
 *
 * `doc_id` includes the absolute path, so the same bid set indexed from three
 * directories appears three times. Deduplicate on `stamp` (mtime:size), which
 * identifies the file itself.
 */

export type PlanDoc = {
  docId: string;
  path: string;
  file: string;
  pages: number;
  indexedAt: number;
  stamp: string;
  /** Other doc_ids for the same physical file, folded into this one. */
  duplicates: number;
};

export type PlanSheet = {
  docId: string;
  page: number;
  sheetNo: string | null;
  title: string | null;
  discipline: string | null;
  /** title_block | bookmark | none - how the sheet number was identified. */
  confidence: string | null;
  /** none | identity | full - whether a vision pass is still needed. */
  visionNeed: string | null;
  widthIn: number | null;
  heightIn: number | null;
};

export function planIndexReady(): boolean {
  return openIndex(PLAN_DB) !== null;
}

export function listDocs(): PlanDoc[] {
  const rows = queryIndex<{
    doc_id: string;
    path: string;
    pages: number;
    indexed_at: number;
    stamp: string;
  }>(PLAN_DB, 'SELECT doc_id, path, pages, indexed_at, stamp FROM docs ORDER BY indexed_at DESC');

  // Newest wins; older duplicates of the same file are counted, not listed.
  const byStamp = new Map<string, PlanDoc>();
  for (const row of rows) {
    const existing = byStamp.get(row.stamp);
    if (existing) {
      existing.duplicates += 1;
      continue;
    }
    byStamp.set(row.stamp, {
      docId: row.doc_id,
      path: row.path,
      file: basename(row.path),
      pages: row.pages,
      indexedAt: row.indexed_at,
      stamp: row.stamp,
      duplicates: 0,
    });
  }
  return [...byStamp.values()];
}

/**
 * How many sheets are indexed, without materializing them.
 *
 * The overview page called `listSheets()` and read `.length`, pulling every row of
 * every indexed set across the process boundary to render one number.
 */
export function countSheets(docId?: string): number {
  const ids = docId ? [docId] : listDocs().map((doc) => doc.docId);
  if (!ids.length) return 0;
  const placeholders = ids.map(() => '?').join(', ');
  return (
    queryIndex<{ n: number }>(
      PLAN_DB,
      `SELECT COUNT(*) AS n FROM sheets WHERE doc_id IN (${placeholders})`,
      ids,
    )[0]?.n ?? 0
  );
}

export function listSheets(docId?: string): PlanSheet[] {
  const docs = listDocs();
  const ids = docId ? [docId] : docs.map((doc) => doc.docId);
  if (!ids.length) return [];

  const placeholders = ids.map(() => '?').join(', ');
  const rows = queryIndex<{
    doc_id: string;
    page: number;
    sheet_no: string | null;
    title: string | null;
    discipline: string | null;
    confidence: string | null;
    vision_need: string | null;
    width_in: number | null;
    height_in: number | null;
  }>(
    PLAN_DB,
    `SELECT doc_id, page, sheet_no, title, discipline, confidence, vision_need, width_in, height_in
       FROM sheets WHERE doc_id IN (${placeholders}) ORDER BY doc_id, page`,
    ids,
  );

  return rows.map((row) => ({
    docId: row.doc_id,
    page: row.page,
    sheetNo: row.sheet_no,
    title: row.title,
    discipline: row.discipline,
    confidence: row.confidence,
    visionNeed: row.vision_need,
    widthIn: row.width_in,
    heightIn: row.height_in,
  }));
}

/** Sheet-number lookup for a `[schedule] Sheet A1.1` citation. */
export function findSheets(q: string, limit = 8): PlanSheet[] {
  const term = q.trim().toUpperCase();
  if (!term) return [];
  const ids = listDocs().map((doc) => doc.docId);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');

  return queryIndex<PlanSheet & Record<string, never>>(
    PLAN_DB,
    `SELECT doc_id AS "docId", page, sheet_no AS "sheetNo", title, discipline,
            confidence, vision_need AS "visionNeed", width_in AS "widthIn", height_in AS "heightIn"
       FROM sheets
      WHERE doc_id IN (${placeholders})
        AND (UPPER(COALESCE(sheet_no, '')) LIKE ? OR UPPER(COALESCE(title, '')) LIKE ?)
      ORDER BY CASE WHEN UPPER(COALESCE(sheet_no, '')) = ? THEN 0 ELSE 1 END, page
      LIMIT ?`,
    [...ids, `%${term}%`, `%${term}%`, term, limit],
  );
}

/** Full-text search across sheet bodies. */
export function searchSheetText(q: string, limit = 8): { docId: string; page: number; snippet: string }[] {
  const expression = ftsQuery(q);
  if (!expression) return [];
  return queryIndex<{ docId: string; page: number; snippet: string }>(
    PLAN_DB,
    `SELECT doc_id AS "docId", page, snippet(sheet_text, 3, '', '', '…', 12) AS snippet
       FROM sheet_text WHERE sheet_text MATCH ? ORDER BY rank LIMIT ?`,
    [expression, limit],
  );
}
