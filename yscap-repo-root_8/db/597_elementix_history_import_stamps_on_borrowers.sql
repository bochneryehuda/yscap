-- ============================================================================
-- db/597 — elementix history import stamps on borrowers
--
-- WHAT THIS CHANGES, AND WHY (owner-directed 2026-08-19). The Elementix data a
-- profile build pulls in — the person's companies and their recorded deals —
-- now lands on the BORROWER'S OWN profile too: companies become entities,
-- recorded deals become (unverified) track-record lines. The owner also asked
-- for the back book: every borrower who already has an Elementix profile cached
-- should get the same import without anybody clicking. That sweep needs a
-- durable "already done" mark per borrower, or every boot would re-walk the
-- whole book forever — and a per-row attempts counter, or one unworkable
-- borrower at the head of the queue would be retried every pass for eternity
-- (the same starvation shape the skip-trace sweep and the XML sweep already
-- guard against).
--
-- The columns are STAMPS for the sweep only. The import itself is idempotent
-- (candidates dedupe on their key, entities reuse by name), so a later profile
-- refresh re-imports safely whatever these say.
--
-- BACKFILL: none — NULL means "the sweep has not been here", which is exactly
-- true for every existing row.
--
-- PRODUCT SEPARATION: RTL only. `borrowers` is the shared identity table and
-- these columns are written by RTL's Elementix plane; nothing Long-Term reads
-- or writes them.
-- ============================================================================

ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS elementix_history_imported_at timestamptz;
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS elementix_history_import_attempts integer NOT NULL DEFAULT 0;

-- The sweep's work list: linked to a person, not yet imported, not given up on.
CREATE INDEX IF NOT EXISTS idx_borrowers_elx_import_due
  ON borrowers (created_at)
  WHERE elementix_person_id IS NOT NULL
    AND elementix_history_imported_at IS NULL
    AND elementix_history_import_attempts < 3;

-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
