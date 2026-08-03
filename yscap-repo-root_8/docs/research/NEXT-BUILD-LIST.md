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

- [ ] **A3** Before a valuation is trusted, walk the user through the subject's
  facts — the ones the value is most sensitive to (size, condition, unit count) —
  let them correct any, and re-run the grid immediately. Most of the machinery
  exists; this is the step that turns "the system says" into "I checked".

### A4. Draw and save a market-area polygon

**Started.** `src/lib/research/market-area.js` is written (ray casting,
half-open edges so a vertex is counted once, a point on the boundary counts as
INSIDE, plus area-in-square-miles so a screen can say "you have drawn 200 square
miles, which is a county"). Still to do:

- [x] **A4a** Its pure test — **DONE**, 68 assertions including a 61x61 grid scan
  against the shape's own definition, and both failure modes proven to fail the
  suite when reintroduced.
- [x] **A4b** A table and routes — **DONE** (`db/454`, save / list / archive /
  what-is-inside). Archived, never deleted: a valuation may rest on a boundary.
- [x] **A4c** Drawing on the map — **DONE**, verified by CLICKING the map in
  Chromium and reading the saved shape back out of the database.
- [ ] **A4d** Use it as a comparable-search filter. The route that answers
  "what is inside this area" exists and cuts correctly (measured: 19 of the 59
  its bounding box held); wiring it into the comp search itself is what is left.

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

- [ ] **B2** A guard in the codebase that says so, so a future change cannot
  quietly start storing a Google coordinate.

### B3. The build

- [ ] **B3a** A Google base-map mode in `CompMap.jsx`, chosen at runtime when a
  key is present and falling back to the current OpenStreetMap tiles when it is
  not — so the map never goes blank because a key expired or a bill lapsed.
- [ ] **B3b** Satellite / map toggle, and Street View for the subject and each
  comparable.
- [ ] **B3c** Keep every honesty rule the current map has: a property with no
  position is NAMED below the map rather than dropped; a position we worked out
  ourselves is drawn hollow and says so.
- [ ] **B3d** Render-verify it, the same way everything else here was verified —
  a green build is not evidence.

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

- [ ] **C4a** Google base map in `CompMap`, falling back to the current
  OpenStreetMap tiles when no key is present — the map must never go blank
  because a bill lapsed.
- [ ] **C4b** Satellite toggle and Street View for the subject and each comp.
- [ ] **C4c** A guard so a Google coordinate can never be written into
  `properties` — the 30-day rule breaks silently, with nothing to warn us.

---

## THE RULE THAT STILL GOVERNS EVERY ITEM

**Never fabricate.** This warehouse holds only properties that appeared in an
appraisal we paid for — roughly 7% of a town. A thin answer is almost always a
statement about our coverage, not about the user's filters, and a confident wrong
answer is more expensive than silence every single time.
