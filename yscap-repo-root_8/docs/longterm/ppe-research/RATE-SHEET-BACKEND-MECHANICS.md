# DSCR Rate-Sheet Backend Mechanics — the "ground truth" reference

**Long-Term (LT) DSCR Product & Pricing Engine (PPE). READ-ONLY research.** This is the authoritative
backend-mechanics reference for a DSCR investor rate sheet and EXACTLY how Lender Price returns each
piece. The owner's requirement: understand *every* LLPA, *every* eligibility, *every* ineligibility,
max price and min price — and reach exact agreement with Lender Price before building any rate sheet.

Everything below is drawn from the repo's own captured knowledge. Primary sources, all cited inline:

- `docs/longterm/RATE-SHEET-KNOWLEDGE.md` — the Deephaven "Corr Flow" DSCR tab, block by block.
- `docs/longterm/LENDERPRICE-RESPONSE-SCHEMA.md` — the `searchRaw` response schema (from a real 5.1 MB capture).
- `src/longterm/lenderprice/client.js` — the LP parser (`parse`, `parseFull`, `parseDisqualified`, `buildSearchPayload`).
- `src/longterm/ppe/lp-normalize-full.js` — the rich LP-side normalizer into our canonical integer units.
- `src/longterm/ppe/deephaven-grid.js` — the Excel grid → stored-sheet converter (the sign rule + N/A-is-ineligible rule).
- `src/longterm/ppe/ratesheet.js` — stored sheet → priceable `program`.
- `src/longterm/ppe/pricing.js` — the numeric pipeline (units, sign, floor/cap, round-once).
- `src/longterm/ppe/quote.js` — cap-tier selection (max price by loan size), floor resolution.
- `src/longterm/ppe/settings.js` — the milli-unit constants (margin 250, floor 98000).
- `src/longterm/ppe/disqualify-crosswalk.js` + `disqualify-analysis.js` — decline reason → eligibility predicate.

> **Investor names are STAFF-ONLY.** Deephaven / Lender Price and every investor name here are internal
> engineering knowledge — never surfaced on a borrower or TPO surface (`src/longterm/audience.js`).

---

## 1. Vocabulary + mechanics, stated correctly

Earlier notes said "par rate → base rate → final note rate." **That is wrong** and is banned in
`pricing.js`. A rate sheet has a **rate axis** (rows) and a **price axis** (what a chosen rate is worth).
Pricing moves along the PRICE axis; you never invent new rates.

| Term | What it is |
|---|---|
| **Coupon / Note rate** | The interest rate the borrower pays (e.g. 6.750%). The ROW label on the sheet. "Coupon" = "note rate". |
| **Price** | Quoted as a **percent of the loan amount**. **Par = 100.000.** Above par (102.850) = premium/rebate/lender credit; below par (98.500) = discount (borrower pays points). |
| **Base price / base pricing** | The price for a coupon at a lock period, BEFORE any adjustments — the raw grid cell. |
| **Price adjustment / LLPA / add-on** | A plus/minus to the **PRICE in points**, driven by loan attributes (FICO, LTV/CLTV, DSCR band, purpose, prepay, property, units, loan amount, credit history, state…). On a DSCR sheet these adjust **price, not rate**. |
| **Final / net / adjusted price** | `base price + Σ price adjustments`, then bounded by **Max Price** (ceiling) and **Min Price** (floor). |
| **Max price (cap)** | The ceiling on the final price. On Deephaven it is **tiered by loan size** (≤$1.5M / ≤$2M / ≤$3M …). |
| **Min price (floor)** | The floor on the final price. Deephaven: **98.000**. |
| **Margin (ours)** | Our correspondent spread, applied **to price, not rate**: a flat **0.250 subtracted from price**, across the board (`Lender Price price = investor sheet price − 0.25`). |
| **Buy-up / buy-down** | Moving to a higher/lower coupon to trade rate for price. |
| **Points** | `points = 100 − price`. Premium (102.85) = NEGATIVE points (−2.85); discount (98.5) = POSITIVE points (+1.5). |

**The stacking chain (the ONE mental model):**

```
choose a COUPON  →  read its BASE PRICE  →  apply Σ LLPAs  →  FINAL PRICE (rounded, then capped/floored)
```

The rate is *chosen*; the price is what gets built up and down. In LP's reporting terms this is
`points = 100 − price` — see `docs/longterm/LENDERPRICE-RESPONSE-SCHEMA.md` §4.

The engine's own worked stack (`pricing.js` header, cost-positive on price, in milli-points):

```
rawPrice = basePrice − Σ(signed LLPA cost) − margin − comp(LPC) + srp
rounded  = roundOnce(rawPrice)          # round to the increment, ONCE
final    = clamp(rounded, floor, cap)   # floor/ceiling is the LAST word
points   = 100000 − final               # (par = 100000 milli)
```

---

## 2. Anatomy of the Deephaven "Corr Flow" DSCR rate sheet, block by block

Source: `Corr_Flow_Rate_Sheet__T0__Excel.xlsx`, **DSCR tab only**. "Corr Flow" = **Correspondent Flow**
channel (we buy/deliver as a correspondent), not wholesale/broker. Verbatim from
`docs/longterm/RATE-SHEET-KNOWLEDGE.md` §2, mapped to how each block becomes engine data.

### Block A — Base pricing grid (columns B–M)

One row per **coupon** (col B: 6.125 → 9.500 in 0.125 steps). Two base-price columns:
- **Column F** = base price for **"15Y Fixed, 5/6 ARM"**
- **Column J** = base price for **"30Y Fixed"**

Example (30Y Fixed base prices, column J):

| Coupon | Base price |
|---|---|
| 6.125 | 100.100 |
| 6.500 | 101.850 |
| 6.750 | 102.850 |
| 7.000 (6.99) | 103.775 |
| 7.500 | 105.425 |

The block header names the lock (**Base Pricing (45 Day)**; the sheet also carries a 30-day and a
30-day/3-yr-prepay variant).

→ **Becomes:** `basePrices[]` rows — one per (coupon × product × lock). In `deephaven-grid.js` this is
`grid.base[]` + `grid.terms[]` + `grid.lockDays`, emitting rows shaped
`{ note_rate_milli_pct, lock_days, product, price_milli }`.

### Block B — FICO × CLTV price-adjustment grid (cols O–Z), segmented by DSCR band

The LLPA grid labelled "Price Adjustments — FICO x CLTV":
- **CLTV bands across the top** (row 12): 50 / 55 / 60 / 65 / 70 / 75 / 80 %.
- **FICO bands down column Q**: 780+, 760–779, 740–759, 720–739, 700–719, 680–699, 660–679, 640–659, 620–639.
- **DSCR bands segment the grid**: **DSCR ≥ 1.25**, **1.15–1.24**, **1.00–1.14**, **< 1.00** — each band has
  its own FICO×CLTV block.
- **Cell value** = the price adjustment (points) for that (DSCR band × FICO × CLTV). Better credit / lower
  leverage = premium (positive); weaker credit / higher leverage = discount (negative); **`N/A` = not
  eligible** at that combination.

→ **Becomes:** `grid.ficoCltvByDscr[]` in `deephaven-grid.js`. Each numeric cell → a **pricing adjustment**;
each `N/A`/null cell → an **ineligibility** (a decline predicate), **never a 0-point adjustment** — a 0
adjustment would happily *price* a combination the sheet forbids. This is one of the module's three
"faithful not clever" rules.

### Block C — Other price adjustments (LLPA tables)

Loan-amount tiers (`< 150,000`, `> 1.5M`, …), **purpose** (Purchase / Cash-Out, split by FICO), **prepay
term** (5/4/3/2/1-Year, No-Prepay) and **Prepay Buydown**, **Interest-Only**, **2–4 Units**, **Condo**,
**Escrow Waiver**, **Non-Warrantable**, **Rental Type** (Short-Term Rental), **rural/state**, and credit
history (**Mortgage History**, **Bankruptcy Seasoning**, **FC/SS/DIL Seasoning**).

→ **Becomes:** `grid.llpaTables[]` — each a banded predicate on a fact (loan_amount, units, …) or a single
`{predicate, adj}`. The threshold stays in its **own natural unit** (loan amount = raw dollars, never scaled).

### Caps + qual rate

- **Max Price**: tiered by loan size (≤$1.5M / ≤$2M / ≤$3M …). "Max Price includes Lender-Paid Comp, if applicable."
- **Min Price: 98.000** (the floor).
- **Qual Rate**: "Max (Fully Indexed, Note Rate)" — the qualifying rate for the DSCR calc.

→ **Becomes:** `grid.priceLimit = { minPrice, capTiers[], roundingMode, roundingIncrement }`.

### The sheet's math for a scenario (verbatim §2)

```
final price = base price(coupon, product)
            + FICO×CLTV adj(DSCR band, FICO, CLTV)
            + Σ other LLPAs (purpose, prepay, IO, units, condo, loan amount, credit history, state…)
final price = clamp(final price, MIN_PRICE=98.000, MAX_PRICE_tier)
```

### How each Deephaven block maps to an engine outcome

| Deephaven block | Becomes | Engine artifact |
|---|---|---|
| Block A base grid (coupon × product × lock) | **base prices** | `basePrices[]` → `baseGrid[]` (`ratesheet.rateSheetToProgram`) |
| Block B numeric cell (DSCR × FICO × CLTV) | **pricing adjustment (LLPA)** | `adjustments[]` (dimension `fico_cltv_dscr`) |
| Block B `N/A` cell | **eligibility decline** | `ineligibilities[]` (kind `eligibility`) |
| Block C LLPA tables | **pricing adjustments (LLPA)** | `adjustments[]` (banded predicate on the fact) |
| Max Price tiers | **price cap** | `priceLimit.capTiers[]` (selected by loan size) |
| Min Price 98.000 | **price floor** | `priceLimit.floorMilli = 98000` |

---

## 3. The Lender Price RESPONSE anatomy — where each piece lives

Request: `POST /rest/v1/lp-ppe-integration/pricing/searchRaw/{companyId}/{userId}` with the full
default-search model overlaid with the scenario (`buildSearchPayload`, `client.js:1006`). We always
search **all options** (`rate:null`, `rates:[]`, `maxListingPerRate:-1`, full `rateRange`); 30-day lock via
`brokerCriteria.dayLocks=30` + `dayLocksCriteria:[30]`; the 30-year term via `termsCriteria:[30]`,
`termsInMonths:false`. Disqualify is a **two-phase async flow**: kick off with
`showDisqualify/showDisqualifyRules/disqualifyAsync/fillLenderMap=true` + `cachedDisqualified:false`, then
re-send the identical body with `cachedDisqualified:true` until `results.disqualifiedData` populates.

### 3a. Top-level containers (`results.*`) — `LENDERPRICE-RESPONSE-SCHEMA.md` §2

| `results.*` key | Meaning |
|---|---|
| `qualifiedNonQMData` | Grouped tree of QUALIFIED non-QM (DSCR) priced options — **this is the DSCR one we read** |
| `qualifiedQMData` | Grouped tree of QUALIFIED QM options |
| `disqualifiedData` | Grouped tree of DECLINED programs + the failing rules (populated only after the async poll completes) |
| `qualifiedNonQMLenders` / `disqualifiedLenders` / … | Objects keyed by **lender name** |
| `lenderDtos` | `{ lenderDtoQm[], lenderDtoNonQm[], lenderDtoDisq[], sponsoredLenderDto[] }` — each `{id,name,shortName,ratePeriodId,rateGrids}` (**investor identity**) |
| `programs`, `baseSearch`, `sponsoredData` | Program metadata, the resolved search, sponsored tree |

**The grouped tree** (`*Data`) nests **Program → Rate → Lender → leaf**. Group node:
`{ key:[…], keyLabel:"<value>", type:"<dimension>", plenderId:"\"<id>\"", childs:[…], leafs:[…] }`. The
`type` names the dimension and `keyLabel` carries its value: `CriteriaFromLineResultKey` → program name,
`RateKey` → the rate, `LenderKey` → lender name. `plenderId` (JSON-quoted) maps into `results.lenderDtos.*`.
The deepest nodes carry **`leafs[]`** — one leaf = one priced option, self-describing (each leaf also
carries `companyName` + `companyId` + `programName`).

Walked by `collectOptions` (`client.js:1210`): it descends `childs`, tracks program (`CriteriaFromLineResultKey`)
and lender (`LenderKey`) context, and reads identity off the leaf first, falling back to the group `keyLabel`.

### 3b. The priced leaf — the price build (`LENDERPRICE-RESPONSE-SCHEMA.md` §3; `priceBuildOf`, `client.js:1151`)

`priceBuildOf(leaf)` reads (LP passes its own magnitudes — a rate as a percent, points as points):

| Our `priceBuild` field | LP leaf field(s) | Meaning |
|---|---|---|
| `parRate` | `undiscountedRate` / `startedAdjustedRate` | The un-bought-down (par) rate |
| `baseRate` | `baseRates` / `rawRates` | Base note rate for the rung |
| `rateAdjustment` | `adjustmentRates` | Rate adjustment total |
| `noteRate` | `rate` / `adjustedRates` | **The coupon (rung)** |
| `basePoints` | `basePoints` / `rawBasePoints` | **Base price as points** (from the lender's rate grid) |
| `adjustmentPoints` | `adjustmentPoints` | **The LLPA stack total, in points** |
| `adjustedPoints` | `adjustedPoints` | **Final points** = base + adjustments |
| `borrowerPaidPoints` | `adjustedPointsBorrowerPaid` / `borrowerPaidPoints` | Final points, borrower-paid |
| `price` | **derived** `100 − adjustedPoints` (else `PRICE_KEYS`) | **Final/net price** (par = 100) |
| `priceDerivedFromPoints` | (flag) | True when price was computed from points (no explicit price field) |
| `apr`, `apor` | `apr`/`notRoundedAPR`, `apor` | APR / Average Prime Offer Rate |

So the reconstruction is **`price = 100 − adjustedPoints`**, and `basePoints ↔ sheet base price`,
`adjustmentPoints ↔ Σ LLPAs`, `price ↔ final price`. This maps 1:1 onto `pricing.priceRung`'s record.

### 3c. The itemized LLPA stack — `groupAdjustmentProperties[]` (§3, "the crown jewel")

An array of adjustment GROUPS, each:

```
{ name: "Adjustments - DSCR Interest Only", type: "RATE"|"POINT",
  totalAdjustment: 0.75, finalAdjustment: 0.75,
  adjustments: [ { key: "DSCR - Interest Only / LTV >75.01% <= 80.0%",   // the human reason
                   adjType: "SimpleRateAdjustment", type: "LLPA",
                   valueType: "Points", adj: 0.75, llpa: 0.75 } ],
  qualifyAdjustments: [], disqualifyAdjustments: [], hideDisqualifyAdjustments: [] }
```

Each inner `adjustments[].key` is the reason (a FICO/LTV/CLTV band, IO, DSCR band, cash-out…); `adj`/`llpa`
is the value in points. `groupRateAdjustmentProperties[]` is the same but for RATE adjustments.
`overrideLLPA {pointAdjs[], rateAdjs[], executionType}` holds manual overrides.

`flattenAdjustments` (`client.js:1119`) flattens each group into
`{ group, reason, adjType, type, valueType, value }` where `reason = a.key || a.name || group` and
`value = num(a.llpa != null ? a.llpa : a.adj)`. Point LLPAs → `option.adjustments[]`; rate LLPAs →
`option.rateAdjustments[]`.

### 3d. Margin / holdback — `holdBackResult` (§3; `holdbackOf`, `client.js:1137`)

```
holdBackResult.{ broker | lender | investor }.adjustments[] =
   [ { key: "NDC Margin - 0.25%", type: "Margin", valueType: "Points", adj: 0.25 } ]
```

`holdbackOf(leaf)` walks `broker` / `lender` / `investor`, mapping each to
`{ reason: a.key||a.name, type, valueType, value: num(a.adj ?? a.llpa) }`. This is the margin the
broker/lender keeps. Also carries `.qualifications` / `.disqualifications` per party.

### 3e. Disqualified tree — `disqualifiedData` (§5; `disqualifyRulesOf` + `parseDisqualified`, `client.js:1419/1442`)

Same **Program → Rate → Lender** tree. Each declined leaf carries `disqualified:true` and the failing rules
in **`groupAdjustmentProperties[].disqualifyAdjustments[]`** (each `{ key:"<rule>", adjType:"<type>", llpa/adj }`),
plus `conditionActions[]` and `holdBackResult.*.disqualifications[]`.

`disqualifyRulesOf(leaf)` collects, in order: every `disqualifyAdjustments` / `hideDisqualifyAdjustments` /
`qualifyAdjustments` `{key, adjType, value}`, then `conditionActions[].{message|description|key|name}`, then
`holdBackResult.*.disqualifications[]`, and only if all are empty falls back to a defensive reason-string
sweep (`REASON_KEYS`). `parseDisqualified(raw)` returns
`{ ready, lenderCount, itemCount, reasonCount, lenders:[{ lender, investor, lenderId, items:[{ program, product, rate, reasons:[{rule, group, adjType, value}] }] }] }`.
`ready` is `hasDisqualifyData(raw)` (the async poll finished).

### 3f. Investor identity — `lenderDtos` (`lenderDtoMap`, `client.js:1108`)

`lenderDtoMap(R)` builds `id → {id, name, shortName, ratePeriodId}` from `lenderDtoQm` + `lenderDtoNonQm` +
`lenderDtoDisq` + `sponsoredLenderDto`. Each option resolves `plenderId` (unquoted) → dto →
`investor = dto.name`, `lenderShort = dto.shortName`. The **lender** is `leaf.companyName`; the **investor**
is the resolved dto name.

### 3g. Rate-sheet provenance / staleness — `ratePeriod` (`rateSheetOf`, `client.js:1252`)

**Measured finding:** 37–61% of a real board can be priced off **EXPIRED** rate sheets (whole lenders at a
time — one capture had AD Mortgage showing the *best* rate on the board, entirely expired). Every leaf
carries `expired`; `ratePeriod.validAsOf` stamps the sheet. `rateSheetOf` surfaces
`{ expired, validAsOf, rateValidDate, name, id, parentInvalid }` per rung, and `parse`/`parseFull` report a
board-level `pricedAt` + `rateSheets` summary. Nothing is filtered — the rule is fail-closed and SAY SO; a
human decides.

### 3h. The crosswalk table — rate-sheet concept → our stored field → Lender Price response path

| Rate-sheet concept | Our stored / canonical field | Lender Price response path |
|---|---|---|
| Coupon / note rate | `basePrices[].note_rate_milli_pct` (milli-pct); rung `rate` | `priceBuild.noteRate` ← leaf `rate` / `adjustedRates` |
| Par (un-bought-down) rate | (n/a — we grid per coupon) | `priceBuild.parRate` ← `undiscountedRate` / `startedAdjustedRate` |
| Base rate | `baseRateMilli` (milli-pct) | `priceBuild.baseRate` ← `baseRates` / `rawRates` |
| Base price | `basePrices[].price_milli`; `priceRung.basePriceMilli` | `priceBuild.basePoints` ← `basePoints` / `rawBasePoints` (price = 100 − basePoints) |
| Σ LLPAs (stack total) | `priceRung.adjustmentPointsMilli`; `adjustmentPointsMilli` | `priceBuild.adjustmentPoints` ← `adjustmentPoints` |
| Itemized LLPA (each) | `adjustments[]` `{code, dimension, adj_milli, unit, reason}`; normalized rung `llpas[]` `{reason, adjType, group, valueMilli}` | `groupAdjustmentProperties[].adjustments[].{key, adjType, type, valueType, adj/llpa}` |
| Itemized RATE LLPA | rung `rateLlpas[]` | `groupRateAdjustmentProperties[].adjustments[]` |
| Final / net price | `priceRung.finalPriceMilli`; rung `priceMilli` | `priceBuild.price` = `100 − adjustedPoints` |
| Final points | `priceRung.finalPointsMilli` | `priceBuild.adjustedPoints` ← `adjustedPoints` |
| Margin (ours / holdback) | `priceRung.marginMilli` (setting `pricing.correspondent_margin_milli`=250); rung `marginMilli` + `marginByTier` | `holdBackResult.{broker,lender,investor}.adjustments[].{key,type,valueType,adj}` |
| Max price (cap) | `priceLimit.capTiers[]` → `capForLoanAmount` → `priceRung.capMilli` | (Deephaven sheet tiers; LP embeds it in `price`. Max-price note in leaf `rateGrid.caps`) |
| Min price (floor) | `priceLimit.floorMilli` = 98000 (`pricing.price_floor_milli`) | (Deephaven sheet; LP embeds it in `price`) |
| Eligibility DECLINE (N/A cell / rule) | `ineligibilities[]` (kind `eligibility`); overlay rule from crosswalk | `disqualifyAdjustments[].{key, adjType}` |
| Investor identity | option `investor` / `lenderShort` | `lenderDtos.*` via `plenderId` (`lenderDtoMap`) |
| Rate-sheet provenance | rung `rateSheetValidAsOf` / `expired` | leaf `ratePeriod.{validAsOf, name, id}` + `expired` |
| Interpolated between rungs | `priceRung.interpolation`; rung `interpolated` | leaf `interpolated` / `interpolationTarget` |

The rich normalizer `lp-normalize-full.js` turns a `parseFull` option into a canonical **rung** (all in our
integer milli units): `rungOf` → `{ rate, priceMilli, baseRateMilli, basePointsMilli, adjustmentPointsMilli,
marginMilli, marginByTier, llpas[], rateLlpas[], disqualified, interpolated, expired }`. Margin sums the
**lender + investor** holdback tiers (the broker tier is TPO/wholesale, excluded from the total).
`normalizeLpDisqualified` shapes the declined tree into
`{ ready, declined:[{ lender, investor, program, reasons:[{rule, adjType}] }] }`.

---

## 4. The DISQUALIFY training insight — decline → eligibility predicate

Source: `src/longterm/ppe/disqualify-crosswalk.js` + `disqualify-analysis.js`. When Lender Price declines a
program it says WHY in a **structured line**, and the key insight is:

> **The `adjType` is the DIMENSION** (which rule failed). **The `key` text carries the THRESHOLD + operator.**
> So a disqualification maps to an **eligibility predicate that fires on the SAME bad condition** the loan hit.

Examples (from `disqualify-crosswalk.js` header):

```
{ key: "FICO - below 660",                  adjType: "FicoRateAdjustment"  }  → decline when fico < 660
{ key: "Max LTV exceeded / CLTV > 80.0 %",  adjType: "CapAdjustment"       }  → decline when cltv > 80000
{ key: "Interest Only not available in NY", adjType: "StatesRateAdjustment"}  → decline when io && state = NY
```

### `adjType` → fact dimension (`ADJTYPE_FACT`)

| `adjType` | Fact / dimension | Notes |
|---|---|---|
| `FicoRateAdjustment` | `fico` | Threshold is a raw score |
| `CapAdjustment` | `ltv_cap` | An LTV/CLTV ceiling; which ratio comes from the text |
| `StatesRateAdjustment` | `state` | A state restriction, sometimes combined with a feature (IO, cash-out) |
| `DscrRateAdjustment` | `dscr` | |
| `LoanAmountRateAdjustment` | `loan_amount` | |
| `LtvRateAdjustment` | `ltv` | |
| `CltvRateAdjustment` | `cltv` | |

### The key text carries threshold + operator (`inferOperator` + `firstNumber`)

`inferOperator` collapses two text styles to the **decline side**:
- **States the FAILING condition** ("below 660", "CLTV > 80") → use as-is (`below/under/less than` → `lt`;
  `exceeded/above/over/greater than` → `gt`; explicit `<=`/`>=`/`<`/`>` first).
- **States the REQUIREMENT** ("Minimum FICO 680", "Max LTV 80%") → decline on the OPPOSITE side
  (`minimum/min/at least` → `lt`; `maximum/max/up to/no more than` → `gt`).
- No readable direction → **null** → the caller REFUSES rather than guess a side.

`firstNumber` reads the first number (honoring `$` and thousands commas). `findState` takes only genuinely
UPPERCASE 2-letter tokens (so "in" never reads as Indiana). `featureLeaf` recognizes `interest only`/`io`
(→ `{io: true}`) and `cash out` (→ `{purpose: 'cashout'}`).

### `keyToPredicate` output + confidence

- **`{ ok:true, fact, predicate, confidence, matchedBy, reasonText }`** — a leaf `{fact, op, value}` (or an
  `{all:[…]}` for state+feature). `confidence:'strong'` when the adjType classified the dimension AND the
  text yielded operator+threshold; `'possible'` when it fell back to a conservative TEXT-only classification
  (a human still confirms).
- **`{ ok:false, needsHumanCrosswalk:true, reasonText, why }`** — an unrecognized `adjType` or unparseable
  threshold. **NEVER guessed** — surfaced for a human to add to the map. An over-eager guess would author a
  wrong eligibility rule that silently declines good loans (the curated-not-guessed discipline).

### The analysis half (`disqualify-analysis.js`)

`analyzeDisqualifications(parseDisqualified(raw))` groups by **investor** and produces, per investor, the
**distinct** disqualification rules LP applied — each turned into a SUGGESTED overlay eligibility rule our
engine could adopt so it declines exactly what LP declines. Output shape:

```
investors:[{ investor, lender, lenderId,
  suggestions:[{ code, kind:'eligibility', source:'overlay', when:<predicate>,
                 declineReason:<verbatim key>, adjType, fact, confidence, matchedBy, programs[], occurrences }],
  unmapped:[{ reasonText, adjType, why, programs[], occurrences }] }]
```

DISCIPLINE: a suggestion is a PROPOSAL; **nothing is written to a program's rules here**. A human accepts
(never auto-applied); the accept-and-write loop (P6/P7) persists it. `suggestionCode(fact, reasonText)` is
deterministic (`disq_<fact>_<slug>`), so re-running never mints a second code for the same rule. Distinct
identity of a disqualification = its verbatim `key` + `adjType`.

**So the full round trip is:** LP declines a program → `disqualifyAdjustments[].{key, adjType}` →
`keyToPredicate` maps `adjType`→dimension + `key`→(operator, threshold) → an eligibility predicate on the
same bad condition → suggested as an overlay rule for that investor → human accepts → our engine now
declines exactly what LP declined. This is how "every ineligibility" gets captured.

---

## 5. UNITS + SIGN — the conventions that keep a wrong number off the sheet

### 5a. The integer milli convention (`pricing.js` header; `settings.js`)

**Everything is an integer in MILLI (thousandths), never a float.** Floats are refused outright
(`assertMilli` throws `pricing:X_not_an_integer_milli` on a non-integer — a non-integer means the caller
mixed units). Summing signed integers stays associative and never drifts.

| Quantity | Milli convention | Example |
|---|---|---|
| **Rate** | milli-**percent** | 7.125% → **7125**; note rate 6.750 → 6750 |
| **Price** | milli-**points** | 102.850 → **102850**; par 100 → **100000** |
| **Points / adjustment** | milli-**points** | 0.250 point → **250**; 1/8 point → 125 |
| Price floor | milli-points | 98.000 → **98000** (`pricing.price_floor_milli`) |
| Correspondent margin | milli-points | 0.250 → **250** (`pricing.correspondent_margin_milli`) |
| Default rounding increment | milli-points | 1/8 point → **125** (`pricing.rounding_increment_milli`) |
| FICO | **raw score** (NOT milli) | 780 → 780 |
| LTV / CLTV | milli-**percent** | 75% → **75000**; 80% → 80000 |
| DSCR | milli | 1.25 → **1250**; 1.00 → 1000 |
| Loan amount | **raw dollars** (NOT milli) | $150,000 → 150000 |
| State | 2-letter code | NY |
| IO | boolean | true |

Constants: `PAR_MILLI = 100000`, `DEFAULT_ROUNDING_INCREMENT_MILLI = 125` (`pricing.js`). The LP→canonical
scale is a **parameter** in `lp-normalize-full.js` (`rateScale`/`priceScale`, default 1000) — not baked-in;
pass a different scale if a live capture proves it. `milli(v, scale) = Math.round(v * scale)`.

The unit conversion in `deephaven-grid.js` (proven by the pricing fixture): FICO bands **pass through raw**;
CLTV → the engine's `ltv` fact **scaled** (75% → `ltv_max` 75000); DSCR **scaled** (1.25 → `dscr_min` 1250);
a loan-amount threshold stays **raw dollars**.

### 5b. The SIGN convention — the #1 place a reconstruction breaks (`pricing.js` §5.2; `deephaven-grid.js`)

The engine uses the **COST-POSITIVE convention on PRICE**:

```
price = base_price − Σ(signed LLPA) − margin − comp(LPC) + srp
```

- A **positive LLPA is a COST** → it LOWERS the price (raises points the borrower pays).
- A **negative LLPA is a CREDIT** → it RAISES the price.
- **Margin** and **LPC comp** LOWER the price; **SRP** (servicing value) RAISES it.
- Each adjustment carries its own signed value AND its convention in the trace — a global sign is never
  inferred after the fact.

**The sheet-to-engine sign flip** (`deephaven-grid.js` `priceAdjMilli`): a rate-sheet **cell** is a PRICE
adjustment where a **POSITIVE value is a PREMIUM that IMPROVES the price** (better credit / lower leverage).
But the engine works in points where a stored `adj_milli` is **SUBTRACTED from the price**. The two are
OPPOSITE, so a sheet value V (premium-positive) becomes engine **`adj_milli = −V`**:

```js
function priceAdjMilli(sheetValue, scale) { return milli(-sheetValue, scale); }
```

> Getting this backwards flips every price on the sheet. Fixtures pin it: a DSCR adj `+250` prices
> "102.850 − 0.250"; a FICO adj `−125` prices "+0.125". Proven end-to-end in the grid test.

`normalizeAdjustment` (`pricing.js`) also normalizes the **unit**: `unit:'points'` (default) means `adjMilli`
is already a signed cost in points (`costMilli = +adjMilli`); `unit:'price'` means a signed price delta
(`costMilli = −adjMilli`). The original is always retained in the trace (`sourceMilli`), never inferred.

### 5c. Floor/ceiling LAST, round ONCE (`pricing.js` §5.2; `quote.js` cap selection)

Adjustments accumulate, then the price is **rounded ONCE** to the declared increment (default 1/8 point =
125 milli; modes `nearest`/`up`/`down`/`half_even`/`none`), then **clamped to [floor, cap]** — the clamp is
the true last word so a rounded value can never escape its bounds. `clamped` and `finalPointsMilli` are
recorded.

**Max price is tiered by loan size** (`quote.capForLoanAmount`): a tier `{uptoLoanAmount, capMilli}` caps
loans AT OR BELOW `uptoLoanAmount`; the first tier the amount fits under wins; above every tier → uncapped.
**Min price** resolves from the program's `priceLimit.floorMilli`, else the setting `pricing.price_floor_milli`
(98000). One subtle trap recorded in `ratesheet.js`: the DB column `rounding_mode` speaks the *settings*
vocabulary (`nearest_eighth`) while the pricer speaks `nearest|up|down|half_even|none` — `translateRoundingMode`
is the ONE place that bridges them (via `resolveRounding`), so a schema-default sheet doesn't throw
`pricing:bad_rounding_mode:nearest_eighth` on every quote.

### 5d. The output IS the reconstruction record (`pricing.priceRung`) — maps 1:1 to LP's `priceBuild`

`priceRung(input)` returns not a bare number but the full record: `basePriceMilli` / `basePointsMilli`
(Layer 1); itemized `adjustments[]` + `adjustmentCostRawMilli` / `adjustmentCostMilli` / `adjustmentPointsMilli`
(Layer 2, verbatim + normalized); `srpMilli` / `marginMilli` / `compMilli` as SEPARATE components (Layers 3–5,
never folded silently); `rawPriceMilli` → `roundedPriceMilli` → `finalPriceMilli` / `finalPointsMilli`;
`floorMilli` / `capMilli` / `clamped`; and `interpolation` provenance. This is exactly what the parity harness
reconciles against LP's `priceBuild` — the "before we build any rate sheet, agree with Lender Price" contract.

---

## Appendix — the margin agreement, verified

`RATE-SHEET-KNOWLEDGE.md` §4 records the owner-stated rule, **verified live 2026-08-16** against the Deephaven
DSCR sheet: `Lender Price price = investor sheet price − 0.25`, because **0.25 is our correspondent margin,
applied to PRICE (not rate), across the board, to the BASE price before LLPAs.** All 28 coupons matched
exactly 0.250 (a couple read 0.251 purely from 3rd-decimal workbook rounding). Worked example: if the sheet
shows **6.75% at 102.0**, Lender Price shows **101.75** for the same scenario — 0.25 lower on price, same rate.
The margin is `pricing.correspondent_margin_milli` = 250 (milli-points), and in an LP response it appears as
the `holdBackResult` NDC-margin line the normalizer sums into `marginMilli`.
