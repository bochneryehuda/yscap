'use strict';

/**
 * THE CONDITION-DOCUMENT UPLOAD, ONE DEFINITION, BOTH PRODUCTS.
 *
 * Lifted VERBATIM out of `src/routes/staff.js`'s `uploadAppDocument` — the same
 * extraction pattern the repo already blessed for `inbound-mail.js`: the module
 * moves, the original file calls it, and the behaviour is byte-identical. The
 * owner ordered it (2026-08-30, docs/longterm/SHARE-THE-CODE-DIRECTIVE.md):
 * *"if I'm updating something in the logic of the Condition Center (the way you
 * preview stuff … drag and drop, accept, reject, preview, download, and delete),
 * it should update them both places. You need to share the code."* — and, in the
 * same breath, *"watch what you're doing not to break the other side of the
 * business, the short-term side."*
 *
 * WHAT LIVES HERE — the rules that are about DOCUMENTS, not about a product:
 *   • the intake contract and the one filename sanitiser;
 *   • which condition the upload lands in, and what that condition makes it
 *     (its label, its audience, its track-record line, its template code);
 *   • the VISIBILITY rule — a request may only ever RESTRICT;
 *   • `takeUpload`, so the JSON door and the STREAMING door are the same code;
 *   • the `doc_kind` rules (term sheet, Heter Iska, signed wire form);
 *   • the unique slot label, and the 120-second de-duplication;
 *   • the INSERT — through `ownerCols`, so a Long-Term document lands with
 *     `lt_loan_id` and an RTL one with `application_id`, from ONE statement;
 *   • the supersede rules (one-current kinds, and an explicit replace);
 *   • the evidence re-open that drops a sign-off the new bytes invalidate.
 *
 * WHAT DOES NOT — anything a product does ABOUT an upload. The ClickUp push and
 * the borrower notification are HOOKS (`hooks-rtl.js`), defaulted to the RTL set
 * only for `scope='application'`. The appraisal auto-import, the research XML
 * catch, the AI classifier, the SharePoint kick and the pipeline shadow enqueue
 * stay at the RTL door: each needs the request itself, shapes the RTL response,
 * or writes RTL's own audit trail, and each is already inert for any other owner
 * — moving them would have changed RTL's ORDER of work for no sharing gain.
 *
 * REFUSALS THROW WITH `err.status`, the same convention `upload-stream` already
 * uses, so a route answers the real reason rather than a generic 500 — the
 * owner's *"if Pilot is giving an error and he can't upload something, he should
 * tell exactly what the error is"*.
 */

const { ownerWhere, ownerCols } = require('../condition-owner');
const { safeFilename } = require('../upload-bytes');
const storage = require('../storage');
const { defaultHooks } = require('./hooks-rtl');

function refuse(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/**
 * The intake contract, checked BEFORE anything is looked up or stored, and the
 * one filename sanitisation (S4-10: sanitize + length-cap before it hits the DB
 * or an email). Mutates `b.filename` in place, exactly as the door always did.
 */
function assertUploadIntake(b) {
  if (!b || !b.filename || !b.dataBase64) throw refuse('filename + dataBase64 required', 400);
  b.filename = safeFilename(b.filename);
  return b;
}

/**
 * Which condition this upload is landing in, and what that condition makes of
 * it. An entity-slot item has no file owner at all (`application_id` /
 * `lt_loan_id` NULL, `llc_id` set), so it is looked up by the entity instead —
 * an entity document follows the entity to every file it vests.
 */
async function loadChecklistItem(q, { owner, checklistItemId, llcId }) {
  const empty = { label: '', audience: null, trackRecordId: null, code: null };
  if (!checklistItemId) return empty;
  const cols = `id, COALESCE(borrower_label,label) AS label, audience, track_record_id,
                (SELECT code FROM checklist_templates ct WHERE ct.id=checklist_items.template_id) AS template_code`;
  const it = llcId
    ? await q.query(`SELECT ${cols} FROM checklist_items WHERE id=$1 AND llc_id=$2`, [checklistItemId, llcId])
    : await (async () => {
      const w = ownerWhere(owner, null, 2);
      return q.query(`SELECT ${cols} FROM checklist_items WHERE id=$1 AND ${w.sql}`, [checklistItemId, ...w.params]);
    })();
  if (!it.rows[0]) throw refuse('checklist item not found on this file', 404);
  return {
    label: it.rows[0].label,
    audience: it.rows[0].audience,
    // A condition raised FOR one track-record line item: the upload belongs to
    // that line too (same contract as the borrower path).
    trackRecordId: it.rows[0].track_record_id || null,
    code: it.rows[0].template_code || null,
  };
}

/**
 * WHAT KIND OF DOCUMENT THESE BYTES ARE — and only these three are ever decided
 * here, because only these three change what the rest of the system may do with
 * the file.
 *
 * A manual upload onto the Heter Iska condition gets an explicit doc_kind so it is
 * provenance-distinguishable from the DocuSign-fed executed copy (heter_iska_signed +
 * source_type system) AND is kept in-system only — heter_iska_manual is on the
 * SharePoint never-mirror list, the TPR-export denylist and closing-prep's FROZEN_KINDS,
 * exactly like heter_iska_signed (owner policy: the Heter Iska never leaves the building).
 * A client can never forge heter_iska_signed here (only term_sheet is client-settable).
 * A wire form uploaded onto the draw condition (draw_cond_signed_request) — whether from
 * the draw desk's own manual-upload route or straight from the conditions list — gets
 * doc_kind='draw_request_signed' so it's picked up by the money gate AND the investor-delivery
 * attachment exactly like a DocuSign-fed copy (owner-directed 2026-08). A manual copy is told
 * apart from a DocuSign one only by source_type (this door → not 'system'). Unlike the Heter
 * Iska, the wire form DOES leave the building (it goes to the investor), so it is on no denylist.
 */
function docKindFor(body, itemCode) {
  return body.docKind === 'term_sheet' ? 'term_sheet'
    : (itemCode === 'rtl_cond_iska' ? 'heter_iska_manual'
      : (itemCode === 'draw_cond_signed_request' ? 'draw_request_signed' : null));
}

/**
 * A ONE-CURRENT kind supersedes its siblings on the SAME owner. Owner-scoped in
 * the statement itself, so a Long-Term term sheet can never retire an RTL one.
 */
async function supersedeSiblings(q, { owner, docKind, keepDocumentId }) {
  const w = ownerWhere(owner, null, 1);
  await q.query(
    `UPDATE documents SET is_current=false,
        review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
      WHERE ${w.sql} AND doc_kind=$2 AND id<>$3 AND is_current=true`,
    [...w.params, docKind, keepDocumentId]);
}

/**
 * EVERY document slot keeps EVERY document (owner-directed): a plain ADD never
 * deletes what's already there. Only an EXPLICIT replace (the user clicked
 * "Replace" on one document, sending replaceDocumentId) supersedes — and it
 * supersedes ONLY that one document, never its siblings or the whole slot.
 *
 * This fixes the "upload a 2nd document and the 1st disappears" bug at its
 * root: the old blanket supersede matched every current document on the
 * condition whenever the slot label was null or collided (a free-form add) and
 * matched the same-labelled document on a fixed slot (appraisal xml/pdf,
 * insurance binder/invoice), so a second upload wiped the first. Now a fixed
 * slot accumulates just like a free-form one, and nothing is ever lost on add.
 */
async function supersedeOne(q, { documentId, checklistItemId }) {
  await q.query(
    `UPDATE documents SET is_current=false,
        review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
      WHERE id=$1 AND checklist_item_id=$2`,
    [documentId, checklistItemId]);
}

/**
 * THE DOOR. `req` is needed only so `takeUpload` can see a body that was already
 * streamed to storage by `binaryIntake`; everything else arrives in `opts`.
 *
 * Resolves either
 *   { deduped: true,  documentId, visibility }                       — a repeat POST
 * or
 *   { deduped: false, documentId, visibility, up, uploadBytes,
 *     docKind, slot, item }                                          — a new row
 * and the caller decides what its product does next with that.
 */
async function uploadConditionDocument(req, opts) {
  const {
    owner, body, actorId, actorKind = 'staff', borrowerId = null, llcId = null, q = require('../../db'),
  } = opts || {};
  const b = body || {};
  const hooks = (opts && opts.hooks) || defaultHooks(owner);

  const item = await loadChecklistItem(q, { owner, checklistItemId: b.checklistItemId, llcId });

  // Internal (staff-audience) conditions like Insurance / Title never leak to the
  // borrower: store the document staff-only and skip the borrower notification.
  // A caller may ask for STAFF-ONLY explicitly — never for borrower-visible. This
  // is how a document with no staff-audience condition to hang on (the purchase
  // advice, which names the note buyer and the sale price) can be uploaded
  // without being borrower-visible for the window before it is designated. The
  // request can only ever RESTRICT, so no caller can widen a document's reach.
  const staffOnly = item.audience === 'staff' || b.staffOnly === true;
  const visibility = staffOnly ? 'staff_only' : 'borrower';

  /* THE BYTES, WHICHEVER DOOR THEY CAME THROUGH (owner-directed 2026-08-21).
     A JSON body is decoded strictly and stored here; a STREAMED upload is already in
     storage and `takeUpload` simply reports where — so this handler, its authorization,
     its condition lookups and its visibility rules are the SAME code on both doors.
     Any refusal carries its real reason and its real status. */
  const up = await require('../upload-stream').takeUpload(req, b);
  const uploadBytes = up.bytes;

  const docKind = docKindFor(b, item.code);
  // WHICH STAMP these bytes print (owner-directed 2026-08-02, db/404). The
  // INITIAL/FINAL wording is drawn into the PDF at generation time, so the
  // generator is the only thing that knows — it reports what it printed and we
  // record it. This is a description of the file, never an authorization: the
  // send gate still decides whether a package may go out, and orchestrate.js
  // reads this only to refuse mailing a sheet whose own face says "NOT FINAL".
  const termSheetFinal = docKind === 'term_sheet' ? (b.termSheetFinal === true) : null;

  let slot = b.slot ? String(b.slot).trim().slice(0, 80) : null;
  // Every slot keeps every document. On a plain ADD (not an explicit replace),
  // if the slot label collides with a document already on the item, make it
  // unique so the two never display under one identical label — a fixed slot
  // becomes "Insurance binder (2)", a free-form add "Document 3", etc.
  if (slot && b.checklistItemId && !b.replaceDocumentId) {
    slot = await require('../slot-label').uniqueSlotLabel(b.checklistItemId, slot);
  }

  /* THE OWNER COLUMNS. An ENTITY-slot upload belongs to the borrower's company,
     not to a file — both file-owner columns stay NULL and `llc_id` carries it, the
     shape a borrower upload has always produced. Otherwise `ownerCols` sets exactly
     one, so `chk_one_owner` is satisfied by construction and the SAME statement
     files an RTL document and a Long-Term one. */
  const cols = llcId ? { application_id: null, lt_loan_id: null } : ownerCols(owner);

  const dup = await require('../doc-dedup').recentDuplicateDocId({   // idempotency (#87)
    filename: b.filename, sizeBytes: uploadBytes, uploadedByKind: actorKind, uploadedById: actorId,
    applicationId: cols.application_id, ltLoanId: cols.lt_loan_id, checklistItemId: b.checklistItemId || null,
    llcId: llcId || null, trackRecordId: item.trackRecordId, slotLabel: slot, docKind, termSheetFinal }, { client: q });
  if (dup) {
    /* The bytes are ALREADY in storage on both doors now (the streaming one cannot know
       about a duplicate until they have landed), so a de-duplicated upload would leave an
       object nothing points at. Remove it — best-effort, because an orphan blob is waste,
       never a correctness problem, and must not turn a successful de-dupe into an error. */
    try { await storage.remove(up.ref); } catch (_) { /* orphan cleanup is best-effort */ }
    return { deduped: true, documentId: dup, visibility };
  }

  const { ref, provider } = up;
  const r = await q.query(
    // A `term_sheet` here is PILOT'S OWN generated PDF, captured from the Term
    // Sheet Studio at registration (that is the ONLY thing that sets this kind
    // at this door — a human uploading a document never passes docKind). So it
    // is born ACCEPTED: nobody reviews a sheet the system just drew, and left
    // pending the acceptance rule would drop it from the TPR export's Term Sheet
    // folder AND make `closing-prep.blockers` refuse every order on the file for
    // want of a term sheet. Every other upload through this door stays pending
    // and waits for a reviewer. Owner-directed 2026-08-03; see
    // lib/document-acceptance.js.
    `INSERT INTO documents (application_id,lt_loan_id,checklist_item_id,borrower_id,llc_id,track_record_id,filename,content_type,size_bytes,storage_provider,storage_ref,
                            uploaded_by_kind,uploaded_by_id,doc_kind,slot_label,visibility,term_sheet_final,
                            review_status,reviewed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
             CASE WHEN $14='term_sheet' THEN 'accepted' ELSE 'pending' END,
             CASE WHEN $14='term_sheet' THEN now() ELSE NULL END) RETURNING id`,
    [cols.application_id, cols.lt_loan_id, b.checklistItemId || null,
     (b.checklistItemId || llcId) ? borrowerId : null, llcId, item.trackRecordId,
     b.filename, b.contentType || 'application/octet-stream', uploadBytes, provider, ref,
     actorKind, actorId, docKind, slot, visibility, termSheetFinal]);
  const documentId = r.rows[0].id;

  if (item.trackRecordId) {
    await q.query(
      `UPDATE track_records SET docs_status='received', updated_at=now()
        WHERE id=$1 AND docs_status IN ('outstanding','requested')`, [item.trackRecordId]);
  }
  if (docKind === 'term_sheet') {
    await supersedeSiblings(q, { owner, docKind: 'term_sheet', keepDocumentId: documentId });
  }
  // A wire form is a ONE-CURRENT document like the term sheet: a wire form uploaded onto the
  // draw condition supersedes any OTHER current draw_request_signed so the money gate and the
  // investor-delivery attachment see EXACTLY ONE (mirrors the draw-desk manual route and the
  // DocuSign completion). Without this, a corrected wire form uploaded from the conditions list
  // after a prior accept would leave two current copies — the gate green off the old accepted
  // one while delivery attached the new unaccepted one. A superseded ACCEPTED copy drops off the
  // gate (is_current=false), forcing the new form to be re-accepted before any wire can move.
  if (docKind === 'draw_request_signed') {
    await supersedeSiblings(q, { owner, docKind: 'draw_request_signed', keepDocumentId: documentId });
  }

  if (b.checklistItemId) {
    if (b.replaceDocumentId) {
      await supersedeOne(q, { documentId: b.replaceDocumentId, checklistItemId: b.checklistItemId });
    }
    // A superseding upload replaces the reviewed evidence with a new UNREVIEWED
    // file, so a prior sign-off no longer matches what's on the item — drop it so
    // the new version is re-reviewed before the file can clear-to-close.
    await require('../checklist-evidence').reopenConditionEvidence(q, b.checklistItemId, 'received');
    if (hooks.conditionTouched) hooks.conditionTouched(b.checklistItemId);   // mapped conditions → ClickUp dropdown
    // The shared list works both ways — tell the borrower their team added it.
    // Staff-only (internal) conditions are never surfaced or emailed to them.
    if (borrowerId && !staffOnly && hooks.notifyUpload) {
      await hooks.notifyUpload({
        borrowerId, ownerId: owner.id, llcId, itemLabel: item.label, filename: b.filename, slot });
    }
  }

  return { deduped: false, documentId, visibility, up, uploadBytes, docKind, slot, item };
}

module.exports = {
  uploadConditionDocument, assertUploadIntake, loadChecklistItem, docKindFor,
  supersedeSiblings, supersedeOne,
};
