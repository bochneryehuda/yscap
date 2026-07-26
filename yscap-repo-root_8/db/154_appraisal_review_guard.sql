-- ============================================================================
-- 154 — Appraisal-review clear-to-close guard (belt-and-suspenders).
--
-- The `appraisal_review_cleared` condition is the clear-to-close gate for the
-- PILOT appraisal review: it may ONLY be marked 'satisfied' when NO fatal PILOT
-- appraisal finding (blocks_ctc=true) is still open. The application layer now
-- enforces this at sign-off (src/routes/staff.js `signOffGate`, the
-- isAppraisalReview branch). This migration adds the DATABASE-LEVEL backstop the
-- original design promised (db/137 header) so the condition can never be flipped
-- to 'satisfied' with an open fatal finding by ANY path — a future endpoint, a
-- bulk update, a direct SQL write. Mirrors the SOW budget guard (db/069).
--
-- Applies to previous AND future files. Rows already at rest are untouched; only
-- a future transition INTO 'satisfied' is checked.
-- ============================================================================

CREATE OR REPLACE FUNCTION appraisal_review_guard() RETURNS trigger AS $$
DECLARE
  tmpl_code  text;
  open_fatal int;
BEGIN
  -- Only ever gate the transition INTO the completed state.
  IF NEW.status IS DISTINCT FROM 'satisfied' THEN
    RETURN NEW;
  END IF;
  -- An already-satisfied row being touched for an unrelated reason (notes,
  -- assignee, review stamp) is not a (re)completion — never block that.
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM 'satisfied' THEN
    RETURN NEW;
  END IF;

  -- Only gate the appraisal-review condition. COALESCE is essential: most
  -- conditions have a NULL template code, and `<>` against NULL is NULL (not
  -- true), so without the COALESCE the guard would fall through / misbehave.
  SELECT code INTO tmpl_code FROM checklist_templates WHERE id = NEW.template_id;
  IF COALESCE(tmpl_code, '') <> 'appraisal_review_cleared' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO open_fatal
    FROM appraisal_findings
   WHERE application_id = NEW.application_id
     AND status = 'open' AND severity = 'fatal' AND blocks_ctc = true;

  IF open_fatal > 0 THEN
    RAISE EXCEPTION 'appraisal_review_cleared cannot be satisfied while % open fatal PILOT appraisal finding(s) remain', open_fatal
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_appraisal_review_guard ON checklist_items;
CREATE TRIGGER trg_appraisal_review_guard
  BEFORE INSERT OR UPDATE ON checklist_items
  FOR EACH ROW EXECUTE FUNCTION appraisal_review_guard();
