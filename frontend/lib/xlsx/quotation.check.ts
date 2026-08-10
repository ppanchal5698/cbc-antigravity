/**
 * Template lock. Run with `npm run check:xlsx`.
 *
 * Fails if the generated sheet's structure drifts from the fixed CBC template -
 * only the data values are allowed to change between runs.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import {
  buildQuotationWorkbook,
  COLUMN_WIDTHS,
  HEADERS,
  MONEY_FORMAT,
  SECTION_TITLES,
  SHEET_NAME,
  standardTerms,
  taxRateFromLabel,
  type QuotationData,
} from './quotation.ts';
import { coerceQuotation, extractJson, readAuditVerdict } from './coerce.ts';

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
      description:
        '3670 16-Ga HM Door, HM Frame 5-7/8", Continuous SS Hinge, Panic Device, Closer, Kick Plate, Weatherstrip, Threshold — full hardware set as scheduled',
      qty: 1,
      unit: 'EA',
      unitSale: 672.16,
      costBasis: 'catalog_list_x_multiplier (Hager .29 / Pemko .45 / Rockwood .55)',
      citations: '[schedule] A1.1 Door Schedule / Hager Price Book #18 / Pemko Buying Program',
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

  // Long text must wrap and grow the row — fixed height 20 was clipping descriptions.
  const desc = ws.getCell(firstLineRow, 3);
  assert.equal(desc.alignment?.wrapText, true, 'Description must wrap');
  assert.equal(desc.alignment?.vertical, 'top', 'Description must align top when wrapping');
  assert.equal(ws.getCell(firstLineRow, 8).alignment?.wrapText, true, 'Cost basis must wrap');
  assert.equal(ws.getCell(firstLineRow, 9).alignment?.wrapText, true, 'Citations must wrap');
  const lineHeight = ws.getRow(firstLineRow).height ?? 0;
  assert.ok(lineHeight > 20, `long description row height stayed at ${lineHeight}`);

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

  // --- tax is computed on the sheet, not baked in --------------------------
  // A literal total silently keeps quoting the old basis after an estimator edits a unit
  // price on the review screen. The Dutch Bros export carried a hardcoded $304.91.
  assert.equal(taxRateFromLabel('Ohio Sales Tax (8.0%):'), 0.08);
  assert.equal(taxRateFromLabel('Kentucky Sales Tax (6.5%):'), 0.065);
  assert.equal(taxRateFromLabel('Sales Tax (0.0%):'), 0);
  assert.equal(taxRateFromLabel('Exempt - out of state resale'), null,
    'no percentage means fall back to the given amount, never to zero');
  assert.equal(taxRateFromLabel('Sales Tax (900%):'), null, 'nonsense rate is not a rate');

  const taxed = buildQuotationWorkbook({ ...sample, salesTaxLabel: 'Ohio Sales Tax (8.0%):' });
  const taxWs = taxed.getWorksheet('CBC Material Quotation')!;
  let taxRow = 0;
  taxWs.eachRow((r, n) => {
    if (String(r.getCell(6).value ?? '').startsWith('Ohio Sales Tax')) taxRow = n;
  });
  assert.ok(taxRow > 0, 'no sales tax row rendered');
  const taxValue = taxWs.getCell(taxRow, 7).value;
  assert.ok(
    typeof taxValue === 'object' && taxValue !== null && 'formula' in taxValue,
    'sales tax must be a live formula over the base subtotal, not a literal',
  );
  assert.match((taxValue as { formula: string }).formula, /ROUND\(G\d+\*0\.08,2\)/);

  // --- a $0 line is not a priced line ---------------------------------------
  // From the DTGO Popeyes run: doors 103/106/107 and two accessories came back at $0.00
  // tagged "[not carried on shelf - outside RFQ required]" with pricingStatus 'priced',
  // which shows on the review screen as settled rather than outstanding.
  {
    const rfq = coerceQuotation(
      {
        doorLines: [{
          tag: '103', qty: 1, unitSale: 0, pricingStatus: 'priced',
          costBasis: '[not carried on shelf - outside RFQ required]',
          citations: '[schedule] A6.1',
        }],
      },
      'x',
    );
    assert.equal(rfq.doorLines[0].pricingStatus, 'awaiting_vendor_rfq',
      'a $0 line whose basis says an RFQ is outstanding cannot report as priced');
  }
  {
    // A real price keeps its status, and an unpriced line with no RFQ language is not
    // silently reclassified as one.
    const priced = coerceQuotation(
      { doorLines: [{ tag: '104', qty: 1, unitSale: 4845.92, pricingStatus: 'priced',
                      costBasis: 'catalog_list_x_multiplier (Hager .29)', citations: '[catalog]' }] },
      'x',
    );
    assert.equal(priced.doorLines[0].pricingStatus, 'priced');
    const owner = coerceQuotation(
      { accessoryLines: [{ tag: 'PA-61', qty: 1, unitSale: 0,
                           costBasis: 'owner supplied by DBC Parts', citations: '[schedule]' }] },
      'x',
    );
    assert.equal(owner.accessoryLines[0].pricingStatus, 'manual_entry_required',
      'a $0 line that claims no RFQ is unpriced, not awaiting one');
  }

  // --- provenance survives coercion ------------------------------------------
  // The run prompt once told the model provenance was "not part of this JSON" while the
  // schema declared the fields, so every quantity_source column came back empty.
  {
    const q = coerceQuotation(
      { doorLines: [{ tag: '103', qty: 2, unitSale: 10, costBasis: 'x', citations: 'y',
                      quantitySource: 'schedule:A6.1 row 103', sizeSource: 'vision:A6.1' }] },
      'x',
    );
    assert.equal(q.doorLines[0].quantitySource, 'schedule:A6.1 row 103');
    assert.equal(q.doorLines[0].sizeSource, 'vision:A6.1');
    assert.equal(q.doorLines[0].quantitySource === null, false);
  }

  // --- the audit verdict gates the export ----------------------------------
  // Only an explicit pass writes a workbook. Silence is not consent: the payload that
  // produced the $107 Dutch Bros quote carried no verdict at all.
  assert.equal(readAuditVerdict({ auditPassed: true, auditFailures: [] }).passed, true);
  assert.equal(readAuditVerdict({ audit_passed: true, audit_failures: [] }).passed, true,
    'snake_case comes straight off the Python engine');
  assert.equal(readAuditVerdict({}).passed, false, 'no verdict must not export');
  assert.equal(readAuditVerdict(null).passed, false);
  assert.equal(readAuditVerdict({ auditPassed: 'yes' }).passed, false, 'only true is true');
  assert.equal(
    readAuditVerdict({ auditPassed: true, auditFailures: [{ line: '01', problem: 'x' }] }).passed,
    false,
    'a failure list outranks a pass flag',
  );
  assert.ok(readAuditVerdict({}).failures[0].includes('no audit verdict'));

  // The gate and the run's output contract have to agree. `schema.json` is passed to agy
  // as --json-schema with additionalProperties:false, so a verdict field the schema does
  // not declare is one the model is structurally unable to emit - and every run then fails
  // the gate for a plumbing reason instead of a quality one. That shipped once.
  const runSchema = JSON.parse(
    await readFile(new URL('./schema.json', import.meta.url), 'utf8'),
  ) as { required: string[]; properties: Record<string, unknown>; $defs: Record<string, unknown> };
  for (const field of ['auditPassed', 'auditFailures']) {
    assert.ok(runSchema.properties[field], `schema.json must declare ${field}`);
    assert.ok(runSchema.required.includes(field), `schema.json must require ${field}`);
  }
  assert.ok(runSchema.$defs.auditFailure, 'auditFailures needs an item shape to be readable');

  const held = readAuditVerdict({
    auditPassed: false,
    auditFailures: [{
      line: '01', block: 'doors',
      problem: 'hardware group GROUP 1 has 9 components, 1 accounted, 8 neither priced nor excluded',
      fix: 'Price each, or tag it [not carried on shelf].',
    }],
  });
  assert.equal(held.passed, false);
  assert.match(held.failures[0], /\[01\].*9 components.*→ Price each/,
    'a failure must arrive readable enough to act on');

  console.log('xlsx template check passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
