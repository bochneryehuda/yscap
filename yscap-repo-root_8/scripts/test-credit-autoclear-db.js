'use strict';
/**
 * DB test for the credit-condition auto-clear (IG-W2, src/lib/credit/completeness.js
 * + the db/286 co-borrower-change trigger).
 *
 * Proves the never-false-clear discipline end to end:
 *   • a single-borrower file with a report + PDF → creditCompleteness complete;
 *     with the env switch ON, importCredit auto-satisfies the condition (system
 *     sign-off, signed_off_by NULL, [auto] note); with the switch OFF it stays 'received'.
 *   • a DATA-ONLY report (no PDF) → NOT complete → never auto-cleared.
 *   • a two-borrower file with only ONE report → NOT complete (both are needed).
 *   • both borrowers imported + PDFs → complete → auto-satisfied.
 *   • a rejected / superseded PDF flips completeness back to false.
 *   • adding/changing the co-borrower REOPENS an auto-cleared condition (db/286).
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-credit-autoclear-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-credit-autoclear-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const assert = require('assert');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const cfg = require('../src/config');
const { ensureSchema } = require('../src/migrate-boot');
const credit = require('../src/lib/credit');
const { creditCompleteness, maybeAutoSatisfyCredit } = require('../src/lib/credit/completeness');

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<RESPONSE_GROUP><RESPONSE><RESPONSE_DATA>
 <CREDIT_RESPONSE CreditReportIdentifier="XAC-AC-1" CreditReportFirstIssuedDate="2026-07-21" CreditRatingCodeType="TriMerge">
  <BORROWER _FirstName="Dana" _LastName="Autoclear" _SSN="123456789" BorrowerID="B1"/>
  <CREDIT_SCORE _Value="712" CreditRepositorySourceType="Equifax" _BorrowerID="B1"/>
  <CREDIT_SCORE _Value="698" CreditRepositorySourceType="Experian" _BorrowerID="B1"/>
  <CREDIT_SCORE _Value="705" CreditRepositorySourceType="TransUnion" _BorrowerID="B1"/>
 </CREDIT_RESPONSE>
</RESPONSE_DATA></RESPONSE></RESPONSE_GROUP>`;
const PDF_B64 = Buffer.from('%PDF-1.4\n% credit autoclear test\n').toString('base64');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// Seed one file with the file-level Credit report condition. Returns ids.
async function seedFile(staffId, first, ssn9) {
  const ssn = C.ssnForStorage(ssn9);
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,date_of_birth,ssn_encrypted,ssn_last4)
     VALUES ($1,'Autoclear',$2,'1985-04-02',$3,$4) RETURNING id`,
    [first, `ac_${first}_${process.pid}@example.com`, ssn.encrypted, ssn.last4])).rows[0];
  const app = (await db.query('INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id', [bor.id])).rows[0];
  const item = (await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, borrower_label, audience, item_kind, role_scope, phase, hint, borrower_hint,
        is_gate, is_milestone, sort_order, tool_key, clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id)
     SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind, COALESCE(t.role_scope,'processor'),
            t.phase, t.hint, t.borrower_hint, COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
            COALESCE(t.sort_order,404), t.tool_key, t.clickup_field_id, COALESCE(t.tpr_exclude,false), 'system',
            COALESCE(t.is_required,true), $1
       FROM checklist_templates t WHERE t.code='rtl_cond_credit' RETURNING id`, [app.id])).rows[0];
  return { borId: bor.id, appId: app.id, itemId: item.id, ssn };
}

async function condRow(itemId) {
  return (await db.query('SELECT status, signed_off_at, signed_off_by, notes FROM checklist_items WHERE id=$1', [itemId])).rows[0];
}

(async () => {
  await ensureSchema();
  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'AC Tester','processor',true) RETURNING id`,
    [`acstaff_${process.pid}@example.com`])).rows[0];

  // ── 1) DISABLED: import a report + PDF, auto-clear off → condition stays 'received'
  cfg.creditAutoclearEnabled = false;
  const f1 = await seedFile(staff.id, 'Off', '123456789');
  await credit.importCredit(f1.appId, { xml: XML, pdfBase64: PDF_B64, actorId: staff.id });
  const c1 = await creditCompleteness(db, f1.appId, null);
  ok(c1.complete === true, 'completeness is TRUE for a single borrower with report + PDF');
  const r1 = await condRow(f1.itemId);
  ok(r1.status === 'received', `switch OFF → condition NOT auto-cleared, stays 'received' (got ${r1.status})`);

  // now turn it on and call the helper directly → it clears (system sign-off)
  cfg.creditAutoclearEnabled = true;
  const m1 = await maybeAutoSatisfyCredit(db, f1.appId, f1.itemId, null);
  ok(m1.satisfied === true && m1.enabled === true, 'switch ON + complete → maybeAutoSatisfyCredit clears the condition');
  const r1b = await condRow(f1.itemId);
  ok(r1b.status === 'satisfied' && r1b.signed_off_at && r1b.signed_off_by === null,
    'auto-clear is a SYSTEM sign-off: satisfied + signed_off_at set + signed_off_by NULL (never a fake human)');
  ok((r1b.notes || '').startsWith('[auto]'), 'auto-clear leaves an [auto] note');
  // idempotent: a second call is a no-op
  const m1c = await maybeAutoSatisfyCredit(db, f1.appId, f1.itemId, null);
  ok(m1c.satisfied === false && m1c.reason === 'already_satisfied', 'a second auto-clear pass is a no-op (already satisfied)');

  // ── 2) DATA-ONLY (no PDF): never auto-cleared even with the switch on
  cfg.creditAutoclearEnabled = true;
  const f2 = await seedFile(staff.id, 'Nopdf', '123456789');
  await credit.importCredit(f2.appId, { xml: XML, actorId: staff.id });   // XML only, no PDF
  const c2 = await creditCompleteness(db, f2.appId, null);
  ok(c2.complete === false && c2.unmetPdf.length === 1, 'a data-only report (no PDF) is NOT complete (unmetPdf)');
  const r2 = await condRow(f2.itemId);
  ok(r2.status === 'received', `data-only import is never auto-cleared, stays 'received' (got ${r2.status})`);

  // ── 3) TWO borrowers, only the PRIMARY has a report → file-level condition needs
  //       BOTH → not complete. Use store.storeImport (per-borrower, NO split-condition
  //       logic) so both reports live on the file-level condition and the co-borrower
  //       does NOT get their own cob_credit condition — this exercises the two-borrower
  //       need[] path directly (importing only the primary would open the co's own
  //       condition and legitimately leave the file-level condition covering only the
  //       primary, which is a different, already-covered case).
  const store = require('../src/lib/credit/store');
  const { parseCreditXml } = require('../src/lib/credit/parse');
  const REQ = { pullType: 'soft', requestType: 'reissue', bureaus: ['Equifax', 'Experian', 'TransUnion'], version: '3.4' };
  cfg.creditAutoclearEnabled = true;
  const f3 = await seedFile(staff.id, 'Pri', '123456789');
  const coSsn = C.ssnForStorage('987654321');
  const co = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,ssn_encrypted,ssn_last4)
     VALUES ('Co','Autoclear',$1,$2,$3) RETURNING id`,
    [`ac_co_${process.pid}@example.com`, coSsn.encrypted, coSsn.last4])).rows[0];
  await db.query('UPDATE applications SET co_borrower_id=$2 WHERE id=$1', [f3.appId, co.id]);
  await store.storeImport({ file: { id: f3.appId }, borrower: { id: f3.borId, ssn_last4: f3.ssn.last4 },
    parsed: parseCreditXml(XML), xml: XML, pdfBase64: PDF_B64, request: REQ, actorId: staff.id, source: 'upload' });
  const c3 = await creditCompleteness(db, f3.appId, null);
  ok(c3.need.length === 2 && c3.complete === false && c3.unmetReport.length === 1,
    'two borrowers, only the primary imported → file-level condition NOT complete (co-borrower unmet)');
  const m3 = await maybeAutoSatisfyCredit(db, f3.appId, f3.itemId, null);
  ok(m3.satisfied === false && m3.reason === 'incomplete', 'the two-borrower file is not auto-cleared until BOTH reports are in');
  ok((await condRow(f3.itemId)).status !== 'satisfied', 'the two-borrower file-level condition stays open');

  // ── 4) both borrowers imported + PDF → complete → auto-cleared
  const CO_XML = XML.replace('_SSN="123456789"', '_SSN="987654321"').replace('XAC-AC-1', 'XAC-AC-CO');
  await store.storeImport({ file: { id: f3.appId }, borrower: { id: co.id, ssn_last4: coSsn.last4 },
    parsed: parseCreditXml(CO_XML), xml: CO_XML, pdfBase64: PDF_B64, request: REQ, actorId: staff.id, source: 'upload' });
  const c4 = await creditCompleteness(db, f3.appId, null);
  ok(c4.complete === true, 'both borrowers with report + PDF → file-level condition complete');
  const m4 = await maybeAutoSatisfyCredit(db, f3.appId, f3.itemId, null);
  ok(m4.satisfied === true, 'both imported → the file condition auto-clears');
  const r4 = await condRow(f3.itemId);
  ok(r4.status === 'satisfied' && r4.signed_off_by === null, 'both imported → satisfied as a system sign-off');

  // ── 5) a REJECTED co-borrower PDF flips completeness back to false (never clear off a bad PDF)
  await db.query(
    `UPDATE documents SET review_status='rejected'
      WHERE application_id=$1 AND doc_kind='credit_pdf' AND borrower_id=$2 AND is_current=true`,
    [f3.appId, co.id]);
  const c5 = await creditCompleteness(db, f3.appId, null);
  ok(c5.complete === false && c5.unmetPdf.length === 1, 'a rejected co-borrower PDF flips completeness back to false');

  // ── 6) db/286: changing the co-borrower REOPENS an auto-cleared condition
  // Start clean: a single-borrower file auto-cleared, then link a co-borrower.
  cfg.creditAutoclearEnabled = true;
  const f6 = await seedFile(staff.id, 'Reopen', '123456789');
  await credit.importCredit(f6.appId, { xml: XML, pdfBase64: PDF_B64, actorId: staff.id });
  // Auto-sign-off RETIRED (owner-directed 2026-07-24): the credit IMPORT no longer
  // auto-signs-off the condition — PILOT never clears a Condition Center condition
  // itself, a human does. So the import leaves it open; establish the SYSTEM [auto]
  // clear directly via the (retained) completeness helper so the db/286 reopen trigger
  // — which only reopens a system [auto] clear, never a human sign-off — can be exercised.
  ok((await condRow(f6.itemId)).status !== 'satisfied', 'baseline: the credit import does NOT auto-sign-off (a human clears it)');
  await maybeAutoSatisfyCredit(db, f6.appId, f6.itemId, null);
  const r6a = await condRow(f6.itemId);
  ok(r6a.status === 'satisfied' && r6a.signed_off_by === null, 'a system [auto] clear can still be established (for the reopen test)');
  const co6 = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Co6','Autoclear',$1) RETURNING id`,
    [`ac_co6_${process.pid}@example.com`])).rows[0];
  await db.query('UPDATE applications SET co_borrower_id=$2 WHERE id=$1', [f6.appId, co6.id]);
  const r6b = await condRow(f6.itemId);
  ok(r6b.status === 'received' && r6b.signed_off_at === null,
    'db/286: adding a co-borrower REOPENS the auto-cleared credit condition to received');
  ok((r6b.notes || '').startsWith('[auto]'), 'the reopen leaves an [auto] note');

  // ── 6b) db/286 must NOT reopen a HUMAN sign-off (signed_off_by set)
  const f6h = await seedFile(staff.id, 'Human', '123456789');
  await db.query(
    `UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2, notes='cleared by hand' WHERE id=$1`,
    [f6h.itemId, staff.id]);
  const coH = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('CoH','Autoclear',$1) RETURNING id`,
    [`ac_coh_${process.pid}@example.com`])).rows[0];
  await db.query('UPDATE applications SET co_borrower_id=$2 WHERE id=$1', [f6h.appId, coH.id]);
  const r6h = await condRow(f6h.itemId);
  ok(r6h.status === 'satisfied' && String(r6h.signed_off_by) === String(staff.id),
    'db/286: a HUMAN sign-off is NOT reopened by a co-borrower change (only system [auto] clears are)');

  // ── 7) DISABLED again → maybeAutoSatisfyCredit reports enabled:false and does nothing
  cfg.creditAutoclearEnabled = false;
  const f7 = await seedFile(staff.id, 'Off2', '123456789');
  await credit.importCredit(f7.appId, { xml: XML, pdfBase64: PDF_B64, actorId: staff.id });
  const m7 = await maybeAutoSatisfyCredit(db, f7.appId, f7.itemId, null);
  ok(m7.enabled === false && m7.satisfied === false, 'switch OFF → maybeAutoSatisfyCredit is enabled:false, does nothing');
  ok((await condRow(f7.itemId)).status === 'received', 'switch OFF → condition remains received');

  // cleanup (throwaway DB, but tidy)
  cfg.creditAutoclearEnabled = false;
  for (const appId of [f1.appId, f2.appId, f3.appId, f6.appId, f6h.appId, f7.appId]) {
    await db.query('UPDATE applications SET co_borrower_id=NULL WHERE id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM credit_reports WHERE application_id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM documents WHERE application_id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM checklist_items WHERE application_id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM applications WHERE id=$1', [appId]).catch(() => {});
  }
  for (const bid of [f1.borId, f2.borId, f3.borId, co, f6.borId, co6, f6h.borId, coH, f7.borId]) {
    await db.query('DELETE FROM borrowers WHERE id=$1', [bid && bid.id ? bid.id : bid]).catch(() => {});
  }
  await db.query('DELETE FROM staff_users WHERE id=$1', [staff.id]).catch(() => {});

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  credit-autoclear-db: completeness, auto-clear on/off, data-only guard, two-borrower gate, rejected-PDF guard, db/286 reopen — all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
