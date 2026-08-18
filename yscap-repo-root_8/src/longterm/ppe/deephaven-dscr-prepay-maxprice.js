'use strict';
/**
 * LT PPE — the Deephaven DSCR rate sheet's PREPAY / MAX-PRICE / LOCK block, encoded verbatim from the
 * owner-supplied Excel (docs/longterm/ppe-research/matrices/deephaven-dscr-ratesheet-corr-t0.json).
 * This is the SIBLING of `deephaven-dscr-sheet.js` and it covers the four tables that file deliberately
 * left out and recorded in its UNMEASURED:
 *
 *   1. `maxPricePrepayBuydown` — the PREPAY LLPA family: 6 terms × TWO pricing models
 *      ("LLPA Other" = standard, "LLPA 5% Fixed" = the promo).
 *   2. the MAX-PRICE CAP per prepay term (105 / 105 / 104 / 102.75 / 102 / 101.5).
 *   3. `maxPriceTiersByLoanAmount` — the max-price TIERS by loan amount (105 / 104.5 / 103.5) and the
 *      98.000 MIN price, combined by the sheet's OWN rule.
 *   4. `termExtensionAdjustments` — LOCK TERM (45 / 60) and EXTENSION (5 / 10 / 15 / 30) pricing.
 *
 * ⛔ THE SIGN — the same money rule as the sibling sheet, and it is the one that already cost a real
 * mispricing. The JSON's `_signConvention` is PREMIUM-POSITIVE: **a positive value IMPROVES the price**.
 * `deephaven-grid.priceAdjMilli(V) = −V`, the engine subtracts that cost from the price, so the chain is
 * `price = base + Σ V`. A sheet cell therefore goes into a grid cell with **NO negation**, and every
 * assertion about it must be made ON THE PRICE AND ITS DIRECTION, never on a bare magnitude — the
 * magnitudes matched while the signs did not, which is exactly how a mispriced sheet passed 44/44.
 *
 * ⛔ THE SHEET IS THE INVESTOR'S PRE-HOLDBACK NUMBER; LENDER PRICE SHOWS THE POST-HOLDBACK VIEW.
 * (owner-directed 2026-08-17, answering the 0.25 gap this sheet's sibling had recorded as unexplained):
 *
 *      LENDER PRICE's number  =  THE RATE SHEET's number  −  our margin holdback
 *
 * The owner's own words: *"if the investor is giving me a max price of 104 and I'm telling you, for
 * Lender Price, give me a 0.25 max holdback, then Lender Price is only showing a max price of 103.75 …
 * this is across the board."* So the gap is NOT an error and NOT unexplained — it is the holdback we
 * configured with Lender Price, and it applies to EVERY price on the sheet: the base ladder (which sits
 * exactly 0.25 above LP at all 28 coupons — asserted in the test, not assumed) **and the MAX-PRICE caps
 * and TIERS** (105 → 104.75, 104.5 → 104.25, 104 → 103.75, 103.5 → 103.25).
 *
 * TWO RULES FALL OUT, and both are load-bearing:
 *   1. **The stored tables below are the SHEET's own numbers — pre-holdback, un-shifted.** The 0.25 is
 *      never baked into a cell. A stored table that has already had a deduction folded into it cannot
 *      be checked against the paper it came from, and the next person to "simplify" it would have no
 *      way to tell what was investor data and what was ours.
 *   2. **The holdback is an EXPLICIT, NAMED step, and its VALUE comes from the ONE existing definition**
 *      — `margin-holdback.resolveMarginHoldback` (per-investor default + per-scenario rules). There is
 *      no `0.25` literal anywhere in this file and no second holdback definition. `resolveHoldbackMilli`
 *      is the only door; `lpPriceMilli` / `maxPriceLpMilli` / `priceLimitFor` all go through it.
 *
 * THE FRAME INVARIANT (the thing to check before changing any of this): **a cap may only ever clamp a
 * price in its OWN frame.** The composed price today is POST-holdback (the sibling sheet's base ladder
 * is the LP-measured one), so the cap handed to the engine is post-holdback too. If the base ladder is
 * ever moved onto the sheet's own pre-holdback numbers, the holdback must be applied to the PRICE at the
 * same moment — otherwise a pre-holdback price would be clamped by a post-holdback ceiling and every
 * capped quote would be 0.25 low. What is NOT settled is the MIN price (see UNMEASURED): a minimum is
 * not a maximum, and shifting a floor DOWN by our holdback would let us quote below the investor's own
 * floor, so the 98.000 is left exactly as the sheet states it.
 *
 * ⛔ THE BASELINE — stated by the sheet itself (`B10`, and the JSON's `_baseline`): base pricing is a
 * **30-DAY LOCK at a 3-YEAR PREPAY**. Both are therefore the ZERO row of their own table:
 *   • prepay 3 Year (standard) = 0.000 → this module emits **NO adjustment** for it. The 5% Fixed
 *     column at the same term is +0.25 and DOES emit — the baseline is the standard column's, not the
 *     term's.
 *   • lock 30 days carries no row at all and emits nothing.
 *
 * TIED OUT TO LENDER PRICE TO THE PENNY (the analysis doc §1, coupon 7.500, base 105.175): standard
 * 5-yr `+0.625` → 105.800; 5% Fixed 5-yr `+1.125` → 106.300; No Prepay `−2.000` → 103.175; 3-yr → no
 * line at all. The 5% Fixed promo is worth **exactly +0.500 over standard at the 5-year term**
 * (1.125 − 0.625), confirmed from the sheet and from the live measurement independently.
 *
 * THE THREE PPP PRICING TIERS (analysis §1a) and how they reach this module:
 *   • STANDARD structures      → priced off `llpaOther`.                          (this module)
 *   • 5% Fixed promo (`fixed5`)→ priced off `llpa5PctFixed`.                      (this module)
 *   • CUSTOM SOFTER (3/3/3/2/1, 3/3/2/1) → priced off `llpaOther` **plus an existing +0.375 margin
 *     holdback**. That holdback is NOT re-implemented here: it already lives on the structure library
 *     (`ppp-structures.marginHoldbackDeltaOf` / `pppMarginHoldbackRules`) and is applied by
 *     `margin-holdback.resolveMarginHoldback`. What this module guarantees is the OTHER half — that a
 *     custom-softer structure resolves to the STANDARD LLPA it composes with, because `prepayFactsFor`
 *     reads the structure's own `pricingModel` out of that same library rather than restating it.
 *
 * TWO FACTS, AND WHY THE LOCK ONE IS NOT `lock_days`:
 *   • `prepay_months` (0/12/24/36/48/60) — the established fact (lp-agreement-legs emits it).
 *   • `prepay_pricing_model` ('standard' | 'fixed5_promo') — NEW. An ABSENT model reads as STANDARD,
 *     which is the sheet's own shape: column P is "LLPA Other", the default column, and the 5% Fixed
 *     column is an opt-in promotion a scenario must ASK for. Use `prepayFactsFor()` to produce both
 *     from a structure key so the model can never be typed by hand and drift from the library.
 *   • `lock_term_days` — NEW, and deliberately NOT `lock_days`. `lock_days` is the engine's RUNG-
 *     SELECTION key (`quote.selectRungs` drops every base rung whose `lockDays` differs), and this
 *     sheet publishes ONE base ladder, at 30 days. Keying the 45/60-day adjustment on `lock_days`
 *     would make the entire base ladder unselectable for exactly the scenarios the adjustment exists
 *     for — the price would not be 0.15 worse, there would be no price at all. So the 30-day ladder
 *     stays selected and the longer term is priced as the ADJUSTMENT the sheet says it is.
 *     `lockTermFacts(days)` emits BOTH keys together so a caller cannot set one without the other.
 *     (The alternative — publishing the base ladder at three lock periods — is an ENGINE wiring
 *     decision, not a sheet reading; it is recorded in UNMEASURED, not guessed at here.)
 *
 * WHAT IS DELIBERATELY NOT WIRED: the EXTENSION table is exported and validated but is **not** emitted
 * as a grid adjustment, because the sheet does not say whether an extension composes WITH the lock-term
 * adjustment or replaces it. Emitting both as independent LLPAs would make the engine SUM them, which
 * is precisely the guess this codebase refuses. See UNMEASURED.
 *
 * PURE: no DB, no network, no clock. LT-only. No RTL imports.
 */

const { getStructure, lpMapping } = require('./ppp-structures');
const { resolveMarginHoldback } = require('./margin-holdback');

// ── 1. THE PREPAY TABLE — JSON `maxPricePrepayBuydown.rows`, verbatim, cell for cell ────────────────
// PREMIUM-POSITIVE. `llpaOther` is the STANDARD column (P); `llpa5PctFixed` is the promo column (Q);
// `maxPrice` is column R — ONE cap per TERM, shared by both pricing models (the sheet publishes no
// second cap column, so the cap is term-keyed and model-independent).
const SHEET_PREPAY = [
  { term: '5 Year', termMonths: 60, llpaOther: 0.625, llpa5PctFixed: 1.125, maxPrice: 105 },
  { term: '4 Year', termMonths: 48, llpaOther: 0.25, llpa5PctFixed: 0.5, maxPrice: 105 },
  { term: '3 Year', termMonths: 36, llpaOther: 0, llpa5PctFixed: 0.25, maxPrice: 104 },
  { term: '2 Year', termMonths: 24, llpaOther: -0.5, llpa5PctFixed: -0.5, maxPrice: 102.75 },
  { term: '1 Year', termMonths: 12, llpaOther: -1, llpa5PctFixed: -1, maxPrice: 102 },
  { term: 'No Prepay', termMonths: 0, llpaOther: -2, llpa5PctFixed: -2, maxPrice: 101.5 },
];

// ── 2. MAX-PRICE TIERS BY LOAN AMOUNT + the MIN price — JSON `maxPriceTiersByLoanAmount` ────────────
const SHEET_MAX_PRICE_TIERS = [
  { loanAmountMax: 1500000, maxPrice: 105 },
  { loanAmountMax: 2000000, maxPrice: 104.5 },
  { loanAmountMax: 2500000, maxPrice: 103.5 },
];
const SHEET_MIN_PRICE = 98.0;
// The sheet's OWN combining rule, quoted so the code and the paper can be read side by side (B48):
const SHEET_MAX_PRICE_RULE = 'Max Price includes Lender Paid Comp, if applicable.  Max Price is the lower of Max Price Tiers and Prepay Buydown, when applicable.';

// ── 3. LOCK TERM + EXTENSION — JSON `termExtensionAdjustments` ──────────────────────────────────────
// 30 days is the base and carries NO row (the JSON says so in its own `_baseline`).
const SHEET_LOCK_TERM = [
  { days: 45, adj: -0.15 },
  { days: 60, adj: -0.3 },
];
// T46 verbatim: "Extension (Max 3 for Max 30 Days)".
const SHEET_EXTENSION = {
  maxExtensions: 3,
  maxTotalDays: 30,
  rows: [
    { days: 5, adj: -0.125 },
    { days: 10, adj: -0.25 },
    { days: 15, adj: -0.375 },
    { days: 30, adj: -0.75 },
  ],
};

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────
function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

// The row for a prepay term, by MONTHS. null (never a guessed 0) for a term the sheet does not publish.
function prepayRowFor(termMonths) {
  if (!isNum(termMonths)) return null;
  return SHEET_PREPAY.find((r) => r.termMonths === termMonths) || null;
}

/**
 * The prepay LLPA for a term × pricing model, as the sheet's own signed value (premium-positive).
 * Returns null when the sheet publishes no row for that term — NEVER 0, because "the sheet says this
 * term is worth nothing" (3 Year standard) and "the sheet does not price this term at all" are
 * different facts and only the first may be treated as a baseline.
 */
function prepayLlpa(termMonths, pricingModel) {
  const row = prepayRowFor(termMonths);
  if (!row) return null;
  return pricingModel === 'fixed5_promo' ? row.llpa5PctFixed : row.llpaOther;
}

/**
 * The scenario facts for one PPP structure, derived from the structure LIBRARY (`ppp-structures`) so
 * "which structures are the 5% Fixed promo" has exactly ONE definition. Returns
 * `{ prepay_months, prepay_pricing_model }`, or null for an unknown structure / an "any term"
 * structure asked for with no term (there is nothing to resolve the months from).
 *
 * A CUSTOM SOFTER structure (33321 / 3321) resolves to `standard` here — by design. It is priced off
 * the standard column and its extra +0.375 holdback is applied by the EXISTING margin-holdback layer,
 * which reads the same library. This module never re-implements that holdback.
 */
function prepayFactsFor(structureKey, termYears) {
  const s = getStructure(structureKey);
  if (!s) return null;
  const lp = lpMapping(s, termYears);
  if (!lp || !isNum(lp.prepayTermMonths)) return null;
  return {
    prepay_months: lp.prepayTermMonths,
    prepay_pricing_model: s.pricingModel === 'fixed5_promo' ? 'fixed5_promo' : 'standard',
  };
}

// A scenario that names no pricing model is priced on the STANDARD column — the sheet's default (P is
// "LLPA Other"; Q is an opt-in promotion). Expressed as a predicate so an ABSENT fact still fires the
// standard row: `none:[eq fixed5_promo]` is true both when the fact says 'standard' and when it is
// missing entirely, whereas a bare `neq` would fail-safe to NOT firing and silently drop the LLPA.
const NOT_FIXED5 = { none: [{ fact: 'prepay_pricing_model', op: 'eq', value: 'fixed5_promo' }] };
const IS_FIXED5 = { fact: 'prepay_pricing_model', op: 'eq', value: 'fixed5_promo' };

// The reason strings mirror Lender Price's own itemized lines for this family (analysis §1):
// `5 Year Prepay Penalty` / `5 Year Prepay Penalty - 5%` / `No Prepay Penalty`.
function prepayReason(row, model) {
  const base = row.termMonths === 0 ? 'No Prepay Penalty' : `${row.term} Prepay Penalty`;
  return model === 'fixed5_promo' ? `${base} - 5%` : base;
}

/**
 * The prepay family as `deephaven-grid` llpaTables. A 0 cell emits NOTHING — that is the 3-Year
 * standard BASELINE, and emitting a 0 adjustment would put a meaningless line on every quote and, worse,
 * imply the sheet prices something there. The 5% Fixed column at the same term is +0.25 and DOES emit.
 */
function prepayLlpaTables() {
  const out = [];
  for (const row of SHEET_PREPAY) {
    const pairs = [
      ['standard', row.llpaOther, NOT_FIXED5],
      ['fixed5', row.llpa5PctFixed, IS_FIXED5],
    ];
    for (const [modelTag, adj, modelPredicate] of pairs) {
      if (adj === 0) continue; // the baseline row — no adjustment, by construction
      out.push({
        dimension: 'prepay',
        code: `dhvn_prepay_${modelTag}_${row.termMonths}`,
        reason: prepayReason(row, modelTag === 'fixed5' ? 'fixed5_promo' : 'standard'),
        predicate: { all: [{ fact: 'prepay_months', op: 'eq', value: row.termMonths }, modelPredicate] },
        adj,
      });
    }
  }
  return out;
}

/**
 * The LOCK-TERM adjustments as llpaTables, keyed on `lock_term_days` (see the header for why not
 * `lock_days`). 30 days has no row and emits nothing.
 */
function lockTermLlpaTables() {
  return SHEET_LOCK_TERM.map((r) => ({
    dimension: 'lock_term',
    code: `dhvn_lock_${r.days}`,
    reason: `Lock Term - ${r.days} Days`,
    predicate: { fact: 'lock_term_days', op: 'eq', value: r.days },
    adj: r.adj,
  }));
}

/**
 * The lock-term adjustment for a lock period, as the sheet's own signed value. 30 (the base) → 0. A
 * lock period the sheet does not publish → null, NEVER an interpolated or guessed value.
 */
function lockTermAdjustment(days) {
  if (!isNum(days)) return null;
  if (days === 30) return 0; // the base lock — the sheet's own baseline, no row and no adjustment
  const row = SHEET_LOCK_TERM.find((r) => r.days === days);
  return row ? row.adj : null;
}

/**
 * The two facts a scenario needs to be priced at a given lock period, emitted TOGETHER so they cannot
 * drift: `lock_days` stays at the base ladder's own 30 (it is the rung-selection key) and
 * `lock_term_days` carries the requested period (it is the pricing key).
 */
function lockTermFacts(days) {
  return { lock_days: 30, lock_term_days: isNum(days) ? days : 30 };
}

/**
 * The EXTENSION adjustment for a published extension length. null for a length the sheet does not
 * publish (5 / 10 / 15 / 30 are the only rows) — never interpolated, never pro-rated.
 */
function extensionAdjustment(days) {
  if (!isNum(days)) return null;
  const row = SHEET_EXTENSION.rows.find((r) => r.days === days);
  return row ? row.adj : null;
}

/**
 * The sheet's own stated extension LIMIT — "Max 3 for Max 30 Days" (`maxExtensions:3`,
 * `maxTotalDays:30` in the JSON). Returns null when the request is within the limit, or a reason
 * string when it is not. Reads the JSON's two named fields and invents no third rule.
 *
 *   extensionProblem({ days: [15, 15] })  → null      (2 extensions, 30 days total)
 *   extensionProblem({ days: [15, 15, 15] }) → over the 30-day total
 */
function extensionProblem(req) {
  const days = Array.isArray(req && req.days) ? req.days : [];
  for (const d of days) {
    if (extensionAdjustment(d) == null) return `extension of ${d} day(s) is not on the sheet (published: ${SHEET_EXTENSION.rows.map((r) => r.days).join('/')})`;
  }
  if (days.length > SHEET_EXTENSION.maxExtensions) return `${days.length} extensions exceeds the sheet's maximum of ${SHEET_EXTENSION.maxExtensions}`;
  const total = days.reduce((s, d) => s + d, 0);
  if (total > SHEET_EXTENSION.maxTotalDays) return `${total} extension days exceeds the sheet's maximum of ${SHEET_EXTENSION.maxTotalDays} days`;
  return null;
}

// ── THE MAX-PRICE RULE ──────────────────────────────────────────────────────────────────────────────

/** The max price for a prepay term (column R). null for a term the sheet does not publish. */
function prepayMaxPrice(termMonths) {
  const row = prepayRowFor(termMonths);
  return row ? row.maxPrice : null;
}

/**
 * The max price for a loan amount. Tiers are ASCENDING and INCLUSIVE at the top ("≤ $1,500,000"), so
 * the first tier the amount fits under wins. Above every tier → null: the sheet publishes no cap there
 * because its own eligibility envelope declines a loan over $2,500,000, and inventing a cap for a loan
 * that cannot exist would be a guess. A non-number → null. (A very small amount still falls in the
 * first tier, which is correct — the sheet's tiers have no lower bound; the sibling sheet's own
 * minimum-loan rules are what decline a loan that is too small, not this ceiling.)
 */
/**
 * The max price this sheet allows for ONE loan amount.
 *
 * ⛔ ABOVE THE TOP TIER THE TOP TIER'S CAP CARRIES UPWARD — OWNER-ANSWERED 2026-08-18, in their own
 * words: *"anything above 2.5 million files the same cap as 2.5 million."*
 *
 * WHAT IT USED TO DO, AND WHY THAT WAS A DEFECT. It returned `null` above $2,500,000 — read everywhere
 * as "uncapped by this axis" — and the module's own note said no ceiling should be invented for a loan
 * that cannot exist, because the sibling sheet's eligibility envelope declines above $2.5MM. Measured:
 *
 *     $2,500,000 + 5-year prepay  →  cap 103.5   (the loan-amount tier binds)
 *     $2,500,001 + 5-year prepay  →  cap 105.0   (nothing binds; the prepay cap is all that is left)
 *
 * One dollar more loan bought 1.5 points more premium — on a $3,000,000 loan, $45,000 — and the CLIFF
 * ran the wrong way: the larger loan got the LOOSER ceiling. An eligibility rule elsewhere is not a
 * reason for a price rule here to have an open top; the two are different sheets, they are overridden
 * by different people, and this module is also compiled into rules a future program can share.
 *
 * IT ALSO SETTLES A DISAGREEMENT WE ALREADY HAD WITH OURSELVES. `price-limit.resolvePriceCap` — the
 * path that actually enforces the ceiling on a compiled quote — has always fallen closed onto the
 * TIGHTEST cap on the sheet above the last tier, answering 103.5 where this function answered null. Two
 * definitions of one ceiling, disagreeing. The owner's rule is what the compiled path was already
 * doing, so this is not a new rule; it is the direct reader being brought into line with the enforcer.
 *
 * THE TRANSCRIPTION IS UNTOUCHED. `SHEET_MAX_PRICE_TIERS` still holds exactly the three tiers the
 * vendor publishes; what is stated here is how to READ the top of that table, attributed to the owner.
 *
 * STILL TO CONFIRM WITH THE VENDOR: the owner asked us to double-check how Lender Price itself reads
 * the top tier. There is no vendor login in this environment, so that check has not been done — the
 * owner's answer is what is implemented, and the cross-check is recorded in UNMEASURED.
 */
function loanAmountMaxPrice(loanAmount) {
  if (!isNum(loanAmount)) return null;
  const sorted = SHEET_MAX_PRICE_TIERS.slice().sort((a, b) => a.loanAmountMax - b.loanAmountMax);
  for (const t of sorted) if (loanAmount <= t.loanAmountMax) return t.maxPrice;
  // Above every published tier: the top tier's cap carries upward (owner, 2026-08-18). An empty table
  // still answers null — there is no ceiling to carry — rather than inventing one.
  return sorted.length ? sorted[sorted.length - 1].maxPrice : null;
}

/**
 * THE SHEET'S OWN COMBINING RULE, implemented exactly as written (B48, quoted in SHEET_MAX_PRICE_RULE):
 * "Max Price is the lower of Max Price Tiers and Prepay Buydown, **when applicable**."
 *
 *   • both resolvable  → the LOWER of the two wins.
 *   • one resolvable   → that one ("when applicable").
 *   • neither          → null (uncapped) — never a fabricated ceiling.
 *
 * Returns { maxPrice, source, prepayMaxPrice, loanAmountMaxPrice } so a caller (and the test) can see
 * WHICH ceiling bound the quote, not just the number.
 */
function maxPriceFor(input) {
  const i = input || {};
  const byPrepay = prepayMaxPrice(i.prepayTermMonths);
  const byAmount = loanAmountMaxPrice(i.loanAmount);
  const candidates = [];
  if (byPrepay != null) candidates.push({ price: byPrepay, source: 'prepay' });
  if (byAmount != null) candidates.push({ price: byAmount, source: 'loan_amount' });
  if (!candidates.length) return { maxPrice: null, source: null, prepayMaxPrice: byPrepay, loanAmountMaxPrice: byAmount };
  // THE LOWEST WINS. On a tie the loan-amount tier is reported as the source only for the trace; the
  // NUMBER is identical either way, so nothing about the price depends on this choice.
  let best = candidates[0];
  for (const c of candidates) if (c.price < best.price) best = c;
  return { maxPrice: best.price, source: best.source, prepayMaxPrice: byPrepay, loanAmountMaxPrice: byAmount };
}

// ── THE MARGIN HOLDBACK — the ONE step that turns a sheet number into the Lender Price view ─────────

/**
 * The holdback, in MILLI-points, resolved by the EXISTING `margin-holdback` module — never a literal
 * here. `opts` is that module's own input shape, passed straight through:
 *   { marginMilli?, holdbackMilli?, rules?, facts? }
 * so a per-investor default (store.js resolves it) and a per-scenario rule (e.g. the custom-softer
 * +0.375) reach this the same way they reach every other consumer. With nothing supplied it returns
 * that module's own product default — which is where the 0.25 comes from.
 *
 * WHICH KNOB: `margin-holdback` carries TWO numbers, `margin` and `holdback`, both pre-filled 0.250.
 * The owner's wording is "our 0.25 holdback" / "give me a 0.25 max holdback", so this reads the
 * HOLDBACK knob. The two are the same number today, so nothing about any price depends on the choice
 * yet — but they diverge the day an investor is given different values, which is why it is named here
 * rather than left implicit (see UNMEASURED).
 */
function resolveHoldbackMilli(opts) {
  const o = opts || {};
  return resolveMarginHoldback({
    marginMilli: o.marginMilli,
    holdbackMilli: o.holdbackMilli,
    rules: o.rules,
    facts: o.facts,
  }).holdbackMilli;
}

/**
 * THE SHEET → LENDER PRICE VIEW, in one place: `LP = sheet − holdback`, in milli-points.
 * Applies to every price on this sheet — the base ladder and the max-price ceilings alike.
 * null in → null out (a ceiling the sheet does not publish stays unpublished, never a shifted 0).
 */
function lpPriceMilli(sheetPrice, holdbackMilli) {
  if (!isNum(sheetPrice)) return null;
  const hb = isNum(holdbackMilli) ? holdbackMilli : resolveHoldbackMilli();
  return Math.round(sheetPrice * 1000) - hb;
}

/**
 * The combined max price for a scenario, in the LENDER PRICE (post-holdback) frame — the frame our
 * composed price is in. Returns the same trace `maxPriceFor` does plus the holdback that was applied,
 * so a reader can always see the investor number, the deduction, and the result separately.
 */
function maxPriceLpMilli(input, opts) {
  const cap = maxPriceFor(input);
  const holdbackMilli = resolveHoldbackMilli(opts);
  return {
    ...cap,
    holdbackMilli,
    sheetMaxPriceMilli: cap.maxPrice == null ? null : Math.round(cap.maxPrice * 1000),
    capLpMilli: lpPriceMilli(cap.maxPrice, holdbackMilli),
  };
}

/**
 * The resolved price limit for ONE scenario, in the pricing engine's MILLI-points.
 *
 *   sheetCapMilli — the INVESTOR's ceiling, exactly as the sheet publishes it.
 *   holdbackMilli — our margin holdback, from `margin-holdback` (never a literal here).
 *   capMilli      — `sheetCapMilli − holdbackMilli`: the ceiling in the frame the composed price is
 *                   actually in, and therefore the one the engine may clamp with (the FRAME INVARIANT
 *                   in the header).
 *   floorMilli    — the sheet's 98.000, **UNADJUSTED**. The owner's rule is stated about a MAX price;
 *                   shifting a MINIMUM down by our own holdback would let us quote below the investor's
 *                   own floor, which is the opposite direction of safe. Not guessed — see UNMEASURED.
 *
 * ORDER: the sheet says the price is capped and then floored at the minimum. The engine's own
 * `pricing.clamp` applies the floor first and the cap second, so a cap BELOW the floor would win there.
 * That cannot arise on this sheet — the LOWEST cap it publishes is 101.5, still 101.25 after the
 * holdback, against a floor of 98.000, a fact the test asserts rather than assumes — so the two orders
 * are indistinguishable here and nothing has been changed in the engine on the strength of a case that
 * does not exist.
 */
function priceLimitFor(scenario, opts) {
  const s = scenario || {};
  const cap = maxPriceFor({
    loanAmount: isNum(s.loan_amount) ? s.loan_amount : null,
    prepayTermMonths: isNum(s.prepay_months) ? s.prepay_months : null,
  });
  const holdbackMilli = resolveHoldbackMilli(opts);
  return {
    floorMilli: Math.round(SHEET_MIN_PRICE * 1000),
    sheetCapMilli: cap.maxPrice == null ? null : Math.round(cap.maxPrice * 1000),
    holdbackMilli,
    capMilli: lpPriceMilli(cap.maxPrice, holdbackMilli),
    capSource: cap.source,
    prepayMaxPrice: cap.prepayMaxPrice,
    loanAmountMaxPrice: cap.loanAmountMaxPrice,
  };
}

/**
 * The loan-amount tiers in the shape `quote.capForLoanAmount` consumes (milli-points), in the SAME
 * post-holdback frame as the composed price (the FRAME INVARIANT). `opts` is passed to
 * `resolveHoldbackMilli`, so a per-investor holdback flows through here too.
 */
function loanAmountCapTiers(opts) {
  const holdbackMilli = resolveHoldbackMilli(opts);
  return SHEET_MAX_PRICE_TIERS
    .slice()
    .sort((a, b) => a.loanAmountMax - b.loanAmountMax)
    .map((t) => ({ uptoLoanAmount: t.loanAmountMax, capMilli: lpPriceMilli(t.maxPrice, holdbackMilli) }));
}

/**
 * A program whose price limit carries the COMBINED cap for THIS scenario.
 *
 * WHY A ONE-TIER LIST: the engine's cap channel (`quote.capForLoanAmount`) is loan-amount tiered, and
 * the combined ceiling additionally depends on the prepay TERM — a scenario fact. So the resolved cap is
 * handed over as a single tier that the scenario's own loan amount falls under. Everything else on the
 * program is left untouched (a shallow clone; the base grid and rules are shared, never copied).
 *
 * `buildPrepayMaxPriceGrid()` already puts the STATIC loan-amount tiers on the grid, so a caller that
 * never reaches this function is still capped — just by the loan-amount tier alone, which is the HIGHER
 * (less restrictive) of the two ceilings. Route a priced scenario through here to get the sheet's real
 * "lower of the two" rule.
 */
function programWithPriceLimit(program, scenario, opts) {
  const lim = priceLimitFor(scenario, opts);
  const pl = (program && program.priceLimit) || {};
  const amount = scenario && isNum(scenario.loan_amount) ? scenario.loan_amount : null;
  return {
    ...program,
    priceLimit: {
      ...pl,
      floorMilli: lim.floorMilli,
      // A null cap means the sheet publishes no ceiling for this scenario (a loan above every tier with
      // no published prepay term). An EMPTY tier list is the engine's own "uncapped", so nothing is
      // invented.
      //
      // A RESOLVED CAP WITH NO LOAN AMOUNT IS STILL A CAP. `maxPriceFor` combines TWO axes and the
      // sheet's own rule is "the lower of the two, WHEN APPLICABLE" — so a scenario that names a
      // prepay term but no loan amount still has a published ceiling (the prepay one; the loan-amount
      // axis simply did not apply). Emitting `[]` there dropped that ceiling on the floor and the
      // scenario priced UNCAPPED, which is the same class of silent over-quote as never running this
      // function at all. The tier is therefore published with a threshold that covers any loan, which
      // is exactly what "the loan-amount axis did not participate" means — never a guessed amount.
      capTiers: lim.capMilli == null
        ? []
        : [{ uptoLoanAmount: amount == null ? Number.MAX_SAFE_INTEGER : amount, capMilli: lim.capMilli }],
    },
  };
}

/**
 * The sibling sheet's grid, EXTENDED with this block: the prepay LLPA family, the lock-term
 * adjustments, the 98.000 floor and the static loan-amount max-price tiers. The base ladder, the
 * FICO×CLTV grid, the DSCR bands, every add-on family and the whole eligibility envelope come from
 * `deephaven-dscr-sheet.buildDeephavenGrid()` untouched — there is ONE base sheet, not two.
 *
 * The EXTENSION table is deliberately absent from the grid (see the header + UNMEASURED).
 */
function buildPrepayMaxPriceGrid(baseGrid, opts) {
  // Required lazily so this module stays loadable on its own and the two files cannot form a cycle.
  const grid = baseGrid || require('./deephaven-dscr-sheet').buildDeephavenGrid();
  return {
    ...grid,
    llpaTables: [...(Array.isArray(grid.llpaTables) ? grid.llpaTables : []), ...prepayLlpaTables(), ...lockTermLlpaTables()],
    priceLimit: {
      ...(grid.priceLimit || {}),
      minPrice: SHEET_MIN_PRICE,
      capTiers: loanAmountCapTiers(opts),
    },
  };
}

// THE SOURCE OF TRUTH, exported so the test asserts against the SHEET rather than re-deriving it.
const SHEET_TABLES = {
  PREPAY: SHEET_PREPAY,
  MAX_PRICE_TIERS: SHEET_MAX_PRICE_TIERS,
  MIN_PRICE: SHEET_MIN_PRICE,
  MAX_PRICE_RULE: SHEET_MAX_PRICE_RULE,
  LOCK_TERM: SHEET_LOCK_TERM,
  EXTENSION: SHEET_EXTENSION,
};

// What is deliberately NOT decided here (never guessed) — each needs one business answer, not a commit.
const UNMEASURED = [
  'EXTENSION COMPOSITION: the sheet lists lock-term (45/60) and extension (5/10/15/30) adjustments in ONE block and says nothing about whether an extension ADDS to the lock-term adjustment, replaces it, or is charged separately at extension time. So the extension table is exported + validated (extensionAdjustment / extensionProblem) but is NOT emitted as a grid adjustment — emitting both as independent LLPAs would make the engine SUM them, which is the guess. One owner answer settles it.',
  'EXTENSION LIMIT READING: "Max 3 for Max 30 Days" is implemented as the JSON\'s own two named fields (maxExtensions 3, maxTotalDays 30 — i.e. at most 3 extensions totalling at most 30 days). Whether the four published lengths are a menu of SINGLE extensions or cumulative buckets (may a 30-day extension be taken at all if it exhausts the 30-day total in one go?) is not stated on the sheet.',
  'LOCK-TERM WIRING: the sheet prices a 45/60-day lock as an ADJUSTMENT to a 30-day base ladder, but the engine selects base rungs by lock period (quote.selectRungs), so the adjustment is keyed on a NEW `lock_term_days` fact with `lock_days` pinned to the base ladder\'s 30 (lockTermFacts emits both). The alternative — publishing the base ladder at 30/45/60 with the adjustment baked in — is an ENGINE wiring decision, not a sheet reading, and is left to the owner.',
  'A LOCK PERIOD THE SHEET DOES NOT PUBLISH (e.g. 15 or 90 days) resolves to null, not to an interpolated or pro-rated adjustment. Whether such a lock is offerable at all is not on this sheet.',
  'MIN PRICE vs THE HOLDBACK — NOT GUESSED. The owner\'s rule (2026-08-17) is that Lender Price shows our numbers AFTER the margin holdback, "across the board", and it is stated about a MAX price ("the investor is giving me a max price of 104 … Lender Price is only showing 103.75"). A MINIMUM is not a maximum: shifting a floor DOWN by our own holdback would let us quote 97.75 against an investor floor of 98.000, which is the opposite direction of safe, while shifting it UP would refuse business the investor allows. So the 98.000 floor is carried EXACTLY as the sheet states it and no holdback is applied to it. One owner answer settles which (if either) it should be.',
  'MIN PRICE 98.000 is implemented as a FLOOR (the price is clamped up to it). Whether a raw price below 98.000 should instead DECLINE the scenario is not stated on the sheet.',
  'WHICH KNOB IS THE 0.25: margin-holdback.js carries TWO numbers — `margin` and `holdback` — both pre-filled 250 milli. The owner said "our 0.25 holdback", so this module reads the HOLDBACK knob. Identical today, so no price depends on the choice; they diverge the first time an investor is given different values, and then this needs confirming rather than inferring.',
  'THE HOLDBACK AND THE BASE LADDER\'S FRAME — CORRECTED 2026-08-18 (parity doc §2.69/§2.76). This entry used to say the engine did not apply the holdback and that wiring it into pricing.priceRung was still to come. IT HAS COME: priceRung SUBTRACTS the holdback (measured — 105.000 with a 0.25 holdback prices 104.750), and the note survived here after the sibling sheet\'s copy was corrected, which is a stale money note that would send the next reader to make a change already made, on a price. What IS still open is the owner\'s: this grid inherits the sibling\'s base ladder, which sits on the LP-measured (post-holdback) numbers and DECLARES that frame (priceFrame lp_post_holdback), so quote.js refuses to price it with a holdback configured rather than taking the 0.25 off twice. Moving the ladder onto the investor\'s own pre-holdback numbers is the other way out and is the owner\'s call.',
  'CLAMP ORDER: the sheet reads cap-then-floor; the engine\'s pricing.clamp is floor-then-cap. Indistinguishable on this sheet because the LOWEST published cap (101.5) is above the floor (98.000) — asserted, not assumed — so the engine was NOT changed on the strength of a case that cannot arise here.',
  'ABOVE $2,500,000 — ANSWERED 2026-08-18, not an assumption any more. The owner: "anything above 2.5 million files the same cap as 2.5 million." So the top tier carries upward and loanAmountMaxPrice returns 103.5 for any amount above $2,500,000. This entry used to say the opposite — that the function returns null (uncapped) because the sibling sheet declines above $2.5MM anyway — and that combination priced a $2,500,001 loan with a 5-year prepay at a 105 ceiling where $2,500,000 was held to 103.5: one dollar more loan, 1.5 points more premium, the cliff running the wrong way. WHAT IS STILL OPEN is the vendor cross-check the owner asked for — how Lender Price itself reads the top of that table — which needs a live login this environment does not have.',
  'ONE CAP PER TERM, BOTH MODELS: the sheet publishes a single Max Price column (R) beside the two LLPA columns, so the 5% Fixed promo is capped at its TERM\'s cap exactly as the standard column is. If the promo carries its own ceiling it is not on this sheet.',
  'THE PRICING-MODEL FACT: an absent `prepay_pricing_model` is priced on the STANDARD column, which is the sheet\'s own default shape (P = "LLPA Other"; Q = an opt-in promotion). Which layer SETS that fact on a live quote (the scenario converter / the LP request builder) is not wired here — prepayFactsFor() derives it from the ppp-structures library so it can never be hand-typed.',
  'A PREPAY TERM THE SHEET DOES NOT PUBLISH (anything other than 0/12/24/36/48/60 months) resolves to null for BOTH the LLPA and the cap — never a 0 adjustment and never an interpolated cap. Whether such a term is offerable is not on this sheet.',
];

module.exports = {
  buildPrepayMaxPriceGrid,
  prepayLlpaTables,
  lockTermLlpaTables,
  prepayLlpa,
  prepayFactsFor,
  prepayMaxPrice,
  loanAmountMaxPrice,
  maxPriceFor,
  resolveHoldbackMilli,
  lpPriceMilli,
  maxPriceLpMilli,
  priceLimitFor,
  loanAmountCapTiers,
  programWithPriceLimit,
  lockTermAdjustment,
  lockTermFacts,
  extensionAdjustment,
  extensionProblem,
  SHEET_TABLES,
  UNMEASURED,
  _internals: { prepayRowFor, prepayReason, NOT_FIXED5, IS_FIXED5 },
};
