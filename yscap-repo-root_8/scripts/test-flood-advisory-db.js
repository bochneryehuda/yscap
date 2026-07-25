'use strict';
/**
 * DB test for the FLOOD advisory (IG-W9, owner-directed 2026-07-24):
 * src/lib/underwriting/flood-advisory.js wired into pilot-advice-engine.js.
 *
 * The flood-certificate condition (rtl_cond_flood) is a STAFF document condition. PILOT
 * NEVER signs it off — it lays an advisory on top. Proves:
 *   • an OPEN flood condition with NO flood read yet → advice 'not_ready';
 *   • a flood determination READ clean (analyzed extraction, no fatal) → advice 'ready'
 *     (status still open — the advisory never signs it off);
 *   • a HUMAN-signed-off flood condition PILOT confirms → advice 'agree';
 *   • a HUMAN-signed-off flood condition with an open FATAL flood finding → 'dispute';
 *   • the advisory NEVER changes status / signed_off_* on any path.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-flood-advisory-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-flood-advisory-db (no DATABASE_URL)'); process.exit(0); }
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
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Flood','Zone',$1) RETURNING id`,
    [`flood_${process.pid}@example.com`])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, is_assignment, purchase_price, property_address)
     VALUES ($1,false,300000,$2) RETURNING id`,
    [bor.id, JSON.stringify({ line: '7 River Rd', city: 'Town', state: 'NY' })])).rows[0];
  return { borId: bor.id, appId: app.id };
}
async function attach(appId, code) {
  return (await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, borrower_label, audience, item_kind, role_scope, phase, is_required, application_id, status)
     SELECT t.id, t.scope, t.label, t.label, t.audience, t.item_kind, COALESCE(t.role_scope,'processor'),
            t.phase, true, $1, 'outstanding'
       FROM checklist_templates t WHERE t.code=$2 RETURNING id`, [appId, code])).rows[0].id;
}
async function insertFloodExtraction(appId) {
  await db.query(
    `INSERT INTO document_extractions (application_id, doc_type, fields, status, confidence, is_current, superseded)
     VALUES ($1,'flood','{}'::jsonb,'analyzed','definite',true,false)`, [appId]);
}
async function row(itemId) {
  return (await db.query(
    'SELECT status, signed_off_by, pilot_advice, pilot_advice_note, pilot_advice_at FROM checklist_items WHERE id=$1', [itemId])).rows[0];
}

(async () => {
  await ensureSchema();
  cfg.pilotReadyStampEnabled = true;

  const f = await seedFile();
  const flood = await attach(f.appId, 'rtl_cond_flood');

  // 1) OPEN, no flood read yet → 'not_ready'.
  await engine.runFileAdvice(db, f.appId);
  let c = await row(flood);
  ok(c.pilot_advice === 'not_ready', 'open flood condition with no read yet → advice "not_ready"');
  ok(c.status === 'outstanding' && c.signed_off_by === null, '…and the advisory did NOT sign it off');

  // 2) The flood determination is read clean → 'ready' (status still open).
  await insertFloodExtraction(f.appId);
  await engine.runFileAdvice(db, f.appId);
  c = await row(flood);
  ok(c.pilot_advice === 'ready' && c.pilot_advice_at, 'flood determination read + clean → advice "ready"');
  ok(c.status === 'outstanding' && c.signed_off_by === null, '…and "ready" did NOT sign the condition off');
  ok((c.pilot_advice_note || '').length > 0, 'the ready advice carries a plain-language note');

  // 3) HUMAN signs it off (still clean) → 'agree'.
  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Flood Tester','processor',true) RETURNING id`,
    [`floodstaff_${process.pid}@example.com`])).rows[0];
  await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2 WHERE id=$1`, [flood, staff.id]);
  await engine.runFileAdvice(db, f.appId);
  c = await row(flood);
  ok(c.pilot_advice === 'agree', 'signed-off + still-clean flood → advice "agree"');
  ok(c.status === 'satisfied' && String(c.signed_off_by) === String(staff.id), '…and the human sign-off is untouched');

  // 4) An open FATAL flood finding appears on the signed-off condition → 'dispute'.
  await db.query(
    `INSERT INTO document_findings (application_id, source, code, severity, status, blocks_ctc)
     VALUES ($1,'flood','flood_insurance_required','fatal','open',true)`, [f.appId]);
  await engine.runFileAdvice(db, f.appId);
  c = await row(flood);
  ok(c.pilot_advice === 'dispute', 'signed-off flood with an open FATAL finding → advice "dispute" (revisit)');
  ok(c.status === 'satisfied' && String(c.signed_off_by) === String(staff.id), '…and the dispute advisory STILL did not touch the human sign-off');
  ok(/look/i.test(c.pilot_advice_note || ''), 'the dispute advice explains why (worth another look)');

  // cleanup
  cfg.pilotReadyStampEnabled = false;
  await db.query('DELETE FROM document_findings WHERE application_id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM document_extractions WHERE application_id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM checklist_items WHERE application_id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM applications WHERE id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [f.borId]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE id=$1', [staff.id]).catch(() => {});

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  flood-advisory-db: not_ready / ready / agree / dispute, advisory never touches sign-off — all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
