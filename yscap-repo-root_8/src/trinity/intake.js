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
const eligibility = require('./eligibility');

// The same reading of "the borrower actually submitted this" the physical program
// already uses — a drafting/pending-borrower draw is not ready to inspect. It was
// a second hand-typed copy of that set until 2026-08-20; it now comes from the ONE
// definition, `sitewire/draw-lifecycle`, which the desk's draft-vs-submitted
// notifications read too. Sending an inspector to a property is the expensive end
// of a drift, so this list must never be re-typed here.
const { SUBMITTED_STATUSES } = require('../sitewire/draw-lifecycle');

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
 * The file's routing is resolved by the caller once per file, exactly as the TrustPoint
 * intake receives it, so this never re-resolves mid-poll. It arrives as
 * `{platform, method, resolved}` — the shape `routing.resolveFilePlatform` returns —
 * and `eligibility.isTrinityFile` is the ONE reader of it.
 *
 * THIS BRANCH WAS UNREACHABLE UNTIL 2026-08-16. It asked for `platform === 'trinity'`,
 * a value `routing.platformOf` cannot produce (its only answers are 'sitewire',
 * 'trustpoint' and 'external'), so a physical draw submitted through Sitewire on a
 * non-Blue-Lake file silently never ordered an inspection. `platform` is still accepted
 * for callers that pass the whole context positionally, but the DECISION now belongs to
 * one shared, tested rule — see src/trinity/eligibility.js.
 */
async function maybeOrderFromSitewire(appId, { drawId, status, platform, method, resolved } = {}) {
  try {
    const ctx = { platform, method, resolved };
    if (!eligibility.isTrinityFile(ctx)) {
      return { skipped: 'not_trinity', reason: eligibility.reasonNotTrinity(ctx) };
    }
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

// ---------------------------------------------------------------------------
// THE THIRD DOOR: a coordinator orders the inspection HERSELF, from the draw desk
// ---------------------------------------------------------------------------
/**
 * Owner-directed 2026-08-16: *"It should automatically start ordering the reports
 * whenever a physical inspection comes in. We should also have the option to order it on
 * our end in the draw center. When we are ordering manually, it should also send over all
 * the information that we set up."*
 *
 * The two automatic doors above mint an order record as a SIDE EFFECT of a borrower
 * submitting a draw. Until now there was no way to mint one on purpose — so when an
 * automatic order stood down for any of the perfectly ordinary reasons it can (the
 * connection switched off during setup, credentials not in yet, Trinity unreachable for
 * an hour, a draw that arrived before this program existed), the coordinator had nothing
 * to press. The desk's existing button only ever RE-DROVE a record that already existed.
 *
 * THIS DOOR CHANGES NOTHING ABOUT WHAT IS SENT. It resolves the same record the automatic
 * door would have created — keyed identically, so a manual click and a later automatic
 * pass can never produce two orders for one draw — and hands it to the SAME
 * `order.placeOrder`. That is what makes the owner's "it should also send over all the
 * information" true by construction rather than by a second copy that drifts: the
 * construction budget, how much has already been drawn on every line, the readable
 * budget spreadsheet, the appraisal, the scope of work and the most recent previous
 * inspection report all travel exactly as they do on an automatic order.
 *
 * IT REFUSES ON A FILE THAT IS NOT TRINITY'S, through the same shared rule the automatic
 * doors use — a virtual file belongs to Sitewire's own inspector and a Blue Lake file to
 * TrustPoint, and manually ordering a second physical inspection onto one of those would
 * put two inspectors on one draw.
 */
async function orderManually(appId, { sitewireDrawId = null, portalRequestId = null, staffId = null,
  override = false, overrideReason = null } = {}) {
  const ctx = await fileRouting(appId);
  /* ONE rule, in `eligibility.planManualOrder` — the route and this door read the same answer, so
     what the screen says a coordinator may do and what actually happens can never disagree. */
  const plan = eligibility.planManualOrder(ctx, { override, overrideReason });
  if (!plan.ok) {
    if (plan.needsReason) {
      return { blocked: true, needsReason: true, warning: plan.warning,
        message: 'Say why this inspection is being ordered against the file’s own setup — it is recorded on the file.' };
    }
    return { blocked: true, mayOverride: plan.mayOverride, warning: plan.warning,
      message: `This file's inspections are not Trinity's — ${plan.blockedReason}.` };
  }

  let orderRowId = null;

  if (sitewireDrawId != null) {
    const drawId = Number(sitewireDrawId);
    if (!Number.isFinite(drawId)) return { blocked: true, message: 'That draw could not be read.' };
    // The draw must be ON THIS FILE. A draw id naming another file's draw is a data
    // fault, and ordering an inspection against it would send an inspector to the wrong
    // property — far worse than refusing.
    const own = (await db.query(
      `SELECT sitewire_draw_id FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`,
      [drawId, appId])).rows[0];
    if (!own) return { blocked: true, message: 'That draw is not on this file.' };

    // THE SAME KEY THE AUTOMATIC DOOR USES. `customer_key` is unique, so this insert IS
    // the claim: if the automatic pass already minted the record, this adopts it instead
    // of creating a second one, and if this runs first the automatic pass adopts ours.
    // The ON CONFLICT target carries the partial index's own WHERE clause (42P10).
    const customerKey = `swd-${drawId}`;
    const ins = await db.query(
      `INSERT INTO trinity_inspection_orders (application_id, sitewire_draw_id, customer_key, note)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (customer_key) WHERE customer_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [appId, drawId, customerKey, `Sitewire draw ${drawId} — physical inspection ordered by hand`]);
    if (ins.rows.length) orderRowId = ins.rows[0].id;
    else {
      const existing = (await db.query(
        `SELECT id, trinity_order_id FROM trinity_inspection_orders WHERE customer_key=$1`, [customerKey])).rows[0];
      if (!existing) return { error: true, message: 'The inspection record could not be read back.' };
      if (existing.trinity_order_id) {
        return { ok: true, already: true, orderRowId: existing.id, trinityOrderId: Number(existing.trinity_order_id) };
      }
      orderRowId = existing.id;
    }
  } else if (portalRequestId != null) {
    const reqId = Number(portalRequestId);
    if (!Number.isFinite(reqId)) return { blocked: true, message: 'That draw request could not be read.' };
    const pr = (await db.query(
      `SELECT id, platform, total_requested_cents FROM portal_draw_requests WHERE id=$1 AND application_id=$2`,
      [reqId, appId])).rows[0];
    if (!pr) return { blocked: true, message: 'That draw request is not on this file.' };
    if (pr.platform !== 'trinity') return { blocked: true, message: 'That draw request is administered by the note buyer, not Trinity.' };
    const existing = (await db.query(
      `SELECT id, trinity_order_id FROM trinity_inspection_orders
        WHERE application_id=$1 AND portal_draw_request_id=$2 ORDER BY id DESC LIMIT 1`, [appId, reqId])).rows[0];
    if (existing && existing.trinity_order_id) {
      return { ok: true, already: true, orderRowId: existing.id, trinityOrderId: Number(existing.trinity_order_id) };
    }
    if (existing) orderRowId = existing.id;
    else {
      // The composer creates this record in the same transaction as the request, so
      // normally there is one. It can be missing on a request composed before this
      // program existed — which is exactly a case somebody needs a button for.
      orderRowId = (await db.query(
        `INSERT INTO trinity_inspection_orders (application_id, portal_draw_request_id, note)
         VALUES ($1,$2,$3) RETURNING id`,
        [appId, reqId, `Portal draw request #${reqId} — physical inspection ordered by hand`])).rows[0].id;
    }
  } else {
    // A draw is not optional, and saying so beats a confusing refusal from Trinity's own
    // validation two calls later. Trinity's form 19 is a LINE-ITEM DRAW: it requires at
    // least one line with an amount requested (`mapper.buildOrderPayload`), so an order
    // with no draw behind it has nothing to inspect against. The way to order an
    // inspection when the borrower has not asked for a draw is to compose the draw
    // request on the desk first — which orders the inspection on its own.
    return { blocked: true, message: 'Pick the draw this inspection is for.' };
  }

  /* THE OVERRIDE IS STAMPED ON THE ROW BEFORE THE ORDER GOES OUT (db/607). Before, because the
     placement is what spends the money and dispatches a person: if it goes out, the file must
     already say who decided that and why. Best-effort — a stamp that cannot be written must never
     stop an order a coordinator has already confirmed, and the audit line below is the second
     record of the same act. */
  if (plan.override) {
    await db.query(
      `UPDATE trinity_inspection_orders
          SET manual_override_reason = $2, manual_override_by = $3, manual_override_at = now()
        WHERE id = $1 AND manual_override_reason IS NULL`,
      [orderRowId, plan.reason, staffId || null]).catch((e) => {
      console.warn('[trinity] could not stamp the manual override:', e && e.message);
    });
  }

  const placed = await require('./order').placeOrder(appId, orderRowId, { staffId });
  return { orderRowId, override: plan.override, warning: plan.warning, ...placed };
}

/** The file's routing, in the shape `eligibility` reads, failing CLOSED if we cannot look. */
async function fileRouting(appId) {
  try {
    const rp = await require('../sitewire/routing').resolveFilePlatform(appId);
    return { platform: rp.platform, method: rp.method, resolved: rp.resolved !== false };
  } catch (_) {
    return { platform: null, method: null, resolved: false };
  }
}

/**
 * What the desk may order an inspection AGAINST, and why it may not.
 *
 * Everything here is a READ. It exists so the button can be offered with a real choice
 * rather than a free-text id, and so a file that cannot be ordered on says why in plain
 * words instead of failing on the click.
 */
async function orderOptions(appId) {
  const ctx = await fileRouting(appId);
  const eligible = eligibility.isTrinityFile(ctx);
  /* THE SECTION IS AVAILABLE ON EVERY FILE (owner-directed 2026-08-21, item 25: *"it should be able
     to be manually placed on any file"* and *"that section should also be available when it's on
     auto"*). So this answers with the file's real state — whose inspections these are, whether a
     human may overrule that, and what they would be acknowledging — rather than going blank the
     moment the file is not Trinity's. The draw list is still built either way: a coordinator
     overruling the routing needs something to order AGAINST. */
  const plan = eligibility.planManualOrder(ctx, {});
  const out = {
    eligible,
    reason: eligible ? null : eligibility.reasonNotTrinity(ctx),
    mayOverride: plan.mayOverride && !eligible,
    overrideWarning: plan.warning,
    platform: (ctx && ctx.platform) || null,
    method: (ctx && ctx.method) || null,
    draws: [],
    requests: [],
  };

  const statuses = Array.from(SUBMITTED_STATUSES);
  // THE AMOUNT SHOWN IS THE ONE THE INSPECTOR WILL SEE. `sitewire_draws.total_requested_cents`
  // is Sitewire's own header total and is 0 whenever their payload did not carry one, so a
  // picker built on it can offer "Draw 2 — $0.00 requested" for a real draw. The per-line
  // requests are what `placeOrder` actually sends as `amountRequested`, so their SUM is
  // preferred and the mirrored header is only the fallback.
  out.draws = (await db.query(
    `SELECT d.sitewire_draw_id, d.number, d.status, d.submitted_at,
            GREATEST(COALESCE(d.total_requested_cents,0), COALESCE(rq.c,0)) AS total_requested_cents,
            o.id AS order_row_id, o.trinity_order_id, o.status AS order_status
       FROM sitewire_draws d
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(COALESCE(r.requested_cents,0)),0)::bigint AS c
           FROM sitewire_draw_requests r WHERE r.sitewire_draw_id = d.sitewire_draw_id
       ) rq ON true
       LEFT JOIN trinity_inspection_orders o
              ON o.sitewire_draw_id = d.sitewire_draw_id AND o.application_id = d.application_id
      WHERE d.application_id = $1
        AND d.historical = false
        AND d.status = ANY($2::text[])
      ORDER BY d.number DESC NULLS LAST, d.sitewire_draw_id DESC
      LIMIT 10`, [appId, statuses])).rows.map((r) => ({
    sitewire_draw_id: Number(r.sitewire_draw_id),
    number: r.number,
    status: r.status,
    total_requested_cents: Number(r.total_requested_cents || 0),
    submitted_at: r.submitted_at,
    // "Already ordered" is TRINITY holding an order, not merely our record existing — a
    // record with no Trinity order id is precisely what this door is for.
    ordered: !!r.trinity_order_id,
    order_row_id: r.order_row_id || null,
  }));

  out.requests = (await db.query(
    `SELECT p.id, p.status, p.total_requested_cents, p.created_at,
            o.id AS order_row_id, o.trinity_order_id
       FROM portal_draw_requests p
       LEFT JOIN trinity_inspection_orders o
              ON o.portal_draw_request_id = p.id AND o.application_id = p.application_id
      WHERE p.application_id = $1
        AND p.platform = 'trinity'
        AND p.status IN ('submitted','entered')
      ORDER BY p.id DESC
      LIMIT 10`, [appId])).rows.map((r) => ({
    id: Number(r.id),
    status: r.status,
    total_requested_cents: Number(r.total_requested_cents || 0),
    created_at: r.created_at,
    ordered: !!r.trinity_order_id,
    order_row_id: r.order_row_id || null,
  }));

  return out;
}

module.exports = {
  SUBMITTED_STATUSES, orderForPortalRequest, maybeOrderFromSitewire,
  orderManually, orderOptions, eligibility,
  _internals: { fileRouting },
};
