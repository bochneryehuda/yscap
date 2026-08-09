-- 466 — Per-experience-tier markup control (owner-directed item 15, second wave).
--
-- The owner: "For the gold program, the top tier is set up in the backend so
-- that it does not have any markup. We need to set that up in the admin pricing
-- settings … for tier one, this markup, for tier two, this markup, for tier
-- three, this markup … Do research on how to make this model setup so that for
-- every tier we should be able to control the markups for every program
-- differently." And, for the studio: "In the products and pricing term sheet
-- generator manual section, we should have, for the gold program, a separate
-- section for the top tier … We should be able to place a markup manually."
--
-- The frozen pricing engines already gained an OPTIONAL per-tier markup overlay
-- (setMarkupTiers) that is INERT when unset — proven byte-identical over 77,760
-- scenarios. This migration adds the two places that value is stored, both
-- NULL/absent by default so every existing file prices exactly as before
-- (previous AND future).
--
-- (A) COMPANY per-tier defaults — the Pricing Admin Center. A jsonb map shaped
--     { "standard": { "1": pct, "2": pct, "3": pct }, "gold": {…}, "silver": {…} }
--     of PERCENTS (mirrors markup_std_pct). Any tier left out keeps its historic
--     markup (Gold Tier 1 = 0, every other tier the base/override). NULL = the
--     whole feature off — read as null by src/lib/pricing-settings.js, so the
--     seeded / existing rows need no backfill.
ALTER TABLE company_pricing_settings
  ADD COLUMN IF NOT EXISTS markup_tiers jsonb;

-- (B) The PER-FILE Gold TOP-TIER manual markup — the studio's "manual section".
--     A sticky percent (mirrors db/109/373 file_markup_*_pct): an explicit
--     per-file Gold Tier-1 markup persists on the application and re-applies to
--     every future quote, so a borrower's self-service pricing can never reprice
--     the top tier back to zero below the markup the file was structured at.
--     NULL = not set → the company per-tier default (or the historic 0) governs.
--
--     Written by the register path (src/routes/staff.js). It is WATCHED by the
--     economics-reopen trigger below exactly like its sibling sticky markups
--     (file_markup_std/gold/silver_pct, db/373) — so a re-register at a different
--     Gold Tier-1 markup reopens Products & Pricing / the signed term sheet the
--     same way, and any future edit surface is covered without a second change.
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS file_markup_gold_t1_pct numeric;

-- (C) Watch file_markup_gold_t1_pct in the economics-reopen trigger — this is
--     db/383's authoritative reopen_conditions_on_budget_change() VERBATIM plus
--     the ONE new clause for the per-file Gold top-tier markup (mirroring the
--     three sibling markup clauses). Every other line is byte-identical to db/383;
--     do not drop the SoW-scope, semantic term/type/state/program compares, the
--     stale-registration marking, or the term-sheet / Iska reopens.
CREATE OR REPLACE FUNCTION reopen_conditions_on_budget_change() RETURNS trigger AS $$
DECLARE
  budget_changed   boolean;
  scope_changed    boolean;
  pricing_changed  boolean;
  ptype_changed    boolean;
  ptype_units_fill boolean;
  prog_changed     boolean;
  changes          text[] := '{}';
  detail           text := '';
  stale_msg        text;
  note_msg         text;
BEGIN
  budget_changed := NEW.rehab_budget IS DISTINCT FROM OLD.rehab_budget;

  -- Anything that changes the Scope-of-Work classification / totals.
  scope_changed := budget_changed
    OR NEW.rehab_type IS DISTINCT FROM OLD.rehab_type
    OR COALESCE(NEW.sqft_pre,0)  IS DISTINCT FROM COALESCE(OLD.sqft_pre,0)
    OR COALESCE(NEW.sqft_post,0) IS DISTINCT FROM COALESCE(OLD.sqft_post,0);

  -- A blank property type filled from the file's unit count to its pricing-
  -- EQUIVALENT default (SFR for 1 unit, Multi 2-4 for 2-4 units — both price as an
  -- eligible 1-4 unit deal exactly as a blank type did) is a label-only backfill
  -- (db/383), not a re-price. A Multi 5+ fill DOES change eligibility, so it is
  -- deliberately NOT suppressed and still reopens.
  ptype_units_fill := COALESCE(btrim(OLD.property_type), '') = ''
    AND pilot_property_type_norm(NEW.property_type)
          = pilot_property_type_norm(pilot_property_type_from_units(NEW.units))
    AND pilot_property_type_norm(NEW.property_type) IN ('sfr', 'multi_2_4');

  -- Property type compares by MEANING (db/322): "Multi 2-4" vs "Multi 2–4" vs
  -- "multi_2_4" is NOT a change, and replacing an appraisal FORM NUMBER with a
  -- real property type is a REPAIR of bad data, not a re-price event (the loan
  -- was never priced on a form number). A real type change still counts; filling
  -- a genuinely blank type still counts EXCEPT the reprice-neutral units fill.
  ptype_changed := pilot_property_type_norm(NEW.property_type)
                     IS DISTINCT FROM pilot_property_type_norm(OLD.property_type)
                   AND NOT pilot_is_appraisal_form_code(OLD.property_type)
                   AND NOT ptype_units_fill;

  -- The deal program compares by MEANING (db/382): 'Not sure yet' / blank and
  -- 'Fix & Flip w/ Construction' all price as Fix & Flip (engineStrategy), so the
  -- Fix-&-Flip default is NOT a re-price. A real Fix & Flip -> Fix & Hold /
  -- Bridge / Ground-Up change is a different engine strategy, so it still counts.
  prog_changed := pilot_program_norm(NEW.program) IS DISTINCT FROM pilot_program_norm(OLD.program);

  pricing_changed := scope_changed
    OR NEW.loan_amount               IS DISTINCT FROM OLD.loan_amount
    OR NEW.purchase_price            IS DISTINCT FROM OLD.purchase_price
    OR NEW.as_is_value               IS DISTINCT FROM OLD.as_is_value
    OR NEW.arv                       IS DISTINCT FROM OLD.arv
    OR NEW.loan_type                 IS DISTINCT FROM OLD.loan_type
    OR prog_changed
    OR ptype_changed
    OR NEW.units                     IS DISTINCT FROM OLD.units
    -- Term compares by MEANING (db/288): "12" vs "12 Months" is NOT a change.
    OR pilot_term_norm(NEW.term)     IS DISTINCT FROM pilot_term_norm(OLD.term)
    -- The subject STATE compares by MEANING (db/326): "New York" and "NY" are
    -- the same state, so re-spelling an address (the 2026-07-26 address-format
    -- repair, a ClickUp import, a geocoder) is NOT a pricing change. A real
    -- state change, and filling a genuinely blank state, still count.
    OR pilot_state_norm(NEW.property_address->>'state')
         IS DISTINCT FROM pilot_state_norm(OLD.property_address->>'state')
    OR NEW.co_borrower_id            IS DISTINCT FROM OLD.co_borrower_id
    OR COALESCE(NEW.file_markup_std_pct,0)  IS DISTINCT FROM COALESCE(OLD.file_markup_std_pct,0)
    OR COALESCE(NEW.file_markup_gold_pct,0) IS DISTINCT FROM COALESCE(OLD.file_markup_gold_pct,0)
    OR COALESCE(NEW.file_markup_silver_pct,0) IS DISTINCT FROM COALESCE(OLD.file_markup_silver_pct,0)
    -- Per-file Gold TOP-TIER markup (item 15, db/466) — watched exactly like the
    -- sibling sticky markups above, so a re-register at a different Gold Tier-1
    -- markup reopens Products & Pricing the same way.
    OR COALESCE(NEW.file_markup_gold_t1_pct,0) IS DISTINCT FROM COALESCE(OLD.file_markup_gold_t1_pct,0)
    OR COALESCE(NEW.requested_ir_months,0)  IS DISTINCT FROM COALESCE(OLD.requested_ir_months,0)
    OR COALESCE(NEW.requested_ir_amount,0)  IS DISTINCT FROM COALESCE(OLD.requested_ir_amount,0)
    OR COALESCE(NEW.is_assignment,false)    IS DISTINCT FROM COALESCE(OLD.is_assignment,false)
    OR COALESCE(NEW.underlying_contract_price,0) IS DISTINCT FROM COALESCE(OLD.underlying_contract_price,0)
    OR COALESCE(NEW.assignment_fee,0)       IS DISTINCT FROM COALESCE(OLD.assignment_fee,0)
    OR COALESCE(NEW.requested_exp_flips,0)  IS DISTINCT FROM COALESCE(OLD.requested_exp_flips,0)
    OR COALESCE(NEW.requested_exp_holds,0)  IS DISTINCT FROM COALESCE(OLD.requested_exp_holds,0)
    OR COALESCE(NEW.requested_exp_ground,0) IS DISTINCT FROM COALESCE(OLD.requested_exp_ground,0);

  IF pricing_changed THEN
    -- Build the plain-language "which number changed" list (best-effort — a
    -- change we don't itemize falls back to the generic wording below).
    IF prog_changed THEN
      changes := changes || ('Program: ' || pilot_fmt_txt(OLD.program) || ' → ' || pilot_fmt_txt(NEW.program)); END IF;
    IF NEW.loan_type IS DISTINCT FROM OLD.loan_type THEN
      changes := changes || ('Loan type: ' || pilot_fmt_txt(OLD.loan_type) || ' → ' || pilot_fmt_txt(NEW.loan_type)); END IF;
    -- Itemized only on a SEMANTIC property-type change (db/322) — never on a
    -- re-spelling, a form-code repair, or the reprice-neutral units fill (db/383).
    IF ptype_changed THEN
      changes := changes || ('Property type: ' || pilot_fmt_txt(OLD.property_type) || ' → ' || pilot_fmt_txt(NEW.property_type)); END IF;
    IF NEW.units IS DISTINCT FROM OLD.units THEN
      changes := changes || ('Units: ' || pilot_fmt_txt(OLD.units::text) || ' → ' || pilot_fmt_txt(NEW.units::text)); END IF;
    -- Itemized only on a SEMANTIC term change (db/288) — never on a re-spelling.
    IF pilot_term_norm(NEW.term) IS DISTINCT FROM pilot_term_norm(OLD.term) THEN
      changes := changes || ('Term: ' || pilot_fmt_txt(OLD.term::text) || ' → ' || pilot_fmt_txt(NEW.term::text)); END IF;
    IF NEW.purchase_price IS DISTINCT FROM OLD.purchase_price THEN
      changes := changes || ('Purchase price: ' || pilot_fmt_money(OLD.purchase_price) || ' → ' || pilot_fmt_money(NEW.purchase_price)); END IF;
    IF NEW.as_is_value IS DISTINCT FROM OLD.as_is_value THEN
      changes := changes || ('As-is value: ' || pilot_fmt_money(OLD.as_is_value) || ' → ' || pilot_fmt_money(NEW.as_is_value)); END IF;
    IF NEW.arv IS DISTINCT FROM OLD.arv THEN
      changes := changes || ('ARV: ' || pilot_fmt_money(OLD.arv) || ' → ' || pilot_fmt_money(NEW.arv)); END IF;
    IF NEW.rehab_budget IS DISTINCT FROM OLD.rehab_budget THEN
      changes := changes || ('Rehab budget: ' || pilot_fmt_money(OLD.rehab_budget) || ' → ' || pilot_fmt_money(NEW.rehab_budget)); END IF;
    IF NEW.loan_amount IS DISTINCT FROM OLD.loan_amount THEN
      changes := changes || ('Loan amount: ' || pilot_fmt_money(OLD.loan_amount) || ' → ' || pilot_fmt_money(NEW.loan_amount)); END IF;
    IF COALESCE(NEW.assignment_fee,0) IS DISTINCT FROM COALESCE(OLD.assignment_fee,0) THEN
      changes := changes || ('Assignment fee: ' || pilot_fmt_money(OLD.assignment_fee) || ' → ' || pilot_fmt_money(NEW.assignment_fee)); END IF;
    IF COALESCE(NEW.underlying_contract_price,0) IS DISTINCT FROM COALESCE(OLD.underlying_contract_price,0) THEN
      changes := changes || ('Seller contract price: ' || pilot_fmt_money(OLD.underlying_contract_price) || ' → ' || pilot_fmt_money(NEW.underlying_contract_price)); END IF;
    IF COALESCE(NEW.requested_ir_months,0) IS DISTINCT FROM COALESCE(OLD.requested_ir_months,0) THEN
      changes := changes || ('Interest reserve (months): ' || pilot_fmt_txt(COALESCE(OLD.requested_ir_months,0)::text) || ' → ' || pilot_fmt_txt(COALESCE(NEW.requested_ir_months,0)::text)); END IF;
    IF COALESCE(NEW.requested_ir_amount,0) IS DISTINCT FROM COALESCE(OLD.requested_ir_amount,0) THEN
      changes := changes || ('Interest reserve (amount): ' || pilot_fmt_money(OLD.requested_ir_amount) || ' → ' || pilot_fmt_money(NEW.requested_ir_amount)); END IF;

    detail := array_to_string(changes, '; ');

    IF detail <> '' THEN
      stale_msg := 'Pricing inputs changed — ' || detail || '. Re-register the product and issue a new term sheet.';
      note_msg  := '[auto] Re-register needed — ' || detail || '. Re-register the product in Products & Pricing so the structure and loan amount match the new numbers.';
    ELSE
      stale_msg := 'deal economics changed — re-register the product and issue a new term sheet';
      note_msg  := '[auto] The deal economics changed — re-register the product in Products & Pricing so the structure and loan amount match the new numbers.';
    END IF;

    UPDATE product_registrations
       SET stale = true,
           stale_reason = stale_msg
     WHERE application_id = NEW.id AND is_current AND NOT stale;

    UPDATE checklist_items
       SET status = 'received', signed_off_at = NULL, signed_off_by = NULL,
           reviewed_at = NULL, reviewed_by = NULL,
           notes = CASE WHEN notes IS NULL OR notes LIKE '[auto]%' THEN note_msg ELSE notes END,
           updated_at = now()
     WHERE application_id = NEW.id
       AND tool_key = 'product_pricing'
       AND (status = 'satisfied' OR signed_off_at IS NOT NULL);

    UPDATE checklist_items ci
       SET status = 'outstanding', signed_off_at = NULL, signed_off_by = NULL,
           reviewed_at = NULL, reviewed_by = NULL,
           notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%'
                        THEN '[auto] The deal economics changed — the signed term sheet no longer matches ('
                             || COALESCE(NULLIF(detail, ''), 'deal economics changed')
                             || '). Generate the new term sheet and collect a fresh signature.'
                        ELSE ci.notes END,
           updated_at = now()
      FROM checklist_templates t
     WHERE t.id = ci.template_id AND t.code = 'rtl_cond_signedts'
       AND ci.application_id = NEW.id
       AND (ci.status IN ('received','satisfied') OR ci.signed_off_at IS NOT NULL);

    -- The Heter Iska is tied to the LOAN AMOUNT specifically (db/280). Reopen it
    -- (and clear its sign-off) only when the loan amount itself moved, so a fresh
    -- ISKA is collected. The app layer additionally voids/supersedes the signed
    -- ISKA DocuSign package on the register path.
    IF NEW.loan_amount IS DISTINCT FROM OLD.loan_amount THEN
      UPDATE checklist_items ci
         SET status = 'outstanding', signed_off_at = NULL, signed_off_by = NULL,
             reviewed_at = NULL, reviewed_by = NULL,
             notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%'
                          THEN '[auto] Reopened because the loan amount changed ('
                               || pilot_fmt_money(OLD.loan_amount) || ' → ' || pilot_fmt_money(NEW.loan_amount)
                               || ') — the signed Heter Iska is tied to the loan amount, so collect a fresh signature.'
                          ELSE ci.notes END,
             updated_at = now()
        FROM checklist_templates t
       WHERE t.id = ci.template_id AND t.code = 'rtl_cond_iska'
         AND ci.application_id = NEW.id
         AND (ci.status IN ('received','satisfied') OR ci.signed_off_at IS NOT NULL);
    END IF;
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
