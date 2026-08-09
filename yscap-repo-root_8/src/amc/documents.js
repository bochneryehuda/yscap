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
// A skip reason in words a person can act on. The code alone is for us.
const REASON_TEXT = {
  already_uploaded: 'already sent to this order',
  read_failed: 'the stored copy could not be read',
  empty: 'the stored copy is empty',
  stage_rejected: 'the appraisal company would not accept it',
};
const reasonText = (r) => REASON_TEXT[r] || r || 'it could not be sent';

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
async function listUploadable(dbh, appId, orderId = null, opts = {}) {
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
      // THE SAME READING THE SEND USES. In test mode the send counts a `pending` row
      // as done (or the poller re-stages the same document every five minutes), so a
      // picker that ignored those offered a document the send then refused —
      // "nothing_to_upload" on a document the screen had just shown as available.
      `SELECT document_id FROM amc_order_documents
        WHERE order_id=$1 AND direction='outbound'
          AND (status = 'uploaded' OR ($2::boolean AND status = 'pending'))
          AND document_id IS NOT NULL`,
      [orderId, opts.dryrun != null ? !!opts.dryrun : !!client.configured().dryrun]);
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
  // WHAT COUNTS AS "ALREADY DONE" DEPENDS ON WHAT WE ARE ABOUT TO DO.
  //   • A REAL send counts only `uploaded` rows. A test-mode row is `pending` —
  //     nothing left the building — and counting it permanently blocked the real
  //     upload of that document while the screen said "already sent".
  //   • A TEST send counts `pending` too, or the auto-upload the poller runs every
  //     five minutes re-stages the same document forever, one junk row per tick in
  //     `amc_order_documents` AND `amc_write_log`.
  // One clause, both readings, so the two can never drift apart.
  const already = new Set((await dbh.query(
    `SELECT document_id FROM amc_order_documents
      WHERE order_id=$1 AND direction='outbound'
        AND (status = 'uploaded' OR ($3::boolean AND status = 'pending'))
        AND document_id = ANY($2::uuid[])`,
    [order.id, ids, dryrun])).rows.map((x) => String(x.document_id)));

  const files = [];   // for /postdocuments
  const specs = [];   // parallel metadata
  const skipped = [];
  for (const d of rows) {
    if (already.has(String(d.id))) { skipped.push({ documentId: d.id, filename: d.filename, reason: 'already_uploaded' }); continue; }
    let bytes;
    try { bytes = await readStorage(d.storage_ref); }
    catch (_) { skipped.push({ documentId: d.id, filename: d.filename, reason: 'read_failed' }); continue; }
    if (!bytes || !bytes.length) { skipped.push({ documentId: d.id, filename: d.filename, reason: 'empty' }); continue; }
    files.push({ fileName: d.filename || 'document', contentType: d.content_type || 'application/octet-stream', bytes });
    specs.push({ documentId: d.id, filename: d.filename, category: categoryOf(d) });
  }
  if (!files.length) {
    // THE SIBLING OF THE STAGING REFUSAL, and it needs the same treatment: a bare
    // `nothing_to_upload` reaches the desk as the CODE, which is for us, with no
    // filenames — on a path where every picked document failed to be read.
    return { ok: false, error: 'nothing_to_upload', skipped,
      message: skipped.length
        ? 'Nothing could be sent: ' + skipped.map((x) => `${x.filename || 'a file'} — ${reasonText(x.reason)}`).join('; ')
        : 'There was nothing to send.' };
  }

  // Stage the bytes → getdocument retrieval URLs.
  let staged;
  try { staged = await stage(files); }
  catch (e) {
    await journal(dbh, { orderId: order.id, appId: order.application_id, action: 'postdocuments', ok: false, error: String(e.message || e), staffId });
    return { ok: false, error: e.code === 'AMC_OUTBOUND_DISABLED' ? 'outbound_disabled' : 'stage_failed', message: String(e.message || e), skipped };
  }

  // THE VENDOR ANSWERS PER FILE, AND A FAILURE THERE IS AN HTTP 200. `/postdocuments`
  // returns `{name, fileName, uploadStatus, retrievalUrl, errorTraceID}` for each part,
  // and one file can fail (antivirus, size) while the call succeeds. None of that was
  // read: a `retrievalUrl` of null went to the vendor as `objectURL: null`, the row was
  // written `uploaded`, and from then on both the picker and the "already sent" set
  // counted it as delivered — the checkbox greys out, so even the manual retry is gone.
  // The appraiser never receives that document and nothing says so.
  //
  // THE JOIN IS BY NAME, NOT BY POSITION. `staged` is the vendor's array; assuming it
  // comes back in the order we sent it is exactly how one document's bytes end up
  // filed under another's name. `name` is the `part<i>` the client itself assigned, so
  // it is the reliable key; `fileName` is the fallback.
  // Each staged answer belongs to exactly ONE file. Without this, a vendor that drops
  // a rejected part and RE-INDEXES the rest hands the same answer to two documents —
  // one of them gets a duplicate of its neighbour's bytes and the other is recorded as
  // delivered having never been sent.
  const claimed = new Set();
  const claim = (s) => { if (!s || claimed.has(s)) return null; claimed.add(s); return s; };
  const stagedFor = (i) => {
    // THE PART NAME IS CHECKED TOO, not trusted. It is the most reliable key we have,
    // which is exactly why an unchecked match is dangerous: a vendor that refuses one
    // file, omits it, and re-indexes the rest returns `part1` for what was our
    // `part2` — and the scope of work is then sent under the photo's name and link,
    // marked delivered, with the picker greying it out so nobody can retry it. A
    // `fileName` that disagrees means this answer is about a different file, so we
    // fall THROUGH (never return null here) and let the filename match rescue it.
    const byPart = staged.find((s) => s && !claimed.has(s) && s.name === 'part' + i
      && (!s.fileName || s.fileName === files[i].fileName));
    if (byPart) return claim(byPart);
    const byName = staged.filter((s) => s && !claimed.has(s) && s.fileName === files[i].fileName);
    if (byName.length === 1) return claim(byName[0]);
    // THE POSITIONAL FALLBACK IS THE LAST RESORT, AND IT IS CHECKED. Taking
    // `staged[i]` on faith is precisely how one document's bytes are sent under
    // another's name — reproduced: with the vendor's answers reordered, the purchase
    // contract went out carrying the scope of work's link, both rows said `uploaded`,
    // and the picker then greyed the contract out so it could never be retried. So the
    // position is only trusted when the vendor gives us NOTHING to check it against;
    // a `fileName` that disagrees means the answer is not about this file, and the
    // honest outcome is to refuse it rather than to guess which document it belongs to.
    if (staged.length !== files.length) return null;
    const at = staged[i];
    if (!at || claimed.has(at)) return null;
    // A disagreeing filename means this answer is not about this file.
    if (at.fileName && at.fileName !== files[i].fileName) return null;
    // AND WITH NOTHING USABLE TO MATCH ON, POSITION IS NOT EVIDENCE — it is the
    // assumption this whole function exists to remove. (What reaches here is an
    // answer whose `name` is absent or names a different part AND whose `fileName` is
    // absent or matched no single file.) On a SINGLE file there is nothing to confuse
    // it with, so position is certain; on a batch it is a guess,
    // and guessing wrong sends one document's bytes under another's name. Refusing
    // costs a retry; guessing costs a document that everything then reports as
    // delivered.
    if (!at.fileName && !at.name && files.length > 1) return null;
    return claim(at);
  };
  // A DENYLIST, DELIBERATELY, NOT AN ALLOWLIST. The vendor's success word is not
  // documented (the only shape in this repo is our own dry-run stub's 'Success'), so an
  // allowlist would silently refuse every document the day they answer "Uploaded" —
  // and a document not sent is the expensive direction. A URL is the real evidence of
  // staging; the words below are the ones that mean a refusal in anybody's vocabulary.
  const REFUSED = /fail|error|reject|deny|denied|invalid|quarantin|block|refus|virus|malware/i;
  const okStage = (s) => !!(s && s.retrievalUrl && String(s.retrievalUrl).trim()
    && !REFUSED.test(String(s.uploadStatus == null ? '' : s.uploadStatus)));

  const sendable = [];      // the specs whose bytes really are staged
  const documents = [];
  for (let i = 0; i < specs.length; i++) {
    const st = stagedFor(i);
    if (!okStage(st)) {
      // The reason must not contradict itself: a missing link with a "Success" status
      // is not a refusal the vendor stated, it is an answer we cannot use.
      const stated = st && REFUSED.test(String(st.uploadStatus || '')) ? String(st.uploadStatus) : null;
      skipped.push({ documentId: specs[i].documentId,
        filename: specs[i].filename,
        reason: 'stage_rejected',
        detail: stated || (st && st.errorTraceID)
          || (st ? 'the appraisal company returned no link for this file' : 'the appraisal company did not answer for this file') });
      continue;
    }
    sendable.push({ ...specs[i], staged: st });
    documents.push({
      objectURL: st.retrievalUrl, objectName: st.fileName || specs[i].filename,
      documentType: docTypeForCategory(specs[i].category),
    });
  }
  if (!documents.length) {
    await journal(dbh, { orderId: order.id, appId: order.application_id, action: 'postdocuments', ok: false, error: 'every file was rejected at staging', staffId });
    return { ok: false, error: 'stage_rejected', skipped,
      message: 'The appraisal company would not accept '
        + (skipped.length === 1 ? 'that document' : 'any of those documents')
        + ': ' + skipped.map((x) => `${x.filename || 'a file'} — ${x.detail}`).join('; ') };
  }
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

  // Only what was really staged AND really sent is recorded — walked over `sendable`,
  // never over `staged`, so a rejected file can never be written as delivered.
  const uploaded = [];
  for (let i = 0; i < sendable.length; i++) {
    await dbh.query(
      `INSERT INTO amc_order_documents
         (order_id, direction, document_id, document_type, object_name, action, retrieval_url, status)
       VALUES ($1,'outbound',$2,$3,$4,$5,$6,$7)`,
      [order.id, sendable[i].documentId, documents[i].documentType, documents[i].objectName, amcAction, sendable[i].staged.retrievalUrl, dry ? 'pending' : 'uploaded']);
    uploaded.push({ documentId: sendable[i].documentId, objectName: documents[i].objectName });
  }
  await journal(dbh, { orderId: order.id, appId: order.application_id, action: amcAction, request: built, response: dry ? { dryrun: true } : resp, ok: true, staffId });
  return { ok: true, dryrun: dry || undefined, uploaded, skipped };
}

// The auto-upload rules: send the current Scope of Work + contract to the order when
// they are not already there (the corrected SOW when it changes, the contract when it
// arrives). Skips HTML exports (the branded PDF/Excel + the real contract are what the
// AMC wants). Best-effort — returns { ok, uploaded } and never throws for a refusal.
async function autoUploadForOrder(dbh, order, deps = {}) {
  const autoDry = deps.dryrun != null ? !!deps.dryrun : !!client.configured().dryrun;
  const docs = await listUploadable(dbh, order.application_id, order.id, { dryrun: autoDry });
  const pick = docs.filter((d) => !d.alreadyUploaded
    && (d.category === CAT_SOW || d.category === CAT_CONTRACT)
    && !/html/i.test(String(d.contentType || ''))
    && !/\.html?$/i.test(String(d.filename || '')));
  if (!pick.length) return { ok: true, uploaded: 0 };
  const out = await uploadToOrder(dbh, order, { staffId: null, documentIds: pick.map((d) => d.id) }, { ...deps, dryrun: autoDry });
  return { ok: out.ok, uploaded: out.uploaded ? out.uploaded.length : 0, error: out.error, skipped: out.skipped };
}

module.exports = { listUploadable, uploadToOrder, autoUploadForOrder, docTypeForCategory, categoryOf, CAT_SOW, CAT_CONTRACT };
