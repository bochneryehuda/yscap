'use strict';
/**
 * EXPERIENCE RE-ALLOCATION — moving the SAME qualified experience between the
 * fix-and-flip and fix-and-hold buckets is NOT a change that needs the Term Sheet
 * package cleared (owner-directed 2026-08-13).
 *
 * THE OWNER'S WORDS, on a live file: a term sheet was signed and issued on an
 * application claiming THREE fix-and-flips. Verification came back as TWO
 * fix-and-flips and ONE fix-and-hold — the same three deals, the same experience
 * level — but the track-record condition can only be signed off once the
 * application MATCHES what was verified, and the application could not be edited:
 * "It doesn't let it, and it says that you need to clear the term sheet, you need
 * to delete, you need to change, and then you need to reprice and reissue."
 *
 *   "What I want to do is for you to put a rule in the backend: between
 *    fix-and-flip and fix-and-hold, as long as it keeps the same backend amount,
 *    it should not be considered something that you need to clear the term sheet
 *    … if you put in 10 fix and flips and then you want to put in 5, you verify
 *    everything: only 5 fix-and-flips and 5 fix-and-holds. The qualified
 *    experience stays at 10. You should be able to edit the application, so you
 *    should be able to sign off the condition without needing to resend a new
 *    term sheet."
 *
 * And, twice, the two things that must STILL be refused:
 *
 *   "if somebody changes and he removes ground-up experience, then it does not
 *    qualify. If somebody removes either fix-and-flip or fix-and-hold and he puts
 *    it through REO, it does not qualify."
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SAFE, AND IT IS A PROPERTY OF THE FROZEN ENGINES — NOT A TOLERANCE
 *
 * The term-sheet freeze exists for exactly ONE reason, stated at the top of
 * file-lock.js: "so the sent term sheet can never silently disagree with the
 * file." A flip↔hold re-allocation cannot create that disagreement, because all
 * three frozen engines count those two buckets TOGETHER and never separately:
 *
 *   · standard-program.js  projectCount(sc, exp):
 *       sc === "NC" (ground-up)  →  exp.ground
 *       otherwise                →  exp.flips + exp.holds + exp.ground
 *   · gold-standard.js:
 *       renoCount  = expFlips + expHolds       (the reno / bridge track)
 *       groundCount = expGround                (the ground-up track)
 *   · silver-program.js  projectCount = YSP.projectCount  (the Standard one)
 *
 * So with `ground` held equal and `flips + holds` held equal, EVERY engine's
 * project count — and therefore the tier, and therefore every number on the term
 * sheet — is byte-identical by construction. That is why this carve-out needs no
 * per-file re-price to be trusted, and why it can be granted to EVERY user rather
 * than only a super-admin: the predicate is on the DATA, exactly like the
 * budget-neutral Scope-of-Work carve-out (`fileLock.sowLockReason`).
 *
 * THE TWO REFUSALS FALL OUT OF THE SAME ARITHMETIC — they are not special cases:
 *
 *   · GROUND-UP must be UNCHANGED. Moving a ground-up into flips would keep the
 *     renovation count but drop the ground-up count to zero, re-tiering (and
 *     possibly disqualifying) a ground-up deal. `ground` is therefore compared
 *     on its own and any move refuses.
 *   · FLIP/HOLD → REO refuses ON ITS OWN, with no rule about REO at all. REO is
 *     the RESIDUAL LIST (owner-directed 2026-08-09) — everything that is NOT
 *     counting — so `requested_exp_reo` is not an engine input, is not part of
 *     the qualified total, and is not even watched by the db/072 reopen trigger.
 *     Ten flips becoming five flips + five REO takes `flips + holds` from 10 to
 *     5, which is a real drop in qualified experience, so the total test refuses
 *     it. Which is exactly the owner's line. REO itself may move freely
 *     alongside a neutral swap precisely BECAUSE it changes no priced number.
 *
 * DELIBERATELY NARROW, in two directions. The request must touch NOTHING but the
 * experience counts — any other field falls straight through to the ordinary
 * freeze — and the STATUS freeze (Clear-to-Close / Funded / Declined / Withdrawn)
 * still stands, so this is a PRE-CTC carve-out only, mirroring `sowLockReason`.
 *
 * PURE — no database, no requires. `details-freeze.js` is the half that reads and
 * writes.
 */

// The request keys this carve-out is about → their `applications` columns. The
// details door's own NUM map is the source of these spellings; keep them in step.
const EXPERIENCE_KEYS = {
  requestedExpFlips: 'requested_exp_flips',
  requestedExpHolds: 'requested_exp_holds',
  requestedExpGround: 'requested_exp_ground',
  requestedExpReo: 'requested_exp_reo',
};

/* Control keys a caller may send alongside. `econVersion` is a concurrency stamp
   several callers attach; the override pair is how a super-admin asks for the
   separate, wider override in file-lock.detailsAdminOverride. Their PRESENCE
   never makes a request a re-allocation — only the experience keys do. */
const CONTROL_KEYS = new Set(['econVersion', 'adminOverride', 'overrideReason']);

/** A count as a non-negative integer. Blank / junk / negative all read as 0 — the
 *  same reading `experience.requestedFromApp` gives the stored columns, so the
 *  before- and after-pictures are always measured the same way. */
function count(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The four counts as they stand on an `applications` row. */
function experienceFromRow(row) {
  return {
    flips: count(row && row.requested_exp_flips),
    holds: count(row && row.requested_exp_holds),
    ground: count(row && row.requested_exp_ground),
    reo: count(row && row.requested_exp_reo),
  };
}

/**
 * The four counts as they WOULD stand after this request body is applied on top
 * of `before`. A key the body does not carry keeps the file's current value —
 * the same rule the details door itself applies, so this can never judge a
 * change the door would not actually make.
 */
function experienceAfter(before, body) {
  const b = body || {};
  const out = { ...before };
  for (const [key, col] of Object.entries(EXPERIENCE_KEYS)) {
    if (!(key in b)) continue;
    const k = col.replace('requested_exp_', '');
    out[k] = count(b[key]);
  }
  return out;
}

/**
 * Would this request CHANGE anything other than the experience counts?
 *
 * IT IS A VALUE TEST, NOT A KEY TEST, AND THAT IS THE WHOLE POINT. The details form
 * posts EVERY field on every save — program, price, term, the address, the lot —
 * whether or not the officer touched them. A "does the body carry only experience
 * keys?" test would therefore be false on every real save from the screen this
 * carve-out exists for, and the rule would never once fire. So each non-experience
 * key is compared to what the file already holds, and only a key whose value would
 * actually MOVE counts as touching something else.
 *
 * FAILS CLOSED, twice over. A key this module does not recognise, a value it cannot
 * compare, and a `property_address` in the body (the form sends it only when the
 * address changed) all read as "something else changed" — so an unmapped field can
 * only ever disable the carve-out, never ride through a frozen term sheet on it.
 *
 *   current  the file's row, as selected with the columns in `details-fields.ALL`
 *   body     the request
 *   kindOf   `details-fields.kindOf` — injected so this file stays pure
 *
 * Returns { onlyExperience, blockedBy } — `blockedBy` names the first offending
 * request key, for the refusal message and the tests.
 */
function changesOnlyExperience(current, body, fields) {
  const b = body || {};
  const keys = Object.keys(b);
  if (!keys.some((k) => k in EXPERIENCE_KEYS)) return { onlyExperience: false, blockedBy: null };
  for (const key of keys) {
    if (key in EXPERIENCE_KEYS) continue;
    if (CONTROL_KEYS.has(key)) continue;
    const kind = fields && fields.kindOf ? fields.kindOf(key) : null;
    // An unrecognised key, and an address (the form sends `propertyAddress` only
    // when it changed), both read as "something else changed" — fail closed.
    if (!kind || kind === 'jsonb') return { onlyExperience: false, blockedBy: key };
    const col = fields.ALL[key];
    if (!sameStoredValue(kind, b[key], current ? current[col] : undefined)) {
      return { onlyExperience: false, blockedBy: key };
    }
  }
  return { onlyExperience: true, blockedBy: null };
}

/**
 * Is this proposed value the one the file already holds?
 *
 * Deliberately LOOSE in the direction of "the same" — '12' vs 12, '' vs NULL, a pg
 * Date vs its YYYY-MM-DD rendering — because the form echoes stored values back in
 * whatever shape it rendered them. A pair it cannot CONFIDENTLY call equal is
 * reported as different, which refuses the carve-out: the safe way round.
 */
function sameStoredValue(kind, proposed, stored) {
  const blank = (v) => v == null || String(v).trim() === '';
  if (kind === 'bool') return !!proposed === !!stored;
  if (blank(proposed) && blank(stored)) return true;
  if (blank(proposed) !== blank(stored)) return false;
  if (kind === 'num') {
    const a = Number(proposed); const c = Number(stored);
    return Number.isFinite(a) && Number.isFinite(c) && a === c;
  }
  if (kind === 'date') {
    const day = (v) => (v instanceof Date
      ? (Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10))
      : String(v).slice(0, 10));
    const a = day(proposed); const c = day(stored);
    return !!a && a === c;
  }
  return String(proposed).trim() === String(stored).trim();
}

/**
 * THE PREDICATE. Is `after` the same qualified experience as `before`, merely
 * re-allocated between fix-and-flip and fix-and-hold?
 *
 *   · ground-up UNCHANGED                    (its own engine track)
 *   · flips + holds UNCHANGED                (the renovation track every engine sums)
 *   · at least one of flips / holds moved    (a no-op is not a re-allocation —
 *                                             it needs no carve-out and must not
 *                                             be reported as having used one)
 *
 * REO is deliberately absent: it is not part of the qualified total and not a
 * priced input, so it neither qualifies nor disqualifies a swap. A REO-ONLY edit
 * moves nothing in flips/holds and so is not a re-allocation either — see
 * `isPricingInert` for the change that touches no priced input at all.
 */
function isNeutralReallocation(before, after) {
  if (!before || !after) return false;
  if (count(before.ground) !== count(after.ground)) return false;
  const beforeReno = count(before.flips) + count(before.holds);
  const afterReno = count(after.flips) + count(after.holds);
  if (beforeReno !== afterReno) return false;
  return count(before.flips) !== count(after.flips) || count(before.holds) !== count(after.holds);
}

/**
 * Does this change touch NO priced experience input at all — i.e. only the REO
 * residual list moved (or nothing moved)? `requested_exp_reo` is read by nothing,
 * is not an engine input, and is not in the db/072 reopen trigger's watch list,
 * so writing it can never make a sent term sheet disagree with the file.
 *
 * Kept separate from `isNeutralReallocation` on purpose: they are different
 * statements ("the same experience, re-arranged" vs "nothing priced moved"), the
 * messages differ, and only the re-allocation needs the registration's stored
 * split brought along with it.
 */
function isPricingInert(before, after) {
  if (!before || !after) return false;
  return count(before.flips) === count(after.flips)
    && count(before.holds) === count(after.holds)
    && count(before.ground) === count(after.ground);
}

/** "2 flips + 1 hold" — for the audit trail and the refusal message. */
function describe(exp) {
  const e = exp || {};
  const bit = (n, one, many) => `${count(n)} ${count(n) === 1 ? one : many}`;
  const parts = [bit(e.flips, 'fix-and-flip', 'fix-and-flips'), bit(e.holds, 'fix-and-hold', 'fix-and-holds')];
  if (count(e.ground)) parts.push(bit(e.ground, 'ground-up', 'ground-ups'));
  if (count(e.reo)) parts.push(bit(e.reo, 'REO', 'REO'));
  return parts.join(' + ');
}

/**
 * WHY a change that touches only the experience counts is still frozen — in the
 * owner's own terms, so "put it back" is actionable instead of a mystery. Returns
 * '' when the change IS allowed (the caller should not be asking).
 */
function whyNotNeutral(before, after) {
  if (isNeutralReallocation(before, after) || isPricingInert(before, after)) return '';
  const groundMoved = count(before.ground) !== count(after.ground);
  const beforeReno = count(before.flips) + count(before.holds);
  const afterReno = count(after.flips) + count(after.holds);
  if (groundMoved) {
    return `Ground-up experience is counted on its own track, so it cannot be moved: this file has `
      + `${count(before.ground)} and the change would make it ${count(after.ground)}.`;
  }
  return `Fix-and-flip and fix-and-hold count together, and this change moves the total: `
    + `${beforeReno} → ${afterReno}. Moving deals BETWEEN fix-and-flip and fix-and-hold is fine — `
    + `taking them out of both (to REO, or by lowering the count) changes the experience the loan was priced on.`;
}

module.exports = {
  EXPERIENCE_KEYS,
  experienceFromRow,
  experienceAfter,
  changesOnlyExperience,
  sameStoredValue,
  isNeutralReallocation,
  isPricingInert,
  describe,
  whyNotNeutral,
  _internals: { count, CONTROL_KEYS },
};
