# Geography, address identity and property data — what to buy, what to build, and what is already broken

**Researched 2026-08-03.** Answers the owner's ask:

> *"They put in the subject property address and the system should realise by itself, using good APIs,
> where exactly it is — and it should know by itself how close the comparables are, not by looking just
> on the city, but really according to the map, according to the distance. Make sure you're not
> duplicating comparables, make sure you know the distances, and make sure the system works properly."*

This is a companion to — **not a replacement for** — `docs/research/GEOCODING-DISTANCE-VENDOR-RESEARCH.md`
(the geocoding buy decision, already made and already built as `src/lib/research/geocode.js`) and
`docs/research/RESEARCH-WAREHOUSE-HANDOFF.md` (how the warehouse works). Where they already answer a
question, this document points at them and moves on. What it adds is: **a measurement of how much of the
owner's ask is reachable today**, **an adversarial audit of the identity/dedupe rule with every defect
reproduced against the real function**, **a verification of the distance arithmetic**, **the geography
beyond a circle**, and **the property-data enrichment layer nobody has costed yet**.

---

## BOTTOM LINE, IN SIX SENTENCES

1. **The distance engine is right; the fuel tank is empty.** `search.js` computes distance correctly and
   `geocode.js` places properties correctly — but on the database in front of me **not one property has
   ever been placed by a real geocoder** (`geo_source='census'`: 0, `geo_source='osm'`: 0). The radius
   filter is a mirage on a full tank of nothing.
2. **Do not buy a geocoder yet — turn on the one that is already written**, and add ONE guard to it
   before you do (§2.3): it currently accepts a match that silently changed the street.
3. **The one thing worth paying for is `Geocodio` as the backstop** — $1 per 1,000, true US rooftop,
   **permanent storage with no restriction**, batch, and it appends **census tract + school district**
   in the same call. That single vendor covers §1 and most of §3.
4. **Straight-line distance is the correct answer to show** — it is what Fannie Mae's own form requires
   (*"1.75 miles NW"*), what every appraisal we hold already states, and what the GSEs judge against.
   Drive time is a recurring bill for a worse number. Show road distance nowhere.
5. **The dedupe key has ten proven defects** (§4) — seven that split one property into several keys and
   **three that merge genuinely different properties into one**. Two of them are severe: two houses in
   different ZIPs collapsing onto one key, and `Suite 5` / `Apt 5` / `Bldg 5` / `Lot 5` being treated as
   the same unit. All are fixable in `property-key.js` with no vendor and no network.
6. **A normalized address key is not enough on its own, but USPS CASS is the cheap second signal we
   already have wired** (`src/lib/integrations/usps.js`, free, unused on 0 of 706 files). A parcel APN is
   the strong second signal and the appraisal states it for the **subject only, never for a comparable** —
   which is exactly why the enrichment layer in §5 matters.

---

## 1. THE MEASUREMENT — how much of the ask is reachable today

**Snapshot: `ysmerge` @ 2026-08-03 04:25 UTC.**

> ### ⚠️ READ THIS BEFORE QUOTING A NUMBER
> **This database is the TEST database, not production.** `npm test` was running against it while I
> measured (`ps` shows the suite mid-run), the row count moved from 94 → 104 between two queries, and
> **93 of 94 properties carried synthetic addresses** minted by the fixtures (`Geotownfifcchh`,
> `Piscatbbgbaddi`, `Testvilleijagrqtppl`, `Factville`). Exactly **one** row had a real-looking town.
> So the *counts* below describe a test corpus. What they describe **accurately and importantly** is the
> **shape of the pipeline** — which stages have ever produced a row and which never have. That is the
> finding, and it does not depend on the corpus.

### 1.1 Coordinate coverage

| Measure | Count | Of 104 |
|---|---|---|
| `properties` rows | **104** | — |
| **Measurable distance** (`eff_latitude IS NOT NULL`) | **14** | **13.5 %** |
| …of which **looked up by us** (`geo_latitude`) | 8 | 7.7 % |
| …of which **the appraiser's own figure** (`latitude`) | 6 | 5.8 % |
| `geo_source = 'census'` | **0** | **0 %** |
| `geo_source = 'osm'` | **0** | **0 %** |
| `geo_source = 'test'` (fixtures) | 16 | 15.4 % |
| **Never attempted** (`geo_attempted_at IS NULL`) | **80** | **76.9 %** |
| Attempted and failed | 16 | 15.4 % |
| Gave up (`geo_attempts >= 3`) | 0 | 0 % |

`geo_attempts` distribution: **86 rows at 0**, **8 rows at 1**, nothing higher. Nothing has exhausted its
three tries, so nothing is stuck — the sweep has simply barely run.

**The conclusion that matters: `geo_source` has never once been `census` or `osm`.** Every placed row is
either a test fixture or an appraiser's own coordinate. The backfill (`backfillGeocodes`) is written,
correct, and has effectively never executed against real data.

### 1.2 Why they failed, honestly

Of the 16 attempted-and-failed rows, **the address was not the problem**: 104 of 104 properties carry a
street *and* a locality, so `addressLine()` builds a lookup string for **every single one**. They failed
because the fixtures are invented towns that no geocoder can place — which is correct behaviour, not a
bug. **There is no evidence in this database of a real address that the Census geocoder could not place.**

I verified the service works from this environment, live:

```
"26 S 10th St, Piscataway, NJ 08854"   → census, 40.579335 / -74.455853   (address-level)
"1727 S 2nd St, Piscataway, NJ 08854"  → census, 40.595432 / -74.454210   (address-level)
"5701 15th Ave, Brooklyn, NY 11219"    → census, 40.627801 / -73.992366   (address-level)
```

### 1.3 The other coverage numbers the ask depends on

| Fact | Coverage | Why it matters |
|---|---|---|
| `property_observations.latitude` — **comparables** | **0 of 77** | The appraiser's software almost never geocodes a comp in the XML. We cannot inherit coordinates; we must look them up. |
| `property_observations.latitude` — **subjects** | **0 of 50** | Confirms db/412's premise: a subject is *never* geocoded by the vendor. |
| `property_observations.proximity` — comparables | **42 of 77 (55 %)** | **The appraiser's own stated distance ("0.35 miles NE") is on file for over half of comps and is used for nothing.** See §2.5. |
| `appraisals.apn` | **5 of 71 (7 %)** | An APN as a second identity signal is available on a small minority of reports — and **subject-only**. |
| `appraisals.census_tract` | **5 of 71 (7 %)** | Same: subject-only, never per comp (`ingest.js:1105` writes `census_tract: null` for every comparable). |
| `applications.usps_address` stamped | **0 of 706** | USPS is fully wired and **has never been switched on**. |
| `applications.property_address` present | 283 of 706 (40 %) | The loan-file side of the same address problem. |

**What this adds up to:** the owner's ask — *"know by itself how close the comparables are… really
according to the map"* — is today answerable for **13.5 %** of the warehouse, and the 13.5 % is mostly
fixtures. Turning on the existing sweep is the single highest-value action in this entire document, and
it costs nothing.

---

## 2. GEOCODING

### 2.1 The vendor decision is already made, and it is still right

`docs/research/GEOCODING-DISTANCE-VENDOR-RESEARCH.md` compares Google, Census, Nominatim, Mapbox, HERE,
Precisely, Smarty, Melissa-class, Geocodio, AWS Location and others at length, with the licence terms
quoted. **Do not re-litigate it.** The summary, so this document stands alone:

| Vendor | US residential accuracy | **Store the coordinate permanently?** | Price / 1,000 | Batch | Already in this repo? |
|---|---|---|---|---|---|
| **US Census Bureau** | Interpolated (a point on the street in front of the parcel), typically 10–40 m off the rooftop | **YES — unrestricted.** US Government work, no ToS restricting downstream storage | **$0** | **Yes, 10,000 per POST** | **YES** — `research/geocode.js`, and `appraisal/flood.js` |
| **Geocodio** | **True rooftop**, US/CA/MX only | **YES — "permanently store, share, reuse… without restrictions"** (sole exception: UK reverse geocoding, irrelevant here) | **$1.00** (rose from $0.50 on 1 Feb 2026); 2,500 free lookups/day | Yes — API + file upload | No |
| **OSM / Nominatim** | Fair; **misses house numbers often** | Data ODbL — storing results is fine. **The public server's policy forbids the bulk job** (1 req/s; scheduled scripts capped at 4/min) | $0 | **No — bulk explicitly restricted** | **YES** — fallback in `research/geocode.js` and `address-canon.js` |
| **Google Geocoding** | **Best-in-class** | **NO — 30 days**, then delete (Maps Platform Service Specific Terms §6.3.1). `place_id` may be kept forever (General Terms A.3) | $5.00 | **No batch endpoint** | **YES** — `address-canon.js` (loan-file address matching) |
| **Mapbox (Permanent)** | Very good | **YES** — `permanent=true`, internal use only, no redistribution | $5.00 | Yes | No |
| **AWS Location** | Very good (Esri/HERE data) | **YES — a priced product feature** (`intendedUse=Stored`) | ≈$4.00 | Yes | No |
| **Smarty US Rooftop** | **Best-in-class US rooftop** | **Conditional and self-cancelling** — storable *only while the subscription is active*, i.e. a permanent recurring bill or a purge | subscription, from ~$125/mo | Yes | No |
| **HERE** | Excellent | **Sources conflict** — base/freemium plans reportedly do NOT permit permanent storage **[verify]** | ~$1.00 | Yes | No |
| **Precisely / Pitney Bowes** | Best-in-class | Licensed, term-limited | enterprise quote (typically $10k+/yr) | Yes | No |
| **Melissa** | Good (CASS + GeoCoder) | Permissive on standard products **[verify current ToS]** | subscription/credits **[verify]** | Yes | No |

**Cost at the owner's volumes** (each property geocoded ONCE and cached forever — see §2.4):

| Volume | Census-first with a Geocodio backstop for the ~5–10 % Census misses |
|---|---|
| 10,000 properties | **$0–$10** one-time (backstop lookups are inside Geocodio's 2,500/day free tier) |
| 100,000 properties | **$5–$10** one-time |
| Ongoing (~900 new addresses/month at 100 appraisals/month) | **$0/month** — inside the free tier |

**Recommendation: keep Census as primary, replace Nominatim with Geocodio as the paid backstop, and pay
the ~$10.** Nominatim is the right last-resort *per-address* fallback for a one-off loan-file lookup — and
it is the wrong tool for a warehouse backfill, because the OSM usage policy explicitly throttles scheduled
bulk scripts to 4 requests/minute. Geocodio also solves §3's census-tract problem in the same call, which
is the tie-breaker.

### 2.2 Is the repo's permanent `place_id` cache compliant? — **Yes, and the coordinates were fixed**

The owner's question, answered precisely:

- **`address_canon_cache.place_id`, kept forever — COMPLIANT.** Google's General Service Terms A.3
  permits caching a Google ID indefinitely. `samePlace()` compares `place_id` identity, so the feature the
  cache exists for is untouched.
- **`lat` / `lng` / `formatted` / `zip` from a Google row, kept forever — WAS NOT COMPLIANT, and has been
  fixed.** §6.3.1 caps stored coordinates at 30 consecutive days; the §6.3.2 indefinite exception requires
  the cache to be *logically isolated to a single end user* and *not used as a replacement for calling the
  API*, and a company-wide address cache is neither. **`db/413` added `coords_expire_at`, back-dated every
  Google-sourced row, and `address-canon.js` runs a bounded boot sweep that blanks the coordinates while
  keeping the `place_id`.** Verified in code at `address-canon.js:159–203`.
- **`osm:`-prefixed rows — COMPLIANT and never expire.** OSM's licence permits keeping the result.
- **The research warehouse (`properties.geo_*`) is unaffected**, because it is Census/OSM-sourced by
  design. That was a deliberate choice in db/412, and it is the reason the warehouse can hold coordinates
  forever while the loan-file cache cannot.

**Rule going forward, and it is the whole reason to prefer Census/Geocodio: a coordinate that has to be
re-bought every 30 days is not an asset, it is a subscription to a number that never moved.**

### 2.3 🔴 **THE ONE REAL DEFECT IN THE GEOCODER — it accepts a match that changed the street**

Reproduced live against the Census service:

```
asked:   "26 S 10th St, Piscataway, NJ 08854"
matched: "26 10TH ST, PISCATAWAY, NJ, 08854"      ← the leading directional "S" is GONE
stored:  lat 40.579335, lng -74.455853,  precision:'address',  source:'census'

asked:   "26 10th St, Piscataway, NJ 08854"       ← a DIFFERENT query
matched: "26 10TH ST, PISCATAWAY, NJ, 08854"
stored:  lat 40.579335, lng -74.455853            ← THE IDENTICAL COORDINATE
```

`geocodeProperty()` returns `ok:true, precision:'address'` for both. **Two different streets, one
coordinate, and nothing anywhere records that a substitution happened.**

This repo has already been burned by exactly this class and already owns the fix. `src/lib/address.js`
carries `geocodeRewriteIsSafe(ours, provider)` — written after the 2026-07-28 incident where
`1727 S 2nd St, Piscataway, NJ 08854` was rewritten to `2nd St, Piscataway, NJ 07063` — and its rule #3 is
literally *"'S 2nd St' and '2nd St' are two different streets in the same town."* Run against the pair
above it answers **`false`**. `research/geocode.js` never calls it.

Worse: `geocodeProperty` *computes* `matched` (the provider's own echo of what it actually found) and
`backfillGeocodes` **throws it away** — only `lat`, `lng`, `source`, `precision` are written. So the one
piece of evidence that would let anyone audit this is discarded at the moment of writing.

**The fix, in the repo's own idiom, no vendor involved:**

1. In `geocodeProperty`, before returning a hit, call
   `ADDR.geocodeRewriteIsSafe(line, hit.matched)`. On `false`, treat it as **no match** — fall through to
   the next provider, and if none passes, record an attempt with no coordinate. A property we cannot place
   is honest; a property placed on the wrong street is the failure the owner is asking us to prevent.
2. Add `geo_matched_address text` and persist `hit.matched`, so "which address did the service think it
   was answering?" is answerable years later without re-calling anyone.
3. Keep `precision` meaning what the *provider* said, and add the safety verdict as its own column rather
   than overloading it.

This is the single highest-severity item in this document, because it fails **toward a confident wrong
answer** — which the house rules forbid by name.

### 2.4 The three rules `geocode.js` already gets right — do not relax them

They are worth restating because every one of them is the thing a "simplification" would remove:

1. **Only an exact address match is stored.** A street- or town-level answer puts every house on one road
   at the same point, and a quarter-mile radius over those *looks like it worked*. Nominatim's road-level
   answer (`addresstype:"road"`, no `house_number`) is refused.
2. **It never throws and never blocks.** A service being down means fewer properties placed today.
3. **It writes only the `geo_*` columns.** `latitude`/`longitude` are ROLL-UP columns recomputed from the
   observations; a geocode written there is silently wiped on the next ingest (db/412's whole point).

### 2.5 A free win nobody has taken: the appraiser already told us the distance

**42 of 77 comparable observations (55 %) carry `proximity`** — the appraiser's own
`ProximityToSubjectDescription`, e.g. *"0.35 miles NE"*. It is parsed, stored, surfaced on the observation
detail (`routes/research.js:893`) — **and used for nothing**. `scoreComp` gives 25 of 100 points to
distance and scores `unknown` when there are no coordinates, even when the report states the distance in
plain English.

**Recommendation:** parse `proximity` into `proximity_miles` + `proximity_bearing` at ingest and use it as
a **clearly-labelled fallback distance for that one report's grid**, ranked *below* a measured
coordinate distance. Two hard constraints:

- It is a distance **from that report's subject**, not from an arbitrary new subject — so it may only be
  used when the search's subject *is* that report's subject. It can never be promoted into a general
  distance between two warehouse properties.
- It must never be laundered into a coordinate. Bearing + distance from a subject we have not placed
  yields nothing; from a subject we *have* placed it yields an estimate, and an estimate written into
  `geo_latitude` would be indistinguishable from a real one. **Store it as a distance, never as a point.**

---

## 3. TRUE DISTANCE — what to compute, and what the code actually does

### 3.1 What the GSEs require, and it is straight-line

| Source | What it says |
|---|---|
| **Fannie Mae Selling Guide B4-1.3-08** | *"When describing the proximity of the comparable sale to the subject property, the appraiser must be specific with respect to the distance in terms of miles and include the applicable directional indicator (for example, '1.75 miles NW')."* |
| **Same section** | *"A minimum of three closed comparables must be reported."* — *"Comparable sales from within the same market area (including subdivision or project) as the subject property should be used when possible."* — *"Comparable sales that have closed within the last 12 months should be used… however, the best and most appropriate comparable sales may not always be the most recent."* |
| **Market area** | *"the geographic region, for a subject property, from which most demand comes and in which most of the competition is located"* — a **market**, not a radius. |
| **The "one-mile rule"** | **Not a Fannie Mae rule.** There is no one-mile radius standard anywhere in the Selling Guide. It is a *lender overlay* — many underwriters impose 1 mile suburban / 5 miles rural. |

**Two things follow, and both matter for how PILOT words things:**

1. **Show straight-line miles + a compass bearing.** It matches the 1004 grid, it matches the 42 of 77
   comps whose distance we already hold in text, and it is the number a reviewer or a note buyer will
   compare against. `search.js` already returns `distance_miles`; **add the bearing** so a comp reads
   "0.42 mi NE" exactly like the form.
2. **Never call a radius a GSE requirement.** The warehouse already carries this discipline for the
   "15 % net / 25 % gross" adjustment pair (removed from the Selling Guide in December 2014, kept as *our
   own* review flag, and the copy is forbidden from calling it a GSE rule). **A 1-mile radius is the same
   kind of thing: it is OUR overlay, and the screen must say so.**

### 3.2 Road distance and drive time — recommend against

- **Cost shape is the argument.** Geocoding is *one call per property, forever*. A distance matrix is
  *S × C calls per month* — at 20 searches/day × 250 candidates that is 150,000 elements/month, ≈$750/mo
  at Google's $5/1,000 (**$9,000/year**), for a number the SQL already produces in microseconds. Google's
  matrix also caps at 25 × 25 = 625 elements per request, so 250 candidates is not one round trip.
- **It answers the wrong question.** An appraiser does not adjust for drive time; a note buyer does not
  review it; the 1004 has no field for it. A comp 0.3 miles away across a river with a 4-mile drive is
  *still* a poor comp — and the reason is the river as a **market boundary** (§4 below), which
  census-tract and municipality data answer directly and for free.
- **Where drive time is genuinely wanted** — "how far is this from the borrower's other projects" — it is
  a per-query product bought at the moment of the question, not a warehouse column.

**Verdict: straight-line only. Spend the drive-time budget on §5 enrichment instead.**

### 3.3 The haversine and the bounding box — verified, with numbers

The repo's own note says the longitude delta must be divided by `cos(lat)`. **It does, and the direction
and magnitude are correct.** `search.js:310–313`:

```js
const dLat = radius / 69.0546;
const dLng = radius / Math.max(1, 69.1710 * Math.cos((lat * Math.PI) / 180));
```

I brute-forced the box against the haversine expression the same query uses (`R = 3958.7613 mi`) at eight
latitudes covering the entire US, at four radii:

| Latitude | Radius | N/S box edge (mi) | E/W box edge (mi) | Verdict |
|---|---|---|---|---|
| 25.8 – 71.3 (all US) | 0.5 | 0.500281 | 0.499439 | E/W **short by 3.0 ft** |
| 25.8 – 71.3 | 1 | 1.000562 | 0.998878 | E/W **short by 5.9 ft** |
| 25.8 – 71.3 | 3 | 3.001686 | 2.996635 | E/W **short by 17.8 ft** |
| 25.8 – 71.3 | 10 | 10.005621 | 9.988782 | E/W **short by 59.2 ft** |

**Findings:**

- ✅ **The `cos(lat)` scaling is correct** — the E/W shortfall is a *constant 0.11 %*, identical at 25.8°
  and at 71.3°. If `cos(lat)` were missing or misapplied the error would swing wildly with latitude. It
  does not. The repo's note is satisfied.
- ✅ **The latitude box over-covers** (1.00056 mi for a 1-mile radius), so it never clips north or south.
- ⚠️ **The longitude box under-covers by exactly 0.11 %** — a strict bounding box must be a **superset**
  of the circle, and this one is a hair inside it on the east and west edges. The cause is a units
  mismatch, not a maths error: `69.1710` is the **WGS84 equatorial** miles-per-degree, while the haversine
  uses a **mean-sphere** radius whose equatorial degree is `2πR/360 = 69.0932`. Impact today: a comp
  sitting within ~6 ft of the edge of a 1-mile radius, or ~59 ft of a 10-mile radius, is dropped. Small —
  and it is exactly the kind of silent clipping the module's own comment was written to prevent.

  **The fix, verified rather than assumed.** Swapping the divisor to `69.0932` closes ~99.5 % of the gap
  but is **still marginally short** at extreme latitude and radius (worst case −0.0056 %, i.e. ~15 ft on a
  50-mile radius at 71.4°N) — because the flat-earth `R·cos(φ)·Δλ` approximation itself drifts as the arc
  grows. Swept over 7 latitudes (17° → 71.4°) × 7 radii (0.25 → 50 mi), only a divisor **plus an explicit
  safety pad** is a provable superset:

  | Formula | Superset everywhere? | Worst margin |
  |---|---|---|
  | `radius / (69.1710 · cos φ)` *(today)* | ❌ **short** | **−0.11 %** |
  | `radius / (69.0932 · cos φ)` | ❌ short | −0.0056 % |
  | **`1.001 · radius / (69.0932 · cos φ)`** | ✅ **yes** | **+0.094 %** |
  | `1.002 · radius / (69.1710 · cos φ)` | ✅ yes | +0.082 % |

  **Recommend the third row.** The pad costs a fractionally wider pre-filter (the exact circle is still
  cut in SQL, so no extra row is ever returned) and buys the invariant the box exists to hold. Apply the
  same 0.1 % pad to `dLat` for symmetry, even though it already over-covers.
- ⚠️ **`Math.max(1, …)` is inert in the US and wrong outside it.** It only engages above ~89.17° latitude,
  where the box becomes drastically narrow (at 89.5°, a 1-mile radius box reaches only 0.60 mi east-west —
  **short by 2,096 ft**). The northernmost US point is ~71.4°N (Point Barrow), where the guard never fires.
  It is a division-by-zero guard doing the wrong thing: the correct behaviour near the pole is to clamp
  `dLng` to 180° (the whole world), not to cap the denominator at 1. Harmless here; worth a one-line fix
  and a comment so nobody trusts it later.
- ⚠️ **The ±180° meridian breaks the BOX but not the HAVERSINE.** The haversine is exact across the
  antimeridian, because it uses `sin²(Δλ/2)` and `sin` is periodic — verified: 0.1° of longitude at 52°N
  computes to 4.25382 mi across the seam versus 4.25859 mi expected. But `eff_longitude BETWEEN lng-dLng
  AND lng+dLng` cannot express a wrapped range: centred at 179.95°, the box is `179.9265 … 179.9735`, and
  a property at −179.98° — a few hundred metres away — is **excluded before the haversine ever sees it**.
  US relevance: the Aleutian Islands cross 180°. For a NJ/NY hard-money book this is theoretical, but the
  correct fix is one line — when `lng - dLng < -180 || lng + dLng > 180`, emit an `OR` of the two wrapped
  ranges instead of a single `BETWEEN`. Since the exact circle is already cut in SQL, correctness is
  preserved either way; the box just needs to stop pre-filtering the wrong side away.
- ✅ **Cutting the exact circle in SQL rather than in JS is right and must stay.** Filtering the page in
  JS runs *after* `LIMIT` and after `count(*) OVER ()`, so pages come back short and totals overstate by
  up to 27 % (the box's area over the circle's). The comment in `search.js:314–319` already says this.

### 3.4 ⚠️ The distance can be confidently wrong for a different reason: `eff_*` mixes two qualities

`eff_latitude = COALESCE(geo_latitude, latitude)` — our looked-up coordinate, falling back to **the
appraiser's**. `db/412` itself warns that vendor comp coordinates are *"whatever the vendor's own geocoder
produced years ago, at unknown precision, and are frequently the centre of the ZIP"*, and
`RESEARCH-WAREHOUSE-HANDOFF.md` §6 already forbids the duplicate detector from using `eff_*` for exactly
this reason — *"every property in a ZIP would look identical."*

**The search does use `eff_*`.** So a comp whose only coordinate is a ZIP centroid gets a distance that
looks measured, prints to two decimals, and can be a mile wrong. Today that affects **6 of 104 rows**
(5.8 %), so it is small — but it grows with every imported report and it is invisible.

**Recommendation:** surface the provenance. `LIST_COLUMNS` already returns `geo_source`; extend it to a
`distance_basis` of `looked_up` | `from_appraisal` | `stated_by_appraiser` (§2.5) | `unmeasured`, and let
the screen mark a non-looked-up distance as approximate. Sorting by a number of unknown quality is the
kind of thing that reads as working right up until someone checks it. **Fail toward "we don't know."**

---

## 4. ADDRESS IDENTITY / DEDUPE — an adversarial audit of `property-key.js`

### 4.1 Why the module is pure and offline, and why that must not change

Before proposing anything: the design is right and the reasons are stated in the file header. It ingests
thousands of comparable rows, it runs inside a boot back-fill, and `lib/address-canon` — the Google
`place_id` resolver used for loan-file comparison — **costs one HTTP round trip per distinct string and
returns `null` with no API key configured.** A warehouse that cannot dedupe without a vendor silently
stores every property twice, forever, and the failure is invisible. **Every fix below is pure, offline and
deterministic.** Nothing here requires a network call at key time.

### 4.2 The defects — each reproduced by calling the real function

Every line below is verbatim output from `require('./src/lib/research/property-key.js').propertyKey(…)`.

#### 🔴 COLLISION 1 — two different houses, in different ZIPs, produce ONE key

```
propertyKey("26 S 10th St, NJ 08854")   →  "26 s 10th||st|nj"
propertyKey("26 S 10th St, NJ 07063")   →  "26 s 10th||st|nj"      ← IDENTICAL
propertyKey("26 S 10th Ave, NJ 08854")  →  "26 s 10th||ave|nj"
```

**Root cause:** when a one-line address carries no city, `ADDR.parseAddress` hits its
`parts.length === 1` branch and **pops the last token as the city** — so `"St"` becomes the locality and
the street loses its type word. The module's documented ZIP fallback (`z<zip>`) is then never reached,
because `p.city` is truthy. Every no-city one-liner in a state collapses onto
`<house> <name> | | <street-type> | <state>`.

**This is precisely the Piscataway/Plainfield incident the repo already has an incident record for** —
`1727 S 2nd St` exists in ZIP 08854 *and* a different house at the same number exists ~130 m away across
the municipal line in ZIP 07063. Under this key they are one property, and every fact from both reports
gets rolled up onto a single row.

**Note it only bites the one-line form.** The parts object is correct:

```
propertyKey({street:'26 S 10th St', state:'NJ', zip:'08854'})  →  "26 s 10th st||z08854|nj"
propertyKey({street:'26 S 10th St', state:'NJ', zip:'07063'})  →  "26 s 10th st||z07063|nj"   ✅ distinct
```

…and the one-line form is *documented as an accepted input* ("some vendors put the whole address in the
street field"), so it is reachable.

**Fix:** in `normalizeParts`, when the packed-street parse yields a `city` that is a bare street-type word
(or the parse consumed the street's own suffix), discard it and fall through to the ZIP. Better: only
accept a parsed city when the residual street still ends in something that is not a recognized suffix.

#### 🔴 COLLISION 2 — the unit designator TYPE is erased; `Suite 5` == `Apt 5` == `Bldg 5` == `Lot 5`

```
100 Main St, unit "Apt 5"       →  "100 main st|5|newark|nj"
100 Main St, unit "Unit 5"      →  "100 main st|5|newark|nj"
100 Main St, unit "Suite 5"     →  "100 main st|5|newark|nj"
100 Main St, unit "Ste 5"       →  "100 main st|5|newark|nj"
100 Main St, unit "Fl 5"        →  "100 main st|5|newark|nj"
100 Main St, unit "Bldg 5"      →  "100 main st|5|newark|nj"
100 Main St, unit "Building 5"  →  "100 main st|5|newark|nj"
100 Main St, unit "Lot 5"       →  "100 main st|5|newark|nj"
100 Main St, unit "Rm 5"        →  "100 main st|5|newark|nj"
100 Main St, unit "#5"          →  "100 main st|5|newark|nj"
100 Main St, unit "5"           →  "100 main st|5|newark|nj"
```

`unitKey` strips the designator word and keeps only the token, so **eleven materially different
designations collapse to `5`.** In a mixed-use building, **Suite 5** (ground-floor commercial) and
**Apt 5** (residential) are different properties with different values. In a garden-apartment complex,
**Bldg 5** is an entire building and **Apt 5** is one dwelling inside it. On new construction, **Lot 5**
is a parcel and **Unit 5** is a finished home.

This directly violates the module's own stated rule — *"It never drops the UNIT. Unit 2 and Unit 5 of the
same building are two properties that sell for different prices."* It keeps the *number* and drops the
*kind*, which is half the identity.

**Fix:** keep a normalized designator class in the key — `apt|ste|fl|bldg|lot|rm|none` — so
`…|apt:5|…` ≠ `…|ste:5|…`, while `Apt 5` / `Apartment 5` / `APT. 5` still fold together. `#5` and a bare
`5` map to `none`, which is honest (the report did not say) rather than a guess.

#### 🔴 COLLISION 3 — a street whose NAME contains a unit keyword is eaten, and two streets merge

```
5 Floor Ave,    Newark NJ  →  "5|oorave|newark|nj"
5 Lot Ln,       Newark NJ  →  "5|ln|newark|nj"
5 Building Rd,  Newark NJ  →  "5|rd|newark|nj"      ┐
5 Room Rd,      Newark NJ  →  "5|rd|newark|nj"      ┘  ← IDENTICAL — two different streets
5 Unit Dr,      Newark NJ  →  "5|dr|newark|nj"
5 Suite Way,    Newark NJ  →  "5|way|newark|nj"
```

`normalizeParts` calls `ADDR.splitUnit(street)` unguarded. `splitUnit`'s `UNIT_RE` requires a whole word —
which correctly stops `"Fl"` matching inside `"Floral"` — but does nothing when the street's name **is**
the keyword. The street collapses to the bare house number, and the *rest of the street name* becomes the
unit. **`5 Building Rd` and `5 Room Rd` become one property.**

**The repo already owns this fix, one module away.** `address.withoutUnit()` carries an explicit guard:

> *"a street whose NAME is a unit keyword ("5 Floor Ave", "100 Lot 5") makes parseAddress swallow the
> street into `unit`, leaving line1 as just the house number… If the parse ate the street, don't strip."*

`property-key.js` needs the same three lines: **if the residual street is nothing but a house number,
reject the split and keep the original string.**

Note also the alternation-order bug visible here: `UNIT_WORD` is `/^(unit|apt|apartment|ste|suite|fl|floor|…)/`,
so `fl` matches before `floor` and `"Floor 5"` → `"oor5"`. That is both a collision hazard and a split
(`Floor 5` ≠ `Fl 5` ≠ `Apt 5`). **Order the alternation longest-first.**

#### 🟠 SPLIT 4 — a unit with no marker is welded into the street

```
"26 S 10th St Apt 2, Piscataway, NJ 08854"   →  "26 s 10th st|2|piscataway|nj"
"26 S 10th St Unit 2, …"                     →  "26 s 10th st|2|piscataway|nj"
"26 S 10th St #2, …"                         →  "26 s 10th st|2|piscataway|nj"
"26 S 10th St 2, …"                          →  "26 s 10th st 2||piscataway|nj"   ← different property
"26 S 10th St, …"                            →  "26 s 10th st||piscataway|nj"     ← different property
```

Appraisal grids routinely write a trailing bare unit. Three keys for one apartment. `address.js`
`parseAddressParts` already handles this case ("a bare trailing token after a street type… only when a
street type was actually seen, so a street name's own last word is never eaten") — `property-key.js` does
not.

#### 🟠 SPLIT 5 — a space or hyphen inside the unit token

```
"814 Bedford Ave Apt 5B, Brooklyn, NY 11205"    →  "814 bedford ave|5b|brooklyn|ny"
"814 Bedford Ave #5b, …"                        →  "814 bedford ave|5b|brooklyn|ny"
"814 Bedford Ave Apt 5 B, …"                    →  "814 bedford ave b|5|brooklyn|ny"   ← street corrupted
"814 Bedford Ave Apt 5-B, …"                    →  "814 bedford ave|5-b|brooklyn|ny"   ← different unit
```

Three keys, and one of them silently changed the **street name** to `bedford ave b`.
**Fix:** strip non-alphanumerics inside `unitKey` (`5-B` → `5b`) and let the unit consume every remaining
token after the designator, not just the first.

#### 🟠 SPLIT 6 — the ordinal suffix

```
"5701 15 Ave, Brooklyn, NY 11219"    →  "5701 15 ave||brooklyn|ny"
"5701 15th Ave, Brooklyn, NY 11219"  →  "5701 15th ave||brooklyn|ny"      ← two keys, one house
```

`address.parseAddressParts` has `dropOrdinal` for exactly this (and it even absorbs the common `"61th"`
typo). `property-key.js` does not use it. In Brooklyn — a core market for this book — numbered streets are
the norm and both spellings appear constantly.

#### 🟠 SPLIT 7 — NYC boroughs and counties

```
"26 S 10th St, Brooklyn, NY 11249"      →  "26 s 10th st||brooklyn|ny"
"26 S 10th St, New York, NY 11249"      →  "26 s 10th st||new york|ny"
"26 S 10th St, Kings County, NY 11249"  →  "26 s 10th st||kings county|ny"
```

Three keys for one house. `address.preferBorough()` exists and is used by `osmComponentsToAddress` and by
the autocomplete route — `normalizeParts` calls only `normalizeCityName`, which strips
`Township`/`Village of` but knows nothing about boroughs or counties. Geocoders label all five boroughs
`"New York"`; USPS and residents use the borough.

#### 🟠 SPLIT 8 — the mailing city vs the municipality, at the same ZIP

```
"1 Main St, Cedarhurst, NY 11516"  →  "1 main st||cedarhurst|ny"
"1 Main St, Hempstead, NY 11516"   →  "1 main st||hempstead|ny"     ← two keys, one house
```

`address.sameAddress` treats the **ZIP as the authority** on locality precisely because of this pair (its
comment names Cedarhurst/Hempstead, Spring Valley/Ramapo, Jackson/Jackson Township). The key does not.
**Fix without breaking the "never key on ZIP" rule:** keep the city out of the key when a ZIP is present
and both are readable — i.e. prefer `z<zip>` as the locality whenever a ZIP exists, and fall back to the
city when it does not. That *inverts* the current precedence and needs care: the header's warning about
ZIP+4 / missing / wrong ZIPs is real. The safer variant is a **two-pass key** (§4.3).

#### 🟡 SPLIT 9 — street-type synonyms the abbreviator does not know, and mid-street types

```
"5 Oak Street Extension, …"  →  "5 oak street ext||nowhere|nj"
"5 Oak St Ext, …"            →  "5 oak st ext||nowhere|nj"       ← two keys
"5 Mill Run, …"              →  "5 mill run||nowhere|nj"
"5 Mill Rn, …"               →  "5 mill rn||nowhere|nj"          ← two keys
"100 St James Pl, …"         →  "100 st james pl||brooklyn|ny"
"100 Saint James Pl, …"      →  "100 saint james pl||brooklyn|ny" ← two keys
```

`abbreviateStreet` abbreviates only the **trailing** suffix, so `Extension` becomes `Ext` and `Street` is
left long. `Run` is not in the dictionary. `Saint` is not normalized. **Fix:** canonicalize *every* token
through a USPS Publication 28 suffix table (the repo already has a partial one in `TYPE_CANON`), and add
`saint`→`st` as a **leading** token only, so `Oak St` (suffix) and `St James` (saint) never merge.

#### 🟡 SPLIT 10 — fractional house numbers are inconsistently accepted

```
"12 1/2 Main St, Newark, NJ 07102"   →  "12 1/2 main st||newark|nj"    (kept)
"12-1/2 Main St, Newark, NJ 07102"   →  null                            (SKIPPED entirely)
```

`hasHouseNumber` accepts `12` (the first token) in the first form; in the second, the whole token is
`12-1/2`, which the regex `^\d+[A-Za-z]?(?:[-/]\d+[A-Za-z]?)?$` rejects. The row is dropped and counted as
unidentifiable. Both are the same well-known Newark address shape.

#### ✅ CORRECTLY SKIPPED — PO boxes, rural routes, corners

```
"PO Box 421, Monsey, NY 10952"     →  null
"RR 2 Box 145, Ellenville, NY"     →  null
"HC 61 Box 5, Sparta, NC 28675"    →  null
"Corner of Main & Elm, Newark NJ"  →  null
```

**This is right, not a defect.** A PO box is not a property and must never be a warehouse row. The
skipped rows are counted on `property_ingest_log.rows_skipped`, which is exactly the honest behaviour.
The one thing worth adding: a **skip reason** on the ledger, so "PO box" and "we could not read it" are
distinguishable.

#### 🔴 BONUS — a separate over-match in `address.sameAddress`: Queens hyphenated house numbers

Not `property-key.js`, but the same family, and it is used by the USPS stamp trigger (db/415), the
review-queue closer, and the ClickUp no-op suppression:

```
sameAddress("150-25 78th Rd, Flushing, NY 11367", "25-150 78th Rd, Flushing, NY 11367")  →  true
sameAddress("61-20 Grand Ave, Maspeth, NY 11378",  "20-61 Grand Ave, Maspeth, NY 11378")  →  true
sameAddress("88-10 51st Ave, Elmhurst, NY 11373",  "10 51st Ave, Elmhurst, NY 11373")     →  true
sameAddress("150-25 78th Rd, …",                    "150-99 78th Rd, …")                   →  true
```

`houseMatches` treats a hyphen as a **range** and matches if *either* endpoint appears on both sides —
deliberately, so `"27-29 Tuscany Ter"` matches `"27 Tuscany Ter"`. **But every address in Queens is
hyphenated**, and the hyphen there is a *grid coordinate*, not a range: `150-25` means house 25 near
150th Street. So `150-25` and `150-99` are two different houses on the same block and this returns `true`
for them. This is an **over-match in a comparer whose stated discipline is to under-match**, and Queens is
squarely in this lender's footprint.

**Fix:** only expand a hyphen as a range when the two parts are *ordered and close* (`a < b`, `b - a <
some small bound`) and the state is not NY, or — cleaner and provable — only when the address does not
carry a NY ZIP in the Queens ranges (11004–11109, 11351–11697). The conservative version: require the
**whole** hyphenated token to match unless one side has no hyphen at all *and* the other side's range is
ascending.

### 4.3 So: is a normalized-address key enough?

**For the warehouse's primary key — yes, once the ten defects above are fixed, and it must stay the
primary key.** It is the only signal that is free, offline, deterministic, available for 100 % of rows,
and available at the moment of the write. Nothing else has all five properties.

**But it should not be the ONLY signal.** The right architecture is a **primary key plus corroborating
identity signals that are recorded, never authoritative**:

| Signal | What it buys | What it costs | Verdict |
|---|---|---|---|
| **Normalized address key** (today, fixed) | 100 % coverage, free, offline, deterministic, no vendor | The ten defects above; can never resolve a genuine typo | **KEEP as the primary key. Non-negotiable.** |
| **USPS CASS** (`usps_address` — **already wired**, `src/lib/integrations/usps.js`, free) | The authoritative *mailing* form + **ZIP+4 + DPV**. ZIP+4 is near-unique to a delivery point and would settle Cedarhurst/Hempstead, the borough problem, and most suffix noise in one stroke | An HTTP round trip; **60 lookups/hour on the free tier** (already paced for in `address-usps-verify.js`); does not cover a non-mailable address (new construction, vacant lot) | **ADOPT as a second signal, asynchronously.** Never at key time — never make the key depend on a network call. Store it, compare on it, and let the merge detector use it. **It is free and currently stamped on 0 of 706 files.** |
| **Parcel APN** | The *legal* identity of the property — immune to every spelling problem, and the only signal that survives a street being renamed | **The appraisal states it for the SUBJECT only (5 of 71 reports = 7 %), never for a comparable.** So it needs a vendor (§5) for anything but a subject; APN formats are county-specific and not globally unique without a FIPS prefix | **RECORD IT, never require it.** Store `apn` + `apn_county_fips`. Use it as a merge *confirmation*, and as the join key when a parcel vendor is added. |
| **Geocoder `place_id`** | Google-stable identity for a building | **A vendor dependency at key time** — one HTTP call per distinct string, `null` with no key, and `address-canon` returns `null` for a road-level match by design. A place_id is also *building*-level, so it cannot separate units | **DO NOT put it in the key.** It is the right tool for the loan-file comparison it already serves and the wrong tool for a warehouse primary key — for exactly the reasons the module header already gives. |
| **Coordinate proximity** (e.g. two rows within 15 m) | Catches typo'd house numbers a rule never can | Depends on §1 coverage (13.5 % today) and on §3.4 provenance — a ZIP-centroid coordinate would merge a whole ZIP | **Already the right design**: `property-merge.js` uses `geo_latitude`, never `eff_*`, and **never merges automatically**. Keep both rules. |

**The governing principle, and it is already the repo's:** a rule-based key handles the spelling; a
**human-confirmed merge** handles the rest. `property-merge.js` exists, requires `platform_setup`, and is
never automatic. **Every fix above makes the rule catch more and leaves the merge to a person.** None of
them lets a machine decide two properties are one on a guess.

### 4.4 Priority order for the fixes

| # | Defect | Severity | Effort | Why this order |
|---|---|---|---|---|
| 1 | Collision 1 — no-city one-liner collapses two ZIPs | 🔴 merges two real properties | S | Merges facts from two houses onto one row; silently corrupts every price-per-foot read |
| 2 | Collision 3 — street name eaten by a unit keyword | 🔴 merges two real streets | S | Fix already exists in `address.withoutUnit`; three lines |
| 3 | Collision 2 — unit designator class erased | 🔴 merges a suite with an apartment | S | Directly contradicts the module's own stated rule |
| 4 | `sameAddress` Queens hyphen over-match | 🔴 affects USPS stamps + review closing | M | Needs a careful, provable narrowing — not a blanket change |
| 5 | Splits 4/5 — bare and spaced unit tokens | 🟠 splits one property | S | Most common real-world spelling on a comp grid |
| 6 | Split 6 — ordinals | 🟠 | S | `dropOrdinal` already exists |
| 7 | Splits 7/8 — borough, county, mailing city | 🟠 | M | `preferBorough` exists; the ZIP-precedence change needs thought |
| 8 | Split 9 — full USPS Pub-28 suffix canonicalization | 🟡 | M | Broadest win per line changed after the above |
| 9 | Split 10 — fractional house numbers | 🟡 | S | One regex |
| 10 | Skip reasons on the ingest ledger | 🟡 | S | Makes every future skip auditable |

**Every one of these belongs in `test-research-property-key.js` as a named case before the fix lands** —
the file already tests by name, and each defect above is a one-line assertion.

---

## 5. BEYOND A CIRCLE — the geography that actually decides comparability

A radius is a proxy. What an appraiser, a reviewer and a note buyer actually judge is **market area** —
Fannie's own words: *"the geographic region from which most demand comes and in which most of the
competition is located."* Two houses 0.3 miles apart on opposite sides of a school district line, a
municipal boundary, or a rail cut are not competitors. That is the owner's *"not by looking just on the
city"* — and the answer is not only distance, it is **boundaries**.

### 5.1 What each geography buys, and what it costs

| Geography | What it decides | Free & authoritative? | How to get it | Value to a hard-money lender |
|---|---|---|---|---|
| **Census tract** | The standard statistical neighbourhood; the unit HMDA, LMI and most "same neighbourhood" tests use | **YES — Census TIGER/Line, public domain** | **Free, in a call you already make**: the Census geocoder's `returntype=geographies` endpoint returns state/county/**tract**/block alongside the coordinate, in the same request and the same 10,000-address batch. Geocodio also appends it | **★★★★★ Highest value per dollar.** Costs literally nothing extra over what §2 already does |
| **Municipality / township** | Tax rate, permitting regime, rent regulation, and the single biggest "same side of the tracks" line in NJ/NY | **YES — TIGER `PLACE` + `COUSUB`** | Free shapefile; point-in-polygon locally, or a Census geographies lookup | **★★★★★** — NJ is a state of ~565 municipalities with wildly different tax rates. Two adjacent houses can differ 40 % in carrying cost |
| **School district** | The single largest non-physical price driver in most suburban US markets | **YES — NCES EDGE district boundaries, public domain**, published per school year (SY 2022-23 is the most recent full collection) | Free shapefile from NCES EDGE; **or one Geocodio append** (counts as 1 extra lookup, so ~$1/1,000) | **★★★★☆** — matters enormously for exit value on a flip; matters less on a 12-month bridge |
| **School attendance zone** (not district) | The *actual* zone a house feeds into — finer than a district | **Partially.** NCES **SABS** exists but is **experimental and stale** (2013-14 and 2015-16 only) | SABS free but old; current attendance zones are a paid product (ATTOM/CoreLogic/Precisely) | **★★☆☆☆** — the stale free version is worse than nothing; do not buy it for a bridge lender |
| **ZIP code** | The mail unit — **not a polygon**, and not a market | Approximately, via **Census ZCTA** (a tabulation *approximation* of a ZIP) | TIGER ZCTA free; **HUD-USPS ZIP↔tract crosswalk** free (quarterly, download or API) | **★★★☆☆** — already in the key and the filters. Useful; never confuse a ZIP with a market |
| **County** | Recording office, transfer tax, foreclosure timeline, APN namespace | **YES — TIGER `COUNTY`** | Free; the Census geocoder returns the county FIPS with the tract | **★★★★☆** — required anyway for an APN to be unique |
| **Subdivision / condo project** | Fannie says comps *"from within the same… subdivision or project… must be used in certain instances"* | **No single free national source.** Regrid parcels carry subdivision on much of the country | Already partially solved: `properties.condo_project_name` is populated from the appraisal (db/422) and is a search filter | **★★★★☆ for condos, already built.** Subdivision for SFR needs a parcel vendor |
| **MLS area** | How agents actually segment a market | **No — MLS data is licensed per-MLS**, and a hard-money lender is rarely a member | Would require MLS membership or a licensed aggregator | **★☆☆☆☆ — skip.** Expensive, fragmented, and census tract + municipality gets 80 % of the benefit |
| **Flood zone (SFHA)** | Insurance requirement; a real value discontinuity across the line | **YES — FEMA NFHL, free, no signup** | **ALREADY BUILT** — `src/lib/appraisal/flood.js` queries FEMA NFHL MapServer layer 28 from a Census-geocoded point, and `properties.sfha` / `fema_flood_zone` are already searchable | **★★★★★ and already done** |
| **"The wrong side of the tracks"** | The real question | **Not directly available from any vendor** | The tractable proxy is **tract + municipality + school district agreement**, plus the appraiser's own `location_rating` / `nbhd_location_type`, both already parsed | **★★★★☆** — see below |

### 5.2 The recommendation for §5, concretely

**Add three columns and one boolean, all from free public data, all from calls we already make:**

1. `census_tract` **for comparables too** — today it is subject-only (`ingest.js:1105` writes `null`). Get
   it from the Census geocoder's `geographies` endpoint at the same time as the coordinate: **one call,
   same batch, same $0.** This alone turns "same neighbourhood" from a guess into a fact.
2. `county_fips` + `place_fips` (municipality) from the same response.
3. `school_district_id` — either an offline point-in-polygon against the free NCES EDGE shapefile, or a
   Geocodio append. Prefer **offline**: it is free forever, it is deterministic and testable, and a
   shapefile lookup cannot fail at 3 a.m.

**Then change the comp ranking, not the filter.** Do **not** add a hard "same tract only" filter — it
would hide legitimate comps and reproduce the 1-mile-radius mistake in a new costume. Instead extend
`valuation.scoreComp`, which already has the right shape (weighted parts, `unknown` excluded from the
denominator, `coverage` reported alongside the score):

| New part | Weight | Rule |
|---|---|---|
| Same census tract | 8 | full credit same tract; partial credit adjacent tract; 0 different, **`unknown` when either side has no tract** |
| Same municipality | 7 | binary, `unknown` when either is missing |
| Same school district | 5 | binary, `unknown` when either is missing |

That is 20 points redistributed from the existing categorical block, and it is **exactly the owner's ask**
— comparability judged by the map and the boundaries, not by the city name — while keeping the two rules
that make the score honest: **a fact nobody stated is not a bad match**, and the score reports its own
coverage.

**A boundary crossing must be shown, not silently penalised.** When a comp is in a different tract,
municipality or school district, say so on the row in words ("different township — Piscataway vs
Plainfield"). A number that quietly went down teaches nobody; a stated reason is what an underwriter can
act on and a note buyer can review.

---

## 6. PROPERTY DATA ENRICHMENT — the facts the appraisal XML does not state

### 6.1 What is genuinely missing

The appraisal is rich (see `docs/research/APPRAISAL-FACT-COVERAGE-AUDIT.md` — db/422 and db/424 pulled
nearly every stated fact through to the warehouse). What it **structurally cannot** give us:

| Missing fact | Why the XML cannot supply it | Who needs it |
|---|---|---|
| **A comparable's property type and unit count** | Genuinely absent from most MISMO 2.6 grids | The warehouse answers it only if that address later appears as some other report's *subject* |
| **A comparable's APN, census tract, flood zone, zoning** | Never stated per comp — `ingest.js` writes `null` for all of them | Everything in §5 |
| **Recorded deeds / full sale history** | The grid states one prior sale, sometimes | Chain of title, seasoning, flip-detection, the existing `deal-basis.seasoningMonths` |
| **Current tax assessment & tax bill** | Subject only, and only when the appraiser filled it in (`property_tax_amount`, db/422) | Carrying cost, exit math |
| **Ownership of record / entity** | Subject only (`owner_of_record`) | The seller-chain and chain-of-title desks |
| **Open permits, violations, liens** | Never | Rehab feasibility, a real hard-money risk |
| **Lot size / year built for a comp** | Mined heuristically from the appraiser's adjustment lines today | Comp scoring |
| **AVM / market value opinion** | Not the appraisal's job | The `avm_consensus` finding already exists |

### 6.2 The vendors, honestly priced

**A blunt note on pricing:** ATTOM, CoreLogic, First American DataTree and LightBox **do not publish
per-record pricing.** Anything below not marked as verified from a public rate card is a secondary source
and must be confirmed by quote before any commitment.

| Vendor | What it is | Coverage | Price | Licence for a lender's internal use | Verdict |
|---|---|---|---|---|---|
| **RentCast** | REST API: 150M+ property records, owner details, **value AND rent estimates**, comps, listings, market trends | 150M+ US properties | **Published rate card**: Developer $0 / 50 req/mo; **Foundation $74/mo — 1,000 req** ($0.06 overage); **Growth $199/mo — 5,000 req** ($0.03); **Scale $449/mo — 25,000 req** ($0.015) | *"flexible licensing… for any use case not specifically prohibited"*, **no attribution required**; caching/redistribution terms are **not spelled out on the pricing page — read the ToU before storing** | **★★★★★ START HERE.** The only vendor on this list with a public rate card, a free tier to evaluate, and a price that fits 900 new properties/month ($199/mo). Rent estimates are a genuine bonus for a fix-and-hold book |
| **Regrid** | **Parcel** data: 160M US parcels, boundaries, zoning, building data; REST API, MCP server, and **bulk download** (Shapefile/GeoPackage/GeoJSON/CSV/SQL/Parquet via S3/SFTP) | 160M parcels, every county | **Not published** — self-serve monthly API plans + county/state Data Store + enterprise bulk licence; contact `parcels@regrid.com` | Bulk licence explicitly permits downloading the nationwide dataset with rolling refreshes — **the strongest structural fit for a permanent warehouse** | **★★★★☆ THE APN ANSWER.** A bulk parcel licence gives APN + boundary + zoning **offline, forever, with no per-call bill** — which is the shape this warehouse wants. Get a quote |
| **ATTOM** | 160M+ properties: assessor, deed/sale history, tax, AVM, school, flood, permits, neighbourhood | 160M+ | **Not published.** Property Navigator (a UI tool, not the API) is $499/yr; API is transaction-priced after a 30-day trial; secondary reports suggest ~$500/mo entry **[2nd]** | Quote-specific | **★★★☆☆** — the broadest single dataset, and **Estated is now part of ATTOM** (Estated's own docs deprecate in 2026), so it is also the successor to the cheap option. Worth a quote, second in line to RentCast |
| **CoreLogic** | The incumbent: assessor, deed, MLS, risk, AVM | Best-in-class | **Not published.** Secondary buyer data reports a **median ≈$12,000/year** **[2nd]** | Enterprise, term-limited | **★★☆☆☆** — right answer at 10× this loan volume. Today it is a $12k/yr line item for facts a $199/mo API covers |
| **First American DataTree** | Deeds, title, tax, document images — title-grade | Excellent, especially **recorded documents** | **Not published**, quote-based | Enterprise | **★★☆☆☆ — with one exception.** Document images are genuinely differentiated; if chain-of-title work grows, revisit |
| **Estated** | Formerly the cheap self-serve property API | — | — | — | **✗ DO NOT BUILD ON IT.** Now part of ATTOM; the v4 docs are slated for deprecation in 2026 |
| **LightBox** | Parcel + CRE-oriented location intelligence | Strong on commercial | **Not published** | Enterprise | **★☆☆☆☆** — CRE focus, wrong shape for a residential RTL book |
| **FREE — FEMA NFHL** | Flood zone from a point | National | **$0, no signup** | Public | **★★★★★ ALREADY BUILT** (`appraisal/flood.js`) |
| **FREE — Census TIGER + geocoder geographies** | Tract, block, county, place | National | **$0** | Public domain | **★★★★★ TAKE IT** (§5) |
| **FREE — NCES EDGE** | School district boundaries | National | **$0** | Public domain | **★★★★☆ TAKE IT** |
| **FREE — HUD-USPS crosswalk** | ZIP ↔ tract/county/CBSA/CD, quarterly, download **and API** | National | **$0** (free account for the API) | Public | **★★★☆☆** — useful glue when only a ZIP is known |
| **FREE — county assessor open data** | Assessor + parcel, per county | **Fragmented** — a different format and a different licence per county | $0 | Varies | **★★☆☆☆** — the maintenance is the cost. Regrid exists because this is painful |

### 6.3 The non-negotiable rule for every vendor in this section

**A vendor's answer NEVER overwrites what a report actually stated.** The warehouse's roll-up already
encodes this — *"the most RECENT report that stated it wins"*, and *"silence never blanks."* A vendor is a
**different kind of source**, not a newer report, and merging the two into one column would destroy the
warehouse's ability to answer *"which report said that?"* — which the handoff calls the whole point of
keeping observations.

**Design: a vendor fact is an observation with `source_kind='vendor'`, or its own column pair
(`tax_amount_vendor` / `tax_amount_vendor_at`), and the roll-up prefers a REPORT over a VENDOR for any
fact a report has ever stated.** Where they disagree, that is a **finding for a human**, exactly like the
appraisal-vs-file tie-out — never a silent overwrite. And a vendor fact is stamped with its vendor and
its date, so a licence that ends can be honoured by deleting exactly those rows.

---

## 7. THE TABLE — what each API buys, what it costs, can we live without it

| API | What it buys us | What it costs | Can we live without it? |
|---|---|---|---|
| **US Census Geocoder** *(built, unused)* | Coordinates for every property → **the entire distance feature**. Plus tract/county/place in the same call | **$0.** No key, no account, no storage restriction. 10,000 per batch | **NO.** Without it the owner's ask is unbuildable. **This is the top priority and it is free** |
| **Census `geographies` endpoint** | Census tract + county + place, free, in the call above | **$0** | Yes, but there is no reason to — it is the same request |
| **Geocodio** | True **rooftop** for the ~5–10 % Census cannot place; **permanent storage, no restriction**; census tract + school district appends | **$1 / 1,000**, 2,500 free/day. Realistically **$0–$10 one-time**, $0/mo ongoing | **Yes, technically** (Nominatim is the current fallback) — but Nominatim's policy forbids the bulk sweep and it misses house numbers. **Buy it; it is ten dollars** |
| **Google Geocoding** *(in use for loan-file matching)* | Best US accuracy; `place_id` for `samePlace()` | $5/1,000, **no batch**, and **coordinates may not be stored past 30 days** | **Keep for `place_id` only.** Never for the warehouse — db/413 exists because of this |
| **OSM / Nominatim** *(in use)* | Free keyless fallback | $0 — but **1 req/s, and scheduled bulk scripts throttled to 4/min** | **Keep as a per-address last resort. Do not build the backfill on it** |
| **USPS Addresses API v3** *(built, 0 of 706 files stamped)* | CASS-standardized address + **ZIP+4 + DPV** → a real second identity signal, and it settles most of §4's city/suffix noise | **$0**, free developer account. 60 lookups/hour — already paced in `address-usps-verify.js` | **Yes, but why?** It is written, free, and switched off. Turn it on |
| **FEMA NFHL** *(built)* | Official flood zone from a point | **$0, no signup** | No — flood drives an insurance condition and a real value discontinuity |
| **NCES EDGE district boundaries** | School district, offline, forever | **$0**, one shapefile | Yes — but it is the cheapest comp-quality signal available |
| **HUD-USPS ZIP crosswalk** | ZIP → tract/county/CBSA when only a ZIP is known | **$0** (free API account) | Yes — nice-to-have glue |
| **RentCast** | Comp facts for properties **no appraisal ever covered**: type, beds/baths, year built, lot, last sale, tax, owner, **rent estimate** | **$199/mo** at 5,000 lookups (Growth); $74/mo at 1,000 | **Yes today** — the warehouse only holds properties an appraisal named. **This is what breaks that ceiling.** Start with the free tier |
| **Regrid (bulk parcel licence)** | **APN + parcel boundary + zoning, offline, nationwide, no per-call bill** — the strong second identity signal §4.3 asks for | Quote. Bulk licence with rolling refreshes | **Yes for now.** Revisit when the address key's defects are fixed and merge volume is measurable |
| **ATTOM** | The broadest single dataset — deeds, sale history, tax, AVM, school, permits | Quote; ~$500/mo entry **[2nd]** | **Yes.** Get a quote for comparison; do not sign before RentCast has been tried |
| **CoreLogic / First American DataTree / LightBox** | Enterprise-grade depth; title-grade documents | ~$12k/yr median **[2nd]** / quote / quote | **YES — comfortably.** Wrong scale for this book today |
| **Google/Mapbox Distance Matrix (drive time)** | Road miles and minutes | ≈**$9,000/year** at 20 searches/day | **YES — do not buy.** It answers a question the GSEs do not ask |
| **Interactive map tiles** | Pins on a map | Separate product, separate bill; a browser-exposed key that cannot be IP-restricted | **Yes for now.** Ship the distance column first; free OSM tiles later if genuinely wanted |
| **Smarty / Precisely / Melissa / HERE** | Best-in-class rooftop / enterprise geocoding | Smarty: subscription, and **storage rights end with the subscription**. Precisely: $10k+/yr. HERE: storage rights **[verify]** | **YES.** Every one of them is either more expensive than Geocodio or contractually wrong for a permanent warehouse |

---

## 8. WHAT TO DO, IN ORDER

| # | Action | Cost | Effort | Why it is in this position |
|---|---|---|---|---|
| 1 | **Add the `geocodeRewriteIsSafe` guard to `research/geocode.js`, and persist `geo_matched_address`** | $0 | S | Everything below multiplies whatever this produces. Placing a property on the wrong street and then reporting confident distances from it is the worst outcome available, and it happens today |
| 2 | **Run the geocode back-fill for real** (`POST /api/research/backfill`, or the boot sweep) | $0 | — | 13.5 % → ~90 %+ coverage. This is the owner's ask, and it is a button |
| 3 | **Fix collisions 1–3 in `property-key.js`**, each with a named test | $0 | S | Three merges of genuinely different properties. Do them before the warehouse fills up, because a merged row is far harder to unpick later |
| 4 | **Switch on USPS** (`USPS_CLIENT_ID` / `USPS_CLIENT_SECRET`, `USPS_BACKFILL_ENABLED=1`) | $0 | — | Free, already written, stamped on zero files |
| 5 | **Take the Census `geographies` endpoint** — tract + county + place for every property, comps included | $0 | M | Turns "same neighbourhood" from a guess into a fact, in a call we already make |
| 6 | Fix splits 4–10 in `property-key.js` | $0 | M | Fewer duplicate rows, better roll-ups |
| 7 | Make the bounding box a provable superset (`1.001 · radius / (69.0932 · cos φ)`), fix the antimeridian wrap and the polar clamp | $0 | S | Small, but "the box is a superset of the circle" is a stated invariant that is false today |
| 8 | Narrow `sameAddress`'s hyphen-range rule for Queens-format addresses | $0 | M | Affects USPS stamps and review closing, so it needs care and a test battery |
| 9 | Use the appraiser's stated `proximity` as a labelled fallback distance | $0 | M | 55 % of comps already carry it |
| 10 | Add tract / municipality / school district to `scoreComp` as **`unknown`-aware** parts | $0 | M | The owner's "not just the city" ask, using only free data |
| 11 | **Buy Geocodio**, replace Nominatim as the *backfill* fallback | ~$10 one-time | S | The last 5–10 % of addresses, at rooftop, storable forever |
| 12 | Trial **RentCast** free tier; move to Growth ($199/mo) if it proves out | $0 → $199/mo | M | Facts for properties no appraisal ever named |
| 13 | Quote **Regrid** bulk parcel, and **ATTOM** | quote | — | Only after 1–12; the APN question is not urgent until the address key is clean |

**Items 1–10 cost nothing and are the majority of the owner's ask.**

---

## 9. THE RULES EVERY RECOMMENDATION HERE OBEYS

Restated so a future change can be checked against them:

1. **Never fabricate a fact.** A property we cannot place gets no coordinate; a fact no report stated
   stays null; a skipped row is *counted*, not invented.
2. **A vendor's answer never overwrites what a report actually stated.** Vendor facts are their own
   source kind; a disagreement is a finding for a human.
3. **Never adopt a geocoder's address TEXT.** A geocoder supplies coordinates. `geocodeRewriteIsSafe` is
   the rule, and §2.3 exists because one module does not call it yet.
4. **Fail toward "we don't know."** An unmeasured distance is `unknown` and leaves the denominator; it is
   never a zero, never a penalty, and never a confident number of unknown provenance (§3.4).
5. **The identity key stays pure, offline and deterministic.** Every §4 fix is a rule change, not a
   vendor. No network call at key time, ever.
6. **A machine never merges two properties.** It proposes; a person with `platform_setup` decides.
7. **Never call our overlay a GSE requirement.** A 1-mile radius is ours, not Fannie's — same discipline
   the warehouse already applies to the 15 %/25 % adjustment pair.
8. **Store only what the licence permits.** Google coordinates expire at 30 days (db/413); Census,
   Geocodio, OSM, FEMA, TIGER, NCES and HUD are permanent; Smarty rooftop is not, which is why it lost.

---

## SOURCES

- [Fannie Mae Selling Guide B4-1.3-08 — Comparable Sales](https://selling-guide.fanniemae.com/sel/b4-1.3-08/comparable-sales)
- [Fannie Mae Selling Guide B4-1.3-07 — Sales Comparison Approach Section](https://selling-guide.fanniemae.com/sel/b4-1.3-07/sales-comparison-approach-section-appraisal-report)
- [Fannie Mae Selling Guide B4-1.3-09 — Adjustments to Comparable Sales](https://selling-guide.fanniemae.com/sel/b4-1.3-09/adjustments-comparable-sales)
- [Sacramento Appraisal Blog — the "Fannie Mae one-mile radius" that is not a rule](https://sacramentoappraisalblog.com/tag/fannie-mae-one-mile-radius/)
- [Census Geocoding Services API](https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html)
- [Census Geocoder User Guide (May 2026)](https://www2.census.gov/geo/pdfs/maps-data/data/Census_Geocoder_User_Guide.pdf)
- [Census Geocoder — batch geographies endpoint](https://geocoding.geo.census.gov/geocoder/geographies/addressbatch?form=)
- [Geocodio pricing](https://www.geocod.io/pricing) · [Pricing changes effective 1 Feb 2026](https://www.geocod.io/updates/pricing-updates-2026/) · [Terms of use / data storage comparison](https://www.geocod.io/geocoding-terms-of-use-comparison) · [Data retention policy](https://www.geocod.io/data-retention-policy)
- [Smarty — US Rooftop Geocoding pricing](https://www.smarty.com/pricing/us-rooftop-geocoding) · [Smarty pricing](https://www.smarty.com/pricing)
- [Google Maps Platform Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms) (§6.3.1 / §6.3.2 quoted in full in `GEOCODING-DISTANCE-VENDOR-RESEARCH.md` §3.1)
- [RentCast API plans & pricing](https://www.rentcast.io/api) · [RentCast Property Data API help](https://help.rentcast.io/en/articles/7992900-rentcast-property-data-api) · [RentCast API docs](https://developers.rentcast.io/)
- [Regrid — nationwide parcel licensing](https://regrid.com/nationwide-parcels) · [Regrid Parcel API](https://regrid.com/parcel-api) · [Regrid plans](https://app.regrid.com/plans)
- [ATTOM Property Data API](https://www.attomdata.com/solutions/delivery/property-data-api/) · [Estated is now part of ATTOM](https://estated.com/) · [Estated v4 docs (deprecating 2026)](https://estated.com/developers/docs/v4)
- [CoreLogic on Datarade](https://datarade.ai/data-providers/corelogic/profile) · [DataTree (First American) on Datarade](https://datarade.ai/data-providers/datatree-by-first-american/profile) · [CoreLogic pricing from actual buyers](https://www.pricelevel.com/vendors/corelogic/pricing) **[2nd]**
- [NCES EDGE — School District Boundaries](https://nces.ed.gov/programs/edge/Geographic/DistrictBoundaries) · [NCES EDGE — SABS](https://nces.ed.gov/programs/edge/sabs) · [SABS technical documentation](https://nces.ed.gov/programs/edge/docs/EDGE_SABS_2015_2016_TECHDOC.pdf)
- [HUD-USPS ZIP Code Crosswalk files](https://www.huduser.gov/portal/datasets/usps_crosswalk.html) · [HUD crosswalk API](https://www.huduser.gov/portal/dataset/uspszip-api.html)
- Internal: `docs/research/GEOCODING-DISTANCE-VENDOR-RESEARCH.md`, `docs/research/RESEARCH-WAREHOUSE-HANDOFF.md`, `docs/research/APPRAISAL-FACT-COVERAGE-AUDIT.md`, `docs/PROPERTY-COMP-DATABASE-RESEARCH.md`, `db/409`, `db/412`, `db/413`, `db/415`, `db/419`, `db/422`, `db/424`
