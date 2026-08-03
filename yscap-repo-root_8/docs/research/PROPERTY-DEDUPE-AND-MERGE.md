# PROPERTY DEDUPE AND MERGE — closing the last gap in "there shouldn't be duplicate properties"

*Research + design note. Owner's ask, 2026-08-02: "If you find two appraisals with the same
comparable, it shouldn't open up two data lines for it… It should merge them together as one
property and it should add the missing information — one appraisal had it, the other didn't.
Merge them together and resolve all the conflicts. There shouldn't be duplicate properties in
the database of properties."*

---

## BOTTOM LINE

**Most of the owner's ask already ships.** `src/lib/research/property-key.js` folds the address
spellings that actually vary between two appraisers, and `ingest.rollupProperty` already does the
"add the missing information / resolve the conflicts" half — for each fact, the most recent report
that *stated* it wins, so a thin new report never blanks what an older one taught us. The tests that
prove it, by name:

| Already handled | Proven by |
| --- | --- |
| `Street`/`St`, `Avenue`/`Ave`, `Boulevard`/`Blvd`, `Drive`/`Dr`, `Court`/`Ct`, `Place`/`Pl`, `Highway`/`Hwy`; case; punctuation; `New Jersey`/`NJ` | `test-research-property-key.js` — *"spelled-out street type and state fold together"*, *"case, punctuation and ZIP+4 do not split a property"* |
| ZIP+4, a **missing** ZIP, a wrong ZIP (ZIP is never in the key when a city is present) | *"a MISSING zip does not split a property — the ZIP is never part of the key when a city is present"* |
| `Village of X` / `Township of X` / `Lakewood Twp` → `Lakewood` | *"\"Village of X\" and \"X\" are one town"* |
| Whole address packed into the street field | *"a whole address packed into one string parses to the same key as its parts"* |
| Unit inside the street line vs. its own field; `#2` / `Apt 2` / `Unit 2` | *"a unit inside the street line and a unit in its own field are the same unit"*, *"unit prefixes (#, Apt, Unit) are noise"* |
| Leading + trailing directionals (`N`/`North`, `10th St NW`) | *"the directional is part of the street"* |
| **The end-to-end merge across reports** — one property, three observations, facts filled in from whichever report stated them | `test-research-db.js` — *"THE SAME HOUSE ON TWO REPORTS IS ONE PROPERTY…"*, *"still ONE property — a third spelling does not split it either"*, *"THE FACTS THE NEWEST REPORT DID NOT STATE ARE KEPT FROM THE ONES THAT DID — a thin report never blanks the record"*, *"both reports describe the SAME sale, so it is stored once"* |

**What genuinely still splits today**, measured against the real code (every line below was run
through `propertyKey()`, not reasoned about):

| Cause | Example that splits | Est. frequency |
| --- | --- | --- |
| **A comp with a ZIP and no city vs. the same house with a city** — key uses `z<zip>` as the locality | `26 Main St, Newark NJ 07103` vs `26 Main St, NJ 07103` → `…\|newark\|nj` vs `…\|z07103\|nj` | **#1 by volume.** `extract.js` documents that "~1/3 of files omit the separate `PropertyCity`/`State`/`PostalCode` attrs", and its `splitCityLine` fallback only fires on a clean `"City, ST ZIP"` string |
| **A unit on one report, none on the other**, on a 2–4 family or a condo | `26 Main St` vs `26 Main St Unit 1` | **#2.** Comps carry no unit field at all (`writeReport` passes only street/city/state/zip); a subject's unit comes from `condo_unit_identifier`. So the *same* house as a subject-with-unit and as a comp-without splits by construction |
| **Street-type abbreviations outside `ADDR.STREET_SUFFIXES`** | `Terrace`/`Terr`, `Street`/`Str`, `Lane`/`La`, `Way`/`Wy`, `Loop`/`Lp`, `Route`/`Rte` all split | Low but real, and clustered by vendor (one vendor writes `Terr` on every report) |
| **Empty unit slot left on the street line** | `26 Main St #` vs `26 Main St` | Rare. `address.js` already handles this; the key does not |
| **`26` vs `26A` vs `26-28`** | all three are distinct keys | Moderate in NJ/Brooklyn two-families |
| **Same ZIP, different town name** (village/section names, renamed municipalities) | `Wayne` vs `Packanack Lake` (07470); `Toms River` vs `Dover Township` (08753) | Low–moderate, concentrated in NJ |
| **Spelled-out ordinal** | `26 S Tenth St` vs `26 S 10th St` | Rare |
| **Ordinal typo** | `61th St` vs `61st St` | Rare |
| **Typo'd house number** | `26` vs `62 S 10th St` | Rare, and the *most* damaging — it invents a house that does not exist |

> No `DATABASE_URL` was available in this environment, so the frequency column is a reasoned
> estimate from the parser's own documented behaviour, not a count. **§6 gives the SQL that turns
> every one of those rows into a real number. Run it before building anything past the detector.**

**The smallest change that closes it, in the order it should be done:**

1. **Build `src/lib/research/property-merge.js` (a human-confirmed merge) FIRST** — ~200 lines, far
   smaller than `borrower-merge.js`, because `properties` is a roll-up: merging is *move the
   observations, delete the loser, re-roll*. **There are no field choices to make.** (§5)
2. **Then two zero-risk ingest/key fixes** that need the merge tool to exist, because changing how a
   key is computed creates collisions against `properties.address_key UNIQUE` and those collisions
   need somewhere to go (§4.1, §4.2):
   - `writeReport` fills a comp's missing city from the **subject's** city *when the comp's ZIP equals
     the subject's ZIP* — exactly the precedent already set one line above it for `state`
     (`state: c.state || a.subject_state`). Pure, offline, deterministic, and it kills cause #1 at
     source.
   - the key drops an **empty unit slot** and canonicalizes the street-type token through
     `address.js`'s already-tested `TYPE_CANON` table.
3. **Everything else is a human-confirmed merge.** Do not touch the key for it.

**Do not build** a fuzzy/automatic merger, a similarity score, a vendor address canonicalizer, or a
borrower-style field-by-field conflict screen. §7 says why, specifically.

---

## 1. WHAT THE KEY DOES, EXACTLY

`propertyKey(input)` → `street|unit|locality|state`, or `null`.

```
"26 South 10th Street, Piscataway, New Jersey 08854"  →  26 s 10th st||piscataway|nj
"26 S. 10th St. #2, PISCATAWAY, nj 08854-1234"        →  26 s 10th st|2|piscataway|nj
"26 Main St, NJ 07103" (no city)                      →  26 main st||z07103|nj
```

**It folds** (verified by running the function):

- street-type suffixes present in `ADDR.STREET_SUFFIXES` — `Street/St`, `Avenue/Ave/Av`, `Road/Rd`,
  `Drive/Dr`, `Boulevard/Blvd`, `Lane/Ln`, `Court/Ct`, `Place/Pl`, `Terrace/Ter`, `Circle/Cir`,
  `Parkway/Pkwy`, `Highway/Hwy`, `Trail/Trl`, `Square/Sq`, `Turnpike/Tpke`, and ~15 more;
- leading and trailing **directionals** (`North`→`N`, `Northwest`→`NW`) — with the deliberate
  exception that a two-token street keeps its word (`26 West St` stays `West`, because `W St` is
  gibberish);
- **case**, `.` `,` `'` `’`, and runs of whitespace;
- **state** spelled out or abbreviated;
- **ZIP absence, ZIP+4, and a wrong ZIP** — the ZIP is not in the key at all when a city is present;
- **`Village of` / `City of` / `Township of` / trailing `Township` / `Twp`** on the city;
- a **whole address packed into the street field** (re-parsed when the street contains a comma; the
  explicit XML elements always win over anything re-parsed out of prose);
- a **unit written inline** in the street vs. one in its own field, and the unit prefixes `#`, `Apt`,
  `Unit`, `Ste`, `Fl`, `Bldg`, `Lot`.

**It deliberately will not:**

- **drop the unit.** Unit 2 and unit 5 of one building are two properties that sell for different
  prices. `test-research-property-key.js`: *"TWO UNITS OF ONE BUILDING ARE TWO PROPERTIES"*, and
  *"the whole building is not the same thing as unit 2 of it"*.
- **key on the ZIP when a city is present** (see §3.5).
- **guess.** No house number → `null`. No state → `null`. No city *and* no ZIP → `null`. The caller
  skips the row and counts it on `property_ingest_log.rows_skipped` with the address as stated.

---

## 2. THE ONE THING THAT MAKES THIS EASY

`properties` is **derived**. `upsertProperty` writes *only* the address columns; every fact on the
row comes from `rollupProperty`, which re-reads `property_observations` ordered
`observed_on DESC, created_at DESC` and takes, per column, the first observation that stated
anything.

**Therefore a property merge has no conflict resolution step.** Move the observations onto the
survivor and re-roll: the survivor now rolls up from the *union* of both rows' observations, and the
"most recent report that stated it wins / an older report fills what a newer one omitted" rule
resolves every fact automatically — the same rule the owner already accepted and
`test-research-db.js` already asserts.

That single fact is why this is a much smaller build than `borrower-merge.js`, which needed
`MERGE_FIELDS`, `compare()`, a `choices` map, and a 409 for an undecided conflict. **None of that
applies here.** The only columns not covered by the re-roll are the address identity columns and the
geocode, and each already has an obvious, existing rule (§5.4).

---

## 3. THE REAL SPLIT CAUSES — CONFIRMED OR REFUTED AGAINST THE CODE

Each heading states the verdict, the actual key output, and the prescribed fix:
**(a) change the key** or **(b) human-confirmed merge**.

### 3.1 A typo'd house number — **CONFIRMED**. Fix: **(b) merge, never the key.**

```
26 S 10th St, Piscataway NJ  →  26 s 10th st||piscataway|nj
62 S 10th St, Piscataway NJ  →  62 s 10th st||piscataway|nj
```

There is no key rule that folds a transposition without also folding `26` and `62` when they are two
real houses on the same street — which they nearly always are. **Folding two different houses
corrupts every price-per-foot read in the comparable search, and that is far worse than a
duplicate.** This is human-only. It is detectable, though, with corroboration: two properties on the
same street in the same town whose `property_sales` rows share a date *and* a price are almost
certainly one house with one digit wrong (§6, branch F).

### 3.2 `26` vs `26A` vs `26-28` — **CONFIRMED**. Fix: **(b) merge.**

All three produce distinct keys (`hasHouseNumber` accepts `26A` and `26-28`, and `tokenKey` keeps
them verbatim). Note the contrast with the loan-file rule: `ADDR.houseMatches` treats a range as
covering its endpoints (*"27-29 Tuscany Ter" IS "27 Tuscany Ter"*), and `sameAddress` therefore
folds `26-28 Main St` into `26 Main St`.

**That is right for `sameAddress` and wrong for the key.** `sameAddress` is a *pairwise* predicate
that decides whether a review row can be closed — a false positive closes a review. The key is an
*identity*: fold `26-28` into `26` and you have permanently asserted that a two-lot assemblage and
one of its lots are the same property, for every future report, with no human in the loop. `26A` is
worse: it is frequently a real, separate carriage-house address. **Human-only.**

### 3.3 A spelled-out ordinal (`Tenth` vs `10th`) — **CONFIRMED**. Fix: **(a), optional.**

```
26 S Tenth St  →  26 s tenth st||piscataway|nj
26 S 10th St   →  26 s 10th st||piscataway|nj
```

Even `sameAddress` misses this one (`parseAddressParts` gives `southtenthstreet` vs `south10street`).
A bounded ordinal-word map (`first`…`twentieth`, `thirtieth`, …, ~30 entries) is deterministic and
carries essentially no over-merge risk — a street named "Tenth Ave" *is* "10th Ave". But it is rare
on a MISMO grid; most vendors emit digits. **Ship it only if the §6 count says it exists in our data.**

The **ordinal typo** (`61th` vs `61st`) is a separate, cheaper case: `address.js` already has
`dropOrdinal` for exactly this (*"'61th' -> '61' (a typo for 61st is the same street)"*) and
`sameAddress` folds it today. Applying `dropOrdinal` to the key's street tokens is a two-line,
near-zero-risk change; take it with the §4.2 work.

### 3.4 A street type `abbreviateStreet` doesn't handle — **CONFIRMED**. Fix: **(a), and be careful how.**

An unknown suffix is left exactly as written (deliberately — so "Newport Avenue Extension" is not
mangled). That is correct, but it means two *different* abbreviations of the same unknown word split:

```
26 Sunrise Way   vs  26 Sunrise Wy     →  SPLIT   (sameAddress folds these)
26 Tuscany Terrace vs 26 Tuscany Terr  →  SPLIT   ("terrace"→"Ter", but "terr" is unknown)
26 Quail Street  vs  26 Quail Str      →  SPLIT
26 Quail Lane    vs  26 Quail La       →  SPLIT
26 Ocean Route 9 vs  26 Rte 9          →  SPLIT
```

**Do not fix this by adding entries to `ADDR.STREET_SUFFIXES`.** That table feeds
`abbreviateStreet` → `canonicalOneLine`, which is the display and comparison one-liner for loan-file
addresses, the ClickUp push, the geocoder query and the SharePoint matcher. Widening it changes
stored and pushed strings across the whole app for a warehouse-only problem.

**Do fix it by canonicalizing inside the key.** `address.js` already owns `TYPE_CANON` — the exact
table `sameAddress` uses, already proven by `test-address-same.js`, covering `str/st/street`,
`terr/ter/terrace`, `wy/way`, `av/ave/avenue`, and the directionals. Export it (a pure addition, no
behaviour change anywhere) and canonicalize the street's trailing type token in `property-key.js`'s
tokenizer.

**One thing to not copy from `sameAddress`: `streetBase`.** `sameAddress` tolerates the street type
being *absent* on one side (`"100 Whisper Vlg" = "100 Whisper Vlg Wy"`). Do not put that in the key —
`Oak St` and `Oak Ave` are two different streets in most towns, and a key that drops the type would
fold them.

### 3.5 The town differs where the ZIP agrees — **CONFIRMED**. Fix: **(b) merge. The key must NOT copy `sameAddress` here.**

```
26 Main St, Wayne NJ 07470          →  26 main st||wayne|nj
26 Main St, Packanack Lake NJ 07470 →  26 main st||packanack lake|nj      SPLIT
26 Main St, Toms River NJ 08753     →  26 main st||toms river|nj
26 Main St, Dover Township NJ 08753 →  26 main st||dover|nj               SPLIT
```

`sameAddress` folds both pairs: *"The ZIP is the authority on locality. Only when one side has no ZIP
does the city name have to agree."*

**Why doesn't `propertyKey` do the same, and should it? No — and the reason is structural, not
stylistic.** "The ZIP wins when both sides have one" is a statement about *two* addresses. A key is a
function of *one* address: it has to emit a single string before it has ever seen the other row.
There is no way to express "prefer the ZIP, but only when the other one also has a ZIP" in a single
string. The only way to honour the ZIP in a key is to *put the ZIP in the key* — and that
re-introduces precisely the failure the module header was written to prevent:

> *"A property routinely appears with ZIP+4 on one report, no ZIP on the next, and an occasional
> wrong ZIP; keying on it splits one house into three."*

A ZIP-keyed warehouse would trade a handful of village-name splits for a *far larger* population of
missing-ZIP splits. **Keep the city-first key. Send this case to the merge tool**, where it is a
high-confidence auto-detected candidate (same street token, same unit token, same state, same ZIP,
different locality — §6, branch B) and a human clicks once.

### 3.6 One report carries a unit and another omits it on a single-family — **CONFIRMED, and this is #2 by volume.** Fix: **(b) merge.**

```
26 Main St            →  26 main st||newark|nj
26 Main St + unit "1" →  26 main st|1|newark|nj        SPLIT (by design)
```

The split is *correct behaviour* and must not be relaxed — the key cannot know at key time whether
`26 Main St` is a single-family or a condo building. But it is structurally guaranteed to happen in
this warehouse, which is why it is not rare:

- `writeReport` passes a comparable **no unit field at all**: `upsertProperty(db, { street: c.address,
  city: c.city, state: c.state || a.subject_state, zip: c.zip })`. A comp's unit can only arrive
  inline in the street string.
- a **subject's** unit comes from `condo_unit_identifier` (deliberately — the importer never writes
  `subject_unit`).

So the *same* house filed once as our subject (with a condo unit) and once as somebody else's comp
(the appraiser wrote just the street) is two rows, every time. Our book is heavy on NJ/NY 2–4
families, so expect volume here.

Also confirmed in this family:

- `unit "2nd Fl"` vs `unit "2"` → `2ndfl` vs `2`. **SPLIT.** Human-only (`2nd Fl` and `Unit 2` are
  usually but not always the same thing).
- `unit "Apt B"` vs `unit "B"` → both `b`. **Folds correctly.**
- **empty unit slot**: `26 Main St #` → `26 main st #||newark|nj`, splitting from `26 main st`.
  `splitUnit`'s `UNIT_RE` requires a token after the `#`, so nothing is extracted and the stray `#`
  stays in the street. `parseAddressParts` already handles this (*"a '#'/keyword with NOTHING after
  it … is an empty unit slot — treated as 'no unit', never as a difference"*). **Fix: (a), and it is
  free** — strip a trailing `#` or a trailing unit keyword with nothing after it before keying. Zero
  over-merge risk: an address ending in a bare `#` carries no information.

### 3.7 A comp given only a ZIP on one report and a city on another — **CONFIRMED. This is #1 by volume.** Fix: **(a), at the ingest, not in the key.**

```
26 Main St, Newark NJ 07103   →  26 main st||newark|nj
26 Main St, NJ 07103          →  26 main st||z07103|nj       SPLIT
```

Confirmed, and **it is not rare.** `extract.js` says so about our own corpus:

> *"Parse "New Haven, CT 06519" (a comp's PropertyStreetAddress2) → {city,state,zip}. Fallback for
> the ~1/3 of files that omit the separate PropertyCity/State/PostalCode attrs. Never guessed — only
> a clean "City, ST ZIP" match yields values."*

So roughly a third of files depend on the fallback, and the fallback fails whenever the address-2
line isn't exactly `City, ST ZIP` (no ZIP, a county, a trailing period, `City ST ZIP` with no comma).
Every comp that lands city-less and *also* appears on some other report that named the city is a
split pair. This is the single biggest bucket.

**The fix is not in the key.** Three options were considered:

| Option | Verdict |
| --- | --- |
| Put the ZIP in the key as a secondary locality | **No.** §3.5 — re-creates a bigger problem. |
| Resolve city from a ZIP→city crosswalk built out of our *own* `properties` rows | **No.** It makes the key data-dependent and order-dependent: the same input keys differently depending on what has been ingested. That breaks the "PURE, DETERMINISTIC, OFFLINE" contract the module is built on, and a key that changes over time is a key that silently splits. |
| Vendor a static 41,000-row ZIP→city table | **No.** Data we would have to keep current, for a problem with a cheaper answer. |

**The cheap, correct answer is at the ingest, and the precedent is already on the line above it.**
`writeReport` already inherits the subject's *state* for a comp that didn't state one:

```js
const pid = await upsertProperty(db, {
  street: c.address, city: c.city, state: c.state || a.subject_state, zip: c.zip,
});
```

Do the same for the city, **gated on the ZIP matching**:

```js
city: c.city || (c.zip && a.subject_zip && K._internals.zip5(c.zip) === K._internals.zip5(a.subject_zip)
        ? a.subject_city : null),
```

Why this is safe, and why it is not the "never inherit from the subject" rule this repo already
warns about (that rule is about property **type** and **unit count**, which genuinely vary comp to
comp):

- it is **pure, offline and deterministic** — everything it reads is on the same report;
- a ZIP is filed to one primary mailing city, and the report itself states that city for the subject;
- it is **monotone**: if the ZIPs differ, nothing changes and we are exactly as we are today
  (`z<zip>`); if they match, we produce the same locality the city-bearing reports produce;
- the key only needs the locality to be **consistent**, not geographically perfect. Even in the rare
  ZIP that spans two municipalities, every report on that ZIP gets the same answer.

Residual: comps outside the subject's ZIP that state no city still key as `z<zip>`. Those go to the
merge tool (§6, branch A), which detects them with high confidence.

### 3.8 Refuted / already-handled — do not spend time here

Confirmed folding correctly, so nothing to do:
`Ave./Av`, `Dr.`, `Ct`, `Hwy`, `Blvd`, `Pl`; `Twp`/`Township of`; ZIP+4; full state names; double
spaces; a city with trailing punctuation; a street packed with commas alongside explicit city/state
elements; `#2`/`APT 2`; `N`/`North` on a 3-token street; `10th St NW`/`Northwest`.

Two small stragglers worth folding into the §4.2 patch because they are free:
`Freehold Boro` does not normalize (`normalizeCityName` knows `borough`, not `boro`), and
`Saint`/`St` and `Mount`/`Mt` in a street *name* (not suffix) split — both are one-line map entries
with no over-merge risk.

---

## 4. THE KEY CHANGES, AND THE ONE THING THAT MAKES THEM DANGEROUS

**`address_key` is a stored, `UNIQUE`, already-populated column. Changing how it is computed does
not retroactively fix a single existing row — and the moment you re-key, previously-distinct rows
collide against that unique index.** So:

> **Build the merge tool before you touch the key.** The re-key needs somewhere to put a collision,
> and that somewhere is `mergeProperties()`.

### 4.1 The ingest fix (cause #1) — §3.7. No key logic changes; new reports simply key better.

### 4.2 The key patch (small, bounded, zero over-merge risk)

In `src/lib/research/property-key.js` only:

1. strip a trailing bare unit marker (`#`, `Apt`, `Unit`, … with nothing after it) before keying;
2. canonicalize the street's trailing type token through `ADDR.TYPE_CANON` (exported from
   `address.js` as a pure addition) — **without** `sameAddress`'s `streetBase` type-optional
   tolerance;
3. apply `dropOrdinal` to street-name tokens (`61th` → `61`);
4. optionally, the ordinal-word map (`Tenth` → `10th`) — only if §6 shows it exists in our data.

Every one of these canonicalizes *two spellings of one word*. None of them makes two different
houses equal. That is the line: **a key change is acceptable only when it is provably a spelling
normalization, never when it is a similarity judgement.**

### 4.3 The re-key sweep

`db/414` already established the pattern with `properties.rollup_version` +
`ingest.rerollStaleProperties()`. Mirror it:

```sql
ALTER TABLE properties ADD COLUMN IF NOT EXISTS key_version smallint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS ix_properties_key_version
  ON properties(key_version, observation_count DESC) WHERE key_version < 1;
```

`rekeyProperties({ limit })` recomputes `propertyKey()` from the stored parts; on `23505` it calls
`mergeProperties()` for the colliding pair and continues.

**An automatic merge is acceptable here and nowhere else**, because the collision is not a guess: it
is a deterministic key rule, reviewed once by a human when the rule shipped, asserting the two
strings are the same address. A fuzzy candidate never gets this treatment.

---

## 5. THE MERGE — modelled on `borrower-merge.js`, and much smaller

### 5.1 The doctrine carried over verbatim

| Borrower-merge rule | Applied to properties |
| --- | --- |
| One transaction; any failure rolls the whole thing back | Same |
| **The whole losing row is SNAPSHOTTED before deletion** (`borrower_merges.merged_snapshot`) | Same — `property_merges.merged_snapshot`, holding the `properties` row plus the observation/sale/photo ids that moved |
| **Foreign keys discovered LIVE from `information_schema`**, never a hand-written list, "so a table added next year is carried automatically instead of silently orphaning its rows" | Same query, `ccu.table_name = 'properties'` |
| **The per-table match predicate is an explicit map that THROWS for an unknown table** — *"refusing to merge beats losing rows"* | Same, **strengthened** — see §5.3 |
| **A "clever" generic predicate once deleted a real record**; the predicate must be written out per table and must never bind to the inner row | Same. Additional rule below. |
| Lock both rows `FOR UPDATE` in a stable id order | Same |
| Record who did it, and what moved per table | Same |

### 5.2 What is *deliberately not* carried over

`MERGE_FIELDS`, `compare()`'s field-by-field conflict list, the `choices` map, and the 409 on an
undecided conflict — **all unnecessary**, because of §2. There is no fact on `properties` a human
could be asked to choose: the re-roll recomputes every one of them from the union of the
observations. Building a borrower-shaped conflict screen here would be ceremony over a decision that
does not exist.

### 5.3 What actually moves — verified against the schema, not assumed

`grep -rn "REFERENCES properties" db/*.sql` gives **six** foreign keys. The brief's list was missing
one (`property_valuations.property_id`):

| Table.column | On delete | Unique index containing `property_id`? | Disposition |
| --- | --- | --- | --- |
| `property_observations.property_id` | **CASCADE** | **No** — the pivots are `(appraisal_id)`, `(comparable_id)`, `(import_id)`, `(import_id, comp_seq)` | plain `UPDATE` (`move`) |
| `property_sales.property_id` | **CASCADE** | **Yes** — `uq_property_sale (property_id, sale_date, COALESCE(sale_price,-1))` | `dedupe` |
| `property_photos.property_id` | **CASCADE** | **Yes** — `uq_property_photo (property_id, document_id)` | `dedupe` |
| `property_valuations.property_id` | SET NULL | No | `move` |
| `property_valuation_comps.property_id` | SET NULL | **Yes** — `uq_pval_comp (valuation_id, COALESCE(property_id::text, id::text))` | `dedupe`, **never delete** (§5.5) |
| `research_imports.subject_property_id` | SET NULL | No | `move` |

**Three of the six CASCADE.** That inverts one borrower-merge default and the change is deliberate:

> `borrowerRefs` blind-`UPDATE`s any table not in `SPECIAL`, so a new table is carried rather than
> orphaned. Here, a new table with a `CASCADE` FK that nobody declared would have its rows **silently
> deleted** when the loser row is removed. So `propertyRefs` **throws on an undeclared
> `(table, column)`** — which is the borrower module's own stated principle
> (*"refusing to merge beats losing rows"*) taken to its conclusion on a schema where the default
> failure mode is deletion, not orphaning.

**The dedupe predicates mirror the index, not a generic rule.** Note the deliberate divergence from
borrower-merge's *"unknown never equals unknown — an `IS NOT DISTINCT FROM` here would … DELETE"*
warning: `uq_property_sale` keys on `COALESCE(sale_price, -1)`, so for *that* index a NULL price
**does** collide with a NULL price. The rule to carry forward is not "never treat NULL as equal" —
it is **"write the predicate to match the index that will actually fire."**

```js
const MATCH = {
  property_sales:          'd2.sale_date = d.sale_date AND COALESCE(d2.sale_price,-1) = COALESCE(d.sale_price,-1)',
  property_photos:         'd2.document_id = d.document_id',
  property_valuation_comps:'d2.valuation_id = d.valuation_id',
};
```

A colliding **sale** is not dropped silently — it is folded the same way `recordSale`'s
`ON CONFLICT` already folds a re-observed sale: `times_seen = times_seen + <loser's>`,
`first_seen_at = least(...)`, and `sale_type`/`sale_status` `COALESCE`d onto the survivor's row.
A colliding **photo** is a genuine duplicate link to the same `document_id` and is dropped.

### 5.4 The only columns the re-roll does not cover

The address identity block and the geocode. Each already has a rule elsewhere in the codebase; reuse
it rather than inventing one:

- `address_key` — the survivor's is kept (it *is* the identity);
- `display_address` — **the longer one wins**, the exact rule `upsertProperty`'s `ON CONFLICT` already
  applies;
- `zip`, `county`, `apn` — `COALESCE(survivor, loser)`, again `upsertProperty`'s own fill-only rule;
- `street`, `unit`, `city`, `state` — the survivor's (they are what the key was computed from);
- `geo_latitude/longitude/source/precision/at` — fill-only from the loser; if neither side has a
  coordinate, clear `geo_attempted_at` and `geo_attempts` so the sweep re-tries the now-more-complete
  address;
- `latitude`/`longitude` (the *appraiser's* coordinates) — **do nothing**: they are roll-up columns
  and the re-roll rewrites them.

### 5.5 The one thing that still needs a human — and it is narrow

`property_valuation_comps`. If **one valuation used both duplicate rows as two separate comps** —
literally the owner's "two data lines for it" complaint, landing inside somebody's saved valuation —
then after the move both rows would violate `uq_pval_comp`. The colliding row **must not be deleted**:
a valuation is a *snapshot*, its row carries its own copied facts and adjustments, and deleting it
would silently change a saved number a human produced.

So: move the non-colliding row, leave the colliding row's `property_id` pointing at the loser, and
let the `ON DELETE SET NULL` FK null it when the loser is removed. The row and its snapshot survive
intact, only its live navigation link is gone. The merge result reports
`valuationCompsUnlinked: [{ valuation_id, count }]` and the UI tells the staffer **which valuations
double-counted a comp**, so a human can revisit the grid. That is the *only* human decision in the
whole merge, and it is a decision about someone's valuation, not about the property.

One benign side effect worth knowing: if a report's subject and one of its own comps were the two
duplicate rows, the survivor ends up with two observations from one report (one `subject`, one
`comparable`). `rollupProperty` counts them as exactly that, which is true, and no unique index is
violated.

### 5.6 Module sketch

```
src/lib/research/property-merge.js
db/415_property_merges.sql
scripts/test-research-property-merge.js         → add to `npm test`
```

```js
'use strict';
/**
 * MERGING TWO PROPERTY ROWS THAT ARE ONE HOUSE (owner-directed 2026-08-02).
 *
 * `propertyKey` folds the spellings that vary; what it CANNOT fold is a house
 * number typo, a "26" vs "26-28", a town written two ways, or a unit stated on
 * one report and omitted on the other. Those must never be folded by the key —
 * merging two different houses corrupts every price-per-foot read in the
 * comparable search, which is far worse than a duplicate row. So they are merged
 * by a HUMAN, the way this repo already merges two profiles of one person.
 *
 * WHY THIS IS MUCH SMALLER THAN borrower-merge.js: `properties` is a ROLL-UP.
 * Moving the observations and re-rolling resolves every fact automatically —
 * the most recent report that STATED a fact wins, an older report fills what a
 * newer one omitted. There is NOTHING for a human to choose.
 */
const db = require('../../db');
const ingest = require('./ingest');

// Every column that points at properties.id, read LIVE from information_schema —
// so a table added next year is carried, not orphaned. Three of the six FKs
// CASCADE, so an UNDECLARED table would be silently DELETED with the loser: an
// unknown (table, column) THROWS. Refusing to merge beats losing rows.
const DISPOSITION = {
  'property_observations.property_id':        'move',
  'property_sales.property_id':               'dedupe',
  'property_photos.property_id':              'dedupe',
  'property_valuations.property_id':          'move',
  'property_valuation_comps.property_id':     'dedupe_keep',   // never delete a valuation's snapshot
  'research_imports.subject_property_id':     'move',
};

// Predicates MIRROR THE INDEX THAT WILL FIRE — never a generic rule, and never a
// subquery that can bind to the inner row (that mistake deleted a real LLC once).
const MATCH = { /* see §5.3 */ };

async function propertyRefs(client) { /* ccu.table_name='properties', minus 'properties'/'property_merges' */ }

/** Which side survives: more observations → more complete address → older row. */
function pickSurvivor(a, b) { /* … the human may flip it */ }

async function candidates({ limit = 50, cause = null }) { /* §6 */ }
async function findDuplicates(propertyId)                { /* §6, one property */ }
async function compare(aId, bId)                         { /* two rows side by side + what will move */ }

/**
 * Absorb `mergedId` into `survivorId`. ONE transaction.
 *   1. lock both FOR UPDATE in id order
 *   2. SNAPSHOT the losing row (+ the ids about to move) into property_merges
 *   3. fill-only merge of the address block + the geocode  (§5.4)
 *   4. re-point every FK from information_schema, per DISPOSITION
 *   5. ASSERT every CASCADE table has 0 rows left on the loser — before the delete
 *   6. DELETE the loser
 *   7. ingest.rollupProperty(client, survivorId)   ← the whole conflict resolution
 */
async function mergeProperties({ survivorId, mergedId, actorId = null }) { /* … */ }

/** "These two are NOT the same house" — the pair never resurfaces. §5.7 */
async function markNotDuplicate({ aId, bId, actorId, note = null }) { /* … */ }

module.exports = { candidates, findDuplicates, compare, mergeProperties, markNotDuplicate,
  _internals: { propertyRefs, DISPOSITION, MATCH, pickSurvivor } };
```

Step 5 is the belt-and-braces the CASCADEs demand:

```js
for (const t of ['property_observations', 'property_sales', 'property_photos']) {
  const { n } = (await client.query(`SELECT count(*)::int n FROM ${t} WHERE property_id=$1`, [mergedId])).rows[0];
  if (n) throw httpError(500, `${n} ${t} rows still point at the row about to be deleted — refusing to merge`);
}
```

### 5.7 Recording "these two are NOT the same house"

The borrower side records this as `borrower_profile_links` — a human-granted "yes, really two
people", written in **both** directions, and `findDuplicates` surfaces it as `allowedShare` and sorts
those pairs **last** rather than hiding them.

Properties get the same idea with one deliberate simplification: a property pair has no directional
meaning (unlike a portal-access grant, which genuinely runs one way), so store **one canonically
ordered row** instead of two:

```sql
CREATE TABLE IF NOT EXISTS property_not_duplicates (
    property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    other_property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    reason            text,                    -- what the human checked, in their words
    created_by        uuid REFERENCES staff_users(id),
    created_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (property_id, other_property_id),
    -- ONE row per pair, always (lesser, greater), so a detector written either way
    -- round cannot miss it and a second staffer cannot file the mirror image.
    CHECK (property_id < other_property_id)
);
```

`markNotDuplicate` inserts `LEAST(a,b), GREATEST(a,b)` with `ON CONFLICT DO NOTHING`. The detector
(§6) `NOT EXISTS`-excludes it, so the pair never resurfaces. `ON DELETE CASCADE` on both sides means
a later merge of *either* row against a *third* property cleans the record up on its own.

And the redirect, mirroring `idx_borrower_merges_merged` ("where did this profile go?"):
`GET /api/research/properties/:id` looks up `property_merges.merged_id` on a 404 and redirects to the
survivor, so a bookmarked or emailed property link never dies.

### 5.8 Schema (`db/415`)

```sql
CREATE TABLE IF NOT EXISTS property_merges (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    survivor_id     uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    merged_id       uuid NOT NULL,              -- NOT an FK: that row is gone, and remembering it is the point
    merged_key      text NOT NULL,              -- the losing address_key
    merged_address  text,
    merged_snapshot jsonb NOT NULL,             -- the whole losing row + the ids that moved
    cause           text,                       -- 'zip_only_locality' | 'unit_absent' | 'house_number' | 'rekey' | 'manual' | …
    moved           jsonb,                      -- {property_observations: 3, property_sales: 1, …}
    merged_by       uuid REFERENCES staff_users(id),   -- NULL when a deterministic re-key did it (§4.3)
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_property_merges_survivor ON property_merges(survivor_id);
CREATE INDEX IF NOT EXISTS idx_property_merges_merged   ON property_merges(merged_id);
```

Access follows the rest of `/api/research`: `requireStaff` on the router, plus `platform_setup` for
the merge itself (it deletes a row), matching how `POST /backfill` and `POST /geocode/run` are gated.

---

## 6. THE DETECTION QUERY

**The key is the parser.** `address_key` is `street|unit|locality|state`, so `split_part` recovers
each component *exactly as the key computed it* — no re-implementation of `tokenKey`/`unitKey` in
SQL, and no chance of the detector and the key disagreeing.

```sql
-- ---------------------------------------------------------------------------
-- DUPLICATE PROPERTY CANDIDATES. Every branch is a SUGGESTION for a human.
-- Nothing here merges anything.
-- ---------------------------------------------------------------------------
WITH p AS (
  SELECT id, address_key, display_address, city, state, zip, unit, units,
         property_category, observation_count, geo_latitude, geo_longitude, geo_precision,
         split_part(address_key, '|', 1) AS street_k,   -- "26 s 10th st"
         split_part(address_key, '|', 2) AS unit_k,     -- "2" / ""
         split_part(address_key, '|', 3) AS locality_k, -- "piscataway" / "z08854"
         split_part(address_key, '|', 4) AS state_k,
         substring(split_part(address_key,'|',1) from '^[^ ]+')        AS house_k,
         regexp_replace(split_part(address_key,'|',1), '^[^ ]+ ', '')  AS streetname_k
    FROM properties
   WHERE observation_count > 0
),
pairs AS (

  -- A. CITY-vs-ZIP-ONLY — one report named the town, the other only had a ZIP.
  --    The single biggest cause (~1/3 of files omit the comp's PropertyCity).
  SELECT a.id AS a_id, b.id AS b_id, 'zip_only_locality' AS cause, 'likely' AS confidence,
         'one report gave only a ZIP, the other named the town' AS why
    FROM p a
    JOIN p b ON b.street_k = a.street_k AND b.unit_k = a.unit_k AND b.state_k = a.state_k
   WHERE a.locality_k LIKE 'z%'
     AND b.locality_k NOT LIKE 'z%'
     AND b.zip IS NOT NULL
     AND substring(a.locality_k from 2) = b.zip

  UNION ALL
  -- B. SAME ZIP, DIFFERENT TOWN NAME. This is exactly the rule
  --    ADDR.sameAddress already applies for loan files ("the ZIP is the
  --    authority on locality") — offered here as a candidate, never as a key.
  SELECT a.id, b.id, 'same_zip_other_town', 'likely',
         'same ZIP, the town is written differently (' || a.city || ' / ' || b.city || ')'
    FROM p a
    JOIN p b ON b.street_k = a.street_k AND b.unit_k = a.unit_k AND b.state_k = a.state_k
   WHERE a.id < b.id
     AND a.zip IS NOT NULL AND a.zip = b.zip
     AND a.locality_k <> b.locality_k

  UNION ALL
  -- C. SAME ROOFTOP GEOCODE. The strongest general signal, and it costs nothing:
  --    both spellings were already looked up.
  --    TWO TRAPS, both load-bearing:
  --      * use geo_latitude/geo_longitude, NEVER eff_latitude/eff_longitude —
  --        eff_* COALESCEs in the APPRAISER's coordinates, which are frequently
  --        the ZIP centroid, so every property in a ZIP would look identical.
  --      * require unit_k to match. geocode.addressLine deliberately drops the
  --        unit ("no geocoder places an apartment"), so unit 2 and unit 5 of one
  --        building share a coordinate BY DESIGN and are correctly two properties.
  SELECT a.id, b.id, 'same_geocode',
         CASE WHEN a.streetname_k = b.streetname_k THEN 'likely' ELSE 'possible' END,
         'both addresses place at the same rooftop coordinate'
    FROM p a
    JOIN p b ON b.geo_latitude = a.geo_latitude AND b.geo_longitude = a.geo_longitude
   WHERE a.id < b.id
     AND a.geo_latitude IS NOT NULL
     AND a.geo_precision = 'address' AND b.geo_precision = 'address'
     AND a.unit_k = b.unit_k

  UNION ALL
  -- D. A UNIT ON ONE SIDE, NONE ON THE OTHER, on something that does not look
  --    like a condo building. Ranked lower on purpose: on a genuine 2-family
  --    "26 Main St" and "26 Main St Unit 1" really are two rows we want.
  SELECT a.id, b.id, 'unit_absent',
         CASE WHEN COALESCE(a.units, b.units, 1) <= 1 THEN 'possible' ELSE 'weak' END,
         'one report stated a unit (' || b.unit || ') and the other did not'
    FROM p a
    JOIN p b ON b.street_k = a.street_k AND b.locality_k = a.locality_k AND b.state_k = a.state_k
   WHERE a.unit_k = '' AND b.unit_k <> ''
     AND COALESCE(a.property_category, '') NOT ILIKE '%condo%'

  UNION ALL
  -- E. "26" vs "26A" vs "26-28". ADDR.houseMatches folds a range for a loan-file
  --    review; the key must not, because 26A is often a real separate address.
  SELECT a.id, b.id, 'house_number_variant', 'possible',
         'house numbers differ only by a letter or a range (' || a.house_k || ' / ' || b.house_k || ')'
    FROM p a
    JOIN p b ON b.streetname_k = a.streetname_k AND b.locality_k = a.locality_k
            AND b.state_k = a.state_k AND b.unit_k = a.unit_k
   WHERE a.id < b.id
     AND a.house_k <> b.house_k
     AND ( b.house_k = a.house_k || '-' || split_part(b.house_k, '-', 2)   -- 26 / 26-28
        OR b.house_k ~ ('^' || a.house_k || '[a-z]$')                      -- 26 / 26a
        OR a.house_k ~ ('^' || b.house_k || '[a-z]$') )

  UNION ALL
  -- F. A TYPO'D HOUSE NUMBER, corroborated by a TRANSACTION. Never proposed on
  --    the address alone — 26 and 62 are two real houses on nearly every street.
  --    Two rows on one street that recorded the SAME sale on the SAME day for the
  --    SAME price are one house with one digit wrong.
  SELECT a.id, b.id, 'house_number_typo', 'possible',
         'different house numbers, but both recorded the same sale on ' || sa.sale_date::text
    FROM p a
    JOIN p b ON b.streetname_k = a.streetname_k AND b.locality_k = a.locality_k
            AND b.state_k = a.state_k AND b.unit_k = a.unit_k AND a.id < b.id
    JOIN property_sales sa ON sa.property_id = a.id
    JOIN property_sales sb ON sb.property_id = b.id
                          AND sb.sale_date = sa.sale_date
                          AND sb.sale_price = sa.sale_price
   WHERE a.house_k <> b.house_k AND sa.sale_price IS NOT NULL
)
SELECT DISTINCT ON (LEAST(a_id, b_id), GREATEST(a_id, b_id))
       LEAST(a_id, b_id) AS property_a, GREATEST(a_id, b_id) AS property_b,
       cause, confidence, why
  FROM pairs
 WHERE NOT EXISTS (
         SELECT 1 FROM property_not_duplicates n
          WHERE n.property_id = LEAST(a_id, b_id)
            AND n.other_property_id = GREATEST(a_id, b_id))
 ORDER BY LEAST(a_id, b_id), GREATEST(a_id, b_id),
          array_position(ARRAY['likely','possible','weak'], confidence)
 LIMIT 200;
```

**Indexes it needs** (`pg_trgm` is contrib and cannot be assumed on Render — CLAUDE.md — so every
branch above is an equality join, deliberately):

```sql
CREATE INDEX IF NOT EXISTS ix_properties_key_street
  ON properties((split_part(address_key,'|',1)), (split_part(address_key,'|',4)));
CREATE INDEX IF NOT EXISTS ix_properties_geo_pair
  ON properties(geo_latitude, geo_longitude) WHERE geo_latitude IS NOT NULL;
```

### The count-first query — run this before building anything past the detector

```sql
SELECT cause, confidence, count(*) FROM ( /* the CTE above, without the LIMIT */ ) c
 GROUP BY 1, 2 ORDER BY 3 DESC;
```

If `zip_only_locality` is in the thousands, ship §3.7's one-line ingest fix and the re-key
immediately. If `house_number_typo` returns four rows, do not build a screen for it — put those four
pairs in front of a human once and move on.

---

## 7. WHAT NOT TO BUILD

**Be clear about the size of this.** The key already handles almost everything an appraiser varies.
The merge tool is a **small backstop for a small number of pairs**, and one ingest line plus one
re-key sweep removes the largest bucket entirely. Anything beyond that is building a system nobody
needs.

Specifically, do not build:

1. **An automatic or fuzzy merger.** Nothing merges without a human, with exactly one exception: a
   deterministic re-key collision (§4.3), where the human judgement happened when the key rule was
   reviewed. A background job that merges on a similarity score will eventually fold two houses and
   corrupt every price-per-foot read in the warehouse — silently, because nothing on the screen looks
   wrong afterwards.
2. **A similarity/edit-distance engine.** No Levenshtein, no `pg_trgm` (unavailable on Render
   anyway), no scoring model. Every branch in §6 is a *reason a human can read* — the same discipline
   `findDuplicates` already uses for borrowers: *"Every candidate carries WHY, so the staffer is
   never asked to trust a bare score."*
3. **A vendor address canonicalizer.** `lib/address-canon` (Google `place_id`) is excluded from the
   warehouse on purpose: one HTTP round trip per string, `null` with no API key. Do not reintroduce
   it as a "just for dedupe" call.
4. **A borrower-style field-by-field conflict UI.** §2 — the roll-up already resolves every fact. The
   merge screen shows two addresses, two observation counts, the reason they were proposed, and two
   buttons: **Same house — merge** / **Not the same house**.
5. **A ZIP-keyed or ZIP-in-the-key variant of `propertyKey`.** §3.5. It trades a small problem for a
   larger one.
6. **A ZIP→city crosswalk inside the key**, whether vendored or built from our own rows. §3.7 — it
   breaks the pure/deterministic/offline contract, and the ingest-side fix is smaller and better.
7. **A review queue / notification / email flow.** This is a staff research screen with a candidate
   list, not a workflow. `sync_review_queue` is for things that block a loan file; a duplicate
   property blocks nothing.
8. **Anything that relaxes the unit rule or the "no house number / no state / no locality → no key"
   rule.** Those two are the reason the warehouse is trustworthy, and a duplicate row is a much
   cheaper mistake than either.

**Estimated size of the whole build:** one migration (`db/415`), ~200 lines in
`src/lib/research/property-merge.js`, ~40 lines across two routes, one candidate panel on the
existing research screen, one line in `ingest.writeReport`, ~15 lines in `property-key.js`, and
`scripts/test-research-property-merge.js` (pure assertions on the `DISPOSITION`/`MATCH` maps and the
throw-on-unknown-table guard, plus a DB-gated end-to-end merge asserting that observations, sales and
photos all moved, that the survivor re-rolled from the union, and that a marked non-duplicate never
comes back) wired into `npm test`.
