/**
 * The one canonical CBC quotation formatter.
 *
 * Structure - columns, section order, fills, widths, formulas - is fixed here
 * and never varies between runs; only the values in `QuotationData` change.
 * Ported from `sandbox/scripts/export_quotation_excel.py`, which is the sheet
 * CBC already produces by hand.
 */
import ExcelJS from 'exceljs';

export type LineConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type PricingStatus = 'priced' | 'manual_entry_required' | 'awaiting_vendor_rfq';
export type PriceFreshness = 'fresh' | 'review' | 'stale';

export type QuotationLine = {
  tag: string;
  room: string;
  description: string;
  qty: number;
  unit: string;
  unitSale: number;
  /** One of the engine's COST_SOURCES, plus detail. */
  costBasis: string;
  /** `[schedule] Sheet A1.1 / Hager #18` style audit trail. */
  citations: string;
  /** Optional FR-8 / FR-9 / FR-16 fields — agent may omit; UI defaults apply. */
  confidence?: LineConfidence | null;
  pricingStatus?: PricingStatus | null;
  priceFreshness?: PriceFreshness | null;
  substitutionNotes?: string | null;
  unitCost?: number | null;
  marginRate?: number | null;
  /**
   * Where the number was READ. Not rendered in the workbook — CBC's template is fixed —
   * but shown on the review screen, so an estimator can see which quantities came off a
   * schedule row, which were counted on a drawing, and which nobody sourced at all.
   */
  quantitySource?: string | null;
  sizeSource?: string | null;
};

export type QuotationData = {
  projectName: string;
  planSet: string;
  clientAccount: string;
  address: string;
  quoteDate: string;
  projectState: string;
  statusLine: string;
  phoneFax: string;
  doorLines: QuotationLine[];
  accessoryLines: QuotationLine[];
  frpLines: QuotationLine[];
  salesTaxLabel: string;
  salesTaxAmount: number;
  /**
   * Decimal rate from the estimating engine (e.g. 0.08). Preferred over parsing
   * `salesTaxLabel` — a mislabelled percentage must not silently become the quoted rate.
   */
  salesTaxRate?: number | null;
  freightNote: string;
  terms: string[];
  rfis: string[];
};

/** Fixed template constants. The check in `quotation.check.ts` asserts these. */
export const HEADERS = [
  'Tag / Item',
  'Room / Section',
  'Description / Details',
  'Qty',
  'Unit',
  'Unit Sale ($)',
  'Ext Sale ($)',
  'Cost Sourcing Basis',
  'Plan & Catalog Citations',
] as const;

/** B/C/H/I sized so long door descriptions and citations wrap instead of clipping. */
export const COLUMN_WIDTHS = [14, 22, 70, 8, 8, 16, 18, 36, 48] as const;

export const SECTION_TITLES = {
  doors: 'DIVISION 08 — DOORS, FRAMES & ARCHITECTURAL HARDWARE',
  accessories: 'DIVISION 10 — WASHROOM ACCESSORIES',
  frp: 'DIVISION 06 64 — FRP WALL PANELS & MOULDINGS (PROVISIONAL)',
  terms: 'STANDARD COMMERCIAL TERMS & CONDITIONS',
  rfis: 'ESTIMATING NOTES & RFI REGISTER',
} as const;

export const SUBTOTAL_LABELS = {
  doors: 'Subtotal Division 08 Doors & Hardware:',
  accessories: 'Subtotal Division 10 Washroom Accessories:',
  frp: 'Subtotal Division 06 FRP Panels & Trims:',
} as const;

export const SHEET_NAME = 'CBC Material Quotation';
export const MONEY_FORMAT = '$#,##0.00';

const NAVY = 'FF1A365D';
const HEADER_BLUE = 'FF2B6CB0';
const SUBTOTAL_GREY = 'FFEDF2F7';
const ACCENT_GREY = 'FFE2E8F0';
const TOTAL_YELLOW = 'FFFEFCBF';
const BORDER_GREY = 'FFCBD5E0';
const MUTED = 'FF4A5568';

const FONT = 'Calibri';
const titleFont: Partial<ExcelJS.Font> = { name: FONT, size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
const subtitleFont: Partial<ExcelJS.Font> = { name: FONT, size: 11, italic: true, color: { argb: 'FFFFFFFF' } };
const headerFont: Partial<ExcelJS.Font> = { name: FONT, size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
const boldFont: Partial<ExcelJS.Font> = { name: FONT, size: 11, bold: true, color: { argb: 'FF000000' } };
const regularFont: Partial<ExcelJS.Font> = { name: FONT, size: 11, color: { argb: 'FF000000' } };
const italicFont: Partial<ExcelJS.Font> = { name: FONT, size: 10, italic: true, color: { argb: MUTED } };
const grandTotalFont: Partial<ExcelJS.Font> = { name: FONT, size: 12, bold: true, color: { argb: NAVY } };

function fill(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

const thinSide: ExcelJS.Border = { style: 'thin', color: { argb: BORDER_GREY } };
const thinBorder: Partial<ExcelJS.Borders> = {
  top: thinSide,
  left: thinSide,
  right: thinSide,
  bottom: thinSide,
};
const subtotalBorder: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: NAVY } },
  bottom: { style: 'medium', color: { argb: NAVY } },
  left: thinSide,
  right: thinSide,
};
const totalBorder: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: NAVY } },
  bottom: { style: 'double', color: { argb: NAVY } },
  left: thinSide,
  right: thinSide,
};

/** Columns 4 and 5 centre, 6 and 7 right, everything else left. */
function headerAlignment(col: number): ExcelJS.Alignment['horizontal'] {
  if (col === 4 || col === 5) return 'center';
  if (col === 6 || col === 7) return 'right';
  return 'left';
}

const wrapTop: Partial<ExcelJS.Alignment> = {
  horizontal: 'left',
  vertical: 'top',
  wrapText: true,
};

/**
 * Approximate Excel row height for wrapped Calibri 11 text.
 * `widthChars` is the column width unit ExcelJS uses (~character widths).
 */
export function wrappedRowHeight(
  texts: Array<{ text: string; widthChars: number }>,
  min = 22,
  max = 90,
): number {
  let lines = 1;
  for (const { text, widthChars } of texts) {
    const value = text || '';
    const cols = Math.max(widthChars * 0.9, 8);
    let needed = 0;
    for (const part of value.split(/\r?\n/)) {
      needed += Math.max(1, Math.ceil(part.length / cols));
    }
    if (needed > lines) lines = needed;
  }
  // ~14pt per wrapped line plus a little padding for borders.
  return Math.min(max, Math.max(min, 8 + lines * 14));
}

export function buildQuotationWorkbook(data: QuotationData): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CBC Estimating Copilot';
  const ws = wb.addWorksheet(SHEET_NAME, {
    views: [{ showGridLines: true }],
  });

  COLUMN_WIDTHS.forEach((width, i) => {
    ws.getColumn(i + 1).width = width;
  });

  // --- title block ---------------------------------------------------------
  ws.mergeCells('A1:I1');
  const a1 = ws.getCell('A1');
  a1.value = 'CONSTRUCTION BUILDING COMPONENTS (CBC)';
  a1.font = titleFont;
  a1.fill = fill(NAVY);
  a1.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  ws.getRow(1).height = 30;

  ws.mergeCells('A2:I2');
  const a2 = ws.getCell('A2');
  a2.value =
    'A Division of The Hamilton Parker Company | Commercial Material Quotation (DRAFT)';
  a2.font = subtitleFont;
  a2.fill = fill(NAVY);
  a2.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  ws.getRow(2).height = 20;

  // --- project info grid ---------------------------------------------------
  const info: [string, string, string, string][] = [
    ['Project:', data.projectName, 'Quote Date:', data.quoteDate],
    ['Plan Set:', data.planSet, 'Project State:', data.projectState],
    ['Client Account:', data.clientAccount, 'Status:', data.statusLine],
    ['Address:', data.address, 'Phone / Fax:', data.phoneFax],
  ];

  let row = 4;
  for (const [label1, value1, label2, value2] of info) {
    ws.getCell(row, 1).value = label1;
    ws.getCell(row, 1).font = boldFont;
    ws.getCell(row, 2).value = value1;
    ws.getCell(row, 2).font = regularFont;
    ws.getCell(row, 6).value = label2;
    ws.getCell(row, 6).font = boldFont;
    ws.getCell(row, 7).value = value2;
    ws.getCell(row, 7).font = regularFont;
    ws.getRow(row).height = 20;
    row += 1;
  }
  row += 1;

  // --- column headers ------------------------------------------------------
  ws.getRow(row).height = 25;
  HEADERS.forEach((text, i) => {
    const cell = ws.getCell(row, i + 1);
    cell.value = text;
    cell.font = headerFont;
    cell.fill = fill(HEADER_BLUE);
    cell.alignment = { horizontal: headerAlignment(i + 1), vertical: 'middle' };
    cell.border = thinBorder;
  });
  row += 1;

  const sectionHeader = (title: string) => {
    ws.mergeCells(row, 1, row, 9);
    const cell = ws.getCell(row, 1);
    cell.value = title;
    cell.font = boldFont;
    cell.fill = fill(ACCENT_GREY);
    cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    for (let c = 1; c <= 9; c += 1) ws.getCell(row, c).border = thinBorder;
    ws.getRow(row).height = 22;
    row += 1;
  };

  /** Writes a section and returns the row its subtotal landed on. */
  const section = (title: string, lines: QuotationLine[], subtotalLabel: string): number => {
    sectionHeader(title);
    const start = row;
    for (const line of lines) {
      ws.getCell(row, 1).value = line.tag;
      ws.getCell(row, 1).alignment = { horizontal: 'center', vertical: 'top' };
      ws.getCell(row, 2).value = line.room;
      ws.getCell(row, 2).alignment = { ...wrapTop };
      ws.getCell(row, 3).value = line.description;
      ws.getCell(row, 3).alignment = { ...wrapTop };
      ws.getCell(row, 4).value = line.qty;
      ws.getCell(row, 4).alignment = { horizontal: 'center', vertical: 'top' };
      ws.getCell(row, 5).value = line.unit;
      ws.getCell(row, 5).alignment = { horizontal: 'center', vertical: 'top' };

      const unitCell = ws.getCell(row, 6);
      unitCell.value = line.unitSale;
      unitCell.numFmt = MONEY_FORMAT;
      unitCell.alignment = { horizontal: 'right', vertical: 'top' };

      // Live formula, so an estimator editing Qty or Unit Sale sees totals move.
      const extCell = ws.getCell(row, 7);
      extCell.value = { formula: `D${row}*F${row}` };
      extCell.numFmt = MONEY_FORMAT;
      extCell.alignment = { horizontal: 'right', vertical: 'top' };

      ws.getCell(row, 8).value = line.costBasis;
      ws.getCell(row, 8).alignment = { ...wrapTop };
      ws.getCell(row, 9).value = line.citations;
      ws.getCell(row, 9).alignment = { ...wrapTop };

      for (let c = 1; c <= 9; c += 1) {
        ws.getCell(row, c).font = regularFont;
        ws.getCell(row, c).border = thinBorder;
      }
      ws.getRow(row).height = wrappedRowHeight([
        { text: line.room, widthChars: COLUMN_WIDTHS[1] },
        { text: line.description, widthChars: COLUMN_WIDTHS[2] },
        { text: line.costBasis, widthChars: COLUMN_WIDTHS[7] },
        { text: line.citations, widthChars: COLUMN_WIDTHS[8] },
      ]);
      row += 1;
    }
    const end = row - 1;

    const labelCell = ws.getCell(row, 3);
    labelCell.value = subtotalLabel;
    labelCell.font = boldFont;
    labelCell.alignment = { horizontal: 'right', vertical: 'middle' };

    const subtotalCell = ws.getCell(row, 7);
    // An empty section would produce SUM over an inverted range; sum zero instead.
    subtotalCell.value = lines.length ? { formula: `SUM(G${start}:G${end})` } : 0;
    subtotalCell.font = boldFont;
    subtotalCell.numFmt = MONEY_FORMAT;
    subtotalCell.alignment = { horizontal: 'right', vertical: 'middle' };

    for (let c = 1; c <= 9; c += 1) {
      ws.getCell(row, c).fill = fill(SUBTOTAL_GREY);
      ws.getCell(row, c).border = subtotalBorder;
    }
    ws.getRow(row).height = 22;
    const subtotalRow = row;
    row += 2;
    return subtotalRow;
  };

  const doorSubtotal = section(SECTION_TITLES.doors, data.doorLines, SUBTOTAL_LABELS.doors);
  const accSubtotal = section(
    SECTION_TITLES.accessories,
    data.accessoryLines,
    SUBTOTAL_LABELS.accessories,
  );
  const frpSubtotal = section(SECTION_TITLES.frp, data.frpLines, SUBTOTAL_LABELS.frp);

  // --- summary -------------------------------------------------------------
  ws.getCell(row, 6).value = 'Base Bid Material Subtotal:';
  ws.getCell(row, 6).font = boldFont;
  ws.getCell(row, 6).alignment = { horizontal: 'right', vertical: 'middle' };
  const baseCell = ws.getCell(row, 7);
  baseCell.value = { formula: `G${doorSubtotal}+G${accSubtotal}+G${frpSubtotal}` };
  baseCell.font = boldFont;
  baseCell.numFmt = MONEY_FORMAT;
  baseCell.alignment = { horizontal: 'right', vertical: 'middle' };
  ws.getRow(row).height = 22;
  const baseRow = row;
  row += 1;

  // Freight is a visible line, never omitted - a missing line reads as "included".
  ws.getCell(row, 6).value = 'Freight (F.O.B. Factory / CBC):';
  ws.getCell(row, 6).font = boldFont;
  ws.getCell(row, 6).alignment = { horizontal: 'right', vertical: 'middle' };
  ws.getCell(row, 7).value = data.freightNote;
  ws.getCell(row, 7).font = italicFont;
  ws.getCell(row, 7).alignment = { horizontal: 'right', vertical: 'middle' };
  ws.getRow(row).height = 20;
  row += 1;

  ws.getCell(row, 6).value = data.salesTaxLabel;
  ws.getCell(row, 6).font = boldFont;
  ws.getCell(row, 6).alignment = { horizontal: 'right', vertical: 'middle' };
  const taxCell = ws.getCell(row, 7);
  // Live formula over the base subtotal, not the model's arithmetic. An estimator who
  // edits a unit price on the review screen expects the tax to follow; a literal silently
  // keeps quoting the old basis. Rate comes from the engine field first; label parse is
  // only a fallback for drafts persisted before salesTaxRate was stored.
  const taxRate = resolveSalesTaxRate(data);
  taxCell.value = taxRate === null
    ? data.salesTaxAmount
    : { formula: `ROUND(G${baseRow}*${taxRate},2)` };
  taxCell.font = regularFont;
  taxCell.numFmt = MONEY_FORMAT;
  taxCell.alignment = { horizontal: 'right', vertical: 'middle' };
  ws.getRow(row).height = 20;
  const taxRow = row;
  row += 1;

  ws.getCell(row, 6).value = 'GRAND TOTAL QUOTATION:';
  ws.getCell(row, 6).font = grandTotalFont;
  ws.getCell(row, 6).alignment = { horizontal: 'right', vertical: 'middle' };
  const grandCell = ws.getCell(row, 7);
  grandCell.value = { formula: `G${baseRow}+G${taxRow}` };
  grandCell.font = grandTotalFont;
  grandCell.numFmt = MONEY_FORMAT;
  grandCell.alignment = { horizontal: 'right', vertical: 'middle' };
  for (let c = 6; c <= 7; c += 1) {
    ws.getCell(row, c).fill = fill(TOTAL_YELLOW);
    ws.getCell(row, c).border = totalBorder;
  }
  ws.getRow(row).height = 26;
  row += 3;

  // --- terms and RFIs ------------------------------------------------------
  const bulletBlock = (title: string, items: string[]) => {
    sectionHeader(title);
    // Merged A–I ≈ sum of column widths for wrap estimates.
    const bulletWidth = COLUMN_WIDTHS.reduce((sum, w) => sum + w, 0);
    for (const item of items) {
      ws.mergeCells(row, 1, row, 9);
      const cell = ws.getCell(row, 1);
      cell.value = item;
      cell.font = italicFont;
      cell.alignment = { horizontal: 'left', vertical: 'top', indent: 1, wrapText: true };
      ws.getRow(row).height = wrappedRowHeight(
        [{ text: item, widthChars: bulletWidth }],
        22,
        72,
      );
      row += 1;
    }
  };

  bulletBlock(SECTION_TITLES.terms, data.terms);
  row += 1;
  bulletBlock(SECTION_TITLES.rfis, data.rfis);

  return wb;
}

/**
 * The tax rate out of a label like `Ohio Sales Tax (8.0%):` as a decimal, or null when the
 * label states no percentage. Null means "write the amount as given" rather than "zero" -
 * an unparsed label must not silently zero a real tax line.
 */
export function taxRateFromLabel(label: string): number | null {
  const m = /\(\s*([\d.]+)\s*%\s*\)/.exec(label || '');
  if (!m) return null;
  const pct = Number(m[1]);
  if (!Number.isFinite(pct) || pct < 0 || pct > 25) return null;
  return pct / 100;
}

/** Prefer the engine rate; fall back to the label only for older drafts. */
export function resolveSalesTaxRate(
  data: Pick<QuotationData, 'salesTaxLabel' | 'salesTaxRate'>,
): number | null {
  const rate = data.salesTaxRate;
  if (typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 && rate <= 0.25) {
    return rate;
  }
  return taxRateFromLabel(data.salesTaxLabel);
}

/** CBC's standard terms. Tax line is the only one that varies by state. */
export function standardTerms(taxLine: string): string[] {
  return [
    '1. Supply-Only material proposal (Material only, F.O.B. factory / CBC warehouse). Installation by others.',
    '2. Quotation is subject to CBC / The Hamilton Parker Company credit approval. Hamilton Parker PO required.',
    '3. Material prices are firm for 30 days from date of quotation.',
    '4. Freight: Excluded at estimate stage / carried TBD (billed at actual cost upon order release).',
    `5. Sales Tax: ${taxLine}`,
  ];
}
