'use strict';
/**
 * THE PAYOFF — one model of how a refinance payoff works, and what has to be
 * entered for one (owner-directed 2026-07-31).
 *
 * The owner: "We should set up a full section for the system to understand how
 * the payoff works and how it should be entered … if there is a payoff entered
 * as a refinance we need to enter who the lender is, the original lender, and
 * the loan number we're paying off. And also set up, if it's a cash out, how
 * much the cash out is going to be according to the structure — just the field
 * for it."
 *
 * WHY A MODULE AND NOT A SCREEN. Before this the payoff was a lone number in a
 * long form. The studio had a box, the file had a column, and nothing anywhere
 * knew what the number MEANT — so nobody could be told what was still missing,
 * the closing attorney had no way to learn who to send the payoff request to,
 * and a "cash-out" refinance quoted a cash figure the file never carried. Each
 * surface guessed. This module is the ONE place that answers:
 *
 *   · is this deal even a refinance, and which kind (rate-&-term or cash-out)?
 *   · what MUST be entered for it, and what is still missing?
 *   · what does the structure imply the borrower actually receives?
 *
 * Everything here is PURE — no database, no network, no throwing. It is fed the
 * application row and (optionally) the registered quote, and returns a plain
 * object. That way the staff card, the API and the tests all read the same
 * answer, and it can never disagree with itself.
 *
 * IT CHANGES NO GUIDELINE. Every number below is arithmetic on figures the
 * FROZEN pricing engine already produced (the sized loan, the initial advance,
 * the closing costs). No cap, no rate, no sizing rule is read or written here.
 */

const { normLoanPurpose } = require('./conditions/field-registry');

const KIND = {
  PURCHASE: 'purchase',
  RATE_TERM: 'rate_term',
  CASH_OUT: 'cash_out',
  UNKNOWN: 'unknown',
};

const KIND_LABEL = {
  [KIND.PURCHASE]: 'Purchase',
  [KIND.RATE_TERM]: 'Refinance — rate & term',
  [KIND.CASH_OUT]: 'Refinance — cash-out',
  [KIND.UNKNOWN]: 'Refinance',
};

/* The loan purpose, classified. REUSES the conditions engine's own normalizer so
   "how the Condition Center reads this file" and "how the payoff section reads
   this file" can never drift — the same trap the free-text `term` and
   `property_type` fields fell into. A refinance whose label says neither
   rate-&-term nor cash-out is UNKNOWN, not a guess: we still need the payoff,
   we just cannot say yet whether cash comes out. */
function refiKind(loanType) {
  const s = String(loanType == null ? '' : loanType);
  const norm = normLoanPurpose(s);
  if (norm === 'refinance_cash_out') return KIND.CASH_OUT;
  if (norm === 'refinance_rate_term') {
    /* normLoanPurpose folds EVERY non-cash-out refinance onto rate-&-term, which
       is right for a condition rule (it has to pick one) and wrong for this
       section: a bare "Refinance" — the spelling legacy and ClickUp data carry —
       would be announced as rate-&-term and would silently hide the cash-out
       field on a deal that may well be one. So we only call it rate-&-term when
       the label actually says so, and otherwise say plainly that we do not know.
       This narrows a DISPLAY reading only; the engine's own classification is
       untouched. */
    return /rate\s*(&|and)?\s*term/i.test(s) ? KIND.RATE_TERM : KIND.UNKNOWN;
  }
  if (norm === 'purchase') return KIND.PURCHASE;
  // 'other' / null — a blank or unrecognized purpose. Only call it a refinance
  // when the raw text actually says so; otherwise it is not our business.
  return /refi/i.test(s) ? KIND.UNKNOWN : KIND.PURCHASE;
}

function isRefinance(loanType) { return refiKind(loanType) !== KIND.PURCHASE; }
function isCashOut(loanType) { return refiKind(loanType) === KIND.CASH_OUT; }

function num(v) {
  /* TRIMMED FIRST (audit round 4, 2026-07-31). `Number('   ')` is 0, so a
     whitespace-only value read as a typed ZERO here while the studio — whose
     reader trims — read it as blank and fell back to the structure. The two then
     quoted different cash for the same deal. A box containing spaces is empty. */
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function text(v) {
  const s = String(v == null ? '' : v).trim();
  return s ? s : '';
}

/* WHAT THE STRUCTURE IMPLIES THE BORROWER RECEIVES AT THE TABLE.
 *
 * The money that actually funds on closing day is the INITIAL ADVANCE — not the
 * whole loan. A renovation loan's rehab holdback is released later, draw by
 * draw, against work completed, and a financed interest reserve is held back
 * too (`totalLoan = initialAdvance + rehabHoldback + financedReserve`, the
 * frozen reconciliation in pricing.js). Netting a payoff off the TOTAL would
 * quote a borrower money they will not see for months — on a heavy-rehab
 * refinance that overstates the cheque by the entire construction budget.
 *
 * So: what funds at closing, less the loan being retired, less the closing
 * costs due at closing. Never negative — a payoff-only refinance shows $0, not
 * a minus, because the borrower does not receive a negative cheque (a shortfall
 * is cash they must BRING, which is what cash-to-close already reports).
 */
function structuralCashOut(d) {
  const at = d || {};
  const funded = num(at.initialAdvance) != null ? num(at.initialAdvance) : num(at.totalLoan);
  if (funded == null || !(funded > 0)) return null;
  const payoff = num(at.payoff) || 0;
  const closing = num(at.closingCosts) || 0;
  return Math.max(0, funded - payoff - closing);
}

/* The figure OF RECORD: whatever a human typed, else what the structure implies.
   A typed value wins because a real deal can net differently — a junior lien
   nobody modelled, a holdback, an escrow — and the number that matters is the
   one actually going to the borrower. `source` says which it is, so no screen
   ever has to guess whose number it is showing.

   ZERO IS A TYPED ANSWER, NOT AN EMPTY BOX (post-merge audit 2026-07-31). The
   test used to be `typed > 0`, so an officer who typed 0 — on a deal that
   genuinely nets the borrower nothing, which is exactly the case where the
   structural figure is most wrong — was told "saved", and then every screen and
   the printed term sheet went on quoting the structural number instead. BLANK is
   what means "use the structure", and `num()` already answers null for blank, so
   the only test needed is `!= null`. A NEGATIVE is not an answer at all (nobody
   receives a negative cheque) and is refused at both write doors. */
function cashOutOfRecord(d) {
  const typed = num((d || {}).typed);
  const structural = structuralCashOut(d);
  if (typed != null && typed >= 0) return { amount: typed, source: 'typed', structural };
  if (structural != null) return { amount: structural, source: 'structure', structural };
  return { amount: null, source: null, structural: null };
}

/* WHAT IS ASKED FOR, and why — in the owner's own terms.
 *
 * NOTHING HERE IS REQUIRED (owner-directed 2026-08-18, verbatim: "The account
 * number should not be required, just the name and the amount, how much it is,
 * and the good-through date. The amount, how much it is, and to whom the payoff
 * is being laid out should also not be required."). So every `required` flag is
 * false — the card labels the fields as optional and nothing anywhere gates on
 * them (the missing list is display-only; the audit confirmed no sign-off gate
 * reads `ready`).
 *
 * `asked` is the separate, softer idea: a blank the screen still POINTS AT as
 * "not filled in yet", because the reasons to fill it are real — an amount
 * alone tells the closing attorney nothing, and a payoff wired without the
 * lender's own loan number sits unapplied. Asked, never nagged as required.
 *
 * The cash-out amount is OPTIONAL-with-a-default: the structure already implies
 * a figure, so the field exists to OVERRIDE it, not to retype arithmetic.
 */
const REQUIREMENTS = [
  { key: 'payoffAmount', column: 'payoff_amount', label: 'Payoff amount',
    why: 'The balance needed to clear the loan already on the property. Every refinance has one.',
    kinds: [KIND.RATE_TERM, KIND.CASH_OUT, KIND.UNKNOWN], required: false, asked: true },
  { key: 'payoffLender', column: 'payoff_lender', label: 'Lender being paid off',
    why: 'Who holds the loan today — the bank, private lender or servicer the payoff request goes to. Without a name nobody can order the payoff letter.',
    kinds: [KIND.RATE_TERM, KIND.CASH_OUT, KIND.UNKNOWN], required: false, asked: true, needsPayoff: true },
  { key: 'payoffLoanNumber', column: 'payoff_loan_number', label: 'Their loan number',
    why: 'The existing lender’s own loan or account number. A payoff wired without it sits unapplied.',
    kinds: [KIND.RATE_TERM, KIND.CASH_OUT, KIND.UNKNOWN], required: false, asked: true, needsPayoff: true },
  /* The payoff letter's GOOD-THROUGH date (db/575) — asked for on the card,
     never listed as "not filled in yet": interest accrues daily and the working
     figure is often on file before the letter that states its expiry. */
  { key: 'payoffGoodThrough', column: 'payoff_good_through', label: 'Payoff good through',
    why: 'The date the payoff quote is valid through, off the payoff letter. After it, the figure must be re-quoted.',
    kinds: [KIND.RATE_TERM, KIND.CASH_OUT, KIND.UNKNOWN], required: false, needsPayoff: true },
  { key: 'estimatedCashOut', column: 'estimated_cash_out', label: 'Cash out to the borrower',
    why: 'What the borrower walks away with after the payoff and the closing costs. Fills in from the structure — type a number only to override it.',
    kinds: [KIND.CASH_OUT], required: false },
];

/* HOW IT WORKS, in plain words — the same explanation on every surface, so the
   file itself teaches the step instead of relying on somebody having been told.
   Written for a person, not a developer. */
function howItWorks(kind) {
  const common = [
    'A refinance pays off the loan that is already on the property. Our new loan funds, the old lender is paid in full at the closing table, and their lien comes off the title.',
    'To do that the closing attorney needs three things from us: how much to pay, who to pay, and which loan of theirs it is. That is exactly what this section collects.',
    'The payoff figure comes from the existing lender’s own payoff letter. It changes with the date — interest accrues daily — so the number on the file is the working figure until the final letter arrives at closing.',
  ];
  if (kind === KIND.CASH_OUT) {
    return common.concat([
      'This is a CASH-OUT refinance: after the old loan is paid off and the closing costs are covered, the borrower keeps the difference. That is the number in “Cash out to the borrower”.',
      'It is worked out from what actually funds on closing day — the initial advance — not the whole loan. On a renovation loan the construction money is held back and released in draws, so it is not cash in the borrower’s pocket at closing.',
    ]);
  }
  if (kind === KIND.RATE_TERM) {
    return common.concat([
      'This is a RATE-&-TERM refinance: the new loan replaces the old one and the borrower takes essentially no cash out. So there is a payoff here, and no cash-out figure.',
    ]);
  }
  return common.concat([
    'The loan purpose does not yet say whether this is a rate-&-term or a cash-out refinance. Set it on the application details and this section will say what else is needed.',
  ]);
}

/**
 * The whole payoff picture for one file.
 *
 * @param {object} app  the applications row (snake_case columns).
 * @param {object} [quote]  the CURRENT registration's normalized quote, when the
 *        file has been registered. Only `sizing.initialAdvance` /
 *        `sizing.totalLoan` / `closingCosts.dueAtClosing` are read — all of them
 *        figures the frozen engine already produced.
 *
 *        IT IS `sizing`, NOT `structure` (audit-found 2026-07-31). A first cut
 *        read `quote.structure`, a key `pricing.js normalize()` has never
 *        produced — every other consumer in the repo reads `quote.sizing`. The
 *        result was silent and total: `canDerive` was false on EVERY registered
 *        file, so the cash-out figure the owner asked for never appeared, the
 *        derivation was never shown, and the rate-&-term-nets-cash advisory
 *        could never fire. `closingCosts` was right, which is exactly why it did
 *        not look broken.
 * @returns {object} never throws; a bad/absent input degrades to "cannot derive".
 */
function payoffState(app, quote) {
  const a = app || {};
  const kind = refiKind(a.loan_type);
  const applies = kind !== KIND.PURCHASE;

  const entered = {
    payoffAmount: num(a.payoff_amount),
    payoffLender: text(a.payoff_lender),
    payoffLoanNumber: text(a.payoff_loan_number),
    payoffGoodThrough: text(a.payoff_good_through),
    estimatedCashOut: num(a.estimated_cash_out),
  };
  const hasPayoff = entered.payoffAmount != null && entered.payoffAmount > 0;
  /* PROPERTY OWNED FREE AND CLEAR (db/575) — there is NO loan to pay off, so
     nothing here is missing and the payoff of record is $0. The flag is a
     staff-confirmed fact; both payoff conditions retract/waive on it. */
  const freeAndClear = a.property_free_and_clear === true;

  const q = quote || {};
  const sizing = q.sizing || {};
  const closing = q.closingCosts || {};
  const derivedInputs = {
    initialAdvance: num(sizing.initialAdvance),
    totalLoan: num(sizing.totalLoan),
    closingCosts: num(closing.dueAtClosing),
    payoff: entered.payoffAmount || 0,
    typed: entered.estimatedCashOut,
  };
  const record = cashOutOfRecord(derivedInputs);
  const derived = {
    initialAdvance: derivedInputs.initialAdvance,
    totalLoan: derivedInputs.totalLoan,
    closingCosts: derivedInputs.closingCosts,
    structuralCashOut: record.structural,
    cashOut: record.amount,
    cashOutSource: record.source,
    // A file with no registered structure cannot imply anything — say so rather
    // than showing a zero that reads like a real answer.
    canDerive: record.structural != null,
  };

  const missing = [];
  if (applies && !freeAndClear) {
    for (const r of REQUIREMENTS) {
      if (!r.asked) continue;   // nothing is REQUIRED (owner 2026-08-18); `asked` fields are pointed at while blank
      if (!r.kinds.includes(kind)) continue;
      // WHO/WHICH are asked for only once there is an amount to pay — nagging for
      // the lender's loan number on a file that has not stated a payoff yet is
      // noise, and the owner's rule is "if there is a payoff entered".
      if (r.needsPayoff && !hasPayoff) continue;
      const v = entered[r.key];
      const blank = (typeof v === 'string') ? v === '' : (v == null || !(v > 0));
      if (blank) missing.push({ key: r.key, column: r.column, label: r.label, why: r.why });
    }
  }

  /* ADVISORY ONLY — a rate-&-term whose structure hands the borrower real money
     is economically a cash-out. We SAY so and change nothing: no status, no
     classification column, no pricing. Somebody who knows the deal decides
     whether the purpose is mislabelled or the structure is about to change. */
  let purposeNote = null;
  if (kind === KIND.RATE_TERM && derived.canDerive && derived.structuralCashOut > 0 && hasPayoff) {
    purposeNote = {
      kind: 'rate_term_nets_cash',
      text: 'This is labelled rate-&-term, but after the payoff and closing costs the structure still hands the borrower money. Check whether it is really a cash-out refinance.',
      amount: derived.structuralCashOut,
    };
  }

  return {
    applies,
    kind,
    kindLabel: KIND_LABEL[kind] || KIND_LABEL[KIND.UNKNOWN],
    isCashOut: kind === KIND.CASH_OUT,
    hasPayoff,
    freeAndClear,
    entered,
    fields: REQUIREMENTS.filter((r) => r.kinds.includes(kind))
      .map((r) => ({ key: r.key, column: r.column, label: r.label, why: r.why, required: !!r.required })),
    missing,
    ready: applies ? missing.length === 0 : true,
    derived,
    purposeNote,
    howItWorks: howItWorks(kind),
  };
}

/* WHO holds the loan and WHICH loan it is — the two fields that are pure
   LOGISTICS, carrying no money and entering no calculation. Named here, once, so
   the freeze carve-out that depends on them (file-lock.payoffContactLockReason)
   can never drift from the model. */
const CONTACT_KEYS = ['payoffLender', 'payoffLoanNumber'];

/**
 * Is this edit ONLY the payoff's who/which — no amount, no cash-out, nothing
 * else at all? Used by the freeze carve-out, so it is deliberately strict: any
 * other key in the body, or an empty body, answers false.
 */
/**
 * THE CONDITIONS "the property is free and clear" ANSWERS — one list, in one place.
 *
 * Owner-directed 2026-08-24: *"There are a few conditions: asking for a payoff, asking to verify
 * the payoff, asking maybe for a VOM. Those payoff conditions are about the old mortgage … mark
 * over there that the property is free and clear, and that should waive the payoff condition, the
 * verified payoff condition, and the VOM condition."*
 *
 * Every one of these asks about a loan that does not exist once the property is confirmed free and
 * clear, so every one of them is answered by that confirmation rather than left for somebody to
 * chase a statement nobody can produce.
 *
 * WHY IT IS A CONSTANT. The free-and-clear route names this set THREE times — waive, un-waive, and
 * strip the stale note — and a fourth list lives in the engine's own rules. Three hand-typed
 * `IN (…)` lists in one route is three chances to add a condition to one and forget the others,
 * and the failure is silent and asymmetric: a condition added to the WAIVE list but not the
 * UN-WAIVE list can never be reopened, so turning free-and-clear off would leave it waived on a
 * file that genuinely has a mortgage to pay off. Adding a condition here adds it to all three.
 *
 * WHAT IS DELIBERATELY NOT HERE. There is NO verification-of-mortgage (VOM) condition on the
 * short-term side — checked across the template library, the rule-driven refinance set and every
 * hand-typed condition on file, and it does not exist. It exists only in the LONG-TERM Encompass
 * condition library, which is a different product and may not be copied here without the owner's
 * written authorisation (`docs/LONG-TERM-AUTHORIZED-COPIES.md`). Whether the short-term product
 * should ask for one at all is a business rule, so it is the owner's to state — and when they do,
 * it is ONE entry in this array and nothing else.
 *
 * `cond_cashout_letter` is the other refinance-gated condition and is deliberately absent: it asks
 * the borrower WHY they are taking cash out, which is a question about this new loan, not about
 * an old mortgage — a free-and-clear cash-out refinance still has to answer it.
 */
const FREE_AND_CLEAR_WAIVES = Object.freeze([
  'cond_payoff_external',   // "Current mortgage / payoff statement (existing loan)" — the payoff
  'cond_payoff_internal',   // "Payoff verified — statement ordered, figure & lender confirmed"
]);

function isPayoffContactOnlyEdit(body) {
  const keys = Object.keys(body || {});
  if (!keys.length) return false;
  return keys.every((k) => CONTACT_KEYS.includes(k));
}

module.exports = {
  CONTACT_KEYS,
  FREE_AND_CLEAR_WAIVES,
  isPayoffContactOnlyEdit,
  KIND,
  KIND_LABEL,
  REQUIREMENTS,
  refiKind,
  isRefinance,
  isCashOut,
  structuralCashOut,
  cashOutOfRecord,
  howItWorks,
  payoffState,
};
