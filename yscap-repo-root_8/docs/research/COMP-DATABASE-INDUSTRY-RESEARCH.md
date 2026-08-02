# Comparable-Sales Database — Industry Research

**Status:** research only. No code changes. Written 2026-08-02.
**Scope:** how the property-data industry models comps, what the appraisal sales-comparison
approach actually is, what Fannie/Freddie/USPAP constrain, how production AVMs work, how time
adjustments are supported, and what is honestly achievable with a few thousand internally-sourced
comp rows.

**Our situation, restated so the recommendations are anchored to it:** the only input is MISMO 2.6
GSE appraisal XML filed by our borrowers' appraisers (URAR 1004, small-income 1025, condo 1073).
Each report yields one subject property plus 3–8 comparable sales, each with a full UAD grid line and
extracted photos. We have no MLS licence, no public-record/assessor feed, no national parcel layer.

A quick note on sourcing: several primary sources (`selling-guide.fanniemae.com`,
`sf.freddiemac.com`, `homebuyer.com`) refuse automated fetches from this environment, so where a rule
is quoted below it is reconstructed from search-engine extracts of those pages plus secondary
industry sources, and the primary URL is given so a human can verify. Anywhere I am reconstructing
rather than quoting verbatim, I say so.

---

## 1. How the industry models this data

### 1.1 The four-entity core

Every serious property warehouse — CoreLogic/Cotality, Black Knight (now ICE), ATTOM, HouseCanary,
Clear Capital, RPR, Zillow, Redfin — converges on the same four-entity separation. Names differ;
the shape does not.

| Entity | Grain | Mutable? | Examples of contents |
|---|---|---|---|
| **Property** | one physical parcel/dwelling unit, forever | identity is immutable; attributes are not stored here | stable surrogate ID, canonical address, geocode, parcel/APN, unit designator |
| **Characteristics / assessment record** | one *observation* of the property's physical facts, as of a date, from a source | append-only | GLA, beds, baths, year built, lot size, quality, condition, garage, pool |
| **Transaction / sale event** | one transfer of title | append-only, corrections appended | deed date, recording date, contract date, price, grantor/grantee, deed type, arms-length flag, financing |
| **Listing** | one marketing episode | has a lifecycle (state machine) | list date, list price, price changes, status (active→pending→sold→withdrawn→expired), DOM, concessions, MLS number, agent/office |

Two more entities are always present in practice:

- **Valuation / opinion** — an AVM run, an appraisal, a BPO, an assessor's assessed value. A
  *value opinion is not a fact about the property*; it is a dated opinion by a named party, and it
  belongs in its own table with a method, an effective date, an author, and a confidence measure.
- **Media** — photos, floor plans, sketches, documents, each tied to a property *and* to the
  observation event that produced it (an appraisal photo dated 2024-03 is evidence about the
  property's condition in March 2024, not today).

The single most important structural idea: **the property is a thin, stable spine; everything else
is a dated observation hanging off it.** Nobody credible stores "the GLA of 123 Main St" as a scalar
column that gets `UPDATE`d. Cotality markets exactly this as the value proposition of its CLIP
identifier — "a unique identifier that links all instances of that property across their data sets,"
maintaining "property lineage and consistency through APN changes, parcel splits/merges, and boundary
shifts" ([Cotality CLIP](https://www.cotality.com/products/clip)). ATTOM does the same with the
integer ATTOM ID — "a single, permanent identifier to each property... Being numbers, ATTOM IDs can
be processed very quickly in relational databases"
([ATTOM Cloud Help](https://cloud-help.attomdata.com/article/497-property-characteristics)).

### 1.2 "One property, many observations over time"

The canonical implementation is a **bitemporal, append-only observation table**:

```
property_observation(
  observation_id,
  property_id,            -- FK to the thin spine
  source_id,              -- which appraisal / MLS / assessor / borrower supplied it
  attribute,              -- 'gla_sqft' | 'bedrooms' | 'condition_uad' | ...
  value_text, value_num,
  effective_date,         -- valid time: when the fact was true of the property
  observed_at,            -- transaction time: when we learned it
  confidence,             -- source-tier * corroboration
  superseded_by           -- nullable, set when a later observation is chosen as golden
)
```

Two clocks matter and are routinely confused by teams building this for the first time:

- **Valid time / effective date** — the appraiser inspected on 2024-03-14, so the C3 condition
  rating is a fact *about March 2024*.
- **Transaction time / ingest date** — we received that XML on 2024-04-02, possibly after we
  received a 2024-06 report that also mentions the property.

You need both, because late-arriving data about an earlier date is the normal case, not the
exception. Without valid time you cannot answer "what did we believe this property looked like when
that comp sold"; without transaction time you cannot reproduce a value opinion you issued last
quarter, which is an audit requirement the moment a value influences a credit decision.

The read model on top is a **"golden record" / survivorship view** computed per attribute, not per
record. Typical survivorship rule stack, applied in order:

1. **Source tier.** A measured-on-site appraiser GLA beats an MLS GLA beats an assessor GLA beats a
   user-supplied GLA. (Zillow explicitly ranks owner-supplied "home facts" below verified sources
   but still ingests them — "If the data is incorrect or incomplete, updating your home facts may
   affect your Zestimate" ([Zillow](https://zillow.zendesk.com/hc/en-us/articles/360057435854-What-is-a-Zestimate-home-value)).)
2. **Recency of effective date**, within tier.
3. **Corroboration count.** Three independent sources saying 1,842 sq ft beat one saying 2,100.
4. **Plausibility / physical-constraint checks.** A 2024 observation of "GLA 4,200" on a property
   observed at 1,800 in 2023 with no permit is quarantined, not merged.
5. **Explicit human override**, recorded as its own observation with an author.

Conflicting facts are therefore *never resolved by deletion*. They are resolved by choosing a winner
for a given read, while retaining the losers — because next month a fourth source may flip the
answer, and because the *disagreement itself is signal* (see §6.4).

### 1.3 Sale events vs. listings vs. "the comp"

Vendors keep these strictly apart because they have different truth properties:

- **Public-record sale** — authoritative on price and date of *recording*, silent on condition,
  concessions, and often silent on contract date. Non-disclosure states (TX, UT, ID, KS, LA, MS, MT,
  NM, ND, WY, AK, and parts of MO) publish no price at all, which is why MLS coverage is not
  optional for a national product.
- **MLS sold listing** — has price, contract date, DOM, concessions, condition narrative, photos,
  agent remarks. Not authoritative (agents mis-key), and licence-restricted.
- **Appraisal comp grid line** — a *third* observation type, and the one we have. It is an
  appraiser's transcription of an MLS/public-record sale, plus the appraiser's own judgment
  (UAD condition/quality, view/location ratings, the adjustment dollars).

Our data is exclusively that third type. That has a structural consequence worth stating early: for
us, the atomic row is not "a sale" — it is **"a sale, as observed and judged by one appraiser on one
date."** The same sale will appear in many appraisals with different condition ratings and different
adjustment dollars. Modelling that as a single mutable "sale" row destroys the most valuable thing we
own.

### 1.4 Keying and dedupe without a national parcel ID

There is no national parcel identifier. APNs are county-scoped, get reissued on splits/merges, and
are formatted inconsistently even within a state. The industry standard pipeline:

1. **Parse** the raw address into components (house number, pre-directional, street name, suffix,
   post-directional, unit type, unit number, city, state, ZIP). Open-source `libpostal` is the usual
   starting point — trained on ~1B OSM records, ~98.9% parse accuracy
   ([Senzing](https://senzing.com/what-is-libpostal/),
   [Crunchy Data](https://www.crunchydata.com/blog/quick-and-dirty-address-matching-with-libpostal)).
2. **Standardize/validate** against USPS CASS-certified reference data to get a canonical delivery
   line, ZIP+4, and (critically for condos) a validated secondary unit designator
   ([Smarty on CASS](https://www.smarty.com/articles/what-is-cass)).
3. **Geocode** to rooftop/parcel centroid. Keep the geocode as a *separate signal* — never let the
   geocoder overwrite the parsed address, because ambiguous input gets snapped to the nearest
   plausible result ([Placekey](https://www.placekey.io/blog/how-to-standardize-address-data)).
4. **Block** candidates cheaply (e.g. ZIP5 + house-number + first 3 chars of street stem, or a
   ~150 m geohash tile) so you compare thousands, not billions, of pairs.
5. **Score** each candidate pair on a weighted feature vector: exact house number, Jaro-Winkler on
   street stem, suffix equivalence class (ST≡STREET≡STR), unit exact/absent/conflict, ZIP match,
   haversine distance, and — the big one — **physical-characteristic agreement** (year built ±1,
   GLA ±5%, lot size ±10%).
6. **Decide** with three bands: auto-merge above a high threshold, auto-reject below a low one,
   and a **human review queue in between**. Every merge writes an audit row and must be reversible
   (`property_merge(surviving_id, absorbed_id, decided_by, decided_at, evidence_json)`), because
   merges *will* be wrong and unmerging a hard-deleted record is impossible.

The two failure modes that cost the most:

- **Under-merging** (same house, two IDs) — silently halves your comp counts and makes every
  density statistic wrong.
- **Over-merging condo units** — `123 Main St` and `123 Main St #4B` and `123 Main St Apt 4B`. Unit
  data is the number-one source of property-record duplication; missing unit data will collapse an
  entire building into one "property." Rule: **a missing unit is not a matching unit.** If either
  side of a candidate pair has a unit and the other does not, that pair goes to review, never to
  auto-merge. This matters disproportionately to us because 1073 condo reports are a third of our
  form mix.

Realistic expectations: even top-tier commercial validation reports ~70–75% clean match rates on raw
address data ([Data Ladder](https://dataladder.com/address-verification-software/)). Plan for a
review queue as a permanent operational cost, not a launch-week cleanup.

### 1.5 The RESO vocabulary is free — use it

The Real Estate Standards Organization Data Dictionary is the industry's shared field vocabulary
(Property, Member, Office, Media resources; `ListingKey`, `ListPrice`, `ClosePrice`,
`LivingArea`, `BedroomsTotal`, `BathroomsFull`/`BathroomsHalf`, `YearBuilt`, `LotSizeSquareFeet`,
`DaysOnMarket`, `CloseDate`, `ContractStatusChangeDate`, …)
([RESO Data Dictionary](https://www.reso.org/data-dictionary/),
[DD wiki](https://ddwiki.reso.org/display/DDW17/ListingKey+Field)). Even with no MLS feed, naming
our columns after RESO enums costs nothing today and makes a future MLS or vendor integration a
mapping exercise rather than a rewrite. Do this.

---

## 2. The sales comparison approach, precisely

### 2.1 The canonical grid, in order

The URAR (Form 1004 / Freddie 70) sales-comparison grid is fixed. Header rows first, then the value
adjustment block. The order is not cosmetic — see §2.3.

**Header rows (descriptive, not adjusted):**

1. Address
2. Proximity to Subject (miles, e.g. `0.42 miles NE`)
3. Sale Price
4. Sale Price / Gross Living Area (`$/sq ft`)
5. Data Source(s) — e.g. `MLS #1234567;DOM 34`
6. Verification Source(s) — e.g. `Public Records; Agent`

**VALUE ADJUSTMENTS block** — each line has a `DESCRIPTION` column and a `+(-) $ Adjustment` column:

| # | Line item | What it captures |
|---|---|---|
| 1 | **Sales or Financing Concessions** | UAD sale type (`ArmLth`, `REO`, `Short`, `Court`, `Estate`, `Relo`, `GfSale`, `Listing`), financing type (`Conv`, `FHA`, `VA`, `Cash`, `Seller`, `RH`, `Other`), and seller-paid concession dollars |
| 2 | **Date of Sale/Time** | market-conditions / time adjustment; UAD reports contract date `c` and settlement date `s` |
| 3 | **Location** | UAD `N;Res`, `B;` (beneficial), `A;BsyRd` (adverse, busy road) etc. — neighbourhood/immediate-siting |
| 4 | **Leasehold/Fee Simple** | property rights conveyed |
| 5 | **Site** | lot size, usually in sq ft or acres |
| 6 | **View** | UAD `N;Res`, `B;Mtn`, `A;CmrcVw`, etc. |
| 7 | **Design (Style)** | `DT1` detached one-story, `RT2` rowhouse two-story, etc. |
| 8 | **Quality of Construction** | UAD **Q1–Q6** |
| 9 | **Actual Age** | years |
| 10 | **Condition** | UAD **C1–C6** |
| 11 | **Above Grade Room Count** | `Total / Bdrms / Baths`, baths as `2.1` = 2 full + 1 half |
| 12 | **Gross Living Area** | above-grade finished sq ft |
| 13 | **Basement & Finished Rooms Below Grade** | e.g. `1200sf1200sfin` + `2rr1br1ba0o` |
| 14 | **Functional Utility** | layout/obsolescence |
| 15 | **Heating/Cooling** | |
| 16 | **Energy Efficient Items** | |
| 17 | **Garage/Carport** | e.g. `2ga2dw` |
| 18 | **Porch/Patio/Deck** | |
| 19–21 | **Other (blank lines)** | fireplace, pool, outbuildings, solar, ADU |

**Footer:**

- `Net Adjustment (Total)` — signed sum
- `Adjusted Sale Price of Comparables` with `Net Adj. __%` and `Gross Adj. __%`

The 1073 condo grid swaps in project-specific lines: **HOA fee / $ per month**, **Common Elements and
Recreation Facilities**, **Floor Location**, **Project/Unit Type**, plus project name and phase. The
1025 (2–4 unit) grid is rent-driven — unit mix, actual/market rents, gross rent multiplier — and its
value conclusion leans on the income approach, so its comp lines are structurally different and
should be a distinct row type in our schema, not squeezed into the 1004 shape.

**UAD ratings are absolute, not relative.** C1 = newly constructed, never occupied, completed within
12 months; C2 = like-new, substantially remodeled within the prior ~36 months, no deferred
maintenance; C3 = well maintained, minimal wear; C4 = modest wear, minor deferred maintenance, fully
functional; C5 = noticeable deferred maintenance, significant repairs needed; C6 = major damage /
serious deferred maintenance. Q1–Q6 describe *construction* quality — design complexity, materials,
craftsmanship — and are essentially fixed at build time, whereas condition moves with maintenance.
A Q2 home can be a C5 ([Freddie Mac UAD definitions PDF](https://sf.freddiemac.com/docs/pdf/uad-condition-quality-ratings-definitions.pdf),
[McKissock](https://www.mckissock.com/blog/appraisal/understanding-appraisal-condition-ratings-c1-to-c6/),
[restb.ai](https://blog.restb.ai/uad-condition-ratings-what-c1-c6-actually-mean)).
This absolute-scale property is what makes UAD ratings usable as model features across appraisers —
it is the single biggest advantage our data has over free-text MLS condition remarks.

### 2.2 Sign convention (get this right or everything downstream is inverted)

**Adjustments are applied to the comparable, never to the subject.**

- Comp is **superior** to subject on an attribute → **subtract** (negative adjustment).
- Comp is **inferior** → **add** (positive adjustment).

```
Adjusted Sale Price of Comp = Comp Sale Price + Σ(all line adjustments, signed)

Net Adj %   = Σ(adjustments)      / Comp Sale Price
Gross Adj % = Σ|adjustment_i|     / Comp Sale Price
```

Mnemonic used in every appraisal class: **CBS / CIA** — "Comp Better, Subtract / Comp Inferior, Add."

Sanity checks worth encoding as validation rules on ingest:

- If comp GLA > subject GLA, the GLA adjustment must be ≤ 0. Wrong-direction adjustments are exactly
  what Fannie's Collateral Underwriter flags (§3.5).
- `Adjusted Sale Price` must reconcile to `Sale Price + Net Adjustment` within rounding.
- `Gross Adj% ≥ |Net Adj%|` always. If not, the parse is wrong.
- Net/gross percentages in the XML should be recomputed from the line items, not trusted — form
  software occasionally reports these against the adjusted rather than the raw price.

### 2.3 Why the order matters: sequential adjustment

Best practice (and what Fannie's market-conditions guidance now assumes) is that the first two lines
are applied **sequentially and multiplicatively before** the physical lines:

1. **Concessions first** → converts the recorded price to a **cash-equivalent price**.
2. **Time second**, applied to the cash-equivalent price → brings it to the effective date.
3. **Physical adjustments** (lines 3–21) applied to that time-adjusted, cash-equivalent price.

```
P_cash  = P_sale − concessions_paid_by_seller
P_time  = P_cash × (1 + r)^(months between comp CONTRACT date and effective date)
P_adj   = P_time + Σ(physical adjustments)
```

Doing time before concessions, or applying a percentage time adjustment to the raw price when a
$12,000 seller credit is embedded in it, over-adjusts. Our extraction should capture the concession
dollars separately (UAD does report them) so we can recompute cash-equivalent prices ourselves rather
than inheriting the appraiser's sequencing.

### 2.4 How each adjustment is derived

Four recognized derivation methods, in rough order of evidentiary strength as reviewers see it:

**(a) Matched-pair / paired-sales analysis.** Find two sales as identical as possible except for one
variable, and attribute the price difference to that variable. This is the method appraisal
education treats as canonical: "the appraiser identifies two sales that are as identical as possible
in location, condition, age, and quality, differing meaningfully in only one variable"
([McKissock](https://www.mckissock.com/blog/appraisal/appraisal-adjustments-types-methods-and-cheat-sheet/)).
Its weakness is obvious and is the core of our small-data problem: true matched pairs are rare, and a
single pair is a sample of one. Practitioners therefore fall back to *grouped* pairs — comparing
means of two strata (e.g. all C3 sales vs all C4 sales in the tract) — which is really a two-group
regression with no controls.

**(b) Regression / statistical analysis.** Fit `price ~ GLA + beds + baths + age + condition + ...`
over a market segment and read the coefficients as adjustments. This is what CU does internally and
what any serious internal tool should do. It is also the method most likely to produce a confidently
wrong number on a small sample (§6).

**(c) Cost-based (depreciated cost).** Used for items with a clear installed cost and a known
contributory ratio — a garage bay, a deck, solar, an added bath. The adjustment is **contributory
value, not cost**: pools are the standard example, typically contributing far less than installed
cost. Cost is a *ceiling* on the adjustment, not the adjustment.

**(d) Market/expert surveys and sensitivity analysis.** Weakest, but common for view and location
where paired data essentially never exists.

USPAP does not prescribe a method; it requires the appraiser to be able to *support* the method
chosen (Standards Rule 1-4: analysis of comparable sales must be performed using recognized methods
and techniques; Standards Rule 2-2 requires the report to summarize the support). The practical
translation: an adjustment with no derivation in the workfile is a USPAP exposure, and Fannie now
treats an *unsupported or absent* time adjustment as an unacceptable appraisal practice (§3.4).

### 2.5 Typical $/unit conventions

These are **conventions, not rules**. Every one of them must be market-derived in a real report. They
are listed because they define the plausible range our validation and outlier detection should use.

| Line | Common convention | Notes / traps |
|---|---|---|
| **GLA** | ~**20–40% of the market's overall $/sq ft**. Market at $200/sf → GLA adjustment ~$40–$80/sf. Commonly rounded to $5/$10 increments. | Using the full $/sf is the classic error — it double-counts the land and site improvements, which don't scale with GLA. |
| **Bedrooms** | Often **$0 as a separate line** when GLA is adjusted | Adjusting both GLA and bedroom count double-counts. A separate bedroom adjustment is defensible only for *utility* differences at equal GLA (e.g. 3/2 vs 4/2 at 1,800 sf). |
| **Full bath** | **$3,000–$10,000** typical; higher in high-price metros | Should scale with market: a rough anchor is 1.5–3% of median price per full bath. |
| **Half bath** | ~**40–60% of a full bath** | |
| **Garage** | **$3,000–$8,000 per space**, or ~$20–$40/sf of garage area | Carport typically 40–60% of a garage bay. |
| **Basement (unfinished)** | **$10–$25/sf** | |
| **Basement (finished)** | **30–50% of the above-grade GLA rate** | Below-grade finish never gets the above-grade rate. Never roll below-grade sf into GLA. |
| **Condition (per C-grade step)** | **2–6% of value per step**, non-linear (C5→C4 usually worth more than C3→C2) | The single largest driver of unexplained variance in our data. |
| **Quality (per Q-grade step)** | **3–8% of value per step** | |
| **Actual age** | often **$0** (subsumed by condition), else a few hundred $/yr | Adjusting both age and condition double-counts. |
| **Fireplace** | **$1,500–$5,000** | |
| **Pool** | **$5,000–$25,000**, region-dependent, sometimes negative | Contributory value « cost; can be negative in cold markets. |
| **Site / lot** | $/sf or $/acre with **declining marginal value** for excess land | Linear $/acre on a 20-acre comp vs a 0.3-acre subject is a classic blow-up. |
| **Concessions** | **dollar-for-dollar, capped at actual concession**, never more | Not a percentage. |
| **View / Location** | pure paired-sales or % of value; no convention | |

**Line-item guideline that reviewers still use:** many lenders/AMCs flag any *single* line adjustment
exceeding **10% of the comp's sale price**, alongside the 15%/25% net/gross convention (§3.2). None
of these are GSE rules today, but they are live in review software.

---

## 3. Fannie Mae / Freddie Mac / USPAP constraints

### 3.1 Comp selection (Fannie Selling Guide **B4-1.3-08, Comparable Sales**)

Primary source: <https://selling-guide.fanniemae.com/sel/b4-1.3-08/comparable-sales> (current
version dated 06/04/2025). Reconstructed from search extracts:

- **Minimum three closed/settled comparable sales.** Freddie's equivalent is Guide Chapter 5605
  (§5605.6 sales comparison approach); FHFA states it plainly: "The Enterprises require that
  mortgages sold to them include at least three settled comps... in the corresponding home appraisal
  reports" ([FHFA, *Counting Comps*](https://www.fhfa.gov/blog/statistics/counting-comps-exploring-the-number-of-comparable-properties-in-home-appraisals)).
- **Age of comps:** "Comparable sales that have closed within the last 12 months should be used in
  the appraisal; however, the best and most appropriate comparable sales may not always be the most
  recent sales." Older sales are permitted **with explanation**, and the Guide explicitly endorses
  the trade-off: "it may be appropriate for the appraiser to use a nine month old sale with a time
  adjustment rather than a one month old sale that requires multiple adjustments."
- **Rural / low-activity markets** are called out as the standard justification for comps older than
  12 months.
- **Comps should come from the subject's neighbourhood / competing market area**; comps from outside
  require explanation of why they are the most appropriate.
- **Prior transfer history** must be researched and reported: **3 years for the subject, 1 year for
  each comparable** (this is a URAR form certification, not merely guidance). This is directly
  useful to us — it means every comp line potentially carries a prior-sale date/price, which is free
  repeat-sales data (§5.4).

**Rules that are NOT actually in the Selling Guide — be precise about this, because our software
should not enforce them as hard stops:**

- **The 1-mile radius.** Fannie does not specify a distance. The "1 mile urban / 5 miles suburban /
  unlimited rural" convention is a *lender overlay and review-software convention*, widely
  implemented but not a GSE rule. Our proximity filters should default to it and be explicitly
  labelled as a convention, overridable.
- **The 90-day recency rule.** Also not a Selling Guide rule for conventional lending. It comes from
  a mix of investor overlays, some jumbo/non-QM guidelines, and appraisal-review checklists. Fannie's
  stated preference is 12 months with explanation beyond.
- **"At least one comp within 90 days"** — overlay, not GSE.

**Condominiums (1073).** Fannie's condo appraisal requirements (B4-1.4-01 and related) impose
project-based comp selection that a general property database will get wrong unless it is modelled:
for **established projects**, comps should be drawn from within the subject project where available
(commonly implemented as two inside + one outside a competing project); for **new / newly converted
projects**, appraisers are expected to include comps from **outside** the subject project so the
value is not anchored entirely to developer pricing. Verify the current wording before encoding it;
the operational point for us is that **`project_id` is a first-class comp-search dimension for
condos**, ranked above raw distance.

**Listings and pending sales.** Closed sales are the evidentiary base. Active listings and pendings
are used *in addition to* the three required closed comps, most often (a) in rapidly appreciating
markets to bracket the top of the value range, (b) where closed data is thin, and (c) as support for
market-conditions conclusions. A pending sale's contract price is treated as an indicator of current
market, not as a settled fact. In the grid they are marked with UAD sale type `Listing`. **We do not
receive listings unless the appraiser included them as supplemental comps — capture the sale-type
code so we never mix a listing price into a sold-price statistic.**

### 3.2 Net 15% / gross 25% — the honest status

This is the most-cited "rule" in the industry and it is **no longer a Fannie Mae guideline.**

- The old guidance: net adjustments should not exceed **15%** of the comp's sale price, gross
  adjustments not exceed **25%**, with any single line item under **10%**; exceedances required
  explanation.
- Fannie **eliminated the 15% net / 25% gross guidelines in December 2014**, effective immediately,
  after analysing UAD adjustment data. The stated rationale: the guideline "was widely implemented as
  an eligibility 'hard stop' due to many rules-based automated review systems, causing many
  appraisers to focus on keeping adjustments within the guidelines instead of reflecting actual market
  reaction" ([Appraisers Blogs summary](https://appraisersblogs.com/appraisal/update-to-fnma-selling-guide-major-change/),
  [Fannie LL-2015-02](https://singlefamily.fanniemae.com/media/15271/display)).
- Current **B4-1.3-09, Adjustments to Comparable Sales**
  (<https://selling-guide.fanniemae.com/sel/b4-1.3-09/adjustments-comparable-sales>): Fannie "does
  not have specific limitations or guidelines associated with net or gross adjustments," and "the
  number and/or amount of the dollar adjustments must not be the sole determinant in the
  acceptability of a comparable." Adjustments "must reflect the market's reaction to the difference
  in the properties."
- **Collateral Underwriter does not apply the 15/25 thresholds.**

Despite all of that, **15/25/10 remains alive** as a lender overlay, an AMC review-checklist trigger,
and an underwriter habit — and it is still referenced in some FHA/VA reviewer training and many
correspondent seller guides. So: **compute net% and gross% and surface them as informational flags
with a clear "guideline, not GSE rule" label. Never block on them.**

### 3.3 Bracketing

Bracketing = selecting comps that are **above and below the subject** on the key value drivers (GLA,
site, condition/quality, room count, and value itself), so the subject sits inside the range of
unadjusted comp prices and the positive/negative adjustments roughly offset.

Status: **bracketing is not a blanket numeric requirement in the Selling Guide**, but it is
(a) explicitly required in specific niches — most notably comps that bracket for MH Advantage /
manufactured housing, ADUs, and energy-efficiency features; (b) a strong Collateral Underwriter
expectation; and (c) universal appraisal best practice, taught as the way to keep the value
conclusion inside the observed data rather than extrapolated beyond it
([Riverfront Appraisals](https://riverfrontappraisals.com/the-loan-officers-guide-to-appraisals-part-5-what-is-bracketing-and-why-do-we-do-it/)).

For our comp-search tool this is the single highest-value UX behaviour: **when the user picks comps,
show live bracketing status per attribute** ("GLA: bracketed 1,640–2,010 vs subject 1,820 ✓;
Condition: NOT bracketed — all comps C3, subject C4 ✗"). That is a genuinely useful, low-risk feature
that requires no statistical modelling at all.

### 3.4 Market conditions / time adjustments — the 2024–2025 change

This is the most consequential recent rule change for anything we build.

- **Announcement SEL-2024-07** (Oct 2, 2024) updated the neighbourhood/market-analysis and
  adjustment sections. Appraisers must "report the market analysis that supports both the indicated
  overall market trend and market derived time adjustments for changes in market conditions"
  ([Fannie SEL-2024-07](https://singlefamily.fanniemae.com/news-events/announcement-sel-2024-07-selling-guide-updates),
  [TENA summary](https://www.tenaco.com/fannie-mae-issues-selling-guide-announcement-sel-2024-07/)).
- **Effective dates:** Fannie's stated trigger is loans requiring an appraisal with **application
  dates on or after February 4, 2025**; several correspondent bulletins restate it as **appraisals
  dated on or after March 1, 2025** (e.g. [PennyMac 25-07](https://corr.pennymac.com/announcements/announcement-25-07)).
  Freddie made parallel changes on the same timeline
  ([WorkingRE](https://www.workingre.com/fannie-freddie-new-market-analysis-requirements-february-4th/)).
- **Substance:**
  - Analyse each comp for market-condition changes **between the comp's CONTRACT date and the
    appraisal's effective date** — not the settlement date. (Our XML gives both; use the contract
    date.)
  - Establish the trend over a **minimum 12-month look-back**.
  - Adjustments may be **positive, negative, or zero, and may differ per comp within the same
    report** — which follows mechanically from using per-comp contract dates.
  - **Failing to make a market-derived time adjustment when the data indicates one is an
    unacceptable appraisal practice.**
  - Fannie's one-page [Market Condition Adjustments fact sheet](https://singlefamily.fanniemae.com/media/40241/display)
    (May 2025) is the concise reference.
- **Form 1004MC** is *not* the vehicle any more. Fannie removed the requirement to complete Form
  1004MC in 2018; the market-conditions **analysis** is still required, it just isn't reported on that
  form. Expect to see 1004MC-style data only sporadically in our XML — do not build the pipeline
  around it.

**Why FHFA pushed this:** FHFA's own research found time adjustments badly underused. Expected time
adjustments would have averaged roughly **2.5% to 9% of sale price**, yet for much of the study
period appraisers time-adjusted **fewer than 10% of comparable sales**, and only **18.5%** of
purchase transactions 2018–2021 carried any time adjustment at all
([FHFA, *Underutilization of Appraisal Time Adjustments*](https://www.fhfa.gov/blog/insights/underutilization-of-appraisal-time-adjustments)).
A companion FHFA post found the omission correlates with tract demographics — appraisers time-adjust
at a **67%** rate in majority-white tracts vs **45%** in majority-Black tracts among appraisals coming
in below contract price
([FHFA, *Underappraisal Disparities and Time Adjustments*](https://www.fhfa.gov/blog/insights/underappraisal-disparities-and-time-adjustments)).

**Direct implication for us:** a large fraction of the historical comp lines we ingest will have a
**$0 time adjustment that should not have been $0.** If we naively regress on adjusted prices from
older reports, we inherit that bias. Always retain the **raw sale price + contract date** and apply
our *own* time adjustment for analytics; treat the appraiser's time adjustment as a separate observed
field, not as truth.

### 3.5 What a reviewer actually flags — Fannie's Collateral Underwriter as the reference design

CU is the closest thing to a public specification of "what an automated appraisal reviewer checks,"
and it is essentially the product we would be building internally. Worth copying deliberately.

- **Risk score 1–5**, 1 = lowest risk, 5 = highest. **999** means CU could not score — typically
  insufficient comparable data in that market
  ([Fannie CU](https://singlefamily.fanniemae.com/applications-technology/collateral-underwriter),
  [JVM Lending](https://www.jvmlending.com/blog/what-is-a-cu-score-on-an-appraisal/)).
- Output is score + **risk flags** + **messages** pointing at specific areas needing review.
- **Model comps.** CU ranks a pool of available sales by physical characteristics, location, and sale
  date, and surfaces the **20 most similar sales (M1–M20)**. Crucially, "the sale prices of these
  comparables are not a factor in the ranking" — the model picks comps on similarity only, then
  compares. Practitioner rule of thumb: appraisals containing **3 of CU's top-5 model comps** usually
  score 1–2 ([Larry Zumwalt / LinkedIn](https://www.linkedin.com/pulse/article-help-appraisers-better-understand-fannie-mae-cu-larry-zumwalt),
  [Sacramento Appraisal Blog](https://sacramentoappraisalblog.com/2015/01/20/what-you-need-to-know-about-fannie-maes-collateral-underwriter/)).
- **Adjustment messages (600-series).** "Single Adjustment messages identify when the appraiser's
  adjustment rates are significantly different from either the model-derived adjustment rates and/or
  adjustment rates made by other appraisers (peers) in the same market for a single standardized
  physical characteristic." The comparison runs "on all Uniform Appraisal Dataset (UAD) standardized
  physical characteristics, date of sale, location, and sale type," and messages fire for adjustments
  that are **in the wrong direction** or significantly different from peers/model
  ([Fannie CU job aid — Single Adjustment Messages](https://singlefamily.fanniemae.com/job-aid/collateral-underwriter/topic/single_adjustment_messages.htm),
  [Adjustment Messages Overview](https://singlefamily.fanniemae.com/job-aid/collateral-underwriter/topic/adjustment_messages_overview.htm)).
- Also flagged: data-integrity contradictions (same property described differently across reports),
  reconciliation weight that ignores the most similar comps, value above the range of adjusted comp
  prices, and appraiser-level outlier behaviour across their whole submission history.

**The "peer comparison" idea is the single most transferable design in this entire document, and it
is achievable with a small dataset in a way that a full AVM is not.** We do not need to know the true
GLA adjustment for Tampa; we only need to know that *this* appraiser used $18/sf when the other 40
Tampa reports in our warehouse used $45–$70/sf.

### 3.6 USPAP

The constraints that bind our product design:

- **Standards Rule 1-1(a)–(c)** — be aware of, understand, and correctly employ recognized methods;
  no substantial errors of omission or commission; no series of errors that collectively affect
  credibility.
- **Standards Rule 1-4(a)** — when the sales comparison approach is used, analyse such comparable
  sales data as are available.
- **Standards Rule 2-2** — the report must summarize the information analysed and the reasoning that
  supports the analyses/opinions/conclusions.
- **Standards Rule 1-2(c)/(e)** and the **Scope of Work Rule** — the scope must be sufficient to
  produce credible assignment results.
- **ETHICS RULE (Conduct/Management/Confidentiality)** and **Record Keeping Rule** — workfile
  retained for **5 years** after preparation, or 2 years after final disposition of any judicial
  proceeding, whichever is longer.

Two practical consequences:

1. If a tool of ours produces a value opinion that an appraiser or a valuation professional then
   signs, our tool's outputs become part of their workfile. **Every number we display must be
   exportable with its derivation, sample size, and date range.** A slider with no audit trail is a
   liability.
2. If our tool produces a value used in a *credit decision*, the **2024 interagency AVM Quality
   Control rule** applies (§4.5) — that is a compliance obligation, not a nice-to-have.

**AIR/appraiser independence:** anything we surface to an appraiser that looks like a target value,
or that could be read as pressure, is a problem. Comp *retrieval* and *adjustment-benchmark* tools are
fine; a "your value should be $X" prompt is not.

---

## 4. AVM methodology

### 4.1 The four production model families

1. **Hedonic regression.** Price (or log price) as a function of property attributes plus location
   fixed effects. `ln(P) = β₀ + β₁·GLA + β₂·beds + β₃·baths + β₄·age + β₅·lot + Σγⱼ·submarketⱼ + ε`.
   Modern implementations use gradient boosting or neural nets instead of OLS but the framing is the
   same: value = sum of the contributions of attributes. Zillow's current Zestimate is a neural
   network correlating "home facts, location, housing market trends and home values"
   ([Zillow Tech Hub](https://www.zillow.com/tech/building-the-neural-zestimate/)).
   Strength: works anywhere you have attributes. Weakness: needs a lot of data, and coefficients are
   unstable in thin submarkets.
2. **Repeat-sales index.** Uses only properties that sold twice, so property attributes cancel out
   and what remains is pure market movement. This is the Case-Shiller and FHFA HPI method. Strength:
   the cleanest measure of appreciation, immune to composition/mix shift. Weakness: says nothing
   about an individual property's level, only its change; discards single-sale properties; struggles
   with renovated properties (the "attributes cancel" assumption breaks).
3. **Comp-based / "appraisal emulation."** Algorithmically select the k most similar recent sales,
   apply model-derived adjustments, reconcile to a weighted value. This is what CU's M1–M20 ranking
   is, and it is the family our data is naturally shaped for. Strength: explainable — you can show
   the user the comps and the adjustments. Weakness: sensitive to comp availability; degrades badly
   in low-density markets.
4. **Tax-assessment / index-carry models.** Take a prior known value (assessed value or last sale
   price) and carry it forward with a submarket index. Cheap, surprisingly hard to beat in stable
   markets, useless after a renovation.

**Every production AVM is an ensemble or a cascade of these.** Ensemble = weighted blend, weights
learned per geography and per data-availability regime. Cascade = try model A; if its confidence is
below threshold or it can't hit the address, fall to model B, then C. Industry framing: "The most
effective AVMs use a hybrid model... blends the granular detail of hedonic models with the
market-trend accuracy of repeat-sales data"
([BatchData](https://batchdata.io/blog/what-does-avm-stand-for-in-real-estate)).

### 4.2 Confidence, FSD, and defensible ranges

**Forecast Standard Deviation (FSD)** is the industry-standard uncertainty measure. Definition:
"the AVM value's expected (forecasted) proportional standard deviation around actual subsequent sales
price for the given property value estimate"
([Clear Capital glossary](https://www.clearcapital.com/resources/glossary-of-terms/fsd-forecast-standard-deviation/),
[AVMetrics](https://www.avmetrics.net/AVM_glossary/forecast-standard-deviation/)).

- **Interpretation:** FSD = 12% means ~68% of comparable properties are expected to transact within
  ±12% of the estimate.
- **Conventional confidence score:** `Confidence = 100 − FSD·100`. FSD 0.12 → confidence 88.
- **Defensible value range:**
  ```
  68% interval:  V × (1 ± FSD)
  90% interval:  V × (1 ± 1.645·FSD)
  95% interval:  V × (1 ± 1.96·FSD)
  ```
- **FSD must be *calibrated*, not asserted.** The test is coverage: over a held-out sample, does the
  claimed 68% band actually contain 68% of realized sale prices? An FSD that isn't back-tested is
  decoration. This is precisely what the interagency rule's "high level of confidence" requirement
  means in practice.

**Accuracy metrics used for validation** ([Clear Capital AVM testing glossary](https://www.clearcapital.com/blog-avm-testing-glossary/),
[ICE](https://mortgagetech.ice.com/blog/test-and-validate-avm-performance-with-confidence)):

| Metric | Definition | Institutional benchmark |
|---|---|---|
| **MdAPE** | median absolute % error vs subsequent sale | **< 5%** institutional; leaders claim ~2.3–3% (Clear Capital publishes MdAPE 2.3% for ClearAVM across 120M+ properties) |
| **PPE10 / PP10** | share of estimates within ±10% of realized price | **> 70%** institutional threshold; leaders 80%+ |
| **Hit rate** | properties valued ÷ properties submitted | coverage measure; a high hit rate with bad FSD is worse than a low hit rate |
| **Bias / mean % error** | signed mean error | should be ≈ 0; persistent sign = systematic over/under-valuation |
| **FSD calibration** | realized coverage of the stated band | the honest one |

Zillow's headline "median error < 2% for on-market homes" is not comparable to these — on-market
Zestimates are conditioned on the list price, which is nearly the answer. **Off-market** median error
is the meaningful figure and is several times larger. Any internal benchmark we quote must state
whether the subject was on-market at valuation time.

### 4.3 Minimum comp count and recency (what practitioners actually use)

There is no single published standard, but the converged practice:

- **3 comps is the floor** because that is the GSE appraisal floor; **5–8 is where comp-based models
  become stable.** FHFA data shows appraisers voluntarily exceed the minimum: "More than two-thirds
  of home appraisals associated with Enterprise-backed mortgages during the 2013–2021 period included
  five or more comparable properties," though that share fell from 76% (2013) to 59% (2021), and is
  13 points lower in rural than high-density urban areas
  ([FHFA, *Counting Comps*](https://www.fhfa.gov/blog/statistics/counting-comps-exploring-the-number-of-comparable-properties-in-home-appraisals)).
- **Recency:** 90 days is the preferred window for comp-based models, 6 months acceptable, 12 months
  the outer bound with time adjustment. Beyond 12 months a comp is mostly an index observation, not
  a comparable.
- **Similarity gates** commonly used before a sale is eligible as a comp: same property type, GLA
  within ±20–25%, year built within ±10–15 years, same submarket/census-tract or ≤1 mile urban,
  arms-length only, price within ±30–50% of the subject's expected range.
- **Density is what determines model family.** Below roughly 20–30 eligible sales in the search
  envelope, hedonic coefficients are noise and a comp-based model with *fixed, market-level* (not
  locally re-estimated) adjustments is the honest choice.

### 4.4 User-driven AVMs — the UX we should study

This is the product category our tool actually belongs to. Three reference implementations:

**RPR "Refine Value" (NAR's Realtors Property Resource).** RPR publishes an automated **RVM**
(Realtor Valuation Model, an AVM augmented with MLS listing data), then lets the agent override it.
The controls are deliberately *qualitative sliders*, not dollar boxes: "The sliders can be used to
adjust value based on the local market and conditions and how the subject property relates to the
comparable properties in areas like home exterior, home interior, lot size, view and privacy." In the
CMA workflow, step three is "making adjustments by rating each of the comps you have chosen, and
adjusting the slider-bar to mark each comp as 'better' or 'worse' than the subject property. Each
adjustment will change the value of the subject property."
([RPR support](https://blog.narrpr.com/support/how-do-i-change-the-estimated-value-refine-value-tool/),
[RPR pricing guide](https://blog.narrpr.com/tips/cma-refine-value-property-pricing/))

Key design lessons from RPR:
- **Better/worse ratings instead of dollar entry.** The user expresses a *direction and magnitude
  class*; the system converts to dollars using its own market data. This is exactly right when the
  user is not an appraiser, and it is exactly right when your dollar coefficients are uncertain.
- The refined value is stored as a **distinct, attributed value** — "RVM" vs "Refined Value" are
  separate labelled numbers. The model's opinion is never silently overwritten by the human's.
- Output is a **report artifact** (Seller's Report / CMA) — the deliverable is a defensible document,
  not a number on a screen.

**HouseCanary Value Report / Property Explorer.** Publishes an AVM with an explicit **FSD**: "HouseCanary
employs a statistical measure called 'Forecast Standard Deviation (FSD)' to estimate the valuation
model uncertainty... The FSD reflects the statistical dispersion of valuations around the estimated
value" ([HouseCanary methodology white paper](https://cdn.prod.website-files.com/659c81c0f2b2def2180e9b9f/65b19c356809d3de910f5399_hc_valuation-methodology_white-paper%20(1).pdf)).
The user-driven layer: "Users can select their own comps, compare those comps to each other and to
the subject property, and then make any necessary adjustments all in one place," with an explicit
**"Select Comps"** action to replace the machine-chosen set
([HouseCanary](https://www.housecanary.com/resources/pexp-quick-start-guide/)).
They also draw a hard product line between **"underwriting-grade" and "marketing-grade" AVMs**
([HouseCanary](https://www.housecanary.com/blog/avms-vs-marketing-avms)) — a distinction we should
adopt in our own UI copy from day one.

**Zillow owner edits.** The consumer-grade version: owners update "home facts," which feed the model
as a low-tier source and can move the Zestimate, but the owner cannot set the number. Notably Zillow
does *not* let the user edit the model output — only the inputs. That is the safest possible design
and the one that best resists manipulation.

**The synthesized control set a user-driven comp tool should expose:**

| Control | Notes |
|---|---|
| Comp search with editable filters (radius, date window, GLA %, type, condition band) | show the filter as a chip set; every filter change re-runs and shows the count |
| Include/exclude a comp with a **required reason code** | reasons become training data and audit trail |
| Per-line adjustment: prefilled from market benchmark, editable, with the benchmark's `n` and range shown inline | this is the CU-peer idea turned into UX |
| "Better / Similar / Worse" qualitative fallback when no dollar benchmark exists | RPR pattern |
| Live bracketing indicator per attribute | §3.3 |
| Live net% / gross% per comp, labelled as conventions | §3.2 |
| Weighted reconciliation with visible weights | default: inverse gross-adjustment weighting; allow manual |
| A value **range**, always; a point estimate only as "most likely" inside the range | §4.2 |
| Provenance panel: which appraisal(s), what date, which appraiser, how many corroborating observations | §1.2 |
| Immutable snapshot + PDF export of the whole session | USPAP workfile compatibility |

### 4.5 Regulatory constraint on AVMs (2024 interagency rule)

Six agencies (OCC, Federal Reserve, FDIC, NCUA, CFPB, FHFA) finalized **Quality Control Standards for
Automated Valuation Models** in June/July 2024. Institutions using AVMs in covered credit decisions or
securitization determinations must maintain policies and controls to:

1. ensure a **high level of confidence** in the estimates;
2. **protect against manipulation of data**;
3. **avoid conflicts of interest**;
4. require **random sample testing and reviews**; and
5. comply with **applicable nondiscrimination laws**.

([CFPB final rule PDF](https://files.consumerfinance.gov/f/documents/cfpb_automated-valuation-models_final-rule_2024-06.pdf),
[CFPB rule page](https://www.consumerfinance.gov/rules-policy/final-rules/quality-control-standards-for-automated-valuation-models/),
[OCC Bulletin 2024-17](https://www.occ.gov/news-issuances/bulletins/2024/bulletin-2024-17.html))
Effective the first day of the calendar quarter following 12 months after Federal Register
publication (i.e. it is in force now).

**Read this carefully against our design.** Point (2) — protect against manipulation — is a direct
constraint on a *user-driven* AVM where a lender employee moves sliders. Point (3) — conflicts of
interest — bites when the person adjusting the comps also benefits from the loan closing. Point (5)
requires fair-lending testing, and FHFA's own finding of demographic disparity in time adjustments
(§3.4) shows this is not theoretical.

**Practical conclusion: our tool must be positioned as internal analytics / comp research / QC, not
as a valuation used to make a credit decision — unless and until we are prepared to stand up the full
QC program.** That positioning should be enforced in the product (labels, permissions, and an
explicit "not for credit decisioning" watermark on exports), not just in a policy document.

---

## 5. Time adjustment / market conditions

### 5.1 The mechanics

Two equivalent formulations.

**(a) Compound monthly rate:**
```
months  = (effective_date − comp_CONTRACT_date) / 30.44
P_time  = P_cash_equivalent × (1 + r_monthly)^months
adj_$   = P_time − P_cash_equivalent
```

**(b) Index ratio (preferred when you have a credible index):**
```
P_time  = P_cash_equivalent × ( Index(effective_date) / Index(comp_contract_date) )
```
The index form is better because it handles non-constant appreciation, seasonality, and inflection
points, which a single compound rate cannot.

**Non-negotiable details:**
- Use the **contract date**, not the settlement date. Fannie's 2024–2025 guidance is explicit about
  this, and it matters: a 60-day escrow means the market signal is 2 months older than the closing
  date suggests.
- Apply to the **cash-equivalent** price (after concessions), not the raw price (§2.3).
- Adjustments can be **positive, negative, or zero within the same report**, because each comp has
  its own contract date.
- **Round sensibly.** Appraisers round to $500 or $1,000; reporting a $3,847 time adjustment implies
  precision nobody has.

### 5.2 Where to get a defensible rate

Ranked by defensibility for our purposes:

1. **FHFA House Price Index, CBSA level.** Free, monthly at the national/census-division level and
   quarterly at the metro level. Three variants matter
   ([FHFA HPI](https://www.fhfa.gov/data/hpi), [FAQ](https://www.fhfa.gov/faqs/hpi)):
   - **Purchase-Only** — Fannie/Freddie purchase mortgages only, ~100 metros. Cleanest, narrowest.
   - **All-Transactions** — adds Enterprise *appraisal* (refinance) valuations, **410 metros**. Much
     better geographic coverage; slightly noisier because it embeds appraised values.
   - **Expanded-Data** — adds FHA and county-recorder transactions below the loan-limit ceiling,
     also 410 metros. Best coverage of the three for below-conforming markets.

   Method is repeat-sales, so it is mix-adjusted — a real advantage over median-price series.
   Weakness: it is capped at conforming-ish loan sizes (Expanded-Data explicitly), it lags (metro
   quarterly data publishes ~2 months after quarter end), and it is revised.
2. **S&P CoreLogic Case-Shiller.** Repeat-sales, monthly, 20 metros + national, ~2-month lag,
   3-month moving average (which smooths but also *delays* turning points — a real problem in a
   fast-moving market). Not free for redistribution.
3. **Local MLS median $/sf or median price, 12-month rolling.** What most appraisers actually use.
   Cheap and current, but **contaminated by mix shift** — a quarter with more large homes selling
   shows "appreciation" that isn't there. If used, stratify (by GLA band, by submarket, by property
   type) before taking medians.
4. **Our own regression on our own comps.** Discussed next. Only defensible above a real sample-size
   floor.

Fannie's own [Market Condition Adjustments fact sheet](https://singlefamily.fanniemae.com/media/40241/display)
and Freddie's [market conditions analysis resources](https://sf.freddiemac.com/docs/pdf/market-conditions-analysis-resources.pdf)
list acceptable derivation approaches: median sale price and median $/sf trends, days-on-market
trends, list-to-sale ratios, absorption rates, paired sales, and regression.

### 5.3 Deriving a monthly rate from a small internal dataset — the honest method

The standard defensible approach on limited data is a **log-linear time regression on price per
square foot**, run on a *stratified* segment:

```
For a segment (e.g. one CBSA × single-family detached × GLA 1,200–2,400 × C3/C4):
    y_i = ln( sale_price_i / gla_i )
    t_i = months between contract_date_i and the analysis anchor date
    Fit:  y_i = a + b·t_i + ε_i           (OLS, or robust/Huber to resist outliers)
    monthly appreciation  r = exp(b) − 1
    annualized            = (1 + r)^12 − 1
```

Report alongside it, always:
- **n** (number of sales in the segment)
- **standard error of b**, and the implied 95% CI on the monthly rate: `exp(b ± 1.96·SE(b)) − 1`
- **R²** and the residual spread
- the **date span** actually covered

**Sample-size floors I would enforce before showing a self-derived rate at all:**

| n in segment | What we may do |
|---|---|
| < 30 | Show nothing self-derived. Use FHFA CBSA index. |
| 30–99 | Show the FHFA index as the primary rate; show our regression as a secondary "internal check" with n and CI displayed. |
| 100–299 | Blend: `r = w·r_internal + (1−w)·r_FHFA`, with credibility weight `w = n / (n + k)`, k ≈ 150. Standard actuarial credibility weighting; it degrades gracefully. |
| ≥ 300 with ≥ 12 months span | Internal rate may lead, FHFA shown as a sanity band; flag if the two differ by more than ~3 percentage points annualized. |

Additional guardrails that matter more than the model:

- **Cap the rate.** Reject any derived monthly rate outside roughly −1.5% to +2.0%/month
  (≈ −16% to +27%/yr) without human sign-off. Small samples produce absurd slopes routinely.
- **Require ≥ 12 months of span** before fitting a trend (this also matches Fannie's minimum
  look-back). Fitting a slope to 4 months of data is a coin flip.
- **Never extrapolate beyond the data window.** If the newest sale in the segment is 5 months old,
  say so on the screen.
- **Watch for the reflexivity trap:** our comp prices come from appraisals whose values were
  themselves partly determined by appraisers. Using them to derive an appreciation rate that then
  feeds back into valuations is a mild echo chamber. FHFA's All-Transactions index has the same
  criticism and it is why the Purchase-Only index exists. Prefer sale prices (which are market
  facts) over appraised values (which are opinions) whenever both are available — and our comp grid
  gives us sale prices, so this is manageable.

### 5.4 A free bonus in our data

Because the URAR requires the appraiser to report **prior transfer history for each comp (1 year) and
for the subject (3 years)**, our XML contains scattered *prior sale price + date* pairs. Every one of
those, paired with the current sale, is a **repeat-sales observation** — the exact input a
Case-Shiller-style index needs, and one that is immune to the attribute/mix problems that plague
median-based trends. It is sparse and short-horizon, but it is free, it is a genuinely different
estimator from the $/sf regression, and agreement between the two is a strong signal. Worth
extracting from day one even if we don't use it for a year.

---

## 6. The small-data problem — a blunt assessment

### 6.1 What "a few thousand comp rows in a few metros" actually is

Do the arithmetic before deciding what to build. Say 1,000 appraisals × 5 comps = **5,000 comp
lines**, and assume 3 metros. That is **~1,700 comp lines per metro**. Then:

- Split by property type (SFR detached / attached / condo / 2–4 unit) → maybe 900 SFR per metro.
- Split by time (only the last 12 months are usable without heavy time adjustment) → **~300–400 per
  metro per year**, if our volume is steady. If volume is ramping, the older years are much thinner.
- Split by submarket. A metro has 50–300 meaningful submarkets. **300 sales ÷ 100 submarkets = 3.**
- Now condition on the attribute you want to price — e.g. C3 vs C4 at similar GLA — and you are at
  **n = 0 to 4 for most cells.**

That is the whole problem in one line: **our data is adequate at the metro level, marginal at the
submarket level, and empty at the cell level where adjustments actually live.**

There is also a heavy **duplication overlap**: popular comps recur across many appraisals. A
neighbourhood's five best recent sales will appear in a dozen reports. Deduped unique sales may be
**40–70% of raw comp lines**, not 100%. Measure this before promising anyone a row count.

### 6.2 The selection biases baked into appraiser-sourced comps (this is the part people miss)

Our comps are **not a random sample of the market.** Every one of the following is a real,
directional bias:

1. **Appraiser-selection bias.** Comps are chosen *because they are similar to a subject we financed*
   and *because they support a credible value*. The distribution of our comps is the distribution of
   properties near our borrowers' properties, not the market.
2. **Mortgage-financeable bias.** Comps skew arms-length, financeable, habitable. C5/C6 properties,
   distressed sales, and cash-only transactions are structurally underrepresented — which is
   precisely the segment a fix-and-flip lender cares most about.
3. **Our own book's bias.** If we lend on rehab/fix-and-flip, our subjects skew C4/C5 pre-rehab and
   our comps skew renovated C3/C2 resales. Any "market" statistic we compute is really a statistic
   about that slice.
4. **Confirmation/anchoring in the adjustment values themselves.** Appraisers adjust toward a
   supportable conclusion. Averaging appraiser adjustments gives you the *consensus convention*, not
   the market's true marginal price. This is fine for peer benchmarking (§3.5) and wrong for
   coefficient estimation.
5. **Time-adjustment omission bias.** Per FHFA, most historical comps carry a $0 time adjustment that
   should have been non-zero (§3.4). Adjusted prices in old reports are systematically stale.
6. **Transcription error.** Comp data is an appraiser's re-keying of MLS data. Expect a low but
   non-trivial rate of wrong GLA, wrong beds, transposed prices. We have partial protection: the same
   sale appearing in multiple reports lets us cross-check.
7. **Survivorship.** We only have appraisals for loans that got far enough to order one. Deals that
   died pre-appraisal are invisible.

### 6.3 What is honestly possible, and what is not

**Genuinely possible with a few thousand rows:**

| Capability | Why it works small |
|---|---|
| **Comp retrieval / search** ("every comp line we've ever seen within 1 mi, ±20% GLA, last 12 mo") | Pure retrieval. Value scales with `n` but correctness does not depend on it. Immediately useful the day the second appraisal lands. |
| **Property dossier** — everything we know about one address across all reports, with dates and sources | Retrieval + provenance. |
| **Appraiser peer benchmarking** ("this report used $18/sf GLA; the other 40 reports in this county used $45–$70") | Only needs `n` in the tens *per metro*, not per submarket, and it makes no claim about market truth — only about consensus. This is the CU-messages pattern and it is our best early win. |
| **Consistency / data-integrity QC** ("this property was C3, 1,840 sf in the March report and C4, 2,100 sf in the June report") | Needs only 2 observations. High value, zero statistics. |
| **Grid arithmetic validation** — net/gross recompute, wrong-direction adjustments, adjusted-price reconciliation | Deterministic. |
| **Bracketing analysis** on a chosen comp set | Deterministic. |
| **Portfolio/market dashboards** at metro level with `n` shown | Aggregation at a level where `n` is adequate. |
| **Time adjustment using FHFA CBSA index** | Borrowed strength — no internal data needed. |

**Not honestly possible, and will produce misleading numbers:**

| Claim | Why it fails |
|---|---|
| **A submarket-level hedonic model / neighbourhood-specific coefficients** | 3–20 sales per submarket. Coefficients will have standard errors wider than the coefficients. Rule of thumb: you want **≥ 10–20 observations per estimated parameter**; a 10-variable hedonic therefore wants 100–200 clean, homogeneous, contemporaneous sales *per segment*. We will not have that for years. Hedonic models are also documented as prone to overfitting precisely because of the large free-parameter count ([IMF WP/16/213](https://www.imf.org/external/pubs/ft/wp/2016/wp16213.pdf)). |
| **Our own house price index** | Repeat-sales indices need thousands of repeat pairs per metro. We'll have dozens. |
| **A point-estimate AVM with a confidence score** | The confidence score is the hard part, not the value. An FSD we cannot back-test against realized sales is a fabricated number, and under the interagency rule an uncalibrated "high level of confidence" claim is a compliance problem, not just bad statistics. |
| **"Market value of a bathroom in ZIP 33607"** | The regression will return a number. On n=12 it will frequently be negative. Publishing it destroys user trust permanently the first time an appraiser sees it. |
| **Condition-adjustment curves (C1→C6) from our data** | Condition is the highest-variance, most-subjective UAD field and appraisers use it inconsistently across firms. Needs large n *and* inter-rater analysis. |
| **Anything at the property level for a property we've seen once** | One observation, from one date, from one interested party. |
| **Rural/thin markets** | Even CU returns **999 — cannot score** for insufficient data in thin markets. If Fannie's model with the national UAD corpus gives up, we should too, loudly rather than silently. |

### 6.4 The one advantage we have that the big vendors don't

Every large vendor has more sales than us. **None of them has, at scale, multiple independent expert
observations of the same sale with explicit dollar adjustments attached.** CoreLogic knows a house
sold for $412,000; it does not know that four different appraisers rated it C3, C3, C4, C3 and priced
its GLA at $52, $60, $45 and $55/sf.

That data supports products that are *not* AVMs and are defensible on small samples:

- **Inter-appraiser agreement metrics** — variance in condition ratings, in adjustment rates, in
  reported GLA for the same property. Directly actionable for vendor management and QC.
- **Appraiser scorecards** — outlier rate vs peers, time-adjustment usage rate, net/gross
  distribution, revision rate, turn time. Constructed from tens of reports per appraiser, not
  thousands of sales.
- **Adjustment-convention library by market** — the empirical distribution of what appraisers in
  *this* county actually use, per line item, with `n`. This is our version of CU's peer comparison
  and it is the most defensible statistical product we can build in year one.
- **Data-conflict detection across reports** — a genuine, unglamorous, high-value QC feature.

Build these first. They are useful at n=200, they get better at n=20,000, and none of them requires
us to claim we know what a house is worth.

---

## WHAT WE SHOULD BUILD

Opinionated, prioritized, and specific to us: MISMO-only data, a few thousand comp rows, a few metros,
Postgres, and a lending platform whose users are not appraisers.

### The governing principles

1. **Store observations, never overwrite facts.** The atomic row is *"this comp, as observed by this
   appraiser, on this date."* Every derived "current" value is a view, not a table. This is the one
   decision that is expensive to undo later. Get it right first.
2. **Retrieval before regression.** Every retrieval feature is correct at n=10. Every statistical
   feature is wrong at n=10. Ship all the retrieval value before touching a model.
3. **No number without `n`, a date range, and a source.** Make this a rendering rule enforced in the
   component layer, not a guideline. If a statistic can't state its sample size, it doesn't render.
4. **Ranges, never point estimates** for anything valuation-flavoured.
5. **Advisory by default; "not for credit decisioning" until we have the AVM QC program.** The 2024
   interagency rule is the reason, and it is cheaper to build the label in now than to retrofit it.
6. **Name fields after RESO** even with no MLS feed, and keep raw MISMO in a JSONB column forever so
   re-parsing never requires re-collection.

### Data model (concrete, Postgres)

```
property                  -- thin, immutable spine
  property_id (uuid pk), canonical_address_line, unit, city, state, zip5, zip4,
  geog (geography point), apn, apn_county_fips, project_id (nullable, condo),
  created_at, merged_into (nullable, self-fk)

property_address_alias    -- every raw address string we've ever seen for this property
  alias_id, property_id, raw_address, normalized_address, source_ref,
  match_score, match_method, decided_by, decided_at

appraisal_report          -- one filed report
  report_id, loan_id, form_type ('1004'|'1025'|'1073'), effective_date, report_date,
  appraiser_license, appraiser_name, appraiser_state, amc, client,
  subject_property_id, opinion_of_value, raw_mismo (jsonb), ingested_at

comp_observation          -- THE core table: one grid line
  comp_obs_id, report_id, comp_property_id, comp_position (1..8),
  sale_price, sale_contract_date, sale_settlement_date,
  sale_type_uad, financing_type_uad, concessions_amount,
  gla_sqft, site_sqft, room_total, bedrooms, baths_full, baths_half,
  condition_uad, quality_uad, actual_age, year_built,
  view_rating, view_type, location_rating, location_type, design_style,
  basement_sqft, basement_finished_sqft, garage_desc, garage_spaces,
  proximity_miles, days_on_market, data_source_text, mls_number,
  net_adjustment, gross_adjustment_abs, adjusted_price,
  prior_sale_price, prior_sale_date,      -- free repeat-sales data (§5.4)
  raw_line (jsonb)

comp_adjustment           -- one row per grid line item, per comp
  comp_obs_id, line_code ('CONCESSIONS'|'TIME'|'LOCATION'|'SITE'|'VIEW'|'DESIGN'|
                          'QUALITY'|'AGE'|'CONDITION'|'ROOM_COUNT'|'GLA'|'BASEMENT'|
                          'FUNCTIONAL'|'HVAC'|'ENERGY'|'GARAGE'|'PORCH'|'OTHER'),
  line_sequence, description_text, adjustment_amount,
  derived_rate (nullable, e.g. $/sf for GLA, $/space for garage)

subject_observation       -- same shape as comp_observation, for the subject
property_photo            -- photo, property_id, report_id, taken_date, kind, storage_key
property_merge_audit      -- reversible merges (§1.4)
market_index              -- imported FHFA CBSA series + any internal derived series
  cbsa, index_name, period, value, source, imported_at
```

Notes on this shape: `comp_adjustment` as a separate long table (rather than 21 columns) is what makes
the peer-benchmarking product a single `GROUP BY line_code, cbsa` query, and it survives the UAD 3.6 /
new URAR form change without a schema migration. `derived_rate` is computed on ingest (GLA adjustment
÷ GLA difference, garage adjustment ÷ space difference) — that normalization is what makes adjustments
comparable across comps of different sizes, and it's the single most useful computed column in the
whole warehouse.

### The staged plan

**Phase 1 — Ingest, identity, retrieval. (Ship this first; it is the whole foundation.)**

- MISMO 2.6 parser for 1004/1025/1073 → the tables above, with the full raw XML retained in JSONB.
- Address normalization + geocoding + blocking + scored matching + **a human review queue** (§1.4).
  Do not skip the review queue; do not auto-merge across a unit-number conflict.
- Comp search: filters for radius, date window, GLA band, property type, condition band, sale type.
- Property dossier page: every observation of an address, every report it appeared in, every photo,
  with dates and appraiser attribution.
- **Deterministic grid QC on ingest:** net/gross recompute, adjusted-price reconciliation,
  wrong-direction adjustment detection, missing time adjustment on comps > 90 days old.
- **Instrument the dataset from day one:** unique properties, unique deduped sales, comp lines,
  observations-per-property distribution, coverage by ZIP and by month. We need to know our own `n`
  before we decide what phase 2 can support.

Success criterion: an underwriter can answer "have we seen this street before, and what did we see"
in under 10 seconds. No statistics involved, no way to be wrong.

**Phase 2 — Data-conflict detection and appraiser peer benchmarking. (Our best differentiated product,
and it works at small n.)**

- Cross-report conflict flags on the same property: GLA differing > 5%, condition differing > 1 grade,
  year built differing > 1, bed/bath mismatch. Surface as a review queue with both reports side by
  side.
- **Adjustment-convention library**: for each `(cbsa | county, line_code)`, the empirical distribution
  of `derived_rate` — p10 / p25 / median / p75 / p90, with `n` and date span. Render the box plot.
  Suppress entirely below n=20.
- **CU-style single-adjustment flags** on new reports: "GLA adjusted at $18/sf; the 42 reports in this
  county over the last 18 months ranged $45–$70/sf (median $56)." Wrong-direction adjustments flagged
  unconditionally regardless of `n`.
- Appraiser scorecards: outlier rate, time-adjustment usage rate, net/gross distribution, condition
  rating distribution vs peers.

This is the phase that pays for the project. It requires no claim about property value, so it cannot
be embarrassingly wrong; it directly reduces appraisal-review labour; and it improves monotonically
with volume.

**Phase 3 — Time adjustment, borrowed then blended.**

- Import **FHFA All-Transactions and Expanded-Data CBSA series** into `market_index` on a scheduled
  job. Use them as the default time-adjustment source immediately.
- Build the internal log-linear $/sf regression per segment, but **display it only under the sample
  floors in §5.3** and always alongside the FHFA figure. Use credibility weighting `w = n/(n+150)` to
  blend, so the internal number gains influence gradually and automatically.
- Extract the prior-sale pairs (§5.4) as an independent repeat-sales check. Flag when the two internal
  estimators disagree by more than a few points annualized — that disagreement is a data-quality
  alarm, not a modelling detail.
- Hard caps on derived rates; explicit "data window ends N months ago" labelling.

**Phase 4 — User-driven comp analysis (the RPR/HouseCanary pattern), advisory only.**

- Machine-suggested comp set ranked by **similarity only, price excluded from ranking** — copy CU's
  design exactly. Ranking features: distance, GLA %, contract-date recency, condition/quality
  distance, same-project for condos, property type, age.
- User adds/removes comps with a **required reason code**.
- Adjustment lines prefilled from the Phase 2 benchmark, editable, with `n` and the peer range shown
  inline. Where no benchmark exists (n < 20), fall back to the **RPR "better / similar / worse"
  qualitative control** rather than a fabricated dollar figure.
- Live bracketing status, live net/gross with a "convention, not GSE rule" tooltip.
- Output: a **range** from the adjusted comp prices (I'd default to the interquartile range of
  adjusted prices, with the inverse-gross-adjustment-weighted mean as "most likely"), never a bare
  point estimate.
- Immutable snapshot + PDF export with full provenance, USPAP-workfile-compatible.
- Watermark: **advisory — not an appraisal, not for credit decisioning.**

**Phase 5 — Only if the data actually arrives: a real model.**

Gate it on measured thresholds, not on a calendar:
- ≥ 20,000 deduped sales in a metro, ≥ 24 months span, ≥ 300 sales per active submarket, **and**
- a back-test against held-out realized sale prices showing MdAPE and PPE10 in the institutional
  range (§4.2), **and**
- a **calibrated** FSD (realized coverage matches claimed coverage on held-out data), **and**
- fair-lending testing and the interagency AVM QC program in place (§4.5).

If we cannot meet all four, the honest product is Phase 4 with a range, and that is a perfectly good
product. Shipping a point-estimate AVM on thin data would produce numbers that are confidently wrong,
would be discovered by an appraiser within a week, and would poison trust in the whole warehouse.

### Things I would explicitly not do

- **Do not build a single mutable `property` row with current GLA/beds/baths.** It is the default
  design and it is the one that cannot be fixed later.
- **Do not enforce 15%/25%/10% as hard stops.** Fannie removed them in 2014 specifically because
  rules-based systems turned them into stops and distorted appraiser behaviour. Show them; don't
  block on them.
- **Do not encode "1 mile" or "90 days" as GSE requirements.** They are conventions. Label them as
  defaults, make them adjustable, and don't cite Fannie for them.
- **Do not trust the appraiser's `adjusted_price` for analytics.** Store it, compare to it, but always
  recompute from raw price + concessions + our own time adjustment.
- **Do not publish any per-attribute dollar figure below n=20**, and **do not publish a value estimate
  below n=5 eligible comps within the search envelope** — return "insufficient data in this market,"
  which is what CU's 999 score does and is a perfectly respectable answer.
- **Do not let a user edit the model's output number directly** (Zillow's discipline). Let them edit
  inputs, comps, and adjustments; recompute the output. That preserves the audit trail and is the
  cleanest answer to the interagency rule's "protect against manipulation" requirement.

---

## Sources

- [Fannie Mae Selling Guide B4-1.3-08, Comparable Sales](https://selling-guide.fanniemae.com/sel/b4-1.3-08/comparable-sales)
- [Fannie Mae Selling Guide B4-1.3-09, Adjustments to Comparable Sales](https://selling-guide.fanniemae.com/sel/b4-1.3-09/adjustments-comparable-sales)
- [Fannie Mae Selling Guide B4-1.3-07, Sales Comparison Approach Section](https://selling-guide.fanniemae.com/sel/b4-1.3-07/sales-comparison-approach-section-appraisal-report)
- [Fannie Mae Announcement SEL-2024-07](https://singlefamily.fanniemae.com/news-events/announcement-sel-2024-07-selling-guide-updates)
- [Fannie Mae — Market Condition Adjustments fact sheet (May 2025)](https://singlefamily.fanniemae.com/media/40241/display)
- [Fannie Mae Lender Letter LL-2015-02](https://singlefamily.fanniemae.com/media/15271/display)
- [Fannie Mae Collateral Underwriter](https://singlefamily.fanniemae.com/applications-technology/collateral-underwriter)
- [Fannie Mae CU job aid — Single Adjustment Messages](https://singlefamily.fanniemae.com/job-aid/collateral-underwriter/topic/single_adjustment_messages.htm)
- [Fannie Mae CU job aid — Adjustment Messages Overview](https://singlefamily.fanniemae.com/job-aid/collateral-underwriter/topic/adjustment_messages_overview.htm)
- [Freddie Mac Guide Chapter 5605 — Appraisal Requirements](https://guide.freddiemac.com/app/servicing/chapter/5605)
- [Freddie Mac — UAD Condition & Quality Ratings Definitions (PDF)](https://sf.freddiemac.com/docs/pdf/uad-condition-quality-ratings-definitions.pdf)
- [Freddie Mac — UAD Lessons Learned Job Aid (PDF)](https://sf.freddiemac.com/docs/pdf/uad-lessons-learned-job-aid.pdf)
- [Freddie Mac — Market Conditions Analysis Resources (PDF)](https://sf.freddiemac.com/docs/pdf/market-conditions-analysis-resources.pdf)
- [FHFA — Counting Comps: Exploring the Number of Comparable Properties in Home Appraisals](https://www.fhfa.gov/blog/statistics/counting-comps-exploring-the-number-of-comparable-properties-in-home-appraisals)
- [FHFA — Underutilization of Appraisal Time Adjustments](https://www.fhfa.gov/blog/insights/underutilization-of-appraisal-time-adjustments)
- [FHFA — Underappraisal Disparities and Time Adjustments](https://www.fhfa.gov/blog/insights/underappraisal-disparities-and-time-adjustments)
- [FHFA — UAD Aggregate Statistics](https://www.fhfa.gov/uniform-appraisal-dataset-aggregate-statistics)
- [FHFA — UAD Aggregate Statistics Data File Overview (PDF)](https://www.fhfa.gov/sites/default/files/2024-09/UAD%20Aggregate%20Statistics%20Data%20File%20Overview.pdf)
- [FHFA — UAD Appraisal-Level Public Use File documentation (PDF)](https://www.fhfa.gov/document/uad-puf-2.1-data-documentation.pdf)
- [FHFA House Price Index](https://www.fhfa.gov/data/hpi) · [HPI FAQ](https://www.fhfa.gov/faqs/hpi)
- [CFPB — Quality Control Standards for Automated Valuation Models, final rule (PDF)](https://files.consumerfinance.gov/f/documents/cfpb_automated-valuation-models_final-rule_2024-06.pdf) · [rule page](https://www.consumerfinance.gov/rules-policy/final-rules/quality-control-standards-for-automated-valuation-models/) · [OCC Bulletin 2024-17](https://www.occ.gov/news-issuances/bulletins/2024/bulletin-2024-17.html)
- [Cotality (CoreLogic) — CLIP](https://www.cotality.com/products/clip)
- [ATTOM Cloud Help — Property Characteristics](https://cloud-help.attomdata.com/article/497-property-characteristics) · [AVM](https://cloud-help.attomdata.com/article/510-avm)
- [Clear Capital — FSD glossary](https://www.clearcapital.com/resources/glossary-of-terms/fsd-forecast-standard-deviation/) · [AVM testing glossary](https://www.clearcapital.com/blog-avm-testing-glossary/) · [ClearAVM](https://www.clearcapital.com/products/clearavm/)
- [HouseCanary — Valuation Methodology white paper (PDF)](https://cdn.prod.website-files.com/659c81c0f2b2def2180e9b9f/65b19c356809d3de910f5399_hc_valuation-methodology_white-paper%20(1).pdf) · [Property Explorer quick start](https://www.housecanary.com/resources/pexp-quick-start-guide/) · [Underwriting-grade vs marketing AVMs](https://www.housecanary.com/blog/avms-vs-marketing-avms)
- [RPR — Refine Value tool](https://blog.narrpr.com/support/how-do-i-change-the-estimated-value-refine-value-tool/) · [Property pricing with RPR](https://blog.narrpr.com/tips/cma-refine-value-property-pricing/) · [Building a spot-on CMA](https://blog.narrpr.com/tips/building-spot-on-cma/)
- [Zillow — What is a Zestimate](https://zillow.zendesk.com/hc/en-us/articles/360057435854-What-is-a-Zestimate-home-value) · [Building the Neural Zestimate](https://www.zillow.com/tech/building-the-neural-zestimate/)
- [AVMetrics — Forecast Standard Deviation](https://www.avmetrics.net/AVM_glossary/forecast-standard-deviation/) · [Confidence isn't overrated](https://www.avmetrics.net/2020/07/02/for-avms-confidence-isnt-overrated/)
- [ICE Mortgage Technology — Test and validate AVM performance](https://mortgagetech.ice.com/blog/test-and-validate-avm-performance-with-confidence)
- [Taylor & Francis — An Exposition of AVM Performance Metrics](https://www.tandfonline.com/doi/full/10.1080/15214842.2020.1757352)
- [IMF WP/16/213 — How to better measure hedonic residential property price indexes (PDF)](https://www.imf.org/external/pubs/ft/wp/2016/wp16213.pdf)
- [McKissock — Appraisal Adjustments: Types, Methods, and Cheat Sheet](https://www.mckissock.com/blog/appraisal/appraisal-adjustments-types-methods-and-cheat-sheet/) · [How to Defend Adjustments](https://www.mckissock.com/blog/appraisal/how-to-defend-adjustments-in-appraisal-reports/) · [Condition ratings C1–C6 under UAD 3.6](https://www.mckissock.com/blog/appraisal/understanding-appraisal-condition-ratings-c1-to-c6/)
- [Riverfront Appraisals — What is bracketing and why do we do it](https://riverfrontappraisals.com/the-loan-officers-guide-to-appraisals-part-5-what-is-bracketing-and-why-do-we-do-it/)
- [Appraisal Buzz — Supporting Market Conditions Adjustments](https://appraisalbuzz.com/supporting-market-conditions-adjustments-a-comprehensive-guide-for-appraisers/) · [Understanding Fannie Mae's New Market Conditions Adjustments Policy](https://appraisalbuzz.com/understanding-fannie-maes-new-market-conditions-adjustments-policy/)
- [Appraisers Blogs — Major change to FNMA Selling Guide (net/gross removal)](https://appraisersblogs.com/appraisal/update-to-fnma-selling-guide-major-change/)
- [WorkingRE — Fannie, Freddie: New Market Analysis Requirements](https://www.workingre.com/fannie-freddie-new-market-analysis-requirements-february-4th/) · [Time Adjustments](https://www.workingre.com/time-adjustments/)
- [PennyMac Announcement 25-07 — Appraisal Time Adjustment Requirements](https://corr.pennymac.com/announcements/announcement-25-07)
- [TENA — Fannie Mae Issues SEL-2024-07](https://www.tenaco.com/fannie-mae-issues-selling-guide-announcement-sel-2024-07/)
- [JVM Lending — What is a CU Score](https://www.jvmlending.com/blog/what-is-a-cu-score-on-an-appraisal/)
- [Sacramento Appraisal Blog — What you need to know about Collateral Underwriter](https://sacramentoappraisalblog.com/2015/01/20/what-you-need-to-know-about-fannie-maes-collateral-underwriter/)
- [restb.ai — UAD Condition Ratings: What C1–C6 Actually Mean](https://blog.restb.ai/uad-condition-ratings-what-c1-c6-actually-mean)
- [RESO Data Dictionary](https://www.reso.org/data-dictionary/) · [ListingKey field](https://ddwiki.reso.org/display/DDW17/ListingKey+Field)
- [Senzing — What is libpostal](https://senzing.com/what-is-libpostal/) · [Crunchy Data — Address matching with libpostal](https://www.crunchydata.com/blog/quick-and-dirty-address-matching-with-libpostal)
- [Smarty — What is CASS](https://www.smarty.com/articles/what-is-cass) · [Placekey — How to standardize address data](https://www.placekey.io/blog/how-to-standardize-address-data) · [Data Ladder — Address verification](https://dataladder.com/address-verification-software/)
- [BatchData — What does AVM stand for](https://batchdata.io/blog/what-does-avm-stand-for-in-real-estate)
