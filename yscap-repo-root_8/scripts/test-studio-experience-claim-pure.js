/**
 * The experience typed in the Term Sheet Studio is the file's CLAIM
 * (owner-directed 2026-08-06) — the PURE half.
 *
 * `studioClaimFrom` decides what a saved studio scenario STATES about
 * experience. Everything it can get wrong is expensive in one direction or the
 * other, so the whole truth table is pinned here:
 *
 *   · a real number (INCLUDING 0) is a stated claim — that is what lets an
 *     officer LOWER a claim from the studio and have it stick;
 *   · a BLANK / absent field states NOTHING, so it can never silently zero a
 *     real claim (the same rule the register path's claimExpVal encodes);
 *   · `expBrrrr` ("BRRRR / rentals stabilized") is the HOLDS bucket — the
 *     owner's reported field, and the mapping every other surface uses;
 *   · junk and unstorable counts state nothing rather than reaching the column
 *     (int4 → 22003 → a 500 the officer reads as "PILOT is broken").
 *
 * No DB, no network.
 */
'use strict';

const S = require('../src/lib/studio-experience-claim');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const eq = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), `${m} — got ${JSON.stringify(a)}`);

const NONE = { flips: null, holds: null, ground: null };

// ---- A. The owner's own case -------------------------------------------------
// "they entered under Experience 10, Rentals Stabilized" — 10 in expBrrrr.
eq(S.studioClaimFrom({ v: { expBrrrr: '10' } }), { flips: null, holds: 10, ground: null },
  'A1 10 in "BRRRR / rentals stabilized" is a claim of 10 HOLDS');
assert(S.statesAnything(S.studioClaimFrom({ v: { expBrrrr: '10' } })) === true,
  'A2 that scenario states something (so the condition must require verifying it)');

// ---- B. Stated vs. not stated ------------------------------------------------
eq(S.studioClaimFrom({ v: { expFlips: '3', expBrrrr: '10', expGround: '2' } }),
  { flips: 3, holds: 10, ground: 2 }, 'B1 all three buckets read from their own studio fields');
eq(S.studioClaimFrom({ v: { expFlips: 0, expBrrrr: '0', expGround: '0' } }),
  { flips: 0, holds: 0, ground: 0 }, 'B2 a typed ZERO is a stated claim (a claim can be LOWERED to 0)');
eq(S.studioClaimFrom({ v: { expFlips: '', expBrrrr: '   ', expGround: null } }), NONE,
  'B3 blank / whitespace / null state NOTHING (a blank is never a deliberate 0)');
eq(S.studioClaimFrom({ v: { expBrrrr: '10' } }).flips, null,
  'B4 a bucket the studio did not mention stays unstated (the column is left alone)');
assert(S.statesAnything(NONE) === false, 'B5 an all-unstated claim states nothing');
assert(S.statesAnything(S.studioClaimFrom({ v: { expFlips: '0' } })) === true,
  'B6 a stated 0 DOES state something (it must be written, to lower the claim)');

// ---- C. Never let junk reach an int4 column ----------------------------------
eq(S.studioClaimFrom({ v: { expFlips: 'ten', expBrrrr: '4.5', expGround: '-2' } }), NONE,
  'C1 words, decimals and negatives state nothing rather than reaching the column');
eq(S.studioClaimFrom({ v: { expFlips: '99999999999' } }), NONE,
  'C2 a count int4 could never hold states nothing (never a 22003 → 500)');
eq(S.studioClaimFrom({ v: { expFlips: '2147483647' } }), { flips: 2147483647, holds: null, ground: null },
  'C3 the largest storable count is still a real claim');

// ---- D. Shape tolerance / never throws ---------------------------------------
eq(S.studioClaimFrom({ expBrrrr: '7' }), { flips: null, holds: 7, ground: null },
  'D1 a bare field bag reads the same as the {v,c} studio state');
for (const bad of [null, undefined, 0, '', 'x', [], { v: null }, { v: 'x' }]) {
  eq(S.studioClaimFrom(bad), NONE, `D2 garbage input (${JSON.stringify(bad)}) states nothing, never throws`);
}

// ---- E. The mapping is the shared one ----------------------------------------
eq(S.STUDIO_FIELD, { flips: 'expFlips', holds: 'expBrrrr', ground: 'expGround' },
  'E1 holds is fed by expBrrrr — the same mapping Apply.jsx / scenario.js / intake.js use');
eq(S.COLUMN, {
  flips: 'requested_exp_flips', holds: 'requested_exp_holds', ground: 'requested_exp_ground',
}, 'E2 each bucket writes its own applications column');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
