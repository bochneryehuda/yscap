-- 326 — "New York" and "NY" are the SAME state (a re-spelling is never a re-price).
-- (owner-reported 2026-07-26: subject/home addresses stored as the raw geocoder
--  display name — "26, South 10th Street, Williamsburg, Brooklyn, Kings County,
--  New York, 11249, United States" — instead of the mailing form ClickUp shows,
--  "26 S 10th St, Brooklyn, NY 11249, USA".)
--
-- THE CONNECTION TO THIS FILE: repairing those addresses rewrites the stored
-- state from the spelled-out "New York" to "NY". The reopen trigger (live body:
-- db/322) compared `property_address->>'state'` as RAW TEXT, so that repair —
-- and every other harmless re-spelling, from the ClickUp import or any geocoder
-- — would have flagged the current registration STALE and demanded a pointless
-- re-register. That is EXACTLY the class db/288 (term) and db/322 (property
-- type) already closed, left armed on one more free-text pricing input.
--
-- THE ROOT FIX:
--   1. pilot_state_norm(text) — ONE semantic reading of a US state text: a
--      2-letter code passes through, a full name maps to its code, and anything
--      unrecognized compares to ITSELF (upper-cased, squeezed). Nothing is ever
--      guessed into a state, so a brand-new value can neither false-fire nor be
--      silently collapsed into another state. The JS twin is stateCompareKey()
--      in src/lib/address.js — KEEP THEM IN SYNC (the DB test
--      scripts/test-address-state-compare-db.js asserts they agree).
--   2. The reopen trigger compares pilot_state_norm(OLD) vs pilot_state_norm(NEW).
--      Behaviour is otherwise IDENTICAL to db/322 (same watched columns, same
--      reopen effects, same semantic term + property-type compares, same Heter
--      Iska branch) — ONLY the state comparison changes from raw text.
--
-- Idempotent: CREATE OR REPLACE only; no data is touched.

-- ---- 1. Semantic reading of a state text ----------------------------------
CREATE OR REPLACE FUNCTION pilot_state_norm(v text) RETURNS text AS $fn$
  SELECT CASE
    WHEN v IS NULL OR btrim(v) = '' THEN NULL
    WHEN upper(btrim(v)) IN ('AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA',
                             'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM',
                             'NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA',
                             'WV','WI','WY','PR','VI','GU','AS','MP')
      THEN upper(btrim(v))
    ELSE COALESCE(
      (SELECT code FROM (VALUES
        ('alabama','AL'),('alaska','AK'),('arizona','AZ'),('arkansas','AR'),('california','CA'),
        ('colorado','CO'),('connecticut','CT'),('delaware','DE'),('district of columbia','DC'),
        ('florida','FL'),('georgia','GA'),('hawaii','HI'),('idaho','ID'),('illinois','IL'),
        ('indiana','IN'),('iowa','IA'),('kansas','KS'),('kentucky','KY'),('louisiana','LA'),
        ('maine','ME'),('maryland','MD'),('massachusetts','MA'),('michigan','MI'),('minnesota','MN'),
        ('mississippi','MS'),('missouri','MO'),('montana','MT'),('nebraska','NE'),('nevada','NV'),
        ('new hampshire','NH'),('new jersey','NJ'),('new mexico','NM'),('new york','NY'),
        ('north carolina','NC'),('north dakota','ND'),('ohio','OH'),('oklahoma','OK'),('oregon','OR'),
        ('pennsylvania','PA'),('rhode island','RI'),('south carolina','SC'),('south dakota','SD'),
        ('tennessee','TN'),('texas','TX'),('utah','UT'),('vermont','VT'),('virginia','VA'),
        ('washington','WA'),('west virginia','WV'),('wisconsin','WI'),('wyoming','WY'),
        ('puerto rico','PR'),('virgin islands','VI'),('guam','GU')
      ) AS m(name, code)
      WHERE m.name = regexp_replace(lower(btrim(v)), '[[:space:]]+', ' ', 'g')),
      -- Unrecognized: compare to itself. Never guessed into a state.
      upper(regexp_replace(btrim(v), '[[:space:]]+', ' ', 'g'))
    )
  END;
$fn$ LANGUAGE sql IMMUTABLE;

-- ---- 2. The reopen trigger, with the state compared by meaning -------------
CREATE OR REPLACE FUNCTION reopen_conditions_on_budget_change() RETURNS trigger AS $$
DECLARE
  budget_changed  boolean;
  scope_changed   boolean;
  pricing_changed boolean;
  ptype_changed   boolean;
  changes         text[] := '{}';
  detail          text := '';
  stale_msg       text;
  note_msg        text;
BEGIN
  budget_changed := NEW.rehab_budget IS DISTINCT FROM OLD.rehab_budget;

  -- Anything that changes the Scope-of-Work classification / totals.
  scope_changed := budget_changed
    OR NEW.rehab_type IS DISTINCT FROM OLD.rehab_type
    OR COALESCE(NEW.sqft_pre,0)  IS DISTINCT FROM COALESCE(OLD.sqft_pre,0)
    OR COALESCE(NEW.sqft_post,0) IS DISTINCT FROM COALESCE(OLD.sqft_post,0);

  -- Property type compares by MEANING (db/322): "Multi 2-4" vs "Multi 2–4" vs
  -- "multi_2_4" is NOT a change, and replacing an appraisal FORM NUMBER with a
  -- real property type is a REPAIR of bad data, not a re-price event (the loan
  -- was never priced on a form number). A real type change, and filling a
  -- genuinely blank type, still count exactly as before.
  ptype_changed := pilot_property_type_norm(NEW.property_type)
                     IS DISTINCT FROM pilot_property_type_norm(OLD.property_type)
                   AND NOT pilot_is_appraisal_form_code(OLD.property_type);

  pricing_changed := scope_changed
    OR NEW.loan_amount               IS DISTINCT FROM OLD.loan_amount
    OR NEW.purchase_price            IS DISTINCT FROM OLD.purchase_price
    OR NEW.as_is_value               IS DISTINCT FROM OLD.as_is_value
    OR NEW.arv                       IS DISTINCT FROM OLD.arv
    OR NEW.loan_type                 IS DISTINCT FROM OLD.loan_type
    OR NEW.program                   IS DISTINCT FROM OLD.program
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
    IF NEW.program IS DISTINCT FROM OLD.program THEN
      changes := changes || ('Program: ' || pilot_fmt_txt(OLD.program) || ' → ' || pilot_fmt_txt(NEW.program)); END IF;
    IF NEW.loan_type IS DISTINCT FROM OLD.loan_type THEN
      changes := changes || ('Loan type: ' || pilot_fmt_txt(OLD.loan_type) || ' → ' || pilot_fmt_txt(NEW.loan_type)); END IF;
    -- Itemized only on a SEMANTIC property-type change (db/322) — never on a
    -- re-spelling, and never on a form-code repair.
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

