-- ============================================================================
-- 179 — Document-underwriting-review clear-to-close guard (belt-and-suspenders).
--
-- The `underwriting_review_cleared` condition is the clear-to-close gate for the
-- PILOT document-underwriting engine (db/183): it may ONLY be marked 'satisfied'
-- when NO fatal PILOT document finding (blocks_ctc=true) is still open. The
-- application layer enforces this at sign-off (src/routes/staff.js `signOffGate`,
-- the isUnderwritingReview branch, which ALSO folds in the derived tie-out
-- fatals). This migration adds the DATABASE-LEVEL backstop db/183's header
-- promised, so the condition can never be flipped to 'satisfied' with an open
-- fatal document finding by ANY path. Mirrors the appraisal guard (db/154).
--
-- The trigger checks the STORED fatals (document_findings); the derived tie-out
-- fatals can only be evaluated in the app layer (they have no row), so the app
-- gate is the complete check and this is the structural backstop for stored
-- fatals. Applies to previous AND future files; only a transition INTO
-- 'satisfied' is checked.
-- ============================================================================

CREATE OR REPLACE FUNCTION underwriting_review_guard() RETURNS trigger AS $$
DECLARE
  tmpl_code  text;
  open_fatal int;
BEGIN
  IF NEW.status IS DISTINCT FROM 'satisfied' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM 'satisfied' THEN
    RETURN NEW;
  END IF;

  -- COALESCE is essential (most conditions have a NULL template code; `<>` NULL
  -- is NULL, which would fall through) — mirrors the appraisal/SOW guards.
  SELECT code INTO tmpl_code FROM checklist_templates WHERE id = NEW.template_id;
  IF COALESCE(tmpl_code, '') <> 'underwriting_review_cleared' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO open_fatal
    FROM document_findings
   WHERE application_id = NEW.application_id
     AND status = 'open' AND severity = 'fatal' AND blocks_ctc = true;

  IF open_fatal > 0 THEN
    RAISE EXCEPTION 'underwriting_review_cleared cannot be satisfied while % open fatal PILOT document finding(s) remain', open_fatal
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_underwriting_review_guard ON checklist_items;
CREATE TRIGGER trg_underwriting_review_guard
  BEFORE INSERT OR UPDATE ON checklist_items
  FOR EACH ROW EXECUTE FUNCTION underwriting_review_guard();
