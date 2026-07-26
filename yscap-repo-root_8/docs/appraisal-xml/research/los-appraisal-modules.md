# LOS / Mortgage-Platform Appraisal & Collateral Modules — Competitive Feature Research

Competitive/feature research for our appraisal-import + property-profile + underwriting-findings system.
Goal: study how the major LOS, POS, appraisal-AMC, and RTL/private-lender platforms handle the
**appraisal / collateral / property** module, and steal the good ideas.

**How to read this doc.** Part 1 = the industry plumbing every serious appraisal module is built on
(UCDP/EAD, CU/LCA scoring, UAD 3.6, the data-collection/waiver products). Part 2 = platform-by-platform
notes. Part 3 = the prioritized **"features to steal"** list mapped to our sections
(*appraisal import / property report / file error-handling / underwriting findings / conditions*),
each tagged **feasible-now** vs **later**.

Our current design (for mapping): a two-path XML importer (1004 vs 1025) that extracts subject/comps/
photos/ARV/As-Is with a `{value, source, confidence}` stamp per field, a property-profile report section,
a per-file error-handling/exception surface, underwriting match rules (CTC), and internal conditions
(e.g. `appraisal_as_is_verify`). See `../README.md`, `../error-handling-and-confidence.md`,
`../underwriting-findings-rules.md`.

> **Method note.** Direct WebFetch to most vendor/GSE domains was blocked by egress policy (HTTP 403), so
> most findings are drawn from search-indexed content of those exact pages plus secondary guides, with the
> source URL cited inline. Several private-lender/RTL platforms and consumer POS products publish little about
> their internal collateral screens; those notes are lighter and flagged in-line.

---

## PART 1 — The industry plumbing (what everyone integrates with)

Even a private lender that never sells to the GSEs benefits from copying these patterns — they are the
de-facto standard for "what an appraisal module looks like."

### 1.1 File formats — and the coming UAD 3.6 packaging change (importer-critical)

- **UAD 2.6 (today's world, what our 33 sample files are):** a **MISMO 2.6 GSE-extended XML** stream with the
  **full report PDF base64-encoded *inside* the XML** (`<EMBEDDED_FILE>`), plus per-photo `<IMAGE>` metadata
  when the vendor emits it. Because many downstream systems can't extract the embedded PDF, delivery tools
  routinely hand over the **XML and PDF as a separate pair** — this is the origin of the "two-slot" mental model.
  <https://singlefamily.fanniemae.com/media/16981/display> · <https://help.alamode.com/docs/8803>
- **UAD 3.6 (mandatory Nov 2, 2026):** packaging changes fundamentally from "XML-with-embedded-PDF" to a
  **ZIP containing three discrete components — (1) the PDF, (2) the XML data file, and (3) an images folder of
  separate JPEG photos.** **This directly affects us:** our current plan extracts photos *from inside the PDF*;
  under 3.6 the photos arrive as **discrete JPEGs** we can use directly. Design the importer to accept **both**
  the legacy embedded-PDF XML and the new ZIP + separate-images layout.
  <https://paragonrealtors.com/blog/posts/2025/11/18/technically-speaking-redesigned-appraisal-report/>
  <https://www.clearcapital.com/what-is-uad-3-6-how-the-new-appraisal-standard-will-impact-lenders/>
- **One dynamic report replaces all forms.** The redesigned URAR is a **single data-driven report** that turns
  sections on/off by property + assignment characteristics, replacing 1004, 1025, 1073, 2055, 1075,
  manufactured, co-op, etc. **The data describes the property; the form number no longer drives the report.**
  Emphasis shifts to **structured/discrete data points** (dropdowns/conditional fields) over free-text addenda —
  good for our extraction and QC. Dark Matter's early integration flags **six new property-detail data fields**.
  <https://singlefamily.fanniemae.com/delivering/uniform-mortgage-data-program/uniform-appraisal-dataset>
- **Timeline:** Limited Production **Sept 8, 2025** → Broad Production **Jan 26, 2026** (either 2.6 or 3.6) →
  **UAD 3.6 mandatory Nov 2, 2026** → **UAD 2.6 retired May 3, 2027** (afterward 2.6 only for resubmitting
  files already submitted as 2.6). We are in the dual-format window now.
  <https://www.mckissock.com/blog/appraisal/the-future-is-now-fannie-mae-and-freddie-mac-announce-uad-3-6-implementation-timeline-and-policy-changes/>
  <https://sf.freddiemac.com/docs/pdf/fact-sheet/uad-redesign-timeline.pdf>
- **Importer implication:** our two-path (1004 vs 1025) routing is correct for 2.6 but transitional. Keep the
  field-map abstraction and add a **third, data-driven path** keyed off **property attributes** (not
  `AppraisalFormType`), storing structured fields as first-class queryable data and handling separate JPEG assets.

### 1.2 UCDP / EAD — the submission portal, the SSR, hard stops, versioning

- **UCDP** (Fannie+Freddie joint) and **EAD** (FHA) are the portals lenders submit appraisals to. On submission
  each runs edit checks and returns a **Submission Summary Report (SSR)** per GSE: submission details, **status
  (Successful / Not Successful)**, findings, and a **Document File Identifier (Doc File ID)** — the unique
  appraisal id the lender must carry into loan delivery. SSR findings split into **UAD Compliance Findings,
  Basic Edit Checks, and Proprietary Edit Findings.**
  <https://sf.freddiemac.com/faqs/ucdp-faq> · <https://www.franklinamerican.com/public_extranet/public_extranet/ucdp_guide_for_embs_060614.pdf>
- **Hard stops vs override-able findings (the key two-tier model).** A submission is "Successful" only when it
  passes. Some conditions allow a **user-controlled manual override with a reason code** (flips Not Successful →
  Successful); **hard stops that cannot be overridden force a revised appraisal to be obtained and resubmitted.**
  UCDP surfaces these in a dedicated **Hard Stops panel**. This is the canonical model for our file-error section.
  <https://sf.freddiemac.com/faqs/ucdp-faq>
- **EAD (FHA) parallels this** with **must-fix hard stops** (block transmission) vs **override-able hard stops**.
  Concrete lesson for our parser: **FHA500** ("FHA Case Number missing or in an invalid format") can fire even
  when the number is visibly present but sits in the **wrong XML location** — validate that a value lands at the
  **correct XML path**, not merely that it exists (exactly our "multi-source field, right spot" concern).
  <https://www.hud.gov/sites/documents/sfh_ead_hardstopsfs.pdf>
- **Versioning semantics.** On resubmission UCDP **auto-detects the doc type (URAR / Update / Completion) and
  replaces the existing file by sequence** — overwrite-by-sequence, not an accumulating version stack. The
  **Doc File ID is itself a hard-stop key**: if a loan with an appraisal bearing the same Doc File ID was already
  delivered, UCDP hard-stops on the duplicate.
  <https://sf.freddiemac.com/docs/pdf/step-by-step-guides/ucdp-general-user-guide.pdf>
- **Encompass wraps UCDP/EAD** in-LOS: submit the XML, receive **status + findings**, **correct/modify**, and
  **request overrides**; successful uploads get a Doc File ID and one or more SSR files.
  <https://help.icemortgagetechnology.com/DocumentationLibrary/360/UCDP.pdf>

### 1.3 The GSE risk-score engines — Fannie CU and Freddie LCA

These are the appraisal-QC brains the whole industry benchmarks against; both feed messages into the LOS.

- **Fannie Collateral Underwriter (CU).** Free web app. **Risk score 1.0–5.0** (1 = lowest, 5 = highest);
  **999 = couldn't score** (insufficient comps). Scores **≤ 2.5** earn value rep-&-warrant relief under **Day 1
  Certainty**. **Four risk-flag families: Overvaluation, Undervaluation, Property Eligibility/Policy Compliance,
  Appraisal Quality**, each drilling into **messages** with **self-serve job aids**. CU pulls the **~20 closest
  sales (model comps M1–M20), ranked by physical characteristics, location, and sale date — sale price is NOT a
  ranking factor** — and shows where the appraiser's comps diverge. Reviewers can **validate or dismiss** flags.
  Guardrail: combine with **human due diligence**; don't instruct the appraiser off automated feedback alone.
  <https://singlefamily.fanniemae.com/applications-technology/collateral-underwriter>
  <https://singlefamily.fanniemae.com/job-aid/collateral-underwriter/topic/risk_flags_overview.htm>
  <https://www.mckissock.com/blog/appraisal/fannie-maes-collateral-underwriter-program/>
- **Freddie Loan Collateral Advisor (LCA).** Appraisals submitted via UCDP auto-flow to LCA, which returns a
  **risk score + proprietary, actionable feedback messages** and collateral rep-&-warrant relief eligibility;
  **score 99 = couldn't assess.** Freddie publishes the full proprietary-message list.
  <https://sf.freddiemac.com/tools-learning/technology-tools/our-solutions/loan-collateral-advisor>
  <https://sf.freddiemac.com/docs/pdf/fact-sheet/lca_feedback_messages.pdf>

### 1.4 Data-collection / waiver products (ACE+ PDR, Value Acceptance + PD, UPD, hybrid 1004H)

The GSEs increasingly accept **inspection-based, non-appraisal** collateral — relevant because a private lender
may value some deals with a lighter product than a full appraisal.

- **Freddie ACE+ PDR** = appraisal waiver **plus a Property Data Report** collected on-site by a **trained data
  collector** in a standardized format (property characteristics, **floor plans**, condition, interior+exterior
  photos) — no full appraisal. ~$200 vs ~$600 (~$400 cheaper), ~10–12 days faster (Q2 2025).
- **Fannie Value Acceptance + Property Data** is the equivalent. **UPD (Uniform Property Dataset)** is the
  joint-GSE **dataset for these inspection products** — a second standardized schema besides UAD.
- **Hybrid (1004H):** if the PDR isn't enough, an appraiser completes a **desktop/hybrid** appraisal off the
  collected data; ordering tools chain the 1004H to the data-collection order for the same subject.
  <https://sf.freddiemac.com/tools-learning/technology-tools/our-solutions/ace-pdr>
  <https://www.clearcapital.com/solutions/gse-data-collection/>

### 1.5 The appraisal-review / QC layer & AVM waterfalls

- **Automated review engines** (Reggora, Clear Capital ClearCollateral/AURA, Mercury RealView, ValueLink
  CrossCheck, Veros VeroSCORE) run a **configurable rules engine** (base GSE rules + lender-custom rules; e.g.
  ValueLink CrossCheck **1,000+ UCDP/EAD rules**, ClearQC **100 rules**) in **30–60s / ≤5 min** per appraisal,
  validating **completeness, consistency, compliance, comp selection, adjustment reasonableness, photos/sketch,
  condition**, cross-checking **multiple AVMs**, and scoring risk to **right-size human review**. Explicit goal:
  catch defects **before** they trigger CU/ACE alerts or become buybacks.
  <https://confersolutions.ai/blog/ai-appraisal-review-mortgage-lending> · <https://valuelinkconnect.com/features/>
- **AVM waterfall / cascade:** run several AVMs by **confidence score**; fall to the next provider if one fails a
  threshold. Confidence drops when comparable data is thin/inconsistent. Basis for corroborating our ARV/As-Is.
  <https://www.clearcapital.com/when-to-use-avms-and-appraisals-in-property-valuation/>
- **Pre-delivery QC** (Mercury **RealView Bridge**) runs rulesets **on the appraiser's desktop before delivery**
  to avoid revision cycles — connects to WinTOTAL/form software on >half of US appraiser desktops.
  <https://www.cotality.com/products/realview>
- **Value reconciliation as a first-class artifact** (Clear Capital): reconcile appraisal vs AVM vs prior values
  into a **single "final ruling"** with variance-based risk scoring.
  <https://www.clearcapital.com/products/collateral-desktop-analysis-cda/>
- **Appraiser scorecard:** track avg risk score by appraiser, revision-request rate + reason codes, GSE flag
  rates, AVM variance, turn time; flag consistently high-risk producers.
  <https://www.veros.com/solutions/collateral-risk-management/veroscore>

---

## PART 2 — Platform-by-platform

### ICE Mortgage Technology — Encompass (+ Partner Connect, Appraisal Center, Data Connect)

The reference implementation. Appraisal handling splits across the **Services tab** (order + track), the
**eFolder** (documents + conditions), the **UCDP/EAD interface** (GSE/FHA submission), and third-party review
overlays via **Encompass Partner Connect (EPC)**.

- **Ordering.** Loan → **Services tab → Appraisal → Order Appraisal**. Loan/property data pre-populates; user
  validates the **property section fields**, picks the appraisal **product type**, sets **Date Required**, adds
  instructions; appraiser notified by email.
  <https://www.takefiveconsulting.org/appraisal-process-within-encompass/>
- **Two-slot import with per-element checkboxes (steal this).** On return: **Services tab → Document icon →
  Appraisal Order Status window → Import link**. The user **checks boxes for the *data* and separately for the
  *files* they want to import** — structured XML fields vs the PDF report, chosen independently. Files attach to
  the **eFolder**; data auto-populates loan fields. This is the cleanest reconciliation gate seen anywhere.
  <https://appraisalfirewall.freshdesk.com/support/solutions/articles/69000652100-ordering-an-appraisal-from-encompass->
- **Auto-parse XML → fields.** Governed by an admin-configured **Encompass-UCD field mapping** (Encompass Field
  IDs ↔ provider/extension field names, bidirectional). Encompass exposes **~83 appraisal-related fields** in its
  dictionary. Clear Capital's integration syncs **ClearAVM value, Forecast Standard Deviation (FSD), and property
  condition** straight to the loan file (saves 4–10 min/order, removes manual-entry error).
  <https://docs.partnerconnect.elliemae.com/partnerconnect/docs/field-mapping>
  <https://www.clearcapital.com/clear-capital-adds-automated-service-ordering-and-field-mapping-for-encompass-by-ice-mortgage-technology-users/>
- **Collateral screen.** Imported XML populates the standard **URAR data model**: Subject (address, parcel,
  legal, tax/occupancy), Neighborhood (trend, supply/demand), Site (lot, zoning, flood, utilities), Improvements
  (year built, C-rating, GLA, rooms), Comparable Sales with adjustments, plus cost/sales-comparison/income
  approaches. An in-LOS **appraisal-review tool brings the appraisal data to the underwriter** so they don't open
  the PDF.
  <https://stewartvaluation.com/field-appraisals/uniform-residential-appraisal-report/>
- **Reconciliation / mismatch.** No native side-by-side "source vs file" diff — reconciliation is field-mapping +
  the import-checkbox selection + external QC. Automation guidance: "when Encompass data doesn't match the
  uploaded documents, **conditions are likely**," so lenders **automate field validation before underwriting.**
  Value reconciliation is delegated to overlays (ClearAVM variance, CA Risk Profiler).
  <https://lendertoolkit.com/how-lenders-reduce-underwriting-conditions-in-encompass/>
- **Exception surfaces.** (a) **Alerts & Messages** panel on the loan (compliance/fee tolerance, "records that
  require exceptions"). (b) **UCDP/EAD findings**: Successful vs Not Successful + **hard stops → manual override**
  in the UCDP interface — the closest thing to a per-file appraisal exceptions panel. (c) **eFolder Documents
  tab red asterisk** marks a doc that must be received before a milestone completes (visible "missing doc").
  (d) **Audit Trail**: per-field change history (date, user, new value).
  <https://help.icemortgagetechnology.com/DocumentationLibrary/360/UCDP.pdf>
  <https://help.icemortgagetechnology.com/DocumentationLibrary/360/UsingEncompassDocsSolution.pdf>
- **Document lifecycle.** **eFolder** = document + conditions hub: secure storage, Documents tab logs
  order+receipt of each doc, **version control**, role permissions, audit trail, and **Conditions tabs**
  (underwriting/prelim/post-closing) each linkable to **multiple documents** and to milestones. **Milestone events
  auto-trigger tasks/alerts** (notify processor on "appraisal received"); workflow automation fires alerts when
  all conditions clear. Lifecycle is expressed via **status + milestone + conditions**, not a literal
  received/reviewed/approved toggle.
  <https://developer.icemortgagetechnology.com/developer-connect/reference/loan-conditions>
- **Review overlays worth copying (Clear Capital on EPC):**
  - **AURA** — aggregates everything needed to analyze appraisal risk into a **summary report in ≤5 min** (50%+
    review-time cut). The **AURA Report Summary PDF** combines public records, local-market insights,
    ClearCollateral risk scores, ClearQC rules, and **ClearRank comparables**.
  - **ClearPhoto** — AI rules **auto-review photos and the sketch against the appraisal data** and flag mismatches.
  - **Condition Model** — AI infers property condition from photos and **compares to the appraiser's C-rating**.
  - **ClearQC** — 100 configurable rules with weights/thresholds, incl. a **risky-terms/bias language scan**.
  - **Aggregated GSE findings** — pulls **Fannie CU + Freddie LCA + FHA EAD** findings alongside its own rules,
    with **tiered exception routing** (severity → reviewer level).
  <https://www.clearcapital.com/products/clearcollateral-review/>
  <https://www.clearcapital.com/clear-capital-announces-automated-appraisal-photo-review-innovation-through-clearcollateral-review/>
- **Encompass Data Connect** — near-real-time access to **all Encompass fields** via a hosted **Snowflake**
  instance, auto-schema-sync, pre-built **Power BI / Tableau / Qlik** collateral dashboards. Model for making our
  extracted appraisal fields queryable, not trapped in one screen.
  <https://mortgagetech.ice.com/products/encompass-data-connect>

### Empower (Black Knight → ICE; now developed by Dark Matter)

- **Ingestion.** Service integrations for flood/appraisal/title run **"lights-out"** (order + return without
  manual touch) through the **Exchange** marketplace; data feeds the loan file without rekeying.
  <https://www.housingwire.com/articles/black-knights-empower-los-is-able-to-support-monthly-originations-ranging-from-100-to-more-than-10000/>
- **Collateral / reconciliation — the standout.** **CA Risk Profiler** scores valuation risk from (a) subject-vs-
  comp similarity, (b) **variance between appraised value and AVM**, and (c) UAD compliance. **CA Risk Profiler
  Plus** goes further: it **regenerates an independent comp set from Black Knight's national property database and
  diffs it against the appraiser's comps**, flagging discrepancies/patterns and **potential minority bias**.
  Independent comp regeneration + diff is genuinely differentiated.
  <https://www.blackknightinc.com/press-releases/black-knight-introduces-ca-risk-profiler-plus-to-help-lenders-and-appraisers-identify-potential-minority-bias-in-collateral-valuation/>
- **Property tooling.** Collateral Analytics brought a configurable **MLS + Collateral Market Analysis
  presentation** layer and a native AVM. (fraud/red-flag alerts historically via PitchPoint.)
  <https://mortgageorb.com/black-knight-scoops-up-collateral-analytics>

### Dark Matter Technologies (Empower's current owner)

- **Exchange Service Network** — API marketplace of **16,000+ providers**; order valuations **without leaving
  Empower or rekeying**. **Exchange Valuations** covers appraisal, AVM, and **property inspections** (to
  supplement AVMs / support GSE PDR/PDC), feeding data "directly into the loan file **and to the GSE portals**" —
  a **single order → loan file + UCDP dual-write** model.
  <https://dmatter.com/exchange-service-network>
- **Native UCDP integration (2025), UAD 3.6-ready.** Supports the **UAD 3.6 ZIP-file submission, six new
  property-detail fields, and streamlined PDF + XML extraction** — forward-looking schema work competitors must
  match by the Nov 2026 mandate.
  <https://dmatter.com/2025/press/dark-matter-technologies-achieves-ucdp-integration-driving-appraisal-innovation>

### Mortgage Cadence (Accenture)

- Open, single-system-of-record LOS. Appraisal/collateral runs through **Services Center 2.0** (integration hub
  on licensed FirstClose tech) covering **appraisal, AVM, condition reports, recertification, property details**,
  with lender-configured field mapping ("bring your own integration"), plus the **AppraisalWorks** partnership
  that lets lenders **pick the best-fit valuation product inside MCP**, with an interactive dashboard,
  appraiser scoring/assignment, quote management, and automated appraiser payment.
  <https://www.mortgagecadence.com/platform-integrations/services-center/>
  <https://www.appraisalworks.com/appraisal-management-technology-platform/>

### Modern POS / mid-market LOS — Blend, nCino/SimpleNexus, MeridianLink, BytePro, LendingPad, Floify

*(The dedicated cluster agent for these did not return usable findings; notes below reflect product positioning —
treat as lighter and verify in a demo.)*

- **Blend** — consumer POS over an LOS; strength is the borrower/LO **service marketplace** (incl. appraisal
  ordering) with status in the borrower/LO timeline and automated condition/document collection. Collateral data
  lands in the connected LOS. Best idea to borrow: **borrower-visible order-status timeline.**
- **nCino Mortgage / SimpleNexus** — mobile-first POS + disclosure/closing; appraisal shows as an **ordered
  service with borrower-visible status and in-app payment**, docs flow to the LOS eFolder; push notifications on
  status changes.
- **MeridianLink Mortgage / LendingQB** — browser LOS for banks/CUs; configurable appraisal-order integrations +
  document/conditions engine; decisioning-centric.
- **BytePro (Byte Software)** — bank LOS; appraisal via service-provider integrations + document/condition
  tracking (older architecture).
- **LendingPad (WEI)** — cloud LOS for brokers/small lenders; real-time collaboration, integrated appraisal
  ordering + conditions.
- **Floify** — POS/borrower portal; appraisal as a **milestone + document request** with automated borrower
  notifications; strong status-timeline UX; not itself a collateral-data system.

### The appraisal-AMC / review layer (Reggora, Mercury, ValueLink, AppraisalScope, Clear Capital)

What an LOS orders *through* — and the richest source of features for our findings/QC module.

- **Reggora.** Embeds in the LOS **by iFrame or custom UI via open REST API** — lets a lender manage **100% of
  orders inside their own system**; 24/7 real-time order status (due dates, milestones, comms). **Pipeline Views**
  = custom filters over any data point for **rule/exception-based** pipeline workflows. **AI Appraisal Review**
  imports **500+ property data points from 12 sources** (MLS photos, public records, LOS case/loan data) into a
  report summary; runs **completeness/consistency/compliance/valuation** checks with **customizable rulesets**;
  uses **NLP for red flags and bias detection** (fewer false positives than keyword tools); generates numeric
  **value, accuracy, and confidence scores** to right-size review. Ships an **industry-first repurchase warranty**
  — up to **~70% of appraisals** can pass automated review and be underwritten **without human review**. Clear
  Capital integration cuts review times **82%**.
  <https://www.reggora.com/lenders/appraisal-review> · <https://www.reggora.com/blog/reggora-pipeline-views-take-control-of-your-appraisal-pipeline>
  <https://www.prnewswire.com/news-releases/reggora-launches-ai-powered-appraisal-review-solution-for-lenders-301863420.html>
- **Mercury Network (a la mode / Cotality).** Ordering + vendor management with an **appraiser desktop-plugin**
  architecture → runs **RealView / RealView Bridge** QC rules **before the appraiser delivers**; **double-blind**
  appraiser-independence mode + audit trail; **DataCourier** delivers the XML+PDF. Produces the a la mode TOTAL
  XML we already parse.
  <https://help.mercuryvmp.com/lender/mercury/Mercury/RealView.htm> · <https://vendors.mercuryvmp.com/>
- **ValueLink.** Order/panel management across **hybrid, desktop, AVM, BPO, full appraisal**; panel **performance
  scoring** + rules-engine routing. **CrossCheck** runs **1,000+ UCDP/EAD compliance rules upfront**. Also a good
  plain-language UAD 3.6 / new-URAR field reference.
  <https://valuelinkconnect.com/features/> · <https://www.valuelinksoftware.com/everything-you-need-to-know-about-the-uad-3-6-rollout-and-changes/>
- **AppraisalScope (Cotality).** Order/delivery/UCDP-EAD submission-management platform (thinner public docs);
  treat as comparable ordering plumbing.
  <https://www.cotality.com/platforms/appraisal-scope>
- **Clear Capital** — the deepest collateral-data + automated-review reference:
  - **ClearCollateral Review + AURA** — dynamic, risk-based review driven by loan characteristics + automated
    **CU / LCA / EAD** findings + external data; ≤5-min AURA summary; ClearQC 100 rules; ClearPhoto; Condition
    Model; extended to **PDF-only volume** and **UAD 3.6**.
  - **CDA (Collateral Desktop Analysis)** — re-underwrites the **entire appraisal** ("validating its integrity,
    not just the value") and returns a **Low/Med/High Risk Score** from variance + data discrepancies +
    deficiencies.
  - **ClearAVM + Value Reconciliation** — lending-grade AVM; **Interactive ClearAVM** injects an inspector
    condition rating; Value Reconciliation merges multiple value opinions into a **single final ruling**.
  <https://www.clearcapital.com/products/aura/> · <https://www.clearcapital.com/products/collateral-desktop-analysis-cda/>
  <https://www.clearcapital.com/analytics/clear-avm/>

### RTL / private-lender loan platforms — Liquid Logics, Mortgage Automator, The Mortgage Office, LoanPro, Bryt, LendingWise

Closest to our world (fix-and-flip, DSCR, bridge, ground-up). These are largely value-**entry** / valuation-
**ordering** systems rather than XML-importers — a real appraisal-XML importer + property profile would leapfrog
them — but the two RTL-native ones (Liquid Logics, LendingWise) and the draw/servicing hybrids have strong
patterns worth stealing. *(Findings from search-indexed vendor pages, help centers, and reviews.)*

- **Liquid Logics (Nova)** — RTL-native cloud LOS + servicing with a built-in automated underwriting engine
  ("fully automated underwriting … built in"). **Most valuation-integrated of the six.** Orders valuations
  *inside* the LOS: the **Stewart Valuation Intelligence (SVI) integration** (Oct 2025) puts "traditional
  appraisals, AVMs, BPOs, evaluations, inspections, ValueFocus" in-platform for **instant automated valuations at
  scale**; also "appraisal doc origination and **vaulting** of documents." Standout RTL feature: **NWCC
  draw-inspection integration** (Aug 2025) — order/track draw inspections in Nova with **milestone tracking in the
  loan lifecycle**, **verified progress inspections before fund disbursement**, plus project cost reviews,
  contractor background checks, and insurance loss-draft inspections. Net: **valuation ordering + draw-inspection
  ordering both native** — the closest to an end-to-end ARV-and-draw collateral module.
  <https://www.liquidlogics.com/stuart-valuation-intelligence-integration/> · <https://www.liquidlogics.com/nwcc-draw-inspection-integration/>
- **Mortgage Automator** — end-to-end private-lending LOS **+ servicing** (4.9 on G2 & Capterra). **Request
  appraisals directly in the system**; an "industry-leading calculation engine" auto-propagates loan updates.
  Strong **draw module**: borrowers initiate/manage draws in the portal, **upload photos + video + docs as
  milestone evidence**, lender can **"review and approve draw requests in seconds,"** draws **tied to milestones**,
  disbursements over **ACH/NACHA**. (No documented MISMO/XML parsing; ordering + upload model. Reviews note thin
  public docs.)
  <https://www.mortgageautomator.com/all-features>
- **The Mortgage Office (Applied Business Software)** — mature origination + **servicing/fund-management** suite;
  origination "captures borrower, **collateral**, and loan information" with underwriting support + loan
  structuring/pricing, generic **LTV** (not RTL ARV-sizing). RTL-adjacent strength is **construction-draw support**
  + investor management in one system, extensible via open API.
  <https://www.themortgageoffice.com/products/loan-origination-software/>
- **LoanPro** — a loan-**servicing** platform + API, not an RTL LOS; **no native ARV/rehab/LTV logic**. Each loan
  holds up to **50 collateral items** across four types (Auto / Consumer / **Real Estate** / Other); valuation
  fields ("Appraised Value," "As-Is," "ARV," "Valuation Date," "LTV") would be **lender-defined custom fields**
  (Settings > Loan > Labeling > Collateral Fields) with leverage logic built via API/automations. A "build-your-
  own on custom fields" option.
  <https://developers.loanpro.io/docs/collateral-tracking-values> · <https://help.loanpro.io/en_US/overview/custom-fields-overview>
- **Bryt** — loan-**servicing** with more opinionated collateral tooling. **Asset & Insurance Tracking Module**
  records collateral per loan in an **Assets tab**; values are **updated over the loan life** as markets change.
  The standout: **lifecycle collateral revaluation + exception alerting** — continuous **LTV monitoring**, a
  **Custom Report Writer** for exception reports (high-LTV / outdated values), and **alerts when values drop,
  inspections lapse, LTV breaches, or documents go missing**. Documents tab stores appraisals/inspection
  photos/condition reports with **every upload time-stamped in an Audit Trail**. Construction module has
  **draw schedules + controlled funding** with LTC/LTV monitoring through draws.
  <https://www.brytsoftware.com/track-collateral-value-between-origination-and-payoff/> · <https://www.brytsoftware.com/construction/>
- **LendingWise** — customizable LOS/CRM/servicing for hard-money/private/CRE; along with Liquid Logics the most
  RTL-native, and best-documented via its help center. Dedicated **"Valuation"** and **"Inspection Servicing"**
  integration categories: **RicherValues** (ARV + reno-cost estimates, comps/images with human review) and
  **HouseCanary** (AVM; "**compare AVM to as-repaired value**," sales + rental comps). Computes **DTI, DSCR, LTV,
  LTC, and ARV** natively — As-Is/ARV/purchase/rehab are first-class inputs. Best-documented **Draw Management**:
  borrower submits a **line-item rehab budget ("Scope of Work"), typically pre-appraisal**; draws created **by $ or
  by % complete**, allowed **only after the SOW is accepted**, managed **against each budget line item**, with the
  **approved budget enforced as the ceiling** before release (note: approval ≠ disbursement without an integrated
  funds-control partner). Links **appraiser, agent, attorney** contacts to the property/loan.
  <https://www.lendingwise.com/los-software-private-lending-cre/> · <https://help.lendingwise.com/knowledge/draw> · <https://www.lendingwise.com/integration/>

### RTL fintech lenders (proprietary tech) — Kiavi, Roc360, Lima One, Baseline

Direct lenders / lender-software whose portals show how to present valuation to a **non-underwriter**.
*(Portals sit behind login; findings from public product pages + reviews.)*

- **Kiavi (formerly LendingHome)** — the model for "instant value → instant terms." **Does not order a
  traditional appraisal for fix-and-flip/bridge** — values collateral **internally** via a proprietary **ARV ML
  model + "Kiavi Property Risk (KPR)" model** (20+ factors), a **3rd-party inspector photo visit**, an in-house
  **feasibility team** validating the **Scope of Work (SOW)** rehab budget against photos, and an in-house
  valuation team on comps (~6 mo, ~1 mi). (DSCR/rental loans **do** require a borrower-paid third-party
  appraisal.) The public **ARV Estimator** is the collateral screen made self-serve: address + purchase price +
  rehab level → **estimated ARV, recent comps, and total cash-to-close** (down payment / origination / third-party
  costs). Leverage shown explicitly (**up to 95% LTC, 100% of rehab, up to 80% ARV**), and **customized estimated
  terms in minutes**. In-portal: track status, upload docs, **build the SOW**, lock rate.
  <https://www.kiavi.com/arv-estimator> · <https://www.kiavi.com/loans/fix-and-flip>
- **Roc360 / Roc Capital** — vertically integrated + **white-label/table-funding**, so the portal is often
  broker-facing. **Instant pricing engine → preliminary term sheet** (separate bridge vs rental "pricers");
  in-portal **Order Appraisal** flow (gather docs → upload → order → pick approved AMC → track → return report);
  in-house **Valuation Analyst** team assesses **both as-is and ARV** (comps 3–6 mo; add 10–15% to rehab budget);
  ARV-anchored leverage (~70% ARV). Exceptions handled largely via **Relationship Managers + decision-maker
  "chat rooms"** (human-in-the-loop) rather than an automated stip engine.
  <https://roc360.com/valuation-analyst/> · <https://roccapital.com/full-technology-suite/>
- **Lima One Capital** — **Client Portal + standalone public Pricing Engine** (instant quotes); **orders the
  valuation itself** — full third-party appraisal **or exterior/desktop valuation depending on program** (e.g.
  **Bridge Plus up to 85% LTV with an exterior valuation**). Fix-and-flip up to **75% LTARV**. Tight, visible
  **draw loop**: contractor inspection within 48h of a draw request, funds within 24h after.
  <https://www.limaone.com/client-portal/> · <https://pricing.limaonecapital.com/>
- **Baseline (baselinesoftware.com)** — **software private lenders run** (not a lender), so it defines the exact
  building blocks. The **term-sheet + "sizer"** *is* the collateral screen: configurable **sizers compute max loan
  from the property's cost/value and target LTV**, using the standard RTL logic — **min(As-Is LTV/LTC, After-Repair
  LTV)** governs — and auto-generate a branded term sheet in seconds. This is the clearest published **"your value
  came in at X, so your loan is Y"** mechanic among the four, configurable per lender. White-labeled borrower
  portal to apply, upload docs, **build budgets, and request draws with photos/notes**.
  <https://baselinesoftware.com/resources/product-spotlight-generate-professionally-designed-term-sheets-in-seconds>
  <https://www.baselinesoftware.com/product/product-draw-management>

---

## PART 3 — Prioritized "features to steal", mapped to our sections

Tags: **[NOW]** = feasible with our current data/architecture; **[LATER]** = needs new integrations, an
image/AVM pipeline, or UAD-3.6 work. Each item names the section it lands in.

### A. Appraisal import (our XML importer)

1. **[NOW] Two-slot import with per-element checkboxes** *(Encompass)* — separate the ingest into **"data fields"**
   and **"the PDF/files,"** each independently selectable, instead of all-or-nothing. This is the cleanest
   reconciliation gate in the market and maps perfectly to our XML + embedded-PDF pair.
2. **[NOW] Per-import "Submission Summary" receipt + stable import id** *(UCDP SSR / Doc File ID)* — every import
   yields one receipt object: what we ingested (form type, effective date, appraiser, value figures), the outcome
   (success/partial/failed), findings, and a **stable id** the rest of the file references.
3. **[NOW] Validate value *placement*, not just presence** *(EAD FHA500 lesson)* — a field in the wrong XML path is
   a failure even when a value "exists." We already do multi-source fallback; add an explicit "found at expected
   path vs fallback path" note per field, feeding a soft flag.
4. **[NOW] Field-level auto-populate with an overwrite shield** *(Encompass / Clear Capital)* — sync extracted
   fields into the loan file, but **never overwrite a human value with a lower-confidence import** (rule already
   in our spec); show which loan fields the import touched.
5. **[LATER] A third, data-driven import path for UAD 3.6 / redesigned URAR** *(§1.1)* — key the mapper off
   **property attributes**, not form number; store discrete fields as first-class queryable data. We're in the
   dual-format window now (Jan–Nov 2026); 2.6 retires May 2027.
6. **[LATER] Handle the UAD 3.6 ZIP + separate-JPEG photos** *(§1.1)* — under 3.6 photos arrive as **discrete
   JPEGs**, not embedded in the PDF. This *removes* our hardest problem (PDF image extraction) for new files —
   design the photo pipeline to prefer separate images when present and fall back to PDF extraction for 2.6.
7. **[LATER] Ingest the non-appraisal collateral products** *(UPD / PDR / hybrid 1004H)* — so a deal valued by a
   data-collection product still flows through the same pipeline.

### B. Property report (our property profile)

8. **[NOW] A single collateral-risk headline number** *(Fannie CU 1–5 / Freddie LCA / CDA Low-Med-High)* — one
   legible composite risk score at the top of the profile, drilling into the contributing findings. Include an
   explicit **"couldn't score / insufficient data"** state (CU's 999, LCA's 99).
9. **[NOW] A one-screen "Report Summary" view** *(Clear Capital AURA / Smart Views)* — subject facts, value
   summary (As-Is/ARV), comp table, photo manifest, and flags on one scannable panel that **directs attention**
   rather than dumping data. We already bring data to the reviewer; formalize the summary layout.
10. **[LATER] AVM cross-check with a variance meter + confidence** *(ClearAVM / CA Risk Profiler / AVM waterfall)*
    — corroborate our extracted ARV/As-Is against an independent AVM (with FSD/confidence); show variance as an
    always-on widget. Turns "we read $X" into "we read $X; an AVM says $Y (± FSD)."
11. **[LATER] AI photo/sketch vs stated-facts check** *(Clear Capital ClearPhoto)* — auto-flag when photos/sketch
    don't match the appraisal data (e.g. GLA, room count).
12. **[LATER] AI condition inference vs appraiser C-rating** *(Clear Capital Condition Model)* — estimate condition
    from photos and flag disagreement with the appraiser's C1–C6; feeds a finding.
13. **[LATER] Independent comp regeneration + diff** *(Black Knight CA Risk Profiler Plus / CU model comps M1–M20)*
    — generate our own ~20 nearest sales (ranked by physical/location/date, **not price**) and highlight where the
    appraiser's comps diverge; also the basis for bias/pattern detection.
14. **[LATER] Prior-sales / transfer history + market-trend panel** — surface subject prior sales and a small
    market-trend block (from the 1004MC data we already catalog, later enriched externally).

### C. File error-handling / exception surface (our per-file error section)

15. **[NOW] Two-tier hard-stop vs override-able findings, with reason codes + audit** *(UCDP/EAD)* — copy the
    canonical model exactly: **blocking hard stops** (some non-overridable → force re-import) separated from
    **override-able warnings** that clear with a **required reason code**, all logged. Our "ARV unreadable =
    CRITICAL/blocking" vs "As-Is ≤ ARV = soft flag" maps directly. Make blocking/non-blocking a first-class
    attribute of every issue.
16. **[NOW] Findings taxonomy with per-finding "what to do"** *(CU four-flag families + self-serve job aids)* —
    group issues into families (e.g. **value / data-missing / mismatch / eligibility / quality**) and attach a
    short **"how to resolve"** note to each.
17. **[NOW] A first-class source-vs-file diff panel — our differentiator.** **None of the four big LOS incumbents
    exposes a native side-by-side "appraisal vs loan file" mismatch screen** (Encompass leans on field-mapping +
    import checkboxes + external QC). A visible reconciliation panel (address, value, units, GLA: **source →
    file → match/mismatch**) that **proposes the condition** on mismatch would be genuinely differentiated.
18. **[NOW] "Missing required item" visible marker** *(eFolder red asterisk)* — a per-file marker that a
    required datum/doc is missing and gates the milestone, distinct from soft flags.
19. **[LATER] Aggregated external-findings panel** *(Clear Capital: CU + LCA + EAD + own rules, tiered routing)* —
    if/when we integrate GSE or AMC review, pull all findings into one exceptions list with **severity → reviewer
    routing**, run our own checks first to **pre-empt** downstream CU/ACE flags.

### D. Underwriting findings (our CTC match rules)

20. **[NOW] Configurable rules engine (not hardcoded checks)** *(everyone: CrossCheck 1,000+, ClearQC 100,
    Reggora custom rules)* — a rules engine with **weights/thresholds** and **base rules + lender-custom rules**,
    so our CTC checks are data-configured, not baked in.
21. **[NOW] Automated comp-quality checks as named findings** *(review engines / CU)* — comp **distance (~1 mi),
    recency (~12 mo), adjustment reasonableness**, and reconcile **appraised vs sales-comparison vs cost** values
    (we already extract all three) — surfaced as **pass/fail findings**, not just soft internal notes.
22. **[NOW] Value reconciliation as a first-class artifact** *(Clear Capital Value Reconciliation / CDA)* — merge
    appraisal value vs (later) AVM vs prior values into a **single "final ruling"** with variance-based risk.
23. **[NOW] Leverage transparency: "value → max loan, and which cap binds"** *(Baseline sizer / Kiavi / Roc /
    LendingWise tri-metric)* — compute **min(LTV, LTPP, LTC, LTARV)** and **name the binding constraint** ("capped
    by 80% ARV, not LTC"), with a **cap-breach flag** when an entered/updated value pushes a ratio past the program
    cap. LendingWise computes all three natively but **none of the RTL platforms clearly surfaces the
    binding-constraint + breach flag as first-class UI** — a gap we can own. The Baseline sizer is the cleanest
    published "value → loan" mechanic.
24. **[NOW] Confidence-scored auto-clear thresholds** *(Reggora value/accuracy/confidence scores; CU ≤2.5 / LCA
    relief)* — score every file so low-risk imports auto-clear and officers focus on high-risk ones.
25. **[LATER] "Risky terms" / bias language scan of the narrative** *(ClearQC / Reggora NLP)* — increasingly
    table-stakes for compliance; we already sweep narrative attributes for As-Is, so a terms scan is incremental.
26. **[LATER] Appraiser scorecard + exclusion list** *(Veros / ValueLink / review engines)* — per-appraiser risk
    average, revision-request rate + reason codes, AVM variance, turn time; we already check "appraiser not
    excluded" — extend to a maintained scorecard.

### E. Conditions (our internal-condition engine)

27. **[NOW] Milestone-triggered auto-conditions & alerts** *(Encompass eFolder)* — a failed/partial import
    **auto-opens the right condition** (we already do this for `appraisal_as_is_verify`), **notifies the officer**,
    and **auto-satisfies on re-import**. Extend to ARV-unreadable and mismatch conditions.
28. **[NOW] Conditions link to the specific finding + doc page** *(Encompass: one condition ↔ many docs)* — let a
    condition reference the exact **finding + appraisal PDF page** that triggered it, so clearing is one click from
    the evidence.
29. **[LATER] Explicit appraisal-doc lifecycle: received → reviewed → approved / revision-requested** *(AMC review
    loop; UCDP overwrite-by-sequence)* — add a status on the appraisal doc with a **reason-coded revision-request**
    action, and adopt **overwrite-by-sequence** versioning (revised report replaces prior, keeping the receipt).
30. **[LATER] Order-status timeline (if/when we order appraisals)** *(Reggora Pipeline Views / Roc / Lima One /
    Floify)* — real-time status (ordered → assigned → inspected → in-review → delivered) with due dates, visible to
    officer/broker/borrower, driving conditions; Lima One's **48h-inspect / 24h-fund draw SLA** is a good model for
    the servicing/rehab side.

### F. RTL-specific — valuation ↔ rehab-budget ↔ draws (our world)

*(These come from the RTL-native platforms and are the differentiators for a private lender specifically.)*

31. **[NOW] Ingest the appraisal as *data*, not just a document** *(Liquid Logics SVI / LendingWise)* — the RTL
    platforms mostly attach a PDF; our importer already pulls ARV, As-Is, condition, comps as structured fields.
    This is our core advantage — lean into it (structured value + comps flowing into sizing, not a flat file).
32. **[NOW] Line-item rehab budget ("Scope of Work") as the ceiling on draws** *(LendingWise / Kiavi SOW / Baseline
    /Mortgage Automator)* — a structured line-item budget, ideally captured pre-appraisal, that the appraisal's ARV
    is validated against and that caps cumulative draws. Connects the property module to servicing.
33. **[NOW] Feasibility check: borrower-claimed ARV vs independent AVM/appraisal, with variance flag** *(LendingWise
    RicherValues/HouseCanary; Kiavi feasibility team)* — reconcile the claimed/expected ARV against the appraisal
    (and later an AVM) and **flag when the gap exceeds a threshold** ("ARV variance > X%"), or when **rehab budget
    exceeds the ARV-implied max**. Best-in-class for a private lender; extends our existing sanity cross-checks.
34. **[NOW] Contact graph on the collateral record** *(LendingWise)* — link appraiser / agent / attorney to the
    property, cheap and useful for reorder + audit trails (we already capture appraiser/license).
35. **[LATER] Lifecycle collateral revaluation + stale-value / LTV-breach alerts** *(Bryt)* — treat value as a
    tracked figure, not a one-time input; fire exceptions for **stale valuation age, LTV breach, lapsed inspection,
    missing document**. A "valuation age" flag is cheap, high-signal, and feeds our error surface + conditions.
36. **[LATER] Native draw-inspection ordering that gates disbursement on verified milestones** *(Liquid Logics/NWCC
    ; Mortgage Automator photo/video evidence)* — order inspections in-file, track as milestones, and block a draw
    that exceeds inspected completion; combine with the line-item budget from #32.

### G. Cross-cutting / novel

37. **[LATER] Self-serve public ARV/value + terms tool as top-of-funnel** *(Kiavi ARV Estimator, Lima One Pricing
    Engine)* — a no-login value + leverage + cash-to-close calculator that doubles as lead capture and pre-fills
    the real application.
38. **[LATER] Name and expose our valuation logic as a feature** *(Kiavi ARV/KPR models)* — presenting the
    ARV/As-Is derivation with a confidence/factor rationale (rather than a black-box number) builds officer trust
    and dovetails with our `{value, source, confidence}` stamping.
39. **[LATER] Queryable appraisal data warehouse** *(Encompass Data Connect / Snowflake)* — expose extracted
    appraisal fields for BI/portfolio analytics, not trapped in one screen.
40. **[LATER] Valuation-document audit trail + supersede-not-delete versioning** *(Bryt audit trail; UCDP
    overwrite-by-sequence)* — time-stamp every valuation upload and, when a revised appraisal/BPO arrives, retain
    the prior but clearly deprecate it.

---

## Sources (primary)

**GSE plumbing / standards**
- Fannie — UCDP FAQs: <https://singlefamily.fanniemae.com/learning-center/applications/uniform-collateral-data-portal-learning-center/faqs-uniform-collateral-data-portal>
- Freddie — UCDP FAQ (hard stops, XML+PDF, findings): <https://sf.freddiemac.com/faqs/ucdp-faq>
- UCDP General User Guide (versioning / overwrite-by-sequence): <https://sf.freddiemac.com/docs/pdf/step-by-step-guides/ucdp-general-user-guide.pdf>
- UCDP guide for EMBs (SSR / override reason codes): <https://www.franklinamerican.com/public_extranet/public_extranet/ucdp_guide_for_embs_060614.pdf>
- HUD — EAD hard-stops fact sheet (must-fix vs override-able, FHA500): <https://www.hud.gov/sites/documents/sfh_ead_hardstopsfs.pdf>
- Fannie — Collateral Underwriter: <https://singlefamily.fanniemae.com/applications-technology/collateral-underwriter> · Risk flags: <https://singlefamily.fanniemae.com/job-aid/collateral-underwriter/topic/risk_flags_overview.htm> · CU FAQ (999, model comps): <https://www.mckissock.com/blog/appraisal/fannie-maes-collateral-underwriter-program/>
- Freddie — Loan Collateral Advisor: <https://sf.freddiemac.com/tools-learning/technology-tools/our-solutions/loan-collateral-advisor> · proprietary messages: <https://sf.freddiemac.com/docs/pdf/fact-sheet/lca_feedback_messages.pdf>
- UAD 3.6 timeline (McKissock): <https://www.mckissock.com/blog/appraisal/the-future-is-now-fannie-mae-and-freddie-mac-announce-uad-3-6-implementation-timeline-and-policy-changes/> · Freddie timeline PDF: <https://sf.freddiemac.com/docs/pdf/fact-sheet/uad-redesign-timeline.pdf>
- UAD 3.6 ZIP packaging / new URAR: <https://paragonrealtors.com/blog/posts/2025/11/18/technically-speaking-redesigned-appraisal-report/> · <https://www.clearcapital.com/what-is-uad-3-6-how-the-new-appraisal-standard-will-impact-lenders/>
- Fannie UAD overview (2.6 embedded-PDF format): <https://singlefamily.fanniemae.com/media/16981/display> · a la mode embedded-PDF KB: <https://help.alamode.com/docs/8803>
- Freddie ACE+ PDR / UPD: <https://sf.freddiemac.com/tools-learning/technology-tools/our-solutions/ace-pdr> · Clear Capital GSE data collection: <https://www.clearcapital.com/solutions/gse-data-collection/>

**Encompass / Empower / Dark Matter / Mortgage Cadence**
- ICE UCDP/EAD in Encompass: <https://help.icemortgagetechnology.com/DocumentationLibrary/360/UCDP.pdf>
- Ordering an Appraisal from Encompass (two-slot import checkboxes): <https://appraisalfirewall.freshdesk.com/support/solutions/articles/69000652100-ordering-an-appraisal-from-encompass->
- Appraisal Process within Encompass: <https://www.takefiveconsulting.org/appraisal-process-within-encompass/>
- Encompass eFolder / Docs solution: <https://help.icemortgagetechnology.com/DocumentationLibrary/360/UsingEncompassDocsSolution.pdf>
- Encompass Loan Conditions (Developer Connect): <https://developer.icemortgagetechnology.com/developer-connect/reference/loan-conditions>
- Reducing Underwriting Conditions in Encompass (data-vs-file → conditions): <https://lendertoolkit.com/how-lenders-reduce-underwriting-conditions-in-encompass/>
- Encompass Data Connect (Snowflake): <https://mortgagetech.ice.com/products/encompass-data-connect>
- Black Knight CA Risk Profiler Plus (comp regeneration + bias): <https://www.blackknightinc.com/press-releases/black-knight-introduces-ca-risk-profiler-plus-to-help-lenders-and-appraisers-identify-potential-minority-bias-in-collateral-valuation/>
- Dark Matter Exchange Service Network: <https://dmatter.com/exchange-service-network> · UCDP integration (UAD 3.6 ZIP + 6 fields): <https://dmatter.com/2025/press/dark-matter-technologies-achieves-ucdp-integration-driving-appraisal-innovation>
- Mortgage Cadence Services Center: <https://www.mortgagecadence.com/platform-integrations/services-center/> · AppraisalWorks: <https://www.appraisalworks.com/appraisal-management-technology-platform/>

**AMC / review layer**
- Reggora Appraisal Review (500+ pts/12 sources, scores, warranty): <https://www.reggora.com/lenders/appraisal-review> · Pipeline Views: <https://www.reggora.com/blog/reggora-pipeline-views-take-control-of-your-appraisal-pipeline>
- Mercury RealView / RealView Bridge (pre-delivery QC): <https://help.mercuryvmp.com/lender/mercury/Mercury/RealView.htm> · <https://www.cotality.com/products/realview>
- ValueLink CrossCheck (1,000+ rules): <https://valuelinkconnect.com/features/>
- Clear Capital — ClearCollateral Review / ClearPhoto / Condition Model: <https://www.clearcapital.com/products/clearcollateral-review/> · AURA: <https://www.clearcapital.com/products/aura/> · CDA + Value Reconciliation: <https://www.clearcapital.com/products/collateral-desktop-analysis-cda/> · ClearAVM: <https://www.clearcapital.com/analytics/clear-avm/>
- Veros VeroSCORE (appraiser scorecard): <https://www.veros.com/solutions/collateral-risk-management/veroscore>
- AI appraisal review overview: <https://confersolutions.ai/blog/ai-appraisal-review-mortgage-lending>

**RTL fintech lenders / software**
- Kiavi ARV Estimator: <https://www.kiavi.com/arv-estimator> · Fix-and-flip: <https://www.kiavi.com/loans/fix-and-flip>
- Roc Capital Full Technology Suite: <https://roccapital.com/full-technology-suite/> · Valuation Analyst: <https://roc360.com/valuation-analyst/>
- Lima One Client Portal: <https://www.limaone.com/client-portal/> · Pricing Engine: <https://pricing.limaonecapital.com/>
- Baseline term-sheet/sizer: <https://baselinesoftware.com/resources/product-spotlight-generate-professionally-designed-term-sheets-in-seconds> · Draw management: <https://www.baselinesoftware.com/product/product-draw-management>

**RTL loan-servicing sources**
- Liquid Logics SVI integration: <https://www.liquidlogics.com/stuart-valuation-intelligence-integration/> · NWCC draw inspections: <https://www.liquidlogics.com/nwcc-draw-inspection-integration/>
- Mortgage Automator features: <https://www.mortgageautomator.com/all-features>
- The Mortgage Office origination: <https://www.themortgageoffice.com/products/loan-origination-software/>
- LoanPro collateral tracking: <https://developers.loanpro.io/docs/collateral-tracking-values> · custom fields: <https://help.loanpro.io/en_US/overview/custom-fields-overview>
- Bryt collateral tracking + exceptions: <https://www.brytsoftware.com/track-collateral-value-between-origination-and-payoff/> · construction: <https://www.brytsoftware.com/construction/>
- LendingWise LOS: <https://www.lendingwise.com/los-software-private-lending-cre/> · draw management: <https://help.lendingwise.com/knowledge/draw> · integrations: <https://www.lendingwise.com/integration/> · RicherValues: <https://richervalues.com/> · HouseCanary: <https://www.housecanary.com/industries/private-money-lenders>

*Coverage notes:* (1) The modern-POS cluster (Blend, nCino/SimpleNexus, MeridianLink, BytePro, LendingPad,
Floify) is covered from product positioning only — verify in demos. (2) RTL loan-servicing platforms are now
well-documented (Liquid Logics and LendingWise are RTL-native with rich valuation/draw workflows; LoanPro/Bryt
are servicing engines where collateral is generic/custom-field). (3) Best-documented, highest-confidence ideas
come from the GSE plumbing (UCDP/EAD/CU/LCA/UAD 3.6), Encompass, the AMC/review layer (Reggora, Clear Capital,
Black Knight/Empower, ValueLink, Mercury), and the RTL-native draw/valuation platforms (Liquid Logics,
LendingWise).
