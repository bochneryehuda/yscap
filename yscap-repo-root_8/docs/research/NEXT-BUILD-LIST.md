# THE NEXT BUILD LIST

**Started 2026-08-03, right after PR #978 merged.** The previous list
(`PROPERTY-RESEARCH-TASK-LIST.md`) finished **61 of 65**. This carries the four
that are left, records what each is actually waiting on, and holds the new work
the owner is adding.

---

## A. CARRIED OVER — the four still open

### A1. USPS address checking — **waiting on a switch, not on code**

Fully built (`src/lib/usps-verify.js`, `src/lib/address-usps-verify.js`,
`src/lib/integrations/usps.js`). It turns itself on the moment two environment
values exist:

```
USPS_CLIENT_ID
USPS_CLIENT_SECRET
```

`configured()` is literally `!!(clientId && clientSecret)` — nothing else gates
it. **The owner reports both are already in Render.** If so, live verification is
already running on new addresses.

**BUT THAT ONLY COVERS NEW ONES.** The item said "stamped on 0 of 706 files", and
the back book is behind a SECOND switch that is off by default:

```
USPS_BACKFILL_ENABLED=1     # stamps the existing files, paced
USPS_BACKFILL_PER_TICK=40   # lookups per pass — keep at or under the hourly quota
USPS_MAX_PER_HOUR=55        # the free tier is 60/hour shared across USPS APIs
```

So: **keys = going forward; `USPS_BACKFILL_ENABLED` = the 706 already on file.**

- [ ] **A1a** Confirm from the running service that USPS reports `configured:
  true` (API Health screen / the integrations health registry). This cannot be
  checked from a development environment — it has no Render secrets, and it must
  never have them.
  - **EVERYTHING THAT COULD BE DONE FROM HERE IS DONE — the screen now answers
    the question honestly, whichever name the keys are under.** Two changes, both
    aimed at the one way this item can go wrong, which is that the keys ARE in
    Render under a name we were not reading and "not connected" is
    indistinguishable from "never configured":
    · `src/lib/usps-env.js` accepts the alternate names USPS itself prints on its
      portal (`USPS_CONSUMER_KEY` / `_SECRET`, `USPS_API_KEY` / `_SECRET`,
      `USPS_KEY` / `_SECRET`), and when it is STILL not configured it lists every
      `USPS*` variable it CAN see — **by name, never by value** — so the health
      screen says "USPS_ADDRESS_KEY is set; this reads USPS_CLIENT_ID" instead of
      "not connected". A **Web Tools user id** (`USPS_USERID`) is deliberately
      NOT aliased: it is a credential for the older XML API and feeding it to the
      v3 OAuth client would fail as "your key is wrong" when the truth is "that
      is a key for another service" — so it is named and explained instead.
      (`scripts/test-usps-env-pure.js`, 36.)
    · The API Health page's environment CHIPS were still checking only the
      canonical name, so a connector working perfectly under an alternate showed
      a red "required — not set" and the card claimed a key was missing. An env
      entry now declares `alsoAccepts`, the chip reports **which name carried
      it**, and the alternates come from `usps-env`'s own lists so the two can
      never drift. (`test-env-alias-chip-pure.js` 21 +
      `scripts/render-api-health-chip.mjs` 8, browser-verified.)
  - **What is left is one look at the live screen**, which only somebody with
    access to the running service can take.
- [ ] **A1b** Turn on `USPS_BACKFILL_ENABLED` and watch the first pass. **Mind
  the quota**: the free tier is 60 lookups an hour ACROSS ALL USPS APIs, the
  counter is per-process, so with more than one instance the effective cap
  multiplies. Start with one instance or lower `USPS_BACKFILL_PER_TICK`.
- [ ] **A1c** Report what the back book actually looked like — how many of the
  706 standardised cleanly, how many USPS could not deliver to, how many changed.
  A count of corrections is a real finding about our data.

### A2. Geocodio — **waiting on a paid key, and no longer urgent**

3.1b proved the FREE US Census geocoder placed **5 of 5** real warehouse
addresses at rooftop precision in 115–255 ms. Geocodio is now a fallback for
what Census cannot place, not the main path.

- [ ] **A2** Add `GEOCODIO_API_KEY` and wire it as the second rung, ONLY after
  measuring how many addresses Census actually fails on. Buying a fallback for a
  gap nobody has measured is how you end up paying for nothing.

### A3. Confirm-the-facts step, then instant re-value

- [x] **A3** **DONE** — `src/lib/research/subject-facts.js` + the confirm door +
  the panel on the valuation screen.

  **It leads with what is NOT happening, not with what is blank.** A WRONG fact
  produces a wrong number somebody can argue with; a MISSING one removes
  adjustments from the grid, and an absent line reads exactly like "no adjustment
  was needed". Without a living area, FOUR go at once — `suggestAdjustments`
  multiplies the bedroom, bathroom and condition rates by the subject's own square
  footage and skips the size line entirely, so the value quietly becomes close to a
  plain average of the raw sale prices and still prints confidently. The panel says
  that, in those words. `test-subject-facts-pure.js` proves the claim rather than
  asserting the wording: the same subject and comparable, once with a living area
  and once without, and all three adjustments vanish.

  **The confirmation can go stale**, because a "checked" stamp that survives the
  fact being changed afterwards is worse than no stamp — it launders an unchecked
  number as a checked one. Compared by MEANING (2400 and "2400" are the same
  living area), so the badge is never cried wolf.

  **The correction re-values before the panel closes** — and that meant re-deriving
  every suggested adjustment, not just re-running the arithmetic. The first cut
  stored the fact and left the grid on the OLD one, so the value was byte-identical
  before and after; caught by the DB test, which was then proven to fail again when
  the fix is reverted. A line a human typed is never overwritten.

  A correction is checked, not coerced ("about 2400" is refused, naming the field,
  and NOTHING from that request is filed); a blank is a legitimate answer and shows
  back up as a blind spot; and a finalized valuation refuses a later check, because
  it is a record of what was said.

### A4. Draw and save a market-area polygon

**Started.** `src/lib/research/market-area.js` is written (ray casting,
half-open edges so a vertex is counted once, a point on the boundary counts as
INSIDE, plus area-in-square-miles so a screen can say "you have drawn 200 square
miles, which is a county"). Still to do:

- [x] **A4a** Its pure test — **DONE**, 68 assertions including a 61x61 grid scan
  against the shape's own definition, and both failure modes proven to fail the
  suite when reintroduced.
- [x] **A4b** A table and routes — **DONE** (`db/458`, save / list / archive /
  what-is-inside). Archived, never deleted: a valuation may rest on a boundary.
- [x] **A4c** Drawing on the map — **DONE**, verified by CLICKING the map in
  Chromium and reading the saved shape back out of the database.
- [x] **A4d** **DONE** — a drawn area is a comparable-search filter, and it is
  never relaxed. `?market_area_id=` on `GET /api/research/comps`, resolved by ONE
  place (`resolveMarketArea`) that reuses `market-area.pointInRing` rather than
  re-implementing ray casting in SQL — two answers to "is this house inside that
  shape" is exactly the kind of disagreement nobody would notice, because the
  search still returns houses and they still look plausible.

  Four rules, each pinned by `scripts/test-market-area-filter-db.js` (20, in
  `npm test`) and two of them proven to fail when reverted: the cut is EXACT (a
  property in the bounding box but outside the drawn ring does not come back — the
  box is what an index can express, not what the officer drew); the cut happens IN
  SQL, so the LIMIT and the total stay honest; an area containing NONE of our
  properties returns nothing rather than the whole town; and the relaxation ladder
  never widens past a boundary a person drew. An archived or unknown shape is a
  refusal, never a dropped filter. The answer says what the boundary cut, in both
  numbers — "12 of the 40 in its bounding box" is a boundary doing real work,
  "40 of the 40" means the shape is a rectangle.

**Why this matters more than a radius:** a mile in one direction crosses a river,
a rail line or a school-district boundary; a mile in another is the same houses
on the same streets. The 1004MC form itself asks the appraiser to define the
neighbourhood — so the boundary is a judgement a person makes.

---

## B. NEW — a real Google map

**The owner's ask:** *"add some Google API keys for you to use real Google maps
and put your comps on the actual place on the map where it sits … it shouldn't be
like a fake map, it should be a real map."*

### B0. What is already true, so the change is scoped honestly

The pins are **already at their real positions**. A comparable's latitude and
longitude come from the appraiser's own report; the subject's is worked out from
three comparables' stated distances (median fit **17 feet**). Nothing about the
positions is fake. What is plain is the **background** — the current base map is
OpenStreetMap raster tiles, which are free and correct but look nothing like
Google.

So this task is about the base map, Street View and satellite — not about where
the pins sit.

### B1. Which API — the recommendation

| | |
|---|---|
| **Maps JavaScript API** | **The one to use.** The real Google map: satellite, terrain, the familiar look, and the only one that gives Street View inline. |
| **Street View Static API** | **Worth adding.** For this business it may be the single most useful thing on the screen — *look at the actual house* next to the comparable's numbers. |
| **Places API** | **Already wired** (`GOOGLE_PLACES_API_KEY`, address autocomplete). Nothing new needed. |
| Maps Static API | Only if we want a map INSIDE the printed PDF report. Cheaper per call, no interaction. |

**Cost, plainly:** Google gives **$200 of free usage a month**, which is about
**28,500 map loads**. An internal desk will not come close, so in practice this
is free — but billing has to be enabled on the Google Cloud project for the key
to work at all, and a key with no restrictions is a key anyone can copy off the
page and spend our money with.

- [ ] **B1a** Add the key as `GOOGLE_MAPS_API_KEY` — the config already reads it
  (`cfg.googleMapsKey`), falling back to the Places key.
- [ ] **B1b** **RESTRICT THE KEY** in the Google Cloud console: HTTP-referrer
  restricted to our own domain, and enabled for only the APIs we use. A browser
  key is public by nature — it is visible in the page — so the restriction IS the
  security, not the secrecy.

### B2. THE RULE THAT MUST NOT BE BROKEN — display vs storage

**Google's terms let you keep a `place_id` forever and cap storing a latitude and
longitude at 30 days** unless you are on a licensed tier. This warehouse is a
permanent record of properties, looked up once and read for years.

So the split, which the codebase already made deliberately and must keep:

- **Google for DISPLAY** — the base map, satellite, Street View, the picture a
  person looks at.
- **US Census / OpenStreetMap for STORAGE** — the coordinates we write into
  `properties` and keep.

Mixing these would put us out of compliance quietly, and nothing would break to
tell us.

- [x] **B2** **DONE** — and it is a DATABASE CONSTRAINT, not only a code rule
  (`db/459`, `properties_no_google_geo_ck`). Every other guard on this is one
  somebody has to remember: a comment, a provider list, a source-level assertion.
  Each catches the change written the way we expect. The change that will actually
  break this is the one nobody reviewed — an import script, a hand-run migration,
  a module written next year by someone reading only the column names — and a
  CHECK constraint catches it however it is phrased, loudly, at the moment of the
  write. `geocodeProperty` also refuses a forbidden source first, so it reads as a
  named answer rather than as a 500 three layers up on a background sweep. Proven
  by `scripts/test-no-google-coordinate-db.js` (16, in `npm test`): 8 of its
  assertions fail with the constraint removed, and every source we DO use is still
  storable — a guard that breaks the warehouse it protects is worse than none.

### B3. The build

- [x] **B3a / C4a — ANSWERED, AND THE ANSWER IS NOT GOOGLE'S TILES.** Google's
  terms require their imagery to be displayed through the Google Maps JavaScript
  API; pulling their raster tiles into a third-party renderer is a breach, and
  `app-v2/src/lib/tilemap.js` IS a third-party renderer. Using their JS API means
  handing the key to the browser and replacing that renderer wholesale — a real
  project, not a switch, and one to weigh separately.

  What the owner actually asked for ("look on the map actually where around you
  have things") is the AERIAL view, and that is free and unrestricted: **USGS
  National Map imagery** — US federal work, public domain, no key, no account, no
  cap — recent high-resolution orthoimagery of exactly the country we lend in.
  Shipped as a Map / Satellite toggle on `CompMap`, with each layer carrying its
  OWN zoom ceiling (USGS stops at 16 over much of the country and returns nothing
  past it, which reads as a broken map rather than as the edge of the photography)
  and its own attribution. Pinned by `scripts/test-tilemap-pure.mjs` (56),
  including an assertion that NO layer is served by Google — the swap looks
  trivial and would pass every other check in the suite.

---

## C. THE OWNER'S ADDITIONS (2026-08-03)

### C1. **THE HALF-MILE BUG — CONFIRMED, and it is not an API problem**

The owner: *"if I put in a real address and I click it should only come up things
within half a mile — it doesn't work, it comes up properties from different
states."*

**Reproduced on real data:**

```
A half-mile search with NO coordinates (a typed address):
  -> 955 properties across 9 STATES: CT, NJ, NY, AL, PA, OH, IN, MI, SC
  -> distance column: null

The SAME half mile, anchored on a property that HAS coordinates:
  -> 9 properties, 1 state, furthest 0.449 miles, none over the limit

Does the radius reach the SQL with no position?
  -> WHERE clause: (none).  The radius is SILENTLY DROPPED.
```

**ROOT CAUSE** (`src/lib/research/search.js`): the distance predicate is built
inside `if (lat != null && lng != null)`. A typed address has neither, so the
radius is not applied at all — and nothing anywhere says so. The DISTANCE MATHS
IS CORRECT: the anchored test proves it to three decimal places, and
`test-research-geo-box-pure.js` already proves the bounding box contains the
circle at every latitude. **A different geocoding API would not have fixed this.**

- [x] **C1a** **A FILTER THAT CANNOT RUN IS A REFUSAL, NEVER A WIDER SEARCH.**
  **DONE.** `buildQuery` now reports `radiusUnusable` and `searchProperties`
  returns nothing with a stated reason rather than the whole country. Measured
  after the fix: the same half-mile search went from **955 properties across 9
  states** to **0 with a reason**, while the anchored search is untouched (9, one
  state, furthest 0.449 miles). The ladder marks a rung it could not measure so
  it never reads as "found nothing", and the screen now says what actually
  happened instead of "distance was not used at all". Guarded by assertions in
  `test-research-geo-box-pure.js` proven to FAIL when the guard is reverted.
  ORIGINAL WORDING:
  When a radius is asked for and there is no position, the search must say so
  and return nothing rather than hand back nine states. This is the same rule
  the quick answer and the adjustment corpus already follow, and it is the one
  the comp search is missing.
- [x] **C1b** **GEOCODE THE TYPED SUBJECT** so the radius can actually run —
  **DONE** with C2. `GET /api/address/position` answers a typed address with a
  coordinate from KEYLESS sources only (US Census, then OpenStreetMap), and the
  comp search carries it through the URL into `/api/research/comps`. It goes
  through `geocodeProperty`, so it inherits the two refusals written after the
  2026-07-28 Piscataway incident: a provider answering with a DIFFERENT house is
  refused rather than adopted, and "a house number plus a state" is refused
  before anyone is asked.
- [x] **C1c** A test that FAILS on today's code — **DONE** earlier
  (`scripts/test-research-geo-box-pure.js`, proven to fail via `break-radius.js`).
  Extended in `scripts/test-address-position.js` (33) and by the browser check
  `scripts/render-address-box.mjs` (55), which asserts an unplaceable address
  sends NO position and the search refuses honestly.

### C2. **Address autofill everywhere in the Resource Center**

The owner: *"take the address automatic filler … it should populate everywhere
you can put in an address — property research, find comparables, market
conditions, what we charge, quick answer."*

Today only the loan-application form has it (`/api/address/suggest`, which
already prefers Google Places when `GOOGLE_PLACES_API_KEY` is set and falls back
to the free OpenStreetMap service otherwise).

- [x] **C2a** **DONE** — `app-v2/src/components/AddressBox.jsx`. It wraps the
  autocomplete the loan application already uses (deliberately the SAME
  component, so an address typed on a research screen is standardised exactly
  like one typed on a loan file) and adds the two things a research screen needs:
  picking fills the town, state and ZIP as well as the street, and the pick
  carries the position. `TownLookup` is the same box for the screens that search
  a town rather than a house.
- [x] **C2b** **DONE** — on all six: Property Research, Find comparables, Market
  conditions, What we charge, Quick answer, Market areas. Driven for real in a
  browser on every one of them.
- [x] **C2c** **DONE**. The field says which of the two states it is in, worded
  as the consequence: "Found on the map — distance searches can run from here",
  or "we could not place that address on the map — a distance search cannot be
  answered from it, so search by town instead." Typing over a picked address
  drops the position (a coordinate belongs to the address it was looked up for),
  and so does correcting the town, state or ZIP by hand.

**Two things found on the way, both fixed here.** The suggestion menu's
flip-above-the-field logic had never once run: the menu only renders after
`place()` has measured it, so `place()` always measured a menu that was not in
the DOM yet and took its height as zero. On a tall page the list was pinned below
the fold with no way to scroll to it — you could type and nothing would appear.
That affected every address field in PILOT, not just these. And OpenStreetMap's
one-request-per-second limit is per PROCESS, while three modules each kept their
own clock — one clock now (`src/lib/osm-gate.js`).

### C3. **One Property Research & Resource Center section**

The owner: *"we now have on our left side a few separate sections which all of
them should technically be combined in one section with different pages …
property research, find comparables, market conditions, what we charge, quick
answer — all of it is one Resource Center."*

- [x] **C3** **DONE** — `app-v2/src/components/ResearchNav.jsx`. One sidebar
  entry, whose pages appear beneath it while you are inside the section, and the
  same page strip on every page of it.

  **Every URL is unchanged, and that is the design rather than a redirect.** The
  AI Command Center collapsed its screens behind `?tab=` and redirected the old
  routes; that shape is wrong here for two concrete reasons — every research
  screen keeps its entire search in its OWN query string precisely so a search is
  a link you can paste to a colleague, and a `?tab=` would sit in that same query
  string; and these pages already lived at nested paths under
  `/internal/research`, so making them pages of one section needed no new address
  at all. Nothing anyone bookmarked moved, so nothing has to be caught. The tabs
  are ROUTES, so Back, middle-click and bookmarking behave as they look.
  Verified in a browser (`scripts/render-research-section.mjs`, 46): one sidebar
  entry from outside, the pages beneath it from inside, every page still on its
  own address with the right tab lit, and a saved link carrying a search still
  opening on that search.

### C4. **Real Google maps** — see A/B above for the recommendation

The owner is adding a Google key. **One key covers both jobs** (enable *Places
API* + *Maps JavaScript API*, restrict it to our domain):

| Job | API | Why |
|---|---|---|
| The address box | **Google Places Autocomplete** | Already wired — `GOOGLE_PLACES_API_KEY` switches it on everywhere at once |
| The map | **Google Maps JavaScript API** + Street View | The real map, satellite, and seeing the actual house |
| The coordinates we STORE | **the free US Census geocoder — unchanged** | Not cost, LAW: Google's terms cap storing a lat/lng at 30 days while a place_id may be kept forever, and this warehouse is permanent |

- [x] **C4a — ANSWERED, AND THE ANSWER IS NO (see B3a).** A Google BASE MAP is
  the one third of this that cannot be built the way it was imagined, and the
  reason is licensing rather than effort: Google's terms require their imagery to
  be displayed through the Google Maps JavaScript API, and pulling their raster
  tiles into a third-party renderer is a breach. `app-v2/src/lib/tilemap.js` IS a
  third-party renderer — 256px Web Mercator tiles, 56 assertions — so swapping the
  tile URL is not a one-line upgrade, it is a terms violation that would look like
  a working map.

  Doing it properly means the Google Maps JavaScript API: the key goes into the
  browser (referrer-restricted), and our renderer is replaced wholesale, along with
  the pins, the distance rings, the drawing tool and the "this property has never
  been placed" honesty rules built on top of it. That is a real project and worth
  deciding on its own merits, not slipping in under "add a key".

  **What the owner actually asked for is already shipped without it**: the aerial
  view (USGS National Map — public domain, keyless, recent high-resolution
  orthoimagery of exactly the country we lend in) and Street View on the property
  itself. `test-tilemap-pure.mjs` asserts that NO layer is served by Google,
  because the swap looks trivial and would pass every other check in the suite.
- [x] **C4b / B3b** **DONE, and dormant until a key exists.** The satellite half
  shipped with B3a above (USGS imagery — public domain, keyless). Street View is
  the FALLBACK on a property with no appraisal photograph, served through our own
  `/api/address/photo` proxy so the key never reaches the browser, and rendering
  NOTHING at all when no key is configured, so the layout is unchanged until one is.

  **It is always LABELLED, and that is not decoration.** An appraiser's photo is
  evidence of the property on the day of the report and is what the condition grade
  was written from; a street image is a car that drove past at some point, from the
  road, possibly years out. Presenting the two alike invites somebody to read a
  tidy front garden as evidence of condition — so an appraisal photo is never
  replaced by one, and the fallback carries a corner label saying what it is.

  **It is LAZY, which is a cost decision as much as a speed one.** Street View
  Static is billed per request, and a 25-row comparable list would otherwise fire
  25 billable calls per page view including the rows nobody scrolls to. Verified in
  a real browser in both states (`scripts/render-street-fallback.mjs`, 10).
- [x] **C4c** **DONE** — same guard as B2 above (`db/459`).

---

## THE RULE THAT STILL GOVERNS EVERY ITEM

**Never fabricate.** This warehouse holds only properties that appeared in an
appraisal we paid for — roughly 7% of a town. A thin answer is almost always a
statement about our coverage, not about the user's filters, and a confident wrong
answer is more expensive than silence every single time.
