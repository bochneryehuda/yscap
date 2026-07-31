-- ============================================================================
-- 382 - The property type is NEVER blank — it is derived from the unit count
--       (owner-directed 2026-07-31; "when PILOT says 1 unit the ClickUp property
--        type dropdown should say SFR, and same with 2-4").
--
-- ClickUp picked up that a property was a single unit (it filled the unit count)
-- but the *Property Type dropdown was left blank, so the card carried a unit
-- count with no property type. PILOT never populated property_type from the unit
-- count either, so the blank round-tripped and nothing was ever pushed up.
--
-- The owner's rule mirrors the Fix-&-Flip program default (db/381): the property
-- type is never blank — it is derived from the unit count (1 unit -> SFR,
-- 2-4 units -> Multi 2-4, 5+ -> Multi 5+) whenever it is blank, on EVERY write
-- path, and previous files are back-filled. The existing bidirectional ClickUp
-- sync (mapper FIELD_MAP property_type, dir:'both') then carries a later change
-- to Condo / Townhouse / Mixed use in either direction, unchanged — you can pick
-- any property type any time and it round-trips like everything else.
--
-- A single BEFORE trigger is the one chokepoint that catches the borrower
-- application, the staff new-file form, the public intake AND the ClickUp
-- materialize path at once.
--
-- FROZEN-PRICING SAFE for the ordinary case: the frozen engine
-- (src/lib/pricing.js normPropertyType/isIneligiblePropertyType) prices a BLANK
-- property type exactly like an eligible SFR / 2-4 (neither is on the ineligible
-- list), so filling a blank type with SFR or Multi 2-4 changes NO pricing number.
-- To keep the P&P re-price trigger from firing on that label-only fill, the
-- trigger below suppresses a blank -> units-consistent SFR/Multi-2-4 fill, exactly
-- as db/322 treats an appraisal-form-code repair as a non-re-price. A Multi 5+
-- fill DOES change eligibility (a 5+ building is ineligible), so it is a genuine
-- pricing-relevant correction and still reopens Products & Pricing. This mirrors
-- the term (db/288) / property_type (db/322) / state (db/326) / program (db/381)
-- semantic-compare pattern already in this same trigger.
-- ============================================================================

-- The property type a unit count implies. 1 (or an unknown/blank count) -> SFR
-- (the never-blank default; SFR and blank price identically, so this is
-- reprice-neutral), 2-4 -> Multi 2-4, 5+ -> Multi 5+. The labels are the portal's
-- canonical spellings (src/lib/property-type.js LABEL_OF + src/clickup/crosswalk.js
-- property_type.to) — 'Multi 2–4' uses an EN DASH on purpose so it matches the
-- crosswalk key and never re-spells on the round-trip.
CREATE OR REPLACE FUNCTION pilot_property_type_from_units(u integer) RETURNS text AS $$
BEGIN
  IF u IS NULL OR u <= 1     THEN RETURN 'SFR (1 unit)'; END IF;
  IF u BETWEEN 2 AND 4       THEN RETURN 'Multi 2–4';    END IF;
  RETURN 'Multi 5+';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Default a blank property_type from the unit count on EVERY write path. BEFORE
-- INSERT catches file creation from the borrower app, the staff new-file form,
-- the public intake and the ClickUp materialize path; BEFORE UPDATE OF
-- property_type, units heals a value edited (or COALESCE-touched by the inbound
-- sync) to blank, or fills the type the moment a unit count arrives.
CREATE OR REPLACE FUNCTION default_property_type() RETURNS trigger AS $$
BEGIN
  IF NEW.property_type IS NULL OR btrim(NEW.property_type) = '' THEN
    NEW.property_type := pilot_property_type_from_units(NEW.units);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_default_property_type ON applications;
CREATE TRIGGER trg_default_property_type
  BEFORE INSERT OR UPDATE OF property_type, units ON applications
  FOR EACH ROW
  EXECUTE FUNCTION default_property_type();

-- Re-create the P&P / Scope-of-Work / term-sheet / Iska re-price trigger
-- function. This is db/381's authoritative version verbatim EXCEPT the
-- property-type comparison, which now ALSO suppresses a blank -> units-consistent
-- SFR/Multi-2-4 fill (the label-only, pricing-neutral default above). Every other
-- line is identical to db/381 — do not drop the SoW-scope, semantic
-- term/type/state/program compares, stale-registration marking, or the
-- term-sheet / Iska reopens.
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
  -- (db/382), not a re-price. A Multi 5+ fill DOES change eligibility, so it is
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

  -- The deal program compares by MEANING (db/381): 'Not sure yet' / blank and
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
    -- re-spelling, a form-code repair, or the reprice-neutral units fill (db/382).
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

-- Previous files: fill every blank property_type from the unit count so no
-- existing file keeps an empty *Property Type. Reprice-neutral for SFR/Multi-2-4
-- by the meaning-aware trigger above; a Multi 5+ fill correctly reopens Products
-- & Pricing (a 5+ building is ineligible and must be re-reviewed). Idempotent:
-- after the first run there is no blank property_type left to match. (The
-- go-forward ClickUp card fill is done by the boot one-shot
-- backfillDefaultPropertyTypePushOnce() in src/sync/clickup-sync.js.)
INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
  SELECT 'system', NULL, 'property_type_defaulted', 'application', id,
         jsonb_build_object('from', property_type, 'to', pilot_property_type_from_units(units),
           'units', units,
           'why', 'blank property type derived from the unit count so the ClickUp *Property Type is never empty (owner-directed 2026-07-31)')
    FROM applications
   WHERE deleted_at IS NULL
     AND (property_type IS NULL OR btrim(property_type) = '');

UPDATE applications
   SET property_type = pilot_property_type_from_units(units)
 WHERE deleted_at IS NULL
   AND (property_type IS NULL OR btrim(property_type) = '');
