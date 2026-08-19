/**
 * THE PROVABLY-FAIR DRAW, proven -- pure, no database, no network.
 *
 * This is the module the whole feature's credibility rests on, so it is tested
 * for the properties that MATTER rather than for "it returns something":
 *
 *   - the commitment holds only for the real seed, and a swapped seed is caught;
 *   - the roster hash changes when ANY field of ANY candidate changes, and two
 *     different rosters can never collide by field-boundary sliding;
 *   - the same inputs always give the same winner (that is what "verifiable"
 *     means), and different inputs give different winners;
 *   - weights really are the odds, measured over a real sample, not asserted;
 *   - the selector stays in range for every limit (see section E for what this
 *     file can and CANNOT detect about bias -- the limit is stated, not hidden);
 *   - slice angles are the SAME numbers as the odds, so the wheel cannot lie;
 *   - the rotation lands the pointer inside the winner's slice, for every
 *     position in the roster, with and without jitter;
 *   - a roster where nobody can win is REFUSED rather than quietly resolved.
 *
 * PROVEN TO FAIL, and here is exactly how, measured rather than claimed. Four
 * mutations were applied to src/lib/arena/fair-draw.js one at a time, with a
 * clean green run on either side of each:
 *   - ignore the weights and pick a position uniformly -> RED at "one ticket in
 *     ten wins about a tenth of the time (33.09%)";
 *   - drop the field separator from the canonical roster -> RED at "two rosters
 *     cannot collide by sliding a character across a field boundary";
 *   - flip the rotation direction -> RED at "the pointer lands INSIDE slice 0";
 *   - add one to the selected index -> the run stops at pickWeighted's own
 *     "cumulative weights did not cover the roll". Worth naming precisely,
 *     because a THROW is not the same evidence as a failed assertion: what that
 *     mutation proves is that the production guard fails LOUDLY instead of
 *     returning a wrong winner quietly, which is the behaviour that matters.
 * A fifth mutation -- replacing the rejection loop with a plain modulo -- left
 * this file entirely GREEN, which is the honest result and is why section E
 * says so in as many words instead of claiming a bias check it does not have.
 */
'use strict';
const assert = require('assert');
const f = require('../src/lib/arena/fair-draw');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

const people = (names) => names.map((x, i) => (typeof x === 'string'
  ? { key: `k${i}`, label: x, weight: 1 }
  : { key: x.key || `k${i}`, label: x.label, weight: x.weight }));

// ---- A. the commitment ----------------------------------------------------
{
  const c = f.newCommitment();
  eq(c.serverSeed.length, 64, 'the server seed is 32 bytes of hex');
  eq(c.commitHash.length, 64, 'the commitment is a SHA-256');
  eq(c.commitHash, f.sha256Hex(c.serverSeed), 'and it really is the hash of the seed');
  ok(f.commitmentHolds(c.serverSeed, c.commitHash), 'the real seed satisfies its own commitment');
  ok(!f.commitmentHolds(f.newCommitment().serverSeed, c.commitHash), 'a DIFFERENT seed does not');
  ok(!f.commitmentHolds(c.serverSeed, 'a'.repeat(64)), 'and a different fingerprint is not satisfied either');
  ok(!f.commitmentHolds('', c.commitHash), 'an empty seed never satisfies a commitment');
  ok(!f.commitmentHolds(c.serverSeed, ''), 'and neither does an empty fingerprint');
  ok(!f.commitmentHolds(c.serverSeed, c.commitHash.slice(0, 60)), 'a truncated fingerprint is refused, not partially matched');
  // Two seeds are never the same. If they were, the commitment would be
  // meaningless, and randomBytes silently returning constant data is exactly
  // the sort of thing nobody notices.
  const seeds = new Set(Array.from({ length: 500 }, () => f.newCommitment().serverSeed));
  eq(seeds.size, 500, '500 fresh seeds are 500 different seeds');
}

// ---- B. the frozen roster -------------------------------------------------
{
  const base = people(['Alice', 'Bob', 'Carla']);
  const h = f.rosterHash(base);
  eq(h.length, 64, 'the roster hash is a SHA-256');
  eq(f.rosterHash(people(['Alice', 'Bob', 'Carla'])), h, 'the same list hashes the same every time');
  ok(f.rosterHash(people(['Alice', 'Carla', 'Bob'])) !== h, 'RE-ORDERING the list changes the hash');
  ok(f.rosterHash(people(['Alice', 'Bob'])) !== h, 'REMOVING somebody changes the hash');
  ok(f.rosterHash(people(['Alice', 'Bob', 'Carla', 'Dan'])) !== h, 'ADDING somebody changes the hash');
  const heavier = people(['Alice', 'Bob', 'Carla']);
  heavier[0].weight = 5;
  ok(f.rosterHash(heavier) !== h, 'CHANGING A WEIGHT changes the hash - this is the tamper that would rig the odds');
  const renamed = people(['Alice', 'Bob', 'Carla']);
  renamed[2].key = 'somebody-else';
  ok(f.rosterHash(renamed) !== h, 'swapping who a slice actually IS changes the hash');

  // The field-boundary collision: without a separator between fields,
  // {key:'ab',label:'c'} and {key:'a',label:'bc'} would produce the identical
  // canonical string, and two different rosters that hash alike is the one hole
  // that makes a roster hash worthless.
  const slideA = [{ key: 'ab', label: 'c', weight: 1 }];
  const slideB = [{ key: 'a', label: 'bc', weight: 1 }];
  ok(f.rosterHash(slideA) !== f.rosterHash(slideB), 'two rosters cannot collide by sliding a character across a field boundary');
  // And the separator itself cannot be used to forge a collision, because it is escaped.
  const pipeA = [{ key: 'a|b', label: 'c', weight: 1 }];
  const pipeB = [{ key: 'a', label: 'b|c', weight: 1 }];
  ok(f.rosterHash(pipeA) !== f.rosterHash(pipeB), 'and a separator typed INTO a name cannot forge one either');
}

// ---- C. determinism, which is what "verifiable" means ---------------------
{
  const roster = people(['Alice', 'Bob', 'Carla', 'Dan', 'Eve']);
  const seed = f.newCommitment().serverSeed;
  const a = f.pickWeighted(roster, { serverSeed: seed, clientSeed: 'room-42', nonce: 1 });
  for (let i = 0; i < 25; i++) {
    const again = f.pickWeighted(roster, { serverSeed: seed, clientSeed: 'room-42', nonce: 1 });
    eq(again.index, a.index, 'the same seed, client value and nonce always pick the same person');
  }
  const otherNonce = f.pickWeighted(roster, { serverSeed: seed, clientSeed: 'room-42', nonce: 2 });
  const otherClient = f.pickWeighted(roster, { serverSeed: seed, clientSeed: 'room-43', nonce: 1 });
  // Over a 5-person roster a single pair could coincide by chance, so this is
  // checked as "the whole sequence differs", not "this one differs".
  const seqA = Array.from({ length: 40 }, (_, i) => f.pickWeighted(roster, { serverSeed: seed, clientSeed: 'a', nonce: i }).index).join('');
  const seqB = Array.from({ length: 40 }, (_, i) => f.pickWeighted(roster, { serverSeed: seed, clientSeed: 'b', nonce: i }).index).join('');
  ok(seqA !== seqB, 'a different value from the room produces a different sequence of results');
  ok(typeof otherNonce.index === 'number' && typeof otherClient.index === 'number', 'and both still produce a real result');
}

// ---- D. weights ARE the odds (measured, not asserted) ---------------------
{
  const roster = [
    { key: 'a', label: 'One ticket', weight: 1 },
    { key: 'b', label: 'Three tickets', weight: 3 },
    { key: 'c', label: 'Six tickets', weight: 6 },
  ];
  const N = 60000;
  const counts = { a: 0, b: 0, c: 0 };
  const seed = f.newCommitment().serverSeed;
  for (let i = 0; i < N; i++) counts[f.pickWeighted(roster, { serverSeed: seed, clientSeed: 'x', nonce: i }).candidate.key]++;
  const pct = (k) => counts[k] / N;
  // 60,000 draws: the standard error on a 0.1 share is about 0.0012, so a
  // 0.012 tolerance is ten sigma. It cannot flake, and it WOULD catch a
  // selector that ignored weights (which would sit at 0.333 each).
  ok(Math.abs(pct('a') - 0.1) < 0.012, `one ticket in ten wins about a tenth of the time (${(pct('a') * 100).toFixed(2)}%)`);
  ok(Math.abs(pct('b') - 0.3) < 0.012, `three tickets win about three tenths (${(pct('b') * 100).toFixed(2)}%)`);
  ok(Math.abs(pct('c') - 0.6) < 0.012, `six tickets win about six tenths (${(pct('c') * 100).toFixed(2)}%)`);

  // A zero-weight candidate is ON the wheel and cannot win.
  const withZero = [...roster, { key: 'z', label: 'Already won', weight: 0 }];
  let zeroWins = 0;
  for (let i = 0; i < 5000; i++) if (f.pickWeighted(withZero, { serverSeed: seed, clientSeed: 'z', nonce: i }).candidate.key === 'z') zeroWins++;
  eq(zeroWins, 0, 'somebody on zero tickets is visible on the wheel and never wins');
}

// ---- E. the selector stays in range, and is flat at the scale we can see --
//
// AN HONEST LIMIT, STATED RATHER THAN IMPLIED. `uniformBelow` uses rejection
// sampling so that it is EXACTLY unbiased instead of nearly so. This test
// CANNOT detect that difference and does not claim to: for a limit of 3 the
// skew a naive `int % 3` would introduce is about 2^-64 -- roughly one part in
// 10^19 -- which no sample anybody could run would separate from flat. It was
// measured: replacing the rejection loop with a plain modulo leaves this file
// entirely green.
//
// So what is tested here is what is real -- the values stay IN RANGE for every
// limit, and the distribution is flat at the scale that matters (which does
// catch a selector that ignores weights, or one off by one at the ends). The
// rejection sampling is in the module because a knowingly-biased selector
// inside something whose entire purpose is provable fairness is the wrong
// shape, not because this suite would notice its absence.
{
  const LIMIT = 3;
  const N = 60000;
  const seen = [0, 0, 0];
  const seed = f.newCommitment().serverSeed;
  for (let i = 0; i < N; i++) seen[f.uniformBelow(seed, 'bias', i, LIMIT)]++;
  for (let i = 0; i < LIMIT; i++) {
    ok(Math.abs(seen[i] / N - 1 / LIMIT) < 0.012, `value ${i} comes up about a third of the time (${(seen[i] / N * 100).toFixed(2)}%)`);
  }
  // IN RANGE, always, for awkward limits as well as easy ones. This is the
  // property the rejection loop must never break, and it IS observable.
  for (const lim of [1, 2, 3, 7, 10, 255, 256, 1000, 65537, 1000003]) {
    let lo = lim, hi = -1;
    for (let i = 0; i < 400; i++) {
      const v = f.uniformBelow(seed, 'range', i, lim);
      ok(Number.isInteger(v) && v >= 0 && v < lim, `a limit of ${lim} only ever returns 0..${lim - 1} (saw ${v})`);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lim <= 10) {
      // For a small limit, 400 draws should reach both ends. If the loop could
      // never return the last value -- a classic off-by-one -- this catches it.
      eq(hi, lim - 1, `a limit of ${lim} really can return its highest value`);
      eq(lo, 0, `and its lowest`);
    }
  }
  eq(f.uniformBelow(seed, 'x', 1, 1), 0, 'a one-candidate wheel always returns the only candidate');
  assert.throws(() => f.uniformBelow(seed, 'x', 1, 0), /positive integer/, 'a limit of zero is refused');
  n++;
  assert.throws(() => f.uniformBelow(seed, 'x', 1, -4), /positive integer/, 'a negative limit is refused');
  n++;
  assert.throws(() => f.uniformBelow(seed, 'x', 1, 2.5), /positive integer/, 'a fractional limit is refused');
  n++;
}

// ---- F. refusing what cannot be drawn -------------------------------------
{
  const seed = f.newCommitment().serverSeed;
  assert.throws(() => f.pickWeighted([], { serverSeed: seed, clientSeed: 'x', nonce: 1 }), /roster is empty/,
    'an empty wheel is REFUSED, never spun to announce a meaningless winner');
  n++;
  assert.throws(() => f.pickWeighted([{ key: 'a', label: 'A', weight: 0 }], { serverSeed: seed, clientSeed: 'x', nonce: 1 }),
    /nobody could win/, 'a wheel where every slice is zero is refused rather than silently picking somebody');
  n++;
  assert.throws(() => f.pickWeighted([{ key: 'a', label: 'A', weight: -1 }], { serverSeed: seed, clientSeed: 'x', nonce: 1 }),
    /non-negative whole number/, 'a negative weight is refused');
  n++;
  assert.throws(() => f.pickWeighted([{ key: 'a', label: 'A', weight: 1.5 }], { serverSeed: seed, clientSeed: 'x', nonce: 1 }),
    /non-negative whole number/, 'a fractional weight is refused - tickets are whole things');
  n++;
}

// ---- G. the wheel cannot lie about the odds -------------------------------
{
  const roster = [
    { key: 'a', label: 'A', weight: 1 },
    { key: 'b', label: 'B', weight: 3 },
  ];
  const angles = f.sliceAngles(roster);
  eq(angles.length, 2, 'one angle per candidate');
  ok(Math.abs(angles[0] - 90) < 1e-9, 'one ticket in four is a quarter of the wheel');
  ok(Math.abs(angles[1] - 270) < 1e-9, 'three tickets in four is three quarters');
  ok(Math.abs(angles.reduce((a, b) => a + b, 0) - 360) < 1e-9, 'the slices add up to a whole circle');
  // The property that matters: slice share === win probability, exactly.
  const total = roster.reduce((a, c) => a + c.weight, 0);
  roster.forEach((c, i) => {
    ok(Math.abs(angles[i] / 360 - c.weight / total) < 1e-12,
      `${c.label}'s slice is exactly ${c.label}'s chance - the picture cannot disagree with the maths`);
  });
  eq(f.sliceAngles([]).length, 0, 'an empty wheel has no slices');
  const allZero = f.sliceAngles([{ key: 'a', label: 'A', weight: 0 }, { key: 'b', label: 'B', weight: 0 }]);
  ok(Math.abs(allZero[0] - 180) < 1e-9, 'an all-zero wheel is still DRAWN, in equal slices, so an admin can look at it');
}

// ---- H. the rotation really lands on the winner ---------------------------
{
  // For every roster size, and every position in it, the pointer at 12 o'clock
  // must end up inside the winner's slice. This is the check that catches a
  // sign error or an off-by-one in the angle maths -- the failure that would
  // show the room one name and record another.
  for (const size of [2, 3, 5, 8, 13, 24]) {
    const roster = Array.from({ length: size }, (_, i) => ({ key: `k${i}`, label: `P${i}`, weight: 1 }));
    const angles = f.sliceAngles(roster);
    for (let idx = 0; idx < size; idx++) {
      for (const jitter of [0, 0.4, -0.4, 5]) {          // 5 is out of range and must be clamped
        const rot = f.targetRotationDeg(roster, idx, { fullTurns: 4, jitterFraction: jitter });
        ok(rot >= 4 * 360 && rot < 5 * 360, `the wheel turns four full times plus part of one (size ${size}, slice ${idx})`);
        // Where the pointer sits, in the wheel's own frame, once it has stopped.
        const under = (360 - (rot % 360)) % 360;
        let start = 0;
        for (let i = 0; i < idx; i++) start += angles[i];
        const end = start + angles[idx];
        // A slice that wraps past 360 is compared in both frames.
        const inside = (under >= start - 1e-9 && under <= end + 1e-9)
          || (under + 360 >= start - 1e-9 && under + 360 <= end + 1e-9);
        ok(inside, `the pointer lands INSIDE slice ${idx} of ${size} (jitter ${jitter}); pointer at ${under.toFixed(3)}, slice ${start.toFixed(3)}..${end.toFixed(3)}`);
      }
    }
  }
  const two = people(['A', 'B']);
  assert.throws(() => f.targetRotationDeg(two, 5), /outside the roster/, 'an index off the end of the roster is refused');
  n++;
  assert.throws(() => f.targetRotationDeg(two, -1), /outside the roster/, 'and so is a negative one');
  n++;
}

// ---- I. runDraw and verifyDraw agree, and catch tampering -----------------
{
  const roster = people(['Alice', 'Bob', 'Carla', 'Dan']);
  const c = f.newCommitment();
  const d = f.runDraw({ candidates: roster, serverSeed: c.serverSeed, clientSeed: 'room-1', nonce: 3, fullTurns: 6 });
  eq(d.commitHash, c.commitHash, 'the draw reports the same commitment the seed produces');
  eq(d.rosterHash, f.rosterHash(roster), 'and the fingerprint of the list it actually used');
  eq(d.key, roster[d.index].key, 'the winning key matches the winning position');
  eq(d.label, roster[d.index].label, 'and so does the label');

  const record = {
    candidates: roster, serverSeed: c.serverSeed, commitHash: c.commitHash,
    clientSeed: 'room-1', nonce: 3, rosterHash: d.rosterHash, winnerIndex: d.index, winnerKey: d.key,
  };
  const v = f.verifyDraw(record);
  eq(v.ok, true, 'an untouched draw verifies');
  eq(v.commitmentOk, true, 'its commitment holds');
  eq(v.rosterOk, true, 'its list is unchanged');
  eq(v.winnerOk, true, 'and recomputing it lands on the same person');
  eq(v.recomputedKey, d.key, 'the recomputed key is reported so it can be compared by eye');

  const swapped = f.verifyDraw({ ...record, serverSeed: f.newCommitment().serverSeed });
  eq(swapped.ok, false, 'swapping the secret seed after the fact FAILS');
  eq(swapped.commitmentOk, false, 'and it is the fingerprint that catches it');
  ok(/does not match the fingerprint/.test(swapped.reason), 'in words a person can read');

  const stacked = JSON.parse(JSON.stringify(roster));
  stacked[0].weight = 99;
  const rigged = f.verifyDraw({ ...record, candidates: stacked });
  eq(rigged.ok, false, 'stacking the odds after the draw FAILS');
  eq(rigged.rosterOk, false, 'and it is the frozen list that catches it');

  const relabelled = JSON.parse(JSON.stringify(roster));
  relabelled[d.index].key = 'my-friend';
  const swappedWinner = f.verifyDraw({ ...record, candidates: relabelled });
  eq(swappedWinner.ok, false, 'quietly replacing who the winning slice IS also fails');

  const notYet = f.verifyDraw({ ...record, serverSeed: null });
  eq(notYet.ok, false, 'a draw whose secret has not been revealed cannot be verified yet');
  ok(/not been revealed/.test(notYet.reason), 'and it says exactly that, rather than implying it failed');

  eq(f.verifyDraw(null).ok, false, 'verifying nothing is false, not a crash');
  eq(f.verifyDraw({ candidates: [] }).ok, false, 'and so is verifying an empty list');
  ok(f.verifyDraw({ candidates: [{ key: 'a', label: 'A', weight: 0 }], serverSeed: 'x', commitHash: f.sha256Hex('x'), clientSeed: 'c', nonce: 1 }).ok === false,
    'a record that cannot be recomputed reports false instead of throwing');
}

console.log(`arena fair draw (pure): ${n} assertions passed`);
