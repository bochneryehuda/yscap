-- ============================================================================
-- db/582 — workflow item removal + the pipeline Remove button is RETIRED
--
-- Owner-directed 2026-08-18, correcting the 2026-08-11 remove-from-view build
-- (db/522): "The intent when saying remove and put back was on the WORKFLOW,
-- not on the pipeline. Everybody has their workflow: Closing Workflow,
-- Purchasing Workflow, Reconciliation Workflow, Processing Workflow,
-- Underwriting Workflow, Exception Workflow. … For files in the pipeline, the
-- only button that should work is the Archive button and Restore From Archive."
--
-- Two halves:
--
-- 1) The personal WORKFLOW queues (workflow_items — Processing, Underwriting,
--    Exception/Escalation and the rest of the hand-off chain) gain a
--    remove-from-this-workflow marker: a `removed` status plus who/when/why,
--    reversible via restore. Closing and Purchasing already have their own
--    per-desk markers (db/522) and are untouched here; Reconciliation is a
--    stage of the closing desk, so the closing marker covers it.
--
-- 2) The PIPELINE remove is retired. The UI and the route no longer offer it,
--    so any file still hidden by db/522's pipeline marker would become
--    invisible with no button anywhere to bring it back. The markers are
--    therefore CLEARED (each clearance audit-logged first, so who removed the
--    file and why is preserved on the record) — those files reappear on the
--    pipeline, and the recorded way to take one off is now Archive
--    (applications.deleted_at, delete_files capability, restorable from the
--    Archived folder). The db/522 pipeline_removed_* columns are KEPT (never
--    remove a column until nothing depends on it — history + audit detail).
--
-- BACKFILL: half 2 above IS the backfill (clear + audit). Half 1 is go-forward
-- by construction (NULL default; nothing is hidden until a human removes it).
-- ============================================================================

-- ── 1. workflow_items: the removed state ────────────────────────────────────
ALTER TABLE workflow_items ADD COLUMN IF NOT EXISTS removed_at     timestamptz;
ALTER TABLE workflow_items ADD COLUMN IF NOT EXISTS removed_by     uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE workflow_items ADD COLUMN IF NOT EXISTS removed_reason text;

-- Widen the status CHECK IN PLACE under db/212's own (auto-generated) name —
-- the db/527 pattern: db/212 is CREATE TABLE IF NOT EXISTS, so it never
-- re-adds this constraint on replay, and the guard below keeps THIS file from
-- churning a drop/add on every boot.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'workflow_items'::regclass
       AND conname  = 'workflow_items_status_check'
       AND pg_get_constraintdef(oid) NOT LIKE '%removed%'
  ) THEN
    ALTER TABLE workflow_items DROP CONSTRAINT workflow_items_status_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'workflow_items'::regclass
       AND conname  = 'workflow_items_status_check'
  ) THEN
    ALTER TABLE workflow_items ADD CONSTRAINT workflow_items_status_check
      CHECK (status IN ('open','in_progress','returned','cancelled','removed'));
  END IF;
END $$;

-- workflow_events: the two new event kinds, same in-place widening.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'workflow_events'::regclass
       AND conname  = 'workflow_events_event_type_check'
       AND pg_get_constraintdef(oid) NOT LIKE '%restored%'
  ) THEN
    ALTER TABLE workflow_events DROP CONSTRAINT workflow_events_event_type_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'workflow_events'::regclass
       AND conname  = 'workflow_events_event_type_check'
  ) THEN
    ALTER TABLE workflow_events ADD CONSTRAINT workflow_events_event_type_check
      CHECK (event_type IN ('submitted','picked_up','returned','reassigned','cancelled','note','removed','restored'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_wf_removed ON workflow_items(removed_at) WHERE removed_at IS NOT NULL;

-- ── 2. Retire the pipeline remove: audit each hidden file, then surface it ──
-- Idempotent: the WHERE drains the population on the first run; a re-run finds
-- nothing to audit and nothing to clear.
INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
SELECT 'system', NULL, 'pipeline_remove_retired', 'application', a.id,
       jsonb_build_object(
         'removed_at', a.pipeline_removed_at,
         'removed_by', a.pipeline_removed_by,
         'reason',     a.pipeline_removed_reason,
         'note',       'The pipeline Remove button was retired (owner-directed 2026-08-18) — remove/restore lives on the workflows; the pipeline uses Archive. This file was surfaced back onto the pipeline.')
  FROM applications a
 WHERE a.pipeline_removed_at IS NOT NULL;

UPDATE applications
   SET pipeline_removed_at = NULL,
       pipeline_removed_by = NULL,
       pipeline_removed_reason = NULL
 WHERE pipeline_removed_at IS NOT NULL;
