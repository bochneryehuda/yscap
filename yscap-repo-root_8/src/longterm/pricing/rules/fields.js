'use strict';
/**
 * LONG-TERM — EVERY FIELD A PRICING RULE MAY ASK ABOUT.
 *
 * Owner-directed 2026-09-04: *"it should obviously pop up all the fields that
 * are available in the pricing engine. If that field has available drop-downs,
 * you can select in that field any of the above or all of the above with all
 * this kind of logic, one of this or specifically this."*
 *
 * ── THE OPTIONS ARE DERIVED, NEVER HAND-TYPED ──────────────────────────────
 *
 * Every drop-down here is built FROM THE MODULE THAT ALREADY OWNS THAT
 * VOCABULARY — `lenderprice/field-registry` for the property types, borrower
 * types, income documentation, prepayment structures, citizenship, tradelines
 * and every derogatory-event token; `pricing/dscr-tiers` for the DSCR bands.
 * A hand-typed list is a list somebody has to remember to update, and the day it
 * goes stale a rule silently stops matching the very loans it was written for —
 * which is the one failure this centre cannot afford, because a licensing block
 * that looks armed and is not is worse than no block at all.
 *
 * So: to add a value to a drop-down, add it to the registry that owns it. It
 * appears here, in the builder, and in the evaluator, at once.
 *
 * ── WHY THE SCENARIO KEYS ARE STATED AND THE PROOF IS A TEST ───────────────
 *
 * The scenario field NAMES could be read straight out of the pricer route's
 * `SUPPORTED_FIELDS`, and the first cut did exactly that — but that route
 * requires half the pricing library, so importing it from a module the board
 * builder itself imports is a require cycle waiting to happen. The names are
 * therefore written down here and `test-lt-pricing-rules-pure.js` asserts, from
 * the route's own set, that every scenario field this registry offers is one the
 * pricer actually honours. A field that quietly stopped being supported fails
 * the build rather than becoming a rule that can never match.
 *
 * ── WHAT IS DELIBERATELY NOT A FIELD ───────────────────────────────────────
 *
 * Nothing that would let a rule ask about the borrower as a person — no name, no
 * contact, no document. A pricing rule is about the LOAN and the QUOTE.
 *
 * PURE: no database, no network, no clock, no RTL import.
 */

const lp = require('../../lenderprice/field-registry');
const dscrTiers = require('../dscr-tiers');

/** A drop-down entry the shared rule grammar understands. */
const opt = (v, label) => ({ v, label: label || String(v) });

/**
 * Turn a vendor token collection — a Set, an array, or an object whose KEYS are
 * the canonical words — into options, sorted so the builder's list is stable.
 *
 * ⛔ IT NEVER INVENTS A LABEL. A token whose wording we do not own is offered in
 * the vendor's own words: a prettified guess is how a rule ends up written
 * against a value that does not exist.
 */
function optionsFrom(tokens, labels) {
  const raw = tokens instanceof Set ? [...tokens]
    : Array.isArray(tokens) ? tokens
      : tokens && typeof tokens === 'object' ? Object.keys(tokens) : [];
  return raw
    .filter((v) => v != null && v !== '')
    .map((v) => opt(String(v), labels && labels[v] ? labels[v] : String(v)))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Yes / no, spelled the way the builder's other enums are. */
const YES_NO = [opt('yes', 'Yes'), opt('no', 'No')];

/**
 * THE STATE LIST IS THE FIFTY-TWO POSTAL CODES, and it is written out because
 * there is no registry of them in this product to derive it from. It is a closed
 * list that has not changed in fifty years — the "generate, don't hand-maintain"
 * rule is about lists that MOVE.
 */
const STATES = ('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO '
  + 'MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR')
  .split(' ').map((s) => opt(s));

/**
 * ── THE FIELDS ──────────────────────────────────────────────────────────────
 *
 * `group` is what the builder puts them under. `source` says where the value
 * comes from and is the contract `facts.js` fills:
 *
 *   scenario — what the officer searched for
 *   property — where the property is (read off the scenario, named separately
 *              because "the property is in this state" is how a person thinks)
 *   quote    — the priced row itself: the investor, the rate, the price, the term
 *   engine   — which board this is and which rate sheet the row came from
 */
const FIELDS = [
  // ── The loan ───────────────────────────────────────────────────────────────
  { key: 'loan_amount', label: 'Loan amount', type: 'money', group: 'Loan', source: 'scenario' },
  { key: 'loan_purpose', label: 'Loan purpose', type: 'enum', group: 'Loan', source: 'scenario',
    options: [opt('Purchase'), opt('Refinance'), opt('CashOutRefinance', 'Cash-out refinance')] },
  { key: 'ltv', label: 'LTV (%)', type: 'pct', group: 'Loan', source: 'scenario' },
  { key: 'fico', label: 'FICO', type: 'number', group: 'Loan', source: 'scenario' },
  { key: 'dscr', label: 'DSCR', type: 'number', group: 'Loan', source: 'scenario' },
  { key: 'dscr_band', label: 'DSCR band', type: 'enum', group: 'Loan', source: 'scenario',
    help: 'The band the DSCR falls in — the same eleven the bracket search walks.',
    /* THE TIER NUMBER IS THE VALUE and `tierLabel` writes the words. The first
       cut read `t.key`/`t.label`, which this ladder does not carry — every one
       of the eleven options came out as the string "undefined", so a rule about
       a DSCR band could be built, saved and never match. Read the ladder's own
       accessor, never a field name guessed from the shape of another table. */
    options: (Array.isArray(dscrTiers.DSCR_TIERS) ? dscrTiers.DSCR_TIERS : [])
      .map((t) => opt(String(t.tier), dscrTiers.tierLabel(t.tier))) },
  { key: 'cashout_amount', label: 'Cash out', type: 'money', group: 'Loan', source: 'scenario' },
  { key: 'subordinate_loan_amount', label: 'Subordinate financing', type: 'money', group: 'Loan', source: 'scenario' },
  { key: 'reserves_months', label: 'Reserves (months)', type: 'number', group: 'Loan', source: 'scenario' },
  { key: 'term_years', label: 'Term (years)', type: 'number', group: 'Loan', source: 'scenario' },
  { key: 'lock_days', label: 'Lock (days)', type: 'number', group: 'Loan', source: 'scenario' },
  { key: 'interest_only', label: 'Interest only', type: 'boolean', group: 'Loan', source: 'scenario' },
  { key: 'escrow_waived', label: 'Escrows waived', type: 'boolean', group: 'Loan', source: 'scenario' },

  // ── Prepayment penalty ─────────────────────────────────────────────────────
  // The owner's own worked example turns on this pair: *"it has prepayment
  // penalty is not no prepay"*. Both halves are offered because a sheet can
  // express the same loan either way — a structure of "None", or a term of zero.
  { key: 'prepay_months', label: 'Prepayment penalty (months)', type: 'number', group: 'Prepayment', source: 'scenario',
    help: 'Zero means no prepayment penalty.' },
  { key: 'prepay_structure', label: 'Prepayment penalty structure', type: 'enum', group: 'Prepayment', source: 'scenario',
    options: optionsFrom(lp.PREPAY_STRUCTURES) },
  { key: 'has_prepay', label: 'Has a prepayment penalty', type: 'boolean', group: 'Prepayment', source: 'scenario',
    help: 'Yes whenever the penalty runs for one month or more.' },

  // ── The property ───────────────────────────────────────────────────────────
  { key: 'state', label: 'State', type: 'enum', group: 'Property', source: 'property', options: STATES },
  { key: 'county', label: 'County', type: 'text', group: 'Property', source: 'property' },
  { key: 'city', label: 'City', type: 'text', group: 'Property', source: 'property' },
  { key: 'zip', label: 'ZIP code', type: 'text', group: 'Property', source: 'property' },
  { key: 'property_type', label: 'Property type', type: 'enum', group: 'Property', source: 'property',
    options: optionsFrom(lp.PROPERTY_TYPES) },
  { key: 'units', label: 'Units', type: 'number', group: 'Property', source: 'property' },
  { key: 'attachment_type', label: 'Attached or detached', type: 'text', group: 'Property', source: 'property' },
  { key: 'non_warrantable', label: 'Non-warrantable condo', type: 'boolean', group: 'Property', source: 'property' },
  { key: 'rural', label: 'Rural', type: 'boolean', group: 'Property', source: 'property' },
  { key: 'mixed_use', label: 'Mixed use', type: 'boolean', group: 'Property', source: 'property' },
  { key: 'property_value', label: 'Property value', type: 'money', group: 'Property', source: 'property' },
  { key: 'as_is_value', label: 'As-is value', type: 'money', group: 'Property', source: 'property' },
  { key: 'rental_term', label: 'Rental term', type: 'text', group: 'Property', source: 'property',
    help: 'Long-term or short-term, as the search stated it.' },

  // ── The borrower's file ────────────────────────────────────────────────────
  // Facts about the DEAL, never about the person.
  { key: 'borrower_type', label: 'Borrower type', type: 'enum', group: 'Borrower', source: 'scenario',
    options: optionsFrom(lp.BORROWER_TYPES) },
  { key: 'citizenship', label: 'Citizenship', type: 'enum', group: 'Borrower', source: 'scenario',
    options: optionsFrom(lp._tokens && lp._tokens.CITIZENSHIP) },
  { key: 'first_time_investor', label: 'First-time investor', type: 'boolean', group: 'Borrower', source: 'scenario' },
  { key: 'first_time_home_buyer', label: 'First-time home buyer', type: 'boolean', group: 'Borrower', source: 'scenario' },
  { key: 'self_employed', label: 'Self-employed', type: 'boolean', group: 'Borrower', source: 'scenario' },
  { key: 'financed_properties', label: 'Financed properties', type: 'number', group: 'Borrower', source: 'scenario' },
  { key: 'number_of_borrowers', label: 'Number of borrowers', type: 'number', group: 'Borrower', source: 'scenario' },
  { key: 'income_doc_type', label: 'Income documentation', type: 'enum', group: 'Borrower', source: 'scenario',
    options: optionsFrom(lp.INCOME_DOC_TYPES) },
  { key: 'tradelines', label: 'Tradelines', type: 'enum', group: 'Borrower', source: 'scenario',
    options: optionsFrom(lp._tokens && lp._tokens.TRADELINES) },
  { key: 'no_mortgage_history', label: 'No mortgage history', type: 'boolean', group: 'Borrower', source: 'scenario' },
  { key: 'living_rent_free', label: 'Living rent free', type: 'boolean', group: 'Borrower', source: 'scenario' },
  { key: 'cross_collateral', label: 'Cross collateral', type: 'boolean', group: 'Borrower', source: 'scenario' },

  // ── Credit events ──────────────────────────────────────────────────────────
  { key: 'foreclosure', label: 'Foreclosure', type: 'enum', group: 'Credit events', source: 'scenario',
    options: optionsFrom(lp._tokens && lp._tokens.FORECLOSURE) },
  { key: 'short_sale', label: 'Short sale', type: 'enum', group: 'Credit events', source: 'scenario',
    options: optionsFrom(lp._tokens && lp._tokens.SHORTSALE) },
  { key: 'deed_in_lieu', label: 'Deed in lieu', type: 'enum', group: 'Credit events', source: 'scenario',
    options: optionsFrom(lp._tokens && lp._tokens.DEEDINLIEU) },
  { key: 'charge_off', label: 'Mortgage charge-off', type: 'enum', group: 'Credit events', source: 'scenario',
    options: optionsFrom(lp._tokens && lp._tokens.CHARGEOFF) },
  { key: 'forbearance', label: 'Forbearance', type: 'enum', group: 'Credit events', source: 'scenario',
    options: optionsFrom(lp._tokens && lp._tokens.FORBEARANCE) },
  { key: 'bankruptcy_chapter', label: 'Bankruptcy chapter', type: 'enum', group: 'Credit events', source: 'scenario',
    options: optionsFrom(lp._tokens && lp._tokens.BK_CHAPTER) },
  { key: 'late_in_last_12_months', label: 'Late in the last 12 months', type: 'boolean', group: 'Credit events', source: 'scenario' },

  // ── The quoted row ─────────────────────────────────────────────────────────
  // ⛔ STAFF-ONLY BY CONSTRUCTION. `investor` is the real capital provider and
  // `white_label` is the client-safe name. This registry is only ever read
  // behind the super-admin door and by the overlay; nothing here reaches a
  // client, and the investor name rule (CLAUDE.md rule 10) is unchanged — a rule
  // may ASK about an investor, and what a client sees is still built by the
  // term-sheet door out of the client-safe name alone.
  { key: 'investor', label: 'Investor', type: 'text', group: 'The quote', source: 'quote',
    help: 'The capital provider behind the quote. Internal only.' },
  { key: 'investor_key', label: 'Investor (key)', type: 'text', group: 'The quote', source: 'quote' },
  { key: 'white_label', label: 'White-label name', type: 'text', group: 'The quote', source: 'quote' },
  { key: 'lender', label: 'Lender', type: 'text', group: 'The quote', source: 'quote' },
  { key: 'program_name', label: 'Program name', type: 'text', group: 'The quote', source: 'quote' },
  { key: 'product', label: 'Product', type: 'text', group: 'The quote', source: 'quote' },
  { key: 'note_rate', label: 'Note rate (%)', type: 'pct', group: 'The quote', source: 'quote' },
  { key: 'price', label: 'Price', type: 'number', group: 'The quote', source: 'quote' },
  { key: 'points', label: 'Points', type: 'number', group: 'The quote', source: 'quote' },
  { key: 'quoted_term_years', label: 'Quoted term (years)', type: 'number', group: 'The quote', source: 'quote' },
  { key: 'quoted_lock_days', label: 'Quoted lock (days)', type: 'number', group: 'The quote', source: 'quote' },
  { key: 'amortization', label: 'Amortization', type: 'text', group: 'The quote', source: 'quote' },
  { key: 'quoted_ltv', label: 'Quoted LTV (%)', type: 'pct', group: 'The quote', source: 'quote' },
  { key: 'quoted_dscr', label: 'Quoted DSCR', type: 'number', group: 'The quote', source: 'quote' },
  { key: 'margin_holdback', label: 'Margin holdback already applied', type: 'number', group: 'The quote', source: 'quote' },

  // ── Where the price came from ──────────────────────────────────────────────
  // The owner's own example: *"if the pricing is being pulled from Loanex …"*.
  { key: 'source', label: 'Rate sheet', type: 'enum', group: 'Where it came from', source: 'engine',
    options: [opt('loannex', 'LoanNEX'), opt('lenderprice', 'Lender Price')] },
  { key: 'engine', label: 'Pricing engine', type: 'enum', group: 'Where it came from', source: 'engine',
    options: [opt('general', 'General Pricing Engine'), opt('combined', 'Combined Pricing Engine')] },
];

/** `{key -> field}`, the shape the shared rule grammar takes as `fields`. */
const BY_KEY = Object.freeze(FIELDS.reduce((m, f) => { m[f.key] = f; return m; }, {}));

/** The builder's own ordering: groups in the order they are declared above. */
function grouped() {
  const order = [];
  const byGroup = new Map();
  for (const f of FIELDS) {
    if (!byGroup.has(f.group)) { byGroup.set(f.group, []); order.push(f.group); }
    byGroup.get(f.group).push(f);
  }
  return order.map((group) => ({ group, fields: byGroup.get(group) }));
}

/** Every field key, for a guard that wants to compare against another list. */
const KEYS = Object.freeze(FIELDS.map((f) => f.key));

/**
 * The scenario/property keys, which the pricer route is the authority on. Split
 * out so the guard test can compare exactly these against `SUPPORTED_FIELDS` and
 * leave the quote/engine fields — which are answers, not inputs — out of it.
 */
const SCENARIO_KEYS = Object.freeze(
  FIELDS.filter((f) => f.source === 'scenario' || f.source === 'property').map((f) => f.key));

module.exports = { FIELDS, BY_KEY, KEYS, SCENARIO_KEYS, grouped, STATES, YES_NO, _internals: { optionsFrom } };
