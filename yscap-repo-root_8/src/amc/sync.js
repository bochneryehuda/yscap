'use strict';
/**
 * AMC sync worker — the "pull" half of the CDG integration.
 *
 * CoreLogic's Digital Gateway NEVER pushes to us, so an order's status, the AMC's
 * comments, its revisions, and the finished documents are all POLLED. This worker
 * drives that poll for every OPEN order: GetAppraisalStatus advances the lifecycle
 * and records a status timeline; when the report becomes available (CDG 1990,
 * product_available) it pulls the documents back — RetriveAppraisalDocuments →
 * GET each objectURL → file into the Document Center → hand the MISMO XML to the
 * SAME appraisal importer the manual upload uses (src/lib/appraisal/desk.js
 * runAppraisalImport), so the completed appraisal lands on the file automatically.
 *
 * Testability: the response-processing seams (recordStatusEvent / applyStatusResponse)
 * take the db handle + a raw CDG response, so the whole lifecycle is exercised against
 * a real Postgres with no network (scripts/test-amc-sync-db.js). The fetch + document
 * pull go through the transport + session and are gated by AMC_ENABLED — dormant until
 * the feature is switched on.
 *
 * RTL only; off by default. start() schedules the poll but every tick no-ops while
 * AMC_ENABLED is off, so flipping it on at runtime starts polling with no redeploy.
 */
const crypto = require('crypto');
const db = require('../db');
const cfg = require('../config');
const switches = require('../lib/integrations/switches');
const cdg = require('./cdg');
const client = require('./client');
const session = require('./session');
const storage = require('../lib/storage');

// The order states that are still live at the AMC (mirror the partial index in db/480).
// 'cancel_requested' stays open so the poll keeps checking for the vendor's Cancellation
// (1051) confirmation, which flips it to 'cancelled'.
const OPEN_STATUSES = ['ordered', 'in_process', 'assigned', 'inspected', 'in_review', 'product_available', 'on_hold', 'cancel_requested'];
// The terminal lifecycles — an order that reaches one of these is done at the AMC. Used
// to decide when a poll may move an order OUT of the 'cancel_requested' holding state
// (only a vendor-confirmed cancel/completion/rejection releases it — see below).
const TERMINAL_STATUSES = new Set(['cancelled', 'completed', 'rejected']);
const POLL_BATCH = Math.max(1, parseInt(process.env.AMC_POLL_BATCH || '25', 10) || 25);

// ---------------------------------------------------------------------------
// Status timeline (dedupe-safe) — PURE key + a guarded insert.
// ---------------------------------------------------------------------------
function statusDedupeKey(st) {
  const parts = [st.statusCode || '', st.statusName || '', st.statusCondition || '', st.statusDescription || '', st.eventDatetime || st.createdDatetime || ''];
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

// Record a distinct status event. Returns true when it was NEW (re-polling the same
// status is a no-op — the unique index on (order_id, dedupe_key) suppresses it).
async function recordStatusEvent(dbh, orderId, st, raw) {
  const r = await dbh.query(
    `INSERT INTO amc_status_events
       (order_id, status_code, status_name, status_condition, status_description, event_datetime, dedupe_key, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (order_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [orderId, st.statusCode || null, st.statusName || null, st.statusCondition || null,
     st.statusDescription || null, st.eventDatetime || st.createdDatetime || null,
     statusDedupeKey(st), raw ? JSON.stringify(raw) : null]);
  return r.rowCount > 0;
}

// ---------------------------------------------------------------------------
// Apply a GetAppraisalStatus response onto the order row (no network).
// Returns { error } | { lifecycle, status, changed }.
// ---------------------------------------------------------------------------
async function applyStatusResponse(dbh, order, resp) {
  const err = cdg.parseError(resp);
  if (err) {
    // A stale api key surfaces as an auth NACK — drop it so the next call re-logs in.
    if (String(err.code) === '-100' || /authenticat/i.test(err.description || '')) session.invalidate();
    await dbh.query(`UPDATE amc_orders SET last_error=$2, last_polled_at=now(), updated_at=now() WHERE id=$1`,
      [order.id, err.description || err.code || 'AMC status NACK']);
    return { error: err };
  }
  const st = cdg.parseStatus(resp);
  if (!st) {
    await dbh.query(`UPDATE amc_orders SET last_polled_at=now(), updated_at=now() WHERE id=$1`, [order.id]);
    return { lifecycle: null, status: order.status, changed: false };
  }
  await recordStatusEvent(dbh, order.id, st, resp);
  const lifecycle = cdg.mapStatusToLifecycle(st.statusCode, st.statusName);
  let newStatus = lifecycle || order.status;
  // A cancel we've ASKED for stays 'cancel_requested' until the vendor CONFIRMS it
  // (Cancellation / 1051 → 'cancelled') or the order otherwise reaches a terminal state.
  // The order is still live at the AMC, so the next poll returns its current vendor
  // status (assigned / in_process / …), which must NOT downgrade the marker — "asking is
  // not agreeing". We still record the latest status_code/name/description below; only
  // the lifecycle status is pinned. A terminal lifecycle (the 1051 confirmation, a
  // completion, a rejection) is allowed through so the request can actually resolve.
  if (order.status === 'cancel_requested' && !(lifecycle && TERMINAL_STATUSES.has(lifecycle))) {
    newStatus = 'cancel_requested';
  }
  await dbh.query(
    `UPDATE amc_orders SET
        status=$2, status_code=$3, status_name=$4, status_description=$5,
        last_status_response=$6, last_error=NULL, last_polled_at=now(), updated_at=now(),
        completed_at = CASE WHEN $2='completed' AND completed_at IS NULL THEN now() ELSE completed_at END
      WHERE id=$1`,
    [order.id, newStatus, st.statusCode != null ? String(st.statusCode) : null,
     st.statusName || null, st.statusDescription || null, JSON.stringify(resp)]);
  return { lifecycle, status: newStatus, changed: newStatus !== order.status };
}

// ---------------------------------------------------------------------------
// Document pull → Document Center → appraisal import.
// deps lets a test inject the transport + importer; production uses the real ones.
// ---------------------------------------------------------------------------
function looksXml(doc, contentType, bytes) {
  const name = String(doc.objectName || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  if (name.endsWith('.xml') || /xml/.test(ct)) return true;
  const head = bytes && bytes.length ? bytes.slice(0, 64).toString('utf8').trimStart() : '';
  return head.startsWith('<');
}
function looksPdf(doc, contentType, bytes) {
  const name = String(doc.objectName || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  if (name.endsWith('.pdf') || /pdf/.test(ct)) return true;
  return bytes && bytes.length >= 4 && bytes.slice(0, 4).toString('latin1') === '%PDF';
}

async function ingestDocuments(dbh, order, deps = {}) {
  const transport = deps.transport || client;
  const importAppraisal = deps.importAppraisal || ((args) => require('../lib/appraisal/desk').runAppraisalImport(args));
  const authCtx = deps.authContext || (await session.authContext());

  const resp = await transport.read(cdg.buildRetrieveDocuments({
    apiKey: authCtx.apiKey, subdomain: order.sp_subdomain || authCtx.subdomain,
    spOrderNumber: order.sp_order_number, clientOrderNumber: order.client_order_number, includeAdditional: true,
  }), { label: 'RetriveAppraisalDocuments' });

  const err = cdg.parseError(resp);
  if (err) {
    if (String(err.code) === '-100' || /authenticat/i.test(err.description || '')) session.invalidate();
    await dbh.query(`UPDATE amc_orders SET last_error=$2, updated_at=now() WHERE id=$1`, [order.id, err.description || err.code]);
    return { ok: false, error: err };
  }

  const app = (await dbh.query(`SELECT borrower_id FROM applications WHERE id=$1`, [order.application_id])).rows[0];
  const borrowerId = app ? app.borrower_id : null;
  const docs = cdg.parseDocuments(resp);
  let xmlDocId = null, pdfDocId = null, xmlString = null, filed = 0;

  for (const d of docs) {
    try {
      // Dedupe on the AMC's own document id so re-polling never double-files.
      if (d.amcDocumentId) {
        const seen = await dbh.query(
          `SELECT 1 FROM amc_order_documents WHERE order_id=$1 AND direction='inbound' AND amc_document_id=$2`,
          [order.id, d.amcDocumentId]);
        if (seen.rowCount) continue;
      }
      if (!d.objectUrl) continue;
      const { bytes, contentType } = await transport.getDocument(d.objectUrl);
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      const { ref, provider } = await storage.save(bytes, { filename: d.objectName || 'appraisal-document' });
      const ins = await dbh.query(
        `INSERT INTO documents
           (application_id, borrower_id, checklist_item_id, filename, content_type, size_bytes,
            storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, doc_kind, review_status, sha256,
            source_type, visibility)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staff',NULL,NULL,'pending',$9,'system','staff_only')
         RETURNING id`,
        [order.application_id, borrowerId, order.checklist_item_id || null,
         String(d.objectName || 'appraisal-document').slice(0, 300),
         contentType || 'application/octet-stream', bytes.length, provider, ref, sha]);
      const docId = ins.rows[0].id;
      await dbh.query(
        `INSERT INTO amc_order_documents
           (order_id, direction, document_id, amc_document_id, document_type, object_name, object_description,
            action, retrieval_url, object_size, is_additional, status, raw)
         VALUES ($1,'inbound',$2,$3,$4,$5,$6,'RetriveAppraisalDocuments',$7,$8,$9,'retrieved',$10)`,
        [order.id, docId, d.amcDocumentId || null, d.documentType || null, d.objectName || null,
         d.objectDescription || null, d.objectUrl || null, d.objectSize || null, !!d.isAdditional,
         d.raw ? JSON.stringify(d.raw) : null]);
      filed += 1;
      if (!xmlString && looksXml(d, contentType, bytes)) { xmlDocId = docId; xmlString = bytes.toString('utf8'); }
      else if (!pdfDocId && looksPdf(d, contentType, bytes)) { pdfDocId = docId; }
    } catch (e) {
      console.error('[amc] could not file a returned document for order', order.id, (e && e.message) || e);
    }
  }

  // The MISMO appraisal XML feeds the same importer the manual upload uses. Best-effort:
  // a bad/unreadable XML answers ok:false and never breaks the order.
  let imported = false;
  if (xmlString) {
    try {
      const out = await importAppraisal({
        appId: order.application_id, xml: xmlString, importedBy: null,
        xmlDocumentId: xmlDocId, pdfDocumentId: pdfDocId,
      });
      imported = !!(out && out.ok);
    } catch (e) {
      console.error('[amc] appraisal import failed for order', order.id, (e && e.message) || e);
    }
  }
  if (imported) {
    await dbh.query(
      `UPDATE amc_orders SET status='completed', completed_at=COALESCE(completed_at, now()), updated_at=now() WHERE id=$1`,
      [order.id]);
  }
  return { ok: true, filed, imported };
}

// ---------------------------------------------------------------------------
// Fetch one order's status live, then pull documents if the report is ready.
// ---------------------------------------------------------------------------
async function syncOne(dbh, order) {
  const ctx = await session.authContext();
  const resp = await client.read(cdg.buildGetStatus({
    apiKey: ctx.apiKey, subdomain: order.sp_subdomain || ctx.subdomain,
    spOrderNumber: order.sp_order_number, clientOrderNumber: order.client_order_number,
  }), { label: 'GetAppraisalStatus' });
  const out = await applyStatusResponse(dbh, order, resp);
  if (out.error) return out;
  // Pull the AMC's side of the two-way thread + revision statuses on every live order
  // (lazy-required to avoid a load-order cycle). Best-effort — neither poll ever breaks
  // the status sync.
  try { await require('./comments').syncComments(dbh, order); }
  catch (e) { console.error('[amc] comment sync failed for order', order.id, (e && e.message) || e); }
  try { await require('./revisions').syncRevisions(dbh, order); }
  catch (e) { console.error('[amc] revision sync failed for order', order.id, (e && e.message) || e); }
  // Auto-upload the corrected SOW / the contract when they change or arrive (deduped on
  // documents.id, gated by AMC_OUTBOUND_ENABLED). Best-effort — never breaks the poll.
  try { await require('./documents').autoUploadForOrder(dbh, order); }
  catch (e) { console.error('[amc] auto document upload failed for order', order.id, (e && e.message) || e); }
  if (out.status === 'product_available') {
    try { await ingestDocuments(dbh, { ...order, status: out.status }); }
    catch (e) { console.error('[amc] document ingest failed for order', order.id, (e && e.message) || e); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Poll every open order once. No-ops while AMC_ENABLED is off.
// ---------------------------------------------------------------------------
async function pollOpenOrdersOnce(dbh = db) {
  if (!switches.on('AMC_ENABLED')) return { polled: 0, skipped: 'disabled' };
  const rows = (await dbh.query(
    `SELECT * FROM amc_orders
      WHERE status = ANY($1) AND sp_order_number IS NOT NULL
      ORDER BY last_polled_at ASC NULLS FIRST
      LIMIT $2`, [OPEN_STATUSES, POLL_BATCH])).rows;
  let polled = 0;
  for (const o of rows) {
    try { await syncOne(dbh, o); polled += 1; }
    catch (e) { console.error('[amc] poll failed for order', o.id, (e && e.message) || e); }
  }
  return { polled };
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------
let _timer = null;
function start() {
  if (_timer) return;
  const sec = Math.max(30, (cfg.amc && cfg.amc.pollSec) || 300);
  if (switches.on('AMC_ENABLED')) console.log(`[amc] sync poll every ${sec}s`);
  else console.log('[amc] disabled (set AMC_ENABLED=1 to turn on); poll is scheduled but inert');
  _timer = setInterval(() => {
    pollOpenOrdersOnce().catch((e) => console.error('[amc] poll tick error:', (e && e.message) || e));
  }, sec * 1000);
  if (_timer.unref) _timer.unref();
}

module.exports = {
  start, pollOpenOrdersOnce, syncOne, ingestDocuments,
  applyStatusResponse, recordStatusEvent, statusDedupeKey,
  looksXml, looksPdf, OPEN_STATUSES,
};
