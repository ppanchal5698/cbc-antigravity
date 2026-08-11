/**
 * FR-10 — the approved quote as a PDF, in CBC's customer-facing format.
 *
 * FR-10 is a confirmed Must and only the `.xlsx` existed, so the deliverable CBC actually
 * sends had no generator. This renders from the SAME `QuotationData` the workbook is built
 * from, deliberately: two renderers reading two shapes is how a PDF and a spreadsheet end
 * up disagreeing about a total, and disagreeing quote documents are worse than one format.
 *
 * The numbers are NOT recomputed here. The workbook carries live formulas because an
 * estimator edits it; a PDF is a fixed record, so extensions and totals are summed from the
 * same line values and the tax comes from the engine-derived label the worker wrote. If a
 * number is wrong it is wrong upstream, in one place, not in two renderers independently.
 */
import PDFDocument from 'pdfkit';
import type { QuotationData, QuotationLine } from '../xlsx/quotation.ts';
import { taxRateFromLabel } from '../xlsx/quotation.ts';

const NAVY = '#1A365D';
const HEADER_BLUE = '#2B6CB0';
const GREY = '#4A5568';
const RULE = '#CBD5E0';
const WASH = '#EDF2F7';

/** Portrait Letter with 0.5in margins; the table below is sized to what is left. */
const MARGIN = 36;
const PAGE_WIDTH = 612;
const CONTENT = PAGE_WIDTH - MARGIN * 2;

/** Tag · Room · Description · Qty · Unit · Unit Sale · Ext Sale. Sums to CONTENT. */
const COLS = [46, 74, 200, 30, 32, 62, 96] as const;
const HEADINGS = ['Tag', 'Room', 'Description', 'Qty', 'Unit', 'Unit $', 'Ext $'] as const;

const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function extOf(line: QuotationLine): number {
  return Math.round(line.qty * line.unitSale * 100) / 100;
}

/**
 * Render to a Buffer.
 *
 * Buffered rather than streamed because the caller writes it to the project folder and
 * serves it by path, exactly as the workbook is handled — and a partially written PDF on
 * disk is indistinguishable from a complete one until it is opened.
 */
export function buildQuotationPdf(data: QuotationData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', margin: MARGIN, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  let y = MARGIN;

  const room = (needed: number) => {
    if (y + needed <= 756) return;
    doc.addPage();
    y = MARGIN;
  };

  // --- title block ---------------------------------------------------------
  doc.rect(MARGIN, y, CONTENT, 42).fill(NAVY);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(15)
    .text('CONSTRUCTION BUILDING COMPONENTS (CBC)', MARGIN + 10, y + 8);
  doc.font('Helvetica-Oblique').fontSize(9)
    .text('A Division of The Hamilton Parker Company  |  Commercial Material Quotation',
      MARGIN + 10, y + 27);
  y += 54;

  // --- project grid --------------------------------------------------------
  const info: [string, string][] = [
    ['Project:', data.projectName],
    ['Plan Set:', data.planSet],
    ['Client Account:', data.clientAccount],
    ['Address:', data.address],
    ['Quote Date:', data.quoteDate],
    ['Project State:', data.projectState],
    ['Status:', data.statusLine],
  ];
  doc.fillColor('#000000').fontSize(9);
  for (const [label, value] of info) {
    if (!value) continue;
    room(14);
    doc.font('Helvetica-Bold').text(label, MARGIN, y, { width: 92, continued: false });
    doc.font('Helvetica').text(value, MARGIN + 96, y, { width: CONTENT - 96 });
    y = doc.y + 2;
  }
  y += 8;

  // --- one section ---------------------------------------------------------
  const heading = (title: string) => {
    room(22);
    doc.rect(MARGIN, y, CONTENT, 16).fill(WASH);
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9).text(title, MARGIN + 6, y + 4);
    y += 20;
  };

  const columnHeader = () => {
    room(18);
    doc.rect(MARGIN, y, CONTENT, 15).fill(HEADER_BLUE);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8);
    let x = MARGIN;
    HEADINGS.forEach((text, i) => {
      const right = i >= 3;
      doc.text(text, x + 3, y + 4, { width: COLS[i]! - 6, align: right ? 'right' : 'left' });
      x += COLS[i]!;
    });
    y += 15;
  };

  const section = (title: string, lines: QuotationLine[], subtotalLabel: string): number => {
    heading(title);
    columnHeader();
    let subtotal = 0;

    for (const line of lines) {
      const ext = extOf(line);
      subtotal += ext;

      const cells = [
        line.tag,
        line.room,
        // The citation rides under the description: on a customer-facing document it is
        // what makes a line checkable, and it is the whole point of the audit trail.
        line.citations ? `${line.description}\n${line.citations}` : line.description,
        String(line.qty),
        line.unit,
        money(line.unitSale),
        money(ext),
      ];

      doc.font('Helvetica').fontSize(7.5);
      const height = Math.max(
        ...cells.map((text, i) =>
          doc.heightOfString(text || ' ', { width: COLS[i]! - 6 }),
        ),
        12,
      ) + 5;

      room(height + 2);
      doc.fillColor('#000000');
      let x = MARGIN;
      cells.forEach((text, i) => {
        const right = i >= 3;
        doc.text(text || '', x + 3, y + 2.5, {
          width: COLS[i]! - 6,
          align: right ? 'right' : 'left',
        });
        x += COLS[i]!;
      });
      doc.moveTo(MARGIN, y + height).lineTo(MARGIN + CONTENT, y + height)
        .strokeColor(RULE).lineWidth(0.5).stroke();
      y += height;
    }

    room(18);
    doc.rect(MARGIN, y, CONTENT, 15).fill(WASH);
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(8.5)
      .text(subtotalLabel, MARGIN + 6, y + 4, { width: CONTENT - 110, align: 'right' })
      .text(money(subtotal), MARGIN + CONTENT - 100, y + 4, { width: 94, align: 'right' });
    y += 22;
    return subtotal;
  };

  const doors = section('DIVISION 08 — DOORS, FRAMES & ARCHITECTURAL HARDWARE',
    data.doorLines, 'Subtotal Division 08:');
  const acc = section('DIVISION 10 — WASHROOM ACCESSORIES',
    data.accessoryLines, 'Subtotal Division 10:');
  const frp = section('DIVISION 06 64 — FRP WALL PANELS & MOULDINGS (PROVISIONAL)',
    data.frpLines, 'Subtotal Division 06:');

  // --- summary -------------------------------------------------------------
  const base = Math.round((doors + acc + frp) * 100) / 100;
  // The label carries the engine-derived rate (the worker writes it). Falling back to the
  // stored amount rather than recomputing keeps one source of truth for the tax.
  const rate = taxRateFromLabel(data.salesTaxLabel);
  const tax = rate === null ? data.salesTaxAmount : Math.round(base * rate * 100) / 100;

  const summaryRow = (label: string, value: string, bold = false) => {
    room(16);
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10 : 9).fillColor(NAVY);
    doc.text(label, MARGIN + CONTENT - 300, y, { width: 200, align: 'right' });
    doc.text(value, MARGIN + CONTENT - 96, y, { width: 94, align: 'right' });
    y = doc.y + 3;
  };

  y += 4;
  summaryRow('Base Bid Material Subtotal:', money(base), true);
  summaryRow('Freight (F.O.B. Factory / CBC):', data.freightNote || 'TBD (Excluded)');
  summaryRow(data.salesTaxLabel || 'Sales Tax:', money(tax));
  y += 2;
  room(20);
  doc.rect(MARGIN + CONTENT - 300, y - 2, 300, 18).fill('#FEFCBF');
  summaryRow('GRAND TOTAL QUOTATION:', money(Math.round((base + tax) * 100) / 100), true);
  y += 10;

  // --- terms and RFIs ------------------------------------------------------
  const bullets = (title: string, items: string[]) => {
    if (!items.length) return;
    heading(title);
    doc.font('Helvetica').fontSize(7.5).fillColor(GREY);
    for (const item of items) {
      const height = doc.heightOfString(item, { width: CONTENT - 12 }) + 3;
      room(height);
      doc.text(item, MARGIN + 6, y, { width: CONTENT - 12 });
      y = doc.y + 3;
    }
    y += 6;
  };

  bullets('STANDARD COMMERCIAL TERMS & CONDITIONS', data.terms);
  bullets('ESTIMATING NOTES & RFI REGISTER', data.rfis);

  // --- footer on every page ------------------------------------------------
  // The status line goes on each page, not just the first. A DRAFT whose second page has
  // no marking is a DRAFT that gets forwarded as a quote.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    // The footer sits below the bottom margin on purpose, and pdfkit auto-paginates the
    // moment anything is written past it — which appended a blank page carrying nothing
    // but "Page 1 of 1". Dropping the bottom margin for the write is the documented way
    // to put a footer in the margin; it is restored so nothing after this is affected.
    const { bottom } = doc.page.margins;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7).fillColor(GREY)
      .text(
        `${data.statusLine || 'DRAFT — For CBC Estimator Review'}    ·    ${data.projectName}    ·    Page ${i + 1} of ${range.count}`,
        MARGIN,
        762,
        { width: CONTENT, align: 'center', lineBreak: false },
      );
    doc.page.margins.bottom = bottom;
  }

  doc.end();
  return done;
}
