'use strict';
/**
 * End-to-end DB test for the TWO-BORROWER credit import (owner-directed 2026-07-27).
 *
 * Covers the three ways a two-borrower file gets its credit, and the reissue fix:
 *   1. MERGED   — ONE downloaded file covering both borrowers → a report row EACH
 *                 (own scores, own middle score, own FICO), the one physical PDF/XML
 *                 filed ONCE and shared, both on the ONE file-level condition.
 *   2. SEPARATE — a different downloaded file per borrower, imported in one action.
 *   3. LIVE     — each borrower reissued against THEIR OWN reference number (the
 *                 co-borrower could not be imported on their own before this), and a
 *                 joint LIVE response sliced down to the borrower who was pulled.
 * Plus: a merged import folds a split-out co-borrower condition back into one.
 *
 * The live-pull cases stub `provider.pull` (no Xactus call, no credentials) and
 * assert on what the request WOULD have carried.
 * Requires DATABASE_URL; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-credit-merged-import-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-credit-merged-import-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const C = require('../src/lib/crypto');
const { ensureSchema } = require('../src/migrate-boot');
const credit = require('../src/lib/credit');
const provider = require('../src/lib/credit/provider');

// ONE merged/joint report covering both borrowers.
const MERGED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RESPONSE_GROUP><RESPONSE><RESPONSE_DATA>
 <CREDIT_RESPONSE CreditReportIdentifier="XAC-JOINT-DB" CreditReportFirstIssuedDate="2026-07-25" CreditRatingCodeType="TriMerge">
  <BORROWER _ID="B1" _FirstName="Jamie" _LastName="Marsh" _SSN="123456789" _PrintPositionType="Borrower">
    <_RESIDENCE _StreetAddress="9 Oak St" _City="Lakewood" _State="NJ" _PostalCode="08701"/>
  </BORROWER>
  <BORROWER _ID="B2" _FirstName="Robin" _LastName="Marsh" _SSN="987654321" _PrintPositionType="CoBorrower">
    <_RESIDENCE _StreetAddress="9 Oak St" _City="Lakewood" _State="NJ" _PostalCode="08701"/>
  </BORROWER>
  <CREDIT_SCORE _Value="720" CreditRepositorySourceType="Equifax"    _BorrowerID="B1"/>
  <CREDIT_SCORE _Value="690" CreditRepositorySourceType="Experian"   _BorrowerID="B1"/>
  <CREDIT_SCORE _Value="705" CreditRepositorySourceType="TransUnion" _BorrowerID="B1"/>
  <CREDIT_SCORE _Value="640" CreditRepositorySourceType="Equifax"    _BorrowerID="B2"/>
  <CREDIT_SCORE _Value="668" CreditRepositorySourceType="Experian"   _BorrowerID="B2"/>
  <CREDIT_SCORE _Value="655" CreditRepositorySourceType="TransUnion" _BorrowerID="B2"/>
  <CREDIT_LIABILITY _BorrowerID="B1" CreditLiabilityAccountType="Revolving" _AccountStatusType="Open"
      _UnpaidBalanceAmount="1200" _MonthlyPaymentAmount="35"><_CREDITOR _Name="CHASE CARD"/></CREDIT_LIABILITY>
  <CREDIT_LIABILITY _BorrowerID="B2" CreditLiabilityAccountType="Installment" _AccountStatusType="Open"
      _UnpaidBalanceAmount="18000" _MonthlyPaymentAmount="410"><_CREDITOR _Name="TOYOTA FINANCIAL"/></CREDIT_LIABILITY>
  <CREDIT_LIABILITY CreditLiabilityAccountType="Mortgage" _AccountStatusType="Open" _AccountOwnershipType="Joint"
      _UnpaidBalanceAmount="250000" _MonthlyPaymentAmount="1800"><_CREDITOR _Name="WELLS FARGO HM"/></CREDIT_LIABILITY>
 </CREDIT_RESPONSE>
</RESPONSE_DATA></RESPONSE></RESPONSE_GROUP>`;

// One borrower's own report (the "two separate reports" path).
const soloXml = (first, last, ssn, e, x, t, ref) => `<?xml version="1.0"?>
<RESPONSE_GROUP><RESPONSE><RESPONSE_DATA>
 <CREDIT_RESPONSE CreditReportIdentifier="${ref}" CreditReportFirstIssuedDate="2026-07-26">
  <BORROWER _ID="B1" _FirstName="${first}" _LastName="${last}" _SSN="${ssn}"/>
  <CREDIT_SCORE _Value="${e}" CreditRepositorySourceType="Equifax"/>
  <CREDIT_SCORE _Value="${x}" CreditRepositorySourceType="Experian"/>
  <CREDIT_SCORE _Value="${t}" CreditRepositorySourceType="TransUnion"/>
  <CREDIT_LIABILITY CreditLiabilityAccountType="Revolving" _AccountStatusType="Open" _UnpaidBalanceAmount="500"
      _MonthlyPaymentAmount="25"><_CREDITOR _Name="DISCOVER"/></CREDIT_LIABILITY>
 </CREDIT_RESPONSE>
</RESPONSE_DATA></RESPONSE></RESPONSE_GROUP>`;

const PDF_B64 = Buffer.from('%PDF-1.4\n% merged credit report test\n').toString('base64');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// Seed a file with a primary + co-borrower and the internal credit condition.
async function seedFile(tag, staffId) {
  const p = C.ssnForStorage('123456789');
  const c = C.ssnForStorage('987654321');
  const addr = JSON.stringify({ line1: '9 Oak St', city: 'Lakewood', state: 'NJ', zip: '08701' });
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,date_of_birth,ssn_encrypted,ssn_last4,current_address)
     VALUES ('Jamie','Marsh',$1,'1985-04-02',$2,$3,$4) RETURNING id`,
    [`merged_p_${tag}_${process.pid}@example.com`, p.encrypted, p.last4, addr])).rows[0];
  const co = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,date_of_birth,ssn_encrypted,ssn_last4,current_address)
     VALUES ('Robin','Marsh',$1,'1986-08-11',$2,$3,$4) RETURNING id`,
    [`merged_c_${tag}_${process.pid}@example.com`, c.encrypted, c.last4, addr])).rows[0];
  const app = (await db.query(
    'INSERT INTO applications (borrower_id, co_borrower_id) VALUES ($1,$2) RETURNING id', [bor.id, co.id])).rows[0];
  const item = (await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, borrower_label, audience, item_kind, role_scope, phase, hint, borrower_hint,
        is_gate, is_milestone, sort_order, tool_key, clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id)
     SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind, COALESCE(t.role_scope,'processor'),
            t.phase, t.hint, t.borrower_hint, COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
            COALESCE(t.sort_order,404), t.tool_key, t.clickup_field_id, COALESCE(t.tpr_exclude,false), 'system',
            COALESCE(t.is_required,true), $1
       FROM checklist_templates t WHERE t.code='rtl_cond_credit' RETURNING id`, [app.id])).rows[0];
  return { appId: app.id, borrowerId: bor.id, coId: co.id, itemId: item.id, staffId };
}

const rowsFor = (appId) => db.query(
  'SELECT * FROM credit_reports WHERE application_id=$1 ORDER BY pulled_at, borrower_id', [appId]).then((r) => r.rows);

(async () => {
  await ensureSchema();
  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Merged Tester','processor',true) RETURNING id`,
    [`mergedstaff_${process.pid}@example.com`])).rows[0];

  // ═══════════════════════════ 1) ONE MERGED FILE, BOTH BORROWERS ═══════════
  const A = await seedFile('a', staff.id);
  const m = await credit.importCredit(A.appId, { xml: MERGED_XML, pdfBase64: PDF_B64, merged: true, actorId: staff.id });

  ok(m.ok && m.pulled === 2, `a merged report imports for BOTH borrowers in one action (pulled ${m.pulled})`);
  ok(m.importMode === 'merged', `import recorded as merged (got ${m.importMode})`);
  ok(m.merged && m.merged.borrowerCount === 2, 'the report is reported as covering 2 people');
  ok(m.merged && m.merged.matched.every((x) => x.matchedBy === 'ssn' && x.verified),
    'both borrowers matched to the file by SSN (proof, not a guess)');
  ok((m.merged.unmatchedInReport || []).length === 0 && (m.merged.unmatchedOnFile || []).length === 0,
    'nobody in the report or on the file was left out');

  const rowsA = await rowsFor(A.appId);
  ok(rowsA.length === 2, `two credit_reports rows — one per borrower (got ${rowsA.length})`);
  const pRow = rowsA.find((r) => r.borrower_id === A.borrowerId);
  const cRow = rowsA.find((r) => r.borrower_id === A.coId);
  ok(pRow && pRow.middle_score === 705, `primary middle score 705 (got ${pRow && pRow.middle_score})`);
  ok(cRow && cRow.middle_score === 655, `co-borrower middle score 655 (got ${cRow && cRow.middle_score})`);
  ok(pRow.status === 'completed' && cRow.status === 'completed', 'both rows completed');
  ok((pRow.parsed.scores || []).length === 3 && (cRow.parsed.scores || []).length === 3,
    'each borrower keeps their OWN three bureau scores (no cross-borrower de-dupe loss)');
  ok(!(cRow.parsed.scores || []).some((s) => s.value === 720), 'the co-borrower row carries none of the primary’s scores');
  ok(pRow.parsed.borrower && pRow.parsed.borrower.firstName === 'Jamie'
    && cRow.parsed.borrower && cRow.parsed.borrower.firstName === 'Robin', 'each row carries its own borrower identity');
  ok(pRow.parsed.mergedSource && pRow.parsed.mergedSource.borrowerCount === 2,
    'each row records that it came out of a merged report');
  // Own tradelines + the joint mortgage; never the other borrower's own account.
  const pCreditors = (pRow.parsed.liabilities || []).map((l) => l.creditor).sort();
  const cCreditors = (cRow.parsed.liabilities || []).map((l) => l.creditor).sort();
  ok(pCreditors.join('|') === 'CHASE CARD|WELLS FARGO HM', `primary tradelines = own card + the joint mortgage (got ${pCreditors.join('|')})`);
  ok(cCreditors.join('|') === 'TOYOTA FINANCIAL|WELLS FARGO HM', `co-borrower tradelines = own loan + the joint mortgage (got ${cCreditors.join('|')})`);

  // FICO per borrower.
  const ficos = (await db.query('SELECT id, fico FROM borrowers WHERE id=ANY($1::uuid[])', [[A.borrowerId, A.coId]])).rows;
  ok((ficos.find((f) => f.id === A.borrowerId) || {}).fico === 705, 'primary FICO written back to 705');
  ok((ficos.find((f) => f.id === A.coId) || {}).fico === 655, 'co-borrower FICO written back to 655');

  // ONE physical document, filed once, shared by both rows.
  const docsA = (await db.query(
    `SELECT id, doc_kind, filename, borrower_id, is_current FROM documents
      WHERE application_id=$1 AND doc_kind IN ('credit_pdf','credit_xml')`, [A.appId])).rows;
  ok(docsA.length === 2, `the one merged report is filed ONCE — 2 documents, not 4 (got ${docsA.length})`);
  ok(docsA.every((d) => /merged/.test(d.filename)), 'the documents are named as a merged report');
  ok(pRow.pdf_document_id && pRow.pdf_document_id === cRow.pdf_document_id, 'both rows point at the SAME filed PDF');
  ok(pRow.xml_document_id && pRow.xml_document_id === cRow.xml_document_id, 'both rows point at the SAME filed data file');
  ok(pRow.checklist_item_id === A.itemId && cRow.checklist_item_id === A.itemId,
    'both reports sit on the ONE file-level credit condition');
  const coCondA = (await db.query(
    `SELECT 1 FROM checklist_items WHERE application_id=$1 AND field_key='cob_credit'`, [A.appId])).rows;
  ok(coCondA.length === 0, 'no duplicate co-borrower credit condition is created by a merged import');

  // The section shows both borrowers + the higher-of-two.
  const fc = await credit.fileCredit(A.appId);
  ok(fc.borrowers.primary.middleScore === 705 && fc.borrowers.coBorrower.middleScore === 655,
    'the credit section shows each borrower’s own middle score');
  ok(fc.borrowers.higher === 705 && fc.borrowers.higherReady === true,
    'higher-of-two = 705 and final (both borrowers have a report)');

  // Scoped view: the co-borrower's own condition shows THEIR report, not the file's.
  const fcCo = await credit.fileCredit(A.appId, { scope: 'co' });
  ok(fcCo.scope.kind === 'co' && fcCo.scope.borrowerId === A.coId, 'a co-scoped view reports its scope');
  ok(fcCo.report && fcCo.report.middleScore === 655, 'the co-scoped view shows the CO-BORROWER’s report (655)');
  ok(fcCo.history.every((h) => h.borrowerId === A.coId), 'the co-scoped history is only their imports');
  const fcP = await credit.fileCredit(A.appId, { scope: 'primary' });
  ok(fcP.report && fcP.report.middleScore === 705, 'a primary-scoped view shows the primary’s report (705)');

  // ═══════════════════ 2) AUTO-DETECT + FOLDING TWO CONDITIONS INTO ONE ═════
  const B = await seedFile('b', staff.id);
  // Import for the PRIMARY only first — that splits out the co-borrower's own condition.
  const solo = await credit.importCredit(B.appId, {
    xml: soloXml('Jamie', 'Marsh', '123456789', 712, 698, 705, 'XAC-SOLO-P'),
    pdfBase64: PDF_B64, borrowerId: B.borrowerId, actorId: staff.id,
  });
  ok(solo.ok && solo.coConditionOpened, 'importing one borrower opens the co-borrower’s own credit condition');
  const coCondB = (await db.query(
    `SELECT id FROM checklist_items WHERE application_id=$1 AND field_key='cob_credit'`, [B.appId])).rows;
  ok(coCondB.length === 1, 'the co-borrower now has their own credit condition');

  // Now import the merged report WITHOUT saying merged — it must be detected.
  const m2 = await credit.importCredit(B.appId, { xml: MERGED_XML, pdfBase64: PDF_B64, actorId: staff.id });
  ok(m2.pulled === 2 && m2.importMode === 'merged',
    `a merged file is detected on its own, without ticking anything (pulled ${m2.pulled})`);
  ok(m2.coConditionClosed === true, 'the now-redundant co-borrower condition is cleared — no duplicate condition');
  const coCondB2 = (await db.query(
    `SELECT id FROM checklist_items WHERE application_id=$1 AND field_key='cob_credit'`, [B.appId])).rows;
  ok(coCondB2.length === 0, 'the file is left with ONE credit condition holding both borrowers');
  const curB = (await db.query(
    `SELECT COUNT(*)::int n FROM documents WHERE application_id=$1 AND is_current=true AND doc_kind IN ('credit_pdf','credit_xml')`,
    [B.appId])).rows[0].n;
  ok(curB === 2, `after the merged re-import only the 2 fresh documents are current (got ${curB})`);

  // A co-borrower condition that ALREADY holds a report is folded in too — the
  // earlier report moves onto the surviving condition, nothing is orphaned.
  const C2 = await seedFile('c', staff.id);
  await credit.importCredit(C2.appId, {
    xml: soloXml('Jamie', 'Marsh', '123456789', 712, 698, 705, 'XAC-C-P'),
    pdfBase64: PDF_B64, borrowerId: C2.borrowerId, actorId: staff.id,
  });
  const coItemC = (await db.query(
    `SELECT id FROM checklist_items WHERE application_id=$1 AND field_key='cob_credit'`, [C2.appId])).rows[0];
  await credit.importCredit(C2.appId, {
    xml: soloXml('Robin', 'Marsh', '987654321', 611, 620, 615, 'XAC-C-C'),
    pdfBase64: PDF_B64, borrowerId: C2.coId, actorId: staff.id,
  });
  const onCo = (await db.query(
    'SELECT COUNT(*)::int n FROM credit_reports WHERE checklist_item_id=$1', [coItemC.id])).rows[0].n;
  ok(onCo === 1, 'a co-borrower imported alone files their report on their own condition');
  const m3 = await credit.importCredit(C2.appId, { xml: MERGED_XML, pdfBase64: PDF_B64, actorId: staff.id });
  ok(m3.pulled === 2 && m3.coConditionClosed === true, 'a later merged import folds that condition back in');
  const coCondC = (await db.query(
    `SELECT 1 FROM checklist_items WHERE application_id=$1 AND field_key='cob_credit'`, [C2.appId])).rows;
  ok(coCondC.length === 0, 'the file ends with ONE credit condition again');
  const orphans = (await db.query(
    'SELECT COUNT(*)::int n FROM credit_reports WHERE application_id=$1 AND checklist_item_id IS NULL', [C2.appId])).rows[0].n;
  ok(orphans === 0, 'the earlier report was moved across, not orphaned');
  const onFileCond = (await db.query(
    'SELECT COUNT(*)::int n FROM credit_reports WHERE checklist_item_id=$1', [C2.itemId])).rows[0].n;
  ok(onFileCond === 4, `every report on the file now hangs off the one condition (got ${onFileCond})`);

  // A HUMAN sign-off on the co-borrower's condition is never swept away.
  const S = await seedFile('s', staff.id);
  await credit.importCredit(S.appId, {
    xml: soloXml('Jamie', 'Marsh', '123456789', 712, 698, 705, 'XAC-S-P'),
    pdfBase64: PDF_B64, borrowerId: S.borrowerId, actorId: staff.id,
  });
  await db.query(
    `UPDATE checklist_items SET status='satisfied', signed_off_by=$2, signed_off_at=now()
      WHERE application_id=$1 AND field_key='cob_credit'`, [S.appId, staff.id]);
  const m4 = await credit.importCredit(S.appId, { xml: MERGED_XML, pdfBase64: PDF_B64, actorId: staff.id });
  ok(m4.pulled === 2 && m4.coConditionClosed === false, 'a merged import never clears a condition a person signed off');
  const signedStill = (await db.query(
    `SELECT 1 FROM checklist_items WHERE application_id=$1 AND field_key='cob_credit'`, [S.appId])).rows;
  ok(signedStill.length === 1, 'that signed-off condition is left exactly where it is');

  // A merged file on a ONE-borrower file is refused, not guessed at.
  const solo1 = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Solo','Person',$1) RETURNING id`,
    [`solo_${process.pid}@example.com`])).rows[0];
  const soloApp = (await db.query('INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id', [solo1.id])).rows[0];
  let refused = null;
  try {
    await credit.importCredit(soloApp.id, { xml: MERGED_XML, merged: true, actorId: staff.id });
  } catch (e) { refused = e.userMessage || e.message; }
  ok(!!refused && /only one borrower/i.test(refused), `a merged import on a single-borrower file is refused with a clear reason (${refused})`);

  // ═══════════════════════ 3) TWO SEPARATE FILES, ONE ACTION ════════════════
  const D = await seedFile('d', staff.id);
  const sep = await credit.importCredit(D.appId, {
    files: [
      { borrowerId: D.borrowerId, xml: soloXml('Jamie', 'Marsh', '123456789', 742, 738, 740, 'XAC-SEP-P'), pdfBase64: PDF_B64 },
      { borrowerId: D.coId, xml: soloXml('Robin', 'Marsh', '987654321', 611, 620, 615, 'XAC-SEP-C'), pdfBase64: PDF_B64 },
    ],
    actorId: staff.id,
  });
  ok(sep.ok && sep.pulled === 2, `two separate reports import together in one action (pulled ${sep.pulled})`);
  ok(sep.importMode === 'separate', `import recorded as separate (got ${sep.importMode})`);
  const rowsD = await rowsFor(D.appId);
  const pD = rowsD.find((r) => r.borrower_id === D.borrowerId);
  const cD = rowsD.find((r) => r.borrower_id === D.coId);
  ok(pD && pD.middle_score === 740, `primary’s own report scored 740 (got ${pD && pD.middle_score})`);
  ok(cD && cD.middle_score === 615, `co-borrower’s own report scored 615 (got ${cD && cD.middle_score})`);
  ok(pD.vendor_report_id === 'XAC-SEP-P' && cD.vendor_report_id === 'XAC-SEP-C', 'each row keeps its own report reference');
  ok(pD.pdf_document_id !== cD.pdf_document_id, 'two separate reports file two separate documents');
  ok(pD.checklist_item_id === D.itemId && cD.checklist_item_id === D.itemId,
    'imported together, both separate reports sit on the ONE credit condition');
  const coCondD = (await db.query(
    `SELECT 1 FROM checklist_items WHERE application_id=$1 AND field_key='cob_credit'`, [D.appId])).rows;
  ok(coCondD.length === 0, 'no split-out condition when both borrowers are imported together');

  // One borrower's file in the split form still imports just them.
  const E = await seedFile('e', staff.id);
  const one = await credit.importCredit(E.appId, {
    files: [{ borrowerId: E.coId, xml: soloXml('Robin', 'Marsh', '987654321', 611, 620, 615, 'XAC-ONE-C'), pdfBase64: PDF_B64 }],
    actorId: staff.id,
  });
  ok(one.pulled === 1 && one.results[0].borrowerId === E.coId, 'a single file in the split form imports only that borrower');
  ok(one.coConditionOpened !== true, 'importing the co-borrower alone does not open a condition for themselves');
  const rowsE = await rowsFor(E.appId);
  ok(rowsE.length === 1 && rowsE[0].borrower_id === E.coId && rowsE[0].middle_score === 615,
    'the co-borrower can be imported entirely on their own');

  // ═════════════ 4) LIVE: each borrower reissues THEIR OWN reference ════════
  // Stub the vendor call — no network, no credentials; we assert on the request.
  const calls = [];
  const realPull = provider.pull;
  provider.pull = async (args) => {
    calls.push(args);
    const first = (args.borrower && args.borrower.firstName) || 'Jamie';
    return {
      xml: soloXml(first, 'Marsh', first === 'Robin' ? '987654321' : '123456789', 700, 690, 695, 'XAC-LIVE-' + first),
      pdfBase64: PDF_B64, vendorReportId: 'XAC-LIVE-' + first,
    };
  };

  const F = await seedFile('f', staff.id);
  // THE BUG: reissuing the CO-BORROWER on their own used to drop the reference that
  // was typed on screen (it was only ever applied to the primary) and fail with
  // "a reissue needs the reference number" — the co-borrower could not be imported.
  calls.length = 0;
  const coLive = await credit.importCredit(F.appId, {
    borrowerIds: [F.coId], requestType: 'reissue', reissueReportId: '91734608',
    consent: true, actorId: staff.id,
  });
  ok(coLive.ok && coLive.pulled === 1, 'the co-borrower can be reissued on their own');
  ok(calls.length === 1 && calls[0].reissueReportId === '91734608',
    `the reference typed on screen is used for the CO-BORROWER (sent "${calls[0] && calls[0].reissueReportId}")`);
  ok(calls[0].borrower.firstName === 'Robin', 'and it is the co-borrower’s identity that is sent');

  // Both borrowers, one reference each.
  calls.length = 0;
  const bothLive = await credit.importCredit(F.appId, {
    borrowerIds: [F.borrowerId, F.coId], requestType: 'reissue',
    reissueReportIds: { [F.borrowerId]: 'REF-PRIMARY', [F.coId]: 'REF-CO' },
    consent: true, actorId: staff.id,
  });
  ok(bothLive.pulled === 2, 'both borrowers reissue in one action');
  const sent = calls.map((c) => `${c.borrower.firstName}:${c.reissueReportId}`).sort().join(' ');
  ok(sent === 'Jamie:REF-PRIMARY Robin:REF-CO', `each borrower reissues against THEIR OWN reference (sent ${sent})`);

  // A JOINT live response is sliced down to the borrower who was pulled.
  provider.pull = async (args) => { calls.push(args); return { xml: MERGED_XML, pdfBase64: PDF_B64, vendorReportId: 'XAC-JOINT-DB' }; };
  const G = await seedFile('g', staff.id);
  calls.length = 0;
  const jointLive = await credit.importCredit(G.appId, {
    borrowerIds: [G.coId], requestType: 'reissue', reissueReportId: 'JOINT-REF',
    consent: true, actorId: staff.id,
  });
  ok(jointLive.ok, 'a joint response to a single-borrower pull still imports');
  const rowsG = await rowsFor(G.appId);
  ok(rowsG.length === 1 && rowsG[0].borrower_id === G.coId, 'it is stored for the borrower who was pulled');
  ok(rowsG[0].middle_score === 655,
    `the CO-BORROWER’s own score is stored, not the primary’s (got ${rowsG[0].middle_score}, wanted 655)`);
  ok((rowsG[0].parsed.scores || []).length === 3 && !(rowsG[0].parsed.scores || []).some((s) => s.value === 720),
    'and none of the other borrower’s scores came with it');
  const coFicoG = (await db.query('SELECT fico FROM borrowers WHERE id=$1', [G.coId])).rows[0].fico;
  ok(coFicoG === 655, `the co-borrower’s FICO is their own score (got ${coFicoG})`);

  // ═══════ 5) ONE JOINT ORDER: one request, ONE reference, both borrowers ═════
  // The Xactus 3.4 spec takes either shape; this is the "one big one with one
  // reference" the owner asked for, versus the separate orders proven above.
  const J = await seedFile('j', staff.id);
  calls.length = 0;
  provider.pull = async (args) => { calls.push(args); return { xml: MERGED_XML, pdfBase64: PDF_B64, vendorReportId: 'XAC-JOINT-DB' }; };
  const jointOut = await credit.importCredit(J.appId, {
    borrowerIds: [J.borrowerId, J.coId], joint: true, requestType: 'reissue',
    jointReissueReportId: 'JOINT-REF-1', consent: true, actorId: staff.id,
  });
  ok(calls.length === 1, `ONE request goes out for both borrowers, not two (sent ${calls.length})`);
  ok(Array.isArray(calls[0].borrowers) && calls[0].borrowers.length === 2, 'and it carries BOTH borrowers');
  ok(calls[0].reissueReportId === 'JOINT-REF-1', 'against the ONE joint reference number');
  ok(jointOut.importMode === 'joint' && jointOut.pulled === 2, `both borrowers imported off it (${jointOut.pulled})`);
  const rowsJ = await rowsFor(J.appId);
  const pJ = rowsJ.find((r) => r.borrower_id === J.borrowerId);
  const cJ = rowsJ.find((r) => r.borrower_id === J.coId);
  ok(rowsJ.length === 2, 'a report row for each borrower');
  ok(pJ.middle_score === 705 && cJ.middle_score === 655, `each gets their OWN score off the joint report (${pJ.middle_score}/${cJ.middle_score})`);
  ok(pJ.pdf_document_id === cJ.pdf_document_id, 'the one joint report is filed once and shared');
  ok(pJ.checklist_item_id === J.itemId && cJ.checklist_item_id === J.itemId, 'and both sit on the one credit condition');
  ok(jointOut.joint && jointOut.joint.split === 2, 'the joint report was split between both borrowers');

  // A joint order is REFUSED before it goes out when a borrower is missing PII —
  // one bad packet must not burn a billable joint pull.
  const K = await seedFile('k', staff.id);
  await db.query('UPDATE borrowers SET current_address=NULL WHERE id=$1', [K.coId]);
  calls.length = 0;
  let jointRefused = null;
  try {
    await credit.importCredit(K.appId, {
      borrowerIds: [K.borrowerId, K.coId], joint: true, requestType: 'new', consent: true, actorId: staff.id,
    });
  } catch (e) { jointRefused = e.userMessage || e.message; }
  ok(!!jointRefused && /missing/i.test(jointRefused), `a joint order with incomplete borrower details is refused (${jointRefused})`);
  ok(calls.length === 0, 'and nothing was sent to Xactus');

  // The SAME file can still be ordered the other way — separate orders, a
  // reference each — so the choice is genuinely per import.
  const S2 = await seedFile('s2', staff.id);
  calls.length = 0;
  provider.pull = async (args) => {
    calls.push(args);
    const first = (args.borrower && args.borrower.firstName) || (args.borrowers && args.borrowers[0].firstName);
    return { xml: soloXml(first, 'Marsh', first === 'Robin' ? '987654321' : '123456789', 700, 690, 695, 'X-' + first), pdfBase64: PDF_B64, vendorReportId: 'X-' + first };
  };
  const sepOut = await credit.importCredit(S2.appId, {
    borrowerIds: [S2.borrowerId, S2.coId], joint: false, requestType: 'reissue',
    reissueReportIds: { [S2.borrowerId]: 'REF-A', [S2.coId]: 'REF-B' }, consent: true, actorId: staff.id,
  });
  ok(calls.length === 2, `separate orders send one request per borrower (sent ${calls.length})`);
  ok(sepOut.importMode !== 'joint' && sepOut.pulled === 2, 'and both borrowers still import');
  const sentRefs = calls.map((c) => c.reissueReportId).sort().join(',');
  ok(sentRefs === 'REF-A,REF-B', `each with its own reference (${sentRefs})`);

  // A joint response that names nobody on the file is refused, never mis-filed.
  // (Sets its own stub — the sections above swap `provider.pull` for their own.)
  provider.pull = async (args) => { calls.push(args); return { xml: MERGED_XML, pdfBase64: PDF_B64, vendorReportId: 'XAC-JOINT-DB' }; };
  const H = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,date_of_birth,ssn_encrypted,ssn_last4,current_address)
     VALUES ('Chris','Okafor',$1,'1979-01-05',$2,$3,$4) RETURNING id`,
    [`stranger_${process.pid}@example.com`, C.ssnForStorage('555112222').encrypted, '2222',
      JSON.stringify({ line1: '4 Pine Rd', city: 'Toms River', state: 'NJ', zip: '08753' })])).rows[0];
  const hApp = (await db.query('INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id', [H.id])).rows[0];
  let mis = null;
  try {
    await credit.importCredit(hApp.id, { borrowerIds: [H.id], requestType: 'new', consent: true, actorId: staff.id });
  } catch (e) { mis = e.userMessage || e.message; }
  ok(!!mis && /none of them matches/i.test(mis),
    `a joint report naming nobody on the file is refused, not filed against the wrong person (${mis})`);
  provider.pull = realPull;

  // ───────────────────────────────────────────────────────────── cleanup ────
  const apps = [A.appId, B.appId, C2.appId, D.appId, E.appId, F.appId, G.appId, J.appId, K.appId, S.appId, S2.appId, soloApp.id, hApp.id];
  await db.query('DELETE FROM credit_reports WHERE application_id = ANY($1::uuid[])', [apps]).catch(() => {});
  await db.query('DELETE FROM documents WHERE application_id = ANY($1::uuid[])', [apps]).catch(() => {});
  await db.query('DELETE FROM checklist_items WHERE application_id = ANY($1::uuid[])', [apps]).catch(() => {});
  await db.query('UPDATE applications SET co_borrower_id=NULL WHERE id = ANY($1::uuid[])', [apps]).catch(() => {});
  await db.query('DELETE FROM applications WHERE id = ANY($1::uuid[])', [apps]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE email LIKE $1', [`%_${process.pid}@example.com`]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE id=$1', [staff.id]).catch(() => {});

  console.log(failures === 0
    ? '\nOK  credit-merged-import-db: merged split per borrower, one filed document, one condition, two separate files, per-borrower reissue, joint live response sliced — all passed'
    : `\nFAILED ${failures} assertion(s)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
