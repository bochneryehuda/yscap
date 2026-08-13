'use strict';
/**
 * THE APPLICATION-DETAILS DOOR'S FREEZE, WITH ITS TWO 2026-08-13 CARVE-OUTS.
 *
 * `payoffContactLockReason` is still the base rule and is called here UNCHANGED —
 * this module only decides what to do when it says no. Two things may now get
 * through a SENT term sheet without clearing the package (owner-directed
 * 2026-08-13):
 *
 *   1. AN EXPERIENCE RE-ALLOCATION, for EVERY user. Moving deals between
 *      fix-and-flip and fix-and-hold while the qualified total and the ground-up
 *      count stay put. Provably priced-identical in all three frozen engines — see
 *      experience-realloc.js for the proof and file-lock.experienceReallocation for
 *      the freeze decision.
 *   2. A SUPER-ADMIN OVERRIDE of ANY details field, behind a DOUBLE WARNING + a
 *      typed reason (file-lock.detailsAdminOverride). "Only superadmin, not regular
 *      admins."
 *
 * IN BOTH CASES "WITHOUT CLEARING THE TERM SHEET" IS AN ACTIVE JOB, NOT THE ABSENCE
 * OF A REFUSAL. The db/072 + db/486 trigger reopens Products & Pricing, the
 * signed-term-sheet condition (and, when the loan amount / budget move, the Heter
 * Iska and the Scope of Work) and flags the registration STALE — at the DB layer, on
 * ANY write path. So merely letting the save through would leave the owner with the
 * exact "reprice and reissue" they asked to avoid. `capture()` reads those rows
 * BEFORE the write and `restore()` puts them back after — the same mechanism
 * `asis-arv-override.apply()` uses for "Save ARV, keep the loan".
 *
 * AND THE RE-ALLOCATION HAS A SECOND HALF THE OTHERS DO NOT NEED. The experience
 * CONDITION is not gated on the application's claim: `signOffGate` measures the
 * verified track record against the CURRENT REGISTRATION's stored experience
 * (`experience.registeredExperienceNeed`). Editing the application alone would
 * therefore change nothing the owner can see — the condition would still demand
 * three verified FLIPS. `syncRegistrationExperience()` moves the registration's
 * stored split with it, which is safe for exactly the reason the carve-out is safe:
 * the engines read `expFlips + expHolds` as ONE number, so the registration remains
 * a truthful record of the experience the loan was priced on.
 *
 * IT IS DELIBERATELY *NOT* DONE FOR THE SUPER-ADMIN OVERRIDE. That change is not
 * priced-neutral (10 flips → 5 flips + 5 REO genuinely lowers the qualified
 * experience), so rewriting the registration to match would falsify the record of
 * what the borrower was actually quoted. A super-admin who then needs the condition
 * cleared uses the existing audited super-admin condition override (db/344), which
 * records what was missing.
 *
 * Anything this module cannot PROVE is neutral stays FROZEN, and an unreadable file
 * behaves exactly like `payoffContactLockReason` (no hard block).
 */
const db = require('../db');
const fileLock = require('./file-lock');
const realloc = require('./experience-realloc');
const fields = require('./details-fields');

/* Which conditions the reopen trigger touches. `product_pricing` and the
   signed-term-sheet condition move on ANY pricing input (db/072 + db/486); the
   Heter Iska is gated on the loan amount and the Scope of Work on the construction
   budget, so an experience-only change can never disturb those two — but the
   super-admin override can change any field, so its capture set is the superset.
   Over-capturing is harmless (restoring a row to the value it already holds is a
   no-op); under-capturing would leave a condition reopened, which is the whole
   thing this exists to prevent. */
const EXPERIENCE_CONDITION_SQL = `(ci.tool_key = 'product_pricing' OR t.code = 'rtl_cond_signedts')`;
/* THE SCOPE OF WORK IS DELIBERATELY *NOT* RE-ASSERTED, on either path.
   A changed construction budget genuinely invalidates the line items — the SOW must
   total the new budget to the cent before it can be signed off again — so putting its
   sign-off back would be claiming a match that no longer exists. It is also not ours
   to put back: the db/069 belt-and-suspenders trigger REFUSES any write flipping a
   budget condition to 'satisfied' while the totals disagree, so a re-assert would
   raise, be swallowed row-by-row, and leave the condition reopened anyway — the same
   end state, reached less honestly. An override lets the EDIT through and keeps the
   sent term sheet; it does not pretend the scope still matches. */
const ALL_CONDITION_SQL =
  `(ci.tool_key = 'product_pricing' OR t.code IN ('rtl_cond_signedts', 'rtl_cond_iska'))`;

/**
 * Decide what the details door should do with this request on this file.
 *
 * Returns one of:
 *   { mode: 'none' }                                   — nothing frozen; save normally
 *   { mode: 'refused', reason }                        — the freeze stands; answer 409
 *   { mode: 'reallocation', before, after, note }      — allowed; capture + restore + sync the registration
 *   { mode: 'inert',        before, after, note }      — allowed; capture + restore (nothing priced moved)
 *   { mode: 'admin_override', reason: overrideReason, note }
 *                                                      — allowed; capture + restore, registration untouched
 *
 * `opts` is `{ actor }` exactly as `payoffContactLockReason` takes it.
 */
async function evaluate(appId, body, client = db, opts = {}) {
  const b = body || {};
  // THE BASE RULE, UNCHANGED — including its payoff-contact closing-prep carve-out.
  // Nothing below can be reached while this says the file is editable, so a file
  // that is not frozen behaves byte-for-byte as it always has.
  const baseReason = await fileLock.payoffContactLockReason(appId, b, client, opts);
  if (!baseReason) return { mode: 'none' };

  // The lock row is read ONCE and handed to the pure decisions, so a transient read
  // failure can never lift a freeze the base rule already established (the
  // "fail-open second read" the terms-neutral carve-out was corrected for).
  let row = null;
  try { row = await fileLock._internals.lockInputs(appId, client); }
  catch (_) { return { mode: 'refused', reason: baseReason }; }
  if (!row) return { mode: 'refused', reason: baseReason };

  // ── 2. THE SUPER-ADMIN OVERRIDE ──────────────────────────────────────────────
  // Checked FIRST because it is the explicitly-requested one: a super-admin who has
  // clicked through the double warning is asking for THIS, and must get its wording
  // (and its audit record) even when the change happens also to be a neutral swap.
  if (b.adminOverride === true) {
    const reason = String(b.overrideReason || '').trim();
    if (!reason) {
      return { mode: 'refused', code: 400, reason: 'Enter a short reason for the override before saving.' };
    }
    const block = fileLock.detailsAdminOverride(row, { actor: opts.actor, overrideRequested: true });
    if (block) {
      const isSuper = !!(opts.actor && opts.actor.kind === 'staff' && opts.actor.role === 'super_admin');
      return {
        mode: 'refused',
        code: isSuper ? 409 : 403,
        reason: isSuper
          ? block
          : 'Only a super admin can override a sent term sheet. ' + block,
      };
    }
    return {
      mode: 'admin_override',
      reason,
      note: 'Super-admin override of the sent term sheet — the loan, the registration and the sent '
        + 'term sheet were kept exactly as they are; only the recorded application details changed.',
    };
  }

  // ── 1. THE EXPERIENCE RE-ALLOCATION (every user) ─────────────────────────────
  // The request must CHANGE nothing but the experience counts — a value test, not a
  // key test, because the details form posts every field on every save (see
  // experience-realloc.changesOnlyExperience). Any other field genuinely moving is
  // a change the sent term sheet cannot see, so the ordinary freeze governs.
  const cols = [...new Set(Object.values(fields.ALL))].join(', ');
  let cur = null;
  try { cur = (await client.query(`SELECT ${cols} FROM applications WHERE id=$1`, [appId])).rows[0]; }
  catch (_) { return { mode: 'refused', reason: baseReason }; }
  if (!cur) return { mode: 'refused', reason: baseReason };

  const scope = realloc.changesOnlyExperience(cur, b, fields);
  if (!scope.onlyExperience) return { mode: 'refused', reason: baseReason };

  const before = realloc.experienceFromRow(cur);
  const after = realloc.experienceAfter(before, b);

  const neutral = realloc.isNeutralReallocation(before, after);
  const inert = !neutral && realloc.isPricingInert(before, after);
  const block = fileLock.experienceReallocation(row, neutral || inert, { actor: opts.actor });
  if (block) {
    // Say WHY the carve-out did not apply, in the owner's own terms, so "put it
    // back" is actionable — the same discipline `sowLockReason` follows. A STATUS
    // freeze is a different refusal entirely and keeps its own wording.
    const statusFrozen = !!fileLock._internals.statusFreezeReason(row, { actor: opts.actor });
    if (statusFrozen) return { mode: 'refused', reason: block };
    const why = realloc.whyNotNeutral(before, after);
    return {
      mode: 'refused',
      reason: 'The Term Sheet DocuSign package has been sent, so the loan’s figures and structure are frozen. '
        + 'You can still move experience BETWEEN fix-and-flip and fix-and-hold as long as the total stays the same '
        + `and ground-up does not move. ${why} `
        + 'Put the counts back, or clear the Term Sheet package first (that removes the sent term sheet and reopens '
        + 'the term-sheet and application conditions), then re-register.',
    };
  }

  return {
    mode: neutral ? 'reallocation' : 'inert',
    before,
    after,
    note: neutral
      ? `Experience re-allocated between fix-and-flip and fix-and-hold with the qualified total unchanged `
        + `(${realloc.describe(before)} → ${realloc.describe(after)}) — the sent term sheet prices identically, `
        + `so it was left in place.`
      : `Only the REO list changed (${realloc.describe(before)} → ${realloc.describe(after)}) — no priced input `
        + `moved, so the sent term sheet was left in place.`,
  };
}

/**
 * The exact state the reopen trigger is about to destroy: the conditions it
 * reopens and the current registration's stale flag. Read BEFORE the write.
 * Never throws — a capture that fails returns null and `restore()` then does
 * nothing, which fails in the SAFE direction (the conditions stay reopened, so the
 * file honestly looks like it needs re-registering rather than silently claiming
 * a term sheet still matches).
 */
async function capture(appId, mode, client = db) {
  const condSql = mode === 'admin_override' ? ALL_CONDITION_SQL : EXPERIENCE_CONDITION_SQL;
  try {
    const items = (await client.query(
      `SELECT ci.id, ci.status, ci.signed_off_at, ci.signed_off_by, ci.reviewed_at, ci.reviewed_by, ci.notes
         FROM checklist_items ci LEFT JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.application_id = $1 AND ${condSql}`, [appId])).rows;
    const reg = (await client.query(
      `SELECT stale, stale_reason FROM product_registrations WHERE application_id = $1 AND is_current LIMIT 1`,
      [appId])).rows[0] || null;
    return { items, reg };
  } catch (_) { return null; }
}

/**
 * Put back exactly what `capture()` read, so the sent term sheet and its conditions
 * come out of the write untouched. Idempotent — restoring a row to the value it
 * already holds is a no-op — so a retry is always safe. Never throws.
 * Returns the number of condition rows restored.
 */
async function restore(appId, snap, client = db) {
  if (!snap) return 0;
  let n = 0;
  for (const it of snap.items || []) {
    try {
      await client.query(
        `UPDATE checklist_items
            SET status = $2, signed_off_at = $3, signed_off_by = $4, reviewed_at = $5, reviewed_by = $6,
                notes = $7, updated_at = now()
          WHERE id = $1`,
        [it.id, it.status, it.signed_off_at, it.signed_off_by, it.reviewed_at, it.reviewed_by, it.notes]);
      n += 1;
    } catch (_) { /* best-effort, per row */ }
  }
  if (snap.reg) {
    try {
      await client.query(
        `UPDATE product_registrations SET stale = $2, stale_reason = $3 WHERE application_id = $1 AND is_current`,
        [appId, snap.reg.stale, snap.reg.stale_reason]);
    } catch (_) { /* best-effort */ }
  }
  return n;
}

/**
 * Move the CURRENT registration's stored experience split to match the application,
 * for a proven RE-ALLOCATION only.
 *
 * This is what makes the owner's ask actually work end to end: the experience
 * condition's requirement comes from `experience.registeredExperienceNeed`, which
 * reads THIS jsonb — so without it, editing the application to "2 flips + 1 hold"
 * would leave the condition still demanding 3 verified flips and the sign-off still
 * refused, which is the dead end the whole change exists to remove.
 *
 * SAFE FOR THE SAME REASON THE CARVE-OUT IS SAFE: every frozen engine reads
 * `expFlips + expHolds` as one number, so the registration still records the exact
 * experience the loan was priced on — only its split is corrected to what was
 * verified. The merge is a jsonb `||` so nothing else in `inputs` can be disturbed,
 * and `quote` is deliberately untouched (not one number in it moves).
 *
 * Never throws.
 */
async function syncRegistrationExperience(appId, after, client = db) {
  try {
    const r = await client.query(
      `UPDATE product_registrations
          SET inputs = inputs || jsonb_build_object('expFlips', $2::int, 'expHolds', $3::int, 'expGround', $4::int)
        WHERE application_id = $1 AND is_current`,
      [appId, Math.max(0, after.flips | 0), Math.max(0, after.holds | 0), Math.max(0, after.ground | 0)]);
    return r.rowCount;
  } catch (_) { return 0; }
}

module.exports = {
  evaluate, capture, restore, syncRegistrationExperience,
  _internals: { EXPERIENCE_CONDITION_SQL, ALL_CONDITION_SQL },
};
