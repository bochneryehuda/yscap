-- 411 — COORDINATES FOR THE RESEARCH WAREHOUSE (how far is this comp from my house?)
--
-- The owner asked for a distance search and a map: put in a subject property, say
-- how close a comparable has to be, and see how far every property in the database
-- is from it. `search.js` already does the arithmetic correctly (a bounding box on
-- the indexed columns, then a haversine refine with the longitude correction most
-- people get wrong). What was missing was COORDINATES: only a comparable that the
-- appraiser's own software happened to geocode has any, and a SUBJECT property
-- never has any at all, so the radius filter had almost nothing to filter.
--
-- WHY THE GEOCODE NEEDS ITS OWN COLUMNS, and this is the whole point of this file:
-- `properties.latitude`/`longitude` are ROLL-UP columns. Every fact on `properties`
-- is recomputed from the observations on every ingest, and a column that no
-- observation states is set back to NULL. So a geocode written into `latitude`
-- passes every check the day it is written and is silently WIPED the next time any
-- report mentioning that property is re-read — which is exactly the kind of bug
-- that looks like the feature "sometimes not working".
--
-- So: `latitude`/`longitude` keep meaning "what an appraiser told us", untouched,
-- and `geo_latitude`/`geo_longitude` mean "what we looked up". `eff_latitude` /
-- `eff_longitude` are the answer to "where is this property" — generated STORED, so
-- they are a real indexable column rather than an expression every query has to
-- remember to write, and so a query that forgets cannot silently use the wrong one.

ALTER TABLE properties ADD COLUMN IF NOT EXISTS geo_latitude   numeric(9,6);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geo_longitude  numeric(9,6);
-- Which service answered ('census' | 'osm'), so a bad batch can be identified and
-- re-run without touching the rest.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geo_source     text;
-- How precise the answer is. Only a ROOFTOP / exact-address match is stored as a
-- coordinate at all — a street-level or town-level answer would put every house on
-- one road at the same point and make a quarter-mile radius meaningless.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geo_precision  text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geo_at         timestamptz;
-- When we last ASKED. This is what drains the back-fill: a property nobody can
-- place is stamped as attempted so it is not asked about again every boot forever,
-- and can still be re-tried deliberately by clearing the stamp.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geo_attempted_at timestamptz;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geo_attempts   integer NOT NULL DEFAULT 0;

-- THE ONE ANSWER TO "WHERE IS THIS PROPERTY".
-- The looked-up coordinate wins over the appraiser's, deliberately: an appraisal's
-- comp coordinates are whatever the vendor's own geocoder produced years ago, at
-- unknown precision, and are frequently the centre of the ZIP. Ours are kept only
-- when they are an exact address match. COALESCE of two plain columns is immutable,
-- so this is legal as a STORED generated column.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS eff_latitude numeric(9,6)
  GENERATED ALWAYS AS (COALESCE(geo_latitude, latitude)) STORED;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS eff_longitude numeric(9,6)
  GENERATED ALWAYS AS (COALESCE(geo_longitude, longitude)) STORED;

-- The radius search cuts on a bounding box over both columns at once.
CREATE INDEX IF NOT EXISTS ix_properties_eff_geo
  ON properties(eff_latitude, eff_longitude)
  WHERE eff_latitude IS NOT NULL AND eff_longitude IS NOT NULL;

-- The back-fill's own queue: everything not placed yet, oldest attempt first.
CREATE INDEX IF NOT EXISTS ix_properties_geo_todo
  ON properties(geo_attempted_at NULLS FIRST)
  WHERE geo_latitude IS NULL;
