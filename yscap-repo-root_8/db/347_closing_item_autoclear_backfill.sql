-- 347 — Close out the closer's Workflow hand-off for files whose closing is
-- ALREADY COMPLETE (owner-directed 2026-07-26: "once the reconciliation of a
-- file is done and it's marked as completed that file should automatically
-- disappear from the closing workflow").
--
-- Going forward the stage route resolves the hand-off inside the same
-- transaction that moves the file to 'in_purchasing' (workflow.resolveClosingItem).
-- This is the PREVIOUS-files half: a file already handed to purchasing still has
-- a live `workflow_items` row sitting in the closer's "up next" list, because
-- nothing ever resolved it. Clear exactly those.
--
-- Deterministic + idempotent:
--   * only files whose closing stage is 'in_purchasing' (the completed marker),
--   * only LIVE hand-offs (open / in_progress) of submission_type 'closing',
--   * re-running matches nothing (the rows are no longer open), and the event
--     insert is guarded by NOT EXISTS so a second pass can't duplicate history.
-- Nothing is deleted; the item is resolved the same way a manual send-back does,
-- so the Workflow history still shows it.

WITH cleared AS (
  UPDATE workflow_items w
     SET status        = 'returned',
         outcome_label = COALESCE(w.outcome_label, 'Closing complete — sent to purchasing'),
         returned_at   = COALESCE(w.returned_at, now()),
         updated_at    = now()
    FROM closing_workflow cw
   WHERE cw.application_id = w.application_id
     AND cw.stage = 'in_purchasing'
     AND w.submission_type = 'closing'
     AND w.status IN ('open', 'in_progress')
  RETURNING w.id, w.application_id, w.from_staff_id, w.submission_type, w.outcome_label
)
INSERT INTO workflow_events
  (workflow_item_id, application_id, event_type, actor_staff_id, from_staff_id,
   to_staff_id, submission_type, outcome_label, note)
SELECT c.id, c.application_id, 'returned', NULL, NULL,
       c.from_staff_id, c.submission_type, c.outcome_label,
       'Closed out automatically — this file had already been marked complete.'
  FROM cleared c
 WHERE NOT EXISTS (
   SELECT 1 FROM workflow_events e
    WHERE e.workflow_item_id = c.id AND e.event_type = 'returned'
 );
