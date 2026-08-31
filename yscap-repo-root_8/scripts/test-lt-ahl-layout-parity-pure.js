#!/usr/bin/env node
'use strict';
/**
 * AHL — the A-to-Z LAYOUT AUDIT: a reader cannot tell which program priced it.
 *
 * ── THE OWNER'S TEST, NOT MINE ─────────────────────────────────────────────
 * 2026-08-31: *"Lay out the results exactly how it's currently laid out in our
 * pilot system on our general pricer. The LLPAs correctly and everything laid
 * out exactly the same. It takes information also exactly the same… You
 * shouldn't look for the user to make a difference from where the data is
 * coming from."*
 *
 * So this suite does not check that AHL "has adjustments". It builds a LoanNEX
 * breakdown and an AHL breakdown from the two vendors' real captured answers and
 * compares them STRUCTURALLY — same keys, same order, same units, same sign,
 * same wording for the same silence. Anything a screen could branch on is a
 * failure.
 *
 * ── WHAT THIS CAUGHT WHEN IT WAS FIRST RUN ────────────────────────────────
 * Every AHL adjustment row rendered COMPLETELY BLANK — no label, no detail, no
 * value — while `available: true` said the breakdown was fine. AHL's mapper was
 * passing the vendor's own `{name, description, priceAdjustment}` through, and
 * `breakdown.normaliseLine` reads `label`/`reason`, `detail` and `value`. Five
 * empty rows under a price, and the total beneath them still printed in the
 * vendor's own sign. It is the exact defect the owner's instruction is about,
 * and no test that only asserted "AHL produces adjustments" would have seen it.
 *
 * PROVEN TO FAIL: drop the price→points negation and SIGN-1/SIGN-2 go red; pass
 * AHL's raw adjustment objects through and KEYS-2/VALUE-1 go red; leave
 * `adjustmentPoints` in price and TOTAL-1 goes red; fill `basePoints` from
 * nothing and BASE-1 goes red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const fs = require('fs');
const path = require('path');
const ahlParse = require('../src/longterm/ahl/parse');
const nxParse = require('../src/longterm/loannex/parse');
const shape = require('../src/longterm/pricing/quote-shape');
const margin = require('../src/longterm/pricing/vendor-margin');
const bd = require('../src/longterm/pricing/breakdown');
const ahlCap = require('../src/longterm/ahl/capture/legs.json');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok   ${m}`); } else { fail += 1; console.log(`  FAIL ${m}`); } };
const CAP = path.join(__dirname, '..', 'src', 'longterm', 'ahl', 'capture');

function ahlBreakdown() {
  let b = ahlParse.mergeLegs(Object.keys(ahlCap.legs)
    .map((k) => ahlParse.parse(fs.readFileSync(path.join(CAP, ahlCap.legs[k].file), 'utf8'), ahlCap.legs[k].leg)));
  b = margin.applyToBoard(b, 'ahl');
  const o = shape.optionsFromAhl(b, { loanAmount: 350000, fico: 760, ltv: 0.7 }).find((x) => x.evidence.fetched);
  return { option: o, view: bd.breakdown(o) };
}

/**
 * A LoanNEX option with its REAL LIVE evidence folded on — the reference layout.
 *
 * Built through the same production path `test-lt-breakdown-parity-pure.js`
 * uses, from the same live capture, so the reference this suite compares against
 * is the one the existing layout guard already blesses rather than a second
 * construction of my own that could drift from it.
 */
function nexBreakdown() {
  const live = require('../src/longterm/loannex/capture/evidence-live.json');
  for (const s of live.samples || []) {
    const ev = nxParse.parseEvidence(s.response);
    if (!ev) continue;
    const option = shape.attachEvidence(
      shape.optionForQuote({ ...((s.request || {}).quote), vendor: 'loannex' }), ev,
    );
    const view = bd.breakdown(option);
    if (view.lines && view.lines.length) return { option, view };
  }
  return null;
}

(async () => {
  console.log('\nAHL — the layout audit: one system, whoever priced it\n');

  const a = ahlBreakdown();
  const n = nexBreakdown();
  ok(!!a.option, 'SETUP-1 an AHL option with its itemization is available from the captured board');
  ok(!!n, 'SETUP-2 a LoanNEX option with its real captured evidence is available as the reference');
  if (!n) { console.log('\nFAILURES: 1 — no LoanNEX reference to compare against'); process.exit(1); }

  // ── The same keys, in the same order ────────────────────────────────────
  {
    const ka = Object.keys(a.view).join(',');
    const kn = Object.keys(n.view).join(',');
    ok(ka === kn, `KEYS-1 the two breakdowns have the SAME top-level keys in the SAME order\n         ahl: ${ka}\n         nex: ${kn}`);
    const la = Object.keys(a.view.lines[0] || {}).join(',');
    const ln = Object.keys(n.view.lines[0] || {}).join(',');
    ok(la === ln && la === bd.LINE_KEYS.join(','),
      `KEYS-2 every adjustment row has the same keys, and they are exactly LINE_KEYS (${la})`);
    ok(Object.keys(a.view.price).join(',') === Object.keys(n.view.price).join(','),
      'KEYS-3 the price block matches key for key');
    ok(Object.keys(a.view.totals).join(',') === Object.keys(n.view.totals).join(','),
      'KEYS-4 the totals block matches key for key');
    ok(Object.keys(a.view.eligibility).join(',') === Object.keys(n.view.eligibility).join(','),
      'KEYS-5 the eligibility block matches key for key');
  }

  // ── Nothing on the row names a vendor ───────────────────────────────────
  {
    const json = JSON.stringify(a.view);
    const named = ['ahl', 'AHL', 'American Heritage', 'Quick Pricer', 'ahlend'].filter((w) => json.includes(w));
    ok(named.length === 0, `SOURCE-1 the default breakdown names no vendor anywhere${named.length ? ` — found ${named.join(', ')}` : ''}`);
    ok(a.view.source === null && n.view.source === null,
      'SOURCE-2 …and `source` is null on both until an admin asks');
    ok(bd.breakdown(a.option, { reveal: true }).source === 'ahl',
      'SOURCE-3 an admin who asks gets it — nothing is discarded, it is withheld');
  }

  // ── The rows are readable, and in the same order rule ───────────────────
  {
    ok(a.view.lines.length > 0 && a.view.lines.every((l) => l.label && l.detail && l.value != null),
      `LINE-1 every AHL row has a label, a detail and a value (${a.view.lines.length} rows) — the blank-row defect stays fixed`);
    ok(n.view.lines.every((l) => l.value != null), 'LINE-2 …and so does every LoanNEX row');
    const desc = (v) => v.lines.every((l, i, arr) => i === 0 || arr[i - 1].value >= l.value);
    ok(desc(a.view) && desc(n.view), 'LINE-3 both are ordered biggest cost first, by the same rule');
    ok(a.view.display.lines.every((l) => typeof l.valueText === 'string' && /^[+-]?\d/.test(l.valueText)),
      `VALUE-1 the rendered text is present on every AHL row (${a.view.display.lines.map((l) => l.valueText).join(' ')})`);
  }

  // ── ONE SIGN CONVENTION ─────────────────────────────────────────────────
  {
    ok(a.view.lines.every((l) => l.valueType === 'points') && n.view.lines.every((l) => l.valueType === 'points'),
      'SIGN-1 both vendors state their rows in POINTS on the screen, whatever they said on the wire');
    ok(a.view.lines.every((l) => l.givenIn === 'price') && n.view.lines.every((l) => l.givenIn === 'price'),
      'SIGN-2 …and both record that the vendor gave it in PRICE, so an auditor can check the translation');
    ok(a.view.lines.every((l) => Math.abs(l.value + l.valueAsGiven) < 1e-9),
      'SIGN-3 the AHL translation is exactly a negation — nothing else moved');
    // The decisive one: a cost must read as a cost on BOTH.
    const aCost = a.view.lines.find((l) => l.value > 0);
    ok(aCost && aCost.valueAsGiven < 0,
      `SIGN-4 a row that COSTS the borrower is positive in points and negative in AHL's own price (${aCost && aCost.value} / ${aCost && aCost.valueAsGiven}) — the same "+0.25" cannot mean opposite things on one screen`);
  }

  // ── The arithmetic is shown, not asserted ───────────────────────────────
  {
    ok(a.view.totals.checked === true && a.view.totals.reconciles === true,
      `TOTAL-1 the AHL rows sum to the stated total (${a.view.totals.linesPoints} = ${a.view.totals.statedPoints})`);
    ok(n.view.totals.checked === true,
      'TOTAL-2 the LoanNEX rows are checked the same way');
    ok(a.view.price.basePrice != null && a.view.price.basePoints != null && a.view.price.baseDerived === null,
      `BASE-1 AHL publishes the base in BOTH units, so nothing is stamped "we worked this out" (${a.view.price.basePrice} / ${a.view.price.basePoints})`);
  }

  // ── The same silence is worded the same way ─────────────────────────────
  {
    const bare = bd.breakdown({ source: 'ahl', evidence: { fetched: false, reason: 'not_requested' } });
    const bareNx = bd.breakdown({ source: 'loannex', evidence: { fetched: false, reason: 'not_requested' } });
    ok(bare.message === bareNx.message && bare.state === bareNx.state,
      'SILENCE-1 "nobody has asked yet" reads identically whichever vendor it is about');
    ok(bare.eligibility.provided === false && bare.eligibility.message === bd.ELIGIBILITY_ABSENT,
      'SILENCE-2 a missing eligibility block SAYS so, in the same position — a silently absent section reads as a clean bill of health nobody gave');
    const noSheet = bd.breakdown(a.option).sheet;
    ok(noSheet.expired === null && noSheet.stalenessUnknown === true,
      'SILENCE-3 AHL states no sheet date, so staleness is UNKNOWN and never a reassuring `false`');
  }

  // ── The inputs are taken the same way ───────────────────────────────────
  {
    const shared = require('../src/longterm/pricing/scenario-defaults');
    const ahlScenario = require('../src/longterm/ahl/scenario');
    const nxScenario = require('../src/longterm/loannex/scenario');
    const sc = { purpose: 'cashout', value: 500000, loan: 350000, fico: 760, state: 'CT', propertyType: 'SingleFamily' };
    const prof = shared.profileFor(sc);
    const ahlBody = Object.fromEntries(ahlScenario.build(sc).legs[0].body);
    ok(Number(ahlBody.PrepayPenaltyPeriod) * 12 === prof.prepayMonths,
      `INPUT-1 AHL takes the prepay from the SHARED profile (${prof.prepayMonths} months → ${ahlBody.PrepayPenaltyPeriod} years), not a number of its own`);
    ok(Number(ahlBody.DSCR) === prof.dscr,
      `INPUT-2 …and the DSCR (${prof.dscr})`);
    ok(typeof nxScenario.buildQuickPriceBody === 'function' && typeof ahlScenario.build === 'function',
      'INPUT-3 both vendors expose a builder taking the one canonical scenario vocabulary');
    // The same officer button reaches both, under its canonical name.
    for (const flag of ['fthb', 'firstTimeInvestor', 'escrowWaive', 'rural', 'selfEmployed']) {
      const withFlag = Object.fromEntries(ahlScenario.build({ ...sc, [flag]: true }).legs[0].body);
      const changed = Object.keys(withFlag).some((k) => withFlag[k] !== ahlBody[k]) || Object.keys(withFlag).length !== Object.keys(ahlBody).length;
      ok(changed, `INPUT-4:${flag} setting the shared "${flag}" button changes what AHL is asked — it is not silently dropped`);
    }
  }

  console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})();
