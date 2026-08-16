# Lender Price (Digital Lending PPE) — searchRaw response schema & pricing model

**Product: LONG-TERM DSCR only.** This is the durable reference for the Lender Price pricing
response — the complete structure we get back from a scenario, how each price is built (base rate
→ LLPAs → margin/holdback → final), and exactly what our backend captures. Source of truth for
this doc: a real 5.1 MB `searchRaw` response captured from `yscapgroup.digitallending.com` (the
company web app), plus industry research on LLPA/rate-sheet pricing.

Consumers: `src/longterm/lenderprice/client.js` (`parse`, `parseFull`, `parseDisqualified`,
`buildSearch`), `src/longterm/routes/dscr-pricer.js`.

---

## 1. The request (recap)

`POST /rest/v1/lp-ppe-integration/pricing/searchRaw/{companyId}/{userId}` with the FULL default-search
model overlaid with the scenario. We always search for **all options** (`rate:null`, `rates:[]`,
`maxListingPerRate:-1`, `targetInterpolatedPrices:[]`, full `rateRange`). 30-day lock lives in
`brokerCriteria.dayLocks=30` + `dayLocksCriteria:[30]`; the 30-YEAR term is separate
(`termsCriteria:[30]`, `termsInMonths:false`). Disqualify is a two-phase async flow: send with
`showDisqualify/showDisqualifyRules/disqualifyAsync/fillLenderMap=true` + `cachedDisqualified:false`
to kick off, then re-send with `cachedDisqualified:true` (identical body) until
`results.disqualifiedData` populates (a few minutes; empty body = still computing).

---

## 2. Top-level response shape

```
{ id, provider, search (echo of the request), results {…}, closingCost, status, … }
```

Everything we care about is under **`results`**:

| key | meaning |
|-----|---------|
| `qualifiedNonQMData` | grouped tree of QUALIFIED non-QM (DSCR) priced options |
| `qualifiedQMData` | grouped tree of QUALIFIED QM options |
| `disqualifiedData` | grouped tree of DECLINED programs + the failing rules |
| `qualifiedNonQMLenders` / `qualifiedQMLenders` / `disqualifiedLenders` | objects keyed by **lender name** |
| `lenderDtos` | `{ lenderDtoQm[], lenderDtoNonQm[], lenderDtoDisq[], sponsoredLenderDto[] }` — each item `{id,name,shortName,ratePeriodId,rateGrids}` |
| `programs` | array of program metadata |
| `showDisqualifyRules` / `onlyDisqualifyRules` | echo of the request flags |
| `baseSearch` | the resolved search |
| `sponsoredData` | sponsored lenders' grouped tree |

### The grouped tree (Program → Rate → Lender → leaf)

Each `*Data` container is a tree of group nodes. A group node:

```
{ key: [...], keyLabel: "<value>", type: "<dimension>", plenderId: "\"<id>\"", childs: [...], leafs: [...] }
```

- **`type`** names the grouping dimension, **`keyLabel`** carries its value:
  - `CriteriaFromLineResultKey` → **program** name (e.g. "DSCR 30 Year Fixed - IO")
  - `RateKey` → the **rate** (e.g. "7.25")
  - `LenderKey` → the **lender** name (e.g. "AD Mortgage LLC")
- **`plenderId`** is a JSON-quoted lender id → maps into `results.lenderDtos.*`.
- The deepest nodes carry **`leafs[]`** — each leaf is one priced option.

Grouping order is `CriteriaFromLineResultKey → RateKey → LenderKey → leaf`. NOTE: each **leaf also
carries `companyName` + `companyId` + `programName`**, so the leaf is self-describing — our parser
reads identity off the leaf first and falls back to the group `keyLabel`.

---

## 3. The priced leaf — every field (140+)

Each leaf is a complete priced option. The full field union is captured in the parser; the fields
that matter for pricing:

### Identity
`companyName` (lender), `companyId`, `programName`, `productName`, `rateGridId`, `rateGridName`,
`ratePeriod`, `rateProgram`, `rateGrid` (full product metadata: closingDays, qmTypes,
interestOnlyMonth, amortization, affordableHousingTypes, caps…).

### The price build (bottom-up)
| field | meaning |
|-------|---------|
| `undiscountedRate` / `startedAdjustedRate` | **par rate** (before buying the rate down/up) |
| `baseRates` / `rawRates` | base note rate for the rung |
| `adjustmentRates` | rate adjustment total |
| `rate` / `adjustedRates` | **note rate** (the rung) |
| `basePoints` / `rawBasePoints` | **base price points** (from the lender's rate grid) |
| `adjustmentPoints` / `rawAdjustmentPoints` | **the LLPA stack total, in points** |
| `adjustedPoints` | **final points** = base + adjustments |
| `adjustedPointsBorrowerPaid` / `borrowerPaidPoints` | final points, borrower-paid |
| — | **price = 100 − adjustedPoints** (par = 100) |
| `apr` / `notRoundedAPR` | APR |
| `apor` | Average Prime Offer Rate (compliance) |
| `startedAdjustedPrice` | price at the started/par rate |

### The itemized LLPA stack — `groupAdjustmentProperties[]`
This is the crown jewel — **how the price is built**. An array of adjustment GROUPS, each:
```
{ name: "Adjustments - DSCR Interest Only", type: "RATE"|"POINT",
  totalAdjustment: 0.75, finalAdjustment: 0.75,
  adjustments: [ { key: "DSCR - Interest Only / LTV >75.01% <= 80.0%",  // human reason
                   adjType: "SimpleRateAdjustment", type: "LLPA",
                   valueType: "Points", adj: 0.75, llpa: 0.75 } ],
  qualifyAdjustments: [], disqualifyAdjustments: [], hideDisqualifyAdjustments: [] }
```
Each inner `adjustments[].key` is the reason (a FICO/LTV/CLTV band, IO, DSCR band, cash-out, etc.);
`adj`/`llpa` is the value in points. `groupRateAdjustmentProperties[]` is the same but for RATE
adjustments. `totalGroupAdjustmentProperties` / `totalGroupRateAdjustmentProperties` are the sums.
`overrideLLPA` `{pointAdjs[], rateAdjs[], executionType}` holds manual overrides.

### Margin / holdback — `holdBackResult`
`{ broker|lender|investor: { adjustments: [ { key: "NDC Margin - 0.25%", type: "Margin",
valueType: "Points", adj: 0.25 } ], qualifications, disqualifications, … } }` — the margin the
broker/lender keeps (the "holdback").

### Compensation & fees
`borrowerPaid`, `lenderPaid`, `compPlanBorrowerPaid`, `borrowerPaidDetails[]` / `lenderPaidDetails[]`
/ `brokerPaidDetails[]` / `otherPaidDetails[]` (each `{description, points, amount, type, isOrigination,
isDiscount, …}`), `totalOriginationFee`, `totalLenderFees`, `finalClosingCost`, `cashToCloseAmount`,
`cashToCloseItems[]`, `closingCostDetails[]`, `pointsFinancedDollarAmount`.

### Loan / ratios / product
`loanAmount`, `totalLoanAmount`, `term`, `termInMonths`, `termInfo`, `dayLock`, `mortgageType`,
`loanType`, `loanPurpose`, `isInterestOnly`, `dscr`, `fico`, `ltv`, `cltv`, `hcltv*`, `dti`, `hti`,
`hoa`, `incomeAmiRatio`, `highBalanceIndicator`, `pmiType`, `annualMiPremiumAmount`, `armIndexRate`,
`libor`, `loanLimitLite` (conforming/FHA county limits by units).

### Payment / amortization
`monthlyPayment` `{monthlyPI, total, totalPrincipal, totalInterest, buyDown, …}`, `monthlyPayments[]`
(multiple schedules, e.g. IO then amortizing), `amortizationSchedule`, `interestOnlyAmount`,
`monthlyTotal`.

### Compliance / flags
`compliancesMapByType`, `topRateComplianceTestResult`, `finalQmPercentage`, `qmPercentage`,
`appraisalWaiverIndicator`, `disqualified`, `interpolated` / `interpolationTarget`, `expired`,
`hideDisqualified`, `multiSearchKey`.

---

## 4. The pricing model (industry) — invariants to encode

From LLPA/rate-sheet research (Fannie LLPA matrix, Optimal Blue, Scotsman Guide, non-QM/DSCR sources):

1. **`points = 100 − price`** (par = 100). Dollars = points% × loan amount.
2. **`adjusted price = base price − Σ(signed LLPA adjustments)`.**
3. LLPAs are **points of price**, cumulative; monetized either as cash points at closing OR by
   moving up the rate grid (a higher rate's premium offsets the point hit).
4. Positive LLPA = **cost** (lowers price / raises points); negative = **credit** (raises price).
5. Stack order: raw investor price → LLPAs → (SRP) → **margin/holdback** → **comp** (lender-paid
   subtracts from price; borrower-paid does not) → borrower-facing rate/points.
6. Rungs step ~0.125%; between-rung prices are **interpolated** (`interpolated` flag) — record it.
7. Non-QM/DSCR adds first-class adjustments: **DSCR band**, **prepay-penalty term**, **interest-only**,
   loan-amount premiums, cash-out — sometimes published as RATE add-ons (`type:"RATE"`), sometimes
   POINT. Normalize to points but keep the original `valueType`.
8. Declined programs come back **with structured reasons** (`disqualifyAdjustments`), not a boolean.

Worked example (AD Mortgage DSCR 30yr IO, 7.25%): par 7.875 → note 7.25; base −3.75 pts +
LLPA stack (IO/LTV +0.75, CLTV/FICO +1.125…) = adjustmentPoints +1.5 → adjustedPoints −2.25 →
**price 102.25** (2.25-pt credit); plus NDC margin 0.25%.

---

## 5. Disqualified tree

`results.disqualifiedData` is the SAME Program→Rate→Lender tree. Each declined leaf carries
`disqualified:true` and the failing rules in `groupAdjustmentProperties[].disqualifyAdjustments[]`
(each `{key: "<rule>"}`), plus `conditionActions[]` and `holdBackResult.*.disqualifications[]`.
Populated only after the async computation completes (`hasDisqualifyData()` checks childs/leafs).

---

## 6. What our backend captures

- **`parse(raw)`** — display summary: programs grouped by lender+program, each with a rate/point
  ladder + `lender`/`investor`/`lenderId`, `minRate`/`minPoints`/`maxPrice`/`rungCount`, and per-rung
  `basePoints`/`adjustmentPoints`/`adjustmentCount`.
- **`parseFull(raw, {raw})`** — CAPTURE EVERYTHING: per option, `priceBuild` (par/base/note rate,
  base/adjustment/adjusted points, price, APR, APOR), `adjustments[]` (itemized LLPAs with reason +
  value + valueType), `rateAdjustments[]`, `holdback` (margin), `comp` (borrower/lender paid +
  detail lines), `fees`, `terms` (all ratios), `monthlyPayment`, `flags` — and with `{raw:true}` the
  **entire untouched leaf** (nothing dropped). Plus the `lenders` registry from `lenderDtos`.
- **`parseDisqualified(raw)`** — per lender/investor, which programs declined and the itemized
  failing rules.

Endpoints (`/api/lt/_diag/lenderprice/*` diag or `/api/lt/dscr/*` staff):
- `POST /price` → display summary. `{full:true}` → the complete `parseFull` capture; add
  `{raw:true}` to attach each option's raw leaf; `{debug:true}` → structural `rawSummary`.
- `POST /disqualify` → qualified summary + disqualify reasons per lender (async poll).

---

## 7. Open items to verify on a live DSCR capture

- Confirm the DSCR leaf's `groupAdjustmentProperties` itemization matches (base + Σ LLPAs =
  adjustmentPoints) — the captured reference is a mixed QM/non-QM refinance; a pure DSCR search may
  itemize differently.
- Capture a REAL populated `disqualifiedData` leaf to confirm the exact `disqualifyAdjustments` key
  wording and whether reasons also appear elsewhere (`conditionActions`).
- SRP/margin: confirm whether a separate SRP line appears on wholesale (research says it's usually
  embedded; we capture `holdBackResult` margin regardless).
