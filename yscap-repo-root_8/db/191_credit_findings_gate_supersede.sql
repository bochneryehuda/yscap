-- ============================================================================
-- 172 - Harden the credit finding gate against a residual masking edge
--       (audit MINOR, 2026-07-19): an empty REVIEW re-pull could still clear an
--       earlier fatal finding that lived on ANOTHER review report.
--
-- db/190 protected an imported fatal from being masked (via a separate "latest
-- imported" check), but there was no symmetric protection for a fatal on an OLDER
-- review report: review(fatal OFAC) then review(NULL, newer) cleared the gate —
-- a soft clear-path for exactly the compliance-only findings (OFAC / deceased)
-- that otherwise require an admin reconcile.
--
-- General rule (mirrors underwriting.gatingFatalFindings in JS): a fatal finding
-- on ANY imported-or-review report blocks UNLESS it was SUPERSEDED by a LATER
-- CLEAN IMPORTED report (a real re-verification). A review re-pull, or a failed /
-- in_doubt / ordering one, is NOT a re-verification and can never supersede a
-- fatal. So a clean IMPORTED re-pull still clears everything; nothing else does.
--
-- credit_active_fatal_count (db/190) is reused unchanged. Idempotent.
-- ============================================================================

CREATE OR REPLACE FUNCTION credit_finding_gate() RETURNS trigger AS $$
DECLARE
  tmpl_code text;
  is_credit boolean;
  blocked   boolean;
BEGIN
  IF NEW.status IS DISTINCT FROM 'satisfied' THEN
    RETURN NEW;
  END IF;

  SELECT code INTO tmpl_code FROM checklist_templates WHERE id = NEW.template_id;
  is_credit := COALESCE(tmpl_code, '') IN ('rtl_cond_credit', 'rtl_p3_credit', 'rtl_p3_credit2');
  IF NOT is_credit THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM 'satisfied' THEN
    RETURN NEW;
  END IF;

  IF NEW.application_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Block if ANY imported-or-review report carries an active fatal finding that
  -- has NOT been superseded by a later CLEAN IMPORTED report.
  SELECT EXISTS (
    SELECT 1
      FROM credit_reports rf
     WHERE rf.application_id = NEW.application_id
       AND rf.status IN ('imported', 'review')
       AND credit_active_fatal_count(rf.underwriting_finding, rf.underwriting_finding_reconciled_at) > 0
       AND NOT EXISTS (
         SELECT 1
           FROM credit_reports ri
          WHERE ri.application_id = NEW.application_id
            AND ri.status = 'imported'
            AND (ri.created_at, ri.id) > (rf.created_at, rf.id)
            AND credit_active_fatal_count(ri.underwriting_finding, ri.underwriting_finding_reconciled_at) = 0
       )
  ) INTO blocked;

  IF blocked THEN
    RAISE EXCEPTION 'Credit condition cannot be completed: the latest credit report has an unresolved fatal underwriting finding. Correct the file and re-pull, or have an underwriter reconcile the finding, first.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_credit_finding_gate ON checklist_items;
CREATE TRIGGER trg_credit_finding_gate
  BEFORE INSERT OR UPDATE ON checklist_items
  FOR EACH ROW
  EXECUTE FUNCTION credit_finding_gate();

-- ---------------------------------------------------------------------------
-- Idempotent backfill with the superseding predicate (previous + future files).
-- Reopen ONLY 'satisfied' credit conditions never actually signed off
-- (signed_off_at IS NULL) whose file now has an un-superseded active fatal
-- finding. A genuinely signed-off condition is left alone.
UPDATE checklist_items ci
   SET status = 'issue', updated_at = now()
  FROM applications a
 WHERE ci.application_id = a.id
   AND a.deleted_at IS NULL
   AND ci.status = 'satisfied'
   AND ci.signed_off_at IS NULL
   AND COALESCE((SELECT code FROM checklist_templates t WHERE t.id = ci.template_id), '')
       IN ('rtl_cond_credit', 'rtl_p3_credit', 'rtl_p3_credit2')
   AND EXISTS (
     SELECT 1
       FROM credit_reports rf
      WHERE rf.application_id = a.id
        AND rf.status IN ('imported', 'review')
        AND credit_active_fatal_count(rf.underwriting_finding, rf.underwriting_finding_reconciled_at) > 0
        AND NOT EXISTS (
          SELECT 1 FROM credit_reports ri
           WHERE ri.application_id = a.id
             AND ri.status = 'imported'
             AND (ri.created_at, ri.id) > (rf.created_at, rf.id)
             AND credit_active_fatal_count(ri.underwriting_finding, ri.underwriting_finding_reconciled_at) = 0
        )
   );
