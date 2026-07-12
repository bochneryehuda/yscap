-- ============================================================================
-- 072 - Broaden the reopen trigger: the Products & Pricing condition must reopen
--       on ANY change to the deal economics, not only the rehab budget
--       (owner-directed 2026-07-12).
--
-- If any number that feeds the loan structure changes — loan amount, purchase
-- price, as-is value, ARV, rehab budget, program, loan type, property type,
-- units, interest-reserve months, assignment split, or requested experience —
-- the registered product was priced off stale inputs, so the product_pricing
-- condition reopens (clearing any sign-off) and must be re-registered.
--
-- The Scope-of-Work (rehab_budget) condition still reopens ONLY when the
-- construction budget itself changes (it is tied to the construction total).
--
-- Replaces the db/071 trigger function (still named trg_reopen_on_budget_change),
-- now firing AFTER UPDATE on any column and checking the economics inside.
-- Reopens only conditions that had been cleared (no churn); a same-value write
-- never fires anything (IS DISTINCT FROM).
-- ============================================================================

CREATE OR REPLACE FUNCTION reopen_conditions_on_budget_change() RETURNS trigger AS $$
DECLARE
  budget_changed  boolean;
  pricing_changed boolean;
BEGIN
  budget_changed := NEW.rehab_budget IS DISTINCT FROM OLD.rehab_budget;

  -- Any deal-economics input that the pricing engine consumes. Changing any of
  -- these invalidates the registered structure.
  pricing_changed := budget_changed
    OR NEW.loan_amount               IS DISTINCT FROM OLD.loan_amount
    OR NEW.purchase_price            IS DISTINCT FROM OLD.purchase_price
    OR NEW.as_is_value               IS DISTINCT FROM OLD.as_is_value
    OR NEW.arv                       IS DISTINCT FROM OLD.arv
    OR NEW.loan_type                 IS DISTINCT FROM OLD.loan_type
    OR NEW.program                   IS DISTINCT FROM OLD.program
    OR NEW.property_type             IS DISTINCT FROM OLD.property_type
    OR NEW.units                     IS DISTINCT FROM OLD.units
    OR NEW.requested_ir_months       IS DISTINCT FROM OLD.requested_ir_months
    OR NEW.is_assignment             IS DISTINCT FROM OLD.is_assignment
    OR NEW.underlying_contract_price IS DISTINCT FROM OLD.underlying_contract_price
    OR NEW.assignment_fee            IS DISTINCT FROM OLD.assignment_fee
    OR NEW.requested_exp_flips       IS DISTINCT FROM OLD.requested_exp_flips
    OR NEW.requested_exp_holds       IS DISTINCT FROM OLD.requested_exp_holds
    OR NEW.requested_exp_ground      IS DISTINCT FROM OLD.requested_exp_ground;

  IF pricing_changed THEN
    -- Product & Pricing: the registered product is now priced off stale inputs —
    -- reopen for re-registration (only when it had been cleared / signed off).
    UPDATE checklist_items
       SET status = 'received', signed_off_at = NULL, signed_off_by = NULL,
           reviewed_at = NULL, reviewed_by = NULL,
           notes = CASE WHEN notes IS NULL OR notes LIKE '[auto]%'
                        THEN '[auto] The deal economics changed — re-register the product in Products & Pricing so the structure and loan amount match the new numbers.'
                        ELSE notes END,
           updated_at = now()
     WHERE application_id = NEW.id
       AND tool_key = 'product_pricing'
       AND (status = 'satisfied' OR signed_off_at IS NOT NULL);
  END IF;

  IF budget_changed THEN
    -- Scope of Work: tied to the construction budget — reopen only on a budget
    -- change so it is rewritten to total the new budget exactly.
    UPDATE checklist_items
       SET status = 'issue', signed_off_at = NULL, signed_off_by = NULL,
           reviewed_at = NULL, reviewed_by = NULL,
           notes = CASE WHEN notes IS NULL OR notes LIKE '[auto]%'
                        THEN '[auto] The construction budget changed — update the Scope of Work so it totals the new budget exactly before this condition can be signed off.'
                        ELSE notes END,
           updated_at = now()
     WHERE application_id = NEW.id
       AND tool_key = 'rehab_budget'
       AND (status IN ('satisfied', 'received') OR signed_off_at IS NOT NULL);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Re-point the trigger to fire on any column update (the function decides).
DROP TRIGGER IF EXISTS trg_reopen_on_budget_change ON applications;
CREATE TRIGGER trg_reopen_on_budget_change
  AFTER UPDATE ON applications
  FOR EACH ROW
  EXECUTE FUNCTION reopen_conditions_on_budget_change();
