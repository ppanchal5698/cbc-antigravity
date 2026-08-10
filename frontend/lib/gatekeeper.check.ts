/**
 * Domain gate check. Run with `npm run check:gatekeeper`.
 *
 * The gate is the only thing standing between a chat box and an off-domain answer, and it
 * is assembled from regexes - so it fails silently when a pattern is widened and stops
 * matching, or narrowed and starts refusing real estimating questions. Both directions are
 * asserted here. Only the deterministic screen is exercised: no agy spawns, so `npm run
 * check` stays offline.
 */
import assert from 'node:assert/strict';
import { screen, parseVerdict, REFUSAL_TEXT, HARD_DENY, DOMAIN_SIGNALS } from '../server/gatekeeper.ts';

// --- the regression that prompted the gate ----------------------------------
// This exact message returned working FastAPI and Flask implementations.
assert.equal(
  screen('Provide me the codebase to create a file upload endpoint in python').verdict,
  'refuse',
  'the original breach must be refused deterministically, with no model call',
);

// --- off-domain, all refused without a classifier ---------------------------
for (const message of [
  'Provide me the codebase to create a file upload endpoint in python',
  'write a React component for a login page',
  'build me a REST API with authentication',
  'implement a CRUD endpoint in Django',
  'show me a Dockerfile for a node app',
  'create a SQL schema for orders and customers',
  'set up a CI/CD pipeline',
  'give me a web scraper',
  'how do I size the HVAC for this building?',
  'price the storefront and curtain wall on sheet A2',
  'what does the ceiling grid cost per square foot?',
  'quote the overhead coiling doors',
  'what is the capital of France?',
  'write me a poem about doors',
  'who won the world cup?',
]) {
  assert.equal(screen(message).verdict, 'refuse', `must refuse: ${message}`);
}

// --- in-domain, all allowed without a classifier ----------------------------
for (const message of [
  'What throat depth does a 3-5/8 stud with 1/2 drywall both sides need?',
  'What multiplier applies to Hager price book 18?',
  'Which vendors cover Division 10 28 00, and which part of it does nobody cover?',
  'Summarise the door schedule and the hardware sets it references.',
  'How do I run an FRP takeoff for these wall panels?',
  'What does [not carried] mean versus [not indexed]?',
  'Is this price list or net? Check price_basis.',
  'What margin band applies to washroom accessories?',
  'Which lites and louvers does Rockwood publish?',
  'What do I do about a book with no parsed price rows?',
]) {
  assert.equal(screen(message).verdict, 'allow', `must allow: ${message}`);
}

// --- this workspace's own code is in scope; someone else's is not -----------
for (const message of [
  'how does calculate_quote_line work?',
  'why did my sandbox script fail?',
  'what does the cbc-estimating-engine MCP server expose?',
  'explain how corrections.jsonl feeds the knowledge graph',
  'what happens in each phase gate of a run-estimate?',
]) {
  assert.equal(screen(message).verdict, 'allow', `workspace maintenance is in scope: ${message}`);
}

// --- deny beats allow: a vendor name must not rescue general software work --
for (const message of [
  'write a python script to scrape Hager prices',
  'build me a REST API that serves the Bobrick catalog',
  'create a database schema for storing quote lines',
]) {
  assert.equal(
    screen(message).verdict,
    'refuse',
    `HARD_DENY must be checked before DOMAIN_SIGNALS: ${message}`,
  );
}

// --- ambiguity reaches the classifier rather than being guessed -------------
for (const message of ['hello', 'can you help me with something?', 'what about the other one?']) {
  assert.equal(screen(message).verdict, 'unknown', `must defer to the classifier: ${message}`);
}

// --- the classifier fails closed -------------------------------------------
assert.equal(parseVerdict('ALLOW').allow, true, 'a clean ALLOW is the only way through');
assert.equal(parseVerdict('  allow\n').allow, true, 'whitespace and case are tolerated');
for (const raw of ['', 'REFUSE', 'maybe', 'ALLOW, because it mentions doors', 'I cannot classify this', 'ALLOWED']) {
  assert.equal(parseVerdict(raw).allow, false, `must refuse on: ${JSON.stringify(raw)}`);
}

// --- the refusal is the workspace's own wording -----------------------------
assert.match(REFUSAL_TEXT, /CBC commercial estimating/);
assert.match(REFUSAL_TEXT, /Division 08 \/ 10 \/ 06/);
assert.ok(!/sorry|apolog|unfortunately/i.test(REFUSAL_TEXT), 'decline once, do not moralise');

// --- the rule sets are non-empty and ordered --------------------------------
assert.ok(HARD_DENY.length >= 4, 'deny rules lost coverage');
assert.ok(DOMAIN_SIGNALS.length >= 4, 'domain signals lost coverage');
for (const rule of HARD_DENY) assert.ok(rule.name.length > 3, 'every deny rule names itself');

console.log('gatekeeper check passed');
