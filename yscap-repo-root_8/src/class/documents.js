'use strict';
/**
 * Class Valuation — pull the finished appraisal (PDF + MISMO XML) back onto the file.
 *
 * This is the MIRROR of the NAN doc-ingest (src/amc/sync.js:ingestDocuments), adapted
 * to how Class works. NAN is polled and the poll RETURNS the documents; Class PUSHES,
 * and its `NewAttachments` callback ANNOUNCES an attachment by name but carries no bytes
 * (db/490 calls `class_attachments` "a WORK LIST" for exactly this reason). So this is
 * the fetch half of that work list: on a completion — or the moment an attachment is
 * announced — it downloads each announced document, files it into the Document Center,
 * stamps `class_attachments.document_id/fetched_at`, and hands the MISMO XML to the SAME
 * importer the manual upload uses (lib/appraisal/desk.runAppraisalImport), so the
 * finished appraisal lands on the loan file automatically.
 *
 * THREE THINGS THE VENDOR'S GUIDE DOES NOT PIN DOWN, and how this stays correct anyway
 * (the integration is dormant behind CLASS_ENABLED, and the guide even contradicts
 * itself on the attachments PATH — see docs/CLASS-VALUATION-V1-VS-V2.md §2 — so
 * defensiveness here IS correctness):
 *
 *  1. THE ANNOUNCEMENT CARRIES A NAME, NOT AN ID. The documented `NewAttachments`
 *     payload is `data.name` / `data.contentType` with no attachment id — but the
 *     content endpoint is addressed BY id (`/orders/{id}/attachments/{attId}`). So we
 *     LIST the order's attachments first to learn the ids (matching the announced rows
 *     by name), and a listed attachment we never got a callback for is filed too
 *     (belt-and-suspenders — nothing is lost).
 *
 *  2. THE DOWNLOAD SHAPE IS UNDOCUMENTED. `GET .../attachments/{id}` may return the
 *     file bytes directly, a JSON envelope with inline base64, or a JSON envelope with
 *     a download URL. `resolveAttachmentBytes` handles all three off the actual
 *     response, never a guess — a raw PDF/XML is used as-is, base64 is decoded, a URL
 *     is followed. A response that is JSON but carries neither is a recorded fetch
 *     error, not a corrupt document.
 *
 *  3. RETRIES ARE BOUNDED WITHOUT A COUNTER. A fresh announcement always tries; a
 *     persistently-failing one stops being retried once it is older than
 *     CLASS_ATTACH_RETRY_DAYS — so one un-downloadable attachment can never become a
 *     forever-poll (the callback-drain discipline, applied to the fetch).
 *
 * Attachments are NOT version-specific (their `/orders/{id}/attachments` has no /v2
 * variant — only order CREATE / READ / catalogue do), so unlike a status read this
 * never needs the order's UAD version.
 *
 * Best-effort throughout: a failure records itself and never breaks callback
 * processing or the order. RTL only; inert while CLASS_ENABLED is off.
 */

const crypto = require('crypto');
const db = require('../db');
const client = require('./client');
const storage = require('../lib/storage');
const switches = require('../lib/integrations/switches');
const conditionSlots = require('../lib/appraisal/condition-slots');

const RETRY_DAYS = Math.max(1, parseInt(process.env.CLASS_ATTACH_RETRY_DAYS || '3', 10) || 3);
const SWEEP_BATCH = Math.max(1, parseInt(process.env.CLASS_ATTACH_SWEEP_BATCH || '25', 10) || 25);

// ---------------------------------------------------------------------------
// PURE helpers — what a document IS, and how to read the vendor's responses.
// ---------------------------------------------------------------------------
const strOrNull = (v) => { const s = v == null ? '' : String(v).trim(); return s || null; };
function pick(o, keys) {
  if (!o || typeof o !== 'object') return null;
  for (const k of keys) { if (o[k] != null && o[k] !== '') return o[k]; }
  return null;
}

function looksXml(name, contentType, bytes) {
  const n = String(name || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  if (n.endsWith('.xml') || /xml/.test(ct)) return true;
  const head = bytes && bytes.length ? bytes.slice(0, 64).toString('utf8').trimStart() : '';
  return head.startsWith('<');
}
function looksPdf(name, contentType, bytes) {
  const n = String(name || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  if (n.endsWith('.pdf') || /pdf/.test(ct)) return true;
  return bytes && bytes.length >= 4 && bytes.slice(0, 4).toString('latin1') === '%PDF';
}

// The list endpoint's shape is not pinned down, so pull the array from wherever it is
// and read each entry across the obvious key spellings. Nothing is invented: an entry
// with no id AND no name AND no url is dropped.
function firstArray(resp) {
  if (Array.isArray(resp)) return resp;
  if (resp && typeof resp === 'object') {
    for (const k of ['data', 'attachments', 'items', 'results', 'value', 'files', 'documents']) {
      if (Array.isArray(resp[k])) return resp[k];
    }
    // A single object (one attachment) is a list of one.
    if (resp.name || resp.fileName || resp.id || resp.attachmentId) return [resp];
  }
  return [];
}
function parseAttachmentList(resp) {
  return firstArray(resp)
    .filter((a) => a && typeof a === 'object')
    .map((a) => ({
      id: strOrNull(pick(a, ['attachmentId', 'id', 'Id', 'attachment_id', 'attachmentID', 'AttachmentId'])),
      name: strOrNull(pick(a, ['name', 'fileName', 'filename', 'Name', 'FileName', 'title', 'documentName'])),
      contentType: strOrNull(pick(a, ['contentType', 'mimeType', 'ContentType', 'MimeType', 'content_type', 'type'])),
      url: strOrNull(pick(a, ['url', 'downloadUrl', 'objectUrl', 'link', 'href', 'presignedUrl', 'location', 'contentUrl', 'downloadURL'])),
    }))
    .filter((a) => a.id || a.name || a.url);
}

const B64_KEYS = ['content', 'fileContent', 'fileContents', 'contentBase64', 'contentBytes', 'base64', 'fileContentsBase64', 'data', 'bytes', 'body'];
const URL_KEYS = ['url', 'downloadUrl', 'objectUrl', 'link', 'href', 'presignedUrl', 'location', 'contentUrl', 'downloadURL'];
const CT_KEYS = ['contentType', 'mimeType', 'ContentType', 'MimeType', 'content_type'];
const NAME_KEYS = ['name', 'fileName', 'filename', 'Name', 'FileName'];

// A string long enough to be a document and made only of base64 characters. Not a
// proof, a filter — it stops a short human-readable value ("application/pdf", an id)
// being decoded into garbage bytes.
function looksBase64(s) {
  if (typeof s !== 'string') return false;
  const t = s.replace(/\s+/g, '');
  return t.length >= 64 && t.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(t);
}

/**
 * Turn a raw attachment response into `{ bytes, contentType, filename }`. `raw` is what
 * client.attachmentBytes returns: `{ bytes: Buffer, contentType }`. `getUrl(url)` (async)
 * follows a download link and returns the same `{ bytes, contentType }` — injected so the
 * shape logic is testable with no network.
 */
async function resolveAttachmentBytes(raw, { getUrl } = {}) {
  const bytes = raw && raw.bytes;
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('empty attachment response');

  // THE FIRST BYTE DECIDES, not the content-type — because a vendor can mislabel the
  // content-type (a JSON envelope tagged octet-stream, a PDF tagged text/plain) but a
  // real appraisal file NEVER starts with '{' or '['. A PDF starts '%', an XML '<', a
  // PNG 0x89, a JPEG 0xFF, a zip/docx 'P'. So only a body that opens as a JSON object
  // or array is treated as an envelope; everything else IS the file.
  const head = bytes.slice(0, 1).toString('latin1');
  if (head !== '{' && head !== '[') {
    return { bytes, contentType: raw.contentType || 'application/octet-stream' };
  }

  let meta;
  try { meta = JSON.parse(bytes.toString('utf8')); }
  catch { return { bytes, contentType: raw.contentType || 'application/octet-stream' }; }   // opens like JSON but isn't valid → treat the bytes AS the file (defensive)

  // The envelope may nest the useful part under `data`/`attachment`/`result`.
  let flat = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  for (const k of ['data', 'attachment', 'result', 'file', 'document']) {
    if (flat[k] && typeof flat[k] === 'object' && !Array.isArray(flat[k])) { flat = flat[k]; break; }
  }

  const metaCt = strOrNull(pick(flat, CT_KEYS)) || raw.contentType || 'application/octet-stream';
  const filename = strOrNull(pick(flat, NAME_KEYS)) || undefined;

  const b64 = pick(flat, B64_KEYS);
  if (typeof b64 === 'string' && looksBase64(b64)) {
    return { bytes: Buffer.from(b64.replace(/\s+/g, ''), 'base64'), contentType: metaCt, filename };
  }
  const url = strOrNull(pick(flat, URL_KEYS));
  if (url && getUrl) {
    const got = await getUrl(url);
    if (!got || !Buffer.isBuffer(got.bytes) || !got.bytes.length) throw new Error('download url returned no bytes');
    return { bytes: got.bytes, contentType: got.contentType || metaCt, filename };
  }
  throw new Error('attachment response is JSON but carries neither inline content nor a download url');
}

// ---------------------------------------------------------------------------
// Fetch + file one order's announced documents. Returns { ok, filed, imported }.
// deps lets a test inject the transport / storage / importer; production uses the real ones.
//
// A per-order ADVISORY LOCK serializes the pass so two concurrent runs — the webhook
// receiver's drain and the poller sweep, or two scaled-out instances — can't both
// select the same un-fetched attachment and file it twice (the read-then-write class
// db/401 fixed for evaluateApplication; same shape here). A caller that passed its OWN
// transaction client already owns isolation (a test, or an in-tx caller) and runs inner
// directly; the pool path takes the lock on a dedicated connection. FAIL-OPEN: a lock we
// cannot take still runs — a missed lock costs at most one duplicate staff-only / pending
// document a human rejects (and the re-import self-heals), while refusing to run would
// silently drop the appraisal.
// ---------------------------------------------------------------------------
async function ingestForOrder(dbc, order, deps = {}) {
  const onPool = !dbc || dbc === db;
  if (!onPool) return ingestForOrderLocked(dbc, order, deps);
  const lockKey = `class-doc-ingest:${order && order.id}`;
  let lockConn = null;
  try {
    try {
      lockConn = await db.getClient();
      await lockConn.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
    } catch (_) {
      // Fail open — but if getClient() succeeded and only the lock query threw, release
      // the checked-out connection before dropping the reference, or it leaks from the pool.
      if (lockConn) { try { lockConn.release(); } catch (_2) { /* ignore */ } lockConn = null; }
    }
    return await ingestForOrderLocked(db, order, deps);
  } finally {
    if (lockConn) {
      try { await lockConn.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]); } catch (_) { /* ignore */ }
      try { lockConn.release(); } catch (_) { /* ignore */ }
    }
  }
}

async function ingestForOrderLocked(dbc, order, deps = {}) {
  const q = dbc || db;
  const transport = deps.transport || client;
  const store = deps.storage || storage;
  const importAppraisal = deps.importAppraisal
    || ((args) => require('../lib/appraisal/desk').runAppraisalImport(args));

  if (transport.configured && !transport.configured().enabled) return { ok: false, skipped: 'disabled' };
  // Without their order id we can neither list nor fetch — a callback that reached us
  // before the id was written back. The sweep retries it once the id lands.
  if (!order || !order.class_order_id) return { ok: false, skipped: 'no_class_order_id' };

  // 1. LIST — learn the ids the announcement did not carry, and adopt any attachment
  //    Class holds that we were never told about. A list failure is non-fatal: we fall
  //    back to whatever ids are already on the work-list rows.
  let list = [];
  try { list = parseAttachmentList(await transport.attachments(order.class_order_id)); }
  catch (e) { console.warn('[class] attachment list failed for order', order.id, (e && e.message) || e); }

  const urlByKey = new Map();
  for (const a of list) {
    if (a.url) {
      if (a.id) urlByKey.set('id:' + a.id, a.url);
      if (a.name) urlByKey.set('name:' + a.name, a.url);
    }
    // Reconcile by NAME (the one identifier both the callback and the list carry):
    // fill in the id/content-type on an announced row, or insert a listed-but-never-
    // announced one. An id-only list entry has nothing to join on and is left for the
    // callback that names it.
    if (!a.name) continue;
    await q.query(
      `INSERT INTO class_attachments (class_order_row, application_id, name, content_type, class_attachment_id, direction)
       VALUES ($1,$2,$3,$4,$5,'inbound')
       ON CONFLICT (class_order_row, name) WHERE name IS NOT NULL AND direction = 'inbound'
       DO UPDATE SET class_attachment_id = COALESCE(class_attachments.class_attachment_id, EXCLUDED.class_attachment_id),
                     content_type        = COALESCE(class_attachments.content_type, EXCLUDED.content_type)`,
      [order.id, order.application_id, a.name, a.contentType, a.id]);
  }

  // 2. FETCH every announced-but-unfetched attachment (bounded — see RETRY_DAYS).
  const rows = (await q.query(
    `SELECT * FROM class_attachments
      WHERE class_order_row = $1 AND document_id IS NULL AND direction = 'inbound'
        AND (fetch_error IS NULL OR announced_at > now() - ($2 || ' days')::interval)
      ORDER BY announced_at ASC`,
    [order.id, String(RETRY_DAYS)])).rows;
  if (!rows.length) return { ok: true, filed: 0, imported: false };

  const app = (await q.query(`SELECT borrower_id FROM applications WHERE id=$1`, [order.application_id])).rows[0];
  const borrowerId = app ? app.borrower_id : null;

  let filed = 0, xmlDocId = null, xmlString = null, pdfDocId = null;

  // WHERE THE REPORT GOES ON THE FILE — see lib/appraisal/condition-slots.js. The
  // order row's own link wins; an order that carries none resolves the file's
  // appraisal-documents condition here, so a delivery is never stranded off the
  // condition it satisfies.
  const itemId = order.checklist_item_id || (await conditionSlots.conditionItemId(q, order.application_id));
  const slotLabels = await conditionSlots.slotLabels(q);

  for (const row of rows) {
    try {
      const directUrl = (row.class_attachment_id && urlByKey.get('id:' + row.class_attachment_id))
        || (row.name && urlByKey.get('name:' + row.name)) || null;

      let got;
      if (row.class_attachment_id) {
        const raw = await transport.attachmentBytes(order.class_order_id, row.class_attachment_id);
        got = await resolveAttachmentBytes(raw, { getUrl: (u) => transport.fetchUrl(u) });
      } else if (directUrl) {
        got = await transport.fetchUrl(directUrl);
      } else {
        throw new Error('announced with no attachment id and no download url — cannot fetch (a later list will resolve it)');
      }

      const bytes = got && got.bytes;
      if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('attachment fetch returned no bytes');
      const contentType = got.contentType || row.content_type || 'application/octet-stream';
      const filename = String(got.filename || row.name || 'class-appraisal-document').slice(0, 300);
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      // CLASSIFY BEFORE FILING — the slot label has to ride in the INSERT, or the
      // condition cannot see the document as filling its slot in between. Only the
      // FIRST data file and the FIRST report take the two slots; every other
      // attachment Class returns is filed on the condition unslotted.
      const isXml = !xmlDocId && looksXml(filename, contentType, bytes);
      const isPdf = !isXml && !pdfDocId && looksPdf(filename, contentType, bytes);
      const kind = isXml ? 'xml' : (isPdf ? 'pdf' : null);
      const slotLabel = kind ? await conditionSlots.labelFor(q, itemId, kind, slotLabels) : null;
      const { ref, provider } = await store.save(bytes, { filename });

      const ins = await q.query(
        `INSERT INTO documents
           (application_id, borrower_id, checklist_item_id, filename, content_type, size_bytes,
            storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, doc_kind, review_status, sha256,
            source_type, visibility, slot_label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staff',NULL,$10,'pending',$9,'system','staff_only',$11)
         RETURNING id`,
        // Only the data file and the report go onto the condition — see the same
        // note in src/amc/sync.js: a condition refuses sign-off while any document
        // on it is un-reviewed, so an extra attachment must not become a blocker.
        [order.application_id, borrowerId, kind ? itemId : (order.checklist_item_id || null),
          filename, contentType, bytes.length, provider, ref, sha,
          kind ? conditionSlots.DOC_KIND[kind] : null, slotLabel]);
      const docId = ins.rows[0].id;

      await q.query(
        `UPDATE class_attachments
            SET document_id=$2, content_type=COALESCE(content_type,$3), fetched_at=now(), fetch_error=NULL
          WHERE id=$1`,
        [row.id, docId, contentType]);
      filed += 1;

      if (isXml) { xmlDocId = docId; xmlString = bytes.toString('utf8'); }
      else if (isPdf) { pdfDocId = docId; }
    } catch (e) {
      await q.query(`UPDATE class_attachments SET fetch_error=$2 WHERE id=$1`,
        [row.id, String((e && e.message) || e).slice(0, 500)]).catch(() => {});
      console.error('[class] could not fetch attachment', row.id, 'order', order.id, (e && e.message) || e);
    }
  }

  // 3. IMPORT — a newly-filed MISMO XML feeds the same importer the manual upload uses.
  //    If the XML and the PDF arrived on different passes, recover the PDF's document id
  //    from an already-fetched attachment so both ride into the importer. Best-effort:
  //    a bad/unreadable XML answers ok:false and never breaks the order.
  let imported = false;
  if (xmlString) {
    if (!pdfDocId) {
      const pdf = (await q.query(
        `SELECT d.id FROM class_attachments ca JOIN documents d ON d.id = ca.document_id
          WHERE ca.class_order_row=$1 AND ca.direction = 'inbound'
            AND (lower(COALESCE(ca.content_type,'')) LIKE '%pdf%' OR lower(COALESCE(ca.name,'')) LIKE '%.pdf')
          ORDER BY ca.fetched_at DESC NULLS LAST LIMIT 1`, [order.id])).rows[0];
      if (pdf) pdfDocId = pdf.id;
    }
    try {
      const out = await importAppraisal({
        appId: order.application_id, xml: xmlString, importedBy: null,
        xmlDocumentId: xmlDocId, pdfDocumentId: pdfDocId,
      });
      imported = !!(out && out.ok);
    } catch (e) {
      console.error('[class] appraisal import failed for order', order.id, (e && e.message) || e);
    }
    // The import is the proof these two documents are the appraisal we ordered —
    // see lib/appraisal/condition-slots.js. A delivery that did not import stays
    // pending for a human.
    if (imported) await conditionSlots.acceptImportedSources(q, [xmlDocId, pdfDocId]);
  }
  require('../lib/appraisal-order-mirror').fire(order.application_id);
  return { ok: true, filed, imported };
}

// ---------------------------------------------------------------------------
// BACKSTOP sweep — catch an order whose attachment was announced but never fetched
// (the fetch failed, or the callback arrived before the order id had been written
// back). Bounded, self-gated, never throws. Runs from the callback poller.
// ---------------------------------------------------------------------------
async function sweepPendingOnce(dbc = db) {
  const q = dbc || db;
  if (client.configured && !client.configured().enabled) return { swept: 0, skipped: 'disabled' };
  const orders = (await q.query(
    `SELECT DISTINCT o.* FROM class_orders o
       JOIN class_attachments a ON a.class_order_row = o.id
      WHERE a.document_id IS NULL AND a.direction = 'inbound'
        AND o.class_order_id IS NOT NULL
        AND a.announced_at > now() - ($1 || ' days')::interval
      ORDER BY o.id
      LIMIT $2`, [String(RETRY_DAYS), SWEEP_BATCH])).rows;
  let swept = 0;
  for (const o of orders) {
    try { await ingestForOrder(q, o); swept += 1; }
    catch (e) { console.error('[class] attachment sweep failed for order', o.id, (e && e.message) || e); }
  }
  return { swept };
}

// ===========================================================================
// THE OTHER DIRECTION — documents going OUT to the appraiser (owner-directed
// 2026-09-02: "Very important that we should be able to upload documents").
//
// The mirror of src/amc/documents.js `listUploadable` / `uploadToOrder` /
// `autoUploadForOrder`, on Class's `POST /{orderId}/attachments/{category}`. Same
// three rules as the AMC side, because they are rules about OUR files, not theirs:
//   • the picker lists the file's current Document Center documents with the shared
//     categorizer's category and whether each is already on the order;
//   • the scope of work and the purchase contract go up AUTOMATICALLY on every poll
//     when they are not there yet (the corrected SOW when it changes, the contract
//     when it arrives) — nobody has to remember;
//   • an HTML export is never sent (the branded PDF is what the appraiser wants).
//
// What differs is Class's vocabulary. Their upload takes a CATEGORY in the path and
// an `AttachmentType` ∈ HyperLink / PDF / XML / Image in the body — there is no
// "Word" or "Excel" type, so a document whose bytes are neither a PDF, an XML nor an
// image is SKIPPED with a reason rather than sent under a false label. Their
// category list has exact slots for the two documents that matter most —
// `SalesContract` for the contract, `PlansAndSpecs` for the scope of work — and
// `Miscellaneous` for everything else.
// ===========================================================================
const tpr = require('../lib/tpr-export');

const CAT_SOW = 'Scope of Work';
const CAT_CONTRACT = 'Contract & Assignment';

// Class's own attachment categories we send under (their guide p.18, verbatim).
const CLASS_CATEGORIES = [
  'InvisionLink', 'PDCReport', 'PDRReport', 'PFRReport', 'QRRReport', 'AppraisalXml', 'Appraisal',
  'Invoice', 'AppraiserLicense', 'ComplianceCertificate', 'SalesContract', 'PurchaseAgreement',
  'Miscellaneous', 'Other', 'FannieMaeSsr', 'FreddieMacSsr', 'Eadssr', 'PDAPIData', 'FreddieData',
  'PCRReport', 'PropertyPhoto', 'AltValReport', 'ConditionReport', 'PDAReport', 'ClientEngagementLetter',
  'PlansAndSpecs', 'Title', 'ROVDocument', 'BorrowerIntentToProceed', 'ARAReport', 'APPZIP',
];

/** Our document category (the shared categorizer's label) → the Class category to file it under. */
function classCategoryFor(category) {
  if (category === CAT_CONTRACT) return 'SalesContract';
  if (category === CAT_SOW) return 'PlansAndSpecs';
  return 'Miscellaneous';
}

/** A caller-named Class category, in their casing, or null when it is not one of theirs. */
function classCategory(name) {
  const wanted = String(name == null ? '' : name).trim().toLowerCase();
  if (!wanted) return null;
  return CLASS_CATEGORIES.find((c) => c.toLowerCase() === wanted) || null;
}

/**
 * Class's `AttachmentType` for a document, from its content type and name — PDF, XML
 * or Image — or null when the file is none of those (a Word or Excel export), which
 * the caller reports as "unsupported" rather than mislabelling.
 */
function attachmentTypeFor(contentType, filename) {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  const fn = String(filename || '').toLowerCase();
  if (ct.includes('pdf') || fn.endsWith('.pdf')) return 'PDF';
  // An XML document, not an Office file: Word and Excel content types are
  // `application/vnd.openxmlformats-…`, which CONTAINS "xml" and is not one.
  if (ct === 'text/xml' || ct === 'application/xml' || ct.endsWith('+xml') || fn.endsWith('.xml')) return 'XML';
  if (ct.startsWith('image/') || /\.(jpe?g|png|gif|tiff?|bmp|webp|heic)$/.test(fn)) return 'Image';
  return null;
}

function categoryOf(row) {
  try { return tpr.categoryFor(row); } catch (_) { return 'Other Documents'; }
}

function isHtmlExport(d) {
  return /html/i.test(String(d.contentType || d.content_type || '')) || /\.html?$/i.test(String(d.filename || ''));
}

/**
 * The file's current Document Center documents, each with a category, the Class
 * category it would be filed under, whether Class can take it at all, and whether it
 * is already on `orderRowId`. Read-only.
 */
async function listUploadable(dbh, appId, orderRowId = null) {
  const q = dbh || db;
  const r = await q.query(
    `SELECT d.id, d.filename, d.content_type, d.size_bytes, d.doc_kind, d.review_status,
            d.llc_id, d.created_at, ci.label AS item_label, ct.code AS template_code
       FROM documents d
       LEFT JOIN checklist_items ci ON ci.id = d.checklist_item_id
       LEFT JOIN checklist_templates ct ON ct.id = ci.template_id
      WHERE d.application_id = $1 AND d.is_current = true
      ORDER BY d.created_at DESC`, [appId]);
  let sent = new Map();
  if (orderRowId) {
    const s = await q.query(
      `SELECT document_id, category, uploaded_at, upload_error, upload_attempts FROM class_attachments
        WHERE class_order_row = $1 AND direction = 'outbound' AND document_id IS NOT NULL`, [orderRowId]);
    sent = new Map(s.rows.map((x) => [String(x.document_id), x]));
  }
  return r.rows.map((d) => {
    const category = categoryOf(d);
    const attachmentType = attachmentTypeFor(d.content_type, d.filename);
    const was = sent.get(String(d.id));
    // "Sent" means Class actually took it — a stamped uploaded_at and no error. A row
    // that only records a FAILURE (or a dry run) is not sent, and the picker must
    // never say it was (pre-merge audit 2026-09-03: it did, so a failed scope of work
    // was never retried and never re-offered).
    const done = !!(was && was.uploaded_at && !was.upload_error);
    const attempts = was ? Number(was.upload_attempts || 0) : 0;
    return {
      id: d.id, filename: d.filename, contentType: d.content_type, sizeBytes: d.size_bytes,
      docKind: d.doc_kind, reviewStatus: d.review_status,
      category,
      classCategory: classCategoryFor(category),
      attachmentType,
      sendable: !!attachmentType && !isHtmlExport({ contentType: d.content_type, filename: d.filename }),
      alreadyUploaded: done,
      uploadedAt: done ? was.uploaded_at : null,
      uploadError: was && was.upload_error ? String(was.upload_error) : null,
      uploadAttempts: attempts,
      // Retried by the poller until the cap; after that a human sends it by hand.
      uploadGaveUp: !!(was && was.upload_error && attempts >= MAX_UPLOAD_ATTEMPTS),
    };
  });
}

/**
 * Upload the picked documents to a Class order. `category` (optional) forces one Class
 * category for the whole pick — the picker's "send as the purchase contract"; otherwise
 * each document goes under the category its own kind maps to. Returns
 * { ok, uploaded:[{documentId, filename, category}], skipped:[{documentId, reason}] }.
 * Never throws for a refusal: a write-gate refusal comes back as `outbound_disabled`.
 */
/* One order's uploads run ONE AT A TIME in this process. The order route sends the
   scope of work the moment Class numbers the order and the poller repeats the same
   pick minutes later; without this, both can pass the "already sent" read before
   either has written its row, and Class receives the same file twice. The unique
   index would merge the ROWS — it cannot un-send the bytes. PILOT runs as a single
   instance (the web service carries a persistent disk), so an in-process queue is
   the whole lock. */
const inFlight = new Map();
async function withOrderLock(orderRowId, fn) {
  const key = String(orderRowId);
  const prev = inFlight.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  inFlight.set(key, run);
  try { return await run; }
  finally { if (inFlight.get(key) === run) inFlight.delete(key); }
}

// A failed send is retried by the poller (every five minutes) this many times, then
// left for a human: an error that survives an hour of retries is not transient.
const MAX_UPLOAD_ATTEMPTS = 12;

// The write gates, as `client.request` raises them. None of these is a failure of
// THIS document: nothing is recorded against the row, and the next pass simply asks
// again once the switch is on. (The audit found CLASS_DISABLED / CLASS_NOT_CONFIGURED
// being written down as upload errors and never retried.)
const GATE_CODES = { CLASS_OUTBOUND_DISABLED: 'outbound_disabled', CLASS_DISABLED: 'class_disabled', CLASS_NOT_CONFIGURED: 'not_configured' };

async function uploadToOrder(dbh, order, opts = {}, deps = {}) {
  if (!order || order.id == null) return uploadToOrderInner(dbh, order, opts, deps);
  return withOrderLock(order.id, () => uploadToOrderInner(dbh, order, opts, deps));
}

async function uploadToOrderInner(dbh, order, { staffId = null, documentIds, category, force = false } = {}, deps = {}) {
  const q = dbh || db;
  const transport = deps.transport || client;
  const readStorage = deps.readStorage || ((ref) => storage.read(ref));
  const ids = (documentIds || []).filter(Boolean);
  if (!ids.length) return { ok: false, error: 'no_documents' };
  if (!order || !order.class_order_id) return { ok: false, error: 'not_numbered', message: 'Class has not numbered this order yet — nothing can be attached to it.' };
  let forced = null;
  if (category != null && category !== '') {
    forced = classCategory(category);
    if (!forced) {
      return { ok: false, error: 'unknown_category',
        message: `Class has no "${String(category)}" attachment category — it is one of ${CLASS_CATEGORIES.join(', ')}.` };
    }
  }

  const rows = (await q.query(
    `SELECT d.id, d.filename, d.content_type, d.storage_ref, d.doc_kind, d.llc_id,
            ci.label AS item_label, ct.code AS template_code
       FROM documents d
       LEFT JOIN checklist_items ci ON ci.id = d.checklist_item_id
       LEFT JOIN checklist_templates ct ON ct.id = ci.template_id
      WHERE d.application_id = $1 AND d.id = ANY($2::uuid[])`, [order.application_id, ids])).rows;
  const prior = new Map((await q.query(
    `SELECT document_id, uploaded_at, upload_error, upload_attempts FROM class_attachments
      WHERE class_order_row=$1 AND direction='outbound' AND document_id = ANY($2::uuid[])`,
    [order.id, ids])).rows.map((x) => [String(x.document_id), x]));

  const uploaded = [];
  const skipped = [];
  for (const d of rows) {
    const was = prior.get(String(d.id));
    // Sent = Class took it (uploaded_at stamped, no error). A failed or dry-run row is
    // NOT sent and is tried again — up to the cap on failures, unless a human asked
    // (`force`, the picker's own button), which always gets one more try.
    if (was && was.uploaded_at && !was.upload_error) { skipped.push({ documentId: d.id, reason: 'already_uploaded' }); continue; }
    if (!force && was && was.upload_error && Number(was.upload_attempts || 0) >= MAX_UPLOAD_ATTEMPTS) {
      skipped.push({ documentId: d.id, reason: 'gave_up', detail: String(was.upload_error) });
      continue;
    }
    if (isHtmlExport({ contentType: d.content_type, filename: d.filename })) { skipped.push({ documentId: d.id, reason: 'html_export' }); continue; }
    const attachmentType = attachmentTypeFor(d.content_type, d.filename);
    if (!attachmentType) { skipped.push({ documentId: d.id, reason: 'unsupported_type', detail: 'Class takes PDF, XML and image files only' }); continue; }
    let bytes;
    try { bytes = await readStorage(d.storage_ref); }
    catch (_) { skipped.push({ documentId: d.id, reason: 'read_failed' }); continue; }
    if (!bytes || !bytes.length) { skipped.push({ documentId: d.id, reason: 'empty' }); continue; }

    const cat = forced || classCategoryFor(categoryOf(d));
    let resp;
    try {
      resp = await transport.uploadAttachment(order.class_order_id, cat,
        { fileName: d.filename || 'document', contentType: d.content_type || 'application/octet-stream', bytes, attachmentType });
    } catch (e) {
      const gate = e && e.code && GATE_CODES[e.code];
      if (gate) return { ok: false, error: gate, message: String(e.message || e), uploaded, skipped };
      const reason = String((e && e.message) || e);
      await q.query(
        `INSERT INTO class_attachments (class_order_row, application_id, name, content_type, document_id, direction, category, uploaded_by, upload_error, upload_attempts)
         VALUES ($1,$2,$3,$4,$5,'outbound',$6,$7,$8,1)
         ON CONFLICT (class_order_row, document_id) WHERE direction = 'outbound' AND document_id IS NOT NULL
         DO UPDATE SET upload_error = EXCLUDED.upload_error, upload_attempts = class_attachments.upload_attempts + 1`,
        [order.id, order.application_id, d.filename, d.content_type, d.id, cat, staffId, reason.slice(0, 500)]).catch(() => {});
      skipped.push({ documentId: d.id, reason: 'send_failed', detail: reason });
      continue;
    }
    const dry = !!(resp && resp.__dryrun);
    await q.query(
      `INSERT INTO class_attachments (class_order_row, application_id, name, content_type, document_id, direction, category, uploaded_by, uploaded_at, upload_error)
       VALUES ($1,$2,$3,$4,$5,'outbound',$6,$7,$8,NULL)
       ON CONFLICT (class_order_row, document_id) WHERE direction = 'outbound' AND document_id IS NOT NULL
       DO UPDATE SET uploaded_at = EXCLUDED.uploaded_at, category = EXCLUDED.category, upload_error = NULL, upload_attempts = 0`,
      [order.id, order.application_id, d.filename, d.content_type, d.id, cat, staffId, dry ? null : new Date()]);
    uploaded.push({ documentId: d.id, filename: d.filename, category: cat, dryrun: dry || undefined });
  }
  if (!uploaded.length) return { ok: false, error: 'nothing_to_upload', skipped };
  return { ok: true, uploaded, skipped };
}

/**
 * The auto-upload rule: the current scope of work and the purchase contract go to the
 * order when they are not there yet. Best-effort — returns { ok, uploaded } and never
 * throws; with writes gated off it simply reports so.
 */
async function autoUploadForOrder(dbh, order, deps = {}) {
  if (!order || !order.class_order_id) return { ok: true, uploaded: 0 };
  // Ask the switches BEFORE reading anything off disk: with writes off, the old
  // shape read every open order's scope of work and contract every five minutes to
  // then be refused at the transport (pre-merge audit 2026-09-03). A dry run still
  // runs — it is how the body is checked before the switch is turned on.
  const sw = deps.switches || switches;
  if (!sw.on('CLASS_ENABLED')) return { ok: true, uploaded: 0, gated: 'class_disabled' };
  if (!sw.on('CLASS_OUTBOUND_ENABLED') && !sw.on('CLASS_DRYRUN')) return { ok: true, uploaded: 0, gated: 'outbound_disabled' };
  const docs = await listUploadable(dbh, order.application_id, order.id);
  const pick = docs.filter((d) => !d.alreadyUploaded && !d.uploadGaveUp && d.sendable
    && (d.category === CAT_SOW || d.category === CAT_CONTRACT));
  if (!pick.length) return { ok: true, uploaded: 0 };
  const out = await uploadToOrder(dbh, order, { staffId: null, documentIds: pick.map((d) => d.id) }, deps);
  return { ok: out.ok, uploaded: out.uploaded ? out.uploaded.length : 0, error: out.error, skipped: out.skipped };
}

module.exports = {
  ingestForOrder, sweepPendingOnce,
  // outbound
  listUploadable, uploadToOrder, autoUploadForOrder,
  // pure — exported for the unit tests
  parseAttachmentList, resolveAttachmentBytes, looksXml, looksPdf,
  classCategoryFor, classCategory, attachmentTypeFor, CLASS_CATEGORIES, CAT_SOW, CAT_CONTRACT,
  _internals: { pick, looksBase64, firstArray, RETRY_DAYS, MAX_UPLOAD_ATTEMPTS, GATE_CODES, withOrderLock },
};
