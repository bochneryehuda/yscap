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

// ── Two people but NOBODY's scores labelled → read whole-document, and SAY SO ──
// Splitting here would hand BOTH borrowers a blank score — strictly worse than the
// plain read. (This is the guard for the live regression of 2026-07-27: a real
// Xactus 3.4 file repeats one borrower per bureau file, and treating those repeats
// as separate people blanked a report that plainly had a 573.)
const AMBIGUOUS = `<?xml version="1.0"?><CREDIT_RESPONSE>
  <BORROWER _ID="B1" _FirstName="Pat" _LastName="Nguyen" _SSN="123121234"/>
  <BORROWER _ID="B2" _FirstName="Robin" _LastName="Nguyen" _SSN="555443333"/>
  <CREDIT_SCORE _Value="640" CreditRepositorySourceType="Equifax"/>
  <CREDIT_SCORE _Value="700" CreditRepositorySourceType="Experian"/>
</CREDIT_RESPONSE>`;
const amb = parseCreditXml(AMBIGUOUS);
assert.strictEqual(amb.isMerged, false, 'unlabelled scores → NOT split per borrower');
assert.strictEqual(amb.mergedAmbiguous, true, '…but the file is flagged as naming several people');
assert.deepStrictEqual(amb.mergedBorrowerNames, ['Pat Nguyen', 'Robin Nguyen'], 'and it names them');
assert.strictEqual(amb.middleScore, 640, 'the whole-document score still reads (lower of two) — never blanked');
assert.deepStrictEqual(amb.borrowers, [], 'no per-borrower roster is offered when it cannot be trusted');

// ── ONE person written several ways is ONE borrower, not a merged report ──────
// A real MISMO 3.4 file repeats the borrower once per bureau file (and again at the
// deal level), sometimes with the name reversed. The scores sit at the document
// level, so reading those repeats as separate people attributed the scores to
// NOBODY and blanked the report's middle score (live regression, 2026-07-27).
const REPEATED = `<?xml version="1.0"?>
<MESSAGE xmlns:xlink="http://www.w3.org/1999/xlink"><CREDIT_RESPONSE>
  <CREDIT_FILES>
    <CREDIT_FILE><PARTY xlink:label="F1">
      <INDIVIDUAL><NAME><FirstName>PATRICK</FirstName><LastName>KAMARA</LastName></NAME></INDIVIDUAL>
      <TAXPAYER_IDENTIFIERS><TAXPAYER_IDENTIFIER><TaxpayerIdentifierValue>111228028</TaxpayerIdentifierValue></TAXPAYER_IDENTIFIER></TAXPAYER_IDENTIFIERS>
      <ROLES><ROLE><BORROWER/></ROLE></ROLES>
    </PARTY></CREDIT_FILE>
    <CREDIT_FILE><PARTY xlink:label="F2">
      <INDIVIDUAL><NAME><FirstName>KAMARA</FirstName><LastName>PATRICK</LastName></NAME></INDIVIDUAL>
      <TAXPAYER_IDENTIFIERS><TAXPAYER_IDENTIFIER><TaxpayerIdentifierValue>111228028</TaxpayerIdentifierValue></TAXPAYER_IDENTIFIER></TAXPAYER_IDENTIFIERS>
      <ROLES><ROLE><BORROWER/></ROLE></ROLES>
    </PARTY></CREDIT_FILE>
    <CREDIT_FILE><PARTY xlink:label="F3">
      <INDIVIDUAL><NAME><FirstName>PATRICK</FirstName><LastName>KAMARA</LastName></NAME></INDIVIDUAL>
      <ROLES><ROLE><BORROWER/></ROLE></ROLES>
    </PARTY></CREDIT_FILE>
  </CREDIT_FILES>
  <PARTIES><PARTY xlink:label="P1">
    <INDIVIDUAL><NAME><FirstName>PATRICK</FirstName><LastName>KAMARA</LastName></NAME></INDIVIDUAL>
    <TAXPAYER_IDENTIFIERS><TAXPAYER_IDENTIFIER><TaxpayerIdentifierValue>111228028</TaxpayerIdentifierValue></TAXPAYER_IDENTIFIER></TAXPAYER_IDENTIFIERS>
    <ROLES><ROLE><BORROWER/></ROLE></ROLES>
  </PARTY></PARTIES>
  <CREDIT_SCORES>
    <CREDIT_SCORE><CREDIT_SCORE_DETAIL>
      <CreditRepositorySourceType>TransUnion</CreditRepositorySourceType><CreditScoreValue>576</CreditScoreValue>
    </CREDIT_SCORE_DETAIL></CREDIT_SCORE>
    <CREDIT_SCORE><CREDIT_SCORE_DETAIL>
      <CreditRepositorySourceType>Equifax</CreditRepositorySourceType><CreditScoreValue>573</CreditScoreValue>
    </CREDIT_SCORE_DETAIL></CREDIT_SCORE>
    <CREDIT_SCORE><CREDIT_SCORE_DETAIL>
      <CreditRepositorySourceType>Experian</CreditRepositorySourceType><CreditScoreValue>561</CreditScoreValue>
    </CREDIT_SCORE_DETAIL></CREDIT_SCORE>
  </CREDIT_SCORES>
</CREDIT_RESPONSE></MESSAGE>`;
const rep = parseCreditXml(REPEATED);
assert.strictEqual(rep.isMerged, false, 'four records of ONE person is not a merged report');
assert.strictEqual(rep.mergedAmbiguous, false, 'and it is not ambiguous either — there is one borrower');
assert.strictEqual(rep.middleScore, 573, 'the middle score reads normally (576/573/561 → 573)');
assert.strictEqual(rep.scores.length, 3, 'all three bureau scores are kept');
assert.strictEqual(rep.borrower.firstName, 'PATRICK', 'the identity comes off the deal-level party (MISMO 3.x)');
assert.strictEqual(rep.borrower.ssnLast4, '8028', 'including the SSN last-4 that verifies the FICO write-back');

// The same de-duplication must NOT collapse two genuinely different people who
// happen to share a surname.
const TWO_REAL = REPEATED
  .replace('<FirstName>KAMARA</FirstName><LastName>PATRICK</LastName>', '<FirstName>DENISE</FirstName><LastName>KAMARA</LastName>')
  .replace(/<TaxpayerIdentifierValue>111228028<\/TaxpayerIdentifierValue>\s*<\/TAXPAYER_IDENTIFIER><\/TAXPAYER_IDENTIFIERS>\s*<ROLES><ROLE><BORROWER\/><\/ROLE><\/ROLES>\s*<\/PARTY><\/CREDIT_FILE>\s*<CREDIT_FILE><PARTY xlink:label="F3">/,
    '<TaxpayerIdentifierValue>999887777</TaxpayerIdentifierValue></TAXPAYER_IDENTIFIER></TAXPAYER_IDENTIFIERS><ROLES><ROLE><BORROWER/></ROLE></ROLES></PARTY></CREDIT_FILE><CREDIT_FILE><PARTY xlink:label="F3">');
const two = parseCreditXml(TWO_REAL);
assert.strictEqual(two.mergedAmbiguous, true, 'two DIFFERENT people (different SSNs) are still recognised as two');
assert.strictEqual(two.middleScore, 573, '…and their unlabelled scores still read whole-document, never blanked');

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


// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION — the REAL MISMO 3.4 layout (owner-reported 2026-08-21).
//
// Xactus is ordered at MISMO 3.4 (src/lib/credit/provider.js defaults the interface
// version to '3.4'). In 3.4 the borrower PARTIES and the RELATIONSHIP arcs that bind
// a score to a person live at DEAL level — OUTSIDE <CREDIT_RESPONSE>. The parser used
// to scope segmentation to the CREDIT_RESPONSE subtree, so on a real joint 3.4 report
// it found ZERO borrowers, never split the document, and fell back to the flat
// per-bureau de-dupe: "first score per bureau wins" across TWO people. Both borrowers
// were then stored with the SAME whole-document middle score.
//
// Live numbers from the reported file (YSCAP258134859, ref 93123672):
//   Mordechai Scharf  TU 685 · XP 704 · EF 674  → middle 685
//   Michelle Bleier   TU 719 · XP 680 · EF 732  → middle 719
// PILOT showed 719 for BOTH. The fixture below reproduces that exactly; note the
// co-borrower's scores are listed FIRST, which is what made 719 the surviving number.
// ─────────────────────────────────────────────────────────────────────────────
const mkScore = (label, repo, value) => `
  <CREDIT_SCORE xlink:label="${label}"><CREDIT_SCORE_DETAIL>
    <CreditRepositorySourceType>${repo}</CreditRepositorySourceType>
    <CreditScoreValue>${value}</CreditScoreValue>
  </CREDIT_SCORE_DETAIL></CREDIT_SCORE>`;
const mkDealParty = (label, first, last, ssn) => `
  <PARTY xlink:label="${label}">
    <INDIVIDUAL><NAME><FirstName>${first}</FirstName><LastName>${last}</LastName></NAME></INDIVIDUAL>
    <ROLES><ROLE><BORROWER><BORROWER_DETAIL/></BORROWER>
      <ROLE_DETAIL><PartyRoleType>Borrower</PartyRoleType></ROLE_DETAIL></ROLE></ROLES>
    <TAXPAYER_IDENTIFIERS><TAXPAYER_IDENTIFIER>
      <TaxpayerIdentifierValue>${ssn}</TaxpayerIdentifierValue>
    </TAXPAYER_IDENTIFIER></TAXPAYER_IDENTIFIERS>
  </PARTY>`;
// One bureau's own copy of a person: that bureau's spelling of the name, no SSN.
const mkFileParty = (label, first, last) => `
  <CREDIT_FILE xlink:label="${label}_FILE"><PARTY xlink:label="${label}">
    <INDIVIDUAL><NAME><FirstName>${first}</FirstName><LastName>${last}</LastName></NAME></INDIVIDUAL>
    <ROLES><ROLE><BORROWER/></ROLE></ROLES>
  </PARTY></CREDIT_FILE>`;

const REAL_34 = `<?xml version="1.0" encoding="utf-8"?>
<MESSAGE xmlns:xlink="http://www.w3.org/1999/xlink" MISMOReferenceModelIdentifier="3.4">
 <DEAL_SETS><DEAL_SET><DEALS><DEAL>
  <PARTIES>
${mkDealParty('PARTY_B1', 'MORDECHAI', 'SCHARF', '052925287')}
${mkDealParty('PARTY_C1', 'MICHELLE', 'BLEIER', '057926929')}
  </PARTIES>
  <SERVICES><SERVICE><CREDIT>
   <CREDIT_RESPONSE>
    <CREDIT_RESPONSE_DETAIL>
      <CreditReportIdentifier>93123672</CreditReportIdentifier>
      <CreditReportFirstIssuedDate>2026-08-20</CreditReportFirstIssuedDate>
    </CREDIT_RESPONSE_DETAIL>
    <CREDIT_FILES>
${mkFileParty('TUC_C1', 'MICHELLE', 'BLEIER')}
${mkFileParty('EXP_C1', 'MICHELLE', 'BLEIER')}
${mkFileParty('EQX_C1', 'MICHELLE', 'KATZ')}
${mkFileParty('TUC_B1', 'MORDECHAI', 'SCHARF')}
    </CREDIT_FILES>
    <CREDIT_SCORES>
${mkScore('S_C1_TU', 'TransUnion', 719)}
${mkScore('S_C1_XP', 'Experian', 680)}
${mkScore('S_C1_EF', 'Equifax', 732)}
${mkScore('S_B1_TU', 'TransUnion', 685)}
${mkScore('S_B1_XP', 'Experian', 704)}
${mkScore('S_B1_EF', 'Equifax', 674)}
    </CREDIT_SCORES>
   </CREDIT_RESPONSE>
  </CREDIT></SERVICE></SERVICES>
  <RELATIONSHIPS>
    <RELATIONSHIP xlink:from="PARTY_B1" xlink:to="S_B1_TU"/>
    <RELATIONSHIP xlink:from="PARTY_B1" xlink:to="S_B1_XP"/>
    <RELATIONSHIP xlink:from="PARTY_B1" xlink:to="S_B1_EF"/>
    <RELATIONSHIP xlink:from="PARTY_C1" xlink:to="S_C1_TU"/>
    <RELATIONSHIP xlink:from="PARTY_C1" xlink:to="S_C1_XP"/>
    <RELATIONSHIP xlink:from="PARTY_C1" xlink:to="S_C1_EF"/>
  </RELATIONSHIPS>
 </DEAL></DEALS></DEAL_SET></DEAL_SETS>
</MESSAGE>`;

const r34 = parseCreditXml(REAL_34);
assert.strictEqual(r34.parseError, null, 'the real 3.4 layout parses');
assert.strictEqual(r34.isMerged, true, 'DEAL-level parties are found — the joint split runs');
assert.strictEqual(r34.mergedAmbiguous, false, 'the RELATIONSHIP arcs say whose scores are whose');
// The alias surname on one bureau file is the SAME co-borrower, not a third person.
assert.strictEqual(r34.borrowers.length, 2, 'two people on the report — "Michelle Katz" is not a third');
assert.ok(!r34.borrowers.some((b) => /katz/i.test(b.name || '')), 'no phantom alias borrower on the roster');

const scharf = r34.borrowers.find((b) => /scharf/i.test(b.name));
const bleier = r34.borrowers.find((b) => /bleier/i.test(b.name));
assert.ok(scharf && bleier, 'both borrowers are named');
assert.strictEqual(scharf.middleScore, 685, 'Mordechai middle = 685 (685/704/674) — was wrongly 719');
assert.strictEqual(bleier.middleScore, 719, 'Michelle middle = 719 (719/680/732)');
assert.notStrictEqual(scharf.middleScore, bleier.middleScore,
  'the two borrowers must NOT share one number — that was the whole bug');
assert.deepStrictEqual(scharf.scores.map((s) => s.value).sort((a, b) => a - b), [674, 685, 704]);
assert.deepStrictEqual(bleier.scores.map((s) => s.value).sort((a, b) => a - b), [680, 719, 732]);
assert.strictEqual(scharf.ssnLast4, '5287', 'the SSN that verifies the FICO write-back is read from the 3.4 party');
assert.strictEqual(bleier.ssnLast4, '6929');
assert.strictEqual(r34.reportId, '93123672', 'the response header still reads from the CREDIT_RESPONSE');
assert.strictEqual(r34.reportDate, '2026-08-20');

// The file's own borrowers match their segments by SSN — the higher middle (719)
// prices the deal, and Mordechai keeps HIS 685.
const mReal = matchSegments(r34.borrowers, [
  { borrowerId: 'b-real', role: 'primary', firstName: 'Mordechai', lastName: 'Scharf', ssnLast4: '5287' },
  { borrowerId: 'c-real', role: 'co', firstName: 'Michelle', lastName: 'Bleier', ssnLast4: '6929' },
]);
assert.strictEqual(mReal.pairs.length, 2, 'both file borrowers matched');
assert.ok(mReal.pairs.every((x) => x.matchedBy === 'ssn' && x.verified), 'matched by SSN — proof, not a guess');
const forPrimary = mReal.pairs.find((x) => x.borrower.borrowerId === 'b-real');
assert.strictEqual(forPrimary.segment.middleScore, 685, 'the primary is stored with 685, not the co-borrower’s 719');
assert.strictEqual(sliceForSegment(r34, forPrimary.segment).middleScore, 685, 'and the stored slice agrees');

// A vendor that returns ONE <CREDIT_RESPONSE> PER BORROWER must not lose the second.
const TWO_RESPONSES = `<?xml version="1.0"?>
<MESSAGE xmlns:xlink="http://www.w3.org/1999/xlink"><DEAL>
  <PARTIES>
${mkDealParty('P_A', 'AVI', 'GOLD', '111223333')}
${mkDealParty('P_B', 'RUTH', 'GOLD', '444556666')}
  </PARTIES>
  <SERVICES>
   <SERVICE><CREDIT><CREDIT_RESPONSE><CREDIT_SCORES>
${mkScore('SA1', 'TransUnion', 700)}${mkScore('SA2', 'Experian', 710)}${mkScore('SA3', 'Equifax', 690)}
   </CREDIT_SCORES></CREDIT_RESPONSE></CREDIT></SERVICE>
   <SERVICE><CREDIT><CREDIT_RESPONSE><CREDIT_SCORES>
${mkScore('SB1', 'TransUnion', 640)}${mkScore('SB2', 'Experian', 660)}${mkScore('SB3', 'Equifax', 650)}
   </CREDIT_SCORES></CREDIT_RESPONSE></CREDIT></SERVICE>
  </SERVICES>
  <RELATIONSHIPS>
    <RELATIONSHIP xlink:from="P_A" xlink:to="SA1"/><RELATIONSHIP xlink:from="P_A" xlink:to="SA2"/>
    <RELATIONSHIP xlink:from="P_A" xlink:to="SA3"/>
    <RELATIONSHIP xlink:from="P_B" xlink:to="SB1"/><RELATIONSHIP xlink:from="P_B" xlink:to="SB2"/>
    <RELATIONSHIP xlink:from="P_B" xlink:to="SB3"/>
  </RELATIONSHIPS>
</DEAL></MESSAGE>`;
const two34 = parseCreditXml(TWO_RESPONSES);
assert.strictEqual(two34.borrowers.length, 2, 'both borrowers found across two credit responses');
assert.strictEqual(two34.borrowers.find((b) => b.firstName === 'AVI').middleScore, 700);
assert.strictEqual(two34.borrowers.find((b) => b.firstName === 'RUTH').middleScore, 650,
  'the SECOND <CREDIT_RESPONSE> is read too — reading only the first dropped this borrower entirely');


console.log('OK  credit-merged: joint 2.x/3.x split per borrower, the REAL MISMO 3.4 layout (deal-level parties + arcs) split per borrower, alias surnames folded, several credit responses read, joint tradelines shared, unlabelled scores never guessed, file matching by SSN → name → order — all assertions passed');
