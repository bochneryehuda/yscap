# COMPARABLE SEARCH — HOW THE PROS DO IT, AND WHAT WE SHOULD BUILD

**Status:** research + opinionated build spec. No code changed by this document.
**Written:** 2026-08-02.
**Reads:** `db/408_property_research_database.sql`, `src/lib/research/search.js`,
`src/lib/research/valuation.js`, `src/routes/research.js`,
`app-v2/src/screens/StaffPropertyResearch.jsx`.

**Companion documents — read them, this one does not repeat them:**

| Doc | What it already settles |
|---|---|
| `docs/research/COMP-DATABASE-INDUSTRY-RESEARCH.md` | the four-entity data model, the URAR grid, what Fannie/USPAP actually require, AVM model families, the honest limits of a few thousand appraiser-sourced rows |
| `docs/research/PROPERTY-SEARCH-ENGINE-RESEARCH.md` | the SQL: predicate accumulation, tsvector address search, ordinal UAD ranks, the bounding-box + haversine radius, facets in one round trip, keyset paging |
| `docs/research/AVM-BUILDER-RESEARCH.md` | the valuation grid, adjustment derivation, reconciliation, the report and its disclaimers |
| `docs/PROPERTY-COMP-DATABASE-RESEARCH.md` | the warehouse design rationale |

This document is about the **search UX** — the part the owner asked about: *"we should be
able to put in the subject property that we're looking to find comparables for and put in
how close we want to find comparables to."* That is one specific, well-known interaction
pattern, and every professional tool in the industry implements it. It is not what we
built. We built a **browse** screen.

**A note on sourcing.** Most vendor help sites in this space (`kb.crmls.org`,
`help.flexmls.com`, `help.alamode.com`, `blog.narrpr.com`, `singlefamily.fanniemae.com`,
`api.developer.attomdata.com`, `workingre.com`) refuse automated fetches from this
environment with HTTP 403 — the same limitation the earlier research documents recorded.
Where a product behaviour is described below it is reconstructed from search-engine
extracts of those pages, and the primary URL is given so a human can verify. Where I am
reconstructing rather than quoting verbatim, I say so.

---

# 0. The one-paragraph diagnosis

`StaffPropertyResearch.jsx` is a competent **browse** screen: a filter rail on the left, a
result list on the right, facets, a selection tray, URL-as-state. Every filter is
absolute — *"beds between 3 and 4"*, *"price between $300k and $450k"* — and every one of
them must be typed by hand. Nothing on the screen knows what property you are working on.

Every professional comp tool works the other way round. You name a **subject**, and the
tool derives the filters *from* the subject, shows them to you already filled in, and lets
you loosen them. Flexmls: *"the location of the subject property will be based on the map
location from the Subject tab… enter the radius you want to search for and click the Find
Comps button"* ([Flexmls Help — Comps
Tab](https://help.flexmls.com/en/comps-tab--cma-.html)). Paragon: *"each value is relative
to the subject property. For example, setting the square footage value to ±10% will show
you properties that are closer in size than using the default value of ±15%"*
([Paragon Connect EasyCMA, CRMLS
KB](https://kb.crmls.org/knowledgebase/paragon-connect-easycma/)). ATTOM's comparables API
takes `bedroomsRange`, `sqFeetRange`, `yearBuiltRange`, `miles` — every one a *range around
the subject*, not an absolute band ([ATTOM Developer
Guides](https://api.developer.attomdata.com/docs/guides)).

`GET /api/research/comps` in `src/routes/research.js` **already implements** the server
half of this — it takes a `property_id` or an `application_id`, derives defaults, ranks the
results, and returns the reasons. It has **no screen**. `api.researchComps` exists in
`app-v2/src/lib/api.js` and is called from nowhere. The single highest-value thing in this
whole document is: *build the screen for the endpoint we already have.*

---

# 1. HOW THE PROS ACTUALLY SEARCH FOR COMPS

## 1.1 The shape every one of them shares

Strip away the branding and all eleven products below do the same five things in the same
order:

1. **Identify a subject.** Not a filter — an *anchor*. Address lookup, MLS number, tax
   record, or "the listing I'm already on."
2. **Seed the criteria from the subject.** Property type, GLA band, bed/bath band, age
   band, radius, date window — all pre-filled, all visibly editable.
3. **Run, and show how many came back.** The count is the whole game. Too few → widen.
   Too many → tighten.
4. **Pick into a tray/cart.** The result list is a shopping surface, not a destination.
   Nothing about a result matters except whether it goes in the basket.
5. **Take the basket somewhere** — a grid, a CMA, an adjustment worksheet, an export.

Everything else — maps, facets, saved searches, notifications — hangs off that spine.

## 1.2 Product by product

### Matrix (CoreLogic / ICE) — the most-used MLS front end

The first screen of a **360 CMA** asks for the **subject property**, not for filters. You
find it by searching past MLS listings; if it was never listed, you use the **Tax Search**
under the Public Records tab, tick the record and press **"Fill from Selected"** — the
subject's facts populate the CMA
([Canopy MLS](https://support.canopymls.com/kb/article/28-cma/),
[OneKey MLS](https://support.onekeymls.com/hc/en-us/articles/33160131337620-Creating-a-Comparative-Market-Analysis-CMA-in-Matrix)).

Two things Matrix does that we do not:

- **One-click auto-comps.** A **"View Comparable Properties"** link *"automatically returns
  a list of 20 comparable properties"*, searching *"across all sources and record types at
  the same time, including active listings, recently sold/off-market listings, and tax
  records with no corresponding MLS listing"*
  ([CRMLS — Matrix 360 CMA](https://kb.crmls.org/knowledgebase/matrix-360-cma/)). The
  number 20 is not arbitrary; see §1.3.
- **Public records are a first-class comp source.** Selecting the "Non-MLS Sale" status
  compares against Realist tax records inside the same result set
  ([MLSListings — Matrix 360 Realist tax
  searches](http://portal.mlslistings.com/blog/articles/matrix-360-run-realist-tax-searches-within-matrix/)).
  *Our equivalent of "public records" is the observation ledger: a property some other
  report's appraiser wrote up. We have the analogue and do not use it as a distinct
  source.*

Matrix's **saved searches** convert to **Auto Email**: pick a frequency and a send time and
new matches go out on their own; *"as soon as available"* means within about 15 minutes of
the listing hitting the MLS, and a saved search returning **more than 250 listings cannot
be turned into an auto email** — a deliberate anti-noise cap worth copying
([CRMLS — Turning saved searches into auto
emails](https://kb.crmls.org/knowledgebase/turning-saved-searches-into-auto-emails-in-matrix/),
[Market Leader — Listing
Alerts](http://learn.marketleader.com/display/help/Listing+Alerts)).

### Paragon (ICE) — EasyCMA

Step 1 is literally titled **"Subject Property"**
([Paragon Help](http://paragonconnect.paragonrels.com/paragon/create-a-cma-presentation/item/62-basic-search)).
It *"will populate based on public records and previous MLS history"*, and anything wrong
is edited in place. Then — and this is the sentence to steal — the comparable criteria are
expressed **as tolerances around the subject**, with a stated default: *"each value is
relative to the subject property. For example, setting the square footage value to ±10%
will show you properties that are closer in size than using the default value of ±15%"*
([CRMLS — Paragon Connect
EasyCMA](https://kb.crmls.org/knowledgebase/paragon-connect-easycma/)). Per-user defaults
are saved in **Settings** and auto-populate every new EasyCMA.

**±15% GLA is Paragon's shipped default.** Note it; it is one of the very few published
default tolerances in the industry, and it is tighter than the ±20–25% rule of thumb the
appraisal blogs quote.

### Flexmls — the clearest expression of the pattern

A **Full CMA** has explicit tabs: **Subject → Comps → Adjustments → Finish**. On the Comps
tab, *"the location of the subject property will be based on the map location from the
Subject tab, and you can enter the radius you want to search for and click the Find Comps
button. The comparable search will automatically locate results from up to one (1) year
prior."*
([Flexmls Help — Comps Tab](https://help.flexmls.com/en/comps-tab--cma-.html))

So Flexmls's shipped defaults are: **radius = a number you type, sold within 12 months,
statuses you configure.** And they are **per-user preferences**: *"go to General
Preferences under Preferences, click the Comparables tab, set the default Search Radius…
select which Listing Statuses to include"*
([Flexmls — Create a Full CMA](https://help.flexmls.com/en/create-a-full-cma.html)).

Three CMA flavours exist — **Quick** (pick comps you already have), **Full** (the wizard),
**Statistical** (aggregate, no comp picking)
([METRO MLS](https://metromls.com/the-three-cma-types-in-flexmls/)). *We should copy the
Quick/Full split exactly: "I already ticked six sales, put them in a grid" is a different
job from "find me comps for 26 S 10th St."*

### RPR (NAR's Realtors Property Resource)

RPR is the clearest **map-first** implementation. Comp search runs off the map: *"select
the pencil Draw icon to draw a shape on the map… draw freehand or select a shape — radius,
polygon or box"*, plus drive-time
([RPR — How do I run a Map Search](https://blog.narrpr.com/support/how-do-i-run-a-map-search/),
[RPR Maps](https://blog.narrpr.com/tips/rpr-mapping/)). RPR's own guidance on *when* to use
each shape is the useful part, and it is a rebuttal to "just add polygon draw":

- **Radius** — "if your search involves a landmark, or a property you need proximity to."
- **Polygon** — "when you have clear, linear boundaries… such as a highway or river."
- **Box** — "for finding a potentially representative sample of properties in an area you
  don't know well."

Polygon earns its keep only when the user *knows the local boundary that matters*. That is
a real skill an appraiser has and a loan officer usually does not.

### CoreLogic Realist (inside Matrix)

Realist's contribution is **the non-MLS comp**: assessor/deed records for property that
never listed. Its value is coverage, not UX — *"view Realist tax data directly in Matrix
without needing to launch a separate program and leave the Matrix workflow"*
([CoreLogic Matrix
datasheet](https://pages.corelogic.com/hubfs/CoreLogic%20USA/Website%20PDF%20Files/RES-MLS-Matrix-Datasheet-2023.pdf)).
The lesson for us: **do not make the user leave the file to search comps.** A comp search
launched from a loan file must come back to that loan file.

### ATTOM — the API shape, which is the cleanest statement of the pattern

`/salescomparables` takes exactly this: `searchType`, `minComps`, `maxComps`, `miles`,
`bedroomsRange`, `bathroomRange`, `sqFeetRange`, `lotSizeRange`, `saleDateRange`,
`saleAmountRangeFrom/To`, `yearBuiltRange`, `ownerOccupied`, `distressed`
([ATTOM Developer Guides](https://api.developer.attomdata.com/docs/guides),
[ATTOM Developer Platform](https://api.developer.attomdata.com/dlpv2docs)).

Read that list carefully. Six of the parameters are **±ranges around the subject's own
value**. Two (`minComps`/`maxComps`) say *how many answers you want* — the API is expected
to widen or narrow to hit that target. And `distressed` is a **flag**, not a filter, which
is exactly how REO/estate sales should be treated.

`minComps`/`maxComps` is the single most under-appreciated idea in this whole survey: the
professional API takes the **desired result count** as an input. That is the expanding-ring
pattern, promoted to a first-class parameter. See §2.4.

### HouseCanary — Property Explorer

The most automated of the lot. PEXP *"selects up to 500 comparables for each subject
property using a proprietary, quantitatively derived similarity score"* on a **1–100
scale**, adjusts each comp *"by comparing the comp to the subject property using factors
including location, square footage, rooms, lot size, pools, basements, and more"*, and
*"whenever you choose or adjust comps, Property Explorer will instantly recalculate the
Comparable Value"*
([HouseCanary — Property Explorer Quick Start
Guide](https://www.housecanary.com/blog/property-explorer-quick-start-guide),
[Property Explorer product page](https://www.housecanary.com/products/property-explorer),
[Review Selected
Comps](https://appraiser.support.housecanary.com/hc/en-us/articles/228497028-Review-Selected-Comps)).

Two things to take:
- **A similarity score is the ordering, and the human still picks.** HouseCanary does not
  auto-select; it ranks 500 and lets you toggle.
- **Live recompute.** Ticking a comp updates the value immediately. Our valuation screen
  already recomputes server-side on every comp change (`saveComputed` in
  `src/routes/research.js`); the *search* screen has no value readout at all.

### Clear Capital — ClearVal / CDA

Clear Capital's angle is **review**, not search: each report goes *"through a powerful
analytics-based ruleset to identify valuation accuracy and comparable selection risk"*
([Clear Capital — Desktop
Appraisal](https://www.clearcapital.com/products/desktop-appraisal/),
[Collateral Desktop
Analysis](https://www.clearcapital.com/products/collateral-desktop-analysis-cda/)). Their
Collateral Desktop Analysis exists specifically to second-guess an appraiser's comp
selection. That is *our* long-run play too — we hold the appraiser's chosen comps **and**
the pool they chose from, which is precisely the input a CDA needs. Filed under "later"
(§7), but worth knowing the shape.

### Redfin / Zillow — the consumer patterns worth stealing

Not comp tools, but two mechanics are relevant:
- **"Nearby homes recently sold"** on every property page — a zero-input, pre-seeded
  radius search that requires no thought. Cheap for us; §5.
- **Bulk export with a hard cap.** Redfin's "Download All" produces a CSV, capped at **350
  homes**, and *disappears below 20 results*
  ([Redfin — Downloading
  Data](https://support.redfin.com/hc/en-us/articles/360016476931-Downloading-Data)). Both
  ends of that are good design: no export for a trivial set, and a cap that forces the user
  to narrow rather than pull the database.

### Appraiser desktop software — TOTAL, ClickFORMS, ACI

`a la mode`'s **TOTAL Comps Database** is the closest thing to what we are building,
because it is *an appraiser's own private warehouse of everything they have ever
appraised* — exactly our warehouse. It *"integrates various data sources (prior reports,
imported MLS data, public records, photos, notes, docs) into a comprehensive visual **Map
and Grid** based view of your market"*; a drop-down *"allows you to select the subject data
to use when searching, or to choose where you want to place your selected comparables"*;
and **Import** pulls comparables out of existing reports
([a la mode — Comps Database](https://help.alamode.com/appraiser/total/compsdatabase.htm)).

Three design facts fall out of that description, and all three are missing from our screen:

1. **The subject is a dropdown, not a form.** "Which subject am I searching for?" is a
   *selection*, because the subject is usually already in the system.
2. **Map AND grid, side by side, always.** Not a toggle.
3. **The destination is a slot.** You do not "select comps"; you choose *"where you want to
   place your selected comparables"* — comp 1, comp 2, comp 3 of a specific report. The
   basket has numbered slots.

## 1.3 Why "20" keeps appearing

Matrix auto-returns 20. Fannie Mae's **Collateral Underwriter** *"gathers the 20 closest
most similar sales from the subject's address… rated 1–20 (M1 being Fannie's #1 model
comp through M20)"*
([McKissock — CU FAQs](https://www.mckissock.com/blog/appraisal/fannie-maes-collateral-underwriter-program/),
[Zumwalt — understanding the CU
report](https://www.linkedin.com/pulse/article-help-appraisers-better-understand-fannie-mae-cu-larry-zumwalt)).

Twenty is roughly **3–6 comps you will actually use × a 3–5× discard rate**. It is the size
of a list a human will genuinely read. Our `/comps` endpoint currently pulls `limit: 60` —
too many to read, and the tail is noise. **Show 20, offer "show 20 more."**

## 1.4 What every one of them refuses to do

None of these products picks the comps for you. Matrix hands you 20. HouseCanary hands you
500 ranked. CU explicitly does not reject an appraisal because its own model comps differ —
*"CU will not provide a high-risk score solely because the comparables are dated, located
several miles away, or require significant adjustment"*, and *"if CU's comparable selection
model finds the appraiser-provided comparables to be the best available, the appraisal will
likely receive a low-risk score"*
([Appraisal Buzz — CU FAQs](https://appraisalbuzz.com/faqs-about-fannie-maes-collateral-underwriter-program/),
[JVM Lending — the dreaded CU
score](https://www.jvmlending.com/blog/appraisal-issues-the-dreaded-cu-score/)).

That is the posture we already take everywhere else in PILOT (advisory, never blocking) and
it must hold here.

---

# 2. SUBJECT-ANCHORED SEARCH — the central pattern, designed for us

## 2.1 Naming a subject: three doors, one screen

The subject comes from one of three places, and all three land on the same screen with the
same state:

| Door | Where it starts | What it resolves to |
|---|---|---|
| **A loan file** | a "Find comparables" button on the staff file screen, next to the appraisal | `subjectForApplication(appId)` in `src/routes/research.js` — the `property_observations` row with `role='subject'` for that application |
| **A property we already hold** | the "Find comparables for this" button on `StaffPropertyDetail.jsx` | `properties.id` |
| **A typed address** | the search screen's own "Subject" box | the free-form branch already in `/comps` — `address`, `city`, `state`, `gla`, `beds`, `year_built`, `condition_uad`, `lat`, `lng` |

All three already work server-side. The third needs one addition: when the typed address
resolves to an `address_key` we already hold (`src/lib/research/property-key.js`), **say
so** and offer to use the stored facts — "we already have this property; 4 reports have
mentioned it."

**The subject panel is pinned.** Every CMA tool in §1 shows the subject's facts above the
results, permanently, and lets you edit them in place. Ours must too, for a reason specific
to our data: the subject's `gla`/`beds`/`condition` are a **roll-up from the last report
that stated them**, and on a rehab file the condition may be `as_repaired`. The user has to
be able to see and override the yardstick they are measuring against.

## 2.2 The default tolerances

These are the numbers to ship. Each is defensible and each has a source or a stated reason.

| Constraint | Ring-0 default | Why this number |
|---|---|---|
| **Property category** | must match (1-unit / 2–4 / 5+ / condo) | a hard gate, not a tolerance — a duplex is not a comp for a house. Use `src/lib/property-type.js propertyTypeCompareKey`, which the repo already treats as the one definition |
| **Sale status** | **closed only** | Fannie B4-1.3-08 is about closed sales; a listing is an asking price. `valuation.js` already warns `not_closed`. Listings are a *deliberate opt-in*, flagged in the result |
| **Sold within** | **6 months** | *"comps sold within the past 3 months are the preferred standard, while sold within 6 months is acceptable"* ([iBuyer — How to pull comps](https://ibuyer.com/blog/how-to-pull-comps-on-a-house/)); Fannie's outer bound is 12 months ([Fannie Selling Guide B4-1.3-08](https://selling-guide.fanniemae.com/sel/b4-1.3-08/comparable-sales)) |
| **Radius** | **1.0 mile** | the near-universal lender overlay — *"the guideline set by most lenders… comps should be within one mile"* ([RealVals](https://realvals.com/appraisal-comparable-guidelines/)). **Not a GSE rule** (see `COMP-DATABASE-INDUSTRY-RESEARCH.md` §3.2); never label it one |
| **Radius when the subject has no coordinates** | same **city + state** | ~40% of our properties will lack lat/lng; see §2.6 |
| **Living area (GLA)** | **±20%** | the trade rule of thumb — *"a valid comp is within ±20% to 25% of your home's square footage"* ([iBuyer](https://ibuyer.com/blog/comps-for-my-house/)). Paragon ships ±15% ([CRMLS](https://kb.crmls.org/knowledgebase/paragon-connect-easycma/)); ±20% is the right first ring for a warehouse this thin |
| **Bedrooms** | **±1** | tighter than this eliminates the market; wider stops being a comp |
| **Bathrooms** | **no filter** | our bath data is the noisiest field we hold (`baths_full`/`baths_half`/`baths_text` all disagree across vendors). **Score it, do not gate on it** |
| **Year built** | **±15 years** | wide enough to survive a mixed-vintage block, tight enough to exclude a new-build against a 1920s row house |
| **Units** | must match when the subject has >1 | a 3-family and a 4-family are different products to our borrowers |
| **Price** | **NO FILTER, ever** | this is the one that matters. *"By limiting search to a price range, appraisers are apt to miss the most potentially relevant comparable sale… restricting the comparable search by price is one of the easiest ways to miss good data"* ([Working RE — Search parameters and the best comparables](https://www.workingre.com/search-parameters-and-the-best-comparables/)). Filtering comps by price **assumes the answer you are trying to derive**. The current browse screen offers a price filter; the subject-anchored screen must not, and if the user opens it from a browse state carrying one, drop it and say why |
| **Condition / quality** | **no filter** | score it. Gating on condition on an ARV search would exclude the renovated sales that *are* the ARV evidence |
| **Distressed / REO** | **included, flagged** | ATTOM treats `distressed` as a flag; `valuation.js` already emits a `distressed` warning. Excluding them silently would hide the fact that the market is distressed |
| **Target result count** | **8 minimum, 20 shown, 40 = "too many"** | 20 for the reasons in §1.3; 8 is "enough to pick 3–6 from with room to reject" |

Every one of these appears **as a visible, editable chip** on the screen — the Paragon
model. The user must see "within 1 mile · sold in the last 6 months · 1,120–1,680 sq ft ·
3–5 beds · built 1935–1965" and be able to click any of it.

**Per-user defaults, like Flexmls.** An appraiser working rural Pennsylvania wants a
different ring-0 than someone working Brooklyn. One row per staff user holding a JSON
default set, applied at screen open. Low effort, high daily payoff.

## 2.3 Purpose: as-is vs ARV — the thing no MLS tool has to think about

This is our differentiator and it must be a first-class control on the screen, because it
changes *what a good comp is*:

- **As-is comps** — the subject in its current, unrenovated condition. Prefer comps whose
  condition rank is **near the subject's current** rank. Prefer properties whose
  observations came from **as-is grids** (`asis_comp_count > 0`).
- **ARV comps** — the subject *after* the rehab. The condition target is **not the
  subject's current grade**; it is the after-repair grade (default **C3** when the file
  does not state one — the ordinary "renovated, average" outcome). Prefer
  `arv_comp_count > 0`. A C5 sale two doors down is a *bad* ARV comp and a *great* as-is
  comp, and today's `scoreComp` cannot tell the difference.

`db/408` already denormalized `arv_comp_count`/`asis_comp_count` onto `properties`
specifically so this filter is a plain indexed comparison. `search.js` already exposes
`comp_set`. Nothing in the schema needs to change — the *screen* needs a two-way toggle
that sets the comp-set preference and the condition target together.

## 2.4 The expanding ring — the exact relaxation order

When ring 0 returns fewer than **8** candidates, widen automatically, **one step at a
time**, re-running after each step, and **stop the moment the count is met**. Announce each
step in plain words above the results, and make every step individually undoable.

The order is not arbitrary. The governing rule from appraisal practice is **time before
distance**: *"if fewer than three results appear, extend the sold date to 180 days before
adjusting the distance, since widening the radius introduces more neighborhood variability
than extending recency does"* ([iBuyer — How to pull
comps](https://ibuyer.com/blog/how-to-pull-comps-on-a-house/)), and *"it is always better
to find older comparable sales in the home's immediate neighborhood than to choose a more
recent comparable in a non-competing neighborhood further away"*
([RealVals](https://realvals.com/appraisal-comparable-guidelines/)).

| # | Step | New value | Rationale |
|---|---|---|---|
| 1 | sold within | 6 → **12 months** | time first; 12 months is still inside Fannie's stated preference |
| 2 | GLA band | ±20% → **±25%** | the top of the trade range; cheap, purely a size band |
| 3 | radius | 1.0 → **1.5 mi** | the first genuine neighbourhood widening |
| 4 | bedrooms | ±1 → **±2** | room count is adjustable on a grid; location is not |
| 5 | year built | ±15 → **±25 years** | age is one of the easier adjustments |
| 6 | sold within | 12 → **24 months** | now genuinely stale; every result is badged "over a year old" |
| 7 | radius | 1.5 → **3.0 mi** | past the lender overlay; every result is badged with its distance |
| 8 | year built | drop the filter | keep it as a score input only |
| 9 | radius | 3.0 → **5.0 mi** *and* drop the GLA band | scored, not gated; this is the "rural / unique property" tier |
| 10 | statuses | **add active + pending listings** | last resort; every one badged "asking price, not a sale" |
| 11 | **stop** | — | say the true thing: "We hold N properties in {town} and this is all of them. Nothing here is hidden by a filter." |

**Never relax:** the property category, the unit count, `exclude_property_id` (the subject
itself), or the price non-filter (there is nothing to relax).

Two UI rules that make this honest rather than magic:

- **Show the ladder as a strip.** `● 6mo · ● ±20% · ○ 1.0mi …` with the steps that fired
  lit up, and a one-click "put it back."
- **The badge travels with the row.** A result that only exists because of step 7 carries
  "2.4 miles away" in gold on its card. `valuation.js compWarnings` already generates
  exactly this text (`comp_far`, `comp_stale`, `not_closed`, `gla_off`) — reuse it at
  search time instead of only at grid time.

**The reverse direction matters too.** Over ~40 results, offer the tightening chips in
reverse order as one-click actions: "Tighten to 0.5 mi (12 left)" — with the count
precomputed, which the facet query can do in the same round trip.

## 2.5 `minComps` / `maxComps` as a server contract

ATTOM's API takes the desired count. Ours should too: `GET /api/research/comps` gains
`min_comps` (default 8) and `max_comps` (default 20), and the route runs the ladder
server-side, returning:

```json
{
  "subject": { … },
  "rows": [ … ],
  "filters": { "radius_miles": 1.5, "sold_within_months": 12, … },
  "relaxation": {
    "target": 8,
    "steps": [
      { "step": "sold_within_months", "from": 6,   "to": 12,  "found": 4 },
      { "step": "sqft_band",          "from": 0.20,"to": 0.25,"found": 6 },
      { "step": "radius_miles",       "from": 1.0, "to": 1.5, "found": 11 }
    ],
    "stopped_because": "target_met"
  }
}
```

Server-side, because otherwise the screen makes up to 11 round trips to find its answer,
and because a saved search / an export / a future API consumer all need the same ladder.

At our data volume each ladder step is a few-millisecond query on a table small enough to
sit entirely in cache (§6), so eleven of them worst-case is still under ~100 ms.

## 2.6 The property with no coordinates

Roughly a third to a half of our rows will have no lat/lng — MISMO grids frequently omit
them, and we do no geocoding in the research path on purpose (`db/408`: *"the warehouse
must dedupe with no network and no API key"*). A subject-anchored search must degrade, not
fail:

1. Subject **and** comp have coordinates → real radius + real distance, sorted by distance.
2. Subject has coordinates, comp does not → the comp is **not excluded**. It is scored with
   the distance facet **dropped** (§4), placed in a separate "distance unknown — same
   town" group below the ranked list, and badged.
3. Subject has no coordinates → fall back to **same ZIP**, then **same city + state**, and
   say so on the screen: "This property has no map location on file, so we searched
   Piscataway rather than a radius."

Never let a missing coordinate silently mean "far away" — which is exactly what today's
`scoreComp` does (`add(25, 0, 'distance unknown')`).

---

# 3. MAP-BASED SEARCH — what is realistic here

## 3.1 What a map would actually buy us

For comp selection specifically, a map answers four questions:

1. **How far, and in which direction?** (the big one)
2. **Is there a barrier between them?** — a highway, a river, a rail line, a municipal
   line. This is the question RPR's polygon tool exists for.
3. **Are my comps clustered on one side?** — a bracketing/coverage check.
4. **Which of these is the one I mean?** — click a pin, add to tray.

Questions 1, 3 and 4 need **relative geometry**. Only question 2 needs a **basemap**.

That distinction is the whole recommendation.

## 3.2 The options, honestly costed

| Option | Library licence | Runtime cost | CSP impact | Third-party data leak | Verdict |
|---|---|---|---|---|---|
| **Google Maps JS** | proprietary, keyed | Dynamic Maps: **10,000 free map loads/month**, then **$7 / 1,000**; subscription tiers start $100/mo for 50k events ([Google Maps Platform pricing](https://mapsplatform.google.com/pricing/), [blog — 10k free calls per product](https://mapsplatform.google.com/resources/blog/start-building-today-with-up-to-10-000-monthly-free-calls-per-product/)) | needs `script-src`, `img-src`, `connect-src`, `frame-src` for `*.googleapis.com` + `*.gstatic.com` | every viewport, plus a browser-visible API key in a lender portal | **No.** Lowest free tier of the lot, biggest CSP surface |
| **Mapbox GL JS v2+** | **proprietary since Dec 2020** — v2 requires a commercial licence and ToS acceptance; only v1.x remains BSD-3 ([Stadia Maps](https://stadiamaps.com/blog/mapbox-gl-licensing-and-stadia-maps/), [mapbox-gl-js#10162](https://github.com/mapbox/mapbox-gl-js/issues/10162)) | **50,000 free map loads/month**, then ~**$5 / 1,000**; *a map load is billed on every `Map` initialisation* ([Mapbox pricing](https://www.mapbox.com/pricing), [docs](https://docs.mapbox.com/accounts/guides/pricing/)) | WebGL + web workers → needs `worker-src blob:`, `script-src`, `connect-src`, `img-src` | same as Google | **No.** A proprietary, per-init-billed script inside a portal that handles borrower PII is a licensing and privacy conversation we do not need to have to draw six dots |
| **MapLibre GL JS** | **BSD-3** — the community fork of GL JS v1 ([maplibre-gl-js](https://github.com/maplibre/maplibre-gl-js), [MapTiler](https://www.maptiler.com/news/2021/01/maplibre-mapbox-gl-open-source-fork/)) | library free; **you still need a vector tile vendor** (MapTiler / Stadia / Protomaps) — free tiers ~100k tiles/mo, paid from ~$25/mo | WebGL + workers → `worker-src blob:` | tile vendor sees every viewport | **Later, if ever.** Free library, but the tiles are still a keyed vendor and WebGL is a lot of machinery for this job |
| **Leaflet + raster tiles** | **BSD-2**, ~42 KB gzipped, **zero transitive dependencies**, no build step required, no WebGL, no web workers | library free; tiles from a keyed vendor (~$0–25/mo at our volume) or OSM's community servers | **the smallest of any real map**: Leaflet's CSS is self-hosted (`style-src 'self'`), tile images need `img-src <tilehost>`, and — importantly — **Leaflet's runtime positioning does not need `'unsafe-inline'`**, because it sets `element.style.transform` via the CSSOM property, and *"styles properties that are set directly on the element's style property will not be blocked"* by CSP; only `setAttribute('style', …)` and `cssText` are ([MDN — style-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/style-src), [MDN — style-src-attr](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/style-src-attr)) | tile host sees every viewport | **Yes — as phase 2.** The only map option whose cost, licence and CSP footprint are all boring |
| **Static image map** (Google/Mapbox Static API) | n/a | Google Static Maps 10k free/mo then ~$2/1k | `img-src` only — trivially the smallest | one request per view, with the pin coordinates **in the URL** | Cheap, but it cannot pan, zoom, draw, or be clicked. It is a picture, and this is a selection tool |
| **No basemap — an SVG "distance rose" we draw ourselves** | none | **$0** | **none** — same-origin SVG | **none** | **Yes — phase 1, build this first** |

A note on **OSM's community tile servers**, since "Leaflet + free tiles" usually means them:
the OSMF policy is explicit that the servers are donation-funded, that *"heavy use… is an
abuse of the individual donations and sponsorship"*, that *"bulk downloading is
prohibited"*, and that *"access may be blocked without notice if usage degrades the
service"*
([OSMF Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)). A
twenty-person internal tool doing normal interactive viewing is squarely inside the
permitted envelope, and attribution is mandatory. But building a commercial lender's
production feature on a charity's servers with no SLA and a "blocked without notice" clause
is not a decision to make casually. If we ship Leaflet, ship it against a keyed commercial
raster vendor with a free tier, and keep the tile URL in an env var so it can be swapped.

## 3.3 The recommendation

> **Phase 1 (build now): a dependency-free SVG "distance rose". Phase 2 (only if asked
> for): self-hosted Leaflet against a keyed raster tile vendor, behind a config switch.**

**The distance rose.** A square SVG, ~380 px, rendered from the `latitude`/`longitude` we
already return in `LIST_COLUMNS`:

- The **subject** is a gold pin at the centre.
- Concentric **rings at 0.25 / 0.5 / 1 / 2 miles**, labelled, so distance is read off the
  picture rather than a number.
- Each **comp** is a dot at its true bearing and scaled distance. Colour by match band
  (§4), size by nothing (size encodes nothing useful here).
- **Hover** shows the address + price; **click** toggles it into the tray — the same
  `toggle(row)` the list already uses, so the map and the list are one selection.
- Properties with **no coordinates** sit in a labelled strip beneath the circle. They are
  not hidden and they are not placed.
- The current **radius filter** renders as a shaded disc, so "widen to 1.5 mi" is a visible
  action.

Why this is the right first move:

- It answers questions 1, 3 and 4 from §3.1 — which is most of the value — and it answers
  question 1 *better than a basemap does*, because it draws the rings.
- **Zero npm dependency, zero vendor, zero recurring cost, zero CSP change, zero
  third-party disclosure of which properties we are researching.** For a lender's internal
  tool that last one is not nothing.
- It is roughly one day of work: bearing + scaled radius from the same haversine we already
  compute in `search.js`, rendered as `<circle>` elements.
- It cannot degrade. No tile vendor outage, no key rotation, no rate limit.

What it does **not** do, stated plainly so nobody is surprised: it cannot show you that
Route 1 runs between the subject and comp 3. When somebody hits that wall for real — and
they will, in a mixed market — that is the trigger for phase 2, and phase 2 is then a
justified 42 KB dependency rather than a speculative one.

**If and when we do phase 2**, the rules:
- `npm i leaflet` **in `app-v2` only**, vendored through Vite (never a CDN `<script>` — a
  CDN is a third-party script in a PII portal and would need a CSP `script-src` exception).
- Tile URL in an env var; ship with a keyed commercial vendor, not OSM community tiles.
- Attribution rendered, always.
- The map is a **view of the same result set**, never its own query. Do not build
  "search-as-I-pan" — it multiplies the query load by every mouse movement and it makes the
  URL-as-state contract (which this screen gets right) impossible to keep.
- **No polygon draw in phase 2.** See §7.

---

# 4. SIMILARITY RANKING — "find me the best comps"

## 4.1 What the field actually does

Three families, and we should take something from each:

**(a) Weighted-distance / similarity score.** HouseCanary's is the reference: a proprietary
1–100 similarity score over *"location, square footage, rooms, lot size, pools,
basements"*, used to pick up to 500 candidates ([HouseCanary
PEXP](https://www.housecanary.com/products/property-explorer)). Simple, explainable,
robust on small data.

**(b) Gower distance.** The standard answer for **mixed numeric + categorical + ordinal**
data, which is exactly what a property record is (GLA numeric, condition ordinal,
property type categorical). Defined by Gower in 1971; ranges 0–1; computes a per-variable
normalised difference and takes a **weighted average**; and — the property that matters
most to us — **it handles missing values natively by dropping that variable from both the
numerator and the denominator**
([Wikipedia — Gower's distance](https://en.wikipedia.org/wiki/Gower%27s_distance),
[Gower's Similarity Coefficients with Automatic Weight Selection,
arXiv:2401.17041](https://arxiv.org/pdf/2401.17041)). Our data is full of holes; this is
the correct mathematical frame and it is four lines of code.

**(c) k-NN on a normalised feature vector.** The literature is about weighting: distance-
weighted k-NN, feature-importance k-NN, and the observation that k-NN *"can handle multiple
missing values and offers flexibility in adjusting the number of neighbors, making it
suitable for selecting similar properties"*
([Improvement and Comparison of Weighted kNN
Classifiers](https://scialert.net/fulltext/?doi=jse.2016.109.118),
[A new distance-weighted kNN
classifier](https://www.researchgate.net/publication/266872328_A_New_Distance-weighted_k_-nearest_Neighbor_Classifier)).
k-NN *is* Gower-with-a-cutoff once you have a distance function; there is no separate thing
to build.

**(d) Collateral Underwriter — what the reference implementation is documented to do.**
CU *"gathers the 20 closest most similar sales from the subject's address"*, ranks them
**M1–M20**, and *"compares the appraiser-provided comps against a pool of observed sales
transactions in the subject market and not against arbitrary, 'rule of thumb'
guidelines"*; *"the comps with the lowest risk will be those with the most similar
parameters such as bedroom and bath count, square footage, lot size and amenities"*; and
the practitioner heuristic is that *"the best quality appraisals normally have 3 of the top
5 CU Model comps"*
([McKissock](https://www.mckissock.com/blog/appraisal/fannie-maes-collateral-underwriter-program/),
[Appraisal Buzz](https://appraisalbuzz.com/faqs-about-fannie-maes-collateral-underwriter-program/),
[Walser — CU scoring
explained](https://www.linkedin.com/pulse/fannie-mae-collateral-underwriter-scoring-explained-mark-walser)).

Four things to copy from CU exactly:
1. **20 model comps, ranked.** Not 60.
2. **Compare against the observed pool, not against rules of thumb.** This is the same
   posture `valuation.js` already takes about the 15%/25% thresholds.
3. **Distance and age are inputs to a score, not disqualifiers** — CU explicitly does not
   penalise a comp *solely* for being far or old.
4. **A model disagreeing with a human is information, not a verdict.**

## 4.2 Critique of the current `scoreComp`

`src/lib/research/valuation.js` lines 590–624. It is a reasonable first cut and it is
wrong in eight specific ways, in rough order of how much damage each does.

**1. Missing data is scored as a bad match, not as an unknown.** `add(25, 0, 'distance
unknown')`, `add(25, 0, 'sale date unknown')`, `add(20, 0, 'size unknown')`. `possible` is
always exactly 100 (25+25+20+10+10+10), so the `score/possible` division is a no-op and
absent facts are indistinguishable from terrible facts. A property with no coordinates and
no GLA on file **cannot exceed 45/100** even if it is next door and identical. This is
precisely the failure Gower's formulation exists to prevent, and the repo's own
`PROPERTY-SEARCH-ENGINE-RESEARCH.md` §5.4 already states the rule ("degrade when a fact is
missing rather than pretend it is zero"). The implementation does not follow it.

**2. It is inconsistent about that.** Unknown property type gets **half credit**
(`add(10, 5, …)`); every other unknown gets zero. No stated reason.

**3. There are no hard gates.** A pending listing, an REO, a 4-unit against a single-family
subject, and a property with **no sale price at all** can all top the ranked list.
`valuation.js` knows all of these are problems — `not_closed`, `distressed`, `no_price` are
already in `compWarnings` — but the *score* is blind to them, so the ranking recommends
comps the grid will immediately warn about.

**4. The distance fallback is too generous and the wrong shape.** `same city → 15/25` is
60% of the distance credit for "somewhere in Brooklyn." Should fall back **same ZIP → same
city**, at much lower credit, and mark the facet unknown rather than scored.

**5. Recency decays linearly over 24 months.** A 12-month-old sale scores 12.5/25 — half
credit for a comp most reviewers would ask you to justify. Real preference is a **plateau
then a fall**: full credit to ~3 months, decaying to near-zero by 12–18.

**6. Condition is symmetric and purpose-blind.** `10 − |Δrank| × 4`. On an **ARV** search a
comp in *better* condition than the subject's current state is the evidence you are looking
for, and this function penalises it exactly as hard as a derelict. §2.3.

**7. It ignores the two things only we have.** `arv_comp_count` / `asis_comp_count` /
`comp_count` — how many licensed appraisers independently reached for this property as a
comparable, and on which kind of grid — is a **strong, cheap prior** that no MLS tool
possesses, and it is already denormalised onto `properties` and indexed. Likewise the
`gross_adj_pct` the original appraiser needed: a property that took a 6% gross adjustment
on somebody else's report is a better comp than one that took 34%.

**8. Property type is compared as raw text.** `String(st).toLowerCase() === String(comp.property_type).toLowerCase()`
against `subject.property_type || subject.property_category` — two different vocabularies.
The repo already has one definition of this comparison
(`src/lib/property-type.js propertyTypeCompareKey`, and the 2026-08-02 rule that a bare
attachment style is not a category). This must route through it.

**Minor, but fix while you are there:** the 0–100 output reads as a percentage — "87%
match" implies a calibrated probability, which this is not; band it instead (§4.4). And
`add()` pushes into `parts` even for unknowns, so the "reasons" list is padded with
non-reasons.

## 4.3 The replacement — Gower-style, gated, purpose-aware

Two stages, in this order.

### Stage 1 — HARD GATES (excluded from the list, with a reason; never scored)

```
excluded when:
  • it is the subject itself
  • no sale price OR no sale date            → "we don't know what it sold for"
  • sale_status ≠ closed                     → unless include_listings, then scored with a penalty + badge
  • property category band differs           → propertyTypeCompareKey(subject) ≠ propertyTypeCompareKey(comp)
  • units differ and the subject has > 1 unit
  • beyond the HARD outer bounds             → distance > 10 mi, or sold > 36 months ago
```

Exclusions are **returned, counted, and collapsible** — "142 more properties were left out:
118 had no sale price, 19 are a different property type, 5 have not closed." Silently
dropping rows is how a user loses trust in a search box.

### Stage 2 — THE SCORE

Gower's construction: per facet, a distance `d ∈ [0,1]` (0 = identical) and a weight `w`.
Facets we cannot judge are **dropped from both sums**.

```
similarity = 1 − ( Σ wᵢ·dᵢ  /  Σ wᵢ )        over facets where dᵢ is computable
coverage   = Σ wᵢ(judged) / Σ wᵢ(all)        reported separately, never folded into the score
```

**Weights** (sum 100 when everything is known):

| Facet | w | `d` |
|---|---:|---|
| **Distance** | **22** | `0` up to 0.25 mi, then `min(1, (miles − 0.25) / 2.75)` → 3.0 mi is fully dissimilar. Fallbacks: same ZIP → `d = 0.35`; same city+state → `d = 0.60`; otherwise **drop the facet** |
| **Recency** | **20** | `0` up to 3 months, then `min(1, (months − 3) / 15)` → 18 months is fully dissimilar |
| **Living area** | **18** | `min(1, (\|Δgla\| / subject_gla) / 0.40)` → 40% off is fully dissimilar; ±20% ≈ `d 0.5` |
| **Condition** | **10** | `min(1, \|rank(comp) − rank(target)\| / 3)`, where `target` = the subject's grade for an **as-is** search and the after-repair grade (file value, else **C3**) for an **ARV** search |
| **Room count** | **8** | mean of `min(1, \|Δbeds\|/2)` and `min(1, \|Δbaths\|/1.5)`; whichever is known |
| **Age** | **7** | `min(1, \|Δyear_built\| / 30)` |
| **Lot size** | **5** | `min(1, (\|Δlot\| / subject_lot) / 0.50)` |
| **Quality (UAD Q)** | **5** | `min(1, \|Δrank\| / 3)` |
| **Corroboration** *(ours alone)* | **5** | `1 / (1 + n)` where `n` = times this property was used as a comp **on the matching grid type** (`arv_comp_count` for an ARV search, `asis_comp_count` for as-is). Never used → `d = 1`; used once → `0.5`; four times → `0.2` |

**Penalties applied after the weighted average** (multiplicative, so they cannot be
out-voted by a good size match):

```
× 0.80   sale_type matches /reo|short|estate|relocation/i   (distressed, still shown)
× 0.75   sale_status ≠ closed                               (only reachable via include_listings)
× 0.90   the appraiser who used it needed gross_adj_pct > 25   (a comp that was hard for them)
```

**Reference implementation** (drop-in replacement, same module, same export name):

```js
// weight, distance-in-[0,1] pairs; a null d means "we cannot judge this facet"
function scoreComp(subject, comp, opts = {}) {
  const { today = null, purpose = 'as_is', arvTargetCondition = 'C3' } = opts;
  const F = [];                                  // {key, label, w, d}
  const push = (key, label, w, d) => F.push({ key, label, w, d });

  // ---- distance (22) --------------------------------------------------------
  const mi = num(comp.distance_miles);
  if (mi != null)               push('distance', `${mi.toFixed(2)} miles away`, 22, clamp01((mi - 0.25) / 2.75));
  else if (sameZip(subject, comp))  push('distance', 'same ZIP code', 22, 0.35);
  else if (sameCity(subject, comp)) push('distance', 'same town', 22, 0.60);
  else                          push('distance', 'distance unknown', 22, null);

  // ---- recency (20) ---------------------------------------------------------
  const age = today && comp.sale_date ? monthsBetween(today, comp.sale_date) : null;
  if (age != null) push('recency', `sold about ${Math.round(age)} months ago`, 20, clamp01((age - 3) / 15));
  else             push('recency', 'sale date unknown', 20, null);

  // ---- living area (18) -----------------------------------------------------
  const sg = num(subject && subject.gla), cg = num(comp.gla);
  if (sg && cg) push('gla', `${Math.round(cg)} sq ft vs ${Math.round(sg)}`, 18, clamp01((Math.abs(cg - sg) / sg) / 0.40));
  else          push('gla', 'living area unknown', 18, null);

  // ---- condition (10) — the target depends on WHY we are searching ----------
  const target = purpose === 'arv'
    ? rankOf(CONDITION_SCALE, subject && subject.arv_condition_uad || arvTargetCondition)
    : rankOf(CONDITION_SCALE, subject && subject.condition_uad);
  const cc = rankOf(CONDITION_SCALE, comp.condition_uad);
  if (target != null && cc != null) {
    push('condition', purpose === 'arv'
      ? `condition ${comp.condition_uad} vs after-repair target ${CONDITION_SCALE[target]}`
      : `condition ${comp.condition_uad} vs ${subject.condition_uad}`,
      10, clamp01(Math.abs(cc - target) / 3));
  } else push('condition', 'condition unknown', 10, null);

  // ---- room count (8) -------------------------------------------------------
  const rd = [];
  const sb = num(subject && subject.beds), cb = num(comp.beds);
  if (sb != null && cb != null) rd.push(clamp01(Math.abs(sb - cb) / 2));
  const sBath = bathsOf(subject), cBath = bathsOf(comp);
  if (sBath != null && cBath != null) rd.push(clamp01(Math.abs(sBath - cBath) / 1.5));
  push('room_count', rd.length ? `${cb ?? '?'} bed / ${cBath ?? '?'} bath vs ${sb ?? '?'} / ${sBath ?? '?'}`
                               : 'room count unknown',
       8, rd.length ? rd.reduce((a, b) => a + b, 0) / rd.length : null);

  // ---- age (7) / lot (5) / quality (5) --------------------------------------
  const sy = num(subject && subject.year_built), cy = num(comp.year_built);
  push('age', sy && cy ? `built ${cy} vs ${sy}` : 'year built unknown',
       7, sy && cy ? clamp01(Math.abs(cy - sy) / 30) : null);

  const sl = num(subject && subject.lot_sqft), cl = num(comp.lot_sqft);
  push('lot', sl && cl ? `lot ${Math.round(cl)} vs ${Math.round(sl)} sq ft` : 'lot size unknown',
       5, sl && cl ? clamp01((Math.abs(cl - sl) / sl) / 0.50) : null);

  const sq = rankOf(QUALITY_SCALE, subject && subject.quality_uad);
  const cq = rankOf(QUALITY_SCALE, comp.quality_uad);
  push('quality', sq != null && cq != null ? `quality ${comp.quality_uad} vs ${subject.quality_uad}` : 'quality unknown',
       5, sq != null && cq != null ? clamp01(Math.abs(cq - sq) / 3) : null);

  // ---- corroboration (5) — the thing only WE have ---------------------------
  const used = purpose === 'arv' ? num(comp.arv_comp_count) : num(comp.asis_comp_count);
  if (used != null) {
    push('corroboration',
      used > 0 ? `${used} of our appraisers used this as ${purpose === 'arv' ? 'an ARV' : 'an as-is'} comp`
               : 'never used as a comp on one of our reports',
      5, 1 / (1 + used));
  } else push('corroboration', 'not known', 5, null);

  // ---- Gower average over the facets we could judge -------------------------
  const judged = F.filter((f) => f.d != null);
  const wJudged = judged.reduce((a, f) => a + f.w, 0);
  const wAll = F.reduce((a, f) => a + f.w, 0);
  let sim = wJudged ? 1 - judged.reduce((a, f) => a + f.w * f.d, 0) / wJudged : 0;

  // ---- multiplicative penalties --------------------------------------------
  const flags = [];
  if (comp.sale_type && /reo|short|estate|relocation/i.test(String(comp.sale_type))) { sim *= 0.80; flags.push('distressed sale'); }
  if (comp.sale_status && comp.sale_status !== 'closed')                             { sim *= 0.75; flags.push('not a closed sale'); }
  if (num(comp.appraiser_gross_adj_pct) > 25)                                        { sim *= 0.90; flags.push('needed heavy adjusting on the report it came from'); }

  return {
    score: Math.round(sim * 1000) / 10,                 // 0..100, one decimal
    band: sim >= 0.85 ? 'excellent' : sim >= 0.70 ? 'strong' : sim >= 0.55 ? 'fair' : 'weak',
    coverage: wAll ? Math.round((wJudged / wAll) * 100) : 0,
    judgedOn: judged.length, of: F.length,
    parts: F.map((f) => ({ key: f.key, label: f.label, weight: f.w,
                           contribution: f.d == null ? null : Math.round((1 - f.d) * f.w * 10) / 10,
                           known: f.d != null })),
    flags,
  };
}
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
```

**Where it runs.** In JS, over the candidate rows the SQL gate already returned. At our
volume (§6) that is ≤ a few hundred objects and costs microseconds. Do not push this into
SQL — it would be unreadable, unindexable, and untestable, and `scripts/test-research-valuation.js`
already tests it as a pure function.

## 4.4 Presenting the score honestly

**Never print a bare percentage.** "87% match" reads as a calibrated probability. It is a
weighted average of hand-chosen distances over an appraiser-selected, non-random sample —
the honesty rule `valuation.js` already applies to `confidenceOf` ("a confidence LABEL,
never a fake percentage") applies here identically.

Ship this instead, on every result card:

```
  ●●●● Excellent match          judged on 7 of 9 characteristics
  0.3 mi · sold 2 months ago · 1,340 sq ft vs 1,280 · C3 vs C3
  ⚠ we have no lot size or quality grade on file for this one
  ✓ 2 of our appraisers used this as an ARV comp
```

- **Band + dots**, with the numeric score available on hover for anyone who wants it.
- **Coverage stated separately and always.** "Judged on 7 of 9" is the single most
  important number on the card and it is the one every product in §1 omits.
- **The three biggest contributors, in words**, from `parts`.
- **Unknowns listed explicitly** — not silently absent.
- **Flags shown, never used to hide a row.**

And one line at the top of the list, which is the honest frame for the whole feature:

> *These are ranked by how closely they match the subject on the facts we hold. This is not
> an appraisal and it does not choose your comparables — an appraiser would look at things
> this list cannot see.*

---

# 5. SEARCH FEATURES WE ARE MISSING — prioritised

Effort: **S** ≈ under a day · **M** ≈ 1–3 days · **L** ≈ a week or more.

## P0 — the ones that change what the tool is

| # | Feature | What it is | Why it matters here | Effort |
|---|---|---|---|---|
| 1 | **The subject-anchored comp screen** | a screen at `/internal/research/comps` for the `GET /api/research/comps` endpoint that already exists and has no UI | this is the owner's actual request, and the server half is written | **M** |
| 2 | **"Find comparables" from a loan file** | a button in the appraisal section of `StaffApplication.jsx` → `/internal/research/comps?application_id=…` | Realist's lesson: never make the user leave the file. Turns the warehouse from a curiosity into part of the workflow | **S** |
| 3 | **The relaxation ladder** (§2.4) | server-side widening to a target count, with the steps returned and shown | the difference between "no results, try again" and a tool that answers | **M** |
| 4 | **A durable comparison tray** | today's `picked` Map dies on navigation and on reload; persist to `sessionStorage`, show it on every research screen, allow reorder into numbered slots (TOTAL's model) | you cannot browse three towns and keep your picks. This makes the current tray nearly unusable for a real search | **S** |
| 5 | **Side-by-side compare** | the tray's "Compare" view: subject pinned in column 1, up to 6 comps beside it, one row per characteristic, differences highlighted | every product in §1 has this. It is where a human actually decides | **M** |
| 6 | **CSV / XLSX export** | export the result set or the tray; `src/lib/xlsx.js` is already a dependency-free builder used by the draw and TPR exports | comps get pasted into emails and investor packages today by hand. Cap at Redfin's shape: no export under 20 rows, hard cap at ~1,000 | **S** |
| 7 | **Table view + column chooser** | a dense table beside the card list; user picks the columns; sort by `$/sq ft` already exists in `SORTS` | the card list is unreadable past ~15 results and cannot be scanned for outliers | **M** |

## P1 — the ones that make it fast

| # | Feature | What it is | Why it matters here | Effort |
|---|---|---|---|---|
| 8 | **Saved searches** | a search here is *already a URL* (`useSearchParams`) — a saved search is a name + that query string + an owner. One table, three routes | near-free given the URL-as-state design. "My Passaic 3-beds" is a daily query for a loan officer | **S** |
| 9 | **Search history** | the last 20 searches this user ran, as clickable chips; client-side is fine to start | re-running yesterday's search is the most common action in any search tool | **S** |
| 10 | **Recently viewed properties** | last 20 property pages opened | same reason | **S** |
| 11 | **"Properties near this one"** | a pre-seeded 0.5-mile radius search on `StaffPropertyDetail.jsx` | Zillow's "nearby recently sold": zero input, high use. `search.js` already does radius | **S** |
| 12 | **"Other properties this appraiser used"** | `search.js` already accepts `appraiser_id`; there is no UI for it | our unique asset. "Show me every comp Joe Smith has ever leaned on in Paterson" is a real underwriting question, and it is one link from the appraiser profile | **S** |
| 13 | **Preset chips** | "Everything in this ZIP sold last quarter", "3-beds in this town under $400k", "Used as an ARV comp in the last year" | a preset is a saved search with no owner. Removes the blank-page problem | **S** |
| 14 | **Bulk select** | "select all 20 on this page" → tray, with a cap | you cannot assemble a 20-property export one checkbox at a time | **S** |
| 15 | **The distance rose** (§3.3) | dependency-free SVG map | proximity and clustering, at zero cost | **M** |
| 16 | **Bracketing helper** | after 3+ picks: "all three are bigger than the subject — find me a smaller one" as a one-click search | `valuation.js` already detects `no_gla_bracket` at grid time, too late to act on. Bracketing is core appraisal practice ([SAMCO](https://samco-amc.com/blog/bracketing), [Riverfront Appraisals](https://riverfrontappraisals.com/the-loan-officers-guide-to-appraisals-part-5-what-is-bracketing-and-why-do-we-do-it/)) and nothing in the product helps you achieve it | **M** |
| 17 | **Pinned subject header** | subject facts above the results, editable in place | universal in §1; also the only way to correct an `as_repaired` roll-up before it poisons the ranking | **S** |

## P2 — real value, more work, do after P0/P1 land

| # | Feature | What it is | Why it matters here | Effort |
|---|---|---|---|---|
| 18 | **Auto-notify on new matches** | a saved search + a nightly sweep + the existing digest self-gate pattern in `src/lib/notification-digests.js` | **worded honestly**: our data appears when an *appraisal is imported*, not when the market moves. "Tell me whenever any of our appraisers writes up a property in Passaic" is genuinely useful; "new listings" is not what this is. Copy Matrix's **250-result cap** — a saved search that broad cannot be an alert | **M** |
| 19 | **"Sold twice" / flip finder** | `property_sales` holds every distinct transaction; nothing surfaces multiples. "Every property in this town that sold twice within 24 months, and the spread" | for a fix-and-flip lender this may be the single most valuable query in the warehouse and it is one `GROUP BY … HAVING count(*) > 1` away | **M** |
| 20 | **"What the appraiser did with it"** | on each result: how many reports used it, on which grid, the gross adjustment they needed, and (from the observation) their stated proximity | no MLS tool can do this. It is the strongest quality signal we own, and it is already in `property_observations` | **M** |
| 21 | **Days-on-market filter** | `property_observations.days_on_market` is stored and unsearchable | a 200-DOM sale is telling you the price was wrong | **S** |
| 22 | **Near-duplicate detection** | `address_key` dedupes exact matches; the residual is unit variants ("Apt 2" vs "#2"), missing house-number suffixes, and typo'd streets. An admin screen listing suspected pairs with a merge action | a **data-quality** feature, not a search feature. Present it that way — an admin queue, never an automatic merge (see the borrower-merge precedent: a human decides) | **M** |
| 23 | **Print / share a result set** | a stable link plus a print stylesheet | the search is already a URL; this is mostly CSS | **S** |

## P3 — later, or never (see §7 for the ones that are "never")

Photo thumbnails in the result list (`property_photos` exists; it is a per-row extra
fetch); comp-set reconciliation against a specific appraisal ("this report used 4 comps;
here are 3 our ranking preferred and why" — the Clear Capital CDA shape); rental comps off
`market_rent`/`unit_mix` for DSCR files.

---

# 6. SCALE AND PERFORMANCE — be realistic

## 6.1 The actual numbers

Each imported appraisal yields one subject plus 3–8 comparables. At a few thousand imported
reports, `properties` is **low tens of thousands of rows** and `property_observations` is
maybe **2–3×** that. Every row is narrow — the widest is a few hundred bytes.

**Tens of thousands of rows is a table that fits in RAM several times over.** A sequential
scan of 50,000 narrow rows in Postgres is single-digit milliseconds. After the first query
the whole table and every index are in `shared_buffers` and stay there.

## 6.2 What needs no engineering at all at this size

Everything below is fine as written, and "optimising" any of it now is wasted work:

- **`count(*) OVER ()` in `searchProperties`.** It is an extra window node over the already
  materialised result. Fine to ~100k rows.
- **`OFFSET` pagination.** `OFFSET` is O(offset), and our offsets max out around 25 × 20
  pages. Keyset paging (documented in `PROPERTY-SEARCH-ENGINE-RESEARCH.md` §2.1) is the
  right answer at 10–100× and is not needed now.
- **The facet CTE.** One materialised pass, six aggregates. At 50k rows it is a few ms.
- **Bounding box + haversine refine.** The box uses `idx_properties_latlng`; the trig runs
  on what survives. No PostGIS needed at any volume we will plausibly reach.
- **Scoring in JS.** ≤ a few hundred objects per request, microseconds.
- **The `ILIKE '%…%'` fallback** in `buildQuery` for punctuation-only input. It is a
  sequential scan and it is reached almost never.
- **The relaxation ladder's up-to-11 queries.** ~5 ms each on a cached table.
- **`ratesFor`'s `LIMIT 4000`.** Uses `idx_prop_obs_sale_date`; fine.
- **The boot backfill's 400-reports-per-pass.** Self-draining via `property_ingest_log`.

## 6.3 What matters *now*, regardless of size

Two things, and only two:

1. **A `statement_timeout` on the research path.** Not for performance — for containment. A
   pathological filter combination must not pin a pool connection. `SET LOCAL
   statement_timeout = '5s'` around the research queries.
2. **The `LIMIT` clamps that already exist must stay.** `MAX_LIMIT = 200` in `search.js`,
   `slice(0, 24)` on valuation comps, the 8-word cap in `tsPrefixQuery`. An export feature
   (P0 #6) adds a new unbounded knob and needs its own cap.

## 6.4 What would only matter at 10×–100×

Do not build any of this now. Written down so nobody re-derives it later:

- Keyset pagination (`PROPERTY-SEARCH-ENGINE-RESEARCH.md` §2.1).
- Approximate counts from `EXPLAIN`, or a `count(*)` capped by a subquery `LIMIT`.
- Materialised facet counts, refreshed after each ingest pass.
- A geohash column or PostGIS, once the bounding box stops being selective.
- Precomputed nearest-neighbour lists per property.
- A partial index for the "closed sales with a price" subset, once it stops being ~most of
  the table.

**The first thing that will actually get slow** is not the search. It is
`ratesFor`/`suggestAdjustments` joining `property_observations` to `properties` and pulling
4,000 rows on every valuation "suggest" — because observations grow faster than properties
and that query runs on a user click. Watch it; do not pre-optimise it.

---

# 7. WHAT NOT TO BUILD

Opinionated, and each one is attractive.

**1. A trained AVM — regression, gradient boosting, anything fitted.** The owner mentioned
"build up our own AVM model." The honest answer is that our data cannot carry one yet, and
`COMP-DATABASE-INDUSTRY-RESEARCH.md` §6.2 already sets out why: appraiser-selected comps
are a **deliberately non-random sample** — they are the sales an appraiser chose *because
they supported a value*. A model fitted on them learns appraiser selection behaviour, not
the market, and it will be confidently wrong in exactly the cases where we most need it to
be right. **Build the transparent grid instead** (which we have) and let the "AVM" be the
weighted reconciliation of comps a human picked and can defend. Revisit when we have a
market-wide sale feed, not before.

**2. Polygon / freehand draw search.** It looks like the flagship map feature. It requires
a basemap (§3), and RPR's own guidance is that polygon is for *"clear, linear boundaries…
such as a highway or river"* — i.e. it is useful to someone who already knows the local
geography, which is the person least in need of the tool. Over a few thousand points in a
handful of towns, a drawn polygon and a 1.5-mile radius will return nearly the same set.
Cost: high. Marginal value here: low.

**3. Neighbourhood / subdivision / school-district search.** We have **no boundary
geometry, no school data, and no authoritative neighbourhood field** — `properties.neighborhood`
is whatever one appraiser typed. Offering a neighbourhood filter over free text would
produce a dropdown of typos.

**4. Elasticsearch, OpenSearch, or any separate search service.** Postgres tsvector + GIN
already handles our address search (`db/408`, and note `pg_trgm` is contrib and cannot be
assumed on managed Postgres). Adding an operational dependency to search 50,000 rows is
indefensible.

**5. A market-trends dashboard — median price by month by town.** With a handful of
appraiser-chosen sales per town per quarter the line will swing 20% month to month for
purely compositional reasons, and everyone who sees a chart believes it. `valuation.js`
already refuses to publish a time trend below `minSample × 2` for exactly this reason; a
dashboard would quietly override that refusal by drawing the line anyway.

**6. Auto-selecting the comps.** Not one product surveyed does it (§1.4), including
Fannie's own CU. Rank, explain, let the human pick. There is a second reason specific to
us: an auto-picked comp set feeding an ARV that feeds a term sheet is a number nobody
signed, on a regulated-adjacent surface.

**7. A confidence *percentage* on a match.** §4.4.

**8. "Search as I pan" on the map.** Multiplies query volume by mouse movement and breaks
the URL-as-state contract this screen currently gets right.

**9. Photo / vision similarity.** We have photos. Comparing them is a research project with
no defensible link to value, and the compute would exceed everything else in this document
combined.

**10. A second scoring implementation.** There is exactly one `scoreComp`. The search
ranking, the valuation "suggested comps" list, and any future CDA-style review all call the
same function. Two similarity scores that disagree about the same pair of properties is the
`pilot_term_norm` class of bug all over again.

**11. Borrower-facing anything.** `/api/research` is `requireStaff` as a whole router
(`src/routes/research.js`). It shows other people's property addresses and sale prices. It
stays that way.

**12. Exporting the whole warehouse.** Cap every export. Redfin caps at 350; a hard cap of
~1,000 rows with a "narrow your search" message is the right shape.

---

# RECOMMENDED BUILD ORDER

Each stage ships on its own and leaves the product better. Nothing here changes a frozen
engine, a pricing number, or any borrower-facing surface.

---

## Stage 1 — The subject-anchored comp screen *(the owner's actual request)*

**Server** — extend the existing `GET /api/research/comps` in `src/routes/research.js`:

- accept `min_comps` (default **8**), `max_comps` (default **20**), `purpose`
  (`as_is` | `arv`, default `as_is`), `include_listings` (default false)
- change the default `limit` from **60 → 20**
- run the relaxation ladder server-side and return the `relaxation` block from §2.5
- return an `excluded` summary (counts by gate reason), never a silent drop
- **remove the price filter** from the comp path entirely, and drop any `price_min`/`price_max`
  arriving from a browse state, with a note in the response saying why

**Ring-0 defaults** (all overridable, all rendered as editable chips):

| | |
|---|---|
| property category | **must match** (`propertyTypeCompareKey`) — hard gate |
| units | must match when subject units > 1 — hard gate |
| sale status | **closed only** |
| sold within | **6 months** |
| radius | **1.0 mile** (falls back to same ZIP → same city when the subject has no lat/lng) |
| living area | **±20%** |
| bedrooms | **±1** |
| year built | **±15 years** |
| bathrooms | **no filter** (scored) |
| condition / quality | **no filter** (scored) |
| price | **no filter — never** |
| distressed / REO | **included, flagged** |
| target | **min 8, show 20, "too many" at 40** |

**Relaxation ladder, in this exact order** — one step at a time, stop when ≥ `min_comps`:

```
 1. sold within      6 → 12 months
 2. living area      ±20% → ±25%
 3. radius           1.0 → 1.5 mi
 4. bedrooms         ±1 → ±2
 5. year built       ±15 → ±25 years
 6. sold within      12 → 24 months
 7. radius           1.5 → 3.0 mi
 8. year built       drop the filter (score only)
 9. radius           3.0 → 5.0 mi  AND  drop the living-area band (score only)
10. statuses         add active + pending, each badged "asking price, not a sale"
11. stop and say so: "We hold N properties in {town}; nothing is being hidden by a filter."
```

Never relaxed: property category, unit count, the subject exclusion, the price non-filter.

**Client** — new screen `app-v2/src/screens/StaffCompSearch.jsx` at
`/internal/research/comps`, URL-as-state like the existing browse screen:

- pinned, editable **subject panel** at the top (three entry doors: `application_id`,
  `property_id`, typed address)
- an **as-is / ARV** toggle that sets `purpose` and the condition target together
- the criteria as **chips**, each one click to edit
- the **ladder strip** showing which steps fired, each undoable
- **20 results**, each carrying its band, coverage, three reasons, and any badges
- **"Show 20 more"**, never infinite scroll
- the tray, and **"Build a valuation from these →"** (the flow that already exists)

**Also stage 1** (both trivial, both remove the blank page):
- a **"Find comparables"** button on the loan file's appraisal section →
  `?application_id=…`
- a **"Find comparables for this"** button on `StaffPropertyDetail.jsx` → `?property_id=…`

---

## Stage 2 — The scoring function

Replace `scoreComp` in `src/lib/research/valuation.js` with the §4.3 implementation. Same
module, same export name, same call sites. Extend `scripts/test-research-valuation.js`
first, with cases that **fail on the current implementation**:

- a next-door identical property with **no coordinates and no GLA** must score
  `excellent` with `coverage ≈ 55%` — today it cannot exceed 45/100
- a **pending listing** must be gated out unless `include_listings`
- a **2–4 unit** against a 1-unit subject must be gated out
- a comp with **no sale price** must be gated out
- on `purpose:'arv'`, a **C3 comp against a C5 subject** must outscore a C5 comp; on
  `purpose:'as_is'`, the reverse
- a property used as a comp on **4 prior reports** must outrank an identical one used on
  none
- an **REO** must rank below an identical arm's-length sale
- property type must compare through **`propertyTypeCompareKey`**, so `Detached` never
  reads as a category

Then wire the presentation: bands and dots, `judged on N of 9`, unknowns listed explicitly,
flags shown but never hiding a row, and the standing line — *"ranked by how closely they
match on the facts we hold; this is not an appraisal and it does not choose your
comparables."* No bare percentage anywhere.

---

## Stage 3 — The tray, compare, and export

- persist the tray to `sessionStorage`; show it on the browse screen, the comp screen and
  the property page; allow reordering into **numbered slots** (comp 1…6)
- **side-by-side compare**: subject pinned in column 1, up to 6 comps, one row per
  characteristic, differences highlighted
- **bulk select** ("all 20 on this page"), capped
- **CSV + XLSX export** of the result set or the tray via the existing dependency-free
  `src/lib/xlsx.js`; no export below 20 rows, hard cap 1,000, and the disclaimer travels in
  the file
- the **bracketing helper**: after 3+ picks, "all of these are bigger than the subject —
  find a smaller one" as a one-click search

---

## Stage 4 — The map

**Build the distance rose. Do not add a map dependency.**

A ~380 px same-origin SVG: subject pin at centre; labelled rings at **0.25 / 0.5 / 1 / 2
miles**; each comp a dot at its true bearing and scaled distance, coloured by match band;
hover for address + price; **click toggles the tray** (the same `toggle(row)` the list
uses); the active radius drawn as a shaded disc; properties with no coordinates in a
labelled strip beneath, neither hidden nor placed.

Cost: **$0**, no npm dependency, no CSP change, no third-party disclosure of which
properties we are researching.

**Only if somebody hits the real wall** — "I need to see that the highway runs between
these" — add **phase 2**: `npm i leaflet` in `app-v2` (BSD-2, ~42 KB gz, no transitive
dependencies, no WebGL, no web workers), vendored through Vite and **never from a CDN**;
raster tiles from a **keyed commercial vendor** with the URL in an env var — **not** OSM's
community servers, whose policy is explicit that heavy use may be *"blocked without
notice"* ([OSMF Tile Usage
Policy](https://operations.osmfoundation.org/policies/tiles/)). CSP additions needed:
`img-src` for the tile host only — Leaflet positions layers through
`element.style.transform`, which CSP does not block ([MDN —
style-src-attr](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/style-src-attr)).
The map is a **view of the current result set**, never its own query; no search-as-I-pan;
no polygon draw.

Rejected, with the numbers: **Google Dynamic Maps** — 10,000 free map loads/month then
**$7/1,000**, four CSP directives, a browser-visible key. **Mapbox GL JS v2+** —
**proprietary licence since December 2020**, billed per `Map` initialisation, 50,000 free
then ~**$5/1,000**. **MapLibre** — free and BSD-3, but still needs a keyed vector-tile
vendor and brings WebGL plus `worker-src blob:` for a job that needs six dots and four
circles.

---

## Stage 5 — Saved searches, history, presets, alerts

- **saved searches**: name + query string + owner. Near-free, because a search here is
  already a URL.
- **search history** (last 20) and **recently viewed properties** (last 20).
- **presets**: "everything in this ZIP sold last quarter", "used as an ARV comp in the last
  year", "3-beds in this town".
- **"Other properties this appraiser used"** — `search.js` already accepts `appraiser_id`;
  add the link from the appraiser profile.
- **"Properties near this one"** — a pre-seeded 0.5-mile radius on the property page.
- **alerts, last and worded honestly**: a nightly sweep over saved searches, reusing the
  `audit_log` self-gate pattern in `src/lib/notification-digests.js`. The email says *"a new
  appraisal we imported mentions a property matching your saved search"* — because that is
  what actually happened. Copy Matrix's **250-result cap**: a saved search that broad cannot
  become an alert ([CRMLS](https://kb.crmls.org/knowledgebase/turning-saved-searches-into-auto-emails-in-matrix/)).

---

## Stage 6 — The things only we can do

- **"What the appraiser did with it"** on every result: how many reports used it, on which
  grid type, the gross adjustment they needed, their stated proximity — straight out of
  `property_observations`.
- **The flip finder**: every property that sold twice within 24 months and the spread, out
  of `property_sales`.
- **Days-on-market** as a filter.
- **Near-duplicate detection** as an **admin data-quality queue** with a human merge action,
  never an automatic merge.

---

## Never (see §7)

A fitted AVM · polygon / freehand draw · neighbourhood & school-district filters ·
Elasticsearch · a market-trends chart · auto-selected comps · a confidence percentage ·
search-as-I-pan · photo similarity · a second scoring implementation · any borrower-facing
exposure of this data · an uncapped export.

---

## Sources

- [Fannie Mae Selling Guide B4-1.3-08, Comparable Sales](https://selling-guide.fanniemae.com/sel/b4-1.3-08/comparable-sales) · [B4-1.3-07, Sales Comparison Approach](https://selling-guide.fanniemae.com/sel/b4-1.3-07/sales-comparison-approach-section-appraisal-report)
- Collateral Underwriter: [Fannie Mae CU fact sheet](https://singlefamily.fanniemae.com/media/20576/display) · [McKissock — CU FAQs](https://www.mckissock.com/blog/appraisal/fannie-maes-collateral-underwriter-program/) · [Appraisal Buzz — CU FAQs](https://appraisalbuzz.com/faqs-about-fannie-maes-collateral-underwriter-program/) · [JVM Lending — the dreaded CU score](https://www.jvmlending.com/blog/appraisal-issues-the-dreaded-cu-score/) · [Walser — CU scoring explained](https://www.linkedin.com/pulse/fannie-mae-collateral-underwriter-scoring-explained-mark-walser) · [Zumwalt — understanding the CU report](https://www.linkedin.com/pulse/article-help-appraisers-better-understand-fannie-mae-cu-larry-zumwalt)
- Matrix / CoreLogic: [CRMLS — Matrix 360 CMA](https://kb.crmls.org/knowledgebase/matrix-360-cma/) · [Canopy MLS — CMA](https://support.canopymls.com/kb/article/28-cma/) · [OneKey MLS — creating a CMA in Matrix](https://support.onekeymls.com/hc/en-us/articles/33160131337620-Creating-a-Comparative-Market-Analysis-CMA-in-Matrix) · [CRMLS — saved searches → auto emails](https://kb.crmls.org/knowledgebase/turning-saved-searches-into-auto-emails-in-matrix/) · [MLSListings — Realist tax searches inside Matrix](http://portal.mlslistings.com/blog/articles/matrix-360-run-realist-tax-searches-within-matrix/) · [CoreLogic Matrix datasheet](https://pages.corelogic.com/hubfs/CoreLogic%20USA/Website%20PDF%20Files/RES-MLS-Matrix-Datasheet-2023.pdf)
- Paragon: [CRMLS — Paragon Connect EasyCMA](https://kb.crmls.org/knowledgebase/paragon-connect-easycma/) · [Paragon Help — CMA step 1: subject property](http://paragonconnect.paragonrels.com/paragon/create-a-cma-presentation/item/62-basic-search) · [Paragon CMA presentations](https://help.paragonrels.com/Overviews/CMA/MLS_Paragon_CMA.htm)
- Flexmls: [Comps tab (CMA)](https://help.flexmls.com/en/comps-tab--cma-.html) · [Create a Full CMA](https://help.flexmls.com/en/create-a-full-cma.html) · [Create a Quick CMA](https://help.flexmls.com/en/create-a-quick-cma.html) · [METRO MLS — the three CMA types](https://metromls.com/the-three-cma-types-in-flexmls/)
- RPR: [How do I run a map search](https://blog.narrpr.com/support/how-do-i-run-a-map-search/) · [RPR Maps: get the big picture](https://blog.narrpr.com/tips/rpr-mapping/) · [A CMA builder for REALTORS®](https://blog.narrpr.com/tips/building-spot-on-cma/)
- ATTOM: [Developer guides & API examples](https://api.developer.attomdata.com/docs/guides) · [Developer platform](https://api.developer.attomdata.com/dlpv2docs) · [Property characteristics / ATTOM ID](https://cloud-help.attomdata.com/article/497-property-characteristics)
- HouseCanary: [Property Explorer quick start](https://www.housecanary.com/blog/property-explorer-quick-start-guide) · [Property Explorer](https://www.housecanary.com/products/property-explorer) · [Review selected comps](https://appraiser.support.housecanary.com/hc/en-us/articles/228497028-Review-Selected-Comps)
- Clear Capital: [Desktop appraisal](https://www.clearcapital.com/products/desktop-appraisal/) · [Collateral Desktop Analysis](https://www.clearcapital.com/products/collateral-desktop-analysis-cda/)
- Appraiser desktop: [a la mode TOTAL — Comps Database](https://help.alamode.com/appraiser/total/compsdatabase.htm)
- Redfin: [Downloading data](https://support.redfin.com/hc/en-us/articles/360016476931-Downloading-Data)
- Comp-search practice: [Working RE — Search parameters and the best comparables](https://www.workingre.com/search-parameters-and-the-best-comparables/) · [RealVals — appraisal comparable guidelines](https://realvals.com/appraisal-comparable-guidelines/) · [iBuyer — how to pull comps](https://ibuyer.com/blog/how-to-pull-comps-on-a-house/) · [iBuyer — how to find comps](https://ibuyer.com/blog/comps-for-my-house/) · [McKissock — credible appraisal when comps are limited](https://www.mckissock.com/blog/appraisal/arriving-at-an-accurate-appraisal-even-when-comps-are-few/) · [SAMCO — bracketing](https://samco-amc.com/blog/bracketing) · [Riverfront Appraisals — what is bracketing](https://riverfrontappraisals.com/the-loan-officers-guide-to-appraisals-part-5-what-is-bracketing-and-why-do-we-do-it/) · [Riverfront Appraisals — how appraisers choose comps](https://riverfrontappraisals.com/appraisal-blog-the-realtors-guide-to-appraisals-part-3-how-appraisers-choose-comps/)
- Similarity maths: [Wikipedia — Gower's distance](https://en.wikipedia.org/wiki/Gower%27s_distance) · [Gower's similarity coefficients with automatic weight selection (arXiv:2401.17041)](https://arxiv.org/pdf/2401.17041) · [Towards Data Science — Gower's distance for mixed data](https://towardsdatascience.com/gowers-distance-for-mixed-categorical-and-numerical-data-799fedd1080c/) · [Improvement and comparison of weighted kNN classifiers](https://scialert.net/fulltext/?doi=jse.2016.109.118) · [A new distance-weighted kNN classifier](https://www.researchgate.net/publication/266872328_A_New_Distance-weighted_k_-nearest_Neighbor_Classifier)
- Mapping: [OSMF Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/) · [OSMF Vector Tile Usage Policy](https://operations.osmfoundation.org/policies/vector/) · [Mapbox pricing](https://www.mapbox.com/pricing) · [Mapbox pricing docs](https://docs.mapbox.com/accounts/guides/pricing/) · [Google Maps Platform pricing](https://mapsplatform.google.com/pricing/) · [Google — up to 10,000 monthly free calls per product](https://mapsplatform.google.com/resources/blog/start-building-today-with-up-to-10-000-monthly-free-calls-per-product/) · [Stadia Maps — Mapbox GL JS v2 licence change](https://stadiamaps.com/blog/mapbox-gl-licensing-and-stadia-maps/) · [mapbox-gl-js issue #10162 — v2 licence](https://github.com/mapbox/mapbox-gl-js/issues/10162) · [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) · [MapTiler — MapLibre fork announcement](https://www.maptiler.com/news/2021/01/maplibre-mapbox-gl-open-source-fork/)
- CSP: [MDN — style-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/style-src) · [MDN — style-src-attr](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/style-src-attr)
- MLS alerting: [Market Leader — Listing Alerts](http://learn.marketleader.com/display/help/Listing+Alerts)
