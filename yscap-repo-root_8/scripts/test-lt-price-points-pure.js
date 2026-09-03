'use strict';
/**
 * PRICE AND POINTS ARE ONE NUMBER SAID TWO WAYS — one definition of the identity.
 *
 * ── WHAT THIS GUARDS, AND WHY IT IS NOT COSMETIC ───────────────────────────
 * `points = 100 − price` was written out in TEN places across FOUR server files,
 * each reaching for its own rounding helper — and those helpers had already
 * drifted. Measured on 2026-09-03, before the change:
 *
 *   parse.js `round3`        null → null,  non-finite → NaN
 *   breakdown.js `round3`    null → null,  non-finite → null
 *   quote-shape.js `round3`  null → null,  non-finite → null
 *   vendor-margin.js `r3`    null → NaN,   non-finite → NaN
 *
 * So one missing figure came back `null` from one file and `NaN` from the next.
 * NaN is the worse answer at every one of those sites: it survives `!= null`,
 * prints as "NaN" on a rate board, and loses every numeric comparison in silence
 * rather than reading as "the sheet did not state this".
 *
 * ── SECTION D IS THE ONE THAT MATTERS MOST ─────────────────────────────────
 * A truth table proves the module. It cannot prove that the ELEVENTH site does
 * not get written next year — which is how this drift arrived in the first place
 * — so D sweeps the Long-Term server tree for a re-inlined identity and fails on
 * one. That check is the actual deliverable; the rest is the module's contract.
 *
 * PURE: no database, no network. Runs everywhere `npm test` runs.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const PP = require(path.join(ROOT, 'src/longterm/pricing/price-points'));
const { pointsFromPrice, priceFromPoints } = PP;

let pass = 0;
const ok = (c, n) => { assert.ok(c, n); pass++; console.log('  ok  ' + n); };
const eq = (a, b, n) => { assert.deepStrictEqual(a, b, `${n} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); pass++; console.log('  ok  ' + n); };

/* The battery: every thousandth across the range both sheets actually quote in,
   plus par, zero, a negative (a price under par states positive points) and the
   three FOUR-decimal prices this integration measured live on 2026-09-03. */
const THREE_DP = [];
for (let v = 90; v <= 110; v += 0.001) THREE_DP.push(Math.round(v * 1000) / 1000);
const EXTRA = [0, 100, 99.999, -3.5, 1e6];
const FOUR_DP = [104.1762, 100.7605, 103.8855];

console.log('\nA · the identity, in both directions');
{
  eq(pointsFromPrice(100), 0, 'A1 par is zero points — the anchor the whole scale is measured from');
  eq(pointsFromPrice(101.5), -1.5, 'A2 a price above par is a CREDIT, so the points go negative');
  eq(pointsFromPrice(98.25), 1.75, 'A3 …and a price below par is a cost');
  eq(priceFromPoints(1.75), 98.25, 'A4 the other way round, same arithmetic');
  eq(priceFromPoints(0), 100, 'A5 zero points is par');
  eq(pointsFromPrice(104.176), -4.176, 'A6 three decimals are kept — both sheets quote to the thousandth');
}

console.log('\nB · anything that is not a real number is NULL, never NaN');
{
  for (const [v, label] of [[null, 'null'], [undefined, 'undefined'], ['', 'an empty string'],
    [NaN, 'NaN'], [Infinity, 'Infinity'], [-Infinity, '-Infinity'], ['abc', 'a word'], [{}, 'an object']]) {
    eq(pointsFromPrice(v), null, `B1 ${label} answers null`);
  }
  /* ⛔ THE EMPTY STRING IS THE ONE WORTH SAYING OUT LOUD. `Number('')` is 0, so a
     blank field read through the old helpers came back as a confident 100 points —
     par — rather than as "the sheet did not state this". */
  eq(pointsFromPrice(''), null, 'B2 A BLANK FIELD IS NOT PAR — `Number("")` is 0, so the old spelling answered a confident 100');
  eq(priceFromPoints(''), null, 'B2b …in both directions');
  ok(!Number.isNaN(pointsFromPrice(NaN)), 'B3 NaN never comes back out — it survives `!= null` and prints on a board');
  eq(pointsFromPrice('101.5'), -1.5, 'B4 a vendor that states a price as a STRING still reads as that price');
}

console.log('\nC · a figure at the published precision comes back to itself');
{
  const bad = [...THREE_DP, ...EXTRA].filter((x) => !Object.is(priceFromPoints(pointsFromPrice(x)), x));
  eq(bad.length, 0, `C1 all ${THREE_DP.length + EXTRA.length} three-decimal figures round-trip exactly`);
  const four = FOUR_DP.filter((x) => !Object.is(priceFromPoints(pointsFromPrice(x)), x));
  eq(four.length, FOUR_DP.length,
    'C2 …and a FOURTH decimal cannot, by arithmetic — which is exactly why `priceExact` must never be round-tripped through here');
  eq(pointsFromPrice(104.1762), -4.176, 'C2b the fourth decimal is dropped, not carried');
}

console.log('\nD · the identity is written in ONE place, and stays there');
{
  /* The shapes a re-inlined identity takes: `100 - price`, `100-price`, `(100 - x)`.
     Comments are stripped first — this file's own explanation necessarily contains
     the expression, and a guard that read comments would fail on the prose that
     documents it and then be "fixed" by deleting the explanation. */
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const RE = /\b100\s*-\s*(?!\s*$)[A-Za-z_$(]/;
  const skip = new Set(['price-points.js']);
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js') || skip.has(e.name)) continue;
      const src = stripComments(fs.readFileSync(p, 'utf8'));
      for (const line of src.split('\n')) {
        if (!RE.test(line)) continue;
        // A percentage is a different rule and is not this identity.
        if (/pct|percent|ltv|Ltv|LTV|cltv|width|height|progress/.test(line)) continue;
        hits.push(path.relative(ROOT, p) + ': ' + line.trim().slice(0, 90));
      }
    }
  };
  walk(path.join(ROOT, 'src/longterm'));
  eq(hits, [], 'D1 NOBODY re-inlines `100 − price` on the server — that drift is what this module ended');

  /* THE LIST IS TWELVE SITES ACROSS FIVE FILES, and the last two were found by the
     sweep above rather than by the audit that started this — `lenderprice/client.js`
     derives a price from adjusted points in its own parser, which nobody had counted.
     That is the whole argument for D1 being a sweep and not a list. */
  for (const f of ['loannex/parse.js', 'lenderprice/client.js', 'pricing/breakdown.js', 'pricing/quote-shape.js', 'pricing/vendor-margin.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'src/longterm', f), 'utf8');
    ok(/require\(['"][^'"]*price-points['"]\)/.test(src), `D2 ${f} asks the one definition`);
  }

  /* ⛔ THE GUARD MUST BE PROVEN TO BITE, or it is decoration. A line of the shape
     it hunts is fed straight to it here, so a regex that stopped matching would
     fail this assertion rather than silently passing the whole sweep. */
  ok(RE.test('      const points = round3(100 - price);'), 'D3 the sweep really does recognise a re-inlined identity');
  ok(RE.test('  basePoints: r3(100-statedPrice),'), 'D3b …with or without the spaces');
  ok(!RE.test('  const share = 100 - 0;'), 'D3c …and does not fire on a literal, which is arithmetic rather than a copy of the rule');
}

console.log('\nE · the change was NEUTRAL on every real number');
{
  /* The four helper spellings exactly as they stood before this module existed.
     A shared definition that quietly moved a price would be far worse than the
     drift it replaced, so the claim is measured rather than asserted. */
  const parseRound3 = (n) => (n == null ? null : Math.round(Number(n) * 1000) / 1000);
  const strictRound3 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 1000) / 1000);
  const marginR3 = (n) => Math.round(Number(n) * 1000) / 1000;
  const OLD = [parseRound3, strictRound3, marginR3];

  let compared = 0;
  const drift = [];
  for (const x of [...THREE_DP, ...EXTRA, ...FOUR_DP]) {
    const want = pointsFromPrice(x);
    for (const fn of OLD) { compared++; if (!Object.is(fn(100 - x), want)) drift.push([x, fn(100 - x), want]); }
  }
  eq(drift.slice(0, 3), [], 'E1 not one real number moved');
  ok(compared > 60000, `E1b …measured over ${compared.toLocaleString('en-US')} old-vs-new comparisons, not a handful`);
}

console.log('\nF · the identity may NOT be used where there is an anchor to shift');
{
  /* ⛔ THE RULE THIS SECTION EXISTS FOR, and it survived a mutation before it was written.
   *
   * `vendor-margin`'s header has always said the holdback SHIFTS the points rather than
   * re-deriving them from the rounded price — and nothing enforced it. Replacing the shift
   * with `pointsFromPrice(price)` passed every suite in this repo.
   *
   * It is not a stylistic rule. The parser takes its points off the vendor's UNROUNDED price
   * (`priceExact`, which on the live LoanNEX board carries a fourth decimal on 269 of 4,396
   * rungs); recomputing takes them off the ROUNDED, held-back one, and the two land a
   * thousandth apart far more often than 'edge case' suggests. MEASURED over 1,200,006
   * combinations — every ten-thousandth of a price from 90 to 110 against six holdbacks —
   * they disagree on 53,631 of them, 4.47%. A board whose price and points disagree by 0.001
   * is a board somebody spends an afternoon on. */
  const vendorMargin = require(path.join(ROOT, 'src/longterm/pricing/vendor-margin'));

  const rungFor = (vendorPrice) => ({
    rate: 7.5,
    price: Math.round(vendorPrice * 1000) / 1000,
    vendorPrice,
    priceExact: vendorPrice,
    points: pointsFromPrice(vendorPrice),   // as the parser derives it: off the UNROUNDED price
  });
  const heldBack = (vendorPrice) => vendorMargin.applyToBoard(
    { source: 'loannex', programs: [{ investor: 'Acra', rungs: [rungFor(vendorPrice)] }] },
    'loannex', {}).programs[0].rungs[0];

  /* Three vendor prices whose shifted and recomputed points genuinely differ. If the
     production code ever recomputes, every one of these moves by a thousandth. */
  for (const [vendorPrice, wantPoints] of [[90.0015, 10.249], [100.0015, 0.249], [103.8865, -3.636]]) {
    const r = heldBack(vendorPrice);
    eq(r.points, wantPoints,
      `F1 ${vendorPrice} keeps the points the parser derived, moved by the holdback — not re-derived from the rounded price`);
    ok(r.points !== pointsFromPrice(r.price),
      `F1b …and ${vendorPrice} is a case where the two genuinely differ, so F1 is not passing for free`);
  }

  /* AND THE OTHER HALF: with no points to shift, the identity IS the right answer.
     A rule that only ever refused would be no rule at all. */
  {
    const board = { source: 'loannex', programs: [{ investor: 'Acra', rungs: [{ rate: 7.5, price: 101.5 }] }] };
    const r = vendorMargin.applyToBoard(board, 'loannex', {}).programs[0].rungs[0];
    eq(r.points, pointsFromPrice(r.price),
      'F2 a rung the sheet stated no points for takes them from the identity — there is no anchor to shift');
  }

  /* ⛔ AND `priceExact` IS NEVER TOUCHED. It is the vendor's own price to the last decimal,
     kept so LoanNEX can still recognise a quote we hand back — a held-back or rounded copy
     is a price its sheet has never quoted, which is the defect that field was added to end. */
  {
    const r = heldBack(104.1762);
    eq(r.priceExact, 104.1762, 'F3 `priceExact` rides through the holdback unshifted and unrounded');
    ok(r.price !== r.priceExact, 'F3b …while the price beside it is both');
  }
}
console.log(`\n${pass} checks passed`);
