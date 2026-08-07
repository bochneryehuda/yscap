'use strict';
/**
 * DB test for the TRACK-RECORD / EXPERIENCE advisory (IG-W10, owner-directed 2026-07-24):
 * src/lib/underwriting/experience-advisory.js wired into pilot-advice-engine.js.
 *
 * The experience condition (rtl_p3_reo) is a STAFF task condition. PILOT NEVER signs it off
 * — it lays an advisory on top, using the SAME verified-vs-registered-need math the sign-off
 * gate uses. Proves:
 *   • an OPEN experience condition (experience claimed) with NO verified deals → 'not_ready';
 *   • enough VERIFIED deals in the 3-year window to cover the need → 'ready' (status open);
 *   • a HUMAN-signed-off condition PILOT still confirms → 'agree';
 *   • a signed-off condition whose verified experience later falls short → NO advisory
 *     (null / silent) — NEVER a false 'dispute' (a shortfall is absence of verification, not
 *     positive evidence the experience is wrong);
 *   • a file with NO experience requirement → NO advisory at all (not applicable);
 *   • the advisory NEVER changes status / signed_off_* on any path.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-experience-advisory-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-experience-advisory-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const cfg = require('../src/config');
const { ensureSchema } = require('../src/migrate-boot');
const engine = require('../src/lib/underwriting/pilot-advice-engine');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

async function seedFile(expFlips) {
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Track','Record',$1) RETURNING id`,
    [`exp_${process.pid}_${Date.now()}@example.com`])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, is_assignment, purchase_price, property_address, requested_exp_flips)
     VALUES ($1,false,300000,$2,$3) RETURNING id`,
    [bor.id, JSON.stringify({ line: '9 Deal St', city: 'Town', state: 'NY' }), expFlips])).rows[0];
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
async function addVerifiedFlip(borId) {
  // A completed flip whose SALE date is inside the frozen 3-year exit window, VERIFIED.
  const ins = await db.query(
    // Verification is a SEPARATE UPDATE, as production does it — db/485's guard forbids
    // a track record from being BORN verified, so asking for it in the INSERT produced an
    // unverified line and these VERIFIED-experience assertions measured zero.
    `INSERT INTO track_records (borrower_id, deal_type, sale_date)
     VALUES ($1,'Fix & Flip', CURRENT_DATE - INTERVAL '30 days') RETURNING id`, [borId]);
  await db.query(
    `UPDATE track_records SET is_verified=true, verification_status='verified', verified_at=now() WHERE id=$1`,
    [ins.rows[0].id]);
}
async function row(itemId) {
  return (await db.query(
    'SELECT status, signed_off_by, pilot_advice, pilot_advice_note, pilot_advice_at FROM checklist_items WHERE id=$1', [itemId])).rows[0];
}

(async () => {
  await ensureSchema();
  cfg.pilotReadyStampEnabled = true;

  // ---- File A: 1 flip of experience claimed ---------------------------------
  const f = await seedFile(1);
  const exp = await attach(f.appId, 'rtl_p3_reo');

  // 1) OPEN, experience claimed but NO verified deals → 'not_ready'.
  await engine.runFileAdvice(db, f.appId);
  let c = await row(exp);
  ok(c.pilot_advice === 'not_ready', 'experience claimed, none verified yet → advice "not_ready"');
  ok(c.status === 'outstanding' && c.signed_off_by === null, '…and the advisory did NOT sign it off');

  // 2) A verified flip in the 3-year window covers the need → 'ready' (status still open).
  await addVerifiedFlip(f.borId);
  await engine.runFileAdvice(db, f.appId);
  c = await row(exp);
  ok(c.pilot_advice === 'ready' && c.pilot_advice_at, 'verified experience covers the need → advice "ready"');
  ok(c.status === 'outstanding' && c.signed_off_by === null, '…and "ready" did NOT sign the condition off');
  ok((c.pilot_advice_note || '').length > 0, 'the ready advice carries a plain-language note');

  // 3) HUMAN signs it off (still covered) → 'agree'.
  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Exp Tester','processor',true) RETURNING id`,
    [`expstaff_${process.pid}_${Date.now()}@example.com`])).rows[0];
  await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2 WHERE id=$1`, [exp, staff.id]);
  await engine.runFileAdvice(db, f.appId);
  c = await row(exp);
  ok(c.pilot_advice === 'agree', 'signed-off + still-covered experience → advice "agree"');
  ok(c.status === 'satisfied' && String(c.signed_off_by) === String(staff.id), '…and the human sign-off is untouched');

  // 4) The one deal is UN-VERIFIED → verified experience now falls short on a signed-off
  //    condition. PILOT lays NO advisory (silent) — NEVER a false "dispute" — and never
  //    touches the human sign-off.
  await db.query(`UPDATE track_records SET is_verified=false WHERE borrower_id=$1`, [f.borId]);
  await engine.runFileAdvice(db, f.appId);
  c = await row(exp);
  ok(c.pilot_advice === null, 'signed-off + verified shortfall → NO advisory (silent), never a false "dispute"');
  ok(c.status === 'satisfied' && String(c.signed_off_by) === String(staff.id), '…and the shortfall STILL did not touch the human sign-off');

  // ---- File B: NO experience claimed → NOT APPLICABLE (no advisory at all) ---
  const g = await seedFile(0);
  const expB = await attach(g.appId, 'rtl_p3_reo');
  await engine.runFileAdvice(db, g.appId);
  const cb = await row(expB);
  ok(cb.pilot_advice === null, 'no experience required on the file → PILOT lays no advisory (not applicable)');
  ok(cb.status === 'outstanding' && cb.signed_off_by === null, '…and it did NOT touch the condition');

  // cleanup
  cfg.pilotReadyStampEnabled = false;
  for (const file of [f, g]) {
    await db.query('DELETE FROM track_records WHERE borrower_id=$1', [file.borId]).catch(() => {});
    await db.query('DELETE FROM checklist_items WHERE application_id=$1', [file.appId]).catch(() => {});
    await db.query('DELETE FROM applications WHERE id=$1', [file.appId]).catch(() => {});
    await db.query('DELETE FROM borrowers WHERE id=$1', [file.borId]).catch(() => {});
  }
  await db.query('DELETE FROM staff_users WHERE id=$1', [staff.id]).catch(() => {});

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  experience-advisory-db: not_ready / ready / agree / silent-on-shortfall / not-applicable, advisory never touches sign-off — all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
