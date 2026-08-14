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



<!-- SECTION 2 -->

<!-- SECTION 3 -->

<!-- SECTION 4 -->

<!-- SECTION 5 -->

<!-- SECTION 6 -->

<!-- SECTION 7 -->
