'use strict';
/**
 * THE POST-PURCHASE HAND-OFF — from "Encompass says this loan sold" to "PILOT's purchase is
 * finished" (owner-directed 2026-08-13).
 *
 * The owner, in their own words:
 *
 *   "Before we click Finalize Purchase on the purchasing side, the purchase advice date you enter
 *    manually in PILOT needs to match the purchase advice date in Encompass — they need to sync up
 *    to the same date, and Encompass needs to have a purchase advice date filled in in order for
 *    you to be able to mark purchase completed. And when the system realizes that Encompass has a
 *    purchase advice date filled out, it should email the post-purchase people on the file … 'Hey,
 *    PILOT sees that this file was sold. Please come into PILOT, upload the purchase advice, put in
 *    the purchase advice date and mark purchase completed.' … but once one of the two is done, the
 *    draw coordinator should be able to continue as usual — it's sold, fine. PILOT should still
 *    have outstanding tasks for the post-purchaser to take care of."
 *
 * SO THERE ARE TWO CLOCKS, AND THEY DELIBERATELY DO NOT WAIT FOR EACH OTHER:
 *
 *   THE DRAW SIDE moves the moment EITHER source says the loan is sold — Encompass's date, or our
 *     own purchasing desk's record (`sitewire/release-party.soldStatus`). The draw coordinator is
 *     never held up by paperwork sitting on another desk.
 *   THE PURCHASING SIDE stays OUTSTANDING until the post-purchase team finishes it here: the advice
 *     document uploaded, the date entered, the purchase marked complete. That work does not
 *     disappear just because the draws carried on.
 *
 * This module owns the two things that join them up:
 *   · `adviceGate` (PURE) — the rule behind "mark purchase complete": Encompass must hold a date,
 *     PILOT must hold one, and they must be the SAME DAY.
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
 * Three things have to be true, and each refusal says exactly which one is not — a gate that only
 * says "no" is a dead end, and the person reading it is the one who can fix it.
 *
 *   1. ENCOMPASS HOLDS A PURCHASE ADVICE DATE. Until it does, the sale is not recorded where the
 *      rest of the company reads it, so "purchase complete" here would be a claim PILOT cannot
 *      support.
 *   2. PILOT HOLDS ONE, entered on this desk with the advice document.
 *   3. THEY ARE THE SAME DAY. Two different dates for one sale is the thing this gate exists to
 *      catch: whichever is wrong, somebody has to look before the file is closed out.
 *
 * PURE — dates in, an answer out. Both are read through the SAME parser the sold signal uses, so a
 * timestamp, an ISO date and a US-style date all compare as the calendar days they are.
 */
function adviceGate({ encompassDate = null, pilotDate = null } = {}) {
  const enc = RP.paDateOf(encompassDate);
  const ours = RP.paDateOf(pilotDate);
  if (!enc) {
    return {
      ok: false,
      code: 'no_encompass_advice',
      message: 'Encompass has no purchase advice date on this file yet, so the purchase can’t be '
        + 'marked complete. PILOT re-checks on its own — use “Refresh PA date” on the draw desk to '
        + 'look right now, or ask for the date to be filled in on the loan.',
    };
  }
  if (!ours) {
    return {
      ok: false,
      code: 'no_pilot_advice',
      message: `Encompass has the purchase advice dated ${pretty(enc)}. Record the purchase advice `
        + 'here first — upload the document and enter the same date — then mark the purchase complete.',
    };
  }
  if (enc !== ours) {
    return {
      ok: false,
      code: 'advice_dates_differ',
      message: `The purchase advice dates don’t match: PILOT has ${pretty(ours)} and Encompass has `
        + `${pretty(enc)}. They have to be the same day before the purchase can be marked complete — `
        + 'correct whichever one is wrong.',
      pilot_date: ours,
      encompass_date: enc,
    };
  }
  return { ok: true, code: 'ok', date: enc };
}

// ---------------------------------------------------------------------------
// The hand-off — IO
// ---------------------------------------------------------------------------

/** The task this leaves on the purchasing desk, worded as the thing to actually do. */
const TASK_LABEL = 'Upload the purchase advice, enter the purchase advice date, and mark the purchase complete';

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
 *     noise on a finished file.
 * The stamp is written BEFORE the emails and only when it was still unset (`IS NULL`-guarded), so
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

    // Claim the announcement first — whoever wins the guarded UPDATE is the one that sends.
    const claim = await dbc.query(
      `UPDATE applications SET purchase_advice_notified_at=now(), updated_at=now()
        WHERE id=$1 AND purchase_advice_notified_at IS NULL RETURNING id`, [appId]);
    if (!claim.rowCount) return { announced: false, reason: 'already_announced' };

    // The work, left where the purchasing desk will see it even if the email is missed.
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

    const people = await recipients(dbc);
    const where = row.address || row.ys_loan_number || 'this file';
    const notify = require('./notify');
    for (const p of people) {
      try {
        await notify.notifyStaff(p.id, {
          type: 'purchasing',
          title: 'This loan has been sold — finish the purchase in PILOT',
          body: `PILOT can see that ${where} was sold${row.lender ? ` to ${row.lender}` : ''} — Encompass now has the `
            + `purchase advice dated ${pretty(date)}.\n\n`
            + 'Please come into PILOT and finish the purchase on this file: upload the purchase advice, '
            + `enter the same purchase advice date (${pretty(date)}), and mark the purchase complete. `
            + 'The date you enter has to match Encompass’s before PILOT will let the purchase be completed.',
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
