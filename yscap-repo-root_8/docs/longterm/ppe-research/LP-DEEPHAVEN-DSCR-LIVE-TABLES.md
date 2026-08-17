<!-- LIVE Lender Price pricing battery reconstruction (agent-generated, 2026-08-17). LT-only reference for the LT DSCR rate-sheet parity project. Owner-authorized read-only battery. Investor names (Deephaven) are staff-internal and permitted in this internal doc. -->

# Lender Price — Deephaven DSCR rate sheet, reconstructed from a live pricing battery

**What this is.** A developer-grade reconstruction of Lender Price's (LP) Deephaven Mortgage
DSCR rate sheet — base price, every LLPA table, the max/min price behavior, and the
ineligibility rules — extracted from the itemized `adjustments` (`{adjType, reason, value}`)
that LP returned across a **live, read-only** pricing battery of 161 DSCR scenarios.

Every number below is stated as **"Lender Price returned X for reason Y (value Z)"**, with the
scenario that produced it. Where a naive "DSCR-segmented FICO×CLTV grid" assumption is wrong, it
is called out explicitly.

---

## 0. Provenance & method

- **Run:** `scratchpad/lt-lp-battery.js --concurrency 2` on 2026-08-17. Read-only against LP
  (pricing + disqualify calls only; nothing written to LP).
- **Results:** `scratchpad/lt-lp-battery-results.ndjson` (161 rows, kept in scratchpad, not committed).
- **Analysis:** `scratchpad/lt-lp-analyze.js` → `scratchpad/lt-lp-analysis.txt`.
- **Outcome:** 161 scenarios — **158 eligible (priced), 0 clean-ineligible, 3 errors.** All 3
  "errors" are **client-side scenario-validation rejections, not LP behavior** (see §9).
- **The sheet LP priced against** (from every adjustment's `group`):
  `Adjustments - DHM DSCR - Corr (new) ( 12.7.25) - T0,1,2,B` — i.e. the **Deephaven ("DHM")
  DSCR Correspondent** sheet, version-stamped **12.7.25**, tiers T0,1,2,B. Re-pull will change the
  version stamp; treat the tables below as a snapshot of that sheet.
- **Base anchor scenario:** Purchase, property value $500,000, NY (ZIP 11211 / Kings), 5-year
  prepay, 30-yr fixed. FICO and loan amount (→ CLTV) swept around that anchor.

### The Deephaven program containers

LP returns Deephaven DSCR as **three program containers**, all `30 Yr Fixed`:

| Container | Appears in |
|---|---|
| `DSCR  1.00-1.24   -  30 Yr Fixed` | qualified + disqualified |
| `DSCR < 1.00  -  30 Yr Fixed` | qualified + disqualified |
| `DSCR  >= 1.25  - 30 Yr Fixed` | **disqualified data only** in this run |

**Structural surprise #1 — the container band does NOT gate by the borrower's DSCR.** On every
qualified DSCR-1.25 scenario, LP returned pricing under the **`1.00-1.24`** and **`< 1.00`**
containers (identical base grids), and **never** under the `>= 1.25` container — while the actual
DSCR-1.25 price adjustment *was* applied inside those containers (see §5). The `>= 1.25` container
carries a rule literally named `DSCR >=1.25%  only eligible on this program`, yet it is the one
container that did not surface in qualified output. **Do not treat the container label as the
borrower's DSCR band** — the real DSCR pricing is a separate additive LLPA (§5), and the container
names are loose. This also produces "leaked" prices on ineligible scenarios (§9, §10).

---

## 1. Headline structural findings (read this first)

1. **The FICO×CLTV grid is DSCR-independent.** Its cells are labeled `DSCR (All) - <FICO band> /
   CLTV <band>` (`adjType: FicoRateAdjustment`). "(All)" is literal — the same grid applies at
   every DSCR.
2. **DSCR is a SEPARATE additive band LLPA, not a segmentation of the FICO grid.** It arrives as
   its own line `DSCR Ratio - DSCR <band> / CLTV <band>` (`adjType: SimpleRateAdjustment`), added
   *on top of* the `DSCR (All)` FICO cell. This is the single most important departure from a naive
   "one FICO×CLTV grid per DSCR band" model.
3. **Only two DSCR bands carry a non-zero add-on:** `DSCR >= 1.25` (flat **+0.25**, all CLTV) and
   `DSCR < 1.00` (CLTV-segmented, **+0.75 → +2.00**). The **1.00–1.24** band is the baseline
   (no line = 0.000).
4. **State is a single grouped adder:** `DC, MA, NJ, NY` = flat **+0.375** at every CLTV;
   CA / FL / TX (and by inference everywhere else) carry **no** state adder.
5. **Adjustments are quoted independently of the displayed price.** LP's priced options expose a
   per-coupon **base-price ladder**; the itemized LLPAs are reported alongside but are **not folded
   into** the option's displayed `price` (see §3). Consuming code must subtract the LLPA stack
   itself.

---

## 2. Eligibility envelope (the box the sheet prices inside)

From the disqualify probes (§9), verbatim LP rules:

| Dimension | Boundary (verbatim rule) |
|---|---|
| **Min FICO** (DSCR ≥ 1.00) | `DSCR >=1.00, Loan Amount <=$1.5MM: Min FICO 640` |
| **Min FICO** (DSCR < 1.00) | `DSCR < 1.00 -.75, Loan Amount =< $2.0 MM, Minimum FICO 680` |
| **Max LTV/CLTV** | `DSCR Doc Type: Maximum LTV 80%` / `... Purch RT: Maximum LTV/CLTV 80%` |
| **Max LTV, weak FICO** (DSCR < 1.00) | `... FICO < 700, Maximum LTV 70%`; otherwise `Maximum LTV 75%` |
| **Min DSCR** | `Minimum DSCR .75%` (0.75 floor) |
| **Min loan** | `DSCR >= 1.00, Minimum Loan Amount $75,000` |
| **Max loan** | `Maximum Loan Amount $2.50 MM` / `DSCR >=1.00, Maximum Loan Amount $2.5 MM` |

---

## 3. BASE PRICE grid (coupon → base points) and the price-build mechanics

The two qualified containers (`1.00-1.24`, `< 1.00`) return **identical** base ladders. Base points
are constant across every scenario for a given coupon (confirmed across all 158 eligible rows).

| Note rate | basePoints | Note rate | basePoints |
|---:|---:|---:|---:|
| 6.125 | 0.150 | 7.990 | −6.675 |
| 6.250 | −0.500 | 8.125 | −7.050 |
| 6.375 | −1.050 | 8.250 | −7.390 |
| 6.500 | −1.600 | 8.375 | −7.690 |
| 6.625 | −2.100 | 8.500 | −7.990 |
| 6.750 | −2.600 | 8.625 | −8.271 |
| 6.875 | −3.075 | 8.750 | −8.552 |
| 6.990 | −3.525 | 8.875 | −8.834 |
| 7.125 | −3.975 | 8.990 | −9.099 |
| 7.250 | −4.400 | 9.125 | −9.365 |
| 7.375 | −4.800 | 9.250 | −9.552 |
| 7.500 | −5.175 | 9.375 | −9.740 |
| 7.625 | −5.550 | 9.500 | −9.927 |
| 7.750 | −5.925 | | |
| 7.875 | −6.300 | | |

**Price build, as LP reports it, per option:**

```
displayedPrice = 100 − adjustedPoints
adjustedPoints = basePoints + adjustmentPoints
```

Example (anchor, coupon 6.125): `basePoints 0.150`, `adjustmentPoints −1.25`,
`adjustedPoints −1.10`, `price 101.100`.

**Caveat — the itemized LLPAs are NOT in `adjustmentPoints`.** At the anchor the four itemized
adjustments sum to **+2.000** points (FICO 0.75 + DSCR 0.25 + State 0.375 + Prepay 0.625), yet
`adjustmentPoints` is a constant **−1.25** and tracks a **broker margin/origination** component
(the option also carries `holdback.broker = "NDC Margin - 0.25%"`, and the disqualify tree shows an
`Origination : -0.350 (Points)` line). We could **not** fully reconcile the −1.25 to a single named
component from the pricing payload. The practical consequence for LT: **the `adjustments` array is
the rate sheet; the displayed `price` is base pricing net of margin only.** To reproduce a
borrower-facing net price you must subtract the itemized LLPA stack yourself (e.g. anchor 6.125
net ≈ 101.100 − 2.000 = 99.100).

---

## 4. FICO × CLTV grid — `DSCR (All)` `FicoRateAdjustment` (points)

Rows = FICO band, cols = CLTV band, cell = the `value` LP returned. Swept at DSCR 1.25, NY, Purchase.

| FICO band | ≤50 | 50–55 | 55–60 | 60–65 | 65–70 | 70–75 | 75–80 |
|---|---:|---:|---:|---:|---:|---:|---:|
| **780+** (800 & 780 identical) | 1.000 | 0.750 | 0.625 | 0.500 | 0.125 | 0.250 | 0.750 |
| **760–779** | 0.875 | 0.750 | 0.625 | 0.500 | 0.125 | 0.250 | 1.125 |
| **740–759** | 0.750 | 0.625 | 0.500 | 0.375 | 0.125 | 0.500 | 1.500 |
| **720–739** | 0.625 | 0.500 | 0.375 | 0.125 | 0.375 | 0.875 | 1.875 |
| **700–719** | 0.250 | 0.125 | 0.000 | 0.250 | 1.000 | 1.500 | 2.625 |
| **680–699** | 0.000 | 0.250 | 0.500 | 0.750 | 1.625 | 2.500 | n/e |
| **660–679** | 0.500 | 0.750 | 1.000 | 1.250 | 2.125 | 3.750 | n/e |
| **640–659** | 2.500 | 2.750 | 3.000 | 3.375 | 3.875 | n/e | n/e |

- Exact band labels LP returns: `To 50.0%`, `>50.01 % <= 55.0 %`, `>55.01 % <= 60.0 %`,
  `>60.01 % <= 65.0 %`, `>65.01 % <= 70.0 %`, `>70.01 % <= 75.0 %`, `>75.01 % <= 80.0 %`.
  FICO bands: `780+`, `760 - 779`, `740 - 759`, `720 - 739`, `700 - 719`, `680 - 699`, `660 - 679`,
  `640 - 659`.
- **`0.000`** = both containers priced and LP returned no FICO line → a genuine zero cell (LP omits
  a 0.000 adjustment). **`n/e`** = the DSCR-matching container **declined** at that FICO×CLTV, and
  only a mismatched container leaked a price with no FICO line — treat as **ineligible**, not zero.
  The `n/e` cells (680/80, 660/80, 640/75, 640/80) are consistent with the weak-FICO LTV caps in §2
  (FICO < 700 → max LTV ≈ 70–75%).

---

## 5. DSCR-band table — `DSCR Ratio` `SimpleRateAdjustment` (points, additive)

**Applied ON TOP OF the FICO grid, not instead of segmenting it.** Rows = DSCR band, cols = CLTV.

| DSCR band | ≤50 | 50–55 | 55–60 | 60–65 | 65–70 | 70–75 | 75–80 |
|---|---:|---:|---:|---:|---:|---:|---:|
| **≥ 1.25** | 0.250 | 0.250 | 0.250 | 0.250 | 0.250 | 0.250 | 0.250 |
| **1.00 – 1.24** | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| **< 1.00** | 0.750 | 0.875 | 1.000 | 1.250 | 1.500 | 2.000 | n/e |

- `DSCR >= 1.25` is **flat +0.25 at every CLTV** (NOT CLTV-segmented).
- `DSCR < 1.00` **is CLTV-segmented** (rises 0.75 → 2.00 with CLTV).
- `1.00 – 1.24` is the **baseline** — no `DSCR Ratio` line is returned (0.000). Confirmed across the
  DSCR sweep at FICO 760 (DSCR 1.20 / 1.15 / 1.10 / 1.05 / 1.00 all returned **no** DSCR line).
- Exact reason strings, e.g.: `DSCR Ratio - DSCR >= 1.25 / CLTV >65.01 % <= 70.0 %` = 0.25;
  `DSCR Ratio - DSCR < 1.00 / CLTV >70.01 % <= 75.0 %` = 2.0.

---

## 6. STATE adjustment — `StatesRateAdjustment` (points)

One grouped reason: **`Other - State of DC, MA, NJ, NY / CLTV <band>`** = **+0.375 at every CLTV
band** (flat, not CLTV-segmented).

- Confirmed present on NY (anchor, everywhere) and on the **MA** state probe (+0.375).
- Confirmed **absent** on **CA, FL, TX** state probes (no `StatesRateAdjustment` line at all).
- **NJ was not measured directly** — the NJ probe used a ZIP/county mismatch and was rejected
  client-side before reaching LP (§9). NJ is named *in the grouped reason string*, so it is in the
  add-on group, but this run did not independently price a clean NJ loan.

---

## 7. Other LLPA families observed

All are itemized, CLTV-segmented, and additive like the tables above.

### 7a. Cash-out refinance — `FicoRateAdjustment`, reason `Other - Cash Out Refinance, FICO <tier> / CLTV <band>`
| Tier | 65–70 | 75–80 |
|---|---:|---:|
| **FICO ≥ 720** | 0.500 | 2.625 |
| **FICO < 720** | 0.750 | (not measured) |

(From Purchase / Refinance / Cash-out probes at FICO 760 & 700, CLTV 70 & 80. A plain Refinance
carries **no** cash-out line — only Cash-out does.)

### 7b. Condo — `AllCondoRateAdjustment`, reason `Other - Condo / CLTV <band>`
- Condo at CLTV 65–70 = **+0.125**. (Single anchor point; other CLTV bands not swept.)

### 7c. Loan amount — `LoanAmountRateAdjustment`, reason `Loan Amount - <tier> / CLTV <band>`
| Tier | value (CLTV band measured) |
|---|---|
| `< 125,000` | **+2.000** (55–60), **+2.250** (65–70) |
| `< 150,000` | **+1.500** (65–70) |
| `> 1,500,000` | **+0.250** (65–70) |

(From the loan-size tier probes. Loans in the ~$140k–$1.5MM range carry **no** loan-amount line.
Note the tiers are *loan-amount* buckets, not a price cap — see §8.)

### 7d. Prepay — `SimpleRateAdjustment`, reason `5 Year Prepay Penalty` = **+0.625**
- **NEGATIVE FINDING / limitation:** the `5 Year Prepay Penalty` line (+0.625) appeared on **every**
  scenario in this run **including the "No Prepay", "12 Months", "24 Months", "36 Months" prepay
  probes.** The prepay term did **not** differentiate the output — the requested prepay term was
  evidently not reflected in what LP priced (the sheet always priced a 5-year prepay). **The prepay
  axis was not measured** here; re-run with a corrected prepay mapping to obtain the true
  shorter-prepay add-ons.

### 7e. Interest-only and escrow-waiver — **no itemized line**
- The interest-only probe and the escrow-waiver probe returned adjustment sets **byte-identical to
  the anchor** — no IO-specific and no escrow-waiver LLPA line was captured. Either these are not
  priced via an itemized Deephaven LLPA in this channel, or the flags were not applied to the LP
  request. **Not established** by this run.

### 7f. Units / 2–4 family — **not measured**
- Both 2–4-unit probes were rejected **client-side** (`Unknown property type "TwoToFourUnit"`) before
  reaching LP (§9). No units/2–4 LLPA was captured. Re-run with a supported property-type token.

---

## 8. Max / min price observations (the "cap tiers / floor" question)

**Naive expectation was a ~98.000 floor and loan-size price caps. That is NOT what Deephaven's
priced options show.** The Deephaven displayed `price` is the **base-price ladder** (§3), so:

- **Deephaven displayed-price envelope across all eligible scenarios:** min ≈ **96.475**, max ≈
  **111.427** — this simply tracks the coupon ladder (top coupon = highest price), it is **not** a
  hard cap/floor.
- **Deephaven price does not vary by loan size as a cap.** At the anchor FICO/CLTV, the Deephaven
  displayed price was **identical** for $560k / $840k / $1.12M / $1.4M loans (min ≈ 100.475, max ≈
  110.552) and only shifted for the $1.68M loan (the `> 1,500,000` LLPA, §7c) and the small loans
  (the `< 150,000` / `< 125,000` LLPAs). **Loan size enters through the loan-amount LLPA, not a
  price cap.**
- **No ~98.000 floor was observed for Deephaven.** (The *all-investor* `priceMin` in the results
  drops to ~90.5 on large loans, but that is other investors' programs, not Deephaven.)

If LT needs a max-price/floor rule, it is not visible in Deephaven's LP output and would have to
come from a separate LP setting or a different investor — flag for follow-up.

---

## 9. The 3 "errors" — all client-side, NOT Lender Price

These are scenario-construction rejections by the local LP client's validator; **LP was never
asked**. They mean the corresponding axes were **not measured**, not that LP declined them:

| Scenario | Client rejection |
|---|---|
| `propertytype 2-4units` | `Unknown property type "TwoToFourUnit". The request is rejected rather than defaulted to single-family.` |
| `propertytype 3units` | same |
| `state NJ` | `ZIP 07731 is in county 34025 (Monmouth), but county FIPS 34029 was supplied. Fix the conflicting location.` |

---

## 10. Ineligibility / disqualify reasons (verbatim, per the 6 probes)

Each probe polled LP's disqualified tree (up to 90s). Reasons are LP's own strings; boilerplate
program-type tags (`NONQM`, `Conventional`, `Purchase`, etc.) and the per-loan `Origination` line
are omitted. **"Leaked price"** = a mismatched DSCR container still returned a price even though the
scenario should be ineligible (structural surprise #1).

**1. FICO 600, $350k, 70% LTV, DSCR 1.25** — *leaked a price under `DSCR < 1.00`.*
- `DSCR  1.00-1.24`: `DSCR >=1.00, Loan Amount <=$1.5MM: Min FICO 640`
- `DSCR  >= 1.25`: `DSCR >=1.25%  only eligible on this program` + `... Min FICO 640`
- → **Min FICO 640** (DSCR ≥ 1.00). FICO 600 is below it; the matching containers declined.

**2. LTV 85% (loan $425k / $500k), FICO 760, DSCR 1.25** — *fully declined (all containers).*
- `DSCR Doc Type:  Maximum LTV 80%`
- `DSCR >=1.00, Loan Amount <= $1.5 MM, Purch RT:  Maximum LTV/CLTV 80%`
- → **Max LTV/CLTV 80%.**

**3. DSCR 0.6, FICO 760, $350k, 70% LTV** — *leaked a price under `DSCR 1.00-1.24`.*
- `DSCR < 1.00`: `Minimum DSCR .75%`
- `DSCR  >= 1.25`: `DSCR >=1.25%  only eligible on this program`
- → **Min DSCR 0.75.** DSCR 0.6 is below it; the true `< 1.00` container declined.

**4. Tiny loan $60k (value $100k), FICO 760, DSCR 1.25** — *leaked a price under `DSCR < 1.00`.*
- `DSCR  1.00-1.24` / `DSCR  >= 1.25`: `DSCR >= 1.00, Minimum Loan Amount $75,000`
- → **Min loan $75,000.**

**5. Huge loan $3.5M (value $5M), FICO 760, DSCR 1.25** — *fully declined (all containers).*
- `Maximum Loan Amount $2.50 MM` / `DSCR >=1.00, Maximum Loan Amount $2.5 MM`
- → **Max loan $2.5MM.**

**6. FICO 640, LTV 80%, DSCR 0.9** — *leaked a price under `DSCR 1.00-1.24`.*
- `DSCR < 1.00`: all three of —
  - `DSCR < 1.00 -.75, Loan Amount =< $2.0 MM, Minimum FICO 680`
  - `DSCR < 1.00 -.75, Purchase RT, Loan Amount =< $1.5 MM, FICO < 700, Maximum LTV 70%`
  - `DSCR < 1.00 -.75, Purchase RT, Loan Amount =< $1.5 MM, Maximum LTV 75%`
- → For **DSCR < 1.00**: **min FICO 680**, **max LTV 75%** (and **70%** when FICO < 700).

**Caution for LT:** in 4 of 6 ineligible probes, LP still returned a Deephaven price from a
**wrong-DSCR-band container** while the correct container declined. **Do not treat "an eligible
Deephaven price came back" as "the loan is eligible for its DSCR band"** — check that the priced
container's band actually matches the borrower's DSCR, or key eligibility off the disqualify tree.

---

## 11. Summary of reconstructed tables (for the LT engine)

- **Base price ladder:** §3 (coupon → basePoints, 6.125 → 9.500; both containers identical).
- **FICO×CLTV grid** (`DSCR (All)`, DSCR-independent): §4.
- **DSCR band add-on** (separate additive, on top of the grid): §5 — `≥1.25` flat +0.25;
  `1.00–1.24` baseline 0; `<1.00` CLTV-segmented 0.75→2.00.
- **State add-on:** §6 — DC/MA/NJ/NY flat +0.375; others none.
- **Cash-out / condo / loan-amount add-ons:** §7a–c.
- **Prepay / IO / escrow / units:** §7d–f — **not established** this run (see limitations).
- **Eligibility box:** §2 / §10 — FICO ≥ 640 (≥ 680 for DSCR < 1.00), LTV ≤ 80% (≤ 75%/70% for weak
  FICO on DSCR < 1.00), DSCR ≥ 0.75, loan $75k–$2.5MM.
- **Max/min price:** §8 — no Deephaven price cap/floor observed; loan size acts via the
  loan-amount LLPA, not a cap.

**Open items to re-measure:** prepay-term differentiation, interest-only, escrow-waiver, 2–4 units,
a clean NJ loan, and the `adjustmentPoints` (−1.25) margin/origination reconciliation. Re-run the
battery with corrected property-type / prepay / NJ-geo scenarios to close these.
