# LOS / Mortgage-Platform Appraisal & Collateral Modules — Competitive Feature Research

Competitive/feature research for our appraisal-import + property-profile + underwriting-findings system.
Goal: study how the major LOS, POS, appraisal-AMC, and RTL/private-lender platforms handle the
**appraisal / collateral / property** module, and steal the good ideas.

**How to read this doc.** Part 1 = the industry plumbing every serious appraisal module is built on
(UCDP/SSR, Collateral Underwriter, UAD 3.6, the data-collection/waiver products). Part 2 = platform-by-platform
notes. Part 3 = the prioritized **"features to steal"** list mapped to our sections
(*appraisal import / property report / file error-handling / underwriting findings / conditions*),
each tagged **feasible-now** vs **later**.

Our current design (for mapping): a two-path XML importer (1004 vs 1025) that extracts subject/comps/
photos/ARV/As-Is with a `{value, source, confidence}` stamp per field, a property-profile report section,
a per-file error-handling/exception surface, underwriting match rules (CTC), and internal conditions
(e.g. `appraisal_as_is_verify`). See `../README.md`, `../error-handling-and-confidence.md`,
`../underwriting-findings-rules.md`.

---

## PART 1 — The industry plumbing (what everyone integrates with)

This is the shared substrate. Even a private lender that never sells to the GSEs benefits from copying
these patterns because they are the de-facto standard for "what an appraisal module looks like."

### 1.1 UCDP / EAD — the submission portal, the SSR, and hard stops

- **UCDP** (Uniform Collateral Data Portal, Fannie+Freddie joint) and **EAD** (FHA Electronic Appraisal
  Delivery) are the portals lenders submit appraisals to. The appraisal must be **MISMO XML** (2.6 Errata 1
  GSE-extended is the legacy standard; 3.6 for the redesign). This is exactly the XML we ingest.
  <https://singlefamily.fanniemae.com/learning-center/applications/uniform-collateral-data-portal-learning-center/faqs-uniform-collateral-data-portal>
  <https://sf.freddiemac.com/faqs/ucdp-faq>
- **The XML + PDF pair.** A UCDP submission is fundamentally an **XML file paired with its embedded/attached
  PDF**. This is the origin of the "two-slot upload" mental model — the data file and the human-readable
  report travel together. (Under UAD 3.6 the retrievable set becomes XML + PDF, plus a JSON option via the
  data interface.)
  <https://sf.freddiemac.com/faqs/ucdp-faq>
- **Submission Summary Report (SSR).** Every successful submission returns an **SSR per GSE**: a summary of
  the file, its submission **status**, and a **Document File Identifier (Doc File ID)** — the unique appraisal
  id the lender must carry into loan delivery. Our analog: a per-import receipt/summary object.
  <https://singlefamily.fanniemae.com/media/6926/display>
- **Hard stops vs proprietary findings.** UCDP surfaces a dedicated **Hard Stops panel** (bottom-left of the
  Check-Status / View-Result tab). **Hard stops** block until fixed or overridden; some **cannot be
  overridden** → a revised appraisal must be re-obtained and resubmitted. **GSE Proprietary Findings** are
  softer feedback against each GSE's requirements. This hard-stop / soft-finding / override split is the
  canonical model for our file-error-handling section.
  <https://sf.freddiemac.com/faqs/ucdp-faq>
- **Encompass wraps UCDP/EAD** as an integrated interface: submit the XML data file, receive **status and
  findings**, **correct/modify** submissions, and **request overrides** — all in-LOS. Successful uploads get a
  Doc File ID; passing files get the SSR.
  <https://help.icemortgagetechnology.com/DocumentationLibrary/360/UCDP.pdf>

### 1.2 Fannie Mae Collateral Underwriter (CU) — the risk-score model

CU is the appraisal-QC brain the whole industry benchmarks against. Free web app; also delivered as messages
into the LOS.

- **Risk score 1.0–5.0** (1 = lowest risk, 5 = highest) on every appraisal. Scores **≤ 2.5** can qualify for
  **Day 1 Certainty** (rep-and-warrant relief on value). A single, legible collateral-risk number is a strong
  UI primitive.
- **Four risk-flag families:** **Overvaluation, Undervaluation, Property Eligibility / Policy Compliance, and
  Appraisal Quality.** Each flag drills into **messages** with **self-serve job aids** telling the reviewer
  what to investigate. This is a clean taxonomy for our own findings.
- **Guidance guardrail:** lenders must combine CU feedback with **human due diligence** and must **not** instruct
  the appraiser based solely on automated feedback. Mirrors our own "estimate is a hint, officer confirms" stance.
  <https://singlefamily.fanniemae.com/applications-technology/collateral-underwriter>
  <https://singlefamily.fanniemae.com/job-aid/collateral-underwriter/topic/risk_flags_overview.htm>

### 1.3 UAD 3.6 / the redesigned URAR — the form model is changing under us

Directly affects our importer roadmap.

- **One dynamic report replaces all legacy forms.** The redesigned URAR is a **single, data-driven report that
  expands/contracts to the property and assignment**, replacing 1004, 1025, 1073, 2055, 1075, manufactured,
  co-op, etc. **The data describes the property; the form type no longer drives the report.**
- **Timeline:** Limited Production Period began **Sept 8, 2025**; from **Jan 26, 2026** lenders may submit
  **either UAD 2.6 or 3.6**; **UAD 3.6 mandatory Nov 2, 2026**. So we are in the dual-format window right now.
- **Importer implication:** our two-path (1004 vs 1025) routing is correct **for the 2.6 world** but is a
  transitional design. Plan a **third path**: a data-driven mapper keyed off property attributes rather than
  `AppraisalFormType`, aligned to the 3.6 dataset. Keep the field-map abstraction so 3.6 slots in.
  <https://www.mckissock.com/blog/appraisal/the-future-is-now-fannie-mae-and-freddie-mac-announce-uad-3-6-implementation-timeline-and-policy-changes/>
  <https://www.valuelinksoftware.com/everything-you-need-to-know-about-the-uad-3-6-rollout-and-changes/>

### 1.4 Data-collection / waiver products (ACE+ PDR, Value Acceptance + Property Data, UPD, hybrid 1004H)

The GSEs increasingly accept **inspection-based, non-appraisal** collateral. Relevant because a private lender
may value some deals with a lighter product than a full appraisal.

- **Freddie ACE+ PDR** = appraisal waiver (ACE) **plus a Property Data Report** collected on-site by a trained
  **data collector** in a standardized format — no full appraisal. ~$400 cheaper and ~10–12 days faster than
  an appraisal (Q2 2025).
- **Fannie Value Acceptance + Property Data** = the equivalent: a value-acceptance offer extended with an
  on-site **property data collection** capturing current condition.
- **UPD (Uniform Property Dataset)** is the joint-GSE **dataset for these inspection-based products** — a second
  standardized XML/data schema besides UAD.
- **Hybrid (1004H):** if the PDR isn't enough, an appraiser completes a **desktop/hybrid** appraisal off the
  collected data; ordering tools chain the 1004H to the existing data-collection order for the same subject.
  <https://sf.freddiemac.com/tools-learning/technology-tools/our-solutions/ace-pdr>
  <https://www.clearcapital.com/solutions/gse-data-collection/>

### 1.5 Appraisal-review automation & AVM waterfalls (the review layer)

- **AI/rules appraisal review** (Confer, Veros VeroSCORE, ValueLink, LenderX, Clear Capital): a rules engine
  runs in **30–60s/appraisal** and validates **comp selection, adjustment reasonableness, cross-checks against
  multiple AVMs, value reconciliation**, and scores risk to **prioritize human review** — explicitly to catch
  defects "before they become buybacks" and **before they trigger CU/ACE alerts**.
- **AVM waterfall / cascade:** run several AVMs by confidence; if one fails a confidence threshold, fall to the
  next. **Confidence scores** drop when comparable data is thin or inconsistent. Great pattern for corroborating
  our extracted ARV/As-Is with an independent value.
- **Appraiser scorecard:** track avg risk score by appraiser, revision-request frequency + reason codes, GSE
  flag rates, AVM variance, turn time — to identify consistently high-risk appraisers.
  <https://confersolutions.ai/blog/ai-appraisal-review-mortgage-lending>
  <https://www.veros.com/solutions/collateral-risk-management/veroscore>
  <https://www.clearcapital.com/when-to-use-avms-and-appraisals-in-property-valuation/>

---

## PART 2 — Platform-by-platform

> Depth varies by public documentation. ICE/Encompass, the AMC layer, and the GSE tooling are documented in
> detail; several private-lender and RTL-fintech platforms publish little about their internal collateral
> screens, so those notes are lighter and flagged as such.

### ICE Mortgage Technology — Encompass (+ Encompass Partner Connect, Appraisal Center, Data Connect)

The reference implementation. Nearly everything below is a candidate to copy.

- **Ingestion / ordering.** Appraisals are **ordered and retrieved inside the loan** via the **Services tab →
  Appraisal Order Status** window; on completion the **Import** link **downloads the report and attaches it to
  the eFolder**. Orders route through partner AMCs (Mercury/a la mode, ValueLink, Reggora, Clear Capital,
  Appraisal Firewall, homegenius, etc.) over **Encompass Partner Connect** APIs. UCDP/EAD submission is built in
  (§1.1).
  <https://help.icemortgagetechnology.com/appraisalcenter/1.0/Content/Welcome.html>
  <https://www.takefiveconsulting.org/appraisal-process-within-encompass/>
  <https://help.icemortgagetechnology.com/DocumentationLibrary/360/UCDP.pdf>
- **Auto-populate + field mapping.** Integrations **map incoming appraisal forms to eFolder documents** and
  **sync appraisal data points into loan fields** automatically. Clear Capital's integration syncs
  **ClearAVM value, Forecast Standard Deviation (FSD), and property condition** straight to the loan file,
  saving 4–10 min/order and removing manual-entry error. This is the "auto-parse XML into fields" pattern.
  <https://www.clearcapital.com/clear-capital-adds-automated-service-ordering-and-field-mapping-for-encompass-by-ice-mortgage-technology-users/>
- **Collateral / appraisal screen.** Appraisal data lives on dedicated input forms; an in-LOS **appraisal-review
  tool brings the appraisal data to the underwriter** so they review without opening the PDF. AURA (Clear
  Capital, on Partner Connect) runs automated collateral review on the URAR XML+PDF and returns a **Report
  Summary PDF** = a centralized risk assessment.
  <https://www.clearcapital.com/access-intelligent-appraisal-review-with-aura-on-the-encompass-partner-connect-api-platform-available-through-ice-mortgage-technology/>
- **Reconciliation / mismatch.** Automation **compares extracted document data against Encompass fields and
  flags inconsistencies** early; the guidance is explicit — "when the data in Encompass does not match the
  uploaded documents, **conditions are likely**," so lenders **automate field validation before underwriting**.
  Confirms our "compare source vs file → flag → condition" flow is industry-standard.
  <https://lendertoolkit.com/how-lenders-reduce-underwriting-conditions-in-encompass/>
- **Exception / conditions surface = the eFolder.** The **eFolder** is the document+conditions hub:
  underwriting / prelim / post-closing **conditions**, each linkable to **multiple documents** and to milestones.
  **Milestone events auto-trigger tasks/alerts** (e.g. notify the processor when the appraisal is received);
  **workflow automation** fires alerts when all conditions clear. This is the closest existing analog to our
  per-file error-handling + conditions section.
  <https://developer.icemortgagetechnology.com/developer-connect/reference/loan-conditions>
  <https://lendertoolkit.com/how-lenders-reduce-underwriting-conditions-in-encompass/>
- **Document lifecycle.** Import via scan / drag-drop / email / provider integration → organize with
  **stacking templates** → link to conditions/milestones → track status. Appraisal received is a milestone;
  review tools and condition clearing drive the received→reviewed→approved lifecycle.
  <https://help.icemortgagetechnology.com/DocumentationLibrary/360/UsingEncompassDocsSolution.pdf>
- **Encompass Data Connect.** A reporting/data-warehouse layer exposing the full loan dataset (incl. appraisal
  fields) for BI and downstream analytics — the model for making our extracted appraisal fields queryable, not
  trapped in one screen.

### Empower (Black Knight) / Dark Matter Technologies

- Empower is the other tier-1 bank LOS; its collateral handling parallels Encompass — UCDP/EAD submission,
  appraisal ordering integrations, and conditions/exception tracking. **Dark Matter Technologies** acquired the
  Black Knight Empower/origination suite (2023, divested during the ICE–Black Knight merger) and now develops it,
  pushing AI into document/appraisal processing. *(Public collateral-screen documentation is thin; treat as
  parity with Encompass rather than a distinct pattern to copy.)*

### Mortgage Cadence (Accenture)

- Enterprise LOS with an imaging/conditions engine and appraisal-vendor integrations comparable to Encompass.
  *(Limited public detail on the specific collateral screen; parity assumption.)*

### Blend

- Consumer-facing **POS** layered on an LOS. Blend's strength is the borrower/loan-officer workflow and its
  **marketplace of ordered services** (incl. appraisal) with status surfaced in the borrower/LO timeline, plus
  automated **condition/document collection**. Collateral data ultimately lands in the connected LOS. *(Public
  detail on a dedicated collateral screen is limited; strongest idea to borrow is the borrower-visible
  order-status timeline.)*

### nCino Mortgage / SimpleNexus

- SimpleNexus (now **nCino U.S. Mortgage**) is a mobile-first POS + disclosure/closing platform. Appraisal shows
  up as an **ordered service with borrower-visible status and payment**, and documents flow to the LOS eFolder.
  Notable pattern: **borrower can pay for and track the appraisal from their phone**, and push notifications on
  status changes. *(Collateral-screen internals not deeply public.)*

### MeridianLink (MeridianLink Mortgage / LendingQB)

- Browser-based LOS for banks/credit unions with configurable **appraisal-order integrations** and a
  document/conditions engine. Emphasis on **decisioning + service ordering** via its partner network.
  *(Specific collateral-tab fields not deeply documented publicly.)*

### BytePro (Byte Software)

- Long-standing bank LOS. Appraisal handled through **service-provider integrations** and stored in the
  document management module with condition tracking. *(Older architecture; less public UX detail.)*

### LendingPad (WEI Technology)

- Modern cloud LOS popular with brokers/small lenders; real-time collaboration, integrated **appraisal ordering**
  and document management with conditions. *(Collateral-screen internals not deeply public.)*

### Floify

- **POS / borrower portal** (document collection, status, e-sign). Appraisal appears as a **milestone + document
  request** with automated borrower notifications; strong at the **status-timeline** UX. Data flows to the LOS.
  *(Not a collateral-data system itself.)*

### The appraisal-AMC / review layer (Reggora, Mercury Network, ValueLink, AppraisalScope, Clear Capital)

These are what an LOS *orders through* — and their lender-side dashboards are a rich source of features.

- **Reggora.** Modern appraisal management that **embeds in the LOS by iFrame or custom UI via open API** — lets
  a lender manage **100% of appraisal orders inside their own system**. Production staff get **24/7 real-time
  order status: due dates, milestones, communications**. **Pipeline Views** = custom filters over any data point
  to build **rule-based, exception-based workflows** for the appraisal pipeline. Reggora also ships an
  **automated appraisal-review** product (rule-based reviews / revision requests). Claims ~2-day cycle-time cut
  and up to $258/loan saved.
  <https://www.reggora.com/press/reggora-announces-appraisal-order-management-software-fully-integrates-into-custom-loan-origination-systems>
  <https://www.reggora.com/blog/reggora-pipeline-views-take-control-of-your-appraisal-pipeline>
  <https://www.reggora.com/lenders/appraisal-review>
- **Mercury Network (a la mode).** Appraisal ordering + vendor management; deep Encompass integration
  (accuracy + status sync into the loan). Produces the a la mode TOTAL XML we already parse.
  <https://mktrsc.mercuryvmp.com/downloads/encompassbenefits_generic.pdf>
- **ValueLink.** AMC software with **Encompass integration**, **review & compliance** module (rules-based
  appraisal review, revision-request tracking, audit-ready trail) and full order-status workflow.
  <https://www.valuelinksoftware.com/encompass-integration/>
  <https://www.valuelinksoftware.com/review-and-compliance/>
- **AppraisalScope.** AMC/valuation-management platform (ordering, vendor management, compliance) — one of the
  ordering integrations we'd expose as a source.
- **Clear Capital.** Value-product **waterfall**: ClearAVM, **ClearCollateral Review**, **CDA (Collateral
  Desktop Analysis)**, AURA (on Encompass), and GSE data-collection (Value Acceptance + PD / ACE+ PDR). Syncs
  value/FSD/condition to the loan (see Encompass note). The "menu of value products of increasing rigor" is a
  strong model.
  <https://www.clearcapital.com/solutions/gse-data-collection/>

### RTL / private-lender loan platforms

Closest to our world (fix-and-flip, DSCR, bridge, ground-up). These are value-**entry** systems more than
XML-import systems — the opportunity is that a real XML importer + property profile would leapfrog them.

- **Liquid Logics (Nova).** Cloud LOS purpose-built for **private/hard-money lenders**; models **As-Is value,
  ARV, purchase price, rehab budget** and **LTV/LTC/LTARV** leverage natively, with document management and
  conditions/stips. *(Value typically entered/ordered rather than XML-imported — our importer is a differentiator.)*
- **Mortgage Automator.** Private-lending LOS **+ servicing**; deal record carries property value fields, LTV
  caps, and a document/condition checklist; draw/rehab management on the servicing side. *(Manual value entry.)*
- **The Mortgage Office (Applied Business Software).** Mature loan-servicing suite; property/collateral record
  with valuation fields and document storage; strong on servicing/draws, lighter on origination-side appraisal
  ingestion.
- **LoanPro.** API-first loan-management/servicing core; collateral is a data object with custom fields —
  flexible but not appraisal-specialized; you'd build the property profile on top.
- **Bryt Software.** Lightweight loan-servicing; basic collateral/property fields + document attachment.
- **LendingWise.** LOS/POS for hard-money/private/commercial; deal record with **As-Is/ARV/rehab/LTV-LTC-LTARV**,
  conditions/stips checklist, borrower/broker portal, appraisal/BPO as an uploaded doc or ordered service.
  *(Value entry + document upload; not a structured XML importer.)*

### RTL fintech lenders (proprietary tech) — Baseline, Roc360, Kiavi, Lima One

Direct lenders whose broker/borrower portals show how to present valuation to a non-underwriter.

- **Baseline (baseline.io).** Software for private lenders emphasizing fast, **automated deal analysis** incl.
  property valuation and leverage; the pitch is instant sizing from property + value inputs. *(Internals not
  deeply public.)*
- **Roc360 / Roc Capital.** Broker-facing platform that **prices/sizes a deal from the property and value
  inputs**, with an internal valuation/review step before terms firm up. Strong at **term-sheet-from-value**
  transparency to brokers. *(Internals proprietary.)*
- **Kiavi (formerly LendingHome).** Best-in-class RTL borrower UX: **instant online terms**, internal/automated
  valuation to generate an ARV-based offer quickly, appraisal ordered in-flow, status shown in the borrower
  portal. The "**your value came in at X, so your max loan is Y**" transparency is the idea to steal.
  <https://www.kiavi.com/>
- **Lima One Capital.** National RTL lender; broker/borrower portal surfaces deal status, conditions, and
  valuation/appraisal ordering. *(Internals proprietary.)*

---

## PART 3 — Prioritized "features to steal", mapped to our sections

Tags: **[NOW]** = feasible with our current data/architecture; **[LATER]** = needs new integrations, an image/AVM
pipeline, or UAD-3.6 work. Each item names the section it lands in.

### A. Appraisal import (our XML importer)

1. **[NOW] Per-import "Submission Summary" receipt object** — model our import result on the **SSR + Doc File ID**:
   one object recording *what we ingested* (form type, effective date, appraiser, value figures), *the outcome*
   (success / partial / failed), and a **stable import id** the rest of the file references. Gives every import a
   citable receipt instead of just mutating fields. *(from UCDP/SSR §1.1)*
2. **[NOW] Formalize the XML+PDF pair as the import unit** — the industry treats the data file and its PDF as one
   deliverable. We already store both; make the **pair** the first-class import artifact (data + human-readable
   fallback), shown together. *(§1.1)*
3. **[NOW] Field-level auto-populate with an overwrite shield** — sync extracted fields into the loan file
   automatically (like Clear Capital→Encompass), but **never overwrite a human value with a lower-confidence
   import** (we already have this rule). Show which loan fields the import touched. *(Encompass/Clear Capital)*
4. **[LATER] A third, data-driven import path for UAD 3.6 / redesigned URAR** — the form-number routing (1004 vs
   1025) is transitional. Build a mapper keyed off **property attributes**, aligned to the 3.6 single-dataset
   report. We are already in the dual-format window (Jan–Nov 2026). *(§1.3)*
5. **[LATER] Ingest the non-appraisal collateral products** — support the **UPD / Property Data Report** schema
   and **hybrid 1004H**, so a deal valued by a data-collection product (not a full appraisal) still flows through
   the same pipeline. *(§1.4)*

### B. Property report (our property profile)

6. **[NOW] A single collateral-risk headline number** — adopt a **CU-style 1–5 risk score** (or our own
   composite) at the top of the property profile so an officer reads risk at a glance, with drill-down into the
   contributing findings. *(CU §1.2)*
7. **[NOW] Bring the data to the reviewer (don't make them open the PDF)** — Encompass's appraisal-review tool
   surfaces the appraisal data in-app; our profile already does this. Add a **"Report Summary" one-screen view**
   (subject facts, value summary As-Is/ARV, comp table, photo manifest, flags) mirroring AURA's Report Summary PDF.
   *(Encompass/AURA)*
8. **[LATER] AVM cross-check with a confidence score** — corroborate our extracted ARV/As-Is against an
   independent **AVM (with FSD/confidence)**; show variance. Use an **AVM waterfall** if one provider's confidence
   is low. Turns "we read $X" into "we read $X and an AVM says $Y (± FSD)." *(§1.5, Clear Capital)*
9. **[LATER] Prior-sales / transfer history & market-trend panel** — surface subject prior sales and a small
   market-trend block (from 1004MC data we already catalog, later enriched by an external data source). *(§1.2)*

### C. File error-handling / exception surface (our per-file error section)

10. **[NOW] A dedicated hard-stop vs soft-finding panel** — copy UCDP's model exactly: a **Hard Stops panel**
    (blocking; some non-overridable → re-import required) separated from **soft findings/warnings** (advisory).
    Our "ARV could not be read = CRITICAL/blocking" vs "As-Is ≤ ARV = soft flag" maps directly. Make the
    blocking/non-blocking distinction a first-class attribute of every issue. *(§1.1)*
11. **[NOW] Findings taxonomy with per-finding "what to do"** — adopt CU's structure: group issues into families
    (we'd use e.g. **value / data-missing / mismatch / eligibility / quality**), and attach a **self-serve
    "how to resolve"** note to each, so an officer isn't guessing. *(CU §1.2)*
12. **[NOW] Override with reason (audited)** — where a finding is overridable, require an **override reason** and
    log it (UCDP override pattern). Non-overridable findings force a re-import. *(§1.1)*
13. **[NOW] "Data doesn't match the file → likely a condition" compare view** — a **source-vs-file diff**
    (appraisal address/value/units vs loan file) that flags mismatches and, per Encompass guidance, **proposes the
    condition** rather than silently accepting. *(Encompass/Lender Toolkit)*
14. **[LATER] Pre-empt the GSE/investor alerts** — run our checks to catch defects **before** they'd trigger a
    CU/ACE flag downstream (the review-automation pitch), so the file is clean before it leaves us. *(§1.5)*

### D. Underwriting findings (our CTC match rules)

15. **[NOW] Automated comp-quality checks** — validate **comp distance (~1 mi), recency (~12 mo), and adjustment
    reasonableness**, and reconcile the **appraised vs sales-comparison vs cost** values (we already have all three
    figures). These are exactly the review-engine's checks. *(§1.5, review-automation)*
16. **[NOW] Value-reconciliation as an explicit finding** — surface As-Is ≤ ARV, appraised ≈ sales-comparison,
    contract-price present, effective-date-fresh as **named findings with pass/fail**, not just soft internal
    notes. *(CU / review-automation)*
17. **[NOW] Leverage transparency ("value → max loan")** — Kiavi/Roc-style: show **"ARV came in at X → LTARV cap
    → max loan Y"**, and min(LTV, LTPP, LTC, LTARV). Makes the underwriting math legible to officer/broker.
    *(Kiavi/Roc)*
18. **[LATER] Appraiser scorecard** — track per-appraiser risk-score average, revision-request rate + reason
    codes, AVM variance, and turn time; flag consistently high-risk appraisers and maintain an exclusion list
    (we already check "appraiser not excluded"). *(review-automation §1.5)*

### E. Conditions (our internal-condition engine)

19. **[NOW] Milestone-triggered auto-conditions & alerts** — Encompass fires tasks/alerts on the "appraisal
    received" milestone and when conditions clear. Wire our importer so a failed/partial import **auto-opens the
    right condition** (we already do this for `appraisal_as_is_verify`) and **notifies the officer**, and
    auto-satisfies on re-import. *(Encompass eFolder)*
20. **[NOW] Conditions link to multiple documents & to findings** — Encompass lets one condition attach multiple
    docs. Let our conditions reference the specific **finding + the appraisal doc/PDF page** that triggered them,
    so clearing is one click from the evidence. *(Encompass conditions)*
21. **[LATER] Appraisal document lifecycle states** — add an explicit **received → reviewed → approved (or
    revision-requested)** status on the appraisal doc, with a **revision-request** action (reason-coded) that
    parallels the AMC review loop, distinct from generic doc storage. *(Encompass / ValueLink / Reggora)*
22. **[LATER] Order-status timeline (if/when we order appraisals)** — Reggora/Floify/Kiavi-style **real-time
    order status** (ordered → assigned → inspected → in-review → delivered) with due dates, visible to
    officer/broker/borrower and driving conditions. *(Reggora Pipeline Views §, Floify)*

---

## Sources (primary)

- Fannie Mae — UCDP FAQs: <https://singlefamily.fanniemae.com/learning-center/applications/uniform-collateral-data-portal-learning-center/faqs-uniform-collateral-data-portal>
- Fannie Mae — UCDP Overview / SSR / Doc File ID: <https://singlefamily.fanniemae.com/media/6926/display>
- Freddie Mac — UCDP FAQ (hard stops, XML+PDF, proprietary findings): <https://sf.freddiemac.com/faqs/ucdp-faq>
- Fannie Mae — Collateral Underwriter: <https://singlefamily.fanniemae.com/applications-technology/collateral-underwriter>
- Fannie Mae — CU Risk Score & Risk Flags Overview: <https://singlefamily.fanniemae.com/job-aid/collateral-underwriter/topic/risk_flags_overview.htm>
- ICE — Using UCDP/EAD in Encompass: <https://help.icemortgagetechnology.com/DocumentationLibrary/360/UCDP.pdf>
- ICE — Encompass Appraisal Center: <https://help.icemortgagetechnology.com/appraisalcenter/1.0/Content/Welcome.html>
- ICE — Loan Conditions (Developer Connect): <https://developer.icemortgagetechnology.com/developer-connect/reference/loan-conditions>
- ICE — Using Encompass Docs Solution (eFolder): <https://help.icemortgagetechnology.com/DocumentationLibrary/360/UsingEncompassDocsSolution.pdf>
- Take Five Consulting — Appraisal Process within Encompass: <https://www.takefiveconsulting.org/appraisal-process-within-encompass/>
- Lender Toolkit — Reducing Underwriting Conditions in Encompass (data-vs-file mismatch → conditions): <https://lendertoolkit.com/how-lenders-reduce-underwriting-conditions-in-encompass/>
- Clear Capital — Automated service ordering & field mapping for Encompass (AVM/FSD/condition sync): <https://www.clearcapital.com/clear-capital-adds-automated-service-ordering-and-field-mapping-for-encompass-by-ice-mortgage-technology-users/>
- Clear Capital — AURA appraisal review on Encompass Partner Connect: <https://www.clearcapital.com/access-intelligent-appraisal-review-with-aura-on-the-encompass-partner-connect-api-platform-available-through-ice-mortgage-technology/>
- Clear Capital — GSE data collection (Value Acceptance + PD / ACE+ PDR): <https://www.clearcapital.com/solutions/gse-data-collection/>
- Clear Capital — AVMs vs appraisals / waterfall & confidence: <https://www.clearcapital.com/when-to-use-avms-and-appraisals-in-property-valuation/>
- Freddie Mac — ACE+ PDR: <https://sf.freddiemac.com/tools-learning/technology-tools/our-solutions/ace-pdr>
- McKissock — UAD 3.6 / redesigned URAR timeline & policy: <https://www.mckissock.com/blog/appraisal/the-future-is-now-fannie-mae-and-freddie-mac-announce-uad-3-6-implementation-timeline-and-policy-changes/>
- ValueLink — UAD 3.6 rollout & changes: <https://www.valuelinksoftware.com/everything-you-need-to-know-about-the-uad-3-6-rollout-and-changes/>
- Reggora — LOS integration / embed by iFrame or API: <https://www.reggora.com/press/reggora-announces-appraisal-order-management-software-fully-integrates-into-custom-loan-origination-systems>
- Reggora — Pipeline Views (rule/exception-based pipeline): <https://www.reggora.com/blog/reggora-pipeline-views-take-control-of-your-appraisal-pipeline>
- Reggora — Automated Appraisal Review: <https://www.reggora.com/lenders/appraisal-review>
- ValueLink — Review & Compliance / Encompass integration: <https://www.valuelinksoftware.com/review-and-compliance/> · <https://www.valuelinksoftware.com/encompass-integration/>
- Veros — VeroSCORE appraisal review: <https://www.veros.com/solutions/collateral-risk-management/veroscore>
- Confer Solutions — AI appraisal review (rules engine, comp checks, appraiser scorecard): <https://confersolutions.ai/blog/ai-appraisal-review-mortgage-lending>
- Mercury Network — Encompass ordering benefits: <https://mktrsc.mercuryvmp.com/downloads/encompassbenefits_generic.pdf>

*Note on coverage:* several private-lender/RTL platforms (Liquid Logics, Mortgage Automator, The Mortgage
Office, LoanPro, Bryt, LendingWise) and RTL fintech lenders (Baseline, Roc360, Kiavi, Lima One) publish little
public detail on their internal collateral screens; those notes reflect product positioning and general
knowledge and are flagged in-line where not directly citable. The strongest, best-documented ideas come from
the GSE plumbing (UCDP/CU/UAD 3.6), Encompass, and the appraisal-AMC/review layer (Reggora, Clear Capital,
ValueLink, Veros).
