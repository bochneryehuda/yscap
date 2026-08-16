<!-- Captured PPE research brief (agent-generated, 2026-08-16). LT-only reference for the MEGA PPE build. Source: docs/longterm/PPE-MEGA-PLAN.md indexes these. -->

# Engineering Brief: Mortgage Product & Pricing Engine (PPE)

A modern PPE answers one question millions of times a day: *for this borrower/property/loan scenario, which loan products are available, and at what price?* The industry-standard name for the category is **PPE — Product, Pricing & Eligibility engine** (Optimal Blue popularized the three-letter framing; the "E" for eligibility is meaningful, not decorative). Below is the complete feature set, vendor-neutral, with vendor-specific items flagged.

## 1. Core engines: eligibility vs. pricing

The defining architectural decision is the **separation of eligibility from pricing** into two logically distinct engines that run in sequence.

The **eligibility engine** is a rules evaluator. It takes a normalized **loan scenario** (a bundle of ~50–150 attributes: FICO, LTV/CLTV, loan amount, occupancy, property type, units, purpose, doc type, DTI, reserves, citizenship, state, etc.) and answers a boolean per product: *does this scenario fit this program's guidelines?* Rules are typically expressed as predicates over attribute ranges (min/max FICO, max LTV at a given FICO, allowed states, allowed property types). Crucially, a good engine returns **ineligibility / decline reasons** — not just "no," but "declined: LTV 85% exceeds max 80% for FICO 660–679" — because loan officers need to counsel borrowers and change one variable to re-qualify. This reason-tracing is a hard requirement and a real engineering cost.

The **pricing engine** runs only on *eligible* products. It computes a final price as **base price + a stack of adjustments**. Separating the two keeps guideline logic (which changes on investor bulletins) independent of price logic (which changes intraday). Note: this is distinct from an **AUS** like **Loan Product Advisor (LPA, Freddie Mac)** or **Desktop Underwriter (DU, Fannie Mae)** — an AUS renders a credit/underwriting decision on a specific agency; the PPE's eligibility engine screens *many investors' programs* for fit and never underwrites.

## 2. Rate sheet ingestion & base pricing

Investors publish **rate sheets** — daily (and intraday) documents mapping **note rate (coupon) → price**, by **lock period**. The PPE ingests these (PDF, Excel, XML, or API feeds) and normalizes them into **base-price grids**: a matrix of coupon rows (e.g., 6.000, 6.125, 6.250…) against **lock-period** columns (**15/30/45/60-day**), where each cell is a **price** expressed as a percent of par. **Par = 100.000** (or "0.000"): the loan sells for face value. **Above par (e.g., 101.5)** is a **rebate/premium** the investor pays the lender; **below par (e.g., 98.5)** is a **cost/discount** — the borrower pays points. Distinguish **base rate** (the note rate offered) from **base price** (what that rate is worth); the grid ties them together.

Ingestion must handle **effective dating** and **intraday reprices**: when markets move, investors reissue sheets ("reprice"), sometimes multiple times a day, and the engine must swap the active grid while preserving as-of-date history. For 150+ investors × dozens of programs each, this is a large, error-prone, time-sensitive data pipeline — the single biggest operational moat of incumbents (Optimal Blue markets "thousands of rate sheets processed daily" and "system-maintained content" as its core value).

## 3. Adjustments (LLPAs)

On top of base price sits a **stack of adjustments**, generically called **LLPAs — Loan-Level Price Adjustments**. Each is a price add/subtract (in points) triggered by a scenario attribute. Two forms coexist:

- **Grid-based** adjustments: a 2-D matrix, canonically **FICO × LTV** (the classic agency LLPA grid), returning a value at the intersection.
- **Rule-based** adjustments: single-condition deltas (e.g., "cash-out: −0.500," "investment property: −2.125," "condo & LTV>75%: −0.750").

Adjustments **stack cumulatively** and are summed against base price. Engines support **cumulative caps** (total adjustments cannot exceed X points), and per-result **price caps (max price / price ceiling)** and **price floors (min price)** — e.g., "no result may price above 103" prevents paying excess rebate. A subtlety: adjustments can be applied as **price adjustments** (shift the price at a given rate) or **rate adjustments** (bump the rate itself); most are price, but some programs express minimum rate/margin floors. Agency LLPAs are set by the GSEs; investor and lender LLPAs are layered on independently.

## 4. Margin & overlay management

The lender rarely sells at raw investor price. On top of investor pricing sits the **margin** — the lender's/correspondent's profit spread, subtracted from price (worsening it) to create the lender's offered price. Margin is highly configurable: **company-level, branch-level, and LO-level** margins, plus per-**channel** (retail/wholesale/correspondent) and per-**product** margins, often stacked.

Distinct from margin are **overlays** — additional restrictions or price hits beyond the investor's own rules. **Investor overlays** are the investor's stricter-than-agency rules; **lender overlays** are the lender's own guideline tightening and price adjustments. A mature PPE exposes a **client-editable overlay layer**: the vendor maintains base investor content, and the lender edits its *own* margin/overlay/eligibility rules on top without touching (or seeing into) vendor-maintained data. This layered, self-managed configuration ("self-managed, dynamic margin adjustments" in Optimal Blue's language) is a defining modern feature.

## 5. Program & investor management

The data model is **investor → program → version**. One PPE models **many investors**, each offering **many programs**, grouped into **program families**: **Agency** (conforming), **Government** (FHA/VA/USDA), **Jumbo**, **Non-QM**, **DSCR**, **Bank Statement**, **HELOC**, **BPL/business-purpose**. Each program carries **versioning and effective dates** so historical pricing reproduces exactly and future changes stage in advance. **White-labeling** lets a lender hide or rename investor identities (show "Investor A" or a private label) — important for wholesale/broker channels. Specialist engines differ by catalog depth: **LoanNEX** and **Lender Price** are known for deep **Non-QM/DSCR** investor networks and marketplace-style discovery; **LoanSifter (ICE)** for broad wholesale best-ex across 120+ investors; agency-heavy shops lean on Optimal Blue's breadth.

## 6. Best execution / result ranking

**Best execution ("best-ex")** compares all eligible, priced results *across investors* and ranks them. Users sort by **price** (highest rebate / lowest cost at a target rate) or by **rate** (lowest rate at a target price). Two common query modes: **target rate** (fix the rate, show the price) and **target price** (fix an acceptable price — e.g., **par**, or "0 points" — and show which rate each investor hits). Results typically display a rate/price ladder per product so the LO sees the full rebate/discount curve. Best-ex is where eligibility + base + LLPAs + margin + overlays converge into a single comparable number.

## 7. Lock desk & secondary (brief)

A **rate lock** freezes a scenario's price for a **lock period**. The PPE feeds the **lock desk** and supports **lock extensions** (paying a per-day/tiered fee to push expiration), **relocks** after expiration, and **worst-case pricing (WCP)** — a relock/extension prices at the *worse* of original vs. current market, discouraging float-down gaming. Locks are **best-efforts** (lender tries to deliver, no penalty if the loan falls out) or **mandatory** (lender commits to deliver, better price, penalty on fallout). **Commitments** and **pull-through** (the % of locks that actually close) feed hedging — covered deeply by a separate agent. Optimal Blue has automated best-efforts locking directly with investors via API.

## 8. Scenario & workflow features

Standard surface area: a **quick pricer** (fast single-scenario quote), **scenario save/compare** (persist and diff scenarios), **what-if** (tweak one attribute, re-price), **historical / as-of-date pricing** (reproduce a quote for any past date — required for compliance and disputes), **batch/bulk pricing** (price a pipeline or an entire investor's grid at once), and **API pricing** for headless/LOS-embedded use.

## 9. Configuration & governance

Because bad pricing = direct financial loss, governance is first-class: role-based control over **who edits rules**, **approval queues / maker-checker (dual control)** on pricing and rule changes, **effective-dated changes** (stage a change for a future date), **rollback** to a prior version, and a complete **audit trail** (who changed what, when, and the before/after). Every quote should be reproducible from versioned inputs.

## 10. Change detection / daily updates

A modern differentiator: **day-over-day change detection** that diffs each investor's newly ingested base grids and rules against yesterday's and **surfaces deltas** — new/removed programs, guideline changes, price shifts — so secondary-marketing staff review changes rather than re-reading every sheet. This is both a QA control (catch ingestion errors) and a product feature.

## 11. APIs & integrations

The PPE lives inside origination workflows. Core integrations: **LOS** (Encompass/ICE, MeridianLink) — often bidirectional, pushing price/lock back to the loan file; **POS** and pricing widgets. The **pricing API** shape: request = a scenario object; response = an array of eligible products, each with rate/price ladders, adjustment breakdowns, and ineligible products with reasons. Delivery is **real-time** (recompute on request against live grids) vs. **cached** (precomputed grids refreshed on reprice) — a latency/accuracy tradeoff, since a stale cache after a reprice produces a wrong, potentially binding quote.

## What makes a PPE hard

- **Data volume & freshness**: thousands of sheets, intraday reprices, 150+ investors — a relentless ingestion/normalization pipeline where a single parse error mis-prices real loans.
- **Rule interactions**: caps, floors, overlays, and stacked adjustments interact non-linearly; order of operations and cap application must be exact and reproducible.
- **Edge cases**: high-LTV/low-FICO corners, layered risk (cash-out + investment + condo), DTI-triggered agency LLPAs, state-specific rules, non-standard Non-QM/DSCR attributes.
- **Reason tracing & auditability**: explaining *why* something is ineligible or priced as it is, and reproducing any historical quote, roughly doubles engine complexity.
- **Correctness under time pressure**: quotes can become binding commitments, so "fast but sometimes wrong" is unacceptable.

## Standard vocabulary
**PPE**, **eligibility engine**, **scenario**, **base rate / base price**, **par (100.000)**, **rebate/premium (above par)**, **discount/cost (below par)**, **points**, **LLPA**, **adjustment stack**, **price cap/floor**, **margin**, **overlay**, **investor / program / program family**, **best execution**, **target rate/price**, **lock period**, **reprice**, **extension**, **relock**, **worst-case pricing**, **best-efforts / mandatory**, **pull-through**, **as-of-date pricing**, **AUS / LPA / DU**.

**Vendor-specific vs. convention**: the "PPE" acronym and "self-managed margin" framing are Optimal Blue coinages now used industry-wide; **LPA/DU** are proprietary GSE AUS names; par/LLPA/best-ex/lock terminology is universal industry convention. Deep **Non-QM/DSCR** marketplace discovery is a positioning of LoanNEX/Lender Price rather than a universal feature.