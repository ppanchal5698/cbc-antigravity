/**
 * Citation parsing check. Run with `npm run check:citations`.
 *
 * The tag vocabulary comes from `.agent/workflows/run-estimate.md`; the sample
 * lines are the shapes the agent actually emits in a real estimate.
 */
import assert from 'node:assert/strict';
import { parseCitations, resolveCitation, type Citation } from './citations.ts';
import { rehypeCitations } from './rehype-citations.ts';

const SHELF = ['ASI', 'BOBRICK', 'BRADLEY', 'HAGER', 'NUDO', 'PEMKO', 'ROCKWOOD', 'WORLD DRYER'];

const cites = (text: string): Citation[] =>
  parseCitations(text, SHELF).filter((part): part is Citation => typeof part !== 'string');

const text = (text: string): string =>
  parseCitations(text, SHELF)
    .filter((part): part is string => typeof part === 'string')
    .join('');

// Nothing is lost: plain text round-trips untouched.
assert.deepEqual(parseCitations('No tags at all.', SHELF), ['No tags at all.']);

// A catalog citation resolves to that vendor's page.
const catalog = cites('Priced from [catalog] Hager p.18 for the hinge.');
assert.equal(catalog.length, 1);
assert.equal(catalog[0].tag, 'catalog');
assert.equal(catalog[0].href, '/shelf/HAGER?page=18');
assert.equal(catalog[0].gap, false);

// `catalog-page`, `page 8` and lowercase vendor names all resolve too.
assert.equal(cites('[catalog-page] bobrick page 8')[0].href, '/shelf/BOBRICK?page=8');
assert.equal(cites('[Catalog] PEMKO pg. 42')[0].href, '/shelf/PEMKO?page=42');

// A vendor with no page still reaches the vendor.
assert.equal(cites('[catalog] NUDO direct rows')[0].href, '/shelf/NUDO');

// A vendor that is not on this shelf must not produce a dead link.
assert.equal(cites('[catalog] Allegion p.4')[0].href, null);

// Sheet references reach the sheet index.
assert.equal(cites('[schedule] Sheet A1.1')[0].href, '/sheets?q=A1.1');
assert.equal(cites('[drawing] A-101 door schedule')[0].href, '/sheets?q=A-101');
assert.equal(cites('[spec] G0.02 general notes')[0].href, '/sheets?q=G0.02');

// The three gap tags are marked and never link.
for (const tag of ['not carried', 'not indexed', 'not stated']) {
  const [citation] = cites(`Partitions [${tag}] outside RFQ required`);
  assert.equal(citation.gap, true, `${tag} should be a gap`);
  assert.equal(citation.href, null, `${tag} must not link`);
}

// Two citations in one line each take their own subject, and no text is
// duplicated or dropped in between.
const line = 'Door 03 [schedule] A1.1 priced from [catalog] Hager p.18 today';
const both = cites(line);
assert.equal(both.length, 2);
assert.equal(both[0].subject, 'A1.1');
assert.equal(both[1].subject, 'Hager p.18');
assert.equal(text(line), 'Door 03  priced from  today');

// The subject stops at a clause break rather than swallowing the sentence.
assert.equal(
  cites('[schedule] A1.1, Hardware set HW-1 applies')[0].subject,
  'A1.1',
);

// A citation at the very end leaves no trailing fragment.
assert.deepEqual(
  parseCitations('Confirmed [note]', SHELF).filter((p) => typeof p === 'string'),
  ['Confirmed '],
);

// resolveCitation prefers the longest matching folder, so a short folder name
// that is a substring of a longer one cannot win.
assert.equal(
  resolveCitation('catalog', 'WORLD DRYER p.1', ['ASI', 'WORLD DRYER', 'WORLD']),
  '/shelf/WORLD%20DRYER?page=1',
);

// The rehype pass rewrites prose but must never touch a code span.
const tree = {
  type: 'root',
  children: [
    {
      type: 'element',
      tagName: 'p',
      children: [{ type: 'text', value: 'See [catalog] Hager p.18 now' }],
    },
    {
      type: 'element',
      tagName: 'code',
      children: [{ type: 'text', value: '[catalog] Hager p.18' }],
    },
  ],
};
rehypeCitations(SHELF)(tree);

const paragraph = tree.children[0] as { children: { type: string; tagName?: string }[] };
assert.ok(
  paragraph.children.some((child) => child.type === 'element' && child.tagName === 'a'),
  'prose citation was not linked',
);

const code = tree.children[1] as { children: { type: string; value?: string }[] };
assert.equal(code.children.length, 1, 'code span was rewritten');
assert.equal(code.children[0].value, '[catalog] Hager p.18');

// Unified always invokes plugins as factories: attacher(...options) → transform(tree).
// Passing a pre-bound transform made unified call transform() with no tree, which
// crashed the chat UI. Guard that path, and exercise the factory protocol.
assert.doesNotThrow(() => {
  rehypeCitations(SHELF)(undefined as unknown as typeof tree);
}, 'transform must tolerate a missing tree');

{
  const smoke = {
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'p',
        children: [{ type: 'text', value: 'See [catalog] Bobrick p.8' }],
      },
    ],
  };
  // Same call shape unified uses for `.use(rehypeCitations, SHELF)`.
  const transform = rehypeCitations.call(undefined, SHELF);
  assert.equal(typeof transform, 'function', 'factory must return a transformer');
  transform(smoke);
  const para = smoke.children[0] as { children: { type: string; tagName?: string; properties?: { href?: string } }[] };
  const link = para.children.find((child) => child.type === 'element' && child.tagName === 'a');
  assert.ok(link, 'unified-style factory path did not produce a link');
  assert.equal(link?.properties?.href, '/shelf/BOBRICK?page=8');
}

console.log('citation check passed');
