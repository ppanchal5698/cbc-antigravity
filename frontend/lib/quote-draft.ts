/**
 * Persistable FR-9 quote drafts. The workbook is regenerated from these rows.
 */
import { writeFile } from 'node:fs/promises';
import { query, withTransaction } from './db.ts';
import { recordCorrection } from './corrections.ts';
import {
  type LineConfidence,
  type PriceFreshness,
  type PricingStatus,
  type QuotationData,
  type QuotationLine,
  buildQuotationWorkbook,
} from './xlsx/quotation.ts';

export type { LineConfidence, PriceFreshness, PricingStatus };

export type QuoteSection = 'door' | 'accessory' | 'frp' | 'custom';
export type LineAcceptance = 'pending' | 'accepted' | 'rejected';
export type DraftStatus = 'draft' | 'approved';

export type QuoteDraftHeader = {
  projectName: string;
  planSet: string;
  clientAccount: string;
  address: string;
  quoteDate: string;
  projectState: string;
  statusLine: string;
  phoneFax: string;
  salesTaxLabel: string;
  salesTaxAmount: number;
  /** Engine decimal rate when known; older drafts may omit it. */
  salesTaxRate?: number | null;
  freightNote: string;
  terms: string[];
  rfis: string[];
};

export type QuoteDraftRow = {
  id: string;
  run_id: string;
  project_id: string;
  header: QuoteDraftHeader;
  status: DraftStatus;
  created_at: string;
  updated_at: string;
};

export type QuoteLineRow = {
  id: string;
  draft_id: string;
  section: QuoteSection;
  sort_order: number;
  tag: string;
  room: string;
  description: string;
  qty: number;
  unit: string;
  unit_sale: number;
  cost_basis: string;
  citations: string;
  confidence: LineConfidence | null;
  acceptance: LineAcceptance;
  pricing_status: PricingStatus;
  price_freshness: PriceFreshness | null;
  substitution_notes: string | null;
  unit_cost: number | null;
  margin_rate: number | null;
  quantity_source: string | null;
  size_source: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

function headerFromQuotation(q: QuotationData): QuoteDraftHeader {
  return {
    projectName: q.projectName,
    planSet: q.planSet,
    clientAccount: q.clientAccount,
    address: q.address,
    quoteDate: q.quoteDate,
    projectState: q.projectState,
    statusLine: q.statusLine,
    phoneFax: q.phoneFax,
    salesTaxLabel: q.salesTaxLabel,
    salesTaxAmount: q.salesTaxAmount,
    salesTaxRate: q.salesTaxRate ?? null,
    freightNote: q.freightNote,
    terms: q.terms,
    rfis: q.rfis,
  };
}

function linePayload(
  section: QuoteSection,
  sortOrder: number,
  line: QuotationLine,
): unknown[] {
  return [
    section,
    sortOrder,
    line.tag,
    line.room,
    line.description,
    line.qty,
    line.unit,
    line.unitSale,
    line.costBasis,
    line.citations,
    line.confidence ?? null,
    'pending',
    line.pricingStatus ?? 'priced',
    line.priceFreshness ?? null,
    line.substitutionNotes ?? null,
    line.unitCost ?? null,
    line.marginRate ?? null,
    line.quantitySource ?? null,
    line.sizeSource ?? null,
  ];
}

/** Inserts a draft + lines for a completed run. Replaces any prior draft for the run. */
export async function persistQuotationDraft(
  runId: string,
  projectId: string,
  quotation: QuotationData,
): Promise<string> {
  return withTransaction(async (client) => {
    await client.query('DELETE FROM quote_drafts WHERE run_id = $1', [runId]);
    const draftResult = await client.query<{ id: string }>(
      `INSERT INTO quote_drafts (run_id, project_id, header, status)
       VALUES ($1, $2, $3::jsonb, 'draft')
       RETURNING id`,
      [runId, projectId, JSON.stringify(headerFromQuotation(quotation))],
    );
    const draftId = draftResult.rows[0]!.id;

    const batches: { section: QuoteSection; lines: QuotationLine[] }[] = [
      { section: 'door', lines: quotation.doorLines },
      { section: 'accessory', lines: quotation.accessoryLines },
      { section: 'frp', lines: quotation.frpLines },
    ];

    // One statement per chunk rather than one per line. A large bid set was hundreds of
    // sequential round-trips, all on the critical path of an estimate that has just
    // finished running.
    const rows = batches.flatMap((batch) =>
      batch.lines.map((line, i) => [draftId, ...linePayload(batch.section, i, line)]),
    );
    const COLUMNS = 20;
    const CHUNK = 500; // 9000 parameters, well inside Postgres's 65535 limit

    for (let start = 0; start < rows.length; start += CHUNK) {
      const chunk = rows.slice(start, start + CHUNK);
      const tuples = chunk.map(
        (_, r) =>
          `(${Array.from({ length: COLUMNS }, (_, c) => `$${r * COLUMNS + c + 1}`).join(',')})`,
      );
      await client.query(
        `INSERT INTO quote_lines (
           draft_id, section, sort_order, tag, room, description, qty, unit,
           unit_sale, cost_basis, citations, confidence, acceptance,
           pricing_status, price_freshness, substitution_notes, unit_cost, margin_rate,
           quantity_source, size_source
         ) VALUES ${tuples.join(',')}`,
        chunk.flat(),
      );
    }

    return draftId;
  });
}

export async function getDraftByRunId(
  runId: string,
): Promise<{ draft: QuoteDraftRow; lines: QuoteLineRow[] } | null> {
  const drafts = await query<QuoteDraftRow>(
    `SELECT id, run_id, project_id, header, status,
            created_at::text, updated_at::text
       FROM quote_drafts WHERE run_id = $1`,
    [runId],
  );
  const draft = drafts[0];
  if (!draft) return null;

  const lines = await query<QuoteLineRow>(
    `SELECT id, draft_id, section, sort_order, tag, room, description, qty, unit,
            unit_sale, cost_basis, citations, confidence, acceptance, pricing_status,
            price_freshness, substitution_notes, unit_cost, margin_rate,
            quantity_source, size_source,
            deleted_at::text, created_at::text, updated_at::text
       FROM quote_lines
      WHERE draft_id = $1
      ORDER BY section, sort_order, created_at`,
    [draft.id],
  );

  return { draft, lines };
}

function rowToQuotationLine(row: QuoteLineRow): QuotationLine {
  return {
    tag: row.tag,
    room: row.section === 'custom' && !row.room ? 'Custom / Other' : row.room,
    description: row.description,
    qty: row.qty,
    unit: row.unit,
    unitSale: row.unit_sale,
    costBasis: row.cost_basis,
    citations: row.citations,
    confidence: row.confidence,
    pricingStatus: row.pricing_status,
    priceFreshness: row.price_freshness,
    substitutionNotes: row.substitution_notes,
    unitCost: row.unit_cost,
    marginRate: row.margin_rate,
    quantitySource: row.quantity_source,
    sizeSource: row.size_source,
  };
}

/** Builds QuotationData for xlsx export. Excludes deleted and rejected lines. */
export function quotationFromDraft(
  draft: QuoteDraftRow,
  lines: QuoteLineRow[],
  opts: { acceptedOnly?: boolean } = {},
): QuotationData {
  const active = lines.filter((line) => {
    if (line.deleted_at) return false;
    if (line.acceptance === 'rejected') return false;
    if (opts.acceptedOnly && line.acceptance !== 'accepted') return false;
    return true;
  });

  const by = (section: QuoteSection) =>
    active
      .filter((line) => line.section === section)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(rowToQuotationLine);

  const customAsAccessory = by('custom');
  const header = draft.header;

  return {
    projectName: header.projectName,
    planSet: header.planSet,
    clientAccount: header.clientAccount,
    address: header.address,
    quoteDate: header.quoteDate,
    projectState: header.projectState,
    statusLine: opts.acceptedOnly
      ? 'APPROVED — Ready for CBC export'
      : header.statusLine || 'DRAFT — For CBC Estimator Review',
    phoneFax: header.phoneFax,
    doorLines: by('door'),
    accessoryLines: [...by('accessory'), ...customAsAccessory],
    frpLines: by('frp'),
    salesTaxLabel: header.salesTaxLabel,
    salesTaxAmount: header.salesTaxAmount,
    salesTaxRate: header.salesTaxRate ?? null,
    freightNote: header.freightNote,
    terms: header.terms,
    rfis: header.rfis,
  };
}

export async function regenerateWorkbook(
  outputPath: string,
  draft: QuoteDraftRow,
  lines: QuoteLineRow[],
  opts: { acceptedOnly?: boolean } = {},
): Promise<void> {
  const quotation = quotationFromDraft(draft, lines, opts);
  await buildQuotationWorkbook(quotation).xlsx.writeFile(outputPath);
}

/** The `.pdf` beside a run's `.xlsx`. Same stem, so the pair is obviously a pair. */
export function pdfPathFor(workbookPath: string): string {
  return workbookPath.replace(/\.xlsx$/i, '') + '.pdf';
}

/**
 * FR-10: the approved quote in the customer-facing format.
 *
 * Rendered from the same `QuotationData` as the workbook, in the same call, so the two can
 * never describe different totals. Failure is reported, not swallowed — but it does not
 * roll back the approval, because the workbook is already written and the draft is already
 * locked; re-approving to retry would be refused as a replay.
 */
export async function regenerateQuoteDocuments(
  workbookPath: string,
  draft: QuoteDraftRow,
  lines: QuoteLineRow[],
  opts: { acceptedOnly?: boolean } = {},
): Promise<{ workbookPath: string; pdfPath: string | null; pdfError: string | null }> {
  const quotation = quotationFromDraft(draft, lines, opts);
  await buildQuotationWorkbook(quotation).xlsx.writeFile(workbookPath);

  const pdfPath = pdfPathFor(workbookPath);
  try {
    const { buildQuotationPdf } = await import('./pdf/quotation-pdf.ts');
    await writeFile(pdfPath, await buildQuotationPdf(quotation));
    return { workbookPath, pdfPath, pdfError: null };
  } catch (err) {
    const pdfError = err instanceof Error ? err.message : String(err);
    console.error('[quote] PDF render failed:', pdfError);
    return { workbookPath, pdfPath: null, pdfError };
  }
}

export type LinePatch = {
  tag?: string;
  room?: string;
  description?: string;
  qty?: number;
  unit?: string;
  unit_sale?: number;
  cost_basis?: string;
  citations?: string;
  confidence?: LineConfidence | null;
  acceptance?: LineAcceptance;
  pricing_status?: PricingStatus;
  price_freshness?: PriceFreshness | null;
  substitution_notes?: string | null;
  unit_cost?: number | null;
  margin_rate?: number | null;
  quantity_source?: string | null;
  size_source?: string | null;
  deleted?: boolean;
};

/**
 * Why a write was refused. `approved` is the lock: once a draft is approved the
 * workbook has been generated from it, and a line edit afterwards would leave the
 * exported .xlsx describing something nobody signed off.
 */
export type DraftWriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not_found' | 'approved' };

export async function patchQuoteLine(
  lineId: string,
  patch: LinePatch,
): Promise<DraftWriteResult<QuoteLineRow>> {
  // The draft status is joined in rather than checked in the route: `addQuoteLine` and
  // this both mutate an approved draft, and a guard in one route left the other open.
  const existing = await query<QuoteLineRow & { draft_status: DraftStatus }>(
    `SELECT l.id, l.draft_id, l.section, l.sort_order, l.tag, l.room, l.description,
            l.qty, l.unit, l.unit_sale, l.cost_basis, l.citations, l.confidence,
            l.acceptance, l.pricing_status, l.price_freshness, l.substitution_notes,
            l.unit_cost, l.margin_rate, l.quantity_source, l.size_source,
            l.deleted_at::text, l.created_at::text, l.updated_at::text,
            d.status AS draft_status
       FROM quote_lines l
       JOIN quote_drafts d ON d.id = l.draft_id
      WHERE l.id = $1`,
    [lineId],
  );
  const row = existing[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.draft_status === 'approved') return { ok: false, reason: 'approved' };

  const next = {
    tag: patch.tag ?? row.tag,
    room: patch.room ?? row.room,
    description: patch.description ?? row.description,
    qty: patch.qty ?? row.qty,
    unit: patch.unit ?? row.unit,
    unit_sale: patch.unit_sale ?? row.unit_sale,
    cost_basis: patch.cost_basis ?? row.cost_basis,
    citations: patch.citations ?? row.citations,
    confidence: patch.confidence !== undefined ? patch.confidence : row.confidence,
    acceptance: patch.acceptance ?? row.acceptance,
    pricing_status: patch.pricing_status ?? row.pricing_status,
    price_freshness:
      patch.price_freshness !== undefined ? patch.price_freshness : row.price_freshness,
    substitution_notes:
      patch.substitution_notes !== undefined
        ? patch.substitution_notes
        : row.substitution_notes,
    unit_cost: patch.unit_cost !== undefined ? patch.unit_cost : row.unit_cost,
    margin_rate: patch.margin_rate !== undefined ? patch.margin_rate : row.margin_rate,
    // An estimator who changes a quantity owns it from then on. Leaving the old
    // `schedule:A1.2` attached would credit the drawing for a number a human overrode -
    // the provenance has to follow the edit or it stops meaning anything.
    quantity_source:
      patch.quantity_source !== undefined
        ? patch.quantity_source
        : patch.qty !== undefined && patch.qty !== row.qty
          ? 'estimator_confirmed'
          : row.quantity_source,
    size_source: patch.size_source !== undefined ? patch.size_source : row.size_source,
    deleted_at: patch.deleted === true ? new Date().toISOString() : patch.deleted === false ? null : row.deleted_at,
  };

  const updated = await query<QuoteLineRow>(
    `UPDATE quote_lines SET
       tag = $2, room = $3, description = $4, qty = $5, unit = $6,
       unit_sale = $7, cost_basis = $8, citations = $9, confidence = $10,
       acceptance = $11, pricing_status = $12, price_freshness = $13,
       substitution_notes = $14, unit_cost = $15, margin_rate = $16,
       quantity_source = $17, size_source = $18,
       deleted_at = $19, updated_at = now()
     WHERE id = $1
     RETURNING id, draft_id, section, sort_order, tag, room, description, qty, unit,
               unit_sale, cost_basis, citations, confidence, acceptance, pricing_status,
               price_freshness, substitution_notes, unit_cost, margin_rate,
               quantity_source, size_source,
               deleted_at::text, created_at::text, updated_at::text`,
    [
      lineId,
      next.tag,
      next.room,
      next.description,
      next.qty,
      next.unit,
      next.unit_sale,
      next.cost_basis,
      next.citations,
      next.confidence,
      next.acceptance,
      next.pricing_status,
      next.price_freshness,
      next.substitution_notes,
      next.unit_cost,
      next.margin_rate,
      next.quantity_source,
      next.size_source,
      next.deleted_at,
    ],
  );

  await query(`UPDATE quote_drafts SET updated_at = now() WHERE id = $1`, [row.draft_id]);
  const line = updated[0];
  if (!line) return { ok: false, reason: 'not_found' };

  // An estimator changing what a line IS is the signal the graph learns from, and this is
  // the only place in the app where that happens. Phase 5 and the OKF rules both describe
  // the override being appended to corrections.jsonl and ingested; neither ran, so the
  // graph had learned nothing since the file was seeded.
  //
  // After the UPDATE, never before: a correction recorded for an edit that then failed to
  // commit would teach the graph something that never happened. And awaited rather than
  // fired-and-forgotten so the failure is logged, not swallowed.
  await recordCorrection(
    { tag: row.tag, description: row.description, section: row.section },
    { description: patch.description, substitution_notes: next.substitution_notes },
    await projectOf(row.draft_id),
  ).catch((err: unknown) => {
    console.error('[corrections]', err instanceof Error ? err.message : err);
    return null;
  });

  return { ok: true, value: line };
}

/** The project a draft belongs to, for the correction record's `project` field. */
async function projectOf(draftId: string): Promise<string> {
  const rows = await query<{ name: string }>(
    `SELECT p.name FROM quote_drafts d JOIN projects p ON p.id = d.project_id WHERE d.id = $1`,
    [draftId],
  ).catch(() => []);
  return rows[0]?.name ?? 'unknown';
}

export async function addQuoteLine(
  draftId: string,
  input: {
    section: QuoteSection;
    tag?: string;
    room?: string;
    description?: string;
    qty?: number;
    unit?: string;
    unit_sale?: number;
    cost_basis?: string;
    citations?: string;
    pricing_status?: PricingStatus;
    substitution_notes?: string | null;
  },
): Promise<DraftWriteResult<QuoteLineRow>> {
  const drafts = await query<{ status: DraftStatus }>(
    'SELECT status FROM quote_drafts WHERE id = $1',
    [draftId],
  );
  if (!drafts[0]) return { ok: false, reason: 'not_found' };
  if (drafts[0].status === 'approved') return { ok: false, reason: 'approved' };

  const max = await query<{ max: number | null }>(
    `SELECT MAX(sort_order) AS max FROM quote_lines WHERE draft_id = $1 AND section = $2`,
    [draftId, input.section],
  );
  const sortOrder = (max[0]?.max ?? -1) + 1;

  const rows = await query<QuoteLineRow>(
    `INSERT INTO quote_lines (
       draft_id, section, sort_order, tag, room, description, qty, unit,
       unit_sale, cost_basis, citations, acceptance, pricing_status, substitution_notes,
       quantity_source
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13,'estimator_confirmed')
     RETURNING id, draft_id, section, sort_order, tag, room, description, qty, unit,
               unit_sale, cost_basis, citations, confidence, acceptance, pricing_status,
               price_freshness, substitution_notes, unit_cost, margin_rate,
               quantity_source, size_source,
               deleted_at::text, created_at::text, updated_at::text`,
    [
      draftId,
      input.section,
      sortOrder,
      input.tag ?? '',
      input.room ?? (input.section === 'custom' ? 'Custom / Other' : ''),
      input.description ?? '',
      input.qty ?? 1,
      input.unit ?? 'EA',
      input.unit_sale ?? 0,
      input.cost_basis ?? 'manual_wholesaler_net',
      input.citations ?? '[manual entry]',
      input.pricing_status ?? 'manual_entry_required',
      input.substitution_notes ?? null,
    ],
  );

  await query(`UPDATE quote_drafts SET updated_at = now() WHERE id = $1`, [draftId]);
  return { ok: true, value: rows[0]! };
}

/**
 * Flips a draft to `approved`, but only from `draft`. Returns null when the draft is
 * gone or was already approved, so a replayed approve cannot regenerate the workbook
 * a second time under a different set of lines.
 */
export async function markDraftApproved(draftId: string): Promise<QuoteDraftRow | null> {
  const rows = await query<QuoteDraftRow>(
    `UPDATE quote_drafts
        SET status = 'approved',
            header = jsonb_set(header, '{statusLine}', '"APPROVED — Ready for CBC export"'),
            updated_at = now()
      WHERE id = $1 AND status = 'draft'
      RETURNING id, run_id, project_id, header, status,
                created_at::text, updated_at::text`,
    [draftId],
  );
  return rows[0] ?? null;
}
