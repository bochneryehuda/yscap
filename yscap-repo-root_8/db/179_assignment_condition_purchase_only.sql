-- 173 — The Assignment-of-Contract condition (rtl_p5_assign) may only exist on a
-- PURCHASE. An assignment of contract is definitionally a purchase concept, but
-- is_assignment was never coupled to loan_type: an officer could tick "assignment"
-- and then switch the file to a Refinance (or tick it on a refi directly), and the
-- condition — which is borrower-facing (audience 'both') — kept asking a refinance
-- borrower for an "Assignment letter" and underlying purchase contract.
--
-- The pricing engine already ignores is_assignment on a non-Purchase
-- (pricing.js loanTypeOf → isAssignment only when loanType==='Purchase'), so the
-- damage was purely the spurious borrower-facing condition. This teaches the
-- condition trigger the same rule: rtl_p5_assign exists iff the file IS an
-- assignment AND is a purchase (loan_type does NOT mention "refi", matching
-- loanTypeOf exactly). loan_type is added to the trigger's watched columns so a
-- purchase⇄refinance switch adds/removes the condition immediately. Idempotent;
-- deleting is safe (documents.checklist_item_id is ON DELETE SET NULL).

CREATE OR REPLACE FUNCTION ensure_assignment_condition() RETURNS trigger AS $$
DECLARE
  econ_changed boolean;
  is_assign_purchase boolean;
BEGIN
  -- Only touch files that already have a materialized checklist.
  IF NOT EXISTS (SELECT 1 FROM checklist_items WHERE application_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  -- An assignment condition belongs on the file iff it is flagged as an
  -- assignment AND the loan is a purchase (not a refinance).
  is_assign_purchase := NEW.is_assignment IS TRUE
    AND COALESCE(NEW.loan_type, '') !~* 'refi';

  econ_changed := (TG_OP = 'INSERT')
    OR (OLD.is_assignment IS DISTINCT FROM NEW.is_assignment)
    OR (OLD.assignment_fee IS DISTINCT FROM NEW.assignment_fee)
    OR (OLD.underlying_contract_price IS DISTINCT FROM NEW.underlying_contract_price)
    OR (OLD.loan_type IS DISTINCT FROM NEW.loan_type);

  IF is_assign_purchase AND econ_changed THEN
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

    -- (b) reopen it (clear sign-off) if it was already cleared and the assignment
    -- economics just changed — a new assignment amount must be re-verified with a
    -- fresh assignment contract.
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
  ELSIF (NOT is_assign_purchase) AND econ_changed THEN
    -- Not an assignment purchase (not flagged, or a refinance): remove the
    -- now-irrelevant assignment condition so it only appears on assignment
    -- PURCHASE files.
    DELETE FROM checklist_items ci
      USING checklist_templates t
     WHERE ci.application_id = NEW.id AND ci.template_id = t.id
       AND t.code = 'rtl_p5_assign';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate the trigger so it also fires when loan_type changes.
DROP TRIGGER IF EXISTS trg_ensure_assignment_condition ON applications;
CREATE TRIGGER trg_ensure_assignment_condition
  AFTER INSERT OR UPDATE OF is_assignment, assignment_fee, underlying_contract_price, loan_type ON applications
  FOR EACH ROW EXECUTE FUNCTION ensure_assignment_condition();

-- Backfill: remove the assignment condition from existing REFINANCE files that
-- wrongly carry it (ticked assignment before this coupling existed).
DELETE FROM checklist_items ci
  USING checklist_templates t, applications a
 WHERE ci.template_id = t.id AND t.code = 'rtl_p5_assign'
   AND ci.application_id = a.id
   AND COALESCE(a.loan_type, '') ~* 'refi';
