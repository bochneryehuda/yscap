'use strict';
/**
 * ADOPT AN OUTSIDE ENTITY ONTO THE BORROWER'S PROFILE (owner-directed 2026-08-02).
 *
 * THE SITUATION. A bank statement in the assets condition is held by an LLC that is not the
 * borrower and not one of the borrower's known entities. Since 2026-07-27 that is correctly an
 * OWNERSHIP question, not fraud — "it's not major fraud, it's just that you don't have the LLC
 * documents for that LLC". What was missing was the way OUT of the finding. The owner's flow, in
 * their own words:
 *
 *   1. a BUTTON on the finding that adds this LLC to the borrower's profile — "so it's safe for
 *      always so we can always see that he has this LLC on his record";
 *   2. then suggest POSTING A CONDITION asking for that entity's documents, "to allow him to use
 *      this LLC";
 *   3. and when the assets condition already carries an OPERATING AGREEMENT for that same LLC
 *      (it usually does — it gets uploaded alongside the statements), USE it: satisfy the finding
 *      with it, still SHOW the finding, and carry that operating agreement onto the new entity's
 *      OPERATING AGREEMENT SLOT "so it should be available for the future on his profile".
 *
 * THIS MODULE IS THE ONE PLACE THAT DOES IT. Every surface (the finding card, the AI-panel
 * suggestion, any future one) calls `adoptEntityToProfile` rather than re-assembling the steps —
 * the four of them have to happen together or the record is half-made.
 *
 * WHY THE ADOPTION IS STAMPED (`llcs.adopted_*`, db/399) — the load-bearing safety property.
 * `bank-liquidity.js` counts an account as the borrower's when its holder matches ANY entity on the
 * borrower's profile. So merely writing the NAME onto the profile would, by itself, move that
 * account's whole balance into the file's provable liquidity — before a single document proved the
 * borrower owns it. That is precisely the over-count the different-LLC finding exists to prevent,
 * and it would happen silently, one click after a staffer read "this is not fraud". So an entity
 * adopted this way is stamped, and `file-view.loadContext` reports it as FUNDS-PENDING until its
 * documents land; the liquidity engine leaves those balances in the EXCLUDED column (which already
 * explains itself: "it counts only once the borrower's control of that entity is documented"). The
 * pending state clears on its own the moment an entity document is uploaded or the entity is
 * verified — no second click, no flag to remember to turn off.
 *
 * WHAT IS DELIBERATELY *NOT* AUTOMATIC. Nothing here runs on its own: PILOT never adopts an entity,
 * never posts the condition, never resolves the finding (the standing HARD RULE that the AI
 * proposes and a human decides). A human presses the button; this module carries out what they
 * pressed, and reports exactly what it did and what it could not do.
 *
 * The pure half (finding -> entity name, doc type -> slot, which entities are funds-pending) is
 * exported separately so it is unit-testable with no database.
 */

const { entityMatch } = require('./compare');

// A document PILOT read as an entity document -> the LLC slot on the profile it belongs in.
// Keyed on the extraction `doc_type` (registry.js), valued with the db/005 llc-scoped template code
// (llc.js LLC_SLOT_CODES + the optional certificate of good standing).
const SLOT_FOR_DOC_TYPE = {
  operating_agreement: 'rtl_llc_opagmt',
  llc_formation: 'rtl_llc_formation',
  ein_letter: 'rtl_llc_ein',
  good_standing: 'rtl_llc_goodstanding',
};
const ENTITY_DOC_TYPES = Object.keys(SLOT_FOR_DOC_TYPE);

// The finding codes that name an entity the borrower's profile may be missing. Both are the
// warning-level ownership advisories — NEVER the fatal `bank_account_not_borrower` (a third-party
// PERSONAL account is not an entity to adopt; it is a source-of-funds question about a human).
const ADOPTABLE_CODES = new Set(['bank_account_other_entity', 'bank_business_entity_unverified']);

// The condition a human may post from the finding: collect the entity's documents so the borrower
// may use its funds. Application-scoped, auto_apply='manual' (db/399) — an LLC-scoped code such as
// `rtl_llc_opagmt` can NOT be instantiated on a loan file and 400s the convert-to-condition route.
const ENTITY_DOCS_TEMPLATE_CODE = 'rtl_cond_entity_docs';

/**
 * The entity a finding invites you to adopt, or null. PURE.
 * The holder's name lives in `doc_value` on a stored finding and `docValue` on a computed one;
 * `entityName` is carried by the check itself. Any of the three is authoritative.
 */
function adoptTargetOf(finding) {
  const f = finding || {};
  if (!ADOPTABLE_CODES.has(f.code)) return null;
  const raw = f.entityName != null ? f.entityName
    : (f.doc_value != null ? f.doc_value : f.docValue);
  const name = String(raw == null ? '' : raw).trim();
  if (!name) return null;                       // never offer to adopt a nameless entity
  return { entityName: name.slice(0, 160), code: f.code };
}

/**
 * Which of a borrower's entities must NOT count toward liquidity yet. PURE.
 * An entity is funds-pending when PILOT adopted it from a finding (a name read off a bank
 * statement), it is not verified, and no entity document has landed on it. Everything else — every
 * entity a human put on the profile, every adopted entity that has since received a document — is
 * untouched, so no existing file's liquidity moves.
 *
 * @param {Array<{llc_name, is_verified, adopted, has_entity_doc}>} rows
 * @returns {string[]} entity names whose balances stay in the EXCLUDED column
 */
function entityDocsPendingNames(rows) {
  const out = [];
  for (const r of (rows || [])) {
    if (!r || !r.llc_name) continue;
    if (!r.adopted) continue;                   // a human's own entity is never held back
    if (r.is_verified === true) continue;       // verified beats everything
    if (r.has_entity_doc === true) continue;    // proof landed — the hold releases itself
    out.push(r.llc_name);
  }
  return out;
}

/**
 * The entity documents ALREADY on this file that belong to `entityName`. PURE.
 * `extractions` are `document_extractions` rows (doc_type + fields). Matching uses the SAME
 * `entityMatch` the rest of the underwriting stack uses, so "Beta Holdings LLC" on the statement and
 * "Beta Holdings, L.L.C." on the agreement are one entity, and two genuinely different entities
 * never collapse. A row whose document is unknown, or whose entity name is blank, is skipped —
 * never guessed onto an entity.
 */
function matchEntityDocs(entityName, extractions) {
  const want = String(entityName || '').trim();
  if (!want) return { primary: [], extra: [] };   // always the same shape — callers destructure it
  const out = [];
  for (const e of (extractions || [])) {
    const docType = e && (e.doc_type || e.docType);
    if (!SLOT_FOR_DOC_TYPE[docType]) continue;
    const documentId = e && (e.document_id || e.documentId);
    if (!documentId) continue;
    const fields = (e && e.fields) || {};
    const legal = String(fields.entityLegalName || '').trim();
    if (!legal) continue;
    if (entityMatch(legal, want) !== true) continue;
    out.push({ documentId: String(documentId), docType, slotCode: SLOT_FOR_DOC_TYPE[docType], entityLegalName: legal });
  }
  // One document per slot — the first match wins, and the rest are reported as extras rather than
  // stacked onto the slot (a slot showing three copies of one agreement helps nobody).
  const seen = new Set();
  const primary = [], extra = [];
  for (const d of out) {
    if (seen.has(d.slotCode)) { extra.push(d); continue; }
    seen.add(d.slotCode); primary.push(d);
  }
  return { primary, extra };
}

// --------------------------------------------------------------------------
// The database half.
// --------------------------------------------------------------------------

/**
 * Carry out the adoption. Idempotent — pressing the button twice adds nothing twice:
 * `findOrCreateLlc` REUSES an entity of the same name, `generateLlcChecklist` dedupes per slot, the
 * document copy skips a slot that already holds these exact bytes, and the condition is only posted
 * when the file does not already carry it.
 *
 * @param {*} client pg client (a caller's transaction is honored; defaults to the pool)
 * @param {{appId:string, entityName:string, actorId?:string, postCondition?:boolean}} opts
 * @returns {Promise<{llcId, entityName, existed, created, carried:Array, skipped:Array,
 *                    conditionId:string|null, conditionExisted:boolean, slots:number}>}
 */
async function adoptEntityToProfile(client, { appId, entityName, actorId = null, postCondition = true } = {}) {
  const c = client || require('../../db');
  const name = String(entityName || '').trim().slice(0, 160);
  if (!appId) { const e = new Error('appId required'); e.status = 400; throw e; }
  if (!name) { const e = new Error('the entity name is empty — nothing to add'); e.status = 400; throw e; }

  const app = (await c.query(
    `SELECT id, borrower_id FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId])).rows[0];
  if (!app) { const e = new Error('file not found'); e.status = 404; throw e; }
  if (!app.borrower_id) { const e = new Error('this file has no borrower profile to add the entity to'); e.status = 409; throw e; }

  // 1. THE ENTITY. findOrCreateLlc is the repo's one chokepoint for creating an entity — a name the
  //    borrower already has is REUSED (with its documents and verification), never duplicated.
  const llcLib = require('../llc');
  const { id: llcId, existed } = await llcLib.findOrCreateLlc(app.borrower_id, { llcName: name }, c);

  // 2. ITS DOCUMENT SLOTS — formation / EIN / operating agreement (+ good standing). Idempotent per
  //    (llc, template), so an entity that already had them keeps exactly what it had.
  try { await require('../../routes/borrower').generateLlcChecklist(llcId, c); } catch (_) { /* best-effort */ }

  // 3. THE PROVENANCE STAMP — only on an entity this action CREATED. An entity the borrower already
  //    had on their profile is theirs; stamping it would wrongly hold its funds back.
  if (!existed) {
    await c.query(
      `UPDATE llcs SET adopted_from_application_id=$2, adopted_at=now(), adopted_source=$3, updated_at=now()
        WHERE id=$1 AND adopted_at IS NULL`,
      [llcId, appId, 'bank_statement_finding']);
  }

  // 4. Record the borrower as an owner of the entity (the many-to-many link the co-borrower work
  //    added). Additive; never touches the single-owner `llcs.borrower_id`.
  try { await require('../llc-borrowers').linkBorrower(llcId, app.borrower_id, null, c); } catch (_) { /* additive */ }

  // 5. CARRY THE ENTITY DOCUMENTS ALREADY ON THE FILE onto the entity's own slots — the owner's
  //    "take this operating agreement and add it to that new LLC section". Read from the file's
  //    CURRENT extractions so we only ever move a document PILOT actually read as this entity's.
  //    A VERIFIED entity is left alone: the portal already refuses an upload into a verified
  //    entity's slots (routes/staff.js POST /llcs/:id/documents answers 409) because its documents
  //    are the basis of a sign-off somebody made, and this path must not be the one way around that.
  const verified = (await c.query(`SELECT is_verified FROM llcs WHERE id=$1`, [llcId])).rows[0];
  const exts = (await c.query(
    `SELECT document_id, doc_type, fields FROM document_extractions
      WHERE application_id=$1 AND is_current AND superseded=false
        AND doc_type = ANY($2::text[])`, [appId, ENTITY_DOC_TYPES])).rows;
  const { primary, extra } = matchEntityDocs(name, exts);

  const carried = [];
  const skipped = extra.map((d) => ({ documentId: d.documentId, docType: d.docType, reason: 'slot_already_filled_by_this_run' }));
  for (const d of primary) {
    if (verified && verified.is_verified === true) {
      skipped.push({ documentId: d.documentId, docType: d.docType, reason: 'entity_already_verified' });
      continue;
    }
    try {
      const r = await copyDocumentIntoSlot(c, {
        documentId: d.documentId, llcId, borrowerId: app.borrower_id,
        slotCode: d.slotCode, actorId, entityName: name,
      });
      if (r.copied) carried.push({ ...d, newDocumentId: r.documentId, slotItemId: r.slotItemId });
      else skipped.push({ documentId: d.documentId, docType: d.docType, reason: r.reason });
    } catch (e) {
      // Never let one unreadable document stop the adoption — but never silently, either.
      skipped.push({ documentId: d.documentId, docType: d.docType, reason: 'copy_failed', detail: (e && e.message) || 'error' });
    }
  }

  // 6. THE CONDITION — ask for the entity documents so the borrower may use these funds.
  let conditionId = null, conditionExisted = false;
  if (postCondition) {
    const posted = await ensureEntityDocsCondition(c, appId, name);
    conditionId = posted.id; conditionExisted = posted.existed;
  }

  const slots = (await c.query(
    `SELECT count(*)::int n FROM checklist_items WHERE llc_id=$1`, [llcId])).rows[0].n;

  return {
    llcId: String(llcId), entityName: name, existed: !!existed, created: !existed,
    carried, skipped, conditionId, conditionExisted, slots,
  };
}

/**
 * The two side effects that must happen AFTER the adoption is committed. Call this once the caller's
 * transaction has COMMITTED — never inside it.
 *
 * WHY IT IS SEPARATE. Both of these reach the database on their OWN connection: `syncLlcConditions`
 * opens its own (it is shared with the LLC routes, which are not transactional), and the SharePoint
 * mirror runs in a background worker. Called inside an open transaction they would look for rows
 * that are not committed yet — `syncLlcConditions` would find no LLC and return silently, and the
 * mirror would find no documents to copy. Both would "succeed" having done nothing, which is the
 * worst kind of failure: invisible.
 *
 * Best-effort by design: a file's entity condition being one refresh behind, or a mirror copy
 * arriving on the worker's next pass instead of immediately, must never undo an adoption that
 * already happened.
 */
async function afterAdoptCommit(llcId) {
  try { await require('../llc').syncLlcConditions(llcId); } catch (_) { /* best-effort */ }
  try { require('../sharepoint-backup').kick(); } catch (_) { /* mirror is best-effort */ }
}

/**
 * Copy ONE document onto an entity's document slot.
 *
 * THE BYTES ARE COPIED, NOT SHARED. Pointing the profile's row at the loan file's `storage_ref`
 * would be cheaper and is wrong: purging a file deletes the bytes of every document carrying its
 * `application_id` (routes/staff.js), deliberately sparing entity documents because they are keyed
 * on `llc_id` — a shared ref would take the profile's copy down with the file. The whole point of
 * this step is that the agreement is "available for the future on his profile", so it gets its own
 * object. A storage read that fails leaves the slot empty and is REPORTED, never swallowed.
 */
async function copyDocumentIntoSlot(client, { documentId, llcId, borrowerId, slotCode, actorId, entityName }) {
  const c = client;
  const src = (await c.query(
    `SELECT id, filename, content_type, size_bytes, storage_provider, storage_ref, sha256, doc_kind
       FROM documents WHERE id=$1`, [documentId])).rows[0];
  if (!src) return { copied: false, reason: 'source_document_missing' };
  if (!src.storage_ref) return { copied: false, reason: 'source_has_no_stored_copy' };

  const slot = (await c.query(
    `SELECT ci.id FROM checklist_items ci
       JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.llc_id=$1 AND t.code=$2 LIMIT 1`, [llcId, slotCode])).rows[0];
  if (!slot) return { copied: false, reason: 'slot_not_found' };

  // Already there? Two ways to be sure without re-reading bytes: the same source document was
  // carried before (`source_document_id`), or an identical-content document is already in the slot.
  const already = (await c.query(
    `SELECT id FROM documents
      WHERE checklist_item_id=$1 AND is_current
        AND (source_document_id=$2 OR ($3::text IS NOT NULL AND sha256=$3))
      LIMIT 1`, [slot.id, src.id, src.sha256 || null])).rows[0];
  if (already) return { copied: false, reason: 'already_on_this_slot', documentId: String(already.id), slotItemId: String(slot.id) };

  const storage = require('../storage');
  const buf = await storage.read(src.storage_ref);          // throws -> reported as copy_failed
  if (!buf || !buf.length) return { copied: false, reason: 'source_bytes_empty' };
  const saved = await storage.save(buf, { filename: src.filename });

  const crypto = require('crypto');
  const sha = src.sha256 || crypto.createHash('sha256').update(buf).digest('hex');
  const slotLabel = String(`${entityName} — from the loan file`).slice(0, 80);

  const ins = await c.query(
    `INSERT INTO documents
       (checklist_item_id, llc_id, borrower_id, filename, content_type, size_bytes,
        storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, slot_label,
        visibility, source_type, sha256, source_document_id, doc_kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staff',$9,$10,'borrower','system',$11,$12,$13)
     RETURNING id`,
    [slot.id, llcId, borrowerId, src.filename, src.content_type || 'application/octet-stream',
     buf.length, saved.provider, saved.ref, actorId, slotLabel, sha, src.id, src.doc_kind || null]);

  // The slot now holds a document awaiting review — exactly as if a human had uploaded it there.
  // It is deliberately NOT auto-accepted: a reviewer still confirms the agreement names the
  // borrower as managing member / 25%+ owner before the entity can be verified.
  await c.query(`UPDATE checklist_items SET status='received', updated_at=now() WHERE id=$1 AND status='outstanding'`, [slot.id]);

  return { copied: true, documentId: String(ins.rows[0].id), slotItemId: String(slot.id) };
}

/**
 * Post (or find) the entity-documents condition on the file. Idempotent per (file, template) so a
 * second click never stacks a duplicate condition. Mirrors the convert-to-condition instantiation
 * in routes/underwriting.js — every template column copied through, born 'outstanding' (a brand-new
 * ask, never the red "we sent this back" bucket).
 */
async function ensureEntityDocsCondition(client, appId, entityName) {
  const c = client;
  const existing = (await c.query(
    `SELECT ci.id FROM checklist_items ci
       JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.application_id=$1 AND t.code=$2 LIMIT 1`, [appId, ENTITY_DOCS_TEMPLATE_CODE])).rows[0];
  if (existing) return { id: String(existing.id), existed: true };

  const note = `[auto] Entity documents needed for "${entityName}" — the business holding the bank funds on this file.`;
  const ins = await c.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
        phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
        clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id,
        status, notes)
     SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
            COALESCE(t.role_scope,'any'), t.phase, t.hint, t.borrower_hint,
            COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
            COALESCE(t.sort_order,900), t.tool_key, t.clickup_field_id,
            COALESCE(t.tpr_exclude,false), 'system', COALESCE(t.is_required,true), $1,
            'outstanding', $3
       FROM checklist_templates t
      WHERE t.code = $2 AND t.scope = 'application'
      RETURNING id`,
    [appId, ENTITY_DOCS_TEMPLATE_CODE, note]);
  if (!ins.rows[0]) { const e = new Error(`the "${ENTITY_DOCS_TEMPLATE_CODE}" condition template is not installed`); e.status = 500; throw e; }
  return { id: String(ins.rows[0].id), existed: false };
}

/**
 * Is the OWNERSHIP PROOF now on the entity's profile? PURE.
 *
 * The owner's rule is specific: an operating agreement found with the bank statements is what
 * SATISFIES the different-entity finding — "you should use that operating agreement to satisfy your
 * finding". Articles of organization and an EIN letter establish that the company EXISTS; only the
 * operating agreement says who controls it, which is the question the finding asks. So the finding
 * is only settled when the agreement is on the entity's slot — carried by this run, or already
 * there from an earlier one (a second click must reach the same conclusion as the first).
 *
 * Everything else — an adoption with no agreement — leaves the finding OPEN on purpose: the entity
 * is now on the borrower's record and the condition is posted, but nobody has yet shown he controls
 * it, and that is exactly what the finding is still waiting for.
 */
function ownershipProofLanded(res) {
  const r = res || {};
  const inCarried = (r.carried || []).some((d) => d && d.docType === 'operating_agreement');
  const alreadyThere = (r.skipped || []).some((d) => d && d.docType === 'operating_agreement' && d.reason === 'already_on_this_slot');
  return inCarried || alreadyThere;
}

/**
 * A plain-language summary of what the adoption did — used verbatim as the note recorded on the
 * finding, so the file itself answers "why was this cleared?" years later. PURE.
 *
 * It describes the STATE the entity is now in, not merely what THIS run happened to do. A second
 * click carries nothing (the documents are already on the slots), and a summary written from
 * `carried` alone would then read "no entity documents were on this file, so its slots are still
 * empty" on the very click that settled the finding BECAUSE the agreement is there — a note that
 * contradicts the decision it is attached to.
 */
function adoptionSummary(res) {
  const r = res || {};
  const bits = [];
  bits.push(r.created
    ? `Added "${r.entityName}" to the borrower's profile as a borrower entity.`
    : `"${r.entityName}" was already on the borrower's profile.`);
  const label = (t) => DOC_TYPE_LABEL[t] || t;
  const carried = (Array.isArray(r.carried) ? r.carried : []).map((d) => label(d.docType));
  const alreadyThere = (Array.isArray(r.skipped) ? r.skipped : [])
    .filter((d) => d && d.reason === 'already_on_this_slot').map((d) => label(d.docType));
  if (carried.length) bits.push(`Carried the ${carried.join(', ')} from this file onto the entity's document slots.`);
  if (alreadyThere.length) bits.push(`The ${alreadyThere.join(', ')} was already on the entity.`);
  if (!carried.length && !alreadyThere.length) {
    bits.push('No entity documents for it were on this file, so its slots are still empty.');
  }
  if (r.conditionId) {
    bits.push(r.conditionExisted
      ? 'The entity-documents condition was already on the file.'
      : 'Posted the entity-documents condition so the rest can be collected.');
  }
  return bits.join(' ');
}
const DOC_TYPE_LABEL = {
  operating_agreement: 'operating agreement',
  llc_formation: 'articles of organization',
  ein_letter: 'EIN letter',
  good_standing: 'certificate of good standing',
};

module.exports = {
  adoptEntityToProfile,
  afterAdoptCommit,
  adoptTargetOf,
  entityDocsPendingNames,
  matchEntityDocs,
  ownershipProofLanded,
  adoptionSummary,
  SLOT_FOR_DOC_TYPE,
  ENTITY_DOC_TYPES,
  ADOPTABLE_CODES,
  ENTITY_DOCS_TEMPLATE_CODE,
  DOC_TYPE_LABEL,
  _internals: { copyDocumentIntoSlot, ensureEntityDocsCondition },
};
