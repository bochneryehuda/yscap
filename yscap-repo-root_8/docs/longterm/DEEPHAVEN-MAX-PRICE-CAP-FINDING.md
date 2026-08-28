# Deephaven max-price cap — measured finding (2026-08-24)

**Owner report:** on the LT pricing engine, Deephaven shows prices far above every other
investor (e.g. 106–110 where the known Deephaven maximum rebate is 104.25), and the same
lender sometimes reads e.g. "109, then 106 at the next rate up." Lender Price normally pins
a lender's price at its maximum by adding a growing **"Max Price Cap"** LLPA.

**Verdict, measured live (read-only pricing calls, owner-authorized) — three separate answers:**

1. **The uncapped Deephaven ladder is Lender Price's own** (§1–§2). Their response carries the
   cap for every other investor and not for Deephaven, because Deephaven alone prices from our
   custom Tier 0 sheet, which has no cap configured at the vendor. The remedy is a Lender Price
   support ticket; PILOT adds no cap rule of its own.
2. **The "109 then 106 on the same lender" the owner saw on the BOARD is also Lender Price's
   own, and is not an error** (§4). It is the cap working exactly as the owner described — the
   price pinned at the maximum by an LLPA that grows with the rate — followed by the
   higher-capped PROGRAMME no longer being offered at the next rate, so a lower-capped one
   becomes that lender's best. Measured on live data.
3. **A real defect of ours was found and fixed on the way** (§3, §38 in `lenderprice/client.js`):
   two rate sheets sharing one programme name were merged into a single ladder, so 4 programmes
   quoted two different prices at the same rate. That is fixed and guarded — but it is a
   different defect from what the owner reported, and it should not be described as the cause of
   the owner's symptom.

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
capture: **4 programmes quoted two prices at one rate before the fix, 0 after** — see the
correction below for the full table, and for why "non-monotonic steps" is the wrong metric.

Guards: §13c in `scripts/test-lt-lenderprice.js` (mutation-proven — reverting the key fails
6 assertions) and PE-64a…e in `scripts/test-lt-pricer-screen.mjs`.

**CORRECTION (post-merge, 2026-08-24).** The PR body and the merge commit for #1329 — and the
first version of the paragraph above — state "32 non-monotonic ladder steps before, 0 after."
**That was inferred, not measured, and it is wrong.** The measured figures on the same live
capture are:

| grouping key | programs | programs quoting TWO prices at one rate | falling steps |
|---|---:|---:|---:|
| old (`lender+program`) | 30 | **4** | 32 |
| new (`+ grid + rate period`) | 34 | **0** | 35 |

The defect §38 fixes is the **4 → 0**: a program that quoted two different prices at the same
rate because two sheets' rungs were interleaved. Falling steps are NOT the bug metric and went
32 → 35 — and all 35 are **byte-for-byte the vendor's own** (counting falls directly on Lender
Price's raw leaves under the identical grouping yields exactly 35 too). A sheet whose ladder
genuinely declines is mirrored, never corrected.

## 4. What the owner actually saw on the board — MEASURED, and it is not a defect

The owner's report was "you price on 109, and then on the next rate one higher, you price the
same lender as 106." Measured at the BOARD level (per lender, their best price at each rate) on
the live capture, a lender's best price falls at the next rate up in exactly **3** places — and
every one of them comes from a **single sheet**, i.e. straight from Lender Price:

```
NQM Funding LLC        10.5   -> 105.000     then 10.625 -> 104.000
ResiCentral Mortgage    8.875 -> 104.275     then  8.99  -> 103.650
ARC Home Loans          6.375 -> 101.774     then  6.49  -> 101.605
```

**The mechanism is the max-price cap doing exactly what the owner described, plus a programme
dropping out.** NQM's own data:

```
rate 10.375   105.000  capped (cap LLPA 3.420)  30 YR Fixed DSCR Supreme
              104.000  capped (cap LLPA 5.449)  30 YR Fixed Investor DSCR
rate 10.500   105.000  capped (cap LLPA 3.520)  30 YR Fixed DSCR Supreme     <- pinned, LLPA grew
              104.000  capped (cap LLPA 5.549)  30 YR Fixed Investor DSCR    <- pinned, LLPA grew
rate 10.625   104.000  capped (cap LLPA 5.649)  30 YR Fixed Investor DSCR
              (DSCR Supreme is NO LONGER OFFERED at this rate)
```

So the price is pinned at the maximum by a cap LLPA that grows with the rate — the owner's own
description, confirmed on live data — and the apparent "drop" is a **different programme**
becoming that lender's best once the higher-capped one stops being offered. ResiCentral is the
same shape (`DSCR Select`, capped 104.275, is absent from 8.99 up, leaving `Premier` at 103.650).

The board is therefore honest: it shows the best price each lender actually offers at each rate.
What it does not currently SAY is that the programme changed between the two rows — the sub-line
carries the programme name, but a reader scanning the price column sees only the drop. Making
that switch explicit is a presentation change and is **not** made here; it needs the owner's
direction before a mirror surface starts annotating.
