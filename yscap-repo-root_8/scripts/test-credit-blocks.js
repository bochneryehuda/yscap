'use strict';
/* DB-free unit tests for the full-report "blocks" extraction (E1): tradelines,
 * inquiries, public records, collections, reported identity, and alerts — from
 * BOTH MISMO 2.3.1 and 3.4 — plus the alert categorizer. No network, no DB. */
const m2 = require('../src/lib/credit/mismo2-response');
const m3 = require('../src/lib/credit/mismo3-response');
const { categorizeAlert, severityOf, isComplianceOnly } = require('../src/lib/credit/alerts');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log(`FAIL - ${n}`); } };
const eq = (n, g, e) => ok(`${n} (got ${JSON.stringify(g)})`, JSON.stringify(g) === JSON.stringify(e));

// ---- alert categorizer ----
eq('cat fraud enum', categorizeAlert('FACTAFraudVictimInitial', ''), 'fraud_alert');
eq('cat active-duty enum', categorizeAlert('FACTAActiveDuty', ''), 'active_duty');
eq('cat freeze enum', categorizeAlert('CreditFileSuppressed', ''), 'security_freeze');
eq('cat deceased enum', categorizeAlert('DeathClaim', ''), 'deceased');
eq('cat addr enum', categorizeAlert('FACTAAddressDiscrepancy', ''), 'address_discrepancy');
eq('cat ofac by text', categorizeAlert('', 'Possible OFAC SDN match found'), 'ofac');
eq('cat deceased by text', categorizeAlert('', 'Subject is reported as deceased'), 'deceased');
eq('cat ssn by text', categorizeAlert('', 'SSN has not been issued by the SSA'), 'ssn_alert');
eq('cat addr by text', categorizeAlert('', 'Address discrepancy: does not match'), 'address_discrepancy');
eq('cat other default', categorizeAlert('', 'nothing notable'), 'other');
ok('fraud is fatal', severityOf('fraud_alert') === 'fatal');
ok('freeze is warning', severityOf('security_freeze') === 'warning');
ok('ofac compliance-only', isComplianceOnly('ofac') === true);
ok('deceased compliance-only', isComplianceOnly('deceased') === true);
ok('fraud not compliance-only', isComplianceOnly('fraud_alert') === false);
// FraudPoint / risk-SCORE is a WARNING, not a fatal fraud alert — even though the
// product name contains "fraud". (Regression guard for the rule-order fix.)
eq('cat fraudpoint text -> high_risk_score', categorizeAlert('', 'FraudPoint score of 850 indicates elevated risk'), 'high_risk_score');
eq('cat risk-score enum -> high_risk_score', categorizeAlert('FACTARiskScoreValue', ''), 'high_risk_score');
ok('high_risk_score is a warning', severityOf('high_risk_score') === 'warning');
// A GENUINE fraud-victim alert stays fatal (never downgraded by the risk rule).
eq('cat real fraud victim stays fraud_alert', categorizeAlert('', 'Consumer is a victim of identity theft'), 'fraud_alert');

// ---- 2.3.1 blocks ----
const XML2 = `<?xml version="1.0"?><RESPONSE_GROUP MISMOVersionID="2.3.1"><RESPONSE><RESPONSE_DATA><CREDIT_RESPONSE CreditReportIdentifier="R1" CreditReportType="Other">
  <BORROWER BorrowerID="B1" _FirstName="JANE" _LastName="DOE" _SSN="123456789" _BirthDate="1985-04-12" _UnparsedEmployment="ACME INC">
    <_RESIDENCE _StreetAddress="10 Main St" _City="New Haven" _State="CT" _PostalCode="06511"/>
    <_RESIDENCE _StreetAddress="9 Old Rd" _City="Milford" _State="CT" _PostalCode="06460"/>
    <_ALIAS _UnparsedName="JANE SMITH"/>
  </BORROWER>
  <CREDIT_SCORE BorrowerID="B1" CreditRepositorySourceType="Equifax" _ModelNameType="EquifaxBeacon5.0" _Value="732"/>
  <CREDIT_LIABILITY BorrowerID="B1" CreditRepositorySourceType="Equifax" _AccountType="Revolving" _AccountOwnershipType="Individual" _AccountStatusType="Open" _AccountIdentifier="4111111111111234" _UnpaidBalanceAmount="1500" _CreditLimitAmount="5000" _AccountOpenedDate="2019-01-01" _DerogatoryDataIndicator="N">
    <_CREDITOR _Name="CHASE CARD"/><_CURRENT_RATING _Code="C" _Type="AsAgreed"/><_LATE_COUNT _30Days="1" _60Days="0" _90Days="0"/></CREDIT_LIABILITY>
  <CREDIT_LIABILITY BorrowerID="B1" CreditRepositorySourceType="Experian" _AccountType="Collection" _AccountStatusType="Open" _UnpaidBalanceAmount="300"><_CREDITOR _Name="ABC COLLECTIONS"/></CREDIT_LIABILITY>
  <CREDIT_LIABILITY BorrowerID="B1" CreditRepositorySourceType="Equifax" _AccountType="Installment" _AccountOwnershipType="AuthorizedUser" _AccountStatusType="Open"><_CREDITOR _Name="AUTO LOAN"/></CREDIT_LIABILITY>
  <CREDIT_INQUIRY BorrowerID="B1" CreditRepositorySourceType="Equifax" _Date="2026-05-01" _Name="SOME BANK" CreditBusinessType="Mortgage"/>
  <CREDIT_PUBLIC_RECORD BorrowerID="B1" CreditRepositorySourceType="Equifax" _Type="Bankruptcy" _FiledDate="2020-02-02" _Amount="0" _CourtName="US BANKRUPTCY CT"/>
  <ALERT_MESSAGE BorrowerID="B1" _Type="FACTAFraudVictimInitial"><_Text>Initial fraud alert. Verify identity.</_Text></ALERT_MESSAGE>
</CREDIT_RESPONSE></RESPONSE_DATA><STATUS _Condition="Success" _Code="0"/></RESPONSE></RESPONSE_GROUP>`;
const p2 = m2.parseCreditResponse(XML2);
const b2 = p2.borrowers[0];
eq('2.3.1 tradeline count', b2.tradelines.length, 3);
eq('2.3.1 first creditor', b2.tradelines[0].creditorName, 'CHASE CARD');
eq('2.3.1 first balance (string)', b2.tradelines[0].unpaidBalance, '1500');
eq('2.3.1 first late30', b2.tradelines[0].late30Count, '1');
ok('2.3.1 authorized-user flagged', b2.tradelines[2].isAuthorizedUser === true);
eq('2.3.1 account identifier extracted (full — masking is import.js job)', b2.tradelines[0].accountIdentifier, '4111111111111234');
ok('2.3.1 normal tradeline not derogatory', b2.tradelines[0].derogatoryIndicator === false);
ok('2.3.1 normal tradeline not a collection', b2.tradelines[0].isCollection === false);
ok('2.3.1 collection tradeline flagged is_collection', b2.tradelines[1].isCollection === true);
eq('2.3.1 collection derived', b2.collections.length, 1);
eq('2.3.1 collection agency', b2.collections[0].collectionAgencyName, 'ABC COLLECTIONS');
eq('2.3.1 inquiry count', b2.inquiries.length, 1);
eq('2.3.1 inquiry party', b2.inquiries[0].inquiringPartyName, 'SOME BANK');
eq('2.3.1 public record count', b2.publicRecords.length, 1);
eq('2.3.1 public record type', b2.publicRecords[0].recordType, 'Bankruptcy');
eq('2.3.1 identity dob', b2.reportedIdentity.dob, '1985-04-12');
eq('2.3.1 identity current addr', b2.reportedIdentity.currentAddress, '10 Main St, New Haven, CT, 06511');
eq('2.3.1 identity former addr count', b2.reportedIdentity.formerAddresses.length, 1);
eq('2.3.1 identity aliases', b2.reportedIdentity.aliases, ['JANE SMITH']);
eq('2.3.1 identity employers', b2.reportedIdentity.employers, ['ACME INC']);
eq('2.3.1 alerts count', p2.alerts.length, 1);
eq('2.3.1 alert category', p2.alerts[0].category, 'fraud_alert');
ok('2.3.1 alert has text', /fraud alert/i.test(p2.alerts[0].text || ''));
// array-of-one: a single tradeline must not collapse to an object
const oneTL = m2.parseCreditResponse(XML2.replace(/<CREDIT_LIABILITY BorrowerID="B1" CreditRepositorySourceType="Experian"[\s\S]*?<\/CREDIT_LIABILITY>/, '').replace(/<CREDIT_LIABILITY BorrowerID="B1" CreditRepositorySourceType="Equifax" _AccountType="Installment"[\s\S]*?<\/CREDIT_LIABILITY>/, ''));
eq('2.3.1 array-of-one tradeline stays array', oneTL.borrowers[0].tradelines.length, 1);

// ---- 3.4 blocks ----
const XML3 = `<?xml version="1.0"?><MESSAGE><DEAL_SETS><DEAL_SET><DEALS><DEAL><PARTIES><PARTY SequenceNumber="1"><INDIVIDUAL><NAME><FirstName>JANE</FirstName><LastName>DOE</LastName></NAME><BIRTH><BirthDate>1985-04-12</BirthDate></BIRTH></INDIVIDUAL><TAXPAYER_IDENTIFIERS><TAXPAYER_IDENTIFIER><TaxpayerIdentifierValue>123456789</TaxpayerIdentifierValue></TAXPAYER_IDENTIFIER></TAXPAYER_IDENTIFIERS><ROLES><ROLE xlink:label="Borrower01"><ROLE_DETAIL><PartyRoleType>Borrower</PartyRoleType></ROLE_DETAIL><BORROWER><RESIDENCES><RESIDENCE><ADDRESS><AddressLineText>10 Main St</AddressLineText><CityName>New Haven</CityName><StateCode>CT</StateCode><PostalCode>06511</PostalCode></ADDRESS></RESIDENCE></RESIDENCES><EMPLOYERS><EMPLOYER><LegalEntityDetail><FullName>ACME INC</FullName></LegalEntityDetail></EMPLOYER></EMPLOYERS></BORROWER></ROLE></ROLES></PARTY></PARTIES><SERVICES><SERVICE><CREDIT><CREDIT_RESPONSE><CreditReportIdentifier>R1</CreditReportIdentifier>
  <CREDIT_LIABILITIES><CREDIT_LIABILITY><CREDIT_REPOSITORIES><CREDIT_REPOSITORY><CreditRepositorySourceType>Equifax</CreditRepositorySourceType></CREDIT_REPOSITORY></CREDIT_REPOSITORIES><CREDIT_LIABILITY_CREDITOR><FullName>CHASE CARD</FullName></CREDIT_LIABILITY_CREDITOR><CREDIT_LIABILITY_DETAIL><CreditLiabilityAccountType>Revolving</CreditLiabilityAccountType><CreditLiabilityAccountIdentifier>4111111111111234</CreditLiabilityAccountIdentifier><CreditLiabilityUnpaidBalanceAmount>1500</CreditLiabilityUnpaidBalanceAmount><CreditLiabilityAccountOpenedDate>2019-01-01</CreditLiabilityAccountOpenedDate></CREDIT_LIABILITY_DETAIL></CREDIT_LIABILITY></CREDIT_LIABILITIES>
  <CREDIT_INQUIRIES><CREDIT_INQUIRY><FullName>SOME BANK</FullName><CreditBusinessType>Mortgage</CreditBusinessType><CREDIT_INQUIRY_DETAIL><CreditInquiryDate>2026-05-01</CreditInquiryDate></CREDIT_INQUIRY_DETAIL></CREDIT_INQUIRY></CREDIT_INQUIRIES>
  <CREDIT_PUBLIC_RECORDS><CREDIT_PUBLIC_RECORD><CREDIT_REPOSITORIES><CREDIT_REPOSITORY><CreditRepositorySourceType>Experian</CreditRepositorySourceType></CREDIT_REPOSITORY></CREDIT_REPOSITORIES><CREDIT_PUBLIC_RECORD_DETAIL><CreditPublicRecordType>Judgment</CreditPublicRecordType><CreditPublicRecordFiledDate>2021-03-03</CreditPublicRecordFiledDate><CreditPublicRecordLegalObligationAmount>5000</CreditPublicRecordLegalObligationAmount></CREDIT_PUBLIC_RECORD_DETAIL></CREDIT_PUBLIC_RECORD></CREDIT_PUBLIC_RECORDS>
  <CREDIT_RESPONSE_ALERT_MESSAGES><CREDIT_RESPONSE_ALERT_MESSAGE><CreditResponseAlertMessageCategoryType>FACTAAddressDiscrepancy</CreditResponseAlertMessageCategoryType><CreditResponseAlertMessageText>Address on file differs.</CreditResponseAlertMessageText></CREDIT_RESPONSE_ALERT_MESSAGE></CREDIT_RESPONSE_ALERT_MESSAGES>
  </CREDIT_RESPONSE></CREDIT></SERVICE></SERVICES></DEAL></DEALS></DEAL_SET></DEAL_SETS></MESSAGE>`;
const p3 = m3.parseCreditResponse(XML3);
const b3 = p3.borrowers[0];
eq('3.4 tradeline count', b3.tradelines.length, 1);
eq('3.4 tradeline creditor', b3.tradelines[0].creditorName, 'CHASE CARD');
eq('3.4 tradeline balance', b3.tradelines[0].unpaidBalance, '1500');
eq('3.4 tradeline bureau', b3.tradelines[0].bureau, 'Equifax');
eq('3.4 inquiry count', b3.inquiries.length, 1);
eq('3.4 inquiry date', b3.inquiries[0].inquiryDate, '2026-05-01');
eq('3.4 public record count', b3.publicRecords.length, 1);
eq('3.4 public record type', b3.publicRecords[0].recordType, 'Judgment');
eq('3.4 public record amount', b3.publicRecords[0].amount, '5000');
eq('3.4 identity dob', b3.reportedIdentity.dob, '1985-04-12');
eq('3.4 identity addr', b3.reportedIdentity.currentAddress, '10 Main St, New Haven, CT, 06511');
eq('3.4 identity employer', b3.reportedIdentity.employers, ['ACME INC']);
eq('3.4 alerts count', p3.alerts.length, 1);
eq('3.4 alert category', p3.alerts[0].category, 'address_discrepancy');

// ---- 3.4 JOINT: two borrowers. Per E1, tradelines/inquiries/records attach to
// the PRIMARY and the report is FLAGGED unsplit (precise RELATIONSHIP-based per-
// borrower split of blocks is an E3 refinement). Identity IS split per borrower.
// This test locks in the documented behavior so a future split is a deliberate
// change, not an accident.
const XML3J = `<?xml version="1.0"?><MESSAGE><DEAL_SETS><DEAL_SET><DEALS><DEAL><PARTIES>
  <PARTY SequenceNumber="1"><INDIVIDUAL><NAME><FirstName>JANE</FirstName><LastName>DOE</LastName></NAME></INDIVIDUAL><ROLES><ROLE><ROLE_DETAIL><PartyRoleType>Borrower</PartyRoleType></ROLE_DETAIL><BORROWER><RESIDENCES><RESIDENCE><ADDRESS><AddressLineText>10 Main St</AddressLineText><CityName>New Haven</CityName><StateCode>CT</StateCode></ADDRESS></RESIDENCE></RESIDENCES></BORROWER></ROLE></ROLES></PARTY>
  <PARTY SequenceNumber="2"><INDIVIDUAL><NAME><FirstName>JOHN</FirstName><LastName>DOE</LastName></NAME></INDIVIDUAL><ROLES><ROLE><ROLE_DETAIL><PartyRoleType>Borrower</PartyRoleType></ROLE_DETAIL><BORROWER><RESIDENCES><RESIDENCE><ADDRESS><AddressLineText>22 Elm St</AddressLineText><CityName>Bridgeport</CityName><StateCode>CT</StateCode></ADDRESS></RESIDENCE></RESIDENCES></BORROWER></ROLE></ROLES></PARTY>
</PARTIES><SERVICES><SERVICE><CREDIT><CREDIT_RESPONSE><CreditReportIdentifier>RJ</CreditReportIdentifier><CREDIT_LIABILITIES>
  <CREDIT_LIABILITY><CREDIT_REPOSITORIES><CREDIT_REPOSITORY><CreditRepositorySourceType>Equifax</CreditRepositorySourceType></CREDIT_REPOSITORY></CREDIT_REPOSITORIES><CREDIT_LIABILITY_CREDITOR><FullName>CHASE CARD</FullName></CREDIT_LIABILITY_CREDITOR><CREDIT_LIABILITY_DETAIL><CreditLiabilityAccountType>Revolving</CreditLiabilityAccountType><CreditLiabilityUnpaidBalanceAmount>1500</CreditLiabilityUnpaidBalanceAmount></CREDIT_LIABILITY_DETAIL></CREDIT_LIABILITY>
  <CREDIT_LIABILITY><CREDIT_REPOSITORIES><CREDIT_REPOSITORY><CreditRepositorySourceType>Experian</CreditRepositorySourceType></CREDIT_REPOSITORY></CREDIT_REPOSITORIES><CREDIT_LIABILITY_CREDITOR><FullName>WELLS AUTO</FullName></CREDIT_LIABILITY_CREDITOR><CREDIT_LIABILITY_DETAIL><CreditLiabilityAccountType>Installment</CreditLiabilityAccountType><CreditLiabilityUnpaidBalanceAmount>9000</CreditLiabilityUnpaidBalanceAmount></CREDIT_LIABILITY_DETAIL></CREDIT_LIABILITY>
</CREDIT_LIABILITIES></CREDIT_RESPONSE></CREDIT></SERVICE></SERVICES></DEAL></DEALS></DEAL_SET></DEAL_SETS></MESSAGE>`;
const p3j = m3.parseCreditResponse(XML3J);
eq('3.4 joint: two borrowers', p3j.borrowers.length, 2);
eq('3.4 joint: both tradelines on the primary', p3j.borrowers[0].tradelines.length, 2);
eq('3.4 joint: co-borrower has no tradelines (unsplit → primary)', p3j.borrowers[1].tradelines.length, 0);
ok('3.4 joint: report flagged multiBorrowerBlocksUnsplit', p3j.multiBorrowerBlocksUnsplit === true);
// identity IS correctly per-borrower even though blocks are not
eq('3.4 joint: primary identity address', p3j.borrowers[0].reportedIdentity.currentAddress, '10 Main St, New Haven, CT');
eq('3.4 joint: co-borrower identity address', p3j.borrowers[1].reportedIdentity.currentAddress, '22 Elm St, Bridgeport, CT');

console.log(`\ncredit-blocks: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
