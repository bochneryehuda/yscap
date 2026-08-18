'use strict';
/**
 * AMC order documents — push documents UP to an order, and the auto-upload rules.
 *
 * Outbound flow (CDG): stage the bytes at /postdocuments (multipart) → each returns a
 * getdocument retrievalUrl → carry those as embeddedFiles[].objectURL in an
 * UploadDocument / UploadDocumentMulti order action. Staff pick which documents go to
 * which order from the file's Document Center; the picker labels each with the SAME
 * category the TPR export / SharePoint mirror use (tpr-export.categoryFor), so
 * "Contract & Assignment" / "Scope of Work" mean the same thing everywhere.
 *
 * Auto-upload rules (owner-directed): the corrected Scope of Work goes up when it
 * changes, and the contract when it arrives. Both fall out of ONE mechanism — dedupe
 * on documents.id per order: a CHANGED SOW is a NEW documents row, so it uploads; an
 * unchanged one is already recorded and skipped.
 *
 * Network is injectable (deps.transport / deps.authContext / deps.postDocuments /
 * deps.readStorage) so the whole path is testable offline; uploads go through the gated
 * transport (AMC_OUTBOUND_ENABLED).
 */
const db = require('../db');
const cdg = require('./cdg');
const client = require('./client');
const session = require('./session');
const storage = require('../lib/storage');
const tpr = require('../lib/tpr-export');
const { journal } = require('./order-service');

// The stable category labels the auto-upload rules key on (tpr-export's own strings).
const CAT_SOW = 'Scope of Work';
const CAT_CONTRACT = 'Contract & Assignment';

// The AMC embeddedFiles.documentType for a document's category.
function docTypeForCategory(cat) {
  if (cat === CAT_CONTRACT) return 'Sales Contract';
  if (cat === CAT_SOW) return 'Scope of Work';
  return 'Supporting Document';
}

// A document row → its category, via the shared categorizer.
function categoryOf(row) {
  try { return tpr.categoryFor(row); } catch (_) { return 'Other Documents'; }
}

// The file's current Document Center documents, each with a category and whether it is
// already uploaded to `orderId` (when given). Read-only.
async function listUploadable(dbh, appId, orderId = null) {
  const r = await dbh.query(
    `SELECT d.id, d.filename, d.content_type, d.size_bytes, d.doc_kind, d.review_status,
            d.llc_id, d.created_at, ci.label AS item_label, ct.code AS template_code
       FROM documents d
       LEFT JOIN checklist_items ci ON ci.id = d.checklist_item_id
       LEFT JOIN checklist_templates ct ON ct.id = ci.template_id
      WHERE d.application_id = $1 AND d.is_current = true
      ORDER BY d.created_at DESC`, [appId]);
  let sent = new Set();
  if (orderId) {
    const s = await dbh.query(
      `SELECT document_id FROM amc_order_documents
        WHERE order_id=$1 AND direction='outbound' AND document_id IS NOT NULL`, [orderId]);
    sent = new Set(s.rows.map((x) => String(x.document_id)));
  }
  return r.rows.map((d) => ({
    id: d.id, filename: d.filename, contentType: d.content_type, sizeBytes: d.size_bytes,
    docKind: d.doc_kind, reviewStatus: d.review_status,
    category: categoryOf(d),
    alreadyUploaded: sent.has(String(d.id)),
  }));
}

/**
 * THE THREE UPLOAD ACTIONS THE VENDOR DOCUMENTS, AND NOTHING ELSE.
 *
 * `action` arrives from the request body and was passed STRAIGHT THROUGH to
 * `buildUploadDocuments`, which puts it on the wire as `requestActionType`. So a
 * typo — or a caller inventing a name that reads plausibly — became a request the
 * gateway has never heard of, which is the exact class the invented `CancelOrder`
 * belonged to: a button that looks like it works and answers a NACK the first time
 * anybody presses it in anger.
 *
 * `UploadContract` is on the list because it is one of the three (mapping workbook,
 * Request sheet) and because sending the purchase contract as the CONTRACT rather
 * than as a generic supporting document is what puts it where the appraiser looks
 * for it. It had no caller only because nothing offered it.
 */
const UPLOAD_ACTIONS = ['UploadDocument', 'UploadDocumentMulti', 'UploadContract'];

/**
 * Which action to send. A caller may NAME one; otherwise it follows the count, which
 * is what every existing caller relies on and is byte-identical to before.
 * Returns null for a name the vendor does not document — never a guess.
 */
function uploadAction(action, count) {
  if (action == null || action === '') return count > 1 ? 'UploadDocumentMulti' : 'UploadDocument';
  const wanted = String(action).trim();
  const hit = UPLOAD_ACTIONS.find((a) => a.toLowerCase() === wanted.toLowerCase());
  return hit || null;   // the vendor's own casing, whatever the caller typed
}

// Upload the picked documents to an order. Returns
// { ok, uploaded:[{documentId, objectName}], skipped:[{documentId, reason}] }.
async function uploadToOrder(dbh, order, { staffId, documentIds, action } = {}, deps = {}) {
  const transport = deps.transport || client;
  const readStorage = deps.readStorage || ((ref) => storage.read(ref));
  const stage = deps.postDocuments || ((files) => transport.postDocuments(files));
  const authCtx = deps.authContext || (await session.authContext());
  const ids = (documentIds || []).filter(Boolean);
  if (!ids.length) return { ok: false, error: 'no_documents' };
  // REFUSED HERE, not on the wire. Checked before anything is read or staged, so an
  // unrecognised action costs nothing and says plainly what is allowed.
  const wantedAction = uploadAction(action, ids.length);
  if (!wantedAction) {
    return {
      ok: false, error: 'unknown_action',
      message: `AppraisalScope has no "${String(action)}" upload — it is one of ${UPLOAD_ACTIONS.join(', ')}.`,
    };
  }

  const rows = (await dbh.query(
    `SELECT d.id, d.filename, d.content_type, d.storage_ref, d.doc_kind, d.llc_id,
            ci.label AS item_label, ct.code AS template_code
       FROM documents d
       LEFT JOIN checklist_items ci ON ci.id = d.checklist_item_id
       LEFT JOIN checklist_templates ct ON ct.id = ci.template_id
      WHERE d.application_id = $1 AND d.id = ANY($2::uuid[])`, [order.application_id, ids])).rows;
  const already = new Set((await dbh.query(
    `SELECT document_id FROM amc_order_documents
      WHERE order_id=$1 AND direction='outbound' AND document_id = ANY($2::uuid[])`,
    [order.id, ids])).rows.map((x) => String(x.document_id)));

  const files = [];   // for /postdocuments
  const specs = [];   // parallel metadata
  const skipped = [];
  for (const d of rows) {
    if (already.has(String(d.id))) { skipped.push({ documentId: d.id, reason: 'already_uploaded' }); continue; }
    let bytes;
    try { bytes = await readStorage(d.storage_ref); }
    catch (_) { skipped.push({ documentId: d.id, reason: 'read_failed' }); continue; }
    if (!bytes || !bytes.length) { skipped.push({ documentId: d.id, reason: 'empty' }); continue; }
    files.push({ fileName: d.filename || 'document', contentType: d.content_type || 'application/octet-stream', bytes });
    specs.push({ documentId: d.id, filename: d.filename, category: categoryOf(d) });
  }
  if (!files.length) return { ok: false, error: 'nothing_to_upload', skipped };

  // Stage the bytes → getdocument retrieval URLs.
  let staged;
  try { staged = await stage(files); }
  catch (e) {
    await journal(dbh, { orderId: order.id, appId: order.application_id, action: 'postdocuments', ok: false, error: String(e.message || e), staffId });
    return { ok: false, error: e.code === 'AMC_OUTBOUND_DISABLED' ? 'outbound_disabled' : 'stage_failed', message: String(e.message || e), skipped };
  }

  const documents = staged.map((s, i) => ({
    objectURL: s.retrievalUrl, objectName: s.fileName || specs[i].filename,
    documentType: docTypeForCategory(specs[i].category),
  }));
  const built = cdg.buildUploadDocuments({
    // Recomputed from what SURVIVED the read/stage above: a caller's named action
    // still wins, but an unnamed two-document pick that lost one to an unreadable
    // file is a SINGLE upload, and calling it UploadDocumentMulti would describe a
    // request that no longer matches itself.
    action: uploadAction(action, documents.length),
    apiKey: authCtx.apiKey, subdomain: order.sp_subdomain || authCtx.subdomain,
    spOrderNumber: order.sp_order_number, clientOrderNumber: order.client_order_number, documents,
  });
  const amcAction = built.message.requestActionType;

  let resp;
  try { resp = await transport.write(built, { orderId: order.cdg_order_number || undefined, label: amcAction }); }
  catch (e) {
    await journal(dbh, { orderId: order.id, appId: order.application_id, action: amcAction, request: built, ok: false, error: String(e.message || e), staffId });
    return { ok: false, error: e.code === 'AMC_OUTBOUND_DISABLED' ? 'outbound_disabled' : 'send_failed', message: String(e.message || e), skipped };
  }

  const dry = !!(resp && resp.__dryrun);
  if (!dry) {
    const err = cdg.parseError(resp);
    if (err) {
      if (String(err.code) === '-100' || /authenticat/i.test(err.description || '')) session.invalidate();
      await journal(dbh, { orderId: order.id, appId: order.application_id, action: amcAction, request: built, response: resp, ok: false, error: err.description || err.code, staffId });
      return { ok: false, error: 'amc_nack', message: err.description || err.code, skipped };
    }
  }

  const uploaded = [];
  for (let i = 0; i < staged.length; i++) {
    await dbh.query(
      `INSERT INTO amc_order_documents
         (order_id, direction, document_id, document_type, object_name, action, retrieval_url, status)
       VALUES ($1,'outbound',$2,$3,$4,$5,$6,$7)`,
      [order.id, specs[i].documentId, documents[i].documentType, documents[i].objectName, amcAction, staged[i].retrievalUrl, dry ? 'pending' : 'uploaded']);
    uploaded.push({ documentId: specs[i].documentId, objectName: documents[i].objectName });
  }
  await journal(dbh, { orderId: order.id, appId: order.application_id, action: amcAction, request: built, response: dry ? { dryrun: true } : resp, ok: true, staffId });
  return { ok: true, dryrun: dry || undefined, uploaded, skipped };
}

// The auto-upload rules: send the current Scope of Work + contract to the order when
// they are not already there (the corrected SOW when it changes, the contract when it
// arrives). Skips HTML exports (the branded PDF/Excel + the real contract are what the
// AMC wants). Best-effort — returns { ok, uploaded } and never throws for a refusal.
async function autoUploadForOrder(dbh, order, deps = {}) {
  const docs = await listUploadable(dbh, order.application_id, order.id);
  const pick = docs.filter((d) => !d.alreadyUploaded
    && (d.category === CAT_SOW || d.category === CAT_CONTRACT)
    && !/html/i.test(String(d.contentType || ''))
    && !/\.html?$/i.test(String(d.filename || '')));
  if (!pick.length) return { ok: true, uploaded: 0 };
  const out = await uploadToOrder(dbh, order, { staffId: null, documentIds: pick.map((d) => d.id) }, deps);
  return { ok: out.ok, uploaded: out.uploaded ? out.uploaded.length : 0, error: out.error, skipped: out.skipped };
}

module.exports = { listUploadable, uploadToOrder, autoUploadForOrder, docTypeForCategory, categoryOf,
  uploadAction, UPLOAD_ACTIONS, CAT_SOW, CAT_CONTRACT };
