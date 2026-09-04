'use strict';
/**
 * LONG-TERM — THE FACTS A PRICING RULE IS READ AGAINST.
 *
 * One flat object per priced quote, keyed exactly as `rules/fields.js` names its
 * fields, because that is the shape the shared rule evaluator takes as its
 * context (`ctx[row.field]`).
 *
 * ── ABSENT IS ABSENT, NEVER A ZERO AND NEVER A "NO" ────────────────────────
 *
 * A fact the search did not state is `null`. The shared evaluator short-circuits
 * every comparison on a blank to FALSE except the two that ask about emptiness —
 * so "cash out is more than 250,000" cannot match a loan with no cash out, and
 * "is not no-prepay" cannot match a search that never said. Filling a blank with
 * 0 would arm every one of those rules on every loan that simply did not answer.
 *
 * ── A BOOLEAN IS ONLY TRUE OR FALSE WHEN SOMEBODY SAID SO ──────────────────
 *
 * `flag()` answers `true`, `false` or `null`. Coercing with `!!` would turn every
 * unanswered switch into a definite "no", and an `is_false` rule would then fire
 * on every loan in the book — which is exactly the trap the shared evaluator's
 * `is_false` comment warns about.
 *
 * PURE: no database, no network, no clock, no RTL import.
 */

const defaults = require('../scenario-defaults');
const dscrTiers = require('../dscr-tiers');

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const text = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/**
 * A yes/no the search may simply not have answered.
 *
 * ⛔ IT IS `scenario-defaults.readFlag`'S ANSWER, AND ITS STRICTNESS, NOT A SECOND
 * READING. That function accepts ONLY a real JSON boolean and THROWS on anything
 * else — Lender Price learned the hard way that the string "false" is truthy in
 * JavaScript and silently turns a switch ON. The first cut of this file caught
 * that throw and then parsed 'true' / 'yes' / 1 itself, which is a looser reading
 * of the same question living one function away from the strict one: exactly the
 * second copy that drifts. A value it refuses is now `null` here — "we cannot
 * read this" — so a rule about that switch simply does not match, which is the
 * safe direction and the honest one.
 *
 * It also answers `null` for a name that is not a scenario flag at all, so a
 * field added to the rule registry with no switch behind it can never read as a
 * confident "no".
 */
function flag(sc, name) {
  let v;
  try {
    v = defaults.readFlag(sc, name);
  } catch (_) {
    /* Either the name is not a flag, or the value is not a real boolean. Both are
       "we cannot say", and neither is a "no". */
    return null;
  }
  return v === true ? true : v === false ? false : null;
}

/** The first of several scenario spellings that actually carries a value. */
function first(sc, keys, read) {
  for (const k of keys) {
    const v = read(sc ? sc[k] : undefined);
    if (v !== null) return v;
  }
  return null;
}

/**
 * WHICH DSCR BAND — the same eleven the bracket search walks, read through the
 * ladder's own function rather than by comparing numbers here. A DSCR the search
 * did not state has no band; it is not band one.
 */
function bandOf(dscr) {
  if (dscr === null) return null;
  try {
    const t = dscrTiers.dscrTier(dscr);
    const n = t && t.tier != null ? t.tier : (typeof t === 'number' ? t : null);
    return n == null ? null : String(n);
  } catch (_) { return null; }
}

/**
 * THE SEARCH, as facts. Built once per board rather than per row: every row of
 * one board was quoted for the same loan, and rebuilding it per row would be
 * both slower and a chance for two rows to disagree about one search.
 */
function scenarioFacts(sc) {
  const s = sc || {};
  const dscr = num(s.dscr);
  const prepayMonths = num(s.prepayMonths);
  const prepayStructure = text(s.prepayStructure);

  /* HAS A PREPAYMENT PENALTY — the owner's own worked example turns on it
     (*"prepayment penalty is not no prepay"*). It is derived from BOTH halves,
     because a sheet can express "none" either way: a term of zero months, or a
     structure that says None. Neither stated → null, because "we do not know" is
     not "there is no penalty". */
  let hasPrepay = null;
  if (prepayMonths !== null) hasPrepay = prepayMonths > 0;
  if (hasPrepay === null && prepayStructure !== null) {
    hasPrepay = !/^\s*(none|no\s*prepay|no\s*prepayment)\s*$/i.test(prepayStructure);
  }

  return {
    loan_amount: num(s.loan),
    loan_purpose: text(s.purpose),
    ltv: num(s.ltv),
    fico: num(s.fico),
    dscr,
    dscr_band: bandOf(dscr),
    cashout_amount: num(s.cashoutAmount),
    subordinate_loan_amount: num(s.subordinateLoanAmount),
    reserves_months: num(s.reservesMonths),
    term_years: first(s, ['termYears', 'term'], num),
    lock_days: num(s.lockDays),
    interest_only: flag(s, 'io'),
    escrow_waived: flag(s, 'escrowWaive'),

    prepay_months: prepayMonths,
    prepay_structure: prepayStructure,
    has_prepay: hasPrepay,

    state: text(s.state),
    county: first(s, ['county', 'countyName'], text),
    city: text(s.city),
    zip: text(s.zip),
    property_type: text(s.propertyType),
    units: num(s.units),
    attachment_type: first(s, ['attachmentType', 'attachment'], text),
    non_warrantable: flag(s, 'nonWarrantable'),
    rural: flag(s, 'rural'),
    mixed_use: flag(s, 'mixedUse'),
    property_value: first(s, ['value', 'appraisedValue'], num),
    as_is_value: num(s.asIsValue),
    rental_term: text(s.rentalTerm),

    borrower_type: text(s.borrowerType),
    citizenship: text(s.citizenship),
    first_time_investor: flag(s, 'firstTimeInvestor'),
    first_time_home_buyer: flag(s, 'fthb'),
    self_employed: flag(s, 'selfEmployed'),
    financed_properties: num(s.financedProperties),
    number_of_borrowers: num(s.numberOfBorrowers),
    income_doc_type: text(s.incomeDocType),
    tradelines: text(s.tradelines),
    no_mortgage_history: flag(s, 'noMortgageHistory'),
    living_rent_free: flag(s, 'livingRentFree'),
    cross_collateral: flag(s, 'crossCollateral'),

    foreclosure: text(s.foreclosure),
    short_sale: text(s.shortSale),
    deed_in_lieu: text(s.deedInLieu),
    charge_off: text(s.chargeOff),
    forbearance: text(s.forbearance),
    bankruptcy_chapter: text(s.bankruptcy && s.bankruptcy.chapter),
    late_in_last_12_months: flag(s, 'lateInLast12Months'),
  };
}

/**
 * THE QUOTED ROW, as facts.
 *
 * ⛔ IT READS THE ROW, NEVER THE SEARCH. `quoted_ltv` and `quoted_dscr` are what
 * the sheet answered WITH; `ltv` and `dscr` above are what we asked FOR. They are
 * frequently different numbers and a rule that confused them would be written
 * against one and fire on the other.
 *
 * `option` is a priced option when the row has several (a Lender Price program
 * carries `options[]`); the whole row is passed when it is already flat.
 */
function quoteFacts(row, option, opts) {
  const r = row || {};
  const o = option || row || {};
  const pb = (o && o.priceBuild) || {};
  const terms = (o && o.terms) || {};
  const o3 = opts || {};

  return {
    investor: text(r.investor) || text(o.investor),
    investor_key: text(r.investorKey) || text(o.investorKey),
    white_label: text(r.whiteLabel) || text(o.whiteLabel) || text(r.consumerLabel),
    lender: text(r.lender) || text(o.lender),
    program_name: text(r.program) || text(o.program),
    product: text(r.product) || text(o.product),

    note_rate: num(pb.noteRate),
    price: num(pb.price),
    /* THE POINTS THE CLIENT PAYS, which is the figure a discount or a holdback
       is about — `basePoints` is the sheet's own starting point and would read a
       point or two away from what anybody is quoted. */
    points: first(pb, ['borrowerPaidPoints', 'adjustedPoints'], num),

    quoted_term_years: first(terms, ['termYears'], num),
    quoted_lock_days: first(terms, ['dayLock', 'cushionedLockDays'], num),
    amortization: text(terms.amortizationType),
    quoted_ltv: num(terms.ltv),
    quoted_dscr: num(terms.dscr),
    margin_holdback: first({ a: r.marginHoldback, b: o.marginHoldback }, ['a', 'b'], num),

    /* WHERE THE PRICE CAME FROM. `pricedBy` is the board's own engine stamp and
       is only present when the caller asked for it, so the source falls back to
       the vendor trail the routing layer strips on a client-facing board. A row
       whose origin cannot be named carries `null` and a rule about a rate sheet
       simply does not match it — never a guess, because the owner's own worked
       example ("if the pricing is being pulled from Loanex") turns on it. */
    source: text(r.pricedBy) || text(o.pricedBy) || text(r.source) || text(o.source),
    engine: text(o3.engine),
  };
}

/**
 * The whole bag for one quote: the search plus the row.
 *
 * The scenario half is passed in already built so a board pays for it once.
 */
function factsFor(scenarioFactsBag, row, option, opts) {
  return Object.assign({}, scenarioFactsBag || {}, quoteFacts(row, option, opts));
}

module.exports = { scenarioFacts, quoteFacts, factsFor, _internals: { flag, bandOf, num, text } };
