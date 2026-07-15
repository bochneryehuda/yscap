-- ============================================================================
-- 113_address_canon_cache.sql — canonical-address cache (owner-directed
-- 2026-07-15: "Ave/Avenue, Unit 114/114, Village of Spring Valley/Spring
-- Valley is technically the same — we need the Google Maps API for this").
-- Each distinct free-text address resolves ONCE through Google Geocoding to a
-- stable place_id; every later comparison is a cache hit. Two texts with the
-- SAME place_id are the same property, whatever their formatting.
-- Additive + idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS address_canon_cache (
  input_key    text PRIMARY KEY,            -- lower/collapsed input text
  place_id     text,                        -- Google place_id (NULL = unresolvable)
  formatted    text,                        -- canonical formatted_address
  lat          double precision,
  lng          double precision,
  zip          text,
  resolved_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_address_canon_place ON address_canon_cache(place_id) WHERE place_id IS NOT NULL;
