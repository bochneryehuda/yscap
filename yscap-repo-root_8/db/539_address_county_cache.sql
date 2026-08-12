-- ============================================================================
-- 539_address_county_cache.sql — cache the COUNTY of an address alongside the
-- canonical-address rows (db/124), so the Class Valuation order desk can fill the
-- county Class requires without a fresh geocode on every order preview.
--
-- Class rejects an order with no county ("The County field is required"), and the
-- mailing one-line address the file stores never carries one — county is not part
-- of a mailing address. address-canon.resolveCounty() geocodes the property and
-- reads the county (Google administrative_area_level_2 / OSM address.county), then
-- stores it here under a `county:`-prefixed input_key so it can NEVER be read by
-- the place_id resolver (cacheGet only ever reads the plain / `osm:` keys) — a
-- county-only row with a NULL place_id must never look like an "unresolvable"
-- address to canonicalize().
--
-- Additive + idempotent.
-- ============================================================================

ALTER TABLE address_canon_cache ADD COLUMN IF NOT EXISTS county text;
