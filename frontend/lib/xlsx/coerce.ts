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

/** Text on a line that says a real number is still outstanding. */
const AWAITING_RX = /not carried|outside rfq|vendor_rfq|not indexed|rfq required|manual_wholesaler_net/i;

/**
 * A line carrying no money, whose own basis says an RFQ is outstanding, is not "priced".
 *
 * The model reported `priced` on $0.00 door assemblies tagged
 * "[not carried on shelf - outside RFQ required]", which puts them on the review screen
 * under a settled status. `priced` has to mean a price was established; when the line says
 * otherwise in its own words, the line wins. A genuinely $0 owner-supplied item says no
 * such thing and keeps whatever status it was given.
 */
function resolvePricingStatus(source: Record<string, unknown>): QuotationLine['pricingStatus'] {
  const stated = pricingStatus(source.pricingStatus);
  const unpaid = num(source.unitSale) <= 0;
  const outstanding = AWAITING_RX.test(`${str(source.costBasis)} ${str(source.citations)}`);
  if (unpaid && outstanding) return 'awaiting_vendor_rfq';
  return stated ?? (unpaid ? 'manual_entry_required' : 'priced');
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
    pricingStatus: resolvePricingStatus(source),
    priceFreshness: priceFreshness(source.priceFreshness),
    substitutionNotes: str(source.substitutionNotes) || null,
    unitCost,
    marginRate,
    quantitySource: str(source.quantitySource) || null,
    sizeSource: str(source.sizeSource) || null,
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

/**
 * The lines in the shape `cbc_engine.engine.format_cbc_proposal` audits.
 *
 * Deliberately NOT built from `QuotationLine`. The workbook renders nine columns and needs
 * none of this; the audit needs `components`, `hardware_group` and the two manufacturer
 * fields, which the workbook would only carry around. Reading straight off the payload
 * keeps the audit shape and the render shape independent, so neither drags the other.
 *
 * snake_case on purpose - these dicts go to Python and are consumed by the engine as-is.
 */
export type EngineAuditLine = Record<string, unknown>;

function toAuditLine(raw: unknown): EngineAuditLine {
  const source = (raw ?? {}) as Record<string, unknown>;

  // `costBasis` is a display string ("catalog_list_x_multiplier (Hager .29)"). The engine
  // matches `cost_source` exactly, so prefer the explicit field and fall back to the first
  // token of the display string rather than handing the engine a sentence.
  const explicit = str(source.costSource).trim();
  const basis = str(source.costBasis).trim();
  const costSource = explicit || basis.split(/[\s(]/)[0] || '';

  const components = Array.isArray(source.components)
    ? source.components.map((raw) => {
        const c = (raw ?? {}) as Record<string, unknown>;
        return {
          component: str(c.component),
          ext_sale: c.extSale === undefined || c.extSale === null ? null : num(c.extSale),
          exclusion: str(c.exclusion),
          note: str(c.note),
        };
      })
    : [];

  return {
    tag: str(source.tag),
    description: str(source.description),
    quantity: num(source.qty),
    ext_sale: num(source.unitSale) * num(source.qty),
    ext_cost: source.unitCost == null ? 0 : num(source.unitCost) * num(source.qty),
    cost_source: costSource,
    cost_source_detail: str(source.costSourceDetail) || basis,
    quantity_source: str(source.quantitySource),
    size_source: str(source.sizeSource),
    hardware_group: str(source.hardwareGroup),
    components,
    assembly_accounted: source.assemblyAccounted === true,
    specified_manufacturer: str(source.specifiedManufacturer),
    manufacturer: str(source.manufacturer),
    substitution_note: str(source.substitutionNotes),
  };
}

function auditLineList(value: unknown): EngineAuditLine[] {
  return Array.isArray(value) ? value.map(toAuditLine) : [];
}

/** The whole payload in the shape the engine audits. `state` has no default, by design. */
export function toEngineAuditInput(raw: unknown): {
  projectName: string;
  state: string;
  doorLines: EngineAuditLine[];
  accessoryLines: EngineAuditLine[];
  frpLines: EngineAuditLine[];
  alternates: { name: string; description: string; lines: EngineAuditLine[] }[];
} {
  const source = (raw ?? {}) as Record<string, unknown>;
  const alternates = Array.isArray(source.alternates)
    ? source.alternates.map((raw) => {
        const a = (raw ?? {}) as Record<string, unknown>;
        return {
          name: str(a.name, 'Alternate'),
          description: str(a.description),
          lines: auditLineList(a.lines),
        };
      })
    : [];

  return {
    projectName: str(source.projectName),
    // The engine reads a two-letter state. `projectState` is written for a human
    // ("PA (0.0% Sales Tax - Supply-Only)"), so take the leading code and let the engine
    // fail the package when there is none - an unread state is a failure, not a 0% guess.
    state: (str(source.projectState).trim().match(/^[A-Za-z]{2,}\b/)?.[0] ?? '').toUpperCase(),
    doorLines: auditLineList(source.doorLines),
    accessoryLines: auditLineList(source.accessoryLines),
    frpLines: auditLineList(source.frpLines),
    alternates,
  };
}

export function coerceQuotation(raw: unknown, fallbackProjectName: string): QuotationData {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Quotation payload was not an object');
  }
  const source = raw as Record<string, unknown>;
  const salesTaxLabel = str(source.salesTaxLabel, 'Sales Tax (0.0%):');
  const terms = strList(source.terms);
  const rawRate = source.salesTaxRate;
  const salesTaxRate =
    typeof rawRate === 'number' && Number.isFinite(rawRate) ? rawRate : null;

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
    salesTaxRate,
    freightNote: str(source.freightNote, 'TBD (Excluded)'),
    terms: terms.length ? terms : standardTerms(salesTaxLabel.replace(/:$/, '')),
    rfis: strList(source.rfis),
  };
}
