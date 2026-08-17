'use strict';
/**
 * The /quote route's half of §2.8 — does the LIVE door actually read the Lender Price capture?
 *   node scripts/test-lt-ppe-quote-deep-wiring.js
 *
 * A pure façade test cannot answer that: the façade was always correct about what it was HANDED, and
 * the defect lived entirely in what the route handed it (`lp.price()`'s raw envelope, normalized as if
 * it were the parse() shape, so Lender Price read as INELIGIBLE on every single quote). So this test
 * reads the route's own source for the wiring, and exercises the two pure pieces it owns.
 *
 * No DB, no network, no LP credentials — the route module is not even loaded (it opens a database
 * pool at require time); the source is read as text, which is the point: the assertion is about what
 * the route WIRES, and a live pool proves nothing about that.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'routes', 'ppe.js'), 'utf8');
// Comments NAME the defect this fixes, so a guard that scanned raw text would match its own
// explanation and pass for the wrong reason.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// The quote route's own body, so a match somewhere else in the file cannot stand in for it.
const quoteBody = (() => {
  const i = CODE.indexOf('async function quoteRoute');
  const j = CODE.indexOf('\nasync function breakdownRoute');
  return i >= 0 && j > i ? CODE.slice(i, j) : '';
})();

function main() {
  ok(quoteBody.length > 200, 'the quote route body was located');

  // ---- the capture is READ, and read into all three shapes ------------------
  ok(/lpDetail\s*:/.test(quoteBody), 'W1 the route wires deps.lpDetail');
  ok(/lp\.parse\(raw\)/.test(quoteBody), 'W2 …the ladder shape (client.parse)');
  ok(/lp\.parseFull\(raw\)/.test(quoteBody), 'W3 …the full parse (margin + itemized LLPAs)');
  ok(/lp\.parseDisqualified\(raw\)/.test(quoteBody), 'W4 …and the disqualify tree (decline reasons)');
  ok(/answer\s*&&\s*answer\.raw/.test(quoteBody), 'W5 all three read the envelope\'s RAW body, not the envelope');

  // The disqualify tree is computed asynchronously; parsing one that is not there would report an
  // empty decline set as a real "Lender Price declined nothing".
  ok(/hasDisqualifyData\(raw\)/.test(quoteBody), 'W6 the route ASKS whether the disqualify tree is ready');
  ok(/ready:\s*false/.test(quoteBody), 'W7 …and reports it as not-ready rather than as an empty answer');

  // ---- the deep tolerances actually reach the detectors ---------------------
  ok(/marginToleranceMilli:\s*settings\[K\.marginTolerance\]/.test(quoteBody), 'W8 the margin tolerance comes from settings, never a literal');
  ok(/basePriceToleranceMilli:\s*settings\[K\.basePriceTolerance\]/.test(quoteBody), 'W9 …as does the base-price tolerance');

  // ---- the Lender Price scope ---------------------------------------------
  ok(/lpFilter:\s*lpFilterOf\(/.test(quoteBody), 'W10 the scope is passed through the validator');

  const routes = require('../src/longterm/ppe/facade'); // pure, no DB
  eq(typeof routes.priceWithShadow, 'function', 'W11 the façade is the thing being wired');

  // ---- lpFilterOf: the validator itself (pure, re-declared here from source) -
  // eslint-disable-next-line no-new-func
  const lpFilterOf = new Function(`${CODE.match(/const LP_FILTER_KEYS[\s\S]*?\n}/)[0]}\nreturn lpFilterOf;`)();

  eq(lpFilterOf(null), null, 'F1 no filter → null (not scoped), never an empty match-everything');
  eq(lpFilterOf({}), null, 'F2 an empty object → null');
  eq(lpFilterOf([]), null, 'F3 an array → null');
  eq(lpFilterOf({ program: '   ' }), null, 'F4 whitespace is not a scope');
  assert.deepStrictEqual(lpFilterOf({ program: ' DSCR 30 Yr Fixed ' }), { program: 'DSCR 30 Yr Fixed' }, 'F5 a real program is trimmed and kept');
  n += 1;
  assert.deepStrictEqual(lpFilterOf({ investor: 'Deephaven', lender: 'Deephaven' }), { investor: 'Deephaven', lender: 'Deephaven' }, 'F6 several equality keys are kept');
  n += 1;

  // THE ONE THAT MATTERS: `programLike` is compiled with `new RegExp(...)` downstream and /quote is
  // NOT admin-gated, so accepting it over HTTP would let any caller hand the server a pattern to
  // compile and run. A few characters of nested quantifier is a request that never returns.
  eq(lpFilterOf({ programLike: '(a+)+$' }), null, 'F7 a regex pattern is REFUSED over HTTP');
  assert.deepStrictEqual(lpFilterOf({ program: 'P', programLike: '(a+)+$' }), { program: 'P' }, 'F8 …and dropped without taking the rest of the filter with it');
  n += 1;
  eq(lpFilterOf({ program: 'x'.repeat(5000) }), null, 'F9 an absurdly long value is refused');
  eq(lpFilterOf({ program: 42 }), null, 'F10 a non-string is refused');

  console.log(`ok - lt ppe /quote deep wiring (${n} assertions)`);
}

main();
