# PILOT Property Report — Enhancement & "$M-Built" Research

Companion to [`property-report-design-research.md`](./property-report-design-research.md) (the IA + section-stack
spec). **That doc defines the report; this one elevates it.** Here we answer: what *more* could a premium
property-intelligence product show (and where does that data come from), which best-in-class *features* to
build, how to split a single read-only report between **staff (loan officer)** and **borrower** eyes, how to
export it so it stays premium on paper, and the specific craft moves that make a product feel like it cost
millions to build. Don't re-read the section stack here — assume it.

> **Brand tokens** (design toward these): Ink `#141B22` · Gold `#AE8746` · Teal `#2F7F86` · Paper `#F6F3EC` ·
> Fraunces (display) + Hanken Grotesk (text). Gold = value/accent/brand line; Teal = data/links/positive
> deltas; Ink on Paper for body; charts use Teal + Gold + neutral greys only.

> **Two hard product constraints** (from the codebase's standing rules):
> - The report is **read-only for both audiences** — neither staff nor borrower can edit anything.
> - **Never expose a note-buyer / capital-partner name** (BlueLake, Temple View, RCN, Churchill, Fidelis…) on
>   any borrower surface; borrower copy calls the program the **"Gold Standard program."** This governs the
>   staff-vs-borrower split in §3.

---

## 0. How the giants frame a property "profile" — what to steal (beyond the last doc)

The prior doc studied HouseCanary Property Explorer, Zillow, the redesigned URAR, and Clear Capital/CoreLogic
report IA. The new lesson from surveying the **data** vendors (ATTOM, HouseCanary, CoreLogic, Reonomy/Black
Knight, First American) is that a premium property report is really a **layered dossier**: an identity layer
(what/where), a valuation layer (what it's worth, with a confidence number), a **history layer** (who owned it,
what it sold/mortgaged for, what was permitted), a **risk layer** (flood, hazard, environmental), and a
**market/neighborhood layer** (trend, supply, rent, demographics, schools, walkability). Our appraisal XML fills
the identity + valuation + a thin market slice richly; the history and risk layers are where external data later
turns a good report into a "$M product."

- **ATTOM** exposes ~9,000 attributes/property across 160M+ properties: ownership, 10 yrs of deed/sales history,
  mortgage records, tax assessment history, building permits (2,000+ departments), foreclosure filings,
  neighborhood demographics. This is the canonical "history + records" layer.
  ([property data](https://www.attomdata.com/data/property-data/),
  [ownership data](https://www.attomdata.com/data/property-ownership-data/),
  [overview 2026](https://blog.iq.dwellsy.com/attom-data-overview-2026-property-ownership-and-market-data-explained/))
- **HouseCanary** ships the "forward-looking" layer: a monthly AVM + **RPI/HPI**, **rent estimates forecast 12
  months** out (3/6/12-mo % growth) and **value forecast 36 months** out (3–36-mo intervals), a **Market Action
  Score** (ZIP supply/demand), a **Market Grade** (income/jobs/owner-renter mix), and a Rental Index (gross
  yield). Steal the **forecast + market-score** framing.
  ([Data Explorer](https://www.housecanary.com/products/data-explorer),
  [API reference](https://api-docs.housecanary.com/), [HPI/RPI](https://www.housecanary.com/products/hpi-rpi-data))
- **CoreLogic** owns the **risk/neighborhood** layer: natural-hazard + **flood risk score**, granular **crime**
  (by category), **school ratings**, demographics, employment trends, 94% MLS coverage.
  ([RiskMeter](https://riskmeter.corelogic.com/),
  [neighborhood crime](https://marketplace.databricks.com/details/39b2899c-6c20-4f47-83bb-b5023c4d8aee/CoreLogic_Neighborhood-Crime))
- **Reonomy / Black Knight** show the **ownership-graph + debt** layer for CRE — title/assessor records,
  transaction history, **debt & lien filings**, corporate ownership (who really owns the LLC). Relevant to our
  2–4 unit / investor borrowers later.
  ([Reonomy CRE database](https://www.reonomy.com/resources/commercial-real-estate-database/),
  [Black Knight × Reonomy](https://www.prnewswire.com/news-releases/black-knights-extensive-property-data-to-enrich-reonomys-leading-commercial-real-estate-platform-300891708.html))
- **First American / ATTOM Property Navigator** package this as a shareable, mapped **one-pager** — a "sales
  comparables report," distance-ringed comp map, remove-a-comp interactivity — which is exactly our comp UX.
  ([First Am comparables sample](https://dna.firstam.com/solutions/property-data/property-reports/sales-comparables-report-sample),
  [ATTOM Property Navigator](https://www.attomdata.com/solutions/property-navigator/))

**The takeaway for backlog priority:** everything already in the XML should ship *first and beautifully*; the
external layers are a roadmap that visibly "slots in" to sections we design now (leave the shelf space).

---

## 1. Enhancement backlog — data we can add

Split exactly as requested: what we can render **now, from the appraisal XML**, vs. what needs **external data
(public records / APIs) later**. Prioritized within each. "Provenance" = where the number legitimately comes
from; never present an inferred value as structured (see the trust rules in the prior doc §6).

### A. FROM THE APPRAISAL XML — build now (highest priority)

These are already in the MISMO/UAD appraisal payload we extract; they're "free" premium and should be mined
harder than a raw form does.

| # | Enhancement | Source in XML | Why it lifts the report |
|---|---|---|---|
| A1 | **Prior sale / transfer of the SUBJECT** | URAR requires "prior sale within 12mo (subject) / 36mo (comps)"; the appraiser fills date + price | A genuine *history* beat with zero external data — shows last sale price/date + $/sqft vs today. Seeds the value timeline (§2). |
| A2 | **Comp prior-sale history** | Same UAD prior-transfer lines per comp | Lets us show each comp's own last sale — credibility signal appraisers respect. |
| A3 | **Full 1004MC / "Market Analysis" trend block** | Median price, DOM, months-of-supply, listing-vs-sale, trend direction (incr/stable/declining), price range | We already surface a trend line; mine the *whole* block into a KPI row + supply gauge. Pure XML. |
| A4 | **Flood / FEMA fields as a risk chip** | URAR site section carries FEMA zone, map #, map date, "in a flood zone Y/N" | Elevate from a buried field to a **risk chip** in the summary. External flood *score* comes later (B-tier); the zone itself is in the XML now. |
| A5 | **Site / zoning detail** | Zoning classification + description, "legal / legal-nonconforming / illegal," highest-&-best-use, lot size, utilities | A "Zoning & Site" card; flag legal-nonconforming (a real underwriting signal). |
| A6 | **Cost-approach breakdown (1004) / Income-approach (1025/1073)** | Site value, RCN, depreciation, as-completed; GRM, market rent, gross income | Already in stack §8 — make it a waterfall + GRM card, not a table. |
| A7 | **Per-unit rent schedule + market-vs-actual (1025)** | Rent schedule, unit mix, actual vs market rent | Rent-delta mini-bars; the closest we get to a "rent estimate" without external data. |
| A8 | **HOA / condo project data (1073)** | Project name, HOA dues, ownership %, project type, common elements, budget-adequacy line | A "Project & HOA" card for condos — 1073-specific, currently invisible. |
| A9 | **Adjustment transparency (comp grid mined, not just shown)** | Each of ~22 adjustment lines + net/gross % + adjusted range | Compute & surface **net-adjustment % and gross-adjustment %** as quality flags (>15% net / >25% gross is a classic risk threshold) — a derived "comp quality" signal from XML alone. |
| A10 | **Appraiser credential + effective-date recency** | License #, state, expiration, effective/signature date, supervisory appraiser | License-verified badge + aging chip (prior doc §6) — trust layer, all XML. |
| A11 | **Condition/quality (C1–C6 / Q1–Q6) as visual scale** | UAD condition & quality ratings | Render as a 6-point pip scale, not a code — instantly legible. |
| A12 | **Reconciliation narrative + value-basis logic** | Reconciliation text, condition-of-appraisal enum, hypothetical-condition flag | The "this is ARV, subject to completion" banner + a short pulled-quote from the appraiser's reconciliation. |
| A13 | **Derived value math** | As-Is, ARV, purchase price (if present) | Value-add spread (ARV−As-Is), $/sqft for subject and each comp, comp-implied value range. Pure arithmetic on XML fields. |
| A14 | **Photo taxonomy + geotag** | Photo manifest w/ category labels; many carry lat/long/EXIF | Category-tabbed lightbox (prior doc §5); if geotags exist, plot photo locations. |

**Rule of thumb:** A1–A3 + A13 are the biggest "wow for free" — they add the *history* and *derived-analytics*
beats that make a report feel like a data product, using only fields the appraiser already keyed.

### B. EXTERNAL DATA — later (public records / APIs)

Design the shelf space now; wire the data when we license a provider. Each maps to a provider proven above.

| # | Enhancement | Likely source | Placement in report |
|---|---|---|---|
| B1 | **Full ownership + deed/transfer history** (all sales, grantor/grantee, doc type) | ATTOM / CoreLogic / county assessor | Extends the value timeline (A1) into a full chain of title. |
| B2 | **Tax assessment history** (assessed value, tax amount, year, exemptions) | ATTOM / CoreLogic tax | "Taxes & Assessment" card w/ a small assessed-value-over-time line. |
| B3 | **Mortgage / lien / debt history** (open liens, foreclosure filings) | ATTOM / Reonomy-Black Knight | **Staff-only** encumbrance panel (see §3) — never borrower-facing. |
| B4 | **Building permits** (type, date, value, status) | ATTOM permits (2,000+ depts) | "Permit history" strip near Subject — validates the rehab story. |
| B5 | **Flood/FEMA *score* + climate risk** (beyond the XML zone) | CoreLogic RiskMeter / FEMA / First Street | Upgrades the A4 chip into a graded risk meter. |
| B6 | **School ratings** | CoreLogic / GreatSchools / Niche | Neighborhood section — borrower-friendly. |
| B7 | **Walk / Transit / Bike score** | Walk Score API | Neighborhood chips. |
| B8 | **Crime / safety index** | CoreLogic neighborhood crime | Neighborhood — show as an index, not raw counts; handle sensitively. |
| B9 | **Demographics** (income, owner/renter mix, population) | ATTOM / Census / CoreLogic | Market context; feeds a "market grade." |
| B10 | **Rent estimate + rent trend / comparable rentals** | HouseCanary RPI / rentals | Turns A7 into a real rent AVM + rent comps for DSCR sizing. |
| B11 | **Price/value trend + FORECAST** (3–36 mo) | HouseCanary HPI/AVM forecast | Adds a forward band to the market-trend line — the "premium AVM" flex. |
| B12 | **Days-on-market (live)** | MLS / ATTOM | Live DOM vs the appraisal's snapshot. |
| B13 | **Market supply / absorption / Market Action Score** | HouseCanary Market Action Score | A supply/demand gauge in the market section. |
| B14 | **Independent AVM as a second opinion** | HouseCanary / CoreLogic / Clear Capital AVM + confidence | An AVM-vs-appraised comparison w/ vendor confidence score — the single most "valuation-product" add. |
| B15 | **Environmental / hazard overlays** (wildfire, quake, radon, brownfield) | CoreLogic / ATTOM hazards | Risk section overlays. |
| B16 | **Zoning overlays / entitlement** | Local GIS / Regrid / Reonomy | Deeper zoning than the XML classification. |
| B17 | **Corporate ownership graph** (who owns the LLC) | Reonomy / Black Knight | **Staff-only** — KYC/exclusionary context. |

**Sequencing:** B14 (second-opinion AVM + confidence), B1/B2 (chain of title + tax history), and B11/B10
(forecast + rent) are the highest-leverage external adds — they complete the "history" and "forward-looking"
layers that separate us from a reformatted appraisal.

---

## 2. Best-in-class features & interactions (which are tasteful + high-impact)

Rated **High / Med / Low** for impact-to-effort *at premium taste*. High ones are the ones that make people say
"this is a real valuation tool."

| Feature | Verdict | Notes |
|---|---|---|
| **Interactive map, subject (Gold star) + numbered comp pins (Teal), distance rings, row↔pin hover linking** | **High** | The single most "premium/AVM" element. First American & ATTOM Navigator both center the report on a distance-ringed comp map. Pins keyed to comp-table row numbers. ([ATTOM Navigator](https://www.attomdata.com/solutions/property-navigator/), [First Am sample](https://dna.firstam.com/solutions/property-data/property-reports/sales-comparables-report-sample)) |
| **Sortable comps table <-> expandable URAR adjustment grid** (progressive disclosure) | **High** | Scannable by default, appraiser-grade on expand. Already speced (prior doc §4); the *interaction* (sort, expand, sticky first column, adjustment heat cells) is what sells it. |
| **Comp side-by-side compare** (pick 2–3, columns align) + **remove-a-comp** | **High** | HouseCanary Property Explorer's comp-selection panel; First Am lets you drop a comp from the set. Read-only twist: we let the reader *isolate/compare*, not re-underwrite. ([Property Explorer](https://www.housecanary.com/products/property-explorer)) |
| **Photo lightbox, magazine layout, category tabs** (Front/Rear/Street/Interior/Comps/Exhibits), swipe+zoom | **High** | Zillow's gallery is the bar. Emotional core; label every image. |
| **Confidence / summary score** as a first-class chip near the headline value | **High** | Clear Capital/CoreLogic ship an explicit confidence number; borrow it for extraction confidence + comp quality (net/gross adj, distance, recency). Expandable to per-field tiers. |
| **Value-comparison bar** (Purchase -> As-Is -> ARV, spread annotated) | **High** | The signature chart; the "answer first" visual. |
| **Value timeline** (prior sale -> As-Is -> ARV; later: full chain of title + forecast band) | **High** | Starts from XML (A1); grows with B1/B11. A horizontal time axis instantly reads as "intelligence." |
| **Risk / quality flags** (flood zone, legal-nonconforming, high net-adjustment, aging effective date, hypothetical-condition) | **High** | Derived from XML now; a quiet flag rail that signals rigor. Amber, used sparingly. |
| **Street View** embed on the subject + comps | **Med** | Nice, but needs a Maps key + has cost/privacy overhead; do after the static comp map. |
| **Market-trend line w/ latest-point marker** (+ later a forecast band) | **Med** | Keep to one Teal line; don't over-chart. |
| **Shareable read-only link** (tokenized, expiring, view-scoped to borrower or staff variant) | **Med/High** | How First Am/HouseCanary distribute reports. High business value; must respect the §3 split — a borrower link renders the borrower view only. |
| **Printable branded PDF w/ cover + watermark** | **High** | See §4 — table stakes for "premium," and a real deliverable staff hand to borrowers/partners. |
| **AVM second-opinion tile** (external) | **High (later)** | B14; appraised-vs-AVM with vendor confidence. |
| **Cost-approach waterfall / GRM card** | **Med** | Form-conditional; renders only where relevant (dynamic like the new URAR). |
| **"What changed" / freshness ribbon** (effective date, extraction date) | **Med** | Cheap trust cue. |
| **Micro filters inside comps** (by distance/date/adjusted price) | **Med** | Tasteful; keep it to sort + a couple of toggles, not a query builder. |
| 3D/isometric hero, parallax, animated counters everywhere | **Low / avoid** | Reads as marketing, not valuation. One restrained motion system only (§5). |

---

## 3. Two audiences, one read-only report — staff vs. borrower

Same report object, two **view profiles** selected by the viewer's role (and by which share-link type was
issued). Neither can edit. The governing principle: **the borrower sees the property and its value story; the
staff sees that PLUS the deal, the counterparties, and the underwriting internals.** This is a hard privacy
boundary, not a nicety — it's enforced by the same standing rules that keep capital-partner names and SSNs off
borrower surfaces elsewhere in PILOT.

### What the borrower SHOULD see
The full property profile: hero + address, photos, subject facts, **As-Is and ARV values and the approaches
behind them**, the comps (table + map + adjustment grid), neighborhood/market trends, cost/income approach,
appraiser identity + license, exhibits, and the **original appraisal PDF** (it's their appraisal — they're
entitled to it). The confidence/quality framing is fine to show; it's about the appraisal's rigor, not the
lender's math.

### What the borrower should NOT see (staff-only)
- **Internal underwriting math** — LTV / LTC / ARV-LTV, loan sizing, leverage caps, initial advance vs holdback,
  interest-reserve internals, cost basis. (These live in the pricing engine, not the appraisal, but if the
  report ever pulls them, gate them.)
- **Capital-partner / note-buyer names** and program internals — borrower copy says **"Gold Standard program,"**
  never BlueLake/Temple View/RCN/etc.
- **Exclusionary-list / watchlist / KYC checks**, corporate-ownership graph (B17), and any risk-flag phrased as
  a *lender decision* rather than a *property fact*.
- **Encumbrance / lien / mortgage-balance history** (B3) and foreclosure filings — property-records data that's
  underwriting context, not something to surface to the borrower in this product.
- **Internal notes, condition sign-offs, audit/provenance minutiae**, sync-review flags, and staff-only
  confidence *sub-scores* tied to underwriting.
- **Aggressive risk language** — the borrower sees a neutral "FEMA Zone AE" chip; staff may see "flood-risk
  concentration / insurance flag." Same fact, calibrated tone.

### Section × audience matrix

| Section / element | Borrower | Staff (LO) | Notes |
|---|:---:|:---:|---|
| Hero: address, photo, property/form type | shown | shown | |
| As-Is value | shown | shown | |
| ARV value | shown | shown | |
| Purchase / contract price | shown | shown | If present in XML. |
| Value-add spread (ARV-As-Is) | shown | shown | Property fact, fine to show. |
| **LTV / LTC / ARV-LTV, loan sizing, reserve/holdback internals** | hidden | shown | Underwriting math. |
| Photo gallery + lightbox (all categories) | shown | shown | |
| At-a-glance facts strip (beds/baths/GLA/lot/year/condition/quality) | shown | shown | |
| Subject detail cards (site, improvements, utilities, legal) | shown | shown | |
| Zoning classification + legal-nonconforming flag | shown | shown | Property fact. |
| FEMA/flood **zone chip** (neutral) | shown | shown | |
| Flood/hazard **risk framed as lender/insurance concern** | hidden | shown | Same data, staff-only framing. |
| Valuation summary + 3 approaches + reconciliation | shown | shown | |
| Value-basis banner ("ARV, subject to completion") | shown | shown | Trust-critical for both. |
| Comps: table + map + adjustment grid + indicated range | shown | shown | |
| Comp compare / isolate / remove | shown | shown | Read-only exploration. |
| **Net/gross-adjustment quality FLAGS** | soft | shown | Borrower: neutral "within/above typical range"; staff: exact %s + risk call. |
| Neighborhood & market trends (KPI row, trend line) | shown | shown | |
| Rent schedule / market vs actual (1025) | shown | shown | |
| Cost approach (1004) / Income-GRM (1025/1073) | shown | shown | |
| HOA / condo project data (1073) | shown | shown | |
| Appraiser identity + license + effective date | shown | shown | |
| **Confidence/quality score** (property-rigor framing) | shown | shown | |
| **Underwriting confidence sub-scores** (deal-risk framing) | hidden | shown | |
| Extraction provenance line (light) | shown | shown | "Generated by PILOT from the appraisal XML." |
| **Detailed provenance / per-field reliability internals** | hidden | shown | |
| Exhibits grid + **original appraisal PDF** download | shown | shown | |
| **Capital-partner / note-buyer names, program internals** | hidden | shown | Borrower: "Gold Standard program." |
| **Exclusionary-list / KYC / watchlist checks** | hidden | shown | |
| **Encumbrance / lien / mortgage / foreclosure history** (B3, later) | hidden | shown | |
| **Corporate-ownership graph** (B17, later) | hidden | shown | |
| Ownership / deed / tax-assessment history (B1/B2, later) | shown | shown | Public-record property facts — OK for both. |
| Staff internal notes / sign-offs / sync flags | hidden | shown | |

Legend: shown = visible · hidden = not rendered · soft = shown with softened, property-only framing.

**Implementation shape (recommended):** one report schema; every field/section tagged with an `audience` of
`both` / `staff` / `borrower-soft`. The renderer filters by the viewer's resolved role, and the **share-link
type stamps the profile** (a borrower link can *never* resolve to the staff profile, even if a staff member
opens it — the token, not the session, decides). This mirrors PILOT's existing `borrower_label`/`label`
checklist pattern (borrower-facing vs internal copy) — reuse that mental model.

---

## 4. Export spec — branded PDF/print that stays premium on paper

Builds on prior doc §7 (cover page, `@page` header/footer, break rules, embedded fonts, static charts). New
detail below. Two exportable artifacts, offered together: **(1) the PILOT report as a branded PDF**, and **(2)
the original appraisal PDF** alongside it.

### The PILOT branded PDF

- **Render method:** server-side HTML->PDF of the *same components* (headless Chromium / print engine), driven by
  a dedicated `@media print` + `@page` stylesheet — **not** a screenshot and not a separate template, so the PDF
  can never drift from the screen. Optimize per HTML-to-PDF best practice: inline/embed fonts, pre-rasterize
  charts, avoid unsupported CSS. ([optimizing HTML for PDF](https://pdfbolt.com/blog/optimizing-html-for-pdf),
  [print-CSS cheatsheet](https://www.customjs.space/blog/print-css-cheatsheet/),
  [designing for print w/ CSS](https://www.smashingmagazine.com/2015/01/designing-for-print-with-css/))
- **Audience-aware export:** the PDF respects the §3 profile — a **borrower PDF** omits every staff-only
  section; a **staff PDF** is complete. The generator takes the profile as a parameter so the same pipeline
  emits both. The share-link/download button carries the profile.
- **Cover page:** PILOT lockup, hero photo, address in Fraunces, As-Is/ARV headline values, effective date,
  **"Prepared for {borrower}" / "Prepared by {loan officer}, PILOT by YS Capital,"** confidence chip.
  `break-after: page`; suppress running header/footer on the cover via `@page :first`.
- **Running header/footer** (`@page`): small PILOT mark + property address (header); **page X of Y**, effective
  date, and a subtle **"PILOT — Confidential"** watermark (footer). Distinct first-page rule for the cover.
- **"Prepared by" line + disclaimers:** appraiser credential block reproduced; a closing page carries the
  **provenance line** ("Extracted by PILOT from the appraiser's MISMO appraisal XML on {date}; original PDF
  attached") and the required **business-purpose / non-consumer disclosure** already used in PILOT emails
  (regulated YS Capital identity + NMLS #2609746 lives in the footer/last page, PILOT co-brands the header).
- **Print rules that keep it premium:** `break-inside: avoid` on tiles/cards/comp rows/charts/appraiser block;
  `break-before: page` before Valuation, Comps, Market, Exhibits; embed Fraunces + Hanken Grotesk; charts/maps
  as crisp static SVG/raster at print DPI (static map tile snapshot); white page with **Paper `#F6F3EC` reserved
  for accent bands** (ink cost / muddy printers); comps table + full adjustment grid on their own **landscape**
  page so nothing clips; neutralize floats so breaks fire.
- **Watermark discipline:** confidentiality watermark on staff PDFs; on borrower PDFs prefer a lighter "Prepared
  for {borrower}" footer over a heavy CONFIDENTIAL stamp (it's their document).

### Exporting the source appraisal PDF alongside

- A prominent **"Download original appraisal (PDF)"** action in the Exhibits section and in the export menu —
  streamed through PILOT's authorized document pipeline (same auth check as any document download).
- **Bundle option:** "Export report + appraisal" produces a two-file download (or a single merged PDF: PILOT
  report first, original appraisal appended) so a partner/borrower gets the polished summary **and** the source
  of record in one action — the audit-trail move that signals the report is *backed by*, not *replacing*, the
  appraisal.
- The original PDF is **byte-for-byte the appraiser's file** — never re-rendered or re-branded (it's the
  system-of-record document).

---

## 5. What makes it feel "$M-built" — the craft moves

The difference between a template and a product people believe cost millions is **restraint executed
precisely**: one motion system, one type voice, photography treated as content, and honest, designed
empty/loading states. Motion research is blunt about it — *"motion should be like salt: just enough to bring
out the flavor, never enough to overpower,"* and micro-interactions "signal care… tiny details that say we give
a damn." ([SaaS motion design](https://www.eloqwnt.com/blog/motion-design-for-saas-growth),
[micro-interactions](https://www.saasframe.io/blog/micro-interactions-the-small-design-details-that-make-a-big-difference),
[micro-interactions 2025](https://www.stan.vision/journal/micro-interactions-2025-in-web-design))

**The top craft moves, in priority order:**

1. **One editorial type system, ruthlessly applied.** Fraunces for display + one dominant number per section;
   Hanken for everything else; **tabular/monospace figures** for all money and measurements so columns align to
   the decimal. Big number, small label — the URAR "Summary leads" move. This alone separates premium from
   form-like.
2. **A single, quiet motion system.** ~150–250ms ease-out transitions; content **fades/rises in on scroll**
   (staggered by ~40ms), charts **draw once** on first view (bars grow, line traces), the map pin the row is
   hovering **lifts**. No bounce, no parallax, no autoplay. Respect `prefers-reduced-motion` (kill all of it).
   Snappy-vs-smooth matters: *smooth, slow fades read premium.*
3. **Photography as a first-class citizen.** Full-bleed hero with an Ink gradient scrim; magazine lightbox;
   consistent aspect-ratio crops; **never an unlabeled thumbnail strip**; graceful placeholders for missing
   categories (many files lack interior/rear shots) instead of broken frames.
4. **Data-density balance via progressive disclosure.** Summary/answer on top, "expand for the full adjustment
   grid / all photos / all comps" underneath. Skimmable but complete. HouseCanary explicitly *consolidated data
   into tabular sections to cut scrolling* — density is earned, not dumped.
5. **Designed empty & loading states.** **Skeleton screens** shaped like the real cards (not spinners); honest
   empty states ("No interior photos in this appraisal") in Fraunces with a quiet icon — never a broken frame or
   a raw "null." A premium product looks composed *before* the data lands.
6. **Micro-interactions that confirm, not decorate.** Hover a comp row -> its map pin highlights and vice-versa;
   copy-address gives a tiny check; sort re-orders with a soft settle; a value tile shows the full figure on
   hover. Each one *confirms an action* — that's the "we give a damn" signal.
7. **Trust cues as quiet, consistent chrome.** One badge style, one uncertainty marker (a subtle dot +
   tooltip), reused everywhere: license-verified, effective-date recency, confidence score, per-field
   uncertainty. Over-badging reads anxious; a single consistent system reads credible.
8. **Accessibility as craft, not compliance.** Every chart degrades to a labeled table; color is never the only
   signal (deltas carry an arrow + sign, not just Teal/red); AA contrast on Paper (footer links go the deeper
   teal `#256168` for AA on white, matching PILOT email tokens); full keyboard nav on the lightbox, map, and
   comp compare; visible focus rings in Gold; `alt` text from photo category labels.
9. **Numbers that never lie about certainty.** Inferred/narrative-derived figures carry the uncertainty marker;
   the value-basis banner states As-Is vs ARV plainly. Honesty about extraction confidence is itself the premium
   move — the opposite of a template that presents everything as equally hard fact.
10. **Cohesion across screen <-> print <-> share.** The PDF, the shared link, and the on-screen report are visibly
    the *same designed object* (same type, color, lockup, section order). That one-system feeling — on a phone,
    on a partner's printout, in a shared link — is what "$M-built" actually looks like.

---

## Sources (new to this doc)
- ATTOM property data — https://www.attomdata.com/data/property-data/
- ATTOM ownership data — https://www.attomdata.com/data/property-ownership-data/
- ATTOM data overview 2026 (Dwellsy) — https://blog.iq.dwellsy.com/attom-data-overview-2026-property-ownership-and-market-data-explained/
- ATTOM Property Navigator — https://www.attomdata.com/solutions/property-navigator/
- HouseCanary Data Explorer — https://www.housecanary.com/products/data-explorer
- HouseCanary API reference — https://api-docs.housecanary.com/
- HouseCanary HPI/RPI — https://www.housecanary.com/products/hpi-rpi-data
- HouseCanary Property Explorer — https://www.housecanary.com/products/property-explorer
- CoreLogic RiskMeter — https://riskmeter.corelogic.com/
- CoreLogic neighborhood crime (Databricks) — https://marketplace.databricks.com/details/39b2899c-6c20-4f47-83bb-b5023c4d8aee/CoreLogic_Neighborhood-Crime
- Reonomy CRE database guide — https://www.reonomy.com/resources/commercial-real-estate-database/
- Black Knight × Reonomy (PRNewswire) — https://www.prnewswire.com/news-releases/black-knights-extensive-property-data-to-enrich-reonomys-leading-commercial-real-estate-platform-300891708.html
- First American sales-comparables sample report — https://dna.firstam.com/solutions/property-data/property-reports/sales-comparables-report-sample
- SaaS motion design — https://www.eloqwnt.com/blog/motion-design-for-saas-growth
- Micro-interactions (SaaSFrame) — https://www.saasframe.io/blog/micro-interactions-the-small-design-details-that-make-a-big-difference
- Micro-interactions 2025 (Stan Vision) — https://www.stan.vision/journal/micro-interactions-2025-in-web-design
- Optimizing HTML for PDF (PDFBolt) — https://pdfbolt.com/blog/optimizing-html-for-pdf
- Print CSS cheatsheet — https://www.customjs.space/blog/print-css-cheatsheet/
- Designing for print with CSS (Smashing) — https://www.smashingmagazine.com/2015/01/designing-for-print-with-css/
