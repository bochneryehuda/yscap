-- ============================================================================
-- db/576 — lt milestone catalog sync stamp
--
-- WHAT THIS CHANGES, AND WHY. `lt_encompass_milestones` is the tenant's milestone
-- catalog, and it has only ever been a PHOTOGRAPH: db/547 seeded it from an export
-- taken on 2026-08-14 and re-asserts those nineteen rows on every boot. Nothing has
-- ever read the tenant's LIVE catalog into it, although the read-only client has
-- carried the verified call since it was written.
--
-- That matters more than a stale reference list usually would, because the file
-- screen's milestone stepper marks progress POSITIONALLY: a loan sitting at a
-- milestone the catalog does not carry leaves the current position at -1 and marks
-- NOTHING reached, so the whole progress bar goes blank rather than slightly wrong.
-- The day a buyer adds a step — or renames one — every file at that step loses its
-- stepper, and nothing anywhere says why.
--
-- These two columns are what let a refresh be HONEST about itself: which rows came
-- from a live read and which are still the seeded photograph, and when the catalog
-- was last confirmed against Encompass. Without them a screen cannot tell a catalog
-- nobody has ever refreshed from one Encompass confirmed this morning.
--
-- WHY NO `is_archived` CHANGE. The column already exists and the pipeline route
-- already filters on it. A milestone that disappears from Encompass is ARCHIVED,
-- never deleted — a retired step must keep explaining the loans that passed
-- through it.
--
-- IDEMPOTENT. Both statements are ADD COLUMN IF NOT EXISTS.
--
-- BACKFILL: NONE, deliberately. Every existing row IS the seeded photograph, and
-- `catalog_source` NULL says exactly that — stamping them 'seed' now would claim a
-- provenance nobody recorded at the time. The first live refresh stamps what it
-- actually read.
--
-- PRODUCT SEPARATION. Long-Term only: one `lt_*` table, no RTL table named.
-- ============================================================================

ALTER TABLE lt_encompass_milestones ADD COLUMN IF NOT EXISTS catalog_synced_at timestamptz;
ALTER TABLE lt_encompass_milestones ADD COLUMN IF NOT EXISTS catalog_source text;


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
