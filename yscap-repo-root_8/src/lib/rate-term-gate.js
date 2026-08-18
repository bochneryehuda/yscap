'use strict';
/**
 * THE RATE-AND-TERM $2,000 CASH LIMIT + the itemized closing costs that feed it
 * (owner-directed 2026-08-18, verbatim: "You always need to add logic to make
 * sure that it's following standard rate-and-term requirements. You can't get
 * more than $2,000 back in your pocket initially … the initial loan amount
 * cannot be more than $2,000 more than the payoff and all the closing costs.
 * When you're saying that the property is free and clear, that needs to be on
 * the standard that the initial amount, if it's a rate-and-term, cannot be more
 * than $2,000, or you need to change the transaction type to a cash-out
 * transaction. This gate and logic should be added before you can send out a
 * term sheet for e-signature. … bring up a nice note on the structure screen …
 * a red warning that the cash to the borrower is too much for a rate-and-term …
 * You can always request an exception from super admin … I don't want to block
 * without a way out. … you should have a button over there to validate the
 * closing costs. A lot of times, the system is not getting the closing costs
 * correctly. If you're bringing up the closing costs, then it's less cash to
 * the borrower … title fees … custom title fees, mortgage tax, transfer tax …
 * attorney fees … It should still be possible to be a rate-and-term.")
 *
 * THE MATH IS ONE LINE AND IT IS THE PAYOFF MODEL'S OWN: cash to the borrower =
 * initial advance − payoff − ALL closing costs, where the closing costs are the
 * registered quote's own dueAtClosing figure PLUS the itemized fees a staffer
 * validates into closing_cost_items (db/577 — title fees, mortgage tax,
 * transfer tax, attorney fees, custom). The frozen engines are untouched: this
 * is a LAYERED READ over the registered quote, never a pricing input, and
 * nothing here changes a loan's size or rate.
 *
 * WHERE IT BITES, and where it only WARNS:
 *   - the term-sheet e-sign SEND gate (esign/gate.js) carries the blocker,
 *     code 'rate_term_cash' — so it inherits the per-requirement waiver of the
 *     esign-before-ctc exception flow for free;
 *   - an APPROVED 'rate_term_cash' loan exception (super-admin decided in the
 *     ordinary exceptions box) lifts it — the owner's "never block without a
 *     way out";
 *   - the STRUCTURE screen (outside the generator) shows the red warning +
 *     the "Validate closing costs" editor + the request-exception button —
 *     advisory there, never a block.
 *
 * SCOPE: a DEFINITE rate-&-term refinance only (payoff.KIND.RATE_TERM). An
 * unclear refinance is never hard-gated on a classification nobody has made —
 * the payoff model's advisory purposeNote already nags those. Free-and-clear
 * rides through the payoff of record ($0), which is exactly what makes a
 * free-and-clear "rate-&-term" read as cash the borrower is taking out.
 */
const db = require('../db');
const payoffLib = require('./payoff');
const NB = require('./number-bounds');

const LIMIT = 2000;

/** The fee categories the editor offers — 'custom' carries its own typed name. */
const COST_KINDS = Object.freeze({
  title_fee: 'Title fee',
  mortgage_tax: 'Mortgage tax',
  transfer_tax: 'Transfer tax',
  attorney_fee: 'Attorney fee',
  recording_fee: 'Recording fee',
  escrow_fee: 'Escrow / settlement fee',
  survey_fee: 'Survey fee',
  custom: 'Other closing cost',
});

/** Validate one typed fee. Returns '' when clean, else the plain-language refusal. */
function itemProblem(b = {}) {
  const kind = String(b.kind || 'custom');
  if (!Object.prototype.hasOwnProperty.call(COST_KINDS, kind)) return 'Pick a fee type from the list.';
  const label = String(b.label == null ? '' : b.label).trim();
  if (!label) return 'Name the fee (e.g. "Title search", "NY mortgage tax").';
  if (label.length > 120) return 'Keep the fee name under 120 characters.';
  const n = Number(b.amount);
  if (!Number.isFinite(n) || n < 0) return 'Enter the fee as a dollar amount (zero or more).';
  const p = NB.columnProblem('amount', n, 'money', 'The fee amount');
  if (p) return p;
  if (b.note != null && String(b.note).length > 500) return 'Keep the note under 500 characters.';
  return '';
}

async function listItems(appId, client = db) {
  return (await client.query(
    `SELECT ci.id, ci.kind, ci.label, ci.amount, ci.note, ci.created_at,
            s.full_name AS created_by_name
       FROM closing_cost_items ci
       LEFT JOIN staff_users s ON s.id = ci.created_by
      WHERE ci.application_id = $1
      ORDER BY ci.created_at ASC, ci.id ASC`, [appId])).rows
    .map((r) => ({ ...r, amount: Number(r.amount) }));
}

async function itemizedTotal(appId, client = db) {
  const r = (await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM closing_cost_items WHERE application_id = $1`, [appId])).rows[0];
  return Number(r.total) || 0;
}

/**
 * The one check every surface reads. Returns:
 *   { applies, registered, kind, kindLabel, freeAndClear,
 *     initialAdvance, payoff, structuralClosingCosts, itemizedClosingCosts, closingCosts,
 *     cashToBorrower, limit, over, exception:{id,decided_at}|null, blocked }
 * `applies` = a definite rate-&-term refinance. `over` = the structure hands the
 * borrower more than the limit. `blocked` = over AND no approved exception —
 * what the send gate enforces. NEVER throws: an unreadable file answers
 * { applies:false } so a display surface degrades to silence, and the send gate
 * treats a throw as "do not add the blocker" (a read hiccup must never stop
 * every send in the building — the register-time warning still stands).
 */
async function check(appId, client = db) {
  try {
    const a = (await client.query(
      `SELECT a.loan_type, a.payoff_amount, a.property_free_and_clear, a.estimated_cash_out,
              pr.quote
         FROM applications a
         LEFT JOIN product_registrations pr ON pr.application_id = a.id AND pr.is_current
        WHERE a.id = $1 LIMIT 1`, [appId])).rows[0];
    if (!a) return { applies: false, registered: false, over: false, blocked: false };

    const kind = payoffLib.refiKind(a.loan_type);
    const applies = kind === payoffLib.KIND.RATE_TERM;
    const quote = a.quote || null;
    const sizing = (quote && quote.sizing) || {};
    const qClosing = (quote && quote.closingCosts) || {};
    const initialAdvance = Number(sizing.initialAdvance != null ? sizing.initialAdvance : sizing.totalLoan);
    const registered = Number.isFinite(initialAdvance) && initialAdvance > 0;
    const freeAndClear = a.property_free_and_clear === true;
    const payoff = freeAndClear ? 0 : (Number(a.payoff_amount) || 0);
    const structuralClosingCosts = Number(qClosing.dueAtClosing) || 0;
    const itemizedClosingCosts = await itemizedTotal(appId, client);
    const closingCosts = structuralClosingCosts + itemizedClosingCosts;
    const cashToBorrower = registered ? Math.max(0, Math.round((initialAdvance - payoff - closingCosts) * 100) / 100) : null;
    const over = !!(applies && registered && cashToBorrower != null && cashToBorrower > LIMIT);

    let exception = null;
    if (over) {
      try {
        const row = await require('./loan-exceptions').approvedForApp(appId, 'rate_term_cash', client);
        if (row) exception = { id: String(row.id), decidedAt: row.decided_at, seq: row.exception_seq };
      } catch (_) { exception = null; }   // fails CLOSED — an unreadable exception never grants
    }

    return {
      applies, registered, kind, kindLabel: payoffLib.KIND_LABEL ? payoffLib.KIND_LABEL[kind] : kind,
      freeAndClear,
      initialAdvance: registered ? initialAdvance : null,
      payoff, structuralClosingCosts, itemizedClosingCosts, closingCosts,
      cashToBorrower, limit: LIMIT, over,
      exception,
      blocked: over && !exception,
    };
  } catch (_) {
    return { applies: false, registered: false, over: false, blocked: false, unreadable: true };
  }
}

const usd = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/** The one wording every surface quotes for the over-limit state. */
function overMessage(c) {
  return `This is a rate-&-term refinance, but the structure hands the borrower ${usd(c.cashToBorrower)} — `
    + `more than the ${usd(LIMIT)} a rate-&-term allows${c.freeAndClear ? ' (the property is free and clear, so there is no payoff absorbing the loan)' : ''}. `
    + 'Switch the transaction to a cash-out, validate the closing costs (real fees the borrower pays reduce the cash), '
    + 'or request a super-admin exception.';
}

module.exports = { LIMIT, COST_KINDS, itemProblem, listItems, itemizedTotal, check, overMessage };
