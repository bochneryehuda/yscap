-- WHERE DID THAT DISTANCE COME FROM?
--
-- `properties.eff_latitude` / `eff_longitude` (db/412) are generated as
-- `COALESCE(geo_*, *)` — the one answer to "where is this property" — and every
-- radius search, every "0.3 miles away" and every map pin reads them. But the
-- coordinate underneath can be any of FOUR things, and they are not remotely
-- equivalent:
--
--   · `census` / `osm`  — our own lookup, stored ONLY on an exact-address match,
--                         so a rooftop.
--   · `comp_trilateration` — derived from the comparables around the property
--                         (db/446's sibling work). Measured on the real corpus:
--                         median 17 feet out, worst 67. Excellent, and still an
--                         ESTIMATE.
--   · `appraiser`       — the coordinate the appraisal itself carried, which is
--                         whatever the vendor's own geocoder produced years ago
--                         at unknown precision. db/412's own comment says these
--                         are "frequently the centre of the ZIP".
--   · `mixed`           — a latitude from one source and a longitude from
--                         another. `eff_latitude` and `eff_longitude` COALESCE
--                         INDEPENDENTLY, so this is expressible even though
--                         `coords.js` and every writer keep the pair together.
--                         It must be visible rather than silently trusted.
--
-- A ZIP centroid is a mile or more from the house. So "0.3 miles away" computed
-- from one is not a slightly worse answer than one computed from a rooftop — it
-- is a number with no relationship to the question, presented in exactly the
-- same font. Nothing anywhere said which you were looking at.
--
-- THIS COLUMN IS THE PROVENANCE, GENERATED FROM THE SAME COLUMNS `eff_*` READS,
-- so it can never disagree with the coordinate it describes. Generated STORED
-- rather than computed in each query for the same reason `eff_*` is: a query that
-- forgets cannot silently report the wrong basis.
--
-- Deliberately NOT a quality SCORE. Ranking these on one scale would invite a
-- threshold, and the honest statement is the source itself — a caller who wants
-- to exclude a basis names it, and a screen that shows a distance shows where it
-- came from.
--
-- NOTE ON THE TRILATERATED ONES, because it cuts the other way too: the
-- trilateration's known points ARE the appraiser's own comp coordinates. If those
-- were ZIP centroids, three circles drawn around three of them could not possibly
-- agree to seventeen feet — so the residual is itself a measurement of how good
-- the appraisers' coordinates are, and on this corpus it says they are real.

ALTER TABLE properties ADD COLUMN IF NOT EXISTS eff_geo_source text
  GENERATED ALWAYS AS (
    CASE
      WHEN geo_latitude IS NOT NULL AND geo_longitude IS NOT NULL
        THEN COALESCE(geo_source, 'lookup')
      WHEN geo_latitude IS NULL AND geo_longitude IS NULL
        AND latitude IS NOT NULL AND longitude IS NOT NULL
        THEN 'appraiser'
      WHEN COALESCE(geo_latitude, latitude) IS NOT NULL
        AND COALESCE(geo_longitude, longitude) IS NOT NULL
        THEN 'mixed'
      ELSE NULL
    END) STORED;

-- The filter is "give me only properties placed well enough to measure from",
-- which is a small IN-list over a low-cardinality column on rows that already
-- have a position — so it rides the existing `ix_properties_eff_geo` bounding-box
-- index and needs only this to avoid a re-check per row.
CREATE INDEX IF NOT EXISTS ix_properties_eff_geo_source
  ON properties(eff_geo_source)
  WHERE eff_geo_source IS NOT NULL;
