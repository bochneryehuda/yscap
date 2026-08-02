'use strict';
/**
 * src/encompass/flood-desk.js — FLOOD-ORDER orchestration (DB + conditions + PDF).
 *
 * The PILOT-side half of the flood-ordering feature. The guarded HTTP client is
 * src/encompass/flood-order.js (the only thing that talks to Encompass). This
 * module:
 *   - resolves the file's Encompass loan (by ys_loan_number → encompass_loan_guid),
 *   - places the order through the guarded client (with a volume circuit breaker),
 *   - records it in encompass_flood_orders,
 *   - polls pending orders, and on completion files the certificate PDF onto the
 *     flood condition (rtl_cond_flood), records the flood-zone determination, and
 *     re-runs the Condition Center so a proven flood zone auto-attaches the
 *     flood-insurance condition (rtl_cond_flood_insurance).
 *
 * NEVER guesses and NEVER blocks: a failed order is recorded with its reason and a
 * human can re-order; nothing here can mutate Encompass except the one flood order.
 */
const db = require('../db');
const client = require('./flood-order');

const MAX_ORDERS_10MIN = parseInt(process.env.ENCOMPASS_FLOOD_MAX_ORDERS_10MIN || '30', 10);

// ── Resolve the file's Encompass loan GUID (the join key) ────────────────────
// Mirrors how every other Encompass link works: the file's ys_loan_number is the
// human key; the opaque GUID is cached on applications.encompass_loan_guid. If we
// don't have the GUID yet, find it by loan number (a single exact hit only —
// zero or multiple hits are never guessed). Returns { guid } or { error, message }.
function rowGuid(row) {
  if (!row || typeof row !== 'object') return null;
  return row.loanId || row['Loan.Guid'] || (row.fields && (row.fields['Loan.Guid'] || row.fields.loanGuid)) || row.loanGuid || null;
}
async function resolveLoanGuid(appId) {
  const r = await db.query(
    `SELECT ys_loan_number, encompass_loan_guid FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId]);
  const a = r.rows[0];
  if (!a) return { error: 'not_found', message: 'File not found.' };
  const loanNumber = (a.ys_loan_number && String(a.ys_loan_number).trim()) || null;
  // The owner's rule: no loan number → you must enter one before you can order,
  // because the loan number is what links us to the Encompass loan.
  if (!loanNumber) return { error: 'loan_number_required', message: 'Add a loan number to this file first — the loan number is what links it to the Encompass loan.' };
  if (a.encompass_loan_guid) return { guid: a.encompass_loan_guid, loanNumber };
  // No cached GUID — look the loan up by number.
  let rows;
  try { rows = await require('./client').findLoanByLoanNumber(loanNumber); }
  catch (e) { return { error: 'lookup_failed', message: `Could not reach Encompass to find loan ${loanNumber}: ${e.message}` }; }
  const guids = [...new Set((rows || []).map(rowGuid).filter(Boolean))];
  if (!guids.length) return { error: 'not_in_encompass', message: `Loan ${loanNumber} was not found in Encompass. Check the loan number.` };
  if (guids.length > 1) return { error: 'ambiguous', message: `Loan ${loanNumber} matches more than one Encompass loan — resolve it before ordering.` };
  const guid = guids[0];
  // Cache it back (fill-only — never overwrite an existing GUID).
  try { await db.query(`UPDATE applications SET encompass_loan_guid=$1 WHERE id=$2 AND encompass_loan_guid IS NULL`, [guid, appId]); } catch (_) {}
  return { guid, loanNumber };
}

// The flood condition (rtl_cond_flood) this file's certificate attaches to.
async function floodConditionId(appId) {
  const r = await db.query(
    `SELECT ci.id FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
      WHERE ci.application_id=$1 AND t.code='rtl_cond_flood' ORDER BY ci.created_at LIMIT 1`, [appId]);
  return r.rows[0] ? r.rows[0].id : null;
}

// Volume circuit breaker: never place more than N orders in a rolling 10 min
// across the whole system. Fails CLOSED (refuses) if the counter can't be read.
async function circuitOk() {
  try {
    const r = await db.query(`SELECT count(*)::int AS n FROM encompass_flood_orders WHERE ordered_at > now() - interval '10 minutes'`);
    return (r.rows[0].n || 0) < MAX_ORDERS_10MIN;
  } catch (_) { return false; }
}

// ── Place an order ───────────────────────────────────────────────────────────
// Returns a shaped result the route hands straight back: { ok, order?, error?, message }.
async function orderFlood({ appId, checklistItemId, actorId }) {
  if (!client.enabled()) return { ok: false, error: 'disabled', message: 'Flood ordering is not turned on yet.' };
  if (!client.configured()) {
    // Distinguish "missing the flood service id" (the tenant setup value) from
    // "missing credentials" so staff get an actionable message.
    const msg = client.serviceReady()
      ? 'Flood ordering is not set up yet (missing Encompass flood credentials).'
      : 'Flood ordering needs your Encompass flood service id set up first. Ask your Encompass admin for it (the flood "service setup id"), then it can be added.';
    return { ok: false, error: 'not_configured', message: msg };
  }

  const resolved = await resolveLoanGuid(appId);
  if (resolved.error) return { ok: false, error: resolved.error, message: resolved.message };
  if (!(await circuitOk())) return { ok: false, error: 'circuit_open', message: 'Too many flood orders in a short window — try again shortly.' };

  const itemId = checklistItemId || await floodConditionId(appId);

  // RESERVE the single pending slot BEFORE touching Encompass. The partial unique
  // index (one status='ordered' row per file) makes a concurrent second click
  // fail the INSERT here — pre-network — so two clicks can never place two real
  // orders. order_id stays NULL until the order is actually placed, and the poll
  // worker only advances rows that HAVE an order_id, so a reserved row is inert.
  let row;
  try { row = await recordOrder({ appId, itemId, guid: resolved.guid, actorId, status: 'ordered' }); }
  catch (e) {
    if (e.code === '23505') return { ok: false, error: 'already_pending', message: 'A flood certificate is already on order for this file.' };
    throw e;
  }

  let placed;
  try { placed = await client.placeOrder(resolved.guid); }
  catch (e) {
    // Release the reservation as an error so the file can re-order (and the slot frees).
    await db.query(`UPDATE encompass_flood_orders SET status='error', last_error=$2, updated_at=now() WHERE id=$1`, [row.id, e.message]).catch(() => {});
    return { ok: false, error: e.code || 'order_failed', message: `The flood order could not be placed: ${e.message}` };
  }

  if (placed.dryrun) {
    // Dry run isn't a live order, so it must not hold the pending slot.
    const upd = await db.query(
      `UPDATE encompass_flood_orders SET status='dryrun', raw=$2, updated_at=now() WHERE id=$1 RETURNING *`,
      [row.id, JSON.stringify({ body: placed.body })]);
    return { ok: true, dryrun: true, order: upd.rows[0], message: 'Dry run — the order was built and logged but nothing was sent to Encompass.' };
  }
  const upd = await db.query(
    `UPDATE encompass_flood_orders SET order_id=$2, raw=$3, updated_at=now() WHERE id=$1 RETURNING *`,
    [row.id, placed.orderId, placed.raw ? JSON.stringify(placed.raw) : null]);
  await audit(actorId, 'encompass_flood_order_placed', appId, { orderId: placed.orderId, loanGuid: resolved.guid });
  return { ok: true, order: upd.rows[0], message: 'Flood certificate ordered — it will appear on this condition when it comes back.' };
}

async function recordOrder({ appId, itemId, guid, actorId, status, orderId, raw, lastError }) {
  const r = await db.query(
    `INSERT INTO encompass_flood_orders
       (application_id, checklist_item_id, encompass_loan_guid, order_id, status, raw, last_error, ordered_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [appId, itemId || null, guid, orderId || null, status, raw ? JSON.stringify(raw) : null, lastError || null, actorId || null]);
  return r.rows[0];
}

// ── Poll pending orders ──────────────────────────────────────────────────────
// One tick: advance every 'ordered' row. Best-effort per row; never throws.
async function pollPendingOnce() {
  if (!client.enabled() || !client.configured()) return { checked: 0 };
  // Reap a reservation whose order was never confirmed placed (both the place AND
  // the release-on-failure had to fail — rare). It holds the pending slot via the
  // unique index, so free it as an error after 15 min so the file can re-order.
  try {
    await db.query(
      `UPDATE encompass_flood_orders SET status='error', last_error='order was never confirmed placed', updated_at=now()
        WHERE status='ordered' AND order_id IS NULL AND ordered_at < now() - interval '15 minutes'
          AND COALESCE(provider,'encompass')='encompass'`);
  } catch (_) {}
  // Drain ONLY Encompass rows — a Xactus flood row (provider='xactus', db/394) is
  // polled by src/xactus/flood-desk.js, never by this Encompass status call.
  let rows;
  try { rows = (await db.query(`SELECT * FROM encompass_flood_orders WHERE status='ordered' AND order_id IS NOT NULL AND COALESCE(provider,'encompass')='encompass' ORDER BY ordered_at LIMIT 25`)).rows; }
  catch (_) { return { checked: 0 }; }
  let completed = 0, failed = 0;
  for (const o of rows) {
    try {
      const st = await client.getOrderStatus(o.encompass_loan_guid, o.order_id);
      if (st.status === 'completed') { await completeOrder(o, st); completed++; }
      else if (st.status === 'error') {
        await db.query(`UPDATE encompass_flood_orders SET status='error', last_error=$2, raw=$3, updated_at=now() WHERE id=$1`,
          [o.id, 'The flood vendor reported the order failed.', st.raw ? JSON.stringify(st.raw) : null]);
        failed++;
      }
      // else still pending — leave it for the next tick.
    } catch (e) {
      // Transient: leave the row 'ordered' so the next tick retries; just note it.
      try { await db.query(`UPDATE encompass_flood_orders SET last_error=$2, updated_at=now() WHERE id=$1`, [o.id, `poll: ${e.message}`.slice(0, 400)]); } catch (_) {}
    }
  }
  return { checked: rows.length, completed, failed };
}

// A completed order: file the PDF, record the determination, re-evaluate conditions.
async function completeOrder(order, st) {
  let documentId = null;
  if (st.fileUrl) {
    try {
      const buf = await client.downloadResultFile(st.fileUrl);
      if (buf && buf.length) documentId = await attachCertificate(order, buf);
    } catch (e) { console.warn('[encompass-flood] certificate download/attach failed (non-fatal):', e.message); }
  }
  await db.query(
    `UPDATE encompass_flood_orders
        SET status='completed', sfha=$2, flood_zone=$3, determination=$4, document_id=COALESCE($5, document_id),
            raw=$6, completed_at=now(), updated_at=now(), last_error=NULL
      WHERE id=$1`,
    [order.id, st.sfha, st.floodZone, st.determination ? JSON.stringify(st.determination) : null, documentId, st.raw ? JSON.stringify(st.raw) : null]);

  // Re-run the Condition Center. `in_flood_zone` now also reads this completed
  // order (engine.loadRuleContext), so a proven flood zone auto-attaches the
  // flood-insurance condition, and the flood cert itself moves to 'received'.
  try { await require('../lib/conditions/engine').evaluateApplication(order.application_id, { reason: 'flood_order', notify: false }); } catch (_) {}
  await audit(order.ordered_by, 'encompass_flood_order_completed', order.application_id,
    { orderId: order.order_id, sfha: st.sfha, floodZone: st.floodZone, documentId });
}

// File the certificate PDF onto the flood condition — the same chokepoint every
// upload uses (storage.save → documents row on the checklist item → re-review →
// SharePoint mirror), so it flows to SharePoint like every other document.
async function attachCertificate(order, buf) {
  const itemId = order.checklist_item_id || await floodConditionId(order.application_id);
  const filename = `Flood determination${order.order_id ? ` ${order.order_id}` : ''}.pdf`;
  // Idempotent: if this exact certificate is already filed (a prior completeOrder
  // filed the PDF but its status UPDATE failed, so the row re-polled), reuse it
  // rather than filing a duplicate. The filename carries the order id, so the same
  // order always maps to the same file.
  const dupe = await db.query(
    `SELECT id FROM documents WHERE application_id=$1 AND doc_kind='flood_determination'
        AND filename=$2 AND is_current=true ORDER BY created_at DESC LIMIT 1`,
    [order.application_id, filename]);
  if (dupe.rows[0]) return dupe.rows[0].id;
  const storage = require('../lib/storage');
  const { ref, provider } = await storage.save(buf, { filename });
  const borrowerId = (await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [order.application_id])).rows[0];
  const r = await db.query(
    `INSERT INTO documents (application_id, checklist_item_id, borrower_id, filename, content_type, size_bytes,
                            storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, doc_kind, slot_label, visibility, source_type)
     VALUES ($1,$2,$3,$4,'application/pdf',$5,$6,$7,'staff',$8,'flood_determination','Flood determination','staff_only','system')
     RETURNING id`,
    [order.application_id, itemId || null, itemId ? (borrowerId && borrowerId.borrower_id) : null, filename, buf.length, provider, ref, order.ordered_by || null]);
  if (itemId) {
    try { await require('../lib/checklist-evidence').reopenConditionEvidence(db, itemId, 'received'); } catch (_) {}
  }
  try { require('../lib/sharepoint-backup').kick(); } catch (_) {}
  return r.rows[0].id;
}

// The newest order for a file — for the condition button's state.
async function latestFloodOrder(appId) {
  try {
    const r = await db.query(`SELECT * FROM encompass_flood_orders WHERE application_id=$1 ORDER BY ordered_at DESC LIMIT 1`, [appId]);
    return r.rows[0] || null;
  } catch (_) { return null; }
}

async function audit(actorId, action, appId, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ('staff',$1,$2,'application',$3,$4)`,
      [actorId || null, action, appId, detail ? JSON.stringify(detail) : null]);
  } catch (_) { /* logging must never fail the action */ }
}

module.exports = { orderFlood, pollPendingOnce, completeOrder, attachCertificate, resolveLoanGuid, floodConditionId, latestFloodOrder };
