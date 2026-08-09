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
const { matchStaged } = require('./stage-match');
const client = require('./client');
const session = require('./session');
const storage = require('../lib/storage');
const tpr = require('../lib/tpr-export');
const { journal } = require('./order-service');
// One definition for both desks — never a pasted copy; see the module header.
const { sendFailMessage, nackMessage } = require('../lib/appraisal-messages');


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
  // NOT the same thing as a refusal, and it must never be worded as one. The upload
  // call succeeded and the appraisal company answered — we could not tell WHICH of
  // their answers was about this file, so we refused to guess rather than risk filing
  // one document's link under another's name. Blaming them sends whoever reads it to
  // the wrong party, and this is the answer they see on every poll until it clears.
  unmatched_answer: 'we could not tell which of their answers was about this file',
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
  if (!ids.length) return { ok: false, error: 'no_documents', message: 'Pick at least one document to send.' };

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
    if (already.has(String(d.id))) { skipped.push({ documentId: d.id, filename: d.filename, reason: 'already_uploaded', detail: reasonText('already_uploaded') }); continue; }
    let bytes;
    try { bytes = await readStorage(d.storage_ref); }
    catch (_) { skipped.push({ documentId: d.id, filename: d.filename, reason: 'read_failed', detail: reasonText('read_failed') }); continue; }
    if (!bytes || !bytes.length) { skipped.push({ documentId: d.id, filename: d.filename, reason: 'empty', detail: reasonText('empty') }); continue; }
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
    return { ok: false, error: e.code === 'AMC_OUTBOUND_DISABLED' ? 'outbound_disabled' : 'stage_failed', message: sendFailMessage(e, 'The documents'), skipped };
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
  // WHICH ANSWER BELONGS TO WHICH FILE is its own problem, and a hard one — six audit
  // passes each found a new way an incremental version of it mis-filed a document. The
  // whole rule lives in src/amc/stage-match.js, pure and swept exhaustively; an answer
  // it cannot place with confidence comes back null and is refused below.
  const matched = matchStaged(files, staged);
  const stagedFor = (i) => matched[i] || null;
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
      // WHOSE PROBLEM IT IS DECIDES WHO HAS TO ACT, so the two are separate reasons.
      // No staged entry at all means the MATCHER declined to place one of their answers
      // on this file — ours to work out, not a refusal they made. Only an entry they
      // actually returned can carry `stage_rejected`.
      const reason = st ? 'stage_rejected' : 'unmatched_answer';
      // `errorTraceID` IS A SUPPORT REFERENCE, NOT AN EXPLANATION — a CoreLogic trace
      // GUID. It was used as the human `detail`, which composes into the batch
      // `message` and into the poller's log, so a refusal reached the appraisal desk
      // reading "Scope of Work.pdf — 6f1c9a02-3e4d-4b77-9a10-5c8e2d0b7f31" in red: a
      // person cannot act on it, and it displaced the sentence that says what happened.
      // It is KEPT on the record as its own field — that is the number their support
      // asks for — and journaled below; it just never becomes the wording.
      skipped.push({ documentId: specs[i].documentId,
        filename: specs[i].filename,
        reason,
        traceId: (st && st.errorTraceID) ? String(st.errorTraceID) : null,
        detail: stated
          || (st ? 'the appraisal company returned no link for this file' : reasonText('unmatched_answer')) });
      continue;
    }
    sendable.push({ ...specs[i], staged: st });
    documents.push({
      objectURL: st.retrievalUrl, objectName: st.fileName || specs[i].filename,
      documentType: docTypeForCategory(specs[i].category),
    });
  }
  if (!documents.length) {
    // THE BATCH-LEVEL ANSWER MUST NOT CONTRADICT THE PER-FILE ONES. Giving each skip its
    // own honest reason and leaving this sentence hard-coded produced, verbatim:
    // "The appraisal company would not accept that document: Scope of Work.pdf — we
    // could not tell which of their answers was about this file" — a sentence that
    // blames them and then says the opposite. Worse on the unattended path, where the
    // poller logs the per-file reasons on OUR side of the split and this message on
    // THEIRS, in the same tick. So it is composed from what actually happened.
    const theirs = skipped.filter((x) => x.reason === 'stage_rejected');
    const lead = !theirs.length
      ? 'These could not be sent'
      : (theirs.length === skipped.length
        ? 'The appraisal company would not accept ' + (skipped.length === 1 ? 'that document' : 'any of those documents')
        : 'Nothing could be sent');
    await journal(dbh, { orderId: order.id, appId: order.application_id, action: 'postdocuments', ok: false,
      response: { staged, skipped },
      error: theirs.length ? 'every file was rejected at staging' : 'no answer could be matched to a file', staffId });
    return {
      // The CODE follows the same rule the per-file reasons do — a batch nobody refused
      // is not `stage_rejected`, and sync.js splits the poller's log on exactly this.
      ok: false, error: theirs.length ? 'stage_rejected' : 'unmatched_answer', skipped,
      message: lead + ': ' + skipped.map((x) => `${x.filename || 'a file'} — ${x.detail}`).join('; '),
    };
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
    return { ok: false, error: e.code === 'AMC_OUTBOUND_DISABLED' ? 'outbound_disabled' : 'send_failed', message: sendFailMessage(e, 'The documents'), skipped };
  }

  const dry = !!(resp && resp.__dryrun);
  if (!dry) {
    const err = cdg.parseError(resp);
    if (err) {
      if (String(err.code) === '-100' || /authenticat/i.test(err.description || '')) session.invalidate();
      await journal(dbh, { orderId: order.id, appId: order.application_id, action: amcAction, request: built, response: resp, ok: false, error: err.description || err.code, staffId });
      return { ok: false, error: 'amc_nack', message: nackMessage(err, 'the documents'), skipped };
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
  // A PARTIAL batch still has to record why the rest was held back — including each
  // vendor trace id, which is deliberately no longer in the wording the desk reads and
  // would otherwise exist nowhere at all. It rides INSIDE `response`: `journal`
  // destructures a fixed set of keys, so a new top-level one is silently dropped.
  const answered = dry ? { dryrun: true } : resp;
  await journal(dbh, { orderId: order.id, appId: order.application_id, action: amcAction, request: built,
    response: skipped.length ? { answered, held: skipped } : answered, ok: true, staffId });
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
  // `message` rides along or the poller has only a CODE to print — every plain
  // sentence the send path composes would stop at this line, on the one path where
  // nobody is watching and the log is the whole record.
  return { ok: out.ok, uploaded: out.uploaded ? out.uploaded.length : 0,
    error: out.error, message: out.message, skipped: out.skipped };
}

module.exports = { listUploadable, uploadToOrder, autoUploadForOrder, docTypeForCategory, categoryOf, CAT_SOW, CAT_CONTRACT };
