'use strict';

/**
 * THE EXPERIENCE TYPED IN THE TERM SHEET STUDIO IS THE FILE'S CLAIM
 * (owner-directed 2026-08-06).
 *
 * The owner, on a live file: *"they entered under Experience 10, Rentals
 * Stabilized, and on the condition it says that they don't need to verify
 * anything. If they entered any experience on the term sheet generated, they
 * should feed directly into the file, and the condition should require verifying
 * 10. You should not be able to sign it off till you verify 10."*
 *
 * ROOT CAUSE. Experience reached `applications.requested_exp_*` from every door
 * EXCEPT the one an officer actually uses to build a deal: the Term Sheet Studio
 * on the file. `POST /pricing/quote` persists nothing by design, and the
 * write-back in `product-registration.persistProductRegistration` only runs on
 * REGISTER — so an officer who typed 10 into "BRRRR / rentals stabilized",
 * generated the term sheet and stopped there left the file claiming ZERO. And
 * zero is not a neutral state anywhere downstream: `experience.js` reads the
 * claim, sees nothing to verify, stamps the track-record condition
 * `notApplicable`, and `signOffGate` returns null on `claimed === 0` — so the
 * condition reads "No experience required on this file" and signs off freely on
 * a deal that was priced on ten stabilized rentals.
 *
 * THE CLASS: a value a user TYPES that only reaches the file on a LATER,
 * OPTIONAL step is silently discarded for every user who does not take that
 * step — and every consumer downstream reads the absence as a confident "none",
 * not as "not stated". The studio scenario already persists (the pricing
 * condition's `tool_state`), so the fix is to let the claim ride that same save
 * onto the column that is the single source of truth, rather than to teach each
 * consumer about a second place experience can live.
 *
 * THE SEMANTICS ARE THE REGISTER PATH'S, DELIBERATELY. A field carrying a real
 * number wins VERBATIM — including 0, so a claim can be LOWERED and stick (the
 * owner's 2026-07-28 rule: *"no matter how many times I remove the 5 and put 0
 * it comes back"*). A BLANK field states nothing and leaves the column alone: a
 * blank is not a deliberate zero, which is exactly what `claimExpVal` already
 * encodes for the register. Keeping the two identical is the point — the studio
 * must not mean one thing when you press Register and another when you don't.
 *
 * STAFF ONLY, and that is not an oversight against the all-sides rule. A
 * borrower CANNOT type experience in their studio at all (`ProductStudioPanel`
 * locks those three fields for them, and the borrower register route strips
 * every experience override) — they have no way to produce this bug. Wiring
 * their autosave to this would OPEN one instead: a resumed borrower draft
 * echoing a stale number would silently rewrite the claim the whole
 * verification requirement is measured against. The borrower REQUESTS an
 * experience change and the team approves it; that path is untouched.
 */

// `db` and `file-lock` are required LAZILY, inside the IO half only, so the
// PURE reader below loads with no database in reach and can be unit-tested
// without one — the same split as esign/term-sheet-stamp.js. `number-bounds` is
// pure, so it rides at the top.
const { intOverflows } = require('./number-bounds');

/** The studio field id for each application column. `expBrrrr` ("BRRRR /
 *  rentals stabilized") is the holds bucket — the SAME mapping every other
 *  surface already uses (Apply.jsx, scenario.js, intake.js, ProductStudioPanel
 *  ID_FOR). Never re-spell it locally. */
const STUDIO_FIELD = { flips: 'expFlips', holds: 'expBrrrr', ground: 'expGround' };
const COLUMN = { flips: 'requested_exp_flips', holds: 'requested_exp_holds', ground: 'requested_exp_ground' };
const BUCKETS = ['flips', 'holds', 'ground'];

/**
 * PURE. What experience does this saved studio scenario STATE?
 *
 * Returns `{flips, holds, ground}` where a number (including 0) is a stated
 * claim and `null` is "the studio said nothing about this bucket" — absent,
 * blank, or a value the column could never hold.
 *
 * `state` is the `{v, c}` shape `studioStateFromFields` writes; a bare field bag
 * is accepted too so a caller never has to know which it holds. Never throws.
 */
function studioClaimFrom(state) {
  const out = { flips: null, holds: null, ground: null };
  if (!state || typeof state !== 'object') return out;
  const v = (state.v && typeof state.v === 'object') ? state.v : state;
  for (const bucket of BUCKETS) {
    const raw = v[STUDIO_FIELD[bucket]];
    if (raw == null) continue;
    const s = String(raw).trim();
    if (s === '') continue;                       // blank states nothing (never a deliberate 0)
    if (!/^-?\d+$/.test(s)) continue;             // not a whole count — say nothing rather than guess
    const n = parseInt(s, 10);
    if (!Number.isFinite(n) || n < 0) continue;   // a negative deal count is not a claim
    // requested_exp_* is int4. An unstorable count must never reach the write
    // (22003 → a 500 the officer reads as "PILOT is broken"); it states nothing.
    if (intOverflows(n)) continue;
    out[bucket] = n;
  }
  return out;
}

/** True when the scenario states at least one bucket. */
function statesAnything(claim) {
  return BUCKETS.some((b) => claim && claim[b] != null);
}

/**
 * Is this file frozen against a structural write?
 *
 * FAILS CLOSED, unlike `fileLock.structuralLockReason`, which swallows a read
 * error and answers "not locked". That is right for a human pressing Save (a
 * database hiccup must not refuse their edit) and exactly wrong for an
 * unattended writer, where a statement timeout would read a FUNDED file as
 * unlocked and let a background save move a pricing input on it. Same reasoning
 * — and the same `_internals` composition — as the appraisal As-Is writer.
 *
 * Called with NO actor on purpose, so this can never inherit a super-admin's
 * unlock: a human who unlocked a cleared-to-close file to edit it is not asking
 * an autosave to rewrite the experience claim behind them.
 */
async function frozen(appId, client) {
  const I = require('./file-lock')._internals;
  try {
    const row = await I.lockInputs(appId, client);
    if (!row) return true;                        // no file to judge → do nothing
    return !!(I.statusFreezeReason(row, {}) || I.termSheetFreezeReason(row, {}));
  } catch (_) { return true; }
}

/**
 * Feed the studio's stated experience onto the file.
 *
 * Returns `{written, claim, skipped}` — `skipped` naming why nothing moved, so
 * a caller (and a test) can tell "nothing to say" apart from "refused". NEVER
 * throws: this rides an autosave, and a save must never fail because the claim
 * could not be fed.
 *
 * The UPDATE writes only the buckets the scenario STATED and is guarded with
 * `IS DISTINCT FROM`, so a scenario that merely echoes the file touches no row
 * — which matters because `requested_exp_*` is watched by the db/071/072
 * reopen trigger, and a no-op write would reopen Products & Pricing on every
 * keystroke's autosave.
 */
async function applyStudioExperienceClaim(appId, state, client) {
  const db = require('../db');
  if (!client) client = db;
  const claim = studioClaimFrom(state);
  if (!appId) return { written: false, claim, skipped: 'no_file' };
  if (!statesAnything(claim)) return { written: false, claim, skipped: 'nothing_stated' };
  try {
    // The OVERWHELMINGLY common autosave merely echoes what the file already
    // says (the studio prefills from it, and the panel snaps the file's values
    // back onto a resumed draft). Answer that case with ONE primary-key read
    // rather than a freeze probe plus a write attempt — this runs on every
    // debounced keystroke pass, so the quiet path has to be cheap.
    const cur = (await client.query(
      `SELECT ${BUCKETS.map((b) => COLUMN[b]).join(', ')} FROM applications WHERE id=$1`, [appId])).rows[0];
    if (!cur) return { written: false, claim, skipped: 'no_file' };
    const moves = BUCKETS.some((b) => claim[b] != null && Number(cur[COLUMN[b]]) !== claim[b]);
    if (!moves) return { written: false, claim, skipped: 'unchanged' };
    if (await frozen(appId, client)) return { written: false, claim, skipped: 'file_frozen' };
    const sets = [];
    const params = [appId];
    const guards = [];
    for (const bucket of BUCKETS) {
      if (claim[bucket] == null) continue;
      const col = COLUMN[bucket];
      params.push(claim[bucket]);
      sets.push(`${col}=$${params.length}`);
      guards.push(`${col} IS DISTINCT FROM $${params.length}`);
    }
    const r = await client.query(
      `UPDATE applications SET ${sets.join(', ')}, updated_at=now()
        WHERE id=$1 AND (${guards.join(' OR ')})
        RETURNING id`, params);
    if (!r.rows[0]) return { written: false, claim, skipped: 'unchanged' };
    // Flip the track-record condition out of "No experience required" NOW, so
    // the officer sees the requirement on the screen they are already looking
    // at rather than on some later checklist load.
    try { await require('./experience').syncExperienceChecklistForApplication(appId, client); } catch (_) { /* best-effort */ }
    return { written: true, claim, skipped: null };
  } catch (e) {
    try { console.warn('[studio-experience] claim write skipped:', require('../db').describeError(e)); } catch (_) {}
    return { written: false, claim, skipped: 'error' };
  }
}

module.exports = {
  studioClaimFrom, statesAnything, applyStudioExperienceClaim,
  STUDIO_FIELD, COLUMN, BUCKETS,
  _internals: { frozen },
};
