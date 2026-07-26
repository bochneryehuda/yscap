-- 145 — Reopen ALL signed e-sign conditions on an economics/FICO change
--       (owner-approved 2026-07-19).
--
-- The term-sheet package sends and signs THREE documents together — the term
-- sheet, the loan-application export, and the business-purpose disclosure — and
-- all three carry the loan amount. The reopen family (096/126) previously reopened
-- only the signed-term-sheet condition (rtl_cond_signedts) on an economics change,
-- leaving the signed application (rtl_cond_signed_app) and signed disclosure
-- (rtl_cond_disclosures) marked satisfied even when the numbers they show went
-- stale — so a borrower's signature could sit on a disclosure/application with the
-- wrong loan amount. Extend both reopen functions to reopen all three, so a numbers
-- change always forces a fresh signature on the whole packet (it re-sends as one
-- envelope anyway). Idempotent: CREATE OR REPLACE only — the triggers that call
-- these functions were installed by 096/126 and are unchanged.

CREATE OR REPLACE FUNCTION reopen_conditions_on_budget_change() RETURNS trigger AS $$
DECLARE
  budget_changed  boolean;
  scope_changed   boolean;
  pricing_changed boolean;
BEGIN
  budget_changed := NEW.rehab_budget IS DISTINCT FROM OLD.rehab_budget;

  scope_changed := budget_changed
    OR NEW.rehab_type IS DISTINCT FROM OLD.rehab_type
    OR COALESCE(NEW.sqft_pre,0)  IS DISTINCT FROM COALESCE(OLD.sqft_pre,0)
    OR COALESCE(NEW.sqft_post,0) IS DISTINCT FROM COALESCE(OLD.sqft_post,0);

  pricing_changed := scope_changed
    OR NEW.loan_amount               IS DISTINCT FROM OLD.loan_amount
    OR NEW.purchase_price            IS DISTINCT FROM OLD.purchase_price
    OR NEW.as_is_value               IS DISTINCT FROM OLD.as_is_value
    OR NEW.arv                       IS DISTINCT FROM OLD.arv
    OR NEW.loan_type                 IS DISTINCT FROM OLD.loan_type
    OR NEW.program                   IS DISTINCT FROM OLD.program
    OR NEW.property_type             IS DISTINCT FROM OLD.property_type
    OR NEW.units                     IS DISTINCT FROM OLD.units
    OR NEW.term                      IS DISTINCT FROM OLD.term
    OR (NEW.property_address->>'state') IS DISTINCT FROM (OLD.property_address->>'state')
    OR NEW.co_borrower_id            IS DISTINCT FROM OLD.co_borrower_id
    OR COALESCE(NEW.file_markup_std_pct,0)  IS DISTINCT FROM COALESCE(OLD.file_markup_std_pct,0)
    OR COALESCE(NEW.file_markup_gold_pct,0) IS DISTINCT FROM COALESCE(OLD.file_markup_gold_pct,0)
    OR COALESCE(NEW.requested_ir_months,0)  IS DISTINCT FROM COALESCE(OLD.requested_ir_months,0)
    OR COALESCE(NEW.requested_ir_amount,0)  IS DISTINCT FROM COALESCE(OLD.requested_ir_amount,0)
    OR COALESCE(NEW.is_assignment,false)    IS DISTINCT FROM COALESCE(OLD.is_assignment,false)
    OR COALESCE(NEW.underlying_contract_price,0) IS DISTINCT FROM COALESCE(OLD.underlying_contract_price,0)
    OR COALESCE(NEW.assignment_fee,0)       IS DISTINCT FROM COALESCE(OLD.assignment_fee,0)
    OR COALESCE(NEW.requested_exp_flips,0)  IS DISTINCT FROM COALESCE(OLD.requested_exp_flips,0)
    OR COALESCE(NEW.requested_exp_holds,0)  IS DISTINCT FROM COALESCE(OLD.requested_exp_holds,0)
    OR COALESCE(NEW.requested_exp_ground,0) IS DISTINCT FROM COALESCE(OLD.requested_exp_ground,0);

  IF pricing_changed THEN
    UPDATE product_registrations
       SET stale = true,
           stale_reason = 'deal economics changed — re-register the product and issue a new term sheet'
     WHERE application_id = NEW.id AND is_current AND NOT stale;

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

    -- Reopen EVERY signed document in the term-sheet package (term sheet +
    -- application + disclosure) — all three carry the loan amount and re-send as
    -- one envelope, so none may keep a signature over stale numbers.
    UPDATE checklist_items ci
       SET status = 'outstanding', signed_off_at = NULL, signed_off_by = NULL,
           reviewed_at = NULL, reviewed_by = NULL,
           notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%'
                        THEN '[auto] The deal economics changed — the signed documents no longer match. Re-send the signing package and collect fresh signatures.'
                        ELSE ci.notes END,
           updated_at = now()
      FROM checklist_templates t
     WHERE t.id = ci.template_id
       AND t.code IN ('rtl_cond_signedts','rtl_cond_signed_app','rtl_cond_disclosures')
       AND ci.application_id = NEW.id
       AND (ci.status IN ('received','satisfied') OR ci.signed_off_at IS NOT NULL);
  END IF;

  IF scope_changed THEN
    UPDATE checklist_items
       SET status = 'issue', signed_off_at = NULL, signed_off_by = NULL,
           reviewed_at = NULL, reviewed_by = NULL,
           notes = CASE WHEN notes IS NULL OR notes LIKE '[auto]%'
                        THEN '[auto] The construction scope changed — update the Scope of Work so it totals the current budget exactly before this condition can be signed off.'
                        ELSE notes END,
           updated_at = now()
     WHERE application_id = NEW.id
       AND tool_key = 'rehab_budget'
       AND (status IN ('satisfied', 'received') OR signed_off_at IS NOT NULL);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION reopen_pricing_on_fico_change() RETURNS trigger AS $$
BEGIN
  IF NEW.fico IS DISTINCT FROM OLD.fico THEN
    UPDATE product_registrations pr
       SET stale = true,
           stale_reason = 'representative FICO changed since the product was priced — re-register the product and issue a new term sheet'
      FROM applications a
     WHERE pr.application_id = a.id
       AND pr.is_current AND NOT pr.stale
       AND (a.borrower_id = NEW.id OR a.co_borrower_id = NEW.id)
       AND COALESCE((pr.inputs->>'fico')::numeric, 0) IS DISTINCT FROM COALESCE(NEW.fico, 0);

    UPDATE checklist_items ci
       SET status = 'received', signed_off_at = NULL, signed_off_by = NULL,
           reviewed_at = NULL, reviewed_by = NULL,
           notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%'
                        THEN '[auto] The representative FICO changed — re-register the product so the rate and eligibility match the new score.'
                        ELSE ci.notes END,
           updated_at = now()
      FROM applications a, product_registrations pr
     WHERE ci.application_id = a.id
       AND pr.application_id = a.id AND pr.is_current AND pr.stale
       AND (a.borrower_id = NEW.id OR a.co_borrower_id = NEW.id)
       AND ci.tool_key = 'product_pricing'
       AND (ci.status = 'satisfied' OR ci.signed_off_at IS NOT NULL);

    UPDATE checklist_items ci
       SET status = 'outstanding', signed_off_at = NULL, signed_off_by = NULL,
           reviewed_at = NULL, reviewed_by = NULL,
           notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%'
                        THEN '[auto] The representative FICO changed — the signed documents no longer match. Re-send the signing package and collect fresh signatures.'
                        ELSE ci.notes END,
           updated_at = now()
      FROM checklist_templates t, applications a, product_registrations pr
     WHERE t.id = ci.template_id
       AND t.code IN ('rtl_cond_signedts','rtl_cond_signed_app','rtl_cond_disclosures')
       AND ci.application_id = a.id
       AND pr.application_id = a.id AND pr.is_current AND pr.stale
       AND (a.borrower_id = NEW.id OR a.co_borrower_id = NEW.id)
       AND (ci.status IN ('received','satisfied') OR ci.signed_off_at IS NOT NULL);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
