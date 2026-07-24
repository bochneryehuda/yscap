'use strict';
/**
 * DB test for the background/OFAC condition auto-clear (IG-W12,
 * src/lib/underwriting/fraud-autoclear.js).
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-fraud-autoclear-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-fraud-autoclear-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const cfg = require('../src/config');
const { ensureSchema } = require('../src/migrate-boot');
const {
  fraudCompleteness, maybeAutoSatisfyFraud, fraudItemId,
} = require('../src/lib/underwriting/fraud-autoclear');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

async function seedFile(first) {
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ($1,'Fraud',$2) RETURNING id`,
    [first, `fraud_${first}_${process.pid}@example.com`])).rows[0];
  const app = (await db.query('INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id', [bor.id])).rows[0];
  const item = (await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, borrower_label, audience, item_kind, role_scope, phase, is_required, application_id, status)
     SELECT t.id, t.scope, t.label, t.label, t.audience, t.item_kind, COALESCE(t.role_scope,'underwriter'),
            t.phase, COALESCE(t.is_required,true), $1, 'outstanding'
       FROM checklist_templates t WHERE t.code='rtl_cond_fraud' RETURNING id`, [app.id])).rows[0];
  return { borId: bor.id, appId: app.id, itemId: item.id };
}

// Attach an AI-read background report to a file. clean=false → an open fatal OFAC finding.
// ofac controls the extracted ofacResult ('clear' for a clean read, or null to
// simulate a report whose OFAC section was never captured).
async function attachReport(appId, itemId, { clean = true, ofac = 'clear' } = {}) {
  const doc = (await db.query(
    `INSERT INTO documents (application_id, checklist_item_id, filename, doc_kind, visibility, review_status, is_current, slot_label, storage_ref)
     VALUES ($1,$2,'background.pdf','background_report','staff_only','accepted',true,'Background report','x/y') RETURNING id`,
    [appId, itemId])).rows[0];
  const fields = JSON.stringify(ofac == null ? { subjectName: 'Test Borrower', readable: true } : { subjectName: 'Test Borrower', ofacResult: ofac, readable: true });
  await db.query(
    `INSERT INTO document_extractions (document_id, application_id, doc_type, status, confidence, is_current, superseded, fields)
     VALUES ($1,$2,'background_report','analyzed','definite',true,false,$3::jsonb)`, [doc.id, appId, fields]);
  if (!clean) {
    await db.query(
      `INSERT INTO document_findings (application_id, document_id, source, code, severity, status, blocks_ctc)
       VALUES ($1,$2,'background_report','ofac_confirmed_match','fatal','open',true)`, [appId, doc.id]);
  }
  return doc.id;
}

async function condRow(itemId) {
  return (await db.query('SELECT status, signed_off_at, signed_off_by, notes FROM checklist_items WHERE id=$1', [itemId])).rows[0];
}
async function registerGold(appId) {
  // product_registrations.inputs + quote are NOT NULL (jsonb) — seed a valid row.
  await db.query(
    `INSERT INTO product_registrations (application_id, program, inputs, quote, is_current)
     VALUES ($1,'gold','{}'::jsonb,'{}'::jsonb,true)`, [appId]);
}

(async () => {
  await ensureSchema();
  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Fraud Tester','underwriter',true) RETURNING id`,
    [`fraudstaff_${process.pid}@example.com`])).rows[0];

  // ── 1) clean report → complete; switch OFF no-op, switch ON clears.
  cfg.fraudAutoclearEnabled = false;
  const f1 = await seedFile('Clean');
  await attachReport(f1.appId, f1.itemId, { clean: true });
  ok((await fraudCompleteness(db, f1.appId, f1.itemId)).complete === true, 'a clean background/OFAC report → complete');
  const off = await maybeAutoSatisfyFraud(db, f1.appId, f1.itemId);
  ok(off.enabled === false && off.satisfied === false, 'switch OFF → no auto-clear');
  ok((await condRow(f1.itemId)).status === 'outstanding', 'switch OFF → condition untouched');
  cfg.fraudAutoclearEnabled = true;
  const on = await maybeAutoSatisfyFraud(db, f1.appId, f1.itemId);
  ok(on.satisfied === true, 'switch ON + clean → auto-clears');
  const r1 = await condRow(f1.itemId);
  ok(r1.status === 'satisfied' && r1.signed_off_by === null && (r1.notes || '').startsWith('[auto]'),
    'auto-clear is a system sign-off (satisfied, signed_off_by NULL, [auto] note)');

  // ── 2) a fatal OFAC finding → not complete; a prior auto-clear REOPENS.
  await db.query(
    `INSERT INTO document_findings (application_id, document_id, source, code, severity, status, blocks_ctc)
     SELECT $1, d.id, 'background_report','ofac_confirmed_match','fatal','open',true
       FROM documents d WHERE d.application_id=$1 AND d.doc_kind='background_report' AND d.is_current LIMIT 1`, [f1.appId]);
  ok((await fraudCompleteness(db, f1.appId, f1.itemId)).complete === false, 'an open OFAC finding → not complete');
  const reopen = await maybeAutoSatisfyFraud(db, f1.appId, f1.itemId);
  ok(reopen.reopened === true, 'a dirty re-read reopens the prior auto-clear');
  ok((await condRow(f1.itemId)).status === 'received', 'reopened condition is back to received');

  // ── 3) no report at all → not complete.
  const f3 = await seedFile('Empty');
  ok((await fraudCompleteness(db, f3.appId, f3.itemId)).complete === false, 'no background report → not complete');

  // ── 3b) a report whose OFAC section was NEVER captured (ofacResult null, readable,
  //        no finding) → NOT complete. "Clean" requires an affirmative OFAC clear,
  //        not merely the absence of a finding (never-false-clear).
  const f3b = await seedFile('NullOfac');
  await attachReport(f3b.appId, f3b.itemId, { clean: true, ofac: null });
  const c3b = await fraudCompleteness(db, f3b.appId, f3b.itemId);
  ok(c3b.complete === false && c3b.reason === 'no_clean_read', 'a report with no OFAC result (null) is NOT complete — affirmative clear required');
  ok((await maybeAutoSatisfyFraud(db, f3b.appId, f3b.itemId)).satisfied === false, 'a null-OFAC report is never auto-cleared');

  // ── 4) Gold file needs the criminal slot too.
  const f4 = await seedFile('Gold');
  await attachReport(f4.appId, f4.itemId, { clean: true });
  await registerGold(f4.appId);
  const g1 = await fraudCompleteness(db, f4.appId, f4.itemId);
  ok(g1.complete === false && g1.reason === 'gold_criminal_missing', 'a Gold file with a clean report but NO criminal slot → not complete');
  await db.query(
    `INSERT INTO documents (application_id, checklist_item_id, filename, doc_kind, visibility, review_status, is_current, slot_label, storage_ref)
     VALUES ($1,$2,'criminal.pdf','background_report','staff_only','accepted',true,'Criminal report','x/z')`, [f4.appId, f4.itemId]);
  ok((await fraudCompleteness(db, f4.appId, f4.itemId)).complete === true, 'Gold file + clean report + criminal slot → complete');

  // ── 5) a non-fraud condition is never touched.
  const bad = (await db.query(
    `INSERT INTO checklist_items (scope, application_id, label, audience, item_kind, status, created_by_kind)
     VALUES ('application',$1,'Other','staff','document','outstanding','system') RETURNING id`, [f1.appId])).rows[0];
  ok((await maybeAutoSatisfyFraud(db, f1.appId, bad.id)).reason === 'not_fraud_condition', 'a non-fraud condition is refused');

  // ── 6) a HUMAN sign-off is never touched by the auto-clear.
  const f6 = await seedFile('Human');
  await attachReport(f6.appId, f6.itemId, { clean: false });   // dirty, so completeness is false
  await db.query(
    `UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2, notes='cleared by hand' WHERE id=$1`,
    [f6.itemId, staff.id]);
  const h = await maybeAutoSatisfyFraud(db, f6.appId, f6.itemId);
  ok(h.reason === 'human_signed_off' && h.reopened === false, 'a human sign-off is never reopened by the auto-clear');

  // cleanup
  cfg.fraudAutoclearEnabled = false;
  for (const appId of [f1.appId, f3.appId, f3b.appId, f4.appId, f6.appId]) {
    await db.query('DELETE FROM document_findings WHERE application_id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM document_extractions WHERE application_id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM documents WHERE application_id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM product_registrations WHERE application_id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM checklist_items WHERE application_id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM applications WHERE id=$1', [appId]).catch(() => {});
  }
  await db.query("DELETE FROM borrowers WHERE email LIKE $1", [`fraud_%_${process.pid}@example.com`]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE id=$1', [staff.id]).catch(() => {});

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  fraud-autoclear-db: clean signal, on/off, dirty-reopen, empty guard, Gold criminal-slot, non-fraud refusal, human-signoff — all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
