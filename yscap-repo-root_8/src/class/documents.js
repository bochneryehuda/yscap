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
      `INSERT INTO class_attachments (class_order_row, application_id, name, content_type, class_attachment_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (class_order_row, name) WHERE name IS NOT NULL
       DO UPDATE SET class_attachment_id = COALESCE(class_attachments.class_attachment_id, EXCLUDED.class_attachment_id),
                     content_type        = COALESCE(class_attachments.content_type, EXCLUDED.content_type)`,
      [order.id, order.application_id, a.name, a.contentType, a.id]);
  }

  // 2. FETCH every announced-but-unfetched attachment (bounded — see RETRY_DAYS).
  const rows = (await q.query(
    `SELECT * FROM class_attachments
      WHERE class_order_row = $1 AND document_id IS NULL
        AND (fetch_error IS NULL OR announced_at > now() - ($2 || ' days')::interval)
      ORDER BY announced_at ASC`,
    [order.id, String(RETRY_DAYS)])).rows;
  if (!rows.length) return { ok: true, filed: 0, imported: false };

  const app = (await q.query(`SELECT borrower_id FROM applications WHERE id=$1`, [order.application_id])).rows[0];
  const borrowerId = app ? app.borrower_id : null;

  let filed = 0, xmlDocId = null, xmlString = null, pdfDocId = null;
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
      const { ref, provider } = await store.save(bytes, { filename });

      const ins = await q.query(
        `INSERT INTO documents
           (application_id, borrower_id, checklist_item_id, filename, content_type, size_bytes,
            storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, doc_kind, review_status, sha256,
            source_type, visibility)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staff',NULL,NULL,'pending',$9,'system','staff_only')
         RETURNING id`,
        [order.application_id, borrowerId, order.checklist_item_id || null,
          filename, contentType, bytes.length, provider, ref, sha]);
      const docId = ins.rows[0].id;

      await q.query(
        `UPDATE class_attachments
            SET document_id=$2, content_type=COALESCE(content_type,$3), fetched_at=now(), fetch_error=NULL
          WHERE id=$1`,
        [row.id, docId, contentType]);
      filed += 1;

      if (!xmlString && looksXml(filename, contentType, bytes)) { xmlDocId = docId; xmlString = bytes.toString('utf8'); }
      else if (!pdfDocId && looksPdf(filename, contentType, bytes)) { pdfDocId = docId; }
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
          WHERE ca.class_order_row=$1
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
  }
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
      WHERE a.document_id IS NULL
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

module.exports = {
  ingestForOrder, sweepPendingOnce,
  // pure — exported for the unit tests
  parseAttachmentList, resolveAttachmentBytes, looksXml, looksPdf,
  _internals: { pick, looksBase64, firstArray, RETRY_DAYS },
};
