'use strict';
/**
 * LONG-TERM — a geocoder may restyle our address, never ADD to it.
 *
 * OWNER-REPORTED 2026-08-24, with three real files: "963 Sherman Ave, New Haven,
 * CT, 06511 was entered in Encompass, but in ClickUp it populated as
 * 963;965 Sherman Ave" — and the same on 967 (-> 967;969) and 971 (-> 971;973).
 * Sherman Ave is a row of two-family houses, so the geocoder answers the
 * neighbouring unit as a RANGE.
 *
 * ROOT CAUSE. `providerTextSafe` extracted the house number with
 * /^(\d+[A-Za-z]?)\b/ — and in "963;965" the SEMICOLON satisfies \b. So it read
 * "963", compared equal to ours, and reported the house number as preserved. The
 * guard asked whether our number SURVIVED and never whether anything had been
 * APPENDED, so a second address was adopted onto the card as though it were ours.
 *
 * THE RULE NOW: compare the whole leading token. A refusal is the SAFE
 * direction — it only ever means we keep the address we already hold and take
 * the provider's coordinates, which is exactly what the owner did by hand.
 */
const assert = require('assert');
const push = require('../src/longterm/clickup/push');
const safe = push._internals.providerTextSafe;

let n = 0;
const no = (o, p, m) => { assert.strictEqual(safe(o, p), false, m); n++; };
const yes = (o, p, m) => { assert.strictEqual(safe(o, p), true, m); n++; };

// ── 1. THE THREE REPORTED FILES — every one must now be refused ────────────
no('963 Sherman Ave, New Haven, CT 06511', '963;965 Sherman Ave, New Haven, CT 06511',
  'THE ONE THAT MATTERS: the reported 963 -> 963;965 is refused');
no('967 Sherman Ave, New Haven, CT 06511', '967;969 Sherman Ave, New Haven, CT 06511',
  '...and 967 -> 967;969');
no('971 Sherman Ave, New Haven, CT 06511', '971;973 Sherman Ave, New Haven, CT 06511',
  '...and 971 -> 971;973');

// ── 2. every other way a second number can be appended ─────────────────────
no('963 Sherman Ave, New Haven, CT 06511', '963-965 Sherman Ave, New Haven, CT 06511',
  'a hyphen range is the same corruption in another costume');
no('963 Sherman Ave, New Haven, CT 06511', '963/965 Sherman Ave, New Haven, CT 06511',
  'a slash range too');
no('963 Sherman Ave, New Haven, CT 06511', '963 1/2 Sherman Ave, New Haven, CT 06511',
  'a half-address is not the address we hold');

// ── 3. the ORIGINAL corruption classes still refused (no regression) ───────
no('1727 2nd St, Piscataway, NJ 08854', '2nd St, Piscataway, NJ 07063',
  'the Piscataway case: a road-level answer that drops the house number');
no('1727 S 2nd St, Piscataway, NJ 08854', '1727 S 2nd St, Plainfield, NJ 07063',
  'a different ZIP is a different property, however precise the match');
no('963 Sherman Ave, New Haven, CT 06511', '', 'an empty provider answer is never adopted');
no('', '963 Sherman Ave, New Haven, CT 06511', 'with nothing of our own there is nothing to protect');

// ── 4. a genuine RESTYLE is still adopted — the guard must not refuse all ──
yes('963 Sherman Ave, New Haven, CT 06511', '963 Sherman Avenue, New Haven, CT 06511',
  'spelling the street type out is a restyle, not a change of address');
yes('963 Sherman Ave, New Haven, CT 06511', '963 Sherman Ave, New Haven, CT 06511',
  'an identical answer is trivially safe');
yes('963 Sherman Ave, New Haven, CT', '963 Sherman Ave, New Haven, CT 06511',
  'FILLING a ZIP we never had is a gain, never a contradiction');
yes('963A Sherman Ave, New Haven, CT 06511', '963a Sherman Ave, New Haven, CT 06511',
  'a unit letter differing only in case is the same house');

console.log(`✓ lt address house token (pure): ${n} assertions passed`);
