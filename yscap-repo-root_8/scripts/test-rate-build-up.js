#!/usr/bin/env node
/**
 * THE RATE BUILD-UP: BUY RATE → OUR MARKUP → THE BORROWER'S NOTE RATE.
 *
 * Owner-directed 2026-08-07, on the registered-product structure page: "when I have
 * added the buy rate, the markup, and the final rate, I want to show what is out of
 * pocket of rehab. I want to show the payoff amount. I want to show a lot more
 * information that was actually registered … I want that page to be restructured,
 * redesigned, and set up with correct tables. Don't remove any information."
 *
 * The three engines deliberately never hand over the buy rate (standard-program.js:
 * "the buy rate is computed internally and never returned/exposed"), so pricing.js
 * MEASURES it — prices the same deal with the markup pinned to zero — and then
 * PROVES the measurement by re-pricing at the measured markup and requiring the
 * engine to reproduce the real note rate and the real structure exactly.
 *
 * THE TWO ASSERTIONS THAT MATTER:
 *   §2 — nothing leaks. The measurement sets the engines' markup hooks, so a missed
 *        restore would silently re-price every later quote in the process at the
 *        wrong markup. That is a pricing bug, not a display bug.
 *   §6 — the frozen numbers did not move. Hard-coded canaries, so a change to the
 *        rate or the sizing has to be a deliberate edit to this file.
 *
 * PURE — no database, no network. In `npm test`.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let fails = 0;
function ok(cond, what) {
  if (cond) { console.log(`  ✓ ${what}`); return; }
  fails++; console.error(`  ✗ ${what}`);
}
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const near = (a, b, eps = 0.0011) => Math.abs(Number(a) - Number(b)) <= eps;

const P = require('../src/lib/pricing');
if (!P.enginesReady()) {
  console.error('  ✗ pricing engines unavailable: ' + (P.loadErr() || ''));
  process.exit(1);
}

const BASE = {
  purchase_price: 400000, as_is_value: 400000, arv: 600000, rehab_budget: 100000,
  fico: 720, loan_type: 'Purchase', program: 'Standard', property_type: 'SFR', units: 1,
  term: '12', property_address: { state: 'NJ', city: 'Newark', oneLine: '1 Test St, Newark, NJ 07102' },
};
const EXP = { flips: 3, holds: 0, ground: 0 };
const PROGRAMS = ['standard', 'gold', 'silver', 'manual'];
// A manual product prices on the Standard engine and is only ever recorded as
// Manual when a STRUCTURAL basis override is present (manual-program.resolveProgram),
// so every manual quote here carries one.
const quote = (prog, app = BASE, over = null, exp = EXP) => {
  const o = Object.assign({}, over || {}, prog === 'manual' ? { ovrLTCPct: 80 } : {});
  return P.quoteProgram(prog, P.buildInputs(app, exp, Object.keys(o).length ? o : null));
};
const build = (prog, app, over, exp) => (quote(prog, app, over, exp).adminPricing || {}).rateBuildUp || null;

console.log('\n1. The three figures ADD UP — on every program and every deal shape');
{
  const shapes = [
    ['plain purchase', {}, null],
    ['financed reserve', { requested_ir_months: 6 }, null],
    ['bigger reserve, small deal', { purchase_price: 180000, as_is_value: 175000, arv: 260000, rehab_budget: 40000, requested_ir_months: 12 }, null],
    ['heavy rehab', { rehab_budget: 320000, arv: 900000, rehab_type: 'Heavy / gut rehab' }, null],
    ['LTC target', { requested_ir_months: 6 }, { ovrLTCPct: 80 }],
    ['cash-out refinance', { loan_type: 'Refinance', payoff_amount: 250000, requested_ir_months: 3 }, { cashOut: true }],
    ['13-month term', { term: '18' }, null],
    ['low FICO', { fico: 665 }, null],
  ];
  let measured = 0;
  for (const [label, over, ovr] of shapes) {
    for (const prog of PROGRAMS) {
      const app = Object.assign({}, BASE, over);
      let b;
      try { b = build(prog, app, ovr); } catch (e) { ok(false, `${label} / ${prog} threw: ${e.message}`); continue; }
      if (!b) continue;                                  // nothing priced — no build-up to reconcile
      if (!b.exact) {
        // Omit-don't-guess: an unproven measurement may never carry a figure.
        ok(b.buyRatePct === null && b.markupPct === null && !!b.why,
          `${label} / ${prog}: unproven build-up carries NO buy rate, and says why (${b.why})`);
        continue;
      }
      measured++;
      ok(near(b.buyRatePct + b.markupPct, b.finalRatePct),
        `${label} / ${prog}: ${b.buyRatePct}% buy + ${b.markupPct}% markup = ${b.finalRatePct}% note rate`);
      ok(b.markupPct >= 0, `${label} / ${prog}: the markup is never negative`);
    }
  }
  ok(measured >= 20, `the build-up is actually measurable on real deals (${measured} of them), not permanently "unproven"`);
}

console.log('\n2. THE SAFETY PROPERTY — measuring leaves the engines exactly as it found them');
{
  // The measurement pins each engine's markup hooks. If it failed to put them back,
  // every LATER quote in this process would price at the probe's markup — a silent
  // pricing bug across the whole app, out of a display feature.
  //
  // THE BASELINE COMES FROM A CHILD PROCESS, and that is the whole point. Taking it
  // in-process is worthless: by the time this section runs, §1 has already measured
  // 30 quotes, so a leak would have corrupted the "before" snapshot too and the
  // comparison would pass. (Verified: with the restore deliberately removed, an
  // in-process baseline reported no leak while the §6 canaries screamed.) A fresh
  // `node -e` require is the only genuinely untouched engine state available.
  const { execFileSync } = require('child_process');
  const inp = P.buildInputs(BASE, EXP, null);
  const engines = ['standard-program', 'gold-standard', 'silver-program'];
  const child = `
    const out = {};
    for (const n of ${JSON.stringify(engines)}) {
      out[n] = JSON.stringify(require(${JSON.stringify(path.join(__dirname, '../web/tools/'))} + n + '.js')
        .evaluate(${JSON.stringify(inp)}));
    }
    process.stdout.write(JSON.stringify(out));`;
  let pristine = null;
  try { pristine = JSON.parse(execFileSync(process.execPath, ['-e', child], { encoding: 'utf8' })); }
  catch (e) { ok(false, `could not take a pristine engine baseline: ${e.message}`); }
  if (pristine) {
    for (let i = 0; i < 3; i++) {
      for (const prog of PROGRAMS) {
        quote(prog, Object.assign({}, BASE, { requested_ir_months: 6 }), null);
        quote(prog, Object.assign({}, BASE, { requested_ir_months: 6 }),
          { markupStdPct: 1.25, markupGoldPct: 0.9, markupSilverPct: 1.4, markupGoldT1Pct: 0.35 });
      }
    }
    for (const n of engines) {
      const now = JSON.stringify(require(`../web/tools/${n}.js`).evaluate(inp));
      ok(now === pristine[n],
        `${n}.js still prices exactly as it does on a fresh boot — no markup state left behind`);
    }
  }
  // And a quote is deterministic, which is the same property seen from the top.
  ok(JSON.stringify(quote('standard')) === JSON.stringify(quote('standard')),
    'the same inputs produce a byte-identical quote, twice running');

  // THE RESTORE CONTRACT, ASSERTED DIRECTLY rather than hoped for. A quote sequence
  // is a poor way to catch this: `quoteProgram`'s own finally resets whatever IT set,
  // and the probe's last act is to re-price at the markup it just measured — so
  // depending on the exact tail of the sequence a missed restore can leave the
  // engine looking correct, and several plausible sequences were tried against a
  // deliberately-removed restore before this. So: put the engine into a state a
  // caller would have set, measure, and require that exact state back.
  //
  // AND IT HAS TO BE READ ON A DIFFERENT TIER THAN THE ONE MEASURED. Re-pricing the
  // SAME deal proves nothing: the probe's last act is to pin the markup it measured
  // on every tier, which for that deal's own tier reproduces its rate exactly, so a
  // dropped restore is invisible there. Measure the TIER-3 deal (whose markup comes
  // from the caller's per-program value) and then read the TIER-1 one (whose markup
  // comes from the caller's per-tier map) — a leak pins tier 3's value on tier 1.
  // NOTE the Standard engine reaches its top tier at THREE flips, so the ordinary
  // fixture above is already tier 1; the tiers here are chosen deliberately.
  const YSP = require('../web/tools/standard-program.js');
  const CALLER_M = 0.02, CALLER_TIERS = { 1: 0.03 };
  const t3In = P.buildInputs(BASE, { flips: 0, holds: 0, ground: 0 }, null);     // tier 3
  const t1In = P.buildInputs(BASE, { flips: 12, holds: 0, ground: 0 }, null);    // tier 1
  try {
    YSP.setMarkup(CALLER_M);
    YSP.setMarkupTiers(CALLER_TIERS);
    const hot3 = YSP.evaluate(t3In);
    const hot1 = YSP.evaluate(t1In).noteRate;
    ok(hot3.tier === 3 && !near(hot1 * 100, hot3.noteRate * 100, 0.01),
      'the fixture prices its two tiers differently, so the check below can tell a leak from a restore');
    P._internals.measureRateBuildUp('standard', t3In, hot3, CALLER_M, CALLER_TIERS);
    ok(near(YSP.evaluate(t3In).noteRate * 100, hot3.noteRate * 100, 1e-9),
      'after measuring, the caller\'s per-program markup is back (the measured deal prices unchanged)');
    ok(near(YSP.evaluate(t1In).noteRate * 100, hot1 * 100, 1e-9),
      '…and so is the caller\'s per-TIER map — a tier the probe never measured is not left pinned');
  } finally {
    YSP.setMarkup(null);
    YSP.setMarkupTiers(null);
  }
}

console.log('\n3. It measures the REAL rule, including the two that are easy to get wrong');
{
  // GOLD TIER 1 IS MARKUP-EXEMPT (frozen). A measurement that reported 0.5% here
  // would be reporting the base markup rather than what the engine applied.
  const g1 = build('gold', BASE, null, { flips: 12, holds: 0, ground: 0 });
  ok(g1 && g1.exact && g1.markupPct === 0 && near(g1.buyRatePct, g1.finalRatePct),
    'Gold top tier: the markup measures ZERO and the buy rate IS the note rate (the frozen Tier-1 exemption)');
  const g2 = build('gold', BASE, null, { flips: 3, holds: 0, ground: 0 });
  ok(g2 && g2.exact && g2.markupPct > 0, '…while a lower Gold tier does carry a markup');

  // SILVER HARD-CAPS THE MARKUP at MARKUP_MAX (1.00%). Asking for 1.4% must measure
  // as 1.0%, not as the 1.4% we requested — the engine, not the request, is truth.
  const sv = build('silver', BASE, { markupSilverPct: 1.4 });
  ok(sv && sv.exact && near(sv.markupPct, 1.0),
    `Silver: a 1.4% markup request measures as the program's 1.00% ceiling (${sv && sv.markupPct}%)`);

  // A per-file override is measured verbatim where no ceiling binds.
  const st = build('standard', BASE, { markupStdPct: 1.25 });
  ok(st && st.exact && near(st.markupPct, 1.25), 'Standard: a 1.25% markup override measures as 1.25%');
  const st0 = build('standard');
  ok(st0 && st0.exact && near(st0.markupPct, 0.5), '…and the untouched default measures as the engine constant, 0.5%');
  ok(st.buyRatePct === st0.buyRatePct,
    'changing the markup moves the NOTE rate and leaves the buy rate alone — which is what a markup is');
}

console.log('\n4. An admin-forced rate has no build-up, and says so');
{
  for (const prog of PROGRAMS) {
    const b = build(prog, BASE, { ovrRatePct: 11 });
    ok(b && b.why === 'rate_overridden' && b.buyRatePct === null && b.markupPct === null && near(b.finalRatePct, 11),
      `${prog}: an admin-set rate reports the rate alone (no invented markup)`);
  }
}

console.log('\n5. It is INTERNAL by construction — inside the block every borrower path strips');
{
  const q = quote('standard');
  ok(q.adminPricing && 'rateBuildUp' in q.adminPricing,
    'the build-up lives inside adminPricing');
  ok(!('rateBuildUp' in q), '…and NOT at the top level of the quote, where nothing would strip it');
  // The three existing scrubs all drop `adminPricing` wholesale, so the build-up is
  // covered without a fourth strip site to remember — assert they still do.
  // stripQuoteInternal moved into the shared lib/borrower-safe.js (TPO Phase 4b —
  // ONE definition, shared with routes/tpo.js so an external broker can never be
  // handed a wider scrub than a borrower by drift). It still drops adminPricing
  // wholesale; routes/borrower.js + routes/tpo.js both require it.
  const bs = read('../src/lib/borrower-safe.js');
  ok(/const \{ adminPricing, \.\.\.rest \} = q;/.test(bs),
    'lib/borrower-safe.js stripQuoteInternal still drops adminPricing wholesale');
  const b = read('../src/routes/borrower.js');
  ok(/const \{ adminPricing, \.\.\.rest \} = row\.registered_quote;/.test(b),
    'routes/borrower.js stripInternalAppFields still drops it from the registered quote');
  ok(/const \{ adminPricing, \.\.\.rest \} = registration\.quote;/.test(read('../src/lib/tpr-export.js')),
    'lib/tpr-export.js still drops it before a quote can ride out to an investor');
  // And the panel's second layer: the buy rate renders only on a staff read.
  const ui = read('../app-v2/src/components/ProductStudioPanel.jsx');
  ok(/const build = \(showAdmin && q\.adminPricing && q\.adminPricing\.rateBuildUp\) \|\| null;/.test(ui),
    'the panel reads the build-up only when showAdmin is set');
  ok(/const showBuild = !!\(build && build\.exact && build\.buyRatePct != null\);/.test(ui),
    '…and renders the buy rate only when the server proved it exact');
}

console.log('\n6. FROZEN CANARIES — the rate and the sizing did not move');
{
  // Hard-coded so a change to any frozen number has to be a deliberate edit HERE.
  // Deal: $400k purchase / $400k as-is / $600k ARV / $100k rehab / 720 FICO / 3 flips
  // / NJ / 12 months, no reserve requested.
  const expected = {
    standard: { rate: 0.10300000000000001, total: 450000, initial: 350000, holdback: 100000, ctc: 61720, liq: 73945, cc: 11720 },
    gold: { rate: 0.095, total: 420000, initial: 320000, holdback: 100000, ctc: 91210, liq: 116410, cc: 11210 },
    silver: { rate: 0.09250000000000001, total: 450000, initial: 350000, holdback: 100000, ctc: 61720, liq: 73157.5, cc: 11720 },
  };
  for (const [prog, e] of Object.entries(expected)) {
    const q = quote(prog);
    const s = q.sizing;
    ok(q.noteRate === e.rate && s.totalLoan === e.total && s.initialAdvance === e.initial
      && s.rehabHoldback === e.holdback && q.cashToClose === e.ctc
      && q.liquidityRequired === e.liq && q.closingCosts.dueAtClosing === e.cc,
      `${prog}: rate ${q.noteRate}, loan ${s.totalLoan}, cash-to-close ${q.cashToClose}, liquidity ${q.liquidityRequired} — unchanged`);
  }
}

console.log('\n7. The page can build every total it shows out of the engine, never by adding up');
{
  // Each figure the restructured page presents as a TOTAL has to come from the
  // engine, so the page can never disagree with the loan by a cent.
  const q = quote('standard', Object.assign({}, BASE, { requested_ir_months: 6 }));
  const cc = q.closingCosts;
  ok(near(cc.dueAtClosing, cc.origination + cc.lenderFee + cc.creditFee + cc.titleAndSettlement, 0.011),
    'the closing-costs total IS origination + legal/UW + credit + title (the owner\'s "all together")');
  ok(near(cc.totalIncludingPoc, cc.dueAtClosing + cc.appraisalPoc, 0.011),
    'and the with-appraisal total adds only the appraisal on top');
  ok(near(q.liquidityRequired, q.cashToClose + q.reserveRequirement + (q.sizing.oopRehab || 0) + q.closingBuffer, 0.011),
    'the liquidity total IS cash-to-close + reserve + out-of-pocket rehab + the 1% buffer');
  ok(near(q.cashToClose, q.sizing.downPayment + q.sizing.assignmentExcessOOP + cc.dueAtClosing, 0.011),
    'on a purchase, cash-to-close IS down payment + assignment excess + closing costs');
  // A refinance is a DIFFERENT sum, which is why the page itemizes it differently.
  const r = quote('standard', Object.assign({}, BASE, { loan_type: 'Refinance', payoff_amount: 250000 }));
  ok(r.refi && near(r.cashToClose, Math.max(0, r.refi.payoff + r.refi.closing - r.refi.fundedAtClose), 0.011),
    'on a refinance it IS payoff + closing − the funds advanced (never the purchase shape)');
  ok(r.refi.payoff === 250000, 'and the payoff the owner asked to see is on the quote');
}

console.log('\n8. Nothing was removed from the page');
{
  // The owner: "Don't remove any information." Every label the old layout showed
  // must still be rendered somewhere in the new one.
  const ui = read('../app-v2/src/components/ProductStudioPanel.jsx');
  const kept = ['Total loan amount', 'Note rate (interest-only)', 'Initial advance (at closing)',
    'Down payment (equity)', 'Payment — initial advance', 'Payment — fully drawn',
    'Loan-to-cost (LTC)', 'Initial / as-is LTV', 'Loan-to-ARV', 'Selected leverage (LTC target)',
    'Binding limit', 'Program max — as-is', 'UW / processing / legal', 'Credit report',
    'Title / escrow (est.)', 'Estimated cash to close', 'Reserve to show', 'Closing cost buffer',
    'Strategy / purpose', 'Purchase price', 'Seller price / assignment fee', 'As-is value / ARV',
    'Rehab budget', 'Rehab scope', 'FICO / experience', 'Requested interest reserve',
    'Admin pricing', 'Guaranty / recourse', 'Interest accrual', '3-month minimum interest',
    'Estimated closing date', 'First payment date (est.)', 'Maturity date (est.)'];
  const missing = kept.filter((k) => ui.indexOf(k) < 0);
  ok(!missing.length, `every row the old layout showed is still there${missing.length ? ' — MISSING: ' + missing.join(', ') : ''}`);
  // And the figures the owner named by name are now on it.
  const added = ['Program buy rate', 'YS markup', 'Total closing costs due at closing',
    'Total closing costs including the appraisal', 'Total liquidity to verify',
    'Payoff of the existing loan', 'Rehab out of pocket', 'Total project cost (the LTC basis)',
    'Cash out to the borrower', 'Construction holdback'];
  const absent = added.filter((k) => ui.indexOf(k) < 0);
  ok(!absent.length, `every figure the owner asked for is on the page${absent.length ? ' — ABSENT: ' + absent.join(', ') : ''}`);
}

console.log(fails ? `\n✗ ${fails} assertion(s) failed\n` : '\n✓ rate build-up + structure output: all assertions passed\n');
process.exit(fails ? 1 : 0);
