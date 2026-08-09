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
        WHERE order_id=$1 AND direction='outbound' AND status = 'uploaded'
          AND document_id IS NOT NULL`, [orderId]);
    sent = new Set(s.rows.map((x) => String(x.document_id)));
  }
  return r.rows.map((d) => ({
    id: d.id, filename: d.filename, contentType: d.content_type, sizeBytes: d.size_bytes,
    docKind: d.doc_kind, reviewStatus: d.review_status,
    category: categoryOf(d),
    alreadyUploaded: sent.has(String(d.id)),
  }));
}

// Upload the picked documents to an order. Returns
// { ok, uploaded:[{documentId, objectName}], skipped:[{documentId, reason}] }.
async function uploadToOrder(dbh, order, { staffId, documentIds, action } = {}, deps = {}) {
  const transport = deps.transport || client;
  const readStorage = deps.readStorage || ((ref) => storage.read(ref));
  // TEST MODE IS DECIDED ONCE HERE TOO. This path reads the switch twice — once when
  // STAGING the bytes (a dry run mints fake `dryrun://getdocument/N` URLs and uploads
  // nothing) and again when SENDING the message that carries those URLs. The switch is
  // an in-memory flag refreshed on a timer with real network I/O between the two, so
  // they can disagree — and when they did, a LIVE UploadDocument went out carrying
  // `dryrun://` links, the rows were written as `uploaded`, and every later attempt
  // skipped those documents as already sent. The appraiser never received them and
  // nothing said so. Same shape, same fix as createOrder: read once, pass it down.
  const dryrun = deps.dryrun != null ? !!deps.dryrun : !!client.configured().dryrun;
  const stage = deps.postDocuments || ((files) => transport.postDocuments(files, { dryrun }));
  let authCtx;
  try {
    authCtx = deps.authContext || (await session.authContext(dryrun ? { offline: true } : undefined));
  } catch (e) {
    return { ok: false, error: 'not_connected', message: session.signInMessage(e) };
  }
  const ids = (documentIds || []).filter(Boolean);
  if (!ids.length) return { ok: false, error: 'no_documents' };

  const rows = (await dbh.query(
    `SELECT d.id, d.filename, d.content_type, d.storage_ref, d.doc_kind, d.llc_id,
            ci.label AS item_label, ct.code AS template_code
       FROM documents d
       LEFT JOIN checklist_items ci ON ci.id = d.checklist_item_id
       LEFT JOIN checklist_templates ct ON ct.id = ci.template_id
      WHERE d.application_id = $1 AND d.id = ANY($2::uuid[])`, [order.application_id, ids])).rows;
  // ONLY A DOCUMENT THAT REALLY WENT counts as already sent. A test-mode upload writes
  // its rows as `pending` (nothing left the building), so counting those permanently
  // blocked the real upload of the same document — a document the appraiser never got,
  // reported on the screen as "already sent".
  const already = new Set((await dbh.query(
    `SELECT document_id FROM amc_order_documents
      WHERE order_id=$1 AND direction='outbound' AND status = 'uploaded'
        AND document_id = ANY($2::uuid[])`,
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
    action: action || (documents.length > 1 ? 'UploadDocumentMulti' : 'UploadDocument'),
    apiKey: authCtx.apiKey, subdomain: order.sp_subdomain || authCtx.subdomain,
    spOrderNumber: order.sp_order_number, clientOrderNumber: order.client_order_number, documents,
  });
  const amcAction = built.message.requestActionType;

  let resp;
  try { resp = await transport.write(built, { orderId: order.cdg_order_number || undefined, label: amcAction, dryrun }); }
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

module.exports = { listUploadable, uploadToOrder, autoUploadForOrder, docTypeForCategory, categoryOf, CAT_SOW, CAT_CONTRACT };
