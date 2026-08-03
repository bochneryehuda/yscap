-- ---------------------------------------------------------------------------
-- A GOOGLE COORDINATE MAY NEVER BE STORED IN THE PROPERTY WAREHOUSE.
--
-- This is a LICENSING rule, not a preference, and it is the one rule in the
-- research warehouse that a well-meaning future change is most likely to break:
-- once a Google Places key is configured, "we already have the place_id, just ask
-- Google for the geometry" is one line of code and it would be a genuine
-- improvement in every respect except the one that matters.
--
-- Google Maps Platform lets you keep a `place_id` indefinitely and caps storing a
-- latitude/longitude at 30 CONSECUTIVE DAYS unless the cache is isolated to a
-- single end user. `properties` is a permanent, shared warehouse read by everyone
-- in the company — it is not that. Complying by re-geocoding the whole warehouse
-- every month, forever, turns a one-off cost into a permanent bill for a number
-- that has not moved. The full comparison, with the terms quoted, is in
-- docs/research/GEOCODING-DISTANCE-VENDOR-RESEARCH.md.
--
-- So the warehouse's coordinates come only from services whose answers carry no
-- such term: the US Census geocoder (a US federal service, no key, no account),
-- OpenStreetMap Nominatim (ODbL, attributed in the UI), the appraisers' own
-- figures off the reports, and our own trilateration from those figures.
--
-- WHY A DATABASE CONSTRAINT AND NOT ONLY A CODE RULE. Every other guard on this
-- is a rule someone has to remember: a comment in `geocode.js`, a source-level
-- assertion in a test, a paragraph in a design document. Each of those catches the
-- change that is written the way we expect. A CHECK constraint catches it however
-- it is written — a new module, a hand-run migration, a psql session, an import
-- script nobody reviewed — and it fails LOUDLY at the moment of the write rather
-- than silently accumulating rows that have to be found and deleted later.
--
-- Google remains free to SUGGEST an address (the autocomplete uses it when a key
-- is set) and to draw a MAP. Neither of those stores a coordinate.
--
-- `address_canon_cache` is deliberately NOT covered: it legitimately holds Google
-- results and is swept on the 30-day expiry (db/413). This constraint is about the
-- permanent store.
-- ---------------------------------------------------------------------------

-- Any spelling of the vendor, in any casing, with or without punctuation, and
-- whether it arrives as the source itself ("google") or as a compound naming it
-- ("google_places", "places-google", "geocoded by Google"). Deliberately broad:
-- the cost of refusing a source we invented that merely contains the word is a
-- clear error at the moment somebody writes it, while the cost of letting one
-- through is a licensing breach nobody notices for a year.
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_no_google_geo_ck;
ALTER TABLE properties ADD CONSTRAINT properties_no_google_geo_ck
  CHECK (geo_source IS NULL OR lower(geo_source) NOT LIKE '%google%');

COMMENT ON CONSTRAINT properties_no_google_geo_ck ON properties IS
  'Google Maps Platform caps a STORED latitude/longitude at 30 days unless the cache is per-end-user; this warehouse is permanent and shared, so its coordinates come only from the US Census geocoder, OpenStreetMap, the appraisers themselves, or our own trilateration. Google may suggest an address and draw a map; it may never place a property here.';
