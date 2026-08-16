<!-- Captured PPE research brief (agent-generated, 2026-08-16). LT-only reference for the MEGA PPE build. Source: docs/longterm/PPE-MEGA-PLAN.md indexes these. -->

# How Mortgage Pricing Is Built in a PPE Rate Sheet: The LLPA Model

**Scope:** How a final rate/price is constructed bottom-up in a Product & Pricing Engine (PPE) rate sheet, with emphasis on the LLPA (Loan-Level Price Adjustment) model used by GSEs, wholesale, and non-QM/DSCR investors, and the shape of the data a PPE `searchRaw` response returns so nothing is lost when you reconstruct it.

**The one mental model to hold throughout:** *Almost everything in mortgage pricing is denominated in **price (points)**, not in rate.* A rate is chosen; a **price** is what that rate is worth. Adjustments (LLPAs) move the **price** up or down, and the price is then converted into borrower-facing points/credits or "baked into" a higher rate. Getting this price-vs-rate duality exactly right is the crux of your data model.

---

## 1. How a Final Price/Rate Is Built From the Bottom Up

Think of pricing as a stack. Each layer is a transformation applied to a **price** (expressed as a percentage of the loan amount, par = 100).

### Layer 0 — Investor/raw base rate sheet (the rate→price grid)
The investor (or the lender's secondary desk) publishes a **rate sheet**: a grid of **note rates**, each with an associated **base price**. This is the "raw price" — "the price that investors are willing to pay for a loan… the starting point before any mark-ups or mark-downs are made to a company's distribution channels" (Scotsman Guide). Every rung is a rate paired with a price like 100.125, 99.500, 102.250, etc.

### Layer 1 — Base price (par ± points)
For a chosen note rate, the grid gives a **base price**. Par = 100.000.
- **Price > 100** = premium → generates a **credit** (rebate) that can pay borrower costs or comp.
- **Price < 100** = discount → the borrower (or someone) must **pay points** to buy that rate.
- The identity that governs everything: **points = 100 − price**. A price of 99.000 = 1.000 point cost; a price of 101.500 = 1.500 points of rebate/credit.

(Scotsman Guide: "A price of 100 means the investor will pay 100 percent of the loan amount… A price of 99… means the investor will only pay… 99 percent… Borrowers would then need to pay 1 percent of the loan amount, or one point.")

### Layer 2 — LLPAs / price adjustments (the risk stack, in points)
Risk-based **add-ons** are then applied **to the price, in points** — not to the rate. Each factor (FICO, LTV, occupancy, purpose, property type, units, loan amount, DSCR band, prepay term, cash-out, condo, etc.) contributes a signed point value. They are **cumulative** ("All LLPAs are cumulative… apply to all loans that meet the stated criteria" — Fannie Mae / Homebuyer.com). The convention almost universally used on a rate sheet is a **cost** expressed as a positive adjustment that is **subtracted from price**:

> **adjusted price = base price − Σ(LLPA adjustments)**

A +0.500 LLPA (a "hit") lowers price by half a point (worse for the borrower); a negative LLPA (a credit/incentive, e.g., a high-FICO rebate) *raises* price. Watch the sign convention carefully — this is the single most common place a reconstruction breaks (see §2).

### Layer 3 — SRP / servicing value (correspondent/retail context)
**SRP (Service Release Premium)** is the price an aggregator pays for the *servicing rights* to the loan. On correspondent/retail sheets, SRP is added into price as a positive contribution (it raises the price the lender receives). On a **wholesale/broker** channel, servicing value is generally already embedded in the investor's raw price, so you often will not see a separate SRP line — instead you see broker compensation. Model SRP as its own optional price component so channel differences are captured.

### Layer 4 — Margin / corporate margin
The lender's secondary desk adds a **margin** (markup) that lowers the price shown to the originator — this is the company's profit and overhead. "Corporate margin is the money mortgage companies need to make on loans… Pricing engines add configured margins to raw investor pricing, automatically embedding profit before rates display" (Scotsman Guide). Optimal Blue markets this as "self-managed, dynamic… margin adjustments." Margin is itself often a small grid/table (by product, channel, loan amount, sometimes state). Effect on price: **subtract margin points**.

### Layer 5 — Lender/originator compensation (LOC)
- **Lender-paid compensation (LPC):** the lender pays the broker/LO a fixed comp % (e.g., 1.875%–2.75% of loan amount). This is **subtracted from price** — the borrower doesn't pay it directly but "pays" it through a higher rate, because to net par after comp you must move up the rate grid.
- **Borrower-paid compensation (BPC):** the borrower pays comp directly as a cost at closing; comp is **not** subtracted from the rate-sheet price, so the borrower can access a lower rate/better price, but writes a check (or takes it from the price as points). See §4.

### Layer 6 — Final rate / points / price presented to the borrower
After all layers, the PPE reports, for each rate rung it deems eligible:
- **Final price** (adjusted, net of everything above).
- **Final points/credit** to the borrower = 100 − final price (positive = borrower pays; negative = borrower credit).
- **Final note rate** (the rung).
- Derived borrower metrics: **APR**, **monthly P&I**, and any qualifying figures.

Because the engine prices **every rung** of the grid, the borrower/LO sees a menu: pay more points for a lower rate, or take a higher rate for a credit — a continuous trade-off along the grid (§3).

---

## 2. LLPAs, Precisely

### What they are
An LLPA is a **risk-based price adjustment** — "a risk based method to determine the fee required by Fannie Mae and Freddie Mac… Instead of denying loans to higher-risk borrowers, [they] use LLPAs to charge higher rates that reflect that risk" (Homebuyer.com). Non-QM/DSCR investors use the identical mechanism under their own matrices.

### They move PRICE (points), not the rate
An LLPA is quoted in **points of price**. A 1.250 LLPA means 1.250% of the loan amount deducted from price. The borrower can then **monetize** that hit two ways (Fannie Mae guidance via Homebuyer.com): (1) **pay it as discount points/cost at closing**, or (2) **"add the LLPA directly into the rate"** — i.e., choose a higher rate whose extra premium offsets the point hit. This is why you must store the LLPA in **points** and treat the "as-rate" version as a downstream presentation choice, not the source of truth.

### Positive vs. negative
- **Positive LLPA = a "hit"/cost** → **reduces** adjusted price → borrower pays more (points) or takes a higher rate.
- **Negative LLPA = a credit/incentive** (e.g., ≥780 FICO at moderate LTV can be a rebate) → **increases** adjusted price.

The rate sheet math is **subtractive on cost-positive values**: `adjusted price = base price − Σ(adjustments)`. If your PPE emits credits as negative numbers, subtracting a negative correctly *adds* to price. Capture each adjustment's **signed value** and treat "subtract the sum" as the invariant.

### Price/points identity (store this explicitly)
- **price 100.000 = par** (no cost, no credit).
- **points to borrower = 100 − price.** Price 98.750 → borrower pays 1.250 points. Price 101.000 → borrower gets 1.000 point credit.
- One point = **1% of loan amount** in dollars.

### Typical adjustment categories (the LLPA stack)
GSE/conventional and non-QM overlap heavily. Common axes:
- **FICO / credit score** (the "base" cell in a FICO×LTV matrix — "start with your base LLPA using the FICO/LTV matrix, then add adjustments" — Homebuyer.com).
- **LTV / CLTV** (adjustments are usually organized in LTV tiers: ≤60, 60.01–70, 70.01–75, 75.01–80, 80.01–85, 85.01–90, 90.01–95, >95 — TruthAboutMortgage).
- **Loan purpose** (purchase vs. rate-&-term refi vs. **cash-out** — cash-out is a distinct, usually large hit).
- **Occupancy** (primary / second home / **investment/NOO** — investment carries significant hits).
- **Property type** (SFR / **condo** / 2–4 **units** / manufactured).
- **Number of units.**
- **Loan amount / balance** (small-loan premiums below a floor; high-balance/jumbo tiers above a ceiling).
- **Documentation type** (full doc vs. bank statement / P&L / **NINA** — non-QM specific).
- **DSCR band** (non-QM — see §5).
- **Prepay penalty term** (non-QM — see §5).
- **Interest-only** (add-on — see §5).
- **Subordinate financing / secondary financing present.**
- **State / geography**, **ARM vs. fixed**, **escrow waiver**, **first-time buyer**, **high-balance**, etc.

Cumulative example (TruthAboutMortgage): a non-owner-occupied 4-unit stacks multiple hits; when adjustments sum to ~1.125, the effective par 4.625% moves to ~4.75% once the hit is "priced into" the rate.

### Reference LLPA matrices (authoritative)
- **Fannie Mae LLPA Matrix** (canonical grid of FICO×LTV and factor add-ons): https://singlefamily.fanniemae.com/media/7336/display (also mirrored: https://www.ncsha.org/wp-content/uploads/2015/04/llpa-matrix-1.pdf). Freddie Mac publishes an equivalent "Credit Fees" grid.

---

## 3. Base Rate vs. Note Rate vs. Adjusted Rate; the Grid, Buy-Up/Buy-Down, Interpolation

### The grid of rate→price rungs
A rate sheet is a **discrete ladder**: each **note rate** (the actual contractual rate on the note) has a **base price** for a given lock period. Example (TruthAboutMortgage, 30-yr fixed, 30-day lock): **4.625% priced at ~100** (yielding a 0.385% lender credit at that rung), while **4.500% costs 0.147 points** on the same sheet. Rungs typically step by 0.125% in rate.

- **Base rate / par rate** — the rate on the sheet whose price is closest to 100 for that scenario (the borrower's specific scenario after adjustments). "The par mortgage rate, otherwise known as the base rate… may include mortgage pricing adjustments" (TruthAboutMortgage).
- **Note rate** — the specific rung actually chosen for a priced option.
- **Adjusted rate** — the *effective* rate after LLPAs are "baked in" rather than paid as points; i.e., you climb the grid until the premium at the higher rung absorbs the LLPA cost. In the example, ~1.125 of hits pushes 4.625% → ~4.75%.

### Buying down / buying up the rate (trading points for rate)
- **Buy down (discount points):** move to a **lower** rung; its price is lower (more discount), so the borrower **pays points**. ("Selecting 4.5% would cost 0.147% in points… $294 on a $200,000 loan.")
- **Buy up (higher rate → rebate/credit):** move to a **higher** rung; its price is above par, generating a **credit** that can offset closing costs or fund lender-paid comp.

This is a continuous menu: the borrower picks the (rate, points) pair on the ladder that fits their cash and time horizon.

### Interpolated prices
Rungs are discrete (every 0.125%), but a scenario's true price may fall **between** two published rungs — especially after applying continuous margin/comp/SRP or when a requested rate isn't exactly on the grid. Engines compute an **interpolated price** by linearly blending the two nearest rungs' prices (weighted by rate distance). Practically: (a) rate-to-price interpolation between adjacent rungs, and sometimes (b) interpolation **inside an LLPA matrix** across tier boundaries (though most GSE LLPAs are step-functions, not interpolated — the cell value applies to the whole tier). **Capture whether a returned price was interpolated**, and if so between which rungs, so you can reproduce it.

---

## 4. Borrower-Paid vs. Lender-Paid Compensation

Broker/LO compensation is regulated (post-Dodd-Frank, comp cannot vary by loan terms within a plan) and it changes the price the borrower sees:

- **Lender-Paid Compensation (LPC):** The **wholesale lender pays the broker** a fixed % of the loan amount, set by the broker's comp plan (a flat % across all that lender's loans, e.g., 2.500%). That comp is **subtracted from the rate-sheet price**, so to reach par-to-the-borrower the loan must sit at a **higher rate** (whose premium funds the comp). Net effect: borrower usually sees a **higher rate but no separate origination charge**. Borrower cannot also pay the broker.

- **Borrower-Paid Compensation (BPC):** The **borrower pays the broker directly** (cash at closing or from a lender credit generated by rate). Because comp is not deducted from the sheet price, the borrower can access a **lower rate / better price**, but pays the origination charge explicitly. Comp % is again fixed per the broker's plan for that transaction.

**Modeling implication:** comp is a **channel + plan** parameter, not a per-loan negotiation. Store the comp **basis (borrower vs. lender), the comp % (or min/max/flat), and whether it was subtracted from price.** The *same rung* prices differently under LPC vs. BPC solely because of where comp lands. On correspondent/retail, replace "broker comp" with the retail LO comp and the lender's own margin; the structural role in the stack is identical.

---

## 5. DSCR / Non-QM Pricing Nuances

Non-QM/DSCR loans use the exact LLPA machinery but with additional risk axes. (DSCR = Debt Service Coverage Ratio = rental income ÷ PITIA; it's non-QM, "cannot be sold to Fannie/Freddie," so investors set their own matrices — Griffin, Stacking Capital.)

- **DSCR ratio bands.** Price improves as coverage rises. Typical bands: **≥1.25**, **1.15–1.24**, **1.00–1.14**, **0.75–0.99 (sub-1.0 / "no ratio")**. Lower DSCR = larger price hit and often LTV caps. Model as a **banded LLPA** keyed to the DSCR bucket, plus potential **eligibility cutoffs** (loan declined below a floor).
- **Prepayment penalty (PPP) term as a price adjustment.** Longer PPP = **better price** to the borrower (investor is protected against early payoff), so a shorter/absent PPP is a **cost add-on**. Representative deltas (industry aggregations; investor-specific): **5-4-3-2-1 step-down = baseline (best price)**; **3-2-1 adds ~0.125–0.25% to rate**; **1-year adds ~0.25–0.5%**; **no PPP adds ~0.5–1.0%** (Stacking Capital; corroborated by AHL, MoTheBroker). Store PPP as **structure + term**, and note that on a rate sheet the delta may be published in **price (points)** and/or as a rate add — capture both.
- **Interest-Only (IO) add-on.** An IO feature (e.g., 10-yr IO then amortizing) adds roughly **0.25–0.5% over fully-amortizing pricing** (Stacking Capital). Treat as its own LLPA line, and note IO changes the **P&I/qualifying payment** (IO payment during the IO period vs. fully-amortized).
- **Loan-amount premiums (non-QM shape).** Sweet spot roughly **$200K–$2M** at baseline; **below ~$150K adds ~0.25–0.5%** (small-loan premium); **above ~$2M adds ~0.125–0.25%** (jumbo). (Stacking Capital.)
- **Cash-out.** Adds ~**0.125–0.375%** over purchase / rate-&-term (Stacking Capital).
- Other common non-QM axes: **property type** (condo, 2–4 unit, 5–8 unit / small multifamily, short-term-rental/Airbnb), **first-time investor**, **foreign national**, **doc type** (bank statement, P&L, asset depletion, **NINA**), **reserves**, **state**, **min DSCR by product**.

**Non-QM caution for your model:** on many non-QM sheets, some adjustments are published **as rate add-ons** and others **as price hits**, and the two are sometimes mixed on one sheet. Normalize everything to **price (points)** internally where possible, but **retain the original unit** the investor published so you can reconstruct exactly.

---

## 6. Data a PPE Typically Returns Per Priced Option (so nothing is lost)

Optimal Blue's own description: *"All eligible products and rates are presented… including any adjustments, notes, and advisories, while ineligible products are also displayed along with a reason for ineligibility"* (Optimal Blue PPE). Your `searchRaw` consumer should capture, **per product and per priced rate rung**:

### Product / program level
- Investor name, program/product name and ID, channel (wholesale/correspondent/retail), lock period(s), amortization type (fixed/ARM/IO), term, ARM parameters (index, margin, caps), product-level eligibility summary.

### Per priced rate rung
- **Note rate** (the rung).
- **Base price** (raw/pre-adjustment price for that rung).
- **Base points** (= 100 − base price), if provided.
- **Adjustment stack (the LLPA itemization)** — this is the crown jewel: an **array of adjustments**, each with:
  - `description`/`reason` (e.g., "FICO 700–719 / LTV 75.01–80", "Cash-Out Refi", "Investment Property", "DSCR 1.00–1.14", "PPP 3-2-1", "Interest-Only"),
  - `category` (FICO, LTV, purpose, occupancy, property, units, loan amount, DSCR, prepay, IO, doc type, state, margin, SRP, comp…),
  - `value` (**signed**, in **points of price** — and/or in rate if that's how it was published),
  - `unit` (price vs. rate),
  - `sign convention` (cost-positive vs. credit-positive).
- **Adjusted price** (= base price − Σ adjustments) and **adjusted points** (= 100 − adjusted price).
- **Margin, SRP, and comp components** (separately, if the engine exposes them; often folded into "adjustments" or into the base — store whatever granularity is available and flag what was folded).
- **Interpolation flag** (was this price interpolated? between which rungs?).
- **Final rate / final points / final price** as presented to the borrower.
- **APR**, **monthly P&I** (and, for IO, the IO payment and the amortizing payment), qualifying payment, **PITIA** for DSCR.
- **Lock/expiration** timestamps, price-sheet effective date/time, rate-sheet version.

### Eligibility / disqualification (declined programs)
When a program is **ineligible**, the PPE returns it **with a reason** rather than dropping it. Capture:
- `status` (eligible / ineligible / eligible-with-conditions),
- one or more `disqualifyReasons` / `advisories`, each ideally with a **rule reference** and the **failing value vs. limit** (e.g., "Max LTV 80% exceeded (requested 85%)", "Min FICO 660 not met (640)", "DSCR below 0.75 floor", "Loan amount below program minimum", "State not licensed").
- Distinguish **hard fails** (ineligible) from **soft advisories/notes** (eligible but flagged) — Optimal Blue exposes both "adjustments, notes, and advisories."

**Reconstruction principle:** if you store, per rung, the **base price**, the **signed itemized adjustment array (with unit + sign convention)**, the **margin/SRP/comp components**, the **interpolation provenance**, and the **eligibility rule outcomes**, you can recompute `adjusted price = base price − Σ(adjustments)`, convert to points (`100 − price`), and reproduce the borrower-facing rate/points/credit exactly — which is precisely the invariant the whole stack is built on.

---

## Quick Reference — The Invariants to Encode

1. `points = 100 − price` (par = 100). Dollars = points% × loan amount.
2. `adjusted price = base price − Σ(signed LLPA adjustments)`.
3. LLPAs are **points of price**, cumulative; monetized either as **cash points** or by **moving up the rate grid**.
4. Positive LLPA = cost (lowers price); negative = credit (raises price). **Store the sign convention.**
5. Stack order (typical): raw investor price → LLPAs → (SRP) → margin → comp (LPC subtracts from price; BPC does not) → borrower-facing rate/points.
6. Rungs step ~0.125%; between-rung prices are **interpolated** — record provenance.
7. Non-QM adds DSCR-band, PPP-term, and IO as first-class adjustments, sometimes published as **rate** add-ons — normalize to price but keep the original unit.
8. Declined programs come back **with structured reasons** — capture rule + failing value, not just a boolean.

---

## Sources

- [Fannie Mae — Loan-Level Price Adjustment (LLPA) Matrix](https://singlefamily.fanniemae.com/media/7336/display) (mirror: [NCSHA copy](https://www.ncsha.org/wp-content/uploads/2015/04/llpa-matrix-1.pdf))
- [Homebuyer.com — Loan-Level Pricing Adjustments (LLPAs): The Deep-Dive Guide](https://homebuyer.com/learn/loan-level-pricing-adjustments)
- [The Mortgage Reports — LLPA: A Complete Guide](https://themortgagereports.com/6866/llpa-loan-level-pricing-adjustment-mortgage-rate)
- [Griffin Funding — LLPAs and how they affect DSCR rates](https://griffinfunding.com/blog/dscr-loans/loan-level-price-adjustments-llpas-what-they-are-and-how-they-affect-rate/)
- [Scotsman Guide — The Secrets of Mortgage Pricing](https://www.scotsmanguide.com/residential/the-secrets-of-mortgage-pricing/) (par=100, raw price, margin)
- [TruthAboutMortgage — Mortgage Pricing Adjustments / How to Read a Rate Sheet](https://www.thetruthaboutmortgage.com/mortgage-pricing-adjustments/) (rate→price rungs, buy-up/down, cumulative hits)
- [TruthAboutMortgage — Par Mortgage Rate](https://www.thetruthaboutmortgage.com/mortgage-dictionary/par-rate-loan/)
- [Optimal Blue — Product, Pricing & Eligibility (PPE) Engine](https://www2.optimalblue.com/product-and-pricing-for-mortgage-lenders) (eligible + ineligible-with-reason, margin adjustments)
- [Stacking Capital — DSCR Investor Loan Guide 2026](https://www.stacking.capital/articles/dscr-investor-loan-real-estate-property-types-2026.html) (PPP/IO/loan-amount/cash-out add-on magnitudes)
- [Stacking/AHL/MoTheBroker — DSCR prepayment-penalty structures](https://ahlend.com/dscr-loan-prepayment-penalties-explained/)
- [BankingBridge — Top Pricing Engines 2026](https://www.bankingbridge.com/post/the-top-5-pricing-engines-for-2026) (Lender Price / Optimal Blue landscape)

**One caveat on the numeric magnitudes in §5:** the specific point/rate deltas for DSCR bands, PPP terms, IO, and loan-amount tiers are **investor-specific** and drawn from industry aggregations, not a single authoritative matrix. Treat them as representative ranges; the actual values in any given `searchRaw` response are authoritative for that lender and should be captured verbatim from the itemized adjustment stack rather than inferred.