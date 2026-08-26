/**
 * esign/invite-recovery.js — THE BORROWERS WHO ARE STILL WAITING.
 *
 * db/631 fixes the signing invitation GOING FORWARD. It cannot help the packages that were
 * already sent while the defect was live: those envelopes are out at DocuSign, the borrower is
 * sitting at routing order 1 having received nothing, and NOTHING re-drives them —
 * `notifyReadyToSign` is called from the send (which has already happened) and from the webhook
 * (which only fires on a status transition that, for these rows, already came and went).
 *
 * The owner asked about exactly these files: *"please check it out from the previous file or
 * two. Why didn't the borrower receive it?"* So this is the previous half of the standing
 * previous-AND-future rule: a bounded, self-draining pass that hands each of them the invitation
 * they should have had.
 *
 * WHY A DATE, AND WHY THIS ONE. Before 4d34752 (2026-08-21 17:52 -0400, PR #1296) the ONLY guard
 * in notifyReadyToSign was "is the ENVELOPE sent" — there was no recipient-level turn test at
 * all, so every recipient on a live envelope WAS invited at send time. That commit added the
 * turn test, and from its deploy nobody was. So the envelope's own `created_at` separates the two
 * populations exactly, and the window is the four days between that deploy and this fix rather
 * than the whole back book. Without it this would nudge every borrower who has been sitting on an
 * unsigned package since June — an unrequested blast, and not what went wrong.
 *
 * THE CUTOFF ERRS EARLY, DELIBERATELY. It is the MERGE time, and the deploy followed it by the
 * length of a CI run. So a package sent inside that gap may be nudged a second time. That is the
 * cheap direction: a duplicate "your documents are ready to sign" on a package they genuinely
 * have not signed is a nudge with a working link, while missing one leaves the reported bug
 * standing on that file.
 *
 * IT DECIDES NOTHING ITSELF. Every rule — whose turn it is, an active staff row for one of our
 * own signers, the send-once stamp, the wording — belongs to `notifyReadyToSign`, and this only
 * chooses which envelopes to offer it. A second copy of the turn rule here is how the sweep and
 * the send path would come to disagree about who is owed an email.
 */
const dbDefault = require('../../db');

/* The merge that introduced the defect. Overridable so a deployment that shipped it at a
   different moment can say so, but never guessed at run time. */
const REGRESSION_AT = process.env.ESIGN_INVITE_RECOVERY_SINCE || '2026-08-21T21:52:38Z';
const BATCH = Math.max(0, Number(process.env.ESIGN_INVITE_RECOVERY_BATCH || 100) || 0);

/* A LIVE package with somebody on it we never invited AND whose turn is now. The turn term is
   what makes the pass DRAIN: a counter-signer on routing order 2 is legitimately uninvited and
   would otherwise re-select their envelope on every boot forever, doing nothing. Theirs arrives
   from the webhook when the signers before them finish, which is the correct path for it. */
const CANDIDATES = `
  SELECT DISTINCT e.id, e.created_at
    FROM esign_envelopes e
    JOIN esign_recipients r ON r.envelope_row_id = e.id
    JOIN applications a ON a.id = e.application_id
   WHERE a.deleted_at IS NULL
     /* A DEAD DEAL IS NOT OWED AN INVITATION. An envelope normally gets voided or cleared with
        its file, but not always — and "please sign your term sheet" landing on a loan that was
        withdrawn or declined is worse than the silence it replaces. */
     AND a.status NOT IN ('withdrawn', 'declined', 'cancelled')
     AND e.status IN ('sent', 'delivered')
     AND e.envelope_id IS NOT NULL
     AND e.application_id IS NOT NULL
     AND e.is_test = false
     AND e.cleared_at IS NULL
     AND e.created_at >= $1
     AND r.invited_at IS NULL
     AND r.signed_at IS NULL
     AND r.declined_at IS NULL
     AND r.email IS NOT NULL
     AND r.role IN ('borrower', 'co_borrower', 'loan_officer', 'admin')
     AND NOT EXISTS (SELECT 1 FROM esign_recipients e2
                      WHERE e2.envelope_row_id = r.envelope_row_id
                        AND e2.routing_order < r.routing_order
                        AND e2.signed_at IS NULL AND e2.declined_at IS NULL)
   ORDER BY e.created_at
   LIMIT $2`;

/**
 * Invite everybody a live package still owes an invitation to. Bounded per pass and
 * self-draining (a sent invitation stamps `invited_at`, which removes the row from the set).
 * NEVER THROWS — this runs at boot and may not be the reason a deploy fails to come up.
 */
async function recoverUninvitedOnce(opts = {}) {
  const db = opts.db || dbDefault;
  const out = { envelopes: 0, sent: 0, skipped: 0, reason: null };
  if (process.env.ESIGN_INVITE_RECOVERY_DISABLED === '1') return { ...out, reason: 'disabled' };
  /* `opts.limit` is how many packages ONE pass may take, not how far back it reaches — the
     window is fixed by REGRESSION_AT and is deliberately not a caller's choice. */
  const limit = Number.isFinite(Number(opts.limit)) ? Math.max(0, Number(opts.limit)) : BATCH;
  if (!limit) return { ...out, reason: 'disabled' };

  /* ONE INSTANCE AT A TIME, ACROSS PROCESSES. The window between selecting an envelope and
     stamping `invited_at` is real, so two instances booting together — an ordinary deploy on a
     scaled-out service — would both select the same package and both email its borrower.

     `pg_try_advisory_lock`, NOT the blocking form: a second instance should DROP this pass, not
     queue behind the first and then re-run a set that is already drained. And unlike the
     conditions engine, this FAILS CLOSED — refusing to run costs nothing (the next boot picks it
     up, and the set only shrinks), while running without the lock can put a second copy of a
     signing invitation in a borrower's inbox. */
  let lockConn = null;
  try {
    lockConn = await db.getClient();
    const held = (await lockConn.query(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', ['esign-invite-recovery'])).rows[0].ok;
    if (!held) {
      try { lockConn.release(); } catch (_) {}
      return { ...out, reason: 'already_running' };
    }
  } catch (e) {
    if (lockConn) { try { lockConn.release(); } catch (_) {} }
    console.warn('[esign-invite-recovery] could not take the lock:', e.message);
    return { ...out, reason: 'no_lock' };
  }

  try {
    let rows;
    try {
      rows = (await db.query(CANDIDATES, [REGRESSION_AT, limit])).rows;
    } catch (e) {
      console.warn('[esign-invite-recovery] load failed:', e.message);
      return { ...out, reason: 'load_failed' };
    }
    if (!rows.length) return out;
    const notify = opts.notify || require('./notify-signers');
    for (const r of rows) {
      try {
        const res = await notify.notifyReadyToSign(r.id, { db });
        out.envelopes++;
        out.sent += Number(res && res.sent) || 0;
        out.skipped += Number(res && res.skipped) || 0;
      } catch (e) {
        out.skipped++;
        console.warn('[esign-invite-recovery] envelope', r.id, 'failed:', e.message);
      }
    }
    /* NO SILENT CAPS. A full batch means there is more waiting, and the next boot takes it —
       say so rather than letting a truncated pass read as "everybody has been reached". */
    out.more = rows.length >= limit;
  } finally {
    try { await lockConn.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', ['esign-invite-recovery']); } catch (_) {}
    try { lockConn.release(); } catch (_) {}
  }
  console.log(`[esign-invite-recovery] ${out.sent} invitation(s) sent across ${out.envelopes} package(s)`
    + `, ${out.skipped} skipped${out.more ? ' — more remain, continuing next boot' : ''}`);
  return out;
}

module.exports = { recoverUninvitedOnce, _internals: { CANDIDATES, REGRESSION_AT, BATCH } };
