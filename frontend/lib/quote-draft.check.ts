/**
 * Quote-draft check. Run with `npm run check:quote-draft`.
 *
 * Covers the pure logic between the database rows and the workbook: which lines make it
 * into an export, where a `custom` line lands, and the header the export carries. The
 * database-touching paths (`patchQuoteLine`, `addQuoteLine`, `markDraftApproved`) are
 * guarded by SQL and exercised end to end, not here - this file needs no Postgres.
 */
import assert from 'node:assert/strict';
import { quotationFromDraft, type QuoteDraftRow, type QuoteLineRow } from './quote-draft.ts';

const HEADER = {
  projectName: 'Baldwin PA',
  planSet: 'Rev 4',
  clientAccount: 'Hamilton Parker',
  address: '1 Main St',
  quoteDate: '2026-08-08',
  projectState: 'OH',
  statusLine: '',
  phoneFax: '',
  salesTaxLabel: 'Sales Tax (8.0%):',
  salesTaxAmount: 12.5,
  freightNote: 'TBD (Excluded)',
  terms: ['1. Supply only.'],
  rfis: ['Confirm hardware set HW-2.'],
};

const draft: QuoteDraftRow = {
  id: 'd1',
  run_id: 'r1',
  project_id: 'p1',
  header: HEADER,
  status: 'draft',
  created_at: '2026-08-08T00:00:00Z',
  updated_at: '2026-08-08T00:00:00Z',
};

let n = 0;
function line(partial: Partial<QuoteLineRow>): QuoteLineRow {
  n += 1;
  return {
    id: `l${n}`,
    draft_id: 'd1',
    section: 'door',
    sort_order: 0,
    tag: `T${n}`,
    room: 'Corridor',
    description: 'Hollow metal door',
    qty: 1,
    unit: 'EA',
    unit_sale: 100,
    cost_basis: 'catalog_list_x_multiplier',
    citations: '[catalog] Hager p.42',
    confidence: 'HIGH',
    acceptance: 'pending',
    pricing_status: 'priced',
    price_freshness: 'fresh',
    substitution_notes: null,
    unit_cost: 73,
    margin_rate: 0.27,
    deleted_at: null,
    created_at: '2026-08-08T00:00:00Z',
    updated_at: '2026-08-08T00:00:00Z',
    ...partial,
  };
}

// --- what reaches an export -------------------------------------------------
// D2 is listed before D1 on purpose: sort_order decides, not arrival order.
const lines = [
  line({ section: 'door', sort_order: 1, tag: 'D2', acceptance: 'accepted' }),
  line({ section: 'door', sort_order: 0, tag: 'D1', acceptance: 'accepted' }),
  line({ section: 'door', sort_order: 2, tag: 'DEL', acceptance: 'accepted', deleted_at: '2026-08-08T01:00:00Z' }),
  line({ section: 'door', sort_order: 3, tag: 'REJ', acceptance: 'rejected' }),
  line({ section: 'door', sort_order: 4, tag: 'PEND', acceptance: 'pending' }),
  line({ section: 'accessory', sort_order: 0, tag: 'A1', acceptance: 'accepted' }),
  line({ section: 'frp', sort_order: 0, tag: 'F1', acceptance: 'accepted' }),
  line({ section: 'custom', sort_order: 0, tag: 'C1', room: '', acceptance: 'accepted' }),
];

const drafted = quotationFromDraft(draft, lines);
const tags = (list: { tag: string }[]) => list.map((l) => l.tag);

// A deleted or rejected line is never exported, in either mode.
assert.ok(!tags(drafted.doorLines).includes('DEL'), 'a deleted line reached the export');
assert.ok(!tags(drafted.doorLines).includes('REJ'), 'a rejected line reached the export');

// Draft mode keeps pending lines; approved mode keeps only accepted ones.
assert.deepEqual(tags(drafted.doorLines), ['D1', 'D2', 'PEND']);
const approved = quotationFromDraft(draft, lines, { acceptedOnly: true });
assert.deepEqual(tags(approved.doorLines), ['D1', 'D2']);

// sort_order decides row order, not the order rows came back in.
assert.deepEqual(tags(drafted.doorLines).slice(0, 2), ['D1', 'D2']);

// `custom` has no section of its own in the workbook - it rides with accessories,
// and a custom line with no room gets a readable one rather than an empty cell.
assert.deepEqual(tags(drafted.accessoryLines), ['A1', 'C1']);
assert.equal(drafted.accessoryLines.at(-1)!.room, 'Custom / Other');
assert.deepEqual(tags(drafted.frpLines), ['F1']);

// --- header ----------------------------------------------------------------
// The status line is the one header field the export overrides, so a downloaded
// workbook always says which of the two it is.
assert.equal(approved.statusLine, 'APPROVED — Ready for CBC export');
assert.equal(drafted.statusLine, 'DRAFT — For CBC Estimator Review');

// Tax, freight, terms and the RFI register carry through untouched - they are the
// audit trail, and a silently dropped RFI is a question nobody answers.
assert.equal(drafted.salesTaxAmount, 12.5);
assert.equal(drafted.salesTaxLabel, 'Sales Tax (8.0%):');
assert.equal(drafted.freightNote, 'TBD (Excluded)');
assert.deepEqual(drafted.rfis, ['Confirm hardware set HW-2.']);
assert.deepEqual(drafted.terms, ['1. Supply only.']);
assert.equal(drafted.projectName, 'Baldwin PA');

// An empty draft still produces a well-formed quotation rather than throwing.
const empty = quotationFromDraft(draft, []);
assert.deepEqual(empty.doorLines, []);
assert.deepEqual(empty.accessoryLines, []);
assert.equal(empty.projectName, 'Baldwin PA');

console.log('quote draft check passed');
