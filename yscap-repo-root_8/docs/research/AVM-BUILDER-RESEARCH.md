# Build-Your-Own AVM — Research & Build Spec

**Working title of the feature:** *"How this property may be appraised"* — an internal, staff-only
comparable-sales workbench that produces an **indicated value** from comps we already own, with a
printable report.

**Date:** 2026-08-02
**Status:** research + opinionated build spec. Nothing here changes pricing, sizing, or any frozen engine.

---

## 0. What we already have (read this first)

This is not a greenfield build. Almost every input already exists in the database:

| Thing | Where it lives today |
|---|---|
| Per-report comparables, UAD grid data, itemized adjustments | `appraisal_comparables` (`db/137`, `149`, `156`, `157`, `166`) — `sale_price`, `adjusted_price`, `gla`, `sale_date`, `condition_uad`, `quality_uad`, `view_rating`, `location_rating`, `days_on_market`, `proximity`, `data_source`, `net_adjustment`, `net_adj_pct`, `gross_adj_pct`, `price_per_gla`, `below_grade_sqft`, `comp_set`, and the **full itemized `adjustments` jsonb** |
| Cross-file property warehouse | `properties` (deduped entity + roll-up facts), `property_observations` (one row per report × property, never overwritten), `property_sales` (distinct transactions), `property_photos` (`db/408`) |
| Subject properties | `applications.property_address` + `appraisals` subject block + `properties.subject_count` |
| Photos | `appraisal_photos` → `documents` bytes, linked to a property by `property_photos` |
| Provenance | `property_observations.appraisal_id` / `application_id` / `appraiser_id` / `observed_on` |
| Comp search indexes | `idx_properties_state_city`, `_zip`, `_beds`, `_gla`, `_sale_date`, `_sale_price`, `_latlng` |

Two consequences that shape everything below:

1. **We have a corpus of real appraiser adjustments, not just sales.** `appraisal_comparables.adjustments`
   (and `property_observations.adjustments`) is an itemized ledger of what licensed appraisers actually
   paid per square foot, per bath, per condition grade, *in our markets*. That is a materially better
   default source than paired-sales inference, and no consumer product (RPR, HouseCanary, Zillow) has it.
   See §3.2 — this should be our **primary** auto-suggest source.

2. **Our data is observation-shaped, not MLS-shaped.** We do not have every sale in a ZIP; we have every
   sale some appraiser chose as a comp. Coverage is sparse and non-random (comps are selected *because*
   they are similar to a subject we lent on). Every statistic derived from it must publish its sample
   size, and must go **blank with a reason** when the sample is thin. This is the single most important
   design constraint in this document.

**Hard boundary:** the output of this tool is **advisory**. It must never write `applications.as_is_value`
or `applications.arv` (those are read off the appraisal by `lib/appraisal/as-is-reader.js` and reopen
Products & Pricing via `db/071`/`db/072`), and it must never touch a frozen pricing engine. It is a
decision-support and sanity-check surface — a second opinion on an appraiser's number, and a pre-order
sanity check before we pay for an appraisal.

---

# 1. The interactive valuation UX, product by product

## 1.1 RPR — "Refine Value" and the CMA tool (NAR / Realtors Property Resource)

RPR splits the job into **two separate tools** that both end at a number, and that split is worth copying.

### (a) Refine Value — adjusting the *model*, not the comps

Starting point is the **RVM®** (Realtor Valuation Model), an AVM with an MLS overlay. The agent does not
touch comps here. The screen offers four refinement categories, entered in a wizard:

1. **Adjust basic facts** — confirm/correct bedrooms, baths, GLA, lot size, year built, garage. Correcting
   a fact re-runs the model. (Same idea as Zillow's owner edit — see §1.6.)
2. **Home improvements** — pick improvements from a catalog (kitchen remodel, roof, HVAC, bath, deck…).
   RPR prices them from regional cost data (Zonda) and applies a **depreciated** value, not cost.
   The agent does not type a dollar figure; they pick the item and RPR supplies the number.
3. **Needed improvements** — the inverse: a repair catalog whose cost is **subtracted**.
4. **Market and home conditions** — sliders/pickers for local market condition, interior condition,
   exterior condition, lot size, view, privacy.

Output: a **Refined Value** that sits alongside the RVM. The report shows both — "here is the model, here
is what the agent adjusted, here is why" — which is exactly the provenance posture we want.

### (b) CMA tool — adjusting the *comps*

1. **Search for comps** — map + criteria (radius/polygon, beds, baths, GLA band, date band, status).
2. **Select** — check comps; selected comps accumulate in a sidebar list with a running count.
3. **Adjust** — this is the notable design choice: **RPR does not use dollar line items.** Each comp gets a
   single slider rating it "better" or "worse" than the subject; each tick is ±5%, to a maximum of ±20%.
   The user may override with their own dollar value, or round the resulting comp value up/down.
4. **Reconcile** — a suggested price range plus a chosen price.
5. **Report** — the Seller's Report carries RVM, Refined Value, and Comp Analysis side by side.

**Lesson:** a ±20% percentage slider is fast and is what non-appraisers actually use, but it is
**indefensible on paper** — you cannot show a reviewer *which* difference caused the 10%. For a lender's
internal file, the URAR-style itemized dollar grid is the right primary UI. RPR's slider is worth keeping
as a *secondary* "quick mode" for a triage pass.

## 1.2 HouseCanary — Property Explorer (PEXP)

The most directly relevant commercial analogue, because it is aimed at lenders/BPO providers doing
appraisal review.

**Screen flow:**

1. **Subject** — address in, subject facts and HouseCanary Estimated Value out.
2. **Comp candidate pool** — the platform pre-selects up to **500** candidate comparables per subject using
   a proprietary, quantitatively derived **similarity score** (explicitly framed as removing human bias
   from the selection step). The pool is presented as a map + a sortable grid.
3. **Filter/sort** — distance, date, GLA, beds/baths, lot, property type; similarity score as a sort key.
4. **Select** — the user can accept the machine's comps, or select their own, or mix.
5. **Adjust** — an "Adjust" control above the grid (or clicking a comp's row) opens per-field adjustment of
   that comp's characteristics — condition, features, upgrades, and the physical fields (GLA, rooms, lot,
   pool, basement…). The platform pre-computes an adjustment for every comp against the subject across
   location, square footage, rooms, lot size, pool, basement and other fields.
6. **Recalculate** — **the headline number recomputes instantly** on every comp add/remove/adjust. The
   "Comparable Value" is the **average of the selected comps' adjusted sale prices** (adjusted off the
   comp's HouseCanary estimated value, not its raw sale price).
7. **Output** — a value report / export used for appraisal review and BPO QC.

**Lessons worth stealing, in priority order:**

- **Pre-select a large candidate pool with a similarity score, then let the human cut it down.** Do not make
  the user build a search from scratch — that is the step that kills adoption.
- **Recalculate the indicated value live on every interaction.** The feedback loop is the product.
- **Pre-fill an adjustment for every comp, every line.** A blank grid is a dead product. (But see §3 —
  where we can't derive a number, we must show a blank *and say why*, not a zero.)
- Their "average of adjusted prices" reconciliation is the weakest part of the design; see §4.

## 1.3 Clear Capital — BPO / ClearVal

Clear Capital's residential BPO is positioned as "the alternative to an appraisal for servicing,
origination and investments." The product is a **broker-completed form** plus a **machine QC layer**, and
the QC layer is the interesting half:

- The broker completes a structured form: subject block, condition/repair items, **three closed sale comps
  and three active/pending listing comps** (the BPO convention — listings bracket the top of the range),
  per-comp adjustment lines, an as-is value, an as-repaired value, and a 30-day/quick-sale value.
- Every submitted report is run through **analytics-based rulesets that score valuation accuracy and
  comparable-selection risk**, and is then reviewed by staff analysts before delivery.
- Commercial variant delivers "intuitive, easy-to-read forms."

**Lessons:**

- **Closed comps and listings are different populations and must be kept in separate blocks.** Our own
  `appraisal_comparables.sale_status` (`closed` / `active` / `pending`, `db/157`) already encodes this and
  the codebase already refuses to count a listing as a settled comp. The AVM builder must inherit that:
  listings inform the *range*, never the *indicated value*.
- **The value of the product is the ruleset, not the form.** A form anyone can fill in is worthless; a form
  that tells you "your comp #3 is 1.4 miles out in a market where 80% of comps are inside 0.5 miles" is a
  review tool. Our warnings engine (§4.4) is the equivalent, and it should be the thing we invest in.
- **Multiple value conclusions on one grid** (as-is / as-repaired / 30-day) is normal in this product class
  and matches our existing As-Is vs ARV comp split (`lib/appraisal/comp-grid.js`).

## 1.4 MLS "CMA wizard" flows

All three major MLS platforms use the same wizard skeleton. The differences are in the adjustment screen.

### Matrix (ICE/CoreLogic)

Tabs across the top, worked left to right:

1. **Start** — pick a contact, name the CMA.
2. **Pages** — a tree of available report sections (`+` to expand); check which pages to include. This is
   the report *builder*, decided up front.
3. **Cover page** — agent info + photo (with "Set as Default"), seller contact, subject photo upload.
4. **Subject** — subject property facts, typed or pulled from a listing/tax record.
5. **Comparables** — comps already checked before entering the wizard are pre-loaded; add more, delete
   any; `Add Selected` from a search result set.
6. **Adjustments** — **defaults to "Single Line Mode"**: you set a value for one *feature* (e.g. "a
   fireplace is worth $3,000") and **every comp adjusts automatically** by that feature's delta against the
   subject. You can switch to per-comp mode for individual overrides.
7. **Print/View** — `View CMA` renders the PDF.

### Paragon (ICE)

Step 3 is explicitly "**Adjustments**", framed to the user as: *remove, as much as possible, the
differences between the subject and the comparables.* Notable ergonomics that were added over time because
users needed them:

- **Copy an adjustment forward/backward** to subsequent/previous comparables ("Copy" buttons on the
  adjustment row, with direction).
- **Prev Comp / Next Comp** buttons distinct from the wizard's own Back/Next (they were relabelled because
  users kept blowing out of the wizard by mistake — a real UX finding worth remembering).

### Flexmls

Tabs: **Comps → Adjustments → Summary → Recommendation → Finish**.

- Adjustments are **dollar amounts per field per comp** — the canonical example in their help is: a bedroom
  is worth $2,000, the subject has one more bedroom than the comp, so the comp gets **+$2,000**.
- **Auto-adjust**: configure a per-field rate ("one story = $30,000 in this market") and hit
  `Auto-Adjust Comparables` to apply it to every comp at once.
- **Summary** shows a table of **low / high / average / median** of the *adjusted* prices.
- **Recommended price = the average adjusted price of the closed comps** included in the CMA.

**Lessons:**

- **Single-line / auto-adjust mode is the ergonomic breakthrough.** The user thinks in *rates*
  ("$85/sqft, $7,500 a bath"), not in 3 comps × 12 lines = 36 individual dollar boxes. Set the rate once,
  every comp computes. Per-comp override stays available. **This is the interaction model to build.**
- **The direction convention must be enforced by the software, not by the user.** Adjust the *comp toward
  the subject*: comp is inferior → **+**; comp is superior → **−**. Every one of these products computes
  the sign from `subject_value − comp_value` times the rate. Hand-typed signs are the #1 source of garbage
  grids.
- Flexmls's "recommended price = plain average of adjusted closed comps" is, again, too naive (§4).

## 1.5 Zillow — owner "edit facts / update home"

- The owner must first **claim** the home (verification step), and can only edit while the home is **not
  currently for sale**.
- Editable: home type, bedrooms, bathrooms, finished square feet, and other basic facts.
- Since 2015 the **Zestimate updates immediately** on save — previously it took weeks. Zillow's own framing:
  the algorithm can never know as much about a property as its owner, so let the owner correct the inputs
  and reflect it in real time.
- Owner-updated facts are marked as owner-provided in the record.

**Lessons:**

- **Correcting the subject's facts is a first-class action, separate from picking comps.** Our subject facts
  come from an appraisal or the loan file and are often stale or wrong (a converted basement, an added
  bath). The tool must let a staffer override subject facts *for this valuation only* without writing back
  to the file.
- **Instant recompute on fact edit** is table stakes.
- **Provenance flag on every overridden fact** — "as filed" vs "staff-corrected" — is what keeps the report
  defensible.

## 1.6 Redfin — agent CMA tool

- Built directly on the **Redfin Estimate** algorithm; the tool **auto-suggests comparables** and the agent
  can accept them or add their own.
- Incorporates **real-time demand data** (how many Redfin buyers are actively searching for a home like
  this) alongside the comps — a market-temperature signal, not an adjustment.
- Mobile-first: an agent builds the CMA on a phone right after a walkthrough.
- **The agents' comp selections feed back into the model** — as agents pick comps, the suggestion engine
  learns and refines future suggestions.
- Redfin deliberately **scrapped the consumer-facing version** and kept it agent-only.

**Lessons:**

- **Log every accept/reject of a suggested comp.** It is free training data for the similarity ranker, and
  it is also an audit trail of *what the staffer looked at and didn't use* — which is exactly what a
  reviewer asks about six months later.
- Keep it staff-only. A borrower-facing "what your property is worth" surface is a different product with a
  different liability profile.

## 1.7 Appraiser desktop software — the grid itself (ClickFORMS, TOTAL, ACI)

These are form-fillers, not valuation engines, and their grid *is* the Fannie Mae **URAR Form 1004** sales
comparison grid. That grid is the canonical column list and is what our report must look like.

**How they work:**

- **MLS/comp import wizards** populate the sales and listing grids directly from an MLS feed or the
  appraiser's own comp database (ClickFORMS's *MLS Import Wizard* maps and normalizes MLS fields into grid
  lines; the mapping is user-customizable to enforce house standards).
- **A local comp database** accumulates every comp the appraiser has ever used, with photos, so a comp used
  last month is one click away this month. (**We already have this** — `properties` + `property_observations`
  + `property_photos` from `db/408`. That is the single biggest head start we have.)
- Adjustments are typed **per line, per comp, in dollars**, with a `DESCRIPTION` column next to each
  `+(-) $ Adjustment` column. The software computes net adjustment, net adj %, gross adj %, and adjusted
  sale price automatically. Nothing is auto-filled with a market rate — the appraiser supplies the rate and
  must be able to support it.
- Add-on analysis modules (e.g. Bradford's *Sensitivity Analysis* / *Forecast (Inferential) Analysis*,
  regression tooling) exist precisely because deriving the rate is the hard part, and it is a separate
  step from filling in the grid.

### The URAR 1004 sales comparison grid — exact line list

This is the column/row structure to mirror. Columns: `FEATURE | SUBJECT | COMPARABLE SALE #1 | #2 | #3`
(each comp column is itself two sub-columns: `DESCRIPTION` and `+(-) $ Adjustment`).

**Header rows (no adjustment):**
- Address
- Proximity to Subject
- Sale Price
- Sale Price / Gross Living Area (i.e. $/sqft)
- Data Source(s)
- Verification Source(s)

**VALUE ADJUSTMENTS (each has DESCRIPTION + $ adjustment):**
1. Sales or Financing Concessions
2. Date of Sale / Time
3. Location
4. Leasehold / Fee Simple
5. Site
6. View
7. Design (Style)
8. Quality of Construction
9. Actual Age
10. Condition
11. Above Grade Room Count — Total / Bdrms / Baths
12. Gross Living Area (sq ft)
13. Basement & Finished Rooms Below Grade
14. Functional Utility
15. Heating / Cooling
16. Energy Efficient Items
17. Garage / Carport
18. Porch / Patio / Deck
19–21. *(blank user-defined lines — fireplace, pool, solar, ADU, etc.)*

**Footer rows (computed):**
- Net Adjustment (Total) — `+` / `−` and $
- Adjusted Sale Price of Comparables — with **Net Adj. %** and **Gross Adj. %**

**Below the grid:**
- Prior sale/transfer history of the subject (3 years) and each comparable (1 year)
- Analysis of prior sale/transfer history
- Summary of Sales Comparison Approach (free narrative)
- **Indicated Value by Sales Comparison Approach: $______**

## 1.8 Cross-product synthesis — the design we should copy

| Design question | The answer the market converged on |
|---|---|
| Where does comp selection start? | A **pre-ranked candidate pool** (HouseCanary similarity score, Redfin auto-suggest), not an empty search form |
| How are adjustments entered? | **Rate-per-feature set once, applied to every comp** (Matrix single-line, Flexmls auto-adjust), with per-comp per-line override |
| Who computes the sign? | **The software**, from `subject − comp`. Never the user |
| When does the value update? | **On every keystroke/selection** |
| What are the pre-fills? | Everything the platform can defend; a blank where it can't |
| What does reconciliation look like? | A **stats table** (low/high/avg/median of adjusted prices) + a chosen value + a narrative box |
| What is the output? | A **paginated PDF** with a cover page, subject block, side-by-side grid, photos, map, and the analyst's narrative |
| Who is it for? | **Staff only** (Redfin's explicit lesson) |

---

# 2. The adjustment grid as a data model

## 2.1 The central question: snapshot or reference?

**Snapshot. Copy everything into the valuation. This is not close.**

Reasons, specific to our stack:

1. **Our warehouse is a live roll-up that changes under you.** `properties` is explicitly documented as
   *"a ROLL-UP: the best-known current answer for each fact, always sourced from the most recent report
   that stated it"* (`db/408`). The moment a new appraisal lands naming 42 Oak St as a comp, `properties.gla`
   / `condition_uad` / `last_sale_price` can all move. A valuation that references `properties.id` would
   silently re-render with different facts than the ones the analyst looked at, and the math on the printed
   PDF would no longer reproduce. That is a disqualifying defect for a document we put in a loan file.
2. **`property_observations` is append-only and is the honest source** — *"what THAT appraiser said about
   that property on that date. Never overwritten, never merged."* So the correct reference is not the
   property but **the observation**. Even so, the observation can be superseded by a re-import of its parent
   appraisal (`appraisals` has a `superseded` flag and a one-current index, `db/188`), and cascades exist
   (`ON DELETE CASCADE` from `appraisals` → `property_observations`). A valuation must survive the deletion
   or re-import of the appraisal a comp came from.
3. **Legal/defensibility.** The report says "this is what we knew, on this date, from these sources." A
   snapshot *is* that statement. A reference is a promise you cannot keep.
4. **The repo already works this way.** `product_registrations` snapshots `term_options` and the priced
   quote; `loan_exceptions.deal_snapshot` freezes the deal at request time and surfaces `dealDrift`
   advisorily rather than voiding anything; `underwriting_runs` freeze a `source_hash`. Follow the house
   pattern.

**Therefore:** copy the facts, **and also keep the FK** (`property_id`, `observation_id`, `appraisal_id`,
`application_id`) as *lineage*, so the report can say "Comp #2 came from the appraisal on file YSCAP…,
prepared by John Q. Appraiser, effective 2026-03-14" and so we can compute drift ("this comp's facts have
since changed") as an **advisory**, never as an auto-invalidate — exactly the `dealDrift` doctrine.

Same rule for the **subject**: copy the subject snapshot into the valuation, including any staff
corrections, with a `source` marker per field (`appraisal` / `file` / `warehouse` / `staff_override`).

## 2.2 Versioning: re-open and re-run without losing the previous one

Two competing needs: (a) an analyst wants to tweak and re-print without minting garbage versions;
(b) a printed report must be reproducible forever.

**Model: a chain of immutable versions with exactly one current.**

- `avm_valuations` rows are **versions**. `chain_id` groups them; `version` is a monotonic int within the
  chain; `superseded boolean` + a **partial unique index** `WHERE superseded = false` guarantees one
  current version per chain — the same mechanism as `db/188_appraisals_one_current.sql` and
  `product_registrations`' one-current-per-file index.
- **Draft vs issued.** A version has `status ∈ draft | issued | archived`. While `draft`, edits mutate the
  row in place (no version churn — this is the autosave case, and the repo has been bitten by
  version-per-keystroke before: the SharePoint "Version 47" incident). **Issuing** (generating the PDF)
  freezes the row: `status='issued'`, `issued_at`, `issued_by`, `inputs_hash`, and the rendered document id.
  Any edit to an `issued` version **forks a new draft version** in the same chain.
- `inputs_hash` = a stable hash over (subject snapshot ‖ ordered comp snapshots ‖ ordered adjustments ‖
  weights ‖ reconciliation method). Re-issuing with an unchanged hash **returns the existing version**
  rather than minting a new one — the `maybeRunWholeLoan(..., {skipIfUnchanged:true})` pattern already in
  the codebase.
- Nothing is ever deleted. "Delete" is `status='archived'` + `superseded=true`.
- **`created_by` / `issued_by` are staff ids**, and every issue writes an `audit_log` row.

## 2.3 Adjustments: normalized rows, not a jsonb blob

`appraisal_comparables.adjustments` is jsonb because it is a faithful copy of whatever the appraiser's XML
said. **Ours should not be.** Normalized rows because:

- We want to *query across valuations*: "what has the desk been paying per bath in Passaic County?"
  That query is the feedback loop that makes the auto-suggest better over time (Redfin's lesson).
- We want per-line provenance: was this number auto-suggested, accepted, or hand-typed? A jsonb blob makes
  that a per-key convention nobody enforces.
- The line set is a **fixed catalog** (the URAR lines + user-defined extras), not an open shape.

One `avm_valuation_adjustments` row per (comp × line). ~3–8 comps × ~20 lines = 60–160 rows per valuation.
That is nothing.

## 2.4 The line catalog

Codes are stable identifiers; labels are display. Fixed set mirroring the URAR grid, plus our own:

```
concessions        Sales or Financing Concessions
sale_date          Date of Sale / Time (market conditions)
location           Location
leasehold          Leasehold / Fee Simple
site               Site (lot size)
view               View
design             Design (Style)
quality            Quality of Construction (UAD Q1–Q6)
age                Actual Age
condition          Condition (UAD C1–C6)
room_count         Above Grade Room Count
beds               Bedrooms
baths_full         Full Bathrooms
baths_half         Half Bathrooms
gla                Gross Living Area
below_grade        Basement & Finished Rooms Below Grade
functional         Functional Utility
hvac               Heating / Cooling
energy             Energy Efficient Items
garage             Garage / Carport
porch              Porch / Patio / Deck
units              Unit Count            (ours — 2–4 family is our bread and butter)
rent               Market Rent / GRM     (ours — Fix & Hold / DSCR files)
other_1..other_5   User-defined
```

Each adjustment row carries **both** the descriptive values (`subject_desc`, `comp_desc` — what prints in
the grid's DESCRIPTION cells) **and** the numeric delta and rate when one exists, so the math is
reconstructable from the row alone.

## 2.5 Weights

Two modes, stored on the valuation:

- `weighting_method ∈ equal | gross_adj_inverse | similarity | manual`
- Per-comp `weight numeric` — **always materialized**, even for computed methods, so the printed report's
  arithmetic is reproducible from stored data without re-running the weighting function.

## 2.6 Full logical model

```
avm_valuations              1 ─┬─ n avm_valuation_comps ─── n avm_valuation_adjustments
(chain_id, version)            │
                               └─ n avm_valuation_warnings   (materialized at issue time)

avm_adjustment_bases        (derived market rates, cached, with sample size + method + provenance)
avm_valuation_events        (append-only: comp suggested/accepted/rejected, line edited, issued)
```

---

# 3. Auto-suggested adjustments

**Governing rule, non-negotiable, and it is the same rule as everything else in this codebase:
we never fabricate a number.** Every suggested rate is one of:

```js
{ value: 92.5, unit: '$/sqft', method: 'appraiser_lines', n: 41, appraisers: 7,
  spread: 0.31, market: 'zip:07501', window_months: 18, confidence: 'good' }
```

or

```js
{ value: null, reason: 'insufficient_sample',
  detail: 'Only 2 usable paired sales in ZIP 07501 in the last 24 months (need 5). '
        + 'Widen the market or enter a rate you can support.' }
```

The UI renders the second as an **empty box with the reason underneath**, never a `0`, never a greyed
placeholder that looks like a value. A zero adjustment is a *decision*; a blank is *no data*. They must
look different on screen and print differently on the report.

## 3.1 The market segment (the denominator for everything below)

Define a segment ladder and walk it outward until a sample qualifies, recording which rung was used:

```
L0  same ZIP + same property category + GLA within ±25%          (tightest)
L1  same ZIP + same property category
L2  same city + same property category
L3  same county + same property category
L4  same state + same property category                          (loosest — flag as weak)
```

Property category comes from `properties.property_category` / `derivePropertyCategory` (single-family /
Multi 2–4 / Multi 5+ / condo / townhouse-PUD) — **never** the attachment style. Mixing a 1004 single-family
with a 1025 duplex in one rate derivation is invalid; the repo already learned this lesson
(`db/405`, `property-category.js`).

Time window: **18 months**, extendable to 24 with a flag. Older sales require a time adjustment that is
itself derived from the same thin data — compounding uncertainty.

Any rate derived at **L3 or looser must be labelled "market-wide, not local"** on the report.

## 3.2 PRIMARY SOURCE — mine the appraisers' own adjustment lines

**This is our differentiator and should be built first.** We hold thousands of itemized adjustments made by
licensed appraisers on real properties in our markets. Deriving a rate from them is *revealed appraiser
practice*, and the resulting report sentence is genuinely defensible:

> *"$88/sqft — the median GLA adjustment rate implicit in 41 comparable grid lines from 12 appraisal
> reports by 7 different appraisers in Passaic County over the last 18 months."*

**Derivation (GLA shown; identical shape for every line):**

For each observation `o` in the segment where the appraiser recorded a GLA adjustment:

```
Δgla_o   = subject_gla(o.appraisal) − o.gla            (sqft, signed)
adj_o    = the 'gla' entry in o.adjustments            (dollars, signed)
rate_o   = adj_o / Δgla_o                              (only when |Δgla_o| ≥ 50 sqft)
```

Filters (each one is a real failure mode, keep them all):

- Drop `|Δgla_o| < 50` — dividing by a tiny denominator explodes the rate.
- Drop `adj_o == 0` when `|Δgla_o| ≥ 100` — the appraiser declined to adjust; that is a *judgement*, not a
  rate of $0. **Record the count of declines separately** and surface it: "7 of 48 appraisers made no GLA
  adjustment despite a 100+ sqft difference."
- Drop rows where `sign(adj_o) ≠ sign(Δgla_o)` — a sign error in the source or in our parse.
- Drop `rate_o` outside `[0.10 × mppsf, 0.90 × mppsf]` where `mppsf` is the segment's median
  `price_per_gla`. A GLA adjustment is a *fraction* of total $/sqft (land and site don't scale with GLA);
  a rate at or above full $/sqft is a parse error, and one near zero is a decline mis-parsed.
- **Cap the influence of any one appraiser**: if a single `appraiser_id` supplies more than 40% of the
  observations, we are measuring that person's habit, not the market — flag `confidence: 'weak'`.

Then:

```
rate = median(rate_o)
IQR  = p75 − p25
spread = IQR / median
```

**Sufficiency gate:**

| Condition | Result |
|---|---|
| `n ≥ 12` and `distinct appraisers ≥ 4` and `spread ≤ 0.50` | `confidence: 'good'` — pre-fill |
| `n ≥ 6` and `distinct appraisers ≥ 3` and `spread ≤ 0.80` | `confidence: 'fair'` — pre-fill, badge it |
| anything else | **`value: null`**, fall through to §3.3 |

## 3.3 SECONDARY SOURCE — paired sales from `property_sales`

Classic matched-pair analysis, the textbook method: find two sales as identical as possible except for one
variable, and the price difference *is* the market's price for that variable.

**GLA pairing rule.** For every pair `(a, b)` of closed sales in the segment:

```
same ZIP
same property_category
|sale_date_a − sale_date_b| ≤ 6 months     (or time-adjust both to a common date first — see §3.5)
beds_a == beds_b
|baths_a − baths_b| ≤ 0.5
condition_uad_a == condition_uad_b   (or both null)
quality_uad_a == quality_uad_b       (or both null)
|Δgla| between 100 and 800 sqft
Δgla / min(gla) between 0.05 and 0.40
sale_type both arms-length (exclude REOSale, EstateSale, Listing)
concessions: both null/zero, or both netted out first
```

```
rate_ab = (P_a − P_b) / (gla_a − gla_b)
rate    = median over all qualifying pairs
```

**Sufficiency:** `pairs ≥ 5` **and** `spread = IQR/median ≤ 0.60` **and** the median lands inside the
`[0.10, 0.90] × mppsf` band. Otherwise → §3.4.

**Bath.** Same skeleton with the roles swapped:

```
match: same ZIP, same category, same beds, |Δgla| / gla ≤ 0.05, same condition, same quality,
       sale dates within 6 months
vary:  Δbaths ∈ {0.5, 1.0, 1.5, 2.0}
rate_full = median( (P_a − P_b) / Δbaths )
```
Sanity band: a full bath should land between **2% and 8% of the segment's median sale price**. Outside →
blank. Half bath: derive separately if `n ≥ 5`, else `0.5 × rate_full` **labelled as an assumption**, not
as derived. Sufficiency: `pairs ≥ 5`.

**Bedroom — read this before building it.**

Bedrooms and GLA are strongly collinear: an extra bedroom almost always comes with extra square footage, so
a naive paired-sale bedroom rate is mostly re-measuring GLA and will **double-count** against the GLA line.
The only valid pairing holds GLA effectively constant:

```
match: same ZIP, same category, |Δgla| / gla ≤ 0.03, same baths, same condition, same quality
vary:  Δbeds = ±1
```

That is the *same square footage carved into a different number of rooms*, which is what a bedroom
adjustment actually measures (utility, not size). **This sample will almost never qualify in our data.**
That is the correct outcome, and it matches appraisal practice: many appraisers deliberately make no
separate bedroom adjustment when they have already adjusted GLA. So:

- Default `beds` line to **blank**, with the honest reason:
  *"No bedroom-count adjustment was derived. Only 1 same-size pair differing in bedroom count was found in
  this market (need 5). Note that the GLA adjustment already captures most of the size difference —
  adjusting bedrooms as well often double-counts."*
- Never auto-fill a bedroom rate from a rate-per-bedroom of total price. That number is meaningless.

**Condition (C1–C6) and Quality (Q1–Q6).**

These are ordinal, and the right unit is a **percentage of value**, not a flat dollar amount — the gap
between a C3 and a C4 house is worth more on a $700k property than on a $250k one.

```
For each grade g, compute the segment's median price-per-sqft among sales with condition_uad = g,
controlling for size by restricting to a GLA band (the subject's GLA ±25%).

  mppsf(C3) = median(price_per_gla | condition = 'C3')
  mppsf(C4) = median(price_per_gla | condition = 'C4')

  pct_delta(C3→C4) = mppsf(C3)/mppsf(C4) − 1

Adjustment applied to a C4 comp for a C3 subject:
  adj = comp_sale_price × pct_delta(C3→C4)
```

**Sufficiency and sanity:**

- `n ≥ 8` closed sales in **each** of the two grades being compared, from **≥ 3 distinct appraisals**.
- **Monotonicity check across the whole ladder**: `mppsf(C1) ≥ mppsf(C2) ≥ … ≥ mppsf(C6)`. If the two
  grades in question are out of order (C4 pricing above C3), the sample is noise → **blank**, with the
  reason stated. Do not "fix" it by taking an absolute value.
- Cap: a single-grade condition step above **12%** or below **1%** is implausible → blank with reason.
- Same procedure for Q1–Q6, derived independently. **Never share a rate between condition and quality** —
  they are different UAD dimensions and the codebase already keeps them separate.

**View / Location.** UAD gives us three ordinal levels (Beneficial / Neutral / Adverse) in
`view_rating` / `location_rating`. Same percentage-of-value method, but the sample almost never supports it
(Adverse is rare). Expect blanks. That is fine — these are judgement lines and appraisers treat them as
such.

**Site, garage, porch, basement.** Same paired-sale skeleton; expect blanks in most segments. Below-grade
area is worth attempting because we have `below_grade_sqft` and `below_grade_finished_sqft` on both sides;
the market convention is that finished basement area is worth **25–50% of above-grade $/sqft**, so use that
as the sanity band and blank anything outside it.

## 3.4 TERTIARY SOURCE — bounded hedonic regression

Only when both §3.2 and §3.3 fail, and only as a **suggestion with a loud "modelled" badge**.

```
Model:  ln(P_i) = β0 + β1·GLA_i + β2·baths_i + β3·age_i + Σ β_c·condition_dummy + Σ β_z·zip_dummy + ε
Then:   $/sqft ≈ β1 × P̄      (semi-log: β1 is the fractional price change per sqft)
```

Implementable in plain JS via normal equations (`(XᵀX)⁻¹Xᵀy`) with a small Gauss-Jordan inverse — no new
dependency. Compute the coefficient standard errors from `σ²(XᵀX)⁻¹` so we can gate on significance.

**Sufficiency:**

| Condition | Result |
|---|---|
| `n ≥ 30` observations and `n ≥ 10 × (number of parameters)` | eligible |
| `R² ≥ 0.55` | eligible |
| `|β1 / SE(β1)| ≥ 2` (t-stat) | eligible |
| resulting `$/sqft` inside `[0.10, 0.90] × mppsf` | eligible |
| anything else | **blank**, reason: `"Not enough sales to model this market reliably (n=17, need 30)."` |

Never present a regression output as the headline value (§4.3).

## 3.5 Time / market-conditions adjustment

This one is different: **the GSEs now effectively require it**, and it is the adjustment most often missing
from the appraisals we receive.

Fannie Mae's late-2024 Selling Guide update (effective for appraisals dated on or after **1 March 2025**)
requires appraisers to analyse whether market conditions changed between the comparable's **contract date**
and the appraisal's **effective date** and to make time adjustments as the analysis indicates. Failure to
make market-derived time adjustments when the data indicates them is an **unacceptable appraisal practice**.
Fannie accepts paired sales, statistical analysis, modelling, and home price indices as support, and
requires the report to summarise the data sources, tools and techniques used. Adjustments may be **positive,
negative, or zero** for different comps in the same report.

**Our derivation:**

```
1. Build a monthly series over the segment, 24 months back:
     m_t = median(price_per_gla) for all closed arms-length sales settling in month t
   Require ≥ 3 sales in a month for m_t to exist.

2. Fit OLS on the log of the series:
     ln(m_t) = a + b·t              (t = months since series start)

3. Monthly market rate:
     r = exp(b) − 1

4. Per-comp adjustment (compounded, applied to the comp's own sale price):
     months = whole months from comp sale_date to the valuation's effective date
     adj    = comp_sale_price × ((1 + r)^months − 1)
```

**Sufficiency gate (all must hold):**

| Condition | Why |
|---|---|
| ≥ 8 months with data, out of the last 18 | a 3-point line is not a trend |
| ≥ 24 total sales in the series | |
| `R² ≥ 0.30` | below this the "trend" is noise |
| `|r| ≤ 0.02` (±2%/month) | ±2%/mo is ±27%/yr — beyond that we are fitting an artefact |
| The sign of `r` agrees with a naive first-half vs second-half median comparison | catches a fit driven by one outlier month |

**If it fails → blank, with a reason that tells the analyst what to do:**
*"No market-conditions adjustment was derived: only 4 months in ZIP 07501 had 3+ sales in the last 18
months. If you believe the market has moved, enter a rate and note your source (e.g. an FHFA or Case-Shiller
index for this metro) in the narrative."*

**Two subtleties to build in:**

- **Contract date vs settlement date.** The correct clock starts at the comp's *contract* date, not its
  settlement. We hold settlement dates (`property_sales.sale_date`). We also hold `days_on_market` on many
  comps — where DOM is present it can approximate the contract date (`sale_date − escrow lag`), but escrow
  lag is not DOM. **Recommendation: use settlement date, and state that we used it.** Do not silently
  approximate a contract date; say what clock we used, which is exactly what Fannie asks appraisers to do.
- **The time adjustment must be applied FIRST**, before any other line, because every other paired-sale
  derivation above assumes prices are on a common date. Our derivations already control for this by
  requiring pairs within 6 months; for the grid itself, time is line #2 (right after concessions) and the
  UI should compute it first and show it as such.

## 3.6 Concessions

Not a derived rate — a **direct copy**. `property_observations.concession_amount` holds what the appraiser
recorded. Pre-fill `adj = −concession_amount` (a seller concession inflated the recorded price, so back it
out). Blank when null, with the reason *"No concession amount was recorded on this comp's grid line."*

## 3.7 Where the defaults are cached

Recomputing these on every page load is wasteful and makes the numbers non-reproducible. Cache them in
`avm_adjustment_bases` keyed on `(segment_key, line_code, window_months)`, with `computed_at`, the full
sample metadata, and a TTL (7 days). **The valuation copies the rate and its metadata at the time of use**
(§2.1) — the cache is an accelerator, never the record.

---

# 4. Reconciliation math

## 4.1 The candidate methods, honestly assessed

Let `A_i` = adjusted sale price of comp `i`, `g_i` = gross adjustment % of comp `i`, `n` = number of
**closed** comps.

| Method | Formula | Verdict |
|---|---|---|
| **Simple average** | `ΣA_i / n` | What Flexmls and HouseCanary do. **Do not use as the headline.** One badly-adjusted comp drags it, and it implicitly says every comp is equally good, which is never true |
| **Median** | `median(A_i)` | Robust to one bad comp, but discards information and is unstable at n=4 (it becomes the average of the middle two anyway). **Use as a cross-check, always display it** |
| **Most similar comp** | `A_j where j = argmin g_j` | The appraiser's instinct ("lean toward the comps needing the least adjustment") in its purest form. **Use as a cross-check, always display it.** Never as the headline — a single comp is a single data point |
| **Gross-adjustment-weighted mean** | see below | **This is the headline.** It formalises exactly the reasoning appraisers already apply |
| **Regression** | fitted value at the subject's characteristics | **Cross-check only, and only at n ≥ 30 market sales** (not 3 comps — you cannot regress on 3 points). Fitting a model to the same 4 comps you adjusted is circular |

## 4.2 The recommended headline: similarity-weighted mean

```
w_i = 1 / (g_i + k)            where g_i = gross adjustment % (as a decimal), k = 0.05
indicated = Σ(w_i · A_i) / Σ w_i
```

`k = 0.05` is a floor that stops a comp with a 0% gross adjustment from taking infinite weight (and 5% is
about the noise floor of any real grid anyway). Worked example:

| Comp | Adjusted price | Gross adj % | `w = 1/(g+0.05)` | Normalised weight |
|---|---|---|---|---|
| 1 | $412,000 | 8% | 7.69 | 40.5% |
| 2 | $398,000 | 14% | 5.26 | 27.7% |
| 3 | $431,000 | 22% | 3.70 | 19.5% |
| 4 | $405,000 | 31% | 2.78 | 14.6% |

`indicated = (412,000×7.69 + 398,000×5.26 + 431,000×3.70 + 405,000×2.78) / 19.43 = $410,900`
→ round to **$411,000**.

**Refinements to layer on the weight, all multiplicative and all capped:**

```
w_i = 1/(g_i + 0.05)
    × recency(i)      = 1.0 if ≤6mo, 0.85 if ≤12mo, 0.60 if ≤18mo, 0.35 if >18mo
    × distance(i)     = 1.0 if ≤0.5mi, 0.85 if ≤1.0mi, 0.60 if ≤2.0mi, 0.35 if >2.0mi
    × sale_type(i)    = 1.0 arms-length, 0.40 REO/estate/short
    × 0 if sale_status ≠ 'closed'          ← listings NEVER carry weight
```

Cap any single comp's normalised weight at **40%** — if one comp is carrying the value, that is a finding
to surface, not a result to publish. When the cap binds, say so in the warnings.

**Manual override is always available.** The analyst can type per-comp weights (or zero one out entirely
while keeping it visible on the grid — which is what appraisers do with a comp they show but don't rely on).
Store the final weights either way (§2.5).

## 4.3 Presenting a range and a confidence statement honestly

**Three numbers, always shown together:**

1. **Supported range** = `[min(A_i), max(A_i)]` over the closed comps. This is the honest outer bound and
   it is the one an appraiser is held to — *the indicated value must fall within the range of adjusted
   sale prices*. Enforce it: if the analyst's chosen value falls outside this bracket, **refuse to issue**
   until they either change the value or add a comp that brackets it.
2. **Indicated value** = the weighted mean, rounded to the nearest $1,000 (nearest $5,000 above $1M).
3. **Central range** = `indicated ± max(2.5%, min(15%, 1.0 × σ_w))`, where `σ_w` is the weighted standard
   deviation of the `A_i`. Floor and ceiling because a 3-comp σ is not a real standard deviation; the floor
   stops us implying false precision, the ceiling stops us publishing a range so wide it is useless.

**Confidence statement — derive it, don't assert it.** Use the IAAO **Coefficient of Dispersion**, which is
the standard measure of comp-set tightness:

```
COD = 100 × mean(|A_i − median(A)|) / median(A)
```

| COD | Band | Report language |
|---|---|---|
| ≤ 7 | High | "The adjusted comparables cluster tightly (COD 5.2). This indication is well supported." |
| 7–12 | Moderate | "The adjusted comparables show moderate dispersion (COD 9.4). Treat the range, not the point, as the answer." |
| 12–20 | Low | "The adjusted comparables disagree materially (COD 16.1). This is a wide indication and should not be relied on alone." |
| > 20 | Not supported | "The adjusted comparables do not agree (COD 24.8). **No reliable indication can be drawn from this comp set.**" |

The AVM industry equivalent is **FSD** (Forecast Standard Deviation): an FSD of 0.10 means a **68.3%**
(one-standard-deviation) probability that the true value is within **±10%**; a confidence score is
conventionally `100 − FSD%`. If we ever publish a confidence *score*, define it this way and say so in the
footnote — do not invent a 1-to-100 scale with no meaning behind it.

**Things the confidence statement must never say:** "accurate to within X"; "guaranteed"; anything
implying a distribution we did not measure. And when `n < 3` closed comps, the correct output is **no
indicated value at all** — print the grid, print the warnings, and say plainly that the comp set does not
support a conclusion.

## 4.4 Warnings to surface

Two severities: **advisory** (print it, proceed) and **blocking** (refuse to issue until acknowledged with
a typed reason, which is then printed on the report). The house pattern for "a way through that is
recorded" is the super-admin condition override (`db/344`) — mirror it: never a dead end, never silent.

| # | Condition | Severity | Message |
|---|---|---|---|
| 1 | `n_closed < 3` | **Blocking** | "Fewer than three closed comparables. No indicated value will be produced." |
| 2 | Indicated value outside `[min A_i, max A_i]` | **Blocking** | "Your value is not bracketed by the adjusted comparables." |
| 3 | COD > 20 | **Blocking** | "The comparables do not agree; this set does not support a conclusion." |
| 4 | Any comp `net adj % > 15%` | Advisory | "Comp #N has a net adjustment of 18.4%." |
| 5 | Any comp `gross adj % > 25%` | Advisory | "Comp #N has a gross adjustment of 31.2% — it is materially different from the subject." |
| 6 | Any single line item > 10% of comp sale price | Advisory | "The GLA adjustment on comp #N is 14% of its sale price." |
| 7 | Comp `sale_date` older than 12 months | Advisory | "Comp #N settled 16 months ago." |
| 8 | Comp `sale_date` older than 18 months | Advisory (escalate) | "Comp #N settled 22 months ago and carries reduced weight." |
| 9 | No time adjustment on a comp older than 6 months | Advisory | "Comp #N settled 9 months ago with no market-conditions adjustment. GSE guidance expects one where the data indicates it." |
| 10 | **No bracketing on GLA** (all comps larger, or all smaller) | Advisory | "All comparables are larger than the subject. The GLA adjustment is unbracketed and its direction is untested." |
| 11 | **No bracketing on adjusted price** (subject value above all, or below all, adjusted prices) | **Blocking** (= #2) | |
| 12 | No bracketing on condition grade | Advisory | "No comparable is in the subject's condition grade (C4). The condition adjustment is unverified." |
| 13 | Comp `proximity > 1.0 mi` | Advisory | "Comp #N is 1.4 miles from the subject." |
| 14 | Comp `proximity > 2.0 mi` | Advisory (escalate) | |
| 15 | Comp GLA more than 25% off subject | Advisory | "Comp #N is 34% larger than the subject." |
| 16 | Comp is `active` / `pending` | Advisory | "Comp #N is a listing, not a closed sale. Listings inform the range and carry no weight in the indicated value." |
| 17 | Comp `sale_type` not arms-length (REO/estate/short) | Advisory | "Comp #N was an REO sale." |
| 18 | Any adjustment line was hand-typed with no derived basis | Advisory | "3 adjustments on this grid were entered by hand with no market support recorded. Note your basis in the narrative." |
| 19 | Any single comp's normalised weight > 40% (cap bound) | Advisory | "Comp #1 would carry 58% of the weight; capped at 40%." |
| 20 | Comps drawn from fewer than 2 distinct source appraisals | Advisory | "All comparables came from a single appraisal report." |
| 21 | A comp's warehouse facts have changed since the snapshot | Advisory | "Comp #2's recorded GLA has since been restated by a later report (1,840 → 1,910 sqft)." |
| 22 | Property category mismatch (2–4 family comp against a single-family subject) | **Blocking** | "Comp #N is a 2–4 family; the subject is single-family." |
| 23 | Comp is the subject itself, or a prior sale of the subject | **Blocking** | |
| 24 | Indicated value differs from the file's `as_is_value` by > 10% | Advisory | "This indication is 14% below the As-Is value on the loan file ($411,000 vs $478,000)." |

**On the 15% / 25% thresholds specifically:** these were long-standing Fannie Mae Selling Guide guidance
(≤10% per line item, ≤15% net, ≤25% gross) and are **no longer GSE limits** — Fannie removed them from
B4-1.3-09 and now states it has no specific limitation on net or gross adjustments, that the number and
amount of adjustments must not be the sole determinant of a comparable's acceptability, and that appraisers
should make market-based adjustments without regard to arbitrary limits. **Keep them anyway as internal
review triggers** — they are excellent at flagging a comp that is not really comparable, several of our
note buyers still apply their own versions, and warning #5 says "this comp is materially different," which
remains true. Just do not word them as "you have violated a Fannie Mae rule." Word them as what they are:
our review threshold.

---

# 5. The output report

## 5.1 Contents, page by page

**Page 1 — Cover / Summary**
- Title: *"Indicated Value Analysis — how this property may be appraised"*
- Subject address, photo, loan number / file reference (where the valuation is tied to one)
- **Indicated value**, supported range, central range, confidence band + COD
- Effective date (the as-of date of the analysis) and preparation date — different fields, both printed
- Prepared by (staff name, role), version number, valuation id
- **The disclaimer block** (§5.3) — on page 1, not buried at the back

**Page 2 — Subject**
- Full subject fact block: address, APN, category, units, GLA, beds, baths, year built, lot, condition,
  quality, view, location, basement, garage, flood zone
- **Per-field source flags**: `from the appraisal dated …` / `from the loan file` / `from the warehouse` /
  `corrected by [staff] on [date]`. Every staff correction is visible.
- Subject's prior sale/transfer history if we hold it

**Page 3 — The grid** (landscape)
- Side-by-side URAR-style columns: `FEATURE | SUBJECT | COMP 1 | COMP 2 | COMP 3 | …`
- Header rows: address, proximity, sale price, $/sqft, sale date, sale status, sale type, data source
- All the adjustment lines from §2.4, each with DESCRIPTION and `+(−)$`
- Footer: Net Adjustment, Net Adj %, Gross Adj %, **Adjusted Sale Price**, **weight applied**
- Continuation page when comps > 4 (repeat the SUBJECT column on each page — a grid page without the
  subject column is unreadable)

**Page 4 — Reconciliation**
- The stats table: low / high / mean / median / weighted mean of adjusted prices
- The weighting method and the per-comp weights, with the formula printed
- Cross-checks: median indication, most-similar-comp indication, regression indication (when available)
- **Analyst narrative** (free text, required, minimum length enforced) — why these comps, why these
  adjustments, why this point in the range
- The chosen indicated value and how it relates to the cross-checks

**Page 5 — Warnings & data quality**
- Every warning from §4.4 that fired, with its severity
- Any blocking warning that was overridden, **who overrode it and the reason they typed**
- Every adjustment line that was left blank and **why** ("no market-conditions adjustment was derived —
  insufficient monthly sales")
- Sample sizes behind every auto-suggested rate that was used

**Page 6 — Comparable detail & provenance** (one block per comp)
- Photo, full fact block, adjustment detail
- **Provenance, stated explicitly**: *"Source: appraisal report on file YSCAP258134791, effective
  2026-03-14, prepared by [appraiser name], [license]. This property was Comparable #2 on that report.
  Facts as stated on that report."*
- Whether the comp's facts have since been restated by a later report

**Page 7 — Map**
- Subject pin + comp pins with distances. We hold `latitude`/`longitude` on `properties` and
  `property_observations`. **A static SVG map (relative positions, distance rings, a scale bar) drawn
  from lat/lng requires no tile provider and no new dependency** — do that rather than embedding a
  third-party tile image, which would also be a data-egress question.

**Page 8 — Appendix**
- Methodology note: how weights are computed, how each auto-suggested rate was derived, what COD means
- Definitions (as-is vs after-repair, gross vs net adjustment, arms-length)
- Full disclaimer, repeated

## 5.2 The regulatory frame — what actually applies to us

**Read this carefully; the common instinct here is wrong in both directions.**

### (a) USPAP Standards 1 & 2

USPAP **Standard 1** governs the *development* of a real property appraisal (identify the problem, gather
and verify market data, apply the approaches to value). **Standard 2** governs the *reporting* of it. They
attach to an **appraiser** performing an **appraisal**, i.e. an act of a person performing valuation
services in their capacity as an appraiser.

Two practical consequences:

1. **A non-appraiser staff member producing an internal value indication for the lender's own credit
   analysis is not performing an appraisal under USPAP**, and this tool's output is not an appraisal
   report. That is the ordinary posture for a lender's internal evaluation.
2. **But if the person operating the tool is a licensed or certified appraiser, USPAP can attach to their
   work** depending on capacity and jurisdiction. Several states extend appraiser regulation to anything a
   licensee does that looks like valuation. **Policy recommendation: no licensed appraiser on staff or
   contract should operate this tool for our files.** If that ever becomes necessary, the output must be
   restructured as a USPAP-compliant Restricted Appraisal Report (Standards Rule 2-2(b)), which carries a
   mandatory **use restriction statement** — the client must be the only intended user, or additional
   intended users must be named — and which by design does not contain enough information for anyone else
   to understand the rationale. That is a materially different document from what we are building.

The Appraisal Review standards (Standard 3/4) are also worth knowing: if a staffer uses this tool to form
an opinion about *the quality of an appraiser's work*, that is appraisal review, and if performed by an
appraiser it is subject to Standard 3. Our tool's framing — "how this property may be appraised", a second
indication, not a critique of the appraiser — keeps us on the right side of this, and the report wording
should preserve that framing. **Do not word the output as "the appraisal is wrong."**

### (b) Interagency Appraisal and Evaluation Guidelines (December 2010) — "evaluations"

The federal banking agencies' appraisal regulations permit a regulated institution to use an **evaluation**
in place of an appraisal for certain exempt transactions. The relevant thresholds:

- **Residential:** transactions **under $400,000** — effective 9 October 2019 (raised from $250,000).
- **Commercial:** transactions **at or under $500,000** — final rule 2018 (raised from $250,000; the
  agencies had proposed $400,000 and settled on $500,000).
- For exempted transactions the institution **must still obtain an appropriate evaluation** consistent with
  safe and sound banking practices.

**Evaluation content** (the Guidelines specify a list of ~14 points; the load-bearing ones):

1. Identify the location of the property
2. Provide a description of the property and its **current and projected use**
3. Provide an **estimate of the property's market value in its actual physical condition, use and zoning
   designation** as of the effective date
4. Describe the **method(s)** used to confirm the property's actual physical condition and the extent to
   which an inspection was performed
5. Describe the **analysis performed and the supporting information** used in valuing the property
6. Describe the supplemental information that was considered when using an analytical method or
   technological tool
7. Indicate all **source(s) of information** used
8. Include **information on the preparer** — name, contact information, and signature — when performed by
   a person
9. Provide an estimate of the property's market value **with any limiting conditions**
10. Be **written**, and contain sufficient information and analysis to support the institution's decision
    to engage in the transaction

Critically: *"A valuation method that does not provide a property's market value or sufficient information
and analysis to support the value conclusion is not acceptable as an evaluation."* An evaluation must
address both the property's actual physical condition and characteristics **and** the economic/market
conditions affecting value. **Appendix B** specifically addresses evaluations built on analytical methods
and technological tools including AVMs, and requires the institution to demonstrate the method is
consistent with safe and sound practice. The Guidelines also say institutions should have policies dictating
when an appraisal is used **even where an evaluation would be permitted** — i.e. risk can compel an
appraisal regardless of dollar amount.

**The report design in §5.1 satisfies every one of those content points.** Build it that way even though —

### (c) …none of this legally binds us, and that matters

**We are a private, business-purpose lender.** FIRREA Title XI and the interagency appraisal regulations
apply to **federally regulated financial institutions**. We are not one. The interagency evaluation
thresholds and content rules are not our legal obligation.

So why comply with them anyway? Three concrete reasons:

1. **Note buyers and capital partners.** Blue Lake, CorrFirst, Fidelis, EMCAP and any future warehouse or
   securitization counterparty will diligence our valuation practice, and the interagency evaluation
   content list is the yardstick everyone in the industry reaches for. A report that already satisfies it
   is a non-event in diligence; one that doesn't is a finding.
2. **Litigation.** In any dispute the question will be "on what basis did you lend?" A report that names
   its sources, its sample sizes, its blanks, and its preparer answers that question. One with unattributed
   numbers does not.
3. **Internal discipline.** The content list is, independently, a good specification.

**What we must NOT do:** describe the output as an "evaluation" in the regulatory sense, or as satisfying
any regulatory requirement. Call it an **internal value indication**. It is a credit-analysis work product.

### (d) The AVM Quality Control Rule (effective 1 October 2025)

The OCC, Federal Reserve, FDIC, NCUA, CFPB and FHFA jointly finalised quality-control standards for AVMs
used by **mortgage originators and secondary market issuers** in determining the collateral value of a
mortgage secured by **a consumer's principal dwelling**. Covered institutions must adopt policies,
practices, procedures and control systems ensuring covered AVMs: (1) ensure a high level of confidence in
the estimates; (2) protect against manipulation of data; (3) seek to avoid conflicts of interest;
(4) require random sample testing and reviews; and (5) comply with applicable nondiscrimination laws.
"Credit decision" is defined broadly (originate, modify, terminate, or otherwise change a mortgage,
including extending credit or changing a credit limit).

**Applicability to us:** our loans are business-purpose, on investment property, not a consumer's principal
dwelling — outside the rule's covered transactions. Separately, this tool is arguably not an "AVM" at all
in the rule's sense: a human selects the comps and sets every adjustment; the software computes arithmetic
and suggests defaults.

**But adopt factors (1)–(4) voluntarily anyway**, because they are simply good practice and they are cheap
given what we are already building:

- (1) *high confidence* → the COD-based confidence band and the sufficiency gates in §3
- (2) *protect against manipulation* → immutable versions, `inputs_hash`, full audit trail, no silent edits
  to an issued version
- (3) *conflicts of interest* → the person who set the loan's terms should not be the only person who
  produced its valuation; log `created_by` and surface it
- (4) *random sample testing* → periodically back-test issued indications against the appraisal that
  subsequently arrived, and report the error distribution. **This is a genuinely valuable internal metric
  and it is nearly free to compute** given we already store both numbers.

### (e) The one rule that is ours, not anyone else's

**This tool's output may never size a loan.** In this codebase `as_is_value` and `arv` come off the
appraisal, they are governed by `lib/appraisal/as-is-reader.js` and its confidence rules, and any change to
them reopens Products & Pricing. The AVM builder writes neither. If a staffer concludes from this tool that
the appraisal is wrong, the recorded path is the existing appraisal-findings desk and the As-Is verification
condition — not a back door into the pricing inputs.

## 5.3 The disclaimer block (draft — have counsel review before shipping)

> **THIS IS NOT AN APPRAISAL.**
>
> This document is an internal value indication prepared by YS Capital Group for its own credit analysis.
> It is **not an appraisal**, is **not an appraisal report**, and was **not prepared by a state-licensed or
> state-certified real estate appraiser**. It has **not** been developed or reported in conformity with the
> Uniform Standards of Professional Appraisal Practice (USPAP), including Standards 1 and 2, and it may not
> be represented as, relied upon as, or substituted for an appraisal or an appraisal review.
>
> It is not an "evaluation" for the purposes of the Interagency Appraisal and Evaluation Guidelines or any
> federal or state appraisal regulation, and it is not offered as satisfying any such requirement.
>
> The analysis relies on comparable sales data extracted from appraisal reports previously delivered to
> YS Capital Group by third-party appraisers. Each fact is stated **as it was reported to us on the date
> shown** and has not been independently verified. No interior or exterior inspection of the subject
> property or of any comparable was performed in connection with this analysis. Adjustments reflect the
> judgement of the preparer; automatically suggested adjustments are derived from the limited data set
> described in this report and are shown with their sample sizes. Where no adjustment could be supported by
> the available data, the line is left blank and the reason is stated — a blank line is not a statement
> that no difference in value exists.
>
> The indicated value is an opinion as of the effective date shown, is subject to the range and the
> limiting conditions stated, and may differ materially from an appraised value, from a contract price, or
> from an eventual sale price. It is provided for internal use only, is not for distribution to any
> borrower, investor, guarantor or third party, and creates no representation or warranty to any person.
>
> Prepared by: {staff name}, {role} · Effective date: {effective_date} · Prepared: {issued_at} ·
> Version {version} · Valuation ID {id}

**Distribution control:** treat the artifact as staff-only. In this codebase that means `visibility =
'staff_only'` on the `documents` row and exclusion from the borrower checklist view — the same posture as
`appraisal_source_docs` (`db/175`) and purchase advice (`db/362`). It must also be **excluded from
`TPR_DOC_SELECT`** by default (it is not an investor-delivery document), with a deliberate opt-in if a note
buyer ever asks for it.

---

# 6. Printable / export format

**Constraint:** Node/Express; only `pdf-lib` and `unpdf` in `package.json` for PDF; plain HTML; no new
dependencies.

## 6.1 What each available tool is actually good for

| Tool | Reality |
|---|---|
| **Plain HTML + print CSS** | Full layout engine, tables, page breaks, fonts, images — for free. The browser does the pagination. Zero risk. **This is the canonical renderer.** |
| **`pdf-lib`** | A PDF *object* library, not a layout engine. `drawText` / `drawRectangle` / `drawLine` at absolute coordinates; `embedJpg` / `embedPng`; page creation; **merging and stamping existing PDFs**. Building a paginated multi-column grid with it means hand-writing a text-wrapping and pagination engine. Doable, tedious, and easy to get wrong. |
| **`unpdf`** | A **reader** (text/metadata extraction). Already used for reading appraisal PDFs. **Not a generator.** Irrelevant here except for round-trip verification. |
| **`jspdf` + `jspdf-autotable` — already vendored in this repo** | `web/tools/vendor/jspdf.umd.min.js` and `web/tools/vendor/jspdf.plugin.autotable.min.js` are committed, and `src/lib/esign/application-pdf.js` already loads the UMD **server-side in Node** via a lazy `require(path.join(__dirname,'..','..','..','web','tools','vendor','jspdf.umd.min.js'))`, with a documented fallback to `global.jspdf.jsPDF`. `src/sitewire/draw-report.js`, `iska-pdf.js`, `draw-request-pdf.js` and `disclosure-pdf.js` all build real PDFs this way today. **This is not a new dependency** — it is an existing, in-tree, proven capability, and `autoTable` is purpose-built for exactly the side-by-side grid we need. |

## 6.2 Recommendation

**Two renderers, one data model.** Both read the same frozen valuation snapshot, so they cannot disagree.

**1. HTML is canonical and ships first.**
`GET /api/staff/avm/valuations/:id/report.html` renders a self-contained document:

- Inline `<style>`, no external assets. Photos as `data:` URIs read from `storage` (the draw-report and
  track-record exports already do exactly this).
- `@page { size: letter landscape; margin: 0.4in }` for the grid pages; a `@page :first { size: letter }`
  portrait cover if desired, or keep everything landscape for simplicity.
- `page-break-after: always` between sections; `page-break-inside: avoid` on each comp detail block and on
  each grid row group.
- `thead { display: table-header-group }` so the FEATURE/SUBJECT header repeats on every printed grid page.
- Force light theme explicitly and use dark text on white — the portal's hard rule
  (`--ink*` tokens are **light**; use `#141B22` / `#4B585C`, never `var(--ink)`).
- The grid scrolls horizontally on screen inside its own `overflow-x: auto` container; the print stylesheet
  removes the container and lets it paginate.
- The user prints to PDF from the browser. Nothing to install, nothing to maintain, and the output is
  always current with the HTML.

**2. Server-side PDF via the vendored jsPDF + autoTable, for the attachable artifact.**
`POST /api/staff/avm/valuations/:id/issue` produces the durable PDF and files it as a `documents` row
(`doc_kind = 'avm_indication'`, `visibility = 'staff_only'`), which gets it SharePoint mirroring, version
history and the storage integrity audit for free.

- Reuse `pdfSafe` / `fit` from `src/lib/esign/application-pdf.js` and the PILOT palette — the house style
  already exists and `draw-report.js` is a working precedent for a photo-bearing branded report.
- `autoTable` with `columns = [FEATURE, SUBJECT, COMP1..N]` and `didDrawPage` to repeat headers; it handles
  pagination, column widths and cell wrapping.
- Photos via `doc.addImage`, **JPEG/PNG only, format chosen from magic bytes not `content_type`**, and
  anything that fails to decode is skipped rather than thrown — copy `draw-report.js` verbatim on this;
  it is the hard-won version.
- Strip photo EXIF/GPS with the existing `lib/image-exif.stripLocationExif`.
- Write text uncompressed (jsPDF's default) so field values stay greppable in the raw bytes — the existing
  PDF tests assert on this and ours should too.

**3. Use `pdf-lib` for exactly one thing: merging.** If a valuation ever needs to be appended to the
appraisal PDF or folded into a TPR package, `pdf-lib`'s `copyPages` is the right tool. Do not try to lay the
report out with it.

**4. Also emit XLSX.** `src/lib/xlsx.js` / `tpr-export.buildXlsx` is a proven dependency-free OOXML writer
already used for the reallocation, GL, draw-packet and track-record exports. A one-sheet grid export
(features down, comps across, adjusted prices and weights at the bottom) is ~40 lines and is what an
analyst will actually want when they need to re-cut the numbers.

**Do not** attempt HTML→PDF on the server. Every route to it (headless Chromium, wkhtmltopdf, puppeteer) is
a new dependency and a heavyweight one; Playwright/Chromium exists in the dev environment for testing but
is not a production dependency and must not become one.

---

# RECOMMENDED BUILD

Opinionated, prioritized. Each phase ships something usable on its own.

## Phase 0 — Decisions to lock before writing code

1. **Staff-only.** No borrower surface, ever. (Redfin's lesson; also our capital-partner secrecy rules.)
2. **Advisory only.** Writes nothing to `applications.as_is_value` / `arv` / any pricing input. Its findings
   route through the existing appraisal-findings desk if they matter.
3. **Snapshot, don't reference** (§2.1). Keep FKs for lineage and compute drift advisorily.
4. **Blank, never zero,** when a rate cannot be supported (§3).
5. **The report carries the §5.3 disclaimer on page 1**, and the artifact is `staff_only` and excluded from
   TPR.
6. **No licensed appraiser operates this tool for our files** (§5.2a) — write this into the tool's own
   access policy, and put it in the appendix of the report.

## Phase 1 — The grid (the minimum lovable product)

**What ships:** open a subject → search comps → pick comps → hand-adjust → see an indicated value → print.

- Subject picker: (a) a loan file's subject property, (b) any `properties` row, (c) a typed address that
  creates an ad-hoc unsaved subject.
- Subject fact block with **per-field staff override** and a source badge on every field (§1.5).
- Comp search over `properties` / `property_observations` with the filters the indexes already support:
  ZIP / city / radius (lat-lng box then haversine), beds, baths, GLA band, sale price band, sale date band,
  property category, sale status, sale type. Default the filters from the subject (±20% GLA, ±1 bed,
  1 mile, 12 months) — **never open on an empty form**.
- Results as map + list, with distance, $/sqft, days since sale, and a photo thumbnail.
- Select comps into the grid (target 3–6, allow up to 8).
- The URAR grid (§2.4) with **rate-per-line "single line mode"** (§1.4) as the primary interaction:
  type `$/sqft` once → every comp's GLA line computes as `(subject_gla − comp_gla) × rate`. Per-comp
  override on any cell.
- **The software owns the sign.** `adj = (subject_value − comp_value) × rate`. Never a typed sign.
- Live recompute of net adj, net adj %, gross adj %, adjusted price, and the indicated value on every
  keystroke (§1.2).
- Reconciliation: weighted mean (§4.2) with the stats table and the two cross-checks.
- Warnings engine (§4.4), advisory ones live in the UI.
- Save as a draft version; issue produces the HTML report.

**Deliberately NOT in Phase 1:** auto-suggested rates, PDF, weights UI beyond the default method,
regression. Ship the grid first and let the desk use it.

## Phase 2 — Auto-suggested adjustments

- `avm_adjustment_bases` + the derivation jobs, in this order:
  1. **Appraiser-line mining (§3.2)** — highest value, unique to us, and the easiest to explain on the
     report. Build this first.
  2. **Time / market conditions (§3.5)** — the one most often missing from the appraisals we receive.
  3. **Paired sales for GLA and baths (§3.3)**.
  4. **Condition and quality ladders (§3.3)**.
  5. **Regression (§3.4)** — last, and clearly badged as modelled.
- Every rate renders with an info affordance showing method, `n`, distinct appraisers/pairs, segment rung,
  window, and spread. Clicking it lists the underlying observations.
- Blanks render as blanks with the reason. **Write the sufficiency-gate tests first** — this is the part
  where a bug silently fabricates a number, and this repo's whole discipline is that fabrication is the
  unacceptable failure direction.

## Phase 3 — Report, export, and the audit trail

- `jsPDF` + `autoTable` PDF filed as a `staff_only` `documents` row (§6.2).
- Static SVG map from lat/lng.
- Comp photos from `property_photos` → `documents`, EXIF-stripped.
- XLSX export.
- `avm_valuation_events` recording suggested/accepted/rejected comps and every line edit.
- `audit_log` row on issue.

## Phase 4 — The loop that makes it better

- **Back-test:** for every issued indication on a file that later received an appraisal, record
  `indicated − appraised` and publish the error distribution (median absolute % error, % within 10%). This
  is both the AVM-QC "random sample testing" factor and the only honest way to state confidence over time.
- **Learn the ranker:** the accept/reject log from Phase 3 trains the comp similarity score (Redfin's
  feedback loop).
- **Pre-order sanity check:** run an automatic indication when an appraisal order is placed, and again when
  the appraisal lands; a > 10% divergence becomes an *advisory* finding on the appraisal desk (never a
  block, never an auto-write — the existing advisory-only doctrine).

## ⚠️ Reconciling with the in-flight `db/409_property_valuations.sql`

**A parallel session has already begun this feature** — `db/409_property_valuations.sql` and
`src/lib/research/valuation.js` exist untracked in the working tree as of 2026-08-02. Per the house merge
rule (*both sides' enhancements must survive; renumber your own migration, never theirs*), the schema
below is written as an **evolution of theirs, not a replacement**, and any new migration takes the next
free number (**`db/408`**), leaving `407` alone.

**Where the two designs already agree** (good — these are the load-bearing calls):

- **Snapshot, never reference.** `407`'s header states it in the same terms: *"every valuation carries its
  own copy of the facts… a valuation whose numbers silently change underneath it is not a record of
  anything"*, with `property_id` / `observation_id` kept for navigation only. Identical to §2.1.
- **The rates that pre-filled the grid are copied in** (`property_valuations.market_rates` jsonb) so
  *"where did $119 a square foot come from?"* stays answerable. Identical to §3.7.
- **A stamped disclaimer on every result** (`valuation.js DISCLAIMER`) — §5.3.
- As-is vs ARV are distinct purposes with distinct comp sets — matches `comp_set` and §1.3.
- `included` + `weight` per comp, materialized net/gross/adjusted figures per comp — §2.5, §4.2.

**Where this document recommends changing `407`, and why:**

| `db/409` as written | Recommendation | Reason |
|---|---|---|
| `property_valuation_comps.adjustments jsonb` — `[{key,label,amount,note,source}]` | **Normalize to `property_valuation_adjustments` rows** (`db/408`, additive; keep the jsonb column populated during a transition) | §2.3 — the cross-valuation query *"what has this desk been paying per bath in Passaic County?"* is the Phase-4 feedback loop, and it is not reachable through a jsonb array. Also gives per-line `basis_method` / `basis_n` / `blank_reason` first-class homes |
| `version integer` + `supersedes_id` self-FK | **Add `chain_id` + a partial unique index `WHERE superseded = false`** | A `supersedes_id` chain has no cheap "which one is live?" query and no constraint stopping two live heads. `db/188_appraisals_one_current.sql` and `product_registrations` both use the partial-unique-current pattern; follow it |
| `status ∈ draft \| final` | Add `archived`; on edit-after-final, **fork a new version** rather than reopening | §2.2 — a printed report must stay reproducible |
| no `inputs_hash` | **Add it** | Re-issuing an unchanged valuation should return the existing version, not mint one (`maybeRunWholeLoan(..., {skipIfUnchanged:true})` pattern) |
| `warnings jsonb` | Fine for now; promote to rows only if warnings need per-item override reasons | A **blocking** warning override needs `overridden_by` + a typed reason on the record (§4.4) |
| `market_rates jsonb` copied per valuation | **Keep** — and add the `avm_adjustment_bases` **cache** behind it | §3.7: the cache is an accelerator, the copy is the record. Both, not either |
| `amount` semantics unstated | **Document that `NULL` = blank (unsupported) and `0` = a decision** | §3's central rule; they must render and print differently |
| no event log | Add `property_valuation_events` | §1.6 / Phase 4 — the accept/reject log is what trains the comp ranker and answers "what did they look at and not use?" |
| `created_by uuid` with no FK | Add `REFERENCES staff_users(id) ON DELETE SET NULL` | Consistency with every other staff-authored table |
| `uq_pval_comp ON (valuation_id, COALESCE(property_id::text, id::text))` | Correct as written — note that it permits several ad-hoc comps with no `property_id`, which is intended | (No change; flagged so nobody "simplifies" the COALESCE away — a bare nullable column would let two NULLs be DISTINCT) |

**Practical instruction:** treat the schema below as the target shape. If `407` has already merged, land the
deltas as an additive, idempotent `db/408`; if it has not, fold them into `407` before it merges.

## Target schema (shown standalone for clarity — land as `db/408` deltas on top of `407`)

Additive, idempotent, `IF NOT EXISTS` throughout, per the house migration rules. Table names below use the
`avm_*` prefix for readability; **if `407` merges first, keep its `property_valuation*` names** and apply
only the column/index deltas from the table above — the names matter far less than the shape.

```sql
-- ---------------------------------------------------------------------------
-- 1. THE VALUATION (a version in a chain; snapshots everything it depends on)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS avm_valuations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chain_id            uuid NOT NULL,              -- groups the versions of one analysis
    version             integer NOT NULL DEFAULT 1,
    superseded          boolean NOT NULL DEFAULT false,
    status              text NOT NULL DEFAULT 'draft',   -- draft | issued | archived

    -- WHAT is being valued. All three are optional lineage; the SNAPSHOT below is the record.
    application_id      uuid REFERENCES applications(id) ON DELETE SET NULL,
    property_id         uuid REFERENCES properties(id)   ON DELETE SET NULL,
    appraisal_id        uuid REFERENCES appraisals(id)   ON DELETE SET NULL,

    title               text,
    basis               text NOT NULL DEFAULT 'as_is',   -- as_is | arv | as_repaired_rental
    effective_date      date NOT NULL,                   -- the as-of date of the opinion
    purpose             text,                            -- pre-order check | appraisal review | portfolio

    -- ---- THE SUBJECT SNAPSHOT (copied, never referenced — see doc §2.1) ----
    subject_address     text NOT NULL,
    subject_street      text, subject_unit text, subject_city text,
    subject_state       text, subject_zip text, subject_county text,
    subject_lat         numeric(9,6), subject_lng numeric(9,6),
    subject_category    text,                            -- property-category.js canonical key
    subject_property_type text,
    subject_units       integer,
    subject_gla         numeric(12,2),
    subject_beds        integer,
    subject_baths_full  integer,
    subject_baths_half  integer,
    subject_year_built  integer,
    subject_lot_area    text,
    subject_condition_uad text,
    subject_quality_uad text,
    subject_view_rating text,
    subject_location_rating text,
    subject_below_grade_sqft numeric(12,2),
    subject_below_grade_finished_sqft numeric(12,2),
    subject_garage_type text,
    subject_garage_spaces integer,
    subject_stories     text,
    subject_design_style text,
    subject_market_rent numeric(12,2),
    -- Per-field provenance: {"gla":{"source":"appraisal","appraisal_id":"…","overridden":false}, …}
    subject_field_sources jsonb NOT NULL DEFAULT '{}'::jsonb,
    subject_facts       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- anything else we snapshotted

    -- ---- MARKET SEGMENT USED FOR THE AUTO-SUGGESTED RATES ----
    segment_key         text,        -- e.g. 'zip:07501|cat:sfr|gla:1200-2000'
    segment_level       text,        -- L0 | L1 | L2 | L3 | L4
    segment_window_months integer,

    -- ---- RECONCILIATION ----
    weighting_method    text NOT NULL DEFAULT 'gross_adj_inverse',  -- equal|gross_adj_inverse|similarity|manual
    reconciliation_method text NOT NULL DEFAULT 'weighted_mean',    -- weighted_mean|median|most_similar|manual
    indicated_value     numeric(14,2),
    range_low           numeric(14,2),   -- min adjusted price (the SUPPORTED range)
    range_high          numeric(14,2),   -- max adjusted price
    central_low         numeric(14,2),   -- indicated − dispersion band
    central_high        numeric(14,2),
    mean_adjusted       numeric(14,2),
    median_adjusted     numeric(14,2),
    weighted_mean_adjusted numeric(14,2),
    most_similar_adjusted  numeric(14,2),
    regression_indicated   numeric(14,2),
    cod                 numeric(8,2),    -- coefficient of dispersion
    confidence_band     text,            -- high | moderate | low | not_supported
    closed_comp_count   integer NOT NULL DEFAULT 0,
    listing_comp_count  integer NOT NULL DEFAULT 0,

    narrative           text,            -- the analyst's reconciliation write-up (required to issue)

    -- ---- ISSUE / IMMUTABILITY ----
    inputs_hash         text,            -- stable hash of subject+comps+adjustments+weights+method
    issued_at           timestamptz,
    issued_by           uuid REFERENCES staff_users(id) ON DELETE SET NULL,
    document_id         uuid REFERENCES documents(id) ON DELETE SET NULL,   -- the filed PDF
    override_reason     text,            -- typed when a BLOCKING warning was overridden
    override_by         uuid REFERENCES staff_users(id) ON DELETE SET NULL,
    override_at         timestamptz,

    created_by          uuid REFERENCES staff_users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
-- Exactly ONE live version per chain (the db/188 / product_registrations pattern).
CREATE UNIQUE INDEX IF NOT EXISTS uq_avm_val_current
    ON avm_valuations(chain_id) WHERE superseded = false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_avm_val_version
    ON avm_valuations(chain_id, version);
CREATE INDEX IF NOT EXISTS idx_avm_val_app       ON avm_valuations(application_id);
CREATE INDEX IF NOT EXISTS idx_avm_val_property  ON avm_valuations(property_id);
CREATE INDEX IF NOT EXISTS idx_avm_val_created   ON avm_valuations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_avm_val_creator   ON avm_valuations(created_by);

-- ---------------------------------------------------------------------------
-- 2. THE SELECTED COMPARABLES (each a full frozen snapshot + lineage)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS avm_valuation_comps (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    valuation_id        uuid NOT NULL REFERENCES avm_valuations(id) ON DELETE CASCADE,
    position            integer NOT NULL,          -- 1..N, the grid column order

    -- ---- LINEAGE (nullable on purpose — the snapshot is the record) ----
    property_id         uuid REFERENCES properties(id)            ON DELETE SET NULL,
    observation_id      uuid REFERENCES property_observations(id) ON DELETE SET NULL,
    sale_id             uuid REFERENCES property_sales(id)        ON DELETE SET NULL,
    source_appraisal_id uuid REFERENCES appraisals(id)            ON DELETE SET NULL,
    source_application_id uuid REFERENCES applications(id)        ON DELETE SET NULL,
    source_appraiser_id uuid REFERENCES appraisers(id)            ON DELETE SET NULL,
    source_comp_seq     text,                      -- it was "Comparable #2" on that report
    source_observed_on  date,                      -- that report's effective date
    photo_document_id   uuid REFERENCES documents(id) ON DELETE SET NULL,

    -- ---- THE SNAPSHOT ----
    address             text NOT NULL,
    city text, state text, zip text,
    latitude numeric(9,6), longitude numeric(9,6),
    distance_miles      numeric(8,3),              -- computed at selection time
    proximity_text      text,                      -- the appraiser's own wording, when we have it

    sale_price          numeric(14,2),
    sale_date           date,
    sale_date_text      text,
    sale_status         text NOT NULL DEFAULT 'closed',  -- closed | active | pending
    sale_type           text,                            -- ArmsLengthSale | REOSale | …
    concession_amount   numeric(14,2),
    financing_type      text,
    days_on_market      text,
    list_price          numeric(14,2),
    price_per_gla       numeric(12,2),
    data_source         text,

    property_category   text,
    property_type       text,
    units               integer,
    gla                 numeric(12,2),
    beds                integer,
    baths_full          integer,
    baths_half          integer,
    total_rooms         integer,
    year_built          integer,
    lot_area            text,
    stories             text,
    design_style        text,
    condition_uad       text,
    quality_uad         text,
    view_rating         text,
    location_rating     text,
    below_grade_sqft    numeric(12,2),
    below_grade_finished_sqft numeric(12,2),
    garage_type         text,
    garage_spaces       integer,
    market_rent         numeric(12,2),
    facts               jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- ---- COMPUTED (materialized so the printed report is reproducible) ----
    net_adjustment      numeric(14,2),
    gross_adjustment    numeric(14,2),
    net_adj_pct         numeric(8,2),
    gross_adj_pct       numeric(8,2),
    adjusted_price      numeric(14,2),
    weight              numeric(10,6),             -- final NORMALISED weight actually applied
    weight_raw          numeric(10,6),
    weight_capped       boolean NOT NULL DEFAULT false,
    excluded            boolean NOT NULL DEFAULT false,   -- shown on the grid, zero weight
    exclude_reason      text,
    similarity_score    numeric(8,4),              -- from the ranker, when suggested
    was_suggested       boolean NOT NULL DEFAULT false,

    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_avm_comp_position
    ON avm_valuation_comps(valuation_id, position);
CREATE INDEX IF NOT EXISTS idx_avm_comp_val      ON avm_valuation_comps(valuation_id);
CREATE INDEX IF NOT EXISTS idx_avm_comp_property ON avm_valuation_comps(property_id);
CREATE INDEX IF NOT EXISTS idx_avm_comp_obs      ON avm_valuation_comps(observation_id);

-- ---------------------------------------------------------------------------
-- 3. THE ADJUSTMENT LINES (one row per comp × line — normalized, not jsonb)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS avm_valuation_adjustments (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    valuation_id        uuid NOT NULL REFERENCES avm_valuations(id)      ON DELETE CASCADE,
    comp_id             uuid NOT NULL REFERENCES avm_valuation_comps(id) ON DELETE CASCADE,

    line_code           text NOT NULL,     -- gla | baths_full | condition | sale_date | … (doc §2.4)
    line_label          text NOT NULL,     -- display text as printed on the grid
    line_order          integer NOT NULL,  -- URAR grid order

    -- What prints in the DESCRIPTION cells
    subject_desc        text,
    comp_desc           text,
    -- The numbers behind it
    subject_value       numeric(14,4),     -- e.g. 1850 (sqft), 2.5 (baths), 3 (C3 as ordinal)
    comp_value          numeric(14,4),
    delta               numeric(14,4),     -- subject_value − comp_value
    rate                numeric(14,4),     -- $/unit, or a decimal fraction for % lines
    rate_unit           text,              -- '$/sqft' | '$/bath' | 'pct_of_price' | '$'
    amount              numeric(14,2),     -- THE ADJUSTMENT, signed. NULL = blank line, not zero.

    -- Provenance of the number in `amount`
    entry_mode          text NOT NULL DEFAULT 'manual',  -- suggested | suggested_edited | manual | none
    basis_method        text,       -- appraiser_lines | paired_sales | regression | index | copied | judgement
    basis_n             integer,    -- sample size behind the suggestion
    basis_appraisers    integer,
    basis_spread        numeric(8,4),
    basis_segment       text,
    basis_confidence    text,       -- good | fair | weak
    blank_reason        text,       -- WHY this line is blank — printed on the report
    note                text,       -- analyst's own note on this line

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_avm_adj_line
    ON avm_valuation_adjustments(comp_id, line_code);
CREATE INDEX IF NOT EXISTS idx_avm_adj_val  ON avm_valuation_adjustments(valuation_id);
-- The feedback query: "what has this desk been paying per bath in this market?"
CREATE INDEX IF NOT EXISTS idx_avm_adj_line_code
    ON avm_valuation_adjustments(line_code, basis_segment);

-- ---------------------------------------------------------------------------
-- 4. WARNINGS, MATERIALIZED AT ISSUE TIME (the report must reprint identically)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS avm_valuation_warnings (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    valuation_id        uuid NOT NULL REFERENCES avm_valuations(id) ON DELETE CASCADE,
    comp_id             uuid REFERENCES avm_valuation_comps(id) ON DELETE CASCADE,  -- NULL = grid-level
    code                text NOT NULL,          -- net_adj_over_15 | no_bracketing_gla | comp_over_1mi | …
    severity            text NOT NULL,          -- blocking | advisory
    message             text NOT NULL,
    overridden          boolean NOT NULL DEFAULT false,
    override_reason     text,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_avm_warn_val ON avm_valuation_warnings(valuation_id);

-- ---------------------------------------------------------------------------
-- 5. DERIVED MARKET RATES (a CACHE — the valuation copies what it used)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS avm_adjustment_bases (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    segment_key         text NOT NULL,
    segment_level       text NOT NULL,          -- L0..L4
    line_code           text NOT NULL,
    window_months       integer NOT NULL,
    method              text NOT NULL,          -- appraiser_lines | paired_sales | regression | index
    rate                numeric(14,4),          -- NULL = could not be derived
    rate_unit           text,
    sample_n            integer NOT NULL DEFAULT 0,
    distinct_appraisers integer NOT NULL DEFAULT 0,
    distinct_sources    integer NOT NULL DEFAULT 0,
    spread              numeric(8,4),           -- IQR / median
    r_squared           numeric(8,4),           -- regression / index fits only
    confidence          text,                   -- good | fair | weak | none
    insufficient_reason text,                   -- the sentence the UI shows when rate IS NULL
    detail              jsonb NOT NULL DEFAULT '{}'::jsonb,   -- the underlying observation ids
    computed_at         timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_avm_basis
    ON avm_adjustment_bases(segment_key, line_code, method, window_months);
CREATE INDEX IF NOT EXISTS idx_avm_basis_expiry ON avm_adjustment_bases(expires_at);

-- ---------------------------------------------------------------------------
-- 6. EVENT LOG (append-only: what the analyst looked at and did NOT use)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS avm_valuation_events (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    valuation_id        uuid NOT NULL REFERENCES avm_valuations(id) ON DELETE CASCADE,
    staff_id            uuid REFERENCES staff_users(id) ON DELETE SET NULL,
    kind                text NOT NULL,   -- comp_suggested | comp_accepted | comp_rejected |
                                         -- line_edited | rate_overridden | weight_overridden |
                                         -- warning_overridden | issued | forked
    property_id         uuid REFERENCES properties(id) ON DELETE SET NULL,
    line_code           text,
    detail              jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_avm_events_val  ON avm_valuation_events(valuation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_avm_events_kind ON avm_valuation_events(kind, created_at DESC);
```

**Notes on the schema:**

- `amount NULL` means **blank** (no supported adjustment), `amount = 0` means **the analyst decided the
  difference is worth nothing**. The two are different facts and the report prints them differently. Every
  query that sums adjustments must `COALESCE(amount, 0)` for the arithmetic while `COUNT(*) FILTER (WHERE
  amount IS NULL)` drives the "N lines left blank" line on the report. (And per the house rule: any
  predicate on a nullable column inside a negated/`AND`ed guard must be `COALESCE`d.)
- Every computed number (`adjusted_price`, `weight`, `cod`, `indicated_value`) is **materialized**, not
  derived at read time, so a report reprinted in 2029 shows the 2026 arithmetic.
- Cascades are `ON DELETE CASCADE` from the valuation down, and `ON DELETE SET NULL` on every lineage FK —
  deleting an appraisal must never destroy a valuation we issued.
- `chain_id` has no FK; it is just a grouping key, defaulted to the first version's own `id` by the
  application.

## Proposed routes

*(If `db/409`'s session has already shipped routes under `/api/staff/research/valuations`, keep that prefix
and map the paths below onto it — the shapes are what matter, not the mount point.)*

```
GET    /api/staff/avm/subject/search?q=            find a subject (file / warehouse / typed)
POST   /api/staff/avm/valuations                   create a draft (subject snapshot taken here)
GET    /api/staff/avm/valuations/:id               the live working state
PATCH  /api/staff/avm/valuations/:id               subject overrides, basis, method, narrative (draft only)
GET    /api/staff/avm/valuations/:id/comps/search  ranked candidate pool, defaults from the subject
POST   /api/staff/avm/valuations/:id/comps         add a comp (snapshot taken here)
DELETE /api/staff/avm/valuations/:id/comps/:compId
PATCH  /api/staff/avm/valuations/:id/comps/:compId weight / exclude
PUT    /api/staff/avm/valuations/:id/lines/:code   set a RATE for one line across every comp (single-line mode)
PATCH  /api/staff/avm/valuations/:id/adjustments/:adjId   per-cell override
GET    /api/staff/avm/valuations/:id/bases         the derived rates + their sample metadata
POST   /api/staff/avm/valuations/:id/issue         freeze, render, file the document
POST   /api/staff/avm/valuations/:id/fork          new draft version from an issued one
GET    /api/staff/avm/valuations/:id/report.html   the printable report
GET    /api/staff/avm/valuations/:id/report.xlsx
GET    /api/staff/avm/chains/:chainId              version history
```

All under the staff auth + file-scope middleware; a valuation tied to an `application_id` inherits that
file's visibility scope (`VISIBLE_OFFICERS_SQL`), and an untied valuation is visible to its creator plus
`seesAll` roles.

## Tests to write (and to write first)

| Test | What it must prove |
|---|---|
| `test-avm-adjust-math-pure.js` | Sign convention in every direction; net/gross/adjusted arithmetic; `NULL` vs `0`; single-line mode applying to every comp |
| `test-avm-suggest-sufficiency-pure.js` | **Every sufficiency gate in §3 returns `null` + a reason on a thin sample.** Each gate proven to fail with the guard removed |
| `test-avm-suggest-derivation-pure.js` | Paired-sale, appraiser-line, condition-ladder and time-index derivations against hand-computed fixtures; the monotonicity check; every sanity band |
| `test-avm-reconcile-pure.js` | Weighted mean matches the worked example to the dollar; listings carry zero weight; the 40% cap; COD and the confidence bands |
| `test-avm-warnings-pure.js` | All 24 warnings fire and don't false-fire; blocking vs advisory |
| `test-avm-valuation-db.js` | One-current-per-chain index; issue freezes; edit-after-issue forks; snapshot survives deleting the source appraisal; the drift advisory |
| `test-avm-report-pure.js` | The disclaimer is present; blank lines print with their reason; the subject column repeats on every grid page; the PDF's field values are greppable in the raw bytes |

## What I would explicitly NOT build

- **A borrower-facing version.** Different product, different liability.
- **A percentage slider as the primary adjustment UI** (RPR's model). Fast, but you cannot defend it in a
  file six months later. Fine as an optional triage mode; never the record.
- **Regression as the headline.** It is a cross-check at `n ≥ 30`, badged as modelled, or it is nothing.
- **Auto-writing anything back** — not `as_is_value`, not `arv`, not a condition, not a finding without a
  human pressing a button. The codebase's whole doctrine is that PILOT suggests and a human decides.
- **Server-side HTML→PDF via headless browser.** A new heavyweight dependency for something the vendored
  jsPDF already does.
- **Filling a blank with a national or statewide average** to avoid an empty box. That is fabrication with
  extra steps, and it is the one failure mode this design exists to prevent.

---

## Sources

- [RPR — How do I change the estimated value? (Refine Value tool)](https://blog.narrpr.com/support/how-do-i-change-the-estimated-value-refine-value-tool/)
- [RPR — Property Pricing With RPR (CMA / Refine Value)](https://blog.narrpr.com/tips/cma-refine-value-property-pricing/)
- [RPR — How do I create a CMA?](https://blog.narrpr.com/support/how-to-create-a-cma-comp-analysis/)
- [RPR — What are RVM® and AVM estimated values?](https://blog.narrpr.com/support/what-are-rvm-and-avm-estimated-values/)
- [HouseCanary — Property Explorer Quick Start Guide](https://www.housecanary.com/blog/property-explorer-quick-start-guide)
- [HouseCanary — Property Explorer product page](https://www.housecanary.com/products/property-explorer)
- [HouseCanary — How to Use a Comparative Market Analysis Tool](https://www.housecanary.com/blog/comparative-market-analysis-tool)
- [HouseCanary — Valuation Methodology white paper](https://www.housecanary.com/images/65b19c356809d3de910f5399_hc_valuation-methodology_white-paper-20-1-.pdf)
- [Clear Capital — Broker Price Opinion (residential)](https://www.clearcapital.com/products/broker-price-opinion/)
- [Clear Capital — BPO datasheet (PDF)](https://www.clearcapital.com/wp-content/uploads/2017/09/Broker-Price-Opinion.pdf)
- [Clear Capital — FSD (Forecast Standard Deviation) glossary](https://www.clearcapital.com/resources/glossary-of-terms/fsd-forecast-standard-deviation/)
- [Clear Capital — AVM Testing: A Short Glossary](https://www.clearcapital.com/blog-avm-testing-glossary/)
- [Matrix — CMA Wizard (MLS Technology / GTAR)](https://gtar.zendesk.com/hc/en-us/articles/215702038-CMA-Wizard)
- [Matrix — Create a CMA in Matrix (SmartMLS)](https://matrix.smartmls.com/hc/en-us/articles/13118145563675-Create-a-CMA-in-Matrix)
- [Matrix — Creating a CMA (NorthstarMLS, PDF)](https://media.northstarmls.com/Matrix/PDFs/MatrixCreatingCMA.pdf)
- [Matrix 5 — CMA Wizard (Heartland MLS, PDF)](http://www.heartlandmls.com/matrixdocs/Matrix_5_CMA%20Wizard.pdf)
- [Paragon — How to build a CMA Presentation, Step 3: Adjustments](http://paragonconnect.paragonrels.com/paragon/create-a-cma-presentation/item/81-how-to-build-a-cma-presentation-step-3-adjustments)
- [Paragon 5.66 / 5.67 release notes (adjustment copy forward/back, Prev/Next Comp)](https://pahelp.paragonrels.com/ReleaseNotes/ReleaseNotesTopics/MLS_Paragon_Release_Notes_566.htm)
- [Flexmls — Adjustments Tab (CMA)](https://help.flexmls.com/en/adjustments-tab--cma-.html)
- [Flexmls — Summary Tab (CMA)](https://help.flexmls.com/en/summary-tab--cma-.html)
- [Flexmls — Recommendation Tab (CMA)](https://help.flexmls.com/en/recommendation-tab--cma-.html)
- [Zillow — Homeowners Can Now Change Their Home Facts, Watch Zestimate Update Immediately](https://www.zillow.com/news/homeowners-can-now-change-their-home-facts-watch-zestimate-update-immediately/)
- [Zillow Help — How do I edit the information about my home?](https://zillow.zendesk.com/hc/en-us/articles/360059976733-How-do-I-edit-the-information-about-my-home)
- [Redfin — Redfin Launches Tech-Powered Comparative Market Analysis Tool](http://press.redfin.com/news-releases/news-release-details/redfin-launches-tech-powered-comparative-market-analysis-tool)
- [Redfin — Building the Redfin CMA Tool](https://www.redfin.com/news/building-the-redfin-cma-tool-an-inside-look-at-real-estate-agent-and-engineer-collaboration-at-redfin/)
- [Bradford ClickFORMS — Tools and Services (MLS Import Wizard, comp database)](https://www.bradfordsoftware.com/services/)
- [McKissock — Appraisal Adjustments: Types, Methods, and Cheat Sheet](https://www.mckissock.com/blog/appraisal/appraisal-adjustments-types-methods-and-cheat-sheet/)
- [Working RE — A Spreadsheet Solution for Estimating GLA Adjustments (regression slope method)](https://www.workingre.com/a-spreadsheet-solution-for-estimating-gla-adjustments/)
- [Fannie Mae Selling Guide B4-1.3-09, Adjustments to Comparable Sales](https://selling-guide.fanniemae.com/sel/b4-1.3-09/adjustments-comparable-sales)
- [Fannie Mae — Market Condition Adjustments (PDF)](https://singlefamily.fanniemae.com/media/40241/display)
- [Fannie Mae — Appraiser Update](https://singlefamily.fanniemae.com/originating-underwriting/appraisers/appraiser-update)
- [PennyMac 25-07 — Reminder: Fannie Mae Appraisal Time Adjustment Requirements](https://corr.pennymac.com/announcements/announcement-25-07)
- [Appraisal Buzz — Understanding Fannie Mae's New Market Conditions Adjustments Policy](https://appraisalbuzz.com/understanding-fannie-maes-new-market-conditions-adjustments-policy/)
- [SAMCO — Bracketing](https://samco-amc.com/blog/bracketing)
- [Interagency Appraisal and Evaluation Guidelines, December 2010 (FDIC FIL-82-2010, PDF)](https://www.fdic.gov/news/news/financial/2010/fil10082a.pdf)
- [Interagency Appraisal and Evaluation Guidelines (Federal Register, 75 FR 77450)](https://www.federalregister.gov/documents/2010/12/10/2010-30913/interagency-appraisal-and-evaluation-guidelines)
- [FAQs on the Appraisal Regulations and the Interagency Guidelines (Federal Reserve)](https://www.federalreserve.gov/frrs/guidance/frequently-asked-questions-on-the-appraisal-regulations-and-the-interagency-appraisal-and-evaluation-guidelines.htm)
- [FDIC FIL-76-2018 — Appraisal Threshold for Residential Real Estate Loans](https://www.fdic.gov/news/financial-institution-letters/2018/fil18076.html)
- [Real Estate Appraisals final rule, $400,000 residential threshold (Federal Register, 2019)](https://www.federalregister.gov/documents/2019/07/24/2019-15708/real-estate-appraisals)
- [OCC NR 2018-33 — $500,000 commercial real estate appraisal threshold](https://occ.gov/news-issuances/news-releases/2018/nr-ia-2018-33.html)
- [2024 USPAP Standards 1–4 (PDF)](https://www.mvfairhousing.com/pdfs/hudpolicies/2024_USPAP_STANDARDS_1-4.pdf)
- [McKissock — 7 Key Considerations for Using a Restricted Appraisal Report](https://www.mckissock.com/blog/appraisal/7-key-considerations-for-using-a-restricted-appraisal-report/)
- [Quality Control Standards for Automated Valuation Models — final rule (Federal Register)](https://www.federalregister.gov/documents/2024/08/07/2024-16197/quality-control-standards-for-automated-valuation-models)
- [CFPB — AVM quality control standards small entity compliance guide (PDF)](https://files.consumerfinance.gov/f/documents/cfpb_quality-control-standards-for-avm-small-entity-compliance-guide_2024-10.pdf)
- [OCC Bulletin 2024-17 — Quality Control Standards for AVMs](https://www.occ.gov/news-issuances/bulletins/2024/bulletin-2024-17.html)
- [Alston & Bird — AVM Quality Control Rule Takes Effect October 1, 2025](https://www.alston.com/en/insights/publications/2025/09/avm-quality-control-rule-takes-effect-october-1-20)
- [Veros — Understanding the MISMO® Common Confidence Score (CCS) for AVMs](https://www.veros.com/understanding-the-mismo-common-confidence-score-ccs-for-avms)
