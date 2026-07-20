-- ============================================================================
-- 171 - Close an E2 fail-open: a FATAL bureau alert (fraud / OFAC / deceased /
--       SSN / address) on a REVIEW-status report escaped the sign-off gate.
--       (Audit finding, 2026-07-19.)
--
-- db/189's gate (like db/187) only looked at the latest `status='imported'`
-- report. That was correct when the ONLY finding was fico_mismatch (computed only
-- on imported reports). But E2 surfaces the bureau's own alerts on ANY outcome,
-- so a first pull that returns a frozen bureau (→ status='review') PLUS a fatal
-- DECEASED/OFAC alert would store that fatal finding on a 'review' row — which the
-- 'imported'-only gate never saw. A non-admin could then complete the credit
-- condition with an active, unreconciled compliance finding: a fail-open.
--
-- Fix: the gate now consults TWO reference reports and blocks if EITHER carries an
-- active fatal finding:
--   (a) the latest IMPORTED-OR-REVIEW report  → catches a fatal alert on a review
--       pull (the hole above);
--   (b) the latest IMPORTED report            → so a NULL-finding review re-pull
--       cannot MASK an earlier imported fatal finding. A clean IMPORTED re-pull IS
--       a real re-verification and still supersedes/clears (it becomes both (a)
--       and (b), and its NULL finding clears the gate).
-- A failed / in_doubt / ordering re-pull (not a real result, NULL finding) is
-- excluded from both, so it can never mask a finding — same guarantee as before.
--
-- Kept in lock-step with the app-layer signOffGate (src/routes/staff.js), which
-- reads the same two reports via underwriting.activeFatalFindings. Idempotent.
-- ============================================================================

-- The active-fatal-finding count for ONE report's stored finding, handling BOTH
-- the E2 wrapper {findings:[...]} and the pre-E2 single-finding shape, and the
-- whole-report reconcile flag. Pure/IMMUTABLE — the single source of truth the
-- gate + backfill share (mirrors underwriting.activeFatalFindings in JS).
CREATE OR REPLACE FUNCTION credit_active_fatal_count(v_finding jsonb, v_reconciled timestamptz)
RETURNS int AS $$
BEGIN
  IF v_reconciled IS NOT NULL THEN RETURN 0; END IF;          -- whole-report reconcile clears all
  IF v_finding IS NULL OR jsonb_typeof(v_finding) <> 'object' THEN RETURN 0; END IF;
  IF jsonb_typeof(v_finding->'findings') = 'array' THEN
    RETURN (SELECT count(*)::int FROM jsonb_array_elements(v_finding->'findings') e
             WHERE e->>'severity' = 'fatal'
               AND COALESCE((e->>'reconciled')::boolean, false) = false);
  END IF;
  RETURN CASE WHEN (v_finding->>'severity') = 'fatal' THEN 1 ELSE 0 END;   -- legacy single finding
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION credit_finding_gate() RETURNS trigger AS $$
DECLARE
  tmpl_code text;
  is_credit boolean;
  fr jsonb; rr timestamptz;   -- latest imported-OR-review report
  fi jsonb; ri timestamptz;   -- latest imported report
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

  SELECT underwriting_finding, underwriting_finding_reconciled_at INTO fr, rr
    FROM credit_reports
   WHERE application_id = NEW.application_id AND status IN ('imported', 'review')
   ORDER BY created_at DESC, id DESC
   LIMIT 1;

  SELECT underwriting_finding, underwriting_finding_reconciled_at INTO fi, ri
    FROM credit_reports
   WHERE application_id = NEW.application_id AND status = 'imported'
   ORDER BY created_at DESC, id DESC
   LIMIT 1;

  IF credit_active_fatal_count(fr, rr) + credit_active_fatal_count(fi, ri) > 0 THEN
    RAISE EXCEPTION 'Credit condition cannot be completed: the latest credit report has an unresolved fatal underwriting finding. Correct the file and re-pull, or have an underwriter reconcile the finding, first.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger re-assert (idempotent; unchanged definition).
DROP TRIGGER IF EXISTS trg_credit_finding_gate ON checklist_items;
CREATE TRIGGER trg_credit_finding_gate
  BEFORE INSERT OR UPDATE ON checklist_items
  FOR EACH ROW
  EXECUTE FUNCTION credit_finding_gate();

-- ---------------------------------------------------------------------------
-- Safe, idempotent backfill (previous AND future files) with the corrected
-- two-report predicate. Reopen ONLY credit conditions that are 'satisfied' but
-- were never actually signed off (signed_off_at IS NULL) whose file now has an
-- active fatal finding under the fixed rule — catches any file that got a fatal
-- alert finding on a review report before this fix. A genuinely signed-off
-- condition on a funded/closed file is left alone.
UPDATE checklist_items ci
   SET status = 'issue', updated_at = now()
  FROM applications a
 WHERE ci.application_id = a.id
   AND a.deleted_at IS NULL
   AND ci.status = 'satisfied'
   AND ci.signed_off_at IS NULL
   AND COALESCE((SELECT code FROM checklist_templates t WHERE t.id = ci.template_id), '')
       IN ('rtl_cond_credit', 'rtl_p3_credit', 'rtl_p3_credit2')
   AND (
     COALESCE((SELECT credit_active_fatal_count(cr.underwriting_finding, cr.underwriting_finding_reconciled_at)
                 FROM credit_reports cr
                WHERE cr.application_id = a.id AND cr.status IN ('imported', 'review')
                ORDER BY cr.created_at DESC, cr.id DESC LIMIT 1), 0)
   + COALESCE((SELECT credit_active_fatal_count(cr.underwriting_finding, cr.underwriting_finding_reconciled_at)
                 FROM credit_reports cr
                WHERE cr.application_id = a.id AND cr.status = 'imported'
                ORDER BY cr.created_at DESC, cr.id DESC LIMIT 1), 0)
   ) > 0;
