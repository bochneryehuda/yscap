# Comparable-sales / CMA / property-report systems — what the established products actually do, and what we should build

*Competitive research, 2026-08-03. Written for the PILOT comparable-sales product
(`docs/PROPERTY-COMP-DATABASE-RESEARCH.md`, `db/409`–`db/425`,
`src/lib/research/*`, `/internal/research/*`).*

**Read §1 for the baseline, §5 for the answer.** §2 is the teardown, §3 is the
pattern, §4 is the honest list of what does not apply to us, §6 is what a data
partner would cost.

**Standing discipline for everything in here:** *never fabricate — if the data
does not say it, say nothing.* Every feature in §5 carries a `(e) trap` line
naming the place it would tempt a guess.

---

## 0. METHOD AND SCOPE

Twenty-eight products were surveyed across four categories, against six questions
each:

1. What can the comp SEARCH specify?
2. How are comps RANKED or scored?
3. How are ADJUSTMENTS handled — auto-derived, paired sales, regression, typed?
4. What does the REPORT look like, and what sections does it have?
5. What MAP / geography features exist?
6. What CONFIDENCE / QC signals are shown, and what happens on thin data?

Sources are listed inline and collected in §8. Where a vendor publishes no price,
that is stated rather than estimated. Where a claim comes from a marketing page
rather than documentation, it is marked.

**What our warehouse is, stated once so the rest of the document can lean on it:**
PILOT holds only properties that appeared in an appraisal *we paid for* — roughly
**7% of a typical town**, concentrated in the two or three markets we lend in
(`docs/research/WHERE-THIS-IS-GOING.md` §2). Any feature below that assumes
MLS-completeness is flagged **[NEEDS DATA PARTNER]** with a vendor and a cost.

---

## 1. WHAT WE ALREADY HAVE — the baseline this is measured against

Read this before §5, or half the recommendations will look like things we have.

### Built and working

| Capability | Where |
| --- | --- |
| One row per real-world property, deduped on a pure offline key | `property-key.js`, `properties` |
| Immutable per-report ledger (what ONE appraiser said on ONE date) | `property_observations` |
| Distinct transactions, incl. a comp's *prior* sale and the subject's prior sale | `property_sales` |
| Photos linked to the property they show | `property_photos` |
| Appraiser registry, licence-keyed, with every contact ever seen | `appraisers` + 2 child tables |
| Full-text address search (tsvector + GIN, word-order-free, prefix) | `search.js` |
| ~40 filters: state/city/zip/county, type, units, beds, baths (`baths_total`), GLA, year, rooms, price, **tax**, lot, condition + quality as **ordinal ranks**, sale date / window / status, SFHA, ADU, attic, property rights, occupancy, rent, has-unit-mix, has-photos, condo project | `search.js` |
| **True map distance** — bounding box on indexed lat/lng + haversine refine, longitude delta widened by `1/cos(lat)`, circle cut **in SQL** | `search.js` |
| Facets in the same round trip | `search.js` |
| Subject-anchored comp search from a property, a loan file, **or a typed address** | `GET /api/research/comps` |
| **Relaxation ladder** that says which rung produced the answer | `/comps` RUNGS |
| **Coverage denominator** — "we hold N properties in this town at all" | `/comps` coverage |
| Comp score 0–100 **with a separate coverage %** — unknowns leave the denominator | `valuation.scoreComp` |
| 18-line URAR sales-comparison grid, snapshot-not-reference | `valuation.js`, `db/410` |
| Adjustment suggestions derived from our own closed sales, **that refuse** on small samples or a wrong-signed answer | `deriveMarketRates`, `suggestAdjustments` |
| Weighted reconciliation `1/(1+gross%)²`, 12-month half-life, listings at half | `reconcile` |
| Confidence **label** with reasons (never a fake percentage) | `confidenceOf` |
| Review warnings (15% net / 25% gross / 10% line / 12mo / 1mi / 25% GLA / 3-comp floor), worded as **our** opinion | `THRESHOLDS`, `compWarnings` |
| Geocoding, keyless (US Census → OSM Nominatim), stored `geo_*` + generated `eff_*` | `geocode.js`, `db/412` |
| 1004MC market series, with the form's **relative** windows resolved to real dates | `market.js`, `db/449` |
| Duplicate detection + human-confirmed merge | `property-merge.js`, `db/419` |
| Standalone XML upload door (no loan file needed) | `xml-import.js`, `db/411` |
| A comp's **contract date** (UAD `c MM/YY`), going forward | `db/425` |

### Not built

- **No map.** Distance is computed and displayed as a number; there is no picture.
- **No PDF.** `StaffValuation` calls `window.print()` with a stylesheet. There is
  no paginated, branded, per-comp-detail document. (jsPDF + jsPDF-autoTable are
  already vendored at `web/v2/tools/vendor/` and already loaded server-side by
  `src/lib/esign/application-pdf.js` — so this needs **no new dependency**.)
- **No report versions or layouts.** One screen, one shape.
- **No quick-answer mode.** Every path goes through picking comps by hand.
- **No adjustment corpus.** `property_observations.adjustments` is jsonb; there is
  no `GROUP BY` over it.
- **No flip finder.** `property_sales` holds every transaction; the browse search
  reads only `properties.last_sale_*`, so a house that sold at $250k in 2023 and
  $410k in 2025 is invisible to a "$200–300k in 2023" search.
- **No comp photos in any output** beyond the property detail screen.
- **No appraisal-vs-our-value variance report.**
- **No bracketing check, no conflict detection, no fair-lending distance QC.**

---

## 2. THE TEARDOWN

### 2A. APPRAISAL FORM SOFTWARE AND COMP TOOLS

These are the closest analogue to what we are building, because they are the tools
that produce the *grid* our warehouse is filled from.

---

#### a la mode **TOTAL** (+ **Titan Analytics**, **Comps Database**)

The market leader by installed base.

- **SEARCH.** A local **Comps Database** that accumulates comparables from every
  report the appraiser has ever done, plus MLS imports and "Zap" files. Each record
  keeps sales history, import date, source, images and the full attribute set.
  Filtering is through a "Search IQ" pane plus filter tabs.
  ([alamode KB](https://help.alamode.com/kb/guide/en/comps-database-map-view-BB6NhH4Mg1/Steps/4262610))
- **RANKING.** No published similarity score. Ordering is by the appraiser's own
  filters; selection is manual off the map or the list.
- **ADJUSTMENTS.** Typed on the side-by-side grid. **Titan Analytics** derives
  market-conditions (time) percentages from MLS data and lets the appraiser carry
  the extracted percentage onto each comp, noting the variability in the last
  year's data as the support.
  ([Titan Analytics KB](https://help.alamode.com/kb/guide/en/3010-how-to-use-titan-analytics-in-total-for-fannie-mae-and-freddie-mac-market-analysis-xSyFh0FuZG/Steps/4256967))
- **THE ONE FEATURE MOST WORTH COPYING — the weighted-average / suggested-value
  tool.** The appraiser sets weights either **automatically, from the size of the
  adjustments in the report**, or **manually per comp**; a comp can be **excluded
  from weighting entirely** (a listing included only for bracketing, or one the
  client asked for, should not move the number). It then produces a **chart and
  explanatory addendum text** justifying the weighting.
  ([alamode blog](https://blogs.alamode.com/tech-tip-totals-weighted-average-and-suggested-value-tool))
  *Our `reconcile()` does the same arithmetic already — `1/(1+gross%)²` is the
  automatic weight, a pinned `weight` is the manual one, `include:false` is the
  exclusion. **What we do not have is the chart and the sentence that explains it.***
- **MAP.** Subject as a **red pin**, comps as **blue pins**. Clicking a pin opens a
  "Property Information Balloon" with the address, sale history, image, and six key
  figures (list price, year built, site size, GLA, beds, baths) plus a **tick box**.
  Ticked comps run a **"Comps Marked" counter** and a **Place** button drops them
  into the side-by-side grid. Appraisers can **draw market-area polygons**, combine
  several into one named market, and **save it for reuse**.
- **CONFIDENCE / QC.** None quantified. The addendum text is the defence.
- **THIN DATA.** Widen the polygon or the filters by hand; nothing is automated.

---

#### Bradford **ClickFORMS** + **Redstone Analytics**

The regression-first product, and the only mainstream one that publishes its
statistical method.

- **SEARCH.** MLS-fed (Bradford claims mapping integration across "over 950 MLS
  systems"), with **customisable map polygons** defining the market area.
- **RANKING — the most transferable idea in this whole survey.** Redstone ranks
  candidate comps on **three explicit factors that are shown separately and then
  combined**: **Characteristics Matching**, **Nearness Ranking**, and **Appraiser
  Weighting**. The stated purpose is to "analytically demonstrate how the final
  selection and ranking of comps was derived."
  ([Redstone](https://www.bradfordsoftware.com/redstone/))
  *Our `scoreComp` already returns `parts[]` with a per-factor `earned`/`weight`.
  Nobody sees it.* The missing piece is **Appraiser Weighting** — a human thumb on
  the scale that is recorded as a separate, visible factor rather than hidden
  inside the score.
- **ADJUSTMENTS — regression, refined interactively.** The model runs over
  properties in the subject's market; the user **adds or removes characteristics
  with a click** and sees a **scatter plot plus an accuracy-distribution chart** of
  the model's performance and its statistical output. Adjustment factors in the
  sales-comparison approach then come from the regression result *combined with*
  significant market characteristics *and the appraiser's judgement* — the
  three-way split is stated explicitly in the addendum.
- **TIME ADJUSTMENTS — three named methods**, all off median sale prices: a direct
  monthly adjustment, a **linear-regression** monthly adjustment, and a
  **non-linear** monthly adjustment.
  ([ClickFORMS time adjustments](https://support.bradfordsoftware.com/docs/CF-Time-Adjustments.pdf))
- **REPORT.** Redstone emits an **addendum** — comp rankings **with photos
  auto-transferred**, an **auto-generated 1004MC addendum with trend charts and
  interpretive commentary**, and market-area map visualisations. Importable as PDF
  or pasted directly into ClickFORMS.
- **CONFIDENCE / QC.** The regression's own statistical output (fit, accuracy
  distribution).
- **THIN DATA.** *Not addressed in the published documentation.* This is the
  standing weakness of every regression product and the reason we should not build
  one (§4).

---

#### **ACI** (ACI Report, ACI Sky Workbench, ACI Sky Data)

- **SEARCH.** ACI Sky Data gives in-report access to a national repository powered
  by **First American public-record data**, included with membership; MLS data is
  imported natively or via a CSV/TXT/TAB/XLS export from the MLS's own search. The
  "Research" tool searches on several field parameters, shows **full comps with
  thumbnail photos**, and imports **comps and photos together** into the form —
  and, notably, **exports comps and photos back out of a report into Research**.
  ([ACI Sky Workbench](https://www.aciweb.com/appraisers/workbench/))
  *That last direction — the report populating the comp database — is exactly what
  our ingest does, and ACI is the only surveyed product that does it explicitly.*
- **ADJUSTMENTS.** Typed. No published derivation engine.
- **MAP.** ACI Sky Maps.
- **THIN DATA / QC.** Nothing published.

---

#### **SFREP Appraise-It Pro** (Comp Manager, Image Manager)

- The pitch is **"software by appraisers for appraisers — we do not collect your
  data"** ([appraisersblogs](https://appraisersblogs.com/appraisers-can-trust-SFREP-no-data-collection/)),
  which is a real market position worth noting: appraisers actively resent their
  comp data being harvested.
- **Comp Manager** collects and organises comp information **and photos** with
  automated indexing and filing; **Image Manager** drags images into reports.
- No published ranking, derivation, confidence or thin-data behaviour.
- *Relevance to us: Appraise-It is one of the vendors in our own corpus (it numbers
  comp photos globally as `Sales Comp N - Photo`, and skips comp seq 6 — both
  already handled in `photo-meta.js` and `extract.js`).*

---

#### **Anow** (+ Reports Now **CompVault**)

- Primarily **order/workflow management** — calendar, map, email, invoicing,
  financial analytics, custom workflow templates, real-time order visibility with
  exception management.
- **CompVault** — "store and share comparables securely" — plus **Smart UAD Rules**
  to eliminate errors and a **built-in compliance checker**.
  ([Anow](https://anow.com/))
- *Two ideas land here: a comp store that is explicitly **shared across a team**
  (which is what our warehouse is), and a **compliance/rule checker that runs over
  the finished product** (which is what our `compWarnings` is, unsurfaced).*

---

#### **Spark**

- Imports MLS listings **and public records**, applies **custom filters** to find
  comparable sales, and the dashboard visualises **market trends, cost-approach
  data, and interactive CMA charts**. Web-accessible, subscription, free tier.
  Reported saving of up to an hour per report from **batch import** and trending
  tools.
  ([McKissock](https://www.mckissock.com/blog/appraisal/appraisal-software-tools-streamline-process/))
- *The transferable bit is **batch**: one action that pulls a whole candidate set
  in, rather than a comp at a time.*

---

### 2B. DATA / AVM / ANALYTICS VENDORS

These are the products a lender buys when it wants an answer without a human.

---

#### **HouseCanary** (Agile Suite, Property Explorer, `comps_sale` / `comps_rental`)

- **SEARCH / RANKING — the cleanest published comp-ranking design.** Property
  Explorer selects **up to 500 comparables** per subject and orders them by a
  **proprietary similarity score on a 1–100 scale**. The API endpoints
  `comps_sale` and `comps_rental` return the same ordering programmatically.
  ([HouseCanary](https://www.housecanary.com/blog/property-explorer-quick-start-guide),
  [API docs](https://api-docs-legacy.housecanary.com/))
- **ADJUSTMENTS — fully automatic.** Every comp's sale value is adjusted by
  comparing it to the subject on location, square footage, rooms, lot size, pools,
  basements and other characteristics. The explicit pitch is that this **"removes
  human bias."**
- **The methodological claim worth quoting internally:** machine learning weights
  comparable sales **by relevance rather than only by proximity and recency.**
  That is the exact critique of our `scoreComp`, whose two largest weights (25 + 25
  of 100) are distance and recency.
- **REPORT.** Custom Valuation Reports and AVM PDF reports; a web app plus API.
- **CONFIDENCE.** Score plus value range (see FSD below — the industry standard).
- **PRICE (published, 2026).** Basic **$190/yr** (2 valuation reports/mo); Pro
  **$790/yr** (15 valuation + 15 AVM reports/mo, API access); Teams **$1,990/yr**
  (10 users, 40 + 40). Per unit: **custom valuation report $9–12**, **AVM PDF
  $7–10**, **basic API call $0.30–0.50**, **premium $2.50–4**, **premium-plus
  $4–6**, **property-estimate API $0.05/call**, **portfolio monitoring
  $0.35–0.45/property/month**.
  ([HouseCanary pricing](https://www.housecanary.com/pricing))
  *This is the only vendor in the survey with usable published unit economics, and
  at **$0.05 per property estimate** it is the realistic candidate for a coverage
  partner (§6).*

---

#### **Clear Capital** — ClearAVM, ClearCollateral Review / AURA, **CDA**

- **CONFIDENCE — the industry's standard vocabulary, and we should adopt the
  *honesty*, not the number.** ClearAVM publishes **FSD (Forecast Standard
  Deviation)** — the predicted error of the valuation — and a **Confidence Score =
  1 − FSD** (FSD 0.01 → 99% confidence; FSD 0.5 → 50%), plus a **"Confidence within
  10%"** metric.
  ([Clear Capital glossary](https://www.clearcapital.com/resources/glossary-of-terms/fsd-forecast-standard-deviation/))
- **THIN DATA — stated plainly, and this is the sentence to copy.** *"A lower
  confidence score occurs when there is a lack of similar properties, inconsistent
  sale prices for similar properties, or missing property information."*
  ([Clear Capital](https://www.clearcapital.com/analytics/clear-avm/))
  Three distinct causes, named separately. Our `confidenceOf` already reasons over
  comp count, agreement and adjustment size — the same three — but does not name
  **missing property information** as its own cause.
- **RANKING.** "Comp-ranking algorithms **trained by millions of appraisals**" —
  i.e. the model learns what appraisers picked. *Which is precisely the sample-bias
  problem `WHERE-THIS-IS-GOING.md` §3 says disqualifies us from doing the same at
  our volume. Clear Capital gets away with it because their corpus is national and
  ours is one lender's book.*
- **REPORT — the three-page shape is the best template we found for a short
  product.**
  ([Clear Capital](https://www.clearcapital.com/announcing-an-enhanced-clearavm-report-with-valuable-new-insights/))
  1. **Property overview** — street view, neighbourhood map, the estimate, the
     **value range**, the FSD confidence score, property characteristics **from
     multiple sources**, and **listing event history**.
  2. **Comparable analysis** — the ranked comps.
  3. **Aerial context** — aerial view of the subject **with nearby comparables**.
- **CDA (Collateral Desktop Analysis) — this is the exact product shape our owner
  is describing, sold as a service.** A licensed appraiser reviews someone else's
  appraisal desktop-only and returns: **a value conclusion, the variance from the
  appraised value, a risk level, a recommended next action, and eligibility
  issues — all front-and-centre**, with commentary on market conditions, subject
  analysis, **sale and listing history analysis**, appraisal analysis and
  deficiencies, market sales analysis, and a review conclusion. Risk Score
  (Low/Medium/High) is driven by **variance, data discrepancies, and report
  deficiencies**. Many lenders require the CDA to land **within 10%** of the
  original appraisal.
  ([CDA datasheet](https://www.clearcapital.com/wp-content/uploads/2021/02/Clear_Capital_CDA_Datasheet__1_.pdf),
  [OfferMarket](https://www.offermarket.us/blog/collateral-desktop-analysis))
- **PRICE.** CDA reported at **$90–$250 per report** depending on lender and
  programme (one lender bulletin cites $165).
  ([BiggerPockets thread](https://www.biggerpockets.com/forums/22/topics/948961-collateral-desktop-analysis-cda-fee))
  *That is the price of the thing we would be replacing in-house on files where we
  already hold the data.*

---

#### **CoreLogic / Cotality** — RealQuest, Matrix, Realist, Total Home ValueX

- **The AVM cascade.** Lenders blend **multiple AVMs** in a ranked cascade to
  maximise accuracy *and hit rate* — i.e. when the best model declines to answer,
  the next one is tried. Total Home ValueX is positioned against that as a
  **single-model** AVM for the whole loan lifecycle.
  ([CoreLogic](https://www.corelogic.com/products/geoavm-cascade-suite.aspx))
  *The cascade idea is directly applicable to us as a **source cascade**, not a
  model cascade: our own warehouse first, a purchased feed second, and say which
  one answered.*
- **Matrix 360 CMA + Realist.** Within Matrix's CMA you can select a **Non-MLS
  Sale** status to bring in **public-record (Realist tax) comparables** alongside
  MLS ones. Realist is also used to **verify square footage and property age**
  against public record.
  ([CRMLS KB](https://kb.crmls.org/knowledgebase/matrix-360-cma/))
  *Two sources, labelled, in one grid — the pattern we would need the day we add a
  data partner.*
- **PRICE.** Not published; enterprise quote.

---

#### **ATTOM Data**

- 158M+ US properties, ~30bn transactional rows, 7,200+ attributes; bulk licensing
  hosts the dataset **on your own servers**.
  ([ATTOM](https://www.attomdata.com/solutions/bulk-data-licensing/))
- **PRICE.** Quote-based and tiered by package, call volume and licence term.
  Third-party reports put API entry around **$95–500/month** for modest volumes and
  "generally high" beyond; the only published figure is Property Navigator at
  **$499/yr**.
  ([Datarade](https://datarade.ai/data-providers/attom/profile),
  [zillapi](https://zillapi.com/blog/attom-api/))

---

#### **First American DataTree**

- Property research + a **Sales Comparables Report** product, sold à la carte or on
  prepaid monthly subscriptions from the online store; enterprise pricing is
  sales-led. Reported partner plans at **$97 / $147 / $197 per month**; one vendor
  benchmark puts average enterprise spend near **$30,500/yr**.
  ([DataTree](https://dna.firstam.com/solutions/property-data/datatree-property-research),
  [Vendr](https://www.vendr.com/buyer-guides/first-american-data-analytics))
- *Note the ACI relationship: ACI Sky Data is First American public record. If we
  ever buy public record, we would be buying the same spine our appraisers' own
  software already sits on.*

---

#### **Black Knight / ICE — Collateral Analytics, CA Risk Profiler Plus**

- **The single most directly copyable QC feature in the survey.** CA Risk Profiler
  Plus evaluates **the appraiser's selected comparables against a list derived from
  its own national property database**, and **flags comparables that are
  geographically distant from the subject or located in a census tract with a
  dissimilar demographic composition** — the second being an explicit
  **fair-lending / appraisal-bias** control.
  ([Black Knight press release](https://www.blackknightinc.com/press-releases/black-knight-introduces-ca-risk-profiler-plus-to-help-lenders-and-appraisers-identify-potential-minority-bias-in-collateral-valuation/))
  *The "compare against our own model comps" half needs a complete universe and is
  out of reach. **The "flag a comp that crosses a boundary" half needs nothing but
  a census-tract lookup, which is free from the same US Census service we already
  geocode with.***

---

#### **Reonomy** (Altus) — commercial, included for the search UX

- **200+ filters**; search by address, submarket, **owner name or LLC**, property
  type; an interactive map where you **zoom, or draw a radius or a focal point**.
  Ownership records resolve the individuals behind an owning LLC. 54M+ properties.
  ([Reonomy](https://www.reonomy.com/platform/research))
- *Only one idea transfers: **search by owning entity**. We already store an
  owner-of-record on the observation, and a fix-and-flip lender absolutely does
  want "show me every property this LLC has touched."*

---

#### **Plunk**

- 104M homes, real-time valuation, **remodel value** ("the future, fully-remodeled
  value of a home") and **project recommendations by ROI**, risk assessment
  (including climate), and **the ability to correct or update up to 31 attributes
  of a home to play 'what-if' and get an immediate refined value**.
  ([Plunk](https://www.getplunk.com/what-we-do))
- *Two ideas: (1) an explicit **remodel/after-repair value** as a first-class
  output — which is our whole business and nobody else in the survey names it that
  way; (2) **correct the facts and re-value instantly**, which is the RPR "Refine
  Value" pattern below and is exactly what our officers need when the warehouse's
  rolled-up facts are stale.*

---

#### Fannie Mae **Collateral Underwriter** (not for sale, but it sets the vocabulary)

- **Risk score 1–5** plus a list of **risk flags** and notes on where additional
  review is needed.
- **A comp-selection model.** CU gathers the **20 closest, most similar sales**,
  ranks them **M1..M20**, and compares them to what the appraiser used. Practitioner
  guidance is that the best appraisals contain **3 of CU's top 5 model comps**. The
  characteristic flag is *"the appraiser-provided comparables are materially
  different than the model-selected comparables."*
  ([McKissock FAQ](https://www.mckissock.com/blog/appraisal/fannie-maes-collateral-underwriter-program/),
  [Appraisal Buzz](https://appraisalbuzz.com/appraisers-know-collateral-underwriter/))
- **ADJUSTMENTS — the crucial design decision, and the one we can actually copy.**
  CU does **not** apply the old 15%/25% caps. It compares an adjustment **against
  what other appraisers did on similar properties**. That is a peer benchmark, not
  a market claim — and it is defensible at our volume in a way that a market claim
  is not.
- **THIN DATA.** CU answers **"cannot score"** in thin markets. *If Fannie declines
  on thin data with the entire national appraisal corpus behind it, our refusing is
  not a weakness — it is the same answer.*

---

### 2C. AGENT-SIDE CMA BUILDERS

Weakest analytics of the four categories, **strongest report craft.** That is where
the value is for us.

---

#### **Cloud CMA** (Lone Wolf)

- **Four report sets**: a **CMA**, a **Buyer Tour**, a **single Property Report**,
  and a **Property Flyer** — four layouts over one data set, chosen by audience.
  ([Lone Wolf](https://community.lwolf.com/s/article/CCMA-About-Reports))
  *This is the "multiple report versions/layouts" the owner asked for, and the
  design lesson is that the versions are **by audience**, not by detail level.*
- **Every report carries a personalised cover page, the agent/broker resume, and
  company branding.** The Property Report is pitched as "in-depth information about
  a property at a glance… with very little effort on the part of the agent."
- **Buyer Tour** carries per-property photos, loan info, neighbourhood and school
  information, a **Walk Score**, and an **online valuation summary**.
- **Live CMA** — an interactive screen-shared presentation that switches between
  comps, photos, pricing and strategy.
  ([CRMLS KB](https://kb.crmls.org/knowledgebase/cloud-cma-creating-a-cma/))
- **ADJUSTMENTS / CONFIDENCE / THIN DATA.** Essentially none. This is a
  presentation layer over MLS data.

---

#### **RPR** (Realtors Property Resource) — **the best adjustment UX in the survey**

- **Two tiers, deliberately.** A quick **CMA** and an **Advanced CMA** that "allows
  you to make precise value adjustments and weight your comps." Both follow the
  same four steps: **confirm the property facts → choose comps → make adjustments →
  review the result.**
  ([RPR](https://blog.narrpr.com/support/how-to-create-a-cma-comp-analysis/))
  *Those four steps are the correct spine for our own screen, and step 1 —
  **confirm the facts** — is the one we skip entirely.*
- **THE SLIDER.** Beside the dollar-adjustment fields there is a **slider you move
  left or right to say a comp is worse or better than the subject**, which changes
  the **price per square foot** applied when calculating the estimate.
  ([RPR Adjust Comps](https://blog.narrpr.com/support/how-do-i-create-a-sales-comparison-analysis/))
  *A non-appraiser can use that. A 20-line dollar grid, they cannot. For a loan
  officer doing a five-minute sanity check, this is the right control.*
- **Refine Value — four separate routes**, each a different kind of claim: refine by
  **basic facts**, by **home improvements made**, by **needed improvements**, and by
  **market and home conditions**.
  ([RPR Refine Value](https://blog.narrpr.com/support/how-do-i-change-the-estimated-value-refine-value-tool/))
  *"Needed improvements" is the as-is-vs-ARV distinction in a Realtor's vocabulary,
  and it is a hard-money lender's entire product.*
- **RVM®** — the Realtor Valuation Model, an AVM that adds **MLS listing and sales
  data** on top of public record. Comps that feed it are **marked with a blue
  star** — the model shows its own inputs.
- **CONFIDENCE / THIN DATA.** RVM carries a confidence score; not otherwise
  addressed.

---

#### MLS CMA modules — **Matrix 360**, **Paragon (EasyCMA)**, **Flexmls**

- **Flexmls** has three CMA types; the core is a **traditional 3-up side-by-side
  adjustment grid, sortable by status**, with a **display-options checkbox list**
  controlling exactly which items appear on the report.
  ([Flexmls Help](https://help.flexmls.com/en/cma-types.html))
- **Adjustments tab** — per-comp dollar adjustments, with the worked example
  literally being *"if a bedroom is valued at $2,000 and the subject has one more
  bedroom than the comparable, adjust the comparable by +$2,000."*
  ([Flexmls Adjustments](https://help.flexmls.com/en/adjustments-tab--cma-.html))
- **A "Summary of Adjustments" report page appears only if adjustments were
  actually made**, and there is an **individual adjustment summary per listing** —
  a breakdown of every adjustment on that one comp.
  ([Flexmls Finish tab](https://help.flexmls.com/en/finish-tab--cma-.html))
  *Both are directly copyable: **sections that hide themselves when empty**, and a
  **per-comp adjustment page** — which is exactly the owner's "full detail on every
  comp used."*
- **Matrix 360** — CMA with **Realist public-record comps** selectable alongside MLS
  ones.
- **CONFIDENCE / THIN DATA.** None.

---

#### **Moxi Present**

- **Five presentation types out of the box**: Seller, Property Review, Buyer Tour,
  Buyer, Non-Listing — plus Annual Property Reviews and Open Houses.
  ([MoxiWorks](https://support.moxiworks.com/hc/en-us/articles/209561846-Starting-a-New-Presentation))
- **Page-based composition.** Listing data renders into **Report Pages**; *if the
  page is not in the presentation, the data is not in the presentation.* Page types
  include **scattergraphs of market and trend data**, maps, rich content, and a
  **net-proceeds page**.
  ([MoxiWorks](https://support.moxiworks.com/hc/en-us/articles/360037927492-Add-Report-Pages-to-Your-Presentation))
  *This is the right architecture for "multiple report versions": **a library of
  page types, and a layout is an ordered list of pages.** Not four hard-coded
  templates.*
- Comps can be **edited on the fly** during the conversation — removed, added,
  adjusted.

---

#### **Toolkit CMA**

Same family; report-builder over MLS data with branded, printable presentation
output. Nothing methodologically distinct from the above.

---

### 2D. INVESTOR TOOLS AND LENDER COMP DESKS

This is our actual customer, and the category with the ideas nobody else has.

---

#### **Privy** — *the closest thing to what a fix-and-flip lender needs*

- **THE HEADLINE IDEA, and it is the one we can beat everyone at.** Privy's
  "Intrinsic" algorithm **returns comps based on potential value as a flip** — i.e.
  it distinguishes **investor comps from retail comps** — and determines both the
  **as-is value and the ARV**.
  ([Privy](https://www.privy.pro/product/privy-the-ultimate-real-estate-investment-tool/))
- **LiveCMA** analyses existing MLS and off-market listings **against closed
  investment deals**, showing **side-by-side before-and-after data, photos and
  timelines on comps and historical flips**.
  ([Privy](https://www.privy.pro/real-estate-markets/))
  *Before-and-after, with photos and a timeline. **We hold exactly this and have
  never shown it** — a property that appeared as a C5 as-is comp in 2024 and a C3
  ARV comp in 2026, with both appraisers' photos, is a before-and-after we did not
  have to buy.*
- **Deal scoring in plain words, not a number**: **Gold** = flips, **Silver** = lot
  scrapes / re-zoning, **Bronze** = landlord deals.
- Privy also sells **to lenders** explicitly, to "drive transactions and build
  borrower loyalty."

---

#### **PropStream**

- **165+ filters.** Comp defaults are **sold within the last year, within a
  half-mile radius, similar square footage ±20%** — and every one is editable
  (sales date range, sq ft, distance, beds, baths, year built…).
  ([PropStream](https://www.propstream.com/comps-for-real-estate))
  *Note how much tighter those defaults are than ours (18 months, whole town, 0.6×–
  1.6× GLA). Theirs assume a complete data set; ours are wide because we are thin.
  **A defaults set is a statement about your coverage.***
- **A source toggle: MLS data, public-record data, or both.** The user chooses.
- **Output.** An estimate produced as an **average of the results**, and a **comp
  report downloadable as a PDF**.
- **CONFIDENCE / THIN DATA.** None; the average is the answer.

---

#### **BatchLeads**, **DealMachine**, **Mashvisor**

- Lead-generation-first (skip tracing, driving for dollars, owner contact data,
  list building) with comps as a supporting feature. BatchData (the API arm) sells
  the underlying property data — 155M properties, 1bn+ data points.
- **PRICE (published).** BatchData pay-as-you-go from **$0.01/call**; subscriptions
  from **$1,000/mo for 100,000 records** up to **$5,000/mo for 750,000**.
  ([BatchData pricing](https://batchdata.io/pricing))
- **Not a valuation methodology story.** Included for the price point.

---

#### **Rehab Valuator** — the closest thing to our report

- Full flip workflow: **ARV estimation → line-item rehab budgeting → profit/ROI/risk
  projections → funding needs → offer documents**, with **Maximum Allowable Offer**
  computed from ARV, repair cost, financing and profit target.
- **Generates professional, branded PDF reports with itemised repair scopes to
  share with lenders, investors or contractors** — and separately **private lender
  presentations**.
  ([Rehab Valuator](https://rehabvaluator.com/real-estate-deal-analysis-software))
  *This is the artefact our borrowers already send **us**. Our comparable report is
  the lender-side mirror of it, and it should look at least as finished.*
- Nationwide sales **and rental** comps, plus **owner records for both the subject
  and the comparables**.

---

#### Hard-money / RTL lender comp desks — how the competition actually works

- **The method scales with deal size and risk**: full licensed appraisal → desktop
  review → BPO → in some cases no third-party valuation at all.
  ([Ambition Lending](https://ambitionlending.co/appraisal-vs-bpo-what-valuation-youll-get-on-a-hard-money-deal/))
- **Kiavi is the reference implementation of the thing our owner is describing.**
  It **does not require an appraisal**. An **internal valuations team** reviews
  inspection and feasibility reports and analyses sales comps — **sold within the
  last six months and within a one-mile radius** — to set the ARV, assessing **over
  20 factors** per property with proprietary ARV models, cutting **1–2 weeks** off
  the close.
  ([Kiavi](https://www.kiavi.com/solutions/fix-and-flip-strategy),
  [CrowdfundedWealth comparison](https://www.crowdfundedwealth.com/articles/best-fix-and-flip-lender-2026))
  **Lima One, by contrast, requires appraisals and adds 5–10 business days.**
  *That is the competitive stake: an in-house comp desk is worth 1–2 weeks of
  cycle time, and the market already prices that difference.*
- **The ARV rule of thumb the whole industry states**: ARV must come from
  **renovated** comparable sales, roughly **within a mile and the last few months**,
  **not** from an automated value that ignores condition — and *"renovated comps
  should be given the most consideration."*
  ([Park Place Finance](https://parkplacefinance.com/arv-house-flipping-formula/),
  [Kiavi](https://www.kiavi.com/blog/real-estate-comps-to-determine-home-value))
  ***Condition-aware ARV comps is the industry's stated need and everyone's
  admitted weak spot — and it is the one field our warehouse carries natively,
  from the appraiser's own grid, with the ARV/as-is split already recorded.***

---

## 3. THE PATTERNS EVERYBODY SHARES

Nine things almost every serious product does that we do not.

1. **The map is the primary interface, not a number.** Red subject pin, blue comp
   pins, click for a card, tick to select, a counter, one button to place. Every
   appraisal product and every investor product has this. We have a distance column.
2. **The comp score is shown broken into its factors** (Redstone's three; CU's M1–
   M20; HouseCanary's 1–100). We compute `parts[]` and never render it.
3. **A human weight is a first-class, visible input** — TOTAL's manual weight,
   Redstone's "Appraiser Weighting", the RPR slider. Ours exists in the data model
   and has no control.
4. **A comp can be included for bracketing but excluded from the value.** TOTAL says
   so explicitly. We support `include:false`; nothing explains why you would.
5. **Report sections hide themselves when empty** (Flexmls). Nothing prints
   "Adjustments: none."
6. **There is a per-comp detail page**, not just a grid column (Flexmls "individual
   adjustment summary"). That *is* the owner's "full detail on every comp used."
7. **Reports come in named versions by audience**, composed from a page library
   (Cloud CMA's four sets; Moxi's five types + Report Pages).
8. **Two sources in one grid, labelled** (Matrix + Realist; PropStream's MLS /
   public-record / both toggle).
9. **A confidence signal always travels with the number, and the reasons for a low
   one are named separately** (Clear Capital's three causes; CU's "cannot score").

---

## 4. WHAT DOES **NOT** APPLY TO US — the honest list

Do not build these, and do not let a screen imply we have them.

| Their feature | Why it does not transfer |
| --- | --- |
| **An FSD / calibrated confidence percentage** | FSD is the measured error of a model against held-out sales. We have no model and no held-out set. A percentage would be a fabricated statistic. Our `confidenceOf` label is the correct answer and its `basis` string says so. |
| **A comp-selection model (CU's M1–M20)** | Requires the complete universe of sales. We hold ~7% of a town. Our "model comps" would be a sample of a sample. |
| **Regression-derived adjustments (Redstone)** | Needs ~100–200 clean same-segment sales; our busiest town yields ~88 SFR sales/yr at 2,000 appraisals (`INTERNAL-AVM-ROADMAP.md` §1). And the sample is **appraiser-selected**, so a model learns selection behaviour, not the market. |
| **Absorption rate / months of supply / list-to-sale ratio computed by us** | These need every listing. We can only ever **report what an appraiser's 1004MC stated**, with the report count beside it — which is what `market.js` already does correctly. |
| **Days-on-market analytics** | `days_on_market` is text on the observation, present only when the appraiser typed it, and its denominator is unknown. |
| **Owner contact / skip tracing (Reonomy, PropStream, BatchLeads)** | We are not marketing to owners. Also a real GLBA/DNC surface we should not open. |
| **Agent presentation craft (resume page, "why me", Walk Score, school ratings)** | Wrong audience entirely. The *branding and finish* transfer; the content does not. |
| **Automatic property merging / fuzzy dedupe** | Explicitly ruled out (`PROPERTY-DEDUPE-AND-MERGE.md`). A wrong merge corrupts every price-per-foot figure downstream. |
| **Drive-time distance** | Ruled out; straight-line is what the grid uses and what every threshold is stated in. |
| **A second implementation of the comp score** | One definition, `valuation.scoreComp`. A screen that ranks differently from the server is the bug this rule prevents. |
| **Street view / aerial imagery (Clear Capital pages 1 and 3)** | Needs Google/Bing imagery licensing. Our own comp photos are better evidence anyway — they are what the appraiser actually saw. |
| **"Sold in the last 6 months within 1 mile" as a *default*** | Kiavi and PropStream can default that tight because they have everything. On our data it returns nothing most of the time. Our wide defaults + relaxation ladder are the correct adaptation, and the ladder must keep saying which rung answered. |

**And the one regulatory line that must not get lost:** the 2024 interagency AVM
quality-control rule (effective 1 Oct 2025) reaches a mortgage secured by a
**consumer's principal dwelling even when the loan is business-purpose**. A
straight investment flip is out of scope; a borrower living in one unit of the 2–4
they are rehabbing is **in** scope. Nothing in §5 crosses that line as long as the
output **helps a human review** rather than **sizes a loan** — but §5.3 (quick
answer) is the one that sits closest to it and must never be wired into pricing.

---

## 5. WHAT TO BUILD — in priority order

Each item: **(a)** what it is, in one sentence for the owner · **(b)** why it
matters for a hard-money/RTL lender specifically · **(c)** can our data support it
today · **(d)** build size · **(e)** the correctness trap.

> **Product-separation note (CLAUDE.md, non-negotiable):** everything below is
> **RTL**. The research warehouse is an RTL asset. Nothing here may be built for or
> shared with Long-Term without the owner's written authorisation recorded in
> `docs/LONG-TERM-AUTHORIZED-COPIES.md`.

---

### TIER 1 — the owner's literal ask, and all of it is reachable on data we already hold

---

#### 1. **The branded PILOT comparable report (PDF), with a full page per comp**

**(a)** One button that turns a comp selection into a proper printed report with
our logo — a summary page, the side-by-side grid, and then **one full page for
every comp** showing its photo, all its facts, its distance, its sale, and every
adjustment made to it and why.

**(b)** This is the artefact. It is what goes in the loan file, what an investor or
note buyer sees, and what defends a lending decision two years later at a payoff
dispute. Right now `window.print()` produces a screen dump; a borrower sends us a
better-looking Rehab Valuator PDF than we send anyone. Clear Capital charges
**$90–$250** for the three-page version of this and lenders pay it.

**(c)** **Yes, today, with no new data and no new dependency.** Every field is on
`property_valuations` / `property_valuation_comps` snapshots; photos are in
`property_photos`; **jsPDF + jsPDF-autoTable are already vendored** at
`web/v2/tools/vendor/` and already loaded server-side by
`src/lib/esign/application-pdf.js`.

**(d)** **Medium.**

**(e)** **Traps, three.** (1) The report must render from the **snapshot**, never
re-read `properties` — a printed report that stops reproducing is worse than none
(this is already the design; the PDF must not undo it). (2) The **disclaimer must
travel with the number on every page**, not once on page 1 — `valuation.DISCLAIMER`
exists for this. (3) A blank cell must print **"not stated"**, never a dash that
reads as zero and never a value inherited from the subject.

---

#### 2. **The map**

**(a)** A real map with the subject as one pin and every comp as a numbered pin,
with rings at ½, 1 and 2 miles, where you click a pin to see the house and tick it
to use it.

**(b)** "Real geography and true map distance, not just same city" is the owner's
sentence. We compute the distance correctly and then show a number. An officer
arguing that a comp is across a highway, or on the wrong side of a town line, can
only do that on a picture. It is also the single biggest perceived-quality gap
against every product in §2.

**(c)** **Yes, today.** `properties.eff_latitude/eff_longitude` are generated stored
columns; `search.js` already returns them in `LIST_COLUMNS`; `/comps` already
returns `subject_located` and per-row `distance_miles`. **MapLibre GL JS is MIT and
free for commercial use**; base tiles from an OSM-derived provider or self-hosted
OpenMapTiles (BSD/CC-BY) — **no Google, no per-view cost, and no 30-day
coordinate-caching restriction** (which is exactly why `GEOCODING-DISTANCE-VENDOR-RESEARCH.md`
already rejected Google).
([MapLibre/OSM licensing](https://switch2osm.org/using-tiles/))

**(d)** **Medium.** The CSP on our own pages must allow the tile host, or tiles get
self-hosted.

**(e)** **Traps.** (1) A property with **no coordinate must be visibly listed as
"not placed"**, never silently dropped off the map — an officer counting pins would
undercount. (2) The **appraiser's own lat/lng is frequently a ZIP centroid**
(that is why `eff_*` exists and why the duplicate detector is forbidden from using
it) — a pin sourced from `geo_source='appraiser'` must be drawn differently and
labelled *approximate*. (3) Never let the map be a **second implementation of the
radius**: it draws what the SQL already cut.

---

#### 3. **Quick answer mode — "properties like this have been appraising at roughly $X"**

**(a)** Type an address plus five or six basics and get one sentence back: what
properties like this have been appraising at recently, in this condition, in this
area — with the range, how many sales it is based on, and how far it had to look.

**(b)** This is the 30-second triage a loan officer needs on the phone, before
anyone orders anything. Kiavi's whole competitive claim is that an internal desk
saves 1–2 weeks; this is the front door of that desk.

**(c)** **Yes, today — every piece exists.** `GET /api/research/comps` already takes
a **typed** subject, applies comparable defaults, runs the relaxation ladder and
ranks. `valuation.reconcile()` already produces an indicated value, a likely range,
a median, a price-per-foot and a confidence label from a comp set. The missing
piece is one route that composes them and one screen with six boxes.

**(d)** **Small-to-medium** (server: small; the honest wording is the work).

**(e)** **The most dangerous item in this document. Four traps.**
(1) **It must refuse.** Below `THRESHOLDS.minClosedComps` (3 closed sales) it says
*"we do not hold enough sales here to answer"* and shows the coverage count — it
never averages two comps and prints a number. Fannie's CU says "cannot score" on
thin data; so do we.
(2) **It is a range and a count, never a point estimate.** "Roughly $310,000–
$345,000, from 6 closed sales within 1.4 miles in the last 14 months" — never
"$327,412".
(3) **It must say which rung of the ladder answered and what our coverage is**, or
a thin answer reads as a confident one. `/comps` already returns `ladder`,
`relaxed_to` and `coverage`; the screen must render all three.
(4) **It may never be wired into pricing, sizing, or any registration input.** The
2024 AVM rule reaches an owner-occupied 2–4 even on a business-purpose loan, and
the disclaimer (`not an appraisal, not USPAP work product`) must be on the answer
itself, not a footnote.

---

#### 4. **ARV mode — comps the appraisers actually used for after-repair value**

**(a)** A switch on the comp search that says "show me the comps our appraisers put
on the **after-repair** grid" or "on the **as-is** grid", and pre-sets the
condition filter to match.

**(b)** **This is the thing no competitor can do and every one of them wishes it
could.** The whole industry says "ARV must come from renovated comps, not from an
automated value that ignores condition" — and then leaves the investor to guess
which sales were renovated. We do not guess: `comp_set` records which grid the
appraiser put each comp on, and `condition_uad` / `condition_text` record what
condition they said it was in. For a fix-and-flip lender the as-is/ARV distinction
*is* the product.

**(c)** **Yes, today.** `properties.arv_comp_count` / `asis_comp_count` are
denormalised counters with partial indexes; `search.js` already accepts
`comp_set=arv|as_is|unknown`; `property_observations.comp_set` carries it per
observation. The screens do not expose it.

**(d)** **Small.**

**(e)** **Traps, and they are sharp.** (1) **`comp_set='unknown'` is a real answer,
not missing data** (`comp-grid.js`: *"unknown always beats a wrong assignment"*) —
it must be a visible third option, never folded into as-is. (2) On a **single-grid
report every comp is stamped by default**; the fact-coverage audit (F6/T8) flags
that `comp_split_confidence` / `comp_split_needs_review` do not travel to the
observation. **Until they do, an "ARV comps" filter silently includes comps nobody
ever distinguished** — so either carry the confidence onto the observation first
(two columns, no parsing, item 3 in that audit's order of work) or label the filter
result *"as our reports classified them"* and show the count that was defaulted.
(3) `comp_set` **mutates after ingest** (`backfillAppraisalCompSplitOnce` rewrites
it at boot) — the warehouse must be re-ingested when it does, or the filter answers
with the pre-split answer forever (T9).

---

#### 5. **Report versions — a page library, not four templates**

**(a)** Three named reports off the same work — a **full internal file copy**, a
**one-page summary**, and a **partner/investor package** — chosen from a list of
pages you tick on or off.

**(b)** The full grid belongs in the file; a note buyer wants three pages; a
borrower must never see our internal review flags, our note buyer's name, or the
appraiser's fee. Cloud CMA ships four sets by audience; Moxi composes from Report
Pages. Building the page library first means version four costs nothing.

**(c)** **Yes**, once item 1 exists — same data, different page list.

**(d)** **Small-to-medium** on top of item 1. **Large** if attempted as three
separate builders.

**(e)** **Traps.** (1) **Borrower-safe is a code path, not a checkbox.** The repo
already has `borrower-safe.scrubText` and the standing rule that a **note buyer /
capital partner name never reaches a borrower surface** — the partner layout must
route through it, and it must be a *server-side* selection so a client cannot ask
for the internal one. (2) **Sections hide when empty** (Flexmls) — never print an
empty "Adjustments" heading. (3) A page removed from a layout must be **removed
from the data**, not hidden with CSS, or a PDF text-extract leaks it.

---

### TIER 2 — the things that are ours alone

---

#### 6. **The adjustment corpus — "what our appraisers actually pay for a bathroom here"**

**(a)** Turn the adjustment lines we already store into rows we can add up, so we
can say: "this report adjusted $18 a square foot for living area; the other 40
reports in this county used $45–$70."

**(b)** **The single highest-value thing in the whole warehouse, and the only claim
we can make that a data vendor cannot.** It is exactly what Collateral Underwriter
does — compare an adjustment against **what other appraisers did on similar
properties** — and it is defensible at the volume we have *today*, because it is a
claim about our appraisers, not about the market. There are roughly **nine times
more adjustment observations than sales** in our corpus. It makes appraisal review
faster and better, which is the thing that pays for this project.

**(c)** **Yes, today.** `property_observations.adjustments` is jsonb holding
`[{type, description, amount}]` for every grid line of every comp of every report.
It needs normalising into rows keyed by line code, plus an index. **No new data, no
vendor.**

**(d)** **Medium.**

**(e)** **The trap is the wording, and it is absolute.**
> **Never:** "a bathroom is worth $12,000 in Paterson." That is a claim about the
> market, our sample cannot support it, and on thin data the arithmetic frequently
> returns a **negative** number.
> **Always:** "this report used $X; the other N reports in this county used
> $Y–$Z."

Also: (2) an adjustment is **signed and directional** — a description mined out of
`_Type='Age'` is an *age*, not a year (fact-coverage audit F3); (3) **normalise by
the comp's own price or size before comparing**, or a $30,000 adjustment on a
$1.2M house and on a $190k house land in the same bucket; (4) **retire the rows of
a superseded report** with the observation, or a re-import double-counts the
benchmark.

---

#### 7. **The flip finder**

**(a)** Every property in a town that **sold twice within 24 months**, with the
spread between the two prices, the months between, and the condition on each date.

**(b)** For a fix-and-flip lender this may be the single most valuable question the
database can answer, and **no MLS or AVM vendor answers it in this shape.** It is
simultaneously: comps for an ARV (a real completed flip, with both ends observed),
a read on what rehab actually returns in that market, and a fraud/flip-seasoning
signal on a subject we are being asked to lend against.

**(c)** **Yes — the data is there and the search does not read it.**
`property_sales` holds every distinct transaction (a comp's own sale, the **prior**
sale an appraiser researched on it, the subject's prior sale, a purchase under
contract). The browse search reads only `properties.last_sale_*`. Privy sells this
as "before-and-after with photos and a timeline"; we can add **both appraisers'
photos** to it, which Privy cannot.

**(d)** **Medium.**

**(e)** **Traps.** (1) **`prior_sale_nominal`** — the ≤$1,000 quitclaim flag — is
computed by the extractor and **currently dropped** (fact-coverage audit §1.1). A
$1 intra-family transfer would print as a 40,000% flip. **Fix that before shipping
this**, or exclude nominal-looking prices and say so. (2) A **listing is not a
sale** — only `closed` rows may pair. (3) **Sale dates are month-resolution**
(`settledMonth()` synthesises day 01), so "sold 63 days apart" is fabricated — state
months. (4) Two sales at the same month and price are **deduped by
`uq_property_sale`**, which keys on `COALESCE(sale_price,-1)` — do not re-derive
that rule.

---

#### 8. **Conflict detection — when two of our own reports disagree**

**(a)** Flag a property that two appraisers described differently — different square
footage, different year built, different condition — and show both, with who said
what and when.

**(b)** A review signal we can compute and nobody else can, because nobody else has
two independent professional opinions on the same house. On a rehab file it is also
the *good* kind of disagreement — C5 in 2024 and C3 in 2026 is the renovation, and
that is a comp for the next ARV.

**(c)** **Yes, today.** `property_observations` is an immutable ledger and is
explicitly allowed to disagree with itself; the roll-up picks a winner and throws
the disagreement away at the display layer only.

**(d)** **Medium.**

**(e)** **Traps.** (1) A **subject-to-repairs report's condition is the condition of
a house that does not exist yet** — `condition_basis='as_repaired'` must be
excluded from a conflict, or every rehab file flags itself. This is already
enforced in the roll-up and must be re-enforced here. (2) A **GLA difference where
one side is `gla_basis='gba'`** (a 1025 falling back to gross *building* area) is
not a conflict. (3) A **superseded report is not a second opinion.** (4) Report a
difference as a difference — never adjudicate which appraiser was right.

---

#### 9. **Appraisal-vs-our-value variance (a CDA in-house)**

**(a)** When an appraisal comes in, run our own comp set on the same property and
show the two values side by side with the percentage difference.

**(b)** This is Clear Capital's CDA — **value conclusion, variance from the
appraised value, risk level, recommended next action** — a product lenders pay
**$90–$250 a file** for and commonly require to land **within 10%**. On files where
we already hold the market we can produce the first-pass version for nothing, and
order the paid one only when the variance is wide. It also plugs straight into the
existing appraisal-findings desk, which is already an enforced gate.

**(c)** **Partly today.** All the machinery exists (`/comps` + `reconcile` +
`appraisals`). It is only trustworthy **where our coverage is real** — so it must
be gated on the coverage count and must decline in a town we barely hold.

**(d)** **Medium.**

**(e)** **Traps.** (1) **It must compare like with like** — our indicated value
against the appraisal's **as-is** or **ARV** figure, matched by basis. The As-Is
reader and `arv_applied` machinery already distinguish them; getting this backwards
on a subject-to report compares an as-is to an after-repair value and manufactures a
40% "variance" on a healthy file. (2) It **must not become a blocking gate**. AI
findings are advisory by hard rule and the appraisal desk's enforcement is
narrowly-scoped and owner-directed; a *statistical* disagreement is weaker evidence
than either and belongs as an advisory finding at most. (3) The comps we use must
**exclude the appraisal's own comps**, or we are checking a report against itself.
(4) When coverage is thin the answer is **"we cannot check this one"**, printed —
not a variance computed off two sales.

---

#### 10. **Show the score, and let a human weight a comp**

**(a)** Show *why* each comp scored what it did — distance, recency, size, beds,
condition, type — and let the officer drag a comp up or down and say why, with the
reason printed in the report.

**(b)** Every serious product does this (Redstone's three named factors, TOTAL's
manual weight, RPR's slider), and it converts the tool from "a machine ranked these"
to "a person decided, and here is their reasoning" — which is the difference between
something that survives a file review and something that does not.

**(c)** **Yes, today, and it is nearly free.** `scoreComp` already returns
`parts[]` with per-factor `earned`, `weight` and an `unknown` marker; `/comps`
already returns `match_reasons` and `match_coverage` on every row.
`property_valuation_comps.weight` and `.note` already exist and `reconcile()`
already lets a pinned weight override the formula entirely.

**(d)** **Small.**

**(e)** **Traps.** (1) `coverage` must render **beside** the score, always — 90/100
on two known facts is a weaker statement than 78 on seven, and this is already
documented as the reason unknowns leave the denominator. (2) A human weight must be
recorded as **a separate visible factor**, Redstone-style, not blended silently into
the score. (3) An **unknown must read "not stated"**, never 0.

---

### TIER 3 — quality, defensibility and reach

---

#### 11. **A defensible time adjustment — contract date + FHFA HPI**

**(a)** Adjust each comp for how the market moved between **when its price was
agreed** and today, using a published national index for the metro plus our own
read, and print both.

**(b)** Fannie's current guidance is explicit: the adjustment runs from the
comparable's **contract date** to the effective date, and *failure to make
market-derived time adjustments is unacceptable*. Our current market trend is an
older-half-vs-newer-half read of median price per foot — honest but crude. FHFA HPI
is free, published, quarterly, by metro and ZIP, and citable.

**(c)** **Partly.** `db/425` captures `contract_date` **going forward only** — a
comp imported before it keeps NULL, which honestly means *"we did not read it at
the time"*. FHFA HPI is a free public download, no vendor, no key. `market.js`
already has resolved 1004MC windows to compare against.

**(d)** **Medium.**

**(e)** **Traps.** (1) **NULL contract date means unknown — fall back to the settled
date and SAY SO on that line.** Never assume they are the same; that is written into
the migration's own comment. (2) A **month-resolution date cannot support a daily
index** — snap to the month. (3) Do not silently replace our own read with HPI:
print both and let the difference be visible, the way Redstone prints three time-
adjustment methods.

---

#### 12. **Fix the facts and re-value — "confirm the property facts" as step 1**

**(a)** Before searching, show the facts we hold about the subject with where each
one came from, and let the officer correct one and re-run instantly.

**(b)** RPR's four-step spine starts with **confirm the facts**; Plunk lets you
correct up to 31 attributes and re-value immediately. Our roll-up is *"the most
recent report that stated it"* — which on a house we last saw in 2023 can be three
years stale, and on a rehab file is often the pre-rehab description of the very
property we are lending on. Every downstream number inherits that.

**(c)** **Yes.** The subject is copied into the valuation as a **snapshot** already,
so an override is a snapshot edit and cannot corrupt the warehouse. `/comps` already
accepts a fully typed subject.

**(d)** **Small.**

**(e)** **Traps.** (1) A correction goes **into the snapshot, never back into
`properties`** — `properties` is a derived roll-up and nothing writes it directly.
(2) Each fact must show **where it came from and how old it is** (`observed_on`,
report), or the officer cannot tell what is worth correcting. (3) A corrected fact
must be **marked as ours** in the printed report, exactly the way the grid marks
`source:'user'` today.

---

#### 13. **Bracketing and the QC panel**

**(a)** One panel that answers the questions a reviewer will ask: are there comps
both above and below the subject on size, beds and condition; is anything over our
adjustment thresholds; is anything more than a year old or more than a mile away;
are there at least three closed sales.

**(b)** Bracketing is the first thing an appraisal reviewer and every note buyer
checks. We compute most of the individual warnings already and show them scattered.
Anow ships a "compliance checker"; TOTAL ships an addendum that justifies the
selection. A single panel converts our warnings from noise into a checklist a
processor can clear before the file moves.

**(c)** **Yes, today.** `compWarnings` + `setWarnings` + `THRESHOLDS` exist and are
tested. Bracketing itself is a small addition.

**(d)** **Small.**

**(e)** **Traps.** (1) **The 15%/25% pair is NOT a Fannie rule** — removed from the
Selling Guide in December 2014, and the 1-mile / 90-day conventions are lender
overlays. Every warning must stay worded as **our** opinion. This is already
written into `valuation.js`'s header and must survive into the UI copy. (2) It is
**advisory** — it does not block anything. (3) "Not bracketed" on a property where
we do not know the subject's condition is **"cannot check"**, not a failure.

---

#### 14. **Distance and boundary QC (the fair-lending guard)**

**(a)** Flag a comp that is unusually far away, or that sits across a census-tract
or municipal boundary from the subject, so somebody looks at it deliberately.

**(b)** Black Knight sells exactly this (CA Risk Profiler Plus flags comps that are
geographically distant **or in a census tract with a dissimilar demographic
composition**). Appraisal bias is a live regulatory exposure and this is the cheapest
possible control: it never makes a determination, it only asks a human to look.
For us it doubles as a plain quality check — a comp across a town line is a
different tax bill and often a different school district.

**(c)** **Yes, and free.** We already store `census_tract` on the observation and the
roll-up, and we already geocode against the **US Census Bureau** service (no key, no
account). Tract boundaries come from the same source.

**(d)** **Small-to-medium.**

**(e)** **Traps — this one is genuinely sensitive.** (1) **Flag the geography, never
the demography.** Do not import, store, display or reason over demographic
composition; a tool that shows it invites the decision it is meant to prevent. The
defensible signal is *"this comp is in a different census tract / municipality —
confirm it is the same market."* (2) It must be **advisory and never auto-exclude a
comp**. (3) A missing tract is **"cannot check"**.

---

#### 15. **Draw a market area, and save it**

**(a)** Draw a shape on the map around the neighbourhood you actually mean, use it
as the search boundary, and save it by name to reuse on the next file in that town.

**(b)** Both serious appraisal products have this (TOTAL's market areas, Redstone's
map polygons) because a circle is the wrong shape almost everywhere — a river, a
highway, a school district or a town line cuts a market in half and a 1-mile radius
does not know. In our concentrated markets, a saved "Paterson east of Route 20"
polygon would be reused on file after file.

**(c)** **Yes** — but it needs the map (item 2) first, and a point-in-polygon test.
Plain Postgres can do it (`point <@ polygon`) without PostGIS for the small polygons
this involves; a bounding-box prefilter on the existing `eff_*` index keeps it fast.

**(d)** **Medium.**

**(e)** **Traps.** (1) A saved polygon is **a person's opinion of a market**, not a
fact — label it with who drew it and when. (2) It **narrows** the search, so the
relaxation ladder must be allowed to widen past it and **say that it did**.
(3) A property with **no coordinate cannot be tested** and must be reported as
excluded-for-lack-of-coordinates, not silently absent.

---

### TIER 4 — worth doing, lower urgency

**16. Comp photos everywhere.** Photo thumbnails in the comp list and the search
results (ACI shows "full comps with thumbnail photos"; our `LIST_COLUMNS` already
returns `primary_photo_document_id`). *Small.* Trap: a **60% of files carry no photo
metadata**, so the join is best-effort by design — a grey box must read "no photo on
file", and a photo whose comp match came from the ordinal rather than the caption
address should not be presented as certain.

**17. Search by owning entity.** Reonomy's one transferable idea — "show me every
property this LLC has touched". `owner_of_record` is on the observation.
*Small-to-medium.* Trap: entity-name matching is the same fuzzy-name problem the
borrower CRM already solved painfully; reuse, do not reinvent.

**18. A "comp basket" that survives the session.** Pick comps across several
searches, keep them in a tray, then build the report. *Small.* (`StaffCompSearch`
already keeps everything in the URL, so a search is a link — extend that.)

**19. Rent comps for a fix-and-hold exit.** `market_rent`, `unit_mix` and the 1025
rent roll are all stored, and `has_unit_mix` is already a filter. *Medium.* Trap:
this is **RTL fix-and-hold exit analysis**, not the Long-Term product — ask before
building anything that looks like a DSCR tool.

**20. The two-source cascade, labelled.** The day we buy data (§6), a comp row must
show **which source it came from**, exactly as Matrix labels Realist rows and
PropStream offers MLS / public record / both. Design it now so it costs nothing
later. *Small now, large later.* Trap: never blend two sources into one number
without saying which contributed.

**21. Sale-and-listing history on the subject page.** Clear Capital's page 1 shows
**listing event history**; the CDA reviews "sale and listing history of both the
subject and the comparables" for undisclosed prior transactions. We hold
`property_sales` (multiple) and `last_list_price`. *Small.* Trap: our history is
only as complete as the reports that mentioned it — print the count of reports it is
drawn from, never imply it is a full title history.

**22. Count what we refuse.** A running number for: comps skipped for no locality
(`property_ingest_log.rows_skipped`), properties with no coordinate, searches that
returned nothing, and quick-answers that declined. *Small.* This is how we find out
whether the honest refusals are protecting us or hiding a bug.

---

## 6. IF WE WANT COVERAGE — the data-partner options, with real numbers

Everything in §5 works on our own data. **The one thing money buys is the ~93% of a
town we do not have.** Options, cheapest first, all prices as published or reported
in mid-2026 and all needing a live quote before anyone signs.

| Route | What it gives | Published / reported price | Verdict for us |
| --- | --- | --- | --- |
| **HouseCanary API** | Property estimate, sales comps (`comps_sale`, similarity-ranked), rental comps, national | **$0.05/call** property estimate; **$0.30–0.50** basic endpoints; **$2.50–4** premium; AVM PDF **$7–10**; Pro seat **$790/yr** | **Best fit.** Published unit pricing, a comps endpoint that matches our data shape, and a per-call cost low enough to run on every new file. Start here. |
| **RentCast API** | 140M+ property records, owner details, value + rent estimates, comparables, listings, market aggregates | **from $12/mo** Pro; 50 free calls | **Cheapest way to test the idea.** Coverage/quality needs verifying against a town we know cold — which we can do, because we hold that town. |
| **BatchData** | 155M properties, 1bn+ data points | **$0.01/call** pay-as-you-go; **$1,000/mo** for 100k records → **$5,000/mo** for 750k | Volume pricing; more a list-building product than a valuation one. |
| **ATTOM bulk licence** | 158M properties, ~30bn rows, 7,200 attributes, hosted **on our servers** | Quote only; reported **$95–500/mo** entry, "generally high" at scale; Property Navigator **$499/yr** | The right shape long-term (we host it, so no per-call cost and no caching restriction) and the wrong shape now. |
| **First American DataTree** | Property research + a Sales Comparables Report; the same public-record spine ACI Sky Data runs on | Reported **$97/$147/$197 per month** partner plans; enterprise avg **~$30,500/yr** | Worth a quote if we ever want title-grade record data alongside comps. |
| **CoreLogic / Cotality** | RealQuest, Realist tax, Total Home ValueX AVM | Not published; enterprise | Enterprise-only. Not for us at this size. |
| **Direct MLS licences** | The real answer for a specific town — full listing and sold data | **$50–$500/mo per MLS** plus setup, reported; IDX tiers **$100–$2,000+/mo per MLS**; **a separate licence per MLS** | Viable **because we are concentrated.** Two or three MLSs covers our book. But each one is its own contract, its own data-use policy and its own feed. |
| **Clear Capital CDA (per file)** | A licensed appraiser's desktop review with variance and risk | **$90–$250/report** | Not a data source — the **benchmark price** for the product in §5.9. Order it where our own coverage says we cannot answer. |

**Recommendation:** do not buy anything until §5 items 1–7 are shipped on our own
data. Then run **one** cheap experiment — HouseCanary property estimates and
`comps_sale` on the last 50 files in our two strongest towns — and measure it
against what our own warehouse said. That is a measurable question and we are one
of very few lenders who can actually answer it, because we hold the appraiser's
own conclusion for every one of those 50 files.

---

## 7. THE TRAP REGISTER — every place §5 could tempt a guess

Collected so a reviewer can check them off.

| # | Trap | Where it bites |
| --- | --- | --- |
| 1 | A blank cell printed as a dash reads as zero | 1, 5, 16 |
| 2 | A snapshot re-read from the live roll-up stops reproducing | 1, 12 |
| 3 | The disclaimer separated from the number | 1, 3, 5 |
| 4 | An unplaced property silently missing from a map or a polygon | 2, 15 |
| 5 | A ZIP-centroid coordinate drawn as a rooftop pin | 2 |
| 6 | A point estimate where the honest answer is a range and a count | 3, 9 |
| 7 | A thin answer rendered without the ladder or the coverage denominator | 3, 9 |
| 8 | Any valuation output reaching a pricing/sizing input (2024 AVM rule) | 3, 9 |
| 9 | `comp_set='unknown'` folded into as-is | 4 |
| 10 | A single-grid default presented as a determination (no `comp_split_confidence`) | 4 |
| 11 | A stale `comp_set` after the boot re-split rewrites it | 4 |
| 12 | A note-buyer / partner name on a borrower-facing report | 5 |
| 13 | A page hidden with CSS instead of removed from the data | 5 |
| 14 | "A bathroom is worth $X here" — a market claim our sample cannot support | 6 |
| 15 | Adjustments compared without normalising for price or size | 6 |
| 16 | A $1 quitclaim printed as a flip (`prior_sale_nominal` currently dropped) | 7 |
| 17 | A day-level claim on a month-resolution sale date | 7, 11 |
| 18 | An `as_repaired` condition flagged as a conflict on every rehab file | 8 |
| 19 | A GLA "conflict" that is really `gla_basis='gba'` on a 1025 | 8 |
| 20 | Comparing our value to the wrong basis (as-is vs ARV) | 9 |
| 21 | Checking an appraisal against its own comps | 9 |
| 22 | A score shown without its coverage | 10 |
| 23 | A NULL contract date assumed equal to the settled date | 11 |
| 24 | A correction written back into `properties` | 12 |
| 25 | Our 15%/25% thresholds re-labelled as a Fannie Mae rule | 13 |
| 26 | Storing or displaying demographic composition | 14 |
| 27 | A saved polygon presented as a fact rather than someone's opinion | 15 |
| 28 | A best-effort photo→comp match presented as certain | 16 |
| 29 | Two data sources blended into one number without saying which | 20 |
| 30 | A partial sale history implied to be a full title history | 21 |

---

## 8. SOURCES

**Appraisal software** ·
[a la mode](https://www.alamode.com/) ·
[TOTAL Comps Database map view](https://help.alamode.com/kb/guide/en/comps-database-map-view-BB6NhH4Mg1/Steps/4262610) ·
[TOTAL weighted average / suggested value](https://blogs.alamode.com/tech-tip-totals-weighted-average-and-suggested-value-tool) ·
[Titan Analytics market analysis](https://help.alamode.com/kb/guide/en/3010-how-to-use-titan-analytics-in-total-for-fannie-mae-and-freddie-mac-market-analysis-xSyFh0FuZG/Steps/4256967) ·
[Bradford Redstone](https://www.bradfordsoftware.com/redstone/) ·
[ClickFORMS time adjustments (PDF)](https://support.bradfordsoftware.com/docs/CF-Time-Adjustments.pdf) ·
[Bradford 1004MC calculation](https://www.bradfordsoftware.com/services/calc.shtml) ·
[ACI Sky Workbench](https://www.aciweb.com/appraisers/workbench/) ·
[ACI Report](https://www.aciweb.com/appraisers/aci-report/) ·
[SFREP / Appraise-It](https://appraisersblogs.com/appraisers-can-trust-SFREP-no-data-collection/) ·
[Anow](https://anow.com/) ·
[McKissock: 10 appraisal software tools (Spark, SFREP, Anow)](https://www.mckissock.com/blog/appraisal/appraisal-software-tools-streamline-process/)

**Data / AVM / analytics** ·
[HouseCanary pricing](https://www.housecanary.com/pricing) ·
[HouseCanary Property Explorer](https://www.housecanary.com/blog/property-explorer-quick-start-guide) ·
[HouseCanary API reference](https://api-docs-legacy.housecanary.com/) ·
[HouseCanary CMA tool](https://www.housecanary.com/blog/comparative-market-analysis-tool) ·
[ClearAVM](https://www.clearcapital.com/analytics/clear-avm/) ·
[ClearAVM enhanced report](https://www.clearcapital.com/announcing-an-enhanced-clearavm-report-with-valuable-new-insights/) ·
[FSD definition](https://www.clearcapital.com/resources/glossary-of-terms/fsd-forecast-standard-deviation/) ·
[ClearCollateral Review / AURA](https://www.clearcapital.com/products/clearcollateral-review/) ·
[CDA datasheet (PDF)](https://www.clearcapital.com/wp-content/uploads/2021/02/Clear_Capital_CDA_Datasheet__1_.pdf) ·
[CDA explained](https://www.offermarket.us/blog/collateral-desktop-analysis) ·
[CDA fee discussion](https://www.biggerpockets.com/forums/22/topics/948961-collateral-desktop-analysis-cda-fee) ·
[CoreLogic GeoAVM cascade / Total Home ValueX](https://www.corelogic.com/products/geoavm-cascade-suite.aspx) ·
[Matrix 360 CMA + Realist](https://kb.crmls.org/knowledgebase/matrix-360-cma/) ·
[ATTOM bulk data licensing](https://www.attomdata.com/solutions/bulk-data-licensing/) ·
[ATTOM on Datarade](https://datarade.ai/data-providers/attom/profile) ·
[ATTOM API pricing overview](https://zillapi.com/blog/attom-api/) ·
[First American DataTree](https://dna.firstam.com/solutions/property-data/datatree-property-research) ·
[First American pricing benchmark](https://www.vendr.com/buyer-guides/first-american-data-analytics) ·
[Black Knight CA Risk Profiler Plus](https://www.blackknightinc.com/press-releases/black-knight-introduces-ca-risk-profiler-plus-to-help-lenders-and-appraisers-identify-potential-minority-bias-in-collateral-valuation/) ·
[Reonomy research platform](https://www.reonomy.com/platform/research) ·
[Plunk](https://www.getplunk.com/what-we-do) ·
[RentCast API](https://www.rentcast.io/api) ·
[BatchData pricing](https://batchdata.io/pricing)

**GSE / standards** ·
[McKissock: CU FAQs](https://www.mckissock.com/blog/appraisal/fannie-maes-collateral-underwriter-program/) ·
[Appraisal Buzz: what appraisers should know about CU](https://appraisalbuzz.com/appraisers-know-collateral-underwriter/) ·
[Fannie Mae UAD page](https://singlefamily.fanniemae.com/delivering/uniform-mortgage-data-program/uniform-appraisal-dataset) ·
[McKissock: UAD 3.6 timeline](https://www.mckissock.com/blog/appraisal/the-future-is-now-fannie-mae-and-freddie-mac-announce-uad-3-6-implementation-timeline-and-policy-changes/) ·
[Clear Capital: what is UAD 3.6](https://www.clearcapital.com/what-is-uad-3-6-how-the-new-appraisal-standard-will-impact-lenders/) ·
[Appraiser eLearning: Fannie Mae market conditions adjustments policy](https://appraiserelearning.com/understanding-fannie-maes-new-market-conditions-adjustments-policy/) ·
[Appraisal Buzz: supporting market conditions adjustments](https://appraisalbuzz.com/supporting-market-conditions-adjustments-a-comprehensive-guide-for-appraisers/) ·
[McKissock: paired sales analysis](https://www.mckissock.com/blog/appraisal/paired-sales-analysis/)

**Agent-side CMA** ·
[Cloud CMA: about reports](https://community.lwolf.com/s/article/CCMA-About-Reports) ·
[Cloud CMA: creating a CMA](https://kb.crmls.org/knowledgebase/cloud-cma-creating-a-cma/) ·
[Cloud CMA: property report](https://kb.crmls.org/knowledgebase/cloud-cma-creating-a-property-report/) ·
[RPR: how to create a CMA](https://blog.narrpr.com/support/how-to-create-a-cma-comp-analysis/) ·
[RPR: advanced CMA / adjust comps](https://blog.narrpr.com/support/how-do-i-create-a-sales-comparison-analysis/) ·
[RPR: Refine Value](https://blog.narrpr.com/support/how-do-i-change-the-estimated-value-refine-value-tool/) ·
[RPR: RVM vs AVM](https://blog.narrpr.com/support/what-are-rvm-and-avm-estimated-values/) ·
[Flexmls: CMA types](https://help.flexmls.com/en/cma-types.html) ·
[Flexmls: adjustments tab](https://help.flexmls.com/en/adjustments-tab--cma-.html) ·
[Flexmls: finish tab / report options](https://help.flexmls.com/en/finish-tab--cma-.html) ·
[Paragon Connect EasyCMA](https://kb.crmls.org/knowledgebase/paragon-connect-easycma/) ·
[MoxiPresent: starting a presentation](https://support.moxiworks.com/hc/en-us/articles/209561846-Starting-a-New-Presentation) ·
[MoxiPresent: report pages](https://support.moxiworks.com/hc/en-us/articles/360037927492-Add-Report-Pages-to-Your-Presentation)

**Investor tools / lender desks** ·
[Privy product](https://www.privy.pro/product/privy-the-ultimate-real-estate-investment-tool/) ·
[Privy LiveCMA / markets](https://www.privy.pro/real-estate-markets/) ·
[Privy for lenders](https://www.privy.pro/lenders/) ·
[PropStream comps](https://www.propstream.com/comps-for-real-estate) ·
[PropStream: comps without MLS](https://www.propstream.com/real-estate-investor-blog/can-you-get-accurate-comps-without-the-mls-yes-heres-how) ·
[BatchLeads: comps for ARV](https://batchleads.io/blog/how-to-find-comps-to-determine-arv-for-a-wholesale-deal) ·
[Rehab Valuator deal analysis](https://rehabvaluator.com/real-estate-deal-analysis-software) ·
[Rehab Valuator cost estimator](https://rehabvaluator.com/rehab-cost-estimator-software) ·
[Kiavi fix-and-flip strategy (internal valuations team)](https://www.kiavi.com/solutions/fix-and-flip-strategy) ·
[Kiavi: real estate comps](https://www.kiavi.com/blog/real-estate-comps-to-determine-home-value) ·
[Fix-and-flip lender comparison 2026](https://www.crowdfundedwealth.com/articles/best-fix-and-flip-lender-2026) ·
[Appraisal vs BPO on a hard-money deal](https://ambitionlending.co/appraisal-vs-bpo-what-valuation-youll-get-on-a-hard-money-deal/) ·
[Park Place Finance: ARV formula / renovated comps](https://parkplacefinance.com/arv-house-flipping-formula/)

**Mapping / data access** ·
[Switch2OSM: using tiles](https://switch2osm.org/using-tiles/) ·
[OpenMapTiles](https://openmaptiles.org/) ·
[RESO Web API](https://www.reso.org/reso-web-api/) ·
[MLS data licensing costs overview](https://noseberrydigitals.com/guides/idx-rets-reso-integration-guide)

**Our own prior work** ·
`docs/PROPERTY-COMP-DATABASE-RESEARCH.md` ·
`docs/research/WHERE-THIS-IS-GOING.md` ·
`docs/research/RESEARCH-WAREHOUSE-HANDOFF.md` ·
`docs/research/APPRAISAL-FACT-COVERAGE-AUDIT.md` ·
`docs/research/COMP-SEARCH-UX-RESEARCH.md` ·
`docs/research/PROPERTY-SEARCH-ENGINE-RESEARCH.md` ·
`docs/research/INTERNAL-AVM-ROADMAP.md` ·
`docs/research/GEOCODING-DISTANCE-VENDOR-RESEARCH.md` ·
`docs/research/XML-FIELD-EXPANSION-RESEARCH.md` ·
`docs/research/PROPERTY-DEDUPE-AND-MERGE.md`
