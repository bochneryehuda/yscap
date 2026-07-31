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
 *
 *  THE DROP-IN FOR `Number(x) || 0` ON A MONEY FIELD, and it has to be a real
 *  drop-in or the repo-wide guard (scripts/test-studio-money-handoff.js) would be
 *  telling people to make a silent behaviour change. Two things `moneyStr` alone
 *  gets wrong, both caught by the pre-merge audit of this change (2026-07-31):
 *
 *   • THE SIGN. `moneyStr` strips everything that is not a digit or a dot —
 *     including a minus — because a MoneyInput must not let a human type one.
 *     But a value read back off the SERVER can legitimately be negative (a
 *     credit, an adjustment, a net figure), and `moneyNum(-32500)` returning
 *     +32500 would be a silent sign flip: worse than the NaN→0 this replaces,
 *     because it is a plausible number. The sign is read off the ORIGINAL value
 *     and re-applied.
 *   • A VALUE THAT IS ALREADY A NUMBER is returned as-is, never round-tripped
 *     through a string. `String(1e21)` is "1e+21", which strips to "121".
 *
 *  What it deliberately does NOT preserve, because these are not money: a
 *  non-finite number (Infinity/NaN → 0, the `|| 0` answer), and exponent or hex
 *  NOTATION inside a string ("1e5" → 15, "0x10" → 10). No money field on any
 *  surface produces those — MoneyInput cannot type them and Postgres numeric
 *  never renders them — and a money box that somehow held "1e5" meant 15 far
 *  more plausibly than 100000. */
export function moneyNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(moneyStr(v));
  if (!Number.isFinite(n) || n === 0) return 0;
  return /^[\s$(]*-/.test(String(v == null ? '' : v)) ? -n : n;
}
