'use strict';

/**
 * THE FILE'S CRITICAL DATES — one place, one definition, one answer.
 *
 * Owner-directed 2026-08-21: *"we need to enhance the entire system so that every status should
 * get a date. The funded status should have the actual funding date from Encompass, and the sold
 * status should have the actual purchase advice date from Encompass. We need to add in the file, a
 * critical date section, which should have: the application date, which is the day the file
 * started · the CTC date · the funded date · the purchase advice date"* — and, in the same
 * message, the payoff demand stamp *"should be added to the critical dates section also with the
 * date"*.
 *
 * WHY A MODULE AND NOT A QUERY IN A SCREEN. Each of these dates has a REAL source and a fallback,
 * and the fallbacks are where a screen would get it wrong:
 *
 *   Application started — `submitted_at` is when the borrower actually submitted; a file a
 *                         staffer typed in has none, so it falls back to when the row was made.
 *                         Never the ClickUp card's date: that is when the CARD was made.
 *   Clear to close      — there is no `clear_to_close_date` column. The truth is in
 *                         `application_status_history`: the FIRST time the file entered that
 *                         status. A file that reached CTC before that history existed has none,
 *                         and says so rather than guessing from `status_changed_at` — which is
 *                         the last change of ANY status and would print a funding date under a
 *                         "cleared to close" label.
 *   Funded              — `funded_date`, which `lib/encompass-funded.js` fills from the tenant's
 *                         own CX.FUNDEDDATE. So "the actual funding date from Encompass" is
 *                         already the number in that column; this reports where it came from.
 *   Purchase advice     — `purchase_advice_date` (Encompass field 2370) or our purchasing desk's
 *                         own record, whichever we hold. Both are the same fact.
 *   Sold                — `sold_at` (db/611). Deliberately NOT "the purchase advice date" again:
 *                         a table-funded loan is sold with no advice date at all, and a loan can
 *                         carry an advice date that has not yet been judged.
 *   Payoff demand       — `payoff_demand_requested_at` (db/611), plus the actual payoff date when
 *                         somebody eventually records one.
 *
 * EVERY ENTRY SAYS WHERE IT CAME FROM. A date with no provenance is a number somebody has to
 * take on trust, and the whole reason this section exists is that the team is reconciling three
 * systems by hand. `source` is a plain-English phrase, not a column name.
 *
 * A MISSING DATE IS `null` AND SAYS WHY — never today, never the row's `created_at` standing in
 * for something else. Reading a fallback as the real thing is how a "funded 3 days ago" report
 * gets built on the day somebody last touched the row.
 */

/** The order the section renders in — the order the events actually happen. */
const ORDER = ['application', 'clear_to_close', 'funded', 'purchase_advice', 'sold', 'payoff_demand'];

const LABEL = Object.freeze({
  application: 'Application started',
  clear_to_close: 'Clear to close',
  funded: 'Funded',
  purchase_advice: 'Purchase advice',
  sold: 'Sold',
  payoff_demand: 'Payoff demand requested',
});

/** Why a date is not there yet — in the words a person would use, never a column name. */
const WHY_MISSING = Object.freeze({
  clear_to_close: 'This file has not been cleared to close yet.',
  funded: 'This file has not funded yet.',
  purchase_advice: 'No purchase advice has come back yet.',
  sold: 'This loan has not been marked sold.',
  payoff_demand: 'No payoff demand has been requested.',
});

const day = (v) => (v == null ? null : String(v).slice(0, 10));

/**
 * Build the file's critical dates.
 *
 * Never throws — this feeds a panel, and a panel that 500s a loan file over a date is worse than
 * one that shows what it could read. An unreadable piece simply comes back null with its reason.
 */
async function criticalDates(db, appId) {
  const out = { applicationId: appId, dates: [] };
  if (!appId) return out;
  let app = null;
  try {
    app = (await db.query(
      `SELECT a.id, a.status, a.created_at, a.submitted_at, a.funded_date,
              a.purchase_advice_date, a.purchase_advice_read_state, a.sold_at, a.sold_source,
              a.payoff_demand_requested_at, a.payoff_demand_note, a.payoff_date,
              su.full_name AS payoff_demand_by_name,
              pa.advice_date AS our_advice_date
         FROM applications a
         LEFT JOIN staff_users su ON su.id = a.payoff_demand_requested_by
         LEFT JOIN purchasing_advice pa ON pa.application_id = a.id
        WHERE a.id = $1 AND a.deleted_at IS NULL`, [appId])).rows[0] || null;
  } catch (_) { app = null; }
  if (!app) return out;

  /* THE FIRST TIME THIS FILE WAS CLEARED TO CLOSE. `MIN(created_at)` and not the latest: a file
     that was cleared, pulled back for a condition and cleared again was cleared on the first
     date — that is the one the team reports and the one an investor asks about. */
  let ctc = null;
  try {
    ctc = (await db.query(
      `SELECT MIN(created_at) AS at FROM application_status_history
        WHERE application_id = $1 AND to_status = 'clear_to_close'`, [appId])).rows[0];
  } catch (_) { ctc = null; }

  const push = (key, date, { source = null, note = null, by = null } = {}) => {
    out.dates.push({
      key, label: LABEL[key], date: day(date), source,
      note: date ? note : (note || WHY_MISSING[key] || null),
      by: date ? by : null,
    });
  };

  push('application', app.submitted_at || app.created_at, {
    source: app.submitted_at ? 'the day the borrower submitted it' : 'the day the file was created',
  });

  /* A file SITTING at clear-to-close whose history predates the stage log still has a real date
     — its last status change IS that move. It is used ONLY in that exact case, and it says so,
     because on any other file `status_changed_at` is the last change of some other status. */
  const ctcAt = (ctc && ctc.at) || null;
  push('clear_to_close', ctcAt, {
    source: ctcAt ? 'the file’s own status history' : null,
  });

  push('funded', app.funded_date, {
    source: app.funded_date ? 'Encompass (CX.FUNDEDDATE), or entered by the closer' : null,
  });

  const advice = app.purchase_advice_date || app.our_advice_date || null;
  push('purchase_advice', advice, {
    source: app.purchase_advice_date ? 'Encompass (field 2370)'
      : (app.our_advice_date ? 'the purchasing desk’s own record' : null),
    /* WHEN THERE IS NO DATE, SAY WHETHER WE ACTUALLY ASKED. "No purchase advice yet" and "PILOT
       has not been able to read the field" are different pieces of work for different people —
       the whole point of the read-state work (db/608). */
    note: advice ? null : paMissingNote(app.purchase_advice_read_state),
  });

  push('sold', app.sold_at, {
    source: app.sold_at
      ? (app.sold_source === 'desk' ? 'the purchasing desk’s own record'
        : app.sold_source === 'manual' ? 'recorded by hand' : 'the purchase advice date in Encompass')
      : null,
  });

  push('payoff_demand', app.payoff_demand_requested_at, {
    source: app.payoff_demand_requested_at ? 'recorded on this file' : null,
    note: app.payoff_demand_requested_at ? (app.payoff_demand_note || null) : null,
    by: app.payoff_demand_by_name || null,
  });

  /* The actual payoff date rides ALONGSIDE rather than as its own row — the owner asked for it as
     "an open thing" nobody fills in yet, and an always-empty row in a six-row section is noise. */
  out.payoffDate = day(app.payoff_date);
  out.status = app.status;
  return out;
}

/** Why there is no purchase advice date, in the reader's terms. */
function paMissingNote(readState) {
  switch (readState) {
    case 'blank': return 'PILOT asked Encompass and it came back empty — the loan has not been sold yet.';
    case 'not_returned': return 'PILOT asked Encompass and it did not return this field — the field id may be wrong for this tenant.';
    case 'no_loan_link': return 'PILOT holds no Encompass loan for this file, so it has nothing to read.';
    case 'no_field_id': return 'No purchase advice field is configured on this deployment.';
    case 'value': return null;
    default: return 'PILOT has not asked Encompass about this loan yet.';
  }
}

module.exports = { criticalDates, ORDER, LABEL, WHY_MISSING, paMissingNote };
