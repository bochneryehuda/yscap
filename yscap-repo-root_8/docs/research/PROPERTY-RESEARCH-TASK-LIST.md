# PROPERTY RESEARCH — THE BUILD LIST

**Owner-directed, 2026-08-03.** The ask, in the owner's words: type a subject
property address, enter its details, and the system finds similar comparables
itself — by real map distance, not "same city". Filter by size, sale date,
distance, condition. Pick comps into a report, adjust them, and print a branded
PILOT comparable report with full detail on every comp, in several layouts. Plus
a quick mode: an address and a few basics, and roughly what properties like that
have been appraising at lately.

Four research agents and two pre-merge audits produced this. Their full findings:

| Document | What it answers |
|---|---|
| `COMP-REPORT-COMPETITIVE-RESEARCH.md` | 28 competing products, what to copy, what not to |
| `COMPARABLE-XML-COVERAGE-AUDIT.md` | Every fact in the XML we do and don't read |
| `GEO-AND-DATA-API-RESEARCH.md` | Geocoding, true distance, dedupe, which APIs to buy |
| `CONDITION-AND-REPORT-RESEARCH.md` | Condition vocabularies, adjustments, the report, the legal line |

---

## THE ONE RULE THAT GOVERNS EVERY ITEM

**Never fabricate.** A fact the report did not state stays NULL — never inferred
from the subject, never defaulted, never guessed by a vendor's API. Where we
cannot answer, we say what we cannot answer and why. Three of the defects fixed
on the way here were wrong ANSWERS rather than missing ones, and every one of
them was more expensive than silence:

* a 2–4 unit comparable's bedroom count read unit 1's, so a 7-bedroom triplex
  scored as a strong comp for a 3-bedroom house;
* an after-repair report's depreciation rolled onto the property, so a row read
  "condition C5" and "no wear, replacement cost as-new" at the same time;
* a time adjustment read 3.95%/month off sales bunched into one month, and
  pre-filled +$190,750 on a $400,000 comp.

**And the coverage sentence that has to appear on every screen and every report:**
this warehouse holds only properties that appeared in an appraisal *we* paid for
— roughly 7% of a town. A thin answer is almost always a statement about our
coverage, not about the user's filters.

---

## DONE (this session)

- [x] Market screen — months of supply, median price, days on market by month, with the sample size drawn as a first-class part of every reading
- [x] db/424 — five wrong fact placements corrected; after-repair money can no longer roll onto a property
- [x] db/424 idempotency — the migration was wiping its own column on every boot
- [x] `INGEST_VERSION` — the lever that actually back-fills a newly-read fact, which `ROLLUP_VERSION` cannot
- [x] `AS_IS_ONLY` corrected in **both** directions — three facts joined it, two provably wrong entries left it
- [x] db/426 — a 2–4 unit comparable's rooms/beds/baths, and the per-unit breakdown
- [x] The time-trend rate + dollar ceilings
- [x] db/430/431/432 — **every comparable knows what it is and how many doors it
  has**, verified against a corpus of **262 real production appraisal XMLs pulled
  out of SharePoint** (149 parsed, **769 comparables**). This is the owner's own
  stated priority — *"there shouldn't be a possibility that you should see a
  comparable in your system that doesn't have how many units the property is,
  what property type it is."*

  | | before | after |
  |---|---|---|
  | comparables with a unit count | 0 of 769 | **768 (99.9%)** |
  | comparables with a property type | 0 of 769 | **769 (100%)** |
  | comparables with a year built | **0 (0%)** | **760 (98.8%)** |
  | comparables with a lot size | 717 | 717 (93.2%) |

  Four things the real corpus proved that no synthetic test could have:
  - **A 1004D was being read as a 1004.** The Appraisal Update / Completion
    Report attaches to a 1004, a **1025**, a 1073 or a 2055 and proves nothing
    about the unit count — so the 1004D on 1400-1402 Stratford (plainly a
    two-family; the address is a two-number range) stored its subject and all
    three comparables as `units 1 / SFR (1 unit)` while the appraiser's own grid
    read "2 Family" on every line. A confident wrong answer, not a missing one.
  - **Year built could never have been populated.** The warehouse mined it out of
    the Age adjustment row with a 4-digit-year regex, but that row states an AGE
    IN YEARS — the corpus writes "106", "114 yrs", "76". Silently 0% for every
    comparable ever imported. Now derived from the report's own effective date.
  - **The form was overruling the grid on the label**, producing rows that
    contradict themselves: 18 comparables stored as `units 5 / Multi 2–4`, and a
    grid-stated 2-unit on a 1004 stored as `units 2 / SFR (1 unit)`.
  - **A vendor total row was being counted as a dwelling, and the damage was
    real.** Class Appraisal and OneStop emit an UNNUMBERED leading
    `ROOM_ADJUSTMENT` carrying the property's totals, ahead of rows that DO carry
    `UnitSequenceIdentifier` — so counting rows made every one of their
    comparables ONE UNIT TOO MANY. Scored against the appraiser's own
    `SalesPricePerUnitAmount`, an independent witness the parser never consults
    for a grid-stated count: **133 of 350 multi-unit comparables carried a wrong
    unit count; after the fix, 350 of 350 agree.** It was not cosmetic — a
    conforming 4-unit comparable was labelled `Multi 5+` (ineligible), the price
    per door was divided by the wrong denominator, and 57 Lincoln St appeared in
    two reports as a 3-unit and a 4-unit building. The discriminator is
    STRUCTURAL — *does this grid number its units at all?* — which is why it is
    safe where an earlier value-based draft was not: that one compared counts and
    could not tell a total row from a duplex of two identical units.
  - **A padded grid column is not a comparable.** Every comparable that could not
    establish a unit count was an empty trailing slot with no address, no price
    and no area. Dropping them took price/condition/age/proximity coverage to
    100% and left exactly ONE genuine unknown in 769.

  Plus a fourth identity source ranked above arithmetic because it is STATED
  rather than derived — the appraiser's own design-style words ("2 Family",
  "3 FAMILY", "4-PLEX"). It refuses far more than it accepts: "1/2 Duplex"
  (9 comps, all on 1004s) is ONE SIDE of a two-unit building, and "DOUBLE BLOCK"
  is used both ways, so both are left unanswered rather than doubled.
- [x] **The second audit's nine** (db/433, db/434). The one that mattered most:
  **none of the three back-book version counters had been bumped**, so on an
  already-deployed database none of this would have reached a single stored
  report — `COMP_PARSE_VERSION` 4→5 (4 was claimed by the previous commit, so a
  report stamped 4 would never be re-read), `INGEST_VERSION` 3→4, `ROLLUP_VERSION`
  5→6. Also: the **SQL twin** of `guessFromFormCode` was never changed, and
  `migrate-boot` re-runs every file on every boot, so db/322 kept rewriting a
  1004D file's property type to "SFR (1 unit)" and auditing it as a repair — the
  exact wrong fact db/432 exists to stop, manufactured nightly; a **form-implied
  subject unit count outranked a real measurement** in the roll-up (19 of 79 real
  subjects carry one); five **design-style false positives** (a 12-family read as
  a DUPLEX, "2-4 Family" read as 4, "2.5 Family" read as 5, four half-duplex
  spellings); the style branch was **unbounded on an unrecognised form**; the
  label could **overwrite a form-proved category** (a 1073 comparable stopped
  being a condo); the re-parse guard **did not protect the legacy rows it exists
  for**; and `REPARSED` listed 19 of 53 columns under a comment saying every one
  must be listed — now widened, with the exclusions named and an invariant test
  that caught a real overlap on its first run.
- [x] An **iLAD loan-application export is no longer reported as an unreadable
  appraisal**. Three files in the corpus were refused with "UAD 3.6 — a 3.6
  reader is required"; they are Encompass loan-application exports carrying no
  comparable grid at all, so that message was wrong twice over — a reader would
  not import them, and the real problem (the wrong document was attached) went
  unsaid.

---

## PHASE 1 — STOP BEING WRONG

**11 of 14 done.** Also fixed on the way, and not on the original list: a
migration pair (db/448 + db/424) that undid each other on every boot, burning a
permanent Postgres column slot each time — measured at 1,476 burnt slots with
`properties` sitting exactly at the 1,600 hard limit, i.e. one boot from a table
that could never be altered again. `check-migrations` now refuses that shape.
And `research/rekey.js` + db/428, without which the identity fixes below would
have been WORSE than the bugs: a changed key does not fail loudly, it mints a
duplicate the next time a report arrives about a house we already hold.

Correctness first. Every item is a measured wrong answer or a fact we hold and
throw away.

- [x] **1.1 Price per square foot is dead on every 2–4 unit comp.**
  `SalesPricePerGrossBuildingAreaAmount` appears nowhere in `extract.js`. Same
  file, one attribute renamed: a 1004 reads $154.59, a 1025 reads null.
- [x] **1.2 A comparable's garage is structurally always NULL.**
  `ADJ_TYPES.garage` looks for `garage`/`carport`; MISMO 2.6 writes
  `Parking`/`CarStorage`. Neither matches.
- [x] **1.3 A post-rehab refinance appraisal is mis-read as after-repair.**
  `HYPO_RE`'s second arm does not require the word "hypothetical", so *"All
  repairs were completed in 2024"* flips an **explicit `AsIs`** report to ARV:
  the as-is value is dropped and every comp is stamped `arv`. Split the pattern;
  let only the hypothetical arm override an explicit AsIs.
- [x] **1.4 A subject's worded condition is unrecoverable.** The UAD whitelist
  drops "Good"/"Avg-Good" and `appraisals` has no `condition_text` column, so
  every non-UAD subject rating is lost — and the 1025 was never brought into
  UAD, so that is the whole 2–4 book. Recoverable for free: 73 of 137
  observations carry a `Condition` adjustment line whose description IS the
  rating.
- [x] **1.5 The condition NARRATIVE is never read.** — READ, and the rest
  MEASURED AND DELIBERATELY NOT BUILT.
  `PROPERTY_ANALYSIS[_Type="PropertyCondition"]/@_Comment` is present on ~9 of 10
  1025s and routinely says *"C4 as-is, C3 as repaired"* — the one place the AS-IS
  rating on a renovation file is written down, which is exactly what `AS_IS_ONLY`
  currently leaves those properties without.

  The element IS now parsed (`condition_comment`, present on **143 of 150** real
  reports) and `asIsConditionFromNarrative` reads an explicit as-is code out of
  it. Mining a RATING out of the rest of the prose was then measured and refused:
  exactly **one** of 150 narratives mentions "as is" at all, and of the 5 subjects
  carrying no rating in any field, **zero** have a narrative — so the recovery is
  nil. The risk is not nil: the corpus contains *"Upon completion, the subject is
  assumed to be in overall good condition"*, and a prose reader would file that
  after-repair sentence as the property's condition today, which is the exact
  thing `AS_IS_ONLY` exists to prevent. Nothing to gain, a real way to be wrong.
  Reopen only if a corpus turns up where subjects genuinely lack a grid rating.
- [x] **1.6 A subject that cannot be keyed is dropped SILENTLY.** `writeReport`
  wraps it in `if (subjectId)` with no `else`, while a comparable is counted with
  a reason. That defeats the ledger's stated purpose.
- [x] **1.7 `appraisal_comparables.property_type` is written by nothing** (0 of
  83). Either fill it from a stated fact or drop the column — a column nothing
  writes reads as "the report didn't say" when the truth is "we never looked".
  **FILLED** by db/430-432: 769 of 769 real comparables now carry a property
  type, 768 a unit count and 769 an `identity_basis` saying how it was
  established. The appraisal tab renders both (and an audit caught the first
  attempt DISCARDING them in favour of a warehouse lookup — the row's own answer
  is now the seed and a later source may only ever improve on it).
- [x] **1.8 The geocoder accepts a match that changed the street.** Census
  returns `26 10TH ST` for `26 S 10th St` — directional dropped, `precision:
  'address'`, and it is the identical coordinate it returns for a different
  house. `address.geocodeRewriteIsSafe` exists, was written after exactly this
  incident, and `research/geocode.js` never calls it.
- [x] **1.9 Three dedupe COLLISIONS — different properties, one key.** Two ZIPs
  on one street with no city; `Suite 5` = `Apt 5` = `Bldg 5` = `Lot 5` = `#5`;
  and `5 Building Rd` / `5 Room Rd` collapsing because `splitUnit` eats a street
  whose name is a unit keyword (`address.withoutUnit()` already has the fix).
- [x] **1.10 Seven dedupe SPLITS — one property, several keys.** Bare unit,
  spaced unit, ordinals (`15 Ave` ≠ `15th Ave`), borough vs county, one ZIP with
  two town names, suffix synonyms, fractional house numbers.
- [x] **1.11 `sameAddress` reads a hyphen as a range**, so every Queens address
  over-matches: `150-25 78th Rd` = `150-99 78th Rd`. That comparer gates USPS
  stamps and review closing, and its stated discipline is to UNDER-match.
- [x] **1.12 `perBath` is confounded by size** and returns **$86,940 for one
  bathroom** — while the identical confound pointing the other way is correctly
  refused, and the message blames the sample when 73 sales is not small.
- [x] **1.13 An active listing carries 36% of the weight** into the indicated
  value, the median, the high and the price-per-foot. An asking price is not a
  sale.
- [x] **1.14 Distressed sales are neither filtered nor selectable.** 8 REO
  alongside 8 arm's-length drops the median $/sqft to $217.

## PHASE 2 — READ EVERYTHING THE XML ALREADY CONTAINS

- [x] **2.1 Per-unit data for the SUBJECT** — measured on the corpus: all 64
  form-1025 files produce a subject unit roll, and **every one of the 167 unit
  rows carries rooms, beds, baths, square footage AND rent**. That is the
  owner's *"each and every unit how many bedrooms how many bathrooms each and
  every unit how many square footage"*, complete, for the subject.
- [x] **2.2 `SalesPricePerUnitAmount`**, and the comp's monthly rent + GRM (db/430)
- [x] **2.3 The stated AGE in years** — stored as `age_years`; the year built is
  now derived from it plus the report's effective date instead of being mined out
  of it with a regex that could never match (db/432)
- [x] **2.4 The whole rental-comp grid** (db/435). Done, and it is the biggest
  single addition the warehouse has had: the rent schedule is a SECOND comparable
  grid, and the parser counted its elements and read nothing out of them.
  Measured on the 152-file real corpus, importing every one end to end:

  | | before | after |
  |---|---|---|
  | reports that import at all | 144 of 152 | **149 of 152** (only the 3 iLAD non-appraisals refuse) |
  | rental comparables in the warehouse | 0 | **286** |
  | properties whose ACTUAL rent we know | 0 | **172** |
  | properties with per-unit SQUARE FOOTAGE | 0 | **295** |
  | market observations filed | 139 | **144** |

  Each rental comparable carries its address, gross monthly rent, gross building
  area, rent per foot, rent-control status, condition, year built and a per-unit
  breakdown with **rooms, beds, baths, square footage and the rent for each
  unit**. A re-import of the whole corpus duplicates nothing.

  **Three pre-existing defects fell out of running real files through the
  importer for the first time**, and each cost a whole report:
  - **A median of 6.5 days broke the entire warehouse write.** Four 1004MC
    columns are `integer`, and a median over an even-sized sample is fractional.
    Postgres refused the INSERT, and because the caller's catch had no SAVEPOINT
    the refusal aborted the transaction — so the subject, the whole sales grid
    and the roll-ups were lost, and the report was refused with a message about a
    transaction. 5 of 152 reports, on the values 6.5, 16.5 and 100.5.
  - **"Best-effort" inside a transaction is not what a bare catch does.** Three
    blocks (the market grid, the roll-up loop, and the new rent schedule) now go
    through `bestEffort`, which attempts a SAVEPOINT — because `writeReport` is
    called BOTH inside a caller's transaction (the upload door) and on the pool
    directly (the loan-file door), and `SAVEPOINT` outside a transaction is
    itself an error. Opening one unconditionally broke the loan-file door; not
    opening one loses the report. The helper handles both.
- [x] **2.4b Per-unit SQUARE FOOTAGE for a COMPARABLE.** A sales comparable's
  unit mix is mined from `ROOM_ADJUSTMENT`, which states rooms, beds and baths
  and **never** an area — 353 sales comparables carry a mix and not one carried a
  square footage. On 62 of them the appraiser described the same building in
  BOTH grids of the same report, so `mergeUnitAreas` carries the area (and the
  per-unit rent) across, matched on the appraiser's own unit numbers and keyed on
  the property the warehouse already dedupes on. It only ever FILLS a blank, and
  refuses on any disagreement — a different number of dwellings, a repeated unit
  number, or a unit number on one side missing from the other — because putting
  unit 3's area on unit 2 is worse than leaving it blank.
- [ ] ~~**2.4 The whole rental-comp grid — the biggest remaining unread block.**~~
  `MULTIFAMILY_RENTALS` / `RENTAL_UNIT` / `RENTAL_FEATURE` are present in **91 of
  149 parsed files** and read for nothing but a count. Measured: **267
  `MULTIFAMILY_RENTAL` entries** (the subject at sequence 0 plus ~3 rental
  comparables each) carrying **1,002 `RENTAL_UNIT` rows, 634 of them with square
  footage** — each rental comparable has its own address, `MonthlyRentAmount`,
  gross building area, rent per foot, rent-control status and a per-unit
  breakdown. That is roughly 200 additional real properties with real in-place
  rents, sitting in files we already hold. For a 2–4 unit lender this is the
  single richest thing left in the XML.

- [x] **2.5 ACI's `COMPARABLE_LISTING`** — CLOSED AS A NON-ITEM, on the evidence.
  This was written from a schema reading, not from data. Measured: 56 of 152 real
  reports carry the element, and **all 56 are empty self-closing placeholders at
  sequence 0** (`<COMPARABLE_LISTING PropertySequenceIdentifier="0"/>`), inside
  an equally empty `COMPETITIVE_LISTINGS` block. Not one carries an attribute
  beyond the sequence number or a single child element. There is nothing to read,
  and a parser for it would be code that can only ever return nothing. **Listing
  comparables DO reach the warehouse** — through the ordinary sales grid, whose
  `GSEListingStatusType` marks an active or pending comp and routes its price to
  `last_list_price` rather than `last_sale_price` (that guard is already in the
  ingest). Reopen only if a vendor turns up that actually populates the block.
- [x] **2.9 Only the FIRST `_CONDITION_OF_APPRAISAL` is read** — real, and rarer
  than it reads. Measured across the 143 reports that state one: 142 state
  exactly one, and **one** states `SubjectToRepairs` AND `AsIs` together, which is
  precisely the renovation report carrying two values. The primary answer is
  deliberately UNCHANGED — the after-repair basis is the conservative one and is
  what `AS_IS_ONLY` keys on — but the parser now records every basis the report
  stated (`values.conditionOfAppraisalAll`, null when there was only one), so
  "the appraiser gave no as-is opinion" is distinguishable from "we only read the
  first line".
- [x] **2.6 The rest**: basement, lease dates, functional utility, UAD view/location codes, concessions, rent control, `DataSourceDescription` as a days-on-market fallback.
  Measured over the 769 real comparables: functional utility **769**, location
  factor **769**, data source **769**, days on market **660**, contract date
  **484**, concessions **359**, basement area **312**. The UAD VIEW/LOCATION
  codes were the last of them and were the worst of them — see below.
- [x] **2.7 Count and report the UAD 3.6 refusals** — mandatory 2 Nov 2026, and we read none of them.
  `appraisal_format_refusals` records every one with its reason, the research
  landing warns about the deadline and states the date, and the render harness
  asserts both.
- [x] **2.8 13 columns go NULL on any vendor without the UAD `COMPARISON_DETAIL` block** — find the fallbacks.
  The last two were the VIEW and LOCATION ratings, and the grid row states them
  in UAD short form (`N;Res;`, `A;BsySt;`) on every report that omits the block.
  Measured before → after: **view rating 409 → 608, location rating 409 → 667**,
  and **24 ADVERSE ratings surfaced that nothing could see** — a signal the
  appraisal tab badges. The same pass fixed the other half: the fallback stored
  the grid text VERBATIM, so **181 comparables showed a raw code as their
  "Location"** — `N;Res;`, `A;BsySt;`, even `N;Res;2.5%` with the adjustment
  percentage stuck on — rendered straight to an underwriter. `uad-rating.js`
  expands the code and refuses what is not a rating: a relative word
  ("similar"), and a bare FACTOR ("Residential", "BusyRoad"), because naming
  what you look at is not rating it and reading BusyRoad as neutral would
  manufacture the judgement that matters most.


## PHASE 3 — THE MAP AND THE ADDRESS

Measured: **0 properties have ever been placed by a real geocoder.** 77% were
never attempted. Everything in this phase costs about $10, one time.

- [ ] **3.1 Turn on the geocoder that is already written** — US Census (free, no
  key, batch 10k, unrestricted permanent storage) as primary, routed through
  `geocodeRewriteIsSafe` (item 1.8)
- [ ] **3.2 Geocodio as the backfill fallback** — $1/1,000, true US rooftop,
  permanent storage, and it returns census tract + school district in the same
  call. Nominatim cannot do a bulk backfill under its own policy.
- [x] **3.3 The appraiser's OWN stated proximity is parsed and used for nothing**
  — 42 of 77 comps carry "0.35 miles NE". **DONE**, and it turned out to be worth
  far more than a display field: three stated distances from three comparables
  whose coordinates we DO have determine the subject's own position.
  `src/lib/research/trilaterate.js` + `place-subjects.js`. Measured on the real
  corpus: **every one of the 132 subjects we have lent on was unplaced** (the
  property the loan is secured against was the one nothing could find on a map),
  102 reports carry three or more usable comparables, and **98 of them resolve —
  median residual 17 feet, worst 67**. Free and offline, out of reports already
  paid for, which is why the paid geocoder (3.1/3.2) is a nice-to-have rather
  than a blocker. The refusals are the design: below three circles it refuses,
  it refuses past a quarter-mile residual, and THE MIRROR (comparables strung
  along one road leave a second answer reflected across it) is COMPUTED and
  scored rather than guessed at with an angle threshold — because every
  borderline set in the corpus fits its stated distances to within 2–107 feet, so
  a residual test would have accepted all four with total confidence. The write
  is fill-only and stamped `geo_source='comp_trilateration'`; an estimate is
  never allowed to look like a measurement. `proximityMiles` refuses "2 blocks"
  and "same street" rather than guessing, and refuses an implausible 120 miles.
  `test-trilaterate-pure.js` + `test-place-subjects-db.js`.
- [x] **3.4 `distance_basis` provenance** — `eff_*` silently COALESCEs in a
  coordinate db/412 itself calls "frequently the centre of the ZIP". **DONE**
  (`db/446`), and 3.3 made it urgent rather than tidy: there are now FOUR things
  the coordinate under a distance can be — our own rooftop lookup, a position
  trilaterated from the comparables (±17 ft median), the appraiser's own
  coordinate at unknown precision, and `mixed` (a latitude from one source and a
  longitude from another, which the two independent COALESCEs make expressible).
  A ZIP centroid is a mile from the house, so a distance computed from one is not
  a worse answer, it is an answer to a different question — and it was rendered
  in exactly the same font. `properties.eff_geo_source` is GENERATED from the
  same columns `eff_*` reads, so it can never disagree with the coordinate it
  describes; the search returns it on every row; `geo_basis` / `exclude_geo_basis`
  let a caller refuse one; and the comp search greys the distance and says
  "rough — appraiser's own coordinate" instead of stating it flatly. Deliberately
  a NAMED SOURCE and not a quality score: ranking them on one scale invites a
  threshold nobody can justify. Note it cuts both ways — the trilateration's
  known points ARE the appraisers' own coordinates, and three circles drawn
  around three ZIP centroids could not agree to seventeen feet, so the residual
  is itself a measurement saying those coordinates are real on this corpus.
- [x] **3.5 The bounding box is not a superset of the circle** (short 5.9 ft at 1
  mile, 59 ft at 10) — `1.001 · r / (69.0932 · cos φ)`. The `cos(lat)` scaling
  itself is correct; verified across seven latitudes. **FIXED**, and the root was
  worse than the arithmetic: the box was sized on the ELLIPSOID (69.0546 and
  69.1710) while the haversine refine measures on a SPHERE of radius 3958.7613,
  where a degree is 69.0932 — correct numbers about a different planet from the
  one the distance is measured on, both erring the same way. The constant is now
  DERIVED from that same radius so the two cannot drift again, and `cos` is taken
  at the box edge furthest from the equator rather than at the centre (a further
  0.24% at 40.7°N and a 10-mile radius, ~125 ft at the corners).
  `test-research-geo-box-pure.js` walks 360 bearings across 10 latitudes and 7
  radii — 25,200 points, all inside — and fails on the old formula, which came
  out 0.11% NARROWER than the circle east-west at every latitude.
- [ ] **3.6 USPS is fully wired and stamped on 0 of 706 files** — free, and it is
  the second identity signal item 1.9 needs
- [ ] **3.7 THE MAP.** Subject pin, numbered comp pins, radius rings,
  click-to-select. MapLibre + OSM, no tile bill.

## PHASE 4 — THE REPORT

- [ ] **4.1 The branded PILOT comparable report.** Twelve sections, one full page
  per comp. `jsPDF` is already vendored — no new dependency.
- [ ] **4.2 Four layouts from one data model** — one-pager / standard / full /
  grid-only. **The disclaimer scales; the honesty does not:** no layout may drop
  the confidence label, the range, the comp count, or the blank-adjustment
  sentence.
- [ ] **4.3 The legal line, exactly.** USPAP attaches to an *appraiser*
  performing an *appraisal*, so this is not one — **but no licensed appraiser on
  staff or contract may operate this tool.** "Evaluation" is a regulated word we
  may never use. Call it an **internal value indication**. It may never size a
  loan.
- [ ] **4.4 Every blank adjustment line, and why it is blank**, as a required
  sentence — not an empty cell
- [ ] **4.5 Photos in the report.** `property_photos` is currently 0 rows; ship
  an honest placeholder rather than a broken box.

## PHASE 5 — THE FEATURES THAT MAKE IT WORTH COPYING

- [ ] **5.1 Quick-answer mode**, built to refuse. *"In the 9 appraisals we hold
  within 1 mile in the last 18 months, 1-unit houses 1,200–1,900 sqft in C4 came
  in between $385,000 and $470,000 — median $428k. 7 of 9 were as-is grids. Most
  recent 3 months ago."* Never a point estimate; always the denominator; always
  the recency span; refuse below 5 matches; the empty state blames our coverage.
- [x] **5.2 ARV mode.** Every source in the industry says an ARV must come from
  renovated comps and then leaves you to guess which sales were renovated. **We
  do not guess — the appraiser told us which grid each comp sat on.**
  `comp_set`/`arv_comp_count` exist, are indexed, and are unexposed. This is the
  fix-and-flip lender's core question and it is nearly free. **EXPOSED.** The
  query builder already understood `comp_set`; the two screens an officer
  actually picks comps on did not offer it. Both now do (Any sale / Renovated
  only / As-is only), a valuation whose PURPOSE is the after-repair value starts
  on renovated sales with the control visibly set that way, and every result row
  states which grid an appraiser put it on whether or not the filter was used.
  Measured: **154 of 955 properties have been used on an after-repair grid**, 144
  with a recorded sale, and only **6** appear on both — the two sets really are
  different sales. A LADDER RUNG falls back to any kind of sale when a town holds
  no renovated ones, ahead of the unit band, because a same-kind as-is sale beats
  a renovated sale of the wrong kind of building; an explicitly chosen set is
  never relaxed.
- [ ] **5.3 THE ADJUSTMENT CORPUS.** Measured 599 adjustment lines against 62
  distinct sales — **9.7×**, confirming the claim on live data. It changes the
  claim from *"a bathroom is worth $12,000 in Paterson"* (indefensible on thin
  data, and the arithmetic returns negatives) to *"this report used $18/sqft; the
  other 40 reports in this county used $45–70"* — which is what Fannie's own
  Collateral Underwriter does, and it is defensible because it is a claim about
  our appraisers, not about the market. Always publish n, distinct reports,
  **distinct appraisers**, the IQR (never a σ), and **the count of declines** — an
  appraiser who saw a 200 sqft gap and adjusted $0 made a judgement, not a rate
  of zero. Cap any one appraiser at 40%.
- [ ] **5.4 Show the score's factors, and let a human weight a comp.**
  `scoreComp.parts[]` and `weight` both exist and are unrendered.
- [ ] **5.5 Confirm-the-facts step, then instant re-value**
- [ ] **5.6 Bracketing + QC panel** — `compWarnings` exists, scattered
- [x] **5.7 Flip finder** — sold twice in 24 months, the spread, both photos.
  `property_sales` holds it; the search only ever reads `last_sale_*`. **BUILT**
  (`src/lib/research/flips.js`, `GET /api/research/flips`, a section on the
  market screen). Measured: **56 buy→sell pairs inside two years across 52
  properties**, averaging a $165,816 spread over 215 days, 41 of them over 15%.
  Consecutive pairs only (three sales are two deals), closed sales at BOTH ends
  (an asking price would invent a profit nobody made), and a NOMINAL price is set
  aside and counted — the corpus holds ten $1 transfers and three $10 ones, and
  the first run returned *"12 Ward St — bought $10, sold $565,000, spread
  5,649,900%"*. The renovated marker is the appraiser's own (they put the resale
  on an after-repair grid), never inferred from the size of the spread. Photos
  are not in it yet: `property_photos` coverage is the open half.
- [ ] **5.8 Conflict detection** — two of our own reports disagreeing about one house
- [ ] **5.9 Appraisal-vs-our-value variance** — a CDA in-house, gated on coverage
- [ ] **5.10 Defensible time adjustment from contract date + FHFA HPI**
- [ ] **5.11 Draw and save a market-area polygon**

## PHASE 6 — CONDITION, PROPERLY

**The owner is right that there are two vocabularies, and the reason is not the
one anybody assumes: the split is by FORM, not by property type.** UAD was
mandated for exactly four forms — 1004, 1073, 1075, 2055. **The 1025 (2–4 unit)
was explicitly left out**, so its grid condition is the appraiser's own words. A
condo on a 1073 carries `C3` exactly like a house; the same 2–4 family used as a
comparable *on a 1004* carries `C3` too. So one building can be `C4` on one
report and "Average" on another, and both are correct.

- [x] **6.1 One pure module `condition-scale.js`** returning `{code, rank,
  rankLow, rankHigh, basis, source, original, confidence, why}`. `code` set ONLY
  from a literal code; `rank` the only thing anything filters or adjusts on;
  spanned words keep their span; `original` always displayed.
- [x] **6.2 The mapping table** — `Good` → 3 (2–3), `Average` → 4 (3–4), `Fair` →
  5 (4–5), `Avg-Good` → 3 (3–4), and the rest.
- [x] **6.3 What must stay NULL, and this is most of the list:** every RELATIVE
  word — `Similar`, `Superior`, `Inferior`, `Same`, `+`, `-` — which is the *most
  common* thing in a non-UAD grid and is about that report's subject, not the
  property; `Updated`/`Renovated` (that is work, not condition — a cosmetic flip
  over a failing roof is still C4); and every material in the quality slot —
  **`BRICK` is a real value in our corpus, which is why there can be no default.**
- [x] **6.4 Search and facets can see a worded rating** — 2 properties are
  invisible to every condition filter today — **the real number was 234 of 955
  properties, and the reading recovers 194 of them**
- [x] **6.5 The UI shows the appraiser's word PLUS the reading** — `Average
  (reads as C3–C4)`, never a code we did not receive, always the basis (`C3
  (after repairs)`), and a filter says what it cannot see.

## PHASE 7 — WHAT NOT TO BUILD

Recorded so nobody re-proposes it. Each needs MLS-completeness we do not have:
FSD / calibrated confidence percentages, a Collateral-Underwriter-style comp
selection model, regression adjustments, absorption rates, DOM analytics, owner
skip-tracing, street-view imagery, and tight "6 months / 1 mile" defaults.

**Do not buy drive-time** (~$9,000/yr): Fannie's own form wants straight-line
miles and a bearing, and the one-mile radius is a lender overlay, not a GSE rule.

**Buy nothing until Phases 1–5 ship**, then run ONE measurable experiment against
the ~50 files where we already hold the appraiser's own conclusion. If we then
need coverage: **HouseCanary** is the realistic partner ($0.05/call property
estimate, a `comps_sale` endpoint matching our data shape); **RentCast** ($0 →
$199/mo) is the cheapest way to test the idea at all.
