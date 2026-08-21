-- ============================================================================
-- db/598 — track record candidate indexes for the records stamp
--
-- WHAT THIS CHANGES, AND WHY. The records stamp
-- (src/lib/track-record/records-stamp.js) decides "did this line come from the
-- public records?" with an EXISTS over `track_record_candidates`, matching a
-- line on EITHER of two columns:
--
--   (imported_track_record_id = t.id AND status='imported')
--   OR (match_track_record_id = t.id AND status='merged')
--
-- Neither column was indexed, and because the test is an OR of two correlated
-- equalities Postgres cannot fold it into a hashed subplan the way it does the
-- single-equality pillar half — so it re-scanned the whole candidate table once
-- per track-record row. Measured on the test database (870 track records, 827
-- candidates):
--
--   Seq Scan on track_records (rows=870)          Buffers: shared hit=26790
--     SubPlan -> Seq Scan on track_record_candidates (loops=79)  hit=26619
--
-- i.e. essentially all of the work, O(rows x candidates). That runs on the
-- borrower's own track-record list, the staff list, the workspace line load,
-- the TPR investor export, and `html-copy.refreshSavedCopy` — which fires on
-- EVERY track-record write (debounced 4s). Candidates accumulate for the whole
-- organisation and are never pruned, so this gets worse on its own over time.
--
-- Two PARTIAL indexes, each matching one arm of the OR including its status
-- literal, so the planner can satisfy each arm with an index lookup instead of
-- a scan. Partial rather than plain: only the two success verbs can ever stamp
-- a line ('declined' proves nothing about it), so indexing the rest would be
-- dead weight on a table the importer writes to on every search.
--
-- NO BACKFILL, and none is possible or needed: this file adds indexes only. It
-- changes no row, no column, no constraint and no behaviour — the stamp answers
-- exactly what it answered before, faster. Adding an index takes a brief lock
-- on the table; CONCURRENTLY is deliberately NOT used because migrate-boot runs
-- each file as one implicit transaction and CREATE INDEX CONCURRENTLY cannot
-- run inside one.
--
-- PRODUCT SEPARATION. `track_record_candidates` is an RTL table and nothing
-- here touches `lt_*`.
-- ============================================================================

CREATE INDEX IF NOT EXISTS trc_imported_line_idx
  ON track_record_candidates (imported_track_record_id)
  WHERE imported_track_record_id IS NOT NULL AND status = 'imported';

CREATE INDEX IF NOT EXISTS trc_merged_line_idx
  ON track_record_candidates (match_track_record_id)
  WHERE match_track_record_id IS NOT NULL AND status = 'merged';

-- The pillar half of the stamp is a single equality on `track_record_id`, which
-- the planner already hashes; db/494 indexes that table. Nothing to add there.


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
