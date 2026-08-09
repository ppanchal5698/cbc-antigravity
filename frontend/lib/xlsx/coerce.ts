/**
 * Turns whatever agy returned into a `QuotationData` the formatter can render.
 *
 * `--json-schema` constrains the final result, but a missing optional field or
 * a number arriving as a string must not sink a 20-minute estimate run, so the
 * boundary coerces rather than throws. Only genuinely absent structure fails.
 */
import { standardTerms, type QuotationData, type QuotationLine } from './quotation.ts';

function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // The model sometimes returns citations as a list despite the schema saying
  // string; joining beats dropping the audit trail on the floor.
  if (Array.isArray(value)) {
    const joined = value.map((item) => str(item)).filter(Boolean).join(' ');
    return joined || fallback;
  }
  return fallback;
}

function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[$,\s]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => str(item)).filter(Boolean);
}

function confidence(value: unknown): QuotationLine['confidence'] {
  const v = str(value).toUpperCase();
  if (v === 'HIGH' || v === 'MEDIUM' || v === 'LOW') return v;
  return null;
}

function pricingStatus(value: unknown): QuotationLine['pricingStatus'] {
  const v = str(value).toLowerCase();
  if (v === 'priced' || v === 'manual_entry_required' || v === 'awaiting_vendor_rfq') return v;
  return null;
}

function priceFreshness(value: unknown): QuotationLine['priceFreshness'] {
  const v = str(value).toLowerCase();
  if (v === 'fresh' || v === 'review' || v === 'stale') return v;
  return null;
}

function toLine(raw: unknown): QuotationLine {
  const source = (raw ?? {}) as Record<string, unknown>;
  const unitCost = source.unitCost === undefined || source.unitCost === null ? null : num(source.unitCost);
  const marginRate =
    source.marginRate === undefined || source.marginRate === null ? null : num(source.marginRate);
  return {
    tag: str(source.tag),
    room: str(source.room),
    description: str(source.description),
    qty: num(source.qty),
    unit: str(source.unit, 'EA'),
    unitSale: num(source.unitSale),
    costBasis: str(source.costBasis, 'not_specified'),
    citations: str(source.citations, '[not stated]'),
    confidence: confidence(source.confidence),
    pricingStatus: pricingStatus(source.pricingStatus) ?? 'priced',
    priceFreshness: priceFreshness(source.priceFreshness),
    substitutionNotes: str(source.substitutionNotes) || null,
    unitCost,
    marginRate,
  };
}

function lineList(value: unknown): QuotationLine[] {
  return Array.isArray(value) ? value.map(toLine) : [];
}

/** Every balanced top-level `{...}` span, ignoring braces inside strings. */
function* objectSpans(text: string): Generator<string> {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        yield text.slice(start, i + 1);
        start = -1;
      } else if (depth < 0) {
        depth = 0;
      }
    }
  }
}

/**
 * Pulls the quotation object out of agy's final response.
 *
 * `--json-schema` does not produce one object: agy emits several, one per line,
 * each a refinement of the last. Only the final one is complete, so the last
 * span that parses wins. Fenced blocks and surrounding prose are tolerated too.
 */
export function extractJson(response: string): unknown {
  const trimmed = response.trim();
  let last: unknown;
  let found = false;

  for (const span of objectSpans(trimmed)) {
    try {
      last = JSON.parse(span);
      found = true;
    } catch {
      continue;
    }
  }

  if (!found) throw new Error('Antigravity returned no parseable JSON quotation');
  return last;
}

export function coerceQuotation(raw: unknown, fallbackProjectName: string): QuotationData {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Quotation payload was not an object');
  }
  const source = raw as Record<string, unknown>;
  const salesTaxLabel = str(source.salesTaxLabel, 'Sales Tax (0.0%):');
  const terms = strList(source.terms);

  return {
    projectName: str(source.projectName, fallbackProjectName),
    planSet: str(source.planSet),
    clientAccount: str(source.clientAccount),
    address: str(source.address),
    quoteDate: str(source.quoteDate, new Date().toISOString().slice(0, 10)),
    projectState: str(source.projectState),
    statusLine: str(source.statusLine, 'DRAFT — For CBC Estimator Review'),
    phoneFax: str(source.phoneFax),
    doorLines: lineList(source.doorLines),
    accessoryLines: lineList(source.accessoryLines),
    frpLines: lineList(source.frpLines),
    salesTaxLabel,
    salesTaxAmount: num(source.salesTaxAmount),
    freightNote: str(source.freightNote, 'TBD (Excluded)'),
    terms: terms.length ? terms : standardTerms(salesTaxLabel.replace(/:$/, '')),
    rfis: strList(source.rfis),
  };
}
