'use strict';
/**
 * DB test for the SSN-verification condition auto-clear — CorrFirst only (IG-W4,
 * src/lib/underwriting/ssn-autoclear.js + the db/291 co-borrower/lender-change trigger).
 *
 * Proves the never-false-clear discipline end to end:
 *   • CorrFirst + a completed credit report whose SSN last-4 matches the SSN on file
 *     → verified → with the env switch ON the condition auto-clears (system sign-off,
 *     signed_off_by NULL, [auto] note); with the switch OFF it stays 'received'.
 *   • the CorrFirst-ONLY gate: a NON-CorrFirst note buyer is never auto-cleared, even
 *     with a matching report and the switch on.
 *   • a report whose SSN last-4 DIFFERS from the file (the FICO-mismatch signal) → NOT
 *     verified → never auto-cleared.
 *   • no SSN on file → NOT verified.
 *   • a two-borrower file with only the primary's matching report → NOT complete (both
 *     are needed); both matched → complete → auto-cleared.
 *   • db/291: changing the note buyer AWAY from CorrFirst REOPENS an auto-cleared
 *     condition; adding a co-borrower REOPENS it too.
 *   • a HUMAN sign-off is never touched.
 *   • the credit-import hook (store.storeImport → autoClearSsnCondition) clears live.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-ssn-autoclear-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-ssn-autoclear-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const C = require('../src/lib/crypto');
const cfg = require('../src/config');
const { ensureSchema } = require('../src/migrate-boot');
const {
  noteBuyerIsCorrFirst, ssnVerifiedForBorrower, ssnCompleteness, maybeAutoSatisfySsn, SSN_TEMPLATE_CODE,
} = require('../src/lib/underwriting/ssn-autoclear');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// Seed a file (borrower with SSN, the SSN-verification condition, note buyer = lender).
//
// The condition is seeded from `code` — defaulting to the LIVE template
// `cond_ssn_verify_corrfirst` (db/397). It used to be hard-coded to `rtl_p1_ssn`, which
// db/040 retired and deleted off every open file: the template row still exists, so this
// suite passed while the module it tests could never find a condition on a real file.
// The retired code is still accepted as an argument so the legacy path stays covered.
async function seedFile(first, ssn9, lender, code = 'cond_ssn_verify_corrfirst') {
  const ssn = ssn9 ? C.ssnForStorage(ssn9) : { encrypted: null, last4: null };
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,ssn_encrypted,ssn_last4)
     VALUES ($1,'SsnAc',$2,$3,$4) RETURNING id`,
    [first, `ssnac_${first}_${process.pid}@example.com`, ssn.encrypted, ssn.last4])).rows[0];
  const app = (await db.query(
    'INSERT INTO applications (borrower_id, lender) VALUES ($1,$2) RETURNING id', [bor.id, lender || null])).rows[0];
  const item = (await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, borrower_label, audience, item_kind, role_scope, phase, is_required, application_id, status)
     SELECT t.id, t.scope, t.label, t.label, t.audience, t.item_kind, COALESCE(t.role_scope,'loan_officer'),
            t.phase, COALESCE(t.is_required,true), $1, 'outstanding'
       FROM checklist_templates t WHERE t.code=$2 RETURNING id`, [app.id, code])).rows[0];
  return { borId: bor.id, appId: app.id, itemId: item.id, ssnLast4: ssn.last4 };
}

// Insert a completed credit_reports row with a parsed borrower SSN last-4.
async function insertReport(appId, borrowerId, ssnLast4) {
  await db.query(
    `INSERT INTO credit_reports
       (application_id, borrower_id, vendor, pull_type, request_type, status, source, middle_score, parsed)
     VALUES ($1,$2,'xactus','soft','reissue','completed','api',712,$3)`,
    [appId, borrowerId, JSON.stringify({ borrower: { ssnLast4 } })]);
}

async function condRow(itemId) {
  return (await db.query('SELECT status, signed_off_at, signed_off_by, notes FROM checklist_items WHERE id=$1', [itemId])).rows[0];
}

(async () => {
  await ensureSchema();

  // ── 1) CorrFirst + matching report → verified → auto-clears (switch ON), stays (switch OFF)
  cfg.ssnAutoclearEnabled = false;
  const f1 = await seedFile('Cf', '123456789', 'CorrFirst');           // last4 = 6789
  await insertReport(f1.appId, f1.borId, f1.ssnLast4);
  ok(await noteBuyerIsCorrFirst(db, f1.appId) === true, 'note buyer "CorrFirst" normalizes to the CorrFirst gate');
  ok(await ssnVerifiedForBorrower(db, f1.appId, f1.borId) === true, 'a completed report whose SSN last-4 matches the file → verified');
  const c1 = await ssnCompleteness(db, f1.appId);
  ok(c1.corrfirst === true && c1.complete === true, 'CorrFirst single borrower with a matching report → completeness TRUE');
  const m1off = await maybeAutoSatisfySsn(db, f1.appId, f1.itemId);
  ok(m1off.enabled === false && m1off.satisfied === false, 'switch OFF → does nothing');
  ok((await condRow(f1.itemId)).status === 'outstanding', 'switch OFF → condition stays open');
  cfg.ssnAutoclearEnabled = true;
  const m1 = await maybeAutoSatisfySsn(db, f1.appId, f1.itemId);
  ok(m1.satisfied === true, 'switch ON + complete → the SSN condition auto-clears');
  const r1 = await condRow(f1.itemId);
  ok(r1.status === 'satisfied' && r1.signed_off_at && r1.signed_off_by === null, 'auto-clear is a SYSTEM sign-off (signed_off_by NULL)');
  ok((r1.notes || '').startsWith('[auto]'), 'auto-clear leaves an [auto] note');
  const m1b = await maybeAutoSatisfySsn(db, f1.appId, f1.itemId);
  ok(m1b.satisfied === false && m1b.reason === 'already_satisfied', 'a second pass is a no-op');

  // ── 1b) THE CONDITION IT TARGETS IS REAL. Everything above ran against
  // `cond_ssn_verify_corrfirst` (db/397). Before it existed this module targeted
  // `rtl_p1_ssn`, which db/040 retired and deleted off every open file, so it could
  // never find anything to clear on a live file — the owner's "SS NUMBER VERIFICATION
  // — no condition on the file" (2026-08-02). Two guards so that cannot recur:
  // the targeted template must be ACTIVE (a retired one can never be on a file), and
  // a HISTORICAL instance of the old code must still behave, since a terminal file may
  // still carry one.
  {
    const live = (await db.query(
      `SELECT is_active FROM checklist_templates WHERE code=$1`, [SSN_TEMPLATE_CODE])).rows[0];
    ok(!!live && live.is_active === true,
      'the template ssn-autoclear targets is ACTIVE — a retired one could never be on a file');
    const legacy = await seedFile('Legacy', '123456789', 'CorrFirst', 'rtl_p1_ssn');
    await insertReport(legacy.appId, legacy.borId, legacy.ssnLast4);
    const mL = await maybeAutoSatisfySsn(db, legacy.appId, legacy.itemId);
    ok(mL.satisfied === true, 'a historical rtl_p1_ssn instance on an old file still auto-clears');
    await db.query('DELETE FROM credit_reports WHERE application_id=$1', [legacy.appId]).catch(() => {});
    await db.query('DELETE FROM checklist_items WHERE application_id=$1', [legacy.appId]).catch(() => {});
    await db.query('DELETE FROM applications WHERE id=$1', [legacy.appId]).catch(() => {});
    await db.query('DELETE FROM borrowers WHERE id=$1', [legacy.borId]).catch(() => {});
  }

  // ── 2) CorrFirst-ONLY gate: a non-CorrFirst note buyer is never auto-cleared
  cfg.ssnAutoclearEnabled = true;
  const f2 = await seedFile('Bl', '123456789', 'Blue Lake');
  await insertReport(f2.appId, f2.borId, f2.ssnLast4);
  ok(await noteBuyerIsCorrFirst(db, f2.appId) === false, 'a Blue Lake note buyer is NOT CorrFirst');
  const c2 = await ssnCompleteness(db, f2.appId);
  ok(c2.corrfirst === false && c2.complete === false, 'non-CorrFirst → completeness FALSE (CorrFirst-only)');
  const m2 = await maybeAutoSatisfySsn(db, f2.appId, f2.itemId);
  ok(m2.satisfied === false && m2.complete === false, 'non-CorrFirst → never auto-cleared even with a matching report');
  ok((await condRow(f2.itemId)).status === 'outstanding', 'non-CorrFirst → condition stays open');

  // ── 3) SSN MISMATCH (report names a different last-4) → not verified
  const f3 = await seedFile('Mismatch', '123456789', 'CorrFirst');     // file last4 = 6789
  await insertReport(f3.appId, f3.borId, '0000');                       // report last4 = 0000
  ok(await ssnVerifiedForBorrower(db, f3.appId, f3.borId) === false, 'a report whose SSN last-4 DIFFERS → NOT verified');
  const m3 = await maybeAutoSatisfySsn(db, f3.appId, f3.itemId);
  ok(m3.satisfied === false && m3.reason === 'incomplete', 'SSN mismatch → never auto-cleared');

  // ── 4) no SSN on file → not verified
  const f4 = await seedFile('NoSsn', null, 'CorrFirst');
  await insertReport(f4.appId, f4.borId, '6789');
  ok(await ssnVerifiedForBorrower(db, f4.appId, f4.borId) === false, 'no SSN on file → NOT verified (nothing to match)');
  ok((await ssnCompleteness(db, f4.appId)).complete === false, 'no SSN on file → not complete');

  // ── 5) two borrowers: only the primary matched → not complete; both matched → complete → cleared
  cfg.ssnAutoclearEnabled = true;
  const f5 = await seedFile('Pri5', '123456789', 'CorrFirst');
  const coSsn = C.ssnForStorage('987654321');                          // last4 = 4321
  const co5 = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,ssn_encrypted,ssn_last4)
     VALUES ('Co5','SsnAc',$1,$2,$3) RETURNING id`,
    [`ssnac_co5_${process.pid}@example.com`, coSsn.encrypted, coSsn.last4])).rows[0];
  await db.query('UPDATE applications SET co_borrower_id=$2 WHERE id=$1', [f5.appId, co5.id]);
  await insertReport(f5.appId, f5.borId, f5.ssnLast4);                  // only the primary
  const c5a = await ssnCompleteness(db, f5.appId);
  ok(c5a.need.length === 2 && c5a.complete === false && c5a.unverified.length === 1,
    'two borrowers, only the primary matched → NOT complete (co-borrower unverified)');
  const m5a = await maybeAutoSatisfySsn(db, f5.appId, f5.itemId);
  ok(m5a.satisfied === false && m5a.reason === 'incomplete', 'two-borrower file not cleared until BOTH are matched');
  await insertReport(f5.appId, co5.id, coSsn.last4);                    // now the co-borrower too
  const c5b = await ssnCompleteness(db, f5.appId);
  ok(c5b.complete === true, 'both borrowers matched → complete');
  const m5b = await maybeAutoSatisfySsn(db, f5.appId, f5.itemId);
  ok(m5b.satisfied === true, 'both matched → the file condition auto-clears');

  // ── 6) db/291: changing the note buyer AWAY from CorrFirst reopens an auto-cleared condition
  cfg.ssnAutoclearEnabled = true;
  const f6 = await seedFile('Reopen', '123456789', 'CorrFirst');
  await insertReport(f6.appId, f6.borId, f6.ssnLast4);
  await maybeAutoSatisfySsn(db, f6.appId, f6.itemId);
  ok((await condRow(f6.itemId)).status === 'satisfied', 'baseline: CorrFirst file auto-cleared');
  await db.query(`UPDATE applications SET lender='Blue Lake' WHERE id=$1`, [f6.appId]);
  const r6 = await condRow(f6.itemId);
  ok(r6.status === 'received' && r6.signed_off_at === null, 'db/291: moving off CorrFirst REOPENS the auto-cleared SSN condition');
  ok((r6.notes || '').startsWith('[auto]'), 'the reopen leaves an [auto] note');

  // ── 6b) db/291: adding a co-borrower reopens an auto-cleared condition
  const f6c = await seedFile('Reopen2', '123456789', 'CorrFirst');
  await insertReport(f6c.appId, f6c.borId, f6c.ssnLast4);
  await maybeAutoSatisfySsn(db, f6c.appId, f6c.itemId);
  ok((await condRow(f6c.itemId)).status === 'satisfied', 'baseline: single-borrower CorrFirst file auto-cleared');
  const co6 = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Co6','SsnAc',$1) RETURNING id`,
    [`ssnac_co6_${process.pid}@example.com`])).rows[0];
  await db.query('UPDATE applications SET co_borrower_id=$2 WHERE id=$1', [f6c.appId, co6.id]);
  ok((await condRow(f6c.itemId)).status === 'received', 'db/291: adding a co-borrower REOPENS the auto-cleared SSN condition');

  // ── 7) db/291 must NOT reopen a HUMAN sign-off
  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'SSN Tester','loan_officer',true) RETURNING id`,
    [`ssnstaff_${process.pid}@example.com`])).rows[0];
  const f7 = await seedFile('Human', '123456789', 'CorrFirst');
  await db.query(
    `UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2, notes='cleared by hand' WHERE id=$1`,
    [f7.itemId, staff.id]);
  await db.query(`UPDATE applications SET lender='Fidelis' WHERE id=$1`, [f7.appId]);
  const r7 = await condRow(f7.itemId);
  ok(r7.status === 'satisfied' && String(r7.signed_off_by) === String(staff.id),
    'db/291: a HUMAN sign-off is NOT reopened by a note-buyer change (only system [auto] clears are)');
  // and maybeAutoSatisfySsn refuses to touch a human sign-off
  const m7 = await maybeAutoSatisfySsn(db, f7.appId, f7.itemId);
  ok(m7.reason === 'human_signed_off', 'maybeAutoSatisfySsn never touches a human sign-off');

  // ── 8) the credit-import hook clears live (store.storeImport → autoClearSsnCondition)
  cfg.ssnAutoclearEnabled = true;
  const store = require('../src/lib/credit/store');
  const { parseCreditXml } = require('../src/lib/credit/parse');
  const XML = `<?xml version="1.0"?>
   <RESPONSE_GROUP><RESPONSE><RESPONSE_DATA>
    <CREDIT_RESPONSE CreditReportIdentifier="XAC-SSN-1" CreditRatingCodeType="TriMerge">
     <BORROWER _FirstName="Hook" _LastName="SsnAc" _SSN="123456789" BorrowerID="B1"/>
     <CREDIT_SCORE _Value="712" CreditRepositorySourceType="Equifax" _BorrowerID="B1"/>
     <CREDIT_SCORE _Value="705" CreditRepositorySourceType="Experian" _BorrowerID="B1"/>
     <CREDIT_SCORE _Value="700" CreditRepositorySourceType="TransUnion" _BorrowerID="B1"/>
    </CREDIT_RESPONSE>
   </RESPONSE_DATA></RESPONSE></RESPONSE_GROUP>`;
  const f8 = await seedFile('Hook', '123456789', 'CorrFirst');
  await store.storeImport({ file: { id: f8.appId }, borrower: { id: f8.borId, ssn_last4: f8.ssnLast4 },
    parsed: parseCreditXml(XML), xml: XML, request: { pullType: 'soft', requestType: 'reissue',
      bureaus: ['Equifax', 'Experian', 'TransUnion'], version: '3.4' }, actorId: staff.id, source: 'upload' });
  const r8 = await condRow(f8.itemId);
  // Auto-sign-off RETIRED (owner-directed 2026-07-24): the credit import no longer
  // signs off the SSN condition — PILOT never clears a Condition Center condition
  // itself, a human does. The import still lands the matching report (so the advisory
  // overlay can mark the condition ready); the condition itself stays open for a human.
  ok(r8.status !== 'satisfied' && r8.signed_off_by === null,
    'the credit import does NOT auto-sign-off the SSN condition (PILOT advises; a human clears it)');

  // cleanup (throwaway DB, but tidy)
  cfg.ssnAutoclearEnabled = false;
  const apps = [f1.appId, f2.appId, f3.appId, f4.appId, f5.appId, f6.appId, f6c.appId, f7.appId, f8.appId];
  for (const appId of apps) {
    await db.query('UPDATE applications SET co_borrower_id=NULL WHERE id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM credit_reports WHERE application_id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM checklist_items WHERE application_id=$1', [appId]).catch(() => {});
    await db.query('DELETE FROM applications WHERE id=$1', [appId]).catch(() => {});
  }
  for (const bid of [f1.borId, f2.borId, f3.borId, f4.borId, f5.borId, co5.id, f6.borId, f6c.borId, co6.id, f7.borId, f8.borId]) {
    await db.query('DELETE FROM borrowers WHERE id=$1', [bid]).catch(() => {});
  }
  await db.query('DELETE FROM staff_users WHERE id=$1', [staff.id]).catch(() => {});

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  ssn-autoclear-db: CorrFirst gate, SSN match/mismatch, no-SSN guard, two-borrower gate, auto-clear on/off, db/291 reopen (lender + co-borrower), human-signoff guard, import hook — all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
