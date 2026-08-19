'use strict';
/**
 * THE PROVABLY-FAIR DRAW — the one definition of how a winner is chosen.
 *
 * WHY THIS EXISTS AT ALL. The owner's requirement is social, not technical:
 * "everybody can see why it spins". A room of loan officers watching a wheel
 * their own employer controls has no reason to believe the wheel. Saying "it is
 * random" is an assertion. This module makes it a PROOF anybody in the room can
 * recompute afterwards, using the same scheme regulated sweepstakes services
 * and provably-fair gaming operators use (RandomPicker's "certificate of
 * fairness", Provable.io's sweepstakes API, the server-seed / client-seed /
 * nonce HMAC construction). See docs/ARENA-GAME-ENGINE-RESEARCH.md.
 *
 * THE SEQUENCE, and why each step is in that order:
 *
 *   1. COMMIT.  Before anything else, the server generates a 32-byte secret
 *      `serverSeed` and publishes ONLY `sha256(serverSeed)`. This happens
 *      BEFORE the candidate list is frozen, which is the step that actually
 *      matters: a seed committed after the roster is known could have been
 *      shopped -- tried against the list until it produced a favoured name.
 *      Committed first, it cannot.
 *   2. FREEZE.  The candidate list is snapshotted in order, with weights, and
 *      hashed (`rosterHash`). Nobody can be added, removed or re-ordered after
 *      this without the hash changing.
 *   3. SPIN.    `HMAC-SHA256(serverSeed, clientSeed + ':' + nonce)` produces a
 *      digest. The digest is read as one big integer and mapped onto the
 *      cumulative weights, so slice size and win probability are THE SAME
 *      NUMBER -- a wheel whose slices lie about the odds is worse than no wheel.
 *   4. REVEAL.  `serverSeed` is disclosed. Anyone recomputes sha256 of it,
 *      checks it against the commitment they saw before the draw, recomputes
 *      the HMAC, and lands on the same winner. If any of those three disagrees,
 *      the draw was tampered with.
 *
 * WHY THE DIGEST IS CONSUMED IN CHUNKS. Taking `int(hash) % totalWeight` is the
 * obvious mapping and it is BIASED: 2^256 is not a multiple of totalWeight, so
 * the lowest `2^256 mod totalWeight` values are very slightly likelier. The
 * bias is far too small to matter at this scale -- and shipping a knowingly
 * biased selector inside something whose entire purpose is provable fairness is
 * the wrong shape. `uniformBelow` uses rejection sampling instead: it reads
 * 8-byte chunks of the digest, rejects any chunk landing in the unfair tail,
 * and re-hashes with an incremented counter if it runs out of chunks. Unbiased,
 * deterministic, and reproducible by anyone following the same rule.
 *
 * WHY NOT Math.random(). It is a non-cryptographic generator whose internal
 * state is recoverable from its output -- the exact property that makes it
 * unusable for anything anyone is expected to trust. Every random byte here
 * comes from `crypto.randomBytes`.
 *
 * PURE, and deliberately so: no database, no config, no clock, no IO. Every
 * branch below is exercised by scripts/test-arena-fair-draw-pure.js. The SAME
 * functions run in three places -- when the draw is made, when the API verifies
 * a past draw on request, and in the tests -- so there is no second copy of the
 * rule to drift. The browser NEVER recomputes a winner: it asks the server to
 * verify and displays the answer, which is why a browser twin does not exist.
 */

const crypto = require('crypto');

const sha256Hex = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

/** A fresh secret server seed, and the commitment that is published for it. */
function newCommitment() {
  const serverSeed = crypto.randomBytes(32).toString('hex');
  return { serverSeed, commitHash: sha256Hex(serverSeed) };
}

/** Does this disclosed seed match the hash that was published before the draw? */
function commitmentHolds(serverSeed, commitHash) {
  if (!serverSeed || !commitHash) return false;
  const a = Buffer.from(sha256Hex(serverSeed), 'utf8');
  const b = Buffer.from(String(commitHash).toLowerCase(), 'utf8');
  // Constant-time compare. Not because a timing attack is plausible against a
  // company prize wheel, but because a hash comparison written the sloppy way
  // is the thing people copy out of a file like this into somewhere it matters.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The frozen candidate list, in a form that hashes to the same string for
 * everyone. JSON.stringify of an object is NOT stable across engines (key order
 * is an implementation detail), and a roster hash that depends on key order is
 * a hash that stops matching for no reason -- so the canonical form is built by
 * hand, field by field, with an explicit separator between every field.
 *
 * The separator matters: without one, {key:'ab',label:'c'} and
 * {key:'a',label:'bc'} would hash identically, and two different rosters that
 * hash the same is precisely the hole this is here to close.
 *
 * Each candidate: { key, label, weight }. `key` is what identifies the winner
 * (a staff id, an entry id, a file id); `label` is only what the wheel says.
 */
function canonicalRoster(candidates) {
  const esc = (v) => String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
  return (candidates || [])
    .map((c, i) => [i, esc(c.key), esc(c.label), Number(c.weight) || 0].join('|'))
    .join('\n');
}

function rosterHash(candidates) {
  return sha256Hex(canonicalRoster(candidates));
}

/**
 * A uniform integer in [0, limit) derived from (serverSeed, clientSeed, nonce).
 *
 * Rejection sampling over 8-byte chunks (see the header). `limit` must be a
 * positive safe integer; 8 bytes gives 2^64 possible values, so the loop
 * rejects at most a vanishing fraction and `counter` almost never advances --
 * but it IS advanced rather than falling back to a biased modulo, because "it
 * practically never happens" is exactly the branch that eventually happens.
 */
function uniformBelow(serverSeed, clientSeed, nonce, limit) {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('uniformBelow: limit must be a positive integer');
  if (limit === 1) return 0;
  const SPAN = 2n ** 64n;
  const lim = BigInt(limit);
  // The largest multiple of `limit` that fits in 2^64. Anything at or above it
  // is the unfair tail and gets rejected.
  const fair = (SPAN / lim) * lim;
  for (let counter = 0; counter < 1000; counter++) {
    const msg = `${clientSeed}:${nonce}` + (counter ? `:${counter}` : '');
    const digest = crypto.createHmac('sha256', String(serverSeed)).update(msg, 'utf8').digest();
    for (let off = 0; off + 8 <= digest.length; off += 8) {
      const v = digest.readBigUInt64BE(off);
      if (v < fair) return Number(v % lim);
    }
  }
  // Unreachable in practice (each chunk is rejected with probability below
  // 2^-60, four chunks a round, a thousand rounds). Fails LOUDLY rather than
  // quietly returning 0, which would be a silently rigged wheel.
  throw new Error('uniformBelow: exhausted 1000 rounds without a fair sample');
}

/**
 * Pick the winning candidate by cumulative weight.
 *
 * The SAME weight array must drive the visual slice angles (see sliceAngles) --
 * that is the whole reason weights live in the frozen roster rather than being
 * applied afterwards.
 *
 * Zero-weight candidates stay ON the wheel (people can see they were included)
 * but cannot win. If EVERY weight is zero the draw is REFUSED rather than
 * silently falling back to "pick anyone" -- an all-zero roster means the caller
 * built the pool wrongly, and inventing a winner would hide that.
 */
function pickWeighted(candidates, { serverSeed, clientSeed, nonce }) {
  const list = candidates || [];
  if (!list.length) throw new Error('pickWeighted: the roster is empty');
  const weights = list.map((c) => {
    const w = Number(c.weight);
    if (!Number.isInteger(w) || w < 0) {
      throw new Error(`pickWeighted: weight must be a non-negative whole number (got ${c.weight} for "${c.key}")`);
    }
    return w;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error('pickWeighted: every candidate has weight 0 - nobody could win');
  const roll = uniformBelow(serverSeed, clientSeed, nonce, total);
  let acc = 0;
  for (let i = 0; i < list.length; i++) {
    acc += weights[i];
    if (roll < acc) return { index: i, candidate: list[i], roll, totalWeight: total };
  }
  // Arithmetically unreachable: acc ends at total and roll < total. Kept as a
  // loud failure rather than an implicit undefined return.
  throw new Error('pickWeighted: cumulative weights did not cover the roll');
}

/**
 * The slice angles the wheel is drawn from -- derived from the SAME weights the
 * draw used, so what the room sees is what the odds are. Degrees, in roster
 * order, summing to 360.
 *
 * An all-zero roster cannot be drawn from (pickWeighted refuses it), but it CAN
 * still be displayed -- an admin looking at a pool before anybody has earned a
 * ticket should see the wheel, not a crash -- so it falls back to equal slices.
 */
function sliceAngles(candidates) {
  const list = candidates || [];
  if (!list.length) return [];
  const total = list.reduce((a, c) => a + (Number(c.weight) || 0), 0);
  if (total <= 0) return list.map(() => 360 / list.length);
  return list.map((c) => (360 * (Number(c.weight) || 0)) / total);
}

/**
 * How far the wheel must turn to land the pointer on `index`.
 *
 * The winner is decided FIRST (above) and the rotation is computed FROM it --
 * never the reverse. A wheel that picks whatever it happens to land on has
 * moved the decision into the browser, where anyone can watch it happen in
 * devtools and nobody can verify it afterwards.
 *
 * Convention, fixed HERE so the server and the wheel can never disagree: the
 * pointer sits at the TOP (12 o'clock), slices are laid out clockwise starting
 * at the top, and the wheel itself rotates clockwise by the returned degrees.
 * Landing slice i under the pointer therefore means turning the wheel until
 * that slice's centre is back at the top, plus whole extra turns for the show.
 *
 * `jitterFraction` (-0.45..0.45, default 0) nudges the stop off the exact slice
 * centre so consecutive wins of the same slice do not stop at a visibly
 * identical angle. It is COSMETIC and is bounded to stay inside the slice -- it
 * can never change who won.
 */
function targetRotationDeg(candidates, index, { fullTurns = 6, jitterFraction = 0 } = {}) {
  const angles = sliceAngles(candidates);
  if (!Number.isInteger(index) || index < 0 || index >= angles.length) {
    throw new Error('targetRotationDeg: index outside the roster');
  }
  let start = 0;
  for (let i = 0; i < index; i++) start += angles[i];
  const slice = angles[index];
  const j = Math.max(-0.45, Math.min(0.45, Number(jitterFraction) || 0));
  const centre = start + slice / 2 + slice * j;
  const turns = Math.max(1, Math.floor(Number(fullTurns) || 1));
  // Normalized into [0,360) before the extra turns are added, so the result is
  // stable however the caller ordered the roster.
  const back = (360 - (centre % 360)) % 360;
  return turns * 360 + back;
}

/**
 * THE WHOLE DRAW, in one call -- used when the wheel is spun AND when a past
 * draw is verified. One function, so a verification can never end up checking
 * something other than what actually happened.
 *
 * Returns everything that must be recorded, including the roster hash, so the
 * caller stores exactly what a verifier will later recompute.
 */
function runDraw({ candidates, serverSeed, clientSeed, nonce = 1, fullTurns = 6, jitterFraction = 0 }) {
  const { index, candidate, roll, totalWeight } = pickWeighted(candidates, { serverSeed, clientSeed, nonce });
  return {
    index,
    key: String(candidate.key),
    label: String(candidate.label),
    roll,
    totalWeight,
    rosterHash: rosterHash(candidates),
    commitHash: sha256Hex(serverSeed),
    targetRotationDeg: targetRotationDeg(candidates, index, { fullTurns, jitterFraction }),
  };
}

/**
 * Re-run a recorded draw from its disclosed record and report, in plain words,
 * whether every part of it holds. NEVER THROWS -- a verification that crashes
 * tells the room nothing. Anything unreadable comes back `ok: false` with the
 * reason, which is the honest answer.
 */
function verifyDraw(record) {
  const out = { ok: false, commitmentOk: false, rosterOk: false, winnerOk: false, reason: null };
  try {
    const r = record || {};
    const candidates = r.candidates;
    if (!Array.isArray(candidates) || !candidates.length) {
      out.reason = 'the recorded candidate list is missing or empty';
      return out;
    }
    if (!r.serverSeed) {
      out.reason = 'the secret number has not been revealed yet, so this draw cannot be checked until it is';
      return out;
    }
    out.commitmentOk = commitmentHolds(r.serverSeed, r.commitHash);
    if (!out.commitmentOk) {
      out.reason = 'the revealed secret number does not match the fingerprint that was published before the draw';
      return out;
    }
    out.rosterOk = !r.rosterHash || rosterHash(candidates) === r.rosterHash;
    if (!out.rosterOk) {
      out.reason = 'the list of who was on the wheel does not match the list frozen before the draw';
      return out;
    }
    const again = pickWeighted(candidates, {
      serverSeed: r.serverSeed, clientSeed: r.clientSeed, nonce: r.nonce == null ? 1 : r.nonce,
    });
    const indexOk = r.winnerIndex == null || again.index === r.winnerIndex;
    const keyOk = r.winnerKey == null || String(again.candidate.key) === String(r.winnerKey);
    out.winnerOk = indexOk && keyOk;
    if (!out.winnerOk) {
      out.reason = 'working the draw out again produces a different winner';
      return out;
    }
    out.recomputedIndex = again.index;
    out.recomputedKey = String(again.candidate.key);
    out.recomputedLabel = String(again.candidate.label);
    out.ok = true;
    return out;
  } catch (e) {
    out.reason = `this draw could not be checked: ${(e && e.message) || e}`;
    return out;
  }
}

/**
 * A FREE-SPINNING WHEEL, STOPPED BY A PERSON.
 *
 * The other mode. Instead of the winner being settled first and the wheel being
 * turned to it, the wheel spins and keeps spinning until somebody presses stop
 * — and where it lands is genuinely decided by WHEN they pressed.
 *
 * SO IS IT STILL CHECKABLE? Yes, and by exactly the same means. Three things go
 * into the landing angle and all three are on the record:
 *   - `serverSeed`, committed (as a hash) before anybody entered;
 *   - `elapsedMs`, how long the wheel had been turning when the press reached
 *     the SERVER — not when the browser says it was pressed, because a browser
 *     clock is not evidence;
 *   - the wheel's speed, fixed and published before it started.
 * Anyone can recompute the angle from those three and land on the same slice.
 *
 * CAN THEY AIM IT? Not really, and that is the point. At the default speed the
 * wheel passes a whole slice in a few tens of milliseconds, which is well
 * inside a person's own reaction-time scatter — so they can lean on roughly
 * which QUARTER it lands in if they concentrate, and nothing finer. That is a
 * real thing to hold and it is honest to say so, which is why the screen says
 * exactly that rather than implying either total control or none.
 *
 * WHY THE SEED IS MIXED IN AT ALL. Without it, the angle would be pure
 * arithmetic on the elapsed time, and somebody with a stopwatch and the speed
 * could work out where to press. The seed adds a fixed, unknowable offset that
 * is revealed only afterwards — so the press moves the wheel and nobody can
 * compute the target in advance.
 *
 * `spinDownDeg` is the extra distance the wheel coasts after the press, which
 * is what makes it look like a wheel rather than a switch. It is part of the
 * published maths, not decoration.
 */
function landingFromPress({ serverSeed, elapsedMs, degPerSecond = 900, spinDownDeg = 540 }) {
  const ms = Math.max(0, Math.floor(Number(elapsedMs) || 0));
  const speed = Math.max(60, Number(degPerSecond) || 900);
  // The unknowable offset, in hundredths of a degree so it is a whole number.
  const offset = uniformBelow(serverSeed, 'stop', 1, 36000) / 100;
  const travelled = (ms / 1000) * speed;
  const total = travelled + (Number(spinDownDeg) || 0) + offset;
  return {
    totalRotationDeg: total,
    // Where the pointer at the top ends up, in the wheel's own frame.
    pointerAtDeg: ((360 - (total % 360)) % 360 + 360) % 360,
    offsetDeg: offset,
    travelledDeg: travelled,
    degPerSecond: speed,
    spinDownDeg: Number(spinDownDeg) || 0,
    elapsedMs: ms,
  };
}

/**
 * Which slice is under the pointer at this angle. The inverse of
 * `targetRotationDeg`, and it MUST use the same slice layout — that is why both
 * live in this file and neither is re-derived anywhere else.
 */
function sliceAt(candidates, pointerAtDeg) {
  const angles = sliceAngles(candidates);
  if (!angles.length) return -1;
  let a = ((Number(pointerAtDeg) || 0) % 360 + 360) % 360;
  let acc = 0;
  for (let i = 0; i < angles.length; i++) {
    acc += angles[i];
    if (a < acc) return i;
  }
  return angles.length - 1;   // exactly 360, or a rounding whisker past it
}

/**
 * THE WHOLE HELD DRAW, in one call — used when the button is pressed AND when
 * that draw is later verified. One function, so a check can never be checking
 * something other than what happened.
 */
function runHeldDraw({ candidates, serverSeed, elapsedMs, degPerSecond, spinDownDeg }) {
  const list = candidates || [];
  if (!list.length) throw new Error('runHeldDraw: the roster is empty');
  const total = list.reduce((a, x) => a + (Number(x.weight) || 0), 0);
  if (total <= 0) throw new Error('runHeldDraw: every candidate has weight 0 - nobody could win');
  const landing = landingFromPress({ serverSeed, elapsedMs, degPerSecond, spinDownDeg });
  const index = sliceAt(list, landing.pointerAtDeg);
  const winner = list[index];
  return {
    index,
    key: String(winner.key),
    label: String(winner.label),
    rosterHash: rosterHash(list),
    commitHash: sha256Hex(serverSeed),
    targetRotationDeg: landing.totalRotationDeg,
    landing,
  };
}

/**
 * Check a HELD draw. Same shape of answer as `verifyDraw`, and never throws.
 * The extra thing it proves: the wheel really did land where the press put it.
 */
function verifyHeldDraw(record) {
  const out = { ok: false, commitmentOk: false, rosterOk: false, winnerOk: false, reason: null };
  try {
    const r = record || {};
    const candidates = r.candidates;
    if (!Array.isArray(candidates) || !candidates.length) { out.reason = 'the recorded candidate list is missing or empty'; return out; }
    if (!r.serverSeed) { out.reason = 'the secret number has not been revealed yet, so this draw cannot be checked until it is'; return out; }
    out.commitmentOk = commitmentHolds(r.serverSeed, r.commitHash);
    if (!out.commitmentOk) { out.reason = 'the revealed secret number does not match the fingerprint published before the draw'; return out; }
    out.rosterOk = !r.rosterHash || rosterHash(candidates) === r.rosterHash;
    if (!out.rosterOk) { out.reason = 'the list of who was on the wheel does not match the list frozen before the draw'; return out; }
    const again = runHeldDraw({
      candidates, serverSeed: r.serverSeed, elapsedMs: r.elapsedMs,
      degPerSecond: r.degPerSecond, spinDownDeg: r.spinDownDeg,
    });
    const indexOk = r.winnerIndex == null || again.index === r.winnerIndex;
    const keyOk = r.winnerKey == null || String(again.key) === String(r.winnerKey);
    out.winnerOk = indexOk && keyOk;
    if (!out.winnerOk) { out.reason = 'working the draw out again from the moment the button was pressed produces a different winner'; return out; }
    out.recomputedIndex = again.index;
    out.recomputedKey = again.key;
    out.recomputedLabel = again.label;
    out.landing = again.landing;
    out.ok = true;
    return out;
  } catch (e) {
    out.reason = `this draw could not be checked: ${(e && e.message) || e}`;
    return out;
  }
}

module.exports = {
  sha256Hex, newCommitment, commitmentHolds,
  landingFromPress, sliceAt, runHeldDraw, verifyHeldDraw,
  canonicalRoster, rosterHash,
  uniformBelow, pickWeighted, sliceAngles, targetRotationDeg,
  runDraw, verifyDraw,
};
