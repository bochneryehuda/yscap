'use strict';
/**
 * LT PPE — THE RATE SHEET'S OWN MAX-PRICE RULE, resolved in ONE place.
 *
 * WHAT WAS WRONG (measured on a real database before this module existed, not assumed).
 * The Deephaven DSCR correspondent sheet states its ceiling in TWO axes and combines them itself
 * (`SHEET_MAX_PRICE_RULE`, cell B48): *"Max Price is the lower of Max Price Tiers and Prepay Buydown,
 * when applicable."* Only ONE of those axes ever reached a priced quote:
 *
 *   · `deephaven-dscr-prepay-maxprice.buildPrepayMaxPriceGrid()` puts the LOAN-AMOUNT tiers on the grid,
 *     `deephaven-grid.gridToRateSheet` stores them in `lt_ppe_price_limit.cap_tiers`, and
 *     `ratesheet.rateSheetToProgram` carries them onto the program. That axis works.
 *   · the PREPAY-TERM ceiling depends on a SCENARIO fact (`prepay_months`), so it cannot live in a
 *     stored tier list at all. `programWithPriceLimit` is the function that combines the two — and it
 *     had NO production caller. Not one. It was built, exported and unit-tested, and every quote,
 *     canary and agreement run priced without it.
 *
 * THE MEASUREMENT, on a $1,000,000 loan with a 3-YEAR prepay, through the real store → the real mapper
 * → the real quote façade: the stored sheet capped at **104750** (the ≤$1.5MM loan-amount tier, 105.000
 * less our 0.250 holdback) while the sheet's own combined rule caps at **103750** (the 3-Year prepay
 * ceiling, 104.000 less the same holdback). Coupons 7.125 / 7.250 / 7.375 / 7.500 all quoted **104750
 * against a sheet that forbids anything above 103750 — a FULL POINT**, on four rungs of one ladder, with
 * nothing anywhere in the answer saying a ceiling had been skipped.
 *
 * SO THIS MODULE IS THE ONE DOOR, AND IT HAS TWO HALVES:
 *   1. `scenarioRuleFor(investor)` — which investor's sheet carries a per-scenario max-price rule, and
 *      the function that evaluates it. It DELEGATES to that sheet's own module; there is no second copy
 *      of any ceiling, tier or combining rule here.
 *   2. `resolvePriceCap(priceLimit, loanAmount)` — the stored tier list → the number the pricer clamps
 *      with, ALWAYS saying which of several very different situations it is in. The old lookup answered
 *      a bare `null` — i.e. "no ceiling" — for "the loan is above every tier", "the scenario has no loan
 *      amount" and "the tiers are unreadable" alike, and `quoteProgram` could not tell them apart.
 *
 * FAIL CLOSED WHERE A CAP CANNOT BE READ, AND SAY SO EITHER WAY. A registered rule that THROWS does not
 * quietly fall back to the stored tiers (that is the too-high cap this module exists to stop) — the quote
 * is refused. Tiers that cannot be read refuse too. Everything else is REPORTED: every quote carries a
 * `priceLimit` block naming the rule that governed it, and `priceLimitNotice()` is the one wording a
 * caller shows beside an answer.
 *
 * ⚠ OPEN QUESTION FOR THE OWNER, recorded rather than guessed (see UNMEASURED at the foot of this file).
 *
 * PURE: no DB, no network, no clock. LT-only. No RTL imports.
 */

// ---------------------------------------------------------------------------
// 1. WHICH SHEETS CARRY A PER-SCENARIO MAX-PRICE RULE
// ---------------------------------------------------------------------------
//
// Keyed on the normalized investor token, the SAME normalization `program-registry` uses, so one
// investor keys identically wherever the PPE asks about them. `resolve` is the sheet module's OWN
// function — never a re-implementation, and never a copy of a ceiling. Adding an investor is one entry
// here plus that investor's own module; nothing in the pricing pipeline changes.
//
// The require is LAZY: a sheet module pulls in the whole published grid, and nothing that merely wants
// `resolvePriceCap` should pay for it (and the direction of the dependency stays obvious and cycle-proof
// — the same discipline `ratesheet.js` applies to `quote.js`).
const SCENARIO_RULES = [
  {
    aliases: ['deephaven', 'deephavendscr', 'deephavenmortgage'],
    sheet: 'Deephaven DSCR correspondent — max price is the lower of the loan-amount tier and the prepay-term ceiling',
    load: () => require('./deephaven-dscr-prepay-maxprice').programWithPriceLimit,
  },
];

const normKey = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');

const BY_KEY = new Map();
for (const r of SCENARIO_RULES) for (const a of r.aliases) BY_KEY.set(normKey(a), r);

/**
 * The per-scenario max-price rule registered for an investor, or null.
 * Returns { resolve(program, scenario, opts) -> program, sheet } — `resolve` is the sheet's own function.
 * Never throws: an unknown investor, a blank one and a module that fails to load all answer null, and
 * the caller then REPORTS that only the stored tiers applied (it never silently reads as "capped").
 */
function scenarioRuleFor(investor) {
  const reg = BY_KEY.get(normKey(investor));
  if (!reg) return null;
  try {
    const resolve = reg.load();
    return typeof resolve === 'function' ? { resolve, sheet: reg.sheet } : null;
  } catch (_) {
    return null;
  }
}

/** Every investor whose sheet carries a per-scenario rule — for an admin listing / a test. */
function listScenarioRules() {
  return SCENARIO_RULES.map((r) => ({ aliases: r.aliases.slice(), sheet: r.sheet }));
}

// ---------------------------------------------------------------------------
// 2. RUNNING THAT RULE FOR ONE SCENARIO
// ---------------------------------------------------------------------------

const RULE = {
  SCENARIO: 'scenario',            // the sheet's own per-scenario rule governed this quote
  SHEET_TIERS_ONLY: 'sheet_tiers_only', // only the stored tier list applied (no per-scenario rule)
  UNAVAILABLE: 'unavailable',      // a rule IS registered and could not be evaluated — FAIL CLOSED
};

/**
 * Apply the program's own per-scenario max-price rule, if it carries one.
 *
 * `program.scenarioPriceLimit` is set by the ONE door that turns a stored sheet into a priced program
 * (`routes/ppe.loadProgram`), from `scenarioRuleFor(<the sheet's investor>)`. A program that carries none
 * is priced on its stored tiers alone — which is CORRECT for every sheet that states its ceiling purely
 * by loan amount, and which is REPORTED so it can never read as "the whole rule was applied".
 *
 * Returns { program, rule, sheet, usable, reason, detail }. NEVER throws.
 */
function applyScenarioPriceLimit(program, scenario, opts) {
  const p = program || {};
  const fn = p.scenarioPriceLimit;
  if (typeof fn !== 'function') {
    return {
      program: p,
      rule: RULE.SHEET_TIERS_ONLY,
      sheet: p.priceLimitSheet || null,
      usable: true,
      reason: p.priceLimitRuleReason || 'no_scenario_rule_registered',
      detail: 'This sheet states no per-scenario maximum-price rule, so only the price tiers stored with it were applied.',
    };
  }
  let out;
  try {
    out = fn(p, scenario || {}, opts);
  } catch (e) {
    return failClosed(p, p.priceLimitSheet, `this sheet's own maximum-price rule could not be evaluated (${String((e && e.message) || e).slice(0, 120)})`);
  }
  if (!out || typeof out !== 'object' || !out.priceLimit || typeof out.priceLimit !== 'object') {
    return failClosed(p, p.priceLimitSheet, "this sheet's own maximum-price rule returned nothing usable");
  }
  return {
    program: out,
    rule: RULE.SCENARIO,
    sheet: p.priceLimitSheet || null,
    usable: true,
    reason: null,
    detail: null,
  };
}

// A registered rule that cannot be evaluated is NOT quietly downgraded to the stored tiers — those are
// the HIGHER (less restrictive) ceiling, which is exactly the over-quote this module exists to prevent.
function failClosed(program, sheet, why) {
  return {
    program,
    rule: RULE.UNAVAILABLE,
    sheet: sheet || null,
    usable: false,
    reason: 'scenario_rule_failed',
    detail: `Nothing was priced: ${why}, and the price tiers stored with the sheet are a HIGHER ceiling than its full rule, so quoting on them would price above what the sheet allows.`,
  };
}

// ---------------------------------------------------------------------------
// 3. THE STORED TIER LIST → THE NUMBER THE PRICER CLAMPS WITH
// ---------------------------------------------------------------------------

const CAP_STATUS = {
  NO_LIMIT: 'no_price_limit_on_sheet',
  NO_TIERS: 'no_cap_tiers_on_sheet',
  TIER: 'tier',
  ABOVE_ALL_TIERS: 'above_all_tiers',
  LOAN_AMOUNT_UNKNOWN: 'loan_amount_unknown',
  UNREADABLE_TIER: 'unreadable_tier',
  UNREADABLE: 'unreadable',
};

// A tier is READABLE only when both halves are usable: a finite threshold a loan can be compared
// against, and an INTEGER milli price — `pricing.assertMilli` refuses anything else outright, so a
// half-read tier would throw deep inside the pricer instead of being reported here.
function readTier(t) {
  if (!t || typeof t !== 'object') return null;
  const upto = Number(t.uptoLoanAmount);
  const cap = Number(t.capMilli);
  if (!Number.isFinite(upto) || !Number.isInteger(cap)) return null;
  return { uptoLoanAmount: upto, capMilli: cap };
}

/**
 * The RAW tier lookup: which tier covers this loan amount? A tier {uptoLoanAmount, capMilli} caps loans
 * AT OR BELOW uptoLoanAmount and the first the amount fits under wins (the tiers are ascending).
 *
 * `null` here means ONLY "no tier covers this loan" — it does NOT mean "uncapped". Deciding what to do
 * about that is `resolvePriceCap`'s job and nothing else should call this.
 */
function capForLoanAmount(capTiers, loanAmount) {
  if (!Array.isArray(capTiers) || !capTiers.length || loanAmount == null) return null;
  const tiers = capTiers.map(readTier).filter(Boolean);
  if (!tiers.length) return null;
  const sorted = tiers.slice().sort((a, b) => a.uptoLoanAmount - b.uptoLoanAmount);
  for (const t of sorted) if (loanAmount <= t.uptoLoanAmount) return t.capMilli;
  return null; // no tier covers this loan — see resolvePriceCap
}

/**
 * Resolve a program's price limit for ONE loan amount. NEVER throws.
 *
 * Returns { capMilli, capApplied, readable, status, assumption, detail, tiersDeclared, tiersReadable,
 *           tightestCapMilli } — `detail` is the plain sentence a caller shows, so an absent ceiling can
 * never read as a silent "no cap".
 *
 * ⚠ THE SAFE DIRECTION, AND THE QUESTION IT LEAVES OPEN. Where a sheet plainly HAS a ceiling but the
 * tier for this loan cannot be selected — the loan sits above every tier, or the scenario carries no
 * readable loan amount, or a tier is malformed — this falls closed onto the TIGHTEST (lowest) readable
 * ceiling on that sheet rather than letting the price run free. That can only ever LOWER a price we
 * quote, never raise one. It is NOT a rule any sheet states: see UNMEASURED.
 */
function resolvePriceCap(priceLimit, loanAmount) {
  const base = {
    capMilli: null, capApplied: false, readable: true, assumption: null,
    tiersDeclared: 0, tiersReadable: 0, tightestCapMilli: null,
  };
  if (!priceLimit || typeof priceLimit !== 'object') {
    return { ...base, status: CAP_STATUS.NO_LIMIT, detail: 'This rate sheet carries no price limit at all, so no maximum price was applied to this quote.' };
  }
  const declared = Array.isArray(priceLimit.capTiers) ? priceLimit.capTiers : [];
  const readable = declared.map(readTier).filter(Boolean);
  const counts = { tiersDeclared: declared.length, tiersReadable: readable.length };

  if (!declared.length) {
    return { ...base, ...counts, status: CAP_STATUS.NO_TIERS, detail: 'This rate sheet states no maximum-price tier for this scenario, so no ceiling was applied to this quote.' };
  }
  if (!readable.length) {
    // FAIL CLOSED. The sheet plainly HAS a ceiling and not one tier of it can be read, so we will not
    // put a price on it at all.
    return {
      ...base, ...counts, readable: false, status: CAP_STATUS.UNREADABLE,
      detail: `This rate sheet lists ${declared.length} maximum-price tier(s) and not one of them could be read, so its ceiling is unknown and nothing was priced.`,
    };
  }

  const tightest = readable.reduce((m, t) => (t.capMilli < m ? t.capMilli : m), Infinity);
  const closed = (status, detail) => ({
    ...base, ...counts, capMilli: tightest, capApplied: true, tightestCapMilli: tightest,
    status, assumption: 'tightest_cap_on_sheet', detail,
  });

  if (readable.length !== declared.length) {
    return closed(CAP_STATUS.UNREADABLE_TIER,
      `${declared.length - readable.length} of this sheet's ${declared.length} maximum-price tiers could not be read, so the tier for this loan cannot be trusted; the strictest readable ceiling on the sheet (${tightest}) was applied instead.`);
  }

  const amt = Number(loanAmount);
  if (loanAmount == null || loanAmount === '' || !Number.isFinite(amt)) {
    return closed(CAP_STATUS.LOAN_AMOUNT_UNKNOWN,
      `This scenario carries no readable loan amount, so the maximum-price tier for it could not be chosen; the strictest ceiling on the sheet (${tightest}) was applied instead.`);
  }

  const tierCap = capForLoanAmount(readable, amt);
  if (tierCap == null) {
    return closed(CAP_STATUS.ABOVE_ALL_TIERS,
      `This loan amount is above every maximum-price tier this sheet lists, so no tier covers it; the strictest ceiling on the sheet (${tightest}) was applied instead.`);
  }
  return {
    ...base, ...counts, capMilli: tierCap, capApplied: true, tightestCapMilli: tightest,
    status: CAP_STATUS.TIER,
    detail: `The sheet's maximum price for this scenario (${tierCap}) was applied.`,
  };
}

// ---------------------------------------------------------------------------
// 4. THE ONE WORDING A CALLER SHOWS BESIDE AN ANSWER
// ---------------------------------------------------------------------------

/**
 * The plain sentence for "what happened to this sheet's ceiling on this quote", or null when the sheet's
 * own rule governed and there is nothing to report. `res` is a quote result's `priceLimit` block.
 */
function priceLimitNotice(res) {
  if (!res || typeof res !== 'object') return null;
  if (res.rule === RULE.UNAVAILABLE) return res.ruleDetail || 'This sheet\'s maximum-price rule could not be evaluated, so nothing was priced.';
  const parts = [];
  if (res.rule === RULE.SHEET_TIERS_ONLY && res.ruleDetail) parts.push(res.ruleDetail);
  if (res.status && res.status !== CAP_STATUS.TIER && res.detail) parts.push(res.detail);
  return parts.length ? parts.join(' ') : null;
}

// What is deliberately NOT decided here (never guessed) — each needs one business answer, not a commit.
const UNMEASURED = [
  'A LOAN ABOVE EVERY PUBLISHED TIER: a sheet lists "loans up to $2,500,000 -> max price 103.500" and says nothing about a larger loan. Three readings are possible — (a) the ceiling stops applying, (b) the top tier\'s ceiling carries on, (c) the strictest ceiling on the sheet governs. This implements (c), the SAFE direction (it can only lower a price we quote, never raise one), and REPORTS the assumption on every affected quote as `assumption:"tightest_cap_on_sheet"`. On the Deephaven sheet the case is moot in practice — its own eligibility envelope declines a loan over $2,500,000 — so nothing live depends on the choice today. One owner answer settles it, and it is changed HERE only.',
  'A SCENARIO WITH NO LOAN AMOUNT is treated the same way, for the same reason. Whether a sheet\'s ceiling should instead be unresolvable (refusing to price) when the loan amount is unknown is a business call, not a reading of any sheet.',
  'HOW THE CAP COMBINES WITH THE FLOOR: `pricing.clamp` applies the floor first and the cap second, so a cap BELOW the floor would be the winner there, while the Deephaven sheet reads cap-then-floor. The two are indistinguishable on every sheet in the system today (the LOWEST published cap, 101.5, is above the 98.000 floor — asserted in the test, not assumed), so the engine was NOT changed on the strength of a case that cannot arise. Recorded so the next sheet with a low cap does not meet it by surprise.',
  'THE HOLDBACK FRAME: the caps this module hands the engine are POST-holdback, because the composed price is (see deephaven-dscr-prepay-maxprice\'s FRAME INVARIANT). `quote.js` still does not subtract the holdback from a price itself. If that changes, the cap and the price must move in the SAME commit or every capped quote goes out 0.25 low.',
];

module.exports = {
  scenarioRuleFor,
  listScenarioRules,
  applyScenarioPriceLimit,
  resolvePriceCap,
  capForLoanAmount,
  priceLimitNotice,
  RULE,
  CAP_STATUS,
  UNMEASURED,
  _internals: { readTier, normKey },
};
