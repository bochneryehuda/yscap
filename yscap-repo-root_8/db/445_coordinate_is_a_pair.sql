-- A COORDINATE IS A PAIR — BOTH OR NEITHER. Clearing the halves already stored.
--
-- A latitude with no longitude is not a position, and it reads as one to every
-- `IS NOT NULL` check written on a single column. `properties.eff_latitude` is a
-- GENERATED `COALESCE(geo_latitude, latitude)`, so a half pair makes a property
-- look placed while nothing can place it.
--
-- Measured on the real 152-report corpus: ELEVEN comparables carry a latitude
-- and no longitude, and it propagates the whole way — `appraisal_comparables` →
-- `property_observations` → `properties` → `eff_latitude`. The values are not
-- latitudes at all: -86.96, -86.98, -74.74 are LONGITUDES (Alabama, then New
-- Jersey), written by the vendor into `LatitudeNumber` with `LongitudeNumber`
-- left empty. The parser is right to bound a latitude to ±90 — and every one of
-- these passes it, because a US longitude is a perfectly legal latitude. Only
-- the MISSING OTHER HALF gives it away.
--
-- Nothing has yet shown a wrong distance, because the radius search happens to
-- require both columns. That is luck, not design: the next surface to write
-- `WHERE latitude IS NOT NULL` — a map, a property page, an export — plots a
-- house in the Gulf of Guinea.
--
-- GOING FORWARD the rule lives in `src/lib/research/coords.js`, applied by both
-- write paths. This clears what is already stored. Idempotent, and it only ever
-- removes half a fact — a complete pair is never touched, and there is nothing
-- to restore because half a coordinate was never information.

UPDATE appraisal_comparables
   SET latitude = NULL, longitude = NULL
 WHERE (latitude IS NULL) <> (longitude IS NULL);

UPDATE appraisals
   SET subject_latitude = NULL, subject_longitude = NULL
 WHERE (subject_latitude IS NULL) <> (subject_longitude IS NULL);

UPDATE property_observations
   SET latitude = NULL, longitude = NULL
 WHERE (latitude IS NULL) <> (longitude IS NULL);

-- `properties.latitude` is the appraiser's own figure rolled up from the
-- observations; `geo_*` is what a geocoder looked up. Both pairs get the rule.
UPDATE properties
   SET latitude = NULL, longitude = NULL
 WHERE (latitude IS NULL) <> (longitude IS NULL);

UPDATE properties
   SET geo_latitude = NULL, geo_longitude = NULL, geo_source = NULL, geo_precision = NULL
 WHERE (geo_latitude IS NULL) <> (geo_longitude IS NULL);
