'use strict';
/**
 * DB test for the PILOT advisory overlay (owner-directed 2026-07-24):
 * src/lib/underwriting/pilot-advice.js + pilot-advice-engine.js + db/294.
 *
 * PILOT lays an advisory on top of the human layer for EVERY condition it can judge, and
 * NEVER signs a condition off itself. Proves:
 *   • an OPEN, PILOT-verified condition → advice 'ready' (status still open);
 *   • a condition PILOT can't evaluate → NO advice (null);
 *   • a HUMAN-signed-off condition PILOT confirms → advice 'agree' (status/sign-off untouched);
 *   • a HUMAN-signed-off condition with an open FATAL finding → advice 'dispute' (revisit);
 *   • the advisory NEVER changes status / signed_off_* on any path;
 *   • with the switch OFF (PILOT_READY_STAMP=0) nothing is written.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-pilot-advice-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-pilot-advice-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const cfg = require('../src/config');
const { ensureSchema } = require('../src/migrate-boot');
const engine = require('../src/lib/underwriting/pilot-advice-engine');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

async function seedFile() {
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Adv','Isory',$1) RETURNING id`,
    [`advisory_${process.pid}@example.com`])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, is_assignment, purchase_price, property_address)
     VALUES ($1,false,300000,$2) RETURNING id`,
    [bor.id, JSON.stringify({ line: '10 Main St', city: 'Town', state: 'NY' })])).rows[0];
  return { borId: bor.id, appId: app.id };
}
async function attach(appId, code) {
  return (await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, borrower_label, audience, item_kind, role_scope, phase, is_required, application_id, status)
     SELECT t.id, t.scope, t.label, t.label, t.audience, t.item_kind, COALESCE(t.role_scope,'loan_officer'),
            t.phase, true, $1, 'outstanding'
       FROM checklist_templates t WHERE t.code=$2 RETURNING id`, [appId, code])).rows[0].id;
}
async function insertContractExtraction(appId) {
  await db.query(
    `INSERT INTO document_extractions (application_id, doc_type, fields, status, confidence, is_current, superseded)
     VALUES ($1,'purchase_contract','{}'::jsonb,'analyzed','definite',true,false)`, [appId]);
}
async function row(itemId) {
  return (await db.query(
    'SELECT status, signed_off_by, pilot_advice, pilot_advice_note, pilot_advice_at FROM checklist_items WHERE id=$1', [itemId])).rows[0];
}

(async () => {
  await ensureSchema();
  cfg.pilotReadyStampEnabled = true;

  const f = await seedFile();
  const contract = await attach(f.appId, 'rtl_p1_contract');
  const title = await attach(f.appId, 'rtl_cond_title');   // PILOT has no evaluator for title
  await insertContractExtraction(f.appId);                  // contract read + no fatal → complete

  // 1) OPEN + verified → 'ready'; no-evaluator condition → no advice.
  await engine.runFileAdvice(db, f.appId);
  let c = await row(contract);
  ok(c.pilot_advice === 'ready' && c.pilot_advice_at, 'open + verified contract → advice "ready"');
  ok(c.status === 'outstanding' && c.signed_off_by === null, '…and the advisory did NOT sign it off (status still open)');
  ok((c.pilot_advice_note || '').length > 0, 'the ready advice carries a plain-language note');
  const t = await row(title);
  ok(t.pilot_advice === null, 'a condition PILOT can\'t evaluate (title) gets NO advice');

  // 2) HUMAN signs off the contract (still verified) → 'agree', sign-off untouched.
  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Adv Tester','loan_officer',true) RETURNING id`,
    [`advstaff_${process.pid}@example.com`])).rows[0];
  await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2 WHERE id=$1`, [contract, staff.id]);
  await engine.runFileAdvice(db, f.appId);
  c = await row(contract);
  ok(c.pilot_advice === 'agree', 'signed-off + still-verified contract → advice "agree"');
  ok(c.status === 'satisfied' && String(c.signed_off_by) === String(staff.id), '…and the human sign-off is untouched');

  // 3) An open FATAL contract finding appears on the signed-off condition → 'dispute'.
  await db.query(
    `INSERT INTO document_findings (application_id, source, code, severity, status, blocks_ctc)
     VALUES ($1,'purchase_contract','contract_price_mismatch','fatal','open',true)`, [f.appId]);
  await engine.runFileAdvice(db, f.appId);
  c = await row(contract);
  ok(c.pilot_advice === 'dispute', 'signed-off contract with an open FATAL finding → advice "dispute" (revisit)');
  ok(c.status === 'satisfied' && String(c.signed_off_by) === String(staff.id), '…and the dispute advisory STILL did not touch the human sign-off');
  ok(/look/i.test(c.pilot_advice_note || ''), 'the dispute advice explains why (worth another look)');

  // 4) switch OFF → nothing written (clear first, then run with flag off).
  cfg.pilotReadyStampEnabled = false;
  await db.query(`UPDATE checklist_items SET pilot_advice=NULL, pilot_advice_note=NULL, pilot_advice_at=NULL WHERE id=$1`, [contract]);
  await engine.runFileAdvice(db, f.appId);
  c = await row(contract);
  ok(c.pilot_advice === null, 'with PILOT_READY_STAMP off, the engine writes no advice');

  // cleanup
  cfg.pilotReadyStampEnabled = false;
  await db.query('DELETE FROM document_findings WHERE application_id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM document_extractions WHERE application_id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM checklist_items WHERE application_id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM applications WHERE id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [f.borId]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE id=$1', [staff.id]).catch(() => {});

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  pilot-advice-db: ready / no-advice / agree / dispute, advisory never touches sign-off, off-switch — all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
