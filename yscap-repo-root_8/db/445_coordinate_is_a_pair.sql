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
--
-- FOUR TABLE/COLUMN PAIRS, AND `appraisals` IS DELIBERATELY NOT ONE OF THEM.
-- The first cut of this file also cleared `appraisals.subject_latitude` /
-- `subject_longitude`, which DO NOT EXIST — `ingest.js` says so in as many
-- words ("`appraisals` carries no subject_latitude/longitude, verified against
-- information_schema — reading them would be a phantom column that silently
-- answers null forever"), and the subject's position lives on the PROPERTY.
-- A migration runs as ONE implicit transaction, so that single bad statement
-- aborted the whole file and none of the four good ones ran: CI went red on
-- `column "subject_latitude" does not exist`. It slipped through locally because
-- the check was `psql -f … >/dev/null 2>&1 && echo applied` — psql exits 0 on a
-- statement error unless ON_ERROR_STOP=1 is set, so the "applied" was a lie
-- about a file that had rolled itself back.

UPDATE appraisal_comparables
   SET latitude = NULL, longitude = NULL
 WHERE (latitude IS NULL) <> (longitude IS NULL);

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
