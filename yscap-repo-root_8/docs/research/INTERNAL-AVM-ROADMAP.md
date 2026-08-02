# Internal AVM Roadmap — comps, ARV, and what our data can honestly support

**Status:** research only. No code changes. Written 2026-08-02.
**Reads on top of:** `docs/research/COMP-DATABASE-INDUSTRY-RESEARCH.md` (the industry survey — data models,
the sales-comparison grid, GSE rules, AVM families, the small-data assessment) and
`docs/PROPERTY-COMP-DATABASE-RESEARCH.md` (the design of what we actually built: db/408, db/409,
`src/lib/research/*`). This document does not repeat those. It answers the next question.

**The owner's ask, verbatim:**

> "the goal is to be able to find comparables, potentially build up our own AVM model from all the
> data that we're importing, and be able to search better comparables to find better ARV reports."

Three things, and they are not equally hard. Finding comparables is solved and shipped. Better ARV
reports is a genuinely tractable problem that we are uniquely positioned to solve. "Our own AVM
model," in the sense the phrase normally means, is years away on volume and may never be the right
build — and the reason is not squeamishness, it is arithmetic, laid out in §1.

A note on sourcing: several primary sources (`fhfa.gov`, `federalregister.gov`, `iaao.org`,
`files.consumerfinance.gov`, `ecfr.gov`) refuse automated fetches from this environment. Where a rule
or figure is quoted below it is reconstructed from search-engine extracts of those pages plus
secondary professional sources, and the primary URL is given so a human can verify. Where I am
reconstructing rather than quoting verbatim, I say so.

---

## Table of contents

1. [What a real AVM needs, and where we are](#1-what-a-real-avm-needs-and-where-we-are)
2. [The ARV problem — the one that is actually ours to win](#2-the-arv-problem--the-one-that-is-actually-ours-to-win)
3. [Model families, ranked for our data](#3-model-families-ranked-for-our-data)
4. [The adjustment-derivation goldmine](#4-the-adjustment-derivation-goldmine)
5. [Time adjustment](#5-time-adjustment)
6. [Accuracy measurement and honesty](#6-accuracy-measurement-and-honesty)
7. [Regulatory and fair-lending reality](#7-regulatory-and-fair-lending-reality)
8. [The staged plan](#8-the-staged-plan)
9. [WHAT TO DO NOW](#what-to-do-now)

---

## 1. What a real AVM needs, and where we are

### 1.1 The unit of account is not "a comp line"

Three different counts come out of the same pile of XML, they differ by an order of magnitude, and
using the wrong one is how people talk themselves into a model they cannot support.

| Count | What it is | What it is good for |
|---|---|---|
| **Comp lines** | one grid row on one report | nothing on its own — it is a raw ingest metric |
| **Deduped closed sales** | one transaction, however many reports mention it | *everything valuation* — $/sqft, hedonic, index, backtest |
| **Adjustment observations** | one dollar adjustment on one line of one grid | peer benchmarking, adjustment rates, appraiser QC |

The middle row is the scarce one. The bottom row is roughly **nine times larger** than the middle
row, and it is the corpus nobody else has. That asymmetry decides the whole roadmap.

### 1.2 The duplication ceiling — the number most people never compute

Comps repeat. A neighbourhood's best recent sales appear in a dozen reports. This is usually
described as "waste," which is wrong twice: it is *replication* for peer statistics (§4), and for
sale statistics it obeys a specific saturating law that puts a hard ceiling on what volume can buy.

If each report draws `k` comps from a pool of `M` eligible recent sales in a market, then after `R`
reports:

```
E[unique sales seen]  =  M · ( 1 − (1 − k/M)^R )
```

Two consequences, both important:

1. **Unique sales are capped at `M`, the number of sales that exist.** A town with 800 arm's-length
   1–4-unit sales a year contains 800 sales a year. No volume of lending gets us past that.
2. **Concentration is our friend and dispersion is our enemy.** 100 appraisals a year in one town
   (k=5, M=800) yields `800 · (1 − 0.99375^100) = 373` unique sales — **47% of that town's entire
   market**. The same 100 appraisals spread over 20 towns yields ~5 reports and ~25 unique sales per
   town — 3% coverage each, useless everywhere.

This is the single most actionable quantitative fact in this document: **model the two or three
markets we are concentrated in, and refuse everywhere else.** A national internal AVM is not a
smaller version of a good one; it is a different, worse thing.

### 1.3 The arithmetic at 500 / 2,000 / 10,000 appraisals

Assumptions, all stated so they can be argued with and all measurable against the real warehouse
with the SQL in §1.6:

- **k = 5** comp lines per appraisal on average. One-grid as-is reports run 3–4; two-grid
  subject-to-repairs reports (most of our book) run 6–8. FHFA reports that more than two-thirds of
  Enterprise appraisals 2013–2021 carried five or more comps, falling from 76% in 2013 to 59% in
  2021, and 13 points lower in rural areas
  ([FHFA, *Counting Comps*](https://www.fhfa.gov/blog/statistics/counting-comps-exploring-the-number-of-comparable-properties-in-home-appraisals)).
- **Dedupe ratio 55%** of comp lines → unique properties (the industry survey's 40–70% band, centred).
- **~5 non-zero adjustment lines per comp** (concessions, time, location, site, GLA, condition,
  garage… a typical grid).
- **24-month accumulation window.** Property mix for a NJ/NY fix-and-flip book: SFR 50%, 2–4 unit
  35%, condo 10%, other 5%.
- **Geography:** top metro 40% of volume, top 3 metros 70%. Within the top metro, the busiest town
  ≈ 10% of the metro's reports.

| | **A = 500** | **A = 2,000** | **A = 10,000** |
|---|---|---|---|
| Comp lines | 2,500 | 10,000 | 50,000 |
| Subject observations | 500 | 2,000 | 10,000 |
| **Deduped closed sales (all markets)** | **~1,375** | **~5,500** | **~27,500** |
| **Adjustment observations** | **~12,500** | **~50,000** | **~250,000** |
| Paired as-is / ARV appraisals (60% subject-to) | ~300 | ~1,200 | ~6,000 |
| Top metro — deduped sales, 24 mo | ~750 | ~2,400 | ~9,600 |
| Top metro — **per quarter, all types** | ~94 | ~300 | ~1,200 |
| Top metro — **SFR per quarter** | ~47 | ~150 | ~600 |
| Top metro — 2–4 unit per quarter | ~33 | ~105 | ~420 |
| Top metro — condo per quarter | ~9 | ~30 | ~120 |
| Busiest town — unique sales, 24 mo (M=1,600) | ~97 | ~351 | ~1,139 |
| Busiest town — **SFR per quarter** | **~6** | **~22** | **~71** |
| 3rd metro — SFR per quarter | ~12 | ~38 | ~150 |

Read the bold rows. At 500 appraisals the *best* cell in the *best* town in the *best* metro is six
single-family sales a quarter. At 10,000 appraisals — which at even 100 loans a month is more than
eight years away — the busiest town reaches 71 SFR a quarter and is approaching the saturation
ceiling: we would be seeing about 71% of everything that trades there.

### 1.4 What published models train on, and the published floors

| Reference | Scale | Source |
|---|---|---|
| Zillow Zestimate | **104–110 million homes**; national **off-market median error 7.49%** (earlier reported 6.9%) | [Zillow Tech Hub](https://www.zillow.com/tech/building-the-neural-zestimate/), [Zillow Help](https://zillow.zendesk.com/hc/en-us/articles/360057435854-What-is-a-Zestimate-home-value) |
| Clear Capital ClearAVM | **120M+ properties**, claimed **MdAPE 2.3%** | [Clear Capital](https://www.clearcapital.com/products/clearavm/) |
| Fannie Mae Collateral Underwriter | the **entire national UAD corpus** — and still returns **999 = cannot score** in thin markets | [Fannie CU](https://singlefamily.fanniemae.com/applications-technology/collateral-underwriter) |
| FHFA UAD Appraisal-Level PUF | a **5% nationally representative sample** of Enterprise appraisals, 2013–2022, published as a *research* file | [FHFA UAD PUF](https://www.fhfa.gov/data/uad-appraisal-level-public-use-file-puf) |
| **IAAO ratio-study floor** | **"an absolute minimum of 30 sales or appraisal ratios… in each economic area"**; up to **5 years** of data may be pooled to reach an adequate sample | [IAAO, *Standard on Ratio Studies*](https://www.iaao.org/wp-content/uploads/Standard_on_Ratio_Studies.pdf) |
| Hedonic regression | **10–20 observations per estimated parameter** → a 10-variable model wants **100–200 clean, homogeneous, contemporaneous sales per segment** | [IMF WP/16/213](https://www.imf.org/external/pubs/ft/wp/2016/wp16213.pdf) |
| Gradient-boosted trees | recommended regime is roughly **10³–10⁴ samples**; below that, split points are unreliable | [scikit-learn ensembles](https://scikit-learn.org/stable/modules/ensemble.html) |

### 1.5 The verdict, per approach, stated plainly

**Defensible today, at any n:**

- **Comp retrieval and the property dossier.** Correct at n=2. Already shipped.
- **Deterministic grid QC** — net/gross recompute, wrong-direction adjustments, adjusted-price
  reconciliation, missing time adjustment. Correct at n=1.
- **Cross-report conflict detection.** Needs two observations of one property.
- **Bracketing analysis** on a chosen comp set. Deterministic.
- **Time adjustment from the FHFA CBSA index.** Borrowed strength; needs zero internal data (§5).

**Defensible at ~500–1,000 appraisals** (because the unit is the *adjustment*, not the sale):

- **Adjustment-convention library** at metro/county level: at A=500 the top metro alone yields
  ~5,000 adjustment observations, of which roughly 600 are GLA rates with a usable ΔGLA and ~350 are
  condition rates. That clears the IAAO floor of 30 by an order of magnitude. **This is the first
  statistical product that becomes honest, and it becomes honest far earlier than anything else.**
- **CU-style peer flags** on new reports (§4.6).
- **Metro-level median $/sqft with strata**, reported with `n` and a date range — at A=500 the top
  metro has ~190 SFR sales in the trailing year, comfortably over 30.

**Not defensible until the numbers in §8, and misleading before then:**

- **A submarket/town-level hedonic.** At A=2,000 the busiest town has 22 SFR sales a quarter and 88
  a year — below the 100–200-per-segment floor, and that is the *best* cell we own.
- **Our own house price index.** Repeat-sales indices need thousands of pairs per metro per period.
  Our prior-sale pairs (the URAR's 1-year comp / 3-year subject transfer history) will number in the
  low hundreds at A=2,000 — a useful *cross-check* (§5.5), never an index.
- **A point-estimate AVM with a confidence score.** The value is the easy half. The confidence is the
  hard half, and an FSD that has not been back-tested against realized sale prices is a decorative
  number — see §6, and see §7 for why asserting an uncalibrated "high level of confidence" is a
  compliance problem and not merely bad statistics.
- **Gradient boosting.** §3(c) gives the technical reason it is worse than useless for ARV, on top of
  the sample-size reason.

### 1.6 The binding constraint is not comp rows — it is labelled outcomes

Everything above counts *inputs*. An AVM is a supervised model, and the thing it is supervised by is
**what the property actually sold for after we valued it**. We hold approximately zero of those
today. `applications` records `funded_date` (db/315) and `sitewire_property_links.lifecycle_state`
can reach `'paid_off'` (db/174) — a state flag with no price, no date, no proceeds. There is **no
table in this schema that records the exit of a loan we funded.** That is the single largest gap in
the entire roadmap and it is cheap to close (§9).

But there is a second, free source of ground truth that we already own and are not using, and it is
better than it sounds:

> **A property we valued today becomes a labelled outcome the moment some other appraiser puts it on
> a grid as a settled comparable sale.**

That is an arm's-length closed price for the exact property, reported by an independent professional,
arriving in our XML at no cost. `properties.subject_count` and `properties.comp_count` already exist,
so "which of our subjects have since sold" is one query — given in §1.7. At A=2,000, with 2,000
subjects concentrated in a handful of towns where we also see 47% of the market, a meaningful
fraction will reappear. This supply grows quadratically with concentration, which is another reason
concentration is the strategy.

And there is a third, which is available immediately and is the one that makes §6 possible at all:
**retrospective out-of-time backtesting on the comps themselves.** Pick a cut date `T`; using only
reports and sales dated before `T`, predict the sale price of every closed comp that settled after
`T`; roll `T` forward monthly. At A=2,000 with ~5,500 unique sales, perhaps 1,500 will have adequate
pre-cutoff comp support. **n = 1,500 is enough to state an MdAPE with a ±0.5-point confidence
interval.** So we can measure our own accuracy long before we can build a real model — which is the
correct order.

### 1.7 Measure it — do not estimate it

Every number in §1.3 is a projection. All of them are directly measurable against db/408 today. Run
these and put them on a dashboard; §9 makes that the first item.

```sql
-- (a) The three counts, and the real dedupe ratio.
SELECT count(*) FILTER (WHERE role='comparable')                              AS comp_lines,
       count(DISTINCT property_id) FILTER (WHERE role='comparable')           AS unique_comp_properties,
       round(count(DISTINCT property_id) FILTER (WHERE role='comparable')::numeric
             / NULLIF(count(*) FILTER (WHERE role='comparable'),0), 3)        AS dedupe_ratio,
       count(*) FILTER (WHERE role='subject')                                 AS subjects,
       (SELECT count(*) FROM property_sales
         WHERE COALESCE(sale_status,'closed')='closed' AND sale_price IS NOT NULL) AS deduped_closed_sales
FROM property_observations;

-- (b) Deduped closed sales per market per quarter per type — THE table that decides §8.
--     (city is the proxy for a submarket until a CBSA crosswalk exists — see §9 item 7.)
SELECT p.state, lower(p.city) AS city,
       date_trunc('quarter', s.sale_date)      AS qtr,
       COALESCE(p.property_type,'(unknown)')   AS ptype,
       count(*)                                AS deduped_sales
FROM property_sales s
JOIN properties p ON p.id = s.property_id
WHERE COALESCE(s.sale_status,'closed') = 'closed'
  AND s.sale_price IS NOT NULL
  AND s.sale_date >= now() - interval '3 years'
GROUP BY 1,2,3,4
ORDER BY 5 DESC;

-- (c) Adjustment observations by market and line code, with the appraiser count.
--     Fewer than 3 distinct appraisers is one appraiser's habit, not a market rate (§4.5).
SELECT p.state, p.county, adj->>'type' AS line_code,
       count(*)                          AS n,
       count(DISTINCT o.appraiser_id)    AS appraisers,
       min(o.observed_on) AS first_seen, max(o.observed_on) AS last_seen
FROM property_observations o
JOIN properties p ON p.id = o.property_id
CROSS JOIN LATERAL jsonb_array_elements(o.adjustments) AS adj
WHERE o.role = 'comparable' AND (adj->>'amount') IS NOT NULL
GROUP BY 1,2,3
HAVING count(*) >= 10
ORDER BY n DESC;

-- (d) The ARV training set that already exists.
SELECT count(*)                                              AS arv_pairs,
       count(*) FILTER (WHERE ap.rehab_budget > 0)           AS arv_pairs_with_budget,
       count(*) FILTER (WHERE ap.sqft_post > ap.sqft_pre)    AS pairs_adding_sqft
FROM appraisals a
JOIN applications ap ON ap.id = a.application_id
WHERE a.superseded = false
  AND a.as_is_value IS NOT NULL AND a.arv_value IS NOT NULL
  AND a.arv_value > a.as_is_value;

-- (e) THE MONEY QUERY: our own subjects that a later report shows as a settled sale.
--     This is the free, growing, independent ground truth of §1.6.
SELECT count(DISTINCT p.id) AS subjects_later_sold
FROM properties p
WHERE p.subject_count > 0
  AND EXISTS (
    SELECT 1 FROM property_observations c
     WHERE c.property_id = p.id AND c.role = 'comparable'
       AND c.sale_price IS NOT NULL
       AND COALESCE(c.sale_status,'closed') = 'closed'
       AND c.sale_date > (SELECT max(s.observed_on) FROM property_observations s
                           WHERE s.property_id = p.id AND s.role = 'subject'));
```

---

## 2. The ARV problem — the one that is actually ours to win

### 2.1 Why the public AVMs are worst at exactly our question

An AVM's training label is *the realized arm's-length sale price of a property in the condition it
was in*. ARV is not that. ARV is a **prospective value** — the market value the property will have
once a scope of work that has not happened is complete. The Interagency Appraisal and Evaluation
Guidelines (2010) set this out directly: for construction or renovation financing an appraiser
provides the "as is" market value plus a *prospective* market value upon completion (and, for income
property, upon stabilization), and an institution "should understand the real property's 'as is'
market value and should consider the prospective market value that corresponds to the credit
decision and the phase of the project being funded"
([Interagency Guidelines, Dec 2 2010](https://www.federalreserve.gov/boarddocs/srletters/2010/sr1016a1.pdf)).

Three structural reasons a Zestimate cannot answer it:

1. **It has no scope of work.** ARV is a function of `(property, scope)`. Given only `property`, the
   question is under-determined — a $40k cosmetic refresh and a $260k gut of the same house have
   different answers, and the model is not given the input that distinguishes them.
2. **The renovation changes the very features the model keys on.** GLA, bed/bath count, condition and
   quality are the model's inputs, and the whole point of the loan is that they are about to move.
   Feeding today's attributes returns today's value by construction.
3. **The label does not exist in their data at the moment we need it.** They learn from completed
   sales. We need a number before the work starts.

And the money at stake in getting it wrong is documented: ATTOM reports the typical flip in 2025
netted **$65,981 gross profit on a 25.5% ROI, the lowest since 2008**, on a national median
$260,000 purchase / $320,000 resale
([ATTOM 2025 Year-End Home Flipping Report](https://www.attomdata.com/news/market-trends/flipping/2025-year-end-home-flipping-report/)).
At those margins a 10% ARV error is the entire deal.

### 2.2 What we hold that nobody else does

On a subject-to-repairs report the appraiser states **two values for one property on one day**: the
as-is value and the after-repair value. Critically, the two are supported by **two different comp
sets** — the as-is grid uses tired C4/C5 sales, the ARV grid uses renovated C2/C3 resales — and
db/408 already records which grid every comparable came off (`property_observations.comp_set`), how
confident that split is (`comp_set_confidence`), and whether the subject's condition rating describes
the house today or after the work (`condition_basis` = `as_is` | `as_repaired`).

That is not a dataset. That is an **experimental design**:

> The same property, valued twice, by the same appraiser, on the same effective date, differing only
> in condition. Location, lot, view, market date, appraiser level-bias and every unobserved property
> characteristic difference *out*. What is left is the price of the renovation.

Condition is described in the industry survey as "the highest-variance, most-subjective UAD field"
and "the single largest driver of unexplained variance." Every other approach has to estimate it
across properties, where it is hopelessly confounded. **We can estimate it within a property.** That
is a genuinely stronger identification strategy than anything a national vendor can run, and it is
why the sample size needed here is far smaller than for an AVM.

Layered on top of it, still ours alone:

| Asset | Where it lives today | State |
|---|---|---|
| Paired as-is / ARV values | `appraisals.as_is_value`, `.arv_value`, `.condition_of_appraisal` (db/137) | present, structured, confidence-stamped |
| The ARV comp set, separated | `property_observations.comp_set` + `comp_set_confidence` (db/408) | present |
| As-repaired subject attributes | the seq-0 `appraisal_comparables.is_subject` column + `condition_basis='as_repaired'` | present, and this is the *label* for §2.4 |
| Construction budget | `applications.rehab_budget`, `financed_rehab_budget`, `rehab_type`, `sqft_pre`, `sqft_post` | present |
| **Line-item scope of work** | the SOW tool payload (18 categories, ~90 line items, `web/v2/tools/rehab-budget.js`) | **stored as JSONB — cannot be grouped** |
| **Actual money spent, per line** | `draw_disbursements` + `sitewire_draw_requests` (db/131) bound to SOW lines via `sitewire_job_item_links` | present, and this is *actual* cost vs *budgeted* |
| **Realized exit price** | — | **does not exist** |

### 2.3 Three models over that data, in build order

**(a) The uplift-ratio model — simplest, most defensible, works first.**

For report `r` on property `p` at effective date `t`, with construction budget `B`:

```
U_r  = ARV_r − AsIs_r                     dollars of value created
u_r  = ln( ARV_r / AsIs_r )               log uplift (use this for modelling)
ρ_r  = U_r / B_r                          dollars of value per dollar of rehab
```

Estimate `ρ̂` as a **median of ratios** within a cell of (market × rehab type), never a mean — the
denominator is small and noisy on light-scope files and the mean is destroyed by a handful of them.
Report it with the distribution-free order-statistic interval of §4.3.

**How many pairs to state a `ρ̂` usefully?** For a median, the asymptotic standard error is
`1.2533 σ / √n`, so the 90% half-width is `1.645 × 1.2533 σ / √n = 2.062 σ / √n`, giving

```
n  =  ( 2.062 · σ_ρ / h )²           h = the half-width you are willing to publish
```

With a plausible `σ_ρ ≈ 0.45` (ratios clustered around 1.0–1.6 with real spread):

| Target half-width on ρ̂ | Pairs needed per cell |
|---|---|
| ±0.20 (a directional read) | **22** — below the IAAO floor; show a range, not a central estimate |
| ±0.15 | **38** |
| ±0.10 | **86** |
| ±0.05 | **345** |

So **~60–90 paired appraisals in a (market family × rehab type) cell** buys a ±0.10 statement, which
is a useful thing to say to an underwriter. Per §1.3 that arrives somewhere between A=500 and
A=1,000 for the top market and the most common rehab type — **years before anything AVM-shaped.**

Sanity-band it against the public prior. Zonda's 2025 *Cost vs. Value Report* puts national cost
recouped at **112.6% for a minor midrange kitchen remodel ($28,458), 50.9% for a major midrange
kitchen ($82,793), and 35.7% for an upscale kitchen ($164,104)**
([Zonda 2025 Cost vs. Value](https://zondahome.com/2025-cost-vs-value-report/)). That is a resale-ROI
measure, not an appraiser's ARV uplift, so it is not the same quantity — but it establishes the shape
that matters: **ρ falls sharply as scope deepens.** Any internal `ρ̂` that is flat in scope size, or
above ~1.3 on a heavy rehab, is telling you the sample is wrong.

**(b) The log-uplift regression — the real model, at ~150–300 pairs per market.**

```
ln( ARV_i / AsIs_i )  =  α
                       + β · ln( 1 + B_i / AsIs_i )          scope intensity, β < 1 expected
                       + Σ_c γ_c · share_ci                   share of budget in category c
                       + δ · ln( sqft_post_i / sqft_pre_i )   added square footage
                       + θ_bath · Δbaths_i  +  θ_bed · Δbeds_i
                       + η · Δcondition_grades_i              as-is rank → as-repaired rank
                       + Σ_m market_m  +  Σ_q quarter_q       fixed effects
                       + ε_i
```

Fit by robust (Huber) regression, not OLS — a handful of mis-keyed budgets will otherwise own the
answer. `β < 1` is the diminishing-returns result the Cost vs. Value data predicts; if the fit
returns `β ≥ 1` the model is claiming every marginal rehab dollar creates more than a dollar, which
is not true of any real market and means the sample is dominated by light-scope files.

**This is the model the ARV report should eventually run on, and `share_c` is the reason `rehab_scope_lines`
must exist** — you cannot compute a category share from a JSONB blob without a `GROUP BY`.

**(c) The direct ARV comp grid — build this one FIRST, because it needs no new statistics at all.**

This is what the appraiser does, and the warehouse is already shaped for it. Value the property *as
if* it were in its post-rehab state, against the ARV comp set:

1. Derive the **post-rehab attribute vector** from the scope of work (§2.4).
2. Search `properties` for closed sales matching *that* vector — renovated condition band, target
   GLA, target bed/bath count — preferring properties whose observations carry
   `comp_set = 'arv'` (they were chosen by an appraiser as renovated comparables, which is a
   free relevance signal nobody else has).
3. Run `src/lib/research/valuation.js` `buildGrid()` unchanged, with `purpose = 'arv'`
   (db/409 already carries the field).

Everything in that path exists today except step 1.

### 2.4 The scope-of-work → post-rehab attribute mapper

This is the missing piece, and it is a **deterministic rules table over an 18-category taxonomy we
already own**, not a model. The SOW tool's categories are fixed (`CATS` in
`web/v2/tools/rehab-budget.js`): soft, genconds, demo, site, siteutil, foundation, shell, exterior,
interior, flooring, mep, kitchen, baths, appliances, basement, special, final, other.

A first cut of the rules — every one of which is falsifiable against the as-repaired subject
observations we already store, which is the point:

| Signal in the scope | Post-rehab attribute moves |
|---|---|
| `kitchen` **and** `baths` both funded, combined ≥ 15% of subtotal | condition target → **C3**; with `mep` and `interior` also funded, → **C2** |
| `mep` (panel/plumbing/HVAC) ≥ 10% of subtotal | condition target ≥ C3 (a C4 with new systems is a C3) |
| `exterior` → Roof, Siding, Windows | condition target ≥ C3; supports quality unchanged |
| `sqft_post > sqft_pre` | GLA target = `sqft_post` (already an `applications` column) |
| `basement` → "Finish basement" | below-grade **finished** sqft target; **never** rolled into GLA |
| `special` → "ADU / addition" | unit count and/or bed count moves; flag for human confirmation |
| `baths` → "Full bath remodel" ×N vs. a *new* bath line | distinguish **remodelled** (no count change) from **added** (count change) — the taxonomy does not currently separate these, and it must |
| Scope is `demo` + `foundation` + `shell` | ground-up: there is no as-is condition, and the uplift model does not apply |

Two disciplines that must hold:

- **Never guess a target the scope does not support.** A refresh with no bath work does not gain a
  bathroom because the market likes bathrooms. If an attribute cannot be derived, carry the as-is
  value forward and say so on the report.
- **Calibrate the table, don't assert it.** For every paired report we hold, we know the scope *and*
  the appraiser's own as-repaired subject attributes. That is a labelled training set for the mapper
  itself: predict the as-repaired condition rating from the scope, and measure the confusion matrix.
  At A=500 that is ~300 labelled examples — plenty to check a rules table, nowhere near enough to
  learn one, which is exactly why it should be a rules table.

### 2.5 Validating against realized exits

Three tiers of truth, in descending strength. Use all three; report which one each validation row
came from, because they are not equally believable.

**Tier 1 — the property reappears as a settled comp on a later appraisal.** An arm's-length closed
price for the exact property, from an independent professional, at no cost. Query (e) in §1.7 is the
supply. This is the strongest signal available to us and it costs nothing but the join.

**Tier 2 — the payoff of our own loan.** We know when a loan was retired and by what. Requires the
`loan_outcomes` table we do not have (§2.6). This is the tier that answers the question an
underwriter actually asks — *did the borrower hit the ARV we underwrote?* — and it is the cheapest
high-value thing on the whole list.

**Tier 3 — the borrower's own track record line for a deal we financed.** `track_records` already
carries `purchase_price`, `sale_price`, `sale_date`, `rehab_amount`, `is_verified` — and a repeat
borrower will list a deal we funded as experience on their next file. Self-reported and only
sometimes verified, so treat it as evidence, never as truth, and always carry `is_verified` through
to any statistic computed from it.

**The measurement itself**, once a tier-1 or tier-2 exit lands for a file where we recorded an ARV:

```
realized_error_i = ( Exit_i − ARV_i ) / ARV_i
hold_months_i    = months between the appraisal effective date and the exit
```

and then, per §6: **MdAPE, PPE10, PPE20, and signed bias** — with bias the one that matters most
here. A symmetric error distribution around zero means our ARVs are noisy. A *persistently positive*
`ARV − Exit` means we are systematically over-valuing after-repair, which is a credit-loss mechanism
and not a modelling curiosity. Break it out by rehab type, by market, by appraiser, and by
hold period; the hold-period breakout separates "the ARV was wrong" from "the market moved during
the project," which are different problems with different fixes.

### 2.6 Tables and fields the ARV work needs

**New tables (four):**

```sql
-- 1. THE MISSING ONE. Without this nothing in §2.5 tier 2 and nothing in §6 can be measured.
loan_outcomes(
  id, application_id  REFERENCES applications(id) ON DELETE SET NULL,   -- SET NULL: the outcome
  property_id         REFERENCES properties(id)   ON DELETE SET NULL,   -- outlives the loan file
  exit_type           text,   -- sale | refinance | payoff_other | extension | foreclosure | reo | note_sale
  exit_date           date,
  exit_price          numeric(14,2),      -- gross sale price, when exit_type = 'sale'
  payoff_amount       numeric(14,2),      -- what retired our note
  net_proceeds        numeric(14,2),
  source              text,   -- payoff_letter | hud1 | deed | borrower_stated | later_appraisal_comp
  evidence_document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  confidence          text,   -- definite | reported | inferred     (the db/137 discipline)
  recorded_by uuid, recorded_at timestamptz, notes text
);

-- 2. The backtest ledger. Start it before there is anything to write in it.
valuation_outcomes(
  id, valuation_id REFERENCES property_valuations(id) ON DELETE CASCADE,
  realized_sale_id REFERENCES property_sales(id) ON DELETE SET NULL,
  realized_price numeric(14,2), realized_date date, months_between numeric(6,2),
  error_pct numeric(8,3), abs_error_pct numeric(8,3),
  truth_tier smallint,        -- 1 later-comp | 2 our payoff | 3 borrower-stated
  model_version text, recorded_at timestamptz
);

-- 3. The scope, as ROWS. A category share cannot be computed from a JSONB blob.
rehab_scope_lines(
  id, application_id, sow_document_id, version integer,
  category_id text,      -- 'kitchen' | 'baths' | 'mep' | …  (the CATS ids, verbatim)
  line_item   text,      -- 'Cabinets' | 'Panel / service upgrade' | …
  unit_no     integer,   -- per-unit lines on a 2-4 (the explosion sitewire/mapper already does)
  cost_class  text,      -- hard | soft
  amount_budgeted numeric(14,2),
  amount_drawn    numeric(14,2),   -- rolled up from draw_disbursements via sitewire_job_item_links
  UNIQUE (application_id, version, category_id, line_item, COALESCE(unit_no,0))
);

-- 4. Adjustments as ROWS (this one is also §4's foundation — see §4.1).
observation_adjustments(
  id, observation_id REFERENCES property_observations(id) ON DELETE CASCADE,
  property_id, appraiser_id, market_key text, observed_on date,
  line_code text,          -- normalized from the MISMO `type`
  description text,
  amount numeric(14,2),
  attribute_delta numeric(14,4),   -- subject − comp, in the line's own unit
  delta_unit text,                 -- sqft | bath | bed | space | grade | month | dollar
  derived_rate numeric(14,4),      -- amount / attribute_delta
  derived_rate_pct numeric(10,6),  -- amount / (sale_price × |delta|) — for condition/quality/view/location
  sale_price numeric(14,2),        -- denormalized on purpose; the rate is meaningless without it
  flags text[]                     -- wrong_direction | zero_with_delta | delta_below_floor | outlier
);
```

**New columns:**

- `applications.arv_source_appraisal_id` — which appraisal the file's ARV came from. Today
  `as_is_applied_value` / `arv_applied_value` on `appraisals` record what PILOT wrote (db/353,
  db/356) but the file does not point back.
- `applications.principal_dwelling` boolean — see §7.2. Not an ARV field, but it belongs on the same
  form and it is free to collect now.
- `property_observations.contract_date` — see §5.2 and §9 item 3. The UAD grid states it and the
  parser throws it away.

---

## 3. Model families, ranked for our data

Ranked by *defensibility at our size*, which is not the same as ranked by sophistication.

### (a) Comp-based / appraisal emulation — **rank 1. Use this.**

**Needs:** ≥3–5 eligible closed sales inside a search envelope, and adjustment rates from somewhere
(§4). **Gives:** a value, a range, and — uniquely — an *explanation a human can check*: here are the
six sales, here is what we changed and why.

**Defensible at our size: yes, today.** It is correct at n=5 eligible comps in a way no statistical
model is correct at n=5, because it does not estimate a location surface — it *conditions* on
location by construction. A sale 300 feet away carries information that a hedonic would need
thousands of rows to learn and would still learn worse.

The strongest evidence for this ranking is that Fannie Mae, holding the entire national UAD corpus,
still ships a **comp-based** reviewer: Collateral Underwriter ranks the 20 most similar sales
(M1–M20) by physical characteristics, location and sale date, with "the sale prices of these
comparables… not a factor in the ranking," and *then* compares
([Fannie CU](https://singlefamily.fanniemae.com/applications-technology/collateral-underwriter)).
If the largest owner of this data in the world picks comps by similarity, we should too.

Already built: `src/lib/research/valuation.js`. See §3(g) for three specific things in it that the
arithmetic in this document says are set too loose.

### (b) Hedonic regression — **rank 2, but as an adjustment-rate estimator, not a value estimator**

**Needs:** 10–20 observations per parameter — 100–200 clean, homogeneous, contemporaneous sales per
segment for a realistic 10-variable specification.
**Gives:** coefficients, which are exactly what a grid line wants.

**Defensible at our size: at metro level, from roughly A=2,000; never at submarket level.** The
right use is not "predict the price" — it is "what is a square foot worth in Essex County," fed into
(a). Start with OLS on `ln(price)` with 5–6 features and market fixed effects; add ridge only when
the feature count grows, and be honest that regularization on 200 rows and 8 features buys very
little that dropping two features would not.

The trap: a coefficient's *sign* is more fragile than its magnitude on small samples.
`valuation.js` already refuses a wrong-signed derived rate with a reason, which is the correct
behaviour and must be preserved in any regression path.

### (c) Gradient-boosted trees — **rank 4 for as-is, and structurally WRONG for ARV**

**Needs:** roughly 10³–10⁴ samples to be in its recommended regime
([scikit-learn](https://scikit-learn.org/stable/modules/ensemble.html)); realistically ≥10,000
deduped sales **in one metro** with 24+ months of span before it can be argued for.
**Gives:** the best raw accuracy of any family — *when it has the data*.

Two reasons it ranks low here and one reason it is disqualified for ARV:

1. **Sample.** Per §1.3, 10,000 deduped sales in a single metro is A ≈ 10,000 appraisals. Years.
2. **Opacity vs. the obligations in §7.** "Ensure a high level of confidence" and "comply with
   applicable nondiscrimination laws" are much harder to evidence for a boosted ensemble than for a
   grid, and the fair-lending outcome testing has to be done either way.
3. **Trees cannot extrapolate.** A tree's prediction is an average of training labels in a leaf, so
   it is mathematically incapable of predicting outside the range of its training data. **ARV is by
   construction above the as-is comps** — that is the whole point of the number — and the training
   set on a rehab book skews toward tired properties. A GBT asked for the ARV of a gut rehab will
   return something near the top of the distressed distribution and be confidently, systematically
   low. This is not a tuning problem. It is the model class being wrong for the question.

If a GBT is ever built, it must be for **as-is** value only, and it must be gated on a demonstrated
out-of-time win over (a) — see §8 phase 7.

### (d) Repeat-sales index — **rank 5 as an index; rank 2 as a cross-check**

**Needs:** thousands of repeat pairs per metro per period. **Gives:** the cleanest possible measure of
pure market movement, immune to mix shift, because property attributes cancel.

**Defensible at our size: never as our own index.** But the URAR requires the appraiser to research
prior transfers — 3 years for the subject, 1 year for each comparable — so our XML contains scattered
prior-sale price/date pairs for free. At A=2,000 that is likely a few hundred pairs nationally. Far
too few for an index; **exactly right as an independent second estimator of the time trend** (§5.5).
When the $/sqft regression and the repeat-sales read disagree by more than a few points annualized,
that disagreement is a data-quality alarm.

And the assumption that breaks worst for us is worth naming: repeat-sales assumes the property did
not change between sales. **Our entire book is properties that changed between sales.** A flip's
purchase→resale pair is a renovation premium, not appreciation. Any repeat-sales use must exclude
pairs where a renovation happened — which, ironically, we can do better than anyone, because we know
which properties we lent on.

### (e) Price-per-sqft with stratification — **rank 3, as a band, never as the answer**

**Needs:** ≥30 sales per stratum (the IAAO floor) and honest strata: market × property type × GLA
band × condition band. **Gives:** a defensible sanity range and, in a thin market, the only thing we
can honestly say.

Its failure mode is mix shift — a quarter with more large homes shows "appreciation" that is not
there — which is why stratification is not optional. Report as median with IQR and `n`, always.

### (f) An ensemble — **premature by definition**

An ensemble is a weighted blend of members that are each individually defensible. We have exactly one
such member today. Revisit when there are two.

The *useful* form of the idea, available now, is a **cascade** rather than a blend: try the comp grid;
if it cannot find ≥5 eligible comps, fall to a stratified $/sqft band; if that stratum is under 30
sales, **refuse and say so**. That is what CU's 999 score is, and refusal-as-a-feature is the single
most under-built thing in most internal valuation tools.

### (g) The honest answer to "will a good grid beat machine learning?"

**Yes, at our size, and the evidence is specific rather than sentimental.**

- Sample size: (a) is correct at n=5; (c) needs 10³–10⁴.
- Location: (a) conditions on it; (c) must learn it, and location is the single largest term.
- Extrapolation: (c) structurally cannot do the thing ARV requires.
- Where the error actually is: FHFA's own research found appraisers time-adjusted **fewer than 10% of
  comparable sales** for much of the study period, and only **18.5% of purchase transactions
  2018–2021** carried any time adjustment at all, while the *expected* adjustment would have averaged
  **2.5%–9% of sale price**
  ([FHFA, *Underutilization of Appraisal Time Adjustments*](https://www.fhfa.gov/blog/insights/underutilization-of-appraisal-time-adjustments)).
  A large, systematic, one-parameter error sits in the *time* line — and it is fixable in a week with
  a free public index (§5). Chasing a 1-point MdAPE improvement with a boosted ensemble while a
  5-point error sits in the time adjustment is the wrong order of work.
- Precedent: CU is comp-based.

**Three things in `valuation.js` that this document says are too loose**, and should be raised as part
of the work in §9:

1. `deriveMarketRates({ minSample: 8 })` — a floor of **8** is below every published standard. The
   IAAO minimum is **30** per economic area. Raise it, and split it: 30 for a rate that pre-fills a
   grid line, 10–19 for showing a range only, nothing below 10 (§4.5).
2. `timeTrend` requires `minSample * 2` = **16** dated sales to report a market trend. §5.3 shows the
   requirement is in the **hundreds**. This function should almost always return null and defer to a
   public index; today it will confidently return a slope fitted to 16 points.
3. `groupDelta` accepts a group with **3** members. Three sales is a coincidence with a dollar sign
   on it — the module's own comment says so about a $/sqft rate, and the same applies here.

None of these are bugs; they were sensible placeholders. They are now measurable, so they should be
set from the measurements.

---

## 4. The adjustment-derivation goldmine

### 4.1 What we are actually sitting on

For every comparable on every report, `property_observations.adjustments` holds the appraiser's own
itemized dollar adjustments as `[{ type, description, amount }]` (extracted by
`src/lib/appraisal/extract.js`), and the same row holds both properties' attributes — the comp's, and
(via the report's subject observation) the subject's. So for every adjustment we can compute the
**attribute delta it was paid for**, and therefore the **rate**.

Per §1.3 that is **~12,500 rate observations at A=500** and **~50,000 at A=2,000** — five to nine
times the deduped-sale count, in a corpus of expert judgements in *our* markets that no data vendor
holds. CoreLogic knows a house sold for $412,000. It does not know that four appraisers rated it
C3/C3/C4/C3 and priced its GLA at $52, $60, $45 and $55 a foot.

**Prerequisite, and it is the first line of work:** this is JSONB. It must be normalized into
`observation_adjustments` rows (schema in §2.6) with `attribute_delta` and `derived_rate` computed
**at ingest**, or none of the queries below are writable. The existing design document already names
this as the highest-value follow-up; this document agrees and gives the statistics.

### 4.2 Turning an adjustment into a rate

Normalize each line to a unit that is comparable across properties. The choice of denominator is the
whole game:

| Line | Rate | Denominator floor (below it, discard — division by near-zero) |
|---|---|---|
| Gross living area | `amount / (GLA_subj − GLA_comp)` → **$/sqft** | \|ΔGLA\| ≥ **50 sqft** |
| Room count / baths | `amount / Δbaths` → **$/bath** (half = 0.5) | \|Δ\| ≥ **0.5** |
| Garage | `amount / Δspaces` → **$/space** | \|Δ\| ≥ **1** |
| Site / lot | `amount / Δsqft` → **$/sqft of land**, and note the marginal value *declines* — never fit a line through a 20-acre comp and a 0.3-acre subject | \|Δ\| ≥ **500 sqft** |
| Actual age | `amount / Δyears` | \|Δ\| ≥ **3 years** |
| **Condition / Quality** | `amount / (rank_comp − rank_subj) / SalePrice` → **% of price per grade** | \|Δrank\| ≥ **1** |
| **View / Location** | `amount / SalePrice` → **% of price** (no physical unit exists) | — |
| Date of sale / time | `amount / (P_cash × months)` → **%/month** | months ≥ **2** |
| Concessions | not a rate — should equal `−concession_amount` **dollar for dollar** | — |

**Two denominators, deliberately.** GLA, baths, garage and site scale with a *physical* quantity, so
the rate is dollars per unit. Condition, quality, view and location scale with the *property's
value* — a $10,000 condition adjustment means something completely different on a $200k house and an
$800k house — so those must be normalized by the sale price or the resulting "rate" is just a proxy
for the market's price level. Getting this backwards is the most common way an adjustment library
produces numbers that look fine in one town and are absurd in the next.

The industry conventions (from the survey's §2.5) give the plausibility bands the outlier logic
should use: GLA at 20–40% of the market's overall $/sqft, full bath $3,000–$10,000, garage
$3,000–$8,000 per space, **condition 2–6% of value per C-grade step**, quality 3–8% per Q-grade step,
finished basement at 30–50% of the above-grade rate.

### 4.3 Two estimators, and when each is right

**Median of ratios** — `m = median{ r_i }`. Robust to the fat tails that division by a small delta
guarantees. This is the standard mass-appraisal estimator and it is what appraisers already do by
hand, which matters for defensibility. Its confidence interval is **distribution-free**, from the
order statistics: for `n` sorted ratios, the interval `[ r_(k) , r_(n+1−k) ]` has at least 95%
coverage with

```
k  =  floor( n/2  −  0.98 · √n )        (the normal approximation to the binomial order-statistic CI)
```

For n=30 that is k=3, i.e. the 3rd and 28th values — a wide interval, honestly reported, which is the
point.

**Robust regression through the origin** — `A_i = β · Δ_i + ε_i`, **no intercept**, because a zero
attribute difference must imply a zero adjustment. Fit by **Theil–Sen** (β̂ = median of all pairwise
slopes) or Huber, never plain OLS: a handful of transcription errors will otherwise own the estimate.

**When to use which — this matters and is usually got wrong.** Median-of-ratios weights a 25-sqft
difference exactly as heavily as an 800-sqft difference, which is backwards: the large-delta
observation carries far more information about the rate. Regression through the origin weights by
`Δ²`, which is correct. So:

> **Report the median of ratios** (it is what a reviewer and an appraiser will recognize, and it is
> the honest description of *what our appraisers are doing*).
> **Pre-fill the grid line from the robust regression** (it is the better estimate of the rate).
> Show both. When they diverge by more than ~25%, the sample has a delta-size problem and the rate
> should not pre-fill anything.

### 4.4 Outlier handling, in order

**Step 1 — hard exclusions, which are not statistics.**

- Delta below the floor in the §4.2 table.
- **A zero adjustment with a non-zero delta is a FACT, not a missing value.** The appraiser looked at
  a 300-sqft difference and chose not to adjust. Its rate is **$0**, and it belongs in the sample.
  Dropping these — the natural implementation, since a zero amount looks like no data — **biases every
  rate upward**, systematically, in every market. This is the most damaging single mistake available
  in this section and it should be a named test.
- **Wrong-direction rows** (a comp larger than the subject receiving a *positive* GLA adjustment) are
  **flagged, never silently dropped.** They are the highest-value QC signal we have (§4.6) and they
  must not be excluded from the sample and then be unavailable to the flag.
- Concession lines that do not equal the recorded concession: flag as a parse or a report error.

**Step 2 — robust scale.** Use the modified z-score, not mean ± 3 SD (the mean and SD are themselves
destroyed by the outliers you are trying to find):

```
MAD  = median( | r_i − median(r) | )
z_i  = 0.6745 · ( r_i − median(r) ) / MAD          exclude |z_i| > 3.5   (Iglewicz–Hoaglin)
```

**Step 3 — plausibility gate** against the §4.2 convention bands. A GLA rate of $400/sqft in a market
whose overall $/sqft is $180 is not an outlier to be trimmed, it is a parse error to be investigated.

**Step 4 — the meta-rule.** If more than ~10% of a cell is being excluded, **the segment is wrong,
not the data**. Widen the geography or split the property type; do not keep trimming.

### 4.5 Sample floors, per-market and per-appraiser effects

**The concentration problem.** A pooled median over a county where one appraiser wrote 40% of the
reports is not a market rate — **it is that appraiser's habit, with a county name on it.** Formally
the data is hierarchical:

```
r_ija  =  μ_market(j)  +  a_appraiser(a)  +  ε_ija
```

Two fixes, in increasing cost:

1. **Appraiser-balanced median (do this — it is three lines of SQL).** Take the median per appraiser
   first, then the median of the appraiser medians. One appraiser, one vote.
   ```sql
   SELECT market_key, line_code,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY appraiser_median) AS balanced_rate
   FROM ( SELECT market_key, line_code, appraiser_id,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY derived_rate) AS appraiser_median,
                 count(*) AS n_a
            FROM observation_adjustments
           WHERE derived_rate IS NOT NULL AND NOT ('delta_below_floor' = ANY(flags))
           GROUP BY 1,2,3
          HAVING count(*) >= 3 ) t
   GROUP BY 1,2;
   ```
2. **A random-intercept mixed model.** Only worth it with **≥5 appraisers × ≥5 observations each**.
   Below that it will not identify the variance components and will report the pooled answer with a
   more impressive name.

**Report both the pooled and the appraiser-balanced figure, and flag when they differ by more than
20%.** That difference *is* the concentration warning, and it is more informative than either number.

**Sample floors** — these are the numbers to encode:

| n in cell | Distinct appraisers | What may be shown |
|---|---|---|
| < 10 | any | **Nothing.** Not a median, not a range, not a "roughly." |
| 10–19 | ≥ 2 | The **range and the count only** — "3 appraisers in Passaic County adjusted GLA between $40 and $85/sqft (n=14)." No central estimate. |
| 20–29 | ≥ 3 | Median + IQR + n, labelled **thin**. May be shown; may not pre-fill a grid line. |
| **≥ 30** | **≥ 3** | Median + IQR + order-statistic CI. **May pre-fill a grid line**, with `n` rendered beside it. Matches the IAAO floor. |
| ≥ 100 | ≥ 8 | May be the default rate without a human confirming it. |

Plus three conditions that override all of the above:

- **≥ 12 months of span** in the cell, or the rate is a snapshot of one market moment.
- **Never fewer than 3 distinct appraisers**, at any n.
- **No cell may be more than 50% one appraiser.** If it is, report the balanced figure only.

### 4.6 Detecting an appraiser whose adjustments are out of line

This is Collateral Underwriter's design, and it is the *most transferable idea in the entire industry
survey*, because it works at small n: we do not need to know the true GLA rate for Paterson, only
that this report used $18/sqft when the other 40 Paterson reports used $45–$70.

**The leave-one-out peer statistic** — the "leave-one-out" is not optional. Without it a prolific
appraiser is being compared against a peer median he himself dominates, and he will never flag.

```
peer_med  = median{ r_i : market = M, line = L, appraiser ≠ a }
peer_MAD  = median{ | r_i − peer_med| : same set }
d_a       = median{ r_i : appraiser = a, market = M, line = L }  −  peer_med
z_a       = d_a / ( 1.4826 · peer_MAD )
```

Flag `|z_a| > 2` when `n_a ≥ 10` and the peer set clears the §4.5 floor.

**Four signals that need no peer group at all** and are therefore available from report one:

1. **Wrong-direction adjustments.** Comp GLA > subject GLA with a positive GLA adjustment. Flaggable
   at n=1, unconditionally, at any sample size. This is what CU's 600-series Single Adjustment
   messages fire on: they compare "the appraiser's adjustment rates… [to] the model-derived
   adjustment rates and/or adjustment rates made by other appraisers (peers) in the same market for a
   single standardized physical characteristic," across "all UAD standardized physical
   characteristics, date of sale, location, and sale type"
   ([Fannie CU job aid — Single Adjustment Messages](https://singlefamily.fanniemae.com/job-aid/collateral-underwriter/topic/single_adjustment_messages.htm)).
2. **Grid arithmetic.** `Gross Adj% ≥ |Net Adj%|` always; `adjusted = sale + net` to the dollar. A
   violation is a parse error or a report error, never a judgement.
3. **Zero-time-adjustment rate on comps older than 90 days**, versus peers. Since Fannie's
   SEL-2024-07, "failing to make a market-derived time adjustment when the data indicates one" is an
   *unacceptable appraisal practice*
   ([Fannie SEL-2024-07](https://singlefamily.fanniemae.com/news-events/announcement-sel-2024-07-selling-guide-updates)).
   This is simultaneously a quality metric and a fair-lending metric — see §7.4.
4. **Self-contradiction across reports.** The same property described as 1,840 sqft / C3 in March and
   2,100 sqft / C4 in June. Needs exactly two observations, no statistics, and is directly what CU
   flags as a data-integrity contradiction.

**Distributional signals**, once an appraiser has ~20 reports with us:

- **Condition-rating distribution** vs. peers on comparable vintages — a chi-square or
  Kolmogorov–Smirnov on the C1..C6 histogram. UAD ratings are *absolute*, not relative (C1 = newly
  built; C2 = substantially remodelled within ~36 months; C5 = significant repairs needed), which is
  precisely what makes them comparable across appraisers
  ([Freddie Mac UAD definitions](https://sf.freddiemac.com/docs/pdf/uad-condition-quality-ratings-definitions.pdf)).
  An appraiser whose C-distribution is shifted a full grade against peers is either rating a
  different kind of property or rating differently.
- **Net/gross adjustment distribution**, reported as ours and never as a Fannie rule (§4.7).
- **Reported-GLA disagreement rate** with other reports on the same property.
- **Value-vs-contract-price distribution** — the share of reports landing exactly at contract.

**Governance, and this is not optional.** A per-appraiser scorecard is a personnel-adjacent artifact
about a licensed professional, and appraiser-independence rules (AIR) mean anything that reads as
pressure toward a value is a problem. The existing design document's rule stands and should be
restated here: **do not ship a single composite appraiser score.** Ship the specific, falsifiable
flags with the evidence attached — "this report adjusted GLA at $18/sqft; 42 reports in this county
over 18 months ranged $45–$70, median $56" — which is a fact an appraiser can answer. A number is
not.

### 4.7 What CU actually does with peer data — the reference design

Worth stating compactly because it is the specification we are copying:

- **Risk score 1–5**, 1 lowest. **999 = could not score**, typically insufficient comparable data in
  that market. The world's largest appraisal dataset declines to answer in thin markets; so should
  we, loudly.
- **20 model comps (M1–M20)** ranked by physical characteristics, location and sale date, with **sale
  price excluded from the ranking**. Practitioner rule of thumb: a report containing 3 of CU's top-5
  model comps usually scores 1–2.
- **Adjustment messages** comparing the appraiser's rate to model-derived rates *and* to peer rates in
  the same market, per standardized UAD characteristic, firing on wrong direction and on significant
  divergence.
- **Data-integrity contradictions** across reports on the same property.
- **Appraiser-level outlier behaviour** across their whole submission history.
- **Not applied:** the 15% net / 25% gross thresholds. Fannie **eliminated** those guidelines in
  December 2014 precisely because rules-based review systems turned them into hard stops and
  distorted appraiser behaviour; B4-1.3-09 today says Fannie "does not have specific limitations or
  guidelines associated with net or gross adjustments"
  ([LL-2015-02](https://singlefamily.fanniemae.com/media/15271/display),
  [B4-1.3-09](https://selling-guide.fanniemae.com/sel/b4-1.3-09/adjustments-comparable-sales)).
  We keep 15/25/10 as internal smell tests and must never label them a GSE rule — the existing
  `valuation.js` comment block already says this and it should stay.

---

## 5. Time adjustment

### 5.1 The estimand, and the two things everybody gets wrong

```
P_cash  =  P_sale  −  seller-paid concessions                 cash-equivalent price
P_time  =  P_cash  ×  ( 1 + r )^months                        compound-rate form
   or  =  P_cash  ×  Index(effective_date) / Index(contract_date)      index form (preferred)
adj_$   =  P_time  −  P_cash
```

**Wrong thing #1: using the settlement date.** Fannie's 2024–2025 guidance requires analysing each
comp between its **contract date** and the appraisal's effective date, on a minimum 12-month
look-back, with adjustments that may be positive, negative or zero and may differ per comp within one
report — effective for loans with application dates on or after **February 4, 2025** (restated by
several correspondents as appraisals dated on or after March 1, 2025)
([Fannie SEL-2024-07](https://singlefamily.fanniemae.com/news-events/announcement-sel-2024-07-selling-guide-updates),
[Market Condition Adjustments fact sheet](https://singlefamily.fanniemae.com/media/40241/display),
[PennyMac 25-07](https://corr.pennymac.com/announcements/announcement-25-07)). A 60-day escrow means
the market signal is two months older than the closing date suggests.

**We are currently on the wrong side of this, and the fix is small.** `src/lib/appraisal/extract.js`
`settledMonth()` parses the UAD date-of-sale string — which carries *both* dates, in the form
`s07/24;c05/24` — and deliberately keeps the settled month, using the contract month only as a
fallback when no settled date is present. The contract date is **in the source and discarded.**
Capturing it into `property_observations.contract_date` is a small parser change and is the single
highest-leverage line item in §9.

**Wrong thing #2: applying a percentage to the raw price.** Concessions first, then time on the
cash-equivalent price, then the physical lines. A percentage time adjustment applied to a price with
a $12,000 seller credit embedded in it over-adjusts by the credit times the rate.

Round to $500 or $1,000. A $3,847 time adjustment claims precision nobody has.

### 5.2 The internal estimator, and its standard error

The defensible small-data method is a log-linear regression of price per square foot on time, within
a stratum:

```
For a segment (CBSA × property type × GLA band × condition band):
    y_i = ln( sale_price_i / gla_i )
    t_i = months from contract_date_i to the anchor date
    Fit   y_i = a + b·t_i + ε_i      by Huber or Theil–Sen, not plain OLS
    monthly rate   r = exp(b) − 1
    annualized     = (1 + r)^12 − 1
    95% CI on r    = exp( b ± 1.96·SE(b) ) − 1
    SE(b)          = σ̂ / sqrt( Σ (t_i − t̄)² )
```

### 5.3 How many sales it actually takes — do this arithmetic before fitting anything

Sales spread roughly uniformly over `T` months give `Σ(t−t̄)² ≈ n·T²/12`. Substituting and solving for
the sample size that pins the **annual** rate to a 95% half-width of `ε`:

```
                6,642 · σ²
   n   ≈   ─────────────────────
                 ε²  ·  T²
```

where `σ` is the residual standard deviation of `ln($/sqft)` within the segment (0.20–0.30 is
realistic for a properly stratified residential segment) and `ε` and `T` are the target half-width
(decimal) and the span in months.

At σ = 0.22:

| Span `T` | ±3 points on the annual rate | ±5 points | ±10 points |
|---|---|---|---|
| 12 months | **2,478 sales** | 892 | 223 |
| 24 months | **620 sales** | 223 | 56 |
| 36 months | **276 sales** | 99 | 25 |

Compare to §1.3: at A=2,000 the *best* metro has ~2,400 deduped sales over 24 months **before**
splitting by property type and GLA band. After stratification the biggest single segment is a few
hundred. So **a ±5-point annual rate is reachable in the top metro at around A=2,000, and a ±3-point
rate is not reachable at all at any volume we can foresee.** That is the quantitative case for
borrowing a public index and blending, rather than fitting our own.

Guardrails that matter more than the model:

- **Require ≥12 months of span** before fitting (this also matches Fannie's minimum look-back).
- **Cap the derived rate** at roughly −1.5% to +2.0% per month (≈ −16% to +27% a year) without human
  sign-off. Small samples produce absurd slopes routinely.
- **Never extrapolate past the data window.** If the newest sale in the segment is five months old,
  the screen must say so.
- **Reflexivity.** Our comp prices come from appraisals; using them to derive appreciation that then
  feeds valuations is a mild echo chamber. Prefer *sale prices* (market facts) over *appraised values*
  (opinions) — our grid gives us sale prices, so this is manageable, and it is the same criticism that
  motivated FHFA's Purchase-Only index existing alongside All-Transactions.

### 5.4 The public anchors, ranked

| Source | Geography | Frequency | Notes |
|---|---|---|---|
| **FHFA HPI Purchase-Only** | ~100 metros | quarterly (metro) | Cleanest — Enterprise *purchase* mortgages only. Narrowest coverage. |
| **FHFA HPI All-Transactions** | **410 metros** | quarterly | Adds Enterprise appraisal (refi) valuations — much better coverage, slightly noisier because it embeds appraised values. |
| **FHFA HPI Expanded-Data** | 410 metros | quarterly | Adds FHA and county-recorder transactions below the loan-limit ceiling. **Best of the three for below-conforming markets, which is most of our book.** |
| **FHFA HPI ZIP5 (developmental)** | five-digit ZIP | **annual only** | Very small geographies, but annual granularity only — usable as a *level* correction between a neighbourhood and its metro, not as a quarterly trend. ([FHFA HPI datasets](https://www.fhfa.gov/data/hpi/datasets)) |
| **S&P CoreLogic Case-Shiller** | 20 metros + national | monthly | Repeat-sales, ~2-month lag, **3-month moving average** — smooths, but also *delays turning points*, which is a real problem in a fast market. Not free to redistribute. |
| **FHFA UAD Aggregate Statistics** | national → state → MSA → **county → census tract** | quarterly, 2013–2024 | Not a price index — but it publishes appraisal-record aggregates including **condition ratings, quality of construction, lot-size categories and ADU presence** by tract. That makes it a free **composition control** and a free **prior for the condition distribution** in a market where we have nothing. ([FHFA UAD](https://www.fhfa.gov/data/uad)) |
| Local median $/sqft, 12-month rolling | any | any | What most appraisers use. Cheap, current, **contaminated by mix shift** — stratify before taking any median. |

All are methods Fannie and Freddie themselves list as acceptable derivations (median sale price and
median $/sqft trends, DOM, list-to-sale ratios, absorption rates, paired sales, regression)
([Freddie market conditions resources](https://sf.freddiemac.com/docs/pdf/market-conditions-analysis-resources.pdf)).

### 5.5 The repeat-sales cross-check we get free

The URAR requires prior transfer history — 3 years for the subject, 1 year for each comparable — so
our XML contains scattered prior-sale price/date pairs. Each one paired with the current sale is a
repeat-sales observation, which is a *structurally different estimator* from the $/sqft regression:
attributes cancel, so mix shift cannot contaminate it.

The Bailey–Muth–Nourse form, with the Case–Shiller weighting that acknowledges the variance grows
with the gap between sales:

```
ln( P_2i / P_1i )  =  Σ_t δ_t · D_it  +  ε_i          D_it = +1 at the second sale's period,
                                                              −1 at the first, 0 otherwise
Case–Shiller:  Var(ε_i) = A + B·Δt_i                  estimated in a second-stage regression on the
                                                       squared first-stage residuals, then used as
                                                       weights in a third-stage refit
```

**Do not build an index from it.** With a few hundred pairs spread over 24 quarters the per-period
estimates are noise. Use it as a **single two-point check**:

```
r̂_repeat  =  median over pairs of   ln(P_2/P_1) / Δmonths
```

and alarm when `r̂_repeat` and the $/sqft slope disagree by more than ~3 percentage points annualized.
**And exclude any pair on a property we renovated** — a flip's purchase→resale pair measures the
renovation, not the market, and our book is nothing but those.

### 5.6 Credibility weighting, and the market with three sales a quarter

**The blend.**

```
r  =  Z · r_internal  +  (1 − Z) · r_public
```

Two ways to set `Z`, and they answer different questions:

**(a) Limited-fluctuation credibility (use this — it is self-consistent with §5.3).** Define
"full credibility" as the `n` at which our own estimate reaches our own precision tolerance — which
§5.3 already gives us:

```
n_full  =  6,642 σ² / ( ε² T² )              with ε = the half-width we would accept
Z       =  min( 1 , sqrt( n / n_full ) )
```

At σ=0.22, ε=0.05, T=24: `n_full = 223`. A segment with 30 sales gets `Z = √(30/223) = 0.37`. A
segment with 3 gets `Z = 0.12`. It degrades smoothly and it never lets a thin segment dominate.

**(b) Bühlmann credibility**, once we have several comparable markets to estimate the variance
components from:

```
Z  =  n / ( n + K )            K  =  σ²_within / σ²_between
```

`σ²_within` is the average within-market variance of the estimate; `σ²_between` is the variance of
the true rates *across* markets. Estimate both once there are ≥5 markets with ≥30 sales each. Until
then, `K ≈ 150` is a defensible default (it makes n=150 worth half credibility), but say that it is a
default and replace it with the estimate as soon as it is computable.

**The three-sales-a-quarter market — the concrete recipe.**

Twelve sales a year, σ=0.22, T=12. From §5.3, `Σ(t−t̄)² ≈ 12 × 144/12 = 144`, so
`SE(b) = 0.22/12 = 0.0183` per month. The 95% CI on the monthly rate is **±3.6%/month, which is
roughly ±53% a year.** The estimate is not weak; it is *uninformative*. Do not report it, do not blend
it in at any weight that matters, and do not let a screen render it.

So, in order:

1. **Widen the segment before you widen the model.** A rate from 300 county sales applied to a
   3-sale town is far better than a rate from 12 town sales. Escalate: town → county → CBSA → state
   non-metro aggregate. Stop at the first level clearing 30 sales *and* 12 months.
2. **Use the public index outright.** `Z ≈ 0.12` means the answer is the FHFA CBSA series with a
   rounding error of our own data on top. Prefer **Expanded-Data** for below-conforming markets.
3. **Use the internal data only as a direction check.** Compare the *sign*. Two consecutive quarters
   where the internal sign disagrees with the public index is a data-quality alarm — investigate the
   segment, do not override the index.
4. **Say so on the screen.** "Market trend from the FHFA All-Transactions index for
   Newark–Union NJ-PA, Q1 2026 (published with a two-month lag). We have 11 of our own sales in this
   town over the period — not enough to derive a rate."

### 5.7 The bias we must not inherit

FHFA found appraisers time-adjust **at a 67% rate in majority-white tracts versus 45% in
majority-Black tracts**, among appraisals coming in below contract price
([FHFA, *Underappraisal Disparities and Time Adjustments*](https://www.fhfa.gov/blog/insights/underappraisal-disparities-and-time-adjustments)).

Two consequences, both mandatory:

- **Never treat the appraiser's time adjustment as truth for analytics.** Always retain raw sale
  price + contract date and apply *our own* adjustment; store theirs as an observed field.
- **Our own time-adjustment application rate, broken out by tract demographics, is a fair-lending
  metric from day one** (§7.4). Since it is a published, documented mechanism, not testing for it is
  a choice we would have to defend.

---

## 6. Accuracy measurement and honesty

### 6.1 The metrics, with formulas

Let `V_i` be our estimate and `S_i` the realized sale price.

```
APE_i   = | V_i − S_i | / S_i
MdAPE   = median( APE_i )                              headline accuracy
PPE10   = share( APE_i ≤ 0.10 )                        the one users understand
PPE20   = share( APE_i ≤ 0.20 )                        the tail measure — watch this one
Bias    = median( (V_i − S_i) / S_i )                  SIGNED. Should be ≈ 0.
Hit rate= valued / submitted                            coverage. NOT accuracy.
```

**Forecast Standard Deviation (FSD)** is the industry uncertainty measure: "the AVM value's expected
proportional standard deviation around actual subsequent sales price"
([Clear Capital](https://www.clearcapital.com/resources/glossary-of-terms/fsd-forecast-standard-deviation/),
[AVMetrics](https://www.avmetrics.net/AVM_glossary/forecast-standard-deviation/)). FSD = 12% means
~68% of comparable properties should transact within ±12% of the estimate.

```
68% interval:  V × (1 ± FSD)      90%: V × (1 ± 1.645·FSD)      95%: V × (1 ± 1.96·FSD)
Confidence score (conventional):  100 − 100·FSD
```

**FSD is worthless unless it is calibrated, and calibration is a coverage test:** over a held-out
sample, does the claimed 68% band actually contain ~68% of realized prices? Everything else in this
section is arithmetic. This is the honest part.

**Borrow the assessment profession's uniformity measures too** — they are free, standardized, and
they catch failures the error metrics miss ([IAAO, *Standard on Ratio Studies*](https://www.iaao.org/wp-content/uploads/Standard_on_Ratio_Studies.pdf)):

| Measure | Meaning | Acceptable |
|---|---|---|
| **COD** — coefficient of dispersion | average % deviation from the median ratio; horizontal equity | **< 15** for improved residential (< 20 other real property) |
| **PRD** — price-related differential | mean ratio ÷ weighted mean ratio; vertical equity | **0.98 – 1.03** |
| **PRB** — price-related bias | % change in the ratio when value doubles | **−0.05 to +0.05** |

PRD/PRB are the ones that catch "we are systematically low on expensive houses and high on cheap
ones" — which is the classic failure of a model trained on a lender's own skewed book, and therefore
exactly our expected failure mode.

### 6.2 The backtest design — and the leakage trap that is specific to us

**Rolling-origin, out-of-time, always. Never a random split.**

```
for T in monthly cut dates:
    derive every rate using ONLY observations with observed_on < T AND sale_date < T
    predict every closed sale with sale_date in [T, T+90d]
        that has ≥5 eligible comps drawn entirely from before T
    record (prediction, realized, market, type, comp count, gross adj %, truth tier)
```

**The leakage trap, which is ours alone and would silently produce fabulous fake results:** the same
sale appears in many reports. A random train/test split will put report A's copy of a sale in
training and report B's copy of *the same sale* in test — you would be evaluating on training rows.
And because the market moves, a random split leaks the future into the past regardless. So:

- **Cut by date**, never at random.
- **Group by `property_id` AND by sale event**, so no property and no transaction straddles the cut.
- Deduplicate the test set to one row per sale — the "four appraisers saw this sale" replication is
  wonderful for §4 and is *quadruple counting* here.

**How much test data is needed to state an MdAPE.** The asymptotic SE of a median is
`1.2533 σ / √n`; with APE having a standard deviation of roughly 8 percentage points:

| Test n | 95% half-width on MdAPE |
|---|---|
| 50 | ±2.8 points |
| 100 | **±2.0 points** |
| 300 | ±1.1 points |
| 1,000 | ±0.6 points |

So: **n ≥ 100 before quoting a book-wide MdAPE (with the interval shown), n ≥ 300 before quoting a
market-level one.** Per §1.6, A=2,000 plausibly supplies ~1,500 backtestable comp sales — which means
we can measure our accuracy honestly well before we can build anything sophisticated, and that is the
right order.

### 6.3 The gate — thresholds a number must clear before it renders as a VALUE

Below this bar the tool must show comps and refuse to state a value. Refusal is a first-class output,
not an error — CU's 999 is the precedent.

**Per-valuation gates (all must pass):**

| # | Gate | Why |
|---|---|---|
| 1 | **≥ 5 eligible closed sales** in the envelope | 3 is the GSE floor for an *appraiser*; a machine with no site inspection needs more |
| 2 | **≥ 3 closed within 12 months**, ≥ 1 within 6 | beyond 12 months a comp is an index observation, not a comparable |
| 3 | **Bracketed on GLA and on condition** | otherwise the answer is an extrapolation, not an interpolation |
| 4 | **Median gross adjustment ≤ 25%** | our own smell test, labelled as ours, never as a Fannie rule |
| 5 | **Every pre-filled rate cleared its §4.5 floor** | a value built on an n=6 rate is an n=6 value |
| 6 | **A time adjustment was applied** from an index or a rate that cleared §5.6 | per §5.7, the missing time adjustment is where the systematic error lives |

**Per-segment gates (the model may not offer values in a market until):**

| # | Gate | Threshold |
|---|---|---|
| 7 | Out-of-time backtest observations in that market segment | **≥ 100** |
| 8 | **MdAPE** | **≤ 10%** |
| 9 | **PPE10** | **≥ 55%** |
| 10 | **PPE20** | **≥ 80%** |
| 11 | \|**Bias**\| | **≤ 2%** |
| 12 | **FSD calibration** — realized coverage of the stated 68% band | **62% – 74%** |
| 13 | **COD** | **< 15** |
| 14 | **PRD** | **0.98 – 1.03** |

**Why 10% and not 5%.** Institutional AVM benchmarks are MdAPE < 5% and PPE10 > 70%, with leaders
claiming 2.3–3%. We should not expect to hit those and must not pretend to. The honest yardstick is
that **Zillow's off-market median error is 7.49% nationally across 100M+ homes**. An internal tool on
1,375 sales claiming 4% is not accurate; it is overfit or mismeasured. Setting our internal bar at
10% with the number published is more defensible than setting it at 5% and quietly missing.

Note also that "on-market" accuracy figures are not comparable to anything: an on-market Zestimate is
conditioned on the list price, which is nearly the answer. **Any internal figure we quote must state
whether the subject was on-market at valuation time.**

### 6.4 Saying it to a non-technical user

Never a confidence percentage that is not a backtested coverage rate. Never a bare point estimate.
Never a range narrower than the backtested error — if MdAPE is 9% and the screen offers ±4%, the
screen is lying regardless of what the comps happened to do.

The shape that works:

> **Most likely $412,000**
> We would expect the real number to land between **$384,000 and $441,000** — about **7 times out
> of 10**.
> Based on **6 closed sales**, the closest **0.3 miles** away, all sold within **8 months**. We
> adjusted each one for size, condition and how the market has moved since it sold.
> On the last **340** properties we checked this way in Essex County, we were within 10% **six times
> out of ten**, and within 20% **eight and a half times out of ten**.
> *This is not an appraisal.*

Four rules behind that:

1. **The interval is the answer; the point is the middle of it.**
2. **"7 times out of 10" is a measured coverage rate, not a vibe.** If it has not been measured, the
   line does not render.
3. **Show the track record beside the estimate**, in the same units a person thinks in. This is the
   single most trust-building element available and it costs one join to the backtest ledger.
4. **Refusal reads as competence.** "We do not have enough recent sales in this town to put a number
   on it — here are the 4 sales we do have" is a better product than a number, and it is what CU
   does.

---

## 7. Regulatory and fair-lending reality

*This section is research, not legal advice. Every conclusion below should be confirmed by counsel
before it is relied on, and the two 2026 fair-lending developments in §7.3 are actively moving.*

### 7.1 The 2024 interagency AVM Quality Control Rule

Six agencies — OCC, Federal Reserve, FDIC, NCUA, CFPB and FHFA — finalized *Quality Control Standards
for Automated Valuation Models* on **July 17, 2024**, published in the Federal Register **August 7,
2024**, **effective October 1, 2025**
([CFPB rule page](https://www.consumerfinance.gov/rules-policy/final-rules/quality-control-standards-for-automated-valuation-models/),
[final rule PDF](https://files.consumerfinance.gov/f/documents/cfpb_automated-valuation-models_final-rule_2024-06.pdf),
[Federal Register](https://www.federalregister.gov/documents/2024/08/07/2024-16197/quality-control-standards-for-automated-valuation-models),
[OCC Bulletin 2024-17](https://www.occ.gov/news-issuances/bulletins/2024/bulletin-2024-17.html),
[Fed press release](https://www.federalreserve.gov/newsevents/pressreleases/bcreg20240717a.htm)).

**Who it reaches.** "Mortgage originators" (the TILA definition) and "secondary market issuers" that
use AVMs in a **credit decision** or a **covered securitization determination**.

**"Credit decision"** = a decision regarding whether and on what terms to originate, modify, terminate
or otherwise change a mortgage, including whether to extend new or additional credit or change a line
of credit's limit.

**The five standards.** Policies, practices, procedures and control systems to:

1. ensure a **high level of confidence** in the estimates;
2. **protect against the manipulation of data**;
3. seek to **avoid conflicts of interest**;
4. require **random sample testing and reviews**; and
5. **comply with applicable nondiscrimination laws**.

**It applies to in-house models.** The rule is about *use*, not procurement — a proprietary AVM we
build ourselves is squarely inside it when the coverage test is met.

**What is outside it** (each one relevant to us):

- **Portfolio monitoring** — no determination of collateral value is being made.
- **Verifying or validating a previous determination of value.**
- **Reviewing the quality of already-completed determinations of collateral value.**
- **A certified or licensed appraiser using an AVM in developing an appraisal.**

That exclusion list is close to a description of what §4 and §8 phases 1–3 actually are. **A tool
that helps our staff review an appraisal sits outside the rule. A tool that sets the ARV that sizes
the loan sits inside it — when the coverage test below is met.**

### 7.2 Are we in scope? Precisely.

**The coverage test is not the loan's purpose. It is the collateral.** The rule reaches a **mortgage
secured by a *consumer's principal dwelling*** — and it reaches that mortgage **even when the loan is
primarily for a business, commercial, agricultural or organizational purpose.** The agencies did that
deliberately: Title XI does not limit itself to consumer credit, so the business-purpose carve-out
that exempts us from TILA/RESPA **does not exist here**. "Dwelling" means a residential structure with
one to four units.

So:

| Deal shape | In scope? |
|---|---|
| Fix-and-flip on a non-owner-occupied 1–4 investment property | **No.** Not the consumer's principal dwelling. |
| DSCR rental on a tenant-occupied property | **No.** |
| Ground-up on a vacant lot the borrower does not live on | **No** (and often not a "dwelling" at the time of the decision). |
| **Borrower lives in one unit of the 2–4 they are rehabbing** | **YES.** |
| **A deal cross-collateralized with the borrower's own home** | **YES**, as to that collateral. |
| **Owner-occupied bridge / a rehab of the borrower's residence held in an LLC** | **YES** — the entity wrapper does not change where the human lives. |
| Loan to a true corporate entity with no natural-person principal dwelling anywhere in the collateral | No. |

**The correct posture is therefore: not categorically exempt — exempt deal by deal, on a fact we do
not reliably capture today.** `applications.occupancy` exists with `Primary / Investment / Secondary`,
but it describes the *subject*, it is not audited, and it says nothing about additional collateral.

**The instrumentation consequence is immediate and cheap:** record, per file, (a) whether the subject
is the principal dwelling of any natural-person borrower or guarantor, and (b) whether any additional
collateral is. Two booleans and an evidence pointer. Collect them now, not when the model ships,
because retrofitting them across the back book is the expensive version.

### 7.3 Fair lending — and the two things that moved in 2026

**ECOA / Regulation B applies to business-purpose credit.** ECOA reaches "all creditors" and the
official interpretation is explicit that it covers *commercial* credit. Reg B's *notification*
requirements are relaxed for business credit; the **anti-discrimination prohibition is not**. Our
loans to investors and their LLCs are covered.

**Change #1 — the CFPB removed disparate impact from Regulation B.** On **April 22, 2026** the CFPB
issued a final rule removing the "effects test" from Regulation B and its commentary and stating
affirmatively that ECOA does not recognize disparate-impact liability. **Effective July 21, 2026** —
so it is in force as of this writing
([Federal Register](https://www.federalregister.gov/documents/2026/04/22/2026-07804/equal-credit-opportunity-act-regulation-b),
[Greenberg Traurig](https://www.gtlaw.com/en/insights/2026/5/cfpb-final-rule-revises-ecoa-framework-narrows-disparate-impact-and-discouragement-standards),
[Norton Rose Fulbright](https://www.nortonrosefulbright.com/en-us/knowledge/publications/bcb29048/cfpb-amends-regulation-b-changing-approach-to-fair-lending)).
The same rule narrowed "discouragement" and restricted special purpose credit programs.

**Change #2 — HUD has proposed to remove its Fair Housing Act disparate-impact rule** (proposed
January 14, 2026;
[Federal Register](https://www.federalregister.gov/documents/2026/01/14/2026-00590/huds-implementation-of-the-fair-housing-acts-disparate-impact-standard)).

**Do not read either as "the exposure is gone." Three reasons.**

1. **The Fair Housing Act is a statute, and it is the one that binds us.** FHA §805 reaches
   "residential real estate-related transactions," defined to include *making or purchasing loans
   secured by residential real estate* and *the selling, brokering, or appraising of residential real
   property* — with **no consumer-purpose limitation and no owner-occupancy limitation.** Investor
   loans on 1–4 unit residential are squarely inside, and an internal valuation model is an
   *appraisal-adjacent* activity that the statute names explicitly. A HUD rulemaking does not repeal
   the statute, and the Supreme Court's recognition of disparate-impact claims under the FHA in
   *Inclusive Communities* is a judicial holding, not a regulation
   ([CRS R44203, *Disparate Impact Claims Under the Fair Housing Act*](https://www.congress.gov/crs-product/R44203);
   [CRS R48113, *The Fair Housing Act: A Legal Overview*](https://www.congress.gov/crs-product/R48113)).
2. **State law.** New York, New Jersey, Illinois, California and Massachusetts have independent fair
   lending statutes that courts and state enforcement agencies have read to permit disparate-impact
   claims in credit. **We lend in NJ and NY.** For a private lender in this footprint, state law is
   the binding constraint, not the federal rollback.
3. **The AVM rule's own standard #5 survives all of it** — "comply with applicable nondiscrimination
   laws" is a live obligation on any covered use, and it points at whatever the applicable law is at
   the time.

### 7.4 The specific exposure of *our* internal model

This is not abstract. There is a documented, published, foreseeable mechanism by which our training
data carries a demographic pattern:

- Our comps are **appraiser-selected**, and FHFA has published that appraisers apply time adjustments
  at **67% in majority-white tracts versus 45% in majority-Black tracts** among appraisals coming in
  below contract price (§5.7).
- Most historical comps carry a **$0 time adjustment that should not have been $0**, and per FHFA the
  expected adjustment averaged **2.5%–9% of sale price**.
- A model that regresses on *adjusted* prices from those reports inherits both the level error and its
  demographic pattern.

Because that mechanism is published, "we did not think to test for it" is not a position that can be
held. The remedy is cheap and it is the same one FHFA used: **test outcomes by census tract, not by
borrower.**

### 7.5 The governance and documentation to stand up

Do this whether or not a given deal is in scope, because the same artifacts answer the AVM rule, the
fair-lending question, an investor's diligence, and an examiner.

**Model risk management.** SR 11-7 is the reference framework everyone gets measured against even
outside the banking perimeter. Concretely:

1. **Model inventory + a written model card** per model: purpose, permitted uses, prohibited uses,
   inputs, method, training window, known limitations, and **the conditions under which it refuses**.
2. **Independent validation before production use**, and annual revalidation. "Independent" means not
   the person who built it.
3. **Documented out-of-time backtesting** with the §6.3 thresholds written down *in advance* and a
   documented action on breach (the honest action is "the model stops offering values in that
   segment," automatically).
4. **Change control and versioning.** Every number ever shown must be reproducible years later from a
   stored snapshot. **db/409 already does this correctly** — `subject_snapshot`, each comp's
   `snapshot`, and `market_rates` are copied in, never referenced, precisely so a saved valuation
   cannot silently change. That design decision is already compliance-grade; say so in the model card
   and do not undo it.

**Answering the five standards, specifically:**

| Standard | What satisfies it here |
|---|---|
| High level of confidence | §6.3 gates + a **calibrated** FSD, not an asserted one |
| Protect against data manipulation | Zillow's discipline: **the user edits inputs, comps and adjustments — never the output number.** Every override logged with a reason code; override distribution reported **by officer**; a value that fails the gates cannot be forced through |
| Avoid conflicts of interest | The person who selects the comps must not be the person compensated on the loan closing. Separation of duties on the valuation screen, enforced by permission, not by policy |
| Random sample testing and reviews | A scheduled random sample of valuations pulled for human review, with the result recorded; plus the rolling backtest of §6.2 |
| Nondiscrimination | §7.6 |

**Retention:** 5 years. That is the USPAP Record Keeping Rule's workfile period (or 2 years after
final disposition of any judicial proceeding, whichever is longer) and it is the sensible floor for
anything that informed a credit decision.

**Positioning, until all of the above exists:** an explicit **"internal research — not an appraisal,
not for credit decisioning"** label on every surface and every export, enforced in the product with a
permission gate, not merely written in a policy document. `valuation.js` already stamps a `DISCLAIMER`
into every result and the design document already requires every surface to render it with the
number. Keep that, and add the permission gate.

### 7.6 The fair-lending testing to run

Break every accuracy metric out by geography and report it on a schedule:

```
For each of:  census-tract minority share (quartiles),  tract median income (quartiles),
              and each market segment —

    MdAPE, PPE10, signed BIAS, refusal rate, human-override rate, and
    the share of valuations where a time adjustment was applied.
```

Notes on doing this correctly:

- **By tract, not by borrower.** We do not collect race for these loans and should not start; tract
  composition is the standard proxy and it is exactly what FHFA used in the research above.
- **The refusal rate is a fair-lending metric too**, and it is the one people forget. A model that
  silently declines to value properties in lower-income tracts — because our comp density is lower
  there — produces a disparity in *access to the product*, not in the numbers it prints. That is
  arguably the more likely failure mode for us and it is invisible unless it is measured.
- **Bias is the metric that matters most**, not MdAPE. Equal noise across tracts is a quality problem.
  Systematically *lower* values in one class of tract is the finding that ends the project.
- Set the alarm in advance: a bias gap exceeding ~2 percentage points between quartiles, or a refusal
  rate gap exceeding ~10 points, triggers a documented investigation before any further rollout.

---

## 8. The staged plan

Entry criteria are **measurable, not calendar**. Every threshold below is queryable with §1.7.

### Phase 0 — Instrument. *Entry: none. Do this now.*

The full list is §9. Nothing else in this plan can be validated without it, and every month it is
delayed is a month of un-recoverable un-labelled data.

**Exit:** `loan_outcomes` is being written on every funded loan; `observation_adjustments`,
`rehab_scope_lines` and `contract_date` are populated on ingest; the §1.7 dashboard exists; the FHFA
series are imported; refusals are logged.

### Phase 1 — Retrieval, dossier, deterministic QC. *Entry: ≥1 appraisal. **Already shipped.***

Comp search, the property dossier, grid arithmetic validation, bracketing, conflict detection.
Correctness does not depend on `n`. Nothing here can be embarrassingly wrong.

**Exit:** an underwriter can answer "have we seen this street before, and what did we see" in under
ten seconds.

### Phase 2 — Adjustment-convention library and peer flags. *Entry: a cell with n ≥ 20, ≥ 3 appraisers, ≥ 12 months.*

The §4 work. Per §1.3 the top metro clears this at roughly **A = 400–600 appraisals** for the common
line items (GLA, condition, time, concessions).

**Ship:** per-(county, line) distributions with p10/p25/median/p75/p90, `n`, span and appraiser count;
the CU-style single-adjustment flag on new reports; the four no-peer-group signals (wrong direction,
grid arithmetic, missing time adjustment, self-contradiction) which ship **immediately** at any `n`.

**Exit:** appraisal review labour measurably falls, and no statement about property value has been
made. This is the phase that pays for the project.

### Phase 3 — Time adjustment, borrowed then blended. *Entry (borrowed): none. Entry (blended): n ≥ 30 per segment with ≥ 12 months' span.*

Import FHFA All-Transactions + Expanded-Data CBSA series and the ZIP5 annual series into
`market_index`. Use them as the default immediately. Add the internal log-linear regression behind
the §5.6 credibility weight, and the repeat-sales cross-check.

**Exit:** every comp on every internal grid carries a time adjustment with a stated source, computed
from the **contract date**.

### Phase 4 — ARV. *Entry: ≥ 60 paired as-is/ARV appraisals in a market family × rehab type; ≥ 30 of them with a line-item SOW.*

Per §1.3 that is roughly **A = 500–800**. Order of build:

1. The **scope → post-rehab attribute mapper** (§2.4) — a rules table, calibrated against the
   as-repaired subject observations we already store.
2. The **ARV comp grid** (§2.3c) — `valuation.js` unchanged, `purpose='arv'`, comps drawn from the
   ARV comp set.
3. The **uplift ratio ρ̂** by market × rehab type (§2.3a) as a **cross-check on the grid**, never as
   the primary answer, shown with its interval and its `n`.

**Exit:** an ARV report that states the scope it is conditioned on, shows the renovated comps it used,
and states a range.

### Phase 5 — As-is value with a backtested range. *Entry: all of §6.3 gates 7–14 met in that market segment.*

`n ≥ 100` out-of-time backtest observations, MdAPE ≤ 10%, PPE10 ≥ 55%, PPE20 ≥ 80%, |bias| ≤ 2%,
calibrated 68% band, COD < 15, PRD 0.98–1.03.

This is the first phase in which a number renders as a **value** rather than as research. It is
per-segment: a market that clears the gates gets values; a market that does not gets comps and a
refusal, in the same product, at the same time.

### Phase 6 — Hedonic adjustment coefficients at metro level. *Entry: ≥ 300 deduped closed sales in the metro, ≥ 24 months, ≥ 100 per property-type segment.*

Per §1.3 the top metro reaches ~2,400 deduped sales over 24 months at **A ≈ 2,000**, so the
property-type segments clear around there. Output is **coefficients feeding the grid**, not a value.

### Phase 7 — Machine learning / ensemble. *Entry: two hard gates, both required.*

1. **≥ 10,000 deduped closed sales in a single metro**, ≥ 24 months of span; and
2. **a documented out-of-time win over Phase 5 of ≥ 1.5 MdAPE points, sustained across 3 consecutive
   quarterly folds**, on the same held-out data, with no leakage per §6.2.

If gate 2 fails, the answer is that we do not build it. A model that ties the grid but is harder to
explain is a net loss under §7. **And a GBT is never used for ARV** (§3c) — its inability to
extrapolate is disqualifying, not tunable.

### Phase 8 — Use in a credit decision. *Entry: everything in Phase 5, plus the §7.5 program.*

Model inventory and card; independent validation; documented backtesting with pre-agreed thresholds
and an automatic stop on breach; change control (already satisfied by db/409's snapshots); separation
of duties; the §7.6 fair-lending outcome testing running on a schedule with alarms set; the
principal-dwelling determination captured per file; the random-sample review running.

Until then the tool is advisory, labelled, and permission-gated.

### What we must never claim

- That it is an **appraisal**, or **USPAP work product**, or an **"evaluation"** under the Interagency
  Guidelines.
- A **market value**. It is an internal value indication.
- A **confidence percentage** that is not a measured, backtested coverage rate.
- A comparison to a named vendor's accuracy.
- That **15% net / 25% gross** is a Fannie rule. It has not been since December 2014.
- That **1 mile** or **90 days** are GSE requirements. They are lender overlays.
- Any **rate below its §4.5 sample floor**, in any form, including "roughly."
- An **ARV without a stated scope of work.** ARV is a function of two arguments and we must never
  print it as a function of one.
- A **value in a market that failed the §6.3 segment gates.** Refuse instead, and say why.

---

## WHAT TO DO NOW

Ten things, ordered by (value ÷ effort). Items 1–4 are the ones that, if not done today, cannot be
recovered later — they are about *capturing* data that is currently being thrown away. Everything
else can be built whenever.

**1. Create `loan_outcomes` and start writing it on every funded loan.**
This is the single highest-value item in the document and it is one table plus one form field on the
closing/servicing screen. Today there is **no record anywhere in this schema of what a property we
lent on eventually sold for.** Without it, §2.5 tier 2 is impossible, §6 can never be validated
against our own book, and the ARV model can never be told whether it was right. Every month it is
delayed is a month of exits lost forever. Back-fill what can be reconstructed from payoff letters and
closing files; mark reconstructed rows `confidence = 'inferred'`.

**2. Capture the comp's CONTRACT date. It is in the file and we are discarding it.**
`src/lib/appraisal/extract.js` `settledMonth()` parses the UAD date-of-sale string — which carries
both dates as `s07/24;c05/24` — and keeps only the settled month. Fannie's market-conditions rule
keys on the **contract** date, and every time adjustment we compute from a settled date is
systematically stale by the length of an escrow. Add `property_observations.contract_date`, parse the
`c` token, and re-run the ingest back-fill (which is already re-runnable by design). Small parser
change, largest single accuracy win available.

**3. Normalize `property_observations.adjustments` into `observation_adjustments` rows, with
`attribute_delta` and `derived_rate` computed at ingest.**
Everything in §4 — the highest-value, earliest-viable, most differentiated product in this
document — is a `GROUP BY` that JSONB cannot serve. The existing design document already names this
as the top follow-up. Compute the delta and the rate **on the way in**, while the subject's and the
comp's attributes are both in hand; recomputing them later means re-deriving the subject from a
different table on every query.

**4. Normalize the Scope of Work into `rehab_scope_lines`, and join the drawn amounts.**
The 18-category taxonomy is already fixed and already exploded per unit by `sitewire/mapper.js`, and
`draw_disbursements` already records what was actually spent per line. As rows, "what does a dollar
of kitchen buy versus a dollar of roof, in Paterson" becomes one query. As JSONB it is unanswerable
forever.

**5. Build the §1.7 dashboard and look at it before deciding anything else.**
Five queries. They replace every projected number in §1.3 with a measured one, and they tell us which
market and which property type is closest to a phase gate. *We need to know our own `n` before we
decide what phase 2 can support.*

**6. Log every refusal.**
Every time `deriveMarketRates` returns null with a reason, every time a valuation cannot find five
comps, every time a segment fails a gate — write a row: what was asked, which market, which line,
what `n` was, what floor it missed. **That log is the roadmap.** It tells us exactly which cell to go
fill, and it is the honest answer to "why doesn't it work here?"

**7. Import the FHFA series into a `market_index` table, and add a CBSA crosswalk.**
FHFA All-Transactions and Expanded-Data at CBSA (quarterly, 410 metros) and the ZIP5 developmental
series (annual). Free, published, defensible, and it makes a correct time adjustment available on
every grid **immediately, with zero internal data** — which per §3(g) is where the largest systematic
error currently sits. The crosswalk (ZIP → county → CBSA) is a static file; without it the warehouse
cannot join to any public geography, and `city` is doing a job it is bad at.

**8. Raise the sample floors in `valuation.js` to the measured/published ones.**
`minSample: 8` → 30 for a rate that pre-fills a grid line, 10–19 for range-only, nothing under 10.
`groupDelta`'s 3-per-group → the §4.5 table. `timeTrend` should defer to the public index in almost
every case rather than fitting a slope to 16 points (§5.3 says the requirement is in the hundreds).
Add the "≥3 distinct appraisers" and "no cell more than 50% one appraiser" conditions. These are
one-line changes to constants that turn three confident-but-unsupported numbers into honest refusals.

**9. Ship the four no-peer-group appraisal-review flags today.**
Wrong-direction adjustments; grid arithmetic (`gross ≥ |net|`, `adjusted = sale + net`); a $0 time
adjustment on a comp older than 90 days; the same property described differently across two reports.
Each needs `n = 1` or `n = 2`, each is deterministic, each cannot be wrong, and together they are the
CU-shaped product that pays for the warehouse — with no claim about value and therefore no exposure
under §7.

**10. Record the principal-dwelling fact on every new file, and start the fair-lending baseline.**
Two booleans (subject is a natural-person borrower's principal dwelling; any additional collateral
is) plus an evidence pointer. It is what decides whether the AVM rule reaches a deal (§7.2), it costs
nothing at intake, and back-filling it across the book later is the expensive version. At the same
time, start recording the §7.6 breakouts — even with `n` too small to interpret — so that the
baseline exists on the day someone asks for it.

---

### The one-paragraph version, for the owner

We can already find comparables better than anyone else can for our markets, because we have every
comparable our appraisers ever handed us and nobody else does. The thing worth building next is
**not** an AVM — at 500 appraisals we hold about 1,375 distinct sales, which is three orders of
magnitude below the smallest real one, and the busiest town in our busiest metro has six
single-family sales a quarter. What we hold *instead* is about 12,500 individual expert dollar
judgements in our own markets, which is a corpus nobody else has, and about 300 properties valued
twice on the same day by the same appraiser — once as-is and once after repair. Those two things
support a genuinely differentiated product now: telling an underwriter what appraisers in this county
actually pay for a square foot, a bathroom and a condition grade, catching the reports that are out of
line with their peers, and putting a defensible number on **after-repair** value, which is the number
our business actually runs on and the number every public AVM is worst at. The blocker is not
volume — it is that we are throwing away three things every day that we would need later: the exit
price of every loan we fund, the contract date of every comparable, and the shape of every scope of
work. Start capturing those this month and everything else becomes a question of time.
