# Automated Appraisal-Review & Collateral-Risk Platforms — What the Industry Checks

**Purpose.** Map what commercial appraisal-review / collateral-risk engines (Fannie **CU**, Freddie
**LCA/ACE**, Reggora, Clear Capital **ClearCollateral/AURA**, LoanLogics, Restb.ai, etc.) actually
test on an appraisal, so our appraisal-vs-file match engine (findings **F1–F23**,
`../underwriting-findings-rules.md`) raises the same discrepancies a real collateral desk would.
This is research + a prioritized gap list, **not** a build spec.

**Compiled 2026-07-19.** Companion docs in `../`: `underwriting-findings-rules.md` (our F1–F23 rules),
`field-validation-rules.md` (per-field accept/reject + tripwires), `industry-research.md`,
`field-reliability.md`. All thresholds below are owner-tunable config, never hard constants.

> **Sourcing note.** Fannie/Freddie primary PDFs and the Fannie Selling Guide return HTTP 403 to
> automated fetches; the specifics below are drawn from the GSE landing/job-aid pages, vendor product
> pages, and appraisal-industry write-ups (all cited in §8). Where a number is an *industry
> convention* rather than a hard GSE cap, it is labelled as such — the GSEs deliberately avoid hard
> adjustment caps (see §2.1).

---

## 1. The platforms, in one line each

| Platform | What it is | Output that matters to us |
|---|---|---|
| **Fannie Mae Collateral Underwriter (CU)** | GSE appraisal-risk engine; every UAD appraisal delivered to UCDP is scored. Free to lenders. | **Risk score 1.0–5.0** (composite) + **risk flags** (overvaluation, undervaluation, appraisal quality, property eligibility/policy) + **reason-code messages**. Ranks the appraiser's comps against **up to 20 model-selected comps**. |
| **Freddie Loan Collateral Advisor (LCA)** | Freddie's parallel engine; appraisals to UCDP flow to LCA automatically. | **Single risk score** + **proprietary feedback messages** grouped into lender-friendly categories on a "Findings" tab. Score `99` = couldn't score (HVE unavailable / incomplete report). |
| **Freddie ACE** (Automated Collateral Evaluation) | Appraisal **waiver** — model + public records value a property with *no* appraisal. | Not a review engine; the "no appraisal needed" path. Relevant only as context (our world is deals that *do* need a full report). |
| **Reggora Appraisal Review** | AMC + AI review layer for lenders. NLP-reads the report. | Automates **completeness, consistency, compliance, valuation analysis**; customizable rule sets + QC checklists; routes to underwriters **by CU score band**. |
| **Clear Capital ClearCollateral Review / AURA** | Automated review platform. | **ClearQC** runs **~100 rules** per appraisal (completeness, consistency, photo/sketch errors, condition); **ClearAVM** value check; **PhotoAI** condition/quality; fully **configurable weights + thresholds**; now also reviews **PDF-only** appraisals. |
| **LoanLogics / SharperLending / Jaro (Global DMS) / ValueLink / Appraisal Scope / Mercury Network / ANOW** | AMC + order-management + QC-rules platforms. | Same family of checks: rules-based UAD/compliance edits, CU/LCA integration, review checklists, audit trails. Jaro/ValueLink are pushing UAD 3.6 validation. |
| **Restb.ai / SpencerAI** | Computer-vision **photo AI**. | **C1–C6 condition** + **Q1–Q6 quality** scores from photos (per Fannie methodology), **sub-scores** (kitchen/bath/interior/exterior), **hazard/safety** detection, photo-completeness confidence. A "later" enhancement for us. |

---

## 2. The concrete checks these engines run (with thresholds)

### 2.1 Comp selection & adjustments — the heart of it
- **Net / gross adjustment magnitude (per comp).** Long-standing **industry convention** (Fannie
  *historically* flagged these; they are **not hard caps** today): a comp is flagged when **net
  adjustments > 15%** of its sale price or **gross adjustments > 25%**, and any **single line-item
  adjustment > 10%** of sale price. Fannie now says the number/amount of adjustments "must not be the
  sole determinant" of a comp's acceptability — but every review engine still *flags* these bands for
  human eyes. (Fannie B4-1.3-09; ClearCollateral rules.)
- **Bracketing.** Comps must **bracket the subject on both sides** for the key characteristics — GLA,
  condition (C-rating), quality (Q-rating), and **adjusted sale price** — and the reconciled value
  **must fall within the range of the adjusted comp values**. A value above the highest adjusted comp
  (or below the lowest) is a red flag.
- **Comp GLA vs subject.** Comps ideally **within ~20% of the subject's GLA**; beyond that needs
  commentary.
- **Distance & recency.** Most-recent closed sales, typically **≤ 12 months**; comp **distance**
  reasonable for the market (urban/suburban commonly **≤ 1 mile**). Older/farther comps demand
  appraiser commentary and a **market-conditions (time) adjustment**.
- **Time / market-conditions adjustment.** Expected when comps are older or the market is moving; must
  be data-supported and applied consistently. Absence on an old comp in a moving market = flag.
- **Model comp comparison (CU/LCA).** CU ranks the appraiser's comps against **up to ~20**
  model-selected sales; if the appraiser missed clearly superior/closer comps, the comp-selection flag
  fires. (Needs an external comps database — an AVM/model-comps feed — we don't have.)

### 2.2 Value integrity / over- & under-valuation
- **Appraised vs AVM/model value.** CU's overvaluation flag and ClearAVM both compare the appraised
  value to an independent model value; a large positive gap = overvaluation risk. **Undervaluation** is
  also modeled (CU flags both directions).
- **Cross-approach reconciliation.** Appraised value should tie to the **sales-comparison** indicated
  value; **cost** and **income** approaches should be consistent. A material divergence between
  approaches (industry rule of thumb **> 10–15%**) is a reconciliation flag.
- **Reason-code messages.** When CU issues an over/undervaluation flag it attaches **one reason-code
  message** representing the strongest statistical driver.

### 2.3 CU risk score mechanics (§3 expands)
- **1.0 – 5.0**, 1 = lowest risk, 5 = highest; **999 / 99** = un-scorable (thin market / missing data).
- Composite of three flag families: **overvaluation**, **appraisal quality** (data integrity, comp
  selection, adjustments, reconciliation), **property eligibility & policy compliance** — plus a
  separately-modeled **undervaluation** flag.

### 2.4 Data integrity / UAD compliance edits (§4 expands)
- Required-field presence, valid enums (C/Q codes, occupancy, view/location ratings), internal
  consistency (e.g. GLA vs room count, condition vs adjustments), and format conformance. UCDP returns
  **hard edits (fatal)** and **soft edits (warning)**.

### 2.5 Property condition / quality
- **C1–C6 / Q1–Q6** consistency: subject rating vs comp ratings vs adjustment logic; sudden
  disagreement is a flag. Photo AI (Restb.ai) derives these straight from images and flags where the
  appraiser's stated condition/quality disagrees with the photos (Restb.ai's white paper pegs
  condition/quality-adjustment error at **$27B** of risk).

### 2.6 Photo / exhibit completeness
- Required exhibits present: subject front/rear/street, kitchen, all baths, main living, any deficiency
  photos, plus a comp photo per comparable, location map, sketch/floor plan. Missing/blurry/duplicate
  photos, or photos whose address/features don't match the subject, are flagged.

### 2.7 Subject-to / repairs handling
- "Subject-to-repairs/completion" reports require the repair scope, and a **1004D Certificate of
  Completion** before the value is relied on. Engines flag a subject-to report with no scope, or a
  final draw with no 1004D.

### 2.8 Appraiser risk / eligibility
- **License** active and valid in the subject state; not on the lender's **exclusionary/ineligible
  list** (needs an external list/ASC lookup); appraiser's own history/risk profile (CU tracks
  appraiser patterns). Independence: appraisal must not be **ordered by a party to the transaction**.

---

## 3. CU risk score — bands and lender action

| CU score | Typical lender treatment |
|---|---|
| **1.0 – 2.5** | Low risk. **2.5 is the "Day 1 Certainty" line** — at/under 2.5 with no hard flags a lender can get rep-and-warrant relief on value; minimal manual review. |
| **2.6 – 3.9** | Elevated. Manual appraisal review; underwriter reads the flags/messages, may request comps/clarification. |
| **4.0 – 5.0** | High risk. **Heightened review** — desk review, field review, or a **second appraisal / BPO**; senior sign-off before proceeding. |
| **999 / 99** | Un-scorable (thin market / missing data). Treat as "no automated safety net" → full manual review, not as a pass. |

CU/LCA are decision-**support**: they never auto-approve or auto-deny. Reggora and ClearCollateral let
lenders **route work by the score band** (e.g. auto-clear < 2.5, queue 2.5–4 to a reviewer, escalate
≥ 4). This is exactly the shape of our **F18** (warn ≥ 2.5, fatal ≥ 4.0).

---

## 4. UAD / GSE edits — the validation layer we can mirror

- **UAD** defines every required field per form and standardizes enums for a key subset (condition,
  quality, view, location, occupancy, etc.). UCDP validates on delivery and returns **hard edits**
  (fatal — block delivery) and **soft edits** (warnings).
- **What trips an edit:** a required field missing/blank; a value outside its allowed enum; a format
  violation (dates, money); or an **internal inconsistency** (the XML disagreeing with itself, or with
  the embedded PDF). A known gotcha: the **XML can be wrong even when the PDF looks right** (old forms
  software, XML-generation bugs) — so validating the XML on its own terms matters.
- **UAD 3.6 / new URAR (rolling out):** a single dynamic URAR replaces the 1004/1025/1073/etc. family,
  with far more structured fields and a GSE **compliance/validation API** that checks a report against
  UAD rules (required fields present, valid data types, format) **before** UCDP. Our field-validation
  ruleset (`../field-validation-rules.md` tripwires) is already this idea; we should frame those
  tripwires explicitly as "UAD-style edits" and keep an eye on 3.6 (our current corpus is 2.6).

We already implement a strong slice of this (tripwires 1–14 in `../field-validation-rules.md`:
always-present-field-blank, bad form_type, unit/form mismatch, 0 comps, seq-gap, state/zip decoys,
appraised≠sales-comp, date sanity, year_built range, As-Is decoy, non-UAD C/Q, comma-in-money,
ARV-on-pure-as-is, anchor drift). The gap is turning a few of these into **surfaced findings**, not
just internal regression catches.

---

## 5. Photo AI / condition AI (Restb.ai, SpencerAI) — the "later" layer

- **Inputs:** the appraisal's photo exhibits (and, in ClearCollateral, PDF-only volume).
- **Outputs:** overall **C1–C6** condition and **Q1–Q6** quality (Fannie methodology), **sub-scores**
  for kitchen / bath / interior / exterior, a **confidence** score (low when too few / poor photos),
  **hazard & safety** detection, and **photo-completeness** checks. 2,500+ visual insights/property.
- **How review engines use it:** compare AI condition/quality to the **appraiser's stated C/Q**; a
  disagreement (e.g. appraiser says C3, photos read C5) drives a condition-consistency flag and
  questions the condition/quality adjustments. Restb.ai reports AVM error drops ~18% with AI C/Q.
- **For us:** a genuine "later" enhancement — needs an image pipeline + a vendor/model. Our XML-only
  engine can't see photos, but it *can* today check **photo/exhibit presence/count** from the XML
  exhibit list (see F27 below) and flag **non-UAD / worded condition** (already F14b).

---

## 6. Flip / value-integrity (fix-and-flip relevance)

Our lending is fix-and-flip, so rapid-resale / inflated-ARV patterns matter more than for a GSE.

- **FHA flip rule (the canonical time bands):** resale **within 90 days** of the seller's acquisition
  → **ineligible**. **91–180 days** → if the **resale price ≥ 100% over** (some overlays: **> 20%
  over**) the seller's acquisition price, a **second appraisal** is required. After 180 days → extra
  appraisal at discretion. These aren't our program rules, but they are the **industry's numeric
  tripwires** for "this resale is moving suspiciously fast/high."
- **Rapid-resale red flag:** property changing hands **multiple times within ~6 months** with rising
  prices and **no documented renovation** = staged value.
- **Appraisal red flags for flips / inflated value:** appraisal **ordered by a party to the
  transaction**; purchase price **substantially above (or below) market**; **photos/address mismatch**;
  **map-scale distortion** hiding true comp distance; **comps pulled from a superior area / different
  school district**; renovation claimed in the report that the photos don't support.
- **Where the data lives:** the URAR itself carries a **prior sale/transfer history** — subject
  transfers within **3 years** and comp transfers within **1 year** (a UAD section). So a *partial*
  flip check is feasible from the XML (subject's prior sale date/price vs the current contract);
  a *full* flip score (chain of title, straw-buyer links, ARV vs public AVM) needs **external public
  records / AVM** and is a later layer.

---

## 7. Prioritized "checks to add to our PILOT findings" (mapped to F1–F23)

Legend: **NEW** = new finding; **STRENGTHEN** = extend an existing one. "From-XML now" means we
already extract (or can) the inputs from the MISMO 2.6 XML per `../field-validation-rules.md`.

### 7A. Feasible NOW from the appraisal XML (no external data, no AI)

| Prio | Add/strengthen | What it checks | Industry threshold (owner-tunable) | Maps to |
|---|---|---|---|---|
| **1** | **NEW F24 — Comp adjustment magnitude** | Per comp: net adj % > cap, gross adj % > cap, or any single line-item adj > cap. We already read `SalePriceTotalAdjustmentNetPercent` / `SalesPriceTotalAdjustmentGrossPercent` per comp. | **net > 15%**, **gross > 25%**, **single line > 10%** of comp sale price (convention; flag-not-fail). Warning. | new; near F15/F16 |
| **2** | **NEW F25 — Bracketing / value outside comp range** | Reconciled/appraised value **above the highest** or **below the lowest** adjusted comp price; comps don't bracket subject on GLA & C/Q. Inputs: comp adjusted prices, GLAs, C/Q (all read today). | Value must be **within** the adjusted-comp range; GLA bracket **±20%**; C/Q bracketed both sides. Warning (fatal if value materially outside range). | new; supports F18 |
| **3** | **STRENGTHEN F15 — Comp GLA & bracket** | Add **comp GLA within ~20% of subject** and **time-adjustment present when comp > N months** to the existing distance/recency check. | GLA **±20%**; time adj expected on comps **> 6–12 mo** or moving market. Warning. | F15 |
| **4** | **NEW F26 — Subject prior-sale / flip signal (XML-only slice)** | Subject's **prior sale within 3 years** (URAR history) vs current contract price → % increase & days-held; flag rapid resale + steep markup. | Mirror FHA bands: **< 90 days** or **> ~20% markup with < 180 days & no scope** → warning/escalate. | new; fix-and-flip |
| **5** | **NEW F27 — Photo / exhibit completeness (from XML)** | Required exhibits present in the XML: subject front/rear/street, comp photo per comp, location map, sketch. Count/flag missing. | All required exhibits present; **1 photo per comp**; map + sketch present. Warning. | new; precursor to photo AI |
| **6** | **STRENGTHEN F20 → cross-approach reconciliation (all forms)** | Generalize the 1025 income-vs-sales check to **appraised vs sales-comparison vs cost (vs income)** on every form; we already have the appraised≈sales-comp tripwire (>5%). | Divergence **> 10–15%** between approaches → verify. Info/verify. | F20 (+ tripwire #7) |
| **7** | **STRENGTHEN F14/F21 → explicit UAD edit findings** | Promote key `field-validation` tripwires to **surfaced "UAD edit" findings** (missing required field, invalid enum, internal inconsistency) instead of silent regression catches. | Hard edit = fatal, soft edit = warning (UCDP model). | F14b, F21, F22 |
| **8** | **STRENGTHEN F13 — appraiser license active-date** | Already checks expiry/state; add "license **not active as of effective date**" and record license # for an external exclusionary-list check later. | Active on effective date; state = subject state. Fatal. | F13 |

### 7B. Needs EXTERNAL data or AI — "later" layer

| Prio | Add | What it needs | Industry threshold | Maps to |
|---|---|---|---|---|
| **1** | **Overvaluation vs independent model (AVM)** | An **AVM / model-comps feed** (ClearAVM-style) to compare appraised value to an independent value and to surface **better/closer comps the appraiser missed**. This is the single biggest thing CU does that we can't from XML alone. | Gap vs AVM beyond model tolerance → overvaluation flag; strengthens F18. | strengthens F18 |
| **2** | **Full flip / chain-of-title & straw-buyer** | **Public records / title** — full transfer chain, related-party links, ARV vs public AVM, "ordered by a party to the transaction." | FHA 90/180-day + >20% markup bands; multiple transfers < 6 mo. | extends F26 |
| **3** | **Photo condition/quality AI** | An **image pipeline + Restb.ai/SpencerAI-type model** to derive C1–C6/Q1–Q6 from photos and compare to the appraiser's stated ratings + adjustments; hazard detection. | AI C/Q disagrees with stated C/Q → condition-consistency flag. | strengthens F14/F27 |
| **4** | **Appraiser exclusionary-list / ASC license lookup** | The lender's **do-not-use list** + **ASC/state license** live lookup. | On list / license invalid → fatal ineligibility. | strengthens F13 |
| **5** | **Consume CU/LCA output directly** | Parse the **SSR / CU score + flags** and **LCA feedback messages** when delivered with the appraisal, and map their reason codes to our findings. | CU ≥ 2.5 warn / ≥ 4.0 escalate (already F18). | strengthens F18 |

---

## 8. Sources

- Fannie Mae Collateral Underwriter (landing + job aids): https://singlefamily.fanniemae.com/applications-technology/collateral-underwriter ; https://singlefamily.fanniemae.com/job-aid/collateral-underwriter/topic/risk_flags_overview.htm ; https://singlefamily.fanniemae.com/job-aid/collateral-underwriter/topic/collateral_underwriter_introduction.htm
- CU FAQ / score bands: https://www.mckissock.com/blog/appraisal/fannie-maes-collateral-underwriter-program/ ; https://www.jvmlending.com/blog/what-is-a-cu-score-on-an-appraisal/ ; https://www.jvmlending.com/blog/appraisal-issues-the-dreaded-cu-score/ ; https://www.icba.org/newsroom/news-and-articles/2015/04/01/product-announcement---fannie-mae-s-collateral-underwriter
- Freddie Loan Collateral Advisor / ACE: https://sf.freddiemac.com/tools-learning/technology-tools/our-solutions/loan-collateral-advisor ; https://sf.freddiemac.com/tools-learning/technology-tools/our-solutions/ace-automated-collateral-evaluation ; LCA feedback-messages fact sheet (updated 2025-05-06): https://sf.freddiemac.com/docs/pdf/fact-sheet/lca_feedback_messages.pdf ; https://sf.freddiemac.com/content/_assets/resources/pdf/fact-sheet/understand_collateral_advisor_results.pdf
- UAD / edits / UAD 3.6: https://sf.freddiemac.com/faqs/uad-faq ; https://singlefamily.fanniemae.com/delivering/uniform-mortgage-data-program/uniform-appraisal-dataset ; UAD spec PDF: https://sf.freddiemac.com/docs/pdf/requirements/uad_specification.pdf ; UAD 3.6 rollout: https://www.valuelinksoftware.com/everything-you-need-to-know-about-the-uad-3-6-rollout-and-changes/ ; UAD Compliance API: https://singlefamily.fanniemae.com/media/document/pdf/uad-compliance-api-early-access
- Adjustments / comps / bracketing: Fannie B4-1.3-09 https://selling-guide.fanniemae.com/sel/b4-1.3-09/adjustments-comparable-sales ; https://legalclarity.org/sales-comparison-approach-comps-adjustments-bracketing/ ; https://realvals.com/appraisal-comparable-guidelines/ ; https://www.jvmlending.com/blog/comparable-sales-appraisers-can-and-cant-use/
- Reggora: https://www.reggora.com/lenders/appraisal-review ; https://www.reggora.com/blog/how-lenders-can-reduce-risk-and-costs-with-automated-appraisal-quality-control ; https://www.reggora.com/blog/how-reggora-uses-custom-automation-rules-to-speed-up-lender-workflows
- Clear Capital ClearCollateral / AURA: https://www.clearcapital.com/products/clearcollateral-review/ ; https://www.clearcapital.com/now-available-automated-collateral-review-on-pdf-only-appraisal-volume-in-clearcollateral-review/
- Restb.ai photo AI: https://restb.ai/solutions/property-condition/ ; https://restb.ai/customers/appraisals-inspections/ ; $27B white paper: https://www.globenewswire.com/news-release/2025/05/07/3076271/0/en/AI-Uncovers-27B-Risk-in-Appraisals-Restb-ai-White-Paper-Finds-Flawed-Condition-and-Quality-Adjustments.html
- Property flipping / fraud: FHA flip rule https://www.rocketmortgage.com/learn/fha-flipping-rules ; https://fhalenders.com/fha-flipping-rule/ ; https://www.consumerfinance.gov/ask-cfpb/i-was-told-im-buying-a-home-that-was-flipped-and-that-i-have-to-get-a-second-appraisal-how-does-that-work-en-1799/ ; FBI property flipping https://www.fbi.gov/how-we-can-help-you/more-fbi-services-and-information/freedom-of-information-privacy-act/department-of-justice-fbi-privacy-impact-assessments/property-flipping ; https://legalclarity.org/mortgage-fraud-red-flags-and-how-to-detect-them/
