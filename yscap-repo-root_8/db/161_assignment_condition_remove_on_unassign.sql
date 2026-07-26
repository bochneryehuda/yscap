-- 161 — Remove the Assignment-of-Contract condition when a file is NOT (or is no
-- longer) an assignment (owner-directed 2026-07-20: "make sure that condition
-- only populates if it's an assignment of contract").
--
-- db/077 created the rtl_p5_assign condition whenever a file IS/BECOMES an
-- assignment, but it never REMOVED the condition when a file switched back to a
-- non-assignment (an officer ticking "assignment" by mistake, a ClickUp flip
-- clearing it, etc.), so the condition lingered on files that aren't assignments.
-- This adds the mirror branch to the trigger — delete the now-irrelevant
-- condition when is_assignment is not true — and backfills the removal for
-- existing non-assignment files. Deleting the item is safe: documents.
-- checklist_item_id is ON DELETE SET NULL, so any attached doc is unlinked, not
-- destroyed. Idempotent.

CREATE OR REPLACE FUNCTION ensure_assignment_condition() RETURNS trigger AS $$
DECLARE
  econ_changed boolean;
BEGIN
  -- Only touch files that already have a materialized checklist.
  IF NOT EXISTS (SELECT 1 FROM checklist_items WHERE application_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  econ_changed := (TG_OP = 'INSERT')
    OR (OLD.is_assignment IS DISTINCT FROM NEW.is_assignment)
    OR (OLD.assignment_fee IS DISTINCT FROM NEW.assignment_fee)
    OR (OLD.underlying_contract_price IS DISTINCT FROM NEW.underlying_contract_price);

  IF NEW.is_assignment IS TRUE AND econ_changed THEN
    -- (a) create the condition if the file doesn't already carry it.
    INSERT INTO checklist_items
      (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
       phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
       clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id)
    SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
           COALESCE(t.role_scope,'any'), t.phase, t.hint, t.borrower_hint,
           COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
           COALESCE(t.sort_order, 500), t.tool_key, t.clickup_field_id,
           COALESCE(t.tpr_exclude,false), 'system',
           COALESCE(t.is_required,true), NEW.id
      FROM checklist_templates t
     WHERE t.code = 'rtl_p5_assign' AND t.is_active = true
       AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                        WHERE ci.application_id = NEW.id AND ci.template_id = t.id);

    -- (b) reopen it (clear sign-off) if it was already cleared and the
    -- assignment economics just changed — a new assignment amount must be
    -- re-verified with a fresh assignment contract.
    IF (TG_OP = 'UPDATE') THEN
      UPDATE checklist_items ci
         SET status = CASE WHEN ci.status = 'satisfied' THEN 'received' ELSE ci.status END,
             signed_off_at = NULL, signed_off_by = NULL,
             reviewed_at = NULL, reviewed_by = NULL,
             notes = CASE WHEN COALESCE(ci.notes,'') = '' THEN '[auto] Assignment terms changed — re-verify the assignment contract.'
                          ELSE ci.notes END,
             updated_at = now()
        FROM checklist_templates t
       WHERE ci.application_id = NEW.id AND ci.template_id = t.id AND t.code = 'rtl_p5_assign'
         AND (ci.signed_off_at IS NOT NULL OR ci.status = 'satisfied');
    END IF;
  ELSIF NEW.is_assignment IS NOT TRUE AND econ_changed THEN
    -- The file is NOT (or is no longer) an assignment: remove the now-irrelevant
    -- assignment condition so it only ever appears on assignment files.
    DELETE FROM checklist_items ci
      USING checklist_templates t
     WHERE ci.application_id = NEW.id AND ci.template_id = t.id
       AND t.code = 'rtl_p5_assign';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ensure_assignment_condition ON applications;
CREATE TRIGGER trg_ensure_assignment_condition
  AFTER INSERT OR UPDATE OF is_assignment, assignment_fee, underlying_contract_price ON applications
  FOR EACH ROW EXECUTE FUNCTION ensure_assignment_condition();

-- Backfill: remove the assignment condition from existing NON-assignment files
-- that wrongly carry it (created before this mirror branch existed).
DELETE FROM checklist_items ci
  USING checklist_templates t, applications a
 WHERE ci.template_id = t.id AND t.code = 'rtl_p5_assign'
   AND ci.application_id = a.id
   AND a.is_assignment IS NOT TRUE;
