-- 077 — Ensure the Assignment-of-Contract condition whenever an assignment is
-- detected, from ANY side (owner-directed 2026-07-12).
--
-- The 'Assignment contract' condition (template rtl_p5_assign) was only created
-- at checklist-GENERATION time when the file was already an assignment
-- (borrower.js: `if code=rtl_p5_assign AND !isAssignment continue`). So if a file
-- BECOMES an assignment later — a mid-flow application edit, a Products & Pricing
-- registration that priced an assignment, or a ClickUp inbound flip of the
-- "Contract assignment" checkbox — the assignment condition never appeared.
--
-- This adds an AFTER trigger on `applications` so that whenever is_assignment /
-- assignment_fee / underlying_contract_price change (or a row is inserted) and
-- the file IS an assignment, the condition is (a) created if missing, and (b)
-- REOPENED (sign-off cleared) if the assignment economics changed after it was
-- already cleared — mirroring how db/071/072 reopen the pricing condition.
-- Central + all-sides: every write path (borrower, staff, register, ClickUp
-- inbound) goes through the same trigger.

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
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ensure_assignment_condition ON applications;
CREATE TRIGGER trg_ensure_assignment_condition
  AFTER INSERT OR UPDATE OF is_assignment, assignment_fee, underlying_contract_price ON applications
  FOR EACH ROW EXECUTE FUNCTION ensure_assignment_condition();

-- Backfill: existing assignment files that have a checklist but never got the
-- condition (they turned into an assignment before this trigger existed).
INSERT INTO checklist_items
  (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
   phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id)
SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
       COALESCE(t.role_scope,'any'), t.phase, t.hint, t.borrower_hint,
       COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
       COALESCE(t.sort_order, 500), t.tool_key, t.clickup_field_id,
       COALESCE(t.tpr_exclude,false), 'system',
       COALESCE(t.is_required,true), a.id
  FROM applications a
 CROSS JOIN checklist_templates t
 WHERE t.code = 'rtl_p5_assign' AND t.is_active = true
   AND a.deleted_at IS NULL
   AND a.is_assignment IS TRUE
   AND a.status NOT IN ('withdrawn','cancelled')
   AND EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.application_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = a.id AND ci.template_id = t.id);
