'use strict';
/**
 * DB test for the APPRAISAL-review advisory (IG-W11, owner-directed 2026-07-24):
 * src/lib/underwriting/appraisal-advisory.js wired into pilot-advice-engine.js.
 *
 * The "Appraisal review cleared" condition (appraisal_review_cleared) is a STAFF condition —
 * the clear-to-close gate for PILOT's appraisal findings. PILOT NEVER signs it off — it lays
 * an advisory on top, reading the SAME tables the sign-off gate reads (a current appraisals
 * row = "read"; an open FATAL blocks_ctc appraisal_findings row = contradiction). Proves:
 *   • an OPEN condition with NO appraisal read yet → 'not_ready';
 *   • a current appraisal read + clean (no fatal finding) → 'ready' (status still open);
 *   • a HUMAN-signed-off condition PILOT confirms → 'agree';
 *   • a NEW open FATAL blocks_ctc finding lands AFTER the human signed off → the condition
 *     REOPENS (owner-directed 2026-07-30: appraisal findings are ENFORCED again — db/375
 *     re-armed the db/155 reopen for the APPRAISAL review only; the document review stays
 *     advisory per 2026-07-27), and the advisory reads the reopened condition 'not_ready';
 *   • the advisory itself NEVER changes status / signed_off_* on any path (the reopen is the
 *     DB trigger's doing, not the advisory's).
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-appraisal-advisory-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-appraisal-advisory-db (no DATABASE_URL)'); process.exit(0); }
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
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Appr','Aisal',$1) RETURNING id`,
    [`appr_${process.pid}_${Date.now()}@example.com`])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, is_assignment, purchase_price, property_address)
     VALUES ($1,false,300000,$2) RETURNING id`,
    [bor.id, JSON.stringify({ line: '3 Value Ct', city: 'Town', state: 'NY' })])).rows[0];
  return { borId: bor.id, appId: app.id };
}
async function attach(appId, code) {
  return (await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, borrower_label, audience, item_kind, role_scope, phase, is_required, application_id, status)
     SELECT t.id, t.scope, t.label, t.label, t.audience, t.item_kind, COALESCE(t.role_scope,'underwriter'),
            t.phase, true, $1, 'outstanding'
       FROM checklist_templates t WHERE t.code=$2 RETURNING id`, [appId, code])).rows[0].id;
}
async function insertAppraisal(appId) {
  return (await db.query(
    `INSERT INTO appraisals (application_id, superseded) VALUES ($1, false) RETURNING id`, [appId])).rows[0].id;
}
async function insertFatalFinding(appId, apprId) {
  await db.query(
    `INSERT INTO appraisal_findings (appraisal_id, application_id, source, code, severity, status, blocks_ctc, title)
     VALUES ($1,$2,'appraisal','asis_below_price','fatal','open',true,'As-Is value is below the purchase price')`,
    [apprId, appId]);
}
async function row(itemId) {
  return (await db.query(
    'SELECT status, signed_off_by, pilot_advice, pilot_advice_note, pilot_advice_at FROM checklist_items WHERE id=$1', [itemId])).rows[0];
}

(async () => {
  await ensureSchema();
  cfg.pilotReadyStampEnabled = true;

  const f = await seedFile();
  const appr = await attach(f.appId, 'appraisal_review_cleared');

  // 1) OPEN, no appraisal read yet → 'not_ready'.
  await engine.runFileAdvice(db, f.appId);
  let c = await row(appr);
  ok(c.pilot_advice === 'not_ready', 'open appraisal-review condition, no appraisal read yet → advice "not_ready"');
  ok(c.status === 'outstanding' && c.signed_off_by === null, '…and the advisory did NOT sign it off');

  // 2) A current appraisal is read clean (no fatal finding) → 'ready' (status still open).
  const apprId = await insertAppraisal(f.appId);
  await engine.runFileAdvice(db, f.appId);
  c = await row(appr);
  ok(c.pilot_advice === 'ready' && c.pilot_advice_at, 'appraisal read + clean → advice "ready"');
  ok(c.status === 'outstanding' && c.signed_off_by === null, '…and "ready" did NOT sign the condition off');
  ok((c.pilot_advice_note || '').length > 0, 'the ready advice carries a plain-language note');

  // 3) HUMAN signs it off (still clean) → 'agree'.
  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Appr Tester','underwriter',true) RETURNING id`,
    [`apprstaff_${process.pid}_${Date.now()}@example.com`])).rows[0];
  await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2 WHERE id=$1`, [appr, staff.id]);
  await engine.runFileAdvice(db, f.appId);
  c = await row(appr);
  ok(c.pilot_advice === 'agree', 'signed-off + still-clean appraisal → advice "agree"');
  ok(c.status === 'satisfied' && String(c.signed_off_by) === String(staff.id), '…and the human sign-off is untouched');

  // 4) A NEW open FATAL blocks_ctc appraisal finding lands AFTER the human signed off.
  //    ENFORCED for the APPRAISAL review (owner-directed 2026-07-30; db/375 re-armed db/155's
  //    reopen, narrowing the 2026-07-27 advisory-only rule for this ONE condition): a sign-off
  //    cannot stand over a fresh blocking appraisal finding — the trigger reopens the
  //    condition (with an [auto] note) and the officer must re-clear it. The document/
  //    underwriting review stays advisory (test-ai-advisory-only-db.js covers that side).
  await insertFatalFinding(f.appId, apprId);
  const afterFatal = await row(appr);
  ok(afterFatal.status === 'received' && afterFatal.signed_off_by === null,
    'ENFORCED: a late fatal appraisal finding REOPENS the signed-off appraisal review (db/375 re-armed the reopen)');
  await engine.runFileAdvice(db, f.appId);
  c = await row(appr);
  ok(c.pilot_advice === 'not_ready',
    'the reopened (open) condition with an open fatal → advice "not_ready"');
  ok(c.status === 'received' && c.signed_off_by === null,
    '…and the advisory itself changed nothing — the DB trigger did the reopen, not the advisory');

  // cleanup
  cfg.pilotReadyStampEnabled = false;
  await db.query('DELETE FROM appraisal_findings WHERE application_id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM appraisals WHERE application_id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM checklist_items WHERE application_id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM applications WHERE id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [f.borId]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE id=$1', [staff.id]).catch(() => {});

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  appraisal-advisory-db: not_ready / ready / agree / reopen-on-fatal→not_ready, advisory never touches sign-off — all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
