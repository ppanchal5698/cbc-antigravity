/**
 * The audit-trail vocabulary the CBC workflow requires on every line, and how
 * far each tag can be resolved.
 *
 * `run-estimate.md` mandates these tags; today they render as grey text. Making
 * them land on the actual catalog page or plan sheet closes the grounding loop
 * the whole workspace is built around. A tag that cannot be resolved renders as
 * a plain label - a chip that goes nowhere is worse than no chip.
 */

export const CITATION_TAGS = [
  'schedule',
  'spec',
  'note',
  'drawing',
  'catalog',
  'catalog-page',
  'not carried',
  'not indexed',
  'not stated',
] as const;

export type CitationTag = (typeof CITATION_TAGS)[number];

export type Citation = {
  tag: CitationTag;
  /** The text that followed the tag, up to the next tag or clause end. */
  subject: string;
  href: string | null;
  /** True for the three "we could not confirm this" tags. */
  gap: boolean;
};

const GAP_TAGS = new Set<string>(['not carried', 'not indexed', 'not stated']);

/**
 * Matches `[schedule]`, `[catalog-page]`, and the gap tags - which the workflow
 * writes with their explanation inside the brackets, as in
 * `[not carried on shelf - outside RFQ required]`.
 */
export const CITATION_PATTERN = new RegExp(
  `\\[(${CITATION_TAGS.map((tag) => tag.replace(/[-\s]/g, '[-\\s]')).join('|')})([^\\]]*)\\]`,
  'gi',
);

/** Words that are part of a reference rather than the sentence around it. */
const REFERENCE_WORDS = new Set([
  'sheet', 'sheets', 'sht', 'page', 'pages', 'p', 'pg', 'no', 'rev',
  'detail', 'set', 'div', 'division', 'section', 'item', 'tag',
]);

/** `p.18`, `page 18`, `pg 18`. */
const PAGE_PATTERN = /\b(?:p|pg|page)\.?\s*(\d{1,4})\b/i;
/** `A1.1`, `A-101`, `G0.02` - a discipline letter, digits, then an optional part. */
const SHEET_PATTERN = /\b([A-Z]{1,3}[-\s]?\d{1,3}(?:[.\-]\d{1,3})?)\b/;

function normaliseTag(raw: string): CitationTag {
  return raw.toLowerCase().replace(/\s+/g, ' ') as CitationTag;
}

/**
 * Resolves a citation's subject to a destination.
 *
 * `vendorFolders` is the live shelf, so a catalog citation only links when the
 * vendor is actually on the shelf. Matching is longest-first because `BOBRICK`
 * must win over a shorter folder that happens to be a substring.
 */
export function resolveCitation(
  tag: CitationTag,
  subject: string,
  vendorFolders: string[],
): string | null {
  if (GAP_TAGS.has(tag)) return null;

  if (tag === 'catalog' || tag === 'catalog-page') {
    const upper = subject.toUpperCase();
    const folder = [...vendorFolders]
      .sort((a, b) => b.length - a.length)
      .find((candidate) => upper.includes(candidate.toUpperCase()));
    if (!folder) return null;
    const page = subject.match(PAGE_PATTERN)?.[1];
    if (!page) return `/shelf/${encodeURIComponent(folder)}`;
    // Whatever the citation said besides the vendor and the page - "#18",
    // "Accessories", "2020 price list". A vendor can have several books and a page
    // number alone does not say which, so this rides along to pick the right one.
    const book = subject
      .replace(new RegExp(folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ')
      .replace(PAGE_PATTERN, ' ')
      .trim();
    const query = book
      ? `?page=${page}&book=${encodeURIComponent(book)}`
      : `?page=${page}`;
    return `/shelf/${encodeURIComponent(folder)}${query}`;
  }

  if (tag === 'schedule' || tag === 'drawing' || tag === 'spec') {
    const sheet = subject.match(SHEET_PATTERN)?.[1];
    return sheet ? `/sheets?q=${encodeURIComponent(sheet.replace(/\s/g, ''))}` : null;
  }

  return null;
}

/**
 * Reads the reference that follows a tag, and stops where the sentence resumes.
 *
 * A citation subject is terse by nature - a sheet number, a vendor and a page.
 * Tokens are kept while they look referential (a digit, a capital, a known
 * reference word, a vendor on the shelf) and dropped at the first ordinary
 * word, so `[schedule] A1.1 priced from the book` chips `A1.1` and leaves the
 * rest as prose. Returns the subject and how much of `raw` it consumed.
 */
function readSubject(
  raw: string,
  vendorFolders: string[],
): { subject: string; consumed: number } {
  const folders = new Set(vendorFolders.map((folder) => folder.toUpperCase()));
  const kept: string[] = [];
  let consumed = 0;

  for (const match of raw.matchAll(/\S+/g)) {
    if (kept.length >= 6) break;
    const token = match[0];
    const bare = token.replace(/[.,;:]+$/, '');
    if (!bare) break;

    const referential =
      /\d/.test(bare) ||
      /^[A-Z]/.test(bare) ||
      /^[#/&+-]/.test(bare) ||
      REFERENCE_WORDS.has(bare.toLowerCase()) ||
      folders.has(bare.toUpperCase());
    if (!referential) break;

    kept.push(bare);
    consumed = (match.index ?? 0) + bare.length;
    // A comma or semicolon ends the reference and starts the next clause.
    if (/[,;]$/.test(token)) break;
  }

  return { subject: kept.join(' '), consumed };
}

/** Splits a run of text into plain segments and citations. */
export function parseCitations(
  text: string,
  vendorFolders: string[],
): (string | Citation)[] {
  const matches = [...text.matchAll(CITATION_PATTERN)];
  if (!matches.length) return [text];

  const parts: (string | Citation)[] = [];
  let cursor = 0;

  matches.forEach((match, i) => {
    const start = match.index ?? 0;
    if (start > cursor) parts.push(text.slice(cursor, start));

    const tag = normaliseTag(match[1]);
    const afterTag = start + match[0].length;
    const nextStart = matches[i + 1]?.index ?? text.length;

    // A gap tag carries its explanation inside the brackets; everything else
    // takes its reference from the text that follows.
    const inside = (match[2] ?? '').trim();
    const { subject, consumed } = GAP_TAGS.has(tag)
      ? { subject: inside, consumed: 0 }
      : readSubject(text.slice(afterTag, nextStart), vendorFolders);

    parts.push({
      tag,
      subject,
      href: resolveCitation(tag, subject, vendorFolders),
      gap: GAP_TAGS.has(tag),
    });

    cursor = afterTag + consumed;
  });

  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}
