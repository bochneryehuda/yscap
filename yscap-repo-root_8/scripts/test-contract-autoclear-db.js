'use strict';
/**
 * DB test for the purchase-contract condition auto-clear (IG-W7,
 * src/lib/underwriting/contract-autoclear.js + the db/292 economics-change trigger).
 *
 * Proves the never-false-clear discipline end to end:
 *   • contract READ (a current analyzed purchase_contract extraction) + NO open fatal
 *     contract finding → complete → with the switch ON the condition auto-clears
 *     (system sign-off, signed_off_by NULL, [auto] note); with the switch OFF it stays.
 *   • an open FATAL purchase_contract finding (price/address/buyer mismatch) → NOT
 *     complete → never auto-cleared (the reconciliation doesn't tie out).
 *   • a WARNING finding (assignment math / fee-over-cap advisory) does NOT block.
 *   • no contract extraction on file → NOT complete.
 *   • an unreadable extraction (confidence='unreadable') does NOT count as read.
 *   • an ASSIGNMENT file needs BOTH the purchase_contract AND the assignment extraction;
 *     an open fatal from the assignment doc (source 'assignment') blocks too.
 *   • db/292: changing purchase_price / property_address / assignment economics REOPENS
 *     an auto-cleared condition; a HUMAN sign-off is never touched.
 *   • the store hook (saveAnalysis of a purchase_contract → autoClearContractCondition)
 *     clears live.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-contract-autoclear-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-contract-autoclear-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const cfg = require('../src/config');
const { ensureSchema } = require('../src/migrate-boot');
const {
  contractCompleteness, maybeAutoSatisfyContract, autoClearContractCondition,
} = require('../src/lib/underwriting/contract-autoclear');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// Seed a file with the rtl_p1_contract condition. `assignment` marks the file as one.
async function seedFile(tag, opts = {}) {
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ($1,'CtrAc',$2) RETURNING id`,
    [tag, `ctrac_${tag}_${process.pid}@example.com`])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, is_assignment, purchase_price, property_address)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [bor.id, !!opts.assignment, opts.purchasePrice || 300000,
      JSON.stringify({ line: '10 Main St', city: 'Town', state: 'NY' })])).rows[0];
  const item = (await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, borrower_label, audience, item_kind, role_scope, phase, is_required, application_id, status)
     SELECT t.id, t.scope, t.label, t.label, t.audience, t.item_kind, COALESCE(t.role_scope,'loan_officer'),
            t.phase, COALESCE(t.is_required,true), $1, 'outstanding'
       FROM checklist_templates t WHERE t.code='rtl_p1_contract' RETURNING id`, [app.id])).rows[0];
  return { borId: bor.id, appId: app.id, itemId: item.id };
}

// Insert a current analyzed extraction for a doc_type (confidence overridable).
async function insertExtraction(appId, docType, confidence) {
  await db.query(
    `INSERT INTO document_extractions (application_id, doc_type, fields, status, confidence, is_current, superseded)
     VALUES ($1,$2,'{}'::jsonb,'analyzed',$3,true,false)`, [appId, docType, confidence || 'definite']);
}

// Insert an OPEN finding on the file.
async function insertFinding(appId, source, code, severity) {
  await db.query(
    `INSERT INTO document_findings (application_id, source, code, severity, status, blocks_ctc)
     VALUES ($1,$2,$3,$4,'open',$5)`, [appId, source, code, severity, severity === 'fatal']);
}

async function condRow(itemId) {
  return (await db.query('SELECT status, signed_off_at, signed_off_by, notes FROM checklist_items WHERE id=$1', [itemId])).rows[0];
}

(async () => {
  await ensureSchema();

  // ── 1) contract read + no fatal → auto-clears (switch ON), stays (switch OFF)
  cfg.contractAutoclearEnabled = false;
  const f1 = await seedFile('Clean');
  await insertExtraction(f1.appId, 'purchase_contract');
  const c1 = await contractCompleteness(db, f1.appId);
  ok(c1.contractRead === true && c1.needsAssignment === false && c1.openFatal === 0 && c1.complete === true,
    'contract read + no fatal → completeness TRUE');
  const m1off = await maybeAutoSatisfyContract(db, f1.appId, f1.itemId);
  ok(m1off.enabled === false && m1off.satisfied === false, 'switch OFF → does nothing');
  ok((await condRow(f1.itemId)).status === 'outstanding', 'switch OFF → condition stays open');
  cfg.contractAutoclearEnabled = true;
  const m1 = await maybeAutoSatisfyContract(db, f1.appId, f1.itemId);
  ok(m1.satisfied === true, 'switch ON + complete → the contract condition auto-clears');
  const r1 = await condRow(f1.itemId);
  ok(r1.status === 'satisfied' && r1.signed_off_at && r1.signed_off_by === null, 'auto-clear is a SYSTEM sign-off (signed_off_by NULL)');
  ok((r1.notes || '').startsWith('[auto]'), 'auto-clear leaves an [auto] note');
  const m1b = await maybeAutoSatisfyContract(db, f1.appId, f1.itemId);
  ok(m1b.satisfied === false && m1b.reason === 'already_satisfied', 'a second pass is a no-op');

  // ── 2) an open FATAL contract finding blocks the clear (reconciliation doesn't tie out)
  cfg.contractAutoclearEnabled = true;
  const f2 = await seedFile('Fatal');
  await insertExtraction(f2.appId, 'purchase_contract');
  await insertFinding(f2.appId, 'purchase_contract', 'contract_price_mismatch', 'fatal');
  const c2 = await contractCompleteness(db, f2.appId);
  ok(c2.contractRead === true && c2.openFatal === 1 && c2.complete === false,
    'contract read but an open fatal price mismatch → NOT complete');
  const m2 = await maybeAutoSatisfyContract(db, f2.appId, f2.itemId);
  ok(m2.satisfied === false && m2.reason === 'incomplete', 'open fatal → never auto-cleared');
  ok((await condRow(f2.itemId)).status === 'outstanding', 'open fatal → condition stays open');

  // ── 3) a WARNING finding does NOT block
  const f3 = await seedFile('Warn');
  await insertExtraction(f3.appId, 'purchase_contract');
  await insertFinding(f3.appId, 'purchase_contract', 'assignment_fee_over_cap', 'warning');
  const c3 = await contractCompleteness(db, f3.appId);
  ok(c3.openFatal === 0 && c3.complete === true, 'a warning finding does NOT block the auto-clear');
  const m3 = await maybeAutoSatisfyContract(db, f3.appId, f3.itemId);
  ok(m3.satisfied === true, 'warning present but no fatal → still auto-clears');

  // ── 4) no contract extraction → not complete; an unreadable extraction doesn't count
  const f4 = await seedFile('NoDoc');
  const c4a = await contractCompleteness(db, f4.appId);
  ok(c4a.contractRead === false && c4a.complete === false, 'no contract extraction → NOT complete');
  await insertExtraction(f4.appId, 'purchase_contract', 'unreadable');
  const c4b = await contractCompleteness(db, f4.appId);
  ok(c4b.contractRead === false && c4b.complete === false, 'an unreadable extraction does NOT count as read');
  const m4 = await maybeAutoSatisfyContract(db, f4.appId, f4.itemId);
  ok(m4.satisfied === false && m4.reason === 'incomplete', 'unreadable contract → never auto-cleared');

  // ── 5) assignment file needs BOTH docs; an assignment-doc fatal blocks too
  cfg.contractAutoclearEnabled = true;
  const f5 = await seedFile('Asg', { assignment: true });
  await insertExtraction(f5.appId, 'purchase_contract');
  const c5a = await contractCompleteness(db, f5.appId);
  ok(c5a.needsAssignment === true && c5a.assignmentRead === false && c5a.complete === false,
    'assignment file with only the purchase contract read → NOT complete (assignment doc missing)');
  await insertExtraction(f5.appId, 'assignment');
  const c5b = await contractCompleteness(db, f5.appId);
  ok(c5b.assignmentRead === true && c5b.complete === true, 'both the contract AND the assignment read → complete');
  // now add an open fatal from the assignment doc → blocks
  await insertFinding(f5.appId, 'assignment', 'assignment_unsigned', 'fatal');
  const c5c = await contractCompleteness(db, f5.appId);
  ok(c5c.openFatal === 1 && c5c.complete === false, 'an open fatal from the assignment doc blocks the clear');
  const m5 = await maybeAutoSatisfyContract(db, f5.appId, f5.itemId);
  ok(m5.satisfied === false, 'assignment-doc fatal → never auto-cleared');

  // ── 6) db/292: changing purchase_price REOPENS an auto-cleared condition
  cfg.contractAutoclearEnabled = true;
  const f6 = await seedFile('Reopen');
  await insertExtraction(f6.appId, 'purchase_contract');
  await maybeAutoSatisfyContract(db, f6.appId, f6.itemId);
  ok((await condRow(f6.itemId)).status === 'satisfied', 'baseline: clean file auto-cleared');
  await db.query('UPDATE applications SET purchase_price=350000 WHERE id=$1', [f6.appId]);
  const r6 = await condRow(f6.itemId);
  ok(r6.status === 'received' && r6.signed_off_at === null, 'db/292: a purchase-price change REOPENS the auto-cleared contract condition');
  ok((r6.notes || '').startsWith('[auto]'), 'the reopen leaves an [auto] note');

  // ── 6b) db/292: an address change reopens too
  const f6b = await seedFile('Reopen2');
  await insertExtraction(f6b.appId, 'purchase_contract');
  await maybeAutoSatisfyContract(db, f6b.appId, f6b.itemId);
  ok((await condRow(f6b.itemId)).status === 'satisfied', 'baseline: clean file auto-cleared');
  await db.query(`UPDATE applications SET property_address=$2 WHERE id=$1`,
    [f6b.appId, JSON.stringify({ line: '99 Other Ave', city: 'Town', state: 'NY' })]);
  ok((await condRow(f6b.itemId)).status === 'received', 'db/292: a property-address change REOPENS the auto-cleared contract condition');

  // ── 7) db/292 must NOT reopen a HUMAN sign-off
  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Ctr Tester','loan_officer',true) RETURNING id`,
    [`ctrstaff_${process.pid}@example.com`])).rows[0];
  const f7 = await seedFile('Human');
  await db.query(
    `UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2, notes='cleared by hand' WHERE id=$1`,
    [f7.itemId, staff.id]);
  await db.query('UPDATE applications SET purchase_price=400000 WHERE id=$1', [f7.appId]);
  const r7 = await condRow(f7.itemId);
  ok(r7.status === 'satisfied' && String(r7.signed_off_by) === String(staff.id),
    'db/292: a HUMAN sign-off is NOT reopened by an economics change (only system [auto] clears are)');
  const m7 = await maybeAutoSatisfyContract(db, f7.appId, f7.itemId);
  ok(m7.reason === 'human_signed_off', 'maybeAutoSatisfyContract never touches a human sign-off');

  // ── 8) the store hook clears live (saveAnalysis purchase_contract → autoClearContractCondition)
  cfg.contractAutoclearEnabled = true;
  const f8 = await seedFile('Hook');
  await insertExtraction(f8.appId, 'purchase_contract');
  await autoClearContractCondition(db, f8.appId);
  ok((await condRow(f8.itemId)).status === 'satisfied', 'the store hook auto-clears the contract condition live');

  // cleanup (throwaway DB, but tidy)
  cfg.contractAutoclearEnabled = false;
  const apps = [f1.appId, f2.appId, f3.appId, f4.appId, f5.appId, f6.appId, f6b.appId, f7.appId, f8.appId];
  for (const appId of apps) {
    await db.query('DELETE FROM document_findings WHERE application_id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM document_extractions WHERE application_id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM checklist_items WHERE application_id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM applications WHERE id=$1', [appId]).catch(() => {});
  }
  for (const f of [f1, f2, f3, f4, f5, f6, f6b, f7, f8]) {
    await db.query('DELETE FROM borrowers WHERE id=$1', [f.borId]).catch(() => {});
  }
  await db.query('DELETE FROM staff_users WHERE id=$1', [staff.id]).catch(() => {});

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  contract-autoclear-db: read+tie-out gate, fatal-blocks, warning-ok, no-doc/unreadable guard, assignment two-doc gate, db/292 reopen (price + address), human-signoff guard, store hook — all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
