'use strict';
/**
 * Pure unit test for the credit-report XML parser (no DB, no network).
 * Feeds a realistic tri-merge MISMO 2.x CREDIT_RESPONSE and asserts every
 * section is extracted and the representative (middle) score is computed.
 * Run: node scripts/test-credit-parse.js
 */
const assert = require('assert');
const { parseCreditXml, _internal } = require('../src/lib/credit/parse');

// --- date + bureau helpers -----------------------------------------------------
assert.strictEqual(_internal.isoDate('05/17/2024'), '2024-05-17', 'US date → ISO');
assert.strictEqual(_internal.isoDate('2024-05-17'), '2024-05-17', 'ISO passthrough');
assert.strictEqual(_internal.isoDate('20240517'), '2024-05-17', 'compact date → ISO');
assert.strictEqual(_internal.isoDate(''), null, 'empty date → null');
assert.strictEqual(_internal.bureau('Equifax'), 'Equifax');
assert.strictEqual(_internal.bureau('EquifaxBeacon5.0'), 'Equifax');
assert.strictEqual(_internal.bureau('TransUnion FICO Risk'), 'TransUnion');
assert.strictEqual(_internal.bureau('XPN'), 'Experian');
assert.strictEqual(_internal.num('$1,250.00'), 1250, 'money → number');

// representative score: middle of 3, lower of 2, single
assert.strictEqual(_internal.representative([{ value: 720 }, { value: 690 }, { value: 705 }]), 705, 'middle of 3');
assert.strictEqual(_internal.representative([{ value: 720 }, { value: 690 }]), 690, 'lower of 2');
assert.strictEqual(_internal.representative([{ value: 700 }]), 700, 'single');
assert.strictEqual(_internal.representative([]), null, 'none');

// --- full document -------------------------------------------------------------
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<RESPONSE_GROUP MISMOVersionID="2.4">
 <RESPONSE>
  <RESPONSE_DATA>
   <CREDIT_RESPONSE CreditReportIdentifier="XAC-99887" CreditReportFirstIssuedDate="2026-07-20" CreditRatingCodeType="TriMerge">
    <CREDIT_REPOSITORY_INCLUDED _EquifaxIndicator="Y" _ExperianIndicator="Y" _TransUnionIndicator="Y"/>
    <BORROWER _FirstName="Jane" _MiddleName="Q" _LastName="Investor" _SSN="123456789" _PrintPositionType="Borrower" BorrowerID="B1">
      <_RESIDENCE _StreetAddress="12 Maple Ave" _City="Lakewood" _State="NJ" _PostalCode="08701"/>
      <_EMPLOYER _Name="Acme Holdings LLC"/>
    </BORROWER>
    <CREDIT_SCORE _Value="720" _ModelNameType="EquifaxBeacon5.0" CreditRepositorySourceType="Equifax" _BorrowerID="B1">
      <_FACTOR _Code="10" _Text="Proportion of balances to credit limits is too high"/>
    </CREDIT_SCORE>
    <CREDIT_SCORE _Value="690" _ModelNameType="ExperianFairIsaacV2" CreditRepositorySourceType="Experian" _BorrowerID="B1"/>
    <CREDIT_SCORE _Value="705" _ModelNameType="TransUnionFICOClassic04" CreditRepositorySourceType="TransUnion" _BorrowerID="B1"/>
    <CREDIT_LIABILITY CreditLiabilityAccountType="Revolving" _AccountStatusType="Open"
        _UnpaidBalanceAmount="1200" CreditLimitAmount="5000" _MonthlyPaymentAmount="35"
        _PastDueAmount="0" _AccountOpenedDate="2019-03-01" _AccountReportedDate="2026-07-01"
        _AccountIdentifier="****1234">
      <_CREDITOR _Name="CHASE CARD"/>
      <_CURRENT_RATING _Type="AsAgreed" _Code="1"/>
      <_LATE_COUNT _30Days="0" _60Days="0" _90Days="0"/>
      <CREDIT_REPOSITORY _SourceType="Equifax"/>
      <CREDIT_REPOSITORY _SourceType="Experian"/>
    </CREDIT_LIABILITY>
    <CREDIT_LIABILITY CreditLiabilityAccountType="Installment" _AccountStatusType="Open"
        _UnpaidBalanceAmount="18000" _HighCreditAmount="25000" _MonthlyPaymentAmount="410"
        _PastDueAmount="410" _AccountOpenedDate="2022-06-15" _AccountReportedDate="2026-06-20">
      <_CREDITOR _Name="TOYOTA FINANCIAL"/>
      <_LATE_COUNT _30Days="1" _60Days="0" _90Days="0"/>
      <CREDIT_REPOSITORY _SourceType="TransUnion"/>
    </CREDIT_LIABILITY>
    <CREDIT_LIABILITY CreditLiabilityAccountType="Collection" _AccountStatusType="Open"
        _UnpaidBalanceAmount="640">
      <_CREDITOR _Name="MIDLAND CREDIT"/>
      <CREDIT_REPOSITORY _SourceType="Experian"/>
    </CREDIT_LIABILITY>
    <CREDIT_INQUIRY _Name="CAPITAL ONE" _Date="2026-05-02">
      <CREDIT_REPOSITORY _SourceType="Experian"/>
    </CREDIT_INQUIRY>
    <CREDIT_PUBLIC_RECORD _Type="Bankruptcy" _FiledDate="2018-01-10" _Amount="0" _DispositionType="Discharged"/>
   </CREDIT_RESPONSE>
  </RESPONSE_DATA>
 </RESPONSE>
</RESPONSE_GROUP>`;

const r = parseCreditXml(XML);
assert.strictEqual(r.parseError, null, 'no parse error');
assert.strictEqual(r.reportId, 'XAC-99887', 'report id');
assert.strictEqual(r.reportDate, '2026-07-20', 'report date');

// scores
assert.strictEqual(r.scores.length, 3, 'three scores');
const efx = r.scores.find((s) => s.bureau === 'Equifax');
assert.strictEqual(efx.value, 720, 'equifax value');
assert.strictEqual(efx.factors.length, 1, 'equifax has a reason code');
assert.strictEqual(r.middleScore, 705, 'representative = middle of 720/690/705');
assert.deepStrictEqual(r.bureausReturned.sort(), ['Equifax', 'Experian', 'TransUnion'], 'all three bureaus');

// borrower
assert.strictEqual(r.borrower.firstName, 'Jane');
assert.strictEqual(r.borrower.lastName, 'Investor');
assert.strictEqual(r.borrower.ssnLast4, '6789', 'ssn last 4');
assert.strictEqual(r.borrower.addresses[0].city, 'Lakewood');
assert.strictEqual(r.borrower.employers[0], 'Acme Holdings LLC');

// liabilities
assert.strictEqual(r.liabilities.length, 3, 'three tradelines');
const chase = r.liabilities.find((l) => l.creditor === 'CHASE CARD');
assert.strictEqual(chase.balance, 1200);
assert.strictEqual(chase.creditLimit, 5000);
assert.strictEqual(chase.monthlyPayment, 35);
assert.strictEqual(chase.open, true);
assert.deepStrictEqual(chase.bureaus.sort(), ['Equifax', 'Experian']);
const toyota = r.liabilities.find((l) => l.creditor === 'TOYOTA FINANCIAL');
assert.strictEqual(toyota.late30, 1, 'one 30-day late');
assert.strictEqual(toyota.pastDue, 410);
const coll = r.liabilities.find((l) => l.isCollection);
assert.strictEqual(coll.creditor, 'MIDLAND CREDIT', 'collection detected');

// inquiries + public records
assert.strictEqual(r.inquiries.length, 1);
assert.strictEqual(r.inquiries[0].name, 'CAPITAL ONE');
assert.strictEqual(r.inquiries[0].date, '2026-05-02');
assert.strictEqual(r.publicRecords.length, 1);
assert.strictEqual(r.publicRecords[0].type, 'Bankruptcy');
assert.strictEqual(r.publicRecords[0].status, 'Discharged');

// summary
assert.strictEqual(r.summary.tradelineCount, 3);
assert.strictEqual(r.summary.openCount, 3);
assert.strictEqual(r.summary.totalBalance, 1200 + 18000 + 640);
assert.strictEqual(r.summary.totalMonthlyPayments, 35 + 410);
assert.strictEqual(r.summary.collectionCount, 1);
assert.strictEqual(r.summary.publicRecordCount, 1);
assert.strictEqual(r.summary.delinquentCount, 1, 'toyota is delinquent (past due + 30-day)');

// --- MISMO 3.x child-element variant parses too --------------------------------
const XML3 = `<?xml version="1.0"?>
<MESSAGE><DEAL><CREDIT_RESPONSE>
  <CreditReportIdentifier>XAC-3X-1</CreditReportIdentifier>
  <CREDIT_SCORE>
    <CreditScoreValue>683</CreditScoreValue>
    <CreditRepositorySourceType>Equifax</CreditRepositorySourceType>
    <CreditScoreModelNameType>EquifaxBeacon5.0</CreditScoreModelNameType>
  </CREDIT_SCORE>
  <LIABILITY>
    <CreditLiabilityAccountType>Revolving</CreditLiabilityAccountType>
    <CreditLiabilityAccountStatusType>Open</CreditLiabilityAccountStatusType>
    <CreditLiabilityUnpaidBalanceAmount>500</CreditLiabilityUnpaidBalanceAmount>
    <CREDITOR><FullName>DISCOVER</FullName></CREDITOR>
  </LIABILITY>
</CREDIT_RESPONSE></DEAL></MESSAGE>`;
const r3 = parseCreditXml(XML3);
assert.strictEqual(r3.parseError, null, '3.x no error');
assert.strictEqual(r3.reportId, 'XAC-3X-1', '3.x report id (child element)');
assert.strictEqual(r3.scores.length, 1, '3.x score parsed');
assert.strictEqual(r3.scores[0].value, 683, '3.x score value from child element');
assert.strictEqual(r3.middleScore, 683);
assert.strictEqual(r3.liabilities[0].creditor, 'DISCOVER', '3.x creditor from child element');
assert.strictEqual(r3.liabilities[0].balance, 500);

// --- malformed input degrades, never throws -----------------------------------
const bad = parseCreditXml('<CREDIT_RESPONSE><oops');
assert.ok(bad.parseError, 'malformed sets parseError');
assert.strictEqual(bad.scores.length, 0, 'malformed yields empty, no throw');
assert.strictEqual(parseCreditXml('').parseError, 'empty document');

// --- reject / no-hit codes (0, 9001-9004) are NOT scores -----------------------
// They must never land in the 300-850-CHECKed middle_score column.
const REJECT = `<?xml version="1.0"?><CREDIT_RESPONSE>
  <CREDIT_SCORE _Value="9002" CreditRepositorySourceType="Equifax"/>
  <CREDIT_SCORE _Value="0" CreditRepositorySourceType="Experian"/>
  <CREDIT_SCORE _Value="705" CreditRepositorySourceType="TransUnion"/>
</CREDIT_RESPONSE>`;
const rr = parseCreditXml(REJECT);
assert.strictEqual(rr.scores.length, 1, 'reject/no-hit codes dropped, only the real score kept');
assert.strictEqual(rr.scores[0].value, 705);
assert.strictEqual(rr.middleScore, 705, 'middle score ignores reject codes');
assert.deepStrictEqual(rr.bureausReturned, ['TransUnion'], 'only the scored bureau counts');

const NOHIT = `<?xml version="1.0"?><CREDIT_RESPONSE>
  <CREDIT_SCORE _Value="0" CreditRepositorySourceType="Equifax"/>
  <CREDIT_SCORE _Value="9001" CreditRepositorySourceType="Experian"/>
</CREDIT_RESPONSE>`;
const rn = parseCreditXml(NOHIT);
assert.strictEqual(rn.scores.length, 0, 'all reject codes → no scores');
assert.strictEqual(rn.middleScore, null, 'all-no-hit → middle score null (safe for the DB column)');

console.log('OK  credit-parse: MISMO 2.x + 3.x extraction, middle-score, summary, malformed-safe — all assertions passed');
