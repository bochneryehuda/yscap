# Xactus MISMO 2.3.1 Credit — Field-by-Field Mapping Reference (2026-07-19)

_Research/reference only — nothing implemented. Companion to `CREDIT-REPORT-REISSUE-RESEARCH.md`
(vendor/version) and `CREDIT-REPORT-REISSUE-DESIGN.md` (architecture). Sourced from Xactus's live
OpenAPI bundle `CreditReport_MISMO2.yaml` (`Credit API - MISMO 2.X`, v1.0.0) + its worked
request/response examples, cross-checked against the developer-portal pages. **No live PII/credentials
here.**_

**Transport.** HTTPS POST, `Content-Type: text/xml`, HTTP Basic (credentials as
`LoginAccountIdentifier` / `LoginAccountPassword`; surrogate ordering uses `generic:individual` colon
syntax). Endpoints: `POST /credit_report` (Credit ReportX), **`POST /pre_qualification`
(Pre-QualificationX — our soft pull)**, `/mortgage_only`, `/refresh_report`.

**Everything is an XML attribute (string).** `format: integer` → numeric string; `format: date` →
`YYYY-MM-DD`; `date-time` → `YYYY-MM-DDThh:mm:ss`. **Parse the XML tolerantly** — the JSON schema
marks many fields `required` that arrive empty in practice (e.g. `_MiddleName=""`), so validate on
presence/shape, not the strict OpenAPI `required` arrays.

> ✅ **Soft-pull confirmation:** the Pre-Qualification (`SoftCheck`) response returns the **full
> tri-merge** scores (Beacon 5.0 / Experian-FairIsaac / FICO Classic 04) **and** the embedded PDF —
> structurally identical to a hard `Merge`. So the soft-pull-only approach still gives us all three
> bureau scores + the PDF.

---

## 1. Request — `REQUEST_GROUP`

Wrapper: `REQUEST_GROUP → REQUESTING_PARTY, SUBMITTING_PARTY, REQUEST → REQUEST_DATA → CREDIT_REQUEST → (CREDIT_REQUEST_DATA, SERVICE_PAYMENT, LOAN_APPLICATION)`.

| Path / Attribute | Type / Values | Req? | Notes |
|---|---|---|---|
| `REQUEST_GROUP@MISMOVersionID` | `"2.3.1"` | ✔ | Root version |
| `REQUESTING_PARTY@_Name` | string | ✔ | The ordering entity (your company) |
| `SUBMITTING_PARTY@_Name` | string | ✔ | Software/platform — **"YS Capital Group LOS"** |
| `RECEIVING_PARTY@_Name` | string | – | "Xactus, LLC" |
| `REQUEST@RequestDatetime` | date-time | ✔ | ISO 8601 |
| `CREDIT_REQUEST@MISMOVersionID` | `"2.3.1"` | ✔ | |
| `CREDIT_REQUEST@LenderCaseIdentifier` | string ≤40 | ✔ | Our loan number; **echoed back** |
| `CREDIT_REQUEST_DATA@CreditRequestID` | string | ✔ | Our correlation id |
| `…@BorrowerID` | string | ✔ | `"B1"`; joint = space-separated `"B1 C1"` |
| `…@CreditReportRequestActionType` | **Submit / ForceNew / Reissue / Upgrade / Unmerge** | ✔ | Submit auto-reissues if name+addr+SSN match a report ≤30 days old; ForceNew forces fresh pulls; Reissue/Upgrade/Unmerge require `CreditReportIdentifier` |
| `…@CreditReportType` | **Merge** (tri-merge) / **Other** | ✔ | **Soft pull → `Other`** |
| `…@CreditReportTypeOtherDescription` | **SoftCheck** / Streamline / Refresh | cond | Required when Type=Other; **`SoftCheck` = Pre-Qualification** |
| `…@CreditRequestType` | **Individual / Joint** | ✔ | |
| `…@CreditReportIdentifier` | integer-string | cond | Required for Reissue/Upgrade/Unmerge/Refresh |
| `CREDIT_REPOSITORY_INCLUDED@_EquifaxIndicator / _ExperianIndicator / _TransUnionIndicator` | `"Y"/"N"` | ✔ (all 3) | Which bureaus to pull |
| `LOAN_APPLICATION/BORROWER@BorrowerID` | string | ✔ | `"B1"`, `"C1"` |
| `BORROWER@_FirstName / _LastName` | string | ✔ | |
| `BORROWER@_MiddleName / _NameSuffix` | string | ✔* | Schema-required but often empty (`_MiddleName=""`) |
| `BORROWER@_SSN` | 9-digit / `XXX-XX-XXXX` (ITIN ok) | ✔ | |
| `BORROWER@_BirthDate` | date | – | |
| `_RESIDENCE@_StreetAddress / _City / _State / _PostalCode` | string | ✔ (all) | State supports military codes |
| `_RESIDENCE@BorrowerResidencyType` | **Current / Prior** | ✔ | |
| `SERVICE_PAYMENT@…` | card fields | POS only | Consumer-pay/point-of-sale only; **omit for lender-billed** |

**Soft-pull request skeleton (illustrative):** `CreditReportType="Other"`,
`CreditReportTypeOtherDescription="SoftCheck"`, `CreditReportRequestActionType="Submit"` (or
`Reissue` + `CreditReportIdentifier`), all three repository indicators `"Y"`.

---

## 2. Response envelope — `RESPONSE_GROUP`

Wrapper: `RESPONSE_GROUP → RESPONDING_PARTY, RESPOND_TO_PARTY, RESPONSE → (KEY*, RESPONSE_DATA → CREDIT_RESPONSE)`.

| Path / Attribute | Type / Values | Notes |
|---|---|---|
| `RESPONSE_GROUP@MISMOVersionID` | `"2.3.1"` | |
| `RESPONDING_PARTY@_Name/_StreetAddress/_City/_State/_PostalCode` + `CONTACT_DETAIL/CONTACT_POINT@_Type(Phone\|Fax)/_Value` | Xactus identity | Source bureau of record |
| `RESPOND_TO_PARTY@_Name…` + `CONTACT_DETAIL@_Name` | echo of ordering operator | |
| `RESPONSE@ResponseDateTime` | date-time | |
| `RESPONSE/KEY@_Name/_Value` | name-value pairs | Score-range dictionary — see below |
| `CREDIT_RESPONSE@CreditReportIdentifier` | integer-string | **PRIMARY KEY** — persist; needed for Reissue/Refresh/Upgrade |
| `…@CreditResponseID` | string | e.g. `"CR1202696"` |
| `…@CreditReportFirstIssuedDate / CreditReportLastUpdatedDate` | date | **`FirstIssuedDate` drives the 120-day reopen** (research §retention) |
| `…@CreditReportMergeType` | e.g. `PickAndChoose` | |
| `…@CreditReportType` | Merge / **Other** | Soft pull → Other + `CreditReportTypeOtherDescription="SoftCheck"` |
| `…@CreditRatingCodeType` | Equifax/Experian/TransUnion | |
| `CREDIT_BUREAU@…` | Xactus name/address/contact | |
| `CREDIT_REPORT_PRICE@_Amount/_Type` | e.g. `"19.21" / "Total"` | Store for cost reconciliation |
| `CREDIT_REPOSITORY_INCLUDED@_Equifax/_Experian/_TransUnionIndicator` | `"Y"/"N"` | Which repos **actually** returned (may differ from requested — frozen bureau) |
| `REQUESTING_PARTY@LenderCaseIdentifier/_Name/…` | echo of our loan number | |
| `CREDIT_REQUEST_DATA@…` | echo of request action/type/ids | |

**`RESPONSE/KEY` pairs (parse into a lookup):** `CustomerID`, `BID`, `ver`; per model
`EquifaxBeacon5.0_MinimumValue`=300 / `_MaximumValue`=850, `ExperianFairIsaac_Min/MaxValue`,
`FICORiskScoreClassic04_Min/MaxValue`; and `CreditScoreRankPercent_CR{reportId}_S{scoreId}` = percentile.
**Read the min/max range from here — don't hard-code 300–850** (models can differ). Map each
rank-percent key back to its `CREDIT_SCORE@CreditScoreID`.

---

## 3. `CREDIT_SCORE` — three per borrower (the critical section)

One `CREDIT_SCORE` element **per repository**, each tied to its own `CreditFileID`.

| Attribute | Value | Notes |
|---|---|---|
| `CreditScoreID` | e.g. `"S2124545"` | Join target for the rank-percent KEY |
| `BorrowerID` | `"B1"` | All three bureau scores share the borrower's id |
| `CreditFileID` | links to the matching `CREDIT_FILE` | |
| `CreditReportIdentifier` | report PK | |
| `CreditRepositorySourceType` | **Equifax / Experian / TransUnion** | |
| `_Value` | integer-string, e.g. `734` | The score — **but validate it's a real score, not a no-hit/exclusion code** |
| `_ModelNameType` | `EquifaxBeacon5.0` / `ExperianFairIsaac` / `FICORiskScoreClassic04` | **Assert the model per bureau** |
| `_Date` | date | |
| `_FACTAInquiriesIndicator` | `"Y"/"N"` | |
| child `_FACTOR@_Code/_Text` (×~4) | reason/adverse-action codes | **Bureau-specific**; codes may be zero-padded (`"030"` vs `30`) — keep as strings |

**Model per bureau:** Equifax → `EquifaxBeacon5.0`; Experian → `ExperianFairIsaac`; TransUnion →
`FICORiskScoreClassic04`. **Three-to-one mapping:** all three carry the same `BorrowerID` with
distinct `CreditScoreID`/`CreditFileID`/`CreditRepositorySourceType`. **Select by
model+bureau+borrower, never by position.**

**Scoring pipeline** (see DESIGN §6): per borrower → median of 3 / lower of 2 / the 1 / no-score
if 0; loan representative = **highest** middle across borrowers (matches existing `GREATEST` `#99`).

---

## 4. `CREDIT_LIABILITY` (tradelines)

Each tradeline is **single-repository** (its `CreditFileID`/`CREDIT_REPOSITORY` names the reporting
bureau). Attributes (bold = schema-required):
`**CreditLiabilityID**`, `**BorrowerID**`, `**CreditFileID**`, `CreditTradeReferenceID`,
`**_AccountIdentifier**`, `**_AccountOpenedDate**` (`YYYY-MM`), `**_AccountOwnershipType**`
(Individual / **AuthorizedUser** / JointParticipating / JointContractualLiability),
`**_AccountReportedDate**`, `**_AccountStatusType**` (Open/Paid/Closed), `**_AccountType**`
(Revolving/Open/Installment), `_CollateralDescription`, `_CreditLimitAmount`,
`**_DerogatoryDataIndicator**` (Y/N), `_HighCreditAmount`, `**_LastActivityDate**`,
`_MonthlyPaymentAmount`, `_TermsSourceType` (Calculated/Provided), `_MonthsReviewedCount`,
`**_UnpaidBalanceAmount**`, `_PastDueAmount`, `_TermsDescription` (`"MIN107"`), `_TermsMonthsCount`,
`_AccountPaidDate`, `_AccountClosedDate`, `CreditBusinessType`, `CreditLoanType`.

Children: `_CREDITOR@_Name/_StreetAddress/_City/_State/_PostalCode` (+ optional `CONTACT_DETAIL`);
`_CURRENT_RATING@_Code/_Type` (e.g. `_Code="C" _Type="AsAgreed"`); `_LATE_COUNT@_30/_60/_90Days` with
three nested `PERIODIC_LATE_COUNT@_Type(FirstYear/SecondYear/ThirdYear)/_30/_60/_90/_120Days`;
`_PAYMENT_PATTERN@_Data` (per-month string, e.g. `"CCCCCCCCCCCC"`) `@_StartDate`;
`_HIGHEST_ADVERSE_RATING`/`_MOST_RECENT_ADVERSE_RATING`/`_PRIOR_ADVERSE_RATING@_Code/_Date/_Type`;
`CREDIT_COMMENT@_Code/_SourceType(TransUnion/Experian/Equifax/RepositoryBureau)` + `_Text`;
`CREDIT_REPOSITORY@_SourceType/_SubscriberCode`.

> **Honor `_AccountOwnershipType="AuthorizedUser"`** if underwriting reads tradelines — AU accounts
> aren't the borrower's obligation (a documented inflation trap).

---

## 5. Other response sections

| Section | Key fields | Notes |
|---|---|---|
| `CREDIT_FILE` (one per repo) | `@CreditFileID/BorrowerID/CreditRepositorySourceType/_InfileDate`; child `_ALERT_MESSAGE/_Text`; `_BORROWER` (`@_BirthDate/_FirstName/_MiddleName/_LastName/_SSN/_UnparsedName`, repeating `_RESIDENCE`, `_ALIAS`, `_UnparsedEmployment`); `_OWNING_BUREAU` (dispute address+phone) | `_ALERT_MESSAGE` carries **FACTA / fraud** text. Use `_BORROWER` here to **verify identity** vs the application (SSN/name/DOB) |
| `CREDIT_INQUIRY` | `@CreditInquiryID/BorrowerID/CreditFileID/_Name/_Date/CreditBusinessType/CreditLoanType…` | In example XML but **not** in the OpenAPI `CreditResponse` object — **parse defensively** |
| `CREDIT_SUMMARY` | `@_Name`; repeating `_DATA_SET@_Name/_Value` | ~100 rollup counters: `TotTrds`, `RevTrds`, `MortTrds`, `NumberOfPublicRecords`, `NumberOfAuthorizedUserAccounts`, delinquency buckets, etc. |
| `CREDIT_TRADE_REFERENCE` | `@CreditTradeReferenceID/_Name/_StreetAddress…` + contact | Creditor directory referenced by id |
| `CREDIT_CONSUMER_REFERRAL` | `@_Name/_StreetAddress/_City/_State/_PostalCode/_Identifier` + contact | Bureau dispute contacts |
| `ALERT / FACTA / fraud` | via `CREDIT_FILE/_ALERT_MESSAGE/_Text` + `CREDIT_SCORE/_FACTAInquiriesIndicator` | **No separate fraud element** — surface these as hard-stops |
| `EMBEDDED_FILE` | `@_Type="PDF"`, `@_Name`, `@_Extension="pdf"`, `@_Description`, `@MIMEType="application/pdf"`, `@_EncodingType="base64"`; child `DOCUMENT/<![CDATA[ …base64… ]]>` | **The Base64 PDF** — decode the `DOCUMENT` CDATA → bytes → store blob |

**Flags for the team (confirm with Xactus Integrations if the product depends on them):**
- **No dedicated `CREDIT_PUBLIC_RECORD` / `CREDIT_COLLECTION` elements** in the 2.3.1 schema/examples.
  Public records surface as `CREDIT_SUMMARY` counters (`NumberOfPublicRecords`) and as inquiries /
  tradelines with `CreditBusinessType="MiscellaneousAndPublicRecord"`. Collections arrive as
  `CREDIT_LIABILITY` rows.
- **Embedded-PDF container:** Xactus's 2.3.1 model documents **only** the
  `EMBEDDED_FILE/DOCUMENT/<CDATA>` shape. The `VIEW_FILES/VIEW_FILE/FOREIGN_OBJECT/EmbeddedContentXML`
  shape that appeared in an owner-pasted sample is **not** in Xactus's 2.3.1 model (it belongs to a
  different format/version). Build for `EMBEDDED_FILE/DOCUMENT/CDATA` and **verify empirically in the
  test environment**; only add FOREIGN_OBJECT handling if a real Xactus response uses it.

---

## 6. Storage guidance

- Persist `CreditReportIdentifier` as the report PK (drives Reissue/Refresh/Upgrade).
- Store the three `CREDIT_SCORE` rows as a per-borrower child table: bureau, model, value, date,
  FACTA indicator, factors (JSON), rank-percent.
- Store tradelines / inquiries / summary as child collections keyed on
  `CreditReportIdentifier` + `BorrowerID`.
- Save the decoded PDF as an access-controlled document blob keyed to the report.
- **Encrypt** the raw XML + PDF (they contain SSN/DOB/account numbers); never store raw XML in
  cleartext jsonb; mask PII in logs.

---

## Sources
- Xactus OpenAPI bundle (authoritative schema + worked examples): `https://developer.xactus.com/_bundle/apis/creditapis/CreditReport_MISMO2.yaml`
- Build Request: `https://developer.xactus.com/apimd/creditapis/a2_mismo2_cr_build_request`
- Digest / overview: `https://developer.xactus.com/apimd/creditapis/a1_mismo2_cr_digest`
- Communications / auth / transport: `https://developer.xactus.com/apimd/creditapis/a3_mismo2_cr_submit_request`
- Order endpoints: `https://developer.xactus.com/apis/creditapis/creditreport_mismo2/order/order_credit_report`
- Refresh Report: `https://developer.xactus.com/apis/creditapis/creditreport_mismo2/other/refresh_report`
- MISMO error codes: `https://developer.xactus.com/Credit_API_mismo-error-list.txt`
- Credit ReportX Reference Guide: `https://xactus.com/wp-content/uploads/2025/01/Credit-ReportX-Reference-Guide-for-Xactus360-Form-1.pdf`
