'use strict';
/**
 * DB test for the government-ID condition auto-clear (IG-W3,
 * src/lib/underwriting/gov-id-autoclear.js + the db/287 co-borrower-change trigger).
 *
 * Proves the never-false-clear discipline:
 *   • a borrower whose photo ID was AI-read on THIS file (analyzed government_id
 *     extraction, no open ID finding) → verified → with the env switch ON the
 *     condition auto-clears (system sign-off, [auto] note); with the switch OFF it
 *     stays put.
 *   • an OPEN government_id finding (name mismatch) → NOT verified; and a prior
 *     auto-clear that goes dirty is REOPENED (self-correcting).
 *   • an UNREADABLE read → NOT verified.
 *   • NO per-file extraction (reused ID never read on this file) → NOT verified
 *     (link-only; never a blind clear off the profile pointer).
 *   • a rejected / non-current ID document → NOT verified.
 *   • db/287: changing the co-borrower REOPENS an auto-cleared gov-ID condition.
 *   • a HUMAN sign-off is never touched.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-gov-id-autoclear-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-gov-id-autoclear-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const cfg = require('../src/config');
const { ensureSchema } = require('../src/migrate-boot');
const {
  govIdVerifiedForBorrower, govIdCompleteness, maybeAutoSatisfyGovId,
} = require('../src/lib/underwriting/gov-id-autoclear');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// Seed a file with a borrower + the rtl_p1_id gov-ID condition. Returns ids.
async function seedFile(first) {
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ($1,'GovId',$2) RETURNING id`,
    [first, `govid_${first}_${process.pid}@example.com`])).rows[0];
  const app = (await db.query('INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id', [bor.id])).rows[0];
  const item = (await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, borrower_label, audience, item_kind, role_scope, phase, is_required, application_id, status)
     SELECT t.id, t.scope, t.label, t.label, t.audience, t.item_kind, COALESCE(t.role_scope,'loan_officer'),
            t.phase, COALESCE(t.is_required,true), $1, 'outstanding'
       FROM checklist_templates t WHERE t.code='rtl_p1_id' RETURNING id`, [app.id])).rows[0];
  return { borId: bor.id, appId: app.id, itemId: item.id };
}

// Attach an AI-read government ID to a borrower on a file. When clean=false, also
// records an open fatal government_id finding (a name mismatch).
async function attachReadId(appId, borrowerId, { clean = true, confidence = 'definite', current = true, rejected = false } = {}) {
  const doc = (await db.query(
    `INSERT INTO documents (borrower_id, filename, content_type, doc_kind, visibility, review_status, is_current, storage_ref)
     VALUES ($1,'gov-id.jpg','image/jpeg','photo_id','staff_only',$2,$3,'x/y') RETURNING id`,
    [borrowerId, rejected ? 'rejected' : 'accepted', current])).rows[0];
  await db.query('UPDATE borrowers SET photo_id_document_id=$2 WHERE id=$1', [borrowerId, doc.id]);
  await db.query(
    `INSERT INTO document_extractions (document_id, application_id, borrower_id, doc_type, status, confidence, is_current, superseded)
     VALUES ($1,$2,$3,'government_id','analyzed',$4,true,false)`, [doc.id, appId, borrowerId, confidence]);
  if (!clean) {
    await db.query(
      `INSERT INTO document_findings (application_id, borrower_id, document_id, source, code, severity, status, blocks_ctc)
       VALUES ($1,$2,$3,'government_id','id_name_mismatch','fatal','open',true)`, [appId, borrowerId, doc.id]);
  }
  return doc.id;
}

async function condRow(itemId) {
  return (await db.query('SELECT status, signed_off_at, signed_off_by, notes FROM checklist_items WHERE id=$1', [itemId])).rows[0];
}

(async () => {
  await ensureSchema();
  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'GovId Tester','underwriter',true) RETURNING id`,
    [`govidstaff_${process.pid}@example.com`])).rows[0];

  // ── 1) A clean AI-read ID → verified; switch OFF leaves it, switch ON clears it.
  cfg.govIdAutoclearEnabled = false;
  const f1 = await seedFile('Clean');
  await attachReadId(f1.appId, f1.borId, { clean: true });
  ok(await govIdVerifiedForBorrower(db, f1.appId, f1.borId) === true, 'a clean AI-read ID is verified for the borrower');
  const c1 = await govIdCompleteness(db, f1.appId, null);
  ok(c1.complete === true && c1.need.length === 1, 'single-borrower file with a clean read → complete');
  const off = await maybeAutoSatisfyGovId(db, f1.appId, f1.itemId, null);
  ok(off.enabled === false && off.satisfied === false, 'switch OFF → no auto-clear');
  ok((await condRow(f1.itemId)).status === 'outstanding', 'switch OFF → condition untouched');

  cfg.govIdAutoclearEnabled = true;
  const on = await maybeAutoSatisfyGovId(db, f1.appId, f1.itemId, null);
  ok(on.satisfied === true, 'switch ON + verified → auto-clears');
  const r1 = await condRow(f1.itemId);
  ok(r1.status === 'satisfied' && r1.signed_off_at && r1.signed_off_by === null && (r1.notes || '').startsWith('[auto]'),
    'auto-clear is a SYSTEM sign-off (satisfied, signed_off_by NULL, [auto] note)');
  // idempotent
  const again = await maybeAutoSatisfyGovId(db, f1.appId, f1.itemId, null);
  ok(again.satisfied === false && again.reason === 'already_satisfied', 'a second pass is a no-op (already satisfied)');

  // ── 2) A prior auto-clear that goes DIRTY is REOPENED (self-correcting).
  await db.query(
    `INSERT INTO document_findings (application_id, borrower_id, document_id, source, code, severity, status, blocks_ctc)
     SELECT $1,$2,b.photo_id_document_id,'government_id','id_dob_mismatch','fatal','open',true
       FROM borrowers b WHERE b.id=$2`, [f1.appId, f1.borId]);
  ok(await govIdVerifiedForBorrower(db, f1.appId, f1.borId) === false, 'an open fatal ID finding → no longer verified');
  const reopen = await maybeAutoSatisfyGovId(db, f1.appId, f1.itemId, null);
  ok(reopen.reopened === true && reopen.satisfied === false, 'a dirty re-read reopens the prior auto-clear');
  ok((await condRow(f1.itemId)).status === 'received', 'reopened condition is back to received');

  // ── 3) UNREADABLE read → not verified.
  cfg.govIdAutoclearEnabled = true;
  const f3 = await seedFile('Unread');
  await attachReadId(f3.appId, f3.borId, { clean: true, confidence: 'unreadable' });
  ok(await govIdVerifiedForBorrower(db, f3.appId, f3.borId) === false, 'an unreadable read is not verified');
  const m3 = await maybeAutoSatisfyGovId(db, f3.appId, f3.itemId, null);
  ok(m3.satisfied === false && m3.reason === 'incomplete', 'unreadable ID → not auto-cleared');

  // ── 4) NO per-file extraction (reused ID, never read on THIS file) → not verified.
  const f4 = await seedFile('Reuse');
  // give the borrower a current photo ID doc + pointer, but NO extraction for this app
  const doc4 = (await db.query(
    `INSERT INTO documents (borrower_id, filename, doc_kind, visibility, review_status, is_current, storage_ref)
     VALUES ($1,'gov-id.jpg','photo_id','staff_only','accepted',true,'x/y') RETURNING id`, [f4.borId])).rows[0];
  await db.query('UPDATE borrowers SET photo_id_document_id=$2 WHERE id=$1', [f4.borId, doc4.id]);
  ok(await govIdVerifiedForBorrower(db, f4.appId, f4.borId) === false, 'a reused ID never AI-read on this file is NOT verified (link-only)');
  ok((await maybeAutoSatisfyGovId(db, f4.appId, f4.itemId, null)).satisfied === false, 'reused-unread ID → never auto-cleared');

  // ── 5) A rejected / non-current ID document → not verified.
  const f5 = await seedFile('Rejected');
  await attachReadId(f5.appId, f5.borId, { clean: true, rejected: true });
  ok(await govIdVerifiedForBorrower(db, f5.appId, f5.borId) === false, 'a rejected ID document is not verified');

  // ── 6) db/287: changing the co-borrower REOPENS an auto-cleared gov-ID condition.
  cfg.govIdAutoclearEnabled = true;
  const f6 = await seedFile('Reopen');
  await attachReadId(f6.appId, f6.borId, { clean: true });
  await maybeAutoSatisfyGovId(db, f6.appId, f6.itemId, null);
  ok((await condRow(f6.itemId)).status === 'satisfied', 'baseline: file-level gov-ID auto-cleared');
  const co6 = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Co6','GovId',$1) RETURNING id`,
    [`govid_co6_${process.pid}@example.com`])).rows[0];
  await db.query('UPDATE applications SET co_borrower_id=$2 WHERE id=$1', [f6.appId, co6.id]);
  const r6 = await condRow(f6.itemId);
  ok(r6.status === 'received' && r6.signed_off_at === null,
    'db/287: adding a co-borrower REOPENS the auto-cleared gov-ID condition');

  // ── 6b) db/287 must NOT reopen a HUMAN sign-off.
  const f6h = await seedFile('Human');
  await db.query(
    `UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2, notes='cleared by hand'
      WHERE id=$1`,
    [f6h.itemId, staff.id]);   // a real staff sign-off
  const coH = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('CoH','GovId',$1) RETURNING id`,
    [`govid_coh_${process.pid}@example.com`])).rows[0];
  await db.query('UPDATE applications SET co_borrower_id=$2 WHERE id=$1', [f6h.appId, coH.id]);
  ok((await condRow(f6h.itemId)).status === 'satisfied', 'db/287: a HUMAN sign-off is NOT reopened by a co-borrower change');

  // ── 7) maybeAutoSatisfyGovId refuses a non-gov-ID condition.
  const badItem = (await db.query(
    `INSERT INTO checklist_items (scope, application_id, label, audience, item_kind, status, created_by_kind)
     VALUES ('application',$1,'Something else','staff','document','outstanding','system') RETURNING id`, [f1.appId])).rows[0];
  const bad = await maybeAutoSatisfyGovId(db, f1.appId, badItem.id, null);
  ok(bad.satisfied === false && bad.reason === 'not_gov_id_condition', 'a non-gov-ID condition is never touched');

  // cleanup
  cfg.govIdAutoclearEnabled = false;
  for (const appId of [f1.appId, f3.appId, f4.appId, f5.appId, f6.appId, f6h.appId]) {
    await db.query('UPDATE applications SET co_borrower_id=NULL WHERE id=$1', [appId]).catch(() => {});
    await db.query('UPDATE borrowers SET photo_id_document_id=NULL WHERE id IN (SELECT borrower_id FROM applications WHERE id=$1)', [appId]).catch(() => {});
    await db.query('DELETE FROM document_findings WHERE application_id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM document_extractions WHERE application_id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM documents WHERE application_id=$1 OR borrower_id IN (SELECT borrower_id FROM applications WHERE id=$1)', [appId]).catch(() => {});
    await db.query('DELETE FROM checklist_items WHERE application_id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM applications WHERE id=$1', [appId]).catch(() => {});
  }
  await db.query("DELETE FROM borrowers WHERE email LIKE $1", [`govid_%_${process.pid}@example.com`]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE id=$1', [staff.id]).catch(() => {});

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  gov-id-autoclear-db: verify signal, auto-clear on/off, dirty-reopen, unreadable/reuse/rejected guards, db/287 reopen — all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
