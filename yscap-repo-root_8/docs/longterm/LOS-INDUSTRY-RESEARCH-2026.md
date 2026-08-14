# LOS Industry Research 2026 — Building a Best-in-Class US Mortgage Loan Origination System

**Scope:** Long-term residential investor lending (DSCR, non-QM, conventional investor).
**Date:** August 2026.
**Purpose:** External industry research to inform our own LOS build. Everything here is sourced from public
web material; URLs are cited inline. This is a research document, not a spec.

> Status legend: sections are appended incrementally as research completes.

---

## Table of Contents

1. [Competitive Landscape (2025–2026)](#1-competitive-landscape-20252026)
2. [The Pipeline / Dashboard](#2-the-pipeline--dashboard)
3. [URLA / 1003 (2020)](#3-urla--1003-2020)
4. [Condition Management / Condition Center](#4-condition-management--condition-center)
5. [Pricing & Lock Desk](#5-pricing--lock-desk)
6. [Multi-Tenant / Sellable-LOS Architecture + Compliance](#6-multi-tenant--sellable-los-architecture--compliance)
7. [Strategic Conclusions](#7-strategic-conclusions)

---

## 1. Competitive Landscape (2025–2026)

### 1.0 Shape of the market

Two vendors run most of the volume, and everyone else is a niche or a layer on top:

- **ICE Mortgage Technology / Encompass** — commonly cited at ~40–50% of US originations.
  ([HousingWire / Dark Matter coverage](https://www.housingwire.com/articles/execs-from-dark-matter-technologies-focus-on-automation-to-increase-empowers-market-share/),
  [Grokipedia: Encompass](https://grokipedia.com/page/encompass))
- **Dark Matter Technologies / Empower** — clear #2, roughly 10–15%. Together the two "power roughly
  two-thirds of U.S. mortgage originations."
- Everyone else — MeridianLink, Byte, Calyx, Blue Sage, LendingPad, ARIVE, LendingWise — divides the
  remainder by segment (credit unions, brokers, small IMBs, non-QM/private).
- A separate **point-of-sale (POS) layer** — Blend, nCino Mortgage Suite (ex-SimpleNexus), Floify, Maxwell —
  sits in front of the LOS. The existence of this layer *is itself the indictment of the LOS category*:
  lenders buy a second product because the LOS's own borrower- and broker-facing UX is unusable.

**Key structural insight for us:** the incumbents are agency-retail systems with non-QM/DSCR bolted on. Nobody
has built an LOS whose *native* data model is a business-purpose investor loan (entity borrower, property
cash flow, no employment). That is the wedge.

---

### 1.1 ICE Encompass

| | |
|---|---|
| **Position** | Category king. ~40–50% share; the de facto industry standard. |
| **Who uses it** | IMBs and banks with meaningful volume; anyone selling to agency/aggregator investors. |
| **Pricing** | Not public. Custom-quoted. Industry pattern is either **cost-per-closed-loan** or **$X/month base + per-transaction**, layered with **per-seat and per-integration** charges. |

**Praised:** deepest investor connectivity, most complete compliance tooling, best document management,
dashboard customization, and the largest integration marketplace in the industry. A loan consultant on
Capterra: *"the document management and the dashboard customization are probably the biggest features that
stand out."*
([Capterra Encompass reviews](https://www.capterra.com/p/37038/Encompass360/reviews/) — 4.0/5)

**Complained about — this is the important part:**

- **Speed.** Senior loan officer: *"The software is SLOW. I could be much more productive if the SW moved
  faster. **It takes about 2 minutes to open and close ONE LOAN.**"*
- **Form density with no guidance.** *"It's not very user friendly and does not have near the helpful help
  buttons that it needs to quickly explain the **thousands of different radio buttons and boxes** that it
  offers."*
- **Old-school interface**; reporting "confusing for the average loan officer."
- **Implementation weight** — "measured in quarters rather than weeks," requires dedicated admin/ops staff.
  ([setshape LOS comparison](https://setshape.com/blog/top-loan-origination-systems))
- **Cost compounding** through per-seat and per-integration charges; explicitly called out as high-cost for
  small businesses.
- **Support latency** — "slow to respond, lack of urgency."
- System default coding that flags scenarios and causes **intermittent lockouts**.

**Our read:** Encompass's moat is integrations and investor delivery, not UX. Everything users hate is
addressable by a modern web app. Nobody switches off Encompass for a prettier UI alone — they switch when
the *product they originate* doesn't fit Encompass's agency-shaped data model. DSCR/investor lending is
exactly that case.

---

### 1.2 Dark Matter Technologies — Empower

| | |
|---|---|
| **Position** | #2 LOS, ~10–15%. Formerly Black Knight Empower; divested to Constellation Software's Perseus group in 2023. |
| **Who uses it** | Large-enterprise lenders and banks; fewer, bigger clients than Encompass. |
| **Pricing** | Enterprise, not public. |

2025–26 developments worth noting:

- Named to HousingWire's **2026 Mortgage Tech100** (third appearance).
  ([Dark Matter press](https://dmatter.com/2026/press/dark-matter-technologies-named-to-housingwires-2026-mortgage-tech100-list-for-ai-supported-scalable-mortgage-platforms))
- **February 2026: first LOS provider to expose the platform to AI agents via Model Context Protocol (MCP)**
  — "secure AI agents inside the Empower LOS for regulated lending."
  ([HousingWire](https://www.housingwire.com/articles/dark-matter-mcp-empower-ai/),
  [FinancialContent](https://markets.financialcontent.com/stocks/article/send2press-2026-2-25-dark-matter-technologies-enables-secure-ai-agents-inside-the-empower-los-for-regulated-lending))
- Tightening Empower ↔ Elevate (servicing) integration; multi-year renewals (Arbor Bank), new logos (Covey Financial).
- New CEO **Vikas Rao** (ex-CTO) took over April 2026, signalling an **acquisition-led, AI-first** strategy.
  ([National Mortgage News](https://www.nationalmortgagenews.com/news/new-dark-matter-ceo-eyes-deals-ai-first-future))
- Dark Matter has also signalled it will **offer a second LOS alongside Empower** — implying Empower alone
  can't serve the mid-market. ([NMN](https://www.nationalmortgagenews.com/news/dark-matter-to-offer-second-los-alongside-empower))

**Strategic signal for us:** the #2 player's 2026 headline feature is *an MCP server so AI agents can drive
the LOS*. Agent-accessibility is becoming table stakes. Design our API and tool surface for agents from day one.

---

### 1.3 MeridianLink Mortgage (formerly LendingQB)

| | |
|---|---|
| **Position** | Mid-market; strongest among **credit unions and community banks**. Part of MeridianLink's broader consumer-lending suite (auto, personal, card, DDA). |
| **Who uses it** | Banks/CUs that want one vendor across all lending products. |
| **Pricing** | Not public. |

**Praised:** outstanding support team and responsiveness; easy, strong reporting; rules-based engine that
automates underwriting, product & pricing, and closing-cost generation; workflow-rule customization;
paperless workflow enabling remote ops; large integration marketplace and open APIs.
([Capterra](https://www.capterra.com/p/123177/LendingQB/reviews/),
[Software Advice](https://www.softwareadvice.com/mortgage/lendingqb-profile/reviews/))

**Complained about:** confusing and unattractive UI; slow under load or during upgrades; **lacks customization
where it matters — customizable screens and reportable fields**; "over-built if mortgage is your only
product" — the multi-product architecture forces unused configuration and institutional buying processes.

**Our read:** "reportable fields" is a recurring complaint across every LOS. Lenders want to add a field and
have it *immediately* appear in pipeline columns, filters, reports, and exports. Make that a first-class
architectural guarantee (see §6, everything-as-settings).

---

### 1.4 Byte Software (BytePro / ByteWeb)

| | |
|---|---|
| **Position** | Long-tail incumbent since ~1985/1990. Over **1,000** institutions (bankers, CUs, banks, brokers). |
| **Who uses it** | Lenders with non-standard processes and in-house admin capability. |
| **Pricing** | Not public. |

**Praised:** mature workflow engine; genuinely deep customization via custom fields and macros; handles
unusual processes agency-shaped systems can't. **Complained about:** *"the interface shows its age"*;
requires a dedicated admin; not fast to deploy. One reviewer: *"Byte does not have a fix in its future."*
Byte has launched **ByteWeb**, a browser-based LOS carrying BytePro's workflow/automation into a responsive UI —
i.e. even the 35-year incumbent is rebuilding for the browser.
([Byte Software](https://bytesoftware.com/byteweb/), [Capterra BytePro](https://www.capterra.com/p/9297/BytePro/reviews/))

---

### 1.5 Calyx (Point / Path)

| | |
|---|---|
| **Position** | Legacy small-shop standard, being phased out in favor of browser-based **Path**. |
| **Who uses it** | Brokers, very small lenders, incumbent Point users. |
| **Pricing** | **Path: ~$3 per loan application, no upfront fee, no monthly minimum** — pure per-use. ([Calyx](https://www.calyxsoftware.com/products/point), [SaaSworthy](https://www.saasworthy.com/product/calyx-point/pricing)) |

**Praised:** cheap, familiar, works offline (Point), lowest-friction migration path for the installed base.
**Complained about:** *"Desktop software in a cloud market"*; no real multi-user collaboration; limited
integrations; Path's case is "built on continuity rather than capability" — thin on integrations and reporting.

**Pricing lesson:** Calyx's $3/application, zero-minimum model is the only genuinely transparent pricing in
the category. That transparency is a differentiator we can copy.

---

### 1.6 nCino Mortgage Suite (formerly SimpleNexus)

| | |
|---|---|
| **Position** | POS/mobile origination layer, acquired by nCino Jan 2022, rebranded 2023. Claims involvement in **~25% of US originations**. ([nCino](https://www.ncino.com/news/simplenexus-rebrands-to-ncino)) |
| **Who uses it** | IMBs, banks, CUs — bought as the LO-facing mobile + borrower app in front of Encompass/Empower. |

**Praised:** LO mobility, co-branded LO/realtor-agent marketing, mobile-first borrower experience.
**Complained about:** post-acquisition regression — *"much of what was great about SimpleNexus is now defunct
under nCino's management,"* with **reduced customization options**.
([Software Advice](https://www.softwareadvice.com/loan-origination/simplenexus-profile/))

---

### 1.7 Blend

| | |
|---|---|
| **Position** | Best-known consumer-grade mortgage POS; public company (BLND). |
| **Who uses it** | Large banks and IMBs wanting a consumer-banking-grade application UX. |
| **Trajectory** | **Share is eroding: 17% of originations in 2025 HMDA data, down from 19% in 2024 and 22% in 2023.** Mortgage Suite revenue $17.2M in Q1'26 (+18% YoY) and $19.2M in Q2'26 (+7% YoY), but **economic value per funded loan fell to $79 from $88 (-10%)** — clear pricing pressure. ([HousingWire](https://www.housingwire.com/articles/blend-labs-q1-earnings-outlook/), [Investing.com Q2'26](https://www.investing.com/news/company-news/blend-labs-q2-2026-slides-margin-gains-but-shares-fall-on-guidance-93CH-4844530)) |

**2026 product move:** *Autopilot*, an AI agent product, went commercially available July 1 2026 —
65+ lenders activated, claimed **10–15% pull-through improvement, 2–4 day cycle-time reduction, 4.5 hours of
fulfillment tasks automated per loan**. ([NMP](https://nationalmortgageprofessional.com/news/blend-reports-early-ai-gains-while-mortgage-revenue-trails-volume))

**Our read:** those Autopilot numbers are the benchmark to beat. They also quantify the prize: ~4.5 hours of
manual fulfillment work exists per loan today. A DSCR loan has *less* documentation than an agency loan, so
the automatable fraction should be higher for us.

---

### 1.8 Floify

| | |
|---|---|
| **Position** | POS / document-collection layer for brokers and small correspondents. Owned by Porch Group. |
| **Pricing** | **Publicly listed at ~$79–$149 per user per month**, unlimited loan files and document requests, with LOS sync to Encompass, Calyx, and Byte. ([Software Advice](https://www.softwareadvice.com/loan-origination/floify-profile/), [GetApp](https://www.getapp.com/finance-accounting-software/a/floify/)) |

**Praised:** clean borrower UX, real-time document status tracking, strong LOS integrations.
**Limitation:** it is only a front door — the loan still has to live somewhere else.

---

### 1.9 Maxwell

Borrower onboarding + document collection + task management + lender submission, with an **automated document
request engine that sends borrowers dynamic checklists based on loan type**, plus eClose. Positioned to
smaller IMBs/banks on cycle-time and cost-per-loan reduction. Pricing not public.
([Mortgage Advisor Tools POS roundup](https://www.mortgageadvisortools.com/blog/best-mortgage-pos-platforms-for-lenders-in-2025/))

**Feature to steal:** *dynamic doc checklist driven by loan type/scenario* — for us that's DSCR vs. bank-stmt
vs. full-doc, entity vs. individual, purchase vs. cash-out refi.

---

### 1.10 LoanPASS

Not an LOS — a **rules-first product & pricing engine (PPE)** and the most credible non-agency PPE.

- Supports conventional, **non-QM, business-purpose (DSCR, investor, asset-based)**, HELOC, second liens,
  reverse, construction, fix-and-flip **from a single platform**.
- **No-code configuration** — business users change pricing and eligibility rules without engineering.
- Lender owns margins, **LLPAs, LLRAs, conditions, and exceptions**.
- Sub-second pricing; claims 150k+ scenarios/week.
- Added AUS and MI quoting (PMI Rate Pro acquisition).
- Pricing not public. ([LoanPASS](https://loanpass.io/))

**Why it matters to us:** LoanPASS is the proof that the *pricing/eligibility* problem for DSCR is solvable
declaratively. Our §5 lock/pricing data model should assume a LoanPASS-shaped engine (ours or theirs) and
focus our differentiation on the **lock desk and scenario lifecycle**, which LoanPASS does not own.

---

### 1.11 Mortgage Automator

Purpose-built origination **and servicing** for **private and hard-money lenders** in the US and Canada —
application → underwriting → servicing, renewals, and **fund management** in one system. Pricing: "contact
vendor," no public number. ([Capterra](https://www.capterra.com/compare/135553-191761/The-Loan-Office-vs-Mortgage-Automator))

**Relevance:** the closest analogue to our world on the short-term side. Its strength is that the *loan
lifecycle doesn't end at funding* — servicing, renewals, and investor/fund accounting are in the same system.
Any long-term investor-lending LOS that pretends the loan disappears at funding will lose to this shape.

---

### 1.12 Lendesk (and Jupiter LOS)

Canadian-origin broker platform (loan origination, loan management, TPO origination, pre-qual, e-app, e-sign,
doc management, credit, compliance). ([Capterra](https://www.capterra.com/p/137771/Lendesk/))

Most important 2026 development: **Jupiter LOS**, launched **February 2026 by Rocket Pro and Lendesk** —
broker-focused, **free to broker partners** ("pays only when the loan funds"), no upfront cost for credit
pulls or DU/LPA, one-click Rocket Pro submission, and exports the 1003 to any lender. Weakness: it is an
**intake/submission layer**, not end-to-end origination through closing.
([setshape](https://setshape.com/blog/top-loan-origination-systems))

**Pricing lesson #2:** success-based pricing ("free until it funds") is now in the market and will reset broker
expectations. Any TPO-facing product we build should assume brokers expect zero upfront cost.

---

### 1.13 Others worth tracking

- **ARIVE** — all-in-one for independent brokers, cited at roughly half the broker market; loan file +
  pricing + lender marketplace; full Rocket Pro integration as of 2026; broker-only by design; monthly subscription.
- **LendingPad** — cloud-native, genuine multi-user collaboration, *"deploys in weeks, not quarters,"*
  affordable; weaker investor connections, thinner compliance and reporting.
- **Blue Sage Solutions** — browser-native, multi-channel (retail/wholesale/correspondent) out of the box;
  smaller installed base and younger integration ecosystem.
- **LendingWise** — specialist for non-QM, hard money, fix-and-flip, commercial; configurable across loan types
  "that break agency platforms"; less refined on vanilla agency, small ecosystem.
- **LendingDox** — low-cost, document-workflow-focused, narrow feature set.

---

### 1.14 Who is winning share, and why

1. **Encompass keeps winning by default** — switching costs (integrations, investor delivery, trained staff,
   compliance history) exceed the pain of a slow UI.
2. **Cloud-native challengers win on time-to-value** — "weeks not quarters" is the single most repeated
   selling point (LendingPad, Blue Sage, ARIVE, Calyx Path, ByteWeb).
3. **Specialists win where the agency data model breaks** — LendingWise, Mortgage Automator, LoanPASS all grew
   by serving loans Encompass models badly. This is our lane.
4. **The POS layer is being commoditized** — Blend's evPFL fell 10% YoY and its share slid 22%→19%→17% over
   three years. Selling "a nicer front end" is no longer a business.
5. **2026's differentiator is AI agents + measurable cycle-time reduction** — Dark Matter's MCP server and
   Blend's Autopilot are the two loudest product stories of the year, and both are sold on hours-saved and
   days-of-cycle-time, not features.

---

### 1.15 What LOs and processors say is MISSING (synthesis)

This is the actionable list. Pulled from the review corpus above:

| Pain | What it means for our build |
|---|---|
| "2 minutes to open and close ONE LOAN" | Sub-second file open is a *feature*. Budget for it architecturally: server-rendered/streamed loan file, no monolithic form load. |
| "Thousands of radio buttons with no help" | Progressive disclosure + inline contextual help + scenario-driven field visibility. Never show a DSCR borrower an employment section. |
| Reporting "confusing for the average LO" | Two reporting tiers: (a) saved pipeline views any LO can build with clicks; (b) real query/BI for admins. |
| "Lacks customizable screens and reportable fields" | Custom fields must be first-class: instantly filterable, columnable, reportable, exportable, API-exposed. |
| Implementation "measured in quarters" | Self-serve onboarding with sane defaults; a tenant should originate a test loan on day one. |
| Per-seat + per-integration price compounding | Transparent, predictable pricing. Don't charge per integration. |
| Support "slow, lacks urgency" | In-product support surface with loan-level context attached. |
| Integrations are "where daily pain lives" | Integration health must be observable *in the loan file* — last call, status, error, retry — not buried in an admin log. |
| POS bought separately because the LOS's own borrower UX is unusable | Borrower/broker portal is not an add-on. It is the same application, same data, same conditions. |



---

## 2. The Pipeline / Dashboard

The pipeline is the LOS's home screen and the single most-used surface in the product. Get it wrong and
nothing else matters.

### 2.1 What Encompass actually shows (the baseline to beat)

ICE's own documentation defines the default pipeline column set. Encompass Mobile / LO Connect docs list:

> "the lock status, borrower name, milestone, expected closing date, loan amount, loan program, number of
> alerts, Debt-to-Income ratio, Loan-to-Value ratio, and rate for each loan."
> — [ICE: The Pipeline (LO Connect)](https://help.icemortgagetechnology.com/LOConnect/Content/Pipeline.htm),
> [ICE: Pipeline Overview (Mobile)](https://help.icemortgagetechnology.com/documentation/mobile/content/mobile/loans/Pipeline_Overview.htm)

Mechanics:

- **Sorting** — tap a column header to sort asc/desc; an arrow shows the active sort.
- **Search** — type-ahead filtering by borrower last name as you type. Advanced (tablet) search covers
  loan number, borrower name, loan amount, subject property address, interest rate, loan program, loan
  purpose, milestone, and alerts.
- **Custom columns** — you can add columns, **but only for fields that have first been added to the
  Encompass Reporting Database via Admin Tools**. This is the single biggest structural complaint about
  Encompass pipelines. ([ICE](https://help.icemortgagetechnology.com/LOConnect/Content/Pipeline.htm),
  [adding fields to the reporting DB](https://www.youtube.com/watch?v=f78eDeOWeoo))
- **Loan folders** — loans are physically bucketed into folders (My Pipeline, Archive, Adverse, Prospects,
  Trash, plus custom folders), and folder access is a permission.
- **Alerts** — an alert count column; alerts also live on the Alerts & Messages tab of the loan Log, with
  desktop notifications while Encompass is open.
- **Milestones** — thirteen predefined out of the box: **Started, Qualification, Send to Processing,
  Submittal, Cond. Approval, Resubmittal, Approval, Doc Preparation, Docs Signing, Funding, Post Closing,
  Shipping, Completion**. The Log shows completed *and future* milestones.
- **Persona-based pipeline views** — "Pipeline View can be created for each persona by configuring the
  columns that display on the Pipeline, the order in which they appear, the sorting order for the loan
  entries, and by applying search filters to the Pipeline data." Admins can create custom personas and
  restrict access to individual screens, fields, and loan folders.
  ([ICE 25.x persona-based release notes](https://help.icemortgagetechnology.com/documentation/encompass/Content/encompass/release_notes/25-1/RNBP/index.htm),
  [interface customization writeup](https://mortgageworkspace.com/blog/building-a-faster-home-loan-process-through-encompass-interface-customization))

### 2.2 Column inventory for a modern pipeline

Grouped by who needs them. A best-in-class pipeline ships all of these as *available* columns and gives each
role a sane default subset.

**Identity / file**
`Loan #` · `Borrower / Entity name` · `Co-borrower(s)` · `Subject property address` · `County` · `State` ·
`Occupancy` · `Property type` · `Units` · `Loan purpose` (purchase / R&T refi / cash-out) ·
`Channel` (retail / wholesale-TPO / correspondent) · `Broker / Account exec` · `Loan program` ·
`Product` (30yr fixed, 5/6 ARM, 10yr IO, …) · `Investor / take-out` · `Loan folder`

**Money**
`Loan amount` · `Purchase price / As-is value` · `Appraised value` · `LTV` · `CLTV` · `Note rate` ·
`Points/Price` · `Lock status` · `Locked rate` · `Lock expiration` · `Days to lock expiry` ·
`P&I` · `PITIA` · `Reserves (months)` · `Cash to close`

**Investor-lending specific (missing from every agency LOS)**
`DSCR` · `Gross monthly rent` · `Market rent (1007)` · `Lease in place? (Y/N)` · `Vacancy assumption` ·
`Taxes/Ins/HOA` · `Entity name` · `Entity type (LLC/LP/Corp)` · `Entity state` · `Guarantor(s)` ·
`# properties owned` · `Borrower experience tier` · `Portfolio exposure to this borrower` ·
`Prepay penalty structure` · `Interest-only? / IO period` · `Cross-collateralized? / # properties in loan`

**Workflow / ops**
`Milestone / stage` · `Days in current stage` · `Total age (days since application)` ·
`Assigned LO` · `Assigned processor` · `Assigned underwriter` · `Assigned closer` · `Assigned funder` ·
`Open conditions count` (by category) · `Conditions in review` · `Docs outstanding` ·
`Last borrower contact` · `Last activity timestamp` · `Next action / next task due`

**Dates & SLA**
`Application date` · `Disclosure sent / signed` · `Credit pull date & expiry` · `Appraisal ordered / received / expiry` ·
`Title ordered / received` · `Submitted to UW` · `Approved` · `CTC` · `Docs out` · `Signing` ·
`Funding` · `Estimated closing date (ECD)` · `Contract expiration` · `Rate lock expiration` ·
`Days to close` · `SLA status per stage (green/amber/red)`

**Risk / exception**
`Exceptions open` · `Guideline overlays triggered` · `Appraisal variance` · `Fraud/OFAC status` ·
`Flood zone` · `HOI expiration` · `Compliance test status (TRID/HPML/QM)`

### 2.3 Filters, saved views, and role-based defaults

**Filter primitives users expect**

- Free-text search across borrower, entity, address, loan number, broker.
- Multi-select facets: stage, program, channel, state, investor, assigned user, loan folder, lock status.
- Numeric ranges: loan amount, LTV, DSCR, FICO, rate.
- Date ranges with relative operators: "closing in next 7 days," "locked expiring in 5 days,"
  "no activity in 3+ days," "app date last 30 days."
- Boolean/derived flags: has open PTF conditions, appraisal not ordered, missing insurance, lock expired.
- Negation and "is empty" (surprisingly rare and constantly requested).

**Saved views** — named, shareable, with a defined column set + filter set + sort + grouping. Best practice is
three tiers: *personal* views, *team* views published by a manager, and *system* views shipped by the tenant
admin. Views should be URL-addressable so a manager can paste a link in Slack.

**Role-based defaults** (this is what "persona" means in Encompass, generalized):

| Role | Default scope | Default sort | Columns that matter |
|---|---|---|---|
| **Loan officer** | My loans (all stages, incl. prospects/leads) | ECD ascending | Borrower, stage, lock status/expiry, rate, ECD, open borrower-facing conditions, last contact, next task |
| **Processor** | My assigned files, active stages only | Days-in-stage descending | Conditions outstanding, doc status, appraisal/title/HOI status, submitted-to-UW date, SLA flags |
| **Underwriter** | Queue: files awaiting review, unassigned first | Time-in-queue descending | Submitted timestamp, resubmission count, conditions in review, DSCR/LTV/FICO, exceptions, program/overlays |
| **Closer** | Approved / CTC files | Signing date ascending | CTC date, docs-out, signing appointment, closing agent, wire status, funding conditions |
| **Funder** | Docs-signed / ready-to-fund | Funding date ascending | Funding conditions, wire, disbursement date, trailing docs |
| **Lock desk** | All locked + pending lock requests | Lock expiry ascending | Lock status, expiry, extensions used, worst-case flag, product/price, pending change requests |
| **Manager / exec** | Whole org, roll-up + drill-down | Configurable | Volume by stage, aging outliers, SLA breaches by team member, pull-through, cycle time, capacity/WIP per processor |
| **Broker (TPO)** | Only their own submissions | Status | Status, conditions assigned to broker, lock status/expiry, docs needed, AE contact |
| **Borrower** | Their one loan | — | Milestone tracker, what we need from you, what's done |

Public confirmation this tiering is the expectation: *"A loan officer sees their pipeline, a branch manager
sees the branch pipeline, an operations director sees the firm-wide pipeline, and a CFO sees the revenue
forecast roll-up, all from the same integrated data feed."*
([Zeitro](https://www.zeitro.com/blog/mortgage-pipeline-management))

**"My files vs. team files"** should be a first-class scope toggle at the top of the pipeline —
`Mine · My team · All (I can see)` — not a filter buried in a saved view. Scope must be enforced by the
permission layer, not just the UI (see §6).

### 2.4 Aging, SLA, and turn-time indicators

The metrics the industry actually manages against:

- **Days in current stage** with a per-stage SLA threshold, rendered as green/amber/red. Practice is to
  "define stage SLAs (max days-in-stage) by segment and enforce via alerts and manager reviews."
- **Total cycle time** — application → funding; and sub-cycles: app→submit, submit→approval,
  approval→CTC, CTC→funding.
- **Touch count / resubmission count** — how many times a file went back to underwriting.
- **Pull-through rate** — closed ÷ locked applications; **fallout rate** — the inverse.
- **At-risk flags** — *"a pipeline health dashboard that flags at-risk loans 14 days before close gives loan
  officers time to intervene before cancellation."*
- **No-activity flags** — files with no log event in N days.
- **Expiry countdowns** — rate lock, credit report, appraisal, purchase contract, HOI, entity good standing.
- **Capacity / WIP per processor and underwriter** — files per person by stage; used for round-robin assignment.
  ([Zeitro pipeline management](https://www.zeitro.com/blog/mortgage-pipeline-management),
  [Zeitro pipeline software](https://www.zeitro.com/blog/best-mortgage-pipeline-management-software),
  [pipeline aging methodology](https://umbrex.com/resources/company-analysis/sales/pipeline-aging-by-stage/))

Design rule: **every SLA clock must be visible as a column, filterable as a predicate, and subscribable as an
alert.** If a user can see "amber," they must be able to build a saved view "show me all amber," and then a
notification "tell me when anything goes amber."

### 2.5 Alerts and notifications

Encompass's model is an alert count on the pipeline row plus an Alerts & Messages tab in the Log, plus
desktop toasts. That's the floor. A modern implementation adds:

- **Alert taxonomy**: expiry alerts, SLA breach alerts, action-required alerts, integration-failure alerts,
  compliance alerts, and inbound-event alerts (borrower uploaded a doc, broker responded to a condition).
- **Per-user subscription rules** — "notify me when a file I own enters amber," "notify the lock desk when any
  lock is 3 days from expiry."
- **Digest vs. real-time** channels: in-app, email, SMS, Slack/Teams webhook.
- **Alerts must be dismissible with a reason and auditable** — who cleared what, when.
- **Snooze with a required follow-up date** — the alert that can be permanently ignored is worse than none.

### 2.6 Stage / milestone display

Two competing models; ship both:

1. **Linear milestone tracker** (Encompass style) — an ordered list of milestones showing completed and future
   ones with dates and the responsible role. Good for borrower- and broker-facing status.
2. **Kanban / board view** — columns = stages, cards = loans, WIP counts per column, drag to advance. Good for
   processors and managers; almost no traditional LOS ships it and it is a common request.

Additional display requirements:

- Stage must be **derived from evidence**, not manually toggled, wherever possible (e.g. "Submitted to UW" is
  set by the submission event, not by someone clicking a dropdown).
- **Sub-status within a stage** — e.g. In Underwriting → *initial review / suspended / conditioned / re-review*.
  Encompass's flat 13-milestone model forces shops to abuse "Resubmittal" for everything.
- **Stage history with durations** — a per-file timeline showing how long each stage took and who held it.

### 2.7 What users say is missing

| Gap | Evidence / reasoning |
|---|---|
| **Custom fields don't appear in the pipeline without an admin adding them to a separate reporting database** | ICE docs: "in order to view these fields in the pipeline you must add them to the reporting database." MeridianLink users likewise complain it "lacks customizable screens and reportable fields." This is the #1 structural gap. |
| **Reporting is opaque to normal users** | Encompass reporting called "confusing for the average loan officer." Users want *saved pipeline views*, not a report builder. |
| **No native board/kanban view; no WIP visibility** | Absent from Encompass/Empower/MeridianLink pipelines; managers rebuild it in spreadsheets. |
| **Aging/SLA is not built in** | Shops build days-in-milestone tracking with custom fields, business rules, and BI tools rather than getting it out of the box. |
| **Sluggishness at the list level** | "It takes about 2 minutes to open and close ONE LOAN" — pipeline→file→pipeline round trips dominate the day. |
| **Broker and borrower views are separate products** | Brokers get a TPO portal (ICE TPO Connect, Blue Sage TPO, Pennymac POWER+, PRMG LEO); borrowers get a POS (Blend/Floify/Maxwell). Three different pipelines, three sources of truth. |
| **No cross-loan borrower/portfolio view** | Critical for investor lending: one sponsor with 14 properties should be one row that expands, plus exposure totals. No agency LOS models this. |
| **Bulk actions** | Selecting 20 files and reassigning a processor, or bulk-ordering, is generally unavailable. |
| **Integration health invisible in the pipeline** | "Whichever LOS you pick, the connection to the rest of your stack is where daily pain lives." |

**Our differentiators for the pipeline:** every field reportable the moment it exists; SLA/aging native;
one pipeline engine serving internal, broker, and borrower views with different projections; portfolio/sponsor
roll-up as a first-class grouping; kanban + list + calendar; and URL-addressable saved views.



---

## 3. URLA / 1003 (2020)

### 3.1 Official sources

| Document | Link |
|---|---|
| Fannie Mae — Uniform Residential Loan Application (Form 1003) hub | https://singlefamily.fanniemae.com/delivering/uniform-mortgage-data-program/uniform-residential-loan-application |
| Fannie Mae — Uniform Loan Application Dataset (ULAD) hub | https://singlefamily.fanniemae.com/delivering/uniform-mortgage-data-program/uniform-loan-application-dataset |
| Fannie Mae — URLA/ULAD FAQs | https://singlefamily.fanniemae.com/learning-center/delivering/faqs-uniform-residential-loan-application-uniform-loan-application-dataset |
| Fannie Mae — Instructions for Completing the URLA | https://singlefamily.fanniemae.com/media/document/pdf/instructions-completing-uniform-residential-loan-application |
| Freddie Mac — ULAD / URLA hub | https://sf.freddiemac.com/tools-learning/uniform-mortgage-data-program/ulad |
| Freddie Mac — URLA/ULAD FAQ | https://sf.freddiemac.com/faqs/uniform-residential-loan-application-urla-uniform-loan-application-dataset-ulad-faq |
| Freddie Mac — URLA Instructions (PDF) | https://sf.freddiemac.com/docs/pdf/fact-sheet/urla_instructions.pdf |
| FHFA-hosted URLA Instructions (10-12-22) — mirror that isn't geo-blocked | https://www.fhfa.gov/sites/default/files/2024-04/URLA%20Instructions%20updated%2010-12-22.pdf |
| Fannie Mae DU Specification (MISMO v3.4) | https://singlefamily.fanniemae.com/media/7571/display |
| Freddie Mac LPA Specification Bulletin (v5.1.00) | https://sf.freddiemac.com/docs/pdf/other/lpa-specification-bulletin-v5.1.00-aug-2022.pdf |
| Joint GSE URLA/AUS spec announcement (Nov 2019) | https://sf.freddiemac.com/docs/pdf/other/urla-november-2019-announcement_fre.pdf |

> Note: `singlefamily.fanniemae.com` and `sf.freddiemac.com` return HTTP 403 to automated fetchers. Use the
> FHFA mirror or a browser for the actual PDFs. The **ULAD Mapping Document** itself is distributed on
> request — email `ULAD@FannieMae.com` / `ULAD@FreddieMac.com` or go through your GSE rep.

**Timeline:** redesigned URLA published 2019; **mandatory for all new loans delivered to the GSEs
March 1, 2021**.

### 3.2 Form components

The URLA is a *family* of documents, not one form:

1. **Uniform Residential Loan Application** — Borrower Information (Sections 1–9), completed by/for the
   first borrower.
2. **URLA – Additional Borrower** — mirrors Sections 1, 5, 7, 8, 9 for each additional borrower.
   (Sections 2, 3, 4 are shared across a borrower pair.)
3. **URLA – Unmarried Addendum** — captures civil-union / domestic-partnership relationships where state law
   confers property rights.
4. **URLA – Continuation Sheet** — overflow for any section.
5. **URLA – Lender Loan Information** — the lender-completed L1–L4 pages; not signed by the borrower.

### 3.3 Section structure and numbering

**Borrower-completed sections**

| § | Title |
|---|---|
| **1** | **Borrower Information** |
| 1a | Personal Information |
| 1b | Current Employment/Self-Employment and Income |
| 1c | Additional Employment/Self-Employment and Income |
| 1d | Previous Employment/Self-Employment and Income |
| 1e | Income from Other Sources |
| **2** | **Financial Information — Assets and Liabilities** |
| 2a | Assets — Bank Accounts, Retirement, and Other Accounts You Have |
| 2b | Other Assets and Credits You Have |
| 2c | Liabilities — Credit Cards, Other Debts, and Leases that You Owe |
| 2d | Other Liabilities and Expenses |
| **3** | **Financial Information — Real Estate** |
| 3a | Property You Own |
| 3b | Additional Property (IRS Form 1040 Schedule E-equivalent detail) |
| 3c | Additional Property |
| **4** | **Loan and Property Information** |
| 4a | Loan and Property Information |
| 4b | Other New Mortgage Loans on the Property You Are Buying or Refinancing |
| 4c | Rental Income on the Property You Want to Purchase |
| 4d | Gifts or Grants You Have Been Given or Will Receive for this Loan |
| **5** | **Declarations** |
| 5a | About this Property and Your Money for this Loan |
| 5b | About Your Finances |
| **6** | Acknowledgments and Agreements |
| **7** | Military Service |
| **8** | Demographic Information |
| **9** | Loan Originator Information |

([AD Mortgage URLA guide](https://admortgage.com/blog/an-ultimate-guide-on-completing-the-urla/),
[LegalClarity URLA sections](https://legalclarity.org/what-is-the-urla-in-mortgage-sections-and-requirements/),
[Ocrolus 1003 (2020) field map](https://docs.ocrolus.com/docs/1003-2020))

**Lender Loan Information (L1–L4)**

| § | Title | Notes |
|---|---|---|
| **L1** | Property and Loan Information | Community property state flag, refinance type/program, energy improvement, mixed-use, manufactured home. |
| **L2** | Title Information | Names on title, manner in which title will be held, **Estate held in: Fee Simple / Leasehold (required for all loan types)**, trust/Indian country land indicators. |
| **L3** | Mortgage Loan Information | Note rate, loan term, mortgage type (Conventional/FHA/VA/USDA/Other), amortization type, balloon/IO/negative-am/prepay flags, proposed monthly PITIA breakdown. *All data points required except ARM time periods.* |
| **L4** | Qualifying the Borrower — Minimum Required Funds or Cash Back | High-level cash-to-close calc from total transaction costs, loan amount, credits, and subordinate financing. **Loan amount required regardless of mortgage type.** |

([Fannie Mae L1–L4 guidance PDF](https://singlefamily.fanniemae.com/media/7956/display))

### 3.4 ULAD and MISMO v3.4

- **ULAD Mapping Document** ties *each field on the URLA* to its equivalent data point(s) in the **MISMO
  Reference Model v3.4**. Critically: *"ULAD is not a specification"* — it's a cross-reference to familiarize
  you with standard MISMO terms.
- The authoritative business rules — **when a data point must be present in a submission** — live in each
  GSE's **AUS specification**, not in ULAD.
- **Fannie Mae DU Specification**: MISMO v3.4-based; versions have progressed 1.8 → 1.8.2 → **1.9.1**
  (new DU messages implemented in the DU integration environment around Aug 27, 2025).
  ([USDA GUS bulletin referencing DU spec 1.8.2](https://content.govdelivery.com/accounts/USDARD/bulletins/2fff06b),
  [Fannie DU Spec](https://singlefamily.fanniemae.com/media/7571/display))
- **Freddie Mac LPA Specification**: v5.0.06 → **v5.1.00**, which notably **added two data points that are
  not in MISMO v3.4** — a warning that the "standard" is not fully sufficient.
  ([LPA Spec Bulletin v5.1.00](https://sf.freddiemac.com/docs/pdf/other/lpa-specification-bulletin-v5.1.00-aug-2022.pdf))

**Engineering implications:**

1. **Store canonical MISMO v3.4 containers, not form fields.** The URLA PDF is a *rendering* of the data, not
   the data. Model `DEAL / PARTIES / COLLATERALS / LOANS / ASSETS / LIABILITIES / EXPENSES / INCOMES /
   DECLARATIONS / GOVERNMENT_MONITORING`.
2. **Round-trip requirement:** we must be able to produce (a) a compliant MISMO 3.4 AUS request XML,
   (b) a pixel-correct URLA PDF for signature, and (c) an import of a third-party 1003 (MISMO 3.4 XML or
   Fannie 3.2/DU 1003 flat file, which brokers still send). Support **1003 import** on day one — brokers will
   not retype.
3. **Version the spec, not the code.** DU 1.8.2 → 1.9.1 → next. Treat the AUS spec version as configuration.
4. **Expect out-of-standard fields.** LPA already carries two. DSCR carries dozens. Have a first-class
   extension mechanism (MISMO EXTENSION containers) rather than jamming values into free-text.

### 3.5 What a great digital 1003 UX looks like

**Progressive disclosure**

- Ask *one decision at a time*, not one form page at a time. The screen sequence should be driven by a
  declarative interview graph, not by the PDF's section order.
- **Scenario-first routing**: loan purpose → occupancy → borrower type (individual vs. entity) →
  doc type (full doc / bank statement / DSCR / asset depletion). Those four answers should eliminate 60%+ of
  the questions before the borrower sees them.
- **Never show a section that will be empty.** DSCR: hide 1b/1c/1d entirely. No gift funds: hide 4d.
  No subordinate financing: hide 4b.
- **Defer, don't block.** Any field that isn't needed to price or to run AUS should be collectable later.
  The application should be submittable in minutes and completable over days.
- **Save-and-resume with per-section completeness indicators**, plus a persistent "what's left" panel.
- **Smart defaults + enrichment**: address autocomplete → county, FIPS, flood zone, tax and HOA estimates;
  entity name → Secretary of State record; property address → prior transaction and rent comps.

**Multiple borrowers / borrower pairs**

- Model **N borrowers** with an explicit **application/borrower-pair grouping**, because Sections 2/3/4 are
  shared per pair while 1/5/7/8/9 are per borrower. Encompass's borrower-pair model is the industry norm and
  brokers expect it; it must survive round-trip to DU/LPA.
- Support **joint vs. individual credit** (URLA 1a "Type of Credit") and drive the whole downstream flow
  from it — a joint election changes credit pulls, disclosures, and adverse action.
- **Invite each borrower separately** with their own login. Never make borrower 1 type borrower 2's SSN.
  Each borrower e-signs their own copy.
- **Non-borrowing spouse** and the **Unmarried Addendum** must be modeled, not hand-waved — community
  property states and civil-union states have real requirements.

**Entity / LLC borrowers (the biggest gap in every agency LOS)**

The observed industry practice: *"Lenders submit the 1003/URLA with the entity as the primary borrower, with
the natural person becoming 'guarantor' in second or third positions."*
([Ridge Street Capital](https://www.ridgestreetcap.com/blog/dscr-loan-for-llc),
[OfferMarket DSCR for LLC guide](https://www.offermarket.us/blog/dscr-loan-for-llc))

That is a hack. A correct model:

- **Party** is polymorphic: `Individual` or `LegalEntity`. Both can hold **roles** on the loan:
  `Borrower`, `Guarantor`, `Member/Owner`, `Authorized Signer`, `Trustee`, `Beneficiary`, `Seller`, `Broker`.
- Entity attributes: legal name, DBA, **entity type** (LLC / LP / LLP / S-Corp / C-Corp / Trust / Series LLC),
  **state of formation**, formation date, EIN, **good-standing status + expiration**, registered agent,
  **foreign qualification in the property state**, and the **ownership graph** (members and their % — recursive,
  because members are often other LLCs).
- **Beneficial ownership rollup** to natural persons for KYC/OFAC and for guarantor determination
  (typically ≥20% owners must guarantee).
- **Entity documents as a checklist**: Articles/Certificate of Formation, Operating Agreement (with
  authorized-signer identification), Certificate of Good Standing (with expiry date driving an alert),
  EIN letter, and — where required — a resolution authorizing the loan.
- **Guarantor credit and background** — pulled on the natural persons, with credit report expiry tracked
  per person.
- **Entity reuse across loans.** A repeat sponsor's LLC should be selected, not retyped; and the LOS should
  show all loans that entity is on.

**DSCR loans skipping employment**

Public confirmation that the standard 1003 is a bad fit: *"this is designed for conventional loans and
includes lots of questions and information not required by DSCR lenders"*; DSCR-only lenders use *"customized
applications with questions and fields only specifically needed for DSCR loan qualification, typically a few
pages taking approximately 15 minutes."* ([OfferMarket](https://www.offermarket.us/blog/dscr-loan-for-llc))

And on documentation substitution: *"conventional files trade personal income documents for a job-history
check, while DSCR files trade those documents for a market-rent conclusion from a licensed appraiser."*
([Lendmire](https://www.lendmire.com/do-lenders-verify-employment-on-dscr-loans/))

So the DSCR application replaces 1b–1e and 2d/DTI with a **property cash-flow module**:

| DSCR module field | Notes |
|---|---|
| Lease in place? | Yes → executed lease + proof of receipt (2 months bank statements / rent roll) |
| Actual gross monthly rent (per unit) | Multi-unit: per-unit rent roll |
| Market rent (appraisal Form 1007 / 1025) | The qualifying rent is usually **lesser of actual and market**, or a % of market |
| Short-term rental? | AirDNA/Rabbu 12-month revenue where the program allows STR |
| Vacancy factor | Program-configured (often 0% if leased, 25% haircut for STR) |
| Annual property taxes | Source: tax cert / county |
| Annual hazard + flood insurance | Source: HOI quote/binder |
| HOA dues | Monthly |
| PITIA | Computed |
| **DSCR** | Qualifying rent ÷ PITIA — the single most important derived number in the file |
| Property management | Self vs. third-party; some programs adjust |
| Borrower experience | # of investment properties owned/exited in N years — drives pricing tier |
| Sponsor portfolio exposure | Total UPB with us across all loans; concentration limits |
| First-time investor flag | Common LLPA / eligibility trigger |

**The right architecture: one interview engine, many products.** Define the application as a
**declarative interview schema** (nodes = questions/groups, edges = visibility predicates over collected
answers) that compiles to (a) the UI, (b) the validation rules, (c) the MISMO/URLA projection, and
(d) the document checklist. Then "DSCR application," "full-doc non-QM application," and "conventional
application" are configurations, not codebases — and a tenant can add a program without an engineering ticket.

**Other UX requirements observed as table stakes**

- Mobile-first; borrowers complete applications on phones.
- Asset/income/employment verification via account connection (Plaid/Finicity/AccountChek) offered inline as
  the *easier* path, with manual upload as fallback.
- Real-time field validation and inline explanation of *why* something is asked.
- Co-branded broker/LO experience (this is nCino Mortgage Suite's whole value proposition).
- E-consent (E-SIGN) captured before any electronic disclosure, with an audit trail.
- Auto-generated document checklist on submission — Maxwell's "dynamic checklists based on loan type."



---

## 4. Condition Management / Condition Center

Conditions are where a loan file actually lives or dies. This is the highest-leverage surface in the whole
LOS, and it is under-built everywhere.

### 4.1 Condition categories — the industry vocabulary

The standard "Prior To" taxonomy:

| Code | Name | Meaning |
|---|---|---|
| **PTA** | Prior to Approval | Must be satisfied before the underwriter issues the conditional approval. Blocks the approval decision. |
| **PTD** | Prior to Docs / Prior to Doc Draw | Must clear before closing documents are drawn and sent to the settlement agent. *"PTD conditions can impact the borrower/property qualification."* |
| **PTC** | Prior to Closing / Clear-to-Close | Must clear before CTC is issued. Many shops fold this into PTD; some keep both. |
| **PTF** | Prior to Funding | Must clear before the wire goes out. *"more fundamental in nature"* — often procedural/verification items (verbal VOE, final title, funding authorization). |
| **PTP / Post-Closing** | Post-Closing / Trailing Docs | Recorded mortgage, final title policy, final HUD/CD, trailing originals. Blocks investor delivery/purchase, not funding. |
| **Prior to Purchase / Suspense** | Investor-side | Raised by the take-out investor after delivery; must be modeled or you lose track of loans in suspense. |

([NAMP: PTD, PTF](https://www.mortgageprocessor.org/mortgage-processor-news/2012/09/07/ptd-ptf-add),
[The Truth About Mortgage: conditional approval](https://www.thetruthaboutmortgage.com/what-is-a-conditional-loan-approval/),
[New American Funding: path to final approval](https://www.newamericanfunding.com/blog/the-path-to-final-loan-approval-know-all-the-conditions/))

Orthogonal to "Prior To," conditions also carry:

- **Type** — Underwriting / Preliminary / Post-Closing (Encompass's three condition collections).
- **Category** — Credit, Income, Assets, Property/Appraisal, Title, Insurance, Entity/Legal, Compliance,
  Closing, Misc. (This is what drives reporting on *why* your condition volume is high.)
- **Source** — who raised it: Underwriter, Investor, Compliance/QC, AUS (DU/LPA findings), System/auto-rule,
  Closing, Post-closing.
- **Recipient / Responsible party** — Borrower, Broker/TPO, Loan Officer, Processor, Underwriter, Closer,
  Title/Escrow, Appraiser, Insurance agent, Internal ops. **The party who has the ball must be a field**,
  because the whole SLA model hangs off it.

### 4.2 What Encompass actually does

**Data model.** Conditions are entries in the **eFolder**. The Developer Connect API exposes underwriting,
post-closing, and preliminary conditions. Key documented facts:

- *"A condition is an entry in the eFolder that allows you to track the status of a loan condition as the
  loan moves through the Pipeline."*
- **Many-to-many with documents**: "Multiple documents can be associated with a single condition, and
  documents may be assigned to several conditions simultaneously."
- Each condition gets a unique condition ID returned in the response header, required for all subsequent
  operations.
  ([ICE Developer Connect — Loan Conditions](https://developer.icemortgagetechnology.com/developer-connect/reference/loan-conditions))

**Enhanced Conditions** (the newer tool) standardizes that every condition type carries the same
**Category, Prior To, Source, and Recipient** values.
([Take Five Consulting](https://www.takefiveconsulting.org/overview-of-enhanced-condition-tool-in-encompass/))

**What works:** condition templates/sets, automated triggers that create conditions based on loan type,
document placeholders in the eFolder, the system connecting documents to the conditions they fulfill, and
broker-facing condition upload via TPO Connect (upload to the specific condition via drag-and-drop, then
click **"ready for review"**).
([theLender TPO Connect condition upload instructions](https://wholesale.thelender.com/wp-content/uploads/2025/05/Submit-Conditions-to-theLender.pdf),
[Impac broker guide](https://impacwholesale.com/Documents/BrokerWelcomeGuide/Broker%20Welcome%20Guide.pdf),
[USALLIANCE TPO Connect guide](https://www.usalliance.org/hubfs/documents/Mortgage_Docs/Broker%20Portal%20-%20TPO%20Connect/Website%20User%20Guide.pdf))

### 4.3 Where Encompass falls short

| Gap | Detail |
|---|---|
| **Templates are dumb text** | *"There is not a way for condition templates to refer to loan data, and if an underwriter wants to update the condition to match new loan information, there aren't any automatic options."* Standard practice is to **leave blanks in the template for the underwriter to fill in by hand**. Third parties sell a plugin ("Conditions with Fields") purely to add merge fields to condition text. ([Lender Toolkit](https://lendertoolkit.com/powertools/conditions-with-fields/), [Lender Toolkit: reducing conditions](https://lendertoolkit.com/how-lenders-reduce-underwriting-conditions-in-encompass/)) |
| **No native root-cause analytics** | *"Many lenders know they have too many conditions, but they do not always know why."* No out-of-the-box "conditions per loan by category by source by underwriter by broker." |
| **Auto-clearing is weak** | Encompass connects documents to conditions but does not *read* them. The market answer is a third-party layer (Ocrolus, TRUE) rather than native capability. |
| **Condition text is free-form and inconsistent** | Two underwriters phrase the same condition three ways; borrowers get confused; analytics become impossible. No enforced canonical condition IDs. |
| **Borrower-facing view is a separate product** | Borrowers see conditions through a POS (Blend/Floify/Maxwell), which then has to sync. Two systems, one truth. |
| **No SLA clock per condition** | Age of a condition, time-in-broker-court vs. time-in-underwriter-court, is not native. |
| **Submission vs. review is one blurred event** | "Ready for review" exists in TPO Connect but the full event log (submitted → in review → rejected with reason → resubmitted) is not richly modeled or reportable. |
| **Conditions don't know about each other** | No dependencies ("clear the entity docs before the authorized-signer condition makes sense"), no grouping, no dedupe when three conditions all ask for the same bank statement. |

### 4.4 The 2026 state of the art (what we must at least match)

**Ocrolus Automated Conditioning** — GA **April 1, 2026**:

- **Automatically generates conditions** aligned with selling-guide requirements, eliminating manual authoring
  by the underwriter.
- **Automatically matches incoming documents to the appropriate condition** as they arrive.
- **Syncs conditions and document placeholders directly into Encompass.**
- Full lifecycle in one workspace: review, edit, import, resolve without toggling systems.
  ([PR Newswire](https://www.prnewswire.com/news-releases/ocrolus-accelerates-automated-conditioning-for-mortgage-lenders-with-full-lifecycle-management-302715996.html))

**TRUE** — condition matching plus **exception routing**, "flagging only the items that need attention."

**Benchmark to beat:** *"Some lenders now report auto-clearing 70–75% of credit, income, and asset conditions
without underwriter touch, with targets pushing past 85% by late 2026."* AI adoption among mortgage lenders
went **15% (2023) → 38% (2024)** and has kept climbing.
([Zeitro: AI underwriting software](https://www.zeitro.com/blog/best-ai-mortgage-underwriting-software),
[addy: AI mortgage software](https://addy.com/blog/custom-ai-mortgage-software))

**Conclusion: native, AI-assisted condition auto-clearing is now table stakes, and the fact that Encompass
users must buy it from Ocrolus is the clearest product opening in the entire category.**

### 4.5 Target design: the Condition Center

**Condition record (proposed fields)**

```
condition
  id                       uuid
  loan_id                  uuid
  template_id              uuid?           -- link back to the library entry
  code                     string          -- canonical, e.g. "INC-BANKSTMT-2MO"
  title                    string          -- short, borrower-readable
  body                     string          -- rendered from template + merge fields
  body_internal            string?         -- underwriter-only notes
  category                 enum            -- Credit|Income|Assets|Property|Title|Insurance|Entity|Compliance|Closing|Misc
  prior_to                 enum            -- PTA|PTD|PTC|PTF|PostClosing|PriorToPurchase
  type                     enum            -- Underwriting|Preliminary|PostClosing|Investor
  source                   enum            -- Underwriter|Investor|Compliance|AUS|SystemRule|Closing|QC
  responsible_party        enum            -- Borrower|Broker|LO|Processor|UW|Closer|Title|Appraiser|Insurance|Internal
  assigned_user_id         uuid?
  status                   enum            -- Draft|Active|Submitted|InReview|Rejected|Waived|Cleared|Expired|NotApplicable
  waiver_reason            string?
  waived_by                uuid?
  is_blocking              bool            -- derived from prior_to vs current stage
  expected_doc_types       string[]        -- drives auto-matching
  auto_clear_rule_id       uuid?           -- declarative rule that can clear this without a human
  auto_clear_confidence    decimal?        -- when cleared by AI
  depends_on               uuid[]          -- other condition ids
  visible_to_borrower      bool
  visible_to_broker        bool
  due_date                 date?
  sla_hours                int?
  created_at / created_by
  first_submitted_at
  last_submitted_at
  cleared_at / cleared_by
  reopened_count           int
  aging_days_total         int             -- derived
  aging_days_in_our_court  int             -- derived: time in InReview
  aging_days_in_their_court int            -- derived: time in Active/Rejected awaiting submission
```

**Condition ↔ document link (many-to-many, as Encompass has, plus more)**

```
condition_document
  condition_id, document_id
  match_source     enum   -- Manual|AutoClassified|BorrowerUpload|BrokerUpload|Vendor
  match_confidence decimal
  satisfies        bool   -- this doc alone satisfies vs. partial
  page_range       string? -- a 40-page PDF may satisfy 6 conditions on different pages
  extracted_fields json?   -- what OCR/AI read out of it, so the auto-clear rule can evaluate
```

**Event log (append-only) — this is the compliance and SLA backbone**

```
condition_event
  id, condition_id, actor_id, actor_role, actor_channel (internal|borrower|broker|system|vendor)
  event_type  -- Created|Edited|Assigned|Submitted|ReviewStarted|Rejected|Cleared|Waived|Reopened
               |Expired|Visibility Changed|DocAttached|DocRemoved|AutoCleared|AutoClearOverridden
  reason_code, reason_text
  before_json, after_json
  occurred_at
```

Design principle: **submission and review are distinct events with distinct actors and timestamps.** That
single decision gives you: broker scorecards ("this broker resubmits 3.2x per condition"), underwriter
scorecards, accurate turn-time SLAs, and a clean "who had the ball" narrative for every day of the file.

**Condition library / templates**

- Canonical, **coded** conditions (a stable `code` so you can compare across loans, underwriters, tenants,
  and time) with borrower-readable and internal versions of the text.
- **Merge fields that resolve against live loan data** — the exact thing Encompass can't do:
  `"Provide 2 months' statements for {{asset.institution}} account ending {{asset.last4}}."`
  Re-render on data change.
- **Program/product-scoped sets**: a DSCR condition set, a foreign-national set, an entity set, a
  cash-out set — attached to programs so they're auto-applied.
- **Rule-triggered conditions**: `IF entity_type != null THEN add ENT-OA, ENT-COGS, ENT-EIN`;
  `IF flood_zone IN (A,V) THEN add INS-FLOOD`; `IF lease_in_place THEN add PROP-LEASE ELSE add PROP-1007`.
- **Expiry-aware conditions**: credit report, appraisal, insurance binder, entity good-standing, bank
  statements — each carries a validity window and **re-opens automatically** when it lapses.
- Versioning + effective dating on the library, so a loan records the template version it used.

**Auto-clearing**

Three tiers, in increasing risk:
1. **Deterministic** — a required doc of the right type is present and its extracted fields satisfy an
   explicit predicate (e.g. HOI binder: `coverage >= loan_amount AND effective_date <= closing_date AND
   mortgagee_clause == our_clause`). Clears with full audit.
2. **Assisted** — AI extracts and proposes clearance with a confidence score; underwriter approves in one
   click from a queue. Everything above a configurable threshold gets pre-approved.
3. **Vendor-verified** — condition cleared by an integration result (VOE/VOA report, title commitment
   received, MI cert issued, tax cert). These should never require a human.

Every auto-clear must be **reversible, attributed to the rule/model version, and reported on** —
`auto_cleared_pct` by category is a headline operational KPI.

**Document-to-condition matching**

- Classify on upload (doc type, borrower, property, period covered), then match against
  `expected_doc_types` + entity/period.
- **Split multi-doc PDFs** — borrowers upload one 60-page scan; it must burst into typed documents and
  attach page ranges to the right conditions.
- **Show the borrower/broker the match** and let them correct it; a wrong auto-match is worse than none.
- **Dedupe**: if three conditions want the same paystub, ask once and satisfy all three.

**Borrower- and broker-facing views**

- **Same conditions, different projection.** One record, `visible_to_borrower` / `visible_to_broker` flags,
  and borrower-readable text. Never a second system to sync.
- Borrower view: a plain-language "What we still need from you" list, grouped, with upload per item,
  a clear submitted/under-review/accepted/needs-attention state, and **rejection reasons in plain English**.
- Broker view: TPO Connect's proven pattern — pipeline → file → conditions → drag-and-drop per condition →
  "ready for review" — plus condition-level messaging so the thread lives on the condition, not in email.
- **Never surface internal conditions or internal notes** to external parties; enforce at the query layer.

**SLA tracking**

- Per-condition clocks split by whose court the ball is in.
- Per-file rollups: open conditions by prior-to bucket; oldest open condition; % blocking.
- Underwriter review SLA (e.g. resubmitted conditions reviewed within 4 business hours) with a queue
  ordered by time-in-queue, not by loan number.
- **Escalation**: breach → notify → reassign → manager dashboard.
- Business-hours-aware clocks with per-tenant calendars and holidays.

**Reporting that closes the loop**

Conditions per loan, by category, source, program, underwriter, broker, and LO; trend over time; top 20
condition codes by volume; % auto-cleared; average resubmissions per condition. As the industry itself puts
it, *"condition data becomes a roadmap for operational improvement"* — and the fact that lenders **"do not
always know why"** they have too many conditions is the analytics gap we should close natively.



---

## 5. Pricing & Lock Desk

This is the largest single build in the LOS after the loan file itself, and the one where a bad data model
is unrecoverable. Design it as an **immutable, event-sourced ledger**, not as mutable fields on the loan.

### 5.1 The PPE market (2026)

The market has consolidated to roughly four serious engines plus vertical specialists:

| Engine | Position | Notes |
|---|---|---|
| **Optimal Blue** (+ LoanSifter for brokers) | Enterprise standard | "near-perfect pricing precision across thousands of products and **150+ investors**" (marketing site; the comparison press says 120+). BESTX™ best-execution, secondary automation (hedging, trading, lock desk), deepest capital-markets features. Weaknesses: premium non-public pricing, dated UI, oversized for small shops. |
| **Polly** | AI-first challenger | Cloud-native, patent-pending competitive execution. **Lock desk workflows are the headline: "locks, extensions, re-locks, re-prices, price exceptions, float downs, and more."** Now embedded in Dark Matter's Empower LOS and integrated with LendingPad. A broker reports "automation workflows saved us 15 hours a week on pricing updates." |
| **Lender Price** | API-first mid-market | 100% API-centric, "AILA" AI assistant, clean UI, ICE + Byte LOS integrations. Smaller investor network, limited secondary functionality. |
| **ICE PPE** (formerly **EPPS** — Encompass Product and Pricing Service) | Native to Encompass | ICE re-invested and rebranded EPPS → ICE PPE in 2024 with an advisory group. API groups: **User Management, Rates (programs + eligible rates), Guidelines (program specs), Lookups**. |
| **MeridianLink PPE** | Native to MeridianLink LOS | Real-time pricing, single vendor; only viable if you're on their LOS; early-stage as of 2026. |
| **LoanPASS** | Non-agency specialist | No-code rules; conventional + non-QM + **DSCR/BPL** + HELOC + reverse + construction from one platform; lender owns margins, LLPAs, LLRAs, conditions, exceptions. |

**Pricing model for PPEs:** typically **$15–$50 per lock all-in**, as a per-lock/per-close transaction fee
plus a monthly platform base fee and add-ons, with volume discounts. Enterprise Optimal Blue pricing is
negotiated and non-public.

Sources: [Optimal Blue PPE](https://www2.optimalblue.com/product-and-pricing-for-mortgage-lenders) ·
[Optimal Blue API](https://www2.optimalblue.com/api) ·
[Optimal Blue: automated best-efforts locking with investors](https://www2.optimalblue.com/optimal-blue-fully-automates-best-efforts-locking-directly-with-investors) ·
[Polly PPE](https://polly.io/product-and-pricing-engine/) ·
[Polly product-change function for the lock desk](https://polly.io/media/polly-introduces-new-product-change-function-to-further/) ·
[Dark Matter × Polly in Empower](https://www.send2press.com/wire/dark-matter-technologies-integrates-pollys-advanced-ppe-engine-into-its-empower-los-platform/) ·
[HousingWire: Polly AI in pricing](https://www.housingwire.com/articles/polly-announces-ai-integration-into-its-pricing-engine/) ·
[ICE PPE](https://mortgagetech.ice.com/products/ice-product-and-pricing-engine) ·
[ICE PPE / EPPS v2 API reference](https://developer.icemortgagetechnology.com/developer-connect/reference/epps-v2) ·
[LeadPops PPE comparison 2026](https://leadpops.com/blog/mortgage-pricing-engines-compared) ·
[BankingBridge top 5 PPEs 2026](https://www.bankingbridge.com/post/the-top-5-pricing-engines-for-2026) ·
[LoanPASS](https://loanpass.io/)

**Two notable 2026 moves:**
- Optimal Blue **fully automated best-efforts locking directly with investors via API** — the lock desk no
  longer logs into investor portals and re-keys. ([HousingWire](https://www.housingwire.com/articles/optimal-blue-ppe-mortgage-lenders-technology-eliminate-all-manual-steps/), [MortgageOrb](https://mortgageorb.com/optimal-blue-adds-new-feature-to-ppe-that-automates-best-efforts-locks))
- Optimal Blue's **Rules Optimizer** lets a *single* pricing rule (e.g. a FICO condition or state-level
  adjustment) apply across many investor relationships and products — i.e. rules are becoming a first-class,
  reusable object rather than per-investor copy-paste. ([Optimal Blue](https://www2.optimalblue.com/optimal-blue-amplifies-pricing-accuracy-and-originator-efficiency-through-no-cost-general-availability-of-two-ppe-product-enhancements))

### 5.2 How pricing is actually computed

**The price stack (all in points/percent of loan amount, on a base of 100.000):**

```
  Investor base price for (product, note rate, lock period)     e.g.  101.250
+ Loan-level price adjustments (LLPAs / LLRAs)                        (1.375)   FICO/LTV/occupancy/units/purpose/cashout/property type/DSCR tier/prepay/state
+ Program / product adjustments                                        0.250    IO, ARM margin, prepay penalty term, escrow waiver
+ Investor SRP or servicing value                                      0.500    servicing-released premium / retained servicing value
+ Lock-period adjustment (extended lock cost)                         (0.375)   30/45/60/75/90 day
─────────────────────────────────────────────────────────────────────────────
= Investor net price                                                 100.250
- Lender margin (branch/channel/product/LO-level)                     (2.000)
+/- Price concessions / exceptions (approved, with reason)            (0.125)
+/- Broker compensation (wholesale: lender-paid or borrower-paid)     (2.250)
─────────────────────────────────────────────────────────────────────────────
= Borrower price (points to/from borrower)                            95.875 → 4.125 points
```

**LLPAs.** Fannie Mae's model is the reference implementation: adjustments *"based on certain loan-level
credit risk characteristics, such as credit score, loan purpose, occupancy, number of units, and product
type,"* calculated on the acquisition-date principal balance and **cumulative**.
([Fannie Mae LLPA Matrix](https://singlefamily.fanniemae.com/media/7336/display),
[Fannie Mae LLPA framework](https://capitalmarkets.fanniemae.com/mortgage-backed-securities/fannie-mae-announces-new-loan-level-price-adjustment-framework))

**For DSCR/investor lending the adjustment grid is different and larger.** Typical axes: FICO × LTV,
**DSCR band** (<1.00 / 1.00–1.10 / 1.10–1.25 / ≥1.25), loan amount tier, property type (SFR / 2-4 / condo /
condotel / rural), units, **short-term rental**, first-time investor, **prepayment penalty structure**
(5/4/3/2/1, 3-yr, 5-yr, none — often the single largest adjustment), interest-only, cash-out vs. purchase,
foreign national, entity vs. individual, state, borrower experience tier, and **portfolio/cross-collateral**.
Our adjustment engine must handle **N-dimensional grids and continuous-function adjustments**, not just 2-D
FICO/LTV matrices.

**Rate sheets.** Modelled as a versioned, timestamped artifact per investor: effective datetime, an optional
intraday reprice sequence, per-product rate/price ladders per lock period, plus adjustment tables. Every
price we ever quote must be reproducible from `(rate_sheet_version_id, ruleset_version_id, inputs)`.

### 5.3 Lock desk workflow

**Lock lifecycle states**

```
Not Locked → Lock Requested → (Rejected | Locked)
Locked → { Extended | Re-locked | Repriced | Product Changed | Floated Down | Cancelled | Expired }
Locked → Confirmed to Investor → Delivered → Purchased
```

**Core workflows the desk must support** (Polly's list is the industry checklist:
*"locks, extensions, re-locks, re-prices, price exceptions, float downs"*):

- **Initial lock request** — LO or broker requests from a priced scenario; desk approves/rejects; the
  approved scenario's price is snapshotted.
- **Extension** — N days at a per-day cost (commonly ~0.5–1.5 bps/day, tiered), with **configurable
  extension policies**: max cumulative days, max number of extensions, allowed reasons, and **auto-acceptance
  rules**. Optimal Blue explicitly uses *"toggles in the lock extension policy creation workflow"* with
  *"customization of lock extension reasons"* and *"automations for auto-acceptance."*
  ([Optimal Blue lock extension request walkthrough](https://www.iorad.com/player/1744407/Optimal-Blue--Lock-Extension-Request),
  [Carrington lock extension automation](https://www.carringtoncorrespondent.com/2019/11/06/announcement-19-0084-lock-extension-automation/))
- **Re-lock after expiry** — this is where **worst-case pricing** applies: *"the new pricing is based on the
  worse case between the original lock date and the current market"* (a "worse-of" policy). Model it as a
  computed comparison, stored with both candidate prices and the chosen one.
  ([Financial Samurai](https://www.financialsamurai.com/relock-at-market-rate-and-rate-lock-extension-explained/),
  [719 Lending](https://www.719lending.com/mortgage-rate-locks-explained/))
- **Reprice / product change** — loan attributes changed (LTV, FICO, occupancy, amount, product). Re-run
  pricing at the **original lock date's rate sheet** with the *new* adjustments; the delta is the reprice.
  Polly shipped a dedicated "Product Change function to streamline the lock desk" precisely because this is
  the most error-prone desk task.
- **Float-down** — a one-time election, usually with an eligibility window, a minimum improvement threshold
  (e.g. rate must have improved ≥0.25%), a fee, and a cap on how much of the improvement passes through.
  ([CFI: float down](https://corporatefinanceinstitute.com/resources/commercial-lending/mortgage-rate-lock-float-down/),
  [FCM extended lock + float-down agreement](https://kc.fcmpartners.com/documents/extended-lock-policy-and-agreement.pdf/))
- **Price exception / concession** — an approved off-policy price with reason code, requester, approver,
  amount, and P&L attribution. Must be reportable by LO/branch/reason.
- **Cancel / withdraw**, with pair-off consequences if mandatory.
- **Best-efforts vs. mandatory execution** (see below), plus **best-execution** comparison across investors.

**Best efforts vs. mandatory**

- **Best efforts**: a lock commitment where the seller agrees to make its best effort to deliver a specific
  loan to a specific investor but does not guarantee delivery. The investor provides a **penalty-free option
  not to deliver** (a free put) and prices the expected fallout in. No pair-off fee.
- **Mandatory**: the seller is obligated to deliver; commitments are typically taken after the loan funds;
  **failure to deliver triggers a pair-off fee**, computed from the undelivered amount and market movement.
- **Spread**: historically a **10–50 bp pickup** for mandatory, ~25 bp on average — which is why hedged
  lenders take pipeline risk with TBA hedges instead of locking best-efforts.
  ([Optimal Blue: best-efforts to mandatory spread](https://www2.optimalblue.com/blog/best-efforts-to-mandatory-spread-determining-the-risk-and-reward-of-pipeline-hedging),
  [MCT: intro to mandatory delivery](https://mct-trading.com/blog/introduction-to-mandatory-loan-sale-delivery/),
  [MBA/MCT: Mortgage Pipeline Hedging 101](https://www.mba.org/docs/default-source/membership/white-paper/mct-whitepaper---mortgage-pipeline-hedging-101.pdf?sfvrsn=d1778b40_1),
  [Fannie Mae execution options](https://selling-guide.fanniemae.com/sel/c1-1-01/execution-options))

For a DSCR/non-QM shop the analogue is **whole-loan trade / forward flow commitment** with a
take-out investor, plus AAA/loan-sale settlement dates and pair-off/kick-out terms. The lock record must be
able to point at a **commitment** object.

### 5.4 TRID timing implications of locking

The rules that make the lock record a compliance artifact, not just a pricing one:

- **Locking after the initial LE was issued unlocked is a changed circumstance.** *"When a rate gets locked
  after application, the lender must issue a revised Loan Estimate reflecting the rate locked and its
  expiration, along with any fee, or fee increase, which is directly related to the rate lock."*
- **A revised LE is due within three business days** after the date the rate is subsequently locked.
- Generally, a revised LE must be delivered **within 3 business days of receiving information sufficient to
  establish a changed circumstance**.
- **A revised LE cannot be issued on or after the date the CD is provided**, and the revised LE must be
  **received by the borrower no later than 4 business days prior to consummation.**
- Rate lock agreements are the standard evidence to *"validate when the change took place and why a fee was
  increased."*
  ([Wolters Kluwer: revised LE triggering events](https://www.wolterskluwer.com/en/expert-insights/a-refresher-on-triggering-events-impacting-the-revised-loan-estimate),
  [LoanLogics: allowable changed circumstances](https://www.loanlogics.com/allowable-changes-circumstances-trid-need-know/),
  [Compliance Cohort: TRID 2.0 rate locks and revised disclosures](https://www.compliancecohort.com/blog/trid-20-rate-locks-and-revised-disclosures),
  [CFPB TRID FAQs](https://www.consumerfinance.gov/compliance/compliance-resources/mortgage-resources/tila-respa-integrated-disclosures/tila-respa-integrated-disclosure-faqs/))

**Design consequence:** every lock event must **emit a disclosure-obligation event** with a computed due
date, and the system must block/flag if the obligation isn't satisfied. The lock desk and the disclosure desk
are the same state machine.

> Business-purpose DSCR loans to entities are generally **exempt from TRID/TILA/RESPA** as commercial-purpose
> credit. But (a) many shops also originate consumer-purpose non-QM, (b) an investor loan taken in a personal
> name for a property the borrower may occupy is a live risk, and (c) the *business-purpose determination
> itself* must be documented and auditable per loan. Model TRID applicability as a **per-loan determined flag
> with evidence**, never as a per-tenant setting.

### 5.5 Data model — Pricing Scenario record

A **pricing scenario** is an immutable snapshot of one quote. Never mutate; always create a new version.

```
pricing_scenario
  id                        uuid            PK
  tenant_id                 uuid
  loan_id                   uuid?           -- null for anonymous/quick quotes
  parent_scenario_id        uuid?           -- "duplicate and tweak" lineage
  scenario_name             string?         -- "5/6 ARM 60-day, 3yr prepay"
  scenario_type             enum            -- QuickQuote | Registered | LockRequest | RepriceQuote | Comparison
  status                    enum            -- Draft | Quoted | Selected | Superseded | Expired | Locked
  created_by                uuid
  created_channel           enum            -- Retail | TPO | Correspondent | API | Borrower-facing
  created_at                timestamptz
  expires_at                timestamptz     -- quotes go stale; enforce it

  -- ===== INPUTS (everything that affects price; hash these) =====
  inputs_hash               string          -- sha256 of the canonical input doc; enables cache + audit
  as_of                     timestamptz     -- the pricing timestamp used
  rate_sheet_set_id         uuid            -- which sheets were in force
  ruleset_version_id        uuid            -- which margin/adjustment ruleset
  guideline_version_id      uuid            -- which eligibility guidelines

  inputs                    jsonb {
      -- transaction
      loan_purpose, occupancy, doc_type, channel, lien_position,
      loan_amount, purchase_price, as_is_value, after_repair_value,
      ltv, cltv, hcltv, subordinate_financing_amount,
      cash_out_amount, seasoning_months,
      -- property
      property_type, units, state, county, zip, is_rural, is_condotel,
      is_non_warrantable_condo, is_leasehold, in_flood_zone,
      -- borrower
      borrower_type (Individual|Entity), entity_type, entity_state,
      representative_fico, guarantor_ficos[], citizenship (USC|PR|FN|ITIN),
      first_time_investor, experience_tier, properties_owned,
      mortgage_lates_12mo, bk_fc_ss_seasoning_months, self_employed,
      -- DSCR / cash flow
      gross_monthly_rent, market_rent_1007, lease_in_place, is_str,
      taxes_monthly, insurance_monthly, flood_ins_monthly, hoa_monthly,
      vacancy_factor, dscr, dscr_basis (PITIA|ITIA_IO),
      -- product shape
      product_family, amortization_type, term_months, io_period_months,
      arm_index, arm_margin, arm_caps, balloon_months,
      prepay_structure, prepay_term_months, escrow_waiver,
      -- reserves / assets
      reserves_months, liquid_assets,
      -- execution
      lock_period_days, delivery_type (BestEfforts|Mandatory|Portfolio),
      comp_plan (LenderPaid|BorrowerPaid), comp_bps, comp_flat,
      target_price | target_rate | target_points   -- solve-for mode
  }

  -- ===== OUTPUTS =====
  eligible_products         jsonb[]         -- see product_quote below
  ineligible_products       jsonb[]         -- product_id + failed_rules[] + human message  ("WHY NOT?")
  selected_quote_id         uuid?
  warnings                  jsonb[]         -- soft fails, missing-data assumptions
  engine                    string          -- internal | optimal_blue | polly | loanpass | lender_price | ice_ppe
  engine_request_id         string?         -- vendor correlation id
  engine_raw_request        jsonb           -- store verbatim
  engine_raw_response       jsonb           -- store verbatim; non-negotiable for disputes
  latency_ms                int
```

```
product_quote                                -- one row per (product × rate) returned
  id                        uuid
  scenario_id               uuid
  investor_id               uuid
  investor_product_code     string
  product_name              string
  rate_sheet_id             uuid
  rate_sheet_effective_at   timestamptz
  reprice_sequence          int             -- 1 = morning sheet, 2 = first reprice, ...
  lock_period_days          int

  note_rate                 decimal(7,5)
  base_price                decimal(9,5)    -- 100.000 basis
  adjustments               jsonb[] [ { code, description, category, value, source,
                                        applies_to (Price|Rate|Margin|Fee),
                                        rule_id, rule_version, matched_on {…} } ]
  adjustment_total          decimal(9,5)
  srp                       decimal(9,5)
  investor_net_price        decimal(9,5)
  margin                    decimal(9,5)
  margin_rule_id            uuid
  concession                decimal(9,5)
  broker_comp               decimal(9,5)
  final_price               decimal(9,5)
  points_pct                decimal(9,5)    -- (100 - final_price)
  points_dollars            decimal(14,2)
  discount_or_rebate        enum
  qualifying_payment        decimal(14,2)   -- PITIA used for DSCR
  computed_dscr             decimal(6,3)
  apr                       decimal(7,5)
  monthly_pi                decimal(14,2)
  is_selected               bool
  eligibility_result        enum            -- Eligible | EligibleWithExceptions | Ineligible
  exceptions_required       jsonb[]
  conditions_generated      string[]        -- condition template codes this product implies
```

**Non-negotiable properties of this model**

1. **Immutable + hash-addressed.** `inputs_hash` + `rate_sheet_set_id` + `ruleset_version_id` reproduces the
   quote exactly, years later. This is what wins a repurchase dispute or a fair-lending exam.
2. **Adjustment-level attribution.** Every basis point traces to a rule id and the values it matched on.
   "Why is my price 96?" must be answerable in one screen. No PPE does this well today.
3. **Ineligible products are stored, with reasons.** The "why doesn't this loan fit?" answer is the single
   most valuable output for non-QM/DSCR, and it's where LOs waste the most time.
4. **Vendor raw request/response retained verbatim**, even when we compute internally.
5. **Solve-for modes**: given a target rate → what price; given a target price/par → what rate; given a
   target DSCR/payment → what loan amount. LOs think in all three directions.

### 5.6 Data model — Lock record

```
rate_lock
  id                        uuid            PK
  tenant_id                 uuid
  loan_id                   uuid            FK
  lock_number               string          -- human-facing, tenant-sequenced
  scenario_id               uuid            -- the pricing_scenario that was locked
  product_quote_id          uuid            -- the exact quote row locked

  -- status
  status                    enum            -- Requested | Approved | Rejected | Active | Expired
                                            -- | Cancelled | Withdrawn | ConfirmedToInvestor
                                            -- | Delivered | Purchased | PairedOff
  status_reason             string?

  -- who / when
  requested_by              uuid
  requested_at              timestamptz
  requested_channel         enum            -- LO | Broker | LockDesk | API | Auto
  decided_by                uuid?           -- lock desk approver
  decided_at                timestamptz?
  lock_date                 date            -- the effective lock date (the priced date)
  lock_datetime             timestamptz     -- exact, for reprice/rate-sheet attribution
  lock_period_days          int             -- ORIGINAL period
  expiration_date           date            -- CURRENT expiration (derived from events)
  original_expiration_date  date
  expiration_time           time            -- desk cutoff, with tz
  business_days_only        bool

  -- execution
  delivery_type             enum            -- BestEfforts | Mandatory | Portfolio | ForwardFlow
  investor_id               uuid
  investor_lock_id          string?         -- the investor's confirmation number
  commitment_id             uuid?           -- mandatory/forward-flow commitment
  servicing                 enum            -- Released | Retained | Co-issue
  hedge_instrument_id       uuid?           -- TBA coupon/settlement if hedged
  is_hedged                 bool

  -- economics (snapshotted at lock, then re-snapshotted on each change event)
  note_rate                 decimal(7,5)
  base_price                decimal(9,5)
  adjustment_total          decimal(9,5)
  adjustments_snapshot      jsonb[]         -- full itemization, frozen
  srp                       decimal(9,5)
  investor_net_price        decimal(9,5)
  margin                    decimal(9,5)
  concession                decimal(9,5)
  broker_comp_type          enum            -- LenderPaid | BorrowerPaid
  broker_comp_bps           decimal(7,4)
  broker_comp_amount        decimal(14,2)
  final_price               decimal(9,5)
  points_dollars            decimal(14,2)
  lock_fee                  decimal(14,2)   -- if a lock fee is collected
  expected_revenue          decimal(14,2)   -- for pipeline P&L
  qualifying_dscr           decimal(6,3)

  -- loan attributes AS LOCKED (for reprice detection)
  locked_attributes         jsonb           -- loan_amount, ltv, fico, occupancy, property_type,
                                            -- doc_type, prepay, io, term, units, state, dscr, …
  attribute_drift           jsonb           -- computed: current loan vs locked_attributes
  reprice_required          bool            -- derived from drift vs. tolerance policy

  -- extension / relock accounting
  extension_count           int
  extension_days_total      int
  extension_cost_total      decimal(9,5)    -- in price
  extension_cost_dollars    decimal(14,2)
  relock_count              int
  worst_case_applied        bool
  worst_case_detail         jsonb           -- { original_price, current_market_price, chosen, as_of }
  float_down_used           bool
  float_down_detail         jsonb

  -- policy
  policy_id                 uuid            -- which lock policy governed this
  max_extension_days        int
  max_extensions            int
  auto_extension_eligible   bool

  -- compliance linkage
  triggers_revised_le       bool
  revised_le_due_at         timestamptz     -- lock event + 3 business days
  revised_le_sent_at        timestamptz?
  disclosure_package_id     uuid?
  lock_agreement_doc_id     uuid?
  esign_envelope_id         uuid?

  created_at / updated_at
```

```
rate_lock_event                              -- APPEND ONLY. The lock record above is a projection of these.
  id                        uuid
  lock_id                   uuid
  sequence                  int
  event_type                enum            -- Requested | Approved | Rejected | Confirmed | Extended
                                            -- | Relocked | Repriced | ProductChanged | FloatedDown
                                            -- | ConcessionApplied | Cancelled | Expired | Reinstated
                                            -- | InvestorConfirmed | Delivered | Purchased | PairedOff
  actor_id                  uuid
  actor_role                enum
  actor_channel             enum
  reason_code               string          -- tenant-configurable, reportable (e.g. EXT-APPRAISAL-DELAY)
  reason_text               string
  effective_at              timestamptz
  days_delta                int?            -- extension days
  price_delta               decimal(9,5)?   -- cost/benefit of this event
  dollar_delta              decimal(14,2)?
  paid_by                   enum?           -- Borrower | Lender | Broker | Branch  (concession attribution)
  before_snapshot           jsonb           -- full economics before
  after_snapshot            jsonb           -- full economics after
  scenario_id               uuid?           -- repricing scenario used
  approval_id               uuid?           -- if it required approval
  system_generated          bool
  occurred_at               timestamptz
```

```
lock_policy                                  -- everything-as-settings; per tenant, per channel, per product
  id, tenant_id, name, scope (channel/product/branch/investor)
  lock_desk_hours           jsonb            -- open/close per weekday + timezone + holiday calendar
  allow_lock_before         enum             -- Application | Submission | Approval | CTC
  min_lock_days / max_lock_days / allowed_lock_periods int[]
  auto_approve_rules        jsonb            -- when the desk isn't needed at all
  extension_tiers           jsonb[]          -- [{days:7, price_cost:0.125}, {days:15, price_cost:0.250}, …]
  max_extension_days, max_extensions
  extension_reasons         string[]         -- configurable, reportable, auto-accept flags per reason
  relock_policy             enum             -- WorstCase | CurrentMarket | OriginalRate
  relock_cooling_off_days   int              -- days after expiry before a relock is allowed
  worst_case_lookback       enum             -- OriginalLockDate | ExpirationDate
  float_down_enabled        bool
  float_down_min_improvement decimal
  float_down_window         jsonb            -- earliest/latest relative to lock and closing
  float_down_fee            decimal
  float_down_passthrough_pct decimal
  reprice_tolerance         jsonb            -- how much attribute drift is free before repricing
  concession_approval_matrix jsonb           -- bps thresholds → required approver role
  expiration_grace_hours    int
  auto_expire               bool
  cutoff_for_same_day_lock  time
```

Supporting objects: `rate_sheet` (investor, effective_at, reprice_seq, raw file, parsed ladders),
`adjustment_rule` (versioned, effective-dated, N-dimensional predicate → value), `margin_rule`,
`investor`, `investor_product`, `commitment` (mandatory/forward-flow with amount, settlement date,
pair-off terms), `hedge_position`, and `lock_extension_request` / `concession_request` as approval workflows.

### 5.7 Derived lock-desk views we should ship

- **Lock desk queue** — pending requests, extensions, concessions, with SLA clocks and one-click approve.
- **Expiration board** — locks by days-to-expiry, with the loan's current stage and open blocking conditions,
  so the desk can see "expiring in 5 days and still has 6 PTD conditions."
- **Pipeline position** — locked volume by product/coupon/investor/settlement month, weighted by pull-through,
  for hedging.
- **Reprice risk** — locks where `attribute_drift` exceeds tolerance and no reprice has been done.
- **Concession & extension P&L** — cost in dollars by LO, branch, reason code, and month. This report alone
  pays for the build.
- **Best-execution comparison** — for each locked loan, the alternative investors' prices at lock time,
  retained.



<!-- SECTION 6 -->

<!-- SECTION 7 -->
