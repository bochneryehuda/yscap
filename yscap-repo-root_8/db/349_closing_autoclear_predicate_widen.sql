-- 349 — Widen the closing auto-clear backfill to match the RUNTIME rule.
--
-- db/347 keyed on `cw.stage = 'in_purchasing'`, which was the completion marker
-- at the time. The runtime rule is now workflow.maybeFinishClosing:
--
--     fully_reconciled_at IS NOT NULL AND investor_delivery_signed_off_at IS NOT NULL
--
-- ("stuff is reconciled that should go off of the closing workflow EITHER WAY" —
-- table funded means the loan was sold at closing and never reaches purchasing,
-- so a table-funded file is finished WITHOUT ever hitting stage='in_purchasing').
--
-- So db/347's predicate now misses two real shapes, both of which keep a live
-- hand-off stuck in the closer's "up next" list forever:
--   * a legacy file reconciled + investor-delivered that was never advanced to
--     purchasing (nothing advances it automatically — a human pressed the button,
--     and before this work there was no reason to);
--   * a TABLE FUNDED file, which by design never reaches 'in_purchasing' at all.
--
-- This is a NEW file rather than an edit to 347 because migrate-boot.js records a
-- checksum per applied migration and alarms on drift — an edited migration may not
-- re-apply cleanly on a database that already ran it.
--
-- Same guarantees as 347: deterministic, idempotent (re-running matches nothing,
-- because the rows are no longer live), nothing is deleted, and the item is
-- resolved exactly the way a manual send-back does so Workflow history still
-- shows it.

WITH cleared AS (
  UPDATE workflow_items w
     SET status        = 'returned',
         outcome_label = COALESCE(
           w.outcome_label,
           CASE WHEN cw.table_funded
                THEN 'Closing complete — table funded (sold at closing)'
                ELSE 'Closing complete — sent to purchasing' END),
         returned_at   = COALESCE(w.returned_at, now()),
         updated_at    = now()
    FROM closing_workflow cw
   WHERE cw.application_id = w.application_id
     AND cw.fully_reconciled_at IS NOT NULL
     AND cw.investor_delivery_signed_off_at IS NOT NULL
     AND w.submission_type = 'closing'
     AND w.status IN ('open', 'in_progress')
     -- Only hand-offs that PREDATE the completion. Every numbered migration
     -- re-runs on every boot and the closing columns are sticky, so without this
     -- a file that was completed and then legitimately RE-SUBMITTED to closing
     -- would have its NEW live hand-off silently cleared on the next deploy.
     -- Anchor on the earliest moment the file could be called finished.
     -- GREATEST of all three, NOT COALESCE(purchasing_at, ...): purchasing_at is
     -- sticky, so preferring it would freeze the anchor at the first "Send to
     -- purchasing" and a re-submitted file could never clear again. GREATEST
     -- ignores NULLs, so a file that never reached purchasing is unaffected.
     AND w.received_at <= GREATEST(
           cw.purchasing_at, cw.fully_reconciled_at, cw.investor_delivery_signed_off_at)
  RETURNING w.id, w.application_id, w.from_staff_id, w.submission_type, w.outcome_label
)
INSERT INTO workflow_events
  (workflow_item_id, application_id, event_type, actor_staff_id, from_staff_id,
   to_staff_id, submission_type, outcome_label, note)
SELECT c.id, c.application_id, 'returned', NULL, NULL,
       c.from_staff_id, c.submission_type, c.outcome_label,
       'Closed out automatically — this file was already reconciled and delivered.'
  FROM cleared c
 WHERE NOT EXISTS (
   SELECT 1 FROM workflow_events e
    WHERE e.workflow_item_id = c.id AND e.event_type = 'returned'
 );
