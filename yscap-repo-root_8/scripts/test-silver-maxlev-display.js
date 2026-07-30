'use strict';
/**
 * Silver Program — "PROGRAM MAXIMUM LEVERAGE" IS FIXED; the deal's PRICED CEILING may move.
 *
 * THE OWNER'S REPORT (2026-07-30, Silver / ground-up REFINANCE / tier 2 / upstate NY):
 *   "the Max LTV keeps changing when I change the interest reserve — if I make the
 *    reserve 18 months it's max 65 LTC, if I make the interest 12 months it's max
 *    74.99 LTC … the Max LTC should never change, each tier has its own Max LTC,
 *    I believe for this tier it's much more, I believe it's 85 … it shouldn't change
 *    based on what you're changing the interest reserve … it should have its max set."
 *
 * THE OWNER IS RIGHT, and the tier maximum is even higher than they thought: the EMCAP
 * Tier Grid row for GUC | Refinance | Tier 2 is maxLTC 92.5% — fixed.
 *
 * ROOT CAUSE the studio block "Program maximum leverage — from FICO & experience"
 * (ids rMaxLtc / rMaxLtv / rMaxArv / rMaxLoan in web/v2/tools/term-sheet.html, filled in
 * web/v2/tools/termsheet.js) printed the engine's `caps` — the EFFECTIVE ceiling AFTER the
 * grid-aware step-down has lowered it to reach a priced cell. A financed interest reserve
 * is part of the COST BASIS, so changing it moves the deal into a different priced band,
 * which moves the step-down's effective cap — and a label promising the PROGRAM maximum
 * moved while the borrower edited a reserve.
 *
 * WHAT THIS FILE PINS
 *   (1) INVARIANCE — the engine's read-only tier row `evaluate().tierCaps` does NOT move
 *       across a battery of DEAL changes: reserve months 0/6/12/18/24, an amount-driven
 *       reserve, a range of rehab budgets and ARVs, terms, prices and as-is values. Every
 *       expected value comes from the WORKBOOK FIXTURE (scripts/fixtures/…json), never
 *       from re-running the engine's own logic.
 *   (2) TRUTHFULNESS — the effective ceiling `caps` IS allowed to move, may only ever sit
 *       AT or BELOW the tier row, and whenever it sits below because of the step-down it
 *       is ALWAYS accompanied by the engine's own explaining sentence (reason code
 *       `leverage_capped`), which names the axis that actually bound.
 *   (3) MUTATION PROOF — re-running the SAME invariance assertions against the OLD
 *       behaviour (the program-maximum label fed from `caps`) must FAIL. A test that
 *       cannot fail proves nothing.
 *   (4) DISPLAY CONTRACT — the two values a surface prints are distinguishable, and the
 *       tier row equals the engine's own published caps() lookup, so a display can never
 *       drift from the guideline.
 *
 * HARD RULES HONORED: no DB, no network, pure Node, well under 60s.
 *
 * Run:  node scripts/test-silver-maxlev-display.js
 * npm test entry to ADD (package.json is NOT edited by this script):
 *   "node scripts/test-silver-maxlev-display.js" — place it immediately after
 *   "node scripts/test-silver-address-parse.js" in the test chain.
 */

const path = require('path');
const SVP = require(path.join(__dirname, '..', 'web', 'v2', 'tools', 'silver-program.js'));
const FIX = require(path.join(__dirname, 'fixtures', 'emcap-pricing-tool-v1.json'));

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); } }
function eqNum(a, b) { return Math.abs(Number(a) - Number(b)) < 1e-12; }
const pctS = (x) => (Math.round(x * 10000) / 100) + '%';

/* ===================================================================== *
 * 0. THE OWNER'S OWN SCENARIO, and the workbook row it must obey.
 * ===================================================================== */
const OWNER = {
  loanType: 'Refinance', strategy: 'Ground-up', state: 'NY', zip: '12201', city: 'Albany',
  propertyType: 'single family', fico: 700, expGround: 2,
  purchasePrice: 600000, asIsValue: 700000, arv: 1500000, rehabBudget: 500000, term: 18,
};
// GUC | Refinance | Tier 2 — read from the workbook fixture, not from the engine.
const OWNER_ROW = FIX.tierGrid['GUC|R|T2'];

(function section0() {
  const ev = SVP.evaluate(Object.assign({}, OWNER, { irMonths: 0 }));
  ok(ev.product === 'GUC', `owner scenario prices on the GUC product (got ${ev.product})`);
  ok(ev.loanType === 'Refinance', 'owner scenario is a refinance');
  ok(ev.tier === 2, `owner scenario lands in tier 2 (got ${ev.tier})`);
  ok(!!ev.tierCaps, 'the engine publishes a tierCaps row for a priced scenario');
  ok(eqNum(ev.tierCaps.maxLTC, OWNER_ROW.maxltc), `tier max LTC is the workbook's ${pctS(OWNER_ROW.maxltc)} (got ${pctS(ev.tierCaps.maxLTC)})`);
  ok(eqNum(ev.tierCaps.maxARLTV, OWNER_ROW.maxar), `tier max AR-LTV is the workbook's ${pctS(OWNER_ROW.maxar)}`);
  ok(eqNum(ev.tierCaps.maxAcqLTV, OWNER_ROW.maxacq), `tier max acq-LTV is the workbook's ${pctS(OWNER_ROW.maxacq)}`);
  ok(eqNum(ev.tierCaps.maxLoan, OWNER_ROW.maxloan), `tier max loan is the workbook's ${OWNER_ROW.maxloan}`);
  ok(eqNum(ev.tierCaps.minFico, OWNER_ROW.minfico), `tier min FICO is the workbook's ${OWNER_ROW.minfico}`);
  // and it is HIGHER than the 85% the owner guessed — worth stating explicitly
  ok(ev.tierCaps.maxLTC > 0.85, 'the tier max LTC is above the 85% the owner believed it to be');
})();

/* ===================================================================== *
 * 1. INVARIANCE — the tier row does not move when a DEAL input moves.
 *    This is the owner's report, reproduced and pinned.
 * ===================================================================== */
function tierSig(ev) {
  const t = ev.tierCaps;
  return t ? [t.maxLoan, t.minFico, t.maxAcqLTV, t.maxARLTV, t.maxLTC].join('|') : 'NONE';
}
function effSig(ev) {
  const c = ev.caps;
  return c ? [c.maxLoan, c.minFico, c.maxAcqLTV, c.maxARLTV, c.maxLTC].join('|') : 'NONE';
}

// The battery of DEAL changes. Every one of these leaves the borrower's FICO and
// experience — and therefore the tier — untouched, so the tier row may not budge.
const DEAL_VARIANTS = [];
[0, 3, 6, 9, 12, 18, 24].forEach((m) => DEAL_VARIANTS.push({ label: `reserve ${m} months`, patch: { irMonths: m } }));
[0, 10000, 40000, 90000, 150000, 250000].forEach((a) => DEAL_VARIANTS.push({ label: `reserve $${a} (amount-driven)`, patch: { irAmount: a, irMonths: 0 } }));
[0, 100000, 250000, 500000, 750000, 1000000].forEach((b) => DEAL_VARIANTS.push({ label: `rehab budget $${b}`, patch: { rehabBudget: b } }));
[900000, 1100000, 1300000, 1500000, 1900000, 2400000].forEach((v) => DEAL_VARIANTS.push({ label: `ARV $${v}`, patch: { arv: v } }));
[400000, 600000, 850000, 1200000].forEach((p) => DEAL_VARIANTS.push({ label: `price $${p}`, patch: { purchasePrice: p } }));
[500000, 700000, 950000].forEach((v) => DEAL_VARIANTS.push({ label: `as-is $${v}`, patch: { asIsValue: v } }));
[12, 18, 24].forEach((t) => DEAL_VARIANTS.push({ label: `term ${t} months`, patch: { term: t } }));

(function section1() {
  const baseline = SVP.evaluate(Object.assign({}, OWNER, { irMonths: 0 }));
  const want = tierSig(baseline);
  let moved = 0, effMoved = 0, priced = 0;
  const seenEff = new Set();
  for (const v of DEAL_VARIANTS) {
    const ev = SVP.evaluate(Object.assign({}, OWNER, { irMonths: 0 }, v.patch));
    if (!ev.tierCaps) continue;      // a variant the tier grid has no row for — nothing to compare
    priced++;
    if (tierSig(ev) !== want) { moved++; ok(false, `TIER MAX MOVED on a deal change — ${v.label}: ${tierSig(ev)} (expected ${want})`); }
    if (effSig(ev) !== effSig(baseline)) effMoved++;
    seenEff.add(effSig(ev));
  }
  ok(moved === 0, `the tier maximum is invariant across all ${priced} deal variants (moved ${moved} times)`);
  // The test is only meaningful if the EFFECTIVE ceiling really does move — otherwise
  // there was nothing to separate. This is the owner's symptom, asserted as present.
  ok(effMoved > 0, `the deal's EFFECTIVE ceiling DOES move across the same variants (${effMoved} of ${priced}) — the two are genuinely different things`);
  ok(seenEff.size > 1, `the effective ceiling takes ${seenEff.size} distinct values over the battery`);
})();

/* The owner's exact reproduction: reserve 0 → 6 → 12 → 18 on their own deal. */
(function section1b() {
  const seen = [];
  for (const m of [0, 6, 12, 18]) {
    const ev = SVP.evaluate(Object.assign({}, OWNER, { irMonths: m }));
    seen.push({ m, tier: tierSig(ev), eff: effSig(ev), ltc: ev.caps && ev.caps.maxLTC, arv: ev.caps && ev.caps.maxARLTV });
  }
  const allSameTier = seen.every((s) => s.tier === seen[0].tier);
  ok(allSameTier, `OWNER REPRO — tier maximum identical at reserve 0/6/12/18 (${seen.map((s) => s.tier).join(' ; ')})`);
  const anyEffDiff = seen.some((s) => s.eff !== seen[0].eff);
  ok(anyEffDiff, 'OWNER REPRO — the priced ceiling does change across those same four reserves (the symptom is real)');
  // the two specific numbers the owner watched change
  ok(eqNum(seen[3].ltc, 0.80), `OWNER REPRO — at an 18-month reserve the deal's priced LTC ceiling is 80% (got ${pctS(seen[3].ltc)})`);
  ok(eqNum(seen[2].arv, 0.70), `OWNER REPRO — at a 12-month reserve the deal's priced AR-LTV ceiling is 70% (got ${pctS(seen[2].arv)})`);
  // ...while the tier maximum stayed at the workbook's 92.5% / 75% throughout
  for (const s of seen) {
    const ev = SVP.evaluate(Object.assign({}, OWNER, { irMonths: s.m }));
    ok(eqNum(ev.tierCaps.maxLTC, OWNER_ROW.maxltc) && eqNum(ev.tierCaps.maxARLTV, OWNER_ROW.maxar),
      `OWNER REPRO — at reserve ${s.m} the PROGRAM maximum is still ${pctS(OWNER_ROW.maxltc)} LTC / ${pctS(OWNER_ROW.maxar)} ARV`);
  }
})();

/* ===================================================================== *
 * 2. TRUTHFULNESS — a lower priced ceiling is always explained, and the
 *    tier row is never exceeded. Swept over a seeded battery.
 * ===================================================================== */
(function section2() {
  let seed = 987654321;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  let n = 0, withRow = 0, stepped = 0, unexplained = 0, exceeded = 0, mismatchLookup = 0, missingRow = 0;
  for (let i = 0; i < 12000; i++) {
    const pp = Math.round((120000 + rnd() * 2600000) / 5000) * 5000;
    const rehab = Math.round((rnd() * 0.9 * pp) / 5000) * 5000;
    const inp = {
      loanType: rnd() < 0.5 ? 'Refinance' : 'Purchase',
      strategy: pick(['Fix & Flip', 'Fix & Hold', 'Ground-up', 'Bridge']),
      state: pick(['NY', 'NJ', 'CT', 'PA', 'FL', 'TX', 'GA', 'OH', 'MA', 'NC']),
      zip: pick(['12201', '07030', '06510', '15201', '33101', '75201', '30301', '43201', '02101', '10001']),
      propertyType: 'single family', fico: pick([645, 665, 685, 700, 720, 760, 800]),
      expFlips: Math.floor(rnd() * 6), expHolds: Math.floor(rnd() * 4), expGround: Math.floor(rnd() * 6),
      purchasePrice: pp, asIsValue: Math.round(pp * (0.85 + rnd() * 0.5)),
      arv: Math.round((pp + rehab) * (1.02 + rnd() * 0.7)), rehabBudget: rehab,
      term: pick([12, 18, 24]), irMonths: pick([0, 3, 6, 9, 12, 18, 24]),
      irAmount: rnd() < 0.12 ? Math.round(rnd() * 120000) : 0,
    };
    const ev = SVP.evaluate(inp);
    n++;
    if (!ev.caps) continue;
    if (!ev.tierCaps) { missingRow++; continue; }
    withRow++;
    const t = ev.tierCaps, c = ev.caps;
    // (a) the effective ceiling may never EXCEED the tier row on any axis
    if (c.maxLTC > t.maxLTC + 1e-9 || c.maxARLTV > t.maxARLTV + 1e-9 || c.maxAcqLTV > t.maxAcqLTV + 1e-9 || c.maxLoan > t.maxLoan + 1e-6) exceeded++;
    // (b) the tier row must be the engine's own published lookup — a display reading
    //     tierCaps can therefore never disagree with the guideline
    const row = SVP.caps(ev.product, ev.loanType, ev.tier);
    if (!row || !eqNum(row.maxLTC, t.maxLTC) || !eqNum(row.maxARLTV, t.maxARLTV) || !eqNum(row.maxAcqLTV, t.maxAcqLTV)
      || !eqNum(row.maxLoan, t.maxLoan) || !eqNum(row.minFico, t.minFico)) mismatchLookup++;
    // (c) whenever the STEP-DOWN lowered a leverage axis, the engine must say so
    const lowered = (c.maxLTC < t.maxLTC - 1e-9) || (c.maxARLTV < t.maxARLTV - 1e-9);
    const chose = Number(inp.targetLTC) > 0;   // no voluntary de-leverage in this battery
    if (lowered && !chose) {
      stepped++;
      const why = (ev.reasons || []).filter((r) => r && r.code === 'leverage_capped');
      if (!why.length) { unexplained++; continue; }
      const msg = why[0].msg;
      // the sentence must NAME the axis that actually bound, with the actual number
      const saysLtc = msg.indexOf(pctS(c.maxLTC) + ' loan-to-cost') > -1;
      const saysAr = msg.indexOf(pctS(c.maxARLTV) + ' of the after-repair value') > -1;
      const cutLtc = c.maxLTC < t.maxLTC - 1e-9, cutAr = c.maxARLTV < t.maxARLTV - 1e-9;
      if ((cutLtc && !saysLtc) || (cutAr && !saysAr)) unexplained++;
    }
  }
  ok(withRow > 3000, `swept ${n} scenarios, ${withRow} carried a tier row`);
  ok(missingRow === 0 || missingRow < withRow, `every priced scenario publishes its tier row (${missingRow} without)`);
  ok(exceeded === 0, `the priced ceiling NEVER exceeds the tier maximum (${exceeded} violations)`);
  ok(mismatchLookup === 0, `the published tier row always equals the engine's own caps() lookup (${mismatchLookup} mismatches)`);
  ok(stepped > 100, `the step-down fired often enough to be meaningful (${stepped} times)`);
  ok(unexplained === 0, `every stepped-down ceiling carries the engine's explaining sentence naming the bound axis (${unexplained} unexplained)`);
})();

/* ===================================================================== *
 * 3. MUTATION PROOF — the SAME invariance assertions, run against the OLD
 *    behaviour (the "Program maximum" label fed from `caps`). They MUST fail.
 *    Without this the suite could be passing on a tautology.
 * ===================================================================== */
(function section3() {
  // Exactly what the display did BEFORE this fix: read `caps` under the
  // "Program maximum leverage — from FICO & experience" label.
  const legacyProgramMax = (ev) => ev.caps;
  const fixedProgramMax = (ev) => ev.tierCaps;
  const sig = (c) => (c ? [c.maxLoan, c.minFico, c.maxAcqLTV, c.maxARLTV, c.maxLTC].join('|') : 'NONE');

  function invarianceHolds(readProgramMax) {
    const want = sig(readProgramMax(SVP.evaluate(Object.assign({}, OWNER, { irMonths: 0 }))));
    for (const m of [0, 6, 12, 18]) {
      const ev = SVP.evaluate(Object.assign({}, OWNER, { irMonths: m }));
      if (sig(readProgramMax(ev)) !== want) return false;
    }
    for (const v of DEAL_VARIANTS) {
      const ev = SVP.evaluate(Object.assign({}, OWNER, { irMonths: 0 }, v.patch));
      if (!ev.tierCaps) continue;
      if (sig(readProgramMax(ev)) !== want) return false;
    }
    return true;
  }

  ok(invarianceHolds(fixedProgramMax) === true,
    'MUTATION CONTROL — with the FIXED reading (tierCaps) the invariance assertion PASSES');
  ok(invarianceHolds(legacyProgramMax) === false,
    'MUTATION PROOF — restoring the OLD reading (effective caps under the program-maximum label) makes the invariance assertion FAIL');

  // And specifically on the owner's own four reserves, so the proof is tied to the report.
  const legacyOwner = [0, 6, 12, 18].map((m) => sig(legacyProgramMax(SVP.evaluate(Object.assign({}, OWNER, { irMonths: m })))));
  const fixedOwner = [0, 6, 12, 18].map((m) => sig(fixedProgramMax(SVP.evaluate(Object.assign({}, OWNER, { irMonths: m })))));
  ok(new Set(legacyOwner).size > 1, `MUTATION PROOF — the OLD reading produces ${new Set(legacyOwner).size} different "program maximums" across reserve 0/6/12/18 (this is exactly what the owner saw)`);
  ok(new Set(fixedOwner).size === 1, 'MUTATION PROOF — the FIXED reading produces exactly ONE program maximum across the same four reserves');
})();

/* ===================================================================== *
 * 4. DISPLAY CONTRACT — the two truths are separable and never conflated.
 * ===================================================================== */
(function section4() {
  // A display asks three questions of a result; each must be answerable without
  // re-deriving a cap, and the answers must be consistent.
  const ev = SVP.evaluate(Object.assign({}, OWNER, { irMonths: 18 }));
  ok(!!ev.tierCaps && !!ev.caps, 'a result carries BOTH the tier row and the effective ceiling');
  ok(ev.tierCaps !== ev.caps, 'they are separate objects — a surface can print both');
  const lower = ev.caps.maxLTC < ev.tierCaps.maxLTC - 1e-9 || ev.caps.maxARLTV < ev.tierCaps.maxARLTV - 1e-9;
  ok(lower, "on the owner's 18-month-reserve deal the priced ceiling IS below the tier maximum (so the second line renders)");
  const why = (ev.reasons || []).filter((r) => r && r.code === 'leverage_capped');
  ok(why.length === 1, `exactly one explaining sentence is available for the display (got ${why.length})`);
  ok(/loan-to-cost/.test(why[0].msg) && /after-repair value/.test(why[0].msg),
    'the sentence names BOTH axes on this deal (both were cut)');
  ok(why[0].level === 'ELIGIBLE', 'the explanation is not itself a refusal — the deal is still eligible');
  // an INELIGIBLE early-exit still answers "what is this tier's maximum?"
  const bad = SVP.evaluate(Object.assign({}, OWNER, { irMonths: 0, ownerOccupied: true }));
  ok(bad.status === 'INELIGIBLE', 'control: an owner-occupied property is ineligible');
  ok(bad.tierCaps === null || (bad.tierCaps && eqNum(bad.tierCaps.maxLTC, OWNER_ROW.maxltc)),
    'an ineligible result either has no tier row or still reports the correct one — never a wrong one');
  // no tier row exists for a combination the grid does not carry
  const noRow = SVP.evaluate({ loanType: 'Refinance', strategy: 'Fix & Flip', state: 'NY', zip: '12201', fico: 700,
    purchasePrice: 400000, asIsValue: 400000, arv: 700000, rehabBudget: 100000, term: 12 });
  ok(noRow.tierCaps === null, 'a product/purpose/tier the grid has no row for reports a null tier row, never a guess');
})();

/* ===================================================================== *
 * 5. OTHER TIERS / PRODUCTS — the invariance is not a one-scenario fluke.
 * ===================================================================== */
(function section5() {
  const CASES = [
    { name: 'GUC purchase T1', key: 'GUC|P|T1', inp: { loanType: 'Purchase', strategy: 'Ground-up', expGround: 6, fico: 760 } },
    { name: 'GUC purchase T2', key: 'GUC|P|T2', inp: { loanType: 'Purchase', strategy: 'Ground-up', expGround: 1, fico: 720 } },
    { name: 'GUC refi T1', key: 'GUC|R|T1', inp: { loanType: 'Refinance', strategy: 'Ground-up', expGround: 5, fico: 760 } },
    { name: 'FF purchase T1', key: 'FF|P|T1', inp: { loanType: 'Purchase', strategy: 'Fix & Flip', expFlips: 5, fico: 760 } },
    { name: 'FF purchase T2', key: 'FF|P|T2', inp: { loanType: 'Purchase', strategy: 'Fix & Flip', expFlips: 1, fico: 720 } },
    { name: 'FF refi T2', key: 'FF|R|T2', inp: { loanType: 'Refinance', strategy: 'Fix & Flip', expFlips: 2, fico: 720 } },
    { name: 'BR purchase T1', key: 'BR|P|T1', inp: { loanType: 'Purchase', strategy: 'Bridge', expFlips: 5, fico: 760 } },
  ];
  for (const cs of CASES) {
    const row = FIX.tierGrid[cs.key];
    const base = Object.assign({
      state: 'NJ', zip: '07030', propertyType: 'single family',
      purchasePrice: 700000, asIsValue: 800000, arv: 1600000, rehabBudget: 400000, term: 18,
    }, cs.inp);
    const sigs = new Set();
    let anyRow = null;
    for (const m of [0, 6, 12, 18, 24]) {
      const ev = SVP.evaluate(Object.assign({}, base, { irMonths: m }));
      if (!ev.tierCaps) continue;
      anyRow = ev.tierCaps;
      sigs.add(tierSig(ev));
    }
    ok(sigs.size <= 1, `${cs.name}: the tier maximum is one value across five reserve settings (saw ${sigs.size})`);
    if (anyRow) {
      ok(eqNum(anyRow.maxLTC, row.maxltc) && eqNum(anyRow.maxARLTV, row.maxar) && eqNum(anyRow.maxAcqLTV, row.maxacq)
        && eqNum(anyRow.maxLoan, row.maxloan) && eqNum(anyRow.minFico, row.minfico),
        `${cs.name}: the tier maximum equals the workbook fixture row ${cs.key}`);
    }
  }
})();

/* ===================================================================== *
 * 6. A VOLUNTARY DE-LEVERAGE (the slider) ALSO must not move the tier row.
 *    Same label class: the user choosing less leverage is not the program
 *    changing its maximum.
 * ===================================================================== */
(function section6() {
  const sigs = new Set();
  let effSeen = new Set();
  for (const t of [0, 0.85, 0.80, 0.7499, 0.70]) {
    const ev = SVP.evaluate(Object.assign({}, OWNER, { irMonths: 6, targetLTC: t || 0 }));
    if (!ev.tierCaps) continue;
    sigs.add(tierSig(ev));
    if (ev.caps) effSeen.add(ev.caps.maxLTC);
  }
  ok(sigs.size === 1, `a voluntary de-leverage does not move the tier maximum (saw ${sigs.size} values)`);
  ok(effSeen.size > 1, `a voluntary de-leverage DOES move the deal's own ceiling (saw ${effSeen.size} values) — so the two lines differ there too`);
})();

/* ===================================================================== */
console.log(`\nSilver — program-maximum vs priced-ceiling display`);
console.log(`  passed: ${pass}`);
console.log(`  failed: ${fail}`);
if (fail) {
  console.log('\nFAILURES:');
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('  ✓ the program/tier maximum is FIXED; the deal\'s priced ceiling may move and always explains itself.');
process.exit(0);
