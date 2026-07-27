'use strict';
/**
 * Pure unit test for MERGED (joint) credit reports — no DB, no network.
 *
 * A merged report is ONE file covering BOTH borrowers. Read flat it is worse than
 * useless: the per-bureau de-dupe throws the second borrower's scores away and the
 * "middle" score becomes the median of six numbers belonging to two people. This
 * test proves the document is split per borrower (MISMO 2.x explicit `_BorrowerID`
 * links, MISMO 3.x party nesting, and 3.x RELATIONSHIP arcs), that joint tradelines
 * read as both borrowers', that an unlabelled SCORE is never attributed to anyone,
 * and that report borrowers match the borrowers on the file by SSN → name → order.
 * Run: node scripts/test-credit-merged-pure.js
 */
const assert = require('assert');
const { parseCreditXml, sliceForSegment } = require('../src/lib/credit/parse');
const { matchSegments } = require('../src/lib/credit/match');

// ── MISMO 2.x joint report: two BORROWERs, scores + tradelines linked by _BorrowerID ──
const JOINT_2X = `<?xml version="1.0" encoding="UTF-8"?>
<RESPONSE_GROUP MISMOVersionID="2.4"><RESPONSE><RESPONSE_DATA>
 <CREDIT_RESPONSE CreditReportIdentifier="XAC-JOINT-1" CreditReportFirstIssuedDate="2026-07-25" CreditRatingCodeType="TriMerge">
  <BORROWER _ID="B1" _FirstName="Jane" _LastName="Investor" _SSN="123456789" _PrintPositionType="Borrower">
    <_RESIDENCE _StreetAddress="12 Maple Ave" _City="Lakewood" _State="NJ" _PostalCode="08701"/>
  </BORROWER>
  <BORROWER _ID="B2" _FirstName="Samuel" _LastName="Investor" _SSN="987654321" _PrintPositionType="CoBorrower">
    <_RESIDENCE _StreetAddress="12 Maple Ave" _City="Lakewood" _State="NJ" _PostalCode="08701"/>
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
  <CREDIT_INQUIRY _Name="AMEX" _Date="2026-06-01" _BorrowerID="B2"/>
  <CREDIT_PUBLIC_RECORD _Type="Judgment" _FiledDate="2021-03-04" _BorrowerID="B2" _Amount="4200"/>
 </CREDIT_RESPONSE>
</RESPONSE_DATA></RESPONSE></RESPONSE_GROUP>`;

const j = parseCreditXml(JOINT_2X);
assert.strictEqual(j.parseError, null, 'joint 2.x parses');
assert.strictEqual(j.isMerged, true, 'two borrowers → merged report');
assert.strictEqual(j.borrowers.length, 2, 'both borrowers found');

const [b1, b2] = j.borrowers;
assert.strictEqual(b1.name, 'Jane Investor');
assert.strictEqual(b2.name, 'Samuel Investor');
assert.strictEqual(b1.ssnLast4, '6789', 'primary ssn last-4');
assert.strictEqual(b2.ssnLast4, '4321', 'co-borrower ssn last-4');
assert.strictEqual(b1.printPosition, 'Borrower');
assert.strictEqual(b2.printPosition, 'CoBorrower');

// Scores split per borrower — the co-borrower's three are NOT swallowed by a
// document-wide per-bureau de-dupe (the bug that made a merged import useless).
assert.strictEqual(b1.scores.length, 3, 'primary keeps all three bureau scores');
assert.strictEqual(b2.scores.length, 3, 'co-borrower keeps all three bureau scores');
assert.strictEqual(b1.middleScore, 705, 'primary middle = 705 (720/690/705)');
assert.strictEqual(b2.middleScore, 655, 'co-borrower middle = 655 (640/668/655)');
assert.deepStrictEqual(b1.scores.map((s) => s.value).sort(), [690, 705, 720]);
assert.deepStrictEqual(b2.scores.map((s) => s.value).sort(), [640, 655, 668]);
// The old flat read produced a cross-borrower median — never again.
assert.notStrictEqual(b1.middleScore, b2.middleScore, 'each borrower gets their OWN middle score');

// Tradelines: own + the JOINT mortgage (nobody's label → both borrowers').
assert.strictEqual(b1.liabilities.length, 2, 'primary: own card + the joint mortgage');
assert.strictEqual(b2.liabilities.length, 2, 'co-borrower: own auto loan + the joint mortgage');
assert.ok(b1.liabilities.some((l) => l.creditor === 'CHASE CARD'), 'primary keeps their card');
assert.ok(b2.liabilities.some((l) => l.creditor === 'TOYOTA FINANCIAL'), 'co-borrower keeps their auto loan');
const jointOnB1 = b1.liabilities.find((l) => l.creditor === 'WELLS FARGO HM');
const jointOnB2 = b2.liabilities.find((l) => l.creditor === 'WELLS FARGO HM');
assert.ok(jointOnB1 && jointOnB2, 'the joint mortgage shows for both');
assert.strictEqual(jointOnB1.sharedAcrossBorrowers, true, 'joint tradeline is flagged shared');
assert.ok(!b1.liabilities.some((l) => l.creditor === 'TOYOTA FINANCIAL'), 'no cross-contamination of tradelines');

// Inquiries + public records follow the same link.
assert.strictEqual(b1.inquiries.length, 0, 'the AMEX inquiry is the co-borrower’s only');
assert.strictEqual(b2.inquiries.length, 1);
assert.strictEqual(b1.publicRecords.length, 0);
assert.strictEqual(b2.publicRecords.length, 1, 'the judgment is the co-borrower’s');
assert.strictEqual(b2.summary.publicRecordCount, 1, 'per-borrower summary counts their own record');
assert.strictEqual(b1.summary.tradelineCount, 2, 'per-borrower summary counts their own tradelines');
assert.strictEqual(b1.summary.totalMonthlyPayments, 35 + 1800, 'primary monthly = own card + joint mortgage');

// Document-level headline never mixes people: it is the FIRST borrower's score.
assert.strictEqual(j.middleScore, 705, 'headline middle score = the first borrower’s, not a 6-score median');
assert.strictEqual(j.borrower.firstName, 'Jane', 'headline identity = the first borrower');
assert.strictEqual(j.scores.length, 6, 'all six scores still visible at document level');

// ── One borrower's slice = a complete report for THAT borrower ────────────────
const s2 = sliceForSegment(j, b2);
assert.strictEqual(s2.middleScore, 655, 'slice carries the co-borrower’s middle score');
assert.strictEqual(s2.borrower.firstName, 'Samuel', 'slice carries the co-borrower’s identity');
assert.strictEqual(s2.scores.length, 3, 'slice carries only their scores');
assert.strictEqual(s2.reportId, 'XAC-JOINT-1', 'slice keeps the document-level report id');
assert.strictEqual(s2.reportDate, '2026-07-25', 'slice keeps the report date');
assert.strictEqual(s2.isMerged, false, 'a stored slice is one borrower’s report, not a roster');
assert.deepStrictEqual(s2.borrowers, [], 'a slice carries no roster');
assert.strictEqual(s2.mergedSource.borrowerName, 'Samuel Investor', 'the slice records where it came from');
assert.strictEqual(s2.mergedSource.borrowerCount, 2);
assert.deepStrictEqual(s2.mergedSource.otherBorrowers, ['Jane Investor'], 'and who else the file covered');

// ── MISMO 3.x joint report: identity + scores nested under each PARTY ─────────
const JOINT_3X = `<?xml version="1.0"?>
<MESSAGE xmlns:xlink="http://www.w3.org/1999/xlink"><DEAL><CREDIT_RESPONSE>
  <CreditReportIdentifier>XAC-3X-JOINT</CreditReportIdentifier>
  <PARTIES>
    <PARTY xlink:label="PARTY1">
      <INDIVIDUAL><NAME><FirstName>Dana</FirstName><LastName>Rivera</LastName></NAME></INDIVIDUAL>
      <TAXPAYER_IDENTIFIERS><TAXPAYER_IDENTIFIER>
        <TaxpayerIdentifierValue>111223333</TaxpayerIdentifierValue>
      </TAXPAYER_IDENTIFIER></TAXPAYER_IDENTIFIERS>
      <ROLES><ROLE><BORROWER><CREDIT_SCORES>
        <CREDIT_SCORE><CreditScoreValue>701</CreditScoreValue><CreditRepositorySourceType>Equifax</CreditRepositorySourceType></CREDIT_SCORE>
        <CREDIT_SCORE><CreditScoreValue>715</CreditScoreValue><CreditRepositorySourceType>Experian</CreditRepositorySourceType></CREDIT_SCORE>
        <CREDIT_SCORE><CreditScoreValue>709</CreditScoreValue><CreditRepositorySourceType>TransUnion</CreditRepositorySourceType></CREDIT_SCORE>
      </CREDIT_SCORES></BORROWER></ROLE></ROLES>
    </PARTY>
    <PARTY xlink:label="PARTY2">
      <INDIVIDUAL><NAME><FirstName>Alex</FirstName><LastName>Rivera</LastName></NAME></INDIVIDUAL>
      <TAXPAYER_IDENTIFIERS><TAXPAYER_IDENTIFIER>
        <TaxpayerIdentifierValue>444556666</TaxpayerIdentifierValue>
      </TAXPAYER_IDENTIFIER></TAXPAYER_IDENTIFIERS>
      <ROLES><ROLE><BORROWER><CREDIT_SCORES>
        <CREDIT_SCORE><CreditScoreValue>602</CreditScoreValue><CreditRepositorySourceType>Equifax</CreditRepositorySourceType></CREDIT_SCORE>
        <CREDIT_SCORE><CreditScoreValue>618</CreditScoreValue><CreditRepositorySourceType>Experian</CreditRepositorySourceType></CREDIT_SCORE>
      </CREDIT_SCORES></BORROWER></ROLE></ROLES>
    </PARTY>
  </PARTIES>
  <LIABILITY xlink:label="LIA1">
    <CreditLiabilityAccountType>Revolving</CreditLiabilityAccountType>
    <CreditLiabilityAccountStatusType>Open</CreditLiabilityAccountStatusType>
    <CreditLiabilityUnpaidBalanceAmount>500</CreditLiabilityUnpaidBalanceAmount>
    <CREDITOR><FullName>DISCOVER</FullName></CREDITOR>
  </LIABILITY>
  <RELATIONSHIPS>
    <RELATIONSHIP xlink:from="LIA1" xlink:to="PARTY2"/>
  </RELATIONSHIPS>
</CREDIT_RESPONSE></DEAL></MESSAGE>`;

const t = parseCreditXml(JOINT_3X);
assert.strictEqual(t.parseError, null, 'joint 3.x parses');
assert.strictEqual(t.isMerged, true, '3.x party nesting → merged report');
assert.strictEqual(t.borrowers.length, 2, 'both 3.x parties found');
assert.strictEqual(t.borrowers[0].name, 'Dana Rivera');
assert.strictEqual(t.borrowers[1].name, 'Alex Rivera');
assert.strictEqual(t.borrowers[0].ssnLast4, '3333', '3.x taxpayer id → last 4');
assert.strictEqual(t.borrowers[1].ssnLast4, '6666');
assert.strictEqual(t.borrowers[0].scores.length, 3, 'scores nested under party 1');
assert.strictEqual(t.borrowers[1].scores.length, 2, 'scores nested under party 2');
assert.strictEqual(t.borrowers[0].middleScore, 709, '3.x middle of three');
assert.strictEqual(t.borrowers[1].middleScore, 602, '3.x lower of two');
// The RELATIONSHIP arc attributes the tradeline to party 2 — and only party 2.
assert.strictEqual(t.borrowers[1].liabilities.length, 1, 'RELATIONSHIP arc attributes the tradeline');
assert.strictEqual(t.borrowers[1].liabilities[0].creditor, 'DISCOVER');
assert.strictEqual(t.borrowers[0].liabilities.length, 0, 'the other party does not get it');

// ── An UNLABELLED score on a merged file is never given to anyone ─────────────
const AMBIGUOUS = `<?xml version="1.0"?><CREDIT_RESPONSE>
  <BORROWER _ID="B1" _FirstName="Pat" _LastName="Nguyen" _SSN="123121234"/>
  <BORROWER _ID="B2" _FirstName="Robin" _LastName="Nguyen" _SSN="555443333"/>
  <CREDIT_SCORE _Value="640" CreditRepositorySourceType="Equifax"/>
  <CREDIT_SCORE _Value="700" CreditRepositorySourceType="Experian"/>
</CREDIT_RESPONSE>`;
const amb = parseCreditXml(AMBIGUOUS);
assert.strictEqual(amb.isMerged, true, 'two borrowers named → still a merged file');
assert.strictEqual(amb.borrowers[0].middleScore, null, 'an unlabelled score is NOT given to borrower 1');
assert.strictEqual(amb.borrowers[1].middleScore, null, 'an unlabelled score is NOT given to borrower 2');
assert.strictEqual(amb.mergedUnattributedScores.length, 2, 'the unattributable scores are reported, not guessed');

// ── A single-borrower report is NOT a merged one (no behaviour change) ────────
const SINGLE = `<?xml version="1.0"?><CREDIT_RESPONSE>
  <BORROWER _ID="B1" _FirstName="Dana" _LastName="Solo" _SSN="123456789"/>
  <CREDIT_SCORE _Value="712" CreditRepositorySourceType="Equifax"/>
  <CREDIT_SCORE _Value="698" CreditRepositorySourceType="Experian"/>
  <CREDIT_SCORE _Value="705" CreditRepositorySourceType="TransUnion"/>
</CREDIT_RESPONSE>`;
const one = parseCreditXml(SINGLE);
assert.strictEqual(one.isMerged, false, 'one borrower → not merged');
assert.deepStrictEqual(one.borrowers, [], 'no roster on a single-borrower report');
assert.strictEqual(one.middleScore, 705, 'single-borrower middle score unchanged');

// An empty <BORROWER> placeholder must not split a single-borrower report in two.
const PLACEHOLDER = `<?xml version="1.0"?><CREDIT_RESPONSE>
  <BORROWER _ID="B1" _FirstName="Dana" _LastName="Solo" _SSN="123456789"/>
  <BORROWER _ID="B2"/>
  <CREDIT_SCORE _Value="705" CreditRepositorySourceType="TransUnion"/>
</CREDIT_RESPONSE>`;
assert.strictEqual(parseCreditXml(PLACEHOLDER).isMerged, false, 'an empty borrower placeholder is not a second borrower');

// ── A response with no credit data says what it WAS, in its own words ────────
// A vendor error envelope answers HTTP 200 and parses fine; "no credit data
// recognized" is true but useless on its own.
const ERR_ENVELOPE = `<?xml version="1.0"?>
<RESPONSE_GROUP><RESPONSE><STATUS>
  <_Code>905</_Code>
  <_Description>Login account is not authorized for this product.</_Description>
</STATUS></RESPONSE></RESPONSE_GROUP>`;
const errDoc = parseCreditXml(ERR_ENVELOPE);
assert.strictEqual(errDoc.parseError, null, 'an error envelope still parses as XML');
assert.strictEqual(errDoc.rootTag, 'RESPONSE_GROUP', 'the document’s top element is reported');
assert.strictEqual(errDoc.documentHint, 'Login account is not authorized for this product.',
  'the vendor’s own error text is surfaced');

// An SSN echoed back in an error is masked before it is stored anywhere.
const ERR_WITH_SSN = `<?xml version="1.0"?><RESPONSE><ERROR>No file found for 123-45-6789 / 987654321</ERROR></RESPONSE>`;
const errSsn = parseCreditXml(ERR_WITH_SSN).documentHint;
assert.ok(!/123-45-6789/.test(errSsn) && !/987654321/.test(errSsn), 'SSN-shaped digits are masked in the hint');
assert.ok(/No file found/.test(errSsn), 'the useful part of the message survives');

// A REAL report never carries a hint (nothing to explain).
assert.strictEqual(j.documentHint, null, 'a report with data carries no error hint');

// ── Matching the report's borrowers to the borrowers on the FILE ─────────────
const FILE = [
  { borrowerId: 'p-1', role: 'primary', firstName: 'Jane', lastName: 'Investor', ssnLast4: '6789' },
  { borrowerId: 'c-1', role: 'co', firstName: 'Sam', lastName: 'Investor', ssnLast4: '4321' },
];
const m = matchSegments(j.borrowers, FILE);
assert.strictEqual(m.pairs.length, 2, 'both report borrowers matched to the file');
assert.strictEqual(m.unmatchedSegments.length, 0);
assert.strictEqual(m.unmatchedBorrowers.length, 0);
const pj = m.pairs.find((p) => p.borrower.borrowerId === 'p-1');
const pc = m.pairs.find((p) => p.borrower.borrowerId === 'c-1');
assert.strictEqual(pj.segment.name, 'Jane Investor', 'Jane matched to the primary');
assert.strictEqual(pc.segment.name, 'Samuel Investor', '"Samuel" matched to file "Sam" on SSN');
assert.strictEqual(pj.matchedBy, 'ssn', 'SSN is the strongest match');
assert.strictEqual(pc.verified, true, 'an SSN match is verified');

// No SSN on file → falls back to the name, still verified.
const NO_SSN = [
  { borrowerId: 'p-2', role: 'primary', firstName: 'Jane', lastName: 'Investor', ssnLast4: null },
  { borrowerId: 'c-2', role: 'co', firstName: 'Samuel', lastName: 'Investor', ssnLast4: null },
];
const m2 = matchSegments(j.borrowers, NO_SSN);
assert.strictEqual(m2.pairs.length, 2, 'matched on names when no SSN is on file');
assert.ok(m2.pairs.every((p) => p.matchedBy === 'name' && p.verified), 'full-name match is verified');

// A married/maiden-name difference: one unique last name left → matched, unverified.
const RENAMED = [
  { borrowerId: 'p-3', role: 'primary', firstName: 'Jane', lastName: 'Investor', ssnLast4: null },
  { borrowerId: 'c-3', role: 'co', firstName: 'Sam', lastName: 'Investor', ssnLast4: null },
];
const m3 = matchSegments(j.borrowers, RENAMED);
assert.strictEqual(m3.pairs.length, 2, 'Sam ↔ Samuel resolved by the unique last name');
assert.strictEqual(m3.pairs.find((p) => p.borrower.borrowerId === 'c-3').matchedBy, 'lastName');
assert.strictEqual(m3.pairs.find((p) => p.borrower.borrowerId === 'c-3').verified, false, 'a last-name-only match is NOT verified');

// A report borrower who is nobody on the file is reported, never attached.
const STRANGER = [{ borrowerId: 'p-4', role: 'primary', firstName: 'Jane', lastName: 'Investor', ssnLast4: '6789' }];
const m4 = matchSegments(j.borrowers, STRANGER);
assert.strictEqual(m4.pairs.length, 1, 'only the borrower on the file is matched');
assert.strictEqual(m4.unmatchedSegments.length, 1, 'the extra report borrower is surfaced');
assert.strictEqual(m4.unmatchedSegments[0].name, 'Samuel Investor');

// Contradicting last names with nothing else to go on → NOT paired by position.
const WRONG_PEOPLE = [
  { borrowerId: 'p-5', role: 'primary', firstName: 'Chris', lastName: 'Okafor', ssnLast4: null },
];
const m5 = matchSegments([j.borrowers[0]], WRONG_PEOPLE);
assert.strictEqual(m5.pairs.length, 0, 'a definite name contradiction is never matched by position');
assert.strictEqual(m5.unmatchedBorrowers.length, 1);

// …but a missing name on one side is no contradiction — one each left → order.
const NAMELESS = [{ borrowerId: 'p-6', role: 'primary', firstName: null, lastName: null, ssnLast4: null }];
const m6 = matchSegments([j.borrowers[0]], NAMELESS);
assert.strictEqual(m6.pairs.length, 1, 'one report borrower + one file borrower, no contradiction → matched');
assert.strictEqual(m6.pairs[0].matchedBy, 'order');
assert.strictEqual(m6.pairs[0].verified, false, 'a positional match is never treated as proof');

console.log('OK  credit-merged: joint 2.x/3.x split per borrower, joint tradelines shared, unlabelled scores never guessed, file matching by SSN → name → order — all assertions passed');
