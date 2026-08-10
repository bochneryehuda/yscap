'use strict';
/**
 * DRAW WIRE — OPERATING-AGREEMENT SLOT + LLC-PROFILE LINK (owner-directed 2026-08-05).
 *
 * THE SITUATION. The borrower's DocuSign draw request carries their wire instructions. When the
 * account name is neither the borrower nor the subject/vesting LLC, draw-wire.js classifies it as a
 * NEW entity and raises the FATAL operating-agreement condition (draw_cond_operating_agreement):
 * the money is going to a company we have not vetted, so its operating agreement must be collected
 * and its authority to receive funds confirmed before any wire goes out.
 *
 * The owner's flow, in their own words:
 *   1. the operating-agreement condition is the SLOT — the OA can be uploaded there manually, OR
 *   2. if the entity the borrower typed is one they ALREADY have on their profile with an operating
 *      agreement on file, PULL that agreement onto the condition so the coordinator has a head start;
 *   3. when the coordinator ACCEPTS the agreement on the condition, OPEN/LINK that LLC to the
 *      borrower's profile and SAVE the agreement into the LLC's own operating-agreement slot, "so
 *      it's available for the future on his profile" — exactly the entity-adopt discipline;
 *   4. and when the draw is delivered to the INVESTOR who releases the money to the borrower
 *      (investor_direct), ATTACH the agreement to that email so the investor can confirm the entity
 *      before wiring it.
 *
 * THIS MODULE IS THE ONE PLACE THAT DOES 2 AND 3. The webhook calls autofillFromProfile after the
 * wire capture raises the condition; the document-review route calls onAccepted when the agreement
 * on the condition is accepted; the investor-delivery attachment gathering reads the accepted OA.
 * The four steps must move together or the record is half-made — the same reasoning as entity-adopt.
 *
 * NOTHING HERE RUNS ON ITS OWN in a way that changes the file's state without a human: autofill only
 * COPIES an agreement the borrower already has (a coordinator still accepts it), and the adoption
 * fires only on a human's accept. Best-effort everywhere — a failure never reverses the accept.
 */

const drawWire = require('./draw-wire');
const ACCEPT = require('../document-acceptance');

const OA_MARKER = (appId) => `draw:wire_oa:${appId}`;
const LLC_OA_SLOT = 'rtl_llc_opagmt';
const OA_TEMPLATE = 'draw_cond_operating_agreement';

/**
 * Is this checklist item the DRAW wire operating-agreement condition? Returns the row
 * (id, application_id, wire entity name) when it is, or null. Matched on the durable field_key
 * marker OR the template code, so a hand-relabelled condition is still recognised.
 */
async function drawOaConditionOf(db, itemId) {
  if (!itemId) return null;
  const r = await db.query(
    `SELECT ci.id, ci.application_id, ci.field_key,
            (t.code = $2) AS is_oa_template
       FROM checklist_items ci
       LEFT JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.id = $1`, [itemId, OA_TEMPLATE]);
  const row = r.rows[0];
  if (!row || !row.application_id) return null;
  if (row.field_key !== OA_MARKER(row.application_id) && !row.is_oa_template) return null;
  return row;
}

/** The entity name the wire form named (the account that failed the borrower/subject-LLC test). */
async function wireEntityName(db, appId) {
  const r = await db.query(`SELECT account_name FROM draw_wire_instructions WHERE application_id=$1`, [appId]);
  return r.rows[0] ? String(r.rows[0].account_name || '').trim() : '';
}

/** The borrower's LLC that matches `entityName` (base + legal-form aware), or null. */
async function matchingBorrowerLlc(db, borrowerId, entityName) {
  if (!borrowerId || !entityName) return null;
  const llcs = (await db.query(`SELECT id, llc_name, is_verified FROM llcs WHERE borrower_id=$1`, [borrowerId])).rows;
  for (const l of llcs) {
    if (drawWire.entityMatch(entityName, l.llc_name) === true) return l;
  }
  return null;
}

/**
 * The FILE's entity that matches `entityName` — the SAME population the wire classifier's
 * known-entities check reads (primary owner via llcs.borrower_id AND the many-to-many
 * llc_borrowers, for the borrower AND the co-borrower). `matchingBorrowerLlc` reads only the
 * primary borrower's own rows, so an entity living on the co-borrower's profile (or linked
 * through llc_borrowers) was invisible here while the classifier could see it — the two would
 * then DISAGREE about the same name (classifier: known entity; autofill/adopt: create a
 * duplicate). One matcher for everything that asks "does this file's borrower already have
 * this entity?". Returns { id, llc_name, is_verified } or null.
 */
async function matchingFileEntity(db, appId, entityName) {
  if (!appId || !entityName) return null;
  const llcs = (await db.query(
    `SELECT DISTINCT x.id, x.llc_name, x.is_verified
       FROM applications a
       JOIN llcs x ON ( x.borrower_id IN (a.borrower_id, a.co_borrower_id)
                     OR EXISTS (SELECT 1 FROM llc_borrowers lb
                                 WHERE lb.llc_id = x.id
                                   AND lb.borrower_id IN (a.borrower_id, a.co_borrower_id)) )
      WHERE a.id = $1 AND NULLIF(btrim(x.llc_name),'') IS NOT NULL`, [appId])).rows;
  for (const l of llcs) {
    if (drawWire.entityMatch(entityName, l.llc_name) === true) return l;
  }
  return null;
}

/**
 * Copy a document's BYTES onto a target checklist item as a fresh document row. The bytes are
 * copied, never shared (a shared storage_ref would take the profile copy down when the file is
 * purged — the same rule copyDocumentIntoSlot documents). Lands 'received' (awaiting the
 * coordinator's review), never auto-accepted. Returns { copied, documentId } or a reason. */
async function copyDocumentToItem(c, { documentId, checklistItemId, applicationId, borrowerId, actorId, slotLabel }) {
  const src = (await c.query(
    `SELECT id, filename, content_type, size_bytes, storage_provider, storage_ref, sha256, doc_kind
       FROM documents WHERE id=$1`, [documentId])).rows[0];
  if (!src) return { copied: false, reason: 'source_document_missing' };
  if (!src.storage_ref) return { copied: false, reason: 'source_has_no_stored_copy' };

  // Already there (same source, or identical bytes)? Never stack a duplicate.
  const already = (await c.query(
    `SELECT id FROM documents
      WHERE checklist_item_id=$1 AND is_current
        AND (source_document_id=$2 OR ($3::text IS NOT NULL AND sha256=$3)) LIMIT 1`,
    [checklistItemId, src.id, src.sha256 || null])).rows[0];
  if (already) return { copied: false, reason: 'already_on_item', documentId: String(already.id) };

  const storage = require('../storage');
  const buf = await storage.read(src.storage_ref);       // throws → reported by the caller
  if (!buf || !buf.length) return { copied: false, reason: 'source_bytes_empty' };
  const saved = await storage.save(buf, { filename: src.filename });
  const crypto = require('crypto');
  const sha = src.sha256 || crypto.createHash('sha256').update(buf).digest('hex');

  const ins = await c.query(
    `INSERT INTO documents
       (checklist_item_id, application_id, borrower_id, filename, content_type, size_bytes,
        storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, slot_label,
        visibility, source_type, sha256, source_document_id, doc_kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staff',$9,$10,'borrower','system',$11,$12,$13) RETURNING id`,
    [checklistItemId, applicationId, borrowerId, src.filename, src.content_type || 'application/octet-stream',
     buf.length, saved.provider, saved.ref, actorId, String(slotLabel || '').slice(0, 80),
     sha, src.id, src.doc_kind || null]);
  await c.query(`UPDATE checklist_items SET status='received', updated_at=now() WHERE id=$1 AND status='outstanding'`, [checklistItemId]);
  return { copied: true, documentId: String(ins.rows[0].id) };
}

/**
 * AUTOFILL the draw operating-agreement condition from the borrower's profile (step 2). Runs after
 * the wire capture raises the condition. If the wire entity matches an existing borrower LLC that
 * already carries an ACCEPTED operating agreement, that agreement is copied onto the condition so
 * the coordinator does not have to hunt for it. No-op (returns a reason) when the condition already
 * has a document, the entity does not match a profile LLC, or that LLC has no accepted agreement.
 * Never throws.
 */
async function autofillFromProfile(db, appId, actorId = null) {
  try {
    const item = (await db.query(
      `SELECT id FROM checklist_items WHERE application_id=$1 AND field_key=$2 LIMIT 1`,
      [appId, OA_MARKER(appId)])).rows[0];
    if (!item) return { filled: false, reason: 'no_oa_condition' };
    const has = (await db.query(`SELECT 1 FROM documents WHERE checklist_item_id=$1 AND is_current LIMIT 1`, [item.id])).rows[0];
    if (has) return { filled: false, reason: 'condition_already_has_document' };

    const app = (await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [appId])).rows[0];
    if (!app || !app.borrower_id) return { filled: false, reason: 'no_borrower' };
    const entityName = await wireEntityName(db, appId);
    if (!entityName) return { filled: false, reason: 'no_wire_entity' };

    // The FILE-wide matcher (borrower + co-borrower + llc_borrowers) — the same population the
    // wire classifier reads, so a co-borrower's entity with an accepted OA autofills too.
    const llc = await matchingFileEntity(db, appId, entityName);
    if (!llc) return { filled: false, reason: 'no_matching_profile_entity' };

    const oa = (await db.query(
      `SELECT d.id FROM documents d
         JOIN checklist_items ci ON ci.id = d.checklist_item_id
         JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.llc_id=$1 AND t.code=$2 AND d.is_current AND ${ACCEPT.ACCEPTED_SQL('d')}
        ORDER BY d.created_at DESC LIMIT 1`, [llc.id, LLC_OA_SLOT])).rows[0];
    if (!oa) return { filled: false, reason: 'profile_entity_has_no_accepted_oa' };

    const r = await copyDocumentToItem(db, {
      documentId: oa.id, checklistItemId: item.id, applicationId: appId,
      borrowerId: app.borrower_id, actorId,
      slotLabel: `${llc.llc_name} — operating agreement from the borrower's profile`,
    });
    if (!r.copied) return { filled: false, reason: r.reason };
    return { filled: true, fromLlcId: String(llc.id), documentId: r.documentId, entityName };
  } catch (e) {
    return { filled: false, reason: 'error', detail: (e && e.message) || 'error' };
  }
}

/**
 * ON ACCEPT of the operating agreement on the draw wire condition (step 3): OPEN/LINK the entity on
 * the borrower's profile and SAVE the agreement into the LLC's own operating-agreement slot, so it
 * is on his record for the future. Idempotent — a matching LLC is reused (never duplicated), the
 * agreement is not copied twice, and the slot's own document is left untouched if already there.
 *
 * Returns { adopted, llcId, entityName, created, savedToSlot } — or { adopted:false, reason } when
 * there is nothing to do. Best-effort by contract: the caller wraps this so an accept never fails
 * because the profile link did.
 */
async function onAccepted(db, { itemId, documentId, actorId = null } = {}) {
  const cond = await drawOaConditionOf(db, itemId);
  if (!cond) return { adopted: false, reason: 'not_the_draw_oa_condition' };
  const appId = cond.application_id;

  const app = (await db.query(
    `SELECT borrower_id FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId])).rows[0];
  if (!app || !app.borrower_id) return { adopted: false, reason: 'no_borrower' };

  const entityName = await wireEntityName(db, appId);
  if (!entityName) return { adopted: false, reason: 'no_wire_entity' };

  const llcLib = require('../llc');
  // Reuse a matching profile entity (its clean, human-set name), else create one from a CLEAN
  // display name (never the full legal description, which would not match on the next lookup).
  // FILE-wide matcher — an entity on the co-borrower's profile is reused, never duplicated.
  let llcId, created = false, llcName;
  const match = await matchingFileEntity(db, appId, entityName);
  if (match) { llcId = match.id; llcName = match.llc_name; created = false; }
  else {
    const clean = drawWire.displayEntityName(entityName) || entityName;
    const made = await llcLib.findOrCreateLlc(app.borrower_id, { llcName: clean }, db);
    llcId = made.id; created = !made.existed; llcName = clean;
  }

  // The entity's document slots + the borrower ownership link.
  try { await require('../../routes/borrower').generateLlcChecklist(llcId, db); } catch (_) { /* best-effort */ }
  if (created) {
    await db.query(
      `UPDATE llcs SET adopted_from_application_id=$2, adopted_at=now(), adopted_source='draw_wire_form', updated_at=now()
        WHERE id=$1 AND adopted_at IS NULL`, [llcId, appId]);
  }
  try { await require('../llc-borrowers').linkBorrower(llcId, app.borrower_id, null, db); } catch (_) { /* additive */ }

  // SAVE the accepted agreement into the LLC's operating-agreement slot (entity-adopt's own copier,
  // which resolves the (llc, slot) checklist item). It lands awaiting review — a reviewer still
  // confirms the agreement names the borrower as managing member before the entity is verified.
  let savedToSlot = false, slotReason = null;
  try {
    const r = await require('../underwriting/entity-adopt')._internals.copyDocumentIntoSlot(db, {
      documentId, llcId, borrowerId: app.borrower_id, slotCode: LLC_OA_SLOT, actorId, entityName: llcName,
    });
    savedToSlot = !!r.copied;
    slotReason = r.copied ? null : r.reason;
  } catch (e) { slotReason = (e && e.message) || 'copy_failed'; }

  return { adopted: true, llcId: String(llcId), entityName: llcName, created, savedToSlot, slotReason };
}

/**
 * PUT THE WIRE'S ENTITY ON THE BORROWER'S PROFILE (owner-directed 2026-08-10: "the LLC name
 * should automatically be linked to the profile LLC section — either link it to an existing
 * LLC that is there already in the entity section of the borrower profile or create a new
 * entity slot for this"). Runs at wire CAPTURE and on re-classification, for a new-entity
 * wire — the moment PILOT learns money is headed to a company, that company gets its durable
 * home on the profile (document slots included) instead of waiting for a coordinator's accept.
 *
 * GUARDS, each load-bearing:
 *   · COMPANY NAMES ONLY (`hasEntityDesignator`) — a third-party PERSON's name also classifies
 *     'new_entity' (it failed the borrower test), and creating an "entity" named after a human
 *     would corrupt the library. A personal-name wire keeps its fatal condition; no slot.
 *   · REUSE FIRST (`matchingFileEntity`, the classifier's own population) — a matching entity
 *     anywhere on the borrower's / co-borrower's profile is linked, never duplicated.
 *   · A CREATED entity is ADOPTED-STAMPED (`adopted_source='draw_wire_form'`, db/400), so the
 *     wire classifier and the liquidity engine keep treating it as UNVETTED until its operating
 *     agreement is on file or a human verifies it — creating the slot must never be the thing
 *     that clears the fatal it exists to resolve.
 *
 * Idempotent; never throws (returns { linked:false, reason } instead).
 */
async function ensureWireEntityOnProfile(db, appId, { actorId = null } = {}) {
  try {
    const app = (await db.query(
      `SELECT borrower_id FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId])).rows[0];
    if (!app || !app.borrower_id) return { linked: false, reason: 'no_borrower' };

    const entityName = await wireEntityName(db, appId);
    if (!entityName) return { linked: false, reason: 'no_wire_entity' };
    if (!drawWire.hasEntityDesignator(entityName)) return { linked: false, reason: 'not_an_entity_name' };

    const match = await matchingFileEntity(db, appId, entityName);
    if (match) {
      // Already on the profile — make sure its document slots exist (idempotent) and report it.
      try { await require('../../routes/borrower').generateLlcChecklist(match.id, db); } catch (_) { /* best-effort */ }
      return { linked: true, existed: true, created: false, llcId: String(match.id), llcName: match.llc_name };
    }

    const clean = drawWire.displayEntityName(entityName) || entityName;
    // A name that is ONLY a legal designator ("LLC", "Inc") has no descriptive base — it can never
    // match anything and would put a nonsense entity on the profile. State nothing instead.
    if (!drawWire.splitEntity(clean).base) return { linked: false, reason: 'no_entity_base' };

    // CREATE + ADOPTED-STAMP ATOMICALLY (audit 2026-08-10). These are two statements, and the
    // stamp is a SAFETY property: an entity created but left unstamped would pass the wire
    // classifier's known-entities filter (`adopted_from_application_id IS NULL` clears) and the
    // next re-classification would retract the fatal with no operating agreement ever collected —
    // the exact failure the fatal exists to prevent. The reuse branch above cannot repair a
    // missing stamp (it cannot tell "our create that lost its stamp" from a human's library
    // entity, which must never be stamped), so the window is closed at the source: when handed
    // the POOL, both statements run in one transaction; a caller already inside a transaction
    // (a client) owns its own atomicity.
    // Pool vs client: a pg Client ALSO has .connect, so the discriminator is the Pool's own
    // counter getter (`totalCount` exists on pg.Pool only). A client caller (a test transaction,
    // a future transactional adopter) owns its own atomicity and is used as-is.
    const isPool = typeof db.connect === 'function' && typeof db.totalCount === 'number';
    const c = isPool ? await db.connect() : db;
    let made, created = false;
    try {
      if (isPool) await c.query('BEGIN');
      made = await require('../llc').findOrCreateLlc(app.borrower_id, { llcName: clean }, c);
      created = !made.existed;
      if (created) {
        await c.query(
          `UPDATE llcs SET adopted_from_application_id=$2, adopted_at=now(), adopted_source='draw_wire_form', updated_at=now()
            WHERE id=$1 AND adopted_at IS NULL`, [made.id, appId]);
      }
      if (isPool) await c.query('COMMIT');
    } catch (e) {
      if (isPool) { try { await c.query('ROLLBACK'); } catch (_) {} }
      throw e;   // the outer catch reports { linked:false }
    } finally {
      if (isPool) c.release();
    }
    if (created) {
      try {
        await db.query(
          `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
           VALUES ($1, $2, 'draw_wire_entity_added_to_profile', 'application', $3, $4)`,
          [actorId ? 'staff' : 'system', actorId || null, appId,
           JSON.stringify({ llcId: String(made.id), llcName: clean })]);
      } catch (_) { /* audit best-effort */ }
    }
    try { await require('../../routes/borrower').generateLlcChecklist(made.id, db); } catch (_) { /* best-effort */ }
    try { await require('../llc-borrowers').linkBorrower(made.id, app.borrower_id, null, db); } catch (_) { /* additive */ }
    try { await require('../llc').syncLlcConditions(made.id); } catch (_) { /* best-effort */ }
    return { linked: true, existed: !created, created, llcId: String(made.id), llcName: clean };
  } catch (e) {
    return { linked: false, reason: 'error', detail: (e && e.message) || 'error' };
  }
}

/** The side effects that must run AFTER the accept's transaction commits (condition sync + mirror). */
async function afterAcceptCommit(llcId) {
  if (!llcId) return;
  try { await require('../llc').syncLlcConditions(llcId); } catch (_) { /* best-effort */ }
  try { require('../sharepoint-backup').kick(); } catch (_) { /* mirror is best-effort */ }
}

/**
 * The accepted operating agreement on the draw wire condition, for the investor email (step 4).
 * Returns { id, filename, storage_ref, storage_provider } or null. Only an ACCEPTED agreement is
 * returned — an unaccepted one has not been vetted and must not go to an investor. Never throws.
 */
async function acceptedOaForInvestor(db, appId) {
  try {
    const item = (await db.query(
      `SELECT id FROM checklist_items WHERE application_id=$1 AND field_key=$2 LIMIT 1`,
      [appId, OA_MARKER(appId)])).rows[0];
    if (!item) return null;
    return (await db.query(
      `SELECT id, filename, storage_ref, storage_provider FROM documents d
        WHERE d.checklist_item_id=$1 AND d.is_current AND ${ACCEPT.ACCEPTED_SQL('d')}
        ORDER BY d.created_at DESC LIMIT 1`, [item.id])).rows[0] || null;
  } catch (_) { return null; }
}

module.exports = {
  OA_MARKER, LLC_OA_SLOT, OA_TEMPLATE,
  drawOaConditionOf, wireEntityName, matchingBorrowerLlc, matchingFileEntity,
  autofillFromProfile, onAccepted, afterAcceptCommit, acceptedOaForInvestor,
  ensureWireEntityOnProfile,
  _internals: { copyDocumentToItem },
};
