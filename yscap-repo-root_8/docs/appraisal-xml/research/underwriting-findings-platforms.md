# Automated Underwriting Findings & Conditions Platforms — Design Research

**Purpose.** Study how the industry's automated **underwriting-findings** engines (DU, LPA, CU)
and **conditions / exception-management** platforms (Encompass, LoanLogics, Indecomm, ACES,
SitusAMC, Ncontracts, Maxwell, Roostify) surface findings, let underwriters resolve them, and gate
**clear-to-close (CTC)** — so our **PILOT findings + conditions engine** is best-in-class.

**How to read this against our system.** Our engine is already specified in
`../underwriting-findings-rules.md` (findings **F1–F23**, three-tier severity **fatal / warning /
info**, the **repricing chain**, the blocking condition **`appraisal_review_cleared`**, and the
**findings badge**) and `../../condition-center.md` (admin-authored **Condition Studio**, the
rule engine, condition types, `prior_to_approval → post_closing` categories, roles/capabilities). This
doc maps each industry pattern to those pieces and ends with a **prioritized "features to adopt"** list
split **feasible-now vs later**.

**Compiled:** 2026-07-19. Author context: research pass for the appraisal-XML PILOT findings work.
Note on sourcing: the GSE authoritative pages (`selling-guide.fanniemae.com`,
`sf.freddiemac.com`, `singlefamily.fanniemae.com`) block automated fetch, so the platform notes below
are drawn from GSE search summaries plus vendor/industry pages; every claim carries its URL.

---

## Part A — Platform notes (cited)

### A1. Fannie Mae **Desktop Underwriter (DU)** — the Underwriting Findings report

DU returns a recommendation (**Approve/Eligible**, **Approve/Ineligible**, **Refer with Caution**,
**Out of Scope/Error**) plus a structured **Findings report divided into sections, each section
carrying a different *type* of message**:

- **Summary / recommendation** — the headline call and the eligibility component.
- **Risk / Eligibility** — delivery restrictions that impact eligibility are surfaced **near the top
  for visibility**; some restrictions don't affect the DU decision but must still be complied with to
  deliver. (Design lesson: *the blocking stuff floats to the top.*)
- **Verification Messages / Approval Conditions** — the actionable list. The lender must **confirm
  every DU Verification Message/Approval Condition was satisfactorily resolved and adequately
  supported by appropriate documentation**. These are effectively DU's auto-generated conditions.
- **Observation / Findings messages** — context and required steps to complete processing.
- **Potential Red Flag messages** — inconsistency detectors that **do not change the
  recommendation**; they exist purely to help the lender catch data mismatches (this is exactly our
  *info/verify* tier — surfaced, not blocking).
- Messages are **recommendation-aware**: some appear only on *Approve*, others only on *Refer with
  Caution*.

Design takeaways: (1) **section = message-type**, so a reader instantly knows "must-do" vs "FYI";
(2) blocking/eligibility items are hoisted to the top; (3) each verification message states *what
document satisfies it*; (4) red-flag/inconsistency messages are non-blocking but always shown.

Sources: [DU Underwriting Findings Report — Selling Guide B3-2-11](https://selling-guide.fanniemae.com/sel/b3-2-11/du-underwriting-findings-report),
[General Information on DU B3-2-01](https://selling-guide.fanniemae.com/sel/b3-2-01/general-information-du),
[DU General FAQ](https://singlefamily.fanniemae.com/learning-center/originating-and-underwriting/desktop-underwriter-learning-center/desktop-underwriter-general-frequently-asked-questions),
[Homebuyer.com DU Findings explainer](https://homebuyer.com/guidelines/fannie-mae/du-underwriting-findings-report-b3-2-11),
[Premier Mortgage — what DU findings mean](https://www.premiermtg.com/ft-lauderdale-desktop-underwriting-du-findings-what-they-mean-for-your-conventional-approval/).

### A2. Freddie Mac **Loan Product Advisor (LPA)** — the Feedback Certificate (redesigned)

Two risk classes only: **Accept** (meets automated risk standards, eligible for purchase *provided
the lender verifies all submitted data*) or **Caution** (does not meet automated thresholds — **not a
denial**; lender may manually underwrite or adjust terms and resubmit). The **redesigned Feedback
Certificate** is the strongest UX reference here:

- **Messages are split into "Actionable" vs "Informational"** so users focus on what they must do.
- **Important messages float to the top**, immediately under **Purchase Restriction Messages**.
- A dedicated **Caution Messages** section explains *why* the loan is Caution (the "reason codes").
- **Opportunity Messages** — a positive-signal lane (e.g. rent-payment history or positive cash flow
  that could help the borrower; "LPA Choice" messages that show *how to get to Accept*). This is a
  **"what would fix this" lane**, not just a problem list.
- Freddie is **retiring 1,100+ redundant messages** — deliberate message-catalog hygiene; fewer,
  clearer findings beat many noisy ones.

Design takeaways: **Actionable / Informational / Opportunity** is a cleaner public taxonomy than raw
severity; the *Opportunity* lane (what-if-you-fixed-this → better outcome) is a differentiator we can
mirror. Message hygiene (retire redundant findings) matters as much as adding them.

Sources: [LPA Feedback Redesign — Drive Efficiency and Uncover Opportunity](https://sf.freddiemac.com/articles/news/lpa-feedback-redesign-drive-efficiency-and-uncover-opportunity),
[LPA Feedback Message / Risk Assessment updates (PDF)](https://sf.freddiemac.com/docs/pdf/lpa-feedback-messages-risk-assessment-technology-updates.pdf),
[LegalClarity — LPA overview](https://legalclarity.org/freddie-mac-lpa-automated-underwriting-system-overview/).

### A3. Fannie Mae **Collateral Underwriter (CU)** — appraisal risk score + flags

CU scores each appraisal **1.0 (lowest risk) → 5.0 (highest)**; **999** when it cannot generate a
result (e.g. can't geocode). The composite score decomposes into **risk flags**: **Overvaluation,
Undervaluation, Property Eligibility & Policy Compliance, and Appraisal Quality**, plus **detailed
messages** pointing at the specific aspects of the appraisal a human should review. Crucially: **a
high score is not a fail** — lenders must perform additional due diligence and *check whether the
report already addresses the flagged issue* before requesting a correction. Results are real-time via
UCDP.

Design takeaways: a **single 1–5 collateral-risk score + decomposed flags + drill-down messages** is
exactly the scorecard shape we want for the appraisal file; and the discipline "**a high score is a
review trigger, not an auto-decline**" is already our confidence philosophy (F18, F21). Our engine
already cites CU thresholds (≥2.5 warn / ≥4.0 fatal).

Sources: [Collateral Underwriter — Fannie Mae](https://singlefamily.fanniemae.com/applications-technology/collateral-underwriter),
[CU Risk Score and Risk Flags Overview (job aid)](https://singlefamily.fanniemae.com/job-aid/collateral-underwriter/topic/risk_flags_overview.htm),
[JVM — What is a CU Score](https://www.jvmlending.com/blog/what-is-a-cu-score-on-an-appraisal/),
[McKissock — CU FAQs](https://www.mckissock.com/blog/appraisal/fannie-maes-collateral-underwriter-program/).

### A4. Fannie Mae **Loan Defect Taxonomy** — the severity model everyone borrows

Fannie's QC framework uses **two authoritative severity levels: *significant/critical defect*** (a
manufacturing error that **makes the loan ineligible for sale and requires remediation**) and
**non-critical**; lenders may sub-tier the non-critical band (minor/moderate) however they like — the
taxonomy only demands the black-and-white "does this make the loan ineligible?" answer. Defects are
organized into **categories** (Assets, Borrower/Mortgage Eligibility, Credit, Liabilities,
Income/Employment, Insurance, **Appraisals**, …) explicitly to enable **root-cause analysis**. FHA's
taxonomy instead uses **four tiers** (Tier 1–4).

Design takeaways: our **fatal / warning / info** maps cleanly — *fatal* = "ineligible until resolved"
(their significant/critical), *warning/info* = their non-critical band. Adding a **defect *category*
dimension** (Collateral/Value, Identity, Eligibility/Dates, Income/DSCR) alongside severity gives us
the same root-cause slicing for dashboards.

Sources: [Fannie Mae Loan Defect Taxonomies](https://singlefamily.fanniemae.com/loan-defect-taxonomies),
[DocMagic — Fannie defect categories list](https://www.docmagic.com/compliance/regulatory-announcements/fm-defect-list),
[MortgageOrb — FHA 4-tier taxonomy](https://mortgageorb.com/phil-mccall-fhas-new-loan-defect-taxonomy-could-create-challenges-for-lenders).

### A5. **ACES Quality Management** — QC exception/defect workflow + AI

Founded 1994; core is **ACES Flexible Audit Technology** — customizable audit workflows, **defect/
exception management**, and compliance oversight configurable *without heavy IT*. Recent **ACES
Intelligence** adds: write exceptions and build loan-selection queries in **plain English**;
**Executive Summaries** that auto-generate a narrative of selection method + defect statistics + key
findings; and **Exception Comment Summaries** — a roll-up view of all exceptions in an audit with an
auto-generated summary of the findings noted in comments.

Design takeaways: two ideas travel well to us — **auto-generated plain-language summaries of the open
findings on a file** ("here's the story of this file's issues"), and a **roll-up/aggregation view**
across findings so a reviewer sees themes rather than 20 rows.

Sources: [ACES Quality Management & Control](https://www.acesquality.com/products/aces-quality-management-control),
[ACES Intelligence launch](https://www.send2press.com/wire/aces-quality-management-launches-aces-intelligence-redefining-mortgage-and-financial-services-quality-control-with-ai/),
[ACES 2025 momentum](https://www.acesquality.com/about/news/aces-quality-management-grows-audit-volume-and-market-share-advances-ai-innovation-and-industry-leadership-in-2025).

### A6. **LoanLogics LoanHD** — rules that auto-clear, exceptions that route to humans

LoanHD is rules-based automation across Pre-Close, Post-Close, Pre-Funding, HMDA, TRID. Pattern of
note: the **rules engine auto-clears loans with no errors (often the majority) and routes only
defect-bearing loans to manual exception review** — findings screens **display automated-test results
and separately the tests that require manual intervention**, so reviewers focus on what failed. **IDEA
Data Validation** verifies extracted data against source documents. The **Audit Response Center (ARC)**
lets lenders **address defects/conditions immediately after review** and keeps a **compliance trail
showing how each defect was addressed** so investors/regulators can see the actions taken.

Design takeaways: the **auto-clear-the-clean / escalate-only-the-exceptions** split is our F3-style
"auto-pass, recorded, no task" — we should make that split visible (a "cleared automatically" lane vs
"needs you"). The **ARC's per-defect response + immutable compliance trail** is precisely our
`audit_log` decision trail, and we should give it a **first-class UI** (a response box on each finding).

Sources: [LoanHD Loan Quality Management](https://www.loanlogics.com/products/loan-quality-management-technology/),
[LoanLogics QC software (blog)](https://www.loanlogics.com/blog-mortgage-quality-control-software/),
[LoanLogics Audit Response Center](https://nationalmortgageprofessional.com/news/63779/loanlogics-enhances-loanhd-through-audit-response-center).

### A7. **Indecomm DecisionGenius / AuditGenius** — decisions across four pillars + a pre-organized conditions list

DecisionGenius returns **automated risk-based decisions across the four pillars — credit, assets,
income, collateral** — combining investor guidelines, LOS data/documents, third-party data, and
**lender's own underwriting rules**. Most relevant: it **returns a clear-to-close recommendation with a
pre-organized conditions list back to the LOS**, and **alerts on gaps and discrepancies between data
and documents** (extract → verify → capture discrepancy). **AuditGenius** is the QC/exception sibling.

Design takeaways: **findings should *emit conditions* automatically and hand back a "CTC + organized
conditions list"** — this is exactly our F5→`appraisal_as_is_verify` and F17→1004D-at-completion
auto-condition pattern, and validates auto-conditioning from findings as an industry norm. The
**data-vs-document discrepancy alert** is our source-vs-file diff (see novel ideas).

Sources: [Indecomm DecisionGenius](https://indecomm.com/product/decisiongenius/),
[Indecomm Underwriting solutions](https://indecomm.com/solutions/mortgage-underwriting/),
[DecisionGenius release](https://indecomm.com/indecomm-releases-decisiongenius-an-automated-decision-making-software-for-mortgage-underwriting).

### A8. **DataVerify** — independent verification / fraud risk lane

DataVerify is positioned as a risk-mitigation / data-validation / fraud-detection layer feeding lender
workflows (identity, property, income/employment, fraud red flags). Relevance to us: it models the
**third-party verification lane that produces its own findings** feeding the underwriting decision — a
reminder that a finding's **source/provenance** (which check produced it) is a first-class attribute.

Source: [DataVerify DRIVE](https://drive.dataverify.com/).

### A9. **SitusAMC** — Clarity Portal & ComplianceAnalyzer (five-level RiskIndicator)

**Clarity Portal** posts loan-review results **including exceptions**, and lets stakeholders **respond
to and resolve exceptions directly in the platform** across the review lifecycle. **ComplianceAnalyzer**
shows findings in an **interactive report with a proprietary RiskIndicator dashboard — a high-level
overview of audit results across key risk areas with *five* severity levels** (plus regulatory **cure
analysis**: it tells you *how to cure* a violation). Servicing uses **exception-based processing** —
segment good loans from problem loans so teams focus effort.

Design takeaways: (1) **resolve-in-place** (respond to the exception in the same view that raised it) —
don't make the underwriter leave the finding to act; (2) a **RiskIndicator-style dashboard** across
risk areas is our scorecard; (3) **"cure analysis"** = telling the user the concrete steps to fix, our
"how to clear" guidance made explicit and per-finding.

Sources: [SitusAMC Diligence & QC (Clarity Portal)](https://www.situsamc.com/residential-diligence-QC),
[SitusAMC ComplianceAnalyzer](https://www.situsamc.com/complianceanalyzer),
[SitusAMC ComplianceEase](https://www.situsamc.com/complianceease).

### A10. **Ncontracts** — exception *policy* & trend tracking (governance angle)

Ncontracts frames exceptions as a **governance discipline**: track exception **frequency**, compare
**month-over-month trend lines**, understand **reason codes**, and track **both approvals and denials**
of requested exceptions (fair-lending lens). The lesson for us: **every waiver/exception must carry a
reason code and be *aggregated and trended*, not just logged per file** — a waiver granted repeatedly
for the same reason is a policy signal (and a fair-lending/consistency risk).

Sources: [Ncontracts — exception management for fair lending](https://www.ncontracts.com/nsight-blog/fair-lending-compliance-exception-management),
[Ncontracts mortgage risk management](https://www.ncontracts.com/mortgage-lender-risk-management).

### A11. **Encompass (ICE) Enhanced Conditions** — the reference conditions engine

The most directly comparable conditions engine to ours. Key model:

- Conditions are **eFolder entries tracking status as the loan moves through the pipeline**.
- **Enhanced Condition Settings** define **condition types, statuses, sources, recipients, and
  "Prior To" values** — and, importantly, **which actions can be taken on a given condition template
  based on factors including the user's role** (persona/role-gated actions on conditions).
- **"Prior To" values** encode the gating stage: *prior-to-approval / prior-to-doc(s) / prior-to-
  closing / prior-to-funding* — the same category ladder we call `prior_to_approval → post_closing`.
- Conditions are **cleared** or **waived** (both remove them from the "open" count); the **Pipeline can
  show columns for the count of open external and internal conditions**, which is literally how a file
  reaches **clear-to-close** (open count → 0).
- **Automated (business-rule-driven) conditions** auto-attach conditions from loan data — the
  auto-conditioning pattern — and **condition templates** carry matching criteria (Category, Prior To,
  Source, Recipient).

Design takeaways that validate/extend our design: **role-gated *per-action* controls on conditions**
(who can clear vs waive vs add) — we have capabilities (`sign_off_conditions`, `waive_conditions`,
`manage_conditions`) but Encompass gates them **per condition template**, which we could adopt; the
**internal-vs-external open-condition counts as the CTC signal** (our badge); and **Prior-To as an
explicit gating attribute** (we have `category`; making "which gate does this block" explicit per
condition sharpens it).

Sources: [Encompass Loan Enhanced Conditions API](https://developer.icemortgagetechnology.com/developer-connect/reference/loan-enhanced-conditions),
[Encompass Loan Conditions API](https://developer.icemortgagetechnology.com/developer-connect/reference/loan-conditions),
[Enhanced Conditions tool guide](https://awesometechinc.com/step-by-step-guide-to-the-encompass-enhanced-conditions-tool/),
[Encompass Auto Conditions](https://awesometechinc.com/encompass-auto-conditions/),
[Reducing UW conditions in Encompass — Lender Toolkit](https://lendertoolkit.com/how-lenders-reduce-underwriting-conditions-in-encompass/).

### A12. **Maxwell** and **Roostify** — POS-side condition clearing & dynamic checklists

- **Maxwell**: **dynamic checklist logic by loan type**, built-in **condition tracking**, a strong
  **compliance audit trail**, and a **condition-clearing workflow that auto-marks a condition resolved
  when the correct document is received**; an **automated document-request engine** sends borrowers a
  checklist tailored to loan type (FHA purchase ≠ VA refi). Lenders gather documents ~73% faster.
- **Roostify**: **dynamic task lists tailored to borrower segments**, tiered workflows for different
  teams, embedded calculators/guided applications, and audit trails/compliance monitoring.

Design takeaways: **dynamic, data-driven checklists** (our rule engine already does this) and the
**"received when the right doc lands" auto-advance** — but note our Condition-Center audit deliberately
keeps borrower uploads at **`received`, never auto-`satisfied`** (staff must review). Maxwell's
auto-*resolve* is a speed feature we should **not** fully copy for gating conditions; the middle ground
is *auto-advance to received + flag the underwriter*, which we already do.

Sources: [Maxwell POS](https://himaxwell.com/resources/blog/what-is-mortgage-point-of-sale-pos-software/),
[Maxwell profile](https://www.mortgageadvisortools.com/companies/maxwell/),
[Top mortgage POS systems](https://deantellone.com/top-9-mortgage-pos-systems-for-streamlining-lending/).

### A13. Rules engines & explainability (general)

Modern decision engines **blend rules + scorecards + models and return approve/decline/review with
*reason codes*** that are **explainable and auditable**; rules are transparent if-then policy
("if FICO>680 and DTI<36% → approve") and easy to modify; **Scenario Manager / what-if tools** let
staff simulate changes (e.g. collateral or tenure) and see the outcome. Explainability research (credit
underwriting) stresses **per-decision factor attribution** — showing *which inputs drove the outcome*.

Design takeaways: **reason codes + factor attribution per finding**, **owner-tunable rules surfaced in
an admin screen** (we have this — thresholds config), and a **what-if simulator** ("if I replace the
ARV with the appraisal's, the loan resizes to $X and finding F6 clears") — see novel ideas.

Sources: [DecisionRules — top rule engines 2026](https://www.decisionrules.io/en/articles/top-10-business-rule-engines/),
[LendFoundry — underwriting vs decision engine](https://lendfoundry.com/blog/underwriting-engine-vs-decision-engine-which-drives-better-los-outcomes/),
[Origence automated decisioning](https://origence.com/solutions/automated-loan-decisioning/),
[FinRegLab — explainability & fairness in ML underwriting (PDF)](https://finreglab.org/wp-content/uploads/2023/12/FinRegLab_2023-12-07_Research-Report_Explainability-and-Fairness-in-Machine-Learning-for-Credit-Undewriting_Policy-Analysis.pdf).

---

## Part B — Cross-cutting patterns (answers to the six questions)

### B1. Findings/exceptions UX — how the best systems present findings
- **Section = message type**, not one flat list (DU's Risk/Eligibility vs Verification vs Red-Flag;
  LPA's Actionable vs Informational vs Opportunity). **Blocking items float to the top.**
- **Two-to-three severity tiers, anchored on one binary**: "does this make the loan ineligible/does
  this block?" (Fannie's critical-vs-non-critical; LPA Accept-vs-Caution). Sub-tiers are cosmetic.
  → our **fatal/warning/info** is right; keep the binary "blocks CTC?" as the load-bearing line.
- **Every actionable finding states the fix** ("satisfied by *this document*"; SitusAMC "cure
  analysis"). Findings without a "how to clear" are noise.
- **Reason codes** on caution/decline items (LPA Caution section; general reason-code norm).
- **Non-blocking inconsistency detectors are still shown** (DU red flags = our info/verify tier).
- **Message-catalog hygiene** (Freddie retiring 1,100+ messages): fewer, sharper findings.
- **An "opportunity / what-would-fix-this" lane** (LPA Opportunity, LPA Choice) — a positive framing
  we can uniquely offer via the repricing chain.

### B2. Resolution actions & approval hierarchy
- Industry action set per finding/exception: **clear** (satisfied w/ docs), **waive/grant exception
  with reason code**, **add/attach a condition**, **request document**, **rebut/respond** (ACES,
  LoanLogics ARC), **override**, **decline**. → our F1–F23 actions (Replace/Keep/Request/Exception/
  Decline) already match; the **rebuttal/response box + immutable trail** (ARC) is the piece to make
  first-class.
- **Actions are role-gated *per condition/finding template*** (Encompass persona controls; our
  capabilities `sign_off_conditions` / `waive_conditions` / `manage_conditions`). Adopt **per-template
  action gating** (e.g. only underwriter+ may waive an F4 shortfall; a processor may request a doc).
- **Every waiver carries a reason code and is trended** (Ncontracts) — not just logged per file.
- **Immutable audit trail of every decision** is universal (LoanLogics compliance trail, Maxwell/
  Roostify audit trails) — we have `audit_log`; ensure every finding action writes one row with
  actor, finding id, old→new, reason code.

### B3. Conditions engine
- **Prior-To gating ladder** is the industry backbone: prior-to-approval / prior-to-doc / prior-to-
  closing / prior-to-funding (Encompass "Prior To" values) — our `prior_to_approval → post_closing`.
- **Lifecycle**: added → **received** → reviewed/cleared **or** waived; open-count → 0 = **CTC**
  (Encompass pipeline open-condition columns; the generic UW lifecycle). Our
  added/received/satisfied/waived + the `appraisal_review_cleared` gate matches.
- **Auto-conditions from findings** (Indecomm "pre-organized conditions list"; Encompass automated
  business-rule conditions) — our F5→`appraisal_as_is_verify`, F17→1004D condition.
- **Borrower upload advances to *received*, staff must review/sign off** — our audit already enforces
  this (don't copy Maxwell's auto-*resolve* for gating conditions).
- **Dual approval / sign-off authority** by role/persona (Encompass) — layer per-condition.

### B4. Repricing / re-decision triggers
- The norm is **resubmit-to-re-decision**: change a value (e.g. appraised value → LTV) and the loan is
  **re-run** (LPA "adjust terms and resubmit"; DU resubmission). Scenario/what-if managers preview the
  re-decision before committing. → our **repricing chain** (`trg_reopen_on_budget_change`, a changed
  ARV/As-Is/units/rent reopens `product_pricing`, the frozen engine resizes, re-register, re-fire
  fatals) is *stronger* than most because it's **automatic on the corrected input**, not a manual
  resubmit. The gap vs best-in-class is a **what-if preview** *before* committing the reprice.

### B5. Scorecards / risk indicators
- **A single loan-/collateral-level risk score** (CU 1–5; SitusAMC five-level RiskIndicator) with
  **decomposed flags** and drill-down. → adopt an **appraisal-file risk score** (roll up open fatals/
  warnings + CU score) for the badge.
- **Open-condition counts as the pipeline signal** (Encompass columns) — our badge (fatal count).
- **Aging / SLA / trend dashboards**: exception frequency + month-over-month trends (Ncontracts);
  exception-based processing to segment problem loans (SitusAMC). → add **aging on open findings/
  conditions** and a **portfolio findings dashboard** (by category, by severity, by SLA breach).
- **Auto-generated executive summaries** of a file's findings (ACES).

### B6. Novel ideas worth stealing/inventing
- **What-if / scenario preview on a finding** (Scenario Manager): "Resolve F1 by replacing ARV → loan
  resizes to $X, LTARV n%, and F6 clears / or re-fires" — shown *before* committing. Uniquely feasible
  for us because the repricing chain already computes it; we'd just run it in dry-run.
- **Opportunity lane** (LPA): surface the *favorable* path — "the appraisal came in $20k higher; you
  may re-size up on request" (our F2 already does this — make it a first-class positive card).
- **Source-vs-file side-by-side diff** (Indecomm data-vs-doc discrepancy; DataVerify): for every
  finding show **appraisal value | file value | delta | confidence** in one row, with the appraisal's
  provenance (page/field) — our engine already has `{value, source, confidence}`.
- **Templated waivers with reason codes** (Ncontracts trending): a small library of pre-approved
  exception reasons ("ROV pending", "assignment fee explains price gap") that stamp a reason code,
  set the approver level, and feed the trend dashboard.
- **Per-finding "response/rebuttal" box + immutable trail** (LoanLogics ARC): the underwriter's
  narrative resolution lives *on the finding*, not in a separate note.
- **Auto-generated plain-language file summary** (ACES): "This file has 2 blocking issues (value
  shortfall, stale date) and 3 review items" — one sentence the LO reads.
- **Bulk actions across findings** (acknowledge all info; request-docs for all warnings).
- **Message-catalog hygiene** (Freddie): version findings, retire/merge redundant ones, and record
  which threshold-version fired each (we already record the threshold version).

---

## Part C — Prioritized "features to adopt" (mapped to our engine)

Mapped to: **PILOT findings engine (F1–F23)**, **conditions (Condition Center)**, **blocking CTC
condition (`appraisal_review_cleared`)**, **findings badge**, **repricing chain**.

### Feasible NOW (small/medium build on top of what exists)

| # | Feature | Maps to | Why / source | Effort |
|---|---|---|---|---|
| N1 | **Section the findings list by message-type & float blockers to top** — "Must resolve before CTC" (fatals) / "Review items" (warnings/verify) / "For the file" (info), blockers first. | badge + findings UI | DU sections, LPA Actionable/Informational; readers instantly see must-do vs FYI. | Low |
| N2 | **"How to clear" line on every finding** — each finding renders its concrete fix + the doc that satisfies it (we have the Actions column; surface a one-line cure). | F1–F23 UI | DU verification messages, SitusAMC cure analysis. | Low |
| N3 | **Source-vs-file diff row** — appraisal value \| file value \| delta \| confidence \| appraisal provenance, on every value finding. | F1/F4/F6/F7/F11/F19 | Indecomm data-vs-doc; we already carry `{value,source,confidence}`. | Low–Med |
| N4 | **Reason codes on every waiver/dismiss + a small templated-waiver library** (pre-approved reasons that stamp a code and required approver level). | warning dismissal, F4/F7/F14/F18 exceptions | Ncontracts exception trending; LPA reason codes. | Med |
| N5 | **Per-finding response/rebuttal box** writing one `audit_log` row (actor, finding id, old→new, reason code, timestamp). | audit guarantee §7 | LoanLogics ARC compliance trail. | Low–Med |
| N6 | **Appraisal-file risk score + count summary in the badge** — roll up open fatals/warnings (+ CU score if present) into a 1-line score; keep fatal-count as the CTC signal. | badge | CU 1–5, SitusAMC RiskIndicator, Encompass open-condition columns. | Low–Med |
| N7 | **Per-condition/finding role-gated actions** — which role may clear vs waive vs request-doc, per template (we have capabilities; gate per template). | Condition Center roles, F4/F7 exception approver | Encompass persona controls. | Med |
| N8 | **Auto-clear lane made visible** — show "cleared automatically (F3/within-tolerance)" separately from "needs you." | F3 auto-pass | LoanLogics auto-clear/route-exceptions. | Low |
| N9 | **Aging + SLA timer on open findings/conditions** — days-open, oldest-first. | conditions, badge | Ncontracts trend/aging, SitusAMC exception processing. | Med |

### LATER (larger build / new surfaces)

| # | Feature | Maps to | Why / source | Effort |
|---|---|---|---|---|
| L1 | **What-if / scenario preview before committing a reprice** — dry-run the repricing chain and show the resulting loan/LTARV/LTV and which fatals clear or re-fire, *before* the underwriter commits Replace-value. | repricing chain, F1/F4/F6/F7/F9/F19 | Scenario Manager; explainability. Highest-value differentiator — the chain already computes it. | Med–High |
| L2 | **Opportunity lane** — a positive card set: "appraisal higher than file → you may re-size up", "value supports a lower rate band". | F2 + repricing | LPA Opportunity / LPA Choice. | Med |
| L3 | **Portfolio findings dashboard** — findings by category & severity, waiver reason-code trends, SLA breaches, aging; auto-generated per-file plain-language summary. | badge + new admin screen | ACES exec summaries, Ncontracts trending, SitusAMC RiskIndicator. | High |
| L4 | **Defect *category* dimension** on findings (Collateral/Value, Identity, Eligibility/Dates, Income-DSCR) for root-cause slicing. | F1–F23 metadata | Fannie Loan Defect Taxonomy categories. | Med |
| L5 | **Bulk actions** across findings (acknowledge-all-info, request-docs-for-all-warnings). | findings UI | ACES roll-up; general UX. | Med |
| L6 | **Findings-message catalog hygiene + versioning** — findings library with retire/merge, each firing records threshold-version (partly done). | thresholds config | Freddie retiring 1,100+ messages. | Med |
| L7 | **Dual approval on high-impact waivers** (e.g. two sign-offs to waive an F4 shortfall). | `appraisal_review_cleared`, exceptions | Encompass persona controls; QC governance. | Med |

**Deliberately NOT adopting:** auto-*satisfying* a condition on borrower upload (Maxwell). Our audit
(`05-conditions-engine.md` S5-03) requires borrower inputs stay *claimed/received* until staff accept;
auto-resolve would reintroduce that risk. Keep auto-advance-to-received + notify.

---

## Part D — Sources (consolidated)

- DU: [Selling Guide B3-2-11](https://selling-guide.fanniemae.com/sel/b3-2-11/du-underwriting-findings-report) · [B3-2-01](https://selling-guide.fanniemae.com/sel/b3-2-01/general-information-du) · [DU FAQ](https://singlefamily.fanniemae.com/learning-center/originating-and-underwriting/desktop-underwriter-learning-center/desktop-underwriter-general-frequently-asked-questions) · [Homebuyer.com](https://homebuyer.com/guidelines/fannie-mae/du-underwriting-findings-report-b3-2-11) · [Premier Mortgage](https://www.premiermtg.com/ft-lauderdale-desktop-underwriting-du-findings-what-they-mean-for-your-conventional-approval/)
- LPA: [Feedback Redesign](https://sf.freddiemac.com/articles/news/lpa-feedback-redesign-drive-efficiency-and-uncover-opportunity) · [Feedback/Risk updates PDF](https://sf.freddiemac.com/docs/pdf/lpa-feedback-messages-risk-assessment-technology-updates.pdf) · [LegalClarity overview](https://legalclarity.org/freddie-mac-lpa-automated-underwriting-system-overview/)
- CU: [Fannie CU](https://singlefamily.fanniemae.com/applications-technology/collateral-underwriter) · [Risk Flags job aid](https://singlefamily.fanniemae.com/job-aid/collateral-underwriter/topic/risk_flags_overview.htm) · [JVM](https://www.jvmlending.com/blog/what-is-a-cu-score-on-an-appraisal/) · [McKissock](https://www.mckissock.com/blog/appraisal/fannie-maes-collateral-underwriter-program/)
- Defect taxonomy: [Fannie Taxonomies](https://singlefamily.fanniemae.com/loan-defect-taxonomies) · [DocMagic list](https://www.docmagic.com/compliance/regulatory-announcements/fm-defect-list) · [FHA 4-tier (MortgageOrb)](https://mortgageorb.com/phil-mccall-fhas-new-loan-defect-taxonomy-could-create-challenges-for-lenders)
- ACES: [Product](https://www.acesquality.com/products/aces-quality-management-control) · [ACES Intelligence](https://www.send2press.com/wire/aces-quality-management-launches-aces-intelligence-redefining-mortgage-and-financial-services-quality-control-with-ai/)
- LoanLogics: [LoanHD](https://www.loanlogics.com/products/loan-quality-management-technology/) · [QC blog](https://www.loanlogics.com/blog-mortgage-quality-control-software/) · [ARC](https://nationalmortgageprofessional.com/news/63779/loanlogics-enhances-loanhd-through-audit-response-center)
- Indecomm: [DecisionGenius](https://indecomm.com/product/decisiongenius/) · [Underwriting](https://indecomm.com/solutions/mortgage-underwriting/) · [Release](https://indecomm.com/indecomm-releases-decisiongenius-an-automated-decision-making-software-for-mortgage-underwriting)
- DataVerify: [DRIVE](https://drive.dataverify.com/)
- SitusAMC: [Diligence/QC (Clarity)](https://www.situsamc.com/residential-diligence-QC) · [ComplianceAnalyzer](https://www.situsamc.com/complianceanalyzer) · [ComplianceEase](https://www.situsamc.com/complianceease)
- Ncontracts: [Exception mgmt](https://www.ncontracts.com/nsight-blog/fair-lending-compliance-exception-management) · [Mortgage risk mgmt](https://www.ncontracts.com/mortgage-lender-risk-management)
- Encompass: [Enhanced Conditions API](https://developer.icemortgagetechnology.com/developer-connect/reference/loan-enhanced-conditions) · [Conditions API](https://developer.icemortgagetechnology.com/developer-connect/reference/loan-conditions) · [Enhanced Conditions guide](https://awesometechinc.com/step-by-step-guide-to-the-encompass-enhanced-conditions-tool/) · [Auto Conditions](https://awesometechinc.com/encompass-auto-conditions/) · [Lender Toolkit](https://lendertoolkit.com/how-lenders-reduce-underwriting-conditions-in-encompass/)
- POS: [Maxwell](https://himaxwell.com/resources/blog/what-is-mortgage-point-of-sale-pos-software/) · [Maxwell profile](https://www.mortgageadvisortools.com/companies/maxwell/) · [Roostify (via POS roundups)](https://deantellone.com/top-9-mortgage-pos-systems-for-streamlining-lending/)
- Rules/explainability: [DecisionRules](https://www.decisionrules.io/en/articles/top-10-business-rule-engines/) · [LendFoundry](https://lendfoundry.com/blog/underwriting-engine-vs-decision-engine-which-drives-better-los-outcomes/) · [Origence](https://origence.com/solutions/automated-loan-decisioning/) · [FinRegLab explainability PDF](https://finreglab.org/wp-content/uploads/2023/12/FinRegLab_2023-12-07_Research-Report_Explainability-and-Fairness-in-Machine-Learning-for-Credit-Undewriting_Policy-Analysis.pdf)
</content>
</invoke>
