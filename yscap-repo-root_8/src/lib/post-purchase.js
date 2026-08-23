'use strict';
/**
 * THE POST-PURCHASE HAND-OFF — from "Encompass says this loan sold" to "PILOT's purchase is
 * finished" (owner-directed 2026-08-13, revised 2026-08-23).
 *
 * 2026-08-13, the original ask: *"the purchase advice date you enter manually in PILOT needs to
 * match the purchase advice date in Encompass … And when the system realizes that Encompass has a
 * purchase advice date filled out, it should email the post-purchase people on the file … but once
 * one of the two is done, the draw coordinator should be able to continue as usual — it's sold,
 * fine. PILOT should still have outstanding tasks for the post-purchaser to take care of."*
 *
 * 2026-08-23, the revision that removed one half of it: *"it should need to be filled into
 * Encompass, and from there our line and our field should automatically fill. You should not allow
 * somebody to type in that field."* There is no longer a hand-typed date to reconcile — Encompass
 * is where the sale is recorded and PILOT reads it — so the two-dates-must-match rule is gone and
 * the ADVICE DOCUMENT takes its place as what a finished purchase must leave behind.
 *
 * SO THERE ARE TWO CLOCKS, AND THEY DELIBERATELY DO NOT WAIT FOR EACH OTHER:
 *
 *   THE DRAW SIDE moves the moment the loan reads as sold (`sitewire/release-party.soldStatus`) —
 *     Encompass's date, table funding, or a pre-2026-08-23 record our desk still carries. The draw
 *     coordinator is never held up by paperwork sitting on another desk.
 *   THE PURCHASING SIDE stays OUTSTANDING until the post-purchase team finishes it here: the advice
 *     document uploaded and the purchase marked complete. That work does not disappear just because
 *     the draws carried on.
 *
 * This module owns the two things that join them up:
 *   · `adviceGate` (PURE) — the rule behind "mark purchase complete": Encompass must hold the date,
 *     and the advice document must be on the file.
 *   · `announceSold` (IO) — the once-only email to the post-purchase team the moment Encompass's
 *     date lands, plus the outstanding task it leaves behind on the purchasing desk.
 *
 * Never throws from the IO half: it rides a best-effort Encompass read, and a mail failure must
 * never break a sync or a screen.
 */

const db = require('../db');
const RP = require('../sitewire/release-party');   // paDateOf — ONE date parser for this fact

// ---------------------------------------------------------------------------
// The gate — pure
// ---------------------------------------------------------------------------

/** A date as a person reads it, from the calendar string this repo stores. */
function pretty(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(d || '');
}

/**
 * May this file's purchase be marked COMPLETE?
 *
 * TWO things have to be true, and each refusal says exactly which one is not — a gate that only
 * says "no" is a dead end, and the person reading it is the one who can fix it.
 *
 *   1. ENCOMPASS HOLDS A PURCHASE ADVICE DATE. Until it does, the sale is not recorded where the
 *      rest of the company reads it, so "purchase complete" here would be a claim PILOT cannot
 *      support.
 *   2. THE ADVICE DOCUMENT IS ON THE FILE. The advice itself — the paper naming the note buyer and
 *      what the loan sold for — is the thing a finished purchase is supposed to leave behind.
 *
 * WHY THE THIRD CHECK IS GONE (owner-directed 2026-08-23). Until today there was a third: PILOT had
 * to hold its own hand-typed date and the two had to be the same day. That check existed because two
 * people could type two different dates for one sale. Nobody types the date any more — it is entered
 * in Encompass and read from there — so the two can no longer disagree, and a rule that cannot fail
 * is not a safeguard, it is a step. The owner chose what replaces it: the document.
 *
 * The date halves of the old contract are deliberately NOT loosened by this. `no_encompass_advice`
 * is unchanged, so a purchase still cannot be completed on a loan Encompass does not record as sold.
 *
 * PURE — a date and a document id in, an answer out. The date is read through the SAME parser the
 * sold signal uses, so a timestamp, an ISO date and a US-style date all mean the calendar day they are.
 */
function adviceGate({ encompassDate = null, adviceDocumentId = null } = {}) {
  const enc = RP.paDateOf(encompassDate);
  if (!enc) {
    return {
      ok: false,
      code: 'no_encompass_advice',
      message: 'Encompass has no purchase advice date on this file yet, so the purchase can’t be '
        + 'marked complete. The date is entered on the loan in Encompass and PILOT reads it from '
        + 'there — put it in, and this clears by itself.',
    };
  }
  if (!adviceDocumentId) {
    return {
      ok: false,
      code: 'no_advice_document',
      message: `Encompass has the purchase advice dated ${pretty(enc)}. Upload the purchase advice `
        + 'document here and mark it as the advice, then the purchase can be completed.',
      encompass_date: enc,
    };
  }
  return { ok: true, code: 'ok', date: enc };
}

// ---------------------------------------------------------------------------
// The hand-off — IO
// ---------------------------------------------------------------------------

/** The task this leaves on the purchasing desk, worded as the thing to actually do.
 *
 *  NO LONGER "enter the purchase advice date" (owner-directed 2026-08-23): the date is entered in
 *  Encompass and PILOT reads it, so asking for it here would send somebody to a field that refuses
 *  them. What is genuinely left on this desk is the document and the sign-off. */
const TASK_LABEL = 'Upload the purchase advice document and mark the purchase complete';

/**
 * WHO gets the post-purchase email — the company-wide list (db/546), active internal staff only.
 * An empty list is returned as empty rather than guessed at: emailing the wrong people about a
 * loan sale is worse than emailing nobody, and the admin screen shows plainly when it is empty.
 */
async function recipients(dbc = db) {
  try {
    const r = await dbc.query(
      `SELECT su.id, su.full_name, su.email
         FROM post_purchase_notify p
         JOIN staff_users su ON su.id = p.staff_id
        WHERE su.is_active = true AND COALESCE(su.is_external, false) = false
        ORDER BY lower(su.full_name)`);
    return r.rows || [];
  } catch (_) { return []; }
}

/**
 * ENCOMPASS'S PURCHASE ADVICE DATE JUST LANDED — tell the post-purchase team, once.
 *
 * Called from `release-party.syncPurchaseAdviceDate`, which is the ONE place all three read paths
 * (the poll worker, the draw desk's own refresh, the manual button) land this date — so the email
 * cannot depend on which of them happened to notice.
 *
 * IT FIRES ONCE, and every reason to stay quiet is checked before anybody is emailed:
 *   · no date (it was cleared, not filled in) — nothing to announce;
 *   · we already announced this file (`purchase_advice_notified_at`);
 *   · the purchase is ALREADY complete here — the work this asks for is done, so asking would be
 *     noise on a finished file;
 *   · there is NOBODY on the notify list — see the note at the read, which is why that read happens
 *     before the stamp is claimed.
 * The stamp is written before the emails and only when it was still unset (`IS NULL`-guarded), so
 * two reads landing the same date at the same moment cannot both announce it.
 *
 * It also leaves the work VISIBLE rather than only emailed: an outstanding purchasing task, added
 * only if an identical one is not already sitting there.
 *
 * Never throws. Returns { announced:false, reason } or { announced:true, to, task }.
 */
async function announceSold(appId, paDate, { dbc = db } = {}) {
  try {
    if (!appId) return { announced: false, reason: 'no_file' };
    const date = RP.paDateOf(paDate);
    if (!date) return { announced: false, reason: 'no_date' };

    const row = (await dbc.query(
      `SELECT a.ys_loan_number, a.lender, a.purchase_advice_notified_at,
              a.property_address->>'oneLine' AS address,
              pw.status AS purchasing_status
         FROM applications a
         LEFT JOIN purchasing_workflow pw ON pw.application_id = a.id
        WHERE a.id=$1 AND a.deleted_at IS NULL`, [appId])).rows[0];
    if (!row) return { announced: false, reason: 'file_not_found' };
    if (row.purchase_advice_notified_at) return { announced: false, reason: 'already_announced' };
    if (row.purchasing_status === 'complete') return { announced: false, reason: 'purchase_already_complete' };

    /* THE WORK IS LEFT ON THE DESK FIRST, and unconditionally — it is the half that does not
       depend on anybody's email address being configured. Idempotent on its own (an identical
       OPEN task is never added twice), so it is safe to run on every read rather than only on
       the one that wins the stamp below. */
    let task = false;
    try {
      const purchasing = require('./purchasing');
      const existing = (await dbc.query(
        `SELECT 1 FROM purchasing_tasks WHERE application_id=$1 AND label=$2 AND done_at IS NULL`,
        [appId, TASK_LABEL])).rows[0];
      if (!existing) {
        if (!(await purchasing.getPurchasing(appId))) {
          // Not on the purchasing desk yet — the email still goes, so somebody puts it there.
        } else { await purchasing.addTask(dbc, appId, TASK_LABEL, null); task = true; }
      }
    } catch (_) { /* the email is the important half */ }

    /* WHO WOULD BE TOLD — read BEFORE the stamp is claimed, and this order is the fix, not a
       tidy-up. The stamp is once-only and permanent, so claiming it first meant that on a
       deployment whose `post_purchase_notify` list is still empty — which is how the table
       ships (db/546) — the sale was marked "announced", nobody was emailed, and the file could
       never announce again even after an admin filled the list in. An announcement with no
       audience is not an announcement: leave the stamp unset so the next read tries again, and
       report `no_recipients` rather than a success nobody received.
       The task above has already been left either way, so nothing about the WORK depends on the
       notify list being configured — only the telling does. */
    const people = await recipients(dbc);
    if (!people.length) return { announced: false, reason: 'no_recipients', task };

    // Claim the announcement — whoever wins the guarded UPDATE is the one that sends.
    const claim = await dbc.query(
      `UPDATE applications SET purchase_advice_notified_at=now(), updated_at=now()
        WHERE id=$1 AND purchase_advice_notified_at IS NULL RETURNING id`, [appId]);
    if (!claim.rowCount) return { announced: false, reason: 'already_announced', task };

    const where = row.address || row.ys_loan_number || 'this file';
    const notify = require('./notify');
    for (const p of people) {
      try {
        await notify.notifyStaff(p.id, {
          type: 'purchasing',
          title: 'This loan has been sold — finish the purchase in PILOT',
          body: `PILOT can see that ${where} was sold${row.lender ? ` to ${row.lender}` : ''} — Encompass now has the `
            + `purchase advice dated ${pretty(date)}, and PILOT has already recorded it.\n\n`
            + 'Please come into PILOT and finish the purchase on this file: upload the purchase advice '
            + 'document and mark the purchase complete. You do not need to type the date — it came '
            + 'across from Encompass on its own.',
          applicationId: appId,
          link: `/internal/app/${appId}`,
          ctaLabel: 'Open the file',
        });
      } catch (_) { /* one bad address must not stop the rest */ }
    }
    return { announced: true, to: people.map((p) => p.email), task, date };
  } catch (e) {
    return { announced: false, reason: (e && e.message) ? String(e.message).slice(0, 120) : 'error' };
  }
}

module.exports = { adviceGate, announceSold, recipients, TASK_LABEL, pretty };
