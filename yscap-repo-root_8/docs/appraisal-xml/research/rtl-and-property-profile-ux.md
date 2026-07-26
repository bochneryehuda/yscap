# RTL Lending Platforms + Property-Profile UX — Research for the Appraisal/Property Module

**Purpose.** Two focused literature reviews, then a prioritized enhancement list, to make our
appraisal/property module and PILOT property report *exceptional*:

- **(A) RTL / private / hard-money / DSCR lending platforms** — specifically how they treat
  As-Is vs ARV, LTC/LTARV, rehab budget vs appraisal repairs, draw/inspection tie-ins, the
  1004D completion, and **appraisal-to-file reconciliation** for fix-and-flip.
- **(B) Best-in-class property-intelligence / "property profile" products** — the UX and
  interactions that make them feel like premium valuation tools.

**Companion docs (do not duplicate — this doc extends them):**
`../report-enhancement-research.md` (enhancement backlog A1–A14 / B1–B17, feature verdicts,
staff-vs-borrower split, export spec, craft moves); `../property-report-design-research.md`
(section stack Hero → Photos → Facts → Subject → Valuation → Comps → Market → Cost/Income →
Appraiser → Exhibits → Footer); `../underwriting-findings-rules.md` (the match-engine findings
rules); `../industry-research.md` (MISMO/UAD, As-Is vs ARV, RTL ratios). This doc's distinct
angle is **how the RTL platforms themselves behave**, mapped onto our screen.

> **Brand tokens** (design toward these): Ink `#141B22` · Gold `#AE8746` · Teal `#2F7F86` ·
> Paper `#F6F3EC` · Fraunces (display) + Hanken Grotesk (text).

Compiled 2026-07-19. All claims cited inline; consolidated sources at the end.

---

## PART A — How RTL / private-lending platforms handle appraisal, As-Is/ARV & property review

### A.0 The landscape in one paragraph
RTL ("Residential Transition Loan," the securitization-market name for fix-and-flip / bridge /
rehab loans) tech splits into three layers we should learn from separately: **(1) direct
lenders** who built their own valuation engines (Kiavi, Lima One, Roc360); **(2) LOS/servicing
platforms** private lenders buy to originate and service (Liquid Logics, Mortgage Automator,
Baseline, LendingWise, The Mortgage Office, Bryt); and **(3) diligence / capital-markets
plumbing** that re-verifies collateral value for aggregators and securitizations (Setpoint /
Resolute, Toorak, and rating-agency methodology like DBRS). Our product sits closest to layer 2
but should borrow the **valuation-reconciliation rigor of layer 3** — that rigor is the thing a
private lender can't easily buy, and it's exactly what our appraisal-vs-file match engine is.

### A.1 As-Is vs ARV — how the platforms actually treat the two numbers
- The universal RTL rule: **As-Is (a.k.a. AIV, "as-is value") drives the purchase-side ratios;
  ARV (after-repair value) drives the exit-side ratio.** Kiavi teaches this split explicitly in
  its investor math ("AIV and ARV") and its ARV Estimator. ([Kiavi AIV & ARV](https://www.kiavi.com/blog/real-estate-investing-math-made-easy-aiv-and-arv),
  [Kiavi ARV Estimator](https://www.kiavi.com/arv-estimator))
- Sizing is a **min-of-several-caps** structure, not one ratio. Representative published caps:
  - **Kiavi**: up to **95–100% LTC** of initial cost + **100% of rehab**, capped at **~75–80%
    of ARV**. ([Kiavi fix & flip](https://www.kiavi.com/loans/fix-and-flip))
  - **Lima One (FixNFlip)**: up to **90% LTC** (95% if rehab < 50% of purchase), **75% LTV of
    as-is**, **75% of ARV (LTARV)**, **up to 100% of rehab** funded via reimbursement draws.
    ([Lima One fix & flip](https://www.limaone.com/hard-money-fix-n-flip/detail/),
    [Lima One ARV](https://www.limaone.com/arv-real-estate/))
  - The loan amount is the **binding minimum** of {LTC cap, As-Is LTV cap, ARV/LTARV cap}. Our
    report should surface all three tests, not one — see enhancement N7.
- **Kiavi does not order a full appraisal on many fix-and-flip bridge loans** — it runs an
  in-house AI AVM ("7.8B data points") to set As-Is and ARV. ([Kiavi fix & flip](https://www.kiavi.com/loans/fix-and-flip))
  Implication for us: **the appraisal is not always the value of record.** Our module must treat
  the appraisal as *one* valuation input to reconcile against the file's registered As-Is/ARV,
  which may have come from a BPO or AVM. This is exactly why "match the file," not "replace the
  file," is the right posture (already our principle in `../underwriting-findings-rules.md` §0).

### A.2 Rehab budget / Scope of Work vs appraisal repairs
- Every RTL platform treats the **borrower's Scope of Work (SOW) / rehab budget** as a
  first-class object *separate from* the appraisal. Lima One requires "a documented rehab plan
  and a construction budget"; the ARV is estimated from **comps of *renovated* properties**, i.e.
  the appraiser is valuing the *post-SOW* house. ([Lima One fix & flip](https://www.limaone.com/hard-money-fix-n-flip/detail/),
  [Lima One rehab budget](https://www.limaone.com/how-to-calculate-rehab-budget/))
- The reconciliation gap we should catch: **the appraisal's "subject-to" repairs (the work the
  ARV is conditioned on) must be consistent with the borrower's SOW budget.** If the appraiser's
  ARV assumes a full gut and the borrower budgeted a cosmetic refresh, the ARV is unsupported.
  RCN/Conventus/Constructive all frame ARV as contingent on the described scope. ([RCN ARV loans](https://rcncapital.com/blog/arv-loans-explained-fix-and-flip-financing-based-on-after-repair-value),
  [Constructive fundamentals](https://www.constructiveloans.com/blog/fix-and-flip-financing-fundamentals-for-rehab-investors-and-brokers))
- **RTL-specific must-have:** an **"ARV basis" reconciliation** that pairs the appraisal's
  subject-to condition/repairs with the registered SOW total and flags a mismatch. This is *the*
  fix-and-flip check that generic mortgage tooling lacks.

### A.3 Draw / inspection tie-ins
- The LOS platforms all center fix-and-flip on **milestone-based construction draws with an
  inspection gate**:
  - **Liquid Logics**: automated inspection scheduling, budget/line-item tracking, and fund
    disbursement workflows in one system; a rules engine automates draw approvals.
    ([Liquid Logics](https://www.liquidlogics.com/))
  - **Baseline**: borrowers "build budgets and request draws" in a branded portal; draws tie to
    milestones (framing → mechanicals → drywall → finish → completion); lender inspects
    (in-person or virtual) and releases funds in 24–72h. ([Baseline fix & flip guide](https://www.baselinesoftware.com/resources/articles/fix_and_flip_loans_complete_guide),
    [Baseline](https://www.baselinesoftware.com/))
  - **Mortgage Automator**: borrowers submit draw requests through the portal with **photos and
    videos as milestone evidence**; managed alongside servicing. ([Mortgage Automator features](https://www.mortgageautomator.com/all-features))
  - **Lima One**: reimbursement model, funds by **% of line items complete**, draws in ~4 days;
    experienced borrowers get "commitment funding" (no interest on undrawn construction funds).
    ([Lima One fix & flip](https://www.limaone.com/hard-money-fix-n-flip/detail/))
- **Tie-in to our appraisal module:** the appraisal establishes the **budget baseline** (the SOW
  the ARV is built on) at origination; draws consume against that baseline; the **1004D** verifies
  completion at the end (A.4). Our report should show the SOW line-item budget *as extracted /
  registered* so the draw system has a single source of truth to draw against, and so an
  underwriter can see "appraisal ARV assumes $X of work" next to "$X budget."

### A.4 The 1004D (Appraisal Update and/or Completion Report)
- The **1004D** is the completion certificate: it lets the appraiser (a) update a prior appraisal
  or (b) **certify the described repairs/construction were completed**. It's "often the last item
  needed" to close or to release recourse on renovation loans. ([PCV Murcor 1004D](https://www.pcvmurcor.com/products/appraisal-product-list/appraisal-update-and-or-completion-report-1004d/),
  [Society Mortgage: what is a 1004D](https://societymortgage.com/mortgage-tips/what-is-a-1004d/),
  [Fannie Mae Form 1004D](https://singlefamily.fanniemae.com/media/4106/display))
- Fannie will accept a **Completion Certification letter + photo/video/paid-invoice evidence** in
  lieu of a site visit for some renovation cases — mirroring the photo-evidence draw pattern the
  LOS platforms already use. ([Land Gorilla / FNMA flexibilities](https://landgorilla.com/blog/fannie-mae-temporary-flexibilities-to-appraisal-requirements/),
  [Valligent virtual 1004D](https://www.valligent.com/2024/01/24/streamlining-completion-certifications-form-1004d-with-virtual-inspections/))
- **RTL-specific must-have:** our module should model the **appraisal lifecycle as two documents
  on one collateral** — the origination appraisal (As-Is + subject-to ARV) and the **1004D at
  payoff/recourse-release** — and reconcile the 1004D's "as-completed" against the original ARV.
  A 1004D that comes in *below* the ARV the loan was sized on is a material finding.

### A.5 Appraisal-to-file reconciliation (the capital-markets discipline to steal)
- **Setpoint / Resolute** run **asset-level diligence** for RTL and SFR: their **Valuations
  Manager** orders/normalizes **AVM, BPO, or appraisal**, and **Collateral Manager** tracks data,
  docs, and lender requirements across the funding lifecycle. Crucially, on a rated securitization
  they applied the **DBRS "cascade" methodology — ordering an independent AVM on each loan and
  comparing it to the original appraised value** to test whether the appraisal was "reasonably
  supported." ([Setpoint valuation mgmt](https://www.setpoint.io/valuation-management/),
  [Setpoint $209M RTL diligence](https://www.setpoint.io/setpoint-facilitates-diligence-for-209-million-landmark-rated-securitization-of-residential-transition-loans/),
  [Setpoint acquires Resolute](https://rei-ink.com/setpoint-announces-acquisition-of-resolute-diligence-solutions-strengthening-technology-platform-for-asset-backed-lending/))
- **Roc360's Valuation Analyst** underwrites collateral by "assessing **as-is and as-repaired
  value** … considering regional market trends, the borrower's rehab project, zoning, and
  comparable properties," and Roc360 owns its own AMC (**Tamarisk Appraisals**) to source and QA
  the appraisal. ([Roc360 Valuation Analyst](https://roc360.com/valuation-analyst/),
  [Roc360](https://roc360.com/))
- **Toorak** and other aggregators buy RTL from originators and re-underwrite collateral before
  securitizing (Toorak 2024-RRTL2, $237.5M). ([Connect Money on Roc360 RTL](https://www.connectmoney.com/stories/roc360-closes-238m-rated-rtl-securitization/))
- **The appraiser's own reconciliation** (per Fannie B4-1.3-11) weighs the reliability of each
  approach into a single value opinion — we already extract this narrative (backlog A12). ([FNMA B4-1.3-11](https://selling-guide.fanniemae.com/sel/b4-1.3-11/valuation-analysis-and-reconciliation))
- **Takeaway:** the premium move is a **cascade / second-opinion reconciliation** — appraised
  value shown next to an independent AVM (with confidence) and the delta flagged. We can *design
  the shelf now* from the appraisal alone (show appraised As-Is/ARV + our derived comp-implied
  range) and *wire the external AVM later* (backlog B14). This is the single most
  "capital-markets-grade" feature we can add.

### A.6 DSCR / rental (2–4 unit) nuance
- DSCR/rental products (Lima One Rental30, Kiavi rental, most LOS platforms) size on **rent vs
  debt service**, not rehab. The valuation still matters (LTV) but the **income approach / rent
  schedule** becomes the star — our 1025/1073 income-approach and rent-schedule extraction
  (backlog A6/A7) is the DSCR analogue of the fix-and-flip ARV. Surface **market vs actual rent**
  and a **GRM/DSCR-ready rent figure** prominently for these forms.

### A.7 RTL-specific features our module should have (that generic mortgage tools don't)
1. **Three-cap loan-sizing panel** (staff-only): show As-Is-LTV, LTC, and LTARV tests side by
   side with the binding constraint highlighted (A.1).
2. **ARV-basis reconciliation**: appraisal's subject-to repairs vs registered SOW budget (A.2).
3. **Value-type guardrail**: never let a "subject-to-completion" value be read as As-Is or
   vice-versa — read `conditionOfAppraisal` + `valueType` on every value (already our principle;
   surface it as a visible **value-basis banner**). (A.1, A.5)
4. **Appraisal lifecycle / 1004D reconciliation**: origination appraisal vs completion 1004D,
   flag as-completed < ARV (A.4).
5. **Second-opinion cascade tile**: appraised value vs independent AVM + confidence, delta
   flagged — DBRS/Setpoint pattern (A.5; backlog B14).
6. **Comp-quality risk flags for rehab comps**: ARV must lean on *renovated* comps; flag when
   comps are inferior-condition or when net/gross adjustments exceed thresholds (A.2; backlog A9).
7. **SOW/budget-aware draw baseline**: expose the appraisal-blessed budget as the draw baseline
   so origination value, SOW, and draws share one source of truth (A.3).

---

## PART B — Property-profile / property-intelligence UX (best-in-class)

### B.1 The reference products and their signature interactions
- **HouseCanary Property Explorer** — a *single-interface* flow: scroll images of subject +
  comps, **compare AVM vs ARV**, test multiple valuation methods, and generate a **polished value
  report**. Signature elements: **neighborhood heatmap** with buttons that jump to comp-selection
  and rental-selection views; **proprietary Similarity Score** auto-selects comps; a **comp grid**
  that auto-adjusts each comp to the subject (location, sqft, rooms, lot, pool, basement…); a
  **"Value by 6 Conditions" (C1–C6)** tool; and a redesign that **consolidated data into a tabular
  section to cut scrolling** plus an **AVM breakdown** to reinforce confidence. ([Property Explorer](https://www.housecanary.com/products/property-explorer),
  [Quick Start](https://www.housecanary.com/blog/property-explorer-quick-start-guide))
- **Clear Capital ClearAVM report** — a tight 3-page IA worth copying: **p1** = subject info,
  **Street View + neighborhood map**, value estimate, **value range**, **FSD confidence score**,
  characteristics, listing history; **p2** = comps ranked by algorithm; **p3** = aerial of subject
  + comps. Confidence is a **first-class number**: the score is literally `1 − FSD`, where FSD is
  the forecast standard deviation and tells the reader "68.3% chance the value is within ±X%."
  ([ClearAVM report](https://www.clearcapital.com/announcing-an-enhanced-clearavm-report-with-valuable-new-insights/),
  [FSD definition](https://www.clearcapital.com/resources/glossary-of-terms/fsd-forecast-standard-deviation/))
- **Zillow property page** — **media at the very top**, click → **full-page magazine gallery**;
  content chunked into named cards ("What's Special," "Market Value," "Monthly Cost,"
  "Neighborhood"); **big type for the most important facts**. Emotional/consumer bar for photo and
  hero. (Covered in `../property-report-design-research.md`; still the gallery bar.)
- **ATTOM Property Navigator / First American** — the report is **centered on a distance-ringed
  comp map** with subject + numbered comp pins keyed to the table rows. ([ATTOM Navigator](https://www.attomdata.com/solutions/property-navigator/),
  [First Am sales-comp sample](https://dna.firstam.com/solutions/property-data/property-reports/sales-comparables-report-sample))

### B.2 The interaction patterns that separate premium tools from a PDF
(Verdicts already rated in `../report-enhancement-research.md` §2; the *interaction craft* to nail:)
- **Interactive comp map** — subject as a Gold star, comps as numbered Teal pins, **distance
  rings**, and **row↔pin hover-linking** so hovering a table row lights its pin and vice-versa.
  This one element reads "AVM/valuation tool" more than any other. ([ATTOM Navigator](https://www.attomdata.com/solutions/property-navigator/))
- **Comps: scannable table ⇄ expandable URAR adjustment grid** (progressive disclosure) with a
  **sticky first column**, **adjustment heat-cells** (green/amber intensity by size of
  adjustment), and sortable columns.
- **Comp side-by-side compare / isolate / remove** — pick 2–3 comps, columns align; drop a comp
  from the set. Read-only twist for us: the reader *explores*, never *re-underwrites*.
  ([Property Explorer](https://www.housecanary.com/products/property-explorer))
- **AVM/value with an explicit confidence chip** — borrow ClearAVM's FSD framing. For us the chip
  is **extraction confidence + comp quality** now; **vendor AVM confidence** later. Make it
  **expandable** to per-field / per-comp detail. ([FSD](https://www.clearcapital.com/resources/glossary-of-terms/fsd-forecast-standard-deviation/))
- **Value-comparison bar** (Purchase → As-Is → ARV, spread annotated) — the "answer first" visual.
- **History timelines** — value/ownership/tax/permit as a horizontal time axis; starts from XML
  (subject prior sale, backlog A1) and grows with public records (B1/B2/B4). A timeline instantly
  reads as "intelligence."
- **Risk layer** — flood/FEMA zone chip now (XML), graded climate-risk meter later. ATTOM ships
  scores for **flood, wildfire, heat, drought** (pluvial/fluvial/tidal/sea-level). ([ATTOM risk analytics](https://www.attomdata.com/solutions/ai-powered/property-risk-analytics/))
- **Neighborhood chips** — school ratings, Walk/Transit/Bike score (external, borrower-friendly).
- **Photo lightbox** — magazine layout, category tabs (Front/Rear/Street/Interior/Comps/Exhibits),
  swipe + zoom; every image labeled. Emotional core.
- **Document viewer** — inline view of the **original appraisal PDF** + exhibits, not just a
  download link.

### B.3 Reporting & export (branded, audience-aware)
- **Share links** — HouseCanary's "Share Report" is **read-only by default**, with an option for
  read-only *or* edit-and-save collaborator links; reports are **co-branded** (add items to the
  header) and print-ready. ([HC value report: comments & CMAs](https://resources.housecanary.com/new-improved-housecanary-value-report-comments-rental-cmas-more),
  [Property Explorer](https://www.housecanary.com/products/property-explorer))
  For us: **tokenized, expiring, view-scoped links** where the **token (not the session) stamps
  the audience profile** — a borrower link can never resolve to the staff view
  (`../report-enhancement-research.md` §3).
- **Branded PDF** — cover page (address hero photo, headline value(s), effective date, lender
  logo), **watermark/branding**, disclaimers, and **audience-specific versions** (borrower vs
  staff) generated from one schema. ClearAVM's 3-page structure is a good minimal template; our
  export spec is in `../report-enhancement-research.md` §4.
- **Collaboration/notes** — HouseCanary added **comments** to its value report; a light,
  staff-only **notes/annotation** rail (never borrower-facing) is the tasteful version for us.
  ([HC comments](https://resources.housecanary.com/new-improved-housecanary-value-report-comments-rental-cmas-more))
- **Mobile** — the consumer bar (Zillow) is responsive gallery-first; for a lender tool, a
  **read/skim-optimized responsive layout** (hero + value + comps table that reflows) matters more
  than full mobile editing.

### B.4 Data enrichment — sources, APIs, and realistic cost (for the "later" backlog)
Maps to backlog B1–B17 in `../report-enhancement-research.md`. Realistic integration path/cost:
- **ATTOM** — ~9,000 attributes across ~160M properties: ownership, deeds/sales (10 yr),
  mortgages, **tax history**, **building permits (300M+ from 2,000+ departments)**, foreclosure,
  demographics, **climate risk scores**, schools. Priced **per API "Report" (per record), not per
  call** — public reference point ≈ **$0.10/report** at volume (e.g. $1,000/mo → 100k reports);
  most pricing is custom/quote; Property Navigator seat is $499/yr. ([ATTOM property data](https://www.attomdata.com/data/property-data/),
  [ATTOM API pricing basis](https://cloud-help.attomdata.com/article/684-api-report),
  [ATTOM on Datarade](https://datarade.ai/data-providers/attom/profile),
  [ATTOM permits](https://www.attomdata.com/data/property-data/nationwide-building-permit-data/))
- **CoreLogic** — largest US property repository; AVM + risk (RiskMeter). Sample per-report
  pricing seen in the wild: **~$0.65–$1.00 per Total Home Value report**, **$0.005/call** for
  address type-ahead; rest is enterprise/custom. ([CoreLogic pricing (PriceLevel)](https://www.pricelevel.com/vendors/corelogic/pricing),
  [RiskMeter](https://riskmeter.corelogic.com/))
- **HouseCanary** — AVM + **rent estimate (12-mo forecast)** + **value forecast (up to 36 mo)** +
  Market Action Score; exposes an API/MCP (149 property tools). The "forward-looking" layer.
  ([HC data & AVMs](https://www.housecanary.com/solutions/data-analytics-valuations),
  [HC MCP](https://www.housecanary.com/blog/housecanary-mcp-server))
- **Clear Capital** — ClearAVM + **Rental AVM**, both with FSD confidence; portal + API.
  ([ClearAVM](https://www.clearcapital.com/products/clearavm/),
  [Rental AVM](https://www.clearcapital.com/products/rental-avm/))
- **Walk Score / GreatSchools / FEMA / First Street** — cheap or free point sources for
  walk/transit, schools, flood/climate.
- **Realistic path:** start with **one records provider (ATTOM)** for history/permits/tax + **one
  AVM (Clear Capital or HouseCanary)** for the second-opinion cascade; both are per-record APIs so
  cost scales with usage and can be gated behind "enrich this property" rather than run on every
  import. Budget order-of-magnitude: **pennies to ~$1 per property** enriched.

### B.5 Delight & trust — the craft moves that make it feel expensive
(Detailed in `../report-enhancement-research.md` §5; the highest-signal ones:)
- **Answer-first hero** — headline value(s) above the fold, evidence below.
- **Confidence as a designed object**, not a footnote (ClearAVM FSD).
- **Provenance everywhere** — "Generated by PILOT from the appraisal XML," effective/extraction
  dates, appraiser license-verified badge, source chips on external data. Never present an
  inferred number as structured.
- **One restrained motion system** — hover-link map↔table, smooth lightbox — no parallax/animated
  counters (reads as marketing, not valuation).
- **Editorial type + generous whitespace + named cards** instead of a dense grid.
- **A quiet amber flag rail** (flood zone, legal-nonconforming, high net-adjustment, aging
  effective date, hypothetical-condition) — signals rigor without alarm.

---

## PART C — Prioritized enhancement list (mapped to our property-report screen + RTL findings)

Impact/Effort scale: **H/M/L**. "Screen anchor" = section in
`../property-report-design-research.md`'s stack. **NOW** = buildable from appraisal XML we already
extract; **LATER** = needs external data/APIs. Items prefixed `N` are new/sharpened here relative
to the existing backlog; others cross-reference existing backlog IDs.

### NOW — from the appraisal XML (build against current extraction)

| ID | Enhancement | Screen anchor | Impact | Effort | Notes / RTL tie-in |
|---|---|---|---|:--:|:--:|---|
| N1 | **Value-basis banner** ("This is ARV — subject to completion of described repairs" / "As-Is") driven by `conditionOfAppraisal` + `valueType` | Valuation (§5) | H | L | A.1/A.5 guardrail; trust-critical; also backlog A12 |
| N2 | **Value-comparison bar** Purchase → As-Is → ARV with spread annotated | Hero / Valuation | H | L | The "answer-first" visual; backlog A13 |
| N3 | **Interactive comp map** — Gold subject star, numbered Teal pins, distance rings, **row↔pin hover-link** | Comps (§6) | H | M | Single most "valuation-tool" element (B.2) |
| N4 | **Comps table ⇄ expandable adjustment grid**, sticky first col, **net/gross-adj heat-cells**, sortable | Comps (§6) | H | M | Progressive disclosure; backlog A9 |
| N5 | **Confidence/quality chip** (extraction confidence + comp quality: net/gross adj, distance, recency), expandable | Hero / Valuation | H | M | ClearAVM FSD pattern (B.2) |
| N6 | **ARV-basis reconciliation** — appraisal subject-to repairs vs **registered SOW/rehab budget**, mismatch flag | Valuation + Findings | H | M | **RTL must-have** (A.2); the check generic tools lack |
| N7 | **Three-cap loan-sizing panel** (As-Is-LTV / LTC / LTARV), binding constraint highlighted — **staff-only** | Valuation (staff) | H | M | **RTL must-have** (A.1); respect staff/borrower split |
| N8 | **Comp side-by-side compare / isolate / remove** (read-only exploration) | Comps (§6) | M | M | Property Explorer pattern (B.2) |
| N9 | **Value/ownership timeline seed** — subject prior sale → As-Is → ARV | Subject / Valuation | H | M | Backlog A1; grows with LATER data |
| N10 | **Risk flag rail** — FEMA zone chip, legal-nonconforming, high net-adj, aging effective date, hypothetical-condition | Summary rail | H | L | Backlog A4/A5; amber, sparing |
| N11 | **C1–C6 / Q1–Q6 as a 6-pip visual scale** | Facts strip (§3) | M | L | Backlog A11; instantly legible |
| N12 | **Photo lightbox** — magazine layout, category tabs, swipe+zoom, labeled | Photos (§2) | H | M | Zillow bar; backlog A14 |
| N13 | **Cost-approach waterfall (1004) / GRM + rent-delta card (1025/1073)** | Cost/Income (§8) | M | M | Backlog A6/A7; DSCR star (A.6) |
| N14 | **Appraiser license-verified badge + effective-date aging chip** | Appraiser (§9) | M | L | Backlog A10; trust layer |
| N15 | **Inline document viewer** for original appraisal PDF + exhibits | Exhibits (§10) | M | M | Premium vs a bare download link |
| N16 | **Reconciliation pulled-quote** from appraiser narrative | Valuation (§5) | M | L | Backlog A12; humanizes the value |
| N17 | **1004D lifecycle slot** — model completion report as a second doc on the collateral; flag as-completed < ARV when it arrives | Valuation + Findings | H | M | **RTL must-have** (A.4) |
| N18 | **Provenance line + source chips** ("from the appraisal XML," dates) | Footer (§11) | M | L | Trust; never label inferred as structured |

### LATER — external data / APIs (design the shelf now, wire when licensed)

| ID | Enhancement | Provider | Impact | Effort | Notes |
|---|---|---|---|:--:|:--:|---|
| L1 | **Second-opinion AVM cascade tile** — appraised vs independent AVM + FSD confidence, delta flagged | Clear Capital / HouseCanary | H | M | **RTL must-have** (A.5, DBRS/Setpoint); highest-leverage add; backlog B14 |
| L2 | **Chain of title + tax-assessment history** (extends N9 timeline) | ATTOM / CoreLogic | H | M | Backlog B1/B2 |
| L3 | **Building-permit history strip** (validates the rehab story) | ATTOM permits | M | M | Backlog B4; RTL-relevant |
| L4 | **Rent estimate + rent comps + rent trend** (DSCR sizing) | HouseCanary / Clear Rental AVM | H | M | Backlog B10; DSCR star |
| L5 | **Price/value forecast band (3–36 mo)** on the trend line | HouseCanary | M | M | Backlog B11; "premium AVM" flex |
| L6 | **Graded climate/flood risk meter** (beyond XML zone) | CoreLogic RiskMeter / ATTOM / First Street | M | M | Backlog B5/B15 |
| L7 | **School ratings + Walk/Transit/Bike scores** | GreatSchools / Walk Score | M | L | Backlog B6/B7; borrower-friendly |
| L8 | **Encumbrance / lien / foreclosure history** — **staff-only** | ATTOM / Black Knight | M | M | Backlog B3; never borrower-facing |
| L9 | **Street View embed** on subject + comps | Google Maps | M | M | Needs key; after static map |
| L10 | **Tokenized share links + co-branded audience-specific PDF export** | internal | H | M | HC "Share Report" pattern (B.3); export spec exists |
| L11 | **Staff-only notes/annotation rail** | internal | M | M | HC comments pattern (B.3) |

---

## Consolidated sources

**RTL / private-lending platforms & underwriting**
- Kiavi: [fix & flip](https://www.kiavi.com/loans/fix-and-flip) · [ARV Estimator](https://www.kiavi.com/arv-estimator) · [AIV & ARV math](https://www.kiavi.com/blog/real-estate-investing-math-made-easy-aiv-and-arv)
- Lima One: [fix & flip detail](https://www.limaone.com/hard-money-fix-n-flip/detail/) · [ARV](https://www.limaone.com/arv-real-estate/) · [rehab budget](https://www.limaone.com/how-to-calculate-rehab-budget/)
- Liquid Logics: [product](https://www.liquidlogics.com/)
- Mortgage Automator: [all features](https://www.mortgageautomator.com/all-features) · [home](https://www.mortgageautomator.com/)
- Baseline: [fix & flip guide](https://www.baselinesoftware.com/resources/articles/fix_and_flip_loans_complete_guide) · [home](https://www.baselinesoftware.com/)
- Roc360: [Valuation Analyst](https://roc360.com/valuation-analyst/) · [home](https://roc360.com/) · [$238M RTL securitization](https://www.connectmoney.com/stories/roc360-closes-238m-rated-rtl-securitization/)
- Setpoint / Resolute: [valuation mgmt](https://www.setpoint.io/valuation-management/) · [$209M RTL diligence (AVM cascade)](https://www.setpoint.io/setpoint-facilitates-diligence-for-209-million-landmark-rated-securitization-of-residential-transition-loans/) · [Resolute acquisition](https://rei-ink.com/setpoint-announces-acquisition-of-resolute-diligence-solutions-strengthening-technology-platform-for-asset-backed-lending/)
- RCN / Constructive on ARV basis: [RCN ARV loans](https://rcncapital.com/blog/arv-loans-explained-fix-and-flip-financing-based-on-after-repair-value) · [Constructive fundamentals](https://www.constructiveloans.com/blog/fix-and-flip-financing-fundamentals-for-rehab-investors-and-brokers)
- 1004D: [PCV Murcor](https://www.pcvmurcor.com/products/appraisal-product-list/appraisal-update-and-or-completion-report-1004d/) · [Society Mortgage](https://societymortgage.com/mortgage-tips/what-is-a-1004d/) · [Fannie Mae Form 1004D](https://singlefamily.fanniemae.com/media/4106/display) · [Land Gorilla flexibilities](https://landgorilla.com/blog/fannie-mae-temporary-flexibilities-to-appraisal-requirements/) · [Valligent virtual 1004D](https://www.valligent.com/2024/01/24/streamlining-completion-certifications-form-1004d-with-virtual-inspections/)
- Reconciliation: [FNMA B4-1.3-11](https://selling-guide.fanniemae.com/sel/b4-1.3-11/valuation-analysis-and-reconciliation)

**Property-intelligence / profile UX & data**
- HouseCanary: [Property Explorer](https://www.housecanary.com/products/property-explorer) · [Quick Start](https://www.housecanary.com/blog/property-explorer-quick-start-guide) · [value report comments/CMAs](https://resources.housecanary.com/new-improved-housecanary-value-report-comments-rental-cmas-more) · [data & AVMs](https://www.housecanary.com/solutions/data-analytics-valuations) · [MCP](https://www.housecanary.com/blog/housecanary-mcp-server)
- Clear Capital: [ClearAVM](https://www.clearcapital.com/products/clearavm/) · [enhanced ClearAVM report](https://www.clearcapital.com/announcing-an-enhanced-clearavm-report-with-valuable-new-insights/) · [FSD definition](https://www.clearcapital.com/resources/glossary-of-terms/fsd-forecast-standard-deviation/) · [Rental AVM](https://www.clearcapital.com/products/rental-avm/)
- ATTOM: [property data](https://www.attomdata.com/data/property-data/) · [permits](https://www.attomdata.com/data/property-data/nationwide-building-permit-data/) · [risk analytics](https://www.attomdata.com/solutions/ai-powered/property-risk-analytics/) · [Property Navigator](https://www.attomdata.com/solutions/property-navigator/) · [API report pricing](https://cloud-help.attomdata.com/article/684-api-report) · [Datarade profile](https://datarade.ai/data-providers/attom/profile)
- CoreLogic: [RiskMeter](https://riskmeter.corelogic.com/) · [pricing (PriceLevel)](https://www.pricelevel.com/vendors/corelogic/pricing)
- First American: [sales-comparables sample](https://dna.firstam.com/solutions/property-data/property-reports/sales-comparables-report-sample)
