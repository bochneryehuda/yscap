/**
 * THE SPEED PROGRAM'S THREE ENGINE LEVERS — owner-authorized 2026-09-03 (decision D1 of
 * docs/SPEED-PROGRAM-RESEARCH.md: "Approved on all nine decisions, start building phase 1
 * … not to rebuild anything, just share the code of the two programs"). PURE, no DB, no
 * network.
 *
 * The Speed Program runs the Standard (Fidelis) and Silver (EMCAP) engines under ONE
 * combined ceiling — the lesser of the two on every axis — with the assignment fee
 * financeable at 10% instead of 15%. Pinning that ceiling from OUTSIDE the engines
 * needed three levers that did not exist:
 *
 *   `targetAcqLTV`      — a voluntary ceiling on the acquisition wall (both engines)
 *   `targetARLTV`       — the after-repair ceiling Silver already had, now on Standard
 *   `assignmentMaxPct`  — the financeable share of an assignment fee, a MIN against 0.15
 *
 * Both engines are FROZEN, so the bar is not "the levers work" — it is:
 *
 *   A. INERT WHEN UNSET. With none of the three set, every engine is byte-identical to
 *      the same engine WITHOUT the lever lines, over a broad matrix. The baseline is
 *      built by REMOVING / NEUTRALIZING the lever lines from today's source through
 *      scripts/lib/engine-baseline.js (never `git show HEAD:`), and the strip is proven
 *      to have BITTEN, so this can never degenerate into "the engine equals itself".
 *   B. A LEVER CAN ONLY EVER REDUCE, and when it bites the achieved ratio lands at or
 *      under the requested ceiling; the financed rehab is untouched — the cut comes
 *      off the INITIAL advance (the owner's "if it's capping something, it should cap
 *      the initial").
 *   C. THE 10% ASSIGNMENT MATH IS THE 15% MATH WITH A DIFFERENT NUMBER — same formula,
 *      same fields, same message shape; the label prints the share applied; a share
 *      ABOVE 15% is clamped to 15% (the lever can never loosen the company rule).
 *   D. THE ADMIN BASIS STILL WINS (ovrAcqLTV / ovrARLTV / ovrEffPrice), exactly as for
 *      targetLTC and targetLoan.
 *   E. THE CEILING THE COMPOSITION WILL READ IS THE PINNED ONE — Standard's `caps`,
 *      Silver's `pricedCeiling` — and Silver's step-down lattice never climbs back
 *      above a pinned acquisition wall.
 *   F. A NON-BINDING LEVER IS A COMPLETE NO-OP, RATE INCLUDED (the guard CLAUDE.md
 *      requires of every overlay: a size comparison cannot see a hidden rate change).
 *
 * Gold is not touched by this change; it is in the baseline set so the shared
 * `sizeLoan` is proven unchanged from its side too.
 *
 * MUTATION EVIDENCE (measured before this landed, recorded in the PR): with the
 * Standard `targetAcqLTV` MIN turned into a MAX, B1 and E1 went red; with the clamp
 * `Math.min(0.15, …)` raised to 0.16, C3 went red; with the lever line deleted from
 * one engine, the baseline strip refused to build (count 0 ≠ 1). The unmutated
 * engine was green either side of each.
 */
'use strict';

const EB = require('./lib/engine-baseline');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const num = (v) => (isFinite(Number(v)) ? Number(v) : 0);
const r2 = (n) => Math.round(n * 100) / 100;

/* THE THREE LEVER LINES, as they read in the engines. Each regex is /gm over whole
   lines; the expected count per engine is exact; a residual reference fails the strip.
   `assignmentMaxPct` is NEUTRALIZED rather than deleted (the line declares `maxPct`,
   which the lines below it read), so its "engine without the lever" is the same line
   with the constant 0.15 — a one-line, countable, verifiable edit, and its bite is
   proven by assertStripBit rather than a text search (see engine-baseline.js). */
const LEVERS = [
  { re: /^.*if \(input\.targetAcqLTV && input\.targetAcqLTV > 0\).*$\n/gm,
    expect: { 'standard-program': 1, 'silver-program': 1 }, residual: /input\.targetAcqLTV/ },
  // Silver's own targetARLTV lever (2026-08-06) is stripped alongside Standard's new
  // one: the baseline must be BOTH engines without the lever, and the engine-baseline
  // helper requires the count to be stated for every engine that carries the line.
  { re: /^.*if \(input\.targetARLTV && input\.targetARLTV > 0\).*$\n/gm,
    expect: { 'standard-program': 1, 'silver-program': 1 }, residual: /input\.targetARLTV/ },
  { re: /^.*var maxPct = \(input\.assignmentMaxPct > 0\) \? Math\.min\(0\.15, input\.assignmentMaxPct\) : 0\.15;.*$\n/gm,
    expect: { 'standard-program': 1, 'silver-program': 1 }, with: '      var maxPct = 0.15;\n', residual: /input\.assignmentMaxPct/ },
];

const BASE = EB.baselineEngines(LEVERS);
const LIVE = EB.liveEngines();
const ENGINES = ['standard-program', 'silver-program', 'gold-standard'];
const LEVERED = ['standard-program', 'silver-program'];

/** A broad, deterministic matrix — the shapes the engines actually take. */
function scenarios() {
  const out = [];
  const places = [
    { state: 'NJ', city: 'Newark', zip: '07102' }, { state: 'FL', city: 'Miami', zip: '33101' },
    { state: 'TX', city: 'Dallas', zip: '75201' }, { state: 'OH', city: 'Columbus', zip: '43215' },
    { state: 'CA', city: 'Los Angeles', zip: '90012' },
  ];
  const strategies = ['Fix & Flip', 'Fix & Hold (BRRRR)', 'Ground-up Construction', 'Bridge'];
  for (const place of places) for (const strategy of strategies) for (const loanType of ['Purchase', 'Refinance'])
    for (const fico of [640, 700, 760]) for (const arv of [450000, 900000]) for (const rehab of [0, 80000, 200000])
      for (const exp of [0, 2, 6]) for (const irMonths of [0, 6])
        for (const asg of (loanType === 'Purchase' ? ['none', 'small', 'large'] : ['none'])) {
          const seller = Math.round(arv * 0.62);
          const fee = asg === 'none' ? 0 : asg === 'small' ? Math.round(seller * 0.08) : Math.round(seller * 0.25);
          out.push({
            loanType, strategy, state: place.state, city: place.city, zip: place.zip,
            propertyType: 'SFR (1 unit)', units: 1,
            purchasePrice: seller + fee, sellerPrice: asg === 'none' ? 0 : seller, isAssignment: asg !== 'none',
            asIsValue: Math.round(arv * 0.66), arv, rehabBudget: rehab, fico, term: 12, irMonths,
            expFlips: exp, expHolds: 0, expGround: exp,
          });
        }
  return out;
}

const CASES = scenarios();
const sized = (ev) => !!(ev && ev.sizing && ev.sizing.totalLoan > 0);
console.log(`scenario matrix: ${CASES.length} cases × ${ENGINES.length} engines\n`);

// ---- Strip bit: the baseline genuinely lacks each lever --------------------------------
{
  // An engaging scenario for the share lever is one whose fee EXCEEDS 10% of the seller
  // price — a fee under the cap is untouched by it, on the baseline and the live engine alike.
  const asg = CASES.find((c) => c.isAssignment && (c.purchasePrice - c.sellerPrice) > 0.10 * c.sellerPrice
    && sized(LIVE['standard-program'].evaluate(c)) && sized(LIVE['silver-program'].evaluate(c)));
  const val = CASES.find((c) => c.loanType === 'Purchase' && !c.isAssignment && c.rehabBudget > 0
    && sized(LIVE['standard-program'].evaluate(c)) && sized(LIVE['silver-program'].evaluate(c)));
  EB.assertStripBit(assert, BASE, LIVE, Object.assign({}, asg, { assignmentMaxPct: 0.10 }), LEVERED, 'assignmentMaxPct');
  EB.assertStripBit(assert, BASE, LIVE, Object.assign({}, val, { targetAcqLTV: 0.40 }), LEVERED, 'targetAcqLTV');
  EB.assertStripBit(assert, BASE, LIVE, Object.assign({}, val, { targetARLTV: 0.40 }), LEVERED, 'targetARLTV');
}

// ---- A. INERT WHEN UNSET ---------------------------------------------------------------
for (const e of ENGINES) {
  let drift = 0, priced = 0, first = null;
  for (const c of CASES) {
    const a = EB.shape(BASE[e].evaluate(c)), b = EB.shape(LIVE[e].evaluate(c));
    if (a !== b) { drift++; if (!first) first = { c, a, b }; }
    if (sized(LIVE[e].evaluate(c))) priced++;
  }
  assert(drift === 0, `A1 ${e}: with every lever UNSET the engine is byte-identical to the same engine WITHOUT the levers, over ${CASES.length} scenarios (drift: ${drift})`);
  if (first) console.log('    first drift:', JSON.stringify(first.c), '\n    was:', first.a, '\n    now:', first.b);
  assert(priced > CASES.length * 0.2, `A2 ${e}: the matrix is meaningful — ${priced} of ${CASES.length} scenarios price`);
}

// An explicit 0 / null / blank / non-number lever reads as "no lever", never as a zero cap.
{
  let drift = 0, checked = 0;
  for (const e of LEVERED) for (const c of CASES) {
    const base = EB.shape(BASE[e].evaluate(c));
    for (const v of [0, null, undefined, '', 'abc', -0.5, NaN]) {
      for (const k of ['targetAcqLTV', 'targetARLTV', 'assignmentMaxPct']) {
        checked++;
        if (EB.shape(LIVE[e].evaluate(Object.assign({}, c, { [k]: v }))) !== base) drift++;
      }
    }
  }
  assert(drift === 0, `A3 a 0 / null / blank / non-numeric / negative lever is "no lever", never a zero cap (${checked} checked, drift: ${drift})`);
}

// ---- F. A NON-BINDING LEVER IS A COMPLETE NO-OP — RATE, REASONS AND CAPS INCLUDED ------
{
  let drift = 0, checked = 0, first = null;
  for (const e of LEVERED) for (const c of CASES) {
    const ev = LIVE[e].evaluate(c);
    if (!sized(ev)) continue;
    const before = EB.shape(ev);
    for (const pin of [{ targetAcqLTV: 0.99 }, { targetARLTV: 0.99 }, { assignmentMaxPct: 0.15 }, { assignmentMaxPct: 0.50 },
      { targetAcqLTV: 0.99, targetARLTV: 0.99, assignmentMaxPct: 0.50 }]) {
      checked++;
      const after = EB.shape(LIVE[e].evaluate(Object.assign({}, c, pin)));
      if (before !== after) { drift++; if (!first) first = { e, c, pin, before, after }; }
    }
  }
  assert(checked > 1000 && drift === 0, `F1 a ceiling ABOVE every cap, or a share AT/ABOVE the 15% rule, changes NOTHING — rate, reasons and caps included (${checked} checked, drift: ${drift})`);
  if (first) console.log('    first drift:', first.e, JSON.stringify(first.pin), JSON.stringify(first.c), '\n    was:', first.before, '\n    now:', first.after);
}

// ---- B. THE TWO LEVERAGE LEVERS ONLY REDUCE, BITE, AND TAKE FROM THE INITIAL -----------
for (const e of LEVERED) {
  for (const lever of [{ k: 'targetAcqLTV', rungs: [0.80, 0.70, 0.60], ratio: (s) => s.acqLtvPct },
                       { k: 'targetARLTV', rungs: [0.70, 0.65, 0.60], ratio: (s) => s.arvPct }]) {
    let grew = 0, bit = 0, over = 0, rehabShrank = 0, initialGrew = 0, reserveAbsorbed = 0, checked = 0;
    for (const c of CASES) {
      const full = LIVE[e].evaluate(c);
      if (!sized(full)) continue;
      const bridge = full.strategyCode === 'BR';
      for (const rung of lever.rungs) {
        const cut = LIVE[e].evaluate(Object.assign({}, c, { [lever.k]: rung }));
        if (!sized(cut)) continue;
        checked++;
        const f = full.sizing, s = cut.sizing;
        if (s.totalLoan > f.totalLoan + 1e-6) grew++;
        if (s.totalLoan < f.totalLoan - 1) {
          bit++;
          // The ARV ratio is a wall only on a value-add product (a bridge is sized on the as-is value).
          if (!(lever.k === 'targetARLTV' && bridge) && num(lever.ratio(s)) > rung + 1e-6) over++;
          if (s.rehabLoan < f.rehabLoan - 1) rehabShrank++;
          // The frozen waterfall finances the rehab first, then the initial advance, then
          // fits the reserve; a lower after-repair wall on a reserve-carrying deal can be
          // absorbed by the reserve before the initial moves. What must never happen is
          // money shifting INTO the initial while the loan shrinks.
          if (s.acquisition > f.acquisition + 0.5) initialGrew++;
          if (!(s.acquisition < f.acquisition - 0.5)) reserveAbsorbed++;
        }
      }
    }
    assert(checked > 0, `B0 ${e} ${lever.k}: exercised on ${checked} priced scenario/rung pairs`);
    assert(grew === 0, `B1 ${e} ${lever.k}: a set lever NEVER produces a larger loan than no lever (violations: ${grew})`);
    assert(bit > 0, `B2 ${e} ${lever.k}: the lever genuinely bites — ${bit} pairs sized smaller`);
    assert(over === 0, `B3 ${e} ${lever.k}: …and the achieved ratio never exceeds the requested ceiling (violations: ${over})`);
    assert(rehabShrank === 0, `B4 ${e} ${lever.k}: a cut never shrinks the financed rehab (violations: ${rehabShrank})`);
    /* Silver's OWN after-repair lever (2026-08-06, not part of this change) may pick a
       different step-down candidate under a pin — measured: unpinned it had stepped the
       loan-to-cost down to 90% to reach a priced cell; pinned to a 65% after-repair wall
       it lands on a priced cell at 92.5% loan-to-cost, so the reserve shrinks and the
       initial rises while the LOAN still shrinks (B1) under the ceiling (B3). That is the
       frozen lattice's stated preference for the larger initial advance, owned by
       test-silver-arv-lever-pure.js. B5 is asserted on the levers THIS change adds. */
    if (e === 'silver-program' && lever.k === 'targetARLTV') {
      console.log(`INFO B5 ${e} ${lever.k}: ${bit - reserveAbsorbed} cuts off the initial, ${reserveAbsorbed} absorbed by the reserve, ${initialGrew} re-allocated by the step-down lattice (pre-existing lever — not asserted here)`);
    } else {
      assert(initialGrew === 0, `B5 ${e} ${lever.k}: a cut never moves money INTO the initial advance — it comes off the initial or the financed reserve (${bit - reserveAbsorbed} off the initial, ${reserveAbsorbed} absorbed by the reserve; violations: ${initialGrew})`);
    }
  }
}

// ---- C. THE 10% ASSIGNMENT RULE IS THE 15% RULE WITH A DIFFERENT NUMBER ----------------
for (const e of LEVERED) {
  let checked = 0, badPct = 0, badFee = 0, badPrice = 0, badExcess = 0, badMsg = 0, grew = 0, overAcq = 0, clampDrift = 0, msg15 = 0;
  for (const c of CASES) {
    if (!c.isAssignment) continue;
    const at15 = LIVE[e].evaluate(c);
    const at10 = LIVE[e].evaluate(Object.assign({}, c, { assignmentMaxPct: 0.10 }));
    if (!at10 || !at10.assignment) continue;
    checked++;
    const a = at10.assignment, fee = c.purchasePrice - c.sellerPrice;
    const wantFin = r2(Math.min(fee, 0.10 * c.sellerPrice));
    if (a.maxPct !== 0.10) badPct++;
    if (a.financeableFee !== wantFin || a.maxFee !== r2(0.10 * c.sellerPrice)) badFee++;
    if (a.recognizedPrice !== r2(c.sellerPrice + wantFin)) badPrice++;
    if (a.excessOOP !== r2(fee - wantFin)) badExcess++;
    // The message is written after the hard gates — a deal refused before sizing carries
    // the assignment figures but no messaging, on this engine as before it.
    if (a.overLimit && sized(at10)) {
      const m = (at10.reasons || []).find((r) => /assignment fee is financed \(the /.test(r.msg));
      if (!m || !/\(the 10% cap is /.test(m.msg) || !/, 10% of the /.test(m.msg)) badMsg++;
    }
    if (sized(at10) && sized(at15)) {
      if (at10.sizing.totalLoan > at15.sizing.totalLoan + 1e-6) grew++;
      const denom = Math.min(a.recognizedPrice, c.asIsValue);
      const cap = ((at10.pricedCeiling || at10.caps) || {}).maxAcqLTV;
      if (cap && at10.sizing.acquisition > cap * denom + 1) overAcq++;
    }
    // At 15% the message still reads exactly as it always has.
    if (at15 && at15.assignment && at15.assignment.overLimit && sized(at15)) {
      const m = (at15.reasons || []).find((r) => /assignment fee is financed \(the /.test(r.msg));
      if (!m || !/\(the 15% cap is /.test(m.msg) || !/, 15% of the /.test(m.msg)) msg15++;
    }
    // A share above the rule is the rule: 0.16 / 0.5 / 1 price exactly like unset.
    for (const v of [0.16, 0.5, 1]) if (EB.shape(LIVE[e].evaluate(Object.assign({}, c, { assignmentMaxPct: v }))) !== EB.shape(at15)) clampDrift++;
  }
  assert(checked > 0, `C0 ${e}: ${checked} assignment scenarios exercised at 10%`);
  assert(badPct === 0, `C1 ${e}: the assignment object reports the share applied (maxPct 0.10) (violations: ${badPct})`);
  assert(badFee === 0 && badPrice === 0 && badExcess === 0, `C2 ${e}: financeable = min(fee, 10% × seller), effective price = seller + financeable, excess = the rest — the 15% formula with 0.10 (violations: ${badFee}/${badPrice}/${badExcess})`);
  assert(clampDrift === 0, `C3 ${e}: a share above 15% is clamped to 15% — the lever can never loosen the company rule (drift: ${clampDrift})`);
  assert(badMsg === 0 && msg15 === 0, `C4 ${e}: the over-cap message prints the share applied ("10% cap" at 10%, "15% cap" unset) (violations: ${badMsg}/${msg15})`);
  assert(grew === 0, `C5 ${e}: the 10% basis never produces a larger loan than the 15% basis (violations: ${grew})`);
  assert(overAcq === 0, `C6 ${e}: the initial advance respects the acquisition cap measured on the 10% effective price — the owner's trap, asserted (violations: ${overAcq})`);
}

// ---- D. THE ADMIN BASIS STILL WINS -----------------------------------------------------
for (const e of LEVERED) {
  const c = CASES.find((x) => x.loanType === 'Purchase' && x.rehabBudget > 0 && sized(LIVE[e].evaluate(x)));
  assert(EB.shape(LIVE[e].evaluate(Object.assign({}, c, { targetAcqLTV: 0.5, ovrAcqLTV: 0.9 }))) === EB.shape(LIVE[e].evaluate(Object.assign({}, c, { ovrAcqLTV: 0.9 }))),
    `D1 ${e}: ovrAcqLTV beats targetAcqLTV, exactly as ovrLTC beats targetLTC`);
  assert(EB.shape(LIVE[e].evaluate(Object.assign({}, c, { targetARLTV: 0.5, ovrARLTV: 0.75 }))) === EB.shape(LIVE[e].evaluate(Object.assign({}, c, { ovrARLTV: 0.75 }))),
    `D2 ${e}: ovrARLTV beats targetARLTV`);
  const a = CASES.find((x) => x.isAssignment && x.purchasePrice - x.sellerPrice > 0.15 * x.sellerPrice && sized(LIVE[e].evaluate(x)));
  const ovr = a.sellerPrice + Math.round(0.2 * a.sellerPrice);
  assert(EB.shape(LIVE[e].evaluate(Object.assign({}, a, { assignmentMaxPct: 0.10, ovrEffPrice: ovr }))) === EB.shape(LIVE[e].evaluate(Object.assign({}, a, { ovrEffPrice: ovr }))),
    `D3 ${e}: an admin effective-price exception sizes the same deal whatever the share lever says`);
}

// ---- E. THE CEILING THE COMPOSITION READS IS THE PINNED ONE ---------------------------
for (const e of LEVERED) {
  let checked = 0, bad = 0, climbed = 0;
  for (const c of CASES) {
    const full = LIVE[e].evaluate(c);
    if (!sized(full)) continue;
    const own = (full.pricedCeiling || full.caps);
    for (const pin of [0.80, 0.70, 0.60]) {
      const ev = LIVE[e].evaluate(Object.assign({}, c, { targetAcqLTV: pin }));
      if (!sized(ev)) continue;
      checked++;
      const cap = (ev.pricedCeiling || ev.caps).maxAcqLTV;
      if (Math.abs(cap - Math.min(own.maxAcqLTV, pin)) > 1e-9) bad++;
      if (cap > pin + 1e-9) climbed++;
    }
  }
  assert(checked > 0 && bad === 0, `E1 ${e}: the published ceiling is min(own cap, pin) on every pinned scenario (${checked} checked, violations: ${bad})`);
  assert(climbed === 0, `E2 ${e}: nothing — the step-down lattice included — ever publishes a ceiling above the pin (violations: ${climbed})`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
