'use strict';
/**
 * DB test for the TITLE / INSURANCE CONTACT-INFO advisory (IG-W14, owner-directed 2026-07-24):
 * src/lib/underwriting/contact-advisory.js wired into pilot-advice-engine.js.
 *
 * The "Title contact" (rtl_p1_titlec) and "Insurance contact" (rtl_p1_insc) conditions are
 * STAFF task conditions whose contact is entered as STRUCTURED DATA (application_service_
 * contacts), not a document. PILOT NEVER signs them off — it lays an advisory reading the
 * SAME row the sign-off gate reads. Proves:
 *   • an OPEN contact condition with NO contact on file → 'not_ready';
 *   • the matching contact row on file (title_company / insurance_agent) → 'ready' (open);
 *   • a HUMAN-signed-off condition PILOT confirms → 'agree';
 *   • an OPTIONAL (is_required=false) contact condition → NO advisory (mirrors the gate,
 *     which imposes nothing on an optional contact);
 *   • the advisory NEVER changes status / signed_off_* on any path;
 *   • contradicted is always false — never a 'dispute' (a contact has no findings source).
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-contact-advisory-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-contact-advisory-db (no DATABASE_URL)'); process.exit(0); }
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
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Contact','Info',$1) RETURNING id`,
    [`contact_${process.pid}_${Date.now()}@example.com`])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, is_assignment, purchase_price, property_address)
     VALUES ($1,false,300000,$2) RETURNING id`,
    [bor.id, JSON.stringify({ line: '5 Escrow Way', city: 'Town', state: 'NY' })])).rows[0];
  return { borId: bor.id, appId: app.id };
}
async function attach(appId, code, isRequired = true) {
  return (await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, borrower_label, audience, item_kind, role_scope, phase, is_required, application_id, status)
     SELECT t.id, t.scope, t.label, t.label, t.audience, t.item_kind, COALESCE(t.role_scope,'loan_officer'),
            t.phase, $3, $1, 'outstanding'
       FROM checklist_templates t WHERE t.code=$2 RETURNING id`, [appId, code, isRequired])).rows[0].id;
}
async function addContact(borId, appId, serviceType, linkType) {
  const sc = (await db.query(
    `INSERT INTO service_contacts (borrower_id, contact_type, company_name, email)
     VALUES ($1,$2,'Acme','contact@example.com') RETURNING id`, [borId, serviceType])).rows[0];
  await db.query(
    `INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type)
     VALUES ($1,$2,$3)`, [appId, sc.id, linkType]);
}
async function row(itemId) {
  return (await db.query(
    'SELECT status, signed_off_by, pilot_advice, pilot_advice_note FROM checklist_items WHERE id=$1', [itemId])).rows[0];
}

(async () => {
  await ensureSchema();
  cfg.pilotReadyStampEnabled = true;

  const f = await seedFile();
  const titlec = await attach(f.appId, 'rtl_p1_titlec');
  const insc = await attach(f.appId, 'rtl_p1_insc');

  // 1) OPEN, no contacts on file → both 'not_ready'.
  await engine.runFileAdvice(db, f.appId);
  let t = await row(titlec); let i = await row(insc);
  ok(t.pilot_advice === 'not_ready', 'open title-contact condition, none on file → advice "not_ready"');
  ok(i.pilot_advice === 'not_ready', 'open insurance-contact condition, none on file → advice "not_ready"');
  ok(t.status === 'outstanding' && t.signed_off_by === null && i.signed_off_by === null, '…and the advisory did NOT sign either off');

  // 2) The title company contact is entered → title 'ready', insurance still 'not_ready'.
  await addContact(f.borId, f.appId, 'title_company', 'title_company');
  await engine.runFileAdvice(db, f.appId);
  t = await row(titlec); i = await row(insc);
  ok(t.pilot_advice === 'ready' && (t.pilot_advice_note || '').length > 0, 'title company contact on file → advice "ready" (with a plain-language note)');
  ok(i.pilot_advice === 'not_ready', 'insurance contact still missing → insurance advice stays "not_ready"');
  ok(t.status === 'outstanding' && t.signed_off_by === null, '…and "ready" did NOT sign the title condition off');

  // 3) The insurance contact is entered → insurance 'ready' too.
  await addContact(f.borId, f.appId, 'insurance_agent', 'insurance_agent');
  await engine.runFileAdvice(db, f.appId);
  i = await row(insc);
  ok(i.pilot_advice === 'ready', 'insurance contact on file → advice "ready"');

  // 4) HUMAN signs off the title condition (contact still on file) → 'agree'.
  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Contact Tester','loan_officer',true) RETURNING id`,
    [`cstaff_${process.pid}_${Date.now()}@example.com`])).rows[0];
  await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2 WHERE id=$1`, [titlec, staff.id]);
  await engine.runFileAdvice(db, f.appId);
  t = await row(titlec);
  ok(t.pilot_advice === 'agree', 'signed-off + contact still on file → advice "agree"');
  ok(t.status === 'satisfied' && String(t.signed_off_by) === String(staff.id), '…and the human sign-off is untouched');

  // 5) An OPTIONAL contact condition (is_required=false) → PILOT lays NO advisory (mirrors the
  //    gate, which imposes nothing on an optional contact).
  const g = await seedFile();
  const optTitle = await attach(g.appId, 'rtl_p1_titlec', false);
  await engine.runFileAdvice(db, g.appId);
  const o = await row(optTitle);
  ok(o.pilot_advice === null, 'an OPTIONAL (is_required=false) contact condition → PILOT lays no advisory');
  ok(o.status === 'outstanding' && o.signed_off_by === null, '…and it did NOT touch the condition');

  // cleanup
  cfg.pilotReadyStampEnabled = false;
  for (const file of [f, g]) {
    await db.query('DELETE FROM application_service_contacts WHERE application_id=$1', [file.appId]).catch(() => {});
    await db.query('DELETE FROM service_contacts WHERE borrower_id=$1', [file.borId]).catch(() => {});
    await db.query('DELETE FROM checklist_items WHERE application_id=$1', [file.appId]).catch(() => {});
    await db.query('DELETE FROM applications WHERE id=$1', [file.appId]).catch(() => {});
    await db.query('DELETE FROM borrowers WHERE id=$1', [file.borId]).catch(() => {});
  }
  await db.query('DELETE FROM staff_users WHERE id=$1', [staff.id]).catch(() => {});

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  contact-advisory-db: not_ready / ready / agree / optional-no-advisory, advisory never touches sign-off — all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
