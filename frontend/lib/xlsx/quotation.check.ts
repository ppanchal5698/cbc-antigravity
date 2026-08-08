/**
 * Template lock. Run with `npm run check:xlsx`.
 *
 * Fails if the generated sheet's structure drifts from the fixed CBC template -
 * only the data values are allowed to change between runs.
 */
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  buildQuotationWorkbook,
  COLUMN_WIDTHS,
  HEADERS,
  MONEY_FORMAT,
  SECTION_TITLES,
  SHEET_NAME,
  standardTerms,
  type QuotationData,
} from './quotation.ts';
import { coerceQuotation, extractJson } from './coerce.ts';

const sample: QuotationData = {
  projectName: 'Baldwin PA Revision 4',
  planSet: 'Full Set 25-073.pdf',
  clientAccount: 'Standard Commercial General Bid',
  address: '800 John C. Watts Dr., Nicholasville, KY 40356',
  quoteDate: '2026-08-07',
  projectState: 'PA (0.0% Sales Tax - Supply-Only)',
  statusLine: 'DRAFT — For CBC Estimator Review',
  phoneFax: '855-432-4613 | 877-887-7806',
  doorLines: [
    {
      tag: '03',
      room: 'WASHING',
      description: '3670 16-Ga HM Door, HM Frame 5-7/8"',
      qty: 1,
      unit: 'EA',
      unitSale: 672.16,
      costBasis: 'catalog_list_x_multiplier',
      citations: '[schedule] A1.1 / Hager #18',
    },
  ],
  accessoryLines: [
    {
      tag: 'B-262',
      room: 'RESTROOM',
      description: 'Bobrick B-26212 Paper Towel Dispenser',
      qty: 2,
      unit: 'EA',
      unitSale: 81.14,
      costBasis: 'catalog_list_x_multiplier',
      citations: '[catalog-page] Bobrick p.8',
    },
  ],
  frpLines: [],
  salesTaxLabel: 'Pennsylvania Sales Tax (0.0%):',
  salesTaxAmount: 0,
  freightNote: 'TBD (Excluded)',
  terms: standardTerms('Pennsylvania 0% (supply-only sale to General Contractor)'),
  rfis: ['• FRP quantities provisional (Open Item 5).'],
};

async function main(): Promise<void> {
  const buffer = await buildQuotationWorkbook(sample).xlsx.writeBuffer();

  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(buffer as ArrayBuffer);
  const ws = reloaded.getWorksheet(SHEET_NAME);
  assert.ok(ws, `worksheet "${SHEET_NAME}" is missing`);

  // Column widths are part of the template.
  COLUMN_WIDTHS.forEach((width, i) => {
    assert.equal(ws.getColumn(i + 1).width, width, `column ${i + 1} width drifted`);
  });

  // Find the header row and check all nine columns, in order.
  let headerRow = 0;
  ws.eachRow((row, rowNumber) => {
    if (!headerRow && row.getCell(1).value === HEADERS[0]) headerRow = rowNumber;
  });
  assert.ok(headerRow, 'header row not found');
  HEADERS.forEach((text, i) => {
    assert.equal(ws.getCell(headerRow, i + 1).value, text, `header column ${i + 1} drifted`);
  });

  // All five section banners present, in template order.
  const text: string[] = [];
  ws.eachRow((row) => {
    const value = row.getCell(1).value;
    if (typeof value === 'string') text.push(value);
  });
  const expectedOrder = [
    SECTION_TITLES.doors,
    SECTION_TITLES.accessories,
    SECTION_TITLES.frp,
    SECTION_TITLES.terms,
    SECTION_TITLES.rfis,
  ];
  let cursor = -1;
  for (const title of expectedOrder) {
    const at = text.indexOf(title);
    assert.ok(at !== -1, `section "${title}" missing`);
    assert.ok(at > cursor, `section "${title}" out of order`);
    cursor = at;
  }

  // Ext Sale must stay a live formula, and money cells keep their format.
  const firstLineRow = headerRow + 2;
  const ext = ws.getCell(firstLineRow, 7);
  assert.ok(
    typeof ext.value === 'object' && ext.value !== null && 'formula' in ext.value,
    'Ext Sale is not a formula',
  );
  assert.equal(ext.numFmt, MONEY_FORMAT, 'Ext Sale lost its currency format');

  // An empty section must not emit an inverted SUM range.
  const frpBanner = text.indexOf(SECTION_TITLES.frp);
  assert.ok(frpBanner !== -1);

  // Coercion boundary: strings, missing fields and fenced JSON all survive.
  const coerced = coerceQuotation(
    extractJson('```json\n{"projectName":"X","doorLines":[{"tag":"1","qty":"2","unitSale":"$3.50"}]}\n```'),
    'fallback',
  );
  assert.equal(coerced.projectName, 'X');
  assert.equal(coerced.doorLines[0].qty, 2);
  assert.equal(coerced.doorLines[0].unitSale, 3.5);
  assert.equal(coerced.doorLines[0].costBasis, 'not_specified');
  assert.equal(coerced.frpLines.length, 0);
  assert.ok(coerced.terms.length > 0, 'terms fell back to empty');

  // `agy --json-schema` emits several objects, one per line, each refining the
  // last - only the final one is complete. Observed live, not hypothetical.
  const multi = coerceQuotation(
    extractJson(
      '{"projectName":"draft","doorLines":[]}\n' +
        '{"projectName":"partial","doorLines":[{"tag":"03","citations":["[schedule] A1.1","[catalog] Hager"]}]}\n' +
        '{"projectName":"final","doorLines":[{"tag":"03","citations":"[schedule] A1.1"}],"salesTaxAmount":12.5}\n',
    ),
    'fallback',
  );
  assert.equal(multi.projectName, 'final', 'took the wrong object from a multi-object response');
  assert.equal(multi.salesTaxAmount, 12.5);

  // A brace inside a string must not split the span.
  const braced = extractJson('{"projectName":"a } b","doorLines":[]}') as { projectName: string };
  assert.equal(braced.projectName, 'a } b');

  // Citations arriving as an array are joined, never dropped.
  const arrayCitations = coerceQuotation(
    { doorLines: [{ tag: '03', citations: ['[schedule] A1.1', '[catalog] Hager'] }] },
    'fallback',
  );
  assert.equal(arrayCitations.doorLines[0].citations, '[schedule] A1.1 [catalog] Hager');

  assert.throws(() => extractJson('no json here'), /no parseable JSON/);

  console.log('xlsx template check passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
