# HANDOFF — the property / comparable / appraiser research warehouse

**For the developer taking this over.** Written to be read start to finish once, then
used as a map. It assumes you have read `CLAUDE.md`'s house rules (especially the
frozen-pricing rule, the "previous AND future" rule, and the Encompass read-only
freeze) but nothing about this feature.

Everything described here is **merged to `main`** except where a section says
otherwise. Migrations `db/409`–`db/414` and `db/416`.

---

## 1. WHAT THIS IS, IN ONE PARAGRAPH

Every appraisal PILOT imports was already parsed and stored — but stored **per loan
file**, so the data could only ever answer *"what did THIS report say?"*. The
warehouse re-files the same data as a cross-file database: one row per real-world
**property**, one row per **report × property** observation, the distinct **sales**,
the **photos**, and a registry of every **appraiser**. On top of that sit a search
engine, a standalone XML upload door, a distance/radius layer, a build-your-own
valuation tool, and a duplicate merge.

It adds no new extraction. It is a different **filing system** for data we already had.

---

## 2. THE ONE IDEA YOU MUST HOLD

```
property_observations   ← the CONTENT. What ONE appraiser said about ONE property
                          on ONE date. Never overwritten. Immutable history.
        ↓  rollupProperty()
properties              ← the ROLL-UP. The best-known current answer for each fact.
                          DERIVED. Nothing writes a property fact directly.
```

**`properties` is not a table you write to.** `upsertProperty` writes the *address
columns only*. Every other fact is recomputed by `ingest.rollupProperty()` from the
observations, by one rule:

> for each fact, the most recent report that **stated** it wins; a report that was
> **silent** never blanks it.

Consequences you will trip over if you forget this:

- Adding a fact to `properties` means adding it to `ROLLUP_FACTS` in
  `src/lib/research/ingest.js` **and bumping `ROLLUP_VERSION`** — the boot sweep
  `rerollStaleProperties` then back-fills every existing row. That is the entire
  migration story for a new fact. Do not write a SQL back-fill; a PL/pgSQL twin of
  the roll-up would drift (this repo has been bitten by exactly that —
  `pilot_term_norm`, `pilot_property_type_norm`).
- **A roll-up that throws leaves a property with an address and nothing else**, which
  reads on screen as "we know nothing about this property", not as an error. That
  exact failure shipped once (PR #974) and is the single sharpest lesson in here —
  see §7.
- A column that is a fact about the **report** (proximity, days on market, $/sq ft,
  the adjustment lines, `comp_set`) must **not** roll up. It stays on the observation.

---

## 3. THE FILES, AND WHAT EACH ONE IS FOR

### Server

| File | What it owns |
| --- | --- |
| `src/lib/research/property-key.js` | **The identity rule.** Decides two address lines are the same house. PURE, OFFLINE, no network — read its header before touching it. |
| `src/lib/research/identity.js` | The appraiser identity rule (licence first, then name+firm). |
| `src/lib/research/ingest.js` | The ingest. `ingestAppraisal` (loan-file door), `writeReport` (the shared body BOTH doors use), `rollupProperty`, `backfill`, `rerollStaleProperties`. |
| `src/lib/research/xml-import.js` | The **standalone upload** door — raw XML in, no loan file. |
| `src/lib/research/search.js` | The query builder + `searchProperties` + `facets`. |
| `src/lib/research/valuation.js` | The pure grid engine: adjustments, market rates, `scoreComp`, reconciliation. |
| `src/lib/research/geocode.js` | Places properties on the map (US Census, then OpenStreetMap). |
| `src/lib/research/property-merge.js` | Duplicate detection + merge + "not a duplicate". |
| `src/routes/research.js` | Everything above, mounted at `/api/research`, `requireStaff` on the whole router. |

### Frontend (`app-v2/src`, built into `web/v2/portal`)

`screens/StaffPropertyResearch.jsx` (search + the add-files panel) ·
`screens/StaffPropertyDetail.jsx` · `screens/StaffAppraisers.jsx` ·
`screens/StaffAppraiserDetail.jsx` · `screens/StaffValuation.jsx` ·
`components/ResearchImportPanel.jsx` · `components/NearbyComps.jsx` ·
`lib/research.js` (formatters + shared styles).

**After any change under `app-v2/src` you must run `cd app-v2 && npm run build` and
commit the regenerated `web/v2/portal/` bundle**, or it does not deploy. Render does
not build the frontend.

### Tests — all in `npm test`

| Suite | Proves |
| --- | --- |
| `test-research-property-key.js` | the dedupe **decisions** (48) — pure |
| `test-research-valuation.js` | the grid maths and its refusals (62) — pure |
| `test-research-db.js` | ingest → roll-up → search → routes, end to end (85) |
| `test-research-xml-import-db.js` | the upload door, both reconciliation directions, **and the loan-file importer** (69) |
| `test-research-geocode-db.js` | the roll-up-wipe regression, the box-corner exclusion, count/page agreement (32) |
| `test-property-merge-db.js` | the ingest split fix + the merge + the safety rails (29) |
| `test-google-coord-expiry-db.js` | the Google coordinate window (30) |

`scripts/lib/research-xml-fixture.js` builds a synthetic MISMO 2.6 appraisal in code
(1004 or 1025, with a rent roll). **The real appraisal corpus is not in the
repository**, so most of the parser's own suites SKIP in CI — which is why
`test-research-xml-import-db.js` deliberately doubles as the only CI coverage for
`lib/appraisal/import.js`. If you change that importer, that is the suite that
catches you.

---

## 4. THE RULES THAT LOOK WRONG AND ARE RIGHT

Each is enforced in code and asserted in a test. Relaxing any of them is a
correctness regression, not a simplification.

1. **A renovation report's subject condition describes the house AFTER the repairs.**
   `condition_basis='as_repaired'` is recorded and the roll-up skips it for
   condition/quality. Otherwise the warehouse claims a gutted 1930 house is in
   like-new condition today — on exactly the files this lender writes most.
2. **A listing is not a sale.** An active/pending comp's price is an *asking* price →
   `last_list_price`, never `last_sale_price`. (`sale_status IS NULL` means *closed*.)
3. **UAD condition and quality are ordinal and run BACKWARDS** — C1 is best. "C3 or
   better" is `condition_rank <= 3`. A string comparison means the opposite.
4. **A superseded report is the same report re-imported**, so it is retired, not
   counted twice. Its *sales* are kept — a prior draft is not a retraction.
5. **Every FK from an observation/photo back to a report is `ON DELETE SET NULL`,
   never CASCADE.** `appraisals.application_id` cascades, so a CASCADE here would let
   deleting one loan file erase every comparable sale that report ever taught us.
6. **The unit is never dropped from the key.** Unit 2 and unit 5 of one building sell
   for different prices; folding them corrupts every price-per-foot read.
7. **The key returns null rather than guess.** No house number, no state, or no
   locality → no key, and the row is SKIPPED and **counted** in the ingest ledger.
8. **A comparable's property TYPE and UNIT COUNT are never inherited from the report's
   subject.** They are genuinely absent from most MISMO 2.6 grids. The warehouse
   answers properly when that address turns up as some other report's *subject*.
   (The **town** *is* inherited, gated on the ZIP — see §6. Know why these differ.)
9. **The "15% net / 25% gross" adjustment pair is NOT a current Fannie Mae rule.** It
   was removed from the Selling Guide in December 2014. It is kept as *our own*
   review flag and the copy must never call it a GSE requirement.
10. **Nothing here is an appraisal or a USPAP work product.** The disclaimer is
    stamped into every valuation result and must travel with the number.

---

## 5. HOW DATA GETS IN — three doors, one mapping

```
              ┌─ loan file: appraisal desk → appraisals + appraisal_comparables
              │        ↓ ingestAppraisal()
XML ──────────┼─────────────────────────►  writeReport()  ──►  the warehouse
              │        ↑ importXml()
              └─ standalone upload (db/411): no application, no appraisals row
```

`appraisalRowFrom` / `comparableRowFrom` are **factored out of
`src/lib/appraisal/import.js`** and `writeReport` out of `ingestAppraisal`, so one
report is mapped **one way** whichever door it arrives through. A fact filed
differently by door would make half the market unsearchable and would be invisible
until somebody's search came back wrong. **Do not add a third mapping.**

**One report is one report.** The same appraisal can arrive both ways. They are
reconciled on the report's fingerprint — *property + effective date + appraiser* —
and the **loan-file copy always wins** (it is the one carrying the photographs).
Handled from both directions: the upload stands down if a file already has it
(`existingFileCopy`), and a file's ingest retires an earlier upload
(`retireDuplicateImports`).

**Back-filling** runs at boot, oldest report first, bounded and self-draining via
`property_ingest_log`. `POST /api/research/backfill` (`platform_setup`) pushes it
along. Anything whose log status is not `ok`/`skipped` is retried — **that is the
recovery path** for any bug that breaks an ingest.

---

## 6. DEDUPLICATION — what handles what

This is the owner's most-repeated requirement, so know exactly where each part lives.

**The key folds two spellings of one address** (`propertyKey`): street-type
suffixes, directionals, case, punctuation, a missing/ZIP+4/wrong ZIP, `Village of X`,
an address packed into the street field, inline-vs-field units. Tested by name in
`test-research-property-key.js`.

**The roll-up merges the facts** — newest report that stated a fact wins, silence
never blanks. This is the owner's *"add the missing information one appraisal had and
the other didn't"*, and it is asserted in `test-research-db.js` §3b.

**The ingest closes the biggest split** (db/416 work): a comp that named no **town**
used to key on its ZIP while the same house on a town-naming report keyed on the
town. A comp with no city now inherits the **subject's**, *gated on the ZIPs
matching*. Pure, offline, deterministic, and monotone — a different ZIP changes
nothing. This is why rule 8 in §4 has an exception for the town and not for the type.

**The merge handles what a rule never can** (`property-merge.js`): a typo'd house
number, a unit on one report and not the other. **Never automatic.** Three detection
branches, each with its own stated reason. `platform_setup` to merge.

**If you extend the merge**, the three things that will bite you:
- `assertRefsComplete` **throws** on a table that references `properties` and isn't in
  `REFS`. That is deliberate: three of the six FKs CASCADE, so an undeclared table
  would be silently **deleted**, not orphaned. Add your table to `REFS`; do not
  suppress the throw.
- Each dedupe predicate **mirrors the unique index that will actually fire**, not a
  generic rule. `uq_property_sale` keys on `COALESCE(sale_price,-1)`, so two NULL
  prices genuinely *do* collide there — the opposite of the borrower-merge warning.
- The **duplicate detector must use `geo_latitude/longitude`, never `eff_*`.** The
  effective columns COALESCE in the *appraiser's* coordinates, which are frequently
  a ZIP centroid — every property in a ZIP would look identical.

---

## 7. THE BUGS THAT SHIPPED, AND WHAT THEY TEACH

Read this section before changing the roll-up or the search.

### 7.1 A jsonb value bound raw wiped every fact off every property (PR #974)

A `jsonb` column **reads back as a JS object or array**. Bind that value into the next
statement and node-postgres serialises a JS array as a **Postgres array literal** —
and Postgres answers `invalid input syntax for type json`. Every write into these
tables goes through `JSON.stringify` on the way *in*, so this was invisible until the
roll-up started carrying a jsonb column (`unit_mix`).

The blast radius was total rather than partial for two compounding reasons, and both
are general lessons:

- `upsertProperty` writes only the address, so **every** fact comes from the roll-up —
  a throw leaves an address and nothing else, which looks like ignorance, not an error;
- the roll-up ran **bare in a loop** over every property the report touched, subject
  first — so one throw abandoned the whole report and one 2-4 family subject wiped the
  facts off every comparable on it.

Fixed with `bindable()` at the parameter site (generic, so the next jsonb fact is safe)
plus a per-property `try/catch` that **counts and names** the failure rather than
swallowing it.

### 7.2 Three bugs made the radius search a mirage (db/412)

- **A geocode written into `properties.latitude` was silently wiped**, because that is
  a roll-up column and a column no observation states goes back to NULL. It would have
  passed every manual check on the day it was written. The lookup now has its own
  `geo_*` columns plus generated `eff_latitude`/`eff_longitude`.
- **The exact circle was cut in JavaScript, after the SQL `LIMIT`.** The total came
  from a window function that had counted the bounding **box**, so counts overstated by
  up to 27% and pages came back short. Cut it in SQL.
- **No subject property was ever geocoded**, so the largest weight in `scoreComp` was
  scoring zero for everything.

### 7.3 Missing data was scored as a bad match

`scoreComp` counted an unknown at full weight with nothing earned, so a property next
door — identical in every way, with no coordinates and no size on file — could not
beat 45/100. Unknowns now leave the denominator and the score reports its
**coverage** alongside. *"We don't know"* is not *"it's a bad match"*.

### 7.4 A value we offered was a value the server ignored

The nearby-comps panel offered "Sold at any time", which arrives as an empty
parameter — and the route stripped empty values before applying its 18-month default,
so the option silently did nothing. **If you add an option to a picker, make the
server accept it in the same commit.**

---

## 8. GEOCODING — the vendor decision, already made

**Buy nothing.** Distance between two known points is arithmetic and `search.js`
already does it correctly (bounding box + haversine, with the longitude delta widened
by `1/cos(lat)` — the part everyone gets wrong). What was missing was *coordinates*.

Those come from the **US Census Bureau geocoder** (US federal service: no account, no
key, no card, no restriction on storing the answer) with **OpenStreetMap Nominatim**
as the fallback. Both keyless.

**Deliberately not Google.** Maps Platform permits keeping a `place_id` indefinitely
but caps a stored latitude/longitude at **30 consecutive days** unless the cache is
isolated to a single end user — which a shared warehouse is not. Complying would turn
a one-off backfill into a permanent monthly bill (~$14,400/yr at 250k properties) for
a number that never moves. Full comparison with the terms quoted:
`docs/research/GEOCODING-DISTANCE-VENDOR-RESEARCH.md`.

**OpenStreetMap has a hard one-request-per-second policy** and the sweep holds a
module-level 1.1s floor for it. Breaching it gets the user agent blocked for
*everyone*, not just this sweep. Do not remove that.

**The Census geocoder could not be reached from the build sandbox** (the outbound
proxy denies it), so its live response shape is **unverified**. The OSM fallback
covers a shape mismatch and the sweep degrades to placing nothing rather than placing
anything wrong — but **this is the first thing to confirm in a real environment**.
The `x`/`y` order in the Census response is longitude/latitude, which is the easiest
thing here to get backwards.

**Related, and separate:** `address_canon_cache` (db/124, the loan-file address
matcher) was holding Google coordinates permanently. db/413 expires them at 30 days
and keeps `place_id` forever, so `samePlace()` is untouched — pinned by a test that
matches two spellings of one property *from cache, after the sweep, with no Google key
present*. If that test ever fails, a compliance change has broken address matching
platform-wide.

---

## 9. WHAT IS NOT BUILT — the open work, in priority order

### 9.1 Pull the appraisal XMLs out of Encompass — **the big one**

Full research: `docs/research/ENCOMPASS-APPRAISAL-XML-RESEARCH.md`. **No code was
written and no Encompass module was touched.**

The finding: the appraisal XML is attached to the loan in a place the Encompass UI
**cannot display** — XML is not an eFolder-supported format, so it is filed as a loan
attachment reachable only through the Developer Connect APIs. That is exactly why only
the PDF is visible, and it means *"the eFolder only has the PDF"* is not evidence the
XML is missing. The tenant's own field catalog carries
`CX.IMPORTAPPRAISALXMLWHEN` — somebody there already built an appraisal-XML trigger.

**Three hops, and only one needs permission:**

| Step | Call | Status |
| --- | --- | --- |
| Find it | `GET /encompass/v3/loans/{guid}/attachments` (+ `/documents`) | **legal today** |
| Get bytes | `POST /encompass/v3/loans/{guid}/attachmentDownloadUrl` | **needs the 4th allowlist entry** |
| Fetch | GET the returned time-limited URL | foreign host — needs its own SSRF-guarded fetcher |

> ⚠️ **`src/lib/integrations/encompass.js` structurally refuses every method except
> GET, with a hard-coded allowlist of exactly three read-shaped POSTs.** `CLAUDE.md`
> requires the **owner's sign-off in their own words** for a fourth. Do not add one on
> your own judgement, and do not route around it. If you build this, build it isolated
> as `src/encompass/appraisal-xml.js` with its own narrow allowlist (the
> `flood-order.js` pattern) so `test-encompass-readonly.js` stays green — that is
> **blast radius, not a way around sign-off**.

**Do the read-only probe first.** `GET .../attachments`, `/documents` and
`/serviceOrders` on 3–5 real loans are all permitted *today* and close most of the open
questions, including whether the 4th POST is needed at all. The owner has offered a
test environment.

Three things the owner was asked to confirm, unanswered at handoff:
1. a recent funded loan's Appraisal folder — exact file names, anything not a PDF?
2. Services Management → the AMC → Document Mapping: is there an appraisal-XML row,
   and is it **on**? If off, no API can produce the file.
3. eFolder Conversion Preferences: is *"keep a copy in its original format"* ticked?
   If not, `originalUrls` comes back empty.

Two constraints for whoever builds it: there is **no bulk attachment query** (one call
per loan; ~53 min for 3,000 loans at the existing pace, and the tenant shares a
30-concurrent-call ceiling with every other YS integration), and MISMO files embed the
whole PDF as base64 (5–30 MB each) so you must **parse and discard** — persist
warehouse rows plus the sha256, never the file. Also: **UAD 3.6 is mandatory for GSE
submissions from 2 Nov 2026** and `extract.js` refuses it by name today. These are
business-purpose loans that never go to the GSEs, so nothing forces 3.6 onto a YS file
— but count the refusals from day one; that number is the business case for a 3.6
reader.

### 9.2 Everything else, ranked

| Item | Where the thinking already is |
| --- | --- |
| The comp-search UX (subject-anchored search, relaxation ladder, a real map) | `docs/research/COMP-SEARCH-UX-RESEARCH.md` — note `GET /api/research/comps` already exists and is now used by `NearbyComps`; the *browse* screen is still absolute-filter-only |
| More facts out of the XML (the 1004MC market grid, the as-is condition mined from `PROPERTY_ANALYSIS`, the comp's **contract** date which `settledMonth()` currently discards, adjustments as rows) | `docs/research/XML-FIELD-EXPANSION-RESEARCH.md` |
| Building a real AVM | `docs/research/INTERNAL-AVM-ROADMAP.md` — read §1 (the arithmetic on how few unique sales we actually have) and §7 (the 2024 AVM rule reaches a **consumer's principal dwelling even on a business-purpose loan**, so exemption is deal-by-deal, not categorical) before writing any model code |
| A `key_version` re-key sweep, if the key is ever tightened | `docs/research/PROPERTY-DEDUPE-AND-MERGE.md` §4.3 — build the merge **first**, because `address_key` is UNIQUE and any key change creates collisions that need somewhere to go |

**What NOT to build** is stated in each doc and is worth taking seriously — notably: no
fuzzy/automatic property merger, no similarity scoring, no second implementation of
the comp score, no drive-time distance, and no model fitted on appraiser-selected
comps (they are a deliberately non-random sample; a model learns selection behaviour,
not the market).

---

## 10. OPERATING IT

**Boot passes** (all bounded, self-draining, never fatal, all in `src/server.js`):

| Pass | Off switch |
| --- | --- |
| `ingest.backfill` — fold the appraisal corpus in | — |
| `geocode.backfillGeocodes` — place properties on the map | `RESEARCH_GEOCODE_DISABLED=1` |
| `ingest.rerollStaleProperties` — re-roll rows behind the current `ROLLUP_VERSION` | — |
| `address-canon.expireGoogleCoordsOnce` — the 30-day window | — |

**Env**: `RESEARCH_GEOCODE_BOOT` (default 120), `RESEARCH_GEOCODE_PACE_MS` (350),
`RESEARCH_REROLL_BOOT` (500), `GOOGLE_COORD_TTL_DAYS` (30).

**Access**: every staff user, no per-file scoping — a deliberate departure from the
loan-file rule, because the data is addresses, property characteristics and recorded
sale prices, with no borrower name, loan amount, contact detail or document. Photo
bytes are served only for a document actually linked in `property_photos`, so this
never becomes a "download any document by id" hole. Merging and the corpus back-fill
need `platform_setup`.

**Health check for "is it working?"** — `GET /api/research/stats` (how much of the
corpus is folded in, and what is pending) and `GET /api/research/geocode/status` (how
many properties can be measured a distance to).

---

## 11. IF SOMETHING LOOKS WRONG

| Symptom | Look here first |
| --- | --- |
| A property page shows `?` for every fact | The roll-up failed for that row. Check `property_ingest_log` for `status='error'` and `properties.rollup_version`. §7.1 is the shape this takes. |
| A comparable is in the database twice | `GET /api/research/duplicates?property_id=…`. If the pair is *not* offered, the detector's branches (§6) need a new one — do not loosen the key. |
| A radius search returns nothing | Is the **subject** placed? `subject_located` on the `/comps` response says so explicitly, and the UI shows a banner. |
| A fact is in the reports but not searchable | It is on the observation and not in `ROLLUP_FACTS`. Add it, bump `ROLLUP_VERSION`, add a search filter. |
| An uploaded XML says "already here" | Working as intended — that report is already in from a loan file. The response names the appraisal. |
| Counts disagree between the list and the total | Something is filtering in JS after the SQL `LIMIT`. That was §7.2 and must not come back. |

---

## 12. THE HOUSE RULES THAT APPLY HARDEST HERE

- **Never merge past a conflict carelessly.** `main` moved five times during this
  build and collided on migration numbers twice. Renumber **yours**, never theirs
  (theirs may already be applied in production), fix the migration's own header
  self-label, keep **every** suite from both sides in `package.json`, and rebuild the
  portal bundle from the fully merged `app-v2/src` whenever their commit touched
  `app-v2`.
- **Previous AND future.** A schema change needs a deterministic, idempotent
  back-fill. In this subsystem that usually means a version column plus a bounded boot
  sweep, not SQL.
- **Verify a write by re-reading it.** "Returned 200 but didn't save" is this repo's
  most common bug class.
- **A green build does not mean the page renders.** Run eslint `no-undef` on changed
  `.jsx` — an undeclared identifier compiles fine and throws at render.
- **Talk to the owner in plain, short, business language.** No jargon. That is a
  standing, non-negotiable instruction.
