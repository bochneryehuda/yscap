# searchRaw — the measured field contract

**What this is.** Lender Price answers a request it cannot process with a bare
`{"status":500,"error":"Internal Server Error","message":"500 "}` — no field name, no reason. The
only way to learn which values it refuses is to ask it, one field at a time, against a body that is
otherwise proven to price. That is what this table is: every leaf of a known-good request, probed
three ways against the live tenant.

**This file is GENERATED from the measurement** (`sweep-500-results.json`). Do not hand-edit it —
re-run the sweep and regenerate, or the table and the truth drift apart.

**Method.** Control = the captured frontend request, posted verbatim → HTTP 200. Then for each leaf:

| probe | meaning |
| --- | --- |
| `null` | the leaf set to JSON null — "may this field be null?" |
| `delete` | the leaf removed entirely — "is this field required?" |
| `empty` | `""` / `[]` / `0` / `false` by type — "may this field be blank?" |

`ok` = still HTTP 200. A number = the status the vendor answered. `·` = not probed (the empty probe
is skipped where the good value is already empty).

**Coverage: 320 probes over 129 of the request's 222 leaves; 46 refusals.**

> **⚠ THIS RUN IS INCOMPLETE — 93 of 222 leaves have not been probed yet.**
> Every row below is measured and true. What is NOT here is not evidence of anything: an absent
> field has not been cleared, it has not been asked about. Do not read section 2 as "these are safe"
> until the coverage line above reads 222 of 222.


---

## 1. The fields that BREAK the request — hand this list to Lender Price

These are the leaves where at least one probe stopped the search from working. For each, we would
like to know from the vendor: is the field genuinely required, what is the permitted value set, and
what SHOULD a caller send when it has nothing to say?

| field | good value | null | delete | empty |
| --- | --- | --- | --- | --- |
| `accessCriteria.companyIds` | `[]` | 500 | ok | · |
| `brokerCriteria.ausList` | `["DU","LP","GUS","MUW","None"]` | 500 | ok | ok |
| `brokerCriteria.businessSourceType` | `"BST_NA"` | ok | ok | 500 |
| `brokerCriteria.qmTypes` | `[]` | 500 | ok | · |
| `brokerCriteria.rangeComplan.@class` | `"com.cre8techlabs.entity.range.Double…` | 500 | 500 | 500 |
| `brokerCriteria.sortView` | `"LenderPaid"` | ok | ok | 500 |
| `closingCost.closingCostGroup` | `[]` | 500 | ok | · |
| `criteria.compensationType` | `"BorrowerCompPlan"` | ok | ok | 500 |
| `criteria.fico` | `760` | 500 | 500 | ok |
| `criteria.fundingFeeFinanced` | `"YES"` | ok | ok | 500 |
| `criteria.guranteeFeeFinanced` | `"YES"` | ok | ok | 500 |
| `criteria.isFirstLienSame` | `""` | 500 | ok | · |
| `criteria.lienPriorityType` | `"FirstLien"` | ok | ok | 500 |
| `criteria.loanPurpose` | `"Refinance"` | ok | ok | 500 |
| `criteria.loanType` | `"Fixed"` | ok | ok | 500 |
| `criteria.monthlyIncome` | `16667` | 500 | ok | 500 |
| `criteria.mortgageTypes` | `["Conventional"]` | 500 | ok | ok |
| `criteria.paymentInterestType` | `"FullPITI"` | ok | ok | 500 |
| `criteria.pmiType` | `"BPMI"` | ok | ok | 500 |
| `criteria.propertyUse` | `"Investment"` | ok | ok | 500 |
| `criteria.purchasePrice` | `500000` | 400 | ok | 400 |
| `criteria.specialMortgageOptions` | `[{"id":"592868b74cedfd00015bdd63","na…` | 500 | ok | ok |
| `criteria.ufmipFinanced` | `"YES"` | ok | ok | 500 |
| `criteria.varaiableLoanTypes` | `[]` | 500 | ok | · |
| `filter.productCode` | `[]` | 500 | ok | · |
| `filter.programNames` | `[]` | 500 | ok | · |
| `miCriteria.amortizationType` | `"FullyAmmortized"` | ok | ok | 500 |
| `miCriteria.buyDownPercent` | `"None"` | ok | ok | 500 |
| `miCriteria.duLpDecision` | `"DU_Approve_Eligible"` | ok | ok | 500 |
| `miCriteria.loanType` | `"Fixed"` | ok | ok | 500 |
| `miCriteria.originationChannel` | `"Retail"` | ok | ok | 500 |
| `miCriteria.paymentPlan` | `"EZMonthly"` | ok | ok | 500 |
| `miCriteria.paymentType` | `"Monthly"` | ok | ok | 500 |
| `miCriteria.renewalType` | `"Constant"` | ok | ok | 500 |
| `property.address.state` | `"NY"` | ok | 500 | ok |
| `property.attachmentType` | `"Detached"` | ok | ok | 500 |
| `property.propertyType` | `"SingleFamily"` | ok | ok | 500 |
| `ratePeriodIds` | `[]` | 500 | ok | · |
| `rateRange.@class` | `"com.cre8techlabs.entity.range.Double…` | 500 | 500 | 500 |

### What the pattern says

- **A `400` is a real validation error** — the vendor read the request and told us what was wrong.
  Those are the good ones. Everything else is a `500`, which means the request reached code that
  did not expect it.
- **`@class` markers are structural.** `rateRange.@class` and `brokerCriteria.rangeComplan.@class`
  refuse null, blank and removal alike. They are Jackson polymorphic type tags: without them the
  vendor cannot decide which class to build, and it fails before any business rule runs.
- **An enum may not be an empty string.** Every `""` refusal in the table is a field whose value is
  drawn from a fixed list; blank is not a member of that list.
- **A list may not be null**, even where an empty list is accepted.

---

## 2. The fields that tolerate every probe we ran SO FAR

Proven harmless — worth recording so they stop being suspected during the next outage.
**Partial run: this list will grow as the remaining leaves are probed.**

<details><summary>90 leaves, all probes returned HTTP 200</summary>

- `accessCriteria.marketPlaceSearch`
- `accessCriteria.mkSearchAllLenders`
- `brokerCriteria.closingCostRange.@class`
- `brokerCriteria.closingCostRange.closestToPar`
- `brokerCriteria.closingCostRange.infinite`
- `brokerCriteria.dayLocks`
- `brokerCriteria.dayLocksList`
- `brokerCriteria.displayConventionalRate`
- `brokerCriteria.divisionSourceType`
- `brokerCriteria.feeServicer.companyName`
- `brokerCriteria.feeServicer.primary`
- `brokerCriteria.feeServicer.vendorName`
- `brokerCriteria.feeServicer.vendorType`
- `brokerCriteria.feeServicerList`
- `brokerCriteria.maxCompensation`
- `brokerCriteria.minimunCompensation`
- `brokerCriteria.overrideExistingComplan`
- `brokerCriteria.rangeComplan.from`
- `brokerCriteria.rangeComplan.to`
- `brokerCriteria.rateTypes`
- `brokerCriteria.subRateTypes`
- `closingCost.settlementCost.origination.administrationLabel`
- `closingCost.settlementCost.origination.lenderCreditLabel`
- `closingCost.settlementCost.origination.others`
- `closingCost.settlementCost.origination.othersLabel`
- `closingCost.settlementCost.origination.total`
- `closingCost.settlementCost.origination.underwriting`
- `closingCost.settlementCost.origination.underwritingLabel`
- `closingCost.settlementCost.titleService.borrowerEscrowPaidPercentLabel`
- `closingCost.settlementCost.titleService.borrowerTitlePaidPercent`
- `closingCost.settlementCost.titleService.borrowerTitlePaidPercentLabel`
- `closingCost.settlementCost.titleService.escrowCostLabel`
- `closingCost.settlementCost.titleService.overrideEscrow`
- `closingCost.settlementCost.titleService.overrideTitle`
- `closingCost.settlementCost.titleService.titleInsurance`
- `closingCost.settlementCost.titleService.titleInsuranceLabel`
- `companyId`
- `criteria.ami`
- `criteria.calculatedFeeByMortgageType.FHA`
- `criteria.calculatedFeeByMortgageType.UsdaRural`
- `criteria.calculatedFeeByMortgageType.VA`
- `criteria.clientDti`
- `criteria.downPaymentAmount`
- `criteria.drawAmount`
- `criteria.dscr`
- `criteria.escrowWaiver`
- `criteria.inclusive`
- `criteria.incomeAmiRatio`
- `criteria.interestOnly`
- `criteria.lenderFeeWaiver`
- `criteria.lineAmount`
- `criteria.loanAmount`
- `criteria.loanYear`
- `criteria.ltv`
- `criteria.monthlyDebt`
- `criteria.mortgageLimitForLatestYear.conventionnalLoanLimitAmount`
- `criteria.mortgageLimitForLatestYear.countyLoanLimit1Unit`
- `criteria.mortgageLimitForLatestYear.countyLoanLimit2Unit`
- `criteria.mortgageLimitForLatestYear.countyLoanLimit3Unit`
- `criteria.mortgageLimitForLatestYear.countyLoanLimit4Unit`
- `criteria.mortgageLimitForLatestYear.fhaMortgageLimit`
- `criteria.mortgageLimitForLatestYear.matchingCountyLoanLimit`
- `criteria.mortgageLimitForLatestYear.mortgageLimit`
- `criteria.mortgageLimitForLatestYear.year`
- `criteria.ownProperties`
- `criteria.rehabBudget`
- `criteria.selfEmployed`
- `criteria.subordinateLoanAmount`
- `criteria.totalLoanAmountByMortgageType.FHA`
- `criteria.totalLoanAmountByMortgageType.UsdaRural`
- `criteria.totalLoanAmountByMortgageType.VA`
- `date`
- `miCriteria.numberOfDeferredPayments`
- `property.address.censustract`
- `property.address.city`
- `property.address.country`
- `property.address.county`
- `property.address.countyName`
- `property.address.province`
- `property.address.street`
- `property.address.streetCont`
- `property.address.zip`
- `property.address.zipExt`
- `property.numberOfUnit`
- `rateGridIds`
- `rateRange.from`
- `rateRange.to`
- `showDisqualify`
- `showDisqualifyRules`
- `showUnmatchCompPlan`

</details>

---

## 3. What we already fixed on our side, and what it was

Each of these was measured, not reasoned about.

1. **We were posting the wrong document.** `GET /pricing/defaultSearch` returns the company's
   CONFIGURATION model; the browser transforms it into a request before calling `searchRaw`. Our
   builder cloned it and posted it as-is whenever a live foundation was available — which is every
   time in production. 8,576 bytes, 203 structural differences from the working request, HTTP 500 on
   every scenario. Now the request is always built from the captured working request, and the live
   model contributes values only, through a strict normalizer.
2. **`criteria.mortgageTypes` arrived null** on that configuration model, and the table above shows
   null there is a 500. That single leaf was the trigger. It is now forced.
3. **The shadow/canary path priced a different location than the real pricer.** `validateScenario`
   is what fills county and state in from a ZIP, and only one of the three callers ran it — so the
   comparison that governs the cutover was measuring two different requests. Validation and
   enrichment moved inside `price()`, where no caller can skip them.
4. **A saved company preference could change what kind of search we ran** — a live model turned
   `loanType` into ARM and `mortgageTypes` into FHA on a DSCR search, with no error. The five
   fields that define a DSCR investor search are now forced last.
5. **The address went out untyped** — a lowercase state, a county FIPS as a number (losing a leading
   zero), an object where a county name belongs.

## 4. Still open — the questions for Lender Price

1. **`criteria.fico`**: null → 500 AND removed → 500. So a search must always carry a credit score.
   Is that intended? What should a caller send when the score is genuinely not yet known?
2. **`dynamicPropertiesMap.DSCRRATIO`**: we generate it on every DSCR request; the captured working
   request does not contain the key at all. What is it for, when does the frontend add it, and what
   are the permitted values?
3. **The special mortgage option `Prepay Buyout`** (id `5f64dbe6ce8ad00001f91b69`) is in every
   working request we have; we replace it with a DSCR-band option that carries **no id**. Is the
   band option real, and should Prepay Buyout always be present?
4. **Prepay option ids** for No/1/2/4/5-year PPP were inferred from the one confirmed 3-year id being
   `…dd63`. Please confirm the real ids — a wrong id changes the price silently.
5. **Product counts.** The same scenario returns 17 programs / 439 priced rows from the website. We
   need the same numbers from the API before this can be trusted, and any request-shape difference
   that would explain a gap.
