'use strict';
/**
 * LT LenderPrice — THE numeric parse for a vendor payload. One definition.
 *
 * Every number Lender Price sends us — a rate, a price, a point, an LLPA, a
 * margin — arrives as JSON and has to become one of ours. That conversion has
 * been written three times in this folder and the three did not agree, which is
 * how a real defect lived here for as long as it did:
 *
 *   `search-model.js` and `field-registry.js` were audited and corrected to the
 *   parse below. `client.js` — the one that reads the PRICED RESULT — kept the
 *   original `parseFloat(String(v).replace(/[^0-9.]/g, ''))`, and that
 *   expression DELETES A MINUS SIGN. So every negative LLPA the vendor sent was
 *   read as its positive twin: a price CREDIT of −0.375 became a CHARGE of
 *   +0.375, and a −0.25 lender margin came back as +0.25. It happened on real
 *   numbers, not just strings, because the sign is stripped after `String(v)`.
 *
 *   It was silent because the headline figures take a different road:
 *   `firstNum` uses `Number()` and is sign-safe, so the price, the note rate and
 *   the LLPA stack TOTAL were always right. Only the ITEMISED breakdown flipped
 *   — the lines a person reads to understand why a price is what it is. The
 *   total and its own itemisation disagreed, and nothing compared them.
 *
 * THE RULES, and each one is a bug somebody already had:
 *   · the SIGN IS NEVER STRIPPED — it is the difference between a credit and a
 *     charge;
 *   · a real number passes through untouched, finite-checked — never
 *     round-tripped through a string;
 *   · currency FORMATTING is tolerated ($ , % and spaces) because a vendor
 *     sends "1.25%" and "$1,200" and both mean a number;
 *   · anything else is REFUSED rather than salvaged: "12abc3" is not 123 and
 *     "1e3" is not 13 (both are real corruptions this folder has recorded), and
 *     a boolean, an object or a Date is not a number at all — `Number(true)` is
 *     a perfectly innocent 1.
 *
 * `num` reports a value it cannot read as ABSENT (null). `strictNum` tells the
 * two apart — null for absent, undefined for present-but-unreadable — so a
 * validator can refuse a garbage figure instead of pricing as though the field
 * were blank. Same parse, two answers for the caller who needs the difference.
 *
 * PURE: no requires, no config, no IO.
 */

/** True only for a string that is a plain, optionally-signed decimal. */
const PLAIN = /^-?\d*\.?\d+$/;

/** Parse the FORMATTING a vendor uses, never the value's meaning. */
function fromString(v) {
  const s = String(v).trim();
  if (PLAIN.test(s)) return parseFloat(s);
  const cleaned = s.replace(/[$,%\s]/g, '');   // strip formatting only — never a sign
  if (PLAIN.test(cleaned)) return parseFloat(cleaned);
  return null;
}

/** A finite number, or null when there is nothing readable here. */
function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;      // boolean, array, object, Date — not a number
  return fromString(v);
}

/** null = absent · undefined = present but not a number · otherwise the number. */
function strictNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const n = fromString(v);
  return n === null ? undefined : n;
}

module.exports = { num, strictNum, _internals: { PLAIN, fromString } };
