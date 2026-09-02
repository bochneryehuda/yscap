-- ============================================================================
-- db/671 — workflow track record review submission type
--
-- WHAT THIS CHANGES, AND WHY. The processor's workflow gains a fifth hand-off:
-- TRACK RECORD REVIEW (owner-directed 2026-09-01: "we need to add another action
-- which would be track record review submission and she should have a separate
-- tab for which files she needs to review the track record"). A hand-off is a
-- workflow_items row, and the allow-list on submission_type (db/212, widened by
-- db/296 and db/299) must name the new kind or the submit refuses it.
--
-- IDEMPOTENT: the same replace pattern db/296 and db/299 use — the stably-named
-- constraint is dropped once when it lacks the new value and re-created naming
-- EVERY value the earlier files added, so whichever file replays last agrees.
--
-- BACKFILL: none — nothing existed to be of this kind.
--
-- PRODUCT SEPARATION: RTL only (workflow_items is an RTL table).
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_workflow_submission_type')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_workflow_submission_type'
          AND pg_get_constraintdef(oid) LIKE '%track_record_review%') THEN
    ALTER TABLE workflow_items DROP CONSTRAINT chk_workflow_submission_type;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_workflow_submission_type') THEN
    ALTER TABLE workflow_items ADD CONSTRAINT chk_workflow_submission_type CHECK (submission_type IN (
      'loan_setup','processing','condition_clearing','clear_to_close',
      'closing','draw_setup','post_closing','exception','escalation',
      'trustpoint_import','trinity_inspection_order','track_record_review'));
  END IF;
END $$;
