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
const { buildSearch } = require('../src/longterm/lenderprice/search-model');
const settings = require('../src/longterm/ppe/settings');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}
function flag(name) { return process.argv.includes(name); }
function die(code, msg) { console.error(msg); process.exit(code); }
function readJson(path) { return JSON.parse(fs.readFileSync(path, 'utf8')); }
// The battery's own bookkeeping keys are not part of the request; leaving them in would make two
// scenarios that send the same body look different purely because they are labelled differently.
function stripInternal(sc) { const o = { ...sc }; delete o._label; delete o._group; delete o._ineligible; return o; }

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
  // --with-prepay: measure the PREPAY axis too, using the module's OWN composed grid
  // (deephaven-dscr-prepay-maxprice.buildPrepayMaxPriceGrid) rather than re-composing the tables here —
  // one definition of "the full sheet". Off by default because the base sheet is the 30-day / 3-year
  // baseline every earlier measurement was taken against, so turning it on changes what is being
  // compared and must be a deliberate choice.
  //
  // The prepay LLPA is worth measuring: Lender Price itemizes a `5 Year Prepay Penalty` of 0.625 on
  // every scenario in the canonical battery, and our table reads +0.625 for a 60-month standard term —
  // so this is an axis that can now be CHECKED rather than ignored.
  const withPrepay = flag('--with-prepay');
  let program;
  try {
    const grid = builtin
      ? (withPrepay ? require('../src/longterm/ppe/deephaven-dscr-prepay-maxprice').buildPrepayMaxPriceGrid() : buildDeephavenGrid())
      : null;
    program = builtin
      ? rateSheetToProgram(gridToRateSheet(grid), { code: 'DHVN_DSCR30', name: 'Deephaven DSCR 30yr', investorCode: 'DHVN' })
      : rateSheetToProgram(readJson(sheetPath), { source: sheetPath });
  } catch (e) { die(3, `Could not build a program from ${builtin ? 'the built-in Deephaven sheet' : sheetPath}: ${e.message}`); }
  console.log(`Sheet-under-test: ${builtin ? `built-in Deephaven DSCR (v12.7.25 confirmed subset)${withPrepay ? ' + PREPAY/max-price block' : ''}` : sheetPath}`);

  // 3) scenarios
  const scPath = arg('--scenarios', process.env.LT_SCENARIOS);
  const scenarios = scPath ? readJson(scPath) : defaultScenarios();
  console.log(`Scenarios: ${scenarios.length}${scPath ? ` (from ${scPath})` : ' (canonical agreement battery)'}`);

  // 4) the two legs + the run
  const s = settings.resolveAll().values;
  const filter = {};
  for (const k of ['program', 'investor', 'lender', 'product']) { const v = arg(`--filter-${k}`); if (v) filter[k] = v; }
  // --filter-program-like: the program FAMILY pattern. Lender Price splits ONE rate sheet into several
  // PROGRAMS (Deephaven's DSCR sheet is three programs, one per DSCR band, and the same investor also
  // sells Expanded Prime / Non Prime / ITIN, which decline on every DSCR scenario). An exact --filter-
  // program pins us to one band LP may not have chosen; the investor alone leaves the other product
  // lines in. See lp-normalize-full.programRe.
  {
    const v = arg('--filter-program-like');
    if (v) { try { filter.programLike = new RegExp(v, 'i'); } catch (e) { die(5, `--filter-program-like is not a valid pattern: ${e.message}`); } }
  }

  // ---- THE MIS-INVOCATION GUARD -------------------------------------------------------------------
  // An UNSCOPED run of the built-in Deephaven sheet does not produce a weak verdict — it produces a
  // CONFIDENT WRONG ONE, and that is the expensive direction. Measured live 2026-08-17 on the canonical
  // battery: with no filter the LP side is the WHOLE MARKET, so normalizeLpFull's ladder merges 30 DSCR
  // programs across 16 lenders (→ `coupon_missing_ours` on coupons no single sheet prices) and the
  // disqualify tree contributes 9,146 declined items from 20 lenders (→ `disqualification_missing` on
  // every scenario, because SOMEBODY always declines). The run printed "agreement 0.00% — GATE MET NO"
  // for 299 scenarios, which reads exactly like a total engine regression and is not one: the same
  // battery scoped to `Deephaven Mortgage` agrees on 244/295. A gate that answers confidently when it
  // was asked the wrong question is worse than a gate that refuses, so this refuses.
  if (builtin && !flag('--unscoped') && !filter.investor && !filter.lender && !filter.program && !filter.programLike) {
    die(6, 'REFUSING to run the built-in Deephaven sheet UNSCOPED.\n\n'
      + 'With no --filter-*, the Lender Price side is every lender in the market, so our one-investor\n'
      + 'sheet is compared against ~30 DSCR programs and ~9,000 unrelated declines. The result is a\n'
      + 'confident 0.00% that means nothing. Scope it to the sheet\'s own investor, e.g.\n\n'
      + '  --filter-investor "Deephaven Mortgage" --filter-program-like "^dscr"\n\n'
      + 'Pass --unscoped only if you deliberately want the whole-market comparison.');
  }
  const ours = legs.buildOursLeg(program, s, { factsFromLp: true });
  const lp = legs.buildLpLeg(client, { withDisqualify: !flag('--no-disqualify') });

  let done = 0;
  const onResult = () => { done += 1; if (done % 25 === 0 || done === scenarios.length) process.stdout.write(`  …${done}/${scenarios.length}\n`); };
  const { results, summary } = await runRatesheetAgreement(scenarios, { ours, lp }, {
    // ⛔ ASK LENDER PRICE EACH DISTINCT QUESTION ONCE (§2.95). Measured on the canonical battery: 32 of
    // 305 scenarios build a BYTE-IDENTICAL request — the FICO×CLTV and DSCR×CLTV sweeps overlap at
    // FICO 760, and `ppp 5yr` matches `state CA` because 60 months is the profile default. Both
    // scenarios are still compared and still counted; only the paid call is shared.
    //
    // The key is the request `buildSearch` would actually send, minus its timestamp — not the scenario
    // object, because two DIFFERENT scenarios can build the same request and that is most of the 32.
    // Built against the static base: the foundation is the same for every scenario in a run, so two
    // scenarios equal under it are equal under the live one too.
    dedupeKey: (sc) => {
      try {
        const body = buildSearch(stripInternal(sc));
        return JSON.stringify(body).replace(/"date":"[^"]*"/, '');
      } catch (_) { return null; } // unbuildable → never merged with anything
    },
    filter,
    settings: s,
    priceToleranceMilli: s['validation.price_tolerance_milli'],
    // the live Deephaven sheet itemizes reason-ambiguous adjTypes; classify by reason, and do not count
    // the not-yet-modelled prepay axis as a disagreement (it is surfaced separately).
    lpDimensionOf: builtin ? deephavenLpDimension : undefined,
    // `prepay` is ignored ONLY while the sheet-under-test does not carry the prepay block — with
    // --with-prepay it is a measured axis and ignoring it would hide the very thing that was turned on.
    ignoreDimensions: (builtin && !withPrepay) ? ['prepay'] : undefined,
    // The rate-sheet AGREEMENT is eligibility + base price + itemized LLPAs. LP's displayed price and
    // adjustmentPoints carry an unreconciled origination/margin (NOT the LLPAs), so those net-price axes
    // are a compensation-layer question (task #78), reported but not gated.
    coarseIgnore: builtin ? ['final_price', 'llpa_total', 'margin'] : undefined,
    // ⛔ CAP/FLOOR: gate the FRAME-FREE check only, and never the blunt `skipBounds`.
    //
    // The owner's HARD RULE names max price and min price among the things that must AGREE, and this
    // runner used to pass `skipBounds: builtin` — one flag that switched off BOTH of boundsProbe's
    // checks. `samePrice` genuinely cannot be gated here (it is the same origination/margin gap as
    // `final_price` above), but `clampFaithful` is pure arithmetic of our own and has nothing to do with
    // the frame — so it went un-gated for no reason, and the cap/floor axis was neither gated NOR
    // reported on every live run.
    //
    // MEASURED OFFLINE 2026-08-17 over the whole 299-scenario battery before switching this on, so it
    // cannot newly fail a live run by surprise: 7,168 rungs on each grid, `clampFaithful` false on ZERO.
    // What the same measurement found is worth reading in the bounds line below — the DEFAULT built-in
    // grid states NO ceiling at all (the max-price block lives in the --with-prepay grid), and prices up
    // to 110.500 against an investor sheet whose own ceiling is 105.
    boundsGate: builtin ? ['clampFaithful'] : undefined,
    concurrency: Number(arg('--concurrency', '2')) || 2,
    onResult,
  });

  // 5) the gate report
  console.log('\n===== Lender Price agreement (E3 gate) =====');
  console.log(`  scenarios     ${summary.total}`);
  console.log(`  comparable    ${summary.comparable}  (incomparable ${summary.incomparable}, errors ${summary.errors})`);
  // ⛔ WHY the battery shrank, not just by how much (§2.90/§2.91). An incomparable scenario is neither a
  // match nor a miss, so it leaves the denominator — and the COUNT alone cannot tell "Lender Price
  // answered nothing" from "we never asked it for its refusals". Those send a reader to two different
  // places, so the reasons are named here rather than buried in the --out JSON.
  if (summary.incomparableByReason && Object.keys(summary.incomparableByReason).length) {
    console.log(`                why: ${JSON.stringify(summary.incomparableByReason)}`);
  }
  // The COMPOSITION of the agreement, not just its size. A both-decline is a real agreement (the owner
  // asked for ineligible scenarios by name), but it says far less about the SHEET than a priced scenario
  // whose every LLPA reconciled — so a headline built mostly of declines would read stronger than it is.
  console.log(`  agreed        ${summary.agreed}  (priced ${summary.agreedPriced}, both-declined ${summary.agreedDeclined})`);
  console.log(`  disagreed     ${summary.disagreed}`);
  // How BIG the worst LLPA disagreement is anywhere. "41 disagreements" reads very differently at 1
  // milli than at 5,000, and until now the number was computed per scenario and dropped.
  if (summary.worstDeltaMilli) console.log(`  worst LLPA Δ  ${summary.worstDeltaMilli} milli`);
  console.log(`  agreement     ${summary.agreementRate == null ? 'n/a' : (summary.agreementRate * 100).toFixed(2) + '%'}`);
  if (Object.keys(summary.byCategory).length) console.log(`  by category   ${JSON.stringify(summary.byCategory)}`);
  if (Object.keys(summary.byDimension).length) console.log(`  by dimension  ${JSON.stringify(summary.byDimension)}`);
  if (summary.byStatus && Object.keys(summary.byStatus).length) console.log(`  by status     ${JSON.stringify(summary.byStatus)}`);
  // the two piles a human needs kept apart: whole families we already know we must measure (task #62),
  // vs real surprises (a cell we DO encode got a number wrong, or something unexpected). BOTH block the gate.
  if (summary.pendingEncodeFamilies && summary.pendingEncodeFamilies.length) console.log(`  pending encode ${summary.pendingEncodeFamilies.join(', ')}  (known-unmeasured families — §2.6 / task #62)`);
  if (summary.surprises && summary.surprises.length) console.log(`  ⚠ surprises   ${summary.surprises.join(', ')}  (a cell we DO encode disagrees — investigate)`);
  // THE CAP/FLOOR AXIS, STATED. It used to be computed per rung and dropped, so a reader had no way to
  // tell an agreed ceiling from one nothing ever tested. `capStated 0` means this run priced against NO
  // ceiling; `clamped 0` means every limit stated was stated and never reached — an unexercised limit is
  // not a verified one, and only a run that BINDS a limit can say anything about it.
  {
    const b = summary.bounds;
    if (b && b.rungsProbed) {
      const gated = (b.gated && b.gated.length) ? b.gated.join(', ') : 'none';
      const ungated = (b.ungated && b.ungated.length) ? b.ungated.join(', ') : 'none';
      console.log(`  cap/floor     rungs ${b.rungsProbed} · cap stated ${b.capStated} · floor stated ${b.floorStated} · clamped ${b.clamped} (by cap ${b.boundByCap}, by floor ${b.boundByFloor})`);
      console.log(`                gated: ${gated} · reported only: ${ungated}${Object.keys(b.failures).length ? ` · failures ${JSON.stringify(b.failures)}` : ''}`);
      if (!b.capStated) console.log('                ⚠ no ceiling was stated on any rung — this run TESTED no max price (the max-price block is the --with-prepay grid)');
      else if (!b.clamped) console.log('                ⚠ a ceiling was stated but never reached — this run did not exercise it');
    }
  }
  // The saving, stated. A run that quietly made fewer calls than it has scenarios would read as a
  // battery that shrank; this says plainly that the coverage is whole and the CALLS were shared.
  if (summary.deduped) {
    console.log(`  paid calls    ${summary.distinctRequests} distinct requests for ${summary.total} scenarios (${summary.deduped} shared — identical request, same answer)`);
  }
  if (summary.disagreeing.length) console.log(`  disagreeing   ${summary.disagreeing.slice(0, 10).join(' | ')}${summary.disagreeing.length > 10 ? ' …' : ''}`);
  // ⛔ THE DECLINE FEED, STATED BEFORE THE VERDICT (§2.93). The disqualify tree is the ONLY place
  // Lender Price states a refusal. Without it the run cannot see the EXPENSIVE direction — LP declines
  // and we price, i.e. we quote a loan the investor will not buy — because `lpDeclined` is false on
  // every scenario. So the gate cannot pass, and the report says why in the same breath rather than
  // leaving a reader to wonder which of the numbers above cost them the gate.
  if (!summary.declineFeedComplete) {
    console.log(`  ⚠ declines    NOT OBSERVED on ${summary.total - summary.declineFeedReady} of ${summary.total} scenarios`);
    console.log('                Lender Price states a refusal ONLY in its disqualify tree. This run could');
    console.log('                not see one, so it cannot prove eligibility either way — and it CANNOT see');
    console.log('                the expensive case, LP declining a loan we price. The price comparison above');
    console.log('                stands; the eligibility verdict does not. Re-run without --no-disqualify to gate.');
  }
  console.log(`  GATE MET      ${summary.gateMet ? 'YES' : 'NO'}`);

  const out = arg('--out');
  if (out) { fs.writeFileSync(out, JSON.stringify({ summary, results }, null, 2)); console.log(`\n  full report → ${out}`); }
  process.exit(summary.gateMet ? 0 : 1);
})().catch((e) => die(4, `agreement run failed: ${e && e.stack || e}`));
