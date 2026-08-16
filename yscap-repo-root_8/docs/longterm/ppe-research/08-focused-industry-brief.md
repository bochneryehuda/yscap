<!-- Captured PPE research brief (agent-generated, 2026-08-16). LT-only reference for the MEGA PPE build. Source: docs/longterm/PPE-MEGA-PLAN.md indexes these. -->
<!-- STAFF-ONLY. Section 5 names a specific investor (Deephaven) from its PUBLICLY documented product pages, for internal PPE research only. Per the HARD RULE, an investor/note-buyer name may NEVER reach a borrower or TPO surface — this file is internal reference, never served to a client. -->
> **Internal staff reference only.** This brief names investors (e.g. Deephaven) from their public product pages for research. An investor / note-buyer name must never appear on any borrower- or TPO-facing surface.

# Mortgage Rate Sheets & DSCR Pricing: Knowledge Brief

## 1. How a rate sheet works

A lender/investor **rate sheet** is a pricing grid, not a rate menu. Its rows are **note rates** (also called **coupons**) — the interest rate the borrower pays — typically stepped in eighths (e.g., 7.000, 7.125, 7.250…). For each note rate the sheet quotes a **price**, expressed as a **percentage of loan amount**. Price is a proxy for the cash the loan is worth in the secondary market. **Par** is **100.000**: the loan is worth exactly its balance. **Premium** (price above par, e.g., 101.500) means the investor pays a **rebate** the originator can pass through as a **lender credit**. **Discount** (price below par, e.g., 98.750) means the borrower must pay **discount points** to buy that rate. Higher note rates carry higher prices, so the borrower trades rate against upfront cost. Columns break out **lock periods** — commonly **30 / 45 / 60-day** — with longer locks priced slightly worse (lower price) because the investor carries more market risk. On a $400,000 loan, a price of 101.000 = $4,000 of rebate; 99.000 = $4,000 of cost.

## 2. Terminology (and the rate-vs-price error)

- **Coupon / note rate** — the borrower's interest rate; the row selector on the sheet.
- **Base price / base pricing** — the raw price for a note rate before any adjustment.
- **Par rate** — the note rate whose base price is nearest 100.000 (zero points, zero credit).
- **Price (in points)** — value as a percent of loan amount; 1 point = 1%.
- **LLPA (loan-level price adjustment) / add-on / price adjustment** — a per-loan modifier applied to price for risk attributes. Negative LLPAs subtract from price (cost); some are positive (credit).
- **Buy-up / buy-down** — moving up or down the rate rows to gain price (buy-up) or lower the borrower's rate at a price cost (buy-down).
- **Rebate / lender credit** — premium price returned to borrower/originator.
- **Discount points** — cash paid to cover a below-par price.
- **YSP / SRP (historical)** — Yield Spread Premium (broker) / Service Release Premium (correspondent): the premium value of an above-par rate. YSP disclosure was curtailed post-Dodd-Frank; the mechanics survive as rebate pricing.
- **Margin** — a spread a correspondent/broker applies to investor pricing; typically a **fixed price haircut** (e.g., subtract 1.500 from every price) capturing their revenue.
- **Max price / price cap** and **min price / price floor** — the highest/lowest final price the investor will honor (e.g., capped at 103.000).
- **Qual rate** — the rate used to qualify the loan/compute DSCR, which may differ from the note rate (e.g., IO or a stress rate).

**The core error to avoid:** conflating **rate** and **price**. They are separate axes. The correct chain is: **choose a note rate → look up its base price → apply LLPAs → net/final price → apply cap/floor**. On a DSCR sheet, adjustments are almost always applied to **price (points), not to the rate** — a "−0.500" prepay adjustment means the price drops half a point, not that the rate moves.

## 3. DSCR loan rate sheets

A **DSCR loan** is a non-QM investor mortgage underwritten to the property's cash flow — **DSCR = rent ÷ PITIA** — with no borrower income/employment docs. DSCR sheets price along these axes/LLPA categories (general industry convention):

- **FICO × LTV/CLTV grid** — the primary matrix; each 5% LTV step and each FICO bucket (e.g., 700–719, 720–739) shifts price meaningfully.
- **DSCR ratio bands** — e.g., ≥1.25, 1.15–1.24, 1.00–1.14, <1.00 (sub-1.0 costs price and caps LTV).
- **Loan purpose** — purchase / rate-term / **cash-out** (cash-out is priced worse).
- **Prepayment penalty** — **5/4/3/2/1-year** step-downs or none; longer prepay = better price (positive adjustment). Structures include step-down and fixed-percent.
- **Property type / units** — SFR, 2–4 unit, condo (warrantable vs non-warrantable), PUD, condotel.
- **Interest-only**, **loan-amount tiers**, **rural**, **short-term rental (STR)**, and **mortgage/credit history** all carry their own adjustments.

**Correspondent flow ("Corr Flow")** means the lender funds and closes in its own name, then sells the closed loan to the investor — versus **wholesale/broker**, where a broker submits to the investor who funds. Corr and wholesale usually get distinct sheets.

## 4. How a PPE ingests rate sheets

A **product & pricing engine (PPE)** — Optimal Blue, LoanSifter, Polly, Lender Price — encodes each investor sheet as (a) **eligibility** rules (does the scenario qualify: LTV/FICO/DSCR/state limits) and (b) **pricing** (base price + LLPA stack). The engine separates the two: an ineligible scenario returns no price; an eligible one returns base price adjusted by every applicable LLPA, then capped/floored. A correspondent/lender then layers its **own margin** on top of the investor's net price — commonly a fixed haircut per the sheet — to produce the rate/price shown to the LO or borrower. (Vendor-neutral: all four operate on this eligibility-vs-pricing split; the ingestion format and margin tooling differ by vendor.)

## 5. Deephaven Mortgage

**Deephaven Mortgage** is a non-QM investor/lender operating **wholesale and correspondent** channels (200+ correspondent partners). Its **DSCR** family qualifies on subject-property rental cash flow with no income docs: publicly documented terms include loan amounts up to ~$3.5M, LTVs up to 90%, FICO from 660, minimum DSCR of 1.0x (with reduced limits down to 0.75x DSCR), cash-out options, and a **Wholesale DSCR Second** (second-lien DSCR) product. Eligible properties span SFR, 2–4 units, warrantable/non-warrantable condos, and PUDs.

---

*Note on sourcing:* Sections 1–4 reflect general industry convention (LLPA stacking, par/premium/discount, eligibility-vs-pricing) and are consistent across investors; specific bands, caps, and margin mechanics are sheet-specific. Section 5 reflects Deephaven's publicly documented product pages.

Sources:
- [Deephaven — DSCR Loans](https://deephavenmortgage.com/dscr-loans/) · [DSCR Wholesale Lender](https://deephavenmortgage.com/dscr-wholesale-lender/) · [Wholesale DSCR Second](https://deephavenmortgage.com/wholesale-dscr-second/) · [Correspondent](https://deephavenmortgage.com/correspondent/)
- [BiggerPockets — How DSCR lenders calculate your rate](https://www.biggerpockets.com/blog/how-do-dscr-lenders-calculate-your-interest-rate)
- [LoanStream Non-QM DSCR Rate Sheet (PDF)](https://loanstreamwholesale.com/wp-content/uploads/2026/01/LS-NonQM-DSCR-Ratesheet-01.20.2026.pdf)