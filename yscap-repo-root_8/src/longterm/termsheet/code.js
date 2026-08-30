'use strict';
/**
 * LONG-TERM — the TERM SHEET ID.
 *
 * `TS-4K7P2M`. Six characters of Crockford base32, and every property of that
 * choice is load-bearing:
 *
 *   · NO I, L, O OR U. This identifier is read down a telephone and typed back
 *     ("put in the term sheet ID and pull up the exact scenario"), so the two
 *     pairs a person cannot tell apart by ear or by eye — I/1 and O/0 — are not
 *     in the alphabet at all. U is dropped with them, which is Crockford's own
 *     rule and costs nothing.
 *   · SIX characters. 32^6 ≈ 1.07 billion, which is far more than this company
 *     will ever issue, and short enough to read aloud in one breath.
 *   · RANDOM, NEVER SEQUENTIAL. A counter published on every document we hand
 *     out tells anybody holding two of them how many quotes we issue and how
 *     fast. It is also an internal identifier, and this one is printed.
 *   · CASE-INSENSITIVE ON LOOKUP. Somebody typing it back will not match our
 *     casing, so `normalize` folds and the database's unique index is on
 *     `upper(code)`.
 *
 * A collision is handled by RETRYING against the unique index, never by asking
 * the database for the next number — see store.js.
 *
 * PURE: `crypto` only, no database, no network.
 */

const crypto = require('crypto');

/** Crockford's alphabet, minus I, L, O and U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PREFIX = 'TS-';
/** The prefix WITHOUT its separator — the hyphen is stripped before we look. */
const PREFIX_LETTERS = 'TS';
const LENGTH = 6;

/**
 * A fresh code. Drawn with `randomInt` per character rather than by folding a
 * random byte with `%`: 256 is not a multiple of 32 — it happens to be here, but
 * relying on that means the day somebody changes the alphabet length the codes
 * quietly stop being uniform, and a biased identifier is the kind of defect
 * nobody ever notices.
 */
function mintCode() {
  let out = '';
  for (let i = 0; i < LENGTH; i += 1) out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return PREFIX + out;
}

/**
 * A code somebody typed, as we store it — or null when it is not one of ours.
 *
 * Deliberately forgiving about the things a human does and unforgiving about
 * everything else: the `TS-` prefix may be omitted or lower-cased, spaces and a
 * stray hyphen are dropped, and O/o → 0 plus I/i/L/l → 1 are folded because
 * that is what a person reading the printed page will type. It NEVER invents a
 * character it cannot place: a length that is not six, or a symbol outside the
 * alphabet after folding, answers null rather than a code that might belong to
 * somebody else's term sheet.
 *
 * ⛔ TWO THINGS HERE ARE NARROW ON PURPOSE, AND BOTH WERE FOUND BY ROUND-TRIPPING
 * A MINTED CODE RATHER THAN BY READING THIS FUNCTION.
 *
 *   · ONLY O AND I/L FOLD. **Q IS A REAL SYMBOL IN THIS ALPHABET** — Crockford
 *     drops I, L, O and U and KEEPS Q, and its own decoding rule folds only
 *     O→0 and I/L→1. Folding Q→0 as well (which reads plausible, since Q looks
 *     a little like 0 in some faces) makes every code CONTAINING a Q resolve to
 *     a different code and therefore find nothing: 1 − (31/32)^6, about **one
 *     term sheet in six**, permanently unlookupable, silently, with the officer
 *     told the ID does not exist. Never add a letter to this fold that the
 *     alphabet itself contains.
 *   · THE PREFIX IS STRIPPED ONLY WHEN IT IS A PREFIX. A code may legitimately
 *     BEGIN with the letters T and S — `TSABCD` is 1 in 1,024 of them — so
 *     `startsWith('TS')` alone eats the first two characters of the code itself
 *     when it is typed without the prefix, leaving four characters and a null.
 *     The length decides: eight characters means prefix + code, six means the
 *     code alone.
 */
function normalizeCode(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().toUpperCase().replace(/[\s-]+/g, '');
  if (s.length === PREFIX_LETTERS.length + LENGTH && s.startsWith(PREFIX_LETTERS)) {
    s = s.slice(PREFIX_LETTERS.length);
  }
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== LENGTH) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return PREFIX + s;
}

/** Is this exactly the shape we mint? (Storage-side check, no folding.) */
function isCode(v) {
  const s = String(v == null ? '' : v);
  if (!s.startsWith(PREFIX) || s.length !== PREFIX.length + LENGTH) return false;
  for (const ch of s.slice(PREFIX.length)) if (!ALPHABET.includes(ch)) return false;
  return true;
}

module.exports = { ALPHABET, PREFIX, PREFIX_LETTERS, LENGTH, mintCode, normalizeCode, isCode };
