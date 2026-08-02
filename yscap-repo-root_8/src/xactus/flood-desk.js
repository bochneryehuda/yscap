'use strict';
/**
 * src/xactus/flood-desk.js — XACTUS flood-order orchestration (DB + conditions + PDF).
 *
 * The PILOT-side half of the Xactus flood provider. The guarded HTTP client is
 * src/xactus/flood.js (the only thing that talks to Xactus). This module:
 *   - resolves the file's PROPERTY ADDRESS + borrower name(s) + loan number (a
 *     flood determination is about the property, so the address is the key — NOT
 *     an Encompass loan GUID),
 *   - places the order through the guarded client (with a volume circuit breaker),
 *   - records it in encompass_flood_orders (provider='xactus' — the shared
 *     flood-orders ledger; see db/394),
 *   - on the common INSTANT completion, files the certificate PDF onto the flood
 *     condition (rtl_cond_flood), records the flood-zone determination, and
 *     re-runs the Condition Center so a proven flood zone auto-attaches the
 *     flood-insurance condition (rtl_cond_flood_insurance),
 *   - polls the rare manual (not-on-FEMA-maps) order to completion.
 *
 * NEVER guesses and NEVER blocks: a failed order is recorded with its reason and a
 * human can re-order.
 */
const db = require('../db');
const client = require('./flood');

const MAX_ORDERS_10MIN = parseInt(process.env.XACTUS_FLOOD_MAX_ORDERS_10MIN || '30', 10);
// The in-request certificate retrieval is bounded well under the 90s wire default:
// it runs AFTER the order call inside the same staff request.
const RETRIEVE_TIMEOUT_MS = 25000;

function clean(v) { return v == null ? '' : String(v).trim(); }

// Pure address resolver (shapes → {street,city,state,zip}) lives in a DB-free
// helper so it is unit-testable without the pg pool; re-exported below.
const { resolveAddress, addressUsable } = require('./flood-address');

async function resolveFile(appId) {
  const r = await db.query(
    `SELECT a.ys_loan_number, a.property_address, a.co_borrower_id,
            b.first_name AS b_first, b.last_name AS b_last,
            cb.first_name AS cb_first, cb.last_name AS cb_last
       FROM applications a
       LEFT JOIN borrowers b  ON b.id = a.borrower_id
       LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
      WHERE a.id = $1 AND a.deleted_at IS NULL`,
    [appId]);
  const a = r.rows[0];
  if (!a) return { error: 'not_found', message: 'File not found.' };
  const address = resolveAddress(a.property_address);
  const borrowers = [];
  if (clean(a.b_first) || clean(a.b_last)) borrowers.push({ firstName: clean(a.b_first), lastName: clean(a.b_last) });
  if (a.co_borrower_id && (clean(a.cb_first) || clean(a.cb_last))) borrowers.push({ firstName: clean(a.cb_first), lastName: clean(a.cb_last) });
  return {
    loanNumber: clean(a.ys_loan_number) || null,
    address,
    borrowers,
  };
}

// Whether the file has what a Xactus flood order needs: a usable property address
// AND a borrower name (the cert is issued in the borrower's name). The button gates
// on `ready`, so it stays disabled — never enabled-but-errors — when either is missing.
async function readiness(appId) {
  try {
    const f = await resolveFile(appId);
    if (f.error) return { ready: false, needs: 'not_found' };
    const hasAddr = addressUsable(f.address);
    const hasName = f.borrowers.length > 0;
    const ready = hasAddr && hasName;
    const needs = !hasAddr ? 'address' : !hasName ? 'borrower' : null;
    return { ready, needs, hasLoanNumber: !!f.loanNumber };
  } catch (_) { return { ready: false, needs: 'error' }; }
}

// The flood condition (rtl_cond_flood) the certificate attaches to.
async function floodConditionId(appId) {
  const r = await db.query(
    `SELECT ci.id FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.application_id = $1 AND t.code = 'rtl_cond_flood' ORDER BY ci.created_at LIMIT 1`, [appId]);
  return r.rows[0] ? r.rows[0].id : null;
}

// Volume circuit breaker — never place more than N orders in a rolling 10 min
// across the whole system (all providers share the ledger). Fails CLOSED.
async function circuitOk() {
  try {
    const r = await db.query(`SELECT count(*)::int AS n FROM encompass_flood_orders WHERE ordered_at > now() - interval '10 minutes'`);
    return (r.rows[0].n || 0) < MAX_ORDERS_10MIN;
  } catch (_) { return false; }
}

// The newest COMPLETED **Xactus** flood order on this file. Provider-scoped on
// purpose: this row's order_id is fed back to Xactus as a FloodCertificationIdentifier
// during retrieval, and an Encompass service-order id means nothing there. (The
// provider-AGNOSTIC "has this property already been bought?" billing check lives in
// src/flood/dispatch.js, which is the one door every order goes through.)
// It deliberately does NOT swallow: a caller deciding whether to spend money must be
// able to tell "no order" from "the database did not answer".
async function latestCompletedOrder(appId) {
  const r = await db.query(
    `SELECT * FROM encompass_flood_orders
      WHERE application_id=$1 AND status='completed' AND provider='xactus'
      ORDER BY completed_at DESC NULLS LAST, ordered_at DESC LIMIT 1`, [appId]);
  return r.rows[0] || null;
}

// Does the order's filed certificate still exist as a live document?
async function certificateOnFile(order) {
  if (!order || !order.document_id) return false;
  try {
    const r = await db.query(
      `SELECT 1 FROM documents WHERE id=$1 AND is_current=true
         AND COALESCE(review_status,'') <> 'rejected'`, [order.document_id]);
    return !!r.rows[0];
  } catch (_) { return false; }
}

// ── Retrieve the certificate for an order we ALREADY paid for ─────────────────
// A StatusQuery fetches the completed report — it is a retrieval, NOT a new order,
// so it never charges us again. This is what the "Get the certificate" action runs
// when a determination came back without its PDF attached.
async function fetchCertificate({ appId, actorId }) {
  if (!client.enabled()) return { ok: false, error: 'disabled', message: 'Flood ordering is not turned on yet.' };
  if (!client.configured()) return { ok: false, error: 'not_configured', message: 'Flood ordering is not set up yet — add the Xactus flood web address in the settings.' };

  const order = await latestCompletedOrder(appId);
  if (!order) return { ok: false, error: 'no_completed_order', message: 'There is no completed flood determination on this file yet.' };
  if (await certificateOnFile(order)) {
    return { ok: true, alreadyFiled: true, order, message: 'The flood certificate is already filed on this condition.' };
  }
  if (!order.order_id) {
    return { ok: false, error: 'no_reference', order, message: 'This determination has no Xactus reference number, so the certificate can’t be retrieved. Upload it manually instead.' };
  }

  let st;
  try { st = await client.getOrderStatus(order.order_id); }
  catch (e) {
    return { ok: false, error: 'fetch_failed', order, message: `Could not retrieve the certificate from Xactus: ${e.userMessage || e.message}` };
  }
  if (!st || !st.pdfBase64) {
    return { ok: false, error: 'no_pdf', order, message: 'Xactus did not return a certificate PDF for this determination. Upload the certificate manually instead.' };
  }

  let documentId = null;
  try {
    const buf = decodePdf(st.pdfBase64);
    if (buf && buf.length) documentId = await attachCertificate(order, buf);
  } catch (e) {
    return { ok: false, error: 'file_failed', order, message: `The certificate came back but could not be saved: ${e.message}` };
  }
  if (!documentId) return { ok: false, error: 'file_failed', order, message: 'The certificate came back but could not be read as a PDF. Upload it manually instead.' };

  await db.query(
    `UPDATE encompass_flood_orders SET document_id=$2, updated_at=now(),
            raw = COALESCE(raw,'{}'::jsonb) || jsonb_build_object('pdfAttached', true)
      WHERE id=$1`, [order.id, documentId]).catch(() => {});
  await audit(actorId, 'xactus_flood_certificate_fetched', appId, { certId: order.order_id, documentId });
  const fresh = (await db.query(`SELECT * FROM encompass_flood_orders WHERE id=$1`, [order.id]).catch(() => null))?.rows?.[0] || order;
  return { ok: true, order: fresh, documentId, message: 'Flood certificate retrieved — it’s filed on this condition.' };
}

async function recordOrder({ appId, itemId, actorId, status, orderId, raw, lastError, product }) {
  // provider='xactus'; encompass_loan_guid is NULL (Xactus has no Encompass GUID —
  // db/394 dropped the NOT NULL and added the provider column).
  const r = await db.query(
    `INSERT INTO encompass_flood_orders
       (application_id, checklist_item_id, provider, encompass_loan_guid, product, order_id, status, raw, last_error, ordered_by)
     VALUES ($1,$2,'xactus',NULL,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [appId, itemId || null, product || client.productIdentifier(), orderId || null, status, raw ? JSON.stringify(raw) : null, lastError || null, actorId || null]);
  return r.rows[0];
}

// ── Place an order ───────────────────────────────────────────────────────────
// Returns a shaped result the route hands straight back: { ok, order?, error?, message }.
async function orderFlood({ appId, checklistItemId, actorId }) {
  if (!client.enabled()) return { ok: false, error: 'disabled', message: 'Flood ordering is not turned on yet.' };
  if (!client.configured()) return { ok: false, error: 'not_configured', message: 'Flood ordering is not set up yet — add the Xactus flood web address, username and password in the settings.' };

  const f = await resolveFile(appId);
  if (f.error) return { ok: false, error: f.error, message: f.message };
  if (!addressUsable(f.address)) {
    return { ok: false, error: 'address_required', message: 'Add the full property address (street, city, state, ZIP) to this file first — a flood certificate is ordered on the property address.' };
  }
  if (!f.borrowers.length) {
    return { ok: false, error: 'borrower_required', message: 'Add the borrower’s name to this file first — the flood certificate is issued in the borrower’s name.' };
  }
  // NOTE: the "already bought — don't charge us twice" guard is NOT here. It lives
  // at the ONE door every order goes through (src/flood/dispatch.js orderFlood), so
  // it protects both providers and can never drift between two copies.
  if (!(await circuitOk())) return { ok: false, error: 'circuit_open', message: 'Too many flood orders in a short window — try again shortly.' };

  const itemId = checklistItemId || await floodConditionId(appId);

  // RESERVE the single pending slot BEFORE touching Xactus. The partial unique
  // index (one status='ordered' row per file) makes a concurrent second click
  // fail the INSERT here — pre-network — so two clicks can never place two orders.
  let row;
  try { row = await recordOrder({ appId, itemId, actorId, status: 'ordered' }); }
  catch (e) {
    if (e.code === '23505') return { ok: false, error: 'already_pending', message: 'A flood certificate is already on order for this file.' };
    throw e;
  }

  let placed;
  try { placed = await client.placeOrder({ loanNumber: f.loanNumber, borrowers: f.borrowers, property: f.address }); }
  catch (e) {
    await db.query(`UPDATE encompass_flood_orders SET status='error', last_error=$2, updated_at=now() WHERE id=$1`, [row.id, (e.userMessage || e.message || 'order failed').slice(0, 400)]).catch(() => {});
    return { ok: false, error: e.code || 'order_failed', message: `The flood order could not be placed: ${e.userMessage || e.message}` };
  }

  if (placed.dryrun) {
    // A dry run isn't a live order, so it must not hold the pending slot.
    const upd = await db.query(
      `UPDATE encompass_flood_orders SET status='dryrun', raw=$2, updated_at=now() WHERE id=$1 RETURNING *`,
      [row.id, JSON.stringify({ body: placed.body })]);
    return { ok: true, dryrun: true, order: upd.rows[0], message: 'Dry run — the order was built and logged but nothing was sent to Xactus.' };
  }

  if (placed.status === 'error') {
    await db.query(`UPDATE encompass_flood_orders SET status='error', last_error=$2, raw=$3, updated_at=now() WHERE id=$1`,
      [row.id, (placed.error || 'Xactus reported the order failed.').slice(0, 400), JSON.stringify({ statusText: placed.statusText, code: placed.code })]).catch(() => {});
    return { ok: false, error: 'order_failed', message: `Xactus couldn’t place the flood order: ${placed.error || placed.statusText || 'unknown error'}` };
  }

  // Record the order id (the FloodCertificationIdentifier) either way.
  await db.query(`UPDATE encompass_flood_orders SET order_id=$2, updated_at=now() WHERE id=$1`, [row.id, placed.certId]).catch(() => {});

  if (placed.status === 'completed') {
    // The common case: the determination + certificate PDF came back instantly.
    const fresh = (await db.query(`SELECT * FROM encompass_flood_orders WHERE id=$1`, [row.id])).rows[0] || row;
    await completeOrder(fresh, placed);
    await audit(actorId, 'xactus_flood_order_completed', appId, { certId: placed.certId, sfha: placed.sfha, floodZone: placed.floodZone });
    return { ok: true, order: (await db.query(`SELECT * FROM encompass_flood_orders WHERE id=$1`, [row.id])).rows[0], message: 'Flood certificate received — it’s filed on this condition.' };
  }

  // A manual order (property not on the FEMA maps) — the poll worker completes it.
  await audit(actorId, 'xactus_flood_order_placed', appId, { certId: placed.certId });
  return { ok: true, order: (await db.query(`SELECT * FROM encompass_flood_orders WHERE id=$1`, [row.id])).rows[0], message: 'Flood certificate ordered — it will appear on this condition when it comes back.' };
}

// ── Poll pending (manual) orders ─────────────────────────────────────────────
async function pollPendingOnce() {
  if (!client.enabled() || !client.configured()) return { checked: 0 };
  // Dry-run sends nothing — not even a read-only StatusQuery.
  if (client.dryrun()) return { checked: 0 };
  // Reap a reservation whose order was never confirmed placed (both the place AND
  // the release-on-failure had to fail — rare). It holds the pending slot via the
  // unique index, so free it as an error after 15 min so the file can re-order.
  try {
    await db.query(
      `UPDATE encompass_flood_orders SET status='error', last_error='order was never confirmed placed', updated_at=now()
        WHERE provider='xactus' AND status='ordered' AND order_id IS NULL AND ordered_at < now() - interval '15 minutes'`);
  } catch (_) {}
  let rows;
  try {
    rows = (await db.query(
      `SELECT * FROM encompass_flood_orders
        WHERE provider='xactus' AND status='ordered' AND order_id IS NOT NULL
        ORDER BY ordered_at LIMIT 25`)).rows;
  } catch (_) { return { checked: 0 }; }
  let completed = 0, failed = 0;
  for (const o of rows) {
    try {
      const st = await client.getOrderStatus(o.order_id);
      // This determination CAME from a StatusQuery, so a missing PDF must not
      // trigger another identical StatusQuery inside completeOrder.
      if (st.status === 'completed') { await completeOrder(o, st, { viaStatusQuery: true }); completed++; }
      else if (st.status === 'error') {
        await db.query(`UPDATE encompass_flood_orders SET status='error', last_error=$2, updated_at=now() WHERE id=$1`,
          [o.id, (st.error || 'The flood vendor reported the order failed.').slice(0, 400)]);
        failed++;
      }
      // else still pending — leave it for the next tick.
    } catch (e) {
      try { await db.query(`UPDATE encompass_flood_orders SET last_error=$2, updated_at=now() WHERE id=$1`, [o.id, `poll: ${(e.userMessage || e.message || '')}`.slice(0, 400)]); } catch (_) {}
    }
  }
  return { checked: rows.length, completed, failed };
}

// A completed order: file the PDF, record the determination, re-evaluate conditions.
// `opts.viaStatusQuery` = this determination CAME from a StatusQuery, so re-querying
// for a missing PDF would just repeat the same answer.
async function completeOrder(order, parsed, opts = {}) {
  let documentId = null;
  let pdfBase64 = parsed.pdfBase64 || null;

  // The certificate normally rides back inside the order response. When it doesn't
  // (the account is set to exclude embedded files, or the determination completed
  // out-of-band), RETRIEVE it with a StatusQuery — the vendor's documented way to
  // fetch a completed report. This is a retrieval of a report we already paid for,
  // never a second order. Best-effort: the determination still lands either way.
  if (!pdfBase64 && order.order_id && !opts.viaStatusQuery) {
    try {
      const st = await client.getOrderStatus(order.order_id, RETRIEVE_TIMEOUT_MS);
      if (st && st.pdfBase64) pdfBase64 = st.pdfBase64;
    } catch (e) { console.warn('[xactus-flood] certificate retrieval failed (non-fatal):', e.message); }
  }

  if (pdfBase64) {
    try {
      const buf = decodePdf(pdfBase64);
      if (buf && buf.length) documentId = await attachCertificate(order, buf);
    } catch (e) { console.warn('[xactus-flood] certificate file failed (non-fatal):', e.message); }
  }
  await db.query(
    `UPDATE encompass_flood_orders
        SET status='completed', sfha=$2, flood_zone=$3, determination=$4, document_id=COALESCE($5, document_id),
            raw=$6, completed_at=now(), updated_at=now(), last_error=NULL
      WHERE id=$1`,
    [order.id, parsed.sfha, parsed.floodZone, parsed.determination ? JSON.stringify(parsed.determination) : null,
     // Record WHETHER the certificate was filed, so a missing PDF is diagnosable
     // from the order row itself instead of being invisible.
     documentId, JSON.stringify({ statusText: parsed.statusText, code: parsed.code, certId: parsed.certId,
       // Reflects the ROW's real state, not just this run's: a re-complete that
       // fails to re-file must not stamp "no PDF" on a row that still has one.
       pdfAttached: !!(documentId || order.document_id) })]);

  // Re-run the Condition Center. `in_flood_zone` now also reads this completed
  // order (engine.loadRuleContext reads encompass_flood_orders), so a proven flood
  // zone auto-attaches the flood-insurance condition and the cert moves to 'received'.
  try { await require('../lib/conditions/engine').evaluateApplication(order.application_id, { reason: 'flood_order', notify: false }); } catch (_) {}
}

function decodePdf(b64) {
  // Route through the mandated upload-decode chokepoint (strips any data: prefix,
  // rejects garbage) — never a bare Buffer.from, per the SharePoint-integrity rule.
  try { return require('../lib/upload-bytes').decodeUploadBase64(b64); }
  catch (_) { return null; }
}

// File the certificate PDF onto the flood condition — the same chokepoint every
// upload uses (storage.save → documents row on the checklist item → re-review →
// SharePoint mirror), so it flows to SharePoint like every other document.
async function attachCertificate(order, buf) {
  const itemId = order.checklist_item_id || await floodConditionId(order.application_id);
  const filename = `Flood determination${order.order_id ? ` ${order.order_id}` : ''}.pdf`;
  // Idempotent: if this exact certificate is already filed (a completeOrder whose
  // status UPDATE failed re-polled), reuse it rather than filing a duplicate.
  const dupe = await db.query(
    `SELECT id FROM documents WHERE application_id=$1 AND doc_kind='flood_determination'
        AND filename=$2 AND is_current=true AND COALESCE(review_status,'') <> 'rejected'
      ORDER BY created_at DESC LIMIT 1`,
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

async function audit(actorId, action, appId, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ('staff',$1,$2,'application',$3,$4)`,
      [actorId || null, action, appId, detail ? JSON.stringify(detail) : null]);
  } catch (_) { /* logging must never fail the action */ }
}

module.exports = {
  orderFlood, pollPendingOnce, completeOrder, attachCertificate, resolveFile, resolveAddress, addressUsable, readiness, floodConditionId,
  fetchCertificate, latestCompletedOrder, certificateOnFile,
};
