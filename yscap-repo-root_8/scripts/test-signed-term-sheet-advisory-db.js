'use strict';
/**
 * DB test for the SIGNED-TERM-SHEET advisory (IG-W13, owner-directed 2026-07-24):
 * src/lib/underwriting/signed-term-sheet-advisory.js wired into pilot-advice-engine.js.
 *
 * The "Signed term sheet" condition (rtl_cond_signedts) is an ordinary required-document
 * condition. Its sign-off gate is the GENERIC required-document check: at least one CURRENT,
 * non-rejected document on the checklist item. PILOT NEVER signs it off — it lays an advisory
 * on top, reading that SAME state. Proves:
 *   • an OPEN condition with NO signed term sheet on file → 'not_ready';
 *   • a current, non-rejected signed term sheet document on the item → 'ready' (status open);
 *   • a HUMAN-signed-off condition PILOT confirms → 'agree';
 *   • if the signed copy is later superseded (no current doc), PILOT lays NO advisory (silent)
 *     on the signed-off condition — never a false 'dispute';
 *   • the advisory NEVER changes status / signed_off_* on any path.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-signed-term-sheet-advisory-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-signed-term-sheet-advisory-db (no DATABASE_URL)'); process.exit(0); }
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
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Signed','Sheet',$1) RETURNING id`,
    [`sts_${process.pid}_${Date.now()}@example.com`])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, is_assignment, purchase_price, property_address)
     VALUES ($1,false,300000,$2) RETURNING id`,
    [bor.id, JSON.stringify({ line: '11 Sign St', city: 'Town', state: 'NY' })])).rows[0];
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
async function addDoc(appId, itemId) {
  return (await db.query(
    `INSERT INTO documents (checklist_item_id, application_id, filename, is_current, review_status, doc_kind)
     VALUES ($1,$2,'signed-term-sheet.pdf', true, 'pending', 'term_sheet_signed') RETURNING id`,
    [itemId, appId])).rows[0].id;
}
async function row(itemId) {
  return (await db.query(
    'SELECT status, signed_off_by, pilot_advice, pilot_advice_note, pilot_advice_at FROM checklist_items WHERE id=$1', [itemId])).rows[0];
}

(async () => {
  await ensureSchema();
  cfg.pilotReadyStampEnabled = true;

  const f = await seedFile();
  const sts = await attach(f.appId, 'rtl_cond_signedts');

  // 1) OPEN, no signed term sheet on file → 'not_ready'.
  await engine.runFileAdvice(db, f.appId);
  let c = await row(sts);
  ok(c.pilot_advice === 'not_ready', 'open signed-term-sheet condition, none on file → advice "not_ready"');
  ok(c.status === 'outstanding' && c.signed_off_by === null, '…and the advisory did NOT sign it off');

  // 2) A current, non-rejected signed term sheet document is filed → 'ready' (status open).
  const docId = await addDoc(f.appId, sts);
  await engine.runFileAdvice(db, f.appId);
  c = await row(sts);
  ok(c.pilot_advice === 'ready' && c.pilot_advice_at, 'signed term sheet on file → advice "ready"');
  ok(c.status === 'outstanding' && c.signed_off_by === null, '…and "ready" did NOT sign the condition off');
  ok((c.pilot_advice_note || '').length > 0, 'the ready advice carries a plain-language note');

  // 3) HUMAN signs it off (doc still current) → 'agree'.
  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'STS Tester','loan_officer',true) RETURNING id`,
    [`ststaff_${process.pid}_${Date.now()}@example.com`])).rows[0];
  await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2 WHERE id=$1`, [sts, staff.id]);
  await engine.runFileAdvice(db, f.appId);
  c = await row(sts);
  ok(c.pilot_advice === 'agree', 'signed-off + signed term sheet still on file → advice "agree"');
  ok(c.status === 'satisfied' && String(c.signed_off_by) === String(staff.id), '…and the human sign-off is untouched');

  // 4) The signed copy is superseded (no current doc). PILOT can no longer confirm — it lays
  //    NO advisory (silent) on the signed-off condition. NEVER a false 'dispute' (a term sheet
  //    has no positive-contradiction signal). The advisory never touches the human sign-off.
  await db.query(`UPDATE documents SET is_current=false WHERE id=$1`, [docId]);
  await engine.runFileAdvice(db, f.appId);
  c = await row(sts);
  ok(c.pilot_advice === null, 'signed-off but no current signed term sheet → NO advisory (silent), never a false "dispute"');
  ok(c.status === 'satisfied' && String(c.signed_off_by) === String(staff.id), '…and the advisory STILL did not touch the human sign-off');

  // cleanup
  cfg.pilotReadyStampEnabled = false;
  await db.query('DELETE FROM documents WHERE application_id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM checklist_items WHERE application_id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM applications WHERE id=$1', [f.appId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [f.borId]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE id=$1', [staff.id]).catch(() => {});

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  signed-term-sheet-advisory-db: not_ready / ready / agree / silent-when-superseded, advisory never touches sign-off — all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
