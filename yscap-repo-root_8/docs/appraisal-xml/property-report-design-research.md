# PILOT Property Report — Design & Information-Architecture Research

Design/UX research for turning our extracted Fannie Mae appraisal XML data (subject details,
As-Is & ARV values, comps, photos, market stats, cost/income approaches) into a **premium,
branded "PILOT property report"** — a rich in-app profile a private lender is proud of, and
that exports cleanly to a branded PDF. This is a design + information-architecture spec, not code.

> **Brand tokens to design toward**
> Ink `#141B22` · Gold `#AE8746` · Teal `#2F7F86` · Paper `#F6F3EC`
> Display font **Fraunces** · Text font **Hanken Grotesk**
> Feel: editorial, warm-neutral, confident. Gold = the value/accent/brand line; Teal = data,
> links, positive deltas; Ink on Paper for body; charts use Teal + Gold + neutral greys only.

---

## 1. What the best-in-class reports do (and why they feel premium)

We studied the information architecture of the leading property/valuation reports and profiles.
The consistent lessons — and what separates a premium report from a raw appraisal PDF — are below.

### The reference set

| Product | What to steal from it |
|---|---|
| **HouseCanary Property Explorer** | Single-interface flow: scroll images of subject + comps, compare **AVM vs ARV**, test valuation methods, generate a "polished value report." Their redesign **consolidated data into a tabular section to cut scrolling**, added an **AVM breakdown** to reinforce confidence, and a **comps-selection panel** with filtering + simple selection. "Adjust fields" lets a user correct condition/renovations not in public record. ([Property Explorer](https://www.housecanary.com/products/property-explorer), [Quick Start](https://www.housecanary.com/blog/property-explorer-quick-start-guide), [private-money lenders](https://www.housecanary.com/industries/private-money-lenders)) |
| **Zillow property page (2023 redesign, still current)** | **Media section at the very top**; click a photo → **full-page magazine-style gallery**. Content chunked into named cards: **"What's Special," "Market Value," "Monthly Cost," "Neighborhood."** Wider single-scroll layout, **larger fonts for the most important facts**, "clearer articulation of what makes the home special." ([Zillow newsroom](https://zillow.mediaroom.com/2023-10-23-Zillow-unveils-a-new-look-for-property-pages,-their-biggest-redesign-in-5-years/)) |
| **Redesigned URAR / UAD 3.6** (broad use began Jan 2026) | The mortgage industry's own answer to "the ugly grid PDF." **Dynamic** form: only relevant sections render. **A Summary section leads every report** — property overview, **value conclusion, and key findings** up top. "Neighborhood" is upgraded to a broader **"Market Analysis"** emphasizing trends. Exhibits (maps, sketches, photos) reorganized into an **intuitive, top-to-bottom flow** rather than a dense grid — explicitly modeled on the clean URLA/Closing-Disclosure look. This is the modern IA our report should echo. ([Fannie Mae UAD](https://singlefamily.fanniemae.com/delivering/uniform-mortgage-data-program/uniform-appraisal-dataset), [2026 URAR explainer](https://paragonrealtors.com/blog/posts/2025/11/18/technically-speaking-redesigned-appraisal-report/), [CapCenter overview](https://www.capcenter.com/learning/article/new-uniform-residential-appraisal-form-what-it-means-for-homebuyers-and-the-mortgage-process)) |
| **Clear Capital / CoreLogic BPO & Valuation** | Data-rich 2–3 page reports: property description + photos, **comps with adjustments**, **neighborhood market analysis**, value, methodology. Every report runs through an **analytics ruleset scoring valuation accuracy & comp-selection risk**, then human QA. AVMs ship with an explicit **confidence score** (e.g. "72 ≈ ±5% error"). Steal: the **confidence/quality score as a first-class UI element**. ([Clear Capital BPO](https://www.clearcapital.com/products/broker-price-opinion/), [BPO one-pager PDF](https://www.clearcapital.com/wp-content/uploads/2017/09/Broker-Price-Opinion.pdf), [CoreLogic enhancements](https://nationalmortgageprofessional.com/news/24191/corelogic-announces-enhancements-its-valuation-products)) |
| **URAR sales-comparison grid** | The canonical **side-by-side column comps grid** (subject + 3+ comps across columns, ~22 adjustment lines down rows, +/- adjustments, indicated value range at the bottom). Familiar and trusted by appraisers — keep it available, but modernize it. ([Grayson comp-grid model PDF](https://graysonappraisal.org/wp-content/uploads/2024/04/COMP-GRID-MODEL-2024.pdf), [how appraisers use comps](https://www.madisonparkappraisal.com/blog/how-appraisers-use-comps)) |

### What makes them feel *premium* vs a raw appraisal PDF

1. **A confident hero + summary first.** Address, one hero photo, and the headline value(s)
   above the fold — the "answer" before the evidence. (URAR Summary, Zillow "Market Value.")
2. **Chunked, named cards with generous whitespace** instead of a wall of dense grid cells.
3. **Big type hierarchy** — one dominant number per section, small labels. Editorial, not form-like.
4. **Photography treated as a first-class citizen** (magazine gallery), not thumbnails jammed in a corner.
5. **A few tasteful data-viz moments** (value comparison, trend line, map) that a PDF can't do.
6. **Visible trust/quality signals** — confidence score, verified license, data sources, effective date.
7. **Consistent brand system** — type, color, spacing, iconography read as one designed product.
8. **Progressive disclosure** — summary on top, "expand for detail" (full adjustment grid, all photos)
   underneath, so the report is skimmable but complete.

---

## 2. Recommended section stack for the PILOT property report

Order top-to-bottom. Each section: **what data** it draws from our extraction + **visual treatment**.
This maps 1:1 onto the redesigned-URAR IA (Summary → Subject → Value → Market → Exhibits) so it feels
native to appraisers and lenders, while looking like a modern product.

### 0. Report chrome / sticky sub-nav
- **Data:** section anchors (Summary · Photos · Subject · Valuation · Comps · Market · Appraiser · Exhibits).
- **Visual:** thin sticky top bar, Ink on Paper, Gold active-underline. Right side: **"Export PILOT
  Report"** (primary, Gold), report status/effective-date chip, and a form-type badge (`1004 · SFR` or
  `1025 · 2–4 Unit`). The sub-nav is what makes a long scroll feel like a designed document.

### 1. Hero — address + headline values
- **Data:** full address, city/state/ZIP, property type + form type, **As-Is value**, **ARV**, purchase
  price/contract (if present), effective date, appraiser name/company. GLA, beds/baths, year built, lot.
- **Visual:** full-bleed **hero photo** (front of subject) with a dark Ink gradient scrim; over it, the
  address in **Fraunces** display. Below the photo, a **value band**: 2–3 large stat tiles —
  **As-Is** and **ARV** as the dominant numbers (Gold accent rule under ARV), plus **purchase price** and
  the derived **equity / value-add spread (ARV − As-Is)** and **LTV/ARV%** if we have the loan figure.
  Under-tile microcopy shows the approach that produced each figure ("Sales Comparison," "Income/GRM").
  This is the "answer first" move. A small **confidence chip** sits beside the values (see §6).

### 2. Photo gallery — subject + comps
- **Data:** subject photos (front/rear/street), interior photos, comp photos, plat/map/sketch exhibits,
  all from the XML photo manifest, with their category labels.
- **Visual:** **grid-mosaic** below the hero — one large image + a 2×2 of thumbnails, with a "View all N
  photos" affordance opening a **full-screen lightbox** (magazine layout, à la Zillow). See §5 for the
  full pattern. **Category tabs/filter** inside the lightbox: Front · Rear · Street · Interior · Comps ·
  Exhibits. Label every image; never show an unlabeled photo strip.

### 3. At-a-glance facts strip
- **Data:** beds, baths, GLA (sq ft), lot size, year built, stories/units, garage, condition rating
  (C1–C6), quality rating (Q1–Q6), zoning, occupancy. For 1025: unit count + mix.
- **Visual:** horizontal row of **compact icon stat tiles** (Zillow "key facts strip"). Ink numerals,
  grey labels, Paper background, hairline dividers. On mobile it wraps to a 2-col grid. Any low-reliability
  field carries a small uncertainty dot (§6).

### 4. Subject property details
- **Data:** the full subject record — site (lot, zoning, utilities, FEMA/flood), improvements
  (design/style, materials, foundation, GLA breakdown, rooms), condition/quality narrative, HOA,
  legal description, APN. For 1025: **per-unit rent schedule** (actual vs market rent), unit mix.
- **Visual:** two-column **definition-list cards** grouped by theme (Site · Improvements · Interior ·
  Utilities · Legal). Each card has a Fraunces subhead. For 1025 add a **Rent Schedule table** (unit,
  beds/baths, actual rent, market rent, delta) and a **unit-mix mini-bar**. Keep it scannable — labels
  left, values right-aligned, monospace-tabular numerals.

### 5. Valuation summary — As-Is / ARV / approaches
- **Data:** As-Is value, ARV, the three approaches (Sales Comparison value, Cost Approach value,
  Income/GRM value for 1025), reconciliation narrative, the **condition-of-appraisal** basis
  (AsIs / SubjectToRepairs / SubjectToCompletion), and the hypothetical-condition flag from our
  narrative scan.
- **Visual:** the analytical centerpiece.
  - **Value-comparison horizontal bar chart:** Purchase → As-Is → ARV on a shared axis (Gold for ARV,
    Teal for As-Is, grey for purchase), with the **spread annotated** between As-Is and ARV.
  - **Approach reconciliation cards:** one tile per approach (Sales Comparison / Cost / Income), each with
    its value and a "weight/emphasis" note; the reconciled figure gets the Gold accent.
  - **A value gauge** (optional, tasteful): reconciled value positioned within the comps' indicated value
    range (min–max from the adjusted comps), so the reader sees it sits inside the supported range.
  - A **basis callout banner** stating plainly: *"Value shown is the **ARV** — appraised subject to
    completion of repairs"* (or As-Is), driven by our two-signal logic. This is a trust-critical line;
    if the enum and narrative disagreed, surface the flag here.

### 6. Comparable sales — grid + table + map
See §4 for the full recommendation. Summary: a **modern comps table** (sortable, photo thumbnail per
comp, key attributes, sale price, adjusted price, $/sqft, distance, sale date), a **map** with the subject
pin (Gold) and comp pins (Teal, numbered), and an **expandable full URAR-style adjustment grid** for
appraiser-grade detail. Indicated value range shown at the bottom.

### 7. Neighborhood & market trends
- **Data:** neighborhood name/description, market trend direction (increasing/stable/declining),
  supply/demand & marketing time (from URAR "Market Analysis"/1004MC-style fields), price range and
  predominant value, boundaries. Optionally $/sqft trend if derivable from comps.
- **Visual:** **market-trend line chart** (median price or $/sqft over time), a **KPI row** (trend badge,
  months of supply, avg DOM, price range), and a **neighborhood map / heat context**. Trend badges use
  Teal (up), grey (stable), a muted warm-red only where truly declining. Keep it to 2–3 visuals.

### 8. Cost & income approach detail (conditional)
- **Data:** Cost approach (site value, replacement cost new, depreciation, "as-completed" cost) — 1004.
  Income approach (GRM, monthly market rent, gross income, indicated value) — 1025.
- **Visual:** a **waterfall or stacked breakdown** for cost approach (site + improvements − depreciation =
  value); a small **GRM calc card** for income. Render only the section relevant to the form type
  (dynamic, like the new URAR).

### 9. Appraiser & report info
- **Data:** appraiser name, company, **license # + state + expiration**, effective date, report/signature
  date, form type, lender/client, intended use, scope, supervisory appraiser if any.
- **Visual:** a clean **"prepared by" card** — appraiser identity block + **verification badges** (license
  present, effective-date recency). Reads like the credential footer of a premium report. See §6.

### 10. Exhibits & source PDF
- **Data:** sketch/floor plan, location map, plat map, flood map, and the **original appraisal PDF**.
- **Visual:** a **document/exhibit grid** (thumbnail + label + open/download), plus a prominent
  **"View original appraisal PDF"** button. This is the audit trail — it signals the premium report is
  backed by the source of record, not replacing it.

### 11. Report footer / provenance
- **Data:** "Generated by PILOT from appraisal XML," extraction timestamp, data-source list, disclaimer.
- **Visual:** quiet Ink-on-Paper footer with the PILOT wordmark and a source/provenance line (§6).

---

## 3. Data-visualization recommendations (tasteful, brand-aligned)

Keep it to a handful of high-signal visuals; restraint is what reads as premium. Palette: **Teal + Gold +
neutral greys**, never a rainbow. Number formatting: tabular figures, `$` and `k`/`M` abbreviations on
axes, full values in tooltips/labels.

| Visual | Where | Data | Notes |
|---|---|---|---|
| **Value-comparison bar** (horizontal) | §5 Valuation | Purchase vs As-Is vs ARV | The signature chart. Annotate the ARV−As-Is spread. Gold = ARV. |
| **Value gauge / range band** | §5 Valuation | Reconciled value within comps' adjusted range | Shows the number sits inside the supported range. Use sparingly. |
| **Approach reconciliation tiles** | §5 | Sales / Cost / Income values | Not a chart — 3 stat tiles; reconciled one accented Gold. |
| **Comps $/sqft scatter** | §6 Comps | Each comp: sale date (x) vs $/sqft (y); subject as a reference line | Reveals market drift + where subject sits. Teal dots, Gold subject line. |
| **Comps price/adjustment bars** | §6 Comps | Sale price vs adjusted price per comp | Small paired bars; net-adjustment % as a label. |
| **Adjustment "heat" cells** | §6 grid | Per-line adjustments | Subtle background tint: Teal for positive, warm-grey for negative, intensity ∝ magnitude. Keep low-contrast. |
| **Market-trend line** | §7 Market | Median price or $/sqft over time | Single Teal line, Gold marker on latest point, direction badge. |
| **Cost-approach waterfall** | §8 | Site + RCN − depreciation = value | Only for 1004. |
| **Map with pins** | §6/§7 | Subject (Gold star) + numbered comp pins (Teal), distance rings optional | The single most "premium/AVM" visual. Pins keyed to the comps table row numbers. |
| **Unit-mix mini-bar / rent-delta** | §4 (1025) | Actual vs market rent per unit | Only for 2–4 unit. |

**Avoid:** pie charts, 3D anything, dual-axis clutter, more than ~3 series per chart, gratuitous gradients.
Every chart must degrade to a clean static image for the PDF export (§7).

---

## 4. Comparable-sales presentation

Comps are where lenders and appraisers judge credibility, so offer **three coordinated views of the same
data**, progressively disclosed:

1. **Modern comps table (default).** One row per comp, sortable. Columns: **photo thumbnail**, address,
   distance, sale date, sale price, **adjusted price**, $/sqft, beds/baths, GLA, condition/quality, net &
   gross adjustment %. Row number ties to the map pin. Subject pinned as the first (highlighted) row for
   reference. Sort by distance/date/adjusted price. This is the scannable, product-grade view.
2. **Map view (paired).** Subject = Gold star; comps = numbered Teal pins. Hovering a table row highlights
   its pin and vice-versa. Optional distance rings. This is the highest-impact "this looks like a real
   valuation tool" element.
3. **Full URAR adjustment grid (expandable).** The canonical **side-by-side column layout** — subject +
   comps across the top, ~22 adjustment lines down (sale/financing concessions, date/time, location,
   site, view, design/quality, condition, GLA, rooms, basement, etc.), each with the +/- dollar
   adjustment, and the **net/gross adjustment + adjusted sale price** and the **indicated value range** at
   the bottom. Modernize it: sticky first column, subtle adjustment heat cells, hairline grid (not heavy
   borders), tabular numerals. Appraisers trust this exact format — keep it, but make it breathe.

Card view is optional for mobile (each comp becomes a photo card with key stats + "see adjustments").
Always show the **indicated value range** and note **which comps are As-Is vs ARV** comps where our
extraction split them (this is a known signal in our data).

---

## 5. Photo-gallery pattern

Property photos are the emotional core — treat them like Zillow's magazine layout, not appraisal
thumbnails. Three formats to combine ([gallery formats reference](https://wpresidence.net/property-website-design-patterns/), [lightbox reference](https://www.cincopa.com/media-platform/lightbox-gallery)):

- **Hero (fullbleed):** the front-of-subject shot behind the address (§1).
- **Grid mosaic (section §2):** one large lead image + a 2×2 thumbnail cluster + "View all N photos" tile.
- **Thumbnail strip:** a scrollable row of labeled thumbnails as the secondary browse affordance.
- **Lightbox (on click):** full-screen darkened overlay, one large image, **arrow + swipe navigation,
  zoom/pan**, a thumbnail rail, and **category filter tabs**: **Front · Rear · Street · Interior · Comps ·
  Exhibits (sketch/maps)**. Caption every image with its extracted label + source (subject vs comp #N).

Rules: always label images; group comp photos under their comp; put building sketch/plat/flood maps in
the **Exhibits** category, not mixed with property photos; lazy-load; provide a graceful placeholder for
missing categories (many files won't have interior/rear shots — don't show broken frames).

---

## 6. Trust & credibility cues

Lenders and appraisers expect explicit signals of reliability. Fintech-UX research is consistent: visible
verification badges and data-quality indicators measurably increase trust, and layered disclosure (summary
+ expand-for-detail) keeps confidence high without clutter ([fintech trust patterns](https://phenomenonstudio.com/article/fintech-ux-design-patterns-that-build-trust-and-credibility/), [trust badges](https://meshverify.com/use-case-trust-badges)). Our data is *extracted*, so honesty about
certainty is itself a premium signal.

- **License-verified badge** — appraiser license #, state, and expiration present → a small Gold/Teal
  "License on file" check chip in §9. Flag if expired/near expiry relative to effective date.
- **Effective-date recency chip** — green/Teal if recent, amber if the appraisal is aging (e.g. >90/180
  days), with the actual date always shown. (Mirrors the URAR emphasis on effective date.)
- **Confidence / data-quality score** — borrow Clear Capital/CoreLogic's confidence-score idea. A compact
  badge near the headline values summarizing extraction confidence for the key fields (value basis, comps,
  As-Is/ARV). Expandable to a per-field breakdown driven by our `field-reliability.md` tiers
  (ALWAYS/USUALLY/SOMETIMES/RARELY).
- **Per-field uncertainty markers** — a subtle dot/underline on any value that was estimated, narrative-
  derived, or PDF-only (e.g. an As-Is figure that came from narrative, not a structured attribute).
  Tooltip: source + why it's flagged. Never present an inferred number as if it were structured data.
- **Value-basis banner** — the plain-language "this is the ARV, subject to completion" callout (§5),
  especially when our enum-vs-narrative logic overrode the enum. Silent inference erodes trust; a stated
  basis builds it.
- **Data-source / provenance line** — "Extracted by PILOT from the appraiser's MISMO 2.6 appraisal XML on
  {date}. Original PDF attached." Shows the report is backed by, not inventing, the source of record.
- **Form-type & approach badges** — `1004 · SFR` / `1025 · 2–4 Unit`, and per-value approach labels, so
  the reader knows exactly what methodology produced each figure.

Keep cues quiet and consistent — one badge style, one uncertainty marker, reused everywhere. Over-badging
reads as anxious, not credible.

---

## 7. Exportable branded PILOT report (print / PDF)

The web report must export to a **branded PDF that still looks premium in print**. Approach: a dedicated
`@media print` stylesheet (or a server-side HTML-to-PDF render of the same components) rather than a
screenshot ([print-CSS cheatsheet](https://www.customjs.space/blog/print-css-cheatsheet/), [optimizing HTML for PDF](https://pdfbolt.com/blog/optimizing-html-for-pdf), [designing for print with CSS](https://www.smashingmagazine.com/2015/01/designing-for-print-with-css/)).

**Structure**
- **Cover page** — PILOT wordmark, property hero photo, address in Fraunces, As-Is/ARV headline values,
  effective date, "Prepared for {lender}". `break-after: page;` so nothing bleeds onto it, and suppress the
  running header/footer on the cover.
- **Running header/footer** via `@page` — small PILOT mark + property address in the header; page number
  ("Page X of Y"), effective date, and a subtle **confidentiality/watermark** ("PILOT — Confidential") in
  the footer. Distinct `@page :first` for the cover.
- **Section order** mirrors the on-screen stack (§2): Cover → Summary/Values → Photos (curated subset) →
  Subject → Valuation → Comps (table + map + adjustment grid) → Market → Appraiser → Exhibits.

**Print rules that keep it premium**
- `break-inside: avoid` on stat tiles, comp rows, cards, charts, and the appraiser block so nothing splits
  across a page mid-element.
- `break-before: page` before each major section (Valuation, Comps, Market, Exhibits).
- **Embed brand fonts** (Fraunces + Hanken Grotesk) in the PDF for brand consistency — don't rely on
  system fonts.
- **Charts/maps render as crisp static images** at print resolution (pre-rasterize or use SVG); the map
  needs a static tile snapshot. Convert interactive elements to their static equivalents.
- Neutralize any floated parent (`float: none !important`) so page breaks actually fire.
- Use **Paper `#F6F3EC` sparingly in print** (ink cost / muddy on some printers) — prefer white page with
  Paper reserved for accent bands; keep Gold/Teal for rules and headers where they reproduce well.
- Fit the **comps table to landscape** or scale to page width so it never clips; the full adjustment grid
  may warrant its own landscape page.
- Include the **provenance/source line and disclaimers** in the print footer or a final page.

The result: the same data that produced the ugly generated appraisal PDF now exports as a clean,
cover-paged, brand-consistent **PILOT report** — premium on screen and in print.

---

## Sources
- HouseCanary Property Explorer — https://www.housecanary.com/products/property-explorer
- HouseCanary Property Explorer Quick Start — https://www.housecanary.com/blog/property-explorer-quick-start-guide
- HouseCanary for private-money lenders — https://www.housecanary.com/industries/private-money-lenders
- Zillow property-page redesign (2023) — https://zillow.mediaroom.com/2023-10-23-Zillow-unveils-a-new-look-for-property-pages,-their-biggest-redesign-in-5-years/
- Fannie Mae Uniform Appraisal Dataset (UAD 3.6 / redesigned URAR) — https://singlefamily.fanniemae.com/delivering/uniform-mortgage-data-program/uniform-appraisal-dataset
- 2026 URAR / UAD 3.6 explainer — https://paragonrealtors.com/blog/posts/2025/11/18/technically-speaking-redesigned-appraisal-report/
- New URAR overview (CapCenter) — https://www.capcenter.com/learning/article/new-uniform-residential-appraisal-form-what-it-means-for-homebuyers-and-the-mortgage-process
- Clear Capital Broker Price Opinion — https://www.clearcapital.com/products/broker-price-opinion/
- Clear Capital BPO one-pager (PDF) — https://www.clearcapital.com/wp-content/uploads/2017/09/Broker-Price-Opinion.pdf
- CoreLogic valuation enhancements — https://nationalmortgageprofessional.com/news/24191/corelogic-announces-enhancements-its-valuation-products
- URAR sales-comparison grid model (PDF) — https://graysonappraisal.org/wp-content/uploads/2024/04/COMP-GRID-MODEL-2024.pdf
- How appraisers use comps (Sales Comparison Approach) — https://www.madisonparkappraisal.com/blog/how-appraisers-use-comps
- Property listing page design patterns — https://wpresidence.net/property-website-design-patterns/
- Lightbox gallery pattern (Cincopa) — https://www.cincopa.com/media-platform/lightbox-gallery
- Fintech UX trust patterns — https://phenomenonstudio.com/article/fintech-ux-design-patterns-that-build-trust-and-credibility/
- Verified trust badges — https://meshverify.com/use-case-trust-badges
- Print CSS cheatsheet — https://www.customjs.space/blog/print-css-cheatsheet/
- Optimizing HTML for PDF (PDFBolt) — https://pdfbolt.com/blog/optimizing-html-for-pdf
- Designing for print with CSS (Smashing) — https://www.smashingmagazine.com/2015/01/designing-for-print-with-css/
- Real estate charts & market trends — https://theclose.com/real-estate-charts/
