/* IS THE TERM SHEET PACKAGE FULLY EXECUTED? — the one definition.
 *
 * Owner-directed 2026-08-01: "The fully-signed term sheet package should be a
 * real gate", refining their earlier note that the executed DocuSign package
 * "should be the hold up for CTC … instead of just having a fake condition
 * holding that back, because it's a real step in the game".
 *
 * WHAT WAS WRONG. Nothing checked the package itself. The file carries the
 * condition `rtl_cond_signedts` ("Signed term sheet"), and a completed envelope
 * nudges it to 'received' — deliberately NOT 'satisfied', because a human still
 * signs it off (esign/webhook: "the conservative default"). It is `is_required`
 * but `is_gate=false`, so it lands in the ordinary blocking list and anyone can
 * clear it by ticking it. A file could therefore reach clear-to-close with the
 * term sheet never signed by anybody, as long as someone signed the condition
 * off — which is exactly the "fake condition" the owner described.
 *
 * (The old `rtl_p4_ts` "Term sheet generated" WAS a real gate, but db/052
 * retired it — is_active=false and stripped off every open file — so it gates
 * nothing on any live file. This replaces what that was meant to do, with the
 * real signal instead of a tick.)
 *
 * WHAT THIS IS. A read of the ACTUAL DocuSign state: is there a completed,
 * non-test term-sheet package on this file? Derived, so nobody can tick past
 * it, and it needs no backfill — it is true or false for every file, old and
 * new, the moment it is asked.
 *
 * NOT A NEW KIND OF BLOCK. It is returned as a `gate` from advancementBlockers,
 * which is the machinery the file already has: it makes the readiness widget
 * read "not ready", it refuses the move to clear-to-close, and an ADMIN can
 * still force past it — the same recorded, audited escape hatch every other
 * gate on this file has (`force && isAdmin`, stamped `forced` on the status
 * history). "Real gate" means nobody clears it by ticking a box, not that a
 * loan with a genuine reason can never move.
 *
 * FAILS OPEN. A DB error returns "executed" rather than inventing a blocker: a
 * statement timeout must never freeze every file in the pipeline out of
 * clear-to-close. The condition `rtl_cond_signedts` is still required and still
 * blocks on its own, so the file is never left completely ungated by a wobble.
 */

const dbDefault = require('../../db');

/* The envelope purpose the term sheet package is sent under — the same string
   esign/orchestrate builds it with. */
const TERM_SHEET_PURPOSE = 'term_sheet_package';

/* DocuSign is finished with an envelope only at 'completed'. 'sent' means it is
   still out for signature; 'declined' / 'voided' / 'error' are dead. A package
   that was CLEARED is voided by esign/clear, so a cleared-and-not-re-sent file
   correctly reads as not executed. */
const EXECUTED_STATUS = 'completed';

/* Read the file's term-sheet package state.
 *
 * Returns { executed, status, completedAt, envelopeId, reason }:
 *   executed   — true when a completed, non-test package exists
 *   status     — the furthest-along package's status, or null if none was ever sent
 *   reason     — plain wording for the person reading the readiness widget
 *
 * `is_test` envelopes are excluded: a test send is a dry run against a sandbox
 * signer and must never satisfy a real loan's gate.
 */
async function termSheetPackageState(appId, db = dbDefault) {
  if (!appId) return { executed: true, status: null, reason: null, unknown: true };
  try {
    const r = await db.query(
      `SELECT status, completed_at, id
         FROM esign_envelopes
        WHERE application_id = $1
          AND purpose = $2
          AND COALESCE(is_test, false) = false
        ORDER BY (status = $3) DESC, COALESCE(completed_at, created_at) DESC
        LIMIT 1`,
      [appId, TERM_SHEET_PURPOSE, EXECUTED_STATUS]);
    const row = r.rows[0] || null;
    if (row && row.status === EXECUTED_STATUS) {
      return { executed: true, status: row.status, completedAt: row.completed_at, envelopeId: row.id, reason: null };
    }
    return {
      executed: false,
      status: row ? row.status : null,
      completedAt: null,
      envelopeId: row ? row.id : null,
      reason: reasonFor(row ? row.status : null),
    };
  } catch (_) {
    // Fails OPEN — see the header. Never invent a blocker from an error.
    return { executed: true, status: null, reason: null, unknown: true };
  }
}

/* Plain wording for each not-yet-executed state, written for the person looking
   at the readiness widget rather than for a developer. */
function reasonFor(status) {
  switch (status) {
    case 'sent':
      return 'The term sheet package is out for signature but not everyone has signed it yet. '
           + 'Clear to close opens once the package is fully executed.';
    case 'declined':
      return 'The term sheet package was declined. Send a new package — clear to close needs a fully executed one.';
    case 'voided':
      return 'The term sheet package was cleared or voided. Send a new package — clear to close needs a fully executed one.';
    case 'error':
      return 'The term sheet package failed to send. Send it again — clear to close needs a fully executed one.';
    case 'not_sent':
      return 'The term sheet package has not gone out yet. Send it and get it fully signed before clear to close.';
    default:
      return 'No term sheet package has been sent on this file. Clear to close needs a fully executed one.';
  }
}

/* The blocker row, shaped like every other gate advancementBlockers returns, or
   null when the package is executed (or unreadable — fails open).
   `id` is a stable synthetic string, matching how the underwriting-dealbreaker
   row identifies itself; nothing dereferences it as a checklist_items uuid. */
async function termSheetGate(appId, db = dbDefault) {
  const st = await termSheetPackageState(appId, db);
  if (st.executed) return null;
  return {
    id: 'esign_term_sheet_package',
    label: 'Signed term sheet package',
    title: 'Signed term sheet package',
    // Points at the e-sign section, where the package is actually sent and
    // watched — not at the conditions list, where there is nothing to do.
    section: 'sec-esign',
    source: 'esign',
    reason: st.reason,
    packageStatus: st.status,
  };
}

module.exports = { termSheetGate, termSheetPackageState, TERM_SHEET_PURPOSE, EXECUTED_STATUS, _internals: { reasonFor } };
