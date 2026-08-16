# DSCR Rate Sheets → Lender Price (Digital Lending PPE): how pricing is built

LT-only reference. This is the pricing knowledge behind the Long-Term DSCR pricer
(`src/longterm/lenderprice/*`). It corrects earlier loose terminology, documents how a real
investor DSCR rate sheet is structured, and records the **verified** relationship between a
Deephaven DSCR rate sheet and what Lender Price returns.

> **Investor names are internal.** Deephaven and every other investor/lender name here are
> STAFF-only knowledge. Never surface an investor name on a borrower/TPO surface (see the
> product-separation + audience rules). This doc is internal engineering knowledge.

---

## 1. Terminology — say it correctly

Earlier notes said "par rate → base rate → final note rate." **That is wrong.** A rate sheet has
a **rate axis** and a **price axis**, and pricing moves along the PRICE axis, not by inventing new
rates. The correct vocabulary:

- **Coupon / Note rate** — the interest rate the borrower actually pays (e.g. 6.750%). On the rate
  sheet this is the ROW label. "Coupon" and "note rate" are the same thing here.
- **Price** — quoted as a percentage of the loan amount. **Par = 100.000.**
  - **Above par** (e.g. 102.850) = a **premium / rebate / lender credit** — money credited toward
    the borrower's costs.
  - **Below par** (e.g. 98.500) = a **discount** — the borrower pays points to get that rate.
- **Base price / Base pricing** — the price for a given coupon at a given lock period, BEFORE any
  adjustments. This is the raw grid value.
- **Price adjustment / LLPA (Loan-Level Price Adjustment) / add-on** — a plus/minus to the PRICE
  driven by loan attributes (FICO, LTV/CLTV, DSCR band, purpose, prepay term, property type, units,
  loan amount, credit history, state, …). On a DSCR sheet these adjust **price (points)**, not the
  rate.
- **Final / net / adjusted price** — `base price + Σ price adjustments`, then bounded by the
  **Max Price** (ceiling) and **Min Price** (floor).
- **Buy-up / buy-down** — moving to a higher/lower coupon to trade rate for price.
- **Margin (ours)** — the spread WE (as a correspondent) apply on top of the investor's sheet. See
  §4: for us it is a flat **0.25 subtracted from the price**, across the board.

**The chain:** choose a **coupon** → read its **base price** → apply **price adjustments (LLPAs)**
→ **final price** (capped/floored). The rate is chosen; the price is what gets built up and down.

In points terms (how Lender Price reports it): `points = 100 − price`. A premium price (102.85) is
NEGATIVE points (−2.85); a discount price (98.5) is POSITIVE points (+1.5).

---

## 2. Anatomy of the Deephaven "Corr Flow" DSCR rate sheet (DSCR tab)

Source: `Corr_Flow_Rate_Sheet__T0__Excel.xlsx`, **DSCR tab only**. "Corr Flow" = **Correspondent
Flow** channel (we buy/deliver as a correspondent), as opposed to wholesale/broker.

**Block A — Base pricing grid (columns B–M).** One row per **coupon** (column B: 6.125 → 9.500 in
0.125 steps), and two base-price columns:
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

The block header names the lock period (**Base Pricing (45 Day)**; the sheet also carries
30-day and a 30-day/3-yr-prepay variant).

**Block B — FICO × CLTV price-adjustment grid (columns O–Z), by DSCR band.** This is the LLPA
grid labelled "Price Adjustments — FICO x CLTV":
- **CLTV bands across the top** (row 12): 50 / 55 / 60 / 65 / 70 / 75 / 80 %.
- **FICO bands down column Q**: 780+, 760–779, 740–759, 720–739, 700–719, 680–699, 660–679,
  640–659, 620–639.
- **DSCR bands** segment the grid: **DSCR ≥ 1.25**, **DSCR 1.15–1.24**, **DSCR 1.00–1.14**,
  **DSCR < 1.00** (each band has its own FICO×CLTV adjustment block).
- Cell value = the price adjustment (points) for that (DSCR band × FICO × CLTV). Better credit /
  lower leverage = premium (positive); weaker credit / higher leverage = discount (negative);
  `N/A` = not eligible at that combination.

**Block C — Other price adjustments (LLPA tables).** Loan-amount tiers (`< 150,000`, `> 1.5M`, …),
**purpose** (Purchase / Cash-Out, split by FICO), **prepay term** (5/4/3/2/1-Year, No-Prepay) and
**Prepay Buydown**, **Interest-Only**, **2–4 Units**, **Condo**, **Escrow Waiver**,
**Non-Warrantable**, **Rental Type** (Short-Term Rental), **rural/state**, and credit history
(**Mortgage History**, **Bankruptcy Seasoning**, **FC/SS/DIL Seasoning**).

**Caps:** **Max Price** tiers by loan size (≤$1.5M / ≤$2M / ≤$3M …) and **Min Price: 98.000**
(the price floor). "Max Price includes Lender-Paid Comp, if applicable."

**Qual Rate:** "Max (Fully Indexed, Note Rate)" — the qualifying rate for the DSCR calc.

So the sheet's math for a scenario is:
```
final price = base price(coupon, product)
            + FICO×CLTV adj(DSCR band, FICO, CLTV)
            + Σ other LLPAs (purpose, prepay, IO, units, condo, loan amount, credit history, state…)
final price = clamp(final price, MIN_PRICE=98.000, MAX_PRICE_tier)
```

---

## 3. How Lender Price returns the same thing

Lender Price (the company's Digital Lending PPE) **reads investor rate sheets** and returns, per
lender/program, a **rate ladder** — every coupon with its built-up price. Our client parses each
priced leaf into a `priceBuild` (see `LENDERPRICE-RESPONSE-SCHEMA.md`):

- `parRate` / note rate (the coupon)
- `basePoints` → the base price as points (`100 − basePoints` = base price)
- `adjustmentPoints` → the summed LLPAs as points
- `adjustedPoints` → final points (`basePoints + adjustmentPoints`)
- `price` = `100 − adjustedPoints` (final/net price)
- itemized `adjustments[]` — each LLPA with its **human reason** (e.g. "FICO 760–779 / CLTV
  >70.01% ≤75%", "Pricing Adjustors — DSCR ≥1.25x", "State Specific Additional PPP: NJ / 60
  Months", "Prepayment Penalty LLPA — 60 Months") and its point value.

This maps 1:1 to the rate sheet: `basePoints` ↔ the sheet's **base price**, `adjustments[]` ↔ the
sheet's **FICO×CLTV grid + other LLPA tables**, `price` ↔ the sheet's **final price**.

---

## 4. Our margin: Lender Price is 0.25 cheaper on PRICE, across the board — VERIFIED

**Rule (owner-stated):** Lender Price is always **0.25 more expensive on the PRICE** than the raw
investor rate sheet — because **0.25 is our correspondent margin, applied to price (not rate),
across the board.** i.e. `Lender Price price = investor sheet price − 0.25`.

**Verified live** (2026-08-16) against this exact Deephaven DSCR sheet. Scenario: SFR purchase,
$500k value / $350k loan (70% LTV), FICO 780, DSCR band 1.00–1.24, 5-yr prepay, NJ; Lender Price's
Deephaven "DSCR 1.00–1.24 · 30 Yr Fixed" program. Comparing the Lender Price **base** price
(`100 − basePoints`) to the sheet's **30Y Fixed base** (column J) at every coupon:

| Coupon | Deephaven sheet base (30Y) | Lender Price base | Diff |
|---|---|---|---|
| 6.125 | 100.100 | 99.850 | **0.250** |
| 6.500 | 101.850 | 101.600 | **0.250** |
| 6.750 | 102.850 | 102.600 | **0.250** |
| 7.000 | 103.775 | 103.525 | **0.250** |
| 7.500 | 105.425 | 105.175 | **0.250** |
| … (all 28 coupons) | … | … | **0.250** |

**Every one of the 28 coupons: exactly 0.250.** (A couple of rows read 0.251 purely from
3rd-decimal rounding in the workbook, e.g. 108.80249999.) This confirms the margin is applied to
the **base price**, uniformly, before LLPAs — so any final priced result inherits the same −0.25.

Worked example in the owner's own terms: if the sheet shows **6.75% at 102.0** (a specific
scenario's final price), Lender Price shows **101.75** for the same scenario — 0.25 lower on price,
same rate.

**To reproduce / validate any time:**
1. Price a Deephaven DSCR scenario via `/api/lt/_diag/lenderprice/price` with `full:true` and find
   the `Deephaven Mortgage` program's `priceBuild` per coupon.
2. Decode the DSCR tab base column (F=15Y/ARM, J=30Y Fixed) for the same coupon.
3. Assert `(100 − basePoints) == sheetBase − 0.25`.
4. For a full-scenario check, add the sheet's FICO×CLTV + LLPA adjustments and compare the FINAL
   price to Lender Price's `price` (also −0.25).

---

## 5. Eligible vs Ineligible (disqualified)

A Lender Price search returns **qualified** programs (priced) AND, asynchronously, a large
**disqualified** tree — every lender/program that was declined and the RULE that failed
(e.g. "Full Doc Only", "Investment Ineligible", "Non-Warrantable Condo Ineligible", "Minimum LTV").
See `LENDERPRICE-RESPONSE-SCHEMA.md` for the tree structure and the kickoff→poll handshake
(kick off on `/price`, poll `/disqualifications/:searchKey`).
