/**
 * CLOSING CHAIN — the inbound side (owner-directed 2026-07-28).
 *
 * When anyone on the closing chain sends a message that carries the file's unique
 * `closing+<token>@` address, the inbound webhook resolves the file (see
 * closing-thread.resolveByToken) and hands the attachments here.
 *
 * WHERE THE DOCUMENTS GO, and why it is deliberately NOT a condition.
 * The owner was explicit: "the documents should automatically save directly into the
 * closing folder of the file — not the closing package, a separate document
 * package". So each one is saved as an ordinary `documents` row with
 *   doc_kind = 'closing_correspondence'
 *   checklist_item_id = NULL          (attached to no condition, on purpose)
 * which gives the file a self-contained CLOSING CORRESPONDENCE package holding
 * everything that went back and forth, in order, alongside the email history it
 * came from. It is deliberately distinct from:
 *   · the post-closing `closing_package` item — that is the final executed set a
 *     human files after closing, not a running record of drafts; and
 *   · the closer's `closing_hud_final` / `closing_pkg_signed` conditions — those are
 *     specific documents a person must review and sign off.
 * Nothing here ever clears a condition. A settlement statement that arrives on the
 * chain still has to be filed and reviewed by a human like any other document; this
 * only guarantees that it CANNOT be lost, and that the file shows it arrived.
 *
 * SharePoint mirrors it into `Closing/Correspondence` (sharepoint-backup
 * categoryPathFor), so the same separation exists in the team's drive.
 *
 * Integrity + retry-safety are the same contract as the Orders desk's returned
 * documents: bytes decode through the `decodeUploadBase64` chokepoint (never a bare
 * Buffer.from — a data:-prefixed payload would be silently garbled), the sha256 is
 * stored for the SharePoint integrity audit, a magic-byte sniff flags a file whose
 * bytes don't match its name, and each save dedupes so a webhook redelivery can
 * never double-file. Best-effort by contract: a hiccup here NEVER fails the webhook.
 */
'use strict';

const db = require('../db');
const storage = require('./storage');
const notify = require('./notify');
const { decodeUploadBase64, sniffKind, expectedKind } = require('./upload-bytes');

const DOC_KIND = 'closing_correspondence';
// A closing chain genuinely carries big multi-document sends (a full draft package),
// so this is higher than the Orders desk's 20 — but still bounded.
const MAX_DOCS_PER_EMAIL = 30;

/**
 * IS THIS EXACT DOCUMENT ALREADY ON THIS FILE'S CLOSING CORRESPONDENCE?
 *
 * Identity is the CONTENT — the sha256 this module has always computed and stored
 * for the SharePoint integrity audit, but never once queried. That omission is what
 * forced the caller's always-write marker: `doc-dedup.recentDuplicateDocId` only
 * looks back 120 SECONDS, so a webhook redelivery arriving minutes later (Resend
 * retries up to 8 times, with backoff) sailed past it and re-filed the whole
 * package. With no safe retry available, the caller had to mark the chain handled
 * even when a storage or DB blip had just lost documents — trading a duplicate risk
 * for a silent-loss risk.
 *
 * A content hash has no window, so a retry is idempotent HOWEVER much later it
 * arrives. That is the whole point: it lets the caller withhold the marker on a
 * TRANSIENT failure and actually recover, without the duplicates that made
 * withholding it wrong before.
 *
 * Keyed on (file, kind, bytes, name) and only against a CURRENT row, so a document
 * a human deliberately superseded can still be re-filed when counsel resends it.
 * The same bytes under a genuinely different filename file normally — on a closing
 * record the name is part of what arrived.
 */
async function alreadyFiled({ applicationId, sha256, filename }) {
  if (!sha256 || !applicationId) return null;
  const r = await db.query(
    `SELECT id FROM documents
      WHERE sha256 = $1 AND application_id = $2
        AND COALESCE(doc_kind,'') = $3 AND filename = $4
        AND is_current = true
      -- id breaks the tie so a capped read is deterministic.
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [sha256, applicationId, DOC_KIND, String(filename).slice(0, 300)]);
  return r.rows[0] ? r.rows[0].id : null;
}

/**
 * Persist the documents that arrived on a closing chain.
 *
 * The two failure counts are NOT cosmetic — the caller decides whether a webhook
 * redelivery may retry from them, so collapsing them (as this did) is what made a
 * recoverable blip indistinguishable from an unrecoverable one:
 *   · failedPermanent — retrying produces the identical result (bytes that will not
 *     decode, an empty attachment, a file we cannot look up because it is gone).
 *     Holding the delivery open for these buys nothing and blocks the marker forever.
 *   · failedTransient — storage or the database threw. Retrying can genuinely
 *     succeed, so the caller must NOT mark the chain handled.
 * `failed` stays the total, so existing wording that reports "N did not save" is
 * unchanged.
 *
 * @param p {applicationId, attachments:[{filename,contentType,content(base64)}], fromEmail, subject}
 * @returns {Promise<{saved:number, deduped:number, failed:number, failedPermanent:number, failedTransient:number, suspect:number, names:string[]}>}
 */
async function saveChainDocs({ applicationId, attachments, fromEmail, subject } = {}) {
  const empty = { saved: 0, deduped: 0, failed: 0, failedPermanent: 0, failedTransient: 0, suspect: 0, names: [] };
  const list = (Array.isArray(attachments) ? attachments : [])
    .filter((a) => a && a.filename && a.content)
    .slice(0, MAX_DOCS_PER_EMAIL);
  if (!list.length) return { ...empty };

  let borrowerId = null;
  try {
    const a = await db.query(`SELECT borrower_id FROM applications WHERE id=$1 AND deleted_at IS NULL`, [applicationId]);
    // The file is gone or archived. PERMANENT — no redelivery will bring it back, and
    // holding the chain open for it would block the marker for good.
    if (!a.rows[0]) return { ...empty, failed: list.length, failedPermanent: list.length };
    borrowerId = a.rows[0].borrower_id;
  } catch (_) {
    // The lookup itself threw: the database, not the data. Retryable.
    return { ...empty, failed: list.length, failedTransient: list.length };
  }

  let saved = 0;
  let deduped = 0;
  let failedPermanent = 0;
  let failedTransient = 0;
  let suspect = 0;
  const names = [];
  for (const a of list) {
    try {
      let buf, sha256;
      try { ({ buf, sha256 } = decodeUploadBase64(String(a.content))); }
      // Undecodable bytes are not a transient failure — retrying cannot fix them —
      // but they are still a document the attorney believes we received, so they are
      // COUNTED. Silently returning "0 problems" is how six PDFs became four.
      catch (_) { failedPermanent += 1; console.error('[closing-inbox] undecodable attachment', String(a.filename || '')); continue; }
      if (!buf.length) { failedPermanent += 1; continue; }
      const want = expectedKind(a.filename, a.contentType);
      const got = sniffKind(buf);
      if (want && got && got !== want) suspect += 1;
      // IDEMPOTENT FOREVER, not for 120 seconds — see alreadyFiled. This is what lets
      // the caller retry a delivery that half-failed instead of writing the chain off.
      // A lookup failure here is the DATABASE, so it is transient: filing anyway could
      // duplicate, and the retry will re-check cleanly.
      let dupId = null;
      try { dupId = await alreadyFiled({ applicationId, sha256, filename: a.filename }); }
      catch (e) {
        failedTransient += 1;
        console.error('[closing-inbox] could not check for a duplicate closing attachment:', (e && e.message) || e);
        continue;
      }
      // A duplicate is already on the file — success, but NOT a new document. Counting
      // it as `saved` overstated what arrived and fed a wrong number into the chain's
      // docs_count and the team's "N closing documents arrived" notice.
      if (dupId) { deduped += 1; names.push(String(a.filename)); continue; }
      const { ref, provider } = await storage.save(buf, { filename: a.filename });
      await db.query(
        `INSERT INTO documents
           (application_id, borrower_id, checklist_item_id, filename, content_type, size_bytes,
            storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, doc_kind,
            review_status, sha256, source_type, visibility)
         VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,'staff',NULL,$8,'pending',$9,'system','staff_only')`,
        [applicationId, borrowerId, String(a.filename).slice(0, 300),
         a.contentType || 'application/octet-stream', buf.length, provider, ref, DOC_KIND, sha256 || null]);
      saved += 1;
      names.push(String(a.filename));
    } catch (e) {
      // A storage or DB failure IS transient and IS recoverable — but only if
      // somebody knows, AND only if the caller is allowed to try again. Swallowed and
      // uncounted, the caller marked the whole chain handled and the webhook
      // redelivery skipped it, so the documents were gone with no log line and no
      // sign on the file. Counted separately from the permanent causes above so the
      // caller can tell "try again" from "asking counsel to resend is the only fix".
      failedTransient += 1;
      console.error('[closing-inbox] could not file a closing-chain attachment:', (e && e.message) || e);
    }
  }
  const failed = failedPermanent + failedTransient;

  if (saved) {
    try { require('./sharepoint-backup').kick(); } catch (_) { /* best-effort */ }
    // Move the order to 'documents_in', exactly as the Orders desk does when a title
    // or insurance vendor returns something (order-inbox.js). Only from an ACTIVE
    // state, so this can never revive a cancelled order. Without it the attorney
    // order sat on 'ordered' for the life of the file and the desk's own
    // 'documents_in' label was unreachable, however much came back on the chain.
    try {
      await db.query(
        `UPDATE file_orders SET status='documents_in', updated_at=now()
          WHERE application_id=$1 AND order_type='attorney' AND status IN ('ordered','documents_in')`,
        [applicationId]);
    } catch (_) { /* best-effort — the documents are filed either way */ }
    // IN-APP ONLY. The chain email itself already forwards to every assignee through
    // the normal inbound path, so emailing again about the same message would be the
    // "bombardment" the standing notification rule forbids.
    try {
      const ctx = await notify.fileContext(applicationId).catch(() => null);
      await notify.notifyAppStaff(applicationId, {
        type: 'closing_docs_in',
        title: `${saved} closing document${saved === 1 ? '' : 's'} arrived`,
        body: `${saved} document${saved === 1 ? '' : 's'}${fromEmail ? ` from ${fromEmail}` : ''} came in on the closing email chain`
          + `${ctx ? ` for ${ctx.addr}` : ''}${subject ? ` ("${String(subject).slice(0, 120)}")` : ''}`
          + `${suspect ? ` — ${suspect} may be unreadable, check before relying on it` : ''}. `
          + `They are saved in the file's Closing correspondence.`,
        applicationId,
        subjectTag: ctx ? ctx.subjectTag : '',
        link: `/internal/app/${applicationId}#sec-orders`,
        ctaLabel: 'Open the closing chain',
        inAppOnly: true,
      });
    } catch (_) { /* best-effort */ }
  }
  return { saved, deduped, failed, failedPermanent, failedTransient, suspect, names };
}

/** The file's closing-correspondence package, newest first. */
async function listChainDocs(applicationId, { limit = 100 } = {}) {
  try {
    const r = await db.query(
      `SELECT id, filename, content_type, size_bytes, created_at, review_status, sha256
         FROM documents
        WHERE application_id=$1 AND doc_kind=$2 AND is_current = true
        -- id breaks a created_at tie: a capped list must be deterministic or the
        -- same document can appear on one page load and vanish on the next.
        ORDER BY created_at DESC, id DESC LIMIT $3`,
      [applicationId, DOC_KIND, Math.min(500, Math.max(1, Number(limit) || 100))]);
    return r.rows;
  } catch (_) { return []; }
}

module.exports = { saveChainDocs, listChainDocs, alreadyFiled, DOC_KIND, MAX_DOCS_PER_EMAIL };
