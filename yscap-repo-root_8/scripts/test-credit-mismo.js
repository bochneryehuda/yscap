/* Ad-hoc unit tests for src/lib/credit/mismo2-request.js + mismo2-response.js
 * Run: node scripts/test-credit-mismo.js   (no DB / network needed) */
const R = require('../src/lib/credit/mismo2-request');
const P = require('../src/lib/credit/mismo2-response');
const S = require('../src/lib/credit/scoring');

let pass = 0, fail = 0;
const eq = (name, got, exp) => {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g === e) { pass++; } else { fail++; console.log(`FAIL ${name}: got ${g} expected ${e}`); }
};
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const throws = (name, fn) => { try { fn(); fail++; console.log(`FAIL ${name}: expected throw`); } catch (_) { pass++; } };

const borrower = (over = {}) => Object.assign({
  firstName: 'Nickie', middleName: 'C', lastName: 'Green', ssn: '123-00-3333',
  residence: { streetAddress: '100 Terrace Ave', city: 'West Haven', state: 'CT', postalCode: '06516' },
}, over);

// ===== REQUEST BUILDER =====
const softReissue = R.buildCreditRequest({
  requestingPartyName: 'YS Capital Group', submittingPartyName: 'YS Capital Group LOS',
  lenderCaseIdentifier: 'LOAN123', requestId: 'req-1', product: 'prequal', action: 'Reissue',
  creditReportIdentifier: '1202696', requestDatetime: '2026-07-19T12:00:00', borrowers: [borrower()],
});
ok('req soft type Other', softReissue.includes('CreditReportType="Other"'));
ok('req soft SoftCheck', softReissue.includes('CreditReportTypeOtherDescription="SoftCheck"'));
ok('req action Reissue', softReissue.includes('CreditReportRequestActionType="Reissue"'));
ok('req has identifier', softReissue.includes('CreditReportIdentifier="1202696"'));
ok('req individual', softReissue.includes('CreditRequestType="Individual"'));
ok('req submitting party', softReissue.includes('_Name="YS Capital Group LOS"'));
ok('req ssn digits', softReissue.includes('_SSN="123003333"'));
ok('req all repos Y', softReissue.includes('_EquifaxIndicator="Y" _ExperianIndicator="Y" _TransUnionIndicator="Y"'));

// hard pull, brand-new Submit (no identifier needed)
const hardSubmit = R.buildCreditRequest({
  requestingPartyName: 'YS Capital Group', submittingPartyName: 'YS Capital Group LOS',
  lenderCaseIdentifier: 'LOAN123', requestId: 'req-2', product: 'creditreport', action: 'Submit',
  borrowers: [borrower()],
});
ok('req hard Merge', hardSubmit.includes('CreditReportType="Merge"'));
ok('req hard no otherdesc', !hardSubmit.includes('CreditReportTypeOtherDescription'));
ok('req hard Submit', hardSubmit.includes('CreditReportRequestActionType="Submit"'));

// joint
const joint = R.buildCreditRequest({
  requestingPartyName: 'YS', submittingPartyName: 'YS Capital Group LOS',
  lenderCaseIdentifier: 'L1', requestId: 'r1', product: 'prequal', action: 'Submit',
  borrowers: [borrower(), borrower({ firstName: 'Ann', lastName: 'Freddie', ssn: '992-70-0027' })],
});
ok('req joint type', joint.includes('CreditRequestType="Joint"'));
ok('req joint borrower ids', joint.includes('BorrowerID="B1 C1"'));
ok('req joint two borrowers', (joint.match(/<BORROWER /g) || []).length === 2);

// XML escaping
const esc = R.buildCreditRequest({
  requestingPartyName: 'A & B "Co" <x>', submittingPartyName: 'YS', lenderCaseIdentifier: 'L', requestId: 'r',
  product: 'prequal', action: 'Submit', borrowers: [borrower()],
});
ok('req escapes &<>"', esc.includes('_Name="A &amp; B &quot;Co&quot; &lt;x&gt;"'));

// validation throws
throws('req reissue without id throws', () => R.buildCreditRequest({
  requestingPartyName: 'A', submittingPartyName: 'B', lenderCaseIdentifier: 'L', requestId: 'r',
  product: 'prequal', action: 'Reissue', borrowers: [borrower()] }));
throws('req bad ssn throws', () => R.buildCreditRequest({
  requestingPartyName: 'A', submittingPartyName: 'B', lenderCaseIdentifier: 'L', requestId: 'r',
  product: 'prequal', action: 'Submit', borrowers: [borrower({ ssn: '123' })] }));
throws('req unmerge on prequal throws', () => R.buildCreditRequest({
  requestingPartyName: 'A', submittingPartyName: 'B', lenderCaseIdentifier: 'L', requestId: 'r',
  product: 'prequal', action: 'Unmerge', creditReportIdentifier: '1', borrowers: [borrower()] }));
throws('req no borrowers throws', () => R.buildCreditRequest({
  requestingPartyName: 'A', submittingPartyName: 'B', lenderCaseIdentifier: 'L', requestId: 'r',
  product: 'prequal', action: 'Submit', borrowers: [] }));

// ===== RESPONSE PARSER =====
const MINI_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF').toString('base64');
const scoreXml = (id, file, bureau, val, model) =>
  `<CREDIT_SCORE CreditScoreID="${id}" BorrowerID="${file.b}" CreditFileID="${file.f}" CreditReportIdentifier="1202696" CreditRepositorySourceType="${bureau}" _Date="2026-07-19" _Value="${val}" _ModelNameType="${model}" _FACTAInquiriesIndicator="Y"/>`;
const successXml = `<?xml version="1.0" encoding="UTF-8"?>
<RESPONSE_GROUP MISMOVersionID="2.3.1">
  <RESPONSE ResponseDateTime="2026-07-19T12:00:00">
    <KEY _Name="ver" _Value="2.3.1"/>
    <RESPONSE_DATA>
      <CREDIT_RESPONSE MISMOVersionID="2.3.1" CreditReportIdentifier="1202696" CreditResponseID="CR1202696" CreditReportFirstIssuedDate="2026-07-19" CreditReportLastUpdatedDate="2026-07-19" CreditReportMergeType="PickAndChoose" CreditReportType="Other" CreditReportTypeOtherDescription="SoftCheck" CreditRatingCodeType="Experian">
        <CREDIT_REPOSITORY_INCLUDED _EquifaxIndicator="Y" _ExperianIndicator="Y" _TransUnionIndicator="Y"/>
        <BORROWER BorrowerID="B1" _FirstName="NICKIE" _MiddleName="C" _LastName="GREEN" _SSN="123003333"/>
        ${scoreXml('S1', { b: 'B1', f: 'F1' }, 'Equifax', '734', 'EquifaxBeacon5.0')}
        ${scoreXml('S2', { b: 'B1', f: 'F2' }, 'Experian', '732', 'ExperianFairIsaac')}
        ${scoreXml('S3', { b: 'B1', f: 'F3' }, 'TransUnion', '730', 'FICORiskScoreClassic04')}
        <EMBEDDED_FILE _Type="PDF" _Name="report.pdf" _Extension="pdf" _Description="Pre-Qualification" MIMEType="application/pdf" _EncodingType="base64">
          <DOCUMENT><![CDATA[${MINI_PDF}]]></DOCUMENT>
        </EMBEDDED_FILE>
      </CREDIT_RESPONSE>
    </RESPONSE_DATA>
    <STATUS _Condition="Success" _Code="0" _Description="Success"/>
  </RESPONSE>
</RESPONSE_GROUP>`;

const succ = P.parseCreditResponse(successXml);
eq('resp ok', succ.ok, true);
eq('resp reportIdentifier', succ.reportIdentifier, '1202696');
eq('resp reportType', succ.reportType, 'Other');
eq('resp otherDescription', succ.otherDescription, 'SoftCheck');
eq('resp one borrower', succ.borrowers.length, 1);
eq('resp three scores', succ.borrowers[0].scores.length, 3);
eq('resp borrower ssn', succ.borrowers[0].ssn, '123003333');
// scores feed scoring.js correctly → middle 732
eq('resp -> middle 732', S.borrowerMiddle(succ.borrowers[0].scores).middle, 732);
ok('resp has pdf base64', !!succ.pdf && succ.pdf.base64 === MINI_PDF);
ok('resp repos returned', succ.repositoriesReturned && succ.repositoriesReturned.equifax === true);

// score factors (_FACTOR reason codes) extracted per score
const factorXml = `<?xml version="1.0"?>
<RESPONSE_GROUP MISMOVersionID="2.3.1"><RESPONSE><RESPONSE_DATA>
  <CREDIT_RESPONSE MISMOVersionID="2.3.1" CreditReportIdentifier="RF1" CreditReportType="Other">
    <BORROWER BorrowerID="B1" _FirstName="NICKIE" _LastName="GREEN" _SSN="123003333"/>
    <CREDIT_SCORE BorrowerID="B1" CreditRepositorySourceType="Equifax" _Value="734" _ModelNameType="EquifaxBeacon5.0">
      <_FACTOR _Code="038" _Text="Serious delinquency, and public record or collection filed"/>
      <_FACTOR _Code="018" _Text="Number of accounts with delinquency"/>
    </CREDIT_SCORE>
  </CREDIT_RESPONSE>
</RESPONSE_DATA></RESPONSE></RESPONSE_GROUP>`;
const rf = P.parseCreditResponse(factorXml);
eq('factors extracted count', rf.borrowers[0].scores[0].factors.length, 2);
eq('factor code kept as string', rf.borrowers[0].scores[0].factors[0].code, '038');
ok('factor text present', /Serious delinquency/.test(rf.borrowers[0].scores[0].factors[0].text));
// factors survive scoring classification
const cls = S.classifyScore(rf.borrowers[0].scores[0]);
eq('classified keeps factors', cls.factors.length, 2);
eq('score node without factors -> []', succ.borrowers[0].scores[0].factors.length, 0);

// per-bureau CREDIT_FILE freeze status (nested error + _ResultStatusType) — verified
// against the live Xactus test response for a frozen persona
const frozenXml = `<?xml version="1.0"?>
<RESPONSE_GROUP MISMOVersionID="2.3.1"><RESPONSE><RESPONSE_DATA>
  <CREDIT_RESPONSE MISMOVersionID="2.3.1" CreditReportIdentifier="RZ" CreditReportType="Other">
    <BORROWER BorrowerID="B1" _FirstName="ANN" _LastName="FREDDIE" _SSN="992700027"/>
    <CREDIT_SCORE BorrowerID="B1" CreditRepositorySourceType="TransUnion" _Value="720" _ModelNameType="FICORiskScoreClassic04"/>
    <CREDIT_FILE CreditFileID="F1" BorrowerID="B1" CreditRepositorySourceType="TransUnion" _InfileDate="2001-10"/>
    <CREDIT_FILE CreditFileID="F2" BorrowerID="B1" CreditRepositorySourceType="Experian" _ResultStatusType="NoFileReturnedCreditFreeze">
      <CREDIT_ERROR_MESSAGE _Code="ERR" _SourceType="Experian"><_Text>CONSUMER REQUESTED SECURITY FREEZE - REPORT UNAVAILABLE</_Text></CREDIT_ERROR_MESSAGE>
    </CREDIT_FILE>
    <CREDIT_FILE CreditFileID="F3" BorrowerID="B1" CreditRepositorySourceType="Equifax" _ResultStatusType="NoFileReturnedCreditFreeze"/>
  </CREDIT_RESPONSE>
</RESPONSE_DATA></RESPONSE></RESPONSE_GROUP>`;
const fz = P.parseCreditResponse(frozenXml);
ok('frozen: file-status surfaced as error', fz.errors.some(e => /freeze/i.test((e.texts||[]).join(' ') + (e.code||''))));
ok('frozen: nested error message picked up', fz.errors.some(e => /SECURITY FREEZE/i.test((e.texts||[]).join(' '))));
ok('frozen: normal TU file NOT flagged', !fz.errors.some(e => e.sourceType === 'TransUnion'));

// decode + verify the PDF
const dec = P.decodeReportPdf(succ.pdf.base64);
ok('pdf decodes to %PDF', dec.buf.slice(0, 5).toString('latin1') === '%PDF-');
ok('pdf has sha256', typeof dec.sha256 === 'string' && dec.sha256.length === 64);
throws('pdf junk decode throws', () => P.decodeReportPdf('not-a-pdf-just-base64-text=='));

// error response (E036) — from Xactus docs
const errXml = `<?xml version="1.0" encoding="UTF-8"?>
<RESPONSE_GROUP MISMOVersionID="2.3.1">
  <RESPONSE ResponseDateTime="2024-11-06T06:58:43">
    <RESPONSE_DATA>
      <CREDIT_RESPONSE MISMOVersionID="2.3.1" CreditReportType="Error">
        <CREDIT_ERROR_MESSAGE _Code="E036" _SourceType="CreditBureau">
          <_Text>Invalid Client Account Identifier</_Text>
          <_Text>Incorrect password supplied</_Text>
        </CREDIT_ERROR_MESSAGE>
      </CREDIT_RESPONSE>
    </RESPONSE_DATA>
    <STATUS _Condition="Error" _Code="E036" _Description="Invalid Client Account Identifier"/>
  </RESPONSE>
</RESPONSE_GROUP>`;
const err = P.parseCreditResponse(errXml);
eq('err not ok', err.ok, false);
ok('err has status E036', err.errors.some((e) => e.layer === 'status' && e.code === 'E036'));
ok('err has credit E036', err.errors.some((e) => e.layer === 'credit' && e.code === 'E036'));
ok('err texts captured', err.errors.some((e) => (e.texts || []).includes('Incorrect password supplied')));

// joint response: 2 borrowers x 3 scores
const jointXml = successXml
  .replace('<BORROWER BorrowerID="B1" _FirstName="NICKIE" _MiddleName="C" _LastName="GREEN" _SSN="123003333"/>',
    '<BORROWER BorrowerID="B1" _FirstName="NICKIE" _LastName="GREEN" _SSN="123003333"/><BORROWER BorrowerID="C1" _FirstName="ANN" _LastName="FREDDIE" _SSN="992700027"/>')
  .replace('</EMBEDDED_FILE>',
    `</EMBEDDED_FILE>
        ${scoreXml('S4', { b: 'C1', f: 'F4' }, 'Equifax', '648', 'EquifaxBeacon5.0')}
        ${scoreXml('S5', { b: 'C1', f: 'F5' }, 'Experian', '661', 'ExperianFairIsaac')}
        ${scoreXml('S6', { b: 'C1', f: 'F6' }, 'TransUnion', '655', 'FICORiskScoreClassic04')}`);
const jr = P.parseCreditResponse(jointXml);
eq('joint two borrowers', jr.borrowers.length, 2);
const mids = jr.borrowers.map((b) => S.borrowerMiddle(b.scores).middle);
eq('joint middles 732 & 655', mids.sort((a, b) => a - b), [655, 732]);
eq('joint representative = 732 (highest)', S.loanRepresentative(mids).score, 732);

// frozen bureau: only 2 scores → lower of two
const twoXml = successXml.replace(scoreXml('S3', { b: 'B1', f: 'F3' }, 'TransUnion', '730', 'FICORiskScoreClassic04'), '');
const two = P.parseCreditResponse(twoXml);
eq('two-score middle = lower (732 vs 734 -> 732)', S.borrowerMiddle(two.borrowers[0].scores).middle, 732);

// hardened guards fail closed
throws('resp DOCTYPE rejected', () => P.parseCreditResponse('<?xml version="1.0"?><!DOCTYPE x><RESPONSE_GROUP></RESPONSE_GROUP>'));
throws('resp HTML rejected', () => P.parseCreditResponse('<html><body>error 500</body></html>'));
throws('resp truncated rejected', () => P.parseCreditResponse('<?xml version="1.0"?><RESPONSE_GROUP><RESPONSE>'));
throws('resp empty rejected', () => P.parseCreditResponse('   '));

// entity decoding on extracted names/errors (audit nit 2) — keeps the parser's
// XXE backstop but reads "A&B" / "O'Neil" correctly for the mixed-file check
const entXml = successXml
  .replace('_FirstName="NICKIE" _MiddleName="C" _LastName="GREEN"', '_FirstName="O&apos;Neil" _LastName="A&amp;B &lt;Co&gt;"');
const ent = P.parseCreditResponse(entXml);
eq('entity-decoded lastName', ent.borrowers[0].lastName, 'A&B <Co>');
eq('entity-decoded firstName', ent.borrowers[0].firstName, "O'Neil");
const entErr = P.parseCreditResponse(errXml.replace('Incorrect password supplied', 'Smith &amp; Co &lt;fail&gt;'));
ok('entity-decoded error text', entErr.errors.some((e) => (e.texts || []).includes('Smith & Co <fail>')));

// SSN with a stray letter is rejected (audit nit 3), not silently "fixed"
throws('req ssn with letter throws', () => R.buildCreditRequest({
  requestingPartyName: 'A', submittingPartyName: 'B', lenderCaseIdentifier: 'L', requestId: 'r',
  product: 'prequal', action: 'Submit', borrowers: [borrower({ ssn: '12a-45-6789' })] }));

console.log(`\ncredit-mismo: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
