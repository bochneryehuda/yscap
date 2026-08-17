#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the ONE-COMMAND runner for the ≥200-scenario Lender Price AGREEMENT run (E3 gate, owner HARD
 * RULE 2026-08-17). It is a THIN CLI over tested modules: readiness + the two leg adapters + the
 * orchestrator. It prices OUR sheet-under-test and Lender Price on the same scenarios and prints the
 * gate report — the run that must pass (agree on every LLPA, every eligibility/ineligibility, and
 * max/min price, to the penny) BEFORE a rate sheet is trusted in the system.
 *
 * Named `scripts/test-lt-*.js` because it is an LT VALIDATION harness (it exits 0 when our engine
 * agrees with Lender Price, non-zero when it does not) and only LT test scripts may import Long-Term
 * code (the product-separation gate). It is deliberately NOT in the `npm test` list and does NOT match
 * the `test-lt-ppe-*` aggregate glob — it needs the live login and is run by hand, never in CI.
 *
 * The moment the three Lender Price credentials (LP_USERNAME / LP_PASSWORD / LP_CLIENT_SECRET) are in
 * the environment, this runs the whole battery in one command:
 *
 *   node scripts/test-lt-lp-agreement-run.js --sheet <sheet.json> [--scenarios <scenarios.json>] \
 *        [--filter-investor DHVN] [--no-disqualify] [--out <report.json>]
 *
 *   --sheet       the sheet-under-test (a rateSheetToProgram INPUT, i.e. a ratesheet object). Or set
 *                 LT_SHEET_UNDER_TEST=<path>. This is your INDEPENDENT ANALYSIS candidate — never
 *                 trusted until this run agrees with Lender Price.
 *   --scenarios   a JSON array of Lender Price scenarios. If omitted, the canonical ≥200-scenario
 *                 battery (agreement-scenarios.buildAgreementScenarios) is used — every LLPA angle.
 *   --filter-*    narrow Lender Price to one program/investor/lender/product (the sheet's investor).
 *   --no-disqualify   skip the disqualify poll (rungs-only; faster, but does not check ineligibility).
 *   --out         also write the full per-scenario report as JSON.
 *
 * Nothing about this WRITES a rate sheet anywhere or changes the live pricer. LT-only.
 */
const fs = require('fs');
require('../src/config'); // load a bundled .env (LP_USERNAME/LP_PASSWORD/LP_CLIENT_SECRET) before the client reads env
const client = require('../src/longterm/lenderprice/client');
const legs = require('../src/longterm/ppe/lp-agreement-legs');
const { runRatesheetAgreement } = require('../src/longterm/ppe/ratesheet-agreement');
const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');
const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
const { buildDeephavenGrid } = require('../src/longterm/ppe/deephaven-dscr-sheet');
const { deephavenLpDimension } = require('../src/longterm/ppe/ratesheet-agreement-diff');
const { buildAgreementScenarios } = require('../src/longterm/ppe/agreement-scenarios');
const settings = require('../src/longterm/ppe/settings');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}
function flag(name) { return process.argv.includes(name); }
function die(code, msg) { console.error(msg); process.exit(code); }
function readJson(path) { return JSON.parse(fs.readFileSync(path, 'utf8')); }

// The canonical ≥200-scenario battery (agreement-scenarios.js) — every LLPA angle, in Lender Price
// scenario shape. A caller may still override with --scenarios (e.g. to replay a captured set).
function defaultScenarios() { return buildAgreementScenarios().scenarios; }

(async () => {
  // 1) readiness — the honest blocker. Without the login there is nothing to compare against.
  const r = legs.readiness(client, process.env);
  console.log(`Lender Price login: ${r.configured ? 'present' : 'MISSING'}`);
  if (!r.configured) die(2, `\n${r.message}\n\nThis is the ONLY thing blocking the live agreement run. `
    + 'The whole harness (comparators + orchestrator + adapters) is built and unit-tested offline; '
    + 'it runs the moment those three values are set.');

  // 2) the sheet-under-test → our program. Default: the built-in, LP-validated Deephaven DSCR sheet
  // (deephaven-dscr-sheet.js). Override with --sheet <path> to a rateSheetToProgram input JSON.
  const sheetPath = arg('--sheet', process.env.LT_SHEET_UNDER_TEST);
  const builtin = !sheetPath;
  let program;
  try {
    program = builtin
      ? rateSheetToProgram(gridToRateSheet(buildDeephavenGrid()), { code: 'DHVN_DSCR30', name: 'Deephaven DSCR 30yr', investorCode: 'DHVN' })
      : rateSheetToProgram(readJson(sheetPath), { source: sheetPath });
  } catch (e) { die(3, `Could not build a program from ${builtin ? 'the built-in Deephaven sheet' : sheetPath}: ${e.message}`); }
  console.log(`Sheet-under-test: ${builtin ? 'built-in Deephaven DSCR (v12.7.25 confirmed subset)' : sheetPath}`);

  // 3) scenarios
  const scPath = arg('--scenarios', process.env.LT_SCENARIOS);
  const scenarios = scPath ? readJson(scPath) : defaultScenarios();
  console.log(`Scenarios: ${scenarios.length}${scPath ? ` (from ${scPath})` : ' (canonical agreement battery)'}`);

  // 4) the two legs + the run
  const s = settings.resolveAll().values;
  const filter = {};
  for (const k of ['program', 'investor', 'lender', 'product']) { const v = arg(`--filter-${k}`); if (v) filter[k] = v; }
  const ours = legs.buildOursLeg(program, s, { factsFromLp: true });
  const lp = legs.buildLpLeg(client, { withDisqualify: !flag('--no-disqualify') });

  let done = 0;
  const onResult = () => { done += 1; if (done % 25 === 0 || done === scenarios.length) process.stdout.write(`  …${done}/${scenarios.length}\n`); };
  const { results, summary } = await runRatesheetAgreement(scenarios, { ours, lp }, {
    filter,
    settings: s,
    priceToleranceMilli: s['validation.price_tolerance_milli'],
    // the live Deephaven sheet itemizes reason-ambiguous adjTypes; classify by reason, and do not count
    // the not-yet-modelled prepay axis as a disagreement (it is surfaced separately).
    lpDimensionOf: builtin ? deephavenLpDimension : undefined,
    ignoreDimensions: builtin ? ['prepay'] : undefined,
    // The rate-sheet AGREEMENT is eligibility + base price + itemized LLPAs. LP's displayed price and
    // adjustmentPoints carry an unreconciled origination/margin (NOT the LLPAs), and Deephaven has no
    // cap/floor — so those net-price axes are a compensation-layer question, reported but not gated.
    coarseIgnore: builtin ? ['final_price', 'llpa_total', 'margin'] : undefined,
    skipBounds: builtin,
    concurrency: Number(arg('--concurrency', '2')) || 2,
    onResult,
  });

  // 5) the gate report
  console.log('\n===== Lender Price agreement (E3 gate) =====');
  console.log(`  scenarios     ${summary.total}`);
  console.log(`  comparable    ${summary.comparable}  (incomparable ${summary.incomparable}, errors ${summary.errors})`);
  console.log(`  agreed        ${summary.agreed}`);
  console.log(`  disagreed     ${summary.disagreed}`);
  console.log(`  agreement     ${summary.agreementRate == null ? 'n/a' : (summary.agreementRate * 100).toFixed(2) + '%'}`);
  if (Object.keys(summary.byCategory).length) console.log(`  by category   ${JSON.stringify(summary.byCategory)}`);
  if (Object.keys(summary.byDimension).length) console.log(`  by dimension  ${JSON.stringify(summary.byDimension)}`);
  if (summary.byStatus && Object.keys(summary.byStatus).length) console.log(`  by status     ${JSON.stringify(summary.byStatus)}`);
  // the two piles a human needs kept apart: whole families we already know we must measure (task #62),
  // vs real surprises (a cell we DO encode got a number wrong, or something unexpected). BOTH block the gate.
  if (summary.pendingEncodeFamilies && summary.pendingEncodeFamilies.length) console.log(`  pending encode ${summary.pendingEncodeFamilies.join(', ')}  (known-unmeasured families — §2.6 / task #62)`);
  if (summary.surprises && summary.surprises.length) console.log(`  ⚠ surprises   ${summary.surprises.join(', ')}  (a cell we DO encode disagrees — investigate)`);
  if (summary.disagreeing.length) console.log(`  disagreeing   ${summary.disagreeing.slice(0, 10).join(' | ')}${summary.disagreeing.length > 10 ? ' …' : ''}`);
  console.log(`  GATE MET      ${summary.gateMet ? 'YES' : 'NO'}`);

  const out = arg('--out');
  if (out) { fs.writeFileSync(out, JSON.stringify({ summary, results }, null, 2)); console.log(`\n  full report → ${out}`); }
  process.exit(summary.gateMet ? 0 : 1);
})().catch((e) => die(4, `agreement run failed: ${e && e.stack || e}`));
