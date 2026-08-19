#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE CANARY'S *OURS* LEG WAS FED THE RAW LENDER PRICE SCENARIO (§2.122).
 *
 * §2.106 found the canary's THEIRS leg passing the raw vendor envelope where a ladder was wanted, and
 * fixed it. The OURS leg, built on the very next line of the same call, had the mirror image of that
 * defect and was never looked at: it handed the raw LENDER PRICE SCENARIO straight to `quoteProgram`,
 * which prices from ENGINE FACTS.
 *
 * The battery is LP-shaped BY CONSTRUCTION — the `theirs` leg posts each scenario to `lp.price()`,
 * which takes nothing else — so the same object cannot be right for both legs. An LP scenario carries
 * `loan` / `value` / `dscr`; every rule predicate in the sheet reads `loan_amount`, `ltv`, `cltv`,
 * and twenty-plus more facts that `lpScenarioToFacts` DERIVES and a raw scenario simply does not have.
 *
 * MEASURED on the canonical 305-scenario battery against the built-in Deephaven sheet:
 *
 *     raw LP scenario  →  0 priced, 305 declined      ← what the canary did
 *     converted facts  →  262 priced, 43 declined     ← what it does now
 *     + the investor's prepayment layer  →  260 priced, 45 declined
 *
 * AND THE DECLINE IT RECORDED WAS WORSE THAN A BLANK ONE. The first cut of this suite asserted the 305
 * declines carried no reason; that was wrong, and measuring it properly is what makes the finding
 * sharp. Every one of them named a REAL RULE — `dhvn_min_dscr`, "Minimum DSCR 0.75" — while the same
 * quote's own `unknownFacts` listed six facts it could not read (`ltv`, `units`, `interest_only`,
 * `escrow_waiver`, `non_warrantable`, `short_term_rental`). So the canary was not silent: it filed 305
 * confident refusals citing a rule that had nothing to do with them, and anybody reading that findings
 * ledger would have gone and adjusted the DSCR floor. `unknownFacts` is the tell that was there the
 * whole time — 305 of 305 before, 0 of 305 after.
 *
 * ⛔ AND NO SUITE COULD HAVE CAUGHT IT. Every canary suite passed before this fix and after it — the
 * §2.106 work added `test-lt-ppe-canary-lp-leg-db.js` for the leg it fixed and left the other one
 * uncovered. This file is that missing half (§2.111's class: "tests that cannot fail on the doors that
 * matter most").
 *
 *   node scripts/test-lt-ppe-canary-ours-leg.js
 */
const fs = require('fs');
const path = require('path');
const legs = require('../src/longterm/ppe/lp-agreement-legs');
const quote = require('../src/longterm/ppe/quote');
const registry = require('../src/longterm/ppe/program-registry');
const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');
const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
const { buildDeephavenGrid } = require('../src/longterm/ppe/deephaven-dscr-sheet');
const settingsMod = require('../src/longterm/ppe/settings');
const { buildAgreementScenarios } = require('../src/longterm/ppe/agreement-scenarios');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }
function attemptSync(fn) { try { return fn(); } catch (e) { console.log(`  (threw: ${String(e && e.message || e).slice(0, 110)})`); return null; } }

const settings = settingsMod.resolveAll().values;
const program = rateSheetToProgram(gridToRateSheet(buildDeephavenGrid()),
  { code: 'DHVN_DSCR30', name: 'Deephaven DSCR 30yr', investorCode: 'DHVN' });
const scenarios = buildAgreementScenarios().scenarios;
const ppp = registry.pppLayerFor('Deephaven');

function tally(leg) {
  let priced = 0; let declined = 0; let errored = 0; let withUnknownFacts = 0; let declinesStated = 0;
  const codes = new Map();
  for (const sc of scenarios) {
    let q;
    try { q = leg(sc); } catch (_) { errored += 1; continue; }
    if (q && Array.isArray(q.unknownFacts) && q.unknownFacts.length) withUnknownFacts += 1;
    if (q && q.eligible === true) { priced += 1; continue; }
    declined += 1;
    const d = (q && q.declines) || [];
    if (d.length) declinesStated += 1;
    for (const one of d) codes.set(one.code, (codes.get(one.code) || 0) + 1);
  }
  return { priced, declined, errored, withUnknownFacts, declinesStated, codes };
}

console.log('LT PPE — the canary’s OURS leg (§2.122) — offline\n');

// ---- A. THE TWO LEGS CANNOT BOTH TAKE THE SAME OBJECT --------------------------------------------
// This is the argument the whole item rests on, so it is asserted rather than reasoned about.
{
  const sc = scenarios[0];
  const facts = legs.lpScenarioToFacts(sc);
  ok(sc.loan != null && sc.value != null,
    'A1 a battery scenario is LENDER PRICE shaped — it carries `loan` and `value`');
  ok(sc.loan_amount === undefined && sc.ltv === undefined,
    'A2 …and carries NONE of the engine facts the sheet prices from (`loan_amount`, `ltv`)');
  ok(facts.loan_amount != null && facts.ltv != null && facts.cltv != null,
    'A3 …which `lpScenarioToFacts` derives');
  ok(Object.keys(facts).length > Object.keys(sc).length + 10,
    `A4 …along with ${Object.keys(facts).length - Object.keys(sc).length} other facts a raw scenario does not have`);
}

// ---- B. THE PRE-FIX FORM PRICED NOTHING, AND SAID NOTHING ABOUT WHY -------------------------------
// The old leg is written out here rather than described, so the number below is measured and not
// remembered.
{
  const rawLeg = (sc) => quote.quoteProgram({ scenario: sc, program, settings });
  const raw = tally(rawLeg);
  ok(raw.priced === 0,
    `B1 the raw-scenario leg the canary used prices NOTHING — ${raw.priced} of ${scenarios.length}`);
  ok(raw.declined === scenarios.length,
    `B2 …it declines every single scenario (${raw.declined})`);
  // NOT a blank refusal — a CONFIDENTLY WRONG one, which is worse and is the real finding.
  ok(raw.declinesStated === raw.declined,
    `B3 …and every one of those declines NAMES a rule (${raw.declinesStated}) — it is not silent, it is confidently wrong`);
  ok(raw.codes.get('dhvn_min_dscr') === scenarios.length,
    `B4 …the SAME rule on all of them: dhvn_min_dscr "Minimum DSCR 0.75" (${raw.codes.get('dhvn_min_dscr')} of ${scenarios.length}),`
    + ' a reason a reader would have acted on by adjusting the DSCR floor');
  ok(raw.withUnknownFacts === scenarios.length,
    `B5 …while the very same quotes report facts they COULD NOT READ on every scenario (${raw.withUnknownFacts}) —`
    + ' the tell that was there the whole time');
  ok(raw.errored === 0,
    'B6 …and it never THREW, which is why this survived: it failed silently and confidently');
}

// ---- C. THE FIXED LEG PRICES THE SHEET ------------------------------------------------------------
{
  const fixed = attemptSync(() => legs.buildOursLeg(program, settings, {
    factsFromLp: true, pppDescriptor: ppp.descriptor, onUnresolvedPpp: 'flag',
  }));
  ok(!!fixed, 'C1 the leg the route now builds constructs');
  const out = fixed ? tally(fixed) : null;
  ok(!!out && out.priced > 200,
    `C2 …and prices the sheet — ${out ? out.priced : '?'} of ${scenarios.length}`);
  ok(!!out && out.errored === 0, 'C3 …with nothing thrown');
  ok(!!out && out.withUnknownFacts === 0,
    `C4 …and reads EVERY fact it needs — ${out ? out.withUnknownFacts : '?'} scenarios with an unreadable fact,`
    + ` against ${scenarios.length} before`);
  ok(!!out && out.declinesStated === out.declined,
    'C5 …with every remaining decline stating its own rule, so it can be reconciled against Lender Price’s refusal');
  ok(!!out && (out.codes.get('dhvn_min_dscr') || 0) < scenarios.length / 2,
    `C6 …and the DSCR floor is no longer blamed for the whole battery (${out ? (out.codes.get('dhvn_min_dscr') || 0) : '?'} scenarios)`);
}

// ---- D. THE PREPAYMENT LAYER IS ASKED, AND IT BITES ------------------------------------------------
// §2.116's fix reached the agreement run route and not this one. The scenario that proves it is the
// battery's own.
{
  const withPpp = attemptSync(() => legs.buildOursLeg(program, settings, {
    factsFromLp: true, pppDescriptor: ppp.descriptor, onUnresolvedPpp: 'flag',
  }));
  const withoutPpp = attemptSync(() => legs.buildOursLeg(program, settings, { factsFromLp: true }));
  ok(ppp.asked === true && !!ppp.descriptor, 'D1 Deephaven has a registered prepayment layer to ask');

  const nj = scenarios.find((s) => /NJ Individual PPP prohibited/.test(s._label || ''));
  ok(!!nj, 'D2 the battery carries the scenario a state’s prepayment law forbids');
  const a = withoutPpp && nj ? attemptSync(() => withoutPpp(nj)) : null;
  const b = withPpp && nj ? attemptSync(() => withPpp(nj)) : null;
  ok(!!a && a.eligible === true,
    'D3 without the layer the sheet PRICES it — the sheet carries no borrower-type prepayment rule at all');
  ok(!!b && b.eligible === false,
    'D4 …and with the layer asked it is DECLINED, which is what the investor would actually do');
  ok(!!b && (b.declines || []).some((r) => r && r.code === 'dhvn_ppp_prohibited_nj'),
    'D5 …naming the investor’s own prepayment rule, with its citation, not an anonymous refusal');

  const wp = withPpp ? tally(withPpp) : null;
  const np = withoutPpp ? tally(withoutPpp) : null;
  ok(!!wp && !!np && wp.priced < np.priced,
    `D6 across the battery the layer refuses loans the sheet alone would price (${np ? np.priced : '?'} → ${wp ? wp.priced : '?'})`);
}

// ---- E. THE MARGIN IS HANDED FACTS, WHICH IS WHAT IT DOCUMENTS ITSELF AS TAKING -------------------
// A third instance of the same mismatch, in the same expression: `marginFor(facts)` is its own stated
// contract (routes/ppe.js loadProgram) and the canary was passing it the raw scenario.
{
  const seen = [];
  const leg = attemptSync(() => legs.buildOursLeg(program, settings, {
    factsFromLp: true,
    marginHoldback: (x) => { seen.push(x); return null; },
  }));
  if (leg) attemptSync(() => leg(scenarios[0]));
  ok(seen.length === 1, 'E1 the margin resolver is called once per scenario');
  ok(seen.length === 1 && seen[0] && seen[0].loan_amount != null && seen[0].ltv != null,
    'E2 …and is handed the CONVERTED facts, which is the shape it is documented to take');
  ok(seen.length === 1 && seen[0] && seen[0].loan === undefined,
    'E3 …not the raw Lender Price scenario it had been receiving');
}

// ---- F. THE ROUTE ACTUALLY BUILDS IT THIS WAY ------------------------------------------------------
// A pure test of the leg proves nothing about the caller, and the caller is where the defect lived.
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'routes', 'ppe.js'), 'utf8');
  const runBattery = src.slice(src.indexOf('async function runBattery'), src.indexOf('async function canaryTickRoute'));
  ok(runBattery.length > 500, 'F1 found the canary execution to read');
  ok(/ours: lpAgreementLegs\.buildOursLeg\(/.test(runBattery),
    'F2 the canary builds its OURS leg from the one shared definition');
  ok(/factsFromLp: true/.test(runBattery),
    'F3 …asking for the Lender Price → engine fact conversion');
  ok(/pppDescriptor: canaryPpp\.descriptor/.test(runBattery),
    'F4 …and for the investor’s own prepayment layer');
  ok(/marginHoldback: marginFor,/.test(runBattery),
    'F5 …handing the margin resolver to the leg rather than calling it on a raw scenario');
  ok(!/ours: \(sc\) => quote\.quoteProgram\(/.test(runBattery),
    'F6 …and the raw-scenario form is gone from the canary');
  // The theirs leg must STAY the LP one — the two fixes are mirror images and swapping either is the
  // same class of bug.
  ok(/theirs: lpAgreementLegs\.buildCanaryLpLeg\(/.test(runBattery),
    'F7 …while the THEIRS leg is still the Lender Price one (§2.106)');
}

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);

/* ---------------------------------------------------------------------------------------------
 * MUTATION LOG — control green either side, each checksum-verified to have APPLIED.
 *   M1  route: revert `ours` to the raw-scenario quoteProgram   → F2/F3/F4/F5/F6 fail
 *   M2  route: drop `factsFromLp`                               → F3 fails
 *   M3  route: drop the pppDescriptor                           → F4 fails
 *   M4  buildOursLeg: ignore `factsFromLp` (price the raw form) → B/C/D/E fail together — the leg
 *                                                                 stops pricing entirely
 *   M5  buildOursLeg: call marginHoldback with the scenario     → E2/E3 fail
 * ------------------------------------------------------------------------------------------- */
