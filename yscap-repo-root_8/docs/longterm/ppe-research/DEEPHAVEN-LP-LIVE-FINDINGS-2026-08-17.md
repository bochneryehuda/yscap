# Deephaven DSCR — LP live verification findings (2026-08-17)

Read-only live pricing against Lender Price (`api.digitallending.com`, company `68e4306f…`,
Deephaven sheet `Adjustments - DHM DSCR - Corr (new) ( 12.7.25) - T0,1,2,B`). Pricing/disqualify
calls only; nothing written to LP. All raw captures in this scratchpad; no source modified, no commit.

Captured data (this directory):
- `agreement-full.json` (23 MB) — the 299-scenario eligible-side agreement run, full per-scenario report.
- `agreement-full.log` — the gate report.
- `prepay-results.json` — the 5%-fixed prepay-structure sweep (step 2).
- `ladder-anchor.json` — the live Deephaven 28-coupon rung ladder (step 1 representative).
- `ineligible-results.json` / `ineligible-compact.json` — the 10 disqualify probes (step 3).

MEASURED = observed directly in an LP response this run. INFERRED = reasoned from the data.

---

## Headline (the single most important thing)

**Our built-in "confirmed subset" Deephaven sheet is CORRECT as far as it goes but INCOMPLETE.**
Its base-price ladder, FICO×CLTV grid, DSCR-band add-on and state adder match LP's real 12.7.25
Deephaven sheet **to the penny — 20,776 itemized LLPA lines matched exactly.** The E3 gate fails
(82.71%) not because the sheet is wrong, but because it is **missing four whole LLPA families** LP
prices on: **loan-amount, interest-only, escrow-waiver, and non-warrantable(-condo).** Add those
tables and the pricing side essentially closes.

---

## 1. Eligible-side agreement run (step 1)

`node scripts/test-lt-lp-agreement-run.js --filter-investor "Deephaven Mortgage" --no-disqualify
--concurrency 2` — the built-in Deephaven sheet vs LP, 299 canonical scenarios, ~57 min.

| metric | value |
|---|---|
| scenarios | 299 |
| comparable | 295 (incomparable 4, errors 0) |
| agreed | 244 |
| disagreed | 51 |
| **agreement rate** | **82.71 %** |
| gate met | **NO** |

> Note vs the "preliminary finding" that our sheet disagreed on *every* scenario with a large
> `coupon_missing_ours`: that was the **unfiltered** run comparing our 2-container subset against all
> **30** LP DSCR programs across 16 lenders. Filtering LP to `Deephaven Mortgage` (its real investor)
> is the correct comparison and yields 82.71 %. In this filtered run **`coupon_missing_ours` does not
> occur at all** — our coupon ladder matches LP's (see §1c).

### 1a. Eligibility (our engine vs LP's eligible side)

| our / LP | count | meaning |
|---|---|---|
| eligible / eligible | 274 | agree |
| **decline / eligible** | **21** | we decline; LP's *eligible* side returned a price |
| eligible / decline | 2 | NJ individual PPP (see §3) — the real divergence |
| decline / decline | 2 | agree ineligible (LTV 85, loan $3.5M) |

The 21 "we stricter" cases are **not** true disagreements: they are LP's **"leaked price"**
behaviour — LP returns a Deephaven price from a *wrong-DSCR-band container* while the correct
container declines. Step 3 (the disqualify tree, which adjudicates properly) confirms LP **also**
declines these. So the eligible-side 82.71 % *understates* true agreement, because LP's leaked
prices are counted as "LP eligible." (MEASURED for the 6 clearly-ineligible ones in §3; INFERRED for
the weak-FICO/high-CLTV edge cells, which map to the known `n/e` cells / LTV caps.)

### 1b. What our sheet is missing vs LP's real Deephaven sheet (the 30 disagreed pricing scenarios)

Itemized LLPA reconciliation across all rungs: **20,776 match**, **868 present-in-LP-but-missing-ours**,
**28 present-in-ours-but-missing-LP.**

LLPA lines LP applies that our sheet LACKS (MEASURED, by reason, count = rung-lines):

| family | LP reason (example) | lines |
|---|---|---|
| **Loan amount** | `Loan Amount - > 1,500,000` | 336 |
| **Loan amount** | `Loan Amount - > 2,000,000` | 308 |
| **Loan amount** | `Loan Amount - < 125,000` | 28 |
| **Loan amount** | `Loan Amount - < 150,000` | 28 |
| **Interest Only** | `Other - Interest Only` | 84 |
| **Escrow Waiver** | `Other - Escrow Waiver` | 56 |
| **Non-Warrantable** | `Other - Non-Warrantable / CLTV >75.01% <=80%` | 28 |

Line our sheet has that LP did NOT return: `Other - Condo / CLTV 75–80%` (28, on the
`non-warrantable condo` scenario). INFERRED: on a non-warrantable condo LP applies its
**Non-Warrantable** line, not a plain Condo line; our subset lacks the non-warrantable distinction
and falls back to a plain Condo LLPA — the same single gap seen from the other side.

The 51 disagreed decompose as: **21 eligibility (LP leaked / we correctly decline) + 30 LLPA-family
gaps.** The 4 incomparable = the 2 NJ divergences + 2 mutually-ineligible (LTV 85, $3.5 M).

### 1c. The real Deephaven rung structure LP returns (representative eligible scenario) — MEASURED

Anchor: Purchase, value $500 k, loan $250 k (CLTV 50), FICO 800, DSCR 1.25, NY 11211, 5 yr Standard PPP.
LP returns Deephaven as **two identical priced containers** — `DSCR  1.00-1.24  - 30 Yr Fixed` and
`DSCR < 1.00  - 30 Yr Fixed` — each **28 coupons, 6.125 → 9.500**. (A third container,
`DSCR >= 1.25 - 30 Yr Fixed`, appears **only in disqualified data**, never priced — the "container
label ≠ borrower DSCR band" structural quirk.) `basePoints` is constant per coupon and matches the
12.7.25 snapshot exactly:

```
rate   basePts  adjPts  adjustedPts  price       rate   basePts  adjPts  adjustedPts  price
6.125   0.150   -1.5    -1.350       101.350      7.990  -6.675  -1.5    -8.175       108.175
6.250  -0.500   -1.5    -2.000       102.000      8.125  -7.050  -1.5    -8.550       108.550
6.375  -1.050   -1.5    -2.550       102.550      8.250  -7.390  -1.5    -8.890       108.890
6.500  -1.600   -1.5    -3.100       103.100      8.375  -7.690  -1.5    -9.190       109.190
6.625  -2.100   -1.5    -3.600       103.600      8.500  -7.990  -1.5    -9.490       109.490
6.750  -2.600   -1.5    -4.100       104.100      8.625  -8.271  -1.5    -9.771       109.771
6.875  -3.075   -1.5    -4.575       104.575      8.750  -8.552  -1.5   -10.052       110.052
6.990  -3.525   -1.5    -5.025       105.025      8.875  -8.834  -1.5   -10.334       110.334
7.125  -3.975   -1.5    -5.475       105.475      8.990  -9.099  -1.5   -10.599       110.599
7.250  -4.400   -1.5    -5.900       105.900      9.125  -9.365  -1.5   -10.865       110.865
7.375  -4.800   -1.5    -6.300       106.300      9.250  -9.552  -1.5   -11.052       111.052
7.500  -5.175   -1.5    -6.675       106.675      9.375  -9.740  -1.5   -11.240       111.240
7.625  -5.550   -1.5    -7.050       107.050      9.500  -9.927  -1.5   -11.427       111.427
7.750  -5.925   -1.5    -7.425       107.425
7.875  -6.300   -1.5    -7.800       107.800
```

`price = 100 − adjustedPoints`, `adjustedPoints = basePoints + adjustmentPoints`. Here
`adjustmentPoints = −1.5` on **every** coupon; at the step-2 anchor (FICO 760 / CLTV 75) it was
−0.625, and −1.125 under Fixed 5%. So `adjustmentPoints` is a **scenario-dependent margin/NDC +
prepay layer, NOT the itemized LLPAs** — which is why the harness `coarse-ignores` `final_price` /
`llpa_total` / `margin`. The itemized `adjustments` array is the true rate sheet; a borrower-facing
net price subtracts that itemized stack from the displayed price. Full reconciliation of the margin
component was NOT achieved (as in prior runs) and remains open.

---

## 2. The "5 % Fixed" model (owner priority D33) — SOLVED, MEASURED

**It is a prepayment-STRUCTURE choice, not a separate program.** In the field registry it is
`prepayStructure: 'Fixed 5%'` → `dynamicPropertiesMap.PrePayment_Plan_Type = 'Fixed5'`, priced on the
**same** Deephaven container. Same anchor (FICO 760 / CLTV 75 / DSCR 1.30 / FL 33009), coupon 7.500,
varying only the prepay selection — the Deephaven (`lender=Deephaven Mortgage`) price:

| prepay selection | itemized prepay LLPA | Deephaven price @ 7.500 |
|---|---|---|
| No Prepay (0 mo) | `No Prepay Penalty` = **+2.000** | 103.175 |
| Fixed 3% / 36 mo | (no prepay line) | 105.175 |
| Standard step-down, 5 yr | `5 Year Prepay Penalty` = **+0.625** | 105.800 |
| **Fixed 5%, 5 yr** | `5 Year Prepay Penalty - 5%` = **+1.125** | **106.300** |

- **The 5%-Fixed LLPA credit = +0.500 points of BETTER price** vs the standard declining 5-yr PPP,
  at the same coupon and term (105.800 → 106.300). MEASURED at coupon 7.500; because it is a flat
  additive LLPA (0.625 → 1.125, a +0.500 delta), INFERRED constant across the whole coupon ladder.
- The itemized reason string literally changes (`5 Year Prepay Penalty` → `5 Year Prepay Penalty -
  5%`), confirming Deephaven recognises and prices the Fixed-5% structure distinctly.
- Economics are consistent: a harder (fixed 5%) penalty protects the investor more, so they pay a
  larger rebate. `No Prepay` is the opposite — a **−2.000** charge (worst price).
- `prepayStructure` **'Standard' = '5,4,3,2,1' = omitted default** all priced **identically**
  (105.800). Only `Fixed 5%` and `No Prepay` moved the price. So the owner is right: there are
  effectively two models — the standard soft-declining PPP and the **Fixed 5% promo worth +0.50 pt**.
- Resolves the prior doc's negative finding (§7d "prepay term did not differentiate"): with the
  correct `prepayStructure`/`prepayMonths` mapping, the prepay axis **does** differentiate.

Raw: `prepay-results.json`.

---

## 3. Ineligibility spot-check (step 3) — 9/10 AGREE, 1 DIVERGE

10 should-be-ineligible scenarios via `lp.priceDisqualified` + poll; LP's Deephaven disqualify rule
(correct band) vs our engine's `evaluateProgram` decline. **All verbatim, MEASURED.**

| scenario | LP Deephaven decline rule (correct band) | our engine reason | verdict |
|---|---|---|---|
| FICO 600 | `DSCR >=1.00, Loan Amount <=$1.5MM: Min FICO 640` | `dhvn_min_fico_tier` | AGREE |
| LTV 85 | `DSCR Doc Type: Maximum LTV 80%` | `dhvn_grid_ltv` | AGREE |
| DSCR 0.60 | `Minimum DSCR .75%` | `dhvn_min_dscr` | AGREE |
| loan $60 k | `DSCR >= 1.00, Minimum Loan Amount $75,000` | `dhvn_min_loan_ge1` | AGREE |
| loan $3.5 M | `Maximum Loan Amount $2.50 MM` | `dhvn_max_loan` | AGREE |
| DSCR 0.90 / FICO 660 | `DSCR < 1.00 …, Minimum FICO 680` (+ FICO<700 LTV 70) | `dhvn_grid_na` | AGREE |
| DSCR 0.95 / FICO 680 / LTV 76 | `DSCR < 1.00 …, FICO < 700, Maximum LTV 70%` | `dhvn_grid_ltv` | AGREE |
| DSCR 0.74 | `Minimum DSCR .75%` | `dhvn_min_dscr` | AGREE |
| DSCR 0.98 / FICO 640 / LTV 80 | `Min FICO 680` + `Max LTV 70/75%` | `dhvn_grid_na` | AGREE |
| **NJ individual, 5 yr PPP** | `Prepayment Penalty, State of NJ, 1-4 units, LLC only eligible` | **(none — eligible)** | **DIVERGE** |

Confirms the eligibility envelope: FICO ≥ 640 (≥ 680 for DSCR < 1.00), LTV ≤ 80 % (≤ 75 %, ≤ 70 %
for weak FICO on DSCR < 1.00), DSCR ≥ 0.75, loan $75 k–$2.5 M. The "leaked price" quirk reproduced —
in 7/9 ineligible cases LP still returned a Deephaven price from a wrong-band container while the
correct band declined; our engine (and the disqualify tree) agree it is ineligible.

### The one divergence — NJ individual PPP (LP declines, we allow)

- **MEASURED:** LP declines **all three** Deephaven bands for a NJ, natural-person (Individual),
  1–4 unit borrower requesting a prepay penalty: `Prepayment Penalty, State of NJ, 1-4 units, LLC
  only eligible`. LP itself enforces the NJ natural-person PPP prohibition. Our engine priced it
  **eligible**.
- **Root cause (MEASURED via controlled test):** our engine's rule is *correct* — with
  `state:'NJ'` set explicitly, `evaluateProgram` declines with `dhvn_ppp_prohibited_nj`; with LLC it
  correctly allows. The bug is that **`lpScenarioToFacts` reads `state` only from `scenario.state`
  and never derives it from the ZIP.** A realistic zip-only scenario (08701) yields `facts.state =
  null`, so *no* state-keyed rule (NJ/IL PPP prohibitions — and any state that keys the +0.375 state
  adder off `facts.state`) can fire. This is the exact class of bug the harness exists to catch.
- The 2 NJ scenarios in the battery show the identical `our=true / lp=false` signature — same cause.

---

## 4. What could NOT be determined / open items

- **Margin / `adjustmentPoints` reconciliation** — still not pinned to named components (−1.5 at the
  §1c anchor, −0.625/−1.125 at the step-2 anchor). It carries margin/NDC + the prepay credit; it is
  deliberately coarse-ignored in the gate. Net borrower-facing price requires subtracting the
  itemized stack.
- **Exact per-cell values of the missing LLPA families** (loan-amount tiers, IO, escrow-waiver,
  non-warrantable) across *all* CLTV bands — only the cells hit by the 299-scenario battery were
  captured. A focused sweep is needed to rebuild each full table before adding it to our sheet.
- **State-adder dependency on the same zip→state gap** — the DC/MA/NJ/NY +0.375 adder matched in the
  battery (those scenarios carried `state`), but a zip-only scenario would drop it too. Not
  independently stress-tested here.
- Only 10 ineligibility probes were run (bounded, per instruction); the weak-FICO/high-CLTV edge
  cells were adjudicated by inference from the eligible-side leak pattern, not all disqualify-polled.
