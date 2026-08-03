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

- [ ] **A4a** Its pure test — the geometry decides which comparables an officer
  sees, and getting it subtly wrong is invisible.
- [ ] **A4b** A table and a route to save a named area per market.
- [ ] **A4c** Drawing on the map (click to add corners, drag to move one).
- [ ] **A4d** Use it as a comparable-search filter, with a bounding-box
  pre-filter in SQL and the exact test after it.

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

## C. THE OWNER'S ADDITIONS

*(to be filled in — the owner is adding tasks here)*

- [ ]
- [ ]
- [ ]

---

## THE RULE THAT STILL GOVERNS EVERY ITEM

**Never fabricate.** This warehouse holds only properties that appeared in an
appraisal we paid for — roughly 7% of a town. A thin answer is almost always a
statement about our coverage, not about the user's filters, and a confident wrong
answer is more expensive than silence every single time.
