'use strict';
/**
 * Trinity INTAKE — "a draw was submitted on a physical, non-Blue-Lake file, so order the
 * inspection."
 *
 * Owner-directed 2026-08-14: *"Any inspection that is set up as a physical inspection:
 * whenever the inspection/draw requests get submitted by the borrower, the order should
 * automatically be placed with Trinity as the physical inspector company."*
 *
 * Two doors reach here, and they are the same two the physical program has always had:
 *   · the PORTAL composer (staff or borrower) — `portal-draws.createRequest` already
 *     creates the order record, and this places it;
 *   · a SITEWIRE submission on a physical non-Blue-Lake file — reconcile calls
 *     `maybeOrderFromSitewire`, which mints the order record and places it.
 *
 * THE GUARD IS THE FIRST LINE OF EVERY ENTRY POINT: nothing happens unless the file's
 * platform is 'trinity'. A Blue Lake / TrustPoint file and a Sitewire virtual file
 * return immediately, having read nothing and written nothing — which is what makes it
 * safe to call this from the shared reconcile path.
 *
 * THE CLAIM IS OUR OWN UNIQUE KEY, not a column on a Sitewire table. A Sitewire-
 * originated draw is keyed `swd-<drawId>` and a portal one `pdr-<requestId>`, both
 * unique on `trinity_inspection_orders.customer_key`, so "have we already ordered this
 * draw?" is answered by the insert itself and no Sitewire table is touched.
 */

const db = require('../db');
const client = require('./client');

// The same reading of "the borrower actually submitted this" the physical program
// already uses — a drafting/pending-borrower draw is not ready to inspect.
const SUBMITTED_STATUSES = new Set(['inspecting', 'pending', 'pending_capital_partner', 'approved']);

/**
 * Place the Trinity order for a portal draw request whose order record already exists.
 * Best-effort and self-contained: it never throws into the composer, because a draw
 * request must still be created even if Trinity is unreachable (the desk can then place
 * the order by hand from the draw desk).
 */
async function orderForPortalRequest(appId, portalRequestId) {
  try {
    const o = (await db.query(
      `SELECT id, status, trinity_order_id FROM trinity_inspection_orders
        WHERE application_id = $1 AND portal_draw_request_id = $2
        ORDER BY id DESC LIMIT 1`, [appId, portalRequestId])).rows[0];
    if (!o) return { skipped: 'no_order_record' };
    if (o.trinity_order_id) return { skipped: 'already_ordered' };
    if (!client.available() || !client.enabled()) return { skipped: 'off' };
    return await require('./order').placeOrder(appId, o.id);
  } catch (e) {
    console.warn('[trinity] auto-order (portal) failed:', e && e.message);
    return { error: String(e && e.message).slice(0, 200) };
  }
}

/**
 * A draw submitted in SITEWIRE on a physical non-Blue-Lake file: mint the order record
 * (once) and place it.
 *
 * `platform` is resolved by the caller once per file, exactly as the TrustPoint intake
 * receives it, so this never re-resolves mid-poll.
 */
async function maybeOrderFromSitewire(appId, { drawId, status, platform } = {}) {
  try {
    if (platform !== 'trinity') return { skipped: 'not_trinity' };
    if (!SUBMITTED_STATUSES.has(String(status || ''))) return { skipped: 'not_submitted' };
    if (!drawId) return { skipped: 'no_draw' };

    const customerKey = `swd-${drawId}`;
    // The INSERT is the claim: `customer_key` is unique, so two overlapping reconcile
    // passes cannot both mint an order record for one draw.
    // The ON CONFLICT target carries the index's own WHERE clause: `uq_tio_customer_key`
    // is a PARTIAL unique index and Postgres cannot infer a partial index without it.
    const ins = await db.query(
      `INSERT INTO trinity_inspection_orders (application_id, sitewire_draw_id, customer_key, note)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (customer_key) WHERE customer_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [appId, drawId, customerKey, `Sitewire draw ${drawId} — physical inspection`]);

    if (!ins.rows.length) {
      const existing = (await db.query(
        `SELECT id, trinity_order_id FROM trinity_inspection_orders WHERE customer_key=$1`, [customerKey])).rows[0];
      if (!existing || existing.trinity_order_id) return { skipped: 'already' };
      if (!client.available() || !client.enabled()) return { skipped: 'off' };
      return await require('./order').placeOrder(appId, existing.id);
    }

    if (!client.available() || !client.enabled()) return { created: true, skipped: 'off' };
    const placed = await require('./order').placeOrder(appId, ins.rows[0].id);
    return { created: true, ...placed };
  } catch (e) {
    console.warn('[trinity] auto-order (sitewire) failed:', e && e.message);
    return { error: String(e && e.message).slice(0, 200) };
  }
}

module.exports = { SUBMITTED_STATUSES, orderForPortalRequest, maybeOrderFromSitewire };
