-- ============================================================================
-- db/640 — report definitions
--
-- THE REPORTING DATABASE (owner-directed 2026-08-28): "We need to work on a
-- reporting database that I can go in like an Encompass ... where I can select
-- the fields I want, filter which files should be included, save the report
-- that you're building to be able to use it again, and export to excel.
-- Massive reporting database available for the admin super admin back office."
--
-- This table stores the SAVED REPORTS only. The field dictionary, the filter
-- grammar (field / operator / value rows, AND-combined, per-type operator
-- whitelist, every value bound) and the runner live in src/lib/reporting.js —
-- the Encompass Reporting Database model: a curated field catalog over the
-- loan pipeline, never raw SQL from a client. `definition` is the saved shape
-- {filters:[{field,op,value}], columns:[key], sort:{field,dir}} exactly as the
-- builder posts it; it is RE-VALIDATED against the catalog on every run, so a
-- stale saved report referencing a removed field degrades to a plain error,
-- never to an unchecked query.
--
-- BACKFILL: none — a brand-new feature with no prior rows to migrate.
-- ============================================================================

CREATE TABLE IF NOT EXISTS report_definitions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  -- who saved it; reports are shared across the admin back office (any admin
  -- may run/edit any saved report — the owner asked for a shared desk), the
  -- owner column is attribution, not a visibility scope.
  created_by  uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  updated_by  uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  definition  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS report_definitions_created_by_idx ON report_definitions (created_by);


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself.
