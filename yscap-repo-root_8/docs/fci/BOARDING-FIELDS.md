# FCI boarding fields — every field `insertBoarding` accepts

**GENERATED — do not edit.** Written by `scripts/fci-boarding-fields.js` from
`docs/fci/collection-snapshot.json`, FCI's own published Postman collection. Run
`node scripts/fci-boarding-fields.js --check` to prove this file still matches the snapshot;
`node scripts/fci-api-catalog.js --fetch` re-pins the snapshot when FCI ships a release.

This file is the FIELD LIST only. What PILOT puts in each field is a decision and lives in
`src/fci/boarding-map.js`; `scripts/test-fci-boarding-map-pure.js` proves the two cover each
other exactly, so a field FCI adds cannot go unmapped and a mapping cannot name a field that
does not exist.

## In numbers

- `loan` — **81** fields
- `setBorrower` — **19** fields
- `setLenders` — **14** fields
- `setProperties` — **9** fields
- `setFundings` — **23** fields
- **146** fields in total
- **16** carry an enum legend FCI published for that block, and **1** carries one matched by name from another block (flagged inline as our inference)

## Where the field list came from

FCI ships the boarding structure more than once and the copies are not identical, so all of
them are read and every field records which copies carry it. A field seen in only one copy is
not necessarily wrong — but it is not confirmed either, and the `Seen in` column is the only
honest way to say so without a live call.

| Copy | Path in the collection |
|---|---|
| folder documentation | `/item/5/item/0/description` |
| saved request | `/item/5/item/5/request/body/graphql/query` |
| saved bulk request | `/item/5/item/6/request/body/graphql/query` |

## `loan`

| Field | Type (inferred from FCI's sample) | FCI's sample value | Seen in |
|---|---|---|---|
| `accruedMethod` | integer | `0` | folder documentation, saved request |
| `amortizationType` | integer | `1` | folder documentation, saved bulk request, saved request |
| `approvalChangeFeesTerms` | enum token (unquoted) | `LENDER` | folder documentation, saved request |
| `approvaleReinstatement` | enum token (unquoted) | `EITHER` | folder documentation |
| `approvalPayoff` | enum token (unquoted) | `BROKER` | folder documentation, saved request |
| `approvalReinstatement` | enum token (unquoted) | `EITHER` | saved request |
| `approvalStartForeclosure` | enum token (unquoted) | `BOTH` | folder documentation, saved request |
| `defaultCustomDateFrom` | integer | `2` | folder documentation, saved request |
| `defaultIntActiveDaily` | boolean | `false` | folder documentation, saved request |
| `defaultIntAllowLateCharges` | boolean | `false` | folder documentation, saved request |
| `defaultIntCompanyMaxDist` | integer | `100` | folder documentation, saved request |
| `defaultIntDateFrom` | integer | `1` | folder documentation, saved request |
| `defaultIntDays` | integer | `0` | folder documentation, saved bulk request, saved request |
| `defaultIntEffectiveDateFrom` | integer | `1` | folder documentation, saved request |
| `defaultIntEffectiveDays` | integer | `1` | folder documentation, saved request |
| `defaultIntEffectiveOptionDays` | integer | `1` | folder documentation, saved request |
| `defaultIntEnableMaturity` | boolean | `false` | folder documentation, saved request |
| `defaultIntIsEnabled` | boolean | `false` | folder documentation, saved bulk request, saved request |
| `defaultIntLastEffectiveDate` | date (MM/DD/YYYY string) | `"6/1/21"` | folder documentation, saved request |
| `defaultIntLastEffectiveStatus` | boolean | `true` | folder documentation, saved request |
| `defaultIntLastImplementationDate` | date (MM/DD/YYYY string) | `"6/1/21"` | folder documentation, saved request |
| `defaultIntLastTopDate` | date (MM/DD/YYYY string) | `"6/1/21"` | folder documentation, saved request |
| `defaultIntLenderPct` | integer | `10` | folder documentation, saved request |
| `defaultIntModifier` | integer | `1` | folder documentation, saved request |
| `defaultIntOptionDays` | integer | `0` | folder documentation, saved request |
| `defaultIntRate` | integer | `1` | folder documentation, saved bulk request, saved request |
| `defaultIntTypeCalculation` | integer | `0` | folder documentation, saved request |
| `defaultIntUseCustomDate` | boolean | `false` | folder documentation, saved request |
| `defaultIntVendorPct` | integer | `10` | folder documentation, saved request |
| `defaultRate` | decimal | `12.32` | folder documentation, saved request |
| `firstPaymentDate` | date (MM/DD/YYYY string) | `"08/25/2020"` | folder documentation, saved bulk request, saved request |
| `fundingDate` | date (MM/DD/YYYY string) | `"08/25/2020"` | folder documentation, saved bulk request, saved request |
| `is30DayMonths` | boolean | `true` | folder documentation, saved request |
| `is365DayYears` | boolean | `true` | folder documentation, saved request |
| `lateChargeMax` | integer | `150` | folder documentation, saved request |
| `lateChargesCompanyMaxDist` | integer | `50` | folder documentation, saved request |
| `lateChargesDaily` | integer | `3` | folder documentation, saved request |
| `lateChargesDays` | integer | `1` | folder documentation, saved bulk request, saved request |
| `lateChargesLenderPct` | integer | `40` | folder documentation, saved request |
| `lateChargesMin` | integer | `130` | folder documentation, saved request |
| `lateChargesPct` | integer | `5` | folder documentation, saved bulk request, saved request |
| `lateChargesPostMaturity` | boolean | `false` | folder documentation, saved request |
| `lateChargesVendorPct` | integer | `35` | folder documentation, saved request |
| `lenderAccount` | string | `"test1234"` | folder documentation, saved bulk request, saved request |
| `lienPosition` | integer | `1` | folder documentation, saved bulk request, saved request |
| `loanType` | integer | `1` | folder documentation, saved bulk request |
| `maturityDate` | date (MM/DD/YYYY string) | `"08/25/2020"` | folder documentation, saved bulk request, saved request |
| `negativeToPrincipal` | boolean | `true` | folder documentation, saved request |
| `nextDueDate` | date (MM/DD/YYYY string) | `"08/25/2020"` | folder documentation, saved bulk request, saved request |
| `noPyramiding` | boolean | `true` | folder documentation, saved request |
| `noteRate` | decimal | `12.3` | folder documentation, saved bulk request, saved request |
| `noteType` | integer | `1` | folder documentation, saved bulk request, saved request |
| `originalBalance` | integer | `12` | folder documentation, saved bulk request, saved request |
| `originalVendor` | string | `"VENDORaccount"` | folder documentation |
| `originationDate` | date (MM/DD/YYYY string) | `"08/25/2020"` | folder documentation, saved bulk request, saved request |
| `paidToDate` | date (MM/DD/YYYY string) | `"08/25/2020"` | folder documentation, saved bulk request, saved request |
| `payment` | decimal | `5.0` | folder documentation, saved bulk request, saved request |
| `paymentCityTax` | decimal | `15.00` | folder documentation, saved bulk request, saved request |
| `paymentFrequency` | integer | `1` | folder documentation, saved bulk request, saved request |
| `paymentImpound` | integer | `12` | folder documentation, saved bulk request, saved request |
| `paymentOtherTax` | decimal | `5.00` | folder documentation, saved bulk request, saved request |
| `paymentPropertyTax` | decimal | `12.30` | folder documentation, saved bulk request, saved request |
| `paymentSchoolTax` | decimal | `12.32` | folder documentation, saved bulk request, saved request |
| `paymentTownshipTax` | decimal | `10.00` | folder documentation, saved bulk request, saved request |
| `paymentWaterSewerTax` | decimal | `15.00` | folder documentation, saved bulk request, saved request |
| `prevAccount` | string | `"TESTLOAN01"` | folder documentation, saved bulk request, saved request |
| `primaryPurpose` | integer | `1` | folder documentation, saved bulk request, saved request |
| `principalBalance` | decimal | `12.3` | folder documentation, saved bulk request, saved request |
| `rateType` | integer | `1` | folder documentation, saved bulk request, saved request |
| `reserveCityTax` | integer | `0` | folder documentation, saved bulk request, saved request |
| `reservePropertyTax` | integer | `5` | folder documentation, saved bulk request, saved request |
| `reserveSchoolTax` | integer | `5` | folder documentation, saved bulk request, saved request |
| `reserveTownshipTax` | integer | `0` | folder documentation, saved bulk request, saved request |
| `reserveWaterSewerTax` | integer | `0` | folder documentation, saved bulk request, saved request |
| `spreadRate` | decimal | `1.0` | folder documentation, saved request |
| `startingBalance` | integer | `0` | folder documentation, saved bulk request, saved request |
| `trustAccount` | string | `"FCI - Pool 1 Trust Account"` | folder documentation, saved request |
| `withheldFloodInsurance` | integer | `0` | folder documentation, saved bulk request, saved request |
| `withheldHazardInsurance` | integer | `0` | folder documentation, saved bulk request, saved request |
| `withheldPropertyTax` | integer | `0` | folder documentation, saved bulk request, saved request |
| `withheldWindInsurance` | integer | `0` | folder documentation, saved bulk request, saved request |

## `setBorrower`

| Field | Type (inferred from FCI's sample) | FCI's sample value | Seen in |
|---|---|---|---|
| `city` | string | `"sd"` | folder documentation, saved bulk request, saved request |
| `company` | string | `"Company"` | folder documentation, saved bulk request, saved request |
| `contactName` | string | `"ContactName"` | folder documentation, saved bulk request, saved request |
| `deliveryOptions` | integer | `0` | saved request |
| `email` | string | `"testemail@gmail.com"` | folder documentation, saved bulk request, saved request |
| `fax` | string | `"011-123"` | folder documentation, saved bulk request, saved request |
| `firstName` | string | `"TEST"` | folder documentation, saved bulk request, saved request |
| `homePhone` | string | `"011-123"` | folder documentation, saved bulk request, saved request |
| `isCompany` | boolean | `true` | folder documentation, saved bulk request, saved request |
| `isPrimary` | boolean | `true` | folder documentation, saved bulk request, saved request |
| `lastName` | string | `"TEST"` | folder documentation, saved bulk request, saved request |
| `middleName` | string | `"TESTTEST"` | folder documentation, saved bulk request, saved request |
| `mobilePhone` | string | `"011-123"` | folder documentation, saved bulk request, saved request |
| `state` | string | `"sd"` | folder documentation, saved bulk request, saved request |
| `street` | string | `"street"` | folder documentation, saved bulk request, saved request |
| `tin` | string | `"123456789"` | folder documentation, saved bulk request, saved request |
| `tinType` | integer | `1` | folder documentation, saved bulk request, saved request |
| `workPhone` | string | `"011-123"` | folder documentation, saved bulk request, saved request |
| `zipCode` | string | `"012"` | folder documentation, saved bulk request, saved request |

## `setLenders`

| Field | Type (inferred from FCI's sample) | FCI's sample value | Seen in |
|---|---|---|---|
| `account` | string | `"test1234"` | folder documentation, saved bulk request, saved request |
| `city` | string | `"COSTA"` | folder documentation, saved bulk request, saved request |
| `email` | string | `"email@gmail.com"` | folder documentation, saved bulk request, saved request |
| `fax` | string | `"011-123"` | folder documentation, saved bulk request, saved request |
| `firstName` | string | `"Lender Name"` | folder documentation, saved bulk request, saved request |
| `homePhone` | string | `"011-123"` | folder documentation, saved bulk request, saved request |
| `lastName` | string | `"Lender LastName"` | folder documentation, saved bulk request, saved request |
| `middleName` | string | `"Lender Middle Name"` | folder documentation, saved bulk request, saved request |
| `mobilePhone` | string | `"011-123"` | folder documentation, saved bulk request, saved request |
| `state` | string | `"CA"` | folder documentation, saved bulk request, saved request |
| `street` | string | `"Lender street"` | folder documentation, saved bulk request, saved request |
| `tin` | string | `"123456789"` | folder documentation, saved bulk request, saved request |
| `workPhone` | string | `"011-123"` | folder documentation, saved bulk request, saved request |
| `zipCode` | string | `"012"` | folder documentation, saved bulk request, saved request |

## `setProperties`

| Field | Type (inferred from FCI's sample) | FCI's sample value | Seen in |
|---|---|---|---|
| `city` | string | `"City"` | folder documentation, saved bulk request, saved request |
| `county` | string | `"SLASD"` | folder documentation, saved bulk request, saved request |
| `description` | string | `"Description"` | folder documentation, saved bulk request, saved request |
| `isPrimary` | boolean | `true` | folder documentation, saved bulk request, saved request |
| `occupancyStatus` | integer | `1` | folder documentation, saved bulk request, saved request |
| `state` | string | `"sa"` | folder documentation, saved bulk request, saved request |
| `street` | string | `"Street"` | folder documentation, saved bulk request, saved request |
| `type` | integer | `0` | folder documentation, saved bulk request, saved request |
| `zipCode` | string | `"011"` | folder documentation, saved bulk request, saved request |

## `setFundings`

| Field | Type (inferred from FCI's sample) | FCI's sample value | Seen in |
|---|---|---|---|
| `agreementeTemplateEnumValue` | enum token (unquoted) | `BASIC_LIMITED` | folder documentation, saved bulk request, saved request |
| `brokerFeeFlat` | decimal | `11.00` | folder documentation, saved bulk request, saved request |
| `brokerFeeFlatNPerf` | decimal | `95.00` | folder documentation, saved bulk request, saved request |
| `brokerFeeMin` | decimal | `10.00` | folder documentation, saved bulk request, saved request |
| `brokerFeeMinNPerf` | decimal | `95.00` | folder documentation, saved bulk request, saved request |
| `brokerFeePct` | decimal | `0.00` | folder documentation, saved bulk request, saved request |
| `brokerResAddDays` | integer | `0` | folder documentation, saved bulk request, saved request |
| `brokerResAddDays_2` | integer | `0` | folder documentation, saved bulk request, saved request |
| `brokerResAddDays_3` | integer | `60` | folder documentation, saved bulk request, saved request |
| `brokerResAddFee` | decimal | `0.00` | folder documentation, saved bulk request, saved request |
| `brokerResAddFee_2` | decimal | `0.00` | folder documentation, saved bulk request, saved request |
| `brokerResAddFee_3` | decimal | `0.00` | folder documentation, saved bulk request, saved request |
| `brokerResFee` | decimal | `0.00` | folder documentation, saved bulk request, saved request |
| `funds` | decimal | `126.00` | folder documentation, saved bulk request, saved request |
| `gSTaxUse` | boolean | `true` | folder documentation, saved bulk request, saved request |
| `lenderAccount` | string | `"test1234"` | folder documentation, saved bulk request, saved request |
| `rateType` | integer | `1` | folder documentation, saved request |
| `rateValue` | decimal | `12.00` | folder documentation, saved bulk request, saved request |
| `roundError` | boolean | `true` | folder documentation, saved bulk request, saved request |
| `trustAccount` | string | `"FCI - Pool 1 Trust Account"` | folder documentation, saved request |
| `vendorFeeFlat` | decimal | `0.00` | folder documentation, saved bulk request, saved request |
| `vendorFeeMin` | decimal | `0.00` | folder documentation, saved bulk request, saved request |
| `vendorFeePct` | decimal | `0.00` | folder documentation, saved bulk request, saved request |

## Enum legends FCI publishes

These are the OUTBOUND forms — what a boarding payload sends. FCI's read side returns the
same concepts as display strings, which is why nothing may round-trip an enum by assuming
what went in is what comes back.

### `loan.accruedMethod`

- DUE_TO_DUE_FIXED = 0 — Regular Period (Due Date to Due Date)
- DUE_TO_DUE_ACTUAL = 1 — Actual Days (Due Date to Due Date)
- RECEIVED_TO_RECEIVED = 2 — Actual Days (Received Date to Received Date)

### `loan.amortizationType`

- OTHER = 0
- FULLY_AMORTIZED = 1
- PARTIALLY_AMORTIZED = 2
- INTEREST_ONLY = 3
- CONSTANT_AMORTIZATION = 4
- INTEREST_ONLY_PYMT = 5
- YEAR_AMORTIZED_15 = 6
- YEAR_AMORTIZED_30 = 7

### `loan.approvalChangeFeesTerms`

- Broker = BROKER
- Lender = LENDER
- Either = EITHER
- Both = BOTH

### `loan.approvaleReinstatement`

- Broker = BROKER
- Lender = LENDER
- Either = EITHER
- Both = BOTH

### `loan.approvalPayoff`

- Broker = BROKER
- Lender = LENDER
- Either = EITHER
- Both = BOTH

### `loan.approvalStartForeclosure`

- Broker = BROKER
- Lender = LENDER
- Either = EITHER
- Both = BOTH

### `loan.lienPosition`

- 1st = 1
- 2nd = 2
- 3rd = 3
- 4th = 4
- 5th = 5
- 6th = 6
- 7th = 7
- 8th = 8
- 9th = 9
- 10th = 10
- UNS = 11
- LEASE = 12

### `loan.noteType`

- OTHER = 0
- CONVENTIONAL = 1
- CONSTRUCTION = 2
- LINE_OF_CREDIT = 3
- AUTO = 4
- BUSINESS_PURPOSE_LOAN = 5
- CASH_ADVANCE = 6
- FANNIE_MAE = 7
- FHA = 8
- FREDDIE_MAC = 9
- HECM = 10
- HUD = 11
- LEASE = 12
- PERSONAL = 13
- PURCHASE_CONTRACT = 14
- UNSECURED = 16
- VA = 17
- SECURITIZED_LOAN = 18
- DRAW_LOAN_NON_DUTCH = 19
- DRAW_LOAN_DUTCH = 20
- LOC_OPEN = 21
- LOC_CLOSED = 22
- DSCR = 23

### `loan.paymentFrequency`

- BIWEEKLY = 0
- MONTHLY = 1
- QUATERLY = 2
- SEMI_YEARLY = 3
- YEARLY = 4
- TWICE_MONTHLY = 5
- STRAIGHT = 6

### `loan.primaryPurpose`

- CONSUMER = 0
- BUSINESS = 1

### `loan.rateType`

- OTHER = 0
- FIXED_RATE = 1
- ARM = 2
- GRADUATED_TERMS = 3

### `setBorrower.deliveryOptions`

- 0 = PRINT
- 1 = EMAIL
- 2 = PRINT_AND_EMAIL
- 3 = NEVER

### `setBorrower.tinType`

- 0 = EIN
- 1 = SNN
- 2 = ITIN
- 3 = ATIN
- 4 = PTIN
- 5 = OTHER

### `setProperties.occupancyStatus`

- PRIMARY_BORROWER = 0
- SECONDARY_BORROWER = 1
- VACANT = 2
- TENANT = 3
- INVESTOR = 4
- OTHER = 5
- UNKNOWN = 6

### `setProperties.type`

- 0 = Origination
- 1 = Adjustment
- 2 = Payment
- 3 = Closed
- 4 = Waived
- 5 = Expired

### `setFundings.agreementeTemplateEnumValue`

- Basic Limited = BASIC_LIMITED
- High Touch Limited = HIGH_TOUCH_LIMITED
- High Touch Full = HIGH_TOUCH_FULL
- Basic Full Collection = BASIC_FULL_COLLECTION

### `setFundings.rateType`

> FCI documents this list as **RateType**, under the `loan` block. Applying it
> to `setFundings.rateType` is OUR inference from the shared field name — FCI has not published a
> legend for this block's copy. Confirm it before boarding anything live.

- OTHER = 0
- FIXED_RATE = 1
- ARM = 2
- GRADUATED_TERMS = 3

