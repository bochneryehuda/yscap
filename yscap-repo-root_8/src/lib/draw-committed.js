'use strict';
/**
 * HOW MUCH OF EACH BUDGET LINE IS ALREADY SPOKEN FOR — the one definition.
 *
 * THE PROBLEM THIS EXISTS FOR (owner-directed 2026-08-17, the manual physical draw
 * route). Sitewire does not accept a manual draw entry, so a Trinity/physical draw
 * lives in PILOT as a `portal_draw_requests` row and only reaches Sitewire AFTER it is
 * approved, as a HISTORICAL draw (`portal-draws.historicalCloseOut`). That close-out
 * creates the draw in Sitewire and records it in `sitewire_draws` — but the per-line
 * ledger, `sitewire_draw_requests`, is written by ONE place only: the reconcile
 * (`sitewire/reconcile.js`), on its own poll (default 300s).
 *
 * So there is a window — from the moment a draw closes out until the next reconcile
 * imports its lines — in which that draw's money is in NEITHER source a reader
 * consults:
 *
 *   · `sitewire_draw_requests` has no rows for it yet, and
 *   · the portal request has left `status='approved'` and now carries a
 *     `sitewire_draw_id`, so the old "approved but not yet closed out" fallback
 *     deliberately skips it.
 *
 * In that window a line the borrower has ALREADY BEEN PAID FOR reads as untouched.
 * Two things then go wrong, and both are the expensive direction:
 *
 *   · the next Trinity order tells the inspector the line is 0% complete with its whole
 *     budget still available — the exact "money already released shown as available"
 *     failure `trinity/order.js` calls the single most expensive thing this integration
 *     could get wrong; and
 *   · the draw composer offers that money to be requested a second time.
 *
 * It is a RACE, not a certainty — five minutes on a quiet system — which is precisely
 * why it would not have shown up in testing and would have surfaced as one wrong
 * inspection months from now.
 *
 * WHY IT IS FIXED ON THE READ SIDE. The obvious fix — have the close-out write the
 * ledger rows itself — cannot be done honestly: Sitewire assigns
 * `sitewire_request_id`, and `POST /api/v2/draws` is not known to return the created
 * request ids (there is no Sitewire sandbox to establish it). Inventing ids would
 * corrupt the very crosswalk the write-back uses to put the inspector's figures on the
 * right line. So the ledger stays Sitewire's to write, and the READERS learn to look in
 * both places until it catches up.
 *
 * IT CANNOT DOUBLE COUNT, BY CONSTRUCTION. A portal request is counted only while NO
 * ledger row exists for its draw (`NOT EXISTS`), so the instant reconcile imports the
 * lines the fallback stops counting it — the two sources can never both be live for one
 * draw. That also makes it self-healing: nothing has to be cleaned up afterwards.
 */

const db = require('../db');

/**
 * The SQL, exposed so a caller inside its own transaction can run it on that client and
 * so a test can compare the two readers against the same statement rather than a retyped
 * copy. $1 = application id, $2 = a Sitewire draw id to leave out (nullable),
 * $3 = a portal request id to leave out (nullable).
 *
 * THE TWO EXCLUSIONS ARE THE "not its own history" RULE. When an order is being placed
 * FOR a draw, that draw's own money must not be reported as already drawn — otherwise
 * the same dollars are shown to the inspector both as released and as requested.
 */
const COMMITTED_SQL = `
  WITH ledger AS (
    SELECT r.sitewire_job_item_id AS jid,
           COALESCE(SUM(COALESCE(r.approved_cents, 0)), 0)::bigint AS c
      FROM sitewire_draw_requests r
      JOIN sitewire_draws d ON d.sitewire_draw_id = r.sitewire_draw_id
     WHERE d.application_id = $1
       AND ($2::bigint IS NULL OR d.sitewire_draw_id <> $2::bigint)
     GROUP BY r.sitewire_job_item_id
  ),
  -- Money PILOT has approved that Sitewire's per-line ledger does not carry yet:
  -- either the close-out has not run (writes off, no property link, parked, still in
  -- flight) or it HAS run and the reconcile has not imported the lines.
  portal AS (
    SELECT (l.value->>'sitewire_job_item_id')::bigint AS jid,
           COALESCE(SUM((l.value->>'approved_cents')::bigint), 0)::bigint AS c
      FROM portal_draw_requests p
      CROSS JOIN LATERAL jsonb_array_elements(p.lines) AS l(value)
     WHERE p.application_id = $1
       AND p.status IN ('approved', 'closed_out')
       AND ($3::bigint IS NULL OR p.id <> $3::bigint)
       AND ($2::bigint IS NULL OR p.sitewire_draw_id IS NULL OR p.sitewire_draw_id <> $2::bigint)
       AND l.value->>'sitewire_job_item_id' IS NOT NULL
       AND COALESCE(l.value->>'approved_cents', '') <> ''
       -- the anti-double-count, and the self-heal: once the reconcile has imported this
       -- draw's lines the ledger owns it and this row stops counting.
       AND (p.sitewire_draw_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM sitewire_draw_requests r2
              WHERE r2.sitewire_draw_id = p.sitewire_draw_id))
     GROUP BY l.value->>'sitewire_job_item_id'
  )
  SELECT jid, SUM(c)::bigint AS c FROM (
    SELECT jid, c FROM ledger
    UNION ALL
    SELECT jid, c FROM portal
  ) x
   WHERE jid IS NOT NULL
   GROUP BY jid`;

/**
 * @returns {Promise<Map<number, number>>} job item id -> cents already committed.
 * Never throws on an unreadable row; a job item with nothing against it is simply absent
 * (callers read it as 0, which is the same answer either way).
 */
async function committedByJobItem(appId, opts = {}) {
  const num = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  const client = opts.client || db;
  const rows = (await client.query(COMMITTED_SQL, [
    appId, num(opts.excludeDrawId), num(opts.excludePortalRequestId),
  ])).rows;
  const out = new Map();
  for (const r of rows) {
    const jid = Number(r.jid);
    if (Number.isFinite(jid)) out.set(jid, Number(r.c || 0));
  }
  return out;
}

module.exports = { committedByJobItem, COMMITTED_SQL };
