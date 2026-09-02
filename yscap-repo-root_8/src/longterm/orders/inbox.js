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
const { ownerOf, ownerWhere } = require('../../lib/condition-owner');
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
  /* THE SHARED CONDITION CENTER, not `lt_file_conditions`. db/653 moved the
     long-term conditions into the one `checklist_items` table and this read was
     left on the old one, which nothing has written since — so it found NOTHING,
     and a document a vendor sent back could never reach the condition that asked
     for it. That is the whole point of the per-order reply address, and it was
     silently doing nothing. The slots live on the TEMPLATE in the shared shape
     (`checklist_templates.slots`, seeded by the library). */
  const w = ownerWhere(ownerOf('lt_loan', loanId), 'c', 2);
  const { rows } = await client.query(
    `SELECT c.id, t.code, COALESCE(c.slots, t.slots) AS slots
       FROM checklist_items c
       JOIN checklist_templates t ON t.id = c.template_id
      WHERE t.code = $1 AND ${w.sql}
      ORDER BY c.created_at LIMIT 1`,
    [def.docCondition, ...w.params]);
  const cond = rows[0] || null;
  if (!cond) return null;
  /* WHICH OF ITS SLOTS APPLY ON THIS FILE. A slot carrying `notWhenField` /
     `whenField` is finer than the condition: New York's title package has no
     closing protection letter, no preliminary settlement statement and no wiring
     instructions, and the Condition Center screen already drops those slots on a
     New York file (`read.slotsFor`). A returned "CD.pdf" was still filed INTO the
     dropped slot — filed, invisible, counted by nothing (audit 2026-09-02, S5).
     The SAME filter, over the SAME live values, so the desk and the screen can
     never disagree about which slots a file has; an unreadable context keeps
     every slot, exactly as the screen does, because hiding on a guess is the
     expensive direction. */
  try {
    const read = require('../conditions-center/read');
    const live = await read._internals.liveFieldValues(loanId, client);
    const kept = read._internals.slotsFor({ slots: cond.slots, answer: null }, true, live);
    cond.applicableSlots = kept.map((x) => x.key);
  } catch (_) {
    cond.applicableSlots = null;
  }
  return cond;
}

/** The slot a returned document files into on THIS condition, or null. The
    filename's own answer (`kinds.slotForFilename`), refused when the slot does not
    apply on the file; `explicitSlot` is for a caller that already knows (the
    signed DocuSign form is the rent verification by construction, not by name). */
function slotOn(condition, kind, filename, explicitSlot) {
  const slot = explicitSlot !== undefined ? explicitSlot : kinds.slotForFilename(kind, filename);
  if (!slot) return null;
  const applicable = condition && Array.isArray(condition.applicableSlots) ? condition.applicableSlots : null;
  if (applicable && !applicable.includes(slot)) return null;
  return slot;
}

/**
 * File one attachment onto a condition.
 *
 * NEVER THROWS: a document that cannot be filed is returned as a skip with its
 * reason, so the caller can put it on the thread rather than lose it.
 */
async function fileAttachment({ loanId, order, condition, att, eventId, slot: explicitSlot }, client = db) {
  const filename = String((att && att.filename) || 'attachment');
  try {
    /* `decodeUploadBase64` answers `{ buf, sha256 }`, NOT a Buffer — and treating
       it as one silently drops the file: `.length` is undefined, the emptiness test
       fires, and every document a vendor ever returned reads as "the file came
       through empty". Node's own base64 decoder is lenient enough that nothing
       throws, so the failure is completely silent. Caught by the repo's own guard
       (scripts/test-upload-chokepoint-*), which is why that guard exists. The
       digest it already computed is reused rather than taken again over the same
       bytes. */
    const { buf, sha256: decodedSha } = upload.decodeUploadBase64(att.content);
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

    const sha = decodedSha || upload.sha256hex(buf);

    // ALREADY HERE? A webhook redelivery is deduped by `inbound_id` above, but a
    // vendor genuinely re-sending the same bytes under the same name on a later
    // reply is a different event and must not double-file either.
    const dup = await client.query(
      `SELECT id FROM documents
        WHERE lt_loan_id = $1::uuid AND sha256 = $2 AND is_current LIMIT 1`,
      [String(loanId), sha]);
    if (dup.rows.length) {
      return { skipped: { filename, reason: 'already_filed', why: 'The same document is already on this file.' } };
    }

    const saved = await storage.save(buf, { filename });
    const slot = slotOn(condition, order.kind, filename, explicitSlot);
    /* THE SHARED `documents` TABLE, not `lt_condition_files`. db/653 moved the
       long-term conditions into `checklist_items`, and `lt_condition_files`
       carries a FOREIGN KEY to the retired `lt_file_conditions` — so this insert
       could not succeed at all. Every returned document was reported as a SKIP
       with a foreign-key error as its reason, on every long-term order, which is
       the whole purpose of the per-order reply address doing nothing.

       The columns mirror the short-term vendor return (`lib/order-inbox.js`) so
       one shape files a returned document on both products:
         · `uploaded_by_kind = 'staff'` with a NULL id — the `documents` CHECK
           admits borrower|staff, and a vendor is neither; the short-term side
           already resolves that the same way, and `source_type = 'system'` is
           what actually records that nobody here typed it.
         · `visibility = 'staff_only'` — a title commitment is reviewed before
           anybody outside sees it, exactly as on the short-term side.
         · `review_status = 'pending'` — it is filed, not accepted; db/424's rule
           is that nothing un-accepted leaves the building.
         · the per-order slot travels in `slot_label`, which is the shared
           table's own per-slot key (the Condition Center reads it that way). */
    const { rows } = await client.query(
      `INSERT INTO documents
         (checklist_item_id, lt_loan_id, filename, content_type, size_bytes, sha256,
          storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id,
          slot_label, review_status, source_type, visibility)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,'staff',NULL,$9,'pending','system','staff_only')
       RETURNING id`,
      [condition.id, String(loanId), filename, att.contentType || null,
        buf.length, sha, saved.provider, saved.ref, slot || null]);
    // `storageRef` rides on the answer so a caller that keeps its own record of
    // the document (the rent desk's return row) never re-reads the shared table.
    return { filed: { id: rows[0].id, filename, slot: slot || null, bytes: buf.length, storageRef: saved.ref } };
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

  /* THE DOCUMENTS CONDITION MOVES OFF "OUTSTANDING". The order row went to
     'documents_in' and the condition the documents were filed onto stayed
     'outstanding' — a title commitment sitting on a condition that still read as
     if nobody had sent one (audit 2026-09-02, N4). The same helper the desk uses
     to mark a condition asked for: outstanding → received, and NOTHING further,
     because a vendor's own document is not a reviewed one — the sign-off gate is
     what clears it. Best-effort AFTER the filing, like the desk's own call. */
  if (filed.length) {
    const def = kinds.orderKind(ref.orderKind);
    await desk.markConditionAsked(ref.loanId, def && def.docCondition).catch(() => {});
  }

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
  processReceivedEvent, ordersFromEvent, handleOne, fileAttachment, docConditionFor, slotOn,
  resolveOrder, MAX_RETURN_DOCS,
};
