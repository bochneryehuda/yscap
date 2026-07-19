-- ============================================================================
-- 155 — Reopen the appraisal-review clear-to-close gate when a NEW fatal PILOT
--       appraisal finding lands (M1, owner audit 2026-07-19).
--
-- db/154 stops `appraisal_review_cleared` from being signed off WHILE an open
-- fatal finding exists. But it does not cover the reverse race: the condition is
-- already 'satisfied' (an officer cleared it), then a re-import of a corrected
-- appraisal — or any new finding write — inserts a NEW open fatal finding. Without
-- this trigger the file would sit clear-to-close with an unresolved fatal
-- collateral finding: the gate has a hole on the way IN.
--
-- Mirrors the economics-change reopen (db/071/072): an AFTER INSERT trigger on
-- appraisal_findings that, when the inserted row is an OPEN, FATAL, blocks_ctc
-- finding, reopens the file's appraisal_review_cleared condition (clearing any
-- sign-off) so the officer must re-clear it. Only touches a condition that had
-- been cleared (no churn); an ordinary open finding on an already-open condition
-- changes nothing.
--
-- Applies to previous AND future files. Idempotent (CREATE OR REPLACE + DROP/CREATE).
-- ============================================================================

CREATE OR REPLACE FUNCTION reopen_appraisal_review_on_fatal() RETURNS trigger AS $$
BEGIN
  -- Only a fresh, open, CTC-blocking fatal finding reopens the gate.
  IF NEW.status IS DISTINCT FROM 'open'
     OR NEW.severity IS DISTINCT FROM 'fatal'
     OR NEW.blocks_ctc IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  UPDATE checklist_items ci
     SET status = 'received', signed_off_at = NULL, signed_off_by = NULL,
         reviewed_at = NULL, reviewed_by = NULL,
         notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%'
                      THEN '[auto] A new blocking appraisal finding was raised — review the appraisal findings and clear them before this can be signed off again.'
                      ELSE ci.notes END,
         updated_at = now()
   FROM checklist_templates t
  WHERE ci.template_id = t.id
    AND t.code = 'appraisal_review_cleared'
    AND ci.application_id = NEW.application_id
    AND (ci.status = 'satisfied' OR ci.signed_off_at IS NOT NULL);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reopen_appraisal_review_on_fatal ON appraisal_findings;
CREATE TRIGGER trg_reopen_appraisal_review_on_fatal
  AFTER INSERT ON appraisal_findings
  FOR EACH ROW EXECUTE FUNCTION reopen_appraisal_review_on_fatal();
