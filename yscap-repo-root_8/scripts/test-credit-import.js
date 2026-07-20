/* End-to-end credit order+import integration test (Phase 1e).
 * Requires a Postgres with the migrations applied (NOT in `npm test`). Run:
 *   DATABASE_URL=postgres://postgres@127.0.0.1:5442/yscap XACTUS_ENDPOINT=http://x \
 *     node scripts/test-credit-import.js
 * XACTUS_ENDPOINT must be set (any dummy URL) — orderAndImport requires the endpoint
 * to be configured even though this test injects a no-network transport.
 * Uses an INJECTED transport (no network). Proves: imported path freezes the
 * verified FICO + representative, stores scores + PDF; review path (no score)
 * stores but does not freeze; idempotency returns the prior report. */
if (!process.env.DATABASE_URL) { console.log('SKIP test-credit-import (no DATABASE_URL)'); process.exit(0); }
// Self-set the env this test needs so it can run in the `npm test` chain (mirrors
// test-credit-api-db). orderAndImport requires a configured endpoint even though a
// no-network transport is injected; keys stay deterministic for the crypto paths.
process.env.XACTUS_ENDPOINT = process.env.XACTUS_ENDPOINT || 'http://x';
// This suite's response fixtures are MISMO 2.3.1 — HARD-pin the version (not ||)
// so it always exercises the 2.3.1 builder+parser regardless of an ambient
// XACTUS_MISMO_VERSION, even though the config default is now 3.4. (The 3.4 path
// is covered by test-credit-pull-matrix.js.)
process.env.XACTUS_MISMO_VERSION = '2.3.1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'import-secret-00000000000000000000000000';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.STORAGE_DIR = process.env.STORAGE_DIR || '/tmp/credit-import-storage';
const db = require('../src/db');
const crypto = require('../src/lib/crypto');
const credentials = require('../src/lib/credit/credentials');
const providers = require('../src/lib/credit/providers');
const creditImport = require('../src/lib/credit/import');

let pass = 0, fail = 0;
const eq = (n, g, e) => { if (JSON.stringify(g) === JSON.stringify(e)) pass++; else { fail++; console.log(`FAIL ${n}: got ${JSON.stringify(g)} exp ${JSON.stringify(e)}`); } };
const ok = (n, c) => { if (c) pass++; else { fail++; console.log(`FAIL ${n}`); } };

const MINI_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF').toString('base64');
const score = (id, bid, bureau, val, model, withFactors) =>
  `<CREDIT_SCORE CreditScoreID="${id}" BorrowerID="${bid}" CreditFileID="F${id}" CreditReportIdentifier="RPT1" CreditRepositorySourceType="${bureau}" _Date="2026-07-19" _Value="${val}" _ModelNameType="${model}">${
    withFactors ? '<_FACTOR _Code="038" _Text="Serious delinquency"/><_FACTOR _Code="008" _Text="Too many recent inquiries"/>' : ''
  }</CREDIT_SCORE>`;
function responseXml({ withCo = false, coNoScore = false, issuedDate = '2026-07-19', alerts = '', badBlockDate = false } = {}) {
  // When a caller passes a malformed issuedDate, swap it in for EVERY date in the
  // template (report issued/updated dates + each score _Date) so the whole import
  // sees the bad vendor date — proving the persist path sanitizes rather than
  // throwing on the ::date cast.
  const fixup = (xml) => (issuedDate === '2026-07-19' ? xml : xml.split('2026-07-19').join(issuedDate));
  return fixup(_responseXml({ withCo, coNoScore, alerts, badBlockDate }));
}
function _responseXml({ withCo = false, coNoScore = false, alerts = '', badBlockDate = false } = {}) {
  const b1 = `<BORROWER BorrowerID="B1" _FirstName="NICKIE" _LastName="GREEN" _SSN="123003333" _BirthDate="1985-03-12" _UnparsedEmployment="ACME CORP">
          <_RESIDENCE _StreetAddress="100 Terrace Ave" _City="West Haven" _State="CT" _PostalCode="06516"/>
          <_RESIDENCE _StreetAddress="55 Old Rd" _City="Milford" _State="CT" _PostalCode="06460"/>
          <_ALIAS _UnparsedName="NICKIE GREENE"/>
        </BORROWER>
        ${score('1', 'B1', 'Equifax', '734', 'EquifaxBeacon5.0', true)}
        ${score('2', 'B1', 'Experian', '732', 'ExperianFairIsaac')}
        ${score('3', 'B1', 'TransUnion', '730', 'FICORiskScoreClassic04')}`;
  // ---- Full-report BLOCKS (E1) on B1: a normal installment tradeline (1×30),
  // a collection tradeline (derives a collection block), an authorized-user
  // revolving tradeline, an inquiry, a public record, and a fraud alert.
  const blocks = `
        <CREDIT_LIABILITY BorrowerID="B1" CreditRepositorySourceType="Equifax" CreditFileID="F1"
            _AccountType="Installment" _AccountOwnershipType="Individual" _AccountStatusType="Open"
            _AccountIdentifier="4000123412341234" _UnpaidBalanceAmount="12000.00" _CreditLimitAmount="25000"
            _HighCreditAmount="25000" _MonthlyPaymentAmount="450" _AccountOpenedDate="2020-01-15"
            _AccountReportedDate="2026-06-30" _MonthsReviewedCount="60" _DerogatoryDataIndicator="N">
          <_CREDITOR _Name="CHASE AUTO"/>
          <_CURRENT_RATING _Code="1" _Type="AsAgreed"/>
          <_LATE_COUNT _30Days="1" _60Days="0" _90Days="0"/>
        </CREDIT_LIABILITY>
        <CREDIT_LIABILITY BorrowerID="B1" CreditRepositorySourceType="Experian"
            _AccountType="Collection" _AccountOwnershipType="Individual" _AccountStatusType="Open"
            _AccountIdentifier="99881234" _UnpaidBalanceAmount="850" _AccountReportedDate="2026-05-01">
          <_CREDITOR _Name="MIDLAND FUNDING"/>
        </CREDIT_LIABILITY>
        <CREDIT_LIABILITY BorrowerID="B1" CreditRepositorySourceType="TransUnion"
            _AccountType="Revolving" _AccountOwnershipType="Authorized User" _AccountStatusType="Open"
            _AccountIdentifier="551200005512" _UnpaidBalanceAmount="300" _CreditLimitAmount="5000" _AccountOpenedDate="2019-03-01">
          <_CREDITOR _Name="CAPITAL ONE"/>
        </CREDIT_LIABILITY>
        <CREDIT_INQUIRY BorrowerID="B1" CreditRepositorySourceType="Equifax" _Date="2026-06-01" _Name="ROCKET MORTGAGE" CreditBusinessType="Mortgage" CreditLoanType="Conventional"/>
        <CREDIT_PUBLIC_RECORD BorrowerID="B1" CreditRepositorySourceType="Experian" _Type="Bankruptcy" _FiledDate="2018-04-10" _Amount="0" _CourtName="US Bankruptcy Court" _DispositionType="Discharged" _DispositionDate="2018-10-01" _DocketIdentifier="18-12345" _PlaintiffName="US Trustee"/>`;
  const coScores = coNoScore
    ? `${score('4', 'C1', 'Equifax', '9002', 'EquifaxBeacon5.0')}`   // reject code → no score
    : `${score('4', 'C1', 'Equifax', '700', 'EquifaxBeacon5.0')}
        ${score('5', 'C1', 'Experian', '698', 'ExperianFairIsaac')}
        ${score('6', 'C1', 'TransUnion', '702', 'FICORiskScoreClassic04')}`;
  const co = withCo ? `<BORROWER BorrowerID="C1" _FirstName="ANN" _LastName="FREDDIE" _SSN="992700027"/>
        ${coScores}` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<RESPONSE_GROUP MISMOVersionID="2.3.1">
  <RESPONSE ResponseDateTime="2026-07-19T12:00:00">
    <RESPONSE_DATA>
      <CREDIT_RESPONSE MISMOVersionID="2.3.1" CreditReportIdentifier="RPT1" CreditResponseID="CR1" CreditReportFirstIssuedDate="2026-07-19" CreditReportLastUpdatedDate="2026-07-19" CreditReportType="Other" CreditReportTypeOtherDescription="SoftCheck">
        <CREDIT_REPOSITORY_INCLUDED _EquifaxIndicator="Y" _ExperianIndicator="Y" _TransUnionIndicator="Y"/>
        ${b1}
        ${co}
        ${blocks}
        ${alerts || ''}
        ${badBlockDate ? '<CREDIT_LIABILITY BorrowerID="B1" CreditRepositorySourceType="Equifax" _AccountType="Installment" _AccountReportedDate="N/A" _AccountIdentifier="777" _UnpaidBalanceAmount="100"><_CREDITOR _Name="JUNK DATE CO"/><_LATE_COUNT _30Days="99999999999"/></CREDIT_LIABILITY>' : ''}
        <EMBEDDED_FILE _Type="PDF" _Name="report.pdf" _Extension="pdf" MIMEType="application/pdf" _EncodingType="base64">
          <DOCUMENT><![CDATA[${MINI_PDF}]]></DOCUMENT>
        </EMBEDDED_FILE>
      </CREDIT_RESPONSE>
    </RESPONSE_DATA>
    <STATUS _Condition="Success" _Code="0" _Description="Success"/>
  </RESPONSE>
</RESPONSE_GROUP>`;
}
const transportOf = (body, status = 200) => async () => ({ status, headers: { get: () => 'text/xml' }, text: async () => body });

async function seedStaff(email) {
  const r = await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Test Officer','loan_officer') RETURNING id`, [email]);
  return r.rows[0].id;
}
async function seedBorrower(email, first, ssnRaw = '123-00-3333') {
  const ssn = crypto.ssnForStorage(ssnRaw);
  const r = await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,ssn_encrypted,ssn_last4,current_address,fico)
     VALUES ($1,'Green',$2,$3,$4,$5::jsonb,700) RETURNING id`,
    [first, email, ssn.encrypted, ssn.last4, JSON.stringify({ line1: '100 Terrace Ave', city: 'West Haven', state: 'CT', zip: '06516' })]);
  return r.rows[0].id;
}

(async () => {
  const suffix = 'imp' + process.pid;
  // clean prior
  await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [`%${suffix}@t.test`]).catch(() => {});
  const provider = await providers.getByKey('xactus');
  const actorId = await seedStaff(`officer-${suffix}@t.test`);
  await credentials.setForUser(actorId, { providerKey: 'xactus', operatorIdentifier: 'LO_TEST', secret: 'p@ss', verify: false });

  // ---- IMPORTED path (single borrower, all 3 bureaus) ----
  const bId = await seedBorrower(`b-${suffix}@t.test`, 'Nickie');
  const appR = await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [bId]);
  const appId = appR.rows[0].id;
  // Seed the internal credit-report condition (outstanding) to prove wiring.
  const credTmpl = (await db.query(
    `INSERT INTO checklist_templates (code,label,scope) VALUES ('rtl_cond_credit','Credit report','application')
       ON CONFLICT (code) DO UPDATE SET label=EXCLUDED.label RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO checklist_items (scope,label,application_id,template_id,status) VALUES ('application','Credit report',$1,$2,'outstanding')`, [appId, credTmpl]);

  // Happy path: the claimed FICO matches the verified bracket (730 and 732 are both
  // 720-739), so NO underwriting mismatch finding fires — the condition clears to
  // 'received'. (The mismatch case is exercised separately below.)
  await db.query(`UPDATE borrowers SET fico=730 WHERE id=$1`, [bId]);
  const out = await creditImport.orderAndImport({
    applicationId: appId, actorId, action: 'Reissue', creditReportIdentifier: 'RPT1',
    idempotencyKey: `k-${suffix}-1`, nowMs: 1000, transport: transportOf(responseXml()),
  });
  eq('imported status', out.status, 'imported');
  ok('no underwriting finding when FICO matches', !out.underwritingFinding);
  eq('representative = middle 732', out.representativeScore, 732);   // mid of 734/732/730
  eq('representative bracket', out.representativeBracket, '720-739');
  ok('froze', out.froze === true);
  ok('pdf stored', !!out.pdfDocumentId);

  const bAfter = (await db.query(`SELECT fico, verified_fico, fico_locked, verified_report_id FROM borrowers WHERE id=$1`, [bId])).rows[0];
  eq('borrower verified_fico', bAfter.verified_fico, 732);
  eq('borrower fico copied', bAfter.fico, 732);
  ok('borrower locked', bAfter.fico_locked === true);
  eq('borrower report id', bAfter.verified_report_id, 'RPT1');

  const rpt = (await db.query(`SELECT status, representative_score, first_issued_date, pdf_document_id, xml_encrypted FROM credit_reports WHERE id=$1`, [out.reportId])).rows[0];
  eq('report row imported', rpt.status, 'imported');
  ok('report xml encrypted stored', Buffer.isBuffer(rpt.xml_encrypted) && rpt.xml_encrypted.length > 0);
  ok('report xml decrypts to XML', crypto.decryptSecret(rpt.xml_encrypted).includes('<RESPONSE_GROUP'));
  const scRows = (await db.query(`SELECT count(*)::int n, count(*) FILTER (WHERE usable) usable FROM credit_scores WHERE credit_report_id=$1`, [out.reportId])).rows[0];
  eq('3 score rows', scRows.n, 3);
  eq('3 usable', Number(scRows.usable), 3);
  const appPriced = (await db.query(`SELECT fico_used_for_pricing FROM applications WHERE id=$1`, [appId])).rows[0];
  eq('fico_used_for_pricing captured', appPriced.fico_used_for_pricing, 732);

  // ---- Full-report BLOCKS (E1) persisted + attributed to the borrower --------
  const tls = (await db.query(
    `SELECT bureau, creditor_name, account_type, account_ownership_type, account_identifier_masked,
            account_identifier_encrypted, unpaid_balance, credit_limit, monthly_payment, date_opened,
            late_30_count, is_collection, is_authorized_user, borrower_id, raw
       FROM credit_tradelines WHERE credit_report_id=$1 ORDER BY creditor_name`, [out.reportId])).rows;
  eq('3 tradelines stored', tls.length, 3);
  ok('every tradeline attributed to the borrower', tls.every(t => t.borrower_id === bId));
  const chase = tls.find(t => t.creditor_name === 'CHASE AUTO');
  ok('chase tradeline present', !!chase);
  eq('chase bureau', chase.bureau, 'Equifax');
  eq('chase balance is numeric (no "030" coercion trap — kept exact)', Number(chase.unpaid_balance), 12000);
  eq('chase credit limit', Number(chase.credit_limit), 25000);
  eq('chase monthly payment', Number(chase.monthly_payment), 450);
  eq('chase date_opened cast to date', String(chase.date_opened).slice(0, 10), '2020-01-15');
  eq('chase 1x30 late', chase.late_30_count, 1);
  ok('chase not a collection', chase.is_collection === false);
  // account number: MASKED last-4 for display + ENCRYPTED bytea, NEVER plaintext.
  eq('chase account masked to last-4', chase.account_identifier_masked, '••••1234');
  ok('chase account encrypted is bytea', Buffer.isBuffer(chase.account_identifier_encrypted) && chase.account_identifier_encrypted.length > 0);
  eq('chase account decrypts to the full number', crypto.decryptSecret(chase.account_identifier_encrypted), '4000123412341234');
  ok('no plaintext full account number in any column',
     !Object.entries(chase).filter(([k]) => k !== 'raw' && k !== 'account_identifier_encrypted').some(([, v]) => typeof v === 'string' && v.includes('4000123412341234')));
  // The audit blob (raw jsonb) must NOT re-leak the full account number (GLBA).
  ok('raw audit blob has NO full account number', !JSON.stringify(chase.raw || {}).includes('4000123412341234'));
  ok('raw audit blob keeps the rest of the tradeline', /CHASE AUTO/.test(JSON.stringify(chase.raw || {})));
  const capone = tls.find(t => t.creditor_name === 'CAPITAL ONE');
  ok('authorized-user tradeline flagged', capone && capone.is_authorized_user === true);
  const midland = tls.find(t => t.creditor_name === 'MIDLAND FUNDING');
  ok('collection tradeline flagged is_collection', midland && midland.is_collection === true);

  const cols = (await db.query(`SELECT collection_agency_name, amount, borrower_id FROM credit_collections WHERE credit_report_id=$1`, [out.reportId])).rows;
  eq('1 collection derived', cols.length, 1);
  eq('collection agency', cols[0].collection_agency_name, 'MIDLAND FUNDING');
  eq('collection amount', Number(cols[0].amount), 850);
  ok('collection attributed', cols[0].borrower_id === bId);

  const inq = (await db.query(`SELECT inquiring_party_name, inquiry_date, business_type, borrower_id FROM credit_inquiries WHERE credit_report_id=$1`, [out.reportId])).rows;
  eq('1 inquiry stored', inq.length, 1);
  eq('inquiry party', inq[0].inquiring_party_name, 'ROCKET MORTGAGE');
  eq('inquiry date cast', String(inq[0].inquiry_date).slice(0, 10), '2026-06-01');
  ok('inquiry attributed', inq[0].borrower_id === bId);

  const prs = (await db.query(`SELECT record_type, filed_date, court_name, docket_identifier, borrower_id FROM credit_public_records WHERE credit_report_id=$1`, [out.reportId])).rows;
  eq('1 public record stored', prs.length, 1);
  eq('public record type', prs[0].record_type, 'Bankruptcy');
  eq('public record filed date', String(prs[0].filed_date).slice(0, 10), '2018-04-10');
  eq('public record court', prs[0].court_name, 'US Bankruptcy Court');
  ok('public record attributed', prs[0].borrower_id === bId);

  const idr = (await db.query(`SELECT reported_name, dob, ssn_masked, aliases, current_address, former_addresses, employers, raw, borrower_id FROM credit_report_identities WHERE credit_report_id=$1`, [out.reportId])).rows;
  eq('1 identity row stored', idr.length, 1);
  eq('identity dob cast', String(idr[0].dob).slice(0, 10), '1985-03-12');
  eq('identity ssn stored MASKED only (last-4)', idr[0].ssn_masked, '3333');
  ok('identity carries NO raw SSN in ssn_masked', idr[0].ssn_masked.length === 4);
  ok('identity raw blob has NO raw reported SSN', !JSON.stringify(idr[0].raw || {}).includes('123003333'));
  ok('identity aliases captured', Array.isArray(idr[0].aliases) && idr[0].aliases.includes('NICKIE GREENE'));
  ok('identity current address captured', /Terrace Ave/.test(String(idr[0].current_address)));
  ok('identity former address captured', Array.isArray(idr[0].former_addresses) && idr[0].former_addresses.some(a => /Old Rd/.test(a)));
  ok('identity employer captured', Array.isArray(idr[0].employers) && idr[0].employers.includes('ACME CORP'));
  ok('identity attributed', idr[0].borrower_id === bId);

  const alr = (await db.query(`SELECT category FROM credit_alerts WHERE credit_report_id=$1`, [out.reportId])).rows;
  eq('clean happy-path report has no alerts', alr.length, 0);

  // ---- DATE SAFETY: a MALFORMED vendor date must NOT roll back an already-billed
  // import (the persist path sanitizes bad dates to NULL instead of throwing on
  // ::date). The scores are the payload; a bad date is not worth losing a billed pull.
  const bIdD = await seedBorrower(`bdate-${suffix}@t.test`, 'Datey');
  await db.query(`UPDATE borrowers SET fico=730 WHERE id=$1`, [bIdD]);
  const appD = (await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [bIdD])).rows[0].id;
  const dOut = await creditImport.orderAndImport({
    applicationId: appD, actorId, action: 'Reissue', creditReportIdentifier: 'RPT1',
    idempotencyKey: `k-${suffix}-baddate`, nowMs: 1500, transport: transportOf(responseXml({ issuedDate: 'N/A' })),
  });
  eq('bad-date import still imported (not rolled back)', dOut.status, 'imported');
  ok('bad-date import still froze the FICO', dOut.froze === true);
  const dRpt = (await db.query(`SELECT status, first_issued_date FROM credit_reports WHERE id=$1`, [dOut.reportId])).rows[0];
  ok('malformed first_issued_date stored as NULL', dRpt.first_issued_date === null);
  const dScoreDates = (await db.query(`SELECT count(*)::int n FROM credit_scores WHERE credit_report_id=$1 AND score_date IS NOT NULL`, [dOut.reportId])).rows[0];
  eq('malformed score dates stored as NULL', dScoreDates.n, 0);

  // score factors stored on the Equifax row
  const eqFactors = (await db.query(`SELECT factors FROM credit_scores WHERE credit_report_id=$1 AND bureau='Equifax'`, [out.reportId])).rows[0];
  ok('equifax factors stored', Array.isArray(eqFactors.factors) && eqFactors.factors.length === 2);
  ok('factor text present', /Serious delinquency/.test(JSON.stringify(eqFactors.factors)));
  // adverse-action auto-populates principal reasons from the real bureau factors
  const aa = require('../src/lib/credit/adverse-action');
  const aaId = await aa.draftForApplication({ applicationId: appId, borrowerId: bId, creditReportId: out.reportId, decision: 'declined', actorId });
  const aaRow = (await db.query(`SELECT principal_reasons, scores_disclosed, notice_body, status FROM adverse_action_letters WHERE id=$1`, [aaId])).rows[0];
  ok('AA status draft', aaRow.status === 'draft');
  ok('AA reasons auto-populated from factors', Array.isArray(aaRow.principal_reasons) && aaRow.principal_reasons.some(r => /Serious delinquency/.test(r)));
  ok('AA discloses the score', Array.isArray(aaRow.scores_disclosed) && aaRow.scores_disclosed.length >= 1);
  await db.query(`DELETE FROM adverse_action_letters WHERE id=$1`, [aaId]);

  // condition wired: outstanding -> received on import
  const condStatus = (await db.query(`SELECT status FROM checklist_items WHERE application_id=$1 AND template_id=$2`, [appId, credTmpl])).rows[0];
  eq('credit condition -> received on import', condStatus.status, 'received');

  // ---- APPEND-ONLY EVENT LOG: emission + immutability ----
  await new Promise((r) => setTimeout(r, 300));   // let fire-and-forget events flush
  const evs = (await db.query(`SELECT phase FROM credit_order_events WHERE report_id=$1 ORDER BY id`, [out.reportId])).rows.map(r => r.phase);
  ok('events emitted (journal + post + persist)', evs.includes('journal') && evs.includes('post') && evs.includes('persist'));
  // append-only: UPDATE and DELETE are blocked by the trigger
  const anyEv = (await db.query(`SELECT id FROM credit_order_events WHERE report_id=$1 LIMIT 1`, [out.reportId])).rows[0];
  let updBlocked = false, delBlocked = false;
  try { await db.query(`UPDATE credit_order_events SET phase='hacked' WHERE id=$1`, [anyEv.id]); } catch (_) { updBlocked = true; }
  try { await db.query(`DELETE FROM credit_order_events WHERE id=$1`, [anyEv.id]); } catch (_) { delBlocked = true; }
  ok('event log UPDATE blocked', updBlocked);
  ok('event log DELETE blocked', delBlocked);

  // ---- 120-DAY SWEEP: aged report reopens a satisfied condition ----
  const sweep = require('../src/lib/credit/reopen-sweep');
  await db.query(`UPDATE credit_reports SET first_issued_date = current_date - 130 WHERE application_id=$1`, [appId]);
  await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now() WHERE application_id=$1 AND template_id=$2`, [appId, credTmpl]);
  const sweptOut = await sweep.sweepAgedCreditConditions();
  ok('sweep reopened >=1 item', sweptOut.reopenedItems >= 1);
  const afterSweep = (await db.query(`SELECT status, signed_off_at FROM checklist_items WHERE application_id=$1 AND template_id=$2`, [appId, credTmpl])).rows[0];
  eq('aged credit condition reopened', afterSweep.status, 'outstanding');
  ok('aged condition sign-off cleared', afterSweep.signed_off_at === null);
  // fresh report resets the clock: a recent report means no reopen
  await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now() WHERE application_id=$1 AND template_id=$2`, [appId, credTmpl]);
  await db.query(`UPDATE credit_reports SET first_issued_date = current_date - 5 WHERE application_id=$1`, [appId]);
  const sweep2 = await sweep.sweepAgedCreditConditions();
  const afterFresh = (await db.query(`SELECT status FROM checklist_items WHERE application_id=$1 AND template_id=$2`, [appId, credTmpl])).rows[0];
  eq('fresh report not reopened', afterFresh.status, 'satisfied');

  // ---- IDEMPOTENCY: same key returns the prior report, no new order ----
  const dup = await creditImport.orderAndImport({
    applicationId: appId, actorId, action: 'Reissue', creditReportIdentifier: 'RPT1',
    idempotencyKey: `k-${suffix}-1`, nowMs: 2000, transport: transportOf('<SHOULD_NOT_BE_CALLED/>'),
  });
  ok('idempotent dedup', dup.deduped === true);
  eq('idempotent same report', dup.reportId, out.reportId);
  const cnt = (await db.query(`SELECT count(*)::int n FROM credit_reports WHERE application_id=$1`, [appId])).rows[0];
  eq('only one report row', cnt.n, 1);
  // A deduped re-order never re-persists, so the blocks are untouched — a repeated
  // intent can never duplicate tradelines/inquiries/etc.
  const tlDup = (await db.query(`SELECT count(*)::int n FROM credit_tradelines WHERE credit_report_id=$1`, [out.reportId])).rows[0];
  eq('dedup leaves tradelines unduplicated', tlDup.n, 3);

  // ---- FREEZE holds: a plain fico write is blocked after import ----
  let blocked = false;
  try { await db.query(`UPDATE borrowers SET fico=800 WHERE id=$1`, [bId]); } catch (_) { blocked = true; }
  ok('post-import fico write blocked by freeze', blocked);

  // ---- REVIEW path (co-borrower no score) ----
  const b2 = await seedBorrower(`b2p-${suffix}@t.test`, 'Nickie');
  const co2 = await seedBorrower(`b2c-${suffix}@t.test`, 'Ann', '992-70-0027');   // matches the mock C1 SSN so the SSN-match filter keeps it
  const app2 = (await db.query(`INSERT INTO applications (borrower_id, co_borrower_id) VALUES ($1,$2) RETURNING id`, [b2, co2])).rows[0].id;
  const rev = await creditImport.orderAndImport({
    applicationId: app2, actorId, action: 'Reissue', creditReportIdentifier: 'RPT1',
    idempotencyKey: `k-${suffix}-2`, nowMs: 3000, transport: transportOf(responseXml({ withCo: true, coNoScore: true })),
  });
  eq('review status', rev.status, 'review');
  ok('review reason mentions no score / manual UW', /no score|insufficient|manual underwriting|excluded/i.test(rev.reviewReason || ''));
  ok('review did NOT freeze', rev.froze === false);
  const b2After = (await db.query(`SELECT fico_locked, verified_fico FROM borrowers WHERE id=$1`, [b2])).rows[0];
  ok('review left borrower unlocked', b2After.fico_locked === false);
  eq('review left verified_fico null', b2After.verified_fico, null);

  // ---- RESILIENCE: in_doubt on timeout, no idempotency poison, dedup, breaker ----
  const b3 = await seedBorrower(`b3-${suffix}@t.test`, 'Nickie');
  const app3 = (await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [b3])).rows[0].id;
  // A transport that times out (AbortError) → the order is UNKNOWN, not error.
  const abortTransport = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  let inDoubtThrew = false, inDoubtFlag = false;
  try {
    await creditImport.orderAndImport({ applicationId: app3, actorId, action: 'Reissue', creditReportIdentifier: 'RPT1',
      idempotencyKey: `k-${suffix}-doubt`, nowMs: 4000, transport: abortTransport });
  } catch (e) { inDoubtThrew = true; inDoubtFlag = !!e.inDoubt; }
  ok('timeout throws', inDoubtThrew);
  ok('timeout flagged inDoubt', inDoubtFlag);
  const doubtRow = (await db.query(`SELECT status, completed_at FROM credit_reports WHERE application_id=$1 ORDER BY ordered_at DESC LIMIT 1`, [app3])).rows[0];
  eq('timeout row -> in_doubt (not error)', doubtRow.status, 'in_doubt');
  ok('in_doubt has no completed_at', doubtRow.completed_at === null);
  // NO POISON: a FRESH key re-orders and succeeds despite the prior in_doubt.
  const retry = await creditImport.orderAndImport({ applicationId: app3, actorId, action: 'Reissue', creditReportIdentifier: 'RPT1',
    idempotencyKey: `k-${suffix}-doubt2`, nowMs: 5000, transport: transportOf(responseXml()) });
  eq('fresh-key retry imports (no poison)', retry.status, 'imported');
  // in_doubt surfaces in the review queue set (status IN review,in_doubt)
  const inQueue = (await db.query(`SELECT count(*)::int n FROM credit_reports WHERE application_id=$1 AND status IN ('review','in_doubt')`, [app3])).rows[0];
  ok('in_doubt visible to review queue', inQueue.n >= 1);

  // IN-FLIGHT DEDUP: an existing 'ordering' row for the same app+action+PULL TYPE
  // collapses a second order (fresh key) instead of double-billing. report_type
  // 'Other' = a SOFT (prequal) order — orderAndImport defaults product='prequal'.
  await db.query(`INSERT INTO credit_reports (application_id, provider_id, ordered_by, action_type, report_type, status, ordered_at) VALUES ($1,$2,$3,'Reissue','Other','ordering',now())`, [app3, provider.id, actorId]);
  const dedupOut = await creditImport.orderAndImport({ applicationId: app3, actorId, action: 'Reissue', creditReportIdentifier: 'RPT1',
    idempotencyKey: `k-${suffix}-dedup`, nowMs: 6000, transport: transportOf('<SHOULD_NOT_CALL/>') });
  ok('in-flight dedup returns ordering (same soft pull)', dedupOut.deduped === true && dedupOut.inflight === true);

  // 2×2 DISTINCTNESS: that in-flight SOFT ('Other') order must NOT dedup a HARD
  // ('Merge') order on the same file+action — they are distinct billable pulls.
  // (Was a MAJOR: dedup keyed on action only, so a hard pull got served the soft
  // report.) The hard order proceeds to a real order instead of being swallowed.
  const hardVsSoft = await creditImport.orderAndImport({ applicationId: app3, actorId, product: 'creditreport', action: 'Reissue', creditReportIdentifier: 'RPT1',
    idempotencyKey: `k-${suffix}-hvs`, nowMs: 6050, transport: transportOf(responseXml()) });
  ok('a HARD order is NOT deduped by an in-flight SOFT order (2×2 stays distinct)', !hardVsSoft.deduped);

  // STALE-ORDER SWEEP: an old 'ordering' row → in_doubt.
  await db.query(`UPDATE credit_reports SET ordered_at = now() - interval '30 minutes' WHERE application_id=$1 AND status='ordering'`, [app3]);
  const staleOut = await require('../src/lib/credit/reopen-sweep').sweepStaleOrders({ minutes: 15 });
  ok('stale-order sweep moved >=1', staleOut.swept >= 1);

  // SPEND BREAKER: fake enough recent orders for this user to trip the 10-min cap.
  const cap = require('../src/config').xactus.maxPulls10minUser;
  for (let i = 0; i < cap + 1; i++) {
    await db.query(`INSERT INTO credit_reports (application_id, provider_id, ordered_by, action_type, status, ordered_at) VALUES ($1,$2,$3,'Reissue','error',now())`, [app3, provider.id, actorId]);
  }
  let breakerThrew = false, breakerKind = null;
  try {
    await creditImport.orderAndImport({ applicationId: app3, actorId, action: 'Submit',
      idempotencyKey: `k-${suffix}-spend`, nowMs: 7000, transport: transportOf(responseXml()) });
  } catch (e) { breakerThrew = true; breakerKind = e.kind; }
  ok('spend breaker throws', breakerThrew);
  eq('spend breaker kind', breakerKind, 'spend_limit_user');

  // ---- score_date is persisted (audit completeness) ----
  const sdRows = (await db.query(
    `SELECT count(*)::int n FROM credit_scores WHERE credit_report_id=$1 AND score_date='2026-07-19'`, [out.reportId])).rows[0];
  ok('score_date persisted from the report', sdRows.n >= 1);

  // ---- CONCURRENCY: two orders for the SAME file+action with DIFFERENT keys must
  // bill EXACTLY ONCE (regression for the double-bill race — advisory-lock guard). ----
  const raceStaff = await seedStaff(`race-officer-${suffix}@t.test`);
  await credentials.setForUser(raceStaff, { providerKey: 'xactus', operatorIdentifier: 'LO_RACE', secret: 'p@ss', verify: false });
  const bRace = await seedBorrower(`brace-${suffix}@t.test`, 'Race', '123-00-9911');
  const appRace = (await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [bRace])).rows[0].id;
  let racePosts = 0;
  const raceTransport = async () => { racePosts++; return { status: 200, headers: { get: () => 'text/xml' }, text: async () => responseXml() }; };
  const raceCommon = { applicationId: appRace, actorId: raceStaff, action: 'Reissue', creditReportIdentifier: 'RPT1', transport: raceTransport };
  const raceResults = await Promise.allSettled([
    creditImport.orderAndImport({ ...raceCommon, idempotencyKey: `race-${suffix}-A` }),
    creditImport.orderAndImport({ ...raceCommon, idempotencyKey: `race-${suffix}-B` }),
  ]);
  const raceOk = raceResults.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  eq('concurrent orders bill EXACTLY once (no double-bill)', racePosts, 1);
  ok('one concurrent order deduped to the in-flight one', raceOk.some((r) => r.deduped));
  eq('concurrent orders create ONE report row', (await db.query(`SELECT count(*)::int n FROM credit_reports WHERE application_id=$1`, [appRace])).rows[0].n, 1);
  // race cleanup
  await db.query(`DELETE FROM credit_scores WHERE credit_report_id IN (SELECT id FROM credit_reports WHERE application_id=$1)`, [appRace]);
  await db.query(`DELETE FROM credit_reports WHERE application_id=$1`, [appRace]);
  await db.query(`DELETE FROM documents WHERE application_id=$1`, [appRace]);
  await db.query(`DELETE FROM applications WHERE id=$1`, [appRace]);
  await db.query(`DELETE FROM credit_fico_audit WHERE borrower_id=$1`, [bRace]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bRace]);
  await db.query(`DELETE FROM user_credit_credentials WHERE user_id=$1`, [raceStaff]);
  await db.query(`DELETE FROM staff_users WHERE id=$1`, [raceStaff]);

  // ---- UNDERWRITING FICO-MATCH: a verified score in a DIFFERENT bracket than the
  // FICO the file was built on raises a FATAL finding + blocks the credit condition. ----
  const uwStaff = await seedStaff(`uw-officer-${suffix}@t.test`);
  await credentials.setForUser(uwStaff, { providerKey: 'xactus', operatorIdentifier: 'LO_UW', secret: 'p@ss', verify: false });
  const bUw = await seedBorrower(`buw-${suffix}@t.test`, 'Umatch', '123-00-7722');
  await db.query(`UPDATE borrowers SET fico=650 WHERE id=$1`, [bUw]);   // claimed 650 (640-659) vs verified 732 (720-739)
  const appUw = (await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [bUw])).rows[0].id;
  await db.query(`INSERT INTO checklist_items (scope,label,application_id,template_id,status) VALUES ('application','Credit report',$1,$2,'outstanding')`, [appUw, credTmpl]);
  const uwOut = await creditImport.orderAndImport({
    applicationId: appUw, actorId: uwStaff, action: 'Reissue', creditReportIdentifier: 'RPT1',
    idempotencyKey: `uw-${suffix}`, transport: transportOf(responseXml()),
  });
  ok('mismatch → underwriting finding returned', !!uwOut.underwritingFinding);
  eq('mismatch wrapper severity is fatal', uwOut.underwritingFinding && uwOut.underwritingFinding.severity, 'fatal');
  ok('mismatch wrapper lists fico_mismatch', uwOut.underwritingFinding && Array.isArray(uwOut.underwritingFinding.types) && uwOut.underwritingFinding.types.includes('fico_mismatch'));
  const uwRpt = (await db.query(`SELECT underwriting_finding FROM credit_reports WHERE id=$1`, [uwOut.reportId])).rows[0];
  const uwFico = uwRpt.underwriting_finding && (uwRpt.underwriting_finding.findings || []).find((f) => f.type === 'fico_mismatch');
  ok('mismatch finding persisted in findings[] with both scores', uwFico && uwFico.verified === 732 && uwFico.claimed === 650);
  const uwCond = (await db.query(`SELECT status FROM checklist_items WHERE application_id=$1 AND template_id=$2`, [appUw, credTmpl])).rows[0];
  eq('mismatch blocks the credit condition (issue, not received)', uwCond.status, 'issue');
  ok('mismatch still froze the verified FICO', uwOut.froze === true);
  // the DB gate refuses to complete the condition while the fatal finding stands
  let uwGateBlocked = false;
  try { await db.query(`UPDATE checklist_items SET status='satisfied' WHERE application_id=$1 AND template_id=$2`, [appUw, credTmpl]); } catch (_) { uwGateBlocked = true; }
  ok('db/186 gate blocks completing the condition with a fatal fico finding', uwGateBlocked);
  // uw cleanup
  await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [appUw]);
  await db.query(`DELETE FROM credit_scores WHERE credit_report_id IN (SELECT id FROM credit_reports WHERE application_id=$1)`, [appUw]);
  await db.query(`DELETE FROM credit_reports WHERE application_id=$1`, [appUw]);
  await db.query(`DELETE FROM documents WHERE application_id=$1`, [appUw]);
  await db.query(`DELETE FROM applications WHERE id=$1`, [appUw]);
  await db.query(`DELETE FROM credit_fico_audit WHERE borrower_id=$1`, [bUw]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bUw]);
  await db.query(`DELETE FROM user_credit_credentials WHERE user_id=$1`, [uwStaff]);
  await db.query(`DELETE FROM staff_users WHERE id=$1`, [uwStaff]);

  // ---- E2: BUREAU ALERTS → underwriting findings + gate + reconcile ----------
  // A fraud alert (staff-reconcilable) + an OFAC hit (compliance-only) both become
  // FATAL findings that block the credit condition even though the FICO matched
  // and the pull succeeded. Proves: alerts persist as blocks, the wrapper carries
  // findings[] with reconcilableBy, the condition is blocked, the db/186 gate
  // refuses completion, per-finding reconcile of one finding leaves the other
  // blocking, and clearing all fatal findings opens the gate.
  const U = require('../src/lib/credit/underwriting');
  const alStaff = await seedStaff(`al-officer-${suffix}@t.test`);
  await credentials.setForUser(alStaff, { providerKey: 'xactus', operatorIdentifier: 'LO_AL', secret: 'p@ss', verify: false });
  const bAl = await seedBorrower(`bal-${suffix}@t.test`, 'Alertha', '123-00-8833');
  await db.query(`UPDATE borrowers SET fico=730 WHERE id=$1`, [bAl]);   // matches verified 732 → NO fico finding, isolates the alerts
  const appAl = (await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [bAl])).rows[0].id;
  await db.query(`INSERT INTO checklist_items (scope,label,application_id,template_id,status) VALUES ('application','Credit report',$1,$2,'outstanding')`, [appAl, credTmpl]);
  const alertXml = '<ALERT_MESSAGE BorrowerID="B1" _Type="FACTAFraudVictimInitial" MessageText="Initial fraud alert on file. Verify consumer identity before extending credit."/>'
    + '<ALERT_MESSAGE _Type="Other" MessageText="Possible OFAC SDN match found — verify before funding."/>';
  const alOut = await creditImport.orderAndImport({
    applicationId: appAl, actorId: alStaff, action: 'Reissue', creditReportIdentifier: 'RPT1',
    idempotencyKey: `al-${suffix}`, transport: transportOf(responseXml({ alerts: alertXml })),
  });
  // the pull succeeded → report is imported; the fatal alerts block the CONDITION.
  eq('alert report still imported (pull ok)', alOut.status, 'imported');
  ok('alert wrapper is fatal', alOut.underwritingFinding && alOut.underwritingFinding.severity === 'fatal');
  eq('two fatal findings returned (fraud + ofac)', (alOut.fatalFindings || []).length, 2);
  const alRows = (await db.query(`SELECT category, borrower_id FROM credit_alerts WHERE credit_report_id=$1 ORDER BY category`, [alOut.reportId])).rows;
  eq('two alerts persisted', alRows.map((r) => r.category), ['fraud_alert', 'ofac']);
  ok('fraud alert attributed to the borrower', alRows.find((r) => r.category === 'fraud_alert').borrower_id === bAl);
  ok('report-level OFAC alert has no borrower', alRows.find((r) => r.category === 'ofac').borrower_id === null);
  const alRpt = (await db.query(`SELECT underwriting_finding FROM credit_reports WHERE id=$1`, [alOut.reportId])).rows[0];
  const alF = alRpt.underwriting_finding.findings;
  ok('ofac finding is compliance-only', alF.find((f) => f.type === 'ofac').reconcilableBy === 'compliance');
  ok('fraud finding is staff-reconcilable', alF.find((f) => f.type === 'fraud_alert').reconcilableBy === 'staff');
  const alCond = (await db.query(`SELECT status FROM checklist_items WHERE application_id=$1 AND template_id=$2`, [appAl, credTmpl])).rows[0];
  eq('alert finding blocks the credit condition', alCond.status, 'issue');
  let alBlocked = false;
  try { await db.query(`UPDATE checklist_items SET status='satisfied' WHERE application_id=$1 AND template_id=$2`, [appAl, credTmpl]); } catch (_) { alBlocked = true; }
  ok('db/186 gate refuses completion with a fatal alert finding', alBlocked);
  // per-finding reconcile the fraud finding — OFAC remains, still blocks
  const reFraud = U.recomputeWrapper({ findings: alF.map((f) => (f.type === 'fraud_alert' ? { ...f, reconciled: true } : f)) });
  await db.query(`UPDATE credit_reports SET underwriting_finding=$2::jsonb WHERE id=$1`, [alOut.reportId, JSON.stringify(reFraud)]);
  let stillBlocked = false;
  try { await db.query(`UPDATE checklist_items SET status='satisfied' WHERE application_id=$1 AND template_id=$2`, [appAl, credTmpl]); } catch (_) { stillBlocked = true; }
  ok('reconciling only the fraud finding still blocks (OFAC remains)', stillBlocked);
  // clear OFAC too → gate opens
  const reAll = U.recomputeWrapper({ findings: reFraud.findings.map((f) => ({ ...f, reconciled: true })) });
  await db.query(`UPDATE credit_reports SET underwriting_finding=$2::jsonb WHERE id=$1`, [alOut.reportId, JSON.stringify(reAll)]);
  await db.query(`UPDATE checklist_items SET status='received' WHERE application_id=$1 AND template_id=$2`, [appAl, credTmpl]);
  let nowAllowed = true;
  try { await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now() WHERE application_id=$1 AND template_id=$2`, [appAl, credTmpl]); } catch (_) { nowAllowed = false; }
  ok('clearing all fatal findings opens the gate', nowAllowed);

  // ---- MINOR-1 regression: a malformed block field (bad date + out-of-int4 late
  // count) must NOT roll back the billed/scored/frozen import — blocks are dropped.
  const bJunk = await seedBorrower(`bjunk-${suffix}@t.test`, 'Junky', '123-00-4455');
  await db.query(`UPDATE borrowers SET fico=730 WHERE id=$1`, [bJunk]);
  const appJunk = (await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [bJunk])).rows[0].id;
  const junkOut = await creditImport.orderAndImport({
    applicationId: appJunk, actorId: alStaff, action: 'Reissue', creditReportIdentifier: 'RPT1',
    idempotencyKey: `junk-${suffix}`, transport: transportOf(responseXml({ badBlockDate: true })),
  });
  eq('malformed block did NOT roll back the import', junkOut.status, 'imported');
  ok('malformed block import still froze the FICO', junkOut.froze === true);
  const junkScores = (await db.query(`SELECT count(*)::int n FROM credit_scores WHERE credit_report_id=$1`, [junkOut.reportId])).rows[0];
  eq('scores still persisted despite the bad block', junkScores.n, 3);

  // ---- MINOR-2: JOINT 2.3.1 blocks attribute to the CORRECT borrower ----------
  const jStaff = await seedStaff(`j-officer-${suffix}@t.test`);
  await credentials.setForUser(jStaff, { providerKey: 'xactus', operatorIdentifier: 'LO_J', secret: 'p@ss', verify: false });
  const jB1 = await seedBorrower(`jb1-${suffix}@t.test`, 'Nickie', '123-00-3333');
  const jC1 = await seedBorrower(`jc1-${suffix}@t.test`, 'Ann', '992-70-0027');
  await db.query(`UPDATE borrowers SET fico=730 WHERE id = ANY($1)`, [[jB1, jC1]]);
  const appJ = (await db.query(`INSERT INTO applications (borrower_id, co_borrower_id) VALUES ($1,$2) RETURNING id`, [jB1, jC1])).rows[0].id;
  // a co-borrower (C1) tradeline injected alongside the B1 blocks
  const coTradeline = '<CREDIT_LIABILITY BorrowerID="C1" CreditRepositorySourceType="Equifax" _AccountType="Revolving" _AccountStatusType="Open" _AccountIdentifier="C0B0R0W1" _UnpaidBalanceAmount="500"><_CREDITOR _Name="CO BORROWER BANK"/></CREDIT_LIABILITY>';
  const jOut = await creditImport.orderAndImport({
    applicationId: appJ, actorId: jStaff, action: 'Reissue', creditReportIdentifier: 'RPT1',
    idempotencyKey: `j-${suffix}`, transport: transportOf(responseXml({ withCo: true, alerts: coTradeline })),
  });
  const jB1tl = (await db.query(`SELECT creditor_name FROM credit_tradelines WHERE credit_report_id=$1 AND borrower_id=$2 ORDER BY creditor_name`, [jOut.reportId, jB1])).rows.map((r) => r.creditor_name);
  const jC1tl = (await db.query(`SELECT creditor_name FROM credit_tradelines WHERE credit_report_id=$1 AND borrower_id=$2`, [jOut.reportId, jC1])).rows.map((r) => r.creditor_name);
  ok('joint: B1 tradelines attributed to the primary', jB1tl.includes('CHASE AUTO') && !jB1tl.includes('CO BORROWER BANK'));
  eq('joint: co-borrower tradeline attributed to the co-borrower', jC1tl, ['CO BORROWER BANK']);

  // E2/junk/joint cleanup
  await db.query(`DELETE FROM checklist_items WHERE application_id = ANY($1)`, [[appAl, appJunk, appJ]]);
  await db.query(`DELETE FROM credit_scores WHERE credit_report_id IN (SELECT id FROM credit_reports WHERE application_id = ANY($1))`, [[appAl, appJunk, appJ]]);
  await db.query(`DELETE FROM credit_reports WHERE application_id = ANY($1)`, [[appAl, appJunk, appJ]]);
  await db.query(`DELETE FROM documents WHERE application_id = ANY($1)`, [[appAl, appJunk, appJ]]);
  await db.query(`DELETE FROM applications WHERE id = ANY($1)`, [[appAl, appJunk, appJ]]);
  await db.query(`DELETE FROM credit_fico_audit WHERE borrower_id = ANY($1)`, [[bAl, bJunk, jB1, jC1]]);
  await db.query(`DELETE FROM borrowers WHERE id = ANY($1)`, [[bAl, bJunk, jB1, jC1]]);
  await db.query(`DELETE FROM user_credit_credentials WHERE user_id = ANY($1)`, [[alStaff, jStaff]]);
  await db.query(`DELETE FROM staff_users WHERE id = ANY($1)`, [[alStaff, jStaff]]);

  // cleanup
  await db.query(`DELETE FROM checklist_items WHERE application_id = ANY($1)`, [[appId, app2, app3, appD]]);
  await db.query(`DELETE FROM credit_scores WHERE credit_report_id IN (SELECT id FROM credit_reports WHERE application_id = ANY($1))`, [[appId, app2, app3, appD]]);
  await db.query(`DELETE FROM credit_reports WHERE application_id = ANY($1)`, [[appId, app2, app3, appD]]);
  await db.query(`DELETE FROM documents WHERE application_id = ANY($1)`, [[appId, app2, app3, appD]]);
  await db.query(`DELETE FROM applications WHERE id = ANY($1)`, [[appId, app2, app3, appD]]);
  await db.query(`DELETE FROM credit_fico_audit WHERE borrower_id = ANY($1)`, [[bId, b2, co2, b3, bIdD]]);
  await db.query(`DELETE FROM borrowers WHERE id = ANY($1)`, [[bId, b2, co2, b3, bIdD]]);
  await db.query(`DELETE FROM user_credit_credentials WHERE user_id=$1`, [actorId]);
  await db.query(`DELETE FROM staff_users WHERE id=$1`, [actorId]);

  console.log(`\ncredit-import: ${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
