-- 413 — GOOGLE COORDINATES ARE KEPT ONLY AS LONG AS GOOGLE ALLOWS
-- (owner-authorized 2026-08-02: "go ahead and fix the google coordinates issue")
--
-- db/124 created `address_canon_cache` and says so plainly in its own header: each
-- address resolves ONCE and every later comparison is a cache hit. That is exactly
-- right for what the cache exists to do — prove two differently-typed addresses are
-- the same property — and it is why the resolved row is written as immutable.
--
-- It is NOT right for the coordinates. Google Maps Platform's Service Specific
-- Terms allow a `place_id` to be kept indefinitely (General Terms A.3) but cap a
-- stored latitude/longitude at THIRTY CONSECUTIVE CALENDAR DAYS (§6.3.1). The
-- indefinite exception in §6.3.2 requires the cache to be logically isolated to a
-- single end user AND not used as a replacement for calling the API — a shared,
-- company-wide address cache is neither. So the coordinates in this table have been
-- kept past what we are licensed to keep.
--
-- THE FIX KEEPS THE FEATURE AND DROPS ONLY WHAT WE MAY NOT HOLD:
--
--   • `place_id` is kept FOREVER. It is what `samePlace()` compares, so the
--     address-matching this table was built for is completely untouched — no extra
--     API call, no behaviour change, nothing slower.
--   • `lat` / `lng` / `formatted` / `zip` on a GOOGLE row expire after 30 days and
--     are blanked by a bounded boot sweep. The row stays; only the licensed-window
--     fields go.
--   • An `osm:` row NEVER expires. OpenStreetMap's licence permits keeping the
--     result, so those rows are left exactly as they are — and the research
--     warehouse's own coordinates (db/412) are Census/OSM-sourced for the same
--     reason and are not affected by any of this.
--
-- WHEN A CALLER GENUINELY NEEDS COORDINATES (the ClickUp location push) and the
-- row's have lapsed, `address-canon.geocode()` re-asks and refreshes them. That is
-- one call for one address at the moment it is actually used, instead of holding
-- the whole book indefinitely.

ALTER TABLE address_canon_cache ADD COLUMN IF NOT EXISTS coords_expire_at timestamptz;

-- BACK-DATE. Every existing Google-sourced row gets the expiry it should always
-- have had, measured from when it was resolved. Rows already older than the window
-- land with a date in the PAST, which is correct — the boot sweep clears those on
-- its first run, which is the compliance action itself.
--
-- An `osm:`-keyed row is left NULL: never expires, nothing to do. `place_id IS NULL`
-- is an unresolvable row that holds no coordinates to expire.
UPDATE address_canon_cache
   SET coords_expire_at = resolved_at + INTERVAL '30 days'
 WHERE coords_expire_at IS NULL
   AND place_id IS NOT NULL
   AND place_id NOT LIKE 'osm:%'
   AND input_key NOT LIKE 'osm:%';

-- The sweep's queue: Google rows past their window that still hold coordinates.
CREATE INDEX IF NOT EXISTS idx_address_canon_coords_expiry
  ON address_canon_cache(coords_expire_at)
  WHERE coords_expire_at IS NOT NULL AND lat IS NOT NULL;
