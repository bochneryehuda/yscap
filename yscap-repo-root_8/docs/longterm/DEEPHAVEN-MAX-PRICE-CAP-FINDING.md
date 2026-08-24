# Deephaven max-price cap — measured finding (2026-08-24)

**Owner report:** on the LT pricing engine, Deephaven shows prices far above every other
investor (e.g. 106–110 where the known Deephaven maximum rebate is 104.25), and the same
lender sometimes reads e.g. "109, then 106 at the next rate up." Lender Price normally pins
a lender's price at its maximum by adding a growing **"Max Price Cap"** LLPA.

**Verdict, measured live (read-only pricing calls, owner-authorized):** the PILOT pricer is
a faithful mirror — the wrong number comes from Lender Price's own answer, and the fix for
the cap itself belongs at Lender Price. A second, separate display bug (the "109 then 106"
signature) WAS ours and is fixed in the same commit (§38 in `lenderprice/client.js`).

## 1. The cap is missing from Lender Price's own response — Deephaven only

Default CT search (Purchase $500k / loan $375k / FICO 760 / DSCR 1.25 / SFR / ZIP 06001 /
5-yr standard prepay / 30-yr / 30-day lock), `searchRaw`, priced as the company's own login:

| Lender | priced leaves | leaves carrying a "Max Price Cap" LLPA | max price returned |
|---|---:|---:|---:|
| Acra Lending | 58 | 46 | **104.250** (pinned) |
| NQM Funding | 73 | 55 | 105.000 (pinned) |
| AD Mortgage | 30 | 22 | 102.250 |
| Oaktree | 33 | 28 | 102.750 |
| The Loan Store | 70 | 51 | 104.220 |
| ResiCentral | 239 | 159 | 104.275 |
| Onity / eResi / AmeriHome / AHL / Onslow / Bluepoint | … | capped | ≤ 106 |
| **Deephaven Mortgage** | **56** | **0** | **110.477 — uncapped** |

So Lender Price DOES compute the cap server-side, per lender, as a `CapAdjustment` line
inside `groupAdjustmentProperties` that is already summed into `adjustedPoints` — for every
lender **except Deephaven**. Same result on an NJ scenario, and unchanged when the search is
sent lender-paid or with a comp plan attached.

## 2. Why Deephaven is the exception

Every capped lender prices from its standard sheet (e.g. `Acra Lending - Corr`). Deephaven
alone prices from the tenant's CUSTOM rate period:

> `Deephaven Corr Flow Rate Sheet  - Tier 0 - Lenders with Margins - (YEB Consulting - dba YS Capital) (.250%)`

That custom sheet — the one built to carry the company's 0.250% margin — has **no
max-price-cap configured** in Lender Price. The vendor's own web bundle contains no
client-side cap logic (verified: the string "Max Price Cap" appears nowhere in their
frontend JavaScript), so their screen can only show what `searchRaw` sends; for this login
and these scenarios that is the same uncapped ladder.

**Remedy:** ask Lender Price support to add Deephaven's maximum price (104.25 per the
Deephaven rate sheet) to the custom Tier 0 "Lenders with Margins" rate period, the way it is
configured on the standard investor sheets. No PILOT code can honestly fix this: the pricer
is a mirror by owner direction (2026-08-24, "we need our system to be a true mirror for
now"), and inventing our own cap rule is exactly the parked-rules class the owner told us to
put aside. The moment Lender Price adds the cap, the board and the comp overlay pick it up
with no code change (the cap arrives inside `adjustedPoints`, and the overlay already
shifts the FINAL price — a 104.25 cap with 2 points lender-paid comp reads 102.25, the
owner's own example).

## 3. The half that WAS ours — one program name, two rate sheets (§38, fixed)

Lender Price returns ResiCentral's programs TWICE — once from `ResiCentral Non-Del Parent -
NEW` and once from `Resicentral Wholesale Parent` — two different ladders (104.275 vs
101.2 at the same coupon) under one program name. `parse()`/`parseFull()` keyed programs on
lender+program only, so the two channels' rungs merged into one ladder that read
"same lender: 104.3, then 98.5 at the next rate up" — the owner's non-monotonic signature.
Fixed: the program key now includes the vendor's own `rateGridId` + rate-period id, each
program is stamped with `rateSheetName`, and the board says which sheet a quote came from
whenever one lender quotes the same programme name from two sheets. Measured on the live
capture: 0 merged ladders after the fix (was 32 non-monotonic steps).

Guards: §13c in `scripts/test-lt-lenderprice.js` (mutation-proven — reverting the key fails
6 assertions) and PE-64a…e in `scripts/test-lt-pricer-screen.mjs`.
