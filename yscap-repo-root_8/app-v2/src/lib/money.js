/* THE ONE PLACE A MONEY STRING BECOMES A NUMBER (2026-07-31).
 *
 * The portal has ONE money contract, set by `MoneyInput` in
 * components/FormattedInputs.jsx: the form STORES a plain numeric string
 * ("412500") and only DISPLAYS the comma-grouped version ("412,500"). Every
 * money field a human types therefore parses cleanly with `Number()`.
 *
 * The Term Sheet Studio does NOT follow that contract. It is a frozen static tool
 * whose own money inputs hold the FORMATTED text, and `YS.collectState()` reads
 * the DOM value — so every money value that comes out of the studio looks like
 * "412,500". `Number("412,500")` is **NaN**, and the surrounding `|| 0` turns
 * that into a silent ZERO rather than an error.
 *
 * That is what broke the assignment hand-off: a term sheet priced as an
 * assignment (total price $412,500, seller's contract $380,000, fee $32,500),
 * turned into a loan file, landed in Postgres as
 *   purchase_price = 380,000   assignment_fee = NULL
 * because the fee was derived with a bare `Number()` and came out 0, and the
 * server's `fields.assignmentFields` then (correctly) computes
 * purchase_price = underlying + fee. The whole wholesaler fee disappeared from
 * the file, understating the real price the borrower pays and every LTC / cash-
 * to-close figure derived from it.
 *
 * So: anything that crosses from the studio into the portal's data model goes
 * through `moneyStr` (back onto the clean contract) and any arithmetic on a
 * possibly-formatted money value goes through `moneyNum`. Never bare `Number()`
 * on a money field again — a value that arrives formatted must fail loudly or
 * parse correctly, never quietly become zero.
 */

/* Strip to digits + AT MOST ONE decimal point. Byte-identical in behavior to the
   `cleanMoney` MoneyInput has always used — that function now delegates here, so
   there is exactly one definition of "what a money string means". */
export function moneyStr(v) {
  if (v === '' || v == null) return '';
  const s = String(v).replace(/[^0-9.]/g, '');
  const i = s.indexOf('.');
  return i < 0 ? s : s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, '');
}

/** A money value as a NUMBER. Blank / unparseable → 0, never NaN.
 *  This is the drop-in for `Number(x) || 0` on any money field: for a value that
 *  already obeys the clean contract it returns exactly what `Number()` did, so
 *  swapping it in can never change an existing result. */
export function moneyNum(v) {
  const n = Number(moneyStr(v));
  return Number.isFinite(n) ? n : 0;
}
