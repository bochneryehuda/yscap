-- ============================================================================
-- 170 - Generalize the credit-finding sign-off gate from ONE finding to a LIST
--       (owner-directed 2026-07-19, E2: "if there is any fraud alert on the
--        credit report you should alert; high mismatching alerts should go to
--        underwriting to review").
--
-- db/187 added credit_reports.underwriting_finding as a SINGLE finding object
-- {type,severity,...}; db/188 made a fatal one block completion of the credit
-- condition. E2 turns that into a LIST: import.js now stores a BACK-COMPATIBLE
-- WRAPPER
--   { severity:<max active>, types:[...], message:<joined>,
--     findings:[ {type,severity,code,message,reconciled,reconcilableBy,...} ] }
-- so a report can carry a FICO-mismatch AND a fraud alert AND an address
-- discrepancy at once, each independently reconcilable.
--
-- This migration REPLACES the gate function so it blocks on ANY unreconciled
-- FATAL element of findings[] (via jsonb_array_elements), while STILL honoring:
--   * the pre-E2 single-finding shape (a row with a top-level `severity` and no
--     `findings` array) — old rows keep gating exactly as before;
--   * the whole-report reconcile flag underwriting_finding_reconciled_at (set by
--     the reconcile endpoint) which clears EVERYTHING at once, unchanged;
--   * per-finding reconcile: a findings[] element with "reconciled": true no
--     longer blocks (the app layer flips it + recomputes the mirrored top-level
--     severity so signOffGate agrees).
--
-- Two layers as before (app-layer signOffGate 422 + this DB trigger backstop).
-- Same "latest IMPORTED report, id DESC tiebreak" selection as db/188 so the two
-- layers always resolve the SAME report. Idempotent; safe to re-run every boot.
-- ============================================================================

CREATE OR REPLACE FUNCTION credit_finding_gate() RETURNS trigger AS $$
DECLARE
  tmpl_code    text;
  is_credit    boolean;
  v_finding    jsonb;
  v_reconciled timestamptz;
  v_fatal_ct   int;
BEGIN
  -- Only ever gate the COMPLETION state of a condition.
  IF NEW.status IS DISTINCT FROM 'satisfied' THEN
    RETURN NEW;
  END IF;

  -- Only gate a credit condition. COALESCE is essential (see db/069): a NULL
  -- template code with `IN (...)` yields NULL, which would slip past a bare NOT.
  SELECT code INTO tmpl_code FROM checklist_templates WHERE id = NEW.template_id;
  is_credit := COALESCE(tmpl_code, '') IN ('rtl_cond_credit', 'rtl_p3_credit', 'rtl_p3_credit2');
  IF NOT is_credit THEN
    RETURN NEW;
  END IF;

  -- Never re-block a row that is ALREADY satisfied — an unrelated later touch on a
  -- completed credit condition must not become a landmine. Only a FRESH transition
  -- into satisfied is gated.
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM 'satisfied' THEN
    RETURN NEW;
  END IF;

  IF NEW.application_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- The LATEST imported credit report is the current truth. A later failed /
  -- in_doubt / review / ordering re-pull writes a NEWER row with a NULL finding;
  -- the status='imported' filter stops that row from MASKING an earlier imported
  -- report's unreconciled fatal finding. `id DESC` tiebreak keeps this trigger and
  -- the app-layer gate resolving the SAME row on a same-timestamp tie.
  SELECT underwriting_finding, underwriting_finding_reconciled_at
    INTO v_finding, v_reconciled
    FROM credit_reports
   WHERE application_id = NEW.application_id
     AND status = 'imported'
   ORDER BY created_at DESC, id DESC
   LIMIT 1;

  -- A whole-report reconcile clears everything; nothing to gate.
  IF v_reconciled IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF v_finding IS NULL OR jsonb_typeof(v_finding) <> 'object' THEN
    RETURN NEW;
  END IF;

  -- Count the ACTIVE (unreconciled) FATAL findings. New wrapper → iterate
  -- findings[]; pre-E2 single-finding shape → the object itself is the finding.
  IF jsonb_typeof(v_finding->'findings') = 'array' THEN
    SELECT count(*) INTO v_fatal_ct
      FROM jsonb_array_elements(v_finding->'findings') e
     WHERE e->>'severity' = 'fatal'
       AND COALESCE((e->>'reconciled')::boolean, false) = false;
  ELSE
    v_fatal_ct := CASE WHEN (v_finding->>'severity') = 'fatal' THEN 1 ELSE 0 END;
  END IF;

  IF v_fatal_ct > 0 THEN
    RAISE EXCEPTION 'Credit condition cannot be completed: the latest credit report has % unresolved fatal underwriting finding(s). Correct the file and re-pull, or have an underwriter reconcile the finding(s), first.',
      v_fatal_ct
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger definition is unchanged from db/188, but re-assert it idempotently so a
-- fresh DB that somehow applied 170 without 168 still gets the trigger wired.
DROP TRIGGER IF EXISTS trg_credit_finding_gate ON checklist_items;
CREATE TRIGGER trg_credit_finding_gate
  BEFORE INSERT OR UPDATE ON checklist_items
  FOR EACH ROW
  EXECUTE FUNCTION credit_finding_gate();

-- ---------------------------------------------------------------------------
-- Safe, idempotent backfill (previous AND future files). Reopen ONLY credit
-- conditions that are 'satisfied' but were never actually signed off
-- (signed_off_at IS NULL) AND whose file's latest imported credit report carries
-- an active fatal finding under the GENERALIZED predicate (findings[] OR the
-- legacy single-finding shape). A genuinely signed-off credit condition on a
-- funded/closed file is left alone. Mirrors db/188's backfill.
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
     SELECT
       cr.underwriting_finding_reconciled_at IS NULL
       AND cr.underwriting_finding IS NOT NULL
       AND jsonb_typeof(cr.underwriting_finding) = 'object'
       AND (
         CASE WHEN jsonb_typeof(cr.underwriting_finding->'findings') = 'array' THEN
           EXISTS (
             SELECT 1 FROM jsonb_array_elements(cr.underwriting_finding->'findings') e
              WHERE e->>'severity' = 'fatal'
                AND COALESCE((e->>'reconciled')::boolean, false) = false
           )
         ELSE (cr.underwriting_finding->>'severity') = 'fatal'
         END
       )
       FROM credit_reports cr
      WHERE cr.application_id = a.id
        AND cr.status = 'imported'
      ORDER BY cr.created_at DESC, cr.id DESC
      LIMIT 1
   );
