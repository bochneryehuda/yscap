'use strict';

/**
 * 120-day credit-report reopen sweep (owner-directed 2026-07-19).
 *
 * A credit report is never deleted, but it ages: the owner wants the internal
 * credit-report condition to REOPEN 120 days after the report's first-issued
 * date if the file is still open (not funded/declined/withdrawn), so staff pull
 * a fresh report before the loan closes on a stale one.
 *
 * Keyed on the file's MOST RECENT imported report — pulling a fresh report resets
 * the clock (the new report is < 120 days). Only reopens a condition that is
 * currently satisfied / signed off (so it never churns an already-open one), so
 * it is safe to run on a daily cadence.
 */
const db = require('../../db');

const REOPEN_DAYS = 120;
// The pull checkpoint + the internal condition follow the age; the "scores
// verified" checkpoint is left alone (the scores themselves didn't change).
const AGED_REOPEN_CODES = ['rtl_p3_credit', 'rtl_cond_credit'];

async function sweepAgedCreditConditions({ days = REOPEN_DAYS } = {}) {
  const n = Number.isFinite(days) ? Math.max(1, Math.floor(days)) : REOPEN_DAYS;
  const { rows } = await db.query(
    `WITH latest AS (
       SELECT DISTINCT ON (cr.application_id) cr.application_id, cr.first_issued_date
         FROM credit_reports cr
        WHERE cr.status='imported'
        ORDER BY cr.application_id, cr.created_at DESC
     ), aged AS (
       SELECT l.application_id
         FROM latest l
         JOIN applications a ON a.id = l.application_id
        WHERE l.first_issued_date IS NOT NULL
          AND l.first_issued_date < current_date - make_interval(days => $1)
          AND a.deleted_at IS NULL
          AND a.status NOT IN ('funded','declined','withdrawn')
     )
     UPDATE checklist_items ci
        SET status='outstanding', signed_off_at=NULL, signed_off_by=NULL,
            reviewed_at=NULL, reviewed_by=NULL,
            notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%'
                         THEN '[auto] The credit report is over ' || $1::text || ' days old — pull a fresh report (reissue) before this condition can be signed off.'
                         ELSE ci.notes END,
            updated_at=now()
       FROM checklist_templates t, aged
      WHERE t.id = ci.template_id AND t.code = ANY($2)
        AND ci.application_id = aged.application_id
        AND (ci.status='satisfied' OR ci.signed_off_at IS NOT NULL)
      RETURNING ci.application_id`,
    [n, AGED_REOPEN_CODES]);
  const apps = new Set(rows.map((r) => r.application_id));
  return { reopenedItems: rows.length, reopenedApplications: apps.size };
}

// A crash between the pre-POST journal INSERT and completion leaves a row stuck
// in 'ordering' forever. Sweep any 'ordering' row older than `minutes` to
// 'in_doubt' (an UNKNOWN outcome — the vendor may have billed) so it surfaces for
// reconciliation instead of blocking or being silently lost. Never re-orders.
async function sweepStaleOrders({ minutes } = {}) {
  const m = Number.isFinite(minutes) ? Math.max(1, Math.floor(minutes))
    : (require('../../config').xactus.staleOrderMinutes || 15);
  const { rows } = await db.query(
    `UPDATE credit_reports
        SET status='in_doubt',
            review_reason = COALESCE(review_reason, 'order never completed (process crash?) — verify in Xactus before re-ordering')
      WHERE status='ordering' AND ordered_at < now() - ($1 || ' minutes')::interval
      RETURNING id`, [String(m)]);
  return { swept: rows.length };
}

// Daily scheduler (started from server.js). Runs once shortly after boot, then
// every 24h. .unref() so it never keeps the process alive on its own. Also runs
// the stale-order sweep on a tighter cadence (in-flight orders age in minutes).
function startSweep({ intervalMs = 24 * 60 * 60 * 1000, firstDelayMs = 30000, staleIntervalMs = 10 * 60 * 1000 } = {}) {
  const runDaily = () => sweepAgedCreditConditions()
    .then((r) => { if (r.reopenedItems) console.log(`[credit] reopened ${r.reopenedItems} aged credit condition(s) on ${r.reopenedApplications} file(s)`); })
    .catch((e) => console.error('[credit] reopen sweep failed:', e.message));
  const runStale = () => sweepStaleOrders()
    .then((r) => { if (r.swept) console.log(`[credit] swept ${r.swept} stale in-flight order(s) to in_doubt`); })
    .catch((e) => console.error('[credit] stale-order sweep failed:', e.message));
  setTimeout(runDaily, firstDelayMs).unref();
  setTimeout(runStale, firstDelayMs).unref();
  const t1 = setInterval(runDaily, intervalMs).unref();
  setInterval(runStale, staleIntervalMs).unref();
  return t1;
}

module.exports = { sweepAgedCreditConditions, sweepStaleOrders, startSweep, REOPEN_DAYS, AGED_REOPEN_CODES };
