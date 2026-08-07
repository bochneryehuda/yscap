-- THE "DEAL ECONOMICS CHANGED" MESSAGE MUST ALWAYS NAME WHAT CHANGED
-- (owner-reported 2026-08-07: "Deal economics were not changed. Who changed the deal
-- economics? I just went a minute ago to do it.")
--
-- The reopen/stale trigger decides "did a pricing input move?" with ONE expression and
-- then describes what moved with a SECOND, SHORTER one. Ten watched inputs were never
-- in the second list, so when one of them moved the trigger fell through to its generic
-- wording — "deal economics changed", with nothing itemized — and the officer was told
-- to re-register with no way to see what had supposedly changed. On the reported file
-- the mover was a sticky per-file MARKUP written by the register route itself, a few
-- statements after that same route had cleared the stale flag (the loop; fixed in
-- src/routes/staff.js), so re-registering repeated it forever and the trigger's second
-- UPDATE re-opened Products & Pricing, so signing off could not settle it either.
--
-- The ten: rehab TYPE and both square footages (they reach pricing_changed through
-- scope_changed, where only rehab_budget was ever named), the subject STATE, the
-- CO-BORROWER, all four sticky markups, the ASSIGNMENT flag, and the three claimed
-- EXPERIENCE counts.
--
-- THE CLASS: a change DETECTOR and its change DESCRIPTION are two lists, they drift,
-- and the drift is invisible because the fallback wording is plausible. Anything added
-- to pricing_changed must be described in the SAME migration — the generic branch now
-- says "PILOT could not identify which one", which is a bug signal, not a routine path.
--
-- WORDING + SAFETY ONLY. Not one input is added to or removed from the detection set,
-- so exactly the same events reopen exactly the same conditions as before; only the
-- sentence changes.
--
-- BUILT BY EXTRACTING db/466's function body VERBATIM and applying two substitutions
-- (the new itemization, the generic wording), each asserted to match exactly once.
-- That method is the point: a hand-retyped copy of this function silently dropped the
-- Heter Iska reopen, the signed-term-sheet reopen and the SoW's scope_changed gate, and
-- named the function wrong so it would have been a no-op. Numbered above db/466 so it
-- wins on every boot. When you next change this function, extract and patch — never
-- retype it.

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

    -- ---- THE TEN THAT WERE NEVER NAMED (db/486) --------------------------------
    -- Each of these already reached pricing_changed above; none of them had a
    -- description, so any one of them moving produced the generic wording with
    -- nothing listed. Detection is UNCHANGED — this only lets the message speak.
    IF NEW.rehab_type IS DISTINCT FROM OLD.rehab_type THEN
      changes := changes || ('Rehab type: ' || pilot_fmt_txt(OLD.rehab_type) || ' → ' || pilot_fmt_txt(NEW.rehab_type)); END IF;
    IF COALESCE(NEW.sqft_pre,0) IS DISTINCT FROM COALESCE(OLD.sqft_pre,0) THEN
      changes := changes || ('Square footage (current): ' || pilot_fmt_txt(COALESCE(OLD.sqft_pre,0)::text) || ' → ' || pilot_fmt_txt(COALESCE(NEW.sqft_pre,0)::text)); END IF;
    IF COALESCE(NEW.sqft_post,0) IS DISTINCT FROM COALESCE(OLD.sqft_post,0) THEN
      changes := changes || ('Square footage (after): ' || pilot_fmt_txt(COALESCE(OLD.sqft_post,0)::text) || ' → ' || pilot_fmt_txt(COALESCE(NEW.sqft_post,0)::text)); END IF;
    -- Itemized on the SEMANTIC state change only, matching the detection above, so
    -- an address re-spelling ("New York" → "NY") is still never announced.
    IF pilot_state_norm(NEW.property_address->>'state')
         IS DISTINCT FROM pilot_state_norm(OLD.property_address->>'state') THEN
      changes := changes || ('Property state: ' || pilot_fmt_txt(OLD.property_address->>'state') || ' → ' || pilot_fmt_txt(NEW.property_address->>'state')); END IF;
    -- The co-borrower carries experience and the guaranty behind the pricing. The
    -- NAME is deliberately NOT looked up: this trigger fires on every write to
    -- `applications` and must never join another table to describe itself.
    IF NEW.co_borrower_id IS DISTINCT FROM OLD.co_borrower_id THEN
      changes := changes || (CASE
        WHEN OLD.co_borrower_id IS NULL THEN 'Co-borrower: added'
        WHEN NEW.co_borrower_id IS NULL THEN 'Co-borrower: removed'
        ELSE 'Co-borrower: changed' END); END IF;
    IF COALESCE(NEW.is_assignment,false) IS DISTINCT FROM COALESCE(OLD.is_assignment,false) THEN
      changes := changes || (CASE WHEN COALESCE(NEW.is_assignment,false)
        THEN 'Assignment: this is now an assignment purchase'
        ELSE 'Assignment: no longer an assignment purchase' END); END IF;
    -- The four sticky per-file MARKUPS — internal margin. This text reaches the
    -- stale reason and `checklist_items.notes`, both STAFF-ONLY (never a
    -- borrower_label/borrower_hint), so the number may be stated; it is the one an
    -- officer needs in order to recognise their own edit.
    IF COALESCE(NEW.file_markup_std_pct,0) IS DISTINCT FROM COALESCE(OLD.file_markup_std_pct,0) THEN
      changes := changes || ('Standard markup: ' || pilot_fmt_txt(COALESCE(OLD.file_markup_std_pct,0)::text) || '% → ' || pilot_fmt_txt(COALESCE(NEW.file_markup_std_pct,0)::text) || '%'); END IF;
    IF COALESCE(NEW.file_markup_gold_pct,0) IS DISTINCT FROM COALESCE(OLD.file_markup_gold_pct,0) THEN
      changes := changes || ('Gold markup: ' || pilot_fmt_txt(COALESCE(OLD.file_markup_gold_pct,0)::text) || '% → ' || pilot_fmt_txt(COALESCE(NEW.file_markup_gold_pct,0)::text) || '%'); END IF;
    IF COALESCE(NEW.file_markup_silver_pct,0) IS DISTINCT FROM COALESCE(OLD.file_markup_silver_pct,0) THEN
      changes := changes || ('Silver markup: ' || pilot_fmt_txt(COALESCE(OLD.file_markup_silver_pct,0)::text) || '% → ' || pilot_fmt_txt(COALESCE(NEW.file_markup_silver_pct,0)::text) || '%'); END IF;
    IF COALESCE(NEW.file_markup_gold_t1_pct,0) IS DISTINCT FROM COALESCE(OLD.file_markup_gold_t1_pct,0) THEN
      changes := changes || ('Gold top-tier markup: ' || pilot_fmt_txt(COALESCE(OLD.file_markup_gold_t1_pct,0)::text) || '% → ' || pilot_fmt_txt(COALESCE(NEW.file_markup_gold_t1_pct,0)::text) || '%'); END IF;
    -- The three CLAIMED experience counts — the loan is SIZED on them (#85).
    IF COALESCE(NEW.requested_exp_flips,0) IS DISTINCT FROM COALESCE(OLD.requested_exp_flips,0) THEN
      changes := changes || ('Experience (flips): ' || pilot_fmt_txt(COALESCE(OLD.requested_exp_flips,0)::text) || ' → ' || pilot_fmt_txt(COALESCE(NEW.requested_exp_flips,0)::text)); END IF;
    IF COALESCE(NEW.requested_exp_holds,0) IS DISTINCT FROM COALESCE(OLD.requested_exp_holds,0) THEN
      changes := changes || ('Experience (holds): ' || pilot_fmt_txt(COALESCE(OLD.requested_exp_holds,0)::text) || ' → ' || pilot_fmt_txt(COALESCE(NEW.requested_exp_holds,0)::text)); END IF;
    IF COALESCE(NEW.requested_exp_ground,0) IS DISTINCT FROM COALESCE(OLD.requested_exp_ground,0) THEN
      changes := changes || ('Experience (ground-up): ' || pilot_fmt_txt(COALESCE(OLD.requested_exp_ground,0)::text) || ' → ' || pilot_fmt_txt(COALESCE(NEW.requested_exp_ground,0)::text)); END IF;

    detail := array_to_string(changes, '; ');

    IF detail <> '' THEN
      stale_msg := 'Pricing inputs changed — ' || detail || '. Re-register the product and issue a new term sheet.';
      note_msg  := '[auto] Re-register needed — ' || detail || '. Re-register the product in Products & Pricing so the structure and loan amount match the new numbers.';
    ELSE
      -- REACHING HERE IS NOW A BUG SIGNAL, not a routine path: every input in
      -- pricing_changed above is itemized, so an un-named change means a new input
      -- joined the detection set without a description. Say so plainly rather than
      -- demanding a re-register with no reason — the dead end the owner hit. The fix
      -- is to add the description above; do not re-word this.
      stale_msg := 'A pricing input changed but PILOT could not identify which one — ask an admin to check this file before issuing a term sheet.';
      note_msg  := '[auto] A pricing input changed but PILOT could not identify which one. Re-register the product in Products & Pricing, and tell an admin this message appeared — it means a number moved that PILOT cannot name.';
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
