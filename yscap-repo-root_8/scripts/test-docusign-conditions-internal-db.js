'use strict';
/*
 * The three DocuSign-resolved conditions are INTERNAL (owner-directed 2026-08-04,
 * item #26): Term Sheet, Application & Disclosure, Heter Iska are visible to the
 * team but NOT to the borrower, with an auto-fulfilment note — the signed documents
 * themselves stay borrower-visible. db/467.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
if (!process.env.DATABASE_URL) { console.log('SKIP test-docusign-conditions-internal-db (no DATABASE_URL)'); process.exit(0); }

const assert = require('assert');
const db = require('../src/db');
const CODES = ['rtl_cond_signedts', 'rtl_cond_signed_app', 'rtl_cond_iska'];
let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

(async () => {
  /* 1) All three templates are internal + carry the auto-fulfil note. */
  const t = await db.query(
    `SELECT code, audience, hint FROM checklist_templates WHERE code = ANY($1)`, [CODES]);
  assert.equal(t.rows.length, 3, 'the three DocuSign templates exist');
  for (const row of t.rows) {
    assert.equal(row.audience, 'staff', `${row.code} is internal (audience=staff)`);
    assert.ok(/automatically fulfilled|DocuSign/i.test(row.hint || ''), `${row.code} hint notes it is auto-fulfilled by the DocuSign package`);
  }
  ok('#26: all three DocuSign conditions are internal (audience=staff) with the auto-fulfil note');

  /* 2) It survives a re-run of ensureSchema — db/159/146 set some of them 'both' on
     every boot, and db/467 (higher) must win. Re-apply and re-check. */
  await require('../src/migrate-boot').ensureSchema();
  const t2 = await db.query(`SELECT code, audience FROM checklist_templates WHERE code = ANY($1)`, [CODES]);
  for (const row of t2.rows) assert.equal(row.audience, 'staff', `${row.code} stays internal after a boot re-assert`);
  ok('db/467 wins over the boot-time db/159/146 audience re-assert (stable)');

  /* 3) A new item created from the template inherits 'staff', is hidden from the
     borrower checklist query, yet its SIGNED document stays borrower-visible. */
  const suffix = Date.now();
  const br = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Ds','Tester',$1) RETURNING id`, [`ds-${suffix}@example.com`])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, ys_loan_number, property_address, program, loan_type, status)
     VALUES ($1,$2,$3,'gold','purchase','processing') RETURNING id`,
    [br.id, `DS-${suffix}`, JSON.stringify({ oneLine: '9 Test St' })])).rows[0];
  const tpl = (await db.query(`SELECT id, audience, label, hint FROM checklist_templates WHERE code='rtl_cond_signedts'`)).rows[0];
  const item = (await db.query(
    `INSERT INTO checklist_items (scope, application_id, template_id, label, hint, audience, item_kind, is_required, status, created_by_kind)
     VALUES ('application',$1,$2,$3,$4,$5,'document',true,'outstanding','staff') RETURNING id`,
    [app.id, tpl.id, tpl.label, tpl.hint, tpl.audience])).rows[0];
  assert.equal((await db.query(`SELECT audience FROM checklist_items WHERE id=$1`, [item.id])).rows[0].audience, 'staff',
    'a new signed-term-sheet item is internal');
  // Borrower checklist query shape (audience IN ('borrower','both')) must EXCLUDE it.
  const borrowerSees = await db.query(
    `SELECT 1 FROM checklist_items WHERE id=$1 AND audience IN ('borrower','both')`, [item.id]);
  assert.equal(borrowerSees.rows.length, 0, 'the borrower does NOT see the internal condition on their checklist');
  // The signed document (visibility='borrower') stays visible in the borrower library.
  await db.query(
    `INSERT INTO documents (borrower_id, application_id, checklist_item_id, filename, content_type, size_bytes, storage_provider, storage_ref, uploaded_by_kind, doc_kind, visibility)
     VALUES ($1,$2,$3,'term-sheet-signed.pdf','application/pdf',100,'local','x','system','term_sheet_signed','borrower')`,
    [br.id, app.id, item.id]);
  const lib = await db.query(
    `SELECT id FROM documents WHERE borrower_id=$1 AND application_id=$2 AND visibility='borrower' AND source_type <> 'chat_attachment'`,
    [br.id, app.id]);
  assert.ok(lib.rows.length === 1, 'the borrower can still see their SIGNED term sheet in the document library');
  ok('signed documents stay borrower-visible even though the condition is internal');

  await db.query(`DELETE FROM documents WHERE application_id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM applications WHERE id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [br.id]).catch(() => {});

  console.log(`\nAll DocuSign-conditions-internal checks passed (${n}).`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
