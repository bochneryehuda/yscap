-- ============================================================================
-- 156 - Credit FICO-mismatch finding: reconcile flag + sign-off gate backstop
--       (owner-directed: "make a fatal Underwriting review finding if the FICO
--        doesn't match" — this makes that finding a HARD gate on completing the
--        credit condition, not just a banner).
--
-- When a credit report is imported and the VERIFIED representative FICO lands in
-- a DIFFERENT pricing bracket than the CLAIMED score the loan was structured on,
-- import.js records a fatal `underwriting_finding` on the credit_reports row AND
-- forces the credit condition to 'issue'. This migration makes that finding
-- block COMPLETION of the credit condition until a human resolves it — either by
-- correcting the file and re-pulling (a fresh, matching report clears the finding
-- because the gate reads the LATEST report), or by an underwriter explicitly
-- RECONCILING the finding (a documented exception).
--
-- Two layers, exactly like the SOW budget guard (db/069):
--   1. The application layer enforces it at sign-off (src/routes/staff.js
--      `signOffGate` returns a 422 with a plain-language reason).
--   2. This DB trigger refuses the write as a last line of defense, so the
--      condition can never be flipped to 'satisfied' by ANY path (a future
--      endpoint, a bulk update, a direct SQL write) while the latest report
--      carries an unreconciled fatal finding.
--
-- Applies to PREVIOUS and FUTURE files alike (the trigger fires on every future
-- write regardless of file age). Rows at rest are untouched — a file with no
-- credit report, or whose latest report has no finding, is never affected.
-- ============================================================================

ALTER TABLE credit_reports ADD COLUMN IF NOT EXISTS underwriting_finding_reconciled_at   timestamptz;
ALTER TABLE credit_reports ADD COLUMN IF NOT EXISTS underwriting_finding_reconciled_by   uuid;
ALTER TABLE credit_reports ADD COLUMN IF NOT EXISTS underwriting_finding_reconcile_note  text;

CREATE OR REPLACE FUNCTION credit_finding_gate() RETURNS trigger AS $$
DECLARE
  tmpl_code    text;
  is_credit    boolean;
  v_finding    jsonb;
  v_reconciled timestamptz;
BEGIN
  -- Only ever gate the COMPLETION state of a condition.
  IF NEW.status IS DISTINCT FROM 'satisfied' THEN
    RETURN NEW;
  END IF;

  -- Only gate a credit condition. COALESCE is essential (see db/069): most
  -- conditions have a NULL template code, and `code IN (...)` on a NULL yields
  -- NULL, so without the coalesce a NULL-code row would fall through the NOT and
  -- wrongly be treated as a credit condition. Coerce to '' so is_credit is a real
  -- boolean.
  SELECT code INTO tmpl_code FROM checklist_templates WHERE id = NEW.template_id;
  is_credit := COALESCE(tmpl_code, '') IN ('rtl_cond_credit', 'rtl_p3_credit', 'rtl_p3_credit2');
  IF NOT is_credit THEN
    RETURN NEW;
  END IF;

  -- Never re-block a row that is ALREADY satisfied — an unrelated later touch
  -- (a note, an assignee change, a review stamp) on a completed credit condition
  -- must not become a landmine. Only a FRESH transition into satisfied is gated.
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM 'satisfied' THEN
    RETURN NEW;
  END IF;

  IF NEW.application_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- The LATEST credit report is the current truth; a finding on a superseded,
  -- older report does not block (a clean re-pull clears the gate).
  SELECT underwriting_finding, underwriting_finding_reconciled_at
    INTO v_finding, v_reconciled
    FROM credit_reports
   WHERE application_id = NEW.application_id
   -- `id DESC` tiebreaker: this trigger and the app-layer gate (signOffGate) must
   -- resolve the SAME "latest report" even on a same-timestamp tie, or the two
   -- layers could disagree (one allows the sign-off, the other raises).
   ORDER BY created_at DESC, id DESC
   LIMIT 1;

  IF v_finding IS NOT NULL
     AND jsonb_typeof(v_finding) = 'object'
     AND (v_finding->>'severity') = 'fatal'
     AND v_reconciled IS NULL THEN
    RAISE EXCEPTION 'Credit condition cannot be completed: the latest credit report has an unresolved fatal FICO-mismatch finding (verified % vs claimed %). Correct the file and re-pull, or have an underwriter reconcile the finding, first.',
      COALESCE(v_finding->>'verified', '?'), COALESCE(v_finding->>'claimed', '?')
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
-- Safe, idempotent backfill (previous files). Reopen ONLY credit conditions
-- that are 'satisfied' but were never actually signed off (signed_off_at IS
-- NULL) AND whose file's latest credit report carries an unreconciled fatal
-- finding — an anomalous state a real, signed-off completion never reaches. A
-- genuinely signed-off credit condition on a funded/closed file is left alone
-- (reopening it would corrupt a completed loan's audit trail); going forward the
-- trigger + `signOffGate` enforce the match for previous and future files alike.
UPDATE checklist_items ci
   SET status = 'issue', updated_at = now()
  FROM applications a
 WHERE ci.application_id = a.id
   AND a.deleted_at IS NULL
   AND ci.status = 'satisfied'
   AND ci.signed_off_at IS NULL
   AND COALESCE((SELECT code FROM checklist_templates t WHERE t.id = ci.template_id), '')
       IN ('rtl_cond_credit', 'rtl_p3_credit', 'rtl_p3_credit2')
   -- The file's LATEST credit report has an unreconciled fatal finding. A scalar
   -- subquery over the newest report row returns true/false; no report at all
   -- yields NULL, which excludes the row (nothing to reopen).
   AND (
     SELECT cr.underwriting_finding IS NOT NULL
            AND jsonb_typeof(cr.underwriting_finding) = 'object'
            AND (cr.underwriting_finding->>'severity') = 'fatal'
            AND cr.underwriting_finding_reconciled_at IS NULL
       FROM credit_reports cr
      WHERE cr.application_id = a.id
      ORDER BY cr.created_at DESC, cr.id DESC
      LIMIT 1
   );
