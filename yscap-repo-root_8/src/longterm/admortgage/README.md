# A&D Mortgage (AIM) — the third pricing source

The Pricing Engine's third feed, beside Lender Price and LoanNEX. It prices A&D's
own products through their AIM Quick Pricer, applies our **0.25 margin holdback**,
and hands the board rows the screen cannot tell from a Lender Price row.

> **Read-only.** It logs in, reads schema, prices, logs out. It never books, locks,
> registers, or writes anything at A&D.

---

## 1. Why this one was easy, and where it is not

| | A&D (AIM) | Lender Price | LoanNEX |
|---|---|---|---|
| Auth | JSON login → cookie | OAuth2 + Basic client secret, refresh, breaker | portal login + token exchange |
| Request | 26 query params | full cloned `defaultSearch` model (a hand-built body 500s) | full app body |
| Field map | **the vendor publishes it** — `GET /program-groups/{id}` | reverse-engineered, 128 KB of it | reverse-engineered registry |
| LLPAs | **inline with the search** | inline with the search | a second `/evidences` call per quote |
| Fees / APR | **none at all** | full | partial |
| Disqualify | a 400 that **names the field** | full lender→program→rule tree, async poll | `/fails` tree with thresholds |

The whole adapter is ~4 files because AIM publishes its own schema. What it does
**not** give is fees, APR or closing costs — so an A&D row can populate a rate
board but cannot fill the PITI inputs a term sheet takes from Lender Price.

## 2. Files

| File | What |
|---|---|
| `schema.js` | Resolves our vocabulary against AIM's published schema **by label, never by a hardcoded id**. Holds the interval-sentinel rule. |
| `scenario.js` | Canonical LT scenario → AIM's 26 params. The alias tables and the DSCR banding. |
| `client.js` | Cookie session, schema cache, `price()`, the three refusal modes. |
| `parse.js` | AIM's answer → the common board the merge already consumes. |
| `capture/schemas.json` | All five groups, captured live. A **fallback** — every answer says whether the schema was live or captured. |

## 3. The rule that breaks a naive client

An `interval` field (FICO, DTI, CLTV, Loan Amount) carries `min`/`max` **and may
carry a `values[]` array**. On screen that array is a dropdown entry — DTI shows
*"Not required"*, FICO shows *"No FICO"* — and it has an id, so it looks exactly
like a list option. **It is not sent as that id.** The sentinel goes on the wire
as the number `0`:

```
12=0    → 200, prices
12=256  → 422 {"DTI":["Can not find interval value '256' in program group."]}   ← the option id
12=1    → 400 "change: DSCR >= 1.25 or DTI 00.00% - 43.00%"
```

**Every DSCR scenario fails without it**, which is the entire product we price
here. `scenario.js` forces the pairing — a DSCR income type always sends `12=0`,
whatever the caller supplied, because it is not the caller's to get wrong.

## 4. What selects a program

Three different fields do three different jobs:

- **Income Type** picks the product family. Full-doc types return the Apex/Super/Prime
  tier stack; a DSCR band returns the DSCR program. (P&L-only and WVOE drop Apex.)
- **Loan Term** picks the amortisation variant — `30 Year Fixed`, `40 Year Fixed`,
  `5/6 ARM`, `7/6 ARM`.
- **The DSCR band is a price adjustment only.** All five bands return the same program.

## 5. The DSCR ratio

AIM takes **no numeric DSCR**. The ratio is bucketed and only the bucket goes on the wire.

| Computed DSCR | Income Type sent |
|---|---|
| ≥ 1.25 | `DSCR >= 1.25` |
| 1.10 – 1.24 | `DSCR 1.10 - 1.24` |
| 1.00 – 1.09 | `DSCR 1.00 - 1.09` |
| 0.75 – 0.99 | `DSCR 0.75 - 0.99` |
| < 0.75 | `DSCR < 0.75` |

⚠️ **The rounding at the seams is ours, not A&D's.** The bands leave gaps between
`1.24`/`1.25` and `0.99`/`1.00`. We round to 2dp first, so 1.245 → `>= 1.25`. A&D
has not confirmed that is what their sheet does. One email closes it; until then
`dscrBand` is the single place it would change.

⚠️ **`DSCR < 0.75` prices BETTER than `0.75–0.99`** on A&D's live sheet — an
explicit `0.000` adjustment where the band above takes `-1.500`. Almost certainly
a gap in their sheet. Flagged, not worked around.

## 6. The price build — measured, not assumed

AIM states `discount` (points); the price is the complement. The base decomposes:

```
basePoints = discount + totalAdjustments
```

Verified across five scenarios varying prepay, FICO and LTV: **every unclipped
rung of a ladder yields one identical base per rate.** At 6.250: `1.5 + (−1.5)`,
`0 + 0`, `−0.375 + 0.375` → `0` every time.

Note the **sign**: AIM's adjustments run opposite to its discount, so a positive
adjustment *improves* the price. That is Lender Price's own convention exactly —
`adjustedPoints = basePoints − Σ adjustment values` holds on both — which is why
the two LLPA columns sit side by side with **no sign flip**.

**Where it breaks:** A&D caps the rebate (a flat `−2.500` on the measured
ladders). On a rung sitting at the cap the identity stops holding, so those rungs
carry `basePoints: null` and `evidence.appliesToThisRate: false`. A base we
cannot derive is null — never a number that reconciles to nothing.

## 7. The 0.25 margin holdback

Under the same owner rule as LoanNEX, for the same measured reason: **AIM returns
A&D's raw investor price with none of our margin in it.** Left alone an A&D quote
would read 0.25 better than a Lender Price quote for reasons that have nothing to
do with the investor.

Applied in `pricing/vendor-margin.js`, **once**, on the parsed board, before the
merge, the comparison or the quote shape sees a number. It is also **itemized**:

```json
{ "group": "Margin holdback", "reason": "YS Capital margin holdback",
  "type": "LLPA", "valueType": "Points", "value": -0.25, "ours": true }
```

Two things follow. The build still reconciles — `basePoints − Σ values` stays
exactly the final points with our line in the sum. And a reader can **see** where
it went, instead of a price 0.25 off A&D's own sheet with nothing to explain it.

`basePoints`/`basePrice` are deliberately **not** shifted: moving them would keep
the arithmetic true while making `basePrice` a number A&D never quoted.

## 8. The three refusals

| | Meaning | What we do |
|---|---|---|
| `422` | value outside AIM's published interval | mostly prevented before the call — the schema publishes the bounds |
| `400` | legal values, a rule blocks them, **AIM names the fields** | surfaced as `admortgageRefusal` — a real, synchronous disqualify reason |
| `200` + empty array | nothing fits and **AIM says nothing about why** | board note `no_programs_offered_no_reason_given` |

**A 200 does not mean a price.** That is the trap; `parse.js` never assumes it.

## 9. Configure

| Var | Required | Default |
|---|---|---|
| `AIM_EMAIL` | ✅ | — |
| `AIM_PASSWORD` | ✅ | — |
| `AIM_BASE` | | `https://aim.admortgage.com` |
| `AIM_TIMEOUT_MS` | | `30000` |
| `AIM_SCHEMA_TTL_MS` | | `1800000` (30 min) |

⚠️ **Use a service account, not a personal broker login.** A password change
silently kills the board and every call is attributed to one person. Note also
that `passwordExpired: true` does **not** gate the API — it must never be read as
a health signal.

## 10. The mapping to our Pricing Engine's fields

Every one of A&D's 26 parameters, what our **default scenario** sends on it, and
what makes it move. The defaults are the shared `pricing/scenario-defaults.js`
profile — the *same* numbers Lender Price and LoanNEX read — so the three feeds
price the same loan. Anything not listed as **ours** is A&D's own published default.

| Our scenario field | A&D field | Param | What we send on the DEFAULT scenario | When it changes |
|---|---|---|---|---|
| `occupancy` | Occupancy | `6` | `176` = Investment | Set `occupancy` — Primary Residence / 2nd Home / Investment. |
| `propertyType` | Property Type | `8` | `183` = 1 Unit SFR | Set `propertyType`. With `rural:true` it becomes SFR Rural / PUD Rural. |
| `units` | Number of Units | `13` | `257` = 1 Unit | Set `units` (1–4). Not derived from propertyType — A&D asks separately. |
| `zip` | ZIP | `29` | `_____` | Set `zip`. Optional — A&D prices without it. |
| `state` | State | `10` | `194` = Alabama [AL] | Set `state`. **Note HI and PR are absent from A&D's list.** |
| `county` | County | `35` | — | Only if you fetch it per state; A&D prices without it. |
| `newConstruction` | New Construction | `26` | `399` = 0 | Set `newConstruction`. |
| `channel` | Channel | `44` | `437` = Wholesale | Set `channel`. This is how WE trade with A&D, not a borrower fact. |
| `citizenship` | Citizenship | `4` | `155` = US Citizen / Permanent Resident | Set `citizenship` — also Non-Permanent Resident / Foreign national / ITIN. |
| `purpose` | Purpose | `7` | `178` = Purchase | Set `purpose` — Purchase / Rate-Term / Cashout. |
| `fico` | FICO | `16` | `720` | Set `fico` (620–850). Out of range is REFUSED, never clamped. |
| `term` | Loan Term | `2` | `3` = 30 Year Fixed | Set `termYears` (30/40) or `armType` (5/6, 7/6). **This is what picks the program variant.** |
| `incomeDoc` | Income Type | `5` | `169` = DSCR >= 1.25 | Set `incomeDoc`; for DSCR set `dscr` and the band follows. |
| `dti` | DTI | `12` | `0` = *Not required* | Only on a NON-DSCR income type; then set `dti` (1–55). On DSCR it is forced to 0. |
| `lockDays` | Lock Period | `18` | `366` = 30 Days | Set `lockDays` — A&D offers 15/30/45/60 only. |
| `loan` | Loan Amount | `17` | `500001` | Set `loan` ($75,000–$5,000,000). |
| `compType` | Compensation type | `45` | `440` = Borrower Paid | Set `compType`. Ours, not the borrower's. |
| `cltv` | CLTV | `15` | `70` | Set `cltv` (falls back to `ltv`). 1–90. |
| `prepayMonths` | Prepayment Penalty | `14` | `271` = 5Y PPP | Set `prepayMonths` (0/6/12/24/36/48/60). **0 survives as No PPP.** |
| `escrowWaive` | Escrow Waiver | `25` | `397` = 0 | Toggle `escrowWaive` (any shared alias). |
| `adminFeeBuyout` | Admin Fee Buyout | `28` | `403` = 0 | Set `adminFeeBuyout`. |
| `fthb` | FTHB | `22` | `391` = 0 | Toggle `fthb` — the SAME button as the other two vendors. |
| `mortgageHistory` | Mortgage History | `23` | `529` = 0x30x24 | Set `mortgageHistory`. |
| `io` | Interest Only | `9` | `192` = 0 | Toggle `io`. On A&D it is an INPUT (like Lender Price), not a product filter (like LoanNEX). |
| `shortTermRental` | Short Term Rental | `21` | `389` = 0 | Toggle `shortTermRental`. |
| `creditEvent` | Credit Event | `24` | `395` = 48+ months | Set `creditEvent`. |
| `buydown` | Temporary Buydown | `34` | `427` = None | Set `buydown` — 3-2-1 / 2-1 / 1-0. |


BASELINE QUERY (the default scenario, verbatim):

```
2=3&4=155&5=169&6=176&7=178&8=183&9=192&10=194&12=0&13=257&14=271&15=70&16=720&17=500001&18=366&21=389&22=391&23=529&24=395&25=397&26=399&28=403&29=_____&34=427&44=437&45=440
```


**Three of these are ours, not the borrower's** — Channel (`Wholesale`),
Compensation type (`Borrower Paid`) and Lock Period. They describe how we trade
with A&D, so they are named business defaults rather than silent inheritance:
changing the channel we price on is a visible one-line edit.

**Every parameter is sent on every call.** AIM is not a partial-body API — an
omitted FICO is `422 "Required property is missing"`. So a request is always the
group's published defaults with the scenario overlaid, which also means a field
A&D adds tomorrow arrives with A&D's own default rather than being dropped.

## 11. Verify


```bash
node scripts/test-lt-admortgage-pure.js     # offline, no network, no DB — 48 assertions
node scripts/aim-dump-schemas.js            # refresh capture/schemas.json (needs credentials)
```
