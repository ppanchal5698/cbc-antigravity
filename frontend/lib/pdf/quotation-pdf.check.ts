/**
 * FR-10 PDF check. Run with `npm run check:pdf`.
 *
 * The risk this guards is not "does pdfkit emit bytes" — it is that the PDF and the
 * workbook are two renderers of one quote, and a quote whose two documents disagree about
 * a total is worse than having only one. So the figures are read back out of the rendered
 * file and compared with the same arithmetic the workbook's formulas perform.
 */
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { buildQuotationPdf } from './quotation-pdf.ts';
import { standardTerms, type QuotationData, type QuotationLine } from '../xlsx/quotation.ts';

const line = (o: Partial<QuotationLine> = {}): QuotationLine => ({
  tag: '01',
  room: 'DINING',
  description: 'HM door and frame',
  qty: 2,
  unit: 'EA',
  unitSale: 336.08,
  costBasis: 'catalog_list_x_multiplier',
  citations: '[schedule] A2.2',
  ...o,
});

const data: QuotationData = {
  projectName: 'Baldwin PA',
  planSet: 'set.pdf',
  clientAccount: 'Standard Commercial',
  address: 'Baldwin, PA',
  quoteDate: '2026-08-12',
  projectState: 'PA',
  statusLine: 'APPROVED — Ready for CBC export',
  phoneFax: '',
  doorLines: [line(), line({ tag: '02', qty: 1, unitSale: 672.16 })],
  accessoryLines: [
    line({ tag: 'B-262', description: 'Paper towel dispenser', qty: 2, unitSale: 81.14 }),
  ],
  frpLines: [line({ tag: 'WF-1', description: 'FRP panel', qty: 41, unitSale: 83.88 })],
  salesTaxLabel: 'PA Sales Tax (0.0%):',
  salesTaxAmount: 0,
  freightNote: 'TBD (Excluded)',
  terms: standardTerms('PA Sales Tax (0.0%)'),
  rfis: ['FRP constants provisional (Open Item 5)'],
};

/**
 * The text a reader would see.
 *
 * pdfkit deflates its content streams, so the figures are not in the raw bytes — an
 * assertion against those would pass or fail for reasons unrelated to what the page says.
 * Inflating every stream is what makes this a check about the document.
 */
function visibleText(pdf: Buffer): string {
  let operators = '';
  let at = 0;

  // Walk the Buffer, not a decoded string: the streams are binary and a round-trip
  // through any encoding risks changing the bytes zlib is handed.
  for (;;) {
    const open = pdf.indexOf('stream', at);
    if (open < 0) break;
    // "endstream" contains "stream" too; skip those hits.
    if (pdf.subarray(open - 3, open).toString('latin1') === 'end') {
      at = open + 'stream'.length;
      continue;
    }
    let from = open + 'stream'.length;
    while (pdf[from] === 13 || pdf[from] === 10) from += 1;
    const close = pdf.indexOf('endstream', from);
    if (close < 0) break;
    // Trailing EOL before `endstream` is delimiter, not deflate payload.
    let end = close;
    while (end > from && (pdf[end - 1] === 10 || pdf[end - 1] === 13)) end -= 1;
    try {
      operators += inflateSync(pdf.subarray(from, end)).toString('latin1');
    } catch {
      operators += pdf.subarray(from, end).toString('latin1');
    }
    at = close + 'endstream'.length;
  }

  // pdfkit writes show-text operands as hex strings — `[<434f4e...>] TJ` is "CON...".
  // Decoding them is the difference between checking the document and checking its
  // container; searching the raw operators for "4,945.68" would never match.
  let out = '';
  let cursor = 0;
  for (;;) {
    const lt = operators.indexOf('<', cursor);
    if (lt < 0) break;
    const gt = operators.indexOf('>', lt);
    if (gt < 0) break;
    const hex = operators.slice(lt + 1, gt).replace(/\s+/g, '');
    if (hex.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(hex)) {
      out += Buffer.from(hex, 'hex').toString('latin1');
    }
    cursor = gt + 1;
  }
  return out;
}

const pdf = await buildQuotationPdf(data);
assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', 'must be a PDF');
assert.ok(pdf.length > 1000, 'suspiciously small render');

// One page for a quote this size. The footer writes below the bottom margin, and pdfkit
// auto-paginates on that — which silently appended a blank page carrying only "Page 1 of 1".
const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
assert.equal(pages, 1, `expected 1 page, got ${pages} — is the footer paginating again?`);

// --- the PDF's totals are the workbook's totals ----------------------------
const ext = (l: QuotationLine) => Math.round(l.qty * l.unitSale * 100) / 100;
const sum = (ls: QuotationLine[]) => ls.reduce((t, l) => t + ext(l), 0);
const base =
  Math.round((sum(data.doorLines) + sum(data.accessoryLines) + sum(data.frpLines)) * 100) / 100;
assert.equal(base, 4945.68, 'fixture arithmetic changed; update the expectation deliberately');

const text = visibleText(pdf);
const fmt = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

for (const total of [base, sum(data.doorLines), sum(data.frpLines)]) {
  assert.ok(
    text.includes(fmt(total)) || text.includes(total.toFixed(2)),
    `total ${fmt(total)} does not appear in the rendered PDF`,
  );
}

// The audit trail is what makes a customer-facing line checkable; it must survive.
assert.ok(text.includes('A2.2'), 'plan citations must reach the PDF');
assert.ok(text.includes('CONSTRUCTION BUILDING COMPONENTS'), 'letterhead missing');
assert.ok(text.includes('Supply-Only'), 'standard commercial terms missing');

// --- a draft says so -------------------------------------------------------
const draft = await buildQuotationPdf({
  ...data,
  statusLine: 'DRAFT — For CBC Estimator Review',
});
assert.ok(
  visibleText(draft).includes('DRAFT'),
  'a draft PDF must be marked as one - it is the document that gets forwarded',
);

// --- an empty quote still renders ------------------------------------------
// Every line rejected is a real state, and it must not throw on the way out.
const empty = await buildQuotationPdf({
  ...data,
  doorLines: [],
  accessoryLines: [],
  frpLines: [],
  rfis: [],
  terms: [],
});
assert.equal(empty.subarray(0, 5).toString(), '%PDF-', 'an empty quote must still render');

console.log('quotation pdf check passed');
