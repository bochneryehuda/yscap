-- 096 — Economics change makes the registered product FATAL and reopens the
--       signed term sheet (owner-directed 2026-07-14).
--
-- Extends the 071/072/074 reopen family. When any deal-economics input
-- changes (ARV, as-is value, purchase price, rehab budget / scope of work,
-- loan amount, program, assignment split, experience, IR inputs — the full
-- 072 list), then in addition to reopening the product_pricing condition:
--   1. the CURRENT product registration is flagged STALE ("fatal") — the
--      structure was priced off inputs that no longer exist, so it must be
--      re-registered (re-verified) and a NEW term sheet generated;
--   2. an already-signed term sheet no longer matches the deal — the
--      'Signed term sheet' condition (rtl_cond_signedts) reopens too.
-- A negative TRACK-RECORD change (verified experience dropping below what
-- the registration priced with) trips the same fatality from the app layer
-- (src/lib/experience.js) — table changes there can't fire this trigger.

ALTER TABLE product_registrations
  ADD COLUMN IF NOT EXISTS stale boolean NOT NULL DEFAULT false;
ALTER TABLE product_registrations
  ADD COLUMN IF NOT EXISTS stale_reason text;

CREATE OR REPLACE FUNCTION reopen_conditions_on_budget_change() RETURNS trigger AS $$
DECLARE
  budget_changed  boolean;
  pricing_changed boolean;
BEGIN
  budget_changed := NEW.rehab_budget IS DISTINCT FROM OLD.rehab_budget;

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
    OR NEW.requested_ir_amount       IS DISTINCT FROM OLD.requested_ir_amount
    OR NEW.is_assignment             IS DISTINCT FROM OLD.is_assignment
    OR NEW.underlying_contract_price IS DISTINCT FROM OLD.underlying_contract_price
    OR NEW.assignment_fee            IS DISTINCT FROM OLD.assignment_fee
    OR NEW.requested_exp_flips       IS DISTINCT FROM OLD.requested_exp_flips
    OR NEW.requested_exp_holds       IS DISTINCT FROM OLD.requested_exp_holds
    OR NEW.requested_exp_ground      IS DISTINCT FROM OLD.requested_exp_ground;

  IF pricing_changed THEN
    -- The registered product is FATAL: priced off inputs that no longer exist.
    UPDATE product_registrations
       SET stale = true,
           stale_reason = 'deal economics changed — re-register the product and issue a new term sheet'
     WHERE application_id = NEW.id AND is_current AND NOT stale;

    -- Product & Pricing reopens for re-registration (only when it had been cleared).
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

    -- A signed term sheet no longer matches the deal — a NEW one must be
    -- generated and signed (only reopens one that had progressed).
    UPDATE checklist_items ci
       SET status = 'outstanding', signed_off_at = NULL, signed_off_by = NULL,
           reviewed_at = NULL, reviewed_by = NULL,
           notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%'
                        THEN '[auto] The deal economics changed — the signed term sheet no longer matches. Generate the new term sheet and collect a fresh signature.'
                        ELSE ci.notes END,
           updated_at = now()
      FROM checklist_templates t
     WHERE t.id = ci.template_id AND t.code = 'rtl_cond_signedts'
       AND ci.application_id = NEW.id
       AND (ci.status IN ('received','satisfied') OR ci.signed_off_at IS NOT NULL);
  END IF;

  IF budget_changed THEN
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

DROP TRIGGER IF EXISTS trg_reopen_on_budget_change ON applications;
CREATE TRIGGER trg_reopen_on_budget_change
  AFTER UPDATE ON applications
  FOR EACH ROW
  EXECUTE FUNCTION reopen_conditions_on_budget_change();
