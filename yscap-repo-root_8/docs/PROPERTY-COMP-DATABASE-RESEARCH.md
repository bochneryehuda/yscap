# The Research Database — properties, comparables, appraisers, and your own valuation

*Owner-directed, 2026-08-02. This is the design document db/408 and db/409 point at.*

---

## 1. What was asked for, in the owner's words

> "Save the appraiser information, all the appraiser contact information, phone number, email
> address, license information, state information … click into a certain appraiser and see all his
> profile information … and see a list of all the files that he appraised for us."

> "Build a database from the XML import to save all the comparables … open and back date this
> database so that on every single file that we have already in XML all the comparables that he used
> should be saved into that database … each and every comparable should come with a picture and all
> the information he put for that comparable — square footage, year built, bedrooms, bathrooms,
> everything … and our subject properties should be added to that database."

> "I want to be able to use that to search for comparables … it's like an RPR, it's like an MLS …
> search in certain cities, certain states, between this and this date, this and this sale price,
> this and this bedroom count, this and this bathroom count."

> "While saving the comparables keep in mind also to save the property type, the unit count, the
> condition — very important what condition the properties are — and also if these comparables were
> used for as-is or for ARV. And of course the dates."

> "Make a thing where you can build up your own AVM on a certain property by searching which comps
> you want to add, and then adjust those comps however you want … and you can run a report on how
> your property may be going to be appraised."

Everything below is in service of those five paragraphs.

---

## 2. The one insight the whole design rests on

**We already have this data. It is just filed the wrong way round.**

Since db/137 every imported appraisal XML has been fully parsed and stored — the subject, every
comparable's whole sales-grid line, the appraiser, the photos mined out of the report PDF. But it is
stored **per loan file**: `appraisals` and `appraisal_comparables` hang off one `application_id`, so
the only question they can answer is *"what did THIS report say?"*

Every question the owner asked runs the other way:

| The question | Needs an index on |
|---|---|
| "Show me this appraiser and every file he did" | the appraiser |
| "Show me every comparable we've ever been handed" | the property |
| "3-bed sales in Paterson, $300–450k, last 9 months" | the property's facts |
| "Which comps should I use to value this house?" | the property's location + facts |

So the work is not *extraction* — that is done and well tested. It is **re-filing**: turning a pile
of per-file reports into an entity-per-property, entity-per-appraiser warehouse, plus the search and
the valuation tool that sit on it.

---

## 3. The shape, and why

Four ideas, matching how MLS/public-record vendors model the same problem (see
`docs/research/COMP-DATABASE-INDUSTRY-RESEARCH.md` for the industry survey behind this).

### 3.1 `properties` — one row per real-world address

The **spine**. Its columns are a **roll-up**: for each fact, the answer from the most recent report
that stated it. Nothing writes them directly; they are recomputed from the observations below every
time one changes. That is what keeps "where does this number come from?" answerable.

### 3.2 `property_observations` — one row per (report × property × role)

The **ledger**, and the real content of the database. What one appraiser said about one property on
one date: the sale price and date, the size, beds, baths, **condition**, quality, view, location,
whether it sat on the **ARV grid or the as-is grid**, its proximity to that report's subject, the
itemized dollar adjustments, and the room-by-room rent roll on a small-income property.

Never overwritten, never merged. A property we have seen four times can *disagree with itself*, and
that disagreement is information — it is how you see a house that was C5 in 2024 and C3 after
somebody renovated it.

### 3.3 `property_sales` — one row per distinct transaction

Gathered from four places: a comparable's own sale, the earlier sale an appraiser researched on a
comparable, the subject's prior sale, and a purchase under contract. Deduped on (property, month,
price) — which is exactly the resolution the appraisal grid gives us, because the UAD sale date is
month-resolution.

### 3.4 `appraisers` + `appraiser_licenses` + `appraiser_contacts`

One row per human. **The licence is the identity** (`lic:NJ:42RG00123400`), falling back to
name + firm when a report carries no licence number. The contact tables accumulate *every* phone,
email, firm and address ever seen, so a new spelling adds a row rather than destroying the old one —
the same pattern the borrower CRM uses.

---

## 4. The identity problem, and how it is decided

Two address lines on two different reports are the same house when they produce the same
**key** (`src/lib/research/property-key.js`) — `street | unit | locality | state`, normalized.

**Pure, deterministic and offline, on purpose.** This repo already has a Google-backed canonicalizer
(`lib/address-canon`), and it is deliberately *not* used here: it costs one HTTP round trip per
distinct string, returns null with no API key, and the warehouse has to fold in thousands of
comparable rows inside a boot back-fill. A warehouse that cannot dedupe without a vendor silently
stores every property twice.

Three rules earn their place:

1. **The unit is never dropped.** Unit 2 and Unit 5 of one building are two properties that sell for
   different prices. Folding them would corrupt every price-per-foot figure in the database. (This is
   also why the ingest reads `condo_unit_identifier` — the importer never writes `subject_unit`, so
   reading only that column would fold an entire condo building into one row.)
2. **The ZIP is never part of the key when a city is present.** The same house shows up with ZIP+4 on
   one report, no ZIP on the next, and an occasional wrong one. Keying on it splits one house into
   three. The ZIP is the fallback locality *only* when the report gave no city.
3. **No house number, no state, or no locality → no key, and the row is skipped.** `26 S 10th St`
   with nothing else is not an address. Every skip is counted on `property_ingest_log` with the
   address as stated and the reason, so the loss is a number somebody can look at rather than a
   suspicion.

---

## 5. The five correctness rules that are easy to get wrong

These are the ones that would quietly produce a database that looks right and is wrong. Each is
enforced in code and asserted in `scripts/test-research-db.js`.

### 5.1 A renovation report's subject condition is the condition of a house that does not exist yet

On a subject-to-repairs report, the subject's C-code describes the property **after** the work. Rolling
that up as "the current condition of this property" would be flatly wrong on every rehab file — which
is most of this lender's book. Every observation carries `condition_basis` (`as_is` / `as_repaired`),
and the roll-up **skips** an `as_repaired` statement for condition and quality while still taking
everything from that same report that is true either way (the size, the year built, the address).

### 5.2 A listing is not a sale

On an active or pending comparable, `sale_price` holds the **asking** price. It feeds
`properties.last_list_price` and never `last_sale_price`; it is weighted at half in a valuation and
carries an explicit warning. `sale_status IS NULL` means *closed* (db/157), not unknown, so every
legacy row is read through `COALESCE(…, 'closed')`.

### 5.3 UAD condition and quality are ordinal, and run backwards

C1 is the **best** and C6 the worst. "Condition C3 or better" means rank ≤ 3 — a string comparison
means the opposite. Generated `condition_rank` / `quality_rank` columns make the filter a plain
indexed integer range, which removes the bug class entirely.

### 5.4 A superseded report is the same report, not a second opinion

Re-importing an appraisal supersedes the old row. Folding both into the warehouse would double every
comp count and let a stale value win the roll-up by import order. A superseded report is **retired**:
its observations and photo links are removed, the properties it touched are re-rolled without it, and
the ledger records `skipped`. The **sales** it taught us are kept — a prior draft of a report is not a
retraction, and the sale still happened.

### 5.5 The warehouse must outlive the loan file

`appraisals.application_id` is `ON DELETE CASCADE`, so a naive foreign key would mean that permanently
deleting one loan file silently erases every comparable sale that report ever taught us. Every link
from an observation or a photo back to a report is `ON DELETE SET NULL`, and each observation keeps
its own copy of the address as stated and the date, so a detached row still means something.

Nothing borrower-identifying lives here: an address, the property's characteristics, and what it sold
for.

---

## 6. Which facts the parser was dropping, and now isn't

A fact-coverage audit (`docs/research/APPRAISAL-FACT-COVERAGE-AUDIT.md`) was run against the extractor
while this was being built. It found real losses, fixed in the same change:

| Fact | Was | Now |
|---|---|---|
| A comparable's **condition** in words | Only `^C[1-6]$` accepted; `"Good"` / `"Avg-Good"` discarded with no warning | `condition_text` beside the code — the owner's most important comp fact is no longer null on non-UAD vendors |
| A comparable's **quality** in words | Same | `quality_text` |
| Which **area** a comp's `gla` is | A 1025 grid falls back to gross BUILDING area under the same element, invisibly | `gla_basis` (`gla` / `gba`) |
| A comp's **year built / lot / style / garage** | No MISMO element carries them per comp | Mined out of the appraiser's own **adjustment lines** (`Age`, `Site`, `Design`, `Garage`), whose description holds the comp's figure |
| A photo's **slot label** | Read by `photo-meta`, then thrown away | Stored (`appraisal_photos.identifier` / `comp_seq`) |
| Which **comparable** a photo shows | Unknowable | Matched on the photo caption's **address** first (the only reliable join), the slot ordinal second |
| The **rent roll** on a 1025 | In `appraisal_units`, with no cross-file home | `property_observations.unit_mix` |

A comparable's **property type and unit count** remain genuinely absent from the MISMO 2.6 grid on
most vendors. The columns exist and are read where present, and they are **never** inherited from the
subject of the report the comp sits on — that would assert a fact nobody stated. The warehouse's real
answer is better: the same address, appearing as the **subject** of some other report, supplies its
own type and unit count, and the roll-up picks it up.

---

## 7. The search engine

Plain Postgres — no PostGIS, no Elasticsearch, no new dependency (see
`docs/research/PROPERTY-SEARCH-ENGINE-RESEARCH.md`).

- **Every predicate is appended only when the caller supplied it.** The tempting
  `($1 IS NULL OR col = $1)` pattern is a planner trap: once a statement's plan goes generic,
  Postgres cannot know which filters are live and the row estimate collapses, producing a sequential
  scan at exactly the wrong moment. The parameter-accumulator pattern means the plan always matches
  the query that was actually asked.
- **Address search is full-text, not `ILIKE '%…%'`.** `tsvector` + GIN is *core* Postgres (`pg_trgm`
  is contrib and cannot be assumed on a managed database). A generated `address_tsv` column with
  per-word prefix terms gives word-order-free search — "piscataway 10th" finds "26 S 10th St,
  Piscataway" — which a wildcard `LIKE` could never do, and it uses an index.
- **The three unsearchable columns were fixed at the schema level**: baths lived in two columns
  (`baths_total`), condition/quality were text codes on an ordinal scale (`condition_rank`,
  `quality_rank`), and the lot size is free text (`lot_sqft`, parsed on the way in).
- **"Used as an ARV comp" is denormalized.** It is a fact of the *observation*, so the honest query is
  an `EXISTS` — but a `JOIN` here would be the real bug (it multiplies the property row once per
  observation and corrupts every facet count and the `LIMIT`). Two counters with partial indexes turn
  it into an indexed lookup that can join a BitmapAnd with the other filters.
- **Radius search** is a bounding-box prefilter on indexed lat/lng plus a haversine refine. One degree
  of latitude is 69.05 miles; one of longitude is 69.17 × cos(lat) — about 52 in New Jersey — so the
  longitude box has to be a third wider *in degrees*. Using one delta for both is the classic version
  of this bug and clips the east-west edges off every search.
- **Facets** come back in the same round trip, aggregated over one materialized CTE.

---

## 8. Build your own valuation

`db/409` + `src/lib/research/valuation.js` + the `/internal/research/valuation/:id` screen.

Pick comparables out of the warehouse, adjust each one on the grid an appraiser knows, get a
reconciled indicated value with an honest range and every objection a reviewer would raise.

**Snapshot, never reference.** The subject's facts and each comparable's facts are **copied into** the
valuation when it is built. `properties` is a live roll-up that keeps moving as new reports arrive; a
valuation that re-read it would silently change its own answer and a printed report would stop
reproducing. The live links are kept for navigation only.

**A suggestion never overwrites a human.** The grid pre-fills the lines it can support — living area,
room count, condition, time, and the seller concessions the appraiser recorded — each with the words
explaining where the number came from. The moment you type over one it becomes yours (`source: 'user'`)
and the "suggest" pass will never touch it again.

**Every derived rate is allowed to refuse.** `deriveMarketRates` reads our own closed sales and returns
a rate only when there are enough of them, *and* only when the answer points the right way. A market
where the four-bedroom houses happen to be the tired ones produces a negative per-bedroom rate — the
engine refuses it and says why, because a grid line that subtracts money for an extra bathroom is
worse than a blank one. A "$142 per square foot" derived from three sales is a coincidence with a
dollar sign on it.

**The GLA adjustment is not the price per foot.** An extra square foot of the same house is worth a
fraction of the average foot — the land, the kitchen and the systems are already paid for. The engine
uses ~40% and publishes the quarter-to-half range it sits inside.

**Weighting leans on the closest match.** Each comp's weight is `1 / (1 + gross adjustment %)²`, halved
roughly every 12 months of age, halved again for a listing — and any weight a human pins overrides it
entirely.

**Confidence is a label, never a fake percentage.** A percentage implies a calibrated model behind it.
This is a rule over comp count, agreement, adjustment size and recency, and it says so on its face.

### 8.1 About the "15% / 25%" numbers

The famous 15% net / 25% gross adjustment pair is widely quoted as a Fannie Mae rule. **It is not one
any more** — Fannie removed those hard limits from the Selling Guide in December 2014, and Collateral
Underwriter compares an adjustment against what *other appraisers did on similar properties* instead.
The 1-mile radius and the 90-day recency preference are lender overlays, not GSE requirements.

They are kept here because they remain good internal smell tests, and every warning is worded as **our**
opinion. Do not re-label them as a GSE rule in any screen copy.

### 8.2 What this is not

Not an appraisal. Not USPAP work product. Not an "evaluation" that can stand in for one. The engine
stamps a disclaimer into every result and every surface renders it with the number. It exists so staff
can research a property before ordering the real thing.

---

## 9. Back-dating

The owner's "open and back date this database". `ingest.backfill()` walks every appraisal ever
imported, **oldest report first** — so the final state after a back-fill is identical to the state we
would have reached by filing each report as it arrived (the roll-up prefers the newest report that
stated a fact).

It runs bounded at boot (400 reports a pass) and **self-drains**: the ingest ledger records each
report, each boot picks up where the last stopped, and a fully-folded corpus makes it a single empty
query. A report that FAILED is always retried; a report that was skipped is not.

It is also re-run on the two paths where the underlying data moves after the fact: a fresh import, and
the comp-split back-fill (which rewrites `comp_set` on old appraisals at boot — without re-ingesting,
the warehouse would keep answering "which comps were on the ARV grid?" with the pre-split answer
forever).

---

## 10. Who can see it

**Every staff user, with no per-file scoping** — the owner's instruction, and a deliberate departure
from the loan-file rule. It is defensible because of what the data is: property addresses, property
characteristics and recorded sale prices. No borrower name, no loan amount, no contact detail, no
document. The one identity in it is the appraiser's, which is a licensed professional's published
business contact information, printed on every report they sign.

Borrowers never reach any of it: the router applies `requireStaff` as a whole, not per endpoint.
Photo bytes are served only for a document that is actually linked into the research database, so this
never becomes a general "download any document by id" hole.

---

## 11. Where this goes next

Ordered by value, not by effort. None of it is required for what was asked; all of it is unlocked by
what is now stored.

1. **Normalize the adjustment lines out of jsonb into rows.** `property_observations.adjustments`
   holds a corpus of *real appraiser adjustments in our own markets* — something no data vendor has.
   As rows keyed by line code it becomes one `GROUP BY`: "what are appraisers actually paying per
   bathroom in Paterson?" That is the single highest-value follow-up here, and it is what would turn
   the suggested adjustments from a median-of-ratios read into a peer benchmark.
2. **Conflict detection.** Two reports describing the same property differently, or two appraisers
   adjusting the same sale differently, is a review signal we can compute and nobody else can.
3. **A defensible time adjustment.** Today the market trend is an older-half-vs-newer-half read of
   median price per foot, which is honest but crude. Blending it against the FHFA HPI for the CBSA
   (published, free, quarterly) would make it stand up.
4. **A printable PDF.** `jsPDF` + `jsPDF-autoTable` are already vendored in-tree and already loaded
   server-side by the e-sign document builder, so a paginated side-by-side grid needs no new
   dependency. The screen prints today; a real PDF is a nicety.
5. **A real AVM** — gated on measured thresholds (deduped sales per metro, a calibrated error
   measure, fair-lending testing), not on a date. Until then the tool is advisory and says so.

Do **not** build a scored appraiser rating card. The aggregate figures on an appraiser's profile are
descriptive on purpose: a fair scorecard needs far more reports per appraiser than most of them have
filed with us, and a number on a screen gets believed.
