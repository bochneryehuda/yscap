'use strict';
/**
 * End-to-end DB test for the credit-report import (src/lib/credit/*).
 * Seeds a borrower + application + the internal Credit report condition, imports
 * a tri-merge report via the DOWNLOADED-FILE path (no live Xactus needed), and
 * asserts the whole chain: PDF + XML documents stored on the condition, the
 * credit_reports row + parsed data, the condition moved to 'received', and the
 * middle score written back to borrowers.fico. Also proves a re-import supersedes
 * the prior documents. Requires DATABASE_URL; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-credit-import-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-credit-import-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const assert = require('assert');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const { ensureSchema } = require('../src/migrate-boot');
const credit = require('../src/lib/credit');

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<RESPONSE_GROUP><RESPONSE><RESPONSE_DATA>
 <CREDIT_RESPONSE CreditReportIdentifier="XAC-DBT-1" CreditReportFirstIssuedDate="2026-07-21" CreditRatingCodeType="TriMerge">
  <BORROWER _FirstName="Dana" _LastName="Borrower" _SSN="123456789" BorrowerID="B1">
    <_RESIDENCE _StreetAddress="9 Oak St" _City="Lakewood" _State="NJ" _PostalCode="08701"/>
  </BORROWER>
  <CREDIT_SCORE _Value="712" CreditRepositorySourceType="Equifax" _BorrowerID="B1"/>
  <CREDIT_SCORE _Value="698" CreditRepositorySourceType="Experian" _BorrowerID="B1"/>
  <CREDIT_SCORE _Value="705" CreditRepositorySourceType="TransUnion" _BorrowerID="B1"/>
  <CREDIT_LIABILITY CreditLiabilityAccountType="Revolving" _AccountStatusType="Open" _UnpaidBalanceAmount="900" CreditLimitAmount="4000" _MonthlyPaymentAmount="25">
    <_CREDITOR _Name="CHASE"/><CREDIT_REPOSITORY _SourceType="Equifax"/>
  </CREDIT_LIABILITY>
  <CREDIT_LIABILITY CreditLiabilityAccountType="Installment" _AccountStatusType="Open" _UnpaidBalanceAmount="12000" _MonthlyPaymentAmount="300">
    <_CREDITOR _Name="ALLY AUTO"/><CREDIT_REPOSITORY _SourceType="TransUnion"/>
  </CREDIT_LIABILITY>
  <CREDIT_INQUIRY _Name="AMEX" _Date="2026-06-01"/>
 </CREDIT_RESPONSE>
</RESPONSE_DATA></RESPONSE></RESPONSE_GROUP>`;
const PDF_B64 = Buffer.from('%PDF-1.4\n% credit report test\n').toString('base64');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

(async () => {
  await ensureSchema();
  const suffix = Date.now ? '' : ''; // (Date.now unused; keep deterministic)
  const email = `credittest_${process.pid}@example.com`;

  // Seed staff, borrower (with encrypted SSN + address), application.
  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Credit Tester','processor',true) RETURNING id`,
    [`stafftest_${process.pid}@example.com`])).rows[0];
  const ssn = C.ssnForStorage('123456789');
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,date_of_birth,ssn_encrypted,ssn_last4,current_address)
     VALUES ('Dana','Borrower',$1,'1985-04-02',$2,$3,$4) RETURNING id`,
    [email, ssn.encrypted, ssn.last4, JSON.stringify({ line1: '9 Oak St', city: 'Lakewood', state: 'NJ', zip: '08701' })])).rows[0];
  const app = (await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [bor.id])).rows[0];

  // Attach the Credit report condition (db/076 template) to this file.
  const item = (await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, borrower_label, audience, item_kind, role_scope, phase, hint, borrower_hint,
        is_gate, is_milestone, sort_order, tool_key, clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id)
     SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind, COALESCE(t.role_scope,'processor'),
            t.phase, t.hint, t.borrower_hint, COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
            COALESCE(t.sort_order,404), t.tool_key, t.clickup_field_id, COALESCE(t.tpr_exclude,false), 'system',
            COALESCE(t.is_required,true), $1
       FROM checklist_templates t WHERE t.code='rtl_cond_credit' RETURNING id`, [app.id])).rows[0];
  ok(!!item, 'seeded the Credit report condition on the file');

  // --- preview: shows the borrower info + defaults, ready to pull -------------
  const pv = await credit.preview(app.id);
  ok(pv.borrower.firstName === 'Dana' && pv.borrower.ssnMasked === '•••-••-6789', 'preview shows borrower + masked SSN');
  ok(pv.defaults.pullType === 'soft' && pv.defaults.requestType === 'reissue' && pv.defaults.version === '3.4', 'defaults: soft · reissue · v3.4');
  ok(pv.defaults.bureaus.length === 3, 'preview defaults tri-merge');
  ok(pv.canPull === true && pv.missing.length === 0, 'canPull with full PII');

  // --- import (downloaded-file path) -----------------------------------------
  const out = await credit.importCredit(app.id, { xml: XML, pdfBase64: PDF_B64, actorId: staff.id });
  ok(out.ok && out.source === 'upload', 'import ran via the upload path');
  ok(out.middleScore === 705, `middle score is 705 (got ${out.middleScore})`);
  ok(out.ficoWritten === 705, `FICO written back = 705 (got ${out.ficoWritten})`);
  ok(out.ficoMismatch === false, 'no FICO mismatch (SSN last-4 matches)');
  ok(out.hasPdf && out.hasXml, 'both PDF + XML stored');

  // credit_reports row
  const cr = (await db.query(`SELECT * FROM credit_reports WHERE application_id=$1`, [app.id])).rows[0];
  ok(cr && cr.middle_score === 705 && cr.status === 'completed', 'credit_reports row saved (completed, middle 705)');
  ok(cr.xml_document_id && cr.pdf_document_id, 'credit_reports links both documents');
  ok(cr.parsed && Array.isArray(cr.parsed.liabilities) && cr.parsed.liabilities.length === 2, 'parsed jsonb carries the 2 tradelines');
  ok(cr.pulled_by === staff.id, 'pulled_by recorded');

  // documents attached to the condition, staff-only, current
  const docs = (await db.query(
    `SELECT doc_kind, visibility, review_status, is_current, checklist_item_id FROM documents WHERE application_id=$1 ORDER BY doc_kind`, [app.id])).rows;
  ok(docs.length === 2, 'two documents stored');
  ok(docs.every(d => d.visibility === 'staff_only' && d.is_current && d.checklist_item_id === item.id), 'docs are staff-only, current, on the condition');
  ok(docs.some(d => d.doc_kind === 'credit_pdf') && docs.some(d => d.doc_kind === 'credit_xml'), 'credit_pdf + credit_xml kinds');
  const upl = (await db.query(`SELECT DISTINCT uploaded_by_id FROM documents WHERE application_id=$1 AND doc_kind IN ('credit_pdf','credit_xml')`, [app.id])).rows;
  ok(upl.length === 1 && upl[0].uploaded_by_id === staff.id, 'credit documents record the importer');

  // FICO written to the borrower (→ reopens pricing via db/126 trigger)
  const fico = (await db.query(`SELECT fico FROM borrowers WHERE id=$1`, [bor.id])).rows[0].fico;
  ok(fico === 705, `borrowers.fico updated to 705 (got ${fico})`);

  // condition moved to 'received'
  const st = (await db.query(`SELECT status FROM checklist_items WHERE id=$1`, [item.id])).rows[0].status;
  ok(st === 'received', `condition moved to 'received' (got ${st})`);

  // --- fileCredit section --------------------------------------------------
  const fc = await credit.fileCredit(app.id);
  ok(fc.hasReport && fc.report.middleScore === 705, 'fileCredit returns the latest report');
  ok(fc.report.liabilities.length === 2 && fc.report.inquiries.length === 1, 'section carries tradelines + inquiries');
  ok((fc.report.scores || []).length === 3, 'section carries all three bureau scores');

  // --- re-import supersedes the prior documents ------------------------------
  const out2 = await credit.importCredit(app.id, { xml: XML, pdfBase64: PDF_B64, actorId: staff.id });
  ok(out2.ok, 're-import ran');
  const cur = (await db.query(`SELECT COUNT(*)::int n FROM documents WHERE application_id=$1 AND is_current=true AND doc_kind IN ('credit_pdf','credit_xml')`, [app.id])).rows[0].n;
  ok(cur === 2, `only the fresh 2 docs are current after re-import (got ${cur})`);
  const total = (await db.query(`SELECT COUNT(*)::int n FROM credit_reports WHERE application_id=$1`, [app.id])).rows[0].n;
  ok(total === 2, `two credit_reports rows after two imports (got ${total})`);

  // --- M1 regression: a no-hit / thin-file report (reject codes) must NOT crash
  // the 300-850 middle_score column, must not overwrite an existing FICO --------
  const NOHIT_XML = `<?xml version="1.0"?><RESPONSE_GROUP><RESPONSE><RESPONSE_DATA>
    <CREDIT_RESPONSE CreditReportIdentifier="XAC-NOHIT">
      <BORROWER _FirstName="Dana" _LastName="Borrower" _SSN="123456789"/>
      <CREDIT_SCORE _Value="0" CreditRepositorySourceType="Equifax"/>
      <CREDIT_SCORE _Value="9002" CreditRepositorySourceType="Experian"/>
      <CREDIT_SCORE _Value="9002" CreditRepositorySourceType="TransUnion"/>
    </CREDIT_RESPONSE></RESPONSE_DATA></RESPONSE></RESPONSE_GROUP>`;
  let noHitErr = null, out3 = null;
  try { out3 = await credit.importCredit(app.id, { xml: NOHIT_XML, actorId: staff.id }); }
  catch (e) { noHitErr = e; }
  ok(!noHitErr && out3 && out3.ok, `no-hit / thin-file import does NOT crash (M1)${noHitErr ? ' — ' + noHitErr.message : ''}`);
  ok(out3 && out3.middleScore == null, 'no-hit → middle score null');
  const crNoHit = (await db.query(`SELECT middle_score, status FROM credit_reports WHERE application_id=$1 ORDER BY pulled_at DESC LIMIT 1`, [app.id])).rows[0];
  ok(crNoHit.middle_score === null && crNoHit.status === 'completed', 'no-hit credit_reports row saved with null middle score');
  ok((await db.query(`SELECT fico FROM borrowers WHERE id=$1`, [bor.id])).rows[0].fico === 705, 'no-hit import does not overwrite the existing FICO (stays 705)');

  // --- same M1 class: a MALFORMED report DATE must NOT crash the typed date column
  const BADDATE_XML = `<?xml version="1.0"?><RESPONSE_GROUP><RESPONSE><RESPONSE_DATA>
    <CREDIT_RESPONSE CreditReportIdentifier="XAC-BADDATE" CreditReportFirstIssuedDate="2026-13-45">
      <BORROWER _FirstName="Dana" _LastName="Borrower" _SSN="123456789"/>
      <CREDIT_SCORE _Value="701" CreditRepositorySourceType="Equifax"/>
    </CREDIT_RESPONSE></RESPONSE_DATA></RESPONSE></RESPONSE_GROUP>`;
  let bdErr = null, out4 = null;
  try { out4 = await credit.importCredit(app.id, { xml: BADDATE_XML, actorId: staff.id }); }
  catch (e) { bdErr = e; }
  ok(!bdErr && out4 && out4.ok, `malformed report date does NOT crash the import (M1 class)${bdErr ? ' — ' + bdErr.message : ''}`);
  const crBad = (await db.query(`SELECT report_date, status FROM credit_reports WHERE application_id=$1 ORDER BY pulled_at DESC LIMIT 1`, [app.id])).rows[0];
  ok(crBad && crBad.report_date === null && crBad.status === 'completed', 'malformed report date stored as null, row still saved');

  // cleanup (throwaway DB, but be tidy)
  await db.query(`DELETE FROM applications WHERE id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor.id]).catch(() => {});
  await db.query(`DELETE FROM staff_users WHERE id=$1`, [staff.id]).catch(() => {});

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  credit-import-db: preview, import, store, docs, FICO write-back, condition, section, re-import supersede — all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
