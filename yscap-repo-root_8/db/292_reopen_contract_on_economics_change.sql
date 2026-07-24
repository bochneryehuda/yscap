-- Reopen an AUTO-CLEARED purchase-contract condition when the deal economics the
-- contract reconciles against change (IG-W7, owner-directed 2026-07-24). Mirror of
-- db/291 (SSN), db/290 (assets), db/287 (gov-id), db/286 (credit).
--
-- src/lib/underwriting/contract-autoclear.js may auto-clear the "Executed purchase
-- contract" condition (rtl_p1_contract) once PILOT has read the contract (and, on an
-- assignment, the assignment agreement) AND its economics reconcile to the file — no
-- open FATAL contract/assignment finding remains. Those fatal findings compare the
-- CONTRACT against the file's own economics:
--   • purchase_price            — contract_price_mismatch
--   • property_address          — contract_address_mismatch
--   • is_assignment             — flips whether the assignment leg is even checked
--   • assignment_fee            — assignment_fee_mismatch
--   • underlying_contract_price — underlying_price_mismatch (the seller's original price)
-- So if any of these change on the file after the contract was auto-cleared, the prior
-- reconciliation is stale — the contract may no longer tie out — and an [auto] clear must
-- be reopened so it never stands on stale numbers. (db/071/072 already reopen the separate
-- product_pricing condition on the same class of change; this is the contract condition's
-- own reopen.) A human sign-off (signed_off_by NOT NULL) is left alone, exactly as the
-- auto-clear never overrode one.
--
-- Structural chokepoint: an AFTER UPDATE trigger on `applications` that fires on ANY path
-- which changes one of those economics fields (portal edit, ClickUp inbound sync, product
-- re-register) and reopens the file's auto-cleared contract condition to 'received'.

CREATE OR REPLACE FUNCTION reopen_contract_on_economics_change() RETURNS trigger AS $$
BEGIN
  IF NEW.purchase_price            IS DISTINCT FROM OLD.purchase_price
     OR NEW.property_address       IS DISTINCT FROM OLD.property_address
     OR NEW.is_assignment          IS DISTINCT FROM OLD.is_assignment
     OR NEW.assignment_fee         IS DISTINCT FROM OLD.assignment_fee
     OR NEW.underlying_contract_price IS DISTINCT FROM OLD.underlying_contract_price THEN
    UPDATE checklist_items ci
       SET status='received',
           signed_off_at=NULL, signed_off_by=NULL,
           reviewed_at=NULL, reviewed_by=NULL,
           notes='[auto] The purchase contract needs another look — the loan''s price, address, or assignment figures changed, so it must be re-checked against the contract.',
           updated_at=now()
     WHERE ci.application_id = NEW.id
       AND ci.status='satisfied'
       AND ci.signed_off_by IS NULL
       AND COALESCE(ci.notes,'') LIKE '[auto]%'
       AND ci.template_id = (SELECT id FROM checklist_templates WHERE code='rtl_p1_contract');
  END IF;
  RETURN NULL;  -- AFTER trigger: return value is ignored.
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reopen_contract_on_economics_change ON applications;
CREATE TRIGGER trg_reopen_contract_on_economics_change
  AFTER UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION reopen_contract_on_economics_change();
