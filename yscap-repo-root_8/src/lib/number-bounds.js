'use strict';

/* =====================================================================
   number-bounds.js — the ONE definition of "can this number live in that
   column", and the plain-language reason when it cannot.

   THE ROOT CAUSE THIS EXISTS TO KILL (post-merge audit 2026-07-31). A number
   too big for its column reaches Postgres, raises 22003 (numeric field
   overflow) or 22P02, and the route's catch-all turns it into a 500 "server
   error". To the person at the screen that reads "PILOT is broken", not "that
   number is too big" — and none of the money inputs cap their digits, so a
   fat-fingered paste gets there from an ordinary browser.

   It was fixed FOUR separate times, one column at a time, and each fix left a
   different column wrong:
     · the first bound covered four keys and missed `requested_ir_amount`
       (money, but it matched the int helper's regex, so it was skipped);
     · `units` / `sqft_pre` / `sqft_post` are int4, so everything between
       2,147,483,647 and 10^12 still answered 500;
     · a 400 quoted a MONEY limit for a unit COUNT, so following the advice
       produced another 500;
     · `requested_ir_months` has a CHECK narrower than its type, so int4's
       ceiling was the wrong number to quote there too;
     · and the register + cash-to-close doors each carried their OWN inline
       copy of the money ceiling, so a correction to one never reached them.

   The lesson the copies keep re-teaching: the limit is a property of the
   COLUMN TYPE, not of the field's name or of the door it arrived at. So it is
   decided in one place, keyed on the type, and every door delegates.

   PURE — no DB, no network, never throws. Unit-tested by
   scripts/test-number-bounds-pure.js.
   ===================================================================== */

// numeric(14,2) — the money type used by every dollar column on `applications`
// and `product_registrations`. |value| must ROUND to strictly less than 10^12.
const MONEY_MAX = 1e12;

// int4 — every count column (units, sqft, experience tallies).
const INT_MAX = 2147483647;
const INT_MIN = -2147483648;

// numeric(7,5) — the note rate, stored as a FRACTION (0.11990 = 11.99%). Five
// decimals, so the whole part is two digits: |value| must round to < 100.
const RATE_MAX = 100;

const MONEY_LIMIT_TEXT = '999,999,999,999.99';
const INT_LIMIT_TEXT = '2,147,483,647';

/**
 * Would this value overflow numeric(14,2)?
 *
 * ROUND THE MAGNITUDE, NOT THE SIGNED VALUE. Postgres rounds to two decimals
 * BEFORE it checks for overflow, and it rounds HALF AWAY FROM ZERO — while
 * JavaScript's Math.round breaks ties toward +∞. So -999999999999.995 rounded
 * signed came back inside the ceiling and went on to overflow in Postgres: a
 * 500 that an earlier round believed it had closed for both signs.
 */
function moneyOverflows(n) {
  if (!Number.isFinite(n)) return false;          // "not a number" is a different refusal
  return Math.round(Math.abs(n) * 100) / 100 >= MONEY_MAX;
}

/** Would this value overflow numeric(7,5) (the note rate, as a fraction)? */
function rateOverflows(n) {
  if (!Number.isFinite(n)) return false;
  return Math.round(Math.abs(n) * 1e5) / 1e5 >= RATE_MAX;
}

/** Would this value overflow int4? */
function intOverflows(n) {
  if (!Number.isFinite(n)) return false;
  return n > INT_MAX || n < INT_MIN;
}

/**
 * The reason `n` cannot be stored in the column `key` names, or '' if it can.
 *
 * `kind` is the COLUMN TYPE:
 *   'money'  — numeric(14,2)
 *   'int'    — int4, whole numbers only
 *   'rate'   — numeric(7,5), a rate held as a fraction
 *   {min,max,what} — a column whose CHECK is narrower than its type; the
 *                    constraint is the ceiling, so quote THAT, not the type's.
 *
 * `label` is what the message calls the field (defaults to `key`), so a door
 * can speak the borrower's language without re-deriving the limit.
 */
function columnProblem(key, n, kind, label) {
  const name = label || key;
  if (n == null) return '';
  if (!Number.isFinite(n)) return `${name} must be a number`;

  if (kind && typeof kind === 'object') {
    if (!Number.isInteger(n)) return `${name} must be a whole number of ${kind.what}`;
    if (n < kind.min || n > kind.max) return `${name} must be between ${kind.min} and ${kind.max} ${kind.what}`;
    return '';
  }
  if (kind === 'money') {
    return moneyOverflows(n) ? `${name} is too large — the largest amount this field can hold is ${MONEY_LIMIT_TEXT}` : '';
  }
  if (kind === 'rate') {
    return rateOverflows(n) ? `${name} is out of range — a rate that large cannot be stored` : '';
  }
  // int4
  if (!Number.isInteger(n)) return `${name} must be a whole number`;
  return intOverflows(n) ? `${name} is too large — the largest value this field can hold is ${INT_LIMIT_TEXT}` : '';
}

module.exports = {
  MONEY_MAX, INT_MAX, INT_MIN, RATE_MAX,
  MONEY_LIMIT_TEXT, INT_LIMIT_TEXT,
  moneyOverflows, rateOverflows, intOverflows, columnProblem,
};
