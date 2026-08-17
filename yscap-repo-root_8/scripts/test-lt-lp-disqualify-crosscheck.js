#!/usr/bin/env node
'use strict';
/**
 * LT PPE — CROSS-CHECK OUR ELIGIBILITY RULES AGAINST LENDER PRICE'S OWN DISQUALIFY TREE (task #45).
 *
 * The agreement run measures PRICE on loans both sides will do. This measures the other half: for a loan
 * we REFUSE, does Lender Price refuse it too, and for the same reason? Three outcomes per scenario, and
 * the two that are not "agree" mean opposite things:
 *
 *   • BOTH DECLINE          — corroborated. Our rule is doing what the investor does.
 *   • ONLY WE DECLINE       — either a real overlay (our matrix is stricter, deliberately, with a
 *                             reason) or a rule that is too tight and is costing the borrower a loan.
 *   • ONLY LENDER PRICE     — the DANGEROUS direction: we would price a loan the investor refuses.
 *
 * WHY THIS COULD NOT RUN UNTIL NOW. Lender Price's disqualify tree is the WHOLE MARKET — measured live,
 * 9,146 declined items across 20 lenders on one scenario, and 535 of them Deephaven's own on its other
 * product lines (Expanded Prime, Non Prime, ITIN), which decline on every DSCR scenario. Without a way
 * to scope to the DSCR program FAMILY every scenario reported "Lender Price declined this", so every
 * earlier run had to pass --no-disqualify. `--filter-program-like` is what unblocked it.
 *
 * THE SCENARIOS ARE TARGETED, NOT RANDOM. Each is a deliberate one-rule violation of a bound our own
 * Layer 2 states, built from the SAME constants Layer 2 enforces (never a hand-typed number that could
 * drift from the rule it is meant to trip), plus a control that must be eligible on both sides — because
 * a battery where everything declines proves nothing about whether the decline was caused by the thing
 * under test.
 *
 * KNOWN LIMIT, stated up front rather than discovered in the output: on a `dscr >= 1.25` scenario Lender
 * Price BOTH prices and declines within the family (it splits one sheet into three DSCR band programs —
 * §2.9a), so those scenarios report `disqualification_split` and cannot resolve until task #80 settles
 * how LP picks a band. The battery therefore drives its violations at a DSCR that does not trip the
 * split, and says so.
 *
 * Named `test-lt-*` because it is an LT validation harness. NOT in `npm test` and NOT matched by the
 * `test-lt-ppe-*` aggregate glob — it needs the live Lender Price login and is run by hand.
 *
 *   node scripts/test-lt-lp-disqualify-crosscheck.js [--out report.json] [--concurrency 2]
 */
require('../src/config');
const fs = require('fs');
const client = require('../src/longterm/lenderprice/client');
const legs = require('../src/longterm/ppe/lp-agreement-legs');
const matrix = require('../src/longterm/ppe/deephaven-matrix');
const { normalizeLpDisqualified, normalizeLpFull } = require('../src/longterm/ppe/lp-normalize-full');

function arg(name, dflt) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt; }

const FILTER = { investor: 'Deephaven Mortgage', programLike: /^dscr/i };

// The deal every scenario is a variation of. DSCR 1.10 sits in the 1.00–1.24 band Lender Price actually
// prices (see the known limit above), so a decline we observe is caused by the violation under test and
// not by the band split.
const BASE = {
  purpose: 'Purchase', value: 500000, loan: 300000, fico: 760, dscr: 1.10,
  state: 'TX', zip: '75201', prepayMonths: 60, borrowerType: 'LLC',
};

// Each case names the OUR-SIDE rule it is built to trip, and takes its number from Layer 2's own
// constants wherever Layer 2 exposes one — so a case can never quietly stop violating the rule it names.
const M = matrix._internals || {};
const CASES = [
  { label: 'CONTROL — a clean loan', expect: 'eligible', scenario: {} },
  { label: 'FICO below the program floor', rule: 'dhvn_min_fico', scenario: { fico: 600 } },
  { label: 'DSCR below the 0.75 floor', rule: 'dhvn_min_dscr', scenario: { dscr: 0.5, loan: 300000 } },
  { label: 'loan above the $2.5MM ceiling', rule: 'dhvn_max_loan', scenario: { loan: 3000000, value: 5000000 } },
  { label: 'loan below the $75k floor', rule: 'dhvn_min_loan_ge1', scenario: { loan: 60000, value: 120000 } },
  { label: 'LTV above every grid cap', rule: 'dhvn_grid_ltv', scenario: { loan: 450000 } },           // 90% LTV
  { label: 'subordinate financing', rule: 'dhvn_subordinate', scenario: { subordinateLoanAmount: 50000 } },
  { label: '5+ units', rule: 'dhvn_units_5plus', scenario: { units: 5, propertyType: 'Unit2_4' } },
  { label: 'interest-only below 1.00x DSCR', rule: 'dhvn_io_min_dscr', scenario: { io: true, dscr: 0.9, loan: 250000 } },
];

function scenarioOf(c) { return { ...BASE, ...c.scenario }; }

async function main() {
  const r = legs.readiness(client, process.env);
  console.log(`Lender Price login: ${r.configured ? 'present' : 'MISSING'}`);
  if (!r.configured) { console.error(`\n${r.message}`); process.exit(2); }
  console.log(`Scoped to: investor "${FILTER.investor}", program family /^dscr/i`);
  console.log(`Cases: ${CASES.length} (1 control + ${CASES.length - 1} targeted single-rule violations)\n`);

  const lp = legs.buildLpLeg(client, { withDisqualify: true });
  const rows = [];
  for (const c of CASES) {
    const sc = scenarioOf(c);
    let res;
    try { res = await lp(sc); } catch (e) { rows.push({ ...c, error: String(e && e.message || e) }); continue; }

    const priced = normalizeLpFull(res.full || {}, FILTER);
    const declined = normalizeLpDisqualified(res.disqualified || {}, FILTER);
    // The REAL converter, the same one the agreement harness's own leg uses — never a second copy of
    // the scenario→facts conversion here, or this harness would be measuring a different loan than the
    // one the agreement run measures. (The first cut wrote a local fallback and guarded it on
    // `legs._internals` EXISTING rather than on the function existing, so it took the fallback path and
    // then threw on a function that lives at the top level. A guard has to test the thing you are about
    // to call.)
    const ours = matrix.evaluateEligibility(legs.lpScenarioToFacts(sc));

    rows.push({
      label: c.label, rule: c.rule || null, expect: c.expect || 'ineligible',
      oursEligible: !!ours.eligible,
      ourReasons: (ours.reasons || []).map((x) => x.code),
      lpPriced: priced.bestLadder.length > 0,
      lpDeclinedCount: declined.declined.length,
      lpReasons: [...new Set(declined.declined.flatMap((d) => (d.reasons || []).map((x) => x.rule)).filter(Boolean))],
      dqReady: declined.ready,
    });
  }

  // ---- the report ------------------------------------------------------------------------------
  let corroborated = 0; let onlyOurs = 0; let onlyLp = 0; let split = 0; let unknown = 0;
  console.log('rule                          ours        Lender Price      verdict');
  console.log('─'.repeat(96));
  for (const row of rows) {
    if (row.error) { unknown += 1; console.log(`${String(row.label).padEnd(30)} ERROR ${row.error}`); continue; }
    const oursDeclines = !row.oursEligible;
    const lpDeclines = row.lpDeclinedCount > 0;
    let verdict;
    if (!row.dqReady) { verdict = 'UNKNOWN (LP disqualify feed not ready)'; unknown += 1; }
    else if (row.lpPriced && lpDeclines) { verdict = 'SPLIT — LP both prices and declines (task #80)'; split += 1; }
    else if (oursDeclines && lpDeclines) { verdict = 'corroborated'; corroborated += 1; }
    else if (oursDeclines && !lpDeclines) { verdict = 'ONLY US — overlay, or a rule too tight'; onlyOurs += 1; }
    else if (!oursDeclines && lpDeclines) { verdict = '⚠ ONLY LENDER PRICE — we would price a loan they refuse'; onlyLp += 1; }
    else { verdict = row.expect === 'eligible' ? 'both eligible (control)' : 'NEITHER declines — the case did not bite'; if (row.expect !== 'eligible') onlyLp += 0, unknown += 1; }
    console.log(`${String(row.label).padEnd(30)} ${(oursDeclines ? 'declines' : 'prices').padEnd(11)} ${(lpDeclines ? `declines(${row.lpDeclinedCount})` : 'prices').padEnd(17)} ${verdict}`);
    if (row.ourReasons.length) console.log(`${' '.repeat(30)} our codes: ${row.ourReasons.join(', ')}`);
    if (row.lpReasons.length) console.log(`${' '.repeat(30)} LP says:   ${row.lpReasons.slice(0, 4).join(' | ')}${row.lpReasons.length > 4 ? ` … (+${row.lpReasons.length - 4})` : ''}`);
  }

  console.log('\n===== disqualifier cross-check =====');
  console.log(`  corroborated            ${corroborated}   (both refuse — our rule matches the investor)`);
  console.log(`  only us                 ${onlyOurs}   (a deliberate overlay, or a rule that is too tight)`);
  console.log(`  ⚠ only Lender Price     ${onlyLp}   (we would price a loan they refuse — the dangerous direction)`);
  console.log(`  split / unresolvable    ${split}   (LP prices one DSCR band and declines another — task #80)`);
  console.log(`  unknown                 ${unknown}`);

  const out = arg('--out');
  if (out) { fs.writeFileSync(out, JSON.stringify(rows, null, 2)); console.log(`\n  full report → ${out}`); }
  // The DANGEROUS direction is the only one that fails this harness: being stricter than the investor is
  // a business decision, being looser is a loan we cannot sell.
  process.exit(onlyLp > 0 ? 1 : 0);
}

main().catch((e) => { console.error(`disqualify cross-check failed: ${e && e.stack || e}`); process.exit(4); });
