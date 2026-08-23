'use strict';
/**
 * LT — THE reading of a figure and a word out of a payload we did not write.
 *
 * Everything on this side arrives as JSON from Encompass or as a row from
 * Postgres, and turning one of those values into a number of ours had been
 * written FOUR times (`application/mapper.js`, `file.js`, `locks.js`,
 * `workspace.js`) with four different degrees of care. Only the mapper's tested
 * the TYPE, and it is the one that wrote down why:
 *
 *     `Number(null)`, `Number('')`, `Number(false)` and `Number([])` are ALL a
 *     finite, perfectly innocent 0.
 *
 * The other three did not, and it was not theoretical. Fed a lock section whose
 * `lockedRate` arrived as the boolean `true`, `locks.js` reported a NOTE RATE OF
 * 1%; an empty array in `lockedPrice` reported a PRICE OF 0; `[45]` was read as
 * a 45-day lock term. Each is a confident, plausible, completely wrong figure on
 * a desk somebody makes a decision from — and no error anywhere, because that is
 * what these conversions do when they are handed the wrong kind of thing.
 *
 * THE TYPE TEST COMES BEFORE THE CONVERSION. A number is a number; a string is
 * a number if it says one; everything else — a boolean, an array, an object, a
 * Date — is NOT A FIGURE and reads as absent. Absent is the honest answer, and
 * the screens on this side already know how to say "we do not hold this" (see
 * `application/unsourced.js`); what they cannot do is un-say a 1% rate.
 *
 * `text` is the same discipline for a word: an object is not a sentence, and
 * `String({})` is the string "[object Object]", which has been printed on a
 * screen in this repository before.
 *
 * A BLANK IS NOT A ZERO and a zero is not a blank. `num(0)` is 0 — a real
 * answer, and one that matters when the figure is a fee or an adjustment.
 *
 * PURE: no requires, no config, no IO.
 */

/**
 * A finite number, or null.
 *
 * Deliberately narrower than `Number()`: it accepts only what somebody could
 * have MEANT as a figure. A numeric string is accepted because Postgres returns
 * `numeric` columns as strings — refusing those would blank every money column
 * on the long-term side.
 */
function num(v) {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Trimmed text, or null. An object is never stringified into a sentence. */
function text(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return null;
  const s = String(v).trim();
  return s || null;
}

module.exports = { num, text };
