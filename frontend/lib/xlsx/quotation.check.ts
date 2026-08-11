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
  resolveSalesTaxRate,
  type QuotationData,
} from './quotation.ts';
import { coerceQuotation, extractJson, toEngineAuditInput } from './coerce.ts';
import { claimedVerdict } from '../../server/engine-audit.ts';

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

  // Engine rate wins over a disagreeing label (the residual BUG-04 hole).
  assert.equal(
    resolveSalesTaxRate({ salesTaxLabel: 'Ohio Sales Tax (8.0%):', salesTaxRate: 0.065 }),
    0.065,
  );
  assert.equal(
    resolveSalesTaxRate({ salesTaxLabel: 'Ohio Sales Tax (8.0%):', salesTaxRate: null }),
    0.08,
    'older drafts without salesTaxRate still parse the label',
  );

  const taxed = buildQuotationWorkbook({
    ...sample,
    salesTaxLabel: 'Mislabelled Sales Tax (99.0%):',
    salesTaxRate: 0.08,
  });
  const taxWs = taxed.getWorksheet('CBC Material Quotation')!;
  let taxRow = 0;
  taxWs.eachRow((r, n) => {
    // Exact label — terms also contain the words "Sales Tax".
    if (String(r.getCell(6).value ?? '') === 'Mislabelled Sales Tax (99.0%):') taxRow = n;
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

  // --- the verdict is the engine's, and the model's claim is only a claim --------
  // The worker used to export on the strength of `auditPassed` in the model's own JSON.
  // It now runs format_cbc_proposal itself (server/engine-audit.ts); this flag is kept
  // only so a disagreement can be reported. Silence is still not consent.
  assert.equal(claimedVerdict({ auditPassed: true }).claimedPass, true);
  assert.equal(claimedVerdict({ audit_passed: true }).claimedPass, true,
    'snake_case comes straight off the Python engine');
  assert.equal(claimedVerdict({}).claimedPass, false, 'no verdict is not a pass');
  assert.equal(claimedVerdict(null).claimedPass, false);
  assert.equal(claimedVerdict({ auditPassed: 'yes' }).claimedPass, false, 'only true is true');

  // --- what reaches the engine ---------------------------------------------
  // The audit checks fields the workbook never renders. If the mapping drops one, the
  // engine cannot see the defect it exists to catch, and the package passes for a reason
  // that is not the real one.
  const audited = toEngineAuditInput({
    projectState: 'VA (0.0% Sales Tax - Supply-Only)',
    doorLines: [{
      tag: '01', qty: 2, unitSale: 100, description: '3ft-6in HM door, Hardware Group 1',
      costSource: 'catalog_list_x_multiplier', costSourceDetail: 'Pemko 2026 p13',
      quantitySource: 'schedule:A2.2 row 01', sizeSource: 'schedule:A2.2',
      hardwareGroup: 'GROUP 1', assemblyAccounted: true,
      specifiedManufacturer: 'MARLITE', manufacturer: 'NUDO', substitutionNotes: 'approved equal',
      components: [{ component: 'Threshold', extSale: 32.19 },
                   { component: 'Closer', exclusion: '[not carried on shelf]' }],
    }],
    alternates: [{ name: 'Alt 1', lines: [{ tag: 'ALT-01', qty: 1, unitSale: 50 }] }],
  });
  assert.equal(audited.state, 'VA', 'the engine reads a state code, not a human sentence');
  const line = audited.doorLines[0]!;
  assert.equal(line.cost_source, 'catalog_list_x_multiplier');
  assert.equal(line.ext_sale, 200, 'ext_sale is unitSale x qty - the engine audits extensions');
  assert.equal(line.hardware_group, 'GROUP 1');
  assert.equal(line.assembly_accounted, true);
  assert.equal(line.substitution_note, 'approved equal');
  assert.equal((line.components as unknown[]).length, 2);
  assert.equal(audited.alternates[0]!.lines.length, 1, 'alternates are audited too');

  // A display-only costBasis still yields a usable cost_source rather than a sentence.
  const legacy = toEngineAuditInput({
    doorLines: [{ tag: '01', qty: 1, unitSale: 1, costBasis: 'p21_last_po (PO 88213)' }],
  });
  assert.equal(legacy.doorLines[0]!.cost_source, 'p21_last_po');

  // An unread state must arrive empty so the engine fails the package, rather than
  // arriving as something that looks like a state. A wrong zero is still a wrong number.
  assert.equal(toEngineAuditInput({ projectState: '' }).state, '');

  // The gate and the run's output contract have to agree. `schema.json` is passed to agy
  // as --json-schema with additionalProperties:false, so a field the schema does not
  // declare is one the model is structurally unable to emit - and every run then fails
  // the gate for a plumbing reason instead of a quality one. That shipped once.
  const runSchema = JSON.parse(
    await readFile(new URL('./schema.json', import.meta.url), 'utf8'),
  ) as { required: string[]; properties: Record<string, unknown>; $defs: Record<string, unknown> };
  for (const field of ['auditPassed', 'auditFailures']) {
    assert.ok(runSchema.properties[field], `schema.json must declare ${field}`);
    assert.ok(runSchema.required.includes(field), `schema.json must require ${field}`);
  }
  assert.ok(runSchema.$defs.auditFailure, 'auditFailures needs an item shape to be readable');

  // Every field the engine audits must be declarable, or the model cannot supply it and
  // the re-run fails on plumbing again - this time on the checks that matter most.
  const lineProps = (runSchema.$defs.line as { properties: Record<string, unknown> }).properties;
  for (const field of ['costSource', 'costSourceDetail', 'quantitySource', 'sizeSource',
                       'hardwareGroup', 'components', 'assemblyAccounted',
                       'specifiedManufacturer', 'manufacturer', 'substitutionNotes']) {
    assert.ok(lineProps[field], `schema.json line must declare ${field} for the engine audit`);
  }

  console.log('xlsx template check passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
