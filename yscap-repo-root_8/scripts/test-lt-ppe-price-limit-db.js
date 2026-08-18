#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE RATE SHEET'S OWN MAX-PRICE RULE reaches a priced quote (A4).
 *
 * WHAT THIS PROVES, and it is a MEASUREMENT rather than an assertion. The Deephaven DSCR
 * correspondent sheet states its ceiling in TWO axes and combines them itself (cell B48:
 * "Max Price is the lower of Max Price Tiers and Prepay Buydown, when applicable"). Only the
 * loan-amount half could ever reach a quote — it is the half that fits in a stored tier list —
 * and `deephaven-dscr-prepay-maxprice.programWithPriceLimit`, the function that combines the
 * two, had NO production caller at all.
 *
 * The DB section reproduces that gap inside this suite (§D4 is the CONTROL: the same stored
 * sheet, priced with the rule stripped off, quoting a full point high) and then proves the
 * wired path closes it. So the numbers below are re-measured on every run against a real
 * Postgres, a real store, the real mapper and the real `loadProgram`, not quoted from a comment.
 *
 *   node scripts/test-lt-ppe-price-limit-db.js
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-price-limit-db.js
 *
 * LT-only. No RTL imports.
 */
const fs = require('fs');
const path = require('path');

const PL = require('../src/longterm/ppe/price-limit');
const { quoteProgram } = require('../src/longterm/ppe/quote');
const MAXPRICE = require('../src/longterm/ppe/deephaven-dscr-prepay-maxprice');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures += 1; }
const sentence = (s) => typeof s === 'string' && s.length > 20;

// A minimal program the façade will price: one rung, no rules.
function prog(priceLimit, extra) {
  return {
    code: 'T', name: 'T', rules: [],
    baseGrid: [{ rate: 70000, lockDays: null, product: '', basePriceMilli: 105000 }],
    priceLimit,
    ...(extra || {}),
  };
}
const SETTINGS = { 'pricing.correspondent_margin_milli': 0, 'pricing.rounding_mode': 'none', 'pricing.price_floor_milli': null };

console.log('LT PPE price limit — the sheet\'s own MAX-PRICE rule (pure)\n');

// ---------------------------------------------------------------------------
// P1. resolvePriceCap tells apart every state the old lookup answered `null` for
// ---------------------------------------------------------------------------
{
  const S = PL.CAP_STATUS;
  const TIERS = [{ uptoLoanAmount: 1500000, capMilli: 104750 }, { uptoLoanAmount: 2500000, capMilli: 103250 }];

  const noLimit = PL.resolvePriceCap(undefined, 500000);
  ok(noLimit.status === S.NO_LIMIT && noLimit.capMilli === null && noLimit.readable === true,
    'a program with NO price limit at all → no cap, status no_price_limit_on_sheet');
  ok(sentence(noLimit.detail), '…and it SAYS so in a plain sentence, never a silent null');

  const noTiers = PL.resolvePriceCap({ capTiers: [] }, 500000);
  ok(noTiers.status === S.NO_TIERS && noTiers.capMilli === null,
    'a price limit that states no cap tiers → no cap, status no_cap_tiers_on_sheet');
  ok(sentence(noTiers.detail), '…and it SAYS so');

  const inTier = PL.resolvePriceCap({ capTiers: TIERS }, 900000);
  ok(inTier.status === S.TIER && inTier.capMilli === 104750 && inTier.capApplied === true,
    'a loan inside a tier gets THAT tier\'s ceiling');
  ok(inTier.assumption === null, '…with no assumption recorded — the sheet answered directly');

  const above = PL.resolvePriceCap({ capTiers: TIERS }, 9000000);
  ok(above.status === S.ABOVE_ALL_TIERS && above.capMilli === 103250 && above.capApplied === true,
    'a loan ABOVE every tier falls CLOSED onto the strictest ceiling on the sheet — never uncapped');
  ok(above.assumption === 'tightest_cap_on_sheet' && sentence(above.detail),
    '…and the assumption is NAMED on the result, not buried');

  const noAmt = PL.resolvePriceCap({ capTiers: TIERS }, null);
  ok(noAmt.status === S.LOAN_AMOUNT_UNKNOWN && noAmt.capMilli === 103250,
    'a scenario with no loan amount falls CLOSED onto the strictest ceiling — never uncapped');

  const partly = PL.resolvePriceCap({ capTiers: [TIERS[0], { uptoLoanAmount: 'lots', capMilli: 1 }] }, 900000);
  ok(partly.status === S.UNREADABLE_TIER && partly.capMilli === 104750 && partly.tiersReadable === 1,
    'one unreadable tier makes the tier CHOICE untrustworthy → the strictest readable ceiling applies');

  const bad = PL.resolvePriceCap({ capTiers: [{ uptoLoanAmount: 'lots', capMilli: 'high' }] }, 900000);
  ok(bad.status === S.UNREADABLE && bad.readable === false && bad.capMilli === null,
    'a ceiling NO tier of which can be read is reported UNREADABLE — the fail-closed state');
  ok(sentence(bad.detail) && /nothing was priced/i.test(bad.detail),
    '…and its sentence says nothing was priced, which is what the façade then does');

  // A non-integer milli would throw inside pricing.assertMilli; it must be refused HERE instead.
  const frac = PL.resolvePriceCap({ capTiers: [{ uptoLoanAmount: 1500000, capMilli: 104750.5 }] }, 900000);
  ok(frac.status === S.UNREADABLE, 'a non-integer milli ceiling is refused here, not deep inside the pricer');
}

// ---------------------------------------------------------------------------
// P2. applyScenarioPriceLimit — three states, and a failed rule FAILS CLOSED
// ---------------------------------------------------------------------------
{
  const bare = PL.applyScenarioPriceLimit(prog({ capTiers: [] }), { loan_amount: 1 });
  ok(bare.rule === PL.RULE.SHEET_TIERS_ONLY && bare.usable === true,
    'a program with no per-scenario rule prices on its stored tiers — a real answer, not a failure');
  ok(sentence(bare.detail), '…and SAYS that only the stored tiers applied');

  const thrower = prog({ capTiers: [{ uptoLoanAmount: 9e9, capMilli: 104750 }] }, {
    scenarioPriceLimit: () => { throw new Error('sheet module unavailable'); },
    priceLimitSheet: 'a sheet',
  });
  const failed = PL.applyScenarioPriceLimit(thrower, { loan_amount: 1 });
  ok(failed.usable === false && failed.rule === PL.RULE.UNAVAILABLE && failed.reason === 'scenario_rule_failed',
    'a registered rule that THROWS is unusable — it is never downgraded to the stored tiers');
  ok(/HIGHER ceiling/.test(failed.detail || ''),
    '…and the reason says WHY that downgrade would be wrong: the stored tiers are the higher ceiling');

  const junk = PL.applyScenarioPriceLimit(prog({ capTiers: [] }, { scenarioPriceLimit: () => 42 }), {});
  ok(junk.usable === false, 'a registered rule that returns nothing usable is unusable, never trusted');

  const good = PL.applyScenarioPriceLimit(
    prog({ capTiers: [] }, { scenarioPriceLimit: (p, s) => ({ ...p, priceLimit: { capTiers: [{ uptoLoanAmount: s.loan_amount, capMilli: 103750 }] } }) }),
    { loan_amount: 1000000 });
  ok(good.rule === PL.RULE.SCENARIO && good.program.priceLimit.capTiers[0].capMilli === 103750,
    'a registered rule that answers governs the program handed to the pricer');
}

// ---------------------------------------------------------------------------
// P3. The registry resolves the sheet's OWN function — no second copy of a ceiling
// ---------------------------------------------------------------------------
{
  for (const k of ['Deephaven', 'deephaven', 'Deephaven Mortgage', 'DEEPHAVEN-DSCR']) {
    const r = PL.scenarioRuleFor(k);
    ok(r && r.resolve === MAXPRICE.programWithPriceLimit,
      `investor "${k}" resolves to the SHEET's own programWithPriceLimit, not a copy`);
  }
  ok(PL.scenarioRuleFor('Some Other Investor') === null, 'an unregistered investor resolves to no rule');
  ok(PL.scenarioRuleFor(null) === null && PL.scenarioRuleFor('') === null, 'a blank investor resolves to no rule');
}

// ---------------------------------------------------------------------------
// P4. The façade FAILS CLOSED, and reports the limit on every branch
// ---------------------------------------------------------------------------
{
  const q1 = quoteProgram({
    scenario: { loan_amount: 900000 },
    program: prog({ capTiers: [{ uptoLoanAmount: 'lots', capMilli: 'high' }] }),
    settings: SETTINGS,
  });
  ok(q1.eligible === false && ((q1.declines || [])[0] || {}).code === 'price_limit_unreadable',
    'quoteProgram REFUSES to price a sheet whose ceiling cannot be read');
  ok(q1.priceLimit && q1.priceLimit.status === PL.CAP_STATUS.UNREADABLE,
    '…and the refusal carries the price-limit state that caused it');

  const q2 = quoteProgram({
    scenario: { loan_amount: 900000 },
    program: prog({ capTiers: [] }, { scenarioPriceLimit: () => { throw new Error('boom'); } }),
    settings: SETTINGS,
  });
  ok(q2.eligible === false && ((q2.declines || [])[0] || {}).code === 'price_limit_unreadable' && q2.priceLimit.rule === PL.RULE.UNAVAILABLE,
    'quoteProgram REFUSES when a registered max-price rule cannot be evaluated — it never prices on the weaker cap');

  // An INELIGIBLE quote still says what the ceiling was: that is a fact about the program.
  const q3 = quoteProgram({
    scenario: { loan_amount: 900000, fico: 500 },
    program: prog({ capTiers: [{ uptoLoanAmount: 1500000, capMilli: 104750 }] }, {
      rules: [{ code: 'lowfico', kind: 'eligibility', when: { fact: 'fico', op: 'lt', value: 660 }, declineReason: 'FICO too low' }],
    }),
    settings: SETTINGS,
  });
  ok(q3.eligible === false && q3.priceLimit && q3.priceLimit.status === PL.CAP_STATUS.TIER,
    'an ineligible quote STILL reports the sheet\'s ceiling — it is a fact about the program, not the borrower');

  const q4 = quoteProgram({
    scenario: { loan_amount: 900000 },
    program: prog({ capTiers: [{ uptoLoanAmount: 1500000, capMilli: 103750 }] }),
    settings: SETTINGS,
  });
  ok(q4.eligible === true && q4.ladder[0].finalPriceMilli === 103750,
    'a priced rung is CLAMPED to the sheet\'s ceiling (base 105.000 → 103.750)');
  ok(q4.pricingBasis.capRule === PL.RULE.SHEET_TIERS_ONLY && q4.pricingBasis.capStatus === PL.CAP_STATUS.TIER,
    '…and the reconstruction record names WHICH rule governed the ceiling');

  const notice = PL.priceLimitNotice(q4.priceLimit);
  ok(sentence(notice) && /stored with it|no per-scenario/i.test(notice),
    'priceLimitNotice tells the caller that only the stored tiers applied');
}

// ---------------------------------------------------------------------------
// P5. A resolved ceiling with NO loan amount is still a ceiling
// ---------------------------------------------------------------------------
{
  // The sheet publishes a 3-Year prepay ceiling of 104.000; with no loan amount the loan-amount
  // axis simply does not apply, and "the lower of the two, WHEN APPLICABLE" is still 104.000.
  const combined = MAXPRICE.priceLimitFor({ prepay_months: 36 });
  ok(combined.capMilli === 103750,
    'the sheet resolves a 3-Year prepay ceiling of 103750 (104.000 less the 0.250 holdback) with no loan amount');
  const p = MAXPRICE.programWithPriceLimit(prog({}), { prepay_months: 36 });
  ok(Array.isArray(p.priceLimit.capTiers) && p.priceLimit.capTiers.length === 1 && p.priceLimit.capTiers[0].capMilli === 103750,
    '…and programWithPriceLimit PUBLISHES it rather than dropping it for want of a loan amount');
  const q = quoteProgram({ scenario: { prepay_months: 36 }, program: p, settings: SETTINGS });
  ok(q.eligible === true && q.ladder[0].finalPriceMilli === 103750,
    '…so a scenario with no loan amount is still CAPPED at the sheet\'s ceiling, never priced free');
}

// ---------------------------------------------------------------------------
// P6. capForLoanAmount stays the RAW tier lookup (its callers depend on that)
// ---------------------------------------------------------------------------
{
  const tiers = [{ uptoLoanAmount: 1000000, capMilli: 103000 }, { uptoLoanAmount: 2000000, capMilli: 102000 }];
  ok(PL.capForLoanAmount(tiers, 500000) === 103000, 'capForLoanAmount: a small loan gets the first tier');
  ok(PL.capForLoanAmount(tiers, 1500000) === 102000, 'capForLoanAmount: a mid loan falls into the second tier');
  ok(PL.capForLoanAmount(tiers, 3000000) === null, 'capForLoanAmount answers only "no tier covers this loan" — resolvePriceCap decides what that means');
  ok(PL.capForLoanAmount(null, 500000) === null, 'capForLoanAmount: no tiers → no tier');
}

// ---------------------------------------------------------------------------
// P7. THE ANSWER THE CALLER GETS carries it — the façade passes it through
// ---------------------------------------------------------------------------
{
  // In shadow mode Lender Price is the business answer, so OUR quote object never reaches the
  // caller. Without this passthrough a skipped ceiling would be invisible to everyone.
  const facade = require('../src/longterm/ppe/facade');
  const program = prog({ capTiers: [{ uptoLoanAmount: 1500000, capMilli: 103750 }] });
  let result = null;
  const run = facade.priceWithShadow(
    { scenario: { loan_amount: 900000 }, investor: 'X', program },
    {
      mode: () => 'shadow',
      priceLp: async () => ({ rungs: [] }),
      ourQuote: (sc) => quoteProgram({ scenario: sc, program, settings: SETTINGS }),
      recordFinding: () => {},
      nowMs: 0,
    },
    {},
  );
  run.then((r) => { result = r; }).catch(() => {});
  // priceWithShadow is async; drain the microtask queue before asserting.
  setTimeout(() => {
    ok(result && result.shadow && result.shadow.priceLimit && result.shadow.priceLimit.status === PL.CAP_STATUS.TIER,
      'the façade carries the price-limit state out of the shadow block into the caller\'s answer');
    ok(!!(result && result.shadow && result.shadow.priceLimit && result.shadow.priceLimit.rule === PL.RULE.SHEET_TIERS_ONLY),
      '…naming which max-price rule governed, so a skipped ceiling can never be invisible');

    // The /quote route must SURFACE it rather than leave it buried in `shadow`.
    const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'routes', 'ppe.js'), 'utf8');
    ok(/priceLimit: capRes/.test(routeSrc) && /quote\.priceLimitNotice\(capRes\)/.test(routeSrc),
      'POST /quote puts the price-limit block and its plain-language notice on the response itself');
    ok(/priceLimitLib\.scenarioRuleFor\(investorName\)/.test(routeSrc) && /program\.scenarioPriceLimit = scenarioRule\.resolve/.test(routeSrc),
      'loadProgram — the one door that turns a stored sheet into a priced program — attaches the sheet\'s own rule');

    finish();
  }, 0);
}

function finish() {
if (!process.env.DATABASE_URL) {
  console.log('\n(DB section skipped — set DATABASE_URL to run it.)');
  console.log(`\n${failures ? failures + ' FAILED' : 'all passed (pure)'}`);
  process.exit(failures ? 1 : 0);
}

// ---------------------------------------------------------------------------
// THE DB SECTION — the real sheet, the real store, the real loadProgram
// ---------------------------------------------------------------------------
(async () => {
  console.log('\nLT PPE price limit — the real Deephaven sheet, stored and priced\n');
  const store = require('../src/longterm/ppe/store');
  const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');
  const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
  const routeInternals = require('../src/longterm/routes/ppe')._internals;
  const db = require('../src/longterm/db');

  for (const f of ['558_lt_ppe_foundation.sql', '560_lt_ppe_ratesheet.sql']) {
    await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8'));
  }

  const scope = 'test_pl_' + Math.abs(process.pid || 1);
  const cleanup = async () => {
    await db.query('DELETE FROM lt_ppe_program WHERE scope = $1', [scope]);
    await db.query('DELETE FROM lt_ppe_investor WHERE scope = $1', [scope]);
  };
  await cleanup();

  // The scenario the defect was measured on: $1,000,000, 3-YEAR prepay.
  //   loan-amount tier (≤$1.5MM) → 105.000  → 104750 after the 0.250 holdback
  //   3-Year prepay ceiling      → 104.000  → 103750 after the same holdback
  // The sheet's own rule takes the LOWER: 103750.
  const SCENARIO = { loan_amount: 1000000, prepay_months: 36, fico: 780, ltv: 60000, dscr: 1300 };
  const TIER_ONLY_CAP = 104750;
  const SHEET_RULE_CAP = 103750;

  async function seed(investorName) {
    const inv = await store.createInvestor(db, scope, { code: 'I' + Math.random().toString(36).slice(2, 7), name: investorName });
    const program = await store.createProgram(db, scope, { investorId: inv.id, code: 'DSCR30', name: 'DSCR 30yr' });
    const ver = await store.createRateSheetVersion(db, scope, { programId: program.id, versionNo: 1, channel: 'correspondent' });
    const sheet = gridToRateSheet(MAXPRICE.buildPrepayMaxPriceGrid());
    await store.replaceBasePrices(db, scope, ver.id, sheet.basePrices.map((b) => ({
      noteRateMilliPct: b.note_rate_milli_pct, lockDays: b.lock_days, product: b.product || '', priceMilli: b.price_milli,
    })));
    await store.replaceAdjustments(db, scope, ver.id, sheet.adjustments.map((a) => ({
      code: a.code, dimension: a.dimension, ficoMin: a.fico_min, ficoMax: a.fico_max, ltvMin: a.ltv_min, ltvMax: a.ltv_max,
      dscrMin: a.dscr_min, dscrMax: a.dscr_max, predicate: a.predicate, adjMilli: a.adj_milli, unit: a.unit,
      priority: a.priority, reason: a.reason,
    })));
    await store.setPriceLimit(db, scope, ver.id, {
      minPriceMilli: sheet.priceLimit.min_price_milli,
      roundingMode: sheet.priceLimit.rounding_mode || 'none',
      roundingIncrementMilli: sheet.priceLimit.rounding_increment_milli == null ? 0 : sheet.priceLimit.rounding_increment_milli,
      capTiers: sheet.priceLimit.cap_tiers,
    });
    return ver.id;
  }

  const topPrice = (q) => (q.ladder || []).reduce((m, r) => (r.finalPriceMilli > m ? r.finalPriceMilli : m), -Infinity);

  try {
    // ---- D1. what the SHEET says, read from the sheet's own tables -------------------
    const combined = MAXPRICE.priceLimitFor(SCENARIO);
    ok(combined.loanAmountMaxPrice === 105 && combined.prepayMaxPrice === 104,
      `the sheet publishes TWO ceilings for this scenario: loan-amount 105.000 and 3-Year prepay 104.000`);
    ok(combined.capMilli === SHEET_RULE_CAP && combined.capSource === 'prepay',
      `its own "lower of the two" rule resolves to ${SHEET_RULE_CAP} (the prepay ceiling)`);

    // ---- D2. what the STORED sheet can hold -----------------------------------------
    const versionId = await seed('Deephaven Mortgage');
    const stored = await store.loadRateSheet(db, versionId);
    const storedCaps = (stored.priceLimit.cap_tiers || []).map((t) => t.capMilli);
    ok(storedCaps.includes(TIER_ONLY_CAP) && !storedCaps.includes(SHEET_RULE_CAP),
      `lt_ppe_price_limit.cap_tiers can only hold the LOAN-AMOUNT axis (${storedCaps.join('/')}) — the prepay ceiling is not in it`);

    // ---- D3. THE CONTROL: the defect, reproduced ------------------------------------
    const bare = rateSheetToProgram(stored, { code: 'DHVN_DSCR30', investorCode: 'DHVN' });
    const asBuilt = quoteProgram({ scenario: SCENARIO, program: bare, settings: SETTINGS });
    ok(asBuilt.eligible === true && asBuilt.pricingBasis.capMilli === TIER_ONLY_CAP,
      `CONTROL — with the sheet's rule NOT applied the ceiling is ${TIER_ONLY_CAP} (the loan-amount tier alone)`);
    ok(topPrice(asBuilt) === TIER_ONLY_CAP,
      `CONTROL — and the top coupons quote ${TIER_ONLY_CAP}, a full point above what the sheet allows`);
    ok(asBuilt.pricingBasis.capRule === PL.RULE.SHEET_TIERS_ONLY,
      'CONTROL — and the quote SAYS only the stored tiers applied (it never claims the full rule ran)');

    // ---- D4. THE FIX: through the real loadProgram -----------------------------------
    const loaded = await routeInternals.loadProgram(scope, versionId);
    ok(loaded.program && !loaded.reason, 'loadProgram loads the stored Deephaven sheet');
    ok(loaded.priceLimitRule && loaded.priceLimitRule.rule === PL.RULE.SCENARIO,
      'loadProgram REPORTS that this sheet carries a per-scenario max-price rule');
    ok(typeof loaded.program.scenarioPriceLimit === 'function',
      '…and attaches that rule to the program it hands on');
    ok(loaded.program.scenarioPriceLimit === MAXPRICE.programWithPriceLimit,
      '…the sheet\'s OWN function, so there is no second definition of any ceiling');

    const wired = quoteProgram({ scenario: SCENARIO, program: loaded.program, settings: SETTINGS });
    ok(wired.eligible === true && wired.pricingBasis.capMilli === SHEET_RULE_CAP,
      `FIX — the priced ceiling is now ${SHEET_RULE_CAP}: the sheet's own "lower of the two"`);
    ok(topPrice(wired) === SHEET_RULE_CAP,
      `FIX — no coupon quotes above ${SHEET_RULE_CAP} any more`);
    ok(topPrice(asBuilt) - topPrice(wired) === 1000,
      'FIX — the difference the defect was worth is exactly ONE POINT (1000 milli) on this loan');
    ok(wired.pricingBasis.capRule === PL.RULE.SCENARIO && wired.priceLimit.ruleSheet,
      'FIX — and the quote names the rule and the sheet that governed it');

    // The prepay term is what moves it: a 5-YEAR prepay's ceiling is 105.000, so the
    // loan-amount tier binds and the price is the same as before. The rule is applied, not
    // a blanket reduction.
    const fiveYear = quoteProgram({ scenario: { ...SCENARIO, prepay_months: 60 }, program: loaded.program, settings: SETTINGS });
    ok(fiveYear.pricingBasis.capMilli === TIER_ONLY_CAP && topPrice(fiveYear) === TIER_ONLY_CAP,
      `a 5-YEAR prepay on the same loan is still ${TIER_ONLY_CAP} — the rule LOWERS a price only where the sheet does`);

    // ---- D5. an investor with no registered rule is an honest, reported state --------
    const otherVersion = await seed('Some Other Investor');
    const otherLoaded = await routeInternals.loadProgram(scope, otherVersion);
    ok(otherLoaded.priceLimitRule.rule === PL.RULE.SHEET_TIERS_ONLY && otherLoaded.priceLimitRule.reason === 'no_scenario_rule_registered',
      'an investor with no registered rule is REPORTED as stored-tiers-only, with the reason');
    const otherQuote = quoteProgram({ scenario: SCENARIO, program: otherLoaded.program, settings: SETTINGS });
    ok(otherQuote.pricingBasis.capRule === PL.RULE.SHEET_TIERS_ONLY && sentence(PL.priceLimitNotice(otherQuote.priceLimit)),
      '…and its quote carries a plain sentence saying only the stored tiers applied — never silence');

    // ---- D6. a stored sheet whose ceiling cannot be read refuses to price ------------
    await db.query(
      `UPDATE lt_ppe_price_limit SET cap_tiers = '[{"uptoLoanAmount":"lots","capMilli":"high"}]'::jsonb WHERE version_id = $1`,
      [otherVersion]);
    const brokenLoaded = await routeInternals.loadProgram(scope, otherVersion);
    const brokenQuote = quoteProgram({ scenario: SCENARIO, program: brokenLoaded.program, settings: SETTINGS });
    const brokenDecline = (brokenQuote.declines || [])[0] || {};
    ok(brokenQuote.eligible === false && brokenDecline.code === 'price_limit_unreadable',
      'a STORED sheet whose ceiling cannot be read refuses to price, end to end');
    ok(/nothing was priced/i.test(brokenDecline.reason || ''),
      '…and says so in the answer, rather than quoting uncapped');
  } finally {
    await cleanup();
    await db.pool.end();
  }

  console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
}
