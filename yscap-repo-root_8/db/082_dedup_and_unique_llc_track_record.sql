-- ============================================================================
-- 082_dedup_and_unique_llc_track_record.sql
--
-- Close the concurrent double-create gap for LLCs and auto track records. The
-- ingest upserts (src/clickup/ingest.js upsertLlc / upsertTrackRecord) are
-- check-then-insert; when the reconcile sweep and a live webhook process the SAME
-- file at the same instant, both can pass the SELECT and both INSERT, producing a
-- duplicate LLC / track-record row (there was no DB rule forbidding it). This adds
-- the rule:
--   * one LLC per (borrower_id, lower(btrim(llc_name)))
--   * one auto track record per source_task_id
-- The application code additionally handles the unique-violation gracefully
-- (re-select the winner) so a lost race is a no-op, not an error.
--
-- Because a UNIQUE index can't be created while duplicates exist, this first
-- COLLAPSES any existing duplicates onto a keeper (verified first, then oldest),
-- RE-POINTING every reference so nothing is lost, and only then creates the index
-- (guarded: skipped if any group is somehow still not unique, so it can never fail
-- the boot). The whole thing runs inside ONE DO block with an EXCEPTION handler:
-- any error rolls the block back and downgrades to a WARNING — migrate-boot then
-- continues, and the code's graceful unique-violation path still prevents new
-- duplicates on the next attempt. Fully idempotent; safe to re-run every boot.
-- ============================================================================

DO $$
DECLARE
  v_llc_dupe_groups int;
  v_tr_dupe_groups  int;
BEGIN
  -- ===== LLCs: collapse duplicates onto a keeper =====================
  -- Keeper per (borrower_id, lower(btrim(llc_name))): verified first, then oldest.
  -- Re-point the SET NULL data references so a file/history keeps its entity.
  WITH map AS (
    SELECT id AS dup_id, first_value(id) OVER w AS keep_id
      FROM llcs
      WINDOW w AS (PARTITION BY borrower_id, lower(btrim(llc_name)) ORDER BY is_verified DESC, created_at, id)
  )
  UPDATE applications a SET llc_id = m.keep_id FROM map m WHERE a.llc_id = m.dup_id AND m.dup_id <> m.keep_id;

  WITH map AS (
    SELECT id AS dup_id, first_value(id) OVER w AS keep_id
      FROM llcs
      WINDOW w AS (PARTITION BY borrower_id, lower(btrim(llc_name)) ORDER BY is_verified DESC, created_at, id)
  )
  UPDATE track_records t SET llc_id = m.keep_id FROM map m WHERE t.llc_id = m.dup_id AND m.dup_id <> m.keep_id;

  WITH map AS (
    SELECT id AS dup_id, first_value(id) OVER w AS keep_id
      FROM llcs
      WINDOW w AS (PARTITION BY borrower_id, lower(btrim(llc_name)) ORDER BY is_verified DESC, created_at, id)
  )
  UPDATE clickup_task_index c SET llc_id = m.keep_id FROM map m WHERE c.llc_id = m.dup_id AND m.dup_id <> m.keep_id;

  -- Documents carry a denormalized llc_id (ON DELETE CASCADE) — re-point so real
  -- uploads survive the loser's deletion.
  WITH map AS (
    SELECT id AS dup_id, first_value(id) OVER w AS keep_id
      FROM llcs
      WINDOW w AS (PARTITION BY borrower_id, lower(btrim(llc_name)) ORDER BY is_verified DESC, created_at, id)
  )
  UPDATE documents d SET llc_id = m.keep_id FROM map m WHERE d.llc_id = m.dup_id AND m.dup_id <> m.keep_id;

  -- LLC members (ownership structure) — re-point onto the keeper.
  WITH map AS (
    SELECT id AS dup_id, first_value(id) OVER w AS keep_id
      FROM llcs
      WINDOW w AS (PARTITION BY borrower_id, lower(btrim(llc_name)) ORDER BY is_verified DESC, created_at, id)
  )
  UPDATE llc_members mem SET llc_id = m.keep_id FROM map m WHERE mem.llc_id = m.dup_id AND m.dup_id <> m.keep_id;

  -- llc_borrowers PK is (llc_id, borrower_id): drop the loser's rows that would
  -- collide with the keeper, then re-point the rest.
  WITH map AS (
    SELECT id AS dup_id, first_value(id) OVER w AS keep_id
      FROM llcs
      WINDOW w AS (PARTITION BY borrower_id, lower(btrim(llc_name)) ORDER BY is_verified DESC, created_at, id)
  )
  DELETE FROM llc_borrowers lb USING map m
   WHERE lb.llc_id = m.dup_id AND m.dup_id <> m.keep_id
     AND EXISTS (SELECT 1 FROM llc_borrowers k WHERE k.llc_id = m.keep_id AND k.borrower_id = lb.borrower_id);
  WITH map AS (
    SELECT id AS dup_id, first_value(id) OVER w AS keep_id
      FROM llcs
      WINDOW w AS (PARTITION BY borrower_id, lower(btrim(llc_name)) ORDER BY is_verified DESC, created_at, id)
  )
  UPDATE llc_borrowers lb SET llc_id = m.keep_id FROM map m WHERE lb.llc_id = m.dup_id AND m.dup_id <> m.keep_id;

  -- The loser's LLC-scoped checklist items are redundant (the keeper has its own
  -- set). Delete them; documents.checklist_item_id is ON DELETE SET NULL, so any
  -- attached upload survives (and its llc_id was already re-pointed to the keeper).
  WITH map AS (
    SELECT id AS dup_id, first_value(id) OVER w AS keep_id
      FROM llcs
      WINDOW w AS (PARTITION BY borrower_id, lower(btrim(llc_name)) ORDER BY is_verified DESC, created_at, id)
  )
  DELETE FROM checklist_items ci USING map m WHERE ci.llc_id = m.dup_id AND m.dup_id <> m.keep_id;

  -- Losers now have no references → delete them.
  WITH map AS (
    SELECT id AS dup_id, first_value(id) OVER w AS keep_id
      FROM llcs
      WINDOW w AS (PARTITION BY borrower_id, lower(btrim(llc_name)) ORDER BY is_verified DESC, created_at, id)
  )
  DELETE FROM llcs l USING map m WHERE l.id = m.dup_id AND m.dup_id <> m.keep_id;

  -- Create the uniqueness rule only if clean (self-guard: never error the boot).
  SELECT count(*) INTO v_llc_dupe_groups FROM (
    SELECT 1 FROM llcs GROUP BY borrower_id, lower(btrim(llc_name)) HAVING count(*) > 1) g;
  IF v_llc_dupe_groups = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_llcs_borrower_name ON llcs (borrower_id, lower(btrim(llc_name)));
  ELSE
    RAISE WARNING '082: % LLC duplicate group(s) remain; skipped uq_llcs_borrower_name', v_llc_dupe_groups;
  END IF;

  -- ===== track_records: one auto record per source_task_id ============
  -- Keeper: verified first, then oldest. Re-point the CASCADE document reference,
  -- then delete losers.
  WITH map AS (
    SELECT id AS dup_id, first_value(id) OVER w AS keep_id
      FROM track_records WHERE source_task_id IS NOT NULL
      WINDOW w AS (PARTITION BY source_task_id ORDER BY is_verified DESC, created_at, id)
  )
  UPDATE documents d SET track_record_id = m.keep_id FROM map m WHERE d.track_record_id = m.dup_id AND m.dup_id <> m.keep_id;

  WITH map AS (
    SELECT id AS dup_id, first_value(id) OVER w AS keep_id
      FROM track_records WHERE source_task_id IS NOT NULL
      WINDOW w AS (PARTITION BY source_task_id ORDER BY is_verified DESC, created_at, id)
  )
  DELETE FROM track_records t USING map m WHERE t.id = m.dup_id AND m.dup_id <> m.keep_id;

  SELECT count(*) INTO v_tr_dupe_groups FROM (
    SELECT 1 FROM track_records WHERE source_task_id IS NOT NULL GROUP BY source_task_id HAVING count(*) > 1) g;
  IF v_tr_dupe_groups = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_track_records_source_task
      ON track_records (source_task_id) WHERE source_task_id IS NOT NULL;
  ELSE
    RAISE WARNING '082: % track_record source_task_id duplicate group(s) remain; skipped index', v_tr_dupe_groups;
  END IF;

EXCEPTION WHEN OTHERS THEN
  -- Any failure: roll the block back and keep booting. The code-level graceful
  -- unique-violation handling still prevents new duplicates; the index simply
  -- gets created on a later boot once the data is clean.
  RAISE WARNING '082 dedup/unique migration skipped due to error: %', SQLERRM;
END $$;
