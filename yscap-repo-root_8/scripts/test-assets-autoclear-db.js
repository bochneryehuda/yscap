'use strict';
/**
 * DB test for the liquid-assets condition auto-clear (IG-W5,
 * src/lib/underwriting/assets-autoclear.js).
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-assets-autoclear-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-assets-autoclear-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const cfg = require('../src/config');
const { ensureSchema } = require('../src/migrate-boot');
const {
  assetsCompleteness, maybeAutoSatisfyAssets, assetsItemId,
} = require('../src/lib/underwriting/assets-autoclear');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const LAST = `Aztest${process.pid}`;

// Seed a file with the assets condition. required=null leaves tool_payload empty (no requirement).
async function seedFile(first, required) {
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ($1,$2,$3) RETURNING id`,
    [first, LAST, `assets_${first}_${process.pid}@example.com`])).rows[0];
  const app = (await db.query('INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id', [bor.id])).rows[0];
  const payload = required != null ? JSON.stringify({ liquidity: { required } }) : null;
  const item = (await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, borrower_label, audience, item_kind, role_scope, phase, is_required, application_id, status, tool_payload)
     SELECT t.id, t.scope, t.label, t.label, t.audience, t.item_kind, COALESCE(t.role_scope,'underwriter'),
            t.phase, COALESCE(t.is_required,true), $1, 'outstanding', $2::jsonb
       FROM checklist_templates t WHERE t.code='rtl_p3_assets' RETURNING id`, [app.id, payload])).rows[0];
  return { borId: bor.id, appId: app.id, itemId: item.id, holder: `${first} ${LAST}` };
}

// Attach an AI-read bank statement. holder defaults to the borrower's own name (ties); pass a
// different holder to simulate an untied account.
async function attachStatement(appId, itemId, { holder, balance, readable = true } = {}) {
  const doc = (await db.query(
    `INSERT INTO documents (application_id, checklist_item_id, filename, doc_kind, visibility, review_status, is_current, slot_label, storage_ref)
     VALUES ($1,$2,'bank.pdf','bank_statement','staff_only','accepted',true,'Bank statement','x/y') RETURNING id`,
    [appId, itemId])).rows[0];
  const fields = JSON.stringify({ accountHolderName: holder, bankName: 'Chase', accountNumber: '1234', closingBalance: balance, readable });
  await db.query(
    `INSERT INTO document_extractions (document_id, application_id, doc_type, status, confidence, is_current, superseded, fields)
     VALUES ($1,$2,'bank_statement','analyzed','definite',true,false,$3::jsonb)`, [doc.id, appId, fields]);
  return doc.id;
}

async function condRow(itemId) {
  return (await db.query('SELECT status, signed_off_at, signed_off_by, notes FROM checklist_items WHERE id=$1', [itemId])).rows[0];
}

(async () => {
  await ensureSchema();
  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Assets Tester','underwriter',true) RETURNING id`,
    [`assetsstaff_${process.pid}@example.com`])).rows[0];

  // ── 1) sufficient liquid assets → complete; switch OFF no-op, switch ON clears.
  cfg.assetsAutoclearEnabled = false;
  const f1 = await seedFile('Suff', 50000);
  await attachStatement(f1.appId, f1.itemId, { holder: f1.holder, balance: 80000 });
  ok((await assetsCompleteness(db, f1.appId)).complete === true, 'assets covering the requirement → complete');
  const off = await maybeAutoSatisfyAssets(db, f1.appId, f1.itemId);
  ok(off.enabled === false && off.satisfied === false, 'switch OFF → no auto-clear');
  ok((await condRow(f1.itemId)).status === 'outstanding', 'switch OFF → condition untouched');
  cfg.assetsAutoclearEnabled = true;
  const on = await maybeAutoSatisfyAssets(db, f1.appId, f1.itemId);
  ok(on.satisfied === true, 'switch ON + sufficient → auto-clears');
  const r1 = await condRow(f1.itemId);
  ok(r1.status === 'satisfied' && r1.signed_off_by === null && (r1.notes || '').startsWith('[auto]'),
    'auto-clear is a system sign-off (satisfied, signed_off_by NULL, [auto] note)');

  // ── 2) an open FATAL bank finding → not complete; a prior auto-clear REOPENS.
  await db.query(
    `INSERT INTO document_findings (application_id, document_id, source, code, severity, status, blocks_ctc)
     SELECT $1, d.id, 'bank_statement','bank_account_not_borrower','fatal','open',true
       FROM documents d WHERE d.application_id=$1 AND d.doc_kind='bank_statement' AND d.is_current LIMIT 1`, [f1.appId]);
  ok((await assetsCompleteness(db, f1.appId)).complete === false, 'an open fatal bank finding → not complete');
  const reopen = await maybeAutoSatisfyAssets(db, f1.appId, f1.itemId);
  ok(reopen.reopened === true, 'a dirty re-read reopens the prior auto-clear');
  ok((await condRow(f1.itemId)).status === 'received', 'reopened condition is back to received');

  // ── 3) no bank statement at all → not complete.
  const f3 = await seedFile('Empty', 50000);
  ok((await assetsCompleteness(db, f3.appId)).complete === false, 'no bank statement → not complete');

  // ── 4) no required-liquidity on file (no product registered) → not complete, defer to a human.
  const f4 = await seedFile('NoReq', null);
  await attachStatement(f4.appId, f4.itemId, { holder: f4.holder, balance: 80000 });
  const c4 = await assetsCompleteness(db, f4.appId);
  ok(c4.complete === false && c4.reason === 'no_requirement', 'no required liquidity → not complete (defer to a human)');

  // ── 5) assets SHORT of the requirement → not complete; never auto-cleared.
  const f5 = await seedFile('Short', 50000);
  await attachStatement(f5.appId, f5.itemId, { holder: f5.holder, balance: 30000 });
  const c5 = await assetsCompleteness(db, f5.appId);
  ok(c5.complete === false && c5.reason === 'insufficient_or_datagap', 'assets short of the requirement → not complete');
  ok((await maybeAutoSatisfyAssets(db, f5.appId, f5.itemId)).satisfied === false, 'a short file is never auto-cleared');

  // ── 5b) balance sits in an UNTIED account (not the borrower) → not complete (no countable tied balance).
  const f5b = await seedFile('Untied', 50000);
  await attachStatement(f5b.appId, f5b.itemId, { holder: 'Some Stranger', balance: 80000 });
  ok((await assetsCompleteness(db, f5b.appId)).complete === false, 'money in an account not tied to the borrower does not count');

  // ── 6) a non-assets condition is never touched.
  const bad = (await db.query(
    `INSERT INTO checklist_items (scope, application_id, label, audience, item_kind, status, created_by_kind)
     VALUES ('application',$1,'Other','staff','document','outstanding','system') RETURNING id`, [f1.appId])).rows[0];
  ok((await maybeAutoSatisfyAssets(db, f1.appId, bad.id)).reason === 'not_assets_condition', 'a non-assets condition is refused');

  // ── 7) a HUMAN sign-off is never touched by the auto-clear.
  const f7 = await seedFile('Human', 50000);
  await attachStatement(f7.appId, f7.itemId, { holder: f7.holder, balance: 30000 });   // short, so completeness is false
  await db.query(
    `UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2, notes='cleared by hand' WHERE id=$1`,
    [f7.itemId, staff.id]);
  const h = await maybeAutoSatisfyAssets(db, f7.appId, f7.itemId);
  ok(h.reason === 'human_signed_off' && h.reopened === false, 'a human sign-off is never reopened by the auto-clear');

  // cleanup
  cfg.assetsAutoclearEnabled = false;
  for (const appId of [f1.appId, f3.appId, f4.appId, f5.appId, f5b.appId, f7.appId]) {
    await db.query('DELETE FROM document_findings WHERE application_id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM document_extractions WHERE application_id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM documents WHERE application_id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM checklist_items WHERE application_id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM applications WHERE id=$1', [appId]).catch(() => {});
  }
  await db.query("DELETE FROM borrowers WHERE email LIKE $1", [`assets_%_${process.pid}@example.com`]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE id=$1', [staff.id]).catch(() => {});

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  assets-autoclear-db: sufficient signal, on/off, dirty-reopen, empty guard, no-requirement guard, short guard, untied-account guard, non-assets refusal, human-signoff — all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
