/* Unit tests for the MISMO 3.4 request builder + response parser.
 * Fixtures mirror the real Xactus 3.4 test responses (verified live 2026-07-19).
 * Run: node scripts/test-credit-mismo3.js  (no DB / network) */
const R = require('../src/lib/credit/mismo3-request');
const P = require('../src/lib/credit/mismo3-response');
const S = require('../src/lib/credit/scoring');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log(`FAIL ${n}`); } };
const eq = (n, g, e) => { if (JSON.stringify(g) === JSON.stringify(e)) pass++; else { fail++; console.log(`FAIL ${n}: got ${JSON.stringify(g)} exp ${JSON.stringify(e)}`); } };
const throws = (n, fn) => { try { fn(); fail++; console.log(`FAIL ${n}: expected throw`); } catch (_) { pass++; } };

const borrower = (o = {}) => Object.assign({
  firstName: 'Nickie', middleName: 'C', lastName: 'Green', ssn: '123-00-3333',
  residence: { streetAddress: '100 Terrace Ave', city: 'West Haven', state: 'CT', postalCode: '06516' },
}, o);

// ===== REQUEST BUILDER =====
const soft = R.buildCreditRequest({
  requestingPartyName: 'YS Capital Group', submittingPartyName: 'YS Capital Group LOS',
  lenderCaseIdentifier: 'LOAN9', requestId: 'r9', product: 'prequal', action: 'Submit', borrowers: [borrower()],
});
ok('3.4 root MESSAGE + version', /<MESSAGE MISMOReferenceModelIdentifier="3\.4"/.test(soft));
ok('3.4 soft type Other', /<CreditReportType>Other<\/CreditReportType>/.test(soft));
ok('3.4 soft SoftCheck', /<CreditReportTypeOtherDescription>SoftCheck<\/CreditReportTypeOtherDescription>/.test(soft));
ok('3.4 action Submit', /<CreditReportRequestActionType>Submit<\/CreditReportRequestActionType>/.test(soft));
ok('3.4 individual', /<CreditRequestType>Individual<\/CreditRequestType>/.test(soft));
ok('3.4 SSN element', /<TaxpayerIdentifierValue>123003333<\/TaxpayerIdentifierValue>/.test(soft));
ok('3.4 submitting party', /<FullName>YS Capital Group LOS<\/FullName>/.test(soft));
ok('3.4 receiving party Xactus', /<FullName>Xactus, LLC<\/FullName>/.test(soft));
ok('3.4 repositories true', /<CreditRepositoryIncludedEquifaxIndicator>true</.test(soft));
ok('3.4 address', /<AddressLineText>100 Terrace Ave<\/AddressLineText>/.test(soft));

const hard = R.buildCreditRequest({ requestingPartyName: 'Y', submittingPartyName: 'Y LOS', lenderCaseIdentifier: 'L', requestId: 'r', product: 'creditreport', action: 'Submit', borrowers: [borrower()] });
ok('3.4 hard Merge', /<CreditReportType>Merge<\/CreditReportType>/.test(hard) && !/SoftCheck/.test(hard));

// FULL 2×2 (owner-directed: both pull types must support both actions).
// hard pull, REISSUE — "Credit ReportX reissued" (needs a prior id).
const hardReissue3 = R.buildCreditRequest({ requestingPartyName: 'Y', submittingPartyName: 'Y LOS', lenderCaseIdentifier: 'L', requestId: 'r', product: 'creditreport', action: 'Reissue', creditReportIdentifier: '2598227', borrowers: [borrower()] });
ok('3.4 hard-reissue Merge', /<CreditReportType>Merge<\/CreditReportType>/.test(hardReissue3));
ok('3.4 hard-reissue action Reissue', /<CreditReportRequestActionType>Reissue<\/CreditReportRequestActionType>/.test(hardReissue3));
ok('3.4 hard-reissue carries the prior id', /<CreditReportIdentifier>2598227<\/CreditReportIdentifier>/.test(hardReissue3));
// soft pull, REISSUE — "reissue a soft" default (needs a prior id).
const softReissue3 = R.buildCreditRequest({ requestingPartyName: 'Y', submittingPartyName: 'Y LOS', lenderCaseIdentifier: 'L', requestId: 'r', product: 'prequal', action: 'Reissue', creditReportIdentifier: '2598227', borrowers: [borrower()] });
ok('3.4 soft-reissue SoftCheck + Reissue', /SoftCheck/.test(softReissue3) && /<CreditReportRequestActionType>Reissue<\/CreditReportRequestActionType>/.test(softReissue3));
// a brand-new (Submit) request must OMIT the identifier element entirely — not send an empty one.
ok('3.4 brand-new omits the identifier element', !/<CreditReportIdentifier>/.test(hard) && !/<CreditReportIdentifier>/.test(soft));
ok('3.4 reissue DOES carry the identifier element', /<CreditReportIdentifier>2598227<\/CreditReportIdentifier>/.test(hardReissue3));
// hard reissue without a prior id throws too (the needs-id guard is action-based, so it covers the hard corner).
throws('3.4 hard-reissue needs id', () => R.buildCreditRequest({ requestingPartyName: 'Y', submittingPartyName: 'Y', lenderCaseIdentifier: 'L', requestId: 'r', product: 'creditreport', action: 'Reissue', borrowers: [borrower()] }));

const joint = R.buildCreditRequest({ requestingPartyName: 'Y', submittingPartyName: 'Y LOS', lenderCaseIdentifier: 'L', requestId: 'r', product: 'prequal', action: 'Submit', borrowers: [borrower(), borrower({ firstName: 'Ann', ssn: '992-70-0027' })] });
ok('3.4 joint two parties', (joint.match(/<PARTY SequenceNumber=/g) || []).length >= 2);
ok('3.4 joint request type', /<CreditRequestType>Joint<\/CreditRequestType>/.test(joint));
ok('3.4 joint two relationships', (joint.match(/CREDIT_REQUEST_DATA_IsAssociatedWith_ROLE/g) || []).length === 2);

throws('3.4 reissue needs id', () => R.buildCreditRequest({ requestingPartyName: 'Y', submittingPartyName: 'Y', lenderCaseIdentifier: 'L', requestId: 'r', product: 'prequal', action: 'Reissue', borrowers: [borrower()] }));
throws('3.4 refresh needs id', () => R.buildCreditRequest({ requestingPartyName: 'Y', submittingPartyName: 'Y', lenderCaseIdentifier: 'L', requestId: 'r', product: 'refresh', action: 'Submit', borrowers: [borrower()] }));
throws('3.4 bad ssn rejected', () => R.buildCreditRequest({ requestingPartyName: 'Y', submittingPartyName: 'Y', lenderCaseIdentifier: 'L', requestId: 'r', product: 'prequal', action: 'Submit', borrowers: [borrower({ ssn: '12A-00-3333' })] }));

// ===== RESPONSE PARSER (fixture mirrors the real Xactus 3.4 shape) =====
const scoreEl = (id, bureau, model, val) =>
  `<CREDIT_SCORE SequenceNumber="${id}" xlink:label="S${id}"><CREDIT_SCORE_DETAIL><CreditReportIdentifier>2598227</CreditReportIdentifier><CreditRepositorySourceType>${bureau}</CreditRepositorySourceType><CreditScoreModelNameType>${model}</CreditScoreModelNameType><CreditScoreValue>${val}</CreditScoreValue></CREDIT_SCORE_DETAIL></CREDIT_SCORE>`;
const MINI_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF').toString('base64');
const okResp = `<?xml version="1.0"?>
<MESSAGE MISMOReferenceModelIdentifier="3.4" xmlns="http://www.mismo.org/residential/2009/schemas" xmlns:xlink="http://www.w3.org/1999/xlink">
  <DEAL_SETS>
    <DEAL_SET><DEALS><DEAL>
      <PARTIES><PARTY SequenceNumber="1"><INDIVIDUAL><NAME><FirstName>ANDY</FirstName><LastName>FREDDIE</LastName></NAME></INDIVIDUAL>
        <ROLES><ROLE xlink:label="Borrower01"><ROLE_DETAIL><PartyRoleType>Borrower</PartyRoleType></ROLE_DETAIL></ROLE></ROLES>
        <TAXPAYER_IDENTIFIERS><TAXPAYER_IDENTIFIER><TaxpayerIdentifierValue>990000003</TaxpayerIdentifierValue></TAXPAYER_IDENTIFIER></TAXPAYER_IDENTIFIERS></PARTY></PARTIES>
      <SERVICES><SERVICE><CREDIT><CREDIT_RESPONSE>
        <CREDIT_RESPONSE_DETAIL><CreditReportIdentifier>2598227</CreditReportIdentifier><CreditReportFirstIssuedDate>2026-07-19</CreditReportFirstIssuedDate><CreditReportType>Other</CreditReportType><CreditReportTypeOtherDescription>SoftCheck</CreditReportTypeOtherDescription></CREDIT_RESPONSE_DETAIL>
        <CREDIT_REPOSITORY_INCLUDED><CreditRepositoryIncludedEquifaxIndicator>true</CreditRepositoryIncludedEquifaxIndicator><CreditRepositoryIncludedExperianIndicator>true</CreditRepositoryIncludedExperianIndicator><CreditRepositoryIncludedTransUnionIndicator>true</CreditRepositoryIncludedTransUnionIndicator></CREDIT_REPOSITORY_INCLUDED>
        <CREDIT_SCORES>${scoreEl('1', 'Equifax', 'EquifaxBeacon5.0', '724')}${scoreEl('2', 'TransUnion', 'FICORiskScoreClassic04', '740')}${scoreEl('3', 'Experian', 'ExperianFairIsaac', '742')}</CREDIT_SCORES>
      </CREDIT_RESPONSE></CREDIT></SERVICE></SERVICES>
    </DEAL></DEALS></DEAL_SET>
  </DEAL_SETS>
  <DOCUMENT_SETS><DOCUMENT_SET><DOCUMENTS><DOCUMENT><VIEWS><VIEW><VIEW_FILES><VIEW_FILE xlink:label="ViewFile001"><MIMETypeIdentifier>application/pdf</MIMETypeIdentifier><EmbeddedContentXML>${MINI_PDF}</EmbeddedContentXML></VIEW_FILE></VIEW_FILES></VIEW></VIEWS></DOCUMENT></DOCUMENTS></DOCUMENT_SET></DOCUMENT_SETS>
</MESSAGE>`;
const r = P.parseCreditResponse(okResp);
ok('3.4 resp ok', r.ok && r.errors.length === 0);
eq('3.4 reportId', r.reportIdentifier, '2598227');
eq('3.4 firstIssued', r.firstIssuedDate, '2026-07-19');
eq('3.4 type', [r.reportType, r.otherDescription], ['Other', 'SoftCheck']);
eq('3.4 one borrower (deduped)', r.borrowers.length, 1);
eq('3.4 three scores', r.borrowers[0].scores.length, 3);
eq('3.4 middle 740', S.borrowerMiddle(r.borrowers[0].scores).middle, 740);
ok('3.4 pdf present', !!r.pdf && r.pdf.base64 === MINI_PDF);
ok('3.4 pdf decodes', P.decodeReportPdf(r.pdf.base64).buf.slice(0, 5).toString('latin1') === '%PDF-');
// A truncated PDF (valid %PDF- header, NO %%EOF trailer) must be rejected (parity with 2.3.1).
throws('3.4 truncated PDF (no %%EOF) rejected', () => P.decodeReportPdf(Buffer.from('%PDF-1.4\nbody with no trailer').toString('base64')));

// error response (E103 shape, verified live)
const errResp = `<?xml version="1.0"?><MESSAGE MISMOReferenceModelIdentifier="3.4" xmlns="http://www.mismo.org/residential/2009/schemas"><DEAL_SETS><DEAL_SET><DEALS><DEAL><SERVICES><SERVICE><CREDIT><CREDIT_RESPONSE><CREDIT_ERROR_MESSAGES><CREDIT_ERROR_MESSAGE><CreditErrorMessageCode>E103</CreditErrorMessageCode><CreditErrorMessageSourceType>CreditBureau</CreditErrorMessageSourceType><CreditErrorMessageText>Duplicate order.</CreditErrorMessageText></CREDIT_ERROR_MESSAGE></CREDIT_ERROR_MESSAGES></CREDIT_RESPONSE></CREDIT><STATUSES><STATUS><StatusCode>E103</StatusCode><StatusConditionDescription>Error</StatusConditionDescription><StatusDescription>Duplicate</StatusDescription></STATUS></STATUSES></SERVICE></SERVICES></DEAL></DEALS></DEAL_SET></DEAL_SETS></MESSAGE>`;
const er = P.parseCreditResponse(errResp);
ok('3.4 error not ok', !er.ok);
ok('3.4 error code E103', er.errors.some((e) => e.code === 'E103'));

// phantom echo: the same borrower repeated WITHOUT an SSN must collapse to one
// (a real Xactus response echoes the borrower in several places).
const echoResp = okResp.replace('</DEAL></DEALS></DEAL_SET>',
  '<PARTIES><PARTY SequenceNumber="9"><INDIVIDUAL><NAME><FirstName>ANDY</FirstName><LastName>FREDDIE</LastName></NAME></INDIVIDUAL><ROLES><ROLE xlink:label="Echo"><ROLE_DETAIL><PartyRoleType>Borrower</PartyRoleType></ROLE_DETAIL></ROLE></ROLES></PARTY></PARTIES></DEAL></DEALS></DEAL_SET>');
const ec = P.parseCreditResponse(echoResp);
eq('3.4 no-SSN echo collapses to one borrower', ec.borrowers.length, 1);
eq('3.4 collapsed borrower keeps its 3 scores', ec.borrowers[0].scores.length, 3);

// frozen file status
const frzResp = okResp.replace('<CREDIT_SCORES>', '<CREDIT_FILE><CreditRepositorySourceType>Experian</CreditRepositorySourceType><CreditFileResultStatusType>NoFileReturnedCreditFreeze</CreditFileResultStatusType></CREDIT_FILE><CREDIT_SCORES>');
ok('3.4 frozen file surfaced', P.parseCreditResponse(frzResp).errors.some((e) => /freeze/i.test((e.texts || []).join(' ') + (e.code || ''))));

// ===== JOINT tri-merge: all six scores share ONE CREDIT_SCORES block and are
// tied to each borrower ONLY by RELATIONSHIP xlink links (verified live 2026-07-19,
// John Freddie + Mary Freddie). The co-borrower's PARTY is placed FIRST in document
// order (as the real response echoes it) to prove seq-ordering — not discovery
// order — resolves the primary (John=B1). Each borrower must get HIS/HER own three
// scores, never the other's. =====
const jointResp = `<?xml version="1.0"?>
<MESSAGE MISMOReferenceModelIdentifier="3.4" xmlns="http://www.mismo.org/residential/2009/schemas" xmlns:xlink="http://www.w3.org/1999/xlink">
  <DEAL_SETS><DEAL_SET><DEALS><DEAL>
    <PARTIES>
      <PARTY SequenceNumber="2"><INDIVIDUAL><NAME><FirstName>MARY</FirstName><LastName>FREDDIE</LastName></NAME></INDIVIDUAL>
        <ROLES><ROLE xlink:label="Borrower02"><ROLE_DETAIL><PartyRoleType>Borrower</PartyRoleType></ROLE_DETAIL></ROLE></ROLES>
        <TAXPAYER_IDENTIFIERS><TAXPAYER_IDENTIFIER><TaxpayerIdentifierValue>990200002</TaxpayerIdentifierValue></TAXPAYER_IDENTIFIER></TAXPAYER_IDENTIFIERS></PARTY>
      <PARTY SequenceNumber="1"><INDIVIDUAL><NAME><FirstName>JOHN</FirstName><LastName>FREDDIE</LastName></NAME></INDIVIDUAL>
        <ROLES><ROLE xlink:label="Borrower01"><ROLE_DETAIL><PartyRoleType>Borrower</PartyRoleType></ROLE_DETAIL></ROLE></ROLES>
        <TAXPAYER_IDENTIFIERS><TAXPAYER_IDENTIFIER><TaxpayerIdentifierValue>990100001</TaxpayerIdentifierValue></TAXPAYER_IDENTIFIER></TAXPAYER_IDENTIFIERS></PARTY>
    </PARTIES>
    <SERVICES><SERVICE><CREDIT><CREDIT_RESPONSE>
      <CREDIT_RESPONSE_DETAIL><CreditReportIdentifier>2598320</CreditReportIdentifier><CreditReportFirstIssuedDate>2026-07-19</CreditReportFirstIssuedDate></CREDIT_RESPONSE_DETAIL>
      <CREDIT_REPOSITORY_INCLUDED><CreditRepositoryIncludedEquifaxIndicator>true</CreditRepositoryIncludedEquifaxIndicator><CreditRepositoryIncludedExperianIndicator>true</CreditRepositoryIncludedExperianIndicator><CreditRepositoryIncludedTransUnionIndicator>true</CreditRepositoryIncludedTransUnionIndicator></CREDIT_REPOSITORY_INCLUDED>
      <CREDIT_SCORES>${scoreEl('1', 'Equifax', 'EquifaxBeacon5.0', '760')}${scoreEl('2', 'Equifax', 'EquifaxBeacon5.0', '783')}${scoreEl('3', 'Experian', 'ExperianFairIsaac', '785')}${scoreEl('4', 'Experian', 'ExperianFairIsaac', '771')}${scoreEl('5', 'TransUnion', 'FICORiskScoreClassic04', '779')}${scoreEl('6', 'TransUnion', 'FICORiskScoreClassic04', '768')}</CREDIT_SCORES>
      <RELATIONSHIPS>
        <RELATIONSHIP xlink:from="CR2598320" xlink:to="S1"/>
        <RELATIONSHIP xlink:from="Borrower01" xlink:to="S1"/>
        <RELATIONSHIP xlink:from="Borrower02" xlink:to="S2"/>
        <RELATIONSHIP xlink:from="Borrower01" xlink:to="S3"/>
        <RELATIONSHIP xlink:from="Borrower02" xlink:to="S4"/>
        <RELATIONSHIP xlink:from="Borrower01" xlink:to="S5"/>
        <RELATIONSHIP xlink:from="Borrower02" xlink:to="S6"/>
      </RELATIONSHIPS>
    </CREDIT_RESPONSE></CREDIT></SERVICE></SERVICES>
  </DEAL></DEALS></DEAL_SET></DEAL_SETS>
</MESSAGE>`;
const jr = P.parseCreditResponse(jointResp);
eq('3.4 joint parses two borrowers', jr.borrowers.length, 2);
eq('3.4 joint primary resolves to John=B1 (seq, not doc order)', [jr.borrowers[0].firstName, jr.borrowers[0].borrowerId], ['JOHN', 'B1']);
eq('3.4 joint co resolves to Mary=C1', [jr.borrowers[1].firstName, jr.borrowers[1].borrowerId], ['MARY', 'C1']);
eq('3.4 joint John keeps his SSN', jr.borrowers[0].ssn, '990100001');
eq('3.4 joint Mary keeps her SSN', jr.borrowers[1].ssn, '990200002');
eq('3.4 joint John gets exactly 3 scores', jr.borrowers[0].scores.length, 3);
eq('3.4 joint Mary gets exactly 3 scores', jr.borrowers[1].scores.length, 3);
ok('3.4 joint John scores are HIS only', jr.borrowers[0].scores.every((s) => ['760', '785', '779'].includes(s.value)));
ok('3.4 joint Mary scores are HERS only', jr.borrowers[1].scores.every((s) => ['783', '771', '768'].includes(s.value)));
eq('3.4 joint John middle 779', S.borrowerMiddle(jr.borrowers[0].scores).middle, 779);
eq('3.4 joint Mary middle 771', S.borrowerMiddle(jr.borrowers[1].scores).middle, 771);
ok('3.4 joint not flagged unsplit', !jr.multiBorrowerUnsplit);

// If the RELATIONSHIP links are ABSENT and all scores sit in one shared block, the
// parser must NOT silently mis-assign — it flags the file so import routes it to a
// human (never guesses which borrower owns which score).
const jointNoRel = jointResp.replace(/<RELATIONSHIPS>[\s\S]*<\/RELATIONSHIPS>/, '');
const jnr = P.parseCreditResponse(jointNoRel);
ok('3.4 joint w/o links is flagged unsplit (review, not guessed)', jnr.multiBorrowerUnsplit === true);

// B1/C1 ordering must follow the SCORE-referenced role label, NOT a raw
// SequenceNumber — a per-bureau CREDIT_FILE echo party that carries the
// co-borrower's Borrower ROLE label with a LOW SequenceNumber must not flip the
// primary. Inject such an echo for Mary (Borrower02) at SequenceNumber 1: John
// (Borrower01, the label the scores actually reference) must still be B1.
const jointEchoPollute = jointResp.replace('</PARTIES>',
  `</PARTIES><CREDIT_FILE><PARTIES><PARTY SequenceNumber="1"><INDIVIDUAL><NAME><FirstName>MARY</FirstName><LastName>FREDDIE</LastName></NAME></INDIVIDUAL>` +
  `<ROLES><ROLE xlink:label="B02echo"><ROLE_DETAIL><PartyRoleType>Borrower</PartyRoleType></ROLE_DETAIL></ROLE></ROLES>` +
  `<TAXPAYER_IDENTIFIERS><TAXPAYER_IDENTIFIER><TaxpayerIdentifierValue>990200002</TaxpayerIdentifierValue></TAXPAYER_IDENTIFIER></TAXPAYER_IDENTIFIERS></PARTY></PARTIES></CREDIT_FILE>`);
const jep = P.parseCreditResponse(jointEchoPollute);
eq('3.4 joint echo-pollution: John still B1', [jep.borrowers[0].firstName, jep.borrowers[0].borrowerId], ['JOHN', 'B1']);
eq('3.4 joint echo-pollution: Mary still C1', [jep.borrowers[1].firstName, jep.borrowers[1].borrowerId], ['MARY', 'C1']);
eq('3.4 joint echo-pollution: John keeps his 3 scores', jep.borrowers[0].scores.length, 3);
eq('3.4 joint echo-pollution: Mary keeps her 3 scores', jep.borrowers[1].scores.length, 3);
ok('3.4 joint echo-pollution: John scores are HIS only', jep.borrowers[0].scores.every((s) => ['760', '785', '779'].includes(s.value)));

// hardening
throws('3.4 DOCTYPE rejected', () => P.parseCreditResponse('<?xml version="1.0"?><!DOCTYPE x><MESSAGE></MESSAGE>'));
throws('3.4 truncated rejected', () => P.parseCreditResponse('<?xml version="1.0"?><MESSAGE><DEAL_SETS>'));
throws('3.4 non-MISMO rejected', () => P.parseCreditResponse('<html><body>nope</body></html>'));

console.log(`\ncredit-mismo3: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
