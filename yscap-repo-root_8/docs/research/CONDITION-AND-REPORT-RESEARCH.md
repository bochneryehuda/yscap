# Condition, Quality, and the Comparable Report

*Research, 2026-08-03. Answers two owner asks that turned out to be one problem twice.*

> **Ask A** — *"We need a lot of logic to understand every comparable's condition. For single
> families I believe it's the traditional C1 C2 C3, and for multi-family it's good / average /
> great / whatever. Look through the XML understanding."*
>
> **Ask B** — *"Pick comps into a report, make adjustments, and print a nicely branded PILOT
> comparable report with full detail on every comp, in several layouts."* Plus a quick mode:
> *"Type an address and a few basics, and tell me roughly what properties like this have been
> appraising at recently, in this condition, in this area."*

**The owner is right, and half-right in an instructive way.** There *are* two vocabularies. But
the split is **by FORM, not by property type** — a 2–4 family appraised on a Form 1025 carries
words because the 1025 is not a UAD form; that same 2–4 family appearing as a *comparable* on a
1004 grid carries `C3`. A condo on a 1073 carries `C3` like a single family. §A1.2 is the whole
answer, and it is the thing to build against.

**How to read this document.** Part A is the vocabulary, the measurement of what we actually hold,
and the mapping table. Part B is the report and the adjustments, including an adversarial review of
`src/lib/research/valuation.js` that found a **defect capable of pre-filling a +48% adjustment onto
a comparable**. Nothing here changes code; it is a specification and a bug register.

**Companions, and what each already owns** — read them rather than duplicating them:

| Document | Owns |
|---|---|
| `docs/appraisal-xml/mismo-uad-spec-reference.md` | The verbatim C1–C6 / Q1–Q6 definitions, the bath `full.half` convention, the MISMO 2.6 container map |
| `docs/appraisal-xml/field-validation-rules.md` | The per-field accept/reject rules **and the real non-UAD strings seen in our own corpus** |
| `docs/appraisal-xml/1025-SmallIncome-field-map.md` | What a 1025 actually carries, path by path |
| `docs/research/AVM-BUILDER-RESEARCH.md` | The grid data model, the adjustment-derivation method spec, the report page list, the regulatory frame |
| `docs/research/APPRAISAL-FACT-COVERAGE-AUDIT.md` | Findings F1–F10, of which **F2 (condition is UAD-only)** is this document's starting point |
| `docs/research/WHERE-THIS-IS-GOING.md` | Why an AVM is not reachable, and why the adjustment corpus is |
| `docs/research/RESEARCH-WAREHOUSE-HANDOFF.md` | How the warehouse works and what breaks it |

---

# PART A — READING CONDITION AND QUALITY

## A1. The actual vocabularies

### A1.1 UAD 2.6 — the scale our whole corpus speaks

Two ordinal scales, defined in **UAD Appendix D** and restated in policy form in **Fannie Mae
Selling Guide B4-1.3-06**. Both **run backwards**: 1 is best, 6 is worst. This is already a standing
rule in `CLAUDE.md` and it is the single most common way to get this wrong.

**Condition — what shape the building is in TODAY. It changes with maintenance and renovation.**

| Code | Rank | What it literally means (Fannie B4-1.3-06) | Plain words |
|---|---|---|---|
| `C1` | 1 (best) | Recently constructed, **never previously occupied**; entire structure and all components new; **no physical depreciation** | Brand new, nobody has lived in it |
| `C2` | 2 | **No deferred maintenance**, little or no physical depreciation, **no repairs required**; virtually all components new or recently repaired/refinished/rehabilitated; outdated finishes replaced to current standards | Like new — or gutted and rebuilt inside the last ~3 years |
| `C3` | 3 | **Well maintained**, limited physical depreciation from normal wear and tear; *some* components may be updated or recently rehabilitated, but not every major component | The normal, healthy, marketable house |
| `C4` | 4 | **Some minor deferred maintenance** and deterioration from normal wear; adequately maintained; requires only minimal repairs and cosmetic work; all major components functionally adequate | Lived in, tired, nothing broken |
| `C5` | 5 | **Obvious deferred maintenance**, in need of **some significant repairs**; livability somewhat diminished, but the dwelling **remains useable and functional** | Needs real work, still a house |
| `C6` | 6 (worst) | **Substantial damage or deferred maintenance** with defects **severe enough to affect safety, soundness, or structural integrity**; needs substantial repair of many or most major components | Not liveable |

Two rules that carry consequences:

- **`C6` is contagious.** *"If any portion of the dwelling is rated a C6, the whole dwelling must be
  rated a C6."* A C6 is a **non-overridable fatal at UCDP** (edit FRE4645) and the property is GSE-
  ineligible until repaired to at least C5. `extract.js` already warns `condition_c6`.
- **The rating is ABSOLUTE, not relative to the market.** A C4 in Alpine, NJ and a C4 in Paterson
  describe the same physical state. That is exactly what makes the scale usable as a search filter
  across towns — and it is why a *worded* rating, which is almost always relative to its own
  neighbourhood, cannot simply be swapped in for it (§A4.3).

**Quality of construction — how it was BUILT. It is fixed at construction and does not improve
with maintenance.**

| Code | Rank | What it literally means | Plain words |
|---|---|---|---|
| `Q1` | 1 (best) | Architect-designed **unique** structures; exceptional workmanship, high-grade materials, refinements and ornamentation; usually from detailed architectural plans | One-of-a-kind, architect-built |
| `Q2` | 2 | **Custom** designed for the owner's site or a high-quality development; design, workmanship, materials and ornamentation all high or very high | Custom, high end |
| `Q3` | 3 | Above-standard development or owner's site; significant exterior ornamentation, well-finished interiors; workmanship exceeds acceptable standards; materials upgraded from stock | Better than builder-grade |
| `Q4` | 4 | **Standard or modified** building plans; adequate ornamentation, some interior refinement; mostly stock/builder-grade with a few upgrades; meets or exceeds code | The typical tract home |
| `Q5` | 5 | **Economy of construction and basic functionality** as the main considerations; plain design, basic finishes, minimal ornamentation; meets minimum code; inexpensive stock materials | Cheap but proper |
| `Q6` | 6 (worst) | **Basic quality, lower cost**; some not suitable for year-round occupancy; simple plans or none; lowest-quality materials; often built by the unskilled; mechanical systems may be minimal or absent | Barely a building |

`Q6` is likewise a non-overridable UCDP fatal, and `extract.js` warns `quality_q6`.

**Condition and quality are independent.** A Q2 custom house neglected for thirty years is
`Q2 / C5`. Nothing in the mapping layer may let one imply the other.

### A1.2 WHICH FORMS ACTUALLY CARRY THE CODES — the crux of the owner's question

UAD compliance was mandated from **1 September 2011** for exactly **four** GSE forms. Everything
else must still be delivered to UCDP as MISMO XML, but is **not required to be UAD-formatted** —
so its condition and quality lines are the appraiser's own words.

| Form | Name | UAD-required? | Condition / quality on the sales grid |
|---|---|---|---|
| **1004** / FRE 70 | Uniform Residential Appraisal Report (1-unit) | **YES** | `C1`–`C6`, `Q1`–`Q6` |
| **1073** / FRE 465 | Individual **Condominium** Unit | **YES** | `C1`–`C6`, `Q1`–`Q6` — *a condo is UAD, exactly like a house* |
| **1075** / FRE 466 | Exterior-only condominium | **YES** | `C1`–`C6`, `Q1`–`Q6` |
| **2055** | Exterior-only 1-unit | **YES** | `C1`–`C6`, `Q1`–`Q6` |
| **1025** / FRE 72 | **Small Residential Income (2–4 unit)** | **NO** | **Free text.** "Good", "Average", "Avg-Good", "Fair", or a C-code the vendor's software volunteers |
| **1004C** | Manufactured home | NO | Free text |
| **2090 / 2095** | Co-operative unit | NO | Free text |
| **1050 / 2000 / 1004D / 1007 / 216** | Land, review, update, rent schedule, operating income | NO | n/a or free text |

**So the owner's mental model, corrected:**

- *"For single families it's the traditional C1 C2 C3"* — **right**, and also for condos.
- *"For multi-family it's good / average / great"* — **right about what you see, for the reason you
  did not name.** It is not that 2–4 families are rated on a different scale. It is that the FORM a
  2–4 family gets appraised on (the 1025) was never brought into UAD, so nothing forces the
  appraiser to write a code. Many vendors write `C3` on a 1025 anyway, out of habit — **our own
  corpus shows exactly that** (§A2). So a 1025 is *mixed*, not *worded*.
- The same 2–4 family used as a **comparable on a 1004** appears with a `C`-code, because the
  1004's grid is UAD. **The same building can therefore be `C4` in one report and "Average" in
  another, and both are correct.** Nothing but a mapping layer reconciles that, and that is the
  whole reason this document exists.

### A1.3 Where free text turns up even on a UAD form

Four places, all of which we can see today:

1. **A vendor that fills the UAD slot with a word.** `SALE_PRICE_ADJUSTMENT[_Type="Condition"]
   /@_Description` is a free string in the schema; the *policy* says it must be a C-code, but the
   XML does not enforce it. Our corpus (`docs/appraisal-xml/field-validation-rules.md`) contains
   `"GOOD"`, `"Good"` and `"Avg-Good"` in that slot on real files.
2. **A decoy in the QUALITY slot.** The same corpus contains
   **`Q = "BRICK"`** — a wall *material* written into the quality field. A mapping layer that
   guesses will map that to something. It must not.
3. **The condition NARRATIVE**, `PROPERTY_ANALYSIS[_Type="PropertyCondition"]/@_Comment`, present
   on roughly **9 of 10** of our 1025s and routinely stating **both** ratings at once:
   > `"C4 ... as-is value. C3 for As repaired value ..."`

   This is the single most valuable unmined string in the corpus (§A3.3) and **`extract.js` does
   not read it at all** — the `PROPERTY_ANALYSIS` loop at `src/lib/appraisal/extract.js:590`
   handles only `PhysicalDeficiency` and `AdverseSiteConditions`.
4. **1025 rent comparables.** `MULTIFAMILY_RENTAL/RENTAL_FEATURE[_Type="Condition"]/@_Description`
   is free text by design (`docs/appraisal-xml/1025-SmallIncome-field-map.md:265`). `extract.js`
   only *counts* `MULTIFAMILY_RENTAL` grids (line 1040); it never reads their feature lines. This
   is the literal "multi-family says words" case the owner described.

### A1.4 What a 1025 and a 1073 carry, versus a 1004

| | 1004 (1-unit) | 1073 (condo) | 1025 (2–4 unit) |
|---|---|---|---|
| Subject C/Q source | seq-0 `COMPARISON_DETAIL/@GSEOverallConditionType`, fallback seq-0 `SALE_PRICE_ADJUSTMENT[Condition]/@_Description` | same | same **paths**, but the values may be words |
| Are the codes mandated? | Yes | Yes | **No** |
| `LivingUnitCount` | `1` | **blank — imply 1** | `2`/`3`/`4` |
| Grid area element | Gross **living** area | Gross living area | often Gross **BUILDING** area under the same element → `gla_basis='gba'` |
| Extra payload | — | project/HOA/floor | `_UNIT_GROUP` per-unit breakdown, whole `INCOME_ANALYSIS` (GRM, income value), `UNIT_RENT_SCHEDULE`, up to 3 `MULTIFAMILY_RENTAL` comps, per-unit `ROOM_ADJUSTMENT` rows |
| Condition narrative | sometimes | sometimes | **~9/10, and usually states as-is AND as-repaired** |

The `gla_basis` difference is not a footnote: it means **a 1025 comparable's price-per-foot is not
comparable to a 1004 comparable's**, and §B4 shows that our rate engine currently pools them.

### A1.5 MISMO 2.6 versus MISMO 3.x

| | MISMO 2.6 / UAD 2.6 (**everything we hold**) | MISMO 3.x / UAD 3.6 (the redesign) |
|---|---|---|
| Shape | Attribute-heavy, namespace-free, one `VALUATION_RESPONSE`/`REPORT`, whole PDF embedded as base64 | Namespaced element containers; a different document entirely |
| Subject condition | `COMPARISON_DETAIL/@GSEOverallConditionType` on the **seq-0** comparable (the subject column) | Explicit reconciliation-level condition fields |
| Comp condition | Same attribute per comp, or `SALE_PRICE_ADJUSTMENT[_Type="Condition"]/@_Description` | Structured per-property |
| Quality | `@GSEQualityOfConstructionRatingType`, or `SALE_PRICE_ADJUSTMENT[_Type="Quality"]` | Split into **interior** and **exterior** ratings that reconcile to an overall |
| Our reader | `src/lib/appraisal/extract.js` | **Refuses by name** — `extract.js:845` |

`extract.js:58` is the whitelist that governs everything downstream:

```js
const UAD_C = /^C[1-6]$/, UAD_Q = /^Q[1-6]$/;
```

### A1.6 What UAD 3.6 / the redesigned URAR changes, and when

The GSEs (with FHA aligned) replace **every** current form — 1004, 1025, 1073, 2055, 70, 465, 442,
1004D, 1007, 216 — with **one dynamic URAR** that adapts to 1–4 units and to every valuation
approach. Timeline:

| Date | Event |
|---|---|
| 8 Sep 2025 | Limited production for approved lenders |
| **26 Jan 2026** | **Broad production** — any lender may submit 3.6 alongside 2.6 |
| **2 Nov 2026** | **UAD 3.6 mandatory** for new GSE submissions |
| May 2027 | UAD 2.6 fully retired |

What matters for the mapping layer:

1. **`C1`–`C6` and `Q1`–`Q6` survive.** The scale is not replaced. Our ordinal is safe.
2. **Condition becomes multi-level.** The redesigned URAR captures an **exterior** condition, an
   **interior** condition, **per-kitchen and per-bathroom** condition, and then an **overall**
   condition rating in the Reconciliation section. Our `condition_uad` maps to the **overall**
   one — nothing else.
3. **Quality becomes interior + exterior → overall**, reconciled the same way.
4. **The kitchen/bath update vocabulary is GONE.** `NotUpdated` / `Updated` / `Remodeled` — which
   `extract.js` parses today into `appraisals.updates` — is replaced by a structured
   update-status + timeframe + condition + comment per room. Our `CONDITION_DETAIL` reader will
   read nothing from a 3.6 file.
5. **The reconciliation carries BOTH an "As Is" overall condition AND a "Condition Subject to
   Repair" rating.** This is the single best thing in 3.6 for this lender: the as-is/as-repaired
   ambiguity that §A3.3 has to solve by reading prose becomes a structured field.
6. **The form number disappears**, so `form_type` stops being the signal for "is this UAD?". The
   mapping layer must key on the *value*, never on the form — which is how §A4 is designed.

**Business-purpose loans do not go to the GSEs, so nothing forces 3.6 onto a YS file.** But our
appraisers write for the whole market and will switch their software. **Count the
`uad36_unsupported` refusals from today** — that number is the business case for a 3.6 reader, and
it is the number nobody is watching.

---

## A2. WHAT WE ACTUALLY HOLD — measured

**Measured against the live database** `postgres://ysapp:ysapp@127.0.0.1:5432/ysmerge`, one atomic
`REPEATABLE READ` snapshot at **2026-08-03 04:26:56 UTC**. Method in the Appendix.

> ### ⚠️ Read this caveat before quoting any number below
>
> `npm test` was running against `ysmerge` during measurement (the row counts moved under the first
> queries; the snapshot below is internally consistent because it was taken in one transaction).
> **This database is the test-suite database, and a large part of the corpus is synthetic fixture
> data** written by `scripts/lib/research-xml-fixture.js` and by direct SQL inserts in test suites.
> The sibling database `ystest` is *entirely* fixture data (304 observations, every condition `C3`
> or `C4`, every quality `Q4`, zero worded ratings) and is shown only as a control.
>
> So: **the SHAPE below is real and diagnostic. The DISTRIBUTION is not a production
> distribution.** Specifically, "only 2 worded conditions in the whole corpus" is a statement about
> fixtures, not about the field. The right response is to re-run the Appendix queries against
> production before sizing the work — and, more importantly, that the **structural** findings in
> §A3 come from reading the code, not the sample, and hold regardless.

### A2.1 Corpus totals

| | Count |
|---|---|
| `appraisals` (loan-file reports) | 71 |
| `appraisal_comparables` (loan-file comp rows) | 10 |
| `properties` | 104 |
| `property_observations` | 137 |
| `property_sales` | 62 |
| `property_photos` | **0** |
| `appraisers` | 16 |
| **adjustment lines inside `property_observations.adjustments`** | **599** |

Observations by door — `property_observations` is the only table that sees both:

| Door | Comparable | Subject |
|---|---|---|
| Loan file (`appraisal_id` set) | 12 | 8 |
| Standalone XML upload (`import_id` set) | 75 | 42 |
| **Orphaned** (both NULL — the loan file was deleted) | **10** | **12** |

Those 22 orphans are the `ON DELETE SET NULL` rule (`db/409`) doing exactly its job: the loan file
is gone, the market knowledge survived.

### A2.2 CONDITION coverage, by form type and by subject-vs-comparable

| Form | Role | n | UAD code | text only | **neither** |
|---|---|---|---|---|---|
| FNM1004 | comparable | 72 | 68 (94%) | **2** | 2 |
| FNM1004 | subject | 45 | 43 (96%) | 0 | 2 |
| FNM1025 | comparable | 11 | **11 (100%)** | 0 | 0 |
| FNM1025 | subject | 6 | **6 (100%)** | 0 | 0 |
| FNM1073 | subject | 3 | 0 | 0 | **3 (100%)** |
| **All** | | **137** | **128 (93%)** | **2 (1.5%)** | **7 (5%)** |

**`both` is zero across every cell** — no observation carries a code and a word together. That is a
structural fact, not a coincidence: `extract.js:298` writes to one column or the other, never both.

### A2.3 QUALITY coverage, same cut

| Form | Role | n | UAD code | text only | **neither** |
|---|---|---|---|---|---|
| FNM1004 | comparable | 72 | 62 (86%) | 0 | **10** |
| FNM1004 | subject | 45 | 38 (84%) | 0 | 7 |
| FNM1025 | comparable | 11 | 11 | 0 | 0 |
| FNM1025 | subject | 6 | 6 | 0 | 0 |
| FNM1073 | subject | 3 | 0 | 0 | 3 |
| **All** | | **137** | **117 (85%)** | **0** | **20 (15%)** |

**Quality is `text_only = 0` everywhere.** That is not evidence that quality is always coded — it is
evidence that we have not yet imported a report whose quality slot held a word. When we do, the
`"BRICK"` case in §A1.3 is what arrives.

### A2.4 The distinct strings — the real problem statement

**Condition, `property_observations`:**

| `condition_uad` | n | | `condition_text` | n |
|---|---|---|---|---|
| `C3` | 89 | | *(null)* | 135 |
| `C4` | 35 | | **`Avg-Good`** | **2** |
| *(null)* | 9 | | | |
| `C2` | 3 | | | |
| `C5` | 1 | | | |

**Quality:** `Q4` × 115, *(null)* × 20, `Q3` × 2. **`quality_text` is null on all 137 rows.**

**`appraisal_comparables`** (the loan-file slice, n=10): `C4` × 5, `C3` × 5, `condition_text` null
on all 10, `quality_text` null on all 10.

**Two things this list says, and one thing it does not.**

- It says the **code side works**: 93% of observations carry a clean C-code, and the whole observed
  code vocabulary is `C2 C3 C4 C5` / `Q3 Q4` — no junk, no casing variants, no `C-3`, no `3`.
- It says the **text side is currently a stub**: exactly one distinct string (`Avg-Good`) has ever
  reached `condition_text`, because that column was added only weeks ago (audit finding F2) and the
  back-corpus has not been re-parsed through it.
- **It does not say the free-text problem is small.** The strings we already know exist in our own
  files — `"GOOD"`, `"Good"`, `"Avg-Good"`, `"Average"`, `"BRICK"` — are documented in
  `docs/appraisal-xml/field-validation-rules.md` from a manual read of the real corpus, and only
  one of the five has ever reached a database column. **The mapping table in §A4.2 is built for the
  documented corpus, not for the two rows we happen to have loaded.**

### A2.5 Basis — as-is versus as-repaired

| Role | Basis | n |
|---|---|---|
| comparable | `as_is` | 83 (100%) |
| subject | `as_is` | 50 |
| subject | **`as_repaired`** | **4** |

Meanwhile, on `appraisals`: **`condition_of_appraisal = 'SubjectToRepairs'` on 54 of 71 rows
(76%)**, `AsIs` on 8, null on 9.

**That gap is the loudest number in this document.** Three quarters of the reports we import are
renovation reports whose subject condition describes a house that does not exist yet — and the
warehouse currently records only 4 subject observations as `as_repaired`. Most of those 54 reports
have no subject observation at all in this snapshot (fixtures inserted without addresses), so this
is *not yet* proof of a bug in `ingest.conditionBasis` — but it is the first thing to re-measure on
production, and if the ratio persists it means the `AS_IS_ONLY` roll-up guard is not firing on the
files it exists for.

### A2.6 What the SEARCH can actually see

| `properties` (n=104) | Count |
|---|---|
| Condition **filterable** (`condition_rank` not null) | 92 (88%) |
| Condition **known as a word but invisible to every filter** | **2** |
| Condition genuinely unknown | 10 |
| Quality filterable | 84 (81%) |
| **Carrying any `property_type` at all** | **46 (44%)** |

`src/lib/research/search.js:199-209` filters exclusively on `condition_rank` / `condition_uad`.
**A property whose condition we hold only as a word is excluded from every condition search AND
from the condition facet counts — silently.** At 2 rows that is a rounding error. On a 1025-heavy
production corpus it is the majority of the 2–4 family book, and the screen will report a confident
facet count that is simply wrong.

### A2.7 The comparable pool the rate engine reads from

Of **83 comparable observations**:

| Contamination | Count | Why it matters |
|---|---|---|
| `gla_basis = 'gba'` (gross **building** area, not living area) | **6 (7%)** | Their price-per-foot is not comparable to a 1004's, and §B4 shows nothing filters it |
| `sale_status <> 'closed'` (a listing) | 2 | Correctly excluded from rates; **not** excluded from the reconciled value (§B4.6) |
| On the **ARV grid** (`comp_set='arv'`) | 7 (8%) | Chosen to support an *after-repair* value; pooled with as-is comps by `ratesFor` |
| `comp_set` was **defaulted**, not determined (`single_grid`) | **67 (81%)** | "As-is comps" mostly means "the only grid on the report" |
| `sale_type` unknown | 10 | No distressed-sale filter is even possible |
| **`property_type` NULL on the observation** | **83 (100%)** | By design — never inherited from the subject |
| …and on the joined `properties` roll-up | **0 of 83 have one** | So the `property_type` filter in `ratesFor` returns *nothing* if used, and pools everything if not |

---

## A3. THE FIVE STRUCTURAL GAPS

These come from reading the code, not from the sample, so they are true whatever production looks
like. They are ordered by how much money a wrong answer moves.

### A3.1 A SUBJECT'S WORDED CONDITION IS STRUCTURALLY UNRECOVERABLE

`src/lib/appraisal/extract.js:459` — `subjectCQ()`:

```js
if (cRaw && UAD_C.test(cRaw)) out.conditionUad = cRaw; else if (cRaw) out.cqNonUad = true;
```

The word is tested, found not to be a code, **and dropped**. All that survives is a boolean, which
becomes the warning `nonuad_cq` at `extract.js:1048`.

It could not be stored even if it were kept: **the `appraisals` table has no `condition_text` or
`quality_text` column.** Verified against the live schema — the condition/quality columns on
`appraisals` are exactly `condition_uad`, `quality_uad`, `condition_of_appraisal`,
`cost_quality_rating`, plus three unrelated comment fields.

And so `src/lib/research/ingest.js:871` writes, for **every** subject, unconditionally:

```js
condition_uad: txt(a.condition_uad), condition_text: null,
quality_uad:   txt(a.quality_uad),   quality_text: null,
```

**Consequence.** The audit's finding F2 was fixed for comparables and *not* for subjects. Our own
borrower's property — the one we are lending on — is the one property whose worded condition we
throw away. On a 1025 that is the common case.

**Fix:** two columns on `appraisals`, keep the string in `subjectCQ`, carry it in `ingest`. Three
lines and a migration.

### A3.2 A COMPARABLE'S CONDITION IS RECOVERABLE TWICE OVER AND IS READ ONCE

`extract.js:296-299` reads `SALE_PRICE_ADJUSTMENT[_Type="Condition"]/@_Description`;
`extract.js:321-330` falls back to `COMPARISON_DETAIL/@GSEOverallConditionType`. Good. But the
**adjustment line is also stored whole**, and its `description` carries the comp's own rating:

```json
{ "type": "Condition", "amount": 0, "description": "C4" }
```

Measured: **73 of 137 observations carry a `Condition` adjustment line, and all 73 have a
description.** So the jsonb blob is a second, independent copy of the same fact — which means a
back-fill can repair `condition_uad`/`condition_text` on already-ingested rows **without
re-parsing a single XML file**. Same for `Quality` (73 lines, all described), `Age` (75),
`GrossLivingArea` (67), `Site` (69), `Design` (67).

*(In this fixture corpus the recovery yield is 0, because the 9 rows missing a code are the
FNM1073 rows that carry no adjustment grid either. On production this is the cheapest repair
available.)*

### A3.3 THE CONDITION NARRATIVE — THE BEST SOURCE WE HAVE, AND WE DO NOT READ IT

`PROPERTY_ANALYSIS[_Type="PropertyCondition"]/@_Comment`, present on ~9 of 10 of our 1025s
(`docs/appraisal-xml/1025-SmallIncome-field-map.md:131`), routinely stating both ratings:

> `"C4 ... as-is value. C3 for As repaired value ..."`

`extract.js:590-594` iterates `PROPERTY_ANALYSIS` and handles only `PhysicalDeficiency` and
`AdverseSiteConditions`. **The condition narrative is never touched.**

**Why this is the highest-value fix in Part A.** The roll-up's `AS_IS_ONLY` guard
(`ingest.js:197`) *correctly* refuses to let an as-repaired rating become
`properties.condition_uad` — which means that on a renovation file the warehouse ends up with
**no current condition at all** for the subject. The narrative is the one place the as-is rating is
actually written down. Mining it turns "we know nothing about this house's condition" into "the
appraiser said C4 as-is, C3 after the work."

**But it is prose, so it must be mined the way `as-is-reader.js` mines the As-Is value** — a
deterministic, labelled, verbatim-quoted read that abstains rather than guesses:

- accept only `C[1-6]` adjacent to an explicit basis word (`as-is`, `as is`, `as repaired`,
  `as complete`, `subject to`);
- require the basis word within a small window of the code;
- refuse when both readings land on the same code, or when the as-is code is *better* than the
  as-repaired one (that is a parse error — repairs do not make a house worse);
- store the verbatim sentence beside the code, always, so a human can check it in one glance.

### A3.4 THE SEARCH CANNOT SEE A WORDED CONDITION

`search.js:199-209`. Covered in §A2.6. The fix is not to loosen the filter — it is to give every
property a **mapped ordinal** (§A4) and filter on that, while continuing to display the original
string.

### A3.5 UAD 3.6 IS A CLIFF, NOT A SLOPE

`extract.js:845` refuses a 3.6 file with a clear message — which is right. But the refusal is
counted nowhere. **Add a counter today**, before 2 November 2026 arrives, so the decision to build a
3.6 reader is made on a number rather than on a surprise.

---

## A4. THE MAPPING LAYER

### A4.1 The shape — one ordinal, three columns, never a lie

One new pure module, `src/lib/research/condition-scale.js`, mirroring the discipline of
`src/lib/research/property-key.js`: **pure, offline, deterministic, no database, never throws.**

For any (condition-ish string, quality-ish string) it returns:

```js
{
  code:        'C4' | null,   // the UAD code, ONLY when one was literally stated
  rank:        1..6 | null,   // the comparable ordinal — 1 best, 6 worst
  rankLow:     1..6 | null,   // a worded rating that spans two grades keeps its span
  rankHigh:    1..6 | null,
  basis:       'stated' | 'mapped' | 'unmapped',
  source:      'uad_code' | 'word' | 'narrative' | 'adjustment_line',
  original:    'Avg-Good',    // ALWAYS kept verbatim, always displayed
  confidence:  'exact' | 'strong' | 'weak',
  why:         'the appraiser wrote a UAD code' | 'mapped from the word "Avg-Good"' | 'not a condition rating'
}
```

Four rules, and each one is load-bearing:

1. **`code` is only ever set from a literal code.** A mapped word gets a `rank`, never a `code`.
   Anything that prints "C3" must be able to prove an appraiser wrote "C3", or the warehouse starts
   manufacturing UAD compliance data.
2. **`rank` is the only thing anything filters, sorts, brackets or adjusts on.** Both codes and
   mapped words land there, so a 1025 comp finally becomes searchable — with `basis` travelling
   alongside so a screen or a report can say which it is.
3. **A word that spans two grades keeps its span.** "Average" is honestly `C3`–`C4`. Collapsing it
   to one grade invents precision. `rank` gets the midpoint for ordering, `rankLow`/`rankHigh` carry
   the truth, and any adjustment derived across a spanned rating is flagged.
4. **`original` is never discarded and is always rendered.** The screen shows
   `Average (mapped to C3–C4)`, never a bare `C3`.

### A4.2 THE MAPPING TABLE

**Condition.** Every string below is either observed in our own corpus (marked ✔), or is a standard
appraisal-trade word certain to appear once the back corpus lands. Matching is
case-insensitive, trims whitespace, collapses internal runs of whitespace, and normalises
`-`/`/`/`to` separators — **and nothing else. No stemming, no fuzzy matching, no edit distance.**

| Observed string | → rank | low–high | Confidence | Note |
|---|---|---|---|---|
| `C1` … `C6` ✔ | 1…6 | exact | **exact** | The code. `basis:'stated'` |
| `c3`, ` C3 `, `C-3`, `C 3` | 3 | exact | exact | Same code, spelled loosely. Normalise, do not guess |
| `New`, `Brand new`, `New construction` | 1 | 1–1 | strong | Matches C1's literal definition |
| `Excellent` | 2 | 1–2 | strong | Trade word for "no deferred maintenance" |
| `Very good` | 2 | 2–3 | strong | |
| `Good` ✔, `GOOD` ✔ | 3 | 2–3 | strong | **See the money flag below — this is the dangerous one** |
| `Avg-Good` ✔, `Average-Good`, `Avg/Good`, `Good/Average`, `Average to Good` | 3 | 3–4 | strong | Straddles by construction; span is the honest answer |
| `Average` ✔, `Avg`, `Typical`, `Normal` | 4 | 3–4 | strong | See the money flag |
| `Avg-Fair`, `Average/Fair`, `Fair/Average`, `Fair to Average` | 4 | 4–5 | strong | |
| `Fair` | 5 | 4–5 | strong | |
| `Poor` | 6 | 5–6 | strong | |
| `Very poor`, `Uninhabitable`, `Unsound`, `Not habitable`, `Tear-down`, `Teardown`, `Shell` | 6 | 6–6 | strong | Matches C6's safety/soundness language |
| `C3/C4` ✔-style, `C4/C5`, `C3-C4` | midpoint | as written | strong | An explicit range the appraiser wrote. Keep it as a range |
| `C4+`, `C3-` | base rank | base±1 | **weak** | The appraiser meant "a bit better/worse". Store the span, do not resolve |
| `Updated`, `Renovated`, `Remodeled`, `Rehabbed` | **NULL** | — | — | **Describes WORK, not condition.** See §A4.3 |
| `Dated`, `Original`, `Original condition` | **NULL** | — | — | Describes vintage/finish, not physical state |
| `Well maintained`, `Well kept` | **NULL** | — | — | Verbatim C3 wording — but it is also what an agent says about a C5. Too weak to move money |
| `Habitable`, `Liveable`, `Livable` | **NULL** | — | — | Spans C1–C5. Says nothing |
| `Similar`, `Same`, `Equal`, `Comparable`, `=` | **NULL** | — | — | **RELATIVE to the subject, not absolute.** §A4.3 |
| `Superior`, `Inferior`, `Better`, `Worse`, `+`, `-` | **NULL** | — | — | Relative. §A4.3 |
| `N/A`, `None`, `--`, `-`, `.`, `TBD`, `See addendum`, `See comments`, `Unknown`, `Not observed` | **NULL** | — | — | Explicitly absent |
| Anything else | **NULL** | — | `basis:'unmapped'` | **Counted**, surfaced, never guessed |

**Quality.** Same normalisation, different words. Quality words are *more* dangerous than condition
words because the quality slot is where the `"BRICK"` decoy lives.

| Observed string | → rank | low–high | Confidence | Note |
|---|---|---|---|---|
| `Q1` … `Q6` ✔ | 1…6 | exact | **exact** | The code |
| `Custom`, `Architectural`, `Architect designed`, `High end`, `Luxury` | 2 | 1–2 | strong | Q1/Q2 language |
| `Excellent`, `Superior quality` | 2 | 2–3 | strong | |
| `Very good` | 3 | 2–3 | strong | |
| `Good` | 3 | 3–4 | strong | Quality "Good" sits lower than condition "Good" — Q4 is the *typical* home, C3 is |
| `Average` ✔, `Avg`, `Standard`, `Typical`, `Builder grade`, `Tract` | 4 | 4–4 | strong | Q4 is literally "standard or modified building plans" |
| `Avg-Good`, `Average/Good` | 4 | 3–4 | strong | |
| `Fair`, `Economy`, `Basic`, `Minimal` | 5 | 5–5 | strong | Q5 is literally "economy of construction and basic functionality" |
| `Poor`, `Substandard`, `Low`, `Lowest` | 6 | 5–6 | strong | |
| **`BRICK`** ✔, `Frame`, `Vinyl`, `Stucco`, `Aluminum`, `Wood`, `Masonry`, `Block`, `Stone`, `Siding` | **NULL** | — | — | **A WALL MATERIAL IN THE QUALITY FIELD.** The documented decoy. Refuse the whole class |
| `Colonial`, `Ranch`, `Cape`, `Split`, `Bi-level`, `Contemporary`, `Victorian`, `Tudor` | **NULL** | — | — | An architectural STYLE, not a quality. Belongs in `design_style` |
| `Similar`, `Same`, `Superior`, `Inferior`, `Equal`, `+`, `-` | **NULL** | — | — | Relative |
| `N/A`, `None`, `--`, `.`, `See addendum` | **NULL** | — | — | Absent |
| Anything else | **NULL** | — | `unmapped` | Counted and surfaced |

**One extra rule that costs nothing and prevents an entire bug class:** if a string maps to a
CONDITION word but arrives in the QUALITY slot (or vice versa), map it in its own slot only. Never
cross-fill. A house can be `Q2 / C5`.

### A4.3 THE STRINGS THAT MUST STAY NULL — and exactly why

This is the part a well-meaning implementation gets wrong, so each refusal is argued.

**1. Every RELATIVE word — `Similar`, `Superior`, `Inferior`, `Same`, `Equal`, `Better`, `Worse`,
`+`, `-`.**
These are the single most common thing written in a **non-UAD grid's** condition line, because the
1025 grid is a *comparison* grid: the appraiser is telling you how the comp compares **to this
report's subject**, not what the comp is. Mapping `Similar` to any absolute rank asserts that two
different reports' subjects were in the same condition — which is exactly the assumption a
cross-file warehouse must never make.

> There is a *legitimate* use for them, and it is not this one: a relative word is real information
> about the **pair**, and it belongs on the observation as `condition_relative` ∈
> `{superior, similar, inferior}`. Once the *subject's* absolute rating is known (§A3.1/§A3.3),
> `Similar` + subject `C4` genuinely implies the comp is about C4 — but that is an **inference from
> two facts**, it must be labelled as such (`source:'relative_to_subject'`, `confidence:'weak'`),
> and it must never be written into `condition_uad`.

**2. `Updated` / `Renovated` / `Remodeled` / `Rehabbed`.**
These describe **work performed**, and a house can be renovated and still be C4 (a cosmetic flip
over a failing roof). Under UAD 2.6 this vocabulary belongs to `CONDITION_DETAIL` — a *different
field* — and under 3.6 it is a structured update-status per room. Mapping it to a condition grade
would let a cosmetic rehab read as C2 on a fix-and-flip file, which is precisely the deal where
being wrong is expensive.

**3. `Well maintained`.** It is verbatim the C3 definition — *and* it is what every listing agent
writes about every house. On a data source we cannot interrogate, a phrase that is simultaneously a
definition and a cliché is not evidence. Leave it NULL and let the human read it.

**4. Every material and every style in the quality slot** (`BRICK`, `Frame`, `Colonial`, `Ranch`…).
Not a scale at all. `BRICK` is documented in our own corpus. Refuse the class, not the instance.

**5. Empty-ish tokens** — `N/A`, `None`, `--`, `-`, `.`, `TBD`, `See addendum`, `See comments`,
`Unknown`, `Not observed`. An appraiser who wrote `See addendum` told us where to look, not what
he saw.

**6. Anything unrecognised.** With a **counter and a review queue**. The list above is
finite and the field is not; `unmapped` must be a number somebody can look at, exactly like
`property_ingest_log.rows_skipped`. An unmapped string that shows up 200 times is a mapping-table
entry waiting to be made **by a human**.

### A4.4 THE STRINGS WHERE A WRONG GUESS MOVES MONEY

Flagged explicitly, because these are where a plausible mapping does real damage.

| String | The trap | What it costs |
|---|---|---|
| **`Good`** | Condition-`Good` is C3-ish (a well-maintained house). Quality-`Good` is Q3–Q4. **Same word, two scales, two answers.** And in a 1025 grid `Good` is often *relative to the subject* | Reading condition-`Good` as C2 makes a tired house look renovated. One condition grade × 1,500 sqft × a derived $12–$18/sqft rate ≈ **$18,000–$27,000** of adjustment, on every comp it touches |
| **`Average`** | The trade uses it for **C3 and C4 interchangeably**, and the two are a full grade apart. C3 is "well maintained"; C4 is "minor deferred maintenance" | Collapsing to C3 systematically *over*-values a 1025 book. Keep the C3–C4 span and refuse to derive a condition adjustment across a spanned rating |
| **`Avg-Good` ✔ / `Good/Average`** | Two words joined by a separator. Which one is the base and which the modifier is genuinely ambiguous | Keep as a **span**, always. Never resolve to a point |
| **`Similar` / `Superior` / `Inferior`** | Reads like a rating; is a *comparison* | A `Similar` mapped to C3 on a report whose subject was C5 puts a **two-grade error** into the warehouse, permanently, and it looks like a fact |
| **`Fair`** | In appraisal usage `Fair` is C5 (needs significant repairs). In everyday usage it means "OK". A non-appraiser implementer will map it to C4 | Under-states the repair burden on exactly the properties this lender buys. Map it to 5, span 4–5 |
| **`BRICK` ✔ (quality slot)** | A material that pattern-matches nothing and will fall into an "unknown → average" default if one exists | This is the reason **there must be no default**. `unmapped` → NULL, always |
| **A subject rating on a `SubjectToRepairs` report** | It is the **after-repair** condition — a house that does not exist yet | Already guarded in the roll-up (`ingest.js:197`, `AS_IS_ONLY`). The mapping layer must carry `condition_basis` through untouched and **must never let a mapped word bypass that guard** |
| **`C4+` / `C3-`** | Looks resolvable | It is a hedge. Store the span, mark `weak`, and refuse to derive an adjustment from it |

### A4.5 Where the code changes land

| Change | File | Size |
|---|---|---|
| The mapping module | **new** `src/lib/research/condition-scale.js` | ~200 lines, pure, fully unit-testable with no DB |
| Keep the subject's word | `src/lib/appraisal/extract.js:459` (`subjectCQ`) | 3 lines |
| Give it somewhere to live | **new migration** — `appraisals.condition_text`, `.quality_text` | 2 columns |
| Carry it | `src/lib/research/ingest.js:871` | 2 lines |
| Mine the narrative | `extract.js:590` + a new pure reader beside `as-is-reader.js` | ~120 lines |
| Read the 1025 rent-comp condition | `extract.js` — `MULTIFAMILY_RENTAL/RENTAL_FEATURE` | ~15 lines |
| Store the ordinal | migration — `property_observations.condition_rank_mapped`, `.condition_rank_low`, `.condition_rank_high`, `.condition_source`, and the quality twins | 8 columns |
| Roll it up | `ingest.js` `ROLLUP_FACTS` + **bump `ROLLUP_VERSION`** (the boot sweep back-fills every existing row — that is the entire migration story) | 8 entries |
| Search on it | `search.js:199-209` — filter on the mapped rank, `COALESCE`d with the code's rank | ~6 lines |
| Show it honestly | `app-v2/src/lib/research.js:49-60` — the label maps become span-aware | ~20 lines |
| Count the unmapped | `property_ingest_log.skip_reasons`, plus a stat on `GET /api/research/stats` | small |

**The back-fill needs no XML re-parse for the code side** — §A3.2 shows the `Condition` /`Quality`
adjustment lines already hold the values in `property_observations.adjustments`.

---

## A5. IS MULTI-FAMILY A DIFFERENT SCALE?

**No. It is the same scale, expressed in words, because the FORM was never brought into UAD.**

**Proof from the spec.**

1. UAD required exactly four forms from 1 Sep 2011 — 1004, 1073, 1075, 2055. The 1025 was
   explicitly among the forms that "must be delivered as XML but are not yet required to be
   UAD-formatted."
2. Fannie B4-1.3-06 — which *defines* C1–C6 and Q1–Q6 — applies the definitions to *the
   improvements*, with **no property-type restriction anywhere in the policy**. There is no
   2–4-family condition scale in any GSE document.
3. The 1025's own XML uses **the identical paths** as the 1004:
   `COMPARABLE_SALE[seq=0]/SALE_PRICE_ADJUSTMENT[_Type="Condition"]/@_Description`
   (`docs/appraisal-xml/1025-SmallIncome-field-map.md:130`). Same container, same attribute — only
   the *value* is unconstrained.
4. UAD 3.6 settles it permanently: **one dynamic URAR covers 1–4 units on one scale**, and the 1025
   ceases to exist on 2 Nov 2026.

**Proof from our own data.**

- **All 17 FNM1025 observations in the warehouse carry a clean UAD code** — 11 comparables and 6
  subjects, 100% coded. If the 1025 were a different scale, these could not exist.
- Their codes come from the same distribution as the 1004s (`C3`/`C4`), not from a private one.
- The only worded ratings we hold (`Avg-Good` × 2) are on **FNM1004** rows, not 1025 rows.

So: the appraiser writing a 1025 is describing the same physical states as everybody else. His
software simply does not force him to encode them, so he writes what he would say out loud —
and *sometimes* it writes the code for him.

**One honest caveat, and it is not about the scale.** Rating a *building* is genuinely harder than
rating a house: a 3-family can have one gut-renovated unit above two originals, and the appraiser
has to publish a single overall figure. That is a **precision** problem, not a **scale** problem. It
argues for showing the unit mix and the per-unit rent roll (which `property_observations.unit_mix`
already holds) beside the rating — not for a second vocabulary.

## A6. WHAT THE UI SHOULD SHOW

Everything below is what the mapping layer makes possible; none of it needs a new data source.

**1. Always show the words the appraiser wrote, with the mapping underneath — never instead of it.**

```
Condition   C4 — average, some wear                 ← code stated
Condition   Average  (reads as C3–C4)               ← mapped, span kept
Condition   "Similar"  — compared to that report's subject, not a rating
Condition   —  not stated
```

The current `app-v2/src/lib/research.js:49-60` maps are right and should stay; they gain a
span-aware and an unmappable branch.

**2. Never show a code we did not receive.** A mapped word renders as its word plus its span. The
badge colour may come from the rank; the text may not.

**3. Say which basis it is, on the same line, always.** `C3 (after repairs)` is a completely
different statement from `C3`. 76% of our reports are subject-to.

**4. On a filter, say what the filter cannot see.**

> *"Condition C3 or better — 41 properties. 6 more hold a worded rating that maps into this range
> and are included. 10 have no condition on file and are not shown."*

That single sentence is the difference between a search result and a search result somebody can
trust.

**5. Show condition and quality as two independent chips, never merged**, and never let one imply
the other.

**6. On a 2–4 family, show the unit mix beside the rating.** `3-family · 2×3BR/1BA + 1×2BR/1BA ·
C4 as-is`. It is already in `unit_mix`.

**7. Give the unmapped strings a home.** A small admin list — *"27 condition ratings we could not
read: `Updated` (11), `Similar` (9), `See addendum` (7)"* — with the report each came from. That is
how the mapping table grows, and it must grow **by a human's decision**, never by an algorithm's.

---

# PART B — THE REPORT AND THE ADJUSTMENTS

## B1. How adjustments are professionally derived, and which are defensible on OUR data

Six methods. `docs/research/AVM-BUILDER-RESEARCH.md` §3 already specifies the arithmetic for the
first three in detail; what follows is the **verdict for our corpus**, which is the part that was
missing.

| Method | What it is | Defensible on our data? |
|---|---|---|
| **Appraiser adjustment lines** | Read what licensed appraisers actually adjusted, on real properties, in our markets | **YES — and it is the only one that is clearly defensible today.** §B2–B3 |
| **Paired sales / matched pairs** | Two near-identical sales differing in one variable; the price gap *is* the market's price for it | **Rarely.** Needs same ZIP, same category, same period, same beds/baths/condition, one variable apart. Our corpus holds **62 distinct sales total**; the qualifying-pair count is in the low single digits per segment. Build it as a **cross-check**, not a source |
| **Regression / hedonic** | Fit price on characteristics | **NO.** Two independent reasons, and the second does not improve with volume: (a) volume — 100–200 clean same-segment sales are needed per segment and our best town produces ~88 SFR sales *a year* at 2,000 appraisals; (b) **the sample is not random** — an appraiser picks comps *because they support the value he is about to write*, so a model learns selection behaviour. Distressed, cash and poor-condition sales are systematically absent, which is exactly the segment a fix-and-flip lender needs |
| **Cost-based** | Marshall & Swift-style replacement cost less depreciation, for the *contributory* value of a feature | **Partially, and it is under-used.** The cost approach is already parsed — `cost_new_total`, `dwelling_cost_new`, `depreciation_physical/functional/external`, `site_improvements_value` (db/448/424). It is the correct basis for a **garage, a deck, a finished basement, a bath addition** — features whose contributory value is genuinely construction cost less depreciation. It is *not* a basis for location, view, or condition |
| **Depreciation** | Physical depreciation ÷ cost new = condition expressed as a percentage | **Yes, as a CROSS-CHECK on the condition adjustment, and this is a genuinely novel use of data we already hold.** `db/424` already treats depreciation as "condition in dollars" and puts it under `AS_IS_ONLY` for exactly that reason. Two reports on similar houses at C3 and C5 with 8% and 24% physical depreciation give an independent read on what a condition grade is worth. **Subject-only** — comps carry no cost approach |
| **Market conditions (time)** | What the market did between the comp's sale and today | **Our own read is the weakest thing in the engine (§B4.1) and the free public fix is not taken.** The **FHFA House Price Index** is published quarterly, free, no licence, by CBSA and by ZIP — it turns a noisy in-house read into a citable number with a stated source. Highest value-per-effort of anything external to this project |

## B2. MEASURED — the adjustment corpus

Same atomic snapshot, `ysmerge`, 2026-08-03 04:26:56 UTC.

| | Count | Ratio |
|---|---|---|
| Distinct sales (`property_sales`) | 62 | 1× |
| Closed comparable observations with a price | 81 | 1.3× |
| **Adjustment LINES** | **599** | **9.7× the sales / 7.4× the priced comps** |
| Adjustment lines per comparable observation | | **7.2** |
| Comparable observations carrying at least one line | 69 of 83 | 83% |

**The "roughly 9× more adjustment rows than sales" claim in `WHERE-THIS-IS-GOING.md` is confirmed
on live data: 9.7×.** The `ystest` control agrees independently — 1,351 lines against 112 sales,
**12.1×**.

**Shape — 24 distinct MISMO line types observed:**

| Line type | n | with a description |
|---|---|---|
| `Age` | 75 | 75 |
| `Condition` | 73 | 73 |
| `Quality` | 73 | 73 |
| `DateOfSale` | 73 | 73 |
| `Site` | 69 | 69 |
| `GrossLivingArea` | 67 | 67 |
| `Design` | 67 | 67 |
| `RoomCount`, `OtherFeature`, `FunctionalUtility`, `FinancingConcessions`, `View`, `GrossBuildingArea`, `BasementFinish`, `BasementArea`, `DesignStyle`, `SalesConcessions`, `PorchDeck`, `Parking`, `Location`, `SiteArea`, `HeatingCooling`, `Other`, `EnergyEfficient` | 6 each | 6 each |

**Two structural facts that matter more than the counts.**

- **Every line carries a `description`, and the description is the COMPARABLE'S OWN VALUE** —
  `{"type":"Condition","description":"C4"}`, `{"type":"GrossLivingArea","description":"1400"}`,
  `{"type":"Age","description":"1965"}`. This is why §A3.2 works, and it is why the adjustment blob
  is simultaneously the adjustment corpus *and* a second copy of the comp's facts.
- **The adjustments live in a jsonb array, not in rows.** Every question worth asking of this
  corpus — *"what did our appraisers pay per square foot in Passaic County last year"* — is a
  `GROUP BY` that currently requires a `jsonb_array_elements` lateral over the whole table. This is
  already the #1 follow-up in `docs/PROPERTY-COMP-DATABASE-RESEARCH.md` §11 and it is the right
  next migration.

**The honest limit of this particular snapshot:** the fixture data has **near-zero dollar amounts**
(`Condition` 6 of 73 non-zero, `GrossLivingArea` 0 of 67). So the *count* is real and the *shape* is
real; the *rates* cannot be measured here. Re-run the Appendix queries on production before
promising a number.

## B3. VERDICT — is "what OUR appraisers actually adjust" a better source than a regression?

**Yes. Emphatically, and for four separate reasons — with one condition attached.**

**1. It is the only one of the two that is available at our volume.** A regression needs 100–200
clean same-segment sales; we have **62 distinct sales** in this database and a projected ~88 per
year in our busiest town. We have **599 adjustment lines** from the same corpus. One of those
numbers supports arithmetic and the other does not.

**2. It is the only one of the two that survives the sampling problem.** This is the argument that
actually decides it. Appraiser-selected comps are a **deliberately non-random sample** — the comp is
on the grid *because it supports the value*. A regression on that sample estimates the appraiser's
selection habit and calls it the market. But **the adjustment lines are not a sample of the market
at all — they are a census of the thing we are trying to measure.** If the question is *"what do
appraisers in this county charge for a square foot?"*, appraiser behaviour is not the bias; it is
the subject.

**3. It changes what we are claiming, and the new claim is one we can defend.** This is the
distinction that must never be blurred:

> ❌ *"A bathroom is worth $12,000 in Paterson."*
> A claim about the market. Our sample cannot support it. On thin data the arithmetic frequently
> returns a **negative** number (measured — §B4.2).
>
> ✅ *"This report used $18 a square foot for living area. The other 40 reports in this county over
> the last 18 months used $45–$70, median $58, from 12 appraisers."*
> A claim about **our own files**, verifiable by opening them, and it makes the reviewer's job
> faster in a way no vendor product does.

That second sentence is essentially what **Fannie Mae's Collateral Underwriter** does — it compares
an adjustment against what other appraisers did on similar properties — and it is why CU is
credible at scale while an AVM says "cannot score" in thin markets.

**4. It is the one thing here nobody else has.** An MLS knows what sold. A public-record vendor
knows what it sold for. **Nobody but us knows what our appraisers adjusted for it.**

### The condition attached: express the uncertainty honestly, or the whole argument fails

**Never a bare number. Always the number, the sample, and the spread.** Concretely:

```
Living area          $58 / sq ft
                     41 grid lines · 12 reports · 7 appraisers · Passaic County · last 18 months
                     middle half of those lines: $45 – $70
                     7 of 48 appraisers made NO living-area adjustment despite a 100+ sq ft gap
```

Six disciplines, each of which is a real failure mode:

1. **Publish `n`, distinct reports, and distinct appraisers separately.** 41 lines from 2
   appraisers is one person's habit.
2. **Publish the interquartile range, never a standard deviation.** These distributions are not
   normal; the IQR is honest and a σ implies a model.
3. **Count the DECLINES, and show them.** An appraiser who saw a 200 sq ft gap and adjusted $0 made
   a *judgement*, not a rate of zero. Excluding them silently biases the rate upward; including them
   as zeroes biases it down. **Report both numbers.**
4. **Cap any one appraiser's influence.** If one `appraiser_id` supplies >40% of the lines, the
   confidence is `weak` and the screen says whose habit it is.
5. **Refuse below the floor, with the reason** — the existing `deriveMarketRates` discipline, which
   is right and should be extended, not relaxed.
6. **Never let a derived rate size a loan.** `as_is_value` and `arv` come off the appraisal and are
   governed by `lib/appraisal/as-is-reader.js`. This engine writes neither. That rule is already in
   `AVM-BUILDER-RESEARCH.md` §5.2(e) and it is the one that keeps everything else safe.

**Sequence.** Appraiser lines first (defensible today) → paired sales as a **cross-check** where
enough pairs exist → cost/depreciation for the physical features it genuinely explains → FHFA HPI
for time → regression **never**, until measured thresholds are met, and never for a number that
sizes a loan.

## B4. ADVERSARIAL REVIEW OF `src/lib/research/valuation.js`

Every finding below was reproduced by running the engine — against the live corpus and against
constructed cases. The engine's *stated* principles are good and the file is unusually honest about
its own limits. These are the places where the code does not live up to them.

### B4.1 🔴 THE TIME ADJUSTMENT CAN PRE-FILL A +48% LINE. This is the one to fix first.

`timeTrend` (`valuation.js:496`) computes:

```js
const months = monthsBetween(midNewer, midOlder);   // gap between the two half-medians
const pct = ((mn - mo) / mo) * 100 / months;        // % per month
```

The sufficiency gate is on the **count** of dated sales (`minSample * 2` = 16). **There is no gate
on the SPAN**, no floor on `months`, and no cap on the resulting rate. Reproduced:

| Case | Sales | Half-medians apart | Price gap | Derived rate |
|---|---|---|---|---|
| **A** | 16 | **1 month** | 4% | **+3.95 % / month** |
| **B** | 16 | 12 months | 4% (identical data) | **+0.33 % / month** |
| C | 16 | 0 months | — | correctly refused |

**Identical price data, spaced differently, yields a 12× different rate.** Then
`suggestAdjustments` (`valuation.js:567-572`) multiplies it out with no ceiling:

```
amount = comp.sale_price × (trend / 100) × months_since_sale
```

Case A, a $400,000 comp sold 12 months ago:

```
market_conditions = +$190,750
→ adjusted price $590,750 · net adj 47.7% · gross adj 47.7%
```

**A $190,750 adjustment is pre-filled into the grid**, sourced `'suggested'`, with a note that reads
like a derivation. `compWarnings` fires `net_adj_high` and `line_adj_high` — so the engine's second
principle ("never hide a weak answer") holds — but a screenful of red beside a plausible-looking
number is not a defence. A user who accepts the default has just moved the value by half.

And the live corpus is already in case A: the NJ segment returns **+4.38 %/month from half-medians
1 month apart** — roughly **+68 %/year**.

**Fix, in order:**
1. **Refuse unless the half-medians are ≥ 6 months apart.** The gate belongs on the span, not the
   count.
2. **Clamp the monthly rate to a sane band** (±1.5 %/month is already ±20 %/year) and say when the
   clamp bit.
3. **Cap the resulting dollar line** at a fixed share of the sale price (10 % is generous) and mark
   it capped.
4. **Cap `months` at ~18** — a comp older than that needs a human, not a bigger multiplier.
5. **Prefer the FHFA HPI for the CBSA** and fall back to the in-house read, saying which was used.

### B4.2 🔴 The per-bedroom / per-bath / per-condition method is confounded by SIZE

`groupDelta` (`valuation.js:458`) takes the **difference in median price-per-square-foot** between
groups, then `suggestAdjustments` multiplies it by **the subject's whole GLA**.

Price per square foot is systematically *inverse* to size — smaller houses carry a higher $/sqft.
So a "per bedroom" delta measured in $/sqft is mostly measuring the size difference between
3-bed and 4-bed houses, with the wrong sign. Measured on the live corpus:

| Segment | Result |
|---|---|
| `perBedroom`, NJ, n=73 | **refused** — *"the 73 we have point the wrong way"* |
| `perBath`, NJ, n=69 | `$23.54/sqft` → **$35,310** for one bathroom on a 1,500 sqft subject |
| `perBath`, all states, n=75 | `$57.96/sqft` → **$86,940 for one bathroom** |
| `perConditionGrade`, NJ, n=73 | `$11.77/sqft` → $17,655 per grade on 1,500 sqft. Plausible — and derived from exactly two groups whose only control is that both are 3+ observations |

**The negative-rate refusal is genuinely good and it is doing real work** — a constructed case
(three small cheap 1-bath houses versus twelve large 2-bath houses) was correctly refused. But it is
**asymmetric**: the same confound pointing the *other* way publishes $86,940 with a confident
`basis` string. And the refusal message blames the sample — *"too small or too mixed"* — when 73
sales is not small. **The method is confounded, not the sample.** Saying so would be more honest and
would stop somebody "fixing" it by lowering `minSample`.

**Fix:** stop deriving room-count rates from $/sqft group medians. Take them from the appraisers'
own `RoomCount` / `OtherFeature` lines (§B3), and where those are too thin, **leave the line blank**
— which is the engine's own stated first principle.

### B4.3 🟠 The engine reads 0 of the 599 adjustment lines it is sitting on

`deriveMarketRates` takes `{sale_price, gla, beds, baths_full, baths_half, condition_uad,
sale_date}` and nothing else. **The single most defensible source in the building (§B3) is not
wired in.** This is not a refusal; it is a blind spot, and it is the largest single improvement
available to this file.

### B4.4 🟠 `ratesFor` accepts a whole STATE as "a market"

`src/routes/research.js:341`. The refusal when *no* geography is named is exactly right and well
argued in the comment. But the accept condition is `state OR city OR zip`, so **"NJ" passes**. The
measured NJ answer — `$271/sqft`, GLA rate `$108/sqft`, `+4.38 %/month` — is a state average
presented to the user as "around here".

**Fix:** a state alone is not a market. Require a city, a ZIP, or a radius; if only a state is
known, refuse with the same honest wording already used for the no-geography case.

### B4.5 🟠 Four contaminations of the rate pool, all measurable, none filtered

`ratesFor`'s `SELECT` does not even retrieve the columns that would allow three of these.

| Contamination | Measured | Effect |
|---|---|---|
| **Distressed sales** — `sale_type` ∈ REO/Short/Estate/Court is **never filtered and never selected** | 10 of 83 comps have no `sale_type` at all | Constructed proof: 8 REO at $133/sqft + 8 arm's-length at $300/sqft → **median $217/sqft, GLA rate $87/sqft**. The engine *distrusts a distressed comp in the grid* (`compWarnings` `distressed`) and *trusts it in the rate*. It disagrees with itself |
| **`gla_basis='gba'`** — gross BUILDING area, mostly from 1025s | **6 of 83 (7%)** | Their $/sqft is structurally low and drags the median down. This is the Part A/Part B seam |
| **ARV-grid comps** pooled with as-is comps | **7 of 83 (8%)**, and **67 of 83 (81%) were `comp_set`-stamped by DEFAULT, not determined** | On a fix-and-flip book, ARV comps are systematically in better condition. `comp_set_confidence` exists precisely to make this visible and nothing reads it |
| **Property type** — the filter exists but cannot work | **0 of 83** comp-observation properties carry a rolled-up `property_type` | Supply the filter → zero rows. Omit it → a 4-family and a studio condo share one $/sqft median |

### B4.6 🟠 A listing is half-weighted into the value, and into every summary statistic

`reconcile` (`valuation.js:300`) applies `w *= 0.5` for a non-closed comp — and then includes it in
`indicatedValue`, `median`, `mean`, `low`, `high`, `likelyLow/High`, `spreadPct` and
`pricePerSqft`. Reproduced: one closed comp at $400,000 plus one **active listing** at $520,000 →

```
indicatedValue $443,000   (the listing carries 36% of the weight)
median $460,000 · mean $460,000 · high $520,000
confidence "weak" — reasons include "recent sales", although the listing has no sale date at all
```

`setWarnings` does say *"only 1 closed sale"*, which is the saving grace. But an **asking price is
not evidence of a sale price**, and it should not be inside the headline number. Report the listing
as a **separate ceiling indication** — "3 closed sales indicate $X; two active listings ask $Y" —
which is what an appraiser actually does with them.

### B4.7 🟡 A standard deviation from two comps is printed as a range

`likelyLow` / `likelyHigh` are one weighted σ either side, computed whenever `usable.length > 1`.
At n=2 that is arithmetic without meaning, and it renders as a tidy money range. Require **n ≥ 4**
for a σ-based band; below that show the plain min–max and say so.

### B4.8 🟡 The GLA rate at 40% of price-per-foot

The comment is honest — "the trade convention is a quarter to a half" — and it publishes the band.
Two problems remain:

- **It is a heuristic where a measurement is available.** 67 `GrossLivingArea` adjustment lines are
  sitting in the corpus (§B2).
- **A fixed fraction over-states in a high-$/sqft market.** $271/sqft × 0.4 = **$108/sqft** as a
  *size* adjustment is far above what appraisers in these markets actually write ($40–$80 is the
  usual band). The `AVM-BUILDER-RESEARCH.md` §3.2 sanity band —
  `rate ∈ [0.10, 0.90] × median $/sqft` — should be enforced *and* the derived rate should be
  compared against the appraisers' own lines, with a warning when they disagree by more than ~50%.

### B4.9 Where it REFUSES something it could safely answer

| Refusal | Verdict |
|---|---|
| `pricePerSqft` below `minSample = 8` | **Too blunt.** The floor is on count only. Five arm's-length closed sales in one ZIP in six months is a *better* number than forty across a state. Make the gate **joint** — n *and* geographic tightness *and* spread — and allow an answer at n=5 labelled `thin`, with a wide band |
| `perConditionGrade` needs ≥2 grade groups of ≥3 | **Correct but useless here.** 89 of 137 observations are `C3`; a homogeneous market can never produce a condition rate. The answer is not a lower floor — it is the `Condition` adjustment lines (73 of them), which need no group variation at all |
| The negative-rate refusal | **Keep it. Fix the message.** It is doing real work (§B4.2), but it blames the sample for a method defect |
| `timeTrend` below 16 dated sales | **Gates the wrong quantity.** Passes at n=16 over one month, refuses at n=15 over three years. Gate the **span** |
| `ratesFor` with no geography | **Right, and well argued.** Extend it: a bare state should refuse the same way |
| `suggestAdjustments` skips a GLA line under 25 sq ft | Right — noise |
| `normalizeAdjustments` drops a line over $1e9 | Right — a paste accident, documented |

### B4.10 What the file gets RIGHT, and must not lose in the fixing

Worth stating, because a critique this long can read as a condemnation and this is a good file.

- It **refuses with a reason** rather than fabricating, everywhere.
- It **never zero-fills** a line it cannot support — a blank means "we don't know", not "no
  difference".
- It gets the **sign convention** right and documents it (`valuation.js:32-36`).
- It **honours the backwards ordinal** — `inverse` in `groupDelta`, and the comment at
  `valuation.js:562` explaining why a better subject means a positive comp adjustment.
- It **labels confidence instead of faking a percentage**, and says so on its face.
- It **states that 15%/25% is not a Fannie rule** and words the warnings as our own opinion.
- `scoreComp` **excludes unknowns from the denominator** and reports `coverage` separately — "we
  don't know" is not "it's a bad match".
- `setWarnings` filters to **the same comps the value was computed from**, a bug already found and
  fixed once.
- A **snapshot, not a reference** — a saved valuation cannot silently change.

## B5. WHAT A PROFESSIONAL COMPARABLE REPORT CONTAINS

`docs/research/AVM-BUILDER-RESEARCH.md` §5.1 already specifies the page-by-page contents and should
be treated as the base spec. What follows is the **section list as it must appear in the PILOT
product**, the differences, and the **layouts** the owner asked for.

### B5.1 The sections

| # | Section | Must contain | Non-negotiable |
|---|---|---|---|
| **1** | **Cover** | PILOT lockup; *"Comparable Sales Analysis — how this property may be appraised"*; subject address + photo; **indicated value + range + confidence label**; **effective date AND preparation date as separate printed fields**; prepared-by name and role; version; valuation id | **The disclaimer block is ON PAGE 1**, not at the back |
| **2** | **Subject summary** | Full fact block — address, APN, category, units, GLA (with `gla_basis`), beds, baths, year built, lot, **condition + quality with basis and mapping**, view, location, basement, garage, flood zone; **per-field source flag** (*from the appraisal dated…* / *from the loan file* / *from the warehouse* / *corrected by X on Y*); prior sale history | Every staff correction is visible. Every blank says "not stated", never "0" |
| **3** | **Map** | Subject pin, comp pins, distances, scale bar | **Drawn as an inline SVG from the lat/lng we already hold.** No tile provider — no new dependency, no data egress |
| **4** | **The comp grid** (landscape) | URAR-style `FEATURE │ SUBJECT │ COMP 1 │ …`; header rows (address, proximity, sale price, $/sqft, sale date, **sale status**, sale type, data source); the 18 grid lines from `GRID_LINES` with description and `+(−)$`; footer with net adj, net %, gross %, **adjusted price**, **weight applied** | **Repeat the SUBJECT column on every continuation page.** A grid page without it is unreadable |
| **5** | **Per-comp detail pages** | One block per comp: **photo**, full fact block, every adjustment with its **reason**, and **provenance stated in words** — *"Source: appraisal report on file YSCAP…, effective 2026-03-14, prepared by [appraiser], [licence]. This property was Comparable #2 on that report. Facts as stated on that report."*; whether a later report has since restated any fact | **`property_photos` is currently 0 rows** (§A2.1). Ship the layout with an honest "no photograph on file" placeholder, not a broken image |
| **6** | **Adjustments and their reasoning** | For every line: the amount, the basis in words, and **its sample** — *"$58/sq ft · 41 grid lines · 12 reports · 7 appraisers · Passaic County · last 18 months · middle half $45–$70"*; **every line left BLANK, and why** | *"No market-conditions adjustment was derived — the sales are not spread over enough time"* is a **required sentence**, not an omission. A blank line is not a statement that no difference exists |
| **7** | **Reconciliation** | Low / high / mean / median / weighted mean; the weighting formula printed; per-comp weights; cross-checks (median indication, most-similar-comp indication); **an analyst narrative, required, minimum length enforced** — why these comps, why these adjustments, why this point in the range | A report with no human sentence in it is a spreadsheet with a cover |
| **8** | **Market conditions** | What our own sales did, with `n` and the span; the FHFA HPI for the CBSA when wired; the appraisers' own 1004MC reads from `market_observations` (db/449) **with their sample size**; days on market | db/449's own header says it: this is *"what N appraisers told us about the market around here, and when"* — **never "the market"** |
| **9** | **Data quality and warnings** | Every warning that fired, with severity; any warning overridden, **by whom and the reason they typed**; the coverage statement — *"we hold 7% of what sold in this town"* | The single most important honesty surface in the document |
| **10** | **Assumptions and limiting conditions** | No inspection performed, interior or exterior; facts as reported to us on the dates shown, not independently verified; sale dates are **month-resolution** (the day is always `01`); an active listing is an **asking** price; a condition rating on a subject-to report is the **after-repair** condition; a **mapped** condition is our reading of a word, not a code the appraiser wrote | Items 5 and 6 of this list are Part A leaking into Part B, and they belong here |
| **11** | **Preparer and provenance** | Name, role, contact, date, version, valuation id, **`inputs_hash`**; the list of source reports with their effective dates and appraisers | Answers "on what basis did you lend?" |
| **12** | **The disclaimer, in full** | §B7 verbatim | Repeated from page 1 |

### B5.2 The layouts

The owner asked for *"several layouts/versions"*. Four, from **one** data model — never four
builders.

| Layout | Pages | Audience | Contents |
|---|---|---|---|
| **One-pager** | 1 | An officer, on a phone, before ordering an appraisal | Cover block + a 3-comp mini-grid + the range + confidence + the short-form disclaimer |
| **Standard** | 5–8 | Internal credit file | Sections 1–4, 6, 7, 9, 10, 12 |
| **Full** | 12–20 | Diligence, a note buyer, a dispute | Everything, including a detail page per comp and every photograph |
| **Grid-only** | 1–2 landscape | An appraisal reviewer comparing against a delivered report | Section 4 alone, plus the disclaimer |

**One rule that makes the layouts safe: the disclaimer scales, the honesty does not.** The one-pager
may carry the short-form disclaimer (§B7), but it may **not** drop the confidence label, the range,
the comp count, or the "these lines were left blank" sentence. Those are what stop the number being
read as a valuation.

**Format.** `jsPDF` + `jsPDF-autoTable` are already vendored in-tree and already loaded server-side
by the e-sign document builder, so a paginated grid needs **no new dependency**. The screen prints
today via `window.print()` (`StaffValuation.jsx:79`) and that stays as the fallback.

## B6. THE LEGAL LINE — what a lender may and may not call this

`AVM-BUILDER-RESEARCH.md` §5.2 is the full treatment and is correct. The load-bearing points,
because they govern the wording of every screen and every page:

**1. USPAP attaches to an APPRAISER performing an APPRAISAL.** Standard 1 governs development,
Standard 2 governs reporting. A **non-appraiser staff member producing an internal value indication
for the lender's own credit analysis is not performing an appraisal**, and this output is not an
appraisal report.

> **The trap:** if the operator **is** a licensed or certified appraiser, USPAP can attach to their
> work regardless of the capacity they think they are acting in — several states extend appraiser
> regulation to anything a licensee does that resembles valuation. **Policy: no licensed appraiser
> on staff or contract operates this tool for our files.** If that ever changes, the output must be
> restructured as a USPAP-compliant **Restricted Appraisal Report** (SR 2-2(b)), which carries a
> mandatory use-restriction statement and is by design a materially different document.

**2. Standard 3/4 — appraisal review.** If a staffer uses this to form an opinion about *the quality
of an appraiser's work*, that is appraisal review. Our framing — *"how this property may be
appraised"*, a second indication — keeps us clear. **The report must never say "the appraisal is
wrong."** If a staffer concludes it is, the recorded path is the existing appraisal-findings desk and
the As-Is verification condition.

**3. "Evaluation" is a regulated word and we may not use it.** Under the **Interagency Appraisal and
Evaluation Guidelines (December 2010)** a *federally regulated institution* may use an evaluation in
place of an appraisal for exempt transactions — residential under **$400,000** (since 9 Oct 2019),
commercial at or under **$500,000**. An evaluation must be written, must estimate market value in
the property's **actual physical condition, use and zoning**, must describe the method, the analysis,
the supporting information and every source, must name and be signed by its preparer, and must carry
its limiting conditions. The Guidelines state plainly that *"a valuation method that does not provide
a property's market value or sufficient information and analysis to support the value conclusion is
not acceptable as an evaluation."*

> **We are a private, business-purpose lender and are not a federally regulated institution, so
> FIRREA Title XI and those regulations do not bind us.** We build the report to the interagency
> content list anyway — because note buyers and warehouse counterparties diligence against that
> yardstick, because it answers "on what basis did you lend?" in litigation, and because it is
> independently a good specification.
>
> **What we must NOT do is call the output an "evaluation"**, or say it satisfies any regulatory
> requirement. Call it an **internal value indication** or a **comparable sales analysis**.

**4. The 2024 interagency AVM Quality Control Rule (effective 1 Oct 2025)** reaches AVMs used in a
credit decision on a mortgage secured by **a consumer's principal dwelling — even when the loan is
for a business purpose**. The business-purpose carve-out we rely on elsewhere deliberately does not
apply. A straight investment flip is out of scope; **a borrower living in one unit of the 2–4 they
are rehabbing is in scope**, and that is a fact we do not reliably record today.

Two mitigations, both cheap: (a) this tool is arguably not an "AVM" at all in the rule's sense — a
human picks the comps and sets every adjustment, the software does arithmetic and suggests defaults;
(b) **a tool that helps staff review an appraisal is outside the rule; only the step where a number
sizes a loan is inside it.** Adopt the rule's factors 1–4 voluntarily regardless (confidence gates,
immutable versions + `inputs_hash`, `created_by` surfaced so the person who set the terms is not the
only person who produced the valuation, and periodic back-testing of issued indications against the
appraisal that later arrived — which is nearly free given we store both numbers).

**5. The rule that is ours alone.** **This tool's output may never size a loan.** `as_is_value` and
`arv` come off the appraisal, governed by `lib/appraisal/as-is-reader.js`. The report writes neither.

## B7. THE DISCLAIMER — exact recommended language

Adapted from `AVM-BUILDER-RESEARCH.md` §5.3, tightened, and with the Part A honesty added.
**Have counsel review before it ships.**

### Long form — page 1 and repeated at the back of every layout except the one-pager

> **THIS IS NOT AN APPRAISAL.**
>
> This document is an internal value indication prepared by YS Capital Group for its own credit
> analysis. It is **not an appraisal**, is **not an appraisal report**, and was **not prepared by a
> state-licensed or state-certified real estate appraiser**. It has **not** been developed or
> reported in conformity with the Uniform Standards of Professional Appraisal Practice (USPAP),
> including Standards 1 and 2, and it may not be represented as, relied upon as, or substituted for
> an appraisal or an appraisal review.
>
> It is not an "evaluation" for the purposes of the Interagency Appraisal and Evaluation Guidelines
> or any federal or state appraisal regulation, and it is not offered as satisfying any such
> requirement.
>
> The analysis relies on comparable sales data extracted from appraisal reports previously delivered
> to YS Capital Group by third-party appraisers. Each fact is stated **as it was reported to us on
> the date shown** and has not been independently verified. No interior or exterior inspection of
> the subject property or of any comparable was performed in connection with this analysis. Sale
> dates are reported to the month; where a condition or quality rating is shown as a range, or is
> marked as read from the appraiser's own words rather than a standard code, that is our reading of
> what the report said and not a rating the appraiser assigned.
>
> Adjustments reflect the judgement of the preparer. Automatically suggested adjustments are derived
> from the limited data set described in this report and are shown with their sample sizes. **Where
> no adjustment could be supported by the available data the line is left blank and the reason is
> stated — a blank line is not a statement that no difference in value exists.**
>
> The indicated value is an opinion as of the effective date shown, is subject to the range and the
> limiting conditions stated, and may differ materially from an appraised value, from a contract
> price, or from an eventual sale price. It is provided for internal use only, is **not for
> distribution to any borrower, investor, guarantor or third party**, and creates no representation
> or warranty to any person.
>
> Prepared by: {staff name}, {role} · Effective date: {effective_date} · Prepared: {issued_at} ·
> Version {version} · Valuation ID {id}

### Short form — the one-pager, and every screen that displays a value

> **Not an appraisal.** An internal value indication built from the comparable sales in our own
> appraisal reports. Not USPAP work product, not an "evaluation" under any appraisal regulation, and
> not a substitute for an appraisal. Facts are as reported to us on the dates shown and are not
> independently verified. Internal use only — not for a borrower, an investor or a note buyer.

### The one-line stamp — already in the code, and it should stay

`valuation.js:392` (`DISCLAIMER`) is already stamped into every result and rendered by every surface.
Keep it, and keep the rule that **it travels with the number** — including into the quick answer
(§B8), the API response, and any copy/paste.

**Two wording rules for every screen:**
- **Never** the words *appraisal*, *appraised value*, *evaluation*, *certified*, *USPAP* about our
  own output. Say **indicated value**, **value indication**, **comparable sales analysis**.
- **Never** *"the appraisal is wrong"* or *"the appraiser over-valued"*. Say *"our comparable
  analysis indicates a different range — see the appraisal findings desk."*

## B8. THE QUICK-ANSWER MODE

> *"Type an address and a few basics, and tell me roughly what properties like this have been
> appraising at recently, in this condition, in this area."*

**The single most important design decision: this must answer the question the owner actually asked
— which is not "what is it worth".** He asked what properties like this **have been appraising at**.
That is a question about *our own files*, and it is answerable and defensible. "What is it worth" is
an AVM point estimate we cannot defend. **Answer the first and refuse the second, in the same
breath.**

### What it takes in

Address (required) · GLA · beds · baths · condition (code **or word** — the mapping layer makes the
word work) · property type · units · as-is vs after-repair.

### What it does

1. Geocode / key the address (`property-key.js`, then `geocode.js`).
2. Widen a **relaxation ladder** and **say which rung produced the answer**: ½ mile → 1 mile →
   2 miles → the town → the ZIP → the county. Never silently.
3. Pull closed comparable observations in that ring, last 12–18 months, matching type and units.
4. Band by condition **rank** (mapped or coded), by size (±25%), and by the as-is/ARV grid.
5. Report **the distribution**, never a point.

### What it says — the exact wording

**A good answer:**

> **19 appraisals we hold within 1 mile, in the last 18 months.**
> Of those, **9** are 1-unit houses between 1,200 and 1,900 sq ft in **C4** condition.
> Those 9 came in between **$385,000 and $470,000** — middle half **$410,000–$445,000**, median
> **$428,000**.
> Price per foot ran **$228–$281**, median **$252**.
> 7 of the 9 were on an as-is grid; 2 were after-repair.
> **The most recent was 3 months ago. The oldest was 16 months ago.**
> *Not an appraisal — this is what our own reports said about similar properties nearby.*

**A thin answer, which must look visibly different:**

> **3 appraisals we hold within 1 mile, in the last 18 months** — too few to give a range.
> Widening to the town: **11 appraisals**, of which **4** are a size and condition match. Those 4
> came in between **$340,000 and $505,000** — a spread that wide means we cannot narrow it.
> **We have never lent in this town before this year**, so we hold very little here.

**An empty answer, which must be honest about WHY:**

> **We hold nothing within 2 miles of this address.** Our database only contains properties that
> appeared in an appraisal we paid for — about **7% of what actually sells in a typical town** — and
> we have no files in this area. This is not a statement about the property.

### The rules that keep it truthful

1. **Never a point estimate.** No single number, ever — not as a headline, not as "≈", not as a
   midpoint. A range and a median, or a refusal.
2. **Always lead with the denominator.** *"In the 9 appraisals we hold…"* is the first clause of
   every answer. That sentence is what makes it a statement about our files instead of a claim about
   the market.
3. **Always the recency span**, oldest and newest — not "recent".
4. **Refuse below 5 matching observations**, and say what widening the ring would do. The refusal
   text is part of the product.
5. **Never mix as-is and after-repair silently.** Report the split, and offer the two separately.
6. **Say when the condition was MAPPED**, not coded: *"3 of these 9 had a worded condition rating
   that reads as C3–C4."*
7. **Distressed sales reported separately**, never blended into the headline range.
8. **The empty state blames our coverage, never the user's filters.** As-built, the browse screen
   says "try widening the price or size range" when the true answer is "we have never lent here."
   That is the single most important and nearly-free fix in this whole document.
9. **The one-line disclaimer travels with every answer** — on screen, in the API response, and in
   anything copied out.
10. **Never call it an estimate, a value, or an AVM.** It is *"what our own appraisals said about
    properties like this nearby."*

**What it is allowed to be built on** — closed comparable observations plus subject observations
whose appraised value we hold, in a named geography, in a named window, matched on type/units/size/
condition rank/grid. **Not** on listings, not on a regression, not on a single comp, and not across
a whole state.

## B9. Build order

| # | Item | Why here | Size |
|---|---|---|---|
| 1 | **Clamp `timeTrend` and cap the market-conditions line** (§B4.1) | A +48% pre-filled adjustment is live today | Hours |
| 2 | **Refuse a bare state in `ratesFor`** (§B4.4) | One condition | Minutes |
| 3 | **Exclude distressed sales and `gla_basis='gba'` from the rate pool; select `sale_type`** (§B4.5) | The engine currently disagrees with itself | Hours |
| 4 | **The mapping layer** `condition-scale.js` + the ordinal columns + the roll-up bump (§A4) | Unblocks search, the report, and the quick answer | ~2 days |
| 5 | **Keep the subject's worded rating** — 2 columns, 5 lines (§A3.1) | Cheapest real data gain in the building | Hours |
| 6 | **Back-fill condition/quality from the `Condition`/`Quality` adjustment lines** (§A3.2) | No XML re-parse needed | ~half a day |
| 7 | **Normalize the adjustment lines out of jsonb into rows** (§B2) | Every §B3 question becomes one `GROUP BY` | ~1 day |
| 8 | **Derive rates from the appraisers' own lines**, with n / appraiser count / IQR / declines (§B3) | The defensible source, finally wired in | ~2 days |
| 9 | **Mine the condition narrative** for the as-is rating on renovation files (§A3.3) | Fixes the 76%-subject-to blind spot | ~1 day |
| 10 | **The quick-answer mode** (§B8) | Rests on 4 and 8 | ~2 days |
| 11 | **The report and its four layouts** (§B5) | Rests on everything above | ~4 days |
| 12 | **Count the UAD 3.6 refusals** (§A3.5) | One counter, and 2 Nov 2026 is coming | Minutes |

---

# APPENDIX — how the measurements were taken

Live database `postgres://ysapp:ysapp@127.0.0.1:5432/ysmerge`, single
`BEGIN ISOLATION LEVEL REPEATABLE READ` transaction so every number in §A2 and §B2 agrees with every
other. Snapshot taken **2026-08-03 04:26:56 UTC**, while `npm test` was concurrently writing to the
same database — see the caveat at the head of §A2.

```sql
-- coverage, by form type and by subject-vs-comparable
SELECT COALESCE(form_type,'(none)') AS form_type, role, count(*)::int AS n,
       count(*) FILTER (WHERE COALESCE(condition_uad,'')<>'')                                   AS cond_uad,
       count(*) FILTER (WHERE COALESCE(condition_uad,'')='' AND COALESCE(condition_text,'')<>'') AS cond_text_only,
       count(*) FILTER (WHERE COALESCE(condition_uad,'')='' AND COALESCE(condition_text,'')='')  AS cond_neither,
       count(*) FILTER (WHERE COALESCE(quality_uad,'')<>'')                                      AS qual_uad,
       count(*) FILTER (WHERE COALESCE(quality_uad,'')='' AND COALESCE(quality_text,'')<>'')     AS qual_text_only,
       count(*) FILTER (WHERE COALESCE(quality_uad,'')='' AND COALESCE(quality_text,'')='')      AS qual_neither
  FROM property_observations GROUP BY 1,2 ORDER BY 1,2;

-- the distinct strings — the real problem statement
SELECT COALESCE(condition_text,'(null)') v, count(*)::int n FROM property_observations GROUP BY 1 ORDER BY 2 DESC;
SELECT COALESCE(quality_text,  '(null)') v, count(*)::int n FROM property_observations GROUP BY 1 ORDER BY 2 DESC;

-- what the search can and cannot see
SELECT count(*)::int total,
       count(*) FILTER (WHERE condition_rank IS NOT NULL)                                          AS filterable,
       count(*) FILTER (WHERE condition_rank IS NULL AND COALESCE(condition_text,'')<>'')          AS text_only_invisible,
       count(*) FILTER (WHERE condition_rank IS NULL AND COALESCE(condition_text,'')='')           AS unknown
  FROM properties;

-- the adjustment corpus: size, shape, and how much of it is real dollars
SELECT l->>'type' AS line_type, count(*)::int n,
       count(*) FILTER (WHERE (l->>'amount')::numeric <> 0)          AS nonzero,
       count(*) FILTER (WHERE COALESCE(l->>'description','') <> '')  AS with_description
  FROM property_observations o, LATERAL jsonb_array_elements(o.adjustments) l
 GROUP BY 1 ORDER BY 2 DESC;

-- contamination of the pool `ratesFor` reads
SELECT count(*)::int comps,
       count(*) FILTER (WHERE gla_basis='gba')                        AS gba_not_gla,
       count(*) FILTER (WHERE COALESCE(sale_status,'closed')<>'closed') AS listings,
       count(*) FILTER (WHERE comp_set='arv')                          AS arv_grid,
       count(*) FILTER (WHERE comp_set_confidence='single_grid')       AS comp_set_defaulted,
       count(*) FILTER (WHERE COALESCE(sale_type,'')='')               AS sale_type_unknown,
       count(*) FILTER (WHERE COALESCE(property_type,'')='')           AS property_type_unknown
  FROM property_observations WHERE role='comparable';
```

The engine findings in §B4 were reproduced by calling `src/lib/research/valuation.js` directly —
`deriveMarketRates` over the live comparable pool (whole corpus, then per state), and
`suggestAdjustments` + `adjustComp` + `reconcile` over constructed cases A–F. **Re-run all of this
against production before sizing any of the work in §B9** — the shape holds, the distribution does
not.
