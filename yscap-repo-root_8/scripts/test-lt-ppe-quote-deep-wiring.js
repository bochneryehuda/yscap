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
  // The scope comes from the sheet's OWN stored statement (db/574), loaded beside the program, and
  // from nowhere else. Its own validation lives in `lp-scope.js` and is tested there
  // (scripts/test-lt-ppe-lp-scope.js); what belongs HERE is that the route reads it from the right
  // place and hands it to the comparison.
  // The assertion is that the SCOPE rides out of `loadProgram` — not that `loadProgram` returns
  // exactly three things. It also carries the per-investor margin resolver now, and pinning the
  // whole destructuring would fail the next thing that legitimately travels with the program and
  // invite somebody to bend the route to fit the test instead.
  ok(/const \{[^}]*\blpScope\b[^}]*\} = await loadProgram\(/.test(quoteBody),
    'W10 the quote route loads the sheet\'s stored scope alongside the program');
  ok(/lpFilter:\s*lpScope\b/.test(quoteBody), 'W11 …and hands exactly that to the comparison');

  // A SECOND SOURCE IS THE THING TO KEEP OUT. The transitional request-body scope that shipped with
  // the deep comparison is gone: two sources for one fact are free to disagree, and a caller-supplied
  // scope could silently point a comparison at a program nobody chose. `programLike` is compiled with
  // `new RegExp(...)` and /quote is NOT admin-gated, so accepting one over HTTP would additionally let
  // any caller hand the server a pattern to compile and run — a few characters of nested quantifier is
  // a request that never returns.
  ok(!/b\.lpFilter/.test(CODE), 'W12 the scope is NEVER read from the request body');
  ok(!/lpFilterOf/.test(CODE), 'W13 …and the transitional body-reader is gone, not merely unused');

  const routes = require('../src/longterm/ppe/facade'); // pure, no DB
  eq(typeof routes.priceWithShadow, 'function', 'W14 the façade is the thing being wired');

  console.log(`ok - lt ppe /quote deep wiring (${n} assertions)`);
}

main();
