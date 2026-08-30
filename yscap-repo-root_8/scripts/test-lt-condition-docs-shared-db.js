'use strict';
/**
 * ONE CONDITION-DOCUMENT SERVICE, TWO PRODUCTS — proven against a REAL Postgres,
 * through the REAL extracted functions (src/lib/condition-docs/*).
 *
 * NAMED `test-lt-…` ON PURPOSE: the separation gate reads a test's FILENAME as its
 * product identity (`isLtTest`, check-product-separation.js), and this suite's SQL
 * names `lt_loans` and `documents.lt_loan_id`. A suite exercising the shared door
 * from BOTH sides has to be able to name the Long-Term table, and only a
 * `scripts/test-lt-*.js` name may.
 *
 * WHAT IT PINS, and every one of these is a way the sharing could be wrong while
 * every screen still looked fine:
 *
 *  A. The RTL side is BYTE-IDENTICAL through the shared door — the visibility
 *     rule, the term-sheet born-accepted INSERT, the 120-second de-dupe, the
 *     explicit replace, the one-current supersede, the evidence re-open, the
 *     verdict stamps and the delete's condition re-open all behave exactly as the
 *     inline handlers did.
 *  B. A Long-Term upload lands with `lt_loan_id` set and `application_id` NULL —
 *     one owner column, by construction at the door (NO constraint on `documents`
 *     enforces it — chk_one_owner is on checklist_items only).
 *  C. THE CROSS-OWNER IDOR: with an owner named, a document id belonging to the
 *     OTHER product does not reach a row that some later check is trusted to
 *     refuse — it reaches nothing, on review, on remove and on serve.
 *  D. The two owners' documents NEVER de-duplicate against each other, and a
 *     one-current supersede on one product never retires the other's.
 *  E. The RTL hook set is the default for `scope='application'` and for NOBODY
 *     else — so no RTL call site changed behaviour, and a Long-Term document can
 *     never fire RTL machinery by omission.
 *
 * Skips cleanly with no DATABASE_URL, like every other -db suite here.
 */

if (!process.env.DATABASE_URL) { console.log('SKIP test-lt-condition-docs-shared-db (no DATABASE_URL)'); process.exit(0); }
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';

const fs = require('fs');
const os = require('os');
const path = require('path');
// The upload door really stores bytes, so give it a disposable disk of its own.
process.env.STORAGE_DIR = process.env.STORAGE_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'cond-docs-test-'));

const db = require('../src/db');
const { ownerOf } = require('../src/lib/condition-owner');
const condUpload = require('../src/lib/condition-docs/upload');
const condReview = require('../src/lib/condition-docs/review');
const condRemove = require('../src/lib/condition-docs/remove');
const condServe = require('../src/lib/condition-docs/serve');
const condHooks = require('../src/lib/condition-docs/hooks-rtl');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const uniq = `cds-${process.pid}-${Date.now()}`;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/* EVERY FIXTURE'S BYTES ARE A DIFFERENT LENGTH, DELIBERATELY. The de-dupe tuple
   includes the SIZE, so two unrelated uploads in the same context that happen to
   be the same length really do collapse onto each other — which is correct
   behaviour and a disastrous fixture. A random payload's length is the same far
   more often than not, so the counter below is what keeps this suite about the
   door rather than about luck. */
let seq = 0;
const freshBytes = () => { seq += 1; return b64(`doc-${seq}-${'x'.repeat(seq)}`); };

/** A body shaped like the JSON door's, so `takeUpload` really decodes + stores. */
const body = (over) => Object.assign({
  filename: 'proof.pdf', contentType: 'application/pdf', dataBase64: freshBytes(),
}, over);

/** A hook set that only RECORDS, so a test can see exactly where a hook fires. */
function spyHooks() {
  const calls = [];
  return {
    calls,
    conditionTouched: (id) => { calls.push(['conditionTouched', id]); return Promise.resolve(); },
    notifyUpload: async (a) => { calls.push(['notifyUpload', a.itemLabel, a.slot]); },
  };
}

const docRow = async (id) => (await db.query(
  `SELECT id, application_id, lt_loan_id, borrower_id, llc_id, checklist_item_id, filename,
          slot_label, doc_kind, visibility, review_status, is_current, term_sheet_final,
          uploaded_by_kind, size_bytes, storage_ref, rejection_reason
     FROM documents WHERE id=$1`, [id])).rows[0];
const itemRow = async (id) => (await db.query(
  `SELECT status, signed_off_at, reviewed_at, borrower_hint, notes FROM checklist_items WHERE id=$1`, [id])).rows[0];

(async () => {
  await db.query('SELECT 1');
  const { ensureSchema } = require('../src/migrate-boot');
  await ensureSchema();   // db/650 must be live before a single lt_loan row is written

  /* ───────────────────────────────── seed ─────────────────────────────────── */
  const staffId = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Percy Processor','processor',true) RETURNING id`,
    [`${uniq}@example.test`])).rows[0].id;
  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Bo','Rrower',$1) RETURNING id`,
    [`${uniq}-bo@example.test`])).rows[0].id;

  const appId = (await db.query(
    `INSERT INTO applications (borrower_id, status) VALUES ($1,'underwriting') RETURNING id`, [borrowerId])).rows[0].id;
  const appIdB = (await db.query(
    `INSERT INTO applications (borrower_id, status) VALUES ($1,'underwriting') RETURNING id`, [borrowerId])).rows[0].id;
  // `lt_loans.id` carries no default — the Long-Term side mints its own ids.
  const ltId = (await db.query(
    `INSERT INTO lt_loans (id, loan_number, borrower_name) VALUES ($1::uuid,$2,'Bo Rrower') RETURNING id`,
    [require('crypto').randomUUID(), `YSCAP-${uniq}`])).rows[0].id;

  const APP = ownerOf('application', appId);
  const APP_B = ownerOf('application', appIdB);
  const LT = ownerOf('lt_loan', ltId);

  // A borrower-audience condition on each owner, plus a STAFF-audience one on the
  // RTL file so the visibility rule can be exercised both ways.
  const mkItem = async (owner, label, audience) => (await db.query(
    `INSERT INTO checklist_items (scope, application_id, lt_loan_id, label, borrower_label, audience, status)
     VALUES ($1,$2,$3,$4,$4,$5,'outstanding') RETURNING id`,
    [owner.scope,
      owner.scope === 'application' ? owner.id : null,
      owner.scope === 'lt_loan' ? owner.id : null,
      label, audience])).rows[0].id;
  const appItem = await mkItem(APP, 'RTL insurance binder', 'both');
  const appStaffItem = await mkItem(APP, 'RTL internal review', 'staff');
  await mkItem(APP_B, 'Other RTL file condition', 'both');   // the other RTL file is real, so C4 is not a test against an empty file
  const ltItem = await mkItem(LT, 'LT bank statements', 'both');

  /* ══════════════════ A. THE RTL SIDE, THROUGH THE SHARED DOOR ══════════════ */

  const hooksA = spyHooks();
  const upA = await condUpload.uploadConditionDocument({}, {
    owner: APP, body: body({ checklistItemId: appItem, slot: 'Binder' }),
    actorId: staffId, borrowerId, hooks: hooksA, q: db,
  });
  const rowA = await docRow(upA.documentId);
  assert(!upA.deduped, 'A1 a first upload is not a duplicate');
  assert(rowA.application_id === appId && rowA.lt_loan_id === null,
    'A2 an RTL upload lands with application_id set and lt_loan_id NULL');
  assert(rowA.checklist_item_id === appItem && rowA.slot_label === 'Binder',
    'A3 it lands on the condition, in the slot it was given');
  assert(rowA.visibility === 'borrower' && rowA.review_status === 'pending' && rowA.is_current === true,
    'A4 an ordinary upload is borrower-visible, pending review and current');
  assert(rowA.uploaded_by_kind === 'staff' && rowA.size_bytes > 0 && !!rowA.storage_ref,
    'A5 the bytes were really stored and the uploader recorded');
  assert((await itemRow(appItem)).status === 'received',
    'A6 the evidence re-open moved the condition to received');
  assert(hooksA.calls.some((c) => c[0] === 'conditionTouched' && c[1] === appItem),
    'A7 the condition-touched hook fired for the item');
  assert(hooksA.calls.some((c) => c[0] === 'notifyUpload'),
    'A8 the borrower notification hook fired on a borrower-audience condition');

  // The visibility rule: a STAFF-audience condition stores staff-only and the
  // borrower is never told. A request may only ever RESTRICT.
  const hooksS = spyHooks();
  const upS = await condUpload.uploadConditionDocument({}, {
    owner: APP, body: body({ checklistItemId: appStaffItem }), actorId: staffId, borrowerId, hooks: hooksS, q: db,
  });
  assert((await docRow(upS.documentId)).visibility === 'staff_only',
    'A9 a staff-audience condition stores the document staff-only');
  assert(!hooksS.calls.some((c) => c[0] === 'notifyUpload'),
    'A10 and the borrower is never notified about it');
  const upR = await condUpload.uploadConditionDocument({}, {
    owner: APP, body: body({ checklistItemId: appItem, staffOnly: true }), actorId: staffId, borrowerId, hooks: spyHooks(), q: db,
  });
  assert((await docRow(upR.documentId)).visibility === 'staff_only',
    'A11 a caller may RESTRICT a borrower-audience condition to staff-only');

  // The 120-second de-dupe: the identical file, same context, collapses onto the
  // already-saved row and the second copy's orphan bytes are removed.
  // NOTE the fixture carries NO slot, and that is the door's own ordering rather
  // than a convenience: `uniqueSlotLabel` runs BEFORE the de-dupe check and the
  // slot label is part of the identity tuple, so a repeat upload INTO A NAMED SLOT
  // on a condition has always been given a fresh label and has never de-duplicated.
  // Asserting otherwise would be asserting a behaviour the inline handler never had.
  const dupBody = body({ checklistItemId: appItem, dataBase64: b64('identical-bytes') });
  const dup1 = await condUpload.uploadConditionDocument({}, {
    owner: APP, body: { ...dupBody }, actorId: staffId, borrowerId, hooks: spyHooks(), q: db,
  });
  const dup2 = await condUpload.uploadConditionDocument({}, {
    owner: APP, body: { ...dupBody }, actorId: staffId, borrowerId, hooks: spyHooks(), q: db,
  });
  assert(dup2.deduped === true && dup2.documentId === dup1.documentId,
    'A12 a byte-identical re-upload collapses onto the already-saved document');

  // The unique slot label: a plain ADD never displays two documents under one label.
  const add2 = await condUpload.uploadConditionDocument({}, {
    owner: APP, body: body({ checklistItemId: appItem, slot: 'Binder' }), actorId: staffId, borrowerId, hooks: spyHooks(), q: db,
  });
  assert((await docRow(add2.documentId)).slot_label !== 'Binder',
    'A13 a colliding slot label on a plain ADD is made unique');
  assert((await docRow(rowA.id)).is_current === true,
    'A14 …and the first document is NOT superseded by a plain ADD');

  // An EXPLICIT replace supersedes exactly one document, never its siblings.
  const repl = await condUpload.uploadConditionDocument({}, {
    owner: APP, body: body({ checklistItemId: appItem, replaceDocumentId: rowA.id }),
    actorId: staffId, borrowerId, hooks: spyHooks(), q: db,
  });
  assert((await docRow(rowA.id)).is_current === false && (await docRow(rowA.id)).review_status === 'superseded',
    'A15 an explicit replace supersedes exactly that document');
  assert((await docRow(add2.documentId)).is_current === true,
    'A16 …and leaves its siblings on the condition alone');

  // A term sheet is born ACCEPTED and is one-current on its owner.
  const ts1 = await condUpload.uploadConditionDocument({}, {
    owner: APP, body: body({ docKind: 'term_sheet', termSheetFinal: false }), actorId: staffId, borrowerId, hooks: spyHooks(), q: db,
  });
  const ts1row = await docRow(ts1.documentId);
  assert(ts1row.review_status === 'accepted' && ts1row.doc_kind === 'term_sheet' && ts1row.term_sheet_final === false,
    'A17 a term sheet is born accepted and records the stamp it printed');
  const ts2 = await condUpload.uploadConditionDocument({}, {
    owner: APP, body: body({ docKind: 'term_sheet', termSheetFinal: true }), actorId: staffId, borrowerId, hooks: spyHooks(), q: db,
  });
  assert((await docRow(ts1.documentId)).is_current === false,
    'A18 a newer term sheet supersedes the prior one on the same file');

  // The verdict path: accept marks the condition RECEIVED, never satisfied (#135).
  const accDoc = await condReview.loadDocument(db, repl.documentId);
  await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2 WHERE id=$1`,
    [appItem, staffId]);
  await condReview.applyVerdict(db, {
    doc: accDoc, verdict: condReview.validateVerdict({ action: 'accept' }, { canAccept: true }),
    actorId: staffId, hooks: spyHooks(),
  });
  assert((await docRow(repl.documentId)).review_status === 'accepted', 'A19 accept stamps the document accepted');
  assert((await itemRow(appItem)).status === 'received', 'A20 accept marks the condition RECEIVED, never satisfied');

  // Reject re-opens to 'issue' AND drops the sign-off the rejected doc was evidence for.
  await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2 WHERE id=$1`,
    [appItem, staffId]);
  await condReview.applyVerdict(db, {
    doc: accDoc, verdict: condReview.validateVerdict({ action: 'reject', reason: 'wrong carrier' }, { canAccept: true }),
    actorId: staffId, hooks: spyHooks(),
  });
  const afterReject = await itemRow(appItem);
  assert((await docRow(repl.documentId)).rejection_reason === 'wrong carrier', 'A21 reject records the reason');
  assert(afterReject.status === 'issue' && afterReject.signed_off_at === null,
    'A22 reject re-opens the condition to issue and drops the prior sign-off');

  // Request-more writes the ask into borrower_hint, never into the internal notes.
  await condReview.applyVerdict(db, {
    doc: accDoc,
    verdict: condReview.validateVerdict({ action: 'accept', requestMore: true, note: 'also the invoice' }, { canAccept: true }),
    actorId: staffId, hooks: spyHooks(),
  });
  const afterMore = await itemRow(appItem);
  assert(afterMore.status === 'outstanding' && /Still needed: also the invoice/.test(afterMore.borrower_hint || ''),
    'A23 request-more re-opens the condition and puts the ask in borrower_hint');

  // The refusals, in the order the door has always refused them.
  const refuses = (b2, opts, re) => {
    try { condReview.validateVerdict(b2, opts); return false; }
    catch (e) { return e.status && re.test(e.message); }
  };
  assert(refuses({ action: 'maybe' }, { canAccept: true }, /accept or reject/), 'A24 an unknown action is refused');
  assert(refuses({ action: 'accept' }, { canAccept: false }, /Only the processor/), 'A25 accepting needs the capability');
  assert(refuses({ action: 'reject' }, { canAccept: true }, /rejection reason is required/), 'A26 a rejection needs a reason');
  assert(refuses({ action: 'accept', requestMore: true }, { canAccept: true }, /what additional document/),
    'A27 accept-and-request-more needs a note');

  /* Delete: the row and the bytes go, and the condition RE-OPENS when nothing
     accepted is left.

     A29 USED TO ASSERT NOTHING, and it is worth saying why, because the shape
     recurs. A23 above leaves the item at 'outstanding'; the re-open UPDATE only
     fires for status IN ('received','issue','requested'). So the delete could not
     change anything and A29 merely re-read the state A23 had already set — deleting
     the ENTIRE re-open block from removeDocument left the suite green. A test that
     asserts a state the previous step already produced is testing the previous step.

     So: put the item somewhere the re-open has to MOVE it from, and assert the
     TRANSITION rather than the destination. */
  await db.query("UPDATE checklist_items SET status='received' WHERE id=$1", [appItem]);
  // Make the guard real: something accepted IS still on the condition.
  await db.query(
    `UPDATE documents SET review_status='accepted' WHERE id=(
       SELECT id FROM documents WHERE checklist_item_id=$1 AND is_current=true AND id<>$2 LIMIT 1)`,
    [appItem, add2.documentId]);
  const acceptedBefore = await db.query(
    `SELECT 1 FROM documents WHERE checklist_item_id=$1 AND is_current=true AND review_status='accepted' LIMIT 1`,
    [appItem]);
  assert(acceptedBefore.rows[0] && (await itemRow(appItem)).status === 'received',
    'A28a the condition starts at received WITH an accepted document still on it');

  const delDoc = await condRemove.loadDocument(db, add2.documentId);
  const delRes = await condRemove.removeDocument(db, { doc: delDoc, hooks: spyHooks() });
  assert(delRes.deleted === true && !(await docRow(add2.documentId)), 'A28 the delete really removes the row');
  // THE GUARD HALF: something accepted remains, so the condition must NOT re-open.
  assert((await itemRow(appItem)).status === 'received',
    'A29 a delete does NOT re-open the condition while an accepted document remains');

  /* THE RE-OPEN HALF. Now take the acceptance away and delete a document that IS the
     last of its kind, and the condition has to MOVE. Asserting the transition rather
     than the destination is the whole point: the previous version of A29 read back a
     status an earlier step had already set, so deleting the entire re-open block from
     removeDocument left it green. */
  await db.query("UPDATE documents SET review_status='pending' WHERE checklist_item_id=$1", [appItem]);
  const lastUp = await condUpload.uploadConditionDocument({}, {
    owner: APP, body: body({ checklistItemId: appItem, slot: 'Reopen probe' }),
    actorId: staffId, borrowerId, hooks: spyHooks(), q: db,
  });
  await db.query("UPDATE checklist_items SET status='received' WHERE id=$1", [appItem]);
  const lastDoc = await condRemove.loadDocument(db, lastUp.documentId);
  const lastRes = await condRemove.removeDocument(db, { doc: lastDoc, hooks: spyHooks() });
  assert(lastRes.deleted === true, 'A29a the last document really deletes');
  assert((await itemRow(appItem)).status === 'outstanding',
    'A29b …and with nothing accepted left the delete MOVED the condition received -> outstanding');

  /* ── THE ENTITY SLOT: NEITHER FILE OWNS IT ──────────────────────────────────
     An entity document belongs to the borrower's COMPANY, so both file-owner columns
     stay NULL and `llc_id` carries it — which is what lets one certificate of good
     standing follow the entity to every file it vests. This branch had no fixture at
     all: replacing `llcId ? {application_id:null, lt_loan_id:null} : ownerCols(owner)`
     with a plain `ownerCols(owner)` — which files the entity document against the
     APPLICATION and stops it following the entity anywhere — left the whole suite
     green, and four other suites besides. */
  const llcId = (await db.query(
    `INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,$2) RETURNING id`,
    [borrowerId, `Test Holdings ${uniq} LLC`])).rows[0].id;
  const llcItem = (await db.query(
    `INSERT INTO checklist_items (scope, llc_id, label, borrower_label, audience, status)
     VALUES ('llc',$1,'Certificate of good standing','Certificate of good standing','both','outstanding')
     RETURNING id`, [llcId])).rows[0].id;
  const upEntity = await condUpload.uploadConditionDocument({}, {
    owner: APP, body: body({ checklistItemId: llcItem }),
    actorId: staffId, borrowerId, llcId, hooks: spyHooks(), q: db,
  });
  const rowEntity = await docRow(upEntity.documentId);
  assert(rowEntity.application_id === null && rowEntity.lt_loan_id === null,
    'A30 an ENTITY-slot upload leaves BOTH file-owner columns NULL — the owner passed in is ignored');
  assert(rowEntity.llc_id === llcId,
    'A31 …and llc_id carries it, so the document follows the entity to every file it vests');

  /* ══════════════════ B. THE LONG-TERM SIDE LANDS ON ITS OWN OWNER ══════════ */

  const hooksLt = spyHooks();
  const upLt = await condUpload.uploadConditionDocument({}, {
    owner: LT, body: body({ checklistItemId: ltItem, slot: 'Statement' }),
    actorId: staffId, borrowerId, hooks: hooksLt, q: db,
  });
  const rowLt = await docRow(upLt.documentId);
  assert(rowLt.lt_loan_id === ltId && rowLt.application_id === null,
    'B1 a Long-Term upload lands with lt_loan_id set and application_id NULL');
  assert([rowLt.application_id, rowLt.lt_loan_id].filter((v) => v !== null).length === 1,
    'B2 exactly ONE file-owner column carries a value (by construction at the door — '
    + 'no constraint on `documents` enforces this)');
  assert(rowLt.checklist_item_id === ltItem && rowLt.slot_label === 'Statement' && rowLt.visibility === 'borrower',
    'B3 the same condition lookup, slot and visibility rules apply on the Long-Term side');
  assert((await itemRow(ltItem)).status === 'received',
    'B4 the evidence re-open works on an lt_loan condition');

  // A condition on the OTHER product is not found by an owner it does not belong to.
  let crossItem = null;
  try {
    await condUpload.uploadConditionDocument({}, {
      owner: LT, body: body({ checklistItemId: appItem }), actorId: staffId, borrowerId, hooks: spyHooks(), q: db,
    });
  } catch (e) { crossItem = e; }
  assert(crossItem && crossItem.status === 404,
    'B5 an RTL condition id is "not found on this file" for a Long-Term owner');

  /* ══════════════════ C. THE CROSS-OWNER IDOR ══════════════════════════════ */

  assert(await condReview.loadDocument(db, rowLt.id, LT), 'C1 the LT owner reaches its own document');
  assert((await condReview.loadDocument(db, rowLt.id, APP)) === null,
    'C2 REVIEW: an RTL owner reaches NOTHING for a Long-Term document id');
  assert((await condReview.loadDocument(db, ts2.documentId, LT)) === null,
    'C3 REVIEW: a Long-Term owner reaches NOTHING for an RTL document id');
  assert((await condReview.loadDocument(db, ts2.documentId, APP_B)) === null,
    'C4 REVIEW: another RTL FILE reaches nothing either — the scope is the owner, not the product');

  assert((await condServe.documentForServe(db, rowLt.id, APP)) === null,
    'C5 SERVE: an RTL owner cannot load a Long-Term document row');
  assert((await condServe.documentForServe(db, ts2.documentId, LT)) === null,
    'C6 SERVE: a Long-Term owner cannot load an RTL document row');
  const servedUnscoped = await condServe.documentForServe(db, ts2.documentId);
  assert(servedUnscoped && servedUnscoped.id === ts2.documentId,
    'C7 SERVE: with NO owner the lookup is by id, exactly as the RTL staff door has always done');

  // The delete refuses across owners and the row survives — reported honestly,
  // never as a success that never happened.
  const ltDocForDelete = await condRemove.loadDocument(db, rowLt.id);
  const crossDel = await condRemove.removeDocument(db, { doc: ltDocForDelete, owner: APP, hooks: {} });
  assert(crossDel.deleted === false, 'C8 REMOVE: an owner-scoped delete of the other product reports deleted:false');
  assert(!!(await docRow(rowLt.id)), 'C9 …and the document is still there');
  const ownDel = await condRemove.removeDocument(db, { doc: ltDocForDelete, owner: LT, hooks: {} });
  assert(ownDel.deleted === true && !(await docRow(rowLt.id)), 'C10 …while its OWN owner deletes it');

  /* ══════════════════ D. THE TWO OWNERS NEVER COLLIDE ══════════════════════ */

  // The SAME person uploads the SAME bytes, same filename, same slot, minutes
  // apart — once to the RTL file, once to the Long-Term loan.
  const shared = { filename: 'same-name.pdf', contentType: 'application/pdf', dataBase64: b64('exactly-the-same-bytes'), slot: 'Same slot' };
  const dApp = await condUpload.uploadConditionDocument({}, {
    owner: APP, body: { ...shared }, actorId: staffId, borrowerId, hooks: spyHooks(), q: db,
  });
  const dLt = await condUpload.uploadConditionDocument({}, {
    owner: LT, body: { ...shared }, actorId: staffId, borrowerId, hooks: spyHooks(), q: db,
  });
  assert(dApp.deduped === false && dLt.deduped === false && dApp.documentId !== dLt.documentId,
    'D1 the two products NEVER de-duplicate against each other');
  assert((await docRow(dApp.documentId)).application_id === appId
      && (await docRow(dLt.documentId)).lt_loan_id === ltId,
    'D2 …and each lands on its own owner');
  // The same upload REPEATED on the same owner still dedupes — the guard was
  // narrowed by the owner, not switched off.
  const dLt2 = await condUpload.uploadConditionDocument({}, {
    owner: LT, body: { ...shared }, actorId: staffId, borrowerId, hooks: spyHooks(), q: db,
  });
  assert(dLt2.deduped === true && dLt2.documentId === dLt.documentId,
    'D3 …while a repeat on the SAME owner still collapses');

  // THE TERM THIS RULE IS REALLY ABOUT: two DIFFERENT Long-Term loans. Both carry
  // application_id NULL, so the application column cannot tell their documents
  // apart — `lt_loan_id` is the only thing that can, and without it one loan's
  // document would answer for the other's.
  const ltIdB = (await db.query(
    `INSERT INTO lt_loans (id, loan_number, borrower_name) VALUES ($1::uuid,$2,'Bo Rrower') RETURNING id`,
    [require('crypto').randomUUID(), `YSCAP-${uniq}-B`])).rows[0].id;
  const LT_B = ownerOf('lt_loan', ltIdB);
  const dLtA2 = await condUpload.uploadConditionDocument({}, {
    owner: LT, body: { ...shared, filename: 'two-loans.pdf' }, actorId: staffId, borrowerId, hooks: spyHooks(), q: db,
  });
  const dLtB = await condUpload.uploadConditionDocument({}, {
    owner: LT_B, body: { ...shared, filename: 'two-loans.pdf' }, actorId: staffId, borrowerId, hooks: spyHooks(), q: db,
  });
  assert(dLtB.deduped === false && dLtB.documentId !== dLtA2.documentId,
    'D3b two DIFFERENT Long-Term loans never de-duplicate against each other');
  assert((await docRow(dLtB.documentId)).lt_loan_id === ltIdB,
    'D3c …and the second lands on its own loan');

  // One-current supersede is owner-scoped: a Long-Term term sheet may not retire
  // the RTL file's current one.
  const ltTs = await condUpload.uploadConditionDocument({}, {
    owner: LT, body: body({ docKind: 'term_sheet' }), actorId: staffId, borrowerId, hooks: spyHooks(), q: db,
  });
  assert((await docRow(ts2.documentId)).is_current === true,
    'D4 a Long-Term term sheet does NOT supersede the RTL file\'s current one');
  assert((await docRow(ltTs.documentId)).is_current === true, 'D5 …and its own is current');

  /* ══════════════════ E. THE DEFAULT HOOK SET ═════════════════════════════ */

  assert(condHooks.defaultHooks(APP) === condHooks.RTL,
    'E1 the RTL hook set is the default for an application owner');
  assert(Object.keys(condHooks.defaultHooks(LT)).length === 0,
    'E2 …and NOTHING is the default for a Long-Term owner');
  assert(Object.keys(condHooks.defaultHooks(null)).length === 0,
    'E3 …and for an owner nobody named');

  // Proven at the door, not only on the hook table: with no hooks passed, an RTL
  // upload really writes the borrower's notification and a Long-Term one does not.
  //
  // HONEST NOTE, MEASURED: E4 is the assertion that BITES here — with the default
  // set wrongly emptied, an RTL upload stops notifying and E4 goes red. E5 is
  // necessary but NOT sufficient on its own: `notify.notifyBorrower` is
  // best-effort, and a Long-Term id in `applications`-shaped notification would
  // fail its own foreign key and be swallowed, so "no row appeared" cannot by
  // itself tell "no hook ran" from "a hook ran and its write failed". E2/E3 are
  // what pin the rule, and a mutation making the RTL set the default for every
  // owner was run and fails them.
  const notesBefore = Number((await db.query(
    `SELECT count(*) c FROM notifications WHERE borrower_id=$1`, [borrowerId])).rows[0].c);
  await condUpload.uploadConditionDocument({}, {
    owner: APP, body: body({ checklistItemId: appItem, slot: 'Default hooks' }),
    actorId: staffId, borrowerId, q: db,     // NO hooks — the default must be RTL's
  });
  const notesAfterApp = Number((await db.query(
    `SELECT count(*) c FROM notifications WHERE borrower_id=$1`, [borrowerId])).rows[0].c);
  await condUpload.uploadConditionDocument({}, {
    owner: LT, body: body({ checklistItemId: ltItem, slot: 'Default hooks' }),
    actorId: staffId, borrowerId, q: db,     // NO hooks — the default must be NOTHING
  });
  const notesAfterLt = Number((await db.query(
    `SELECT count(*) c FROM notifications WHERE borrower_id=$1`, [borrowerId])).rows[0].c);
  assert(notesAfterApp === notesBefore + 1,
    'E4 with no hooks named, an RTL upload still notifies the borrower (no call site changed)');
  assert(notesAfterLt === notesAfterApp,
    'E5 …and a Long-Term upload notifies nobody — RTL machinery never fires by omission');

  /* ───────────────────────────────── tidy ─────────────────────────────────── */
  await db.query(`DELETE FROM documents WHERE application_id = ANY($1::uuid[]) OR lt_loan_id = $2::uuid`,
    [[appId, appIdB], ltId]);
  await db.query(`DELETE FROM checklist_items WHERE application_id = ANY($1::uuid[]) OR lt_loan_id = $2::uuid`,
    [[appId, appIdB], ltId]);
  await db.query(`DELETE FROM notifications WHERE borrower_id=$1`, [borrowerId]);
  await db.query(`DELETE FROM documents WHERE lt_loan_id = $1::uuid`, [ltIdB]);
  await db.query(`DELETE FROM lt_loans WHERE id = ANY($1::uuid[])`, [[ltId, ltIdB]]);
  await db.query(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [[appId, appIdB]]);
  await db.query(`DELETE FROM borrowers WHERE id=$1::uuid`, [borrowerId]);
  await db.query(`DELETE FROM staff_users WHERE id=$1::uuid`, [staffId]);

  console.log(failures ? `\nFAILURES: ${failures}` : '\ntest-lt-condition-docs-shared-db: all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
