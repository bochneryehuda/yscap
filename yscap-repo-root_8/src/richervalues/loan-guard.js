'use strict';
/**
 * Richer Value — THE $400,000 LOAN-AMOUNT GUARD.
 *
 * THE OWNER'S RULE (2026-08-14): *"We wanna put a strict warning and a double
 * confirmation. If any loan amount is more than $400,000, we don't recommend Richer
 * Value, and our investors might not accept. Before proceeding, you're gonna need a
 * warning if the loan amount is more than $400,000 registered. If there is no loan
 * amount registered yet, just let them know that it's better if they registered the
 * loan amount before, because Richer Value sees what we expect. You can tell them
 * that there's a limit of a $400,000 loan amount for this product type."*
 *
 * So there are THREE states, and only one of them is a plain go-ahead:
 *
 *   ok        a registered loan amount at or under $400,000 → order normally.
 *   advise    NO loan amount registered yet → say why registering first matters
 *             (Richer Value is SHOWN what we expect, so an order placed before the
 *             loan is registered tells them nothing) and state the limit. The
 *             staffer may still proceed — this is advice, not a refusal.
 *   warn      a registered loan amount OVER $400,000 → the strict warning, and the
 *             DOUBLE confirmation: the screen asks twice and the SERVER refuses
 *             the order unless the second acknowledgement is sent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A PURE MODULE, AND WHY IT NEVER REFUSES OUTRIGHT
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE because both halves of a double confirmation have to agree about what is
 * being confirmed: the screen renders this wording and the route enforces it, and
 * a second copy of the threshold in a React file is exactly how the two drift
 * until the button says one thing and the server does another.
 *
 * NEVER A REFUSAL because the owner's words are *"we don't recommend"* and *"our
 * investors MIGHT not accept"* — a business judgement about a deal, not a rule of
 * arithmetic. The recorded way past it is a human saying yes twice, and the
 * acknowledgement is journalled with the order so the file answers "who decided to
 * order this anyway, and did they know?" years later. A hard block would leave a
 * desk with a legitimate exception no way forward at all — the dead-end class this
 * repo has been bitten by repeatedly.
 */

// The repo's ONE definition of what a money value means. `lib/fields.js` has no
// requires of its own, so taking it does not cost this module its purity — and it
// matters here: a grouped "500,000" read by a bare `Number()` is NaN, which would
// be judged as "no loan amount registered" and let an over-limit order through
// with only advice instead of the strict warning.
const { moneyValue } = require('../lib/fields');

/** The owner's number. One definition; the screen reads it from the server. */
const LOAN_LIMIT = 400000;

/** A stable token the route matches on, so a stale screen cannot confirm a
 *  warning it never showed. */
const ACK = 'over_400k';

function money(n) {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/**
 * Judge a loan amount against the rule.
 *
 * @param {number|string|null} loanAmount  the file's REGISTERED loan amount
 * @returns {{level:'ok'|'advise'|'warn', requiresDoubleConfirm:boolean, ack:string|null,
 *            limit:number, loanAmount:number|null, title:string|null, message:string|null,
 *            confirmPrompt:string|null, secondPrompt:string|null}}
 */
function judgeLoanAmount(loanAmount) {
  const n = moneyValue(loanAmount);
  const amount = Number.isFinite(n) && n > 0 ? n : null;

  if (amount == null) {
    return {
      level: 'advise',
      requiresDoubleConfirm: false,
      ack: null,
      limit: LOAN_LIMIT,
      loanAmount: null,
      title: 'No loan amount is registered on this file yet',
      message:
        'It is better to register the loan amount before ordering. Richer Value is SHOWN what we expect — '
        + 'the loan amount, the As-Is value and the ARV all go over with the order — so ordering before the '
        + `loan is registered tells them nothing about the deal. Also worth knowing: this product is meant for `
        + `loans up to ${money(LOAN_LIMIT)}. You can still order now if you need to.`,
      confirmPrompt: null,
      secondPrompt: null,
    };
  }

  if (amount > LOAN_LIMIT) {
    return {
      level: 'warn',
      requiresDoubleConfirm: true,
      ack: ACK,
      limit: LOAN_LIMIT,
      loanAmount: amount,
      title: `This loan is ${money(amount)} — we do not recommend Richer Value over ${money(LOAN_LIMIT)}`,
      message:
        `This product type is meant for loans up to ${money(LOAN_LIMIT)}, and this file is registered at `
        + `${money(amount)}. We do NOT recommend a Hybrid Appraisal here, and our investors might not accept it — `
        + 'which can mean paying for a second, full appraisal later. If you order anyway, be sure the capital '
        + 'partner on this file will take it.',
      confirmPrompt:
        `Order a Hybrid Appraisal on a ${money(amount)} loan? This is over the ${money(LOAN_LIMIT)} we recommend `
        + 'for this product, and our investors might not accept it.',
      secondPrompt:
        'Last check: our investors might refuse a Hybrid Appraisal on this loan, and the file could need a full '
        + 'appraisal on top of it. Are you sure you want to order it?',
    };
  }

  return {
    level: 'ok',
    requiresDoubleConfirm: false,
    ack: null,
    limit: LOAN_LIMIT,
    loanAmount: amount,
    title: null,
    message: null,
    confirmPrompt: null,
    secondPrompt: null,
  };
}

/**
 * The server half of the double confirmation. `acknowledgements` is whatever the
 * screen sent (an array of tokens, or a single one).
 *
 * FAILS CLOSED: a warning with nothing acknowledged is refused. It only ever
 * refuses the OVER-limit case — the "no loan amount registered" advice is
 * information, and refusing on it would stop ordering on every brand-new file.
 */
function checkAcknowledged(judgement, acknowledgements) {
  if (!judgement || !judgement.requiresDoubleConfirm) return { ok: true };
  const list = Array.isArray(acknowledgements)
    ? acknowledgements.map((x) => String(x || ''))
    : [String(acknowledgements || '')];
  if (list.includes(judgement.ack)) return { ok: true };
  return {
    ok: false,
    code: 'loan_amount_over_limit',
    error: judgement.message,
    judgement,
  };
}

module.exports = { LOAN_LIMIT, ACK, judgeLoanAmount, checkAcknowledged, _internals: { money } };
