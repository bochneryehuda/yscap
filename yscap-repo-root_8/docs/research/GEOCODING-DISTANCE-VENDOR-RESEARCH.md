# Geocoding & Distance — buy decision + integration runbook

**Researched 2026-08-02.** Answers the owner's ask: *"add a Google API or any other API to tell the system how far each comparable in the database is from the subject property … let me know which vendor to buy and exact step-by-step instructions."*

---

## BOTTOM LINE

**Buy nothing for the distance itself — distance between two known points is arithmetic, not a product, and `src/lib/research/search.js` already computes it correctly.** What PILOT is actually missing is *coordinates*: the subject property of every appraisal is stored with `latitude: null, longitude: null` (`src/lib/research/ingest.js:530`), so the radius filter in `/api/research/comps` silently never runs and `valuation.scoreComp` — which gives **25 of the total comp score to distance and awards zero when distance is unknown** — is currently scoring every comparable as if it were three miles away. Fix that with the **US Census Bureau Geocoder**: free, official, no account, no API key, US-only (which is 100% of this book), 10,000 addresses per batch request, and — decisively — **no terms-of-service restriction on storing the coordinates forever**, because it is a US Government work. Sign up for **one paid backstop, Geoapify** (≈ **€49 / $53 for a single month**, then cancel — their licence lets you keep the results), for the ~5–10 % of addresses Census cannot place. Total cost: **$0 at 5,000 properties, $0 at 50,000, and about $53 one-time at 250,000.** **Do not put Google on this job.** Google's own Maps Platform Terms, §6.3.1 (last modified 10 June 2026), forbid keeping a latitude/longitude for more than **30 consecutive calendar days** — which would convert a one-time $1,200 backfill at 250,000 properties into a **permanent $1,200/month, $14,400/year** re-geocoding bill for data you already have. It also means the existing permanent `address_canon_cache` (db/124) is **currently out of compliance** for its Google-sourced `lat`/`lng`/`formatted` columns; §3.4 below gives the exact, cheap fix.

---

## 1. Four different things get confused here. Only one of them needs a vendor.

The owner's message runs four distinct products together. Separating them is most of the decision.

| # | The thing | What it is | Does it need a vendor? | Billed how |
|---|---|---|---|---|
| **(a)** | **Geocoding** | address text → `latitude, longitude`. **One-time per property.** Cacheable forever *if the vendor lets you*. | **Yes** — this is the only real purchase | per lookup |
| **(b)** | **Distance** (straight-line / haversine) | two known lat/lng pairs → miles between them | **NO. This is a five-line formula.** | free, forever |
| **(c)** | **Drive time / route distance** | "12 minutes by car, 4.3 road miles" | **Yes** — and it is billed **per query**, not per property | per element, every single search |
| **(d)** | **Map display** | an interactive map in the browser (tiles + JS) | **Yes** — a *separate product on a separate bill* | per map load |

**Blunt version:** for *"how far is each comparable from my subject"*, the owner needs **(a)** once and **(b)** free. **(c)** and **(d)** are paying for nothing on this ask — see §7 (drive time) and §1.3 (maps).

### 1.1 The call-count math, for N properties

Let **N** = properties in the warehouse, **S** = comparable searches staff run per month, **C** = candidate comps returned per search (realistically 100–300 after the SQL filters).

| Design | Geocode calls | Distance calls | Cost shape |
|---|---|---|---|
| **A — geocode once, cache, haversine in SQL** *(recommended)* | **N once**, then ~1 per newly-ingested property forever | **0. Ever. At any volume.** | one-time |
| **B — vendor Distance Matrix per search** | **N once** (you still need coordinates) | **S × C per month**, billed per *element* | recurring, grows with usage |
| **C — map display on top** | — | — | + per map load |

Worked at this shop's realistic volume — 100 appraisals/month, each contributing 1 subject + 3–8 comps ≈ **900 new addresses/month** after dedupe, and 20 comp searches/day × 250 candidates:

- **Design A:** 900 geocodes/month. **Distance calls: zero.** On Census: **$0/month.**
- **Design B:** the same 900 geocodes, **plus 150,000 Distance Matrix elements/month** → at Google's $5 per 1,000 elements that is **$750/month, $9,000/year**, for a number Design A produces in microseconds inside a query that is already running. (Google's Distance Matrix also caps at 25 origins × 25 destinations = 625 elements per request, so 250 candidates is not even one round trip.)

**Design B is paying $9,000 a year for worse latency and the same answer.** Reject it.

### 1.2 Is straight-line good enough? Yes, and it is what the industry uses.

The Fannie Mae 1004 grid records comparable proximity as `ProximityToSubjectDescription` — *"0.35 miles NE"* — a **straight-line** figure, and PILOT's appraisal parser already extracts it (`src/lib/appraisal/extract.js:365`). Every appraisal this lender has ever received states distance the same way haversine does. Matching the appraiser's own convention is a feature, not a compromise.

### 1.3 A map in the browser is a different bill, and nobody asked for one

The owner said "connected to Google Maps", but the requirement stated — *"tell us how far each and every comparable is"* — is a **number in a table column**, not a pin on a map. Adding an interactive map means the Maps JavaScript API (Essentials tier: 10,000 free dynamic map loads/month, then ~$7 per 1,000), a browser-exposed key that **cannot be IP-restricted** (only HTTP-referrer-restricted, which is far weaker), and Google's "no use with a non-Google map" clause pulling the rest of the geocoding stack into Google's terms. Ship the distance column first. If a map is genuinely wanted later, it is a separate, small decision — and it can be done with free OpenStreetMap tiles.

---

## 2. Vendor comparison — 2026 pricing

Prices verified August 2026. Where a figure comes from a secondary source it is marked **[2nd]**; anything marked **[verify]** must be confirmed against the vendor's live terms before signing.

| Vendor | Free tier | Price / 1,000 | Rate limit | Bulk / batch | US residential rooftop | **Permanent storage?** |
|---|---|---|---|---|---|---|
| **US Census Geocoder** | **Unlimited, free, no key** | **$0** | none published (be polite) | **Yes — 10,000 addresses per POST** | *Interpolated* — a point on the street in front of the parcel, not the rooftop | **YES — unrestricted.** US Government work |
| **Geoapify** | 3,000 credits/day (batch = 0.5 credits ⇒ 6,000 addr/day) | ~€49/mo for 300,000 credits ⇒ **≈$0.09** | ~5 req/s free tier | **Yes — async batch** | Good (OSM + **OpenAddresses**, which carries county parcel points) | **YES** — *"you can store the results"*, attribution to OSM/OpenAddresses/GeoNames required |
| **OpenCage** | 2,500/day | $50/mo for 10,000/day ⇒ **≈$0.17** | 15 req/s | No true batch | Good (open data blend) | **YES** — *"even if you are no longer a customer"* |
| **LocationIQ** | 5,000/day, 2 req/s | $49/mo for 10,000/day ⇒ **≈$0.16** | 2 req/s free | Yes (paid) | Good (OSM-derived) | Reported permissive **[verify]** |
| **Geocodio** | 2,500/day | **$1.00** (rose from $0.50 on 1 Feb 2026) | generous | **Yes — file upload + API** | **Excellent — true rooftop, US/CA/MX only** | Reported unlimited **[verify]** |
| **Mapbox** — Temporary | 100,000/mo | $0.75 → $0.45 at volume | high | Yes | Very good | **NO — storage prohibited entirely** |
| **Mapbox** — **Permanent** | none | **$5.00** | high | Yes | Very good | **YES** — `permanent=true` on Geocoding v6; internal business use only, **no redistribution** |
| **AWS Location Service** | — | **≈$4.00** (`intendedUse=Stored`) | AWS quotas | Yes | Very good (Esri/HERE data) | **YES** — storage is an explicit, priced product feature |
| **HERE** | 250,000/mo freemium **[2nd]** | ~$1.00 after (+~6 % from 1 Apr 2026) | ~5 req/s freemium | Yes | Excellent | **Base plans: NO.** Storage/export needs an enterprise licence **[verify — sources conflict]** |
| **Google Geocoding API** | 10,000/mo (Essentials) | **$5.00** | 3,000 QPM | **No batch endpoint** | **Best-in-class** | **NO — 30 days maximum.** See §3.1 |
| **Radar** | 100,000/mo **[2nd]** | $0.50 **[2nd]** | — | Yes | Good | **Marketing says yes; the Terms of Use reportedly cap caching at 30 days and prohibit "develop a database of addresses"** — see §3.6. **Disqualified pending written clarification** |
| **Smarty (US Rooftop)** | trial | subscription only — $125/mo @ 1,000/mo up to $1,100/mo @ 170,000/mo | — | Yes | **Best-in-class US rooftop** | **Conditional and self-cancelling** — rooftop data may only be stored *while the subscription is active* ⇒ a permanent recurring bill |
| **Precisely** | none | enterprise quote (typically $10k+/yr) | — | Yes | Best-in-class | Licensed, term-limited |
| **OSM / Nominatim** (public) | free | $0 | **1 req/s absolute max; long-running or scheduled scripts throttled to 4 req/min** | **No — bulk explicitly restricted** | Fair; **misses house numbers often** (already documented in `address-canon.js`) | Data ODbL — storing results is fine; **the policy forbids the bulk job**, not the storage |

### 2.1 Reading the table

- **Nominatim cannot do the backfill.** 250,000 addresses at the policy's 1 req/s is 69 hours of continuous requests against a donated volunteer server, and the policy's "scripts run at regular intervals → 4 requests/minute" clause makes a 250,000-address sweep a straightforward violation. `address-canon.js` already implements a 1.1 s politeness gate for exactly this reason — that gate is correct for one-off lookups and useless for a warehouse. Keep Nominatim as the last-resort per-address fallback it already is; do not build the backfill on it.
- **Google has the best US residential accuracy of anything on this list, and it is the one vendor whose terms make it unusable here.** That is the whole decision in one sentence.
- **Smarty has the best *rooftop* accuracy for US residential** and is the right answer for a very different problem (mailing-address validation, flood-zone determination, tax-parcel matching). Its storage rights ending with the subscription makes it structurally wrong for a permanent warehouse.
- **The accuracy gap does not matter for this use case.** Census interpolation typically lands within ~10–40 m of the true rooftop on a normal residential block. On a comp filter of "within 0.5 miles" (2,640 ft ≈ 805 m), a 40 m error changes the answer for a property sitting within ~5 % of the boundary — and those are exactly the marginal comps an underwriter re-checks by eye anyway. Where interpolation *does* bite is census-tract/block assignment (a point interpolated onto the street can fall on the wrong side of a tract boundary) — PILOT does not use the warehouse for tract assignment, so this is not a live risk. Where it also bites is rural addresses on long address ranges and brand-new subdivisions; those are the ~5–10 % that go to the paid backstop.

---

## 3. The caching terms are the deciding factor

This section is the reason the recommendation is not Google.

### 3.1 Google Maps Platform — verbatim, current

From the **Google Maps Platform Service Specific Terms**, *last modified 10 June 2026* ([cloud.google.com/maps-platform/terms/maps-service-terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)), section **6 (Geocoding API)**:

> **6.3.1** Customer may temporarily cache latitude (lat) and longitude (lng) values from the Geocoding API for **up to 30 consecutive calendar days**, after which Customer must delete the cached latitude and longitude values.
>
> **6.3.2** Customer may indefinitely cache latitude (lat), longitude (lng), formatted_address, and the structured address values from the Geocoding API **solely to support the direct, End User facing functionality of the Customer Application that initiated the request** (e.g., displaying the address of a location in a weather application, associating location data with a photograph), **only where the cache is not used as a replacement for making an additional call to the Services. Cached data must be logically isolated to the specific End User it is associated with and must not be used across multiple End Users.**

And from the **General Service Terms**, section **A.3 (Google ID Caching)**:

> Customer may cache the Google ID values from the Services that return such field and allow caching, in accordance with its Documentation. For example, Customer may cache (a) **place_id** from Places API, Directions API, Geolocation API and Routes API …

**What this means for PILOT, precisely:**

| Data | Google's rule | Fits a comp warehouse? |
|---|---|---|
| `place_id` | **Indefinite** | **Yes** — this is why `address-canon.samePlace()` is fine as designed |
| `lat` / `lng` | **30 days**, then delete | **No** |
| `lat`/`lng`/`formatted_address` under the 6.3.2 exception | Indefinite **only** if (i) it serves the end user who made the request, (ii) it is **logically isolated to that one end user**, (iii) it is **not used instead of calling the API again** | **No, on all three prongs.** A cross-file comparable database is by definition shared across every staff user, and its entire purpose is to avoid re-calling the API |

There is **no version of the Google agreement that fixes this.** The 30-day rule lives in the Service Specific Terms, which apply on top of both the standalone *Google Maps Platform Terms of Service* and a *Google Cloud* / Cloud Master Agreement order — signing a Cloud contract, moving to a Maps subscription tier (Starter / Essentials / Pro), or buying volume-discounted pricing changes the **price**, not §6.3.1. The only route to different storage rights is a **negotiated custom licence with Google Maps Platform sales**, which is an enterprise-scale conversation with an enterprise-scale price. The EEA-specific Service Specific Terms carry the same 30-day construction; PILOT is US-billed anyway.

### 3.2 Also note: "No use with a non-Google map"

§6.2: *"Customer must not use Google Maps Content from the Geocoding API in conjunction with a non-Google map."* If a map is ever added to the research screen, mixing Google-derived coordinates with free OSM tiles is itself a breach. One more reason to keep Google out of the warehouse entirely.

### 3.3 The other vendors, on storage

| Vendor | Storage position | Confidence |
|---|---|---|
| **US Census Geocoder** | **Unrestricted.** A work of the US Government, not subject to copyright (17 U.S.C. §105); the geocoder publishes no ToS restricting downstream storage of results. This is the strongest position on the list. | High |
| **Geoapify** | **Permits storing results permanently**, with attribution to OpenStreetMap / OpenAddresses / GeoNames kept alongside the returned addresses. Underlying data is ODbL/open; the OSMF's own *Geocoding Community Guideline* treats storing a set of geocoding results as a *produced work*, not a derivative database, so ODbL share-alike is not triggered by keeping coordinates in your own system. | High |
| **OpenCage** | **Permits permanent storage, explicitly including after you stop being a customer.** Same open-data basis. | High |
| **LocationIQ** | Reported permissive (OSM-derived, same family as OpenCage/Geoapify). | **[verify]** — read the current ToS before relying on it |
| **Mapbox** | **Two products.** *Temporary Geocode* (the default) — **storage prohibited outright**, not even 30 days. *Permanent Geocode* (`permanent=true` on Geocoding v6) — **storage permitted indefinitely**, at $5/1,000, restricted to your own internal business use, **no redistribution or sublicensing**. Mapbox Feature IDs may be stored regardless (the same idea as Google's `place_id`). | High |
| **HERE** | Sources conflict. Multiple comparisons state base/freemium plans **do not** permit permanent storage and that caching/export needs an enterprise licence; others claim storage is allowed on all plans. **Do not rely on HERE for permanent storage without written confirmation.** | **[verify]** |
| **AWS Location Service** | **Permits permanent storage as a priced product feature** — set `intendedUse = Stored` on the request and you are billed the (higher) stored rate, ~$4/1,000, and may keep the result indefinitely. Cleanest contractual position of any commercial vendor. | High |
| **Radar** | See §3.6. **Disqualified pending clarification.** | — |
| **Smarty** | Standard products permit retention; **US Rooftop Geocoding is carved out — that data may only be stored while the subscription is active.** A warehouse built on it must be paid for forever or purged. | High |
| **Nominatim / OSM** | The *data* is ODbL and storing results is fine. The *public server's usage policy* is what blocks a bulk backfill (1 req/s; scheduled/long-running scripts capped at 4 req/min and required to cache). | High |

### 3.4 **PILOT is currently out of compliance. Here is the exact fix.**

`db/124_address_canon_cache.sql` creates `address_canon_cache` with `place_id, formatted, lat, lng, zip` and the module header states the design intent plainly: *"cached forever in address_canon_cache"*, *"This cache is PERMANENT by design"*. `address-canon.cachePut()` writes Google Geocoding output into it and never expires a resolved row.

- **`place_id` — compliant.** General Service Terms A.3 permits indefinite caching. `samePlace()` compares `place_id` identity, so the feature that motivated db/124 in the first place is untouched.
- **`lat`, `lng`, `formatted`, `zip` from a Google row — non-compliant.** §6.3.1 caps them at 30 days, and §6.3.2's exception does not apply (not per-end-user, and explicitly used as a replacement for calling the API).
- **`osm:`-prefixed rows — compliant.** Those come from Nominatim/OSM, whose licence permits keeping the results. Leave them exactly as they are.

**The fix is small, and it does not break `samePlace`:**

1. Add a nullable `coords_expire_at timestamptz` to `address_canon_cache` (new migration, additive + idempotent, per the repo rule).
2. On a **Google-sourced** row (`place_id` not prefixed `osm:`), set `coords_expire_at = now() + interval '30 days'` at write time. On an `osm:` row leave it NULL (never expires).
3. A bounded boot sweep (mirroring `address-heal.js`) nulls `lat`, `lng`, `formatted`, `zip` on Google rows past `coords_expire_at`, **keeping `place_id`**.
4. `cacheGet()` treats a row with a live `place_id` but nulled coordinates as "resolved, coordinates expired" — `samePlace` still answers instantly from `place_id`; `geocode()` re-fetches coordinates when a caller actually needs them.

Net effect: the identity/dedupe feature that db/124 exists for keeps working forever at zero API cost, and PILOT stops storing Google coordinates past the licensed window. **Once the research warehouse gets its own Census/Geoapify-sourced coordinates (§6), almost nothing will ask `address-canon` for coordinates anyway.**

### 3.5 Why this is worth caring about

This is not a theoretical compliance point. Google's Maps Platform terms include an audit right (General Service Terms A.4: a corporate officer's certification and/or an independent audit on 30 days' notice), and a lender that is already carrying GLBA obligations, an NMLS licence and investor due-diligence reviews does not want a third-party-data-licensing finding sitting in a warehouse it built deliberately. It is also just cheaper to be compliant: the compliant vendors here cost **$0–$53 one-time**; the non-compliant design costs **$14,400/year** *and* is non-compliant.

### 3.6 Radar — the trap worth naming

Radar markets itself directly at Google-cost refugees and its blog explicitly sells *"the right to store, reuse, and export results freely."* Secondary reporting on **radar.com/terms**, however, describes a clause prohibiting licensees from **pre-fetching, caching, indexing or storing** address or POI data from the geocoding, autocomplete or place-search APIs **for more than thirty (30) days**, and separately prohibiting use of those APIs **to develop a database of addresses or points of interest**. If that is the operative language, Radar is *the same 30-day restriction as Google plus an explicit prohibition on the exact thing PILOT is building* — despite the marketing. I could not retrieve the primary terms page directly (403 to automated fetch), so this is flagged rather than asserted. **Do not sign Radar for this without the storage right in writing from their sales team.** It is a good illustration of why the marketing page is never the source.

---

## 4. THE RECOMMENDATION

### 4.1 Buy nothing. Use the US Census Geocoder, with Geoapify as a one-month paid backstop.

**Primary: US Census Bureau Geocoder.**
- **$0**, forever, at every volume on the table.
- **No account, no API key, no credit card, no vendor relationship, no contract to review, no key to leak, no bill to cap.** For a non-developer owner, the entire vendor-risk surface is zero.
- **Batch endpoint takes 10,000 addresses per request** — the 250,000-property backfill is 25 (or, run conservatively, 250 smaller) requests.
- **US-only** — which is 100 % of this lender's book. Not a limitation here.
- **Permanent storage with no restriction whatsoever** — the single most important property, and the one Google, Mapbox-temporary, Smarty-rooftop and (probably) Radar and HERE all fail.
- Accuracy is *interpolated to the street frontage*, not rooftop. For "how far is this comp from my subject", the error is immaterial (§2.1).

**Backstop: Geoapify, one month, ≈€49 / $53, then cancel.**
- Covers the ~5–10 % of addresses Census returns `No_Match` or `Tie` for — rural addresses, new construction, addresses whose TIGER range is stale.
- Blends **OpenAddresses**, which carries county-published parcel points, so on the addresses Census misses it is materially better than Census and often rooftop-grade.
- **Storage is permitted permanently**, so the €49 is genuinely one-time: pay for a month, drain the queue, cancel, keep the coordinates.
- Attribution to OpenStreetMap / OpenAddresses / GeoNames must be shown wherever the addresses are displayed — a one-line footnote on the research screen.
- Its free tier (3,000 credits/day; batch geocoding costs 0.5 credits per address ⇒ **6,000 addresses/day free**) may well cover the whole backstop volume without paying at all at 5,000 and 50,000 scale.

### 4.2 Expected monthly cost, each property geocoded once and cached

| | **5,000 properties** | **50,000** | **250,000** | Ongoing (≈900 new/mo) |
|---|---|---|---|---|
| **Census (primary)** | **$0** | **$0** | **$0** | **$0** |
| **Geoapify (backstop, ~8 % of volume)** | 400 addr — **$0** (free tier) | 4,000 addr — **$0** (free tier, 1 day) | 20,000 addr — **$0** (free tier, 4 days) | **$0** |
| **RECOMMENDED TOTAL** | **$0** | **$0** | **$0**, worst case **$53 one-time** | **$0/month** |
| *Google Geocoding, for contrast* | $0 | **$200 — every month, forever** | **$1,200 — every month, forever** ($14,400/yr) | included above |
| *Mapbox Permanent, for contrast* | $25 once | $250 once | $1,250 once | ~$5/mo |
| *AWS Location (Stored), for contrast* | $20 once | $200 once | $1,000 once | ~$4/mo |
| *Smarty US Rooftop, for contrast* | $125/mo forever | ~$400/mo forever | $1,100/mo forever | — storage dies with the subscription |

The Google row is the point of the whole document. Because §6.3.1 forces deletion after 30 days, the "one-time backfill" is not one-time — it is a subscription to re-deriving information you already had. At 250,000 properties that is **$14,400 a year to stand still.**

### 4.3 Fallback / secondary recommendation

**If Census quality proves insufficient in production** (watch `No_Match` + `Tie` rate; if it exceeds ~15 % on this book, the primary is wrong), switch the primary to one of these, in this order:

1. **Geoapify** ($53/mo, cancellable, permanent storage, batch, attribution required) — promote the backstop to primary. Smallest change: the provider adapter already exists.
2. **AWS Location Service** with `intendedUse=Stored` (~$4/1,000, ~$1,000 once at 250k). Best *contractual* clarity of any commercial vendor — storage is a documented, priced feature rather than a concession — and the region is pinnable for data-residency. Choose this if legal wants a named commercial counterparty with a real DPA rather than a federal endpoint and a €49 European SaaS.
3. **Mapbox Permanent Geocoding** ($5/1,000, $1,250 once at 250k). Clean terms, excellent data, but 25× the price of Geoapify for a difference that will not show up in a half-mile comp radius.

**If someone insists on rooftop-perfect US residential coordinates** (e.g. a future flood-zone or tax-parcel feature), that is **Smarty US Rooftop** — and it must be treated as a *recurring* line item, queried live rather than warehoused, because its storage right dies with the subscription. That is a different project.

**Explicitly rejected:** Google (30-day cap, §3.1); Radar (probable 30-day cap **and** an explicit "no address database" clause, §3.6); Mapbox Temporary (no storage at all); HERE base tiers (storage unconfirmed, §3.3); public Nominatim for bulk (policy violation, §2.1).

---

## 5. THE RUNBOOK

### Part A — What the owner does for the recommended path: **almost nothing**

This is the main reason to take this recommendation. The primary geocoder needs **no account, no key, no card, no cap, no bill.**

1. Say yes to the plan. That is the entire owner action for the primary path.
2. There is **no** account to create, **no** API key to generate or restrict, **no** spending cap to set, and **no** first bill to check — because there is no vendor and no charge. The US Census Bureau publishes this as a public service.
3. **What to expect afterwards:** within a day or two of the change deploying, the research screen shows a **"Distance"** column with a mileage on every comparable, and the comp ranking visibly improves (see §6.6 — distance is a quarter of the comp score and has been scoring zero for everything). Nothing else changes.

### Part B — Owner steps for the Geoapify backstop (only if/when it is needed)

Do these only when the developer reports that the Census pass has left a meaningful number of properties unplaced.

1. Go to **https://www.geoapify.com/** and click **Sign up**. Use a company email — **`admin@yscapgroup.com`**, not a personal address — so the account survives any one person leaving.
2. Confirm the email, sign in. You land on **MyProjects**.
3. Click **Create a new project**. Name it exactly **`PILOT — property geocoding`** so it is obvious later what it is for.
4. Open the project. On the **API Keys** tab there is already a key. **Do not use the pre-made one for the server.** Click **Create a new key**, name it **`pilot-server-backfill`**, and copy it somewhere safe for five minutes. You will paste it into Render in step 9 and then it is never needed again.
5. **Restrict the key — this is the step that stops a leaked key becoming somebody else's bill.** Open the key's settings and find **Allowed IP addresses** (it may be labelled *IP restrictions* or sit under *Restrictions*). Enter **the outbound IP addresses of the PILOT Render service** — ask the developer for these; in the Render dashboard they are under the service's **Settings → Outbound IPs**. Save. **Leave "Allowed origins" / "Allowed referrers" empty** — this key is only ever used by our server, never by a web browser, so it should accept requests from our server's IP addresses and nothing else. **Never save an unrestricted key.**
6. **Set the spending ceiling.** Geoapify plans are a **hard credit allowance**, which is better protection than a credit-card cap: when the allowance is used up the API returns an error instead of charging more.
   - Stay on the **Free** plan first (3,000 credits/day). Nothing can be charged at all.
   - Only if the developer says the free allowance is too slow, go to **Pricing / Billing** and pick the **smallest paid plan that covers the job** — the ~€49/month tier (300,000 credits ≈ 600,000 batch addresses). Do **not** pick a bigger tier "to be safe"; a bigger tier is a bigger bill, not more safety.
   - **If there is any setting called "overage", "auto top-up", "pay-as-you-go beyond plan" or similar — turn it OFF.** A hard stop is the whole point. If you cannot find such a setting, tell the developer so they can add an application-side monthly counter instead.
   - Set a **billing alert / email notification** at 50 % and 80 % of the allowance if the console offers one.
7. **Diary the cancellation.** Put a reminder in ClickUp for **35 days out**: *"Cancel the Geoapify paid plan — the backfill is done and their licence lets us keep the coordinates."* This is the difference between a $53 project and a $636/year subscription nobody remembers.
8. **What the FIRST bill should look like:** **one charge of about €49 (≈ $53), once.** Nothing else. Then, after step 7, **nothing, ever again.**
   - **If you see a second monthly charge** → step 7 was missed. Cancel now.
   - **If you see a charge larger than €49** → an overage setting is on, or the key leaked. **Delete the key immediately** in the console (there is a delete/revoke button next to it), then tell the developer.
   - **If you see any charge at all while still on the Free plan** → something is wrong. Delete the key and stop.
9. Give the key to the developer to put into **Render → the PILOT service → Environment** as **`GEOAPIFY_API_KEY`**. **Do not paste it into a chat, an email, a document, or a ClickUp task** — per the repo's standing rule, a credential that appears in a transcript is considered compromised and must be rotated before use. Type it directly into Render, or use Render's own secret entry.
10. **How to verify it works:** ask the developer to confirm two things and show you the output — (a) `GET /api/health` still returns green, and (b) the research screen shows a mileage on a comparable you can sanity-check by eye (pick a comp you know is a couple of blocks away and confirm it reads a few tenths of a mile, not 40 miles and not blank).

### Part C — Developer steps

Numbered, in order. Nothing here touches a frozen pricing engine, a borrower-facing surface, or an existing write path.

1. **Migration `db/411_property_geocode.sql`** — additive + idempotent. **Check the high-water mark at the moment you write it**: `409` was the highest committed file, but a parallel session already has an uncommitted `db/411_research_xml_imports.sql` in the working tree. Two sessions grabbing the same number is a known collision in this repo — take the next free number and renumber *yours*, never theirs.
   ```sql
   ALTER TABLE properties ADD COLUMN IF NOT EXISTS geo_latitude   numeric(9,6);
   ALTER TABLE properties ADD COLUMN IF NOT EXISTS geo_longitude  numeric(9,6);
   ALTER TABLE properties ADD COLUMN IF NOT EXISTS geo_source     text;   -- census | geoapify | osm | appraisal
   ALTER TABLE properties ADD COLUMN IF NOT EXISTS geo_precision  text;   -- rooftop | parcel | interpolated | street | none
   ALTER TABLE properties ADD COLUMN IF NOT EXISTS geo_match      text;   -- the provider's own verdict, verbatim
   ALTER TABLE properties ADD COLUMN IF NOT EXISTS geo_checked_at timestamptz;
   ALTER TABLE properties ADD COLUMN IF NOT EXISTS geo_attempts   integer NOT NULL DEFAULT 0;

   -- The EFFECTIVE coordinate: what the appraiser stated wins; our geocode fills the gap.
   -- COALESCE of two plain columns is IMMUTABLE, so this can be a STORED generated column
   -- and therefore indexed — which is what keeps the bounding-box search sargable.
   ALTER TABLE properties ADD COLUMN IF NOT EXISTS eff_latitude  numeric(9,6)
     GENERATED ALWAYS AS (COALESCE(latitude,  geo_latitude))  STORED;
   ALTER TABLE properties ADD COLUMN IF NOT EXISTS eff_longitude numeric(9,6)
     GENERATED ALWAYS AS (COALESCE(longitude, geo_longitude)) STORED;

   CREATE INDEX IF NOT EXISTS idx_properties_eff_latlng
     ON properties(eff_latitude, eff_longitude) WHERE eff_latitude IS NOT NULL;
   -- Drains the backfill queue: oldest-unchecked first, self-terminating.
   CREATE INDEX IF NOT EXISTS idx_properties_geo_pending
     ON properties(geo_checked_at NULLS FIRST, id) WHERE geo_latitude IS NULL;
   ```
   **Why separate columns and not just writing into `properties.latitude`:** see §6.1. Writing into `latitude` is silently destroyed on the next ingest.

2. **`src/lib/research/geocode.js`** — the provider adapter. Pure request/response shaping, injected IO, never throws. Two providers behind one interface:
   - `census(addresses[])` → `POST https://geocoding.geo.census.gov/geocoder/locations/addressbatch` with `benchmark=Public_AR_Current`, a CSV body of `id,street,city,state,zip` (10,000 rows max; use 1,000 for reliability — the service is slow and a 10,000-row batch can take minutes). Response CSV carries a match verdict (`Match` / `No_Match` / `Tie`), `Exact` vs `Non_Exact`, and `lon,lat` (**note the order — longitude first**; getting this backwards puts every property in the Indian Ocean, which is at least an obvious failure). Map to `geo_precision='interpolated'`, `geo_source='census'`.
   - `geoapify(addresses[])` → the async batch endpoint, `geo_source='geoapify'`, `geo_precision` from their `rank.match_type` (`full_match` ⇒ `rooftop`/`parcel`, anything weaker ⇒ `street`). Only invoked when `cfg.geocoder.geoapifyKey` is set.
   - **Never cache a transient failure.** Reuse the doctrine already proven in `address-canon.js` (`googleDefinitive` / `osmDefinitive`): a 429/5xx/timeout is a statement about the *provider*, not about the address — do not stamp `geo_checked_at`, do not increment past the retry ceiling, retry later. Only a definitive provider "there is no such place" counts as an answer. This exact class already cost the owner a lost ClickUp address in July.
   - **Backoff:** serialize batches (one in flight), 500 ms between Census batches, exponential backoff `2s → 4s → 8s → 16s` capped at 5 attempts on 429/5xx, then leave the batch unstamped for the next cycle.

3. **`src/lib/research/geocode-backfill.js`** — the bounded, resumable, self-draining boot sweep. Mirror `src/clickup/address-backfill.js` term for term:
   - Durable cursor in `sync_runtime_state` under key `research_geocode_backfill`.
   - `RESEARCH_GEOCODE_BATCH` addresses per tick (default **250**), `RESEARCH_GEOCODE_CYCLE_DAYS` rest between full passes (default **30** — new construction does get added to the map, same reasoning as `GEOCODE_NEGATIVE_TTL_DAYS`).
   - **Self-draining:** every property looked at gets `geo_checked_at = now()` and `geo_attempts = geo_attempts + 1`, *including* a definitive no-match — so the queue empties and does not re-decode the same unplaceable rural address every boot. A *transient* failure leaves the row unstamped (point 2).
   - A pass that read zero rows **with errors** retries in 15 minutes rather than serving the full cycle rest (the `FAILED_RETRY_MS` pattern).
   - **Never throws.** A geocode failure must never stop the server booting.
   - Kill switch `RESEARCH_GEOCODE_DISABLED=1`.
   - Wire it in `src/server.js` alongside the existing `require('./lib/research/ingest').backfill(...)` boot block (line ~616), inside the same guarded `.then/.catch` shape.

4. **Geocode on ingest.** In `src/lib/research/ingest.js`, after `upsertProperty` creates a *new* `properties` row, leave `geo_checked_at` NULL — that alone enqueues it for the next sweep tick. **Do not geocode inline inside the appraisal import**: the import is already the longest operation in the app, and a slow provider must never make an appraisal import fail. Fire-and-forget is the existing doctrine here (`fireResearchIngest`); keep it.

5. **`src/config.js`** — add under the existing address block (near `googlePlacesKey`, ~line 470):
   ```js
   geocoder: {
     provider:   (process.env.RESEARCH_GEOCODER || 'census').toLowerCase(), // census | geoapify | none
     geoapifyKey: process.env.GEOAPIFY_API_KEY || '',
     censusBenchmark: process.env.CENSUS_BENCHMARK || 'Public_AR_Current',
     contact:    process.env.OSM_CONTACT || 'admin@yscapgroup.com',   // User-Agent identity
   },
   ```
   **Env vars, set in the Render dashboard** (`render.yaml` is the source of truth for the service; add them there as `sync: false` secrets where applicable): **`GEOAPIFY_API_KEY`** (secret, only if the backstop is used), `RESEARCH_GEOCODER`, `RESEARCH_GEOCODE_BATCH`, `RESEARCH_GEOCODE_CYCLE_DAYS`, `RESEARCH_GEOCODE_DISABLED`. **No key is committed** — standing repo rule.

6. **`src/lib/research/search.js`** — three changes, all small:
   - Point the radius block at `p.eff_latitude` / `p.eff_longitude` instead of `p.latitude` / `p.longitude` (lines 254–265, 280), and add both to `LIST_COLUMNS`.
   - **Move the exact-circle test into the WHERE clause** (§6.4 — this is a real, live bug, not a nicety).
   - Add `geo_precision` and `geo_source` to `LIST_COLUMNS` so the UI can say *"approximate"* on an interpolated point.

7. **`src/routes/research.js`** — in the `/comps` handler (line ~312), read `subject.eff_latitude` / `eff_longitude`, and if the subject still has none, geocode it **on demand, once**, then persist. Keep the existing city/ZIP fallback: a subject with no coordinates must still return comps.

8. **Compliance fix for `address_canon_cache`** — §3.4. Separate, small migration + a bounded boot sweep in `src/lib/address-heal.js` style. `place_id` survives forever, so `samePlace()` is byte-identical in behaviour.

9. **Tests**, both in `npm test`:
   - `scripts/test-research-geocode-pure.js` — the provider response parsers (including the Census `lon,lat` column order, a `Tie`, a `No_Match`, and a truncated CSV row), the transient-vs-definitive classifier, the backoff schedule, and the haversine against three hand-checked real distances.
   - `scripts/test-research-geocode-db.js` — real Postgres: the generated `eff_*` columns resolve correctly for (appraisal-only / geocode-only / both / neither); **a re-ingest that nulls `properties.latitude` does NOT destroy `geo_latitude`** (this is the regression that matters most); the sweep is bounded, resumable and self-draining; a transient failure leaves the row unstamped and a definitive no-match stamps it; and the radius query returns the right rows with a correct `total`.

10. **Two audit agents**, per the standing repo rule: one pre-merge on the diff, one post-merge against `main`.

---

## 6. Integration design for *this* codebase

### 6.1 ⚠️ The trap: `properties.latitude` is a ROLL-UP column and will erase your geocode

`src/lib/research/ingest.js` lists `latitude` and `longitude` in `ROLLUP_FACTS` (line 77), and `rollupProperty()` ends each fact loop with:

```js
if (!(propCol in set)) set[propCol] = null;
```

So on **every** re-ingest of **any** report touching that property, `properties.latitude` is recomputed purely from `property_observations` — and if no observation states a coordinate, **it is set back to NULL.** A backfill that writes into `properties.latitude` would appear to work, pass a manual check, and then be silently wiped the next time an appraisal is re-imported or `backfillAppraisalCompSplitOnce` re-touches the row. This is exactly the "derived, never authored" doctrine the warehouse was designed around, working as intended.

**Therefore:** a geocode is **not an appraiser observation** and must not pretend to be one. It goes in its own `geo_*` columns, outside `ROLLUP_FACTS`, and the two are combined by the generated `eff_latitude` / `eff_longitude` columns (§5 step 1). The appraiser's stated coordinate always wins; ours fills the gap. Both survive every roll-up.

### 6.2 What is actually broken today

| Fact | Where | Consequence |
|---|---|---|
| The **subject** of every appraisal is stored with `latitude: null, longitude: null` | `ingest.js:530` | **Every property this lender actually lends on has no coordinates.** |
| Comps get coordinates only from MISMO `LatitudeNumber` / `LongitudeNumber` | `extract.js:366`, `ingest.js:613` | Present on a minority of reports; most vendors omit it |
| `/comps` radius filter is gated on `subject.latitude != null` | `research.js:312` | **The radius search silently never runs.** It is not broken — it is dark |
| `scoreComp` weights distance **25 of the total** and awards **0** when unknown | `valuation.js:596–598` | **Every comp is being ranked as if it were 3+ miles away.** The single largest weight in comp selection is currently contributing nothing but noise |
| `rollupProperty` nulls unstated roll-up facts | `ingest.js:~268` | §6.1 |

The last row is the strongest business argument for doing this at all: PILOT already *has* a comp-ranking engine that weights proximity most heavily, and it is running blind.

### 6.3 A property that cannot be geocoded must NOT vanish

Non-negotiable, and easy to get wrong:

- The **default** search must never require coordinates. Only the *radius* predicate touches `eff_latitude`, and it is appended only when the caller supplies `lat`/`lng`/`radius_miles` — `search.js` already builds it that way (the parameter-accumulator pattern). Do not add a blanket `eff_latitude IS NOT NULL`.
- `/comps` keeps its **city + ZIP + size-band** filters as the primary net; radius is an *additional* narrowing. A subject with no coordinates gets the same comp list it gets today, minus the distance column.
- `scoreComp` must **stop punishing** an unknown distance. Today `add(25, 0, 'distance unknown')` scores it identically to a comp 3 miles away. Correct behaviour is to **drop the distance component out of the denominator** for that comp and mark the score `partial`, so a good comp with no coordinate is not buried under a bad one with a coordinate. (This is a real scoring bug that the geocoding work exposes; fix it in the same pass.)
- Surface `geo_precision` in the UI: `rooftop` / `parcel` → plain mileage; `interpolated` → *"≈ 0.4 mi"*; `none` → *"distance unknown"*, never a blank cell and never a zero.

### 6.4 `search.js` is correct — and has one real bug the coordinates will expose

**The good news:** the radius implementation is right, including the part people get wrong. The comment at line 243 and the code at 259–262 already scale the longitude delta by `cos(lat)`:

```js
const dLat = radius / 69.0546;
const dLng = radius / Math.max(1, 69.1710 * Math.cos((lat * Math.PI) / 180));
```

That is correct, and the haversine refine is correct. **No change is needed to the maths.** The missing ingredient is the data, not the code.

**The bug:** `searchProperties()` applies the exact circle **in JavaScript, after the SQL `LIMIT`/`OFFSET`** (line 306), while `total` comes from `count(*) OVER ()` (line 296) — which counted the **bounding box**, not the circle. Consequences today (invisible, because the radius path never executes) and the moment coordinates land:

- `total` and `pages` **overstate** the result count by the box-vs-circle ratio — up to **27 %** (a square circumscribing a circle is `4/π` its area).
- Any page can come back **short** — request 25, receive 19 — because corner rows are dropped after paging.
- Sorting by `distance_miles` is fine, but a corner row can occupy a slot on page 1 and then disappear.

**Fix:** move the haversine into the `WHERE` clause as a predicate and delete the JS filter. It only ever evaluates on rows the indexed bounding box already admitted, so it costs essentially nothing:

```sql
AND (3958.7613 * 2 * asin(sqrt(
      power(sin(radians(p.eff_latitude - $lat) / 2), 2) +
      cos(radians($lat)) * cos(radians(p.eff_latitude)) *
      power(sin(radians(p.eff_longitude - $lng) / 2), 2)
    ))) <= $radius
```

### 6.5 The exact query: "properties within X miles of this subject, sorted by distance"

```sql
WITH subject AS (
  SELECT eff_latitude AS lat, eff_longitude AS lng
    FROM properties WHERE id = $1
)
SELECT p.id, p.display_address, p.city, p.state, p.zip,
       p.property_type, p.units, p.year_built, p.gla, p.beds, p.baths_total,
       p.condition_uad, p.quality_uad,
       p.last_sale_price, p.last_sale_date, p.last_sale_status,
       p.geo_precision, p.geo_source,
       round((3958.7613 * 2 * asin(sqrt(
           power(sin(radians(p.eff_latitude  - s.lat) / 2), 2) +
           cos(radians(s.lat)) * cos(radians(p.eff_latitude)) *
           power(sin(radians(p.eff_longitude - s.lng) / 2), 2)
         )))::numeric, 2) AS distance_miles
  FROM properties p CROSS JOIN subject s
 WHERE p.id <> $1
   AND s.lat IS NOT NULL
   AND p.eff_latitude  IS NOT NULL
   -- 1. INDEXED BOUNDING BOX does the cutting. 69.0546 mi per degree of latitude;
   --    a degree of LONGITUDE is 69.1710 * cos(lat) — about 52 mi in New Jersey —
   --    so the longitude box must be ~a third WIDER in degrees to cover the same miles.
   AND p.eff_latitude  BETWEEN s.lat - ($2 / 69.0546)
                           AND s.lat + ($2 / 69.0546)
   AND p.eff_longitude BETWEEN s.lng - ($2 / GREATEST(1, 69.1710 * cos(radians(s.lat))))
                           AND s.lng + ($2 / GREATEST(1, 69.1710 * cos(radians(s.lat))))
   -- 2. EXACT CIRCLE, evaluated only on what the box already admitted.
   AND (3958.7613 * 2 * asin(sqrt(
           power(sin(radians(p.eff_latitude  - s.lat) / 2), 2) +
           cos(radians(s.lat)) * cos(radians(p.eff_latitude)) *
           power(sin(radians(p.eff_longitude - s.lng) / 2), 2)
       ))) <= $2
   -- 3. Optional comp-quality narrowing, appended only when supplied:
   -- AND p.last_sale_date >= (CURRENT_DATE - INTERVAL '12 months')
   -- AND COALESCE(p.last_sale_status,'closed') = 'closed'
 ORDER BY distance_miles ASC, p.id
 LIMIT $3;
```

`$1` = subject property id, `$2` = radius in miles, `$3` = page size. `3958.7613` is the earth's mean radius in statute miles. **The `id` tiebreaker in `ORDER BY` is not decorative** — without it two comps at an identical distance can swap between pages.

### 6.6 What the owner sees when this ships

- A **Distance** column on the research/comp screen, in miles, on every comparable.
- The **"within X miles"** control on the comp finder actually doing something.
- Comp *ranking* materially improving, because the 25-point distance weight in `scoreComp` starts carrying real information instead of scoring zero for everything.
- The `properties` search gaining a working radius filter it has had the code for since day one.

---

## 7. Drive time — not worth it. Recommend against.

**Recommendation: do not buy drive-time / route distance.**

**1. It is not the standard the industry judges comps by.** The URAR grid records straight-line proximity. Appraisal review, investor due diligence and every note buyer's guideline in `docs/investor-guidelines-research/` reason about **neighborhood boundaries** — school district, census tract, the "market area" the appraiser defined, which side of a highway or a municipal line a property sits on. A comp 0.4 straight-line miles away with a 9-minute drive because a river is in the way is *still in the same neighborhood* and *still a valid comp*; a comp 0.4 miles away across a municipal boundary into a different school district may **not** be, and drive time cannot tell you that. Drive time answers a question nobody in this workflow is asking.

**2. This repo already learned this lesson, expensively.** The 2026-07-28 incident recorded in `CLAUDE.md`: `1727 S 2nd St, Piscataway, NJ 08854` and `1727 S 2nd St, Plainfield, NJ 07063` are **two different houses ~130 m apart** on opposite sides of a municipal line where the street numbering continues across the boundary. Straight-line distance says 130 m; drive time says a minute; the *underwriting* answer is "different town, different market, different comp set." The boundary was the fact that mattered. **If anything gets bought next, it is a municipal/tract boundary layer — free from the Census TIGER shapefiles — not drive time.**

**3. The cost is per-query and it never stops.** Google's Distance Matrix bills **per element** (origins × destinations) at $5/1,000 with 10,000 free/month; the Routes API `computeRouteMatrix` bills the same way. One subject against 250 candidates is 250 elements. Twenty searches a day is **150,000 elements/month = $750/month, $9,000/year** — and unlike geocoding it can never be cached down to zero, because a route is a function of the pair, so 250,000 properties have ~31 *billion* pairs. It also cannot be pre-computed: Google's terms treat route results the same way as coordinates.

**4. It would make the screen slower.** Haversine on the bounding-box survivors is sub-millisecond inside a query that is already running. A Distance Matrix round trip is 100–400 ms, capped at 625 elements per request, so 250 candidates is a fan-out of network calls in the request path — a visibly slower screen, a new failure mode, and a new rate limit, in exchange for a number that does not change any decision.

**If drive time is ever genuinely wanted** (e.g. an inspection-routing feature for the draw coordinator — a real use case where road distance is the actual question), buy it *then*, scoped to that feature, capped, and computed for a handful of stops rather than a comp grid.

---

## 8. Privacy / data residency

### 8.1 What is actually transmitted

One string, per property, once: **`1727 S 2nd St, Piscataway, NJ 08854`**. That is all. No borrower name, no SSN, no loan number, no loan amount, no email, no phone, no application id. `address-canon.geocode()` already calls `ADDR.withoutUnit()` before sending, so even the apartment number is stripped (it was added for match quality, and it happens to reduce what leaves the building). The recommended design sends **nothing else, ever** — no distance queries, no map loads, no autocomplete keystrokes.

### 8.2 Is a property address borrower PII? Mostly no — with one honest caveat

- A **property address on its own is public record.** It is in the county recorder's index, the tax assessor's roll, and MLS. It is not "nonpublic personal information" under GLBA (15 U.S.C. §6809(4)), which is keyed to information *about a consumer* obtained in connection with a financial service and not publicly available.
- **The caveat:** the *fact that YS Capital is geocoding this address today* is a weak commercial signal — it implies a property is being underwritten. Unassociated with a name, that signal is close to worthless, and it is far less exposed than what the business already does routinely: the address is pushed to **ClickUp** as a location field, mirrored to **SharePoint** as a folder name, sent to **DocuSign** in an envelope subject line, and typed into an appraisal order. **A geocoder is a strictly smaller disclosure than the integrations already in production.**
- The material distinction versus those systems: ClickUp/SharePoint/DocuSign receive the address **bound to a borrower's name**. The geocoder does not. Keep it that way — **never** put a borrower name, loan number or file id into a geocode query string, not even as a "reference" or "client id" parameter.

### 8.3 What each vendor logs, and where

| Vendor | Who they are | Logging / retention | Residency |
|---|---|---|---|
| **US Census Geocoder** *(recommended)* | US federal agency | Standard federal web-server logs under a System of Records Notice. **No commercial profiling, no ad-tech, no data resale — statutorily impossible.** | **United States.** Best possible answer for a US lender |
| **Geoapify** *(backstop)* | Small German SaaS | Standard API logs; GDPR-regime operator, DPA available | **EU (Germany).** Note: a US property address transiting to the EU is *not* a US data-residency problem (there is no US rule against it); it is only worth noting because the EU has *stricter* obligations on the processor, which is protective, not risky |
| **Google Maps Platform** *(rejected)* | Google LLC | Logged and used to improve Google's own products under the Maps Platform terms; Google explicitly reserves the right to use query data to improve the Services | Global |
| **AWS Location Service** *(fallback #2)* | Amazon | AWS logging; region-pinnable; covered by the AWS DPA and BAA-grade controls | **Your chosen AWS region** — the strongest control on the list if residency is ever contractually required |

### 8.4 Does it matter here? Practically no — with three concrete guardrails

The recommended stack sends a public property address to a US federal agency. That is about as low-risk as a third-party call gets in this application. The controls that make it defensible in a due-diligence questionnaire:

1. **Server-side only.** The key (if any) lives in Render env vars and is IP-restricted; no key ever reaches a browser bundle, and no borrower's browser ever contacts a geocoder. This is already the pattern `src/routes/address.js` uses for autocomplete.
2. **Address only, never identity.** Enforced structurally: the geocode adapter takes an address string, not a property row and not an application id. Add a test asserting the outbound query string contains only address components.
3. **A geocoder is never authoritative about which property the file is about.** This is already law in this repo — `address.geocodeRewriteIsSafe()` exists because Google confidently "corrected" a real subject property onto a different house across a municipal line. The research warehouse must inherit that discipline: a geocode contributes **coordinates only**, and may never rewrite `properties.display_address`, `street`, `city`, `state`, `zip` or `address_key`. Point 3 is a data-integrity rule as much as a privacy one, and it is the single most important line in this section.

**One thing to add regardless of vendor:** list the geocoder in the vendor inventory / third-party risk register alongside ClickUp, DocuSign, SharePoint, Resend, Sitewire and Encompass, with a one-line scope note: *"receives subject-property and comparable-property street addresses only; no borrower identity; results stored permanently under a permissive licence."* That single line is what an investor or auditor actually wants to see, and it costs nothing to write now.

---

## Sources

**Primary (retrieved and quoted verbatim):**
- [Google Maps Platform Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms) — §6.3.1 / §6.3.2 (Geocoding caching), §A.3 (Google ID caching / `place_id`), §6.2 (no use with a non-Google map), §A.4 (audit right). *Last modified 10 June 2026.*
- [Google Maps Platform EEA Service Specific Terms](https://cloud.google.com/archive/terms/maps-platform/eea/maps-service-terms-20251001)
- [Google Maps Platform Service Specific Terms — 2025-03-31 archive](https://cloud.google.com/archive/maps-platform/terms/maps-service-terms-20250331)

**Vendor pricing and terms:**
- [Google — Geocoding API Usage and Billing](https://developers.google.com/maps/documentation/geocoding/usage-and-billing) · [Optimizing Quota Usage When Geocoding](https://developers.google.com/maps/documentation/geocoding/geocoding-strategies) · [Distance Matrix Usage and Billing](https://developers.google.com/maps/documentation/distance-matrix/usage-and-billing) · [Routes API Usage and Billing](https://developers.google.com/maps/documentation/routes/usage-and-billing) · [Geocoding API policies](https://developers.google.com/maps/documentation/geocoding/policies) · [Pricing calculator](https://mapsplatform.google.com/pricing-calculator/)
- [Mapbox Product Terms (October 1, 2025)](https://cdn.prod.website-files.com/609ed46055e27a02ffc0749b/68dddd2815cb3d82685f0096_Mapbox%20Product%20Terms%20(October%201,%202025).pdf) · [Temporary vs Permanent Geocoding](https://docs.mapbox.com/help/dive-deeper/understand-temporary-vs-permanent-geocoding/) · [Mapbox pricing](https://www.mapbox.com/pricing) · [Geocoding API docs](https://docs.mapbox.com/api/search/geocoding/)
- [Amazon Location Service — Places pricing](https://docs.aws.amazon.com/location/latest/developerguide/places-pricing.html) · [IntendedUse parameter](https://docs.aws.amazon.com/location/latest/developerguide/places-intended-use.html) · [Pricing](https://aws.amazon.com/location/pricing)
- [Geoapify pricing](https://www.geoapify.com/pricing/) · [Pricing details](https://www.geoapify.com/pricing-details/) · [Terms and Conditions](https://www.geoapify.com/terms-and-conditions/) · [Geocoding API](https://www.geoapify.com/geocoding-api/) · [Online geocoding tool (storage + attribution statement)](https://www.geoapify.com/tools/geocoding-online/)
- [OpenCage pricing](https://opencagedata.com/pricing) · [Reducing your Google geocoding costs](https://opencagedata.com/reducing-your-google-geocoding-costs)
- [LocationIQ pricing](https://locationiq.com/pricing)
- [Geocodio — Pricing changes effective February 1, 2026](https://www.geocod.io/updates/2025-12-01-pricing-updates-2026) · [Geocoding Terms of Use and Data Storage Comparison](https://www.geocod.io/geocoding-terms-of-use-comparison) · [Why Geocodio results differ from the Census Bureau geocoder](https://www.geocod.io/why-might-geocodios-results-differ-from-the-us-census-bureau/) · [What happens when you exceed the Google Geocoding API rate limit](https://www.geocod.io/what-happens-when-you-exceed-the-google-geocoding-api-rate-limit)
- [Smarty — US Rooftop Geocoding pricing](https://www.smarty.com/pricing/us-rooftop-geocoding) · [US Rooftop Geocoding product](https://www.smarty.com/products/us-rooftop-geocoding) · [Smarty pricing](https://www.smarty.com/pricing)
- [HERE pricing overview (Placematic)](https://placematic.com/here-location-services/here-pricing/) · [HERE Geocoding API review (Distancematrix.ai)](https://distancematrix.ai/blog/here-geocoding-api-review)
- [Radar — Terms of Use](https://radar.com/terms) · [Radar Geocoding docs](https://docs.radar.com/maps/geocoding) · [The true cost of the Google Maps API and how Radar compares in 2026](https://radar.com/blog/google-maps-api-cost) — **note the conflict documented in §3.6**

**Free / open:**
- [US Census Geocoding Services API](https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html) · [API PDF spec](https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.pdf) · [Census Geocoder documentation](https://www.census.gov/programs-surveys/geography/technical-documentation/complete-technical-documentation/census-geocoder.html) · [Census Geocoder User Guide (May 2026)](https://www2.census.gov/geo/pdfs/maps-data/data/Census_Geocoder_User_Guide.pdf) · [Batch geocoding & API announcement](https://content.govdelivery.com/accounts/USCENSUS/bulletins/ac1f5b)
- [Nominatim Usage Policy (OSMF)](https://operations.osmfoundation.org/policies/nominatim/) · [OSMF Licence / Community Guidelines / Geocoding](https://osmfoundation.org/wiki/Licence/Community_Guidelines/Geocoding_-_Guideline) · [OSM Wiki — Open Data License / Geocoding Guideline](https://wiki.openstreetmap.org/wiki/Open_Data_License/Geocoding_-_Guideline)

**Comparisons and market context:**
- [Geocoding APIs compared: pricing, free tiers & terms of use (bitoff.org)](https://www.bitoff.org/geocoding-apis-comparison/) · [Guide to Geocoding API Pricing (Mapscaping)](https://mapscaping.com/guide-to-geocoding-api-pricing/) · [Best Geocoding APIs in 2026 (APIScout)](https://apiscout.dev/guides/best-geocoding-apis-2026) · [Best Free Geocoding APIs in 2026 (Scrap.io)](https://scrap.io/free-geocoding-api-comparison-2026) · [Google Maps API Pricing 2026 (Woosmap)](https://www.woosmap.com/blog/google-maps-api-pricing-breakdown) · [Google Maps API Pricing 2026 full SKU breakdown (MapAtlas)](https://mapatlas.eu/blog/google-maps-api-pricing-2026) · [Mapbox Pricing 2026 (Woosmap)](https://www.woosmap.com/blog/mapbox-pricing) · [Geocoding accuracy: how much do you need](https://www.esri.com/arcgis-blog/products/analytics/analytics/geocoding-delivering-high-location-accuracy) · [Accuracy of residential geocoding (NIH/PMC)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4203975/)

**In-repo (read for this analysis):**
`src/lib/address-canon.js` · `src/lib/address.js` · `src/lib/address-heal.js` · `src/clickup/address-backfill.js` · `src/lib/research/search.js` · `src/lib/research/ingest.js` · `src/lib/research/valuation.js` · `src/lib/appraisal/extract.js` · `src/routes/research.js` · `src/config.js` · `db/124_address_canon_cache.sql` · `db/125_sync_runtime_state.sql` · `db/158_appraisal_enrichment.sql` · `db/409_property_research_database.sql` · `db/410_property_valuations.sql` · `docs/PROPERTY-COMP-DATABASE-RESEARCH.md`
