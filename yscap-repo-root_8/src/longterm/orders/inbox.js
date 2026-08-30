'use strict';
/**
 * LONG-TERM — A VENDOR'S REPLY, AND THE DOCUMENTS THAT COME WITH IT.
 *
 * Every long-term order carries a Reply-To of its own —
 * `ltorder+<kind>.<loanId>@<domain>` — so the title company's answer and the binder
 * the insurance agent sends back land on the ORDER that asked for them rather than
 * in a general inbox. This is the half that reads one.
 *
 * ── IT CLAIMS ONLY ITS OWN ADDRESSES ────────────────────────────────────────
 *
 * There is ONE inbound domain and therefore ONE webhook, shared with the short-term
 * inbox. `processReceivedEvent` answers `{claimed:false}` for anything that is not a
 * long-term order address, and the route then hands the delivery straight on to the
 * short-term reader untouched. The two address families are provably exclusive
 * (`lib/file-address.js` is the registry, and `scripts/test-shared-order-letter-pure.js`
 * asserts neither can parse the other's), so this can never swallow a short-term
 * reply — which would be silent, and would lose a title company's documents.
 *
 * ── NOTHING IS EVER SILENTLY DROPPED ────────────────────────────────────────
 *
 * Every attachment either becomes a document on a condition or appears in `skipped`
 * WITH A REASON, on the thread, where a person reads it. The two reasons are kept
 * apart because they are opposite instructions: a CAP (deterministic — the same
 * delivery yields the same first N forever) means somebody must ask the vendor to
 * send the rest; an ERROR (our network blinked) is transient and retrying is the
 * answer. Telling a team to chase a title company because our own fetch failed is
 * both noise and, once the retry lands, untrue.
 *
 * ── A WRONG SLOT IS WORSE THAN NO SLOT ──────────────────────────────────────
 *
 * A returned document is placed into a named slot only when its own filename says
 * which one; otherwise it is filed on the condition with NO slot. A binder filed as
 * an invoice reads as an invoice that has arrived, and a condition whose slots are
 * all full reads as satisfied — so a guess can clear a condition nobody has met,
 * while an unplaced document merely leaves a person to place it.
 *
 * ── AND NOTHING UN-REVIEWED IS FULFILMENT ───────────────────────────────────
 *
 * Everything files as `pending`. A vendor's own document is not a reviewed document,
 * and the condition centre's sign-off gate refuses to clear a condition over one.
 *
 * SEPARATION: writes `lt_*` only.
 */

const db = require('../db');
const storage = require('../../lib/storage');
const inboundMail = require('../../lib/inbound-mail');
const { ltOrderRefFromRecipient } = require('../../lib/file-address');
const { classifyReturnAttachment } = require('../../lib/order-return-filter');
const upload = require('../../lib/upload-bytes');
const replyCut = require('../../lib/email/reply-cut');
const kinds = require('./kinds');
const desk = require('./desk');

/** How many documents one delivery may file. Matches the retrieval bound the shared
    reader applies, so everything retrieved is filed and anything beyond it is
    REPORTED rather than truncated by a lower ceiling nobody can see. */
const MAX_RETURN_DOCS = 60;

/* WHY a picture was not filed, in words. The classifier answers with a REASON and
   the four are genuinely different things to say to a person: a company logo
   embedded in the signature, a vector icon, a picture too small to be a page of
   anything, and a wide strip. Naming which one is what stops somebody assuming the
   system ate their document. */
const NOT_A_DOCUMENT = Object.freeze({
  vector_image: 'That is a logo or an icon, not a document.',
  embedded_image: 'That picture is embedded in the email itself — an email-signature image rather than an attached document.',
  tiny_image: 'That picture is too small to be a page of anything.',
  banner_image: 'That picture is a wide strip — a banner or a signature line, not a page.',
  signature_image: 'That looks like an email-signature image rather than a document.',
});

/**
 * Which long-term orders a delivery is addressed to.
 *
 * A vendor replying-all can name more than one; each is handled on its own, and one
 * failing must never stop the others.
 */
function ordersFromEvent(eventData) {
  const recips = inboundMail.recipientsFromEvent(eventData);
  const out = [];
  const seen = new Set();
  for (const r of recips) {
    const ref = ltOrderRefFromRecipient(r);
    if (!ref) continue;
    const key = `${ref.loanId}:${ref.orderKind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/** The order row for a ref, or null. The KIND is checked against the registry first:
    an address naming a kind we do not have is not an order, however well-formed. */
async function resolveOrder(ref, client = db) {
  if (!kinds.orderKind(ref.orderKind)) return null;
  return desk.findOrder(ref.loanId, ref.orderKind, client);
}

/** The condition a returned document is filed on, and its slots. */
async function docConditionFor(loanId, kind, client = db) {
  const def = kinds.orderKind(kind);
  if (!def || !def.docCondition) return null;
  const { rows } = await client.query(
    `SELECT id, code, slots FROM lt_file_conditions
      WHERE loan_id = $1::uuid AND code = $2 ORDER BY created_at LIMIT 1`,
    [String(loanId), def.docCondition]);
  return rows[0] || null;
}

/**
 * File one attachment onto a condition.
 *
 * NEVER THROWS: a document that cannot be filed is returned as a skip with its
 * reason, so the caller can put it on the thread rather than lose it.
 */
async function fileAttachment({ loanId, order, condition, att, eventId }, client = db) {
  const filename = String((att && att.filename) || 'attachment');
  try {
    const buf = upload.decodeUploadBase64(att.content);
    if (!buf || !buf.length) return { skipped: { filename, reason: 'empty', why: 'The file came through empty.' } };

    // AN EMAIL-SIGNATURE LOGO IS NOT A RETURNED DOCUMENT. The short-term desk spent
    // months having these rejected by hand on every file; this is the SAME
    // classifier, so the long-term desk never re-lives it.
    const verdict = classifyReturnAttachment({
      filename,
      contentType: att.contentType,
      buf,
      contentDisposition: att.contentDisposition,
      contentId: att.contentId,
    });
    if (verdict && verdict.file === false) {
      return { skipped: { filename, reason: verdict.reason || 'signature_image', why: NOT_A_DOCUMENT[verdict.reason] || 'This looks like part of the email rather than a document somebody attached.' } };
    }

    const sha = upload.sha256hex(buf);

    // ALREADY HERE? A webhook redelivery is deduped by `inbound_id` above, but a
    // vendor genuinely re-sending the same bytes under the same name on a later
    // reply is a different event and must not double-file either.
    const dup = await client.query(
      `SELECT id FROM lt_condition_files
        WHERE loan_id = $1::uuid AND sha256 = $2 AND is_current LIMIT 1`,
      [String(loanId), sha]);
    if (dup.rows.length) {
      return { skipped: { filename, reason: 'already_filed', why: 'The same document is already on this file.' } };
    }

    const saved = await storage.save(buf, { filename });
    const slot = kinds.slotForFilename(order.kind, filename);
    const { rows } = await client.query(
      `INSERT INTO lt_condition_files
         (condition_id, loan_id, slot_key, filename, content_type, byte_size, sha256,
          storage_ref, uploaded_by_kind, review_status, order_id, order_event_id)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,'vendor','pending',$9::uuid,$10::uuid)
       RETURNING id`,
      [condition.id, String(loanId), slot, filename, att.contentType || null,
        buf.length, sha, saved.ref, order.id, eventId || null]);
    return { filed: { id: rows[0].id, filename, slot: slot || null, bytes: buf.length } };
  } catch (e) {
    // TRANSIENT by construction — a storage or database failure, not a fact about
    // the document — so it is reported as an error rather than as a cap, and the
    // team is never told to chase the vendor for something our own side dropped.
    return { skipped: { filename, reason: 'error', why: String((e && e.message) || e).slice(0, 160) } };
  }
}

/**
 * Handle one long-term order address on one delivery.
 *
 * @returns {{status:string, retryable?:boolean, filed?:number, skipped?:number}}
 */
async function handleOne(ref, event, full) {
  const order = await resolveOrder(ref);
  if (!order) return { status: 'unknown_order' };

  const emailId = (event && event.data && (event.data.email_id || event.data.id)) || null;
  const fromEmail = inboundMail.extractAddress(full && full.from);
  const subject = String((full && full.subject) || '');
  const auth = inboundMail.senderAuth(full);

  // AN AUTO-RESPONDER IS RECORDED, NEVER ACTED ON. An out-of-office would otherwise
  // move an order to "documents in" and stop anybody chasing it.
  if (inboundMail.isAutoGenerated(full)) {
    await desk.recordEvent(db, order, {
      direction: 'inbound', msgType: 'auto_reply', subject, fromEmail,
      to: inboundMail.recipientsFromEvent(event && event.data), text: null,
      inboundId: emailId, senderAuth: auth, status: 'auto_reply',
    }).catch(() => {});
    return { status: 'auto_reply' };
  }

  // The vendor's own words, cut at the quoted history — the SAME cut the short-term
  // side uses, which is why the letter prints that exact marker at the top.
  const bodyRaw = String((full && (full.text || full.html_text || '')) || '');
  const body = replyCut.topReply(bodyRaw);

  const metaList = (full && full.attachments) || [];
  let atts = [];
  if (metaList.length) {
    atts = await inboundMail.retrieveAttachmentsSafe(emailId, metaList).catch(() => []);
  }

  const condition = await docConditionFor(ref.loanId, ref.orderKind).catch(() => null);
  const filed = [];
  const skipped = [];

  // Anything the retrieval itself could not bring back, kept apart by WHY.
  const capDropped = Number(atts.droppedByCap || 0);
  const errDropped = Number(atts.droppedByError || 0);
  if (capDropped) skipped.push({ filename: null, reason: 'cap', why: `${capDropped} attachment(s) were too many or too large to bring back. Ask them to send those again on their own.` });
  if (errDropped) skipped.push({ filename: null, reason: 'error', why: `${errDropped} attachment(s) failed to download. PILOT will try again on the next delivery — nobody needs to chase the vendor.` });

  let eventId = null;
  try {
    eventId = await desk.recordEvent(db, order, {
      direction: 'inbound', msgType: 'return', subject, fromEmail,
      to: inboundMail.recipientsFromEvent(event && event.data), text: body,
      inboundId: emailId, senderAuth: auth, status: 'received',
      attachments: atts.slice(0, MAX_RETURN_DOCS).map((a) => ({ filename: a.filename, contentType: a.contentType })),
    });
  } catch (e) {
    // The message could not be recorded at all — RETRYABLE, so the provider
    // redelivers and the unique index makes the second attempt idempotent.
    return { status: 'record_failed', retryable: true };
  }
  // `recordEvent` uses ON CONFLICT DO NOTHING on the inbound id, so a null id here
  // means this delivery has already been handled. Filing again would duplicate every
  // document on it.
  if (!eventId) return { status: 'duplicate' };

  if (condition) {
    for (const a of atts.slice(0, MAX_RETURN_DOCS)) {
      const r = await fileAttachment({ loanId: ref.loanId, order, condition, att: a, eventId });
      if (r.filed) filed.push(r.filed);
      else if (r.skipped) skipped.push(r.skipped);
    }
  } else if (atts.length) {
    skipped.push({
      filename: null, reason: 'no_condition',
      why: 'There is no condition on this loan for these documents yet, so they are on the thread but not filed. Add the condition and they can be placed.',
    });
  }

  try {
    await db.query(
      `UPDATE lt_order_events SET attachments = $2::jsonb, skipped = $3::jsonb WHERE id = $1::uuid`,
      [eventId, JSON.stringify(filed), JSON.stringify(skipped)]);
    if (filed.length) {
      await db.query(
        `UPDATE lt_file_orders SET status = 'documents_in', updated_at = now()
          WHERE id = $1::uuid AND status IN ('ordered', 'not_ordered')`, [order.id]);
    }
  } catch (_) { /* the documents are filed and the message is on the thread */ }

  return { status: 'filed', filed: filed.length, skipped: skipped.length };
}

/**
 * THE WEBHOOK'S QUESTION: is this delivery ours, and if so, deal with it.
 *
 * @returns {{claimed:boolean, status?:string, retryable?:boolean, results?:Array}}
 *          `claimed:false` means "not a long-term order" — the caller passes the
 *          delivery on to the short-term reader UNTOUCHED.
 * NEVER THROWS.
 */
async function processReceivedEvent(event) {
  let refs = [];
  try { refs = ordersFromEvent(event && event.data); }
  catch (_) { refs = []; }
  if (!refs.length) return { claimed: false };

  const emailId = (event && event.data && (event.data.email_id || event.data.id)) || null;
  if (!emailId) return { claimed: true, status: 'no_email_id' };

  let full;
  try { full = await inboundMail.retrieveInboundEmail(emailId); }
  catch (e) {
    // The provider is down or the key is wrong — RETRYABLE. A reply that carries a
    // title commitment must never be dropped because a retrieval blinked.
    return { claimed: true, status: 'retrieval_failed', retryable: true };
  }

  const results = [];
  let retryable = false;
  for (const ref of refs) {
    try {
      const r = await handleOne(ref, event, full);
      results.push({ ...ref, ...r });
      if (r.retryable) retryable = true;
    } catch (e) {
      results.push({ ...ref, status: 'error', why: String((e && e.message) || e).slice(0, 160) });
      retryable = true;
    }
  }
  return { claimed: true, status: results.map((r) => r.status).join(','), results, retryable };
}

module.exports = {
  processReceivedEvent, ordersFromEvent, handleOne, fileAttachment, docConditionFor,
  resolveOrder, MAX_RETURN_DOCS,
};
