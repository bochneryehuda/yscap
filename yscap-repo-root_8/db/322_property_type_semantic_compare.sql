-- 322 — "FNM1025" is not a property type, and a re-spelling is not a change.
-- (owner-reported 2026-07-26: "Property type: FNM1025 → Multi 2–4; Term: 12 →
--  12 Months" — a file demanding a re-register over a property type that never
--  changed and a term that never changed.)
--
-- THE BUG, in two halves — both the SAME class as the db/288 term bug:
--
--  1. FNM1025 IS AN APPRAISAL FORM NUMBER, NOT A PROPERTY TYPE. It is the
--     Fannie Mae "Small Residential Income" (2–4 unit) REPORT. It reached
--     applications.property_type from the appraisal desk: the reconciler raises
--     a property-type finding whose "appraisal value" is the form code, and that
--     value used to be writable back onto the loan file ("use the appraisal's
--     value"). That specific door is shut today (REPRICE_COLS in
--     src/routes/appraisal.js excludes property_type and the finding offers only
--     keep/dismiss), but NO door ever REFUSED the value — staff details, staff
--     and borrower completeness, and the ClickUp inbound all took property_type
--     as unvalidated free text, so any client or script could put a form code
--     back in. src/lib/property-type.js is that refusal (mirroring the #95
--     sanitizeLoanType pattern) and every door now runs it.
--
--  2. applications.property_type is TEXT and the doors write DIFFERENT spellings
--     of the SAME type: the ClickUp dropdown stores "Multi 2-4" (hyphen), the
--     portal forms store "Multi 2–4" (en dash), the Condition Center writes the
--     canonical key "multi_2_4". The reopen trigger (live body: db/288) compared
--     the RAW text, so a re-spelling from any door flagged the current
--     registration STALE and demanded a re-register — the identical loop db/288
--     fixed for `term` and left armed for `property_type`.
--
-- THE ROOT FIX (this file + src/lib/property-type.js):
--   1. pilot_is_appraisal_form_code(text) / pilot_property_type_norm(text) /
--      pilot_appraisal_form_property_key(text) — ONE semantic reading of a
--      property-type text. The JS twins are isAppraisalFormCode() /
--      propertyTypeCompareKey() / guessFromFormCode() in
--      src/lib/property-type.js — KEEP THEM IN SYNC.
--   2. The reopen trigger compares pilot_property_type_norm(OLD) vs
--      pilot_property_type_norm(NEW), so a formatting-only rewrite can NEVER
--      flag the registration stale again, from ANY writer. It also treats
--      "a form code → a real property type" as a REPAIR, not a pricing change:
--      the file was never priced on a form number, so correcting it is not a
--      re-price event. A REAL type change (SFR → Multi 2–4) still trips it
--      exactly as before, and so does filling a genuinely BLANK type.
--   3. Repair the files that already carry a form code in property_type, using
--      the forms' own definitions (1004 → 1 unit, 1025 → 2–4, 1073 → condo).
--      Audited per file. Any other form number is left alone rather than guessed.
--   4. Heal the registrations stuck on a COSMETIC reason. db/288 could only heal
--      a Term-ONLY reason ("NOT LIKE '%;%'"), so the owner's combined
--      "Property type: … ; Term: …" reason was never cleared and the file kept
--      demanding a re-register. pilot_reason_is_cosmetic() parses the whole
--      itemized list and clears only when EVERY item is provably a no-op.
--      Condition statuses / sign-offs are deliberately NOT auto-restored — a
--      human verifies and signs off (same policy as db/288).
--
-- Additive + idempotent: CREATE OR REPLACE throughout; the repair/heal UPDATEs
-- match only the broken shape and rewrite it, so a second boot finds 0 rows.

-- ---- 1. Is this text an appraisal FORM number rather than a property type? --
-- 'FNM1025' / 'FNM 1025' / 'fnma-1004' / 'Form 1073' / '1025' / 'URAR' → true.
-- Deliberately TIGHT: this decides only what to REFUSE, and a value that is not
-- a known Fannie/Freddie form number passes through untouched, so a brand-new
-- ClickUp dropdown option is never silently dropped.
CREATE OR REPLACE FUNCTION pilot_is_appraisal_form_code(v text) RETURNS boolean AS $$
  SELECT COALESCE((
    SELECT (t IN ('urar', 'uad'))
        OR (substring(t from '^(?:fnma|fnm|fannie|fhlmc|fre|freddie|form)?([0-9]{2,4}[a-d]?)$')
            IN ('1004','1004c','1004d','1025','1073','1073a','2055','2090','2095','216','1007','70','72','465'))
    FROM (SELECT regexp_replace(lower(btrim(COALESCE(v, ''))), '[[:space:]._/-]+', '', 'g') AS t) s
    WHERE t <> ''
  ), false);
$$ LANGUAGE sql IMMUTABLE;

-- ---- 2. The semantic property-type key ------------------------------------
-- 'Multi 2–4' / 'Multi 2-4' / 'multi_2_4' / 'Duplex'   → 'multi_2_4'
-- 'SFR (1 unit)' / 'Single Family' / 'Detached'        → 'sfr'
-- an appraisal form code / NULL / ''                   → NULL (never a type)
-- an unrecognized option ('New Construction')          → its squashed text, so
--                                                        it still compares to
--                                                        itself and is never
--                                                        collapsed onto another
--                                                        category by guesswork.
CREATE OR REPLACE FUNCTION pilot_property_type_norm(v text) RETURNS text AS $$
  SELECT CASE
    WHEN v IS NULL OR btrim(v) = ''            THEN NULL
    WHEN pilot_is_appraisal_form_code(v)       THEN NULL
    WHEN lower(v) ~ 'mixed'                    THEN 'mixed_use'
    WHEN lower(v) ~ 'condo|co-?op\M|cooperative' THEN 'condo'
    WHEN lower(v) ~ 'town[[:space:]]*(house|home)|townh' THEN 'townhouse'
    WHEN lower(v) ~ '\mpud\M|planned[[:space:]]*unit'    THEN 'pud'
    WHEN lower(v) ~ '5[[:space:]]*\+|5[[:space:]]*(or[[:space:]]*)?more|multi[[:space:]_-]*5|multifamily[[:space:]_-]*5' THEN 'multi_5_plus'
    WHEN lower(v) ~ '2[[:space:]]*[-–—_ ]?[[:space:]]*4|duplex|triplex|fourplex|four[[:space:]-]?plex|quad|two[[:space:]-]?to[[:space:]-]?four' THEN 'multi_2_4'
    WHEN lower(v) ~ 'sfr|single[[:space:]_-]*family|1[[:space:]]*unit|one[[:space:]]*unit|detached' THEN 'sfr'
    ELSE NULLIF(regexp_replace(lower(btrim(v)), '[^a-z0-9]+', '', 'g'), '')
  END;
$$ LANGUAGE sql IMMUTABLE;

-- ---- 3. What property category is a given appraisal FORM written for? ------
-- Used ONLY to repair a file that already stores a form code (step 6) — never to
-- accept one as input. These are the forms' own definitions, mirrored in
-- src/lib/appraisal/extract.js and docs/appraisal-xml/field-validation-rules.md.
-- A form that says nothing definite about the category (2055 / 216 / 1007) is
-- NOT mapped — it stays unrepaired rather than guessed.
CREATE OR REPLACE FUNCTION pilot_appraisal_form_property_key(v text) RETURNS text AS $$
  SELECT CASE
    WHEN NOT pilot_is_appraisal_form_code(v) THEN NULL
    ELSE (
      SELECT CASE
        WHEN t ~ '1004[cd]?$'      THEN 'sfr'
        WHEN t ~ '1025$|(^|[a-z])72$'   THEN 'multi_2_4'
        WHEN t ~ '1073a?$|(^|[a-z])465$' THEN 'condo'
        ELSE NULL
      END
      FROM (SELECT regexp_replace(lower(btrim(COALESCE(v, ''))), '[[:space:]._/-]+', '', 'g') AS t) s)
  END;
$$ LANGUAGE sql IMMUTABLE;

-- ---- 4. Is an itemized reopen reason entirely COSMETIC? --------------------
-- Parses the "Label: old → new; Label: old → new" list the trigger records and
-- returns true only when EVERY item is provably a no-op under today's semantics:
--   • a term re-spelling ("12" ≡ "12 Months"), and/or
--   • a property-type re-spelling ("Multi 2-4" ≡ "Multi 2–4" ≡ "multi_2_4"),
--     or a form-code REPAIR ("FNM1025" → a real type — it was never a type).
-- ANY other item (a real money/program/units change, a real term or type change,
-- or an item shape we don't recognize) makes the whole reason non-cosmetic, so a
-- genuine re-register is never silently cleared.
CREATE OR REPLACE FUNCTION pilot_reason_is_cosmetic(detail text) RETURNS boolean AS $$
  SELECT COALESCE((
    SELECT bool_and(
      CASE
        WHEN item LIKE 'Term: %' THEN
          pilot_term_norm(substring(item from '^Term: (.*) → '))
            IS NOT DISTINCT FROM pilot_term_norm(substring(item from ' → (.*)$'))
        WHEN item LIKE 'Property type: %' THEN
          pilot_is_appraisal_form_code(substring(item from '^Property type: (.*) → '))
          OR pilot_property_type_norm(substring(item from '^Property type: (.*) → '))
             IS NOT DISTINCT FROM pilot_property_type_norm(substring(item from ' → (.*)$'))
        ELSE false
      END)
    FROM regexp_split_to_table(COALESCE(detail, ''), '; ') AS item
    WHERE btrim(item) <> ''
  ), false);
$$ LANGUAGE sql IMMUTABLE;

-- ---- 5. Re-emit the reopen trigger with the semantic property-type compare --
-- Behaviour is otherwise IDENTICAL to db/288 (same watched columns, same reopen
-- effects, same semantic term compare, same Heter Iska branch) — ONLY the two
-- property_type comparisons change from raw text to pilot_property_type_norm(),
-- with the form-code repair excluded from "changed".
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

-- ---- 6. Repair files that already store an appraisal FORM code -------------
-- "Previous AND future": a file whose property_type is a form number carries a
-- value that is not a property type at all — it corrupts the Condition Center
-- rules, the ClickUp dropdown push, the Sitewire development-type mapping and
-- every guideline that reads the category. Repaired to the category the FORM is
-- written for (1004 → 1 unit, 1025 → 2–4, 1073 → condo), audited per file. The
-- write does NOT flag the registration stale (step 5 treats it as a repair).
-- Only forms with a definite category are touched — nothing is guessed.
WITH targets AS (
  SELECT id,
         property_type AS old_pt,
         CASE pilot_appraisal_form_property_key(property_type)
           WHEN 'sfr'       THEN 'SFR (1 unit)'
           WHEN 'multi_2_4' THEN 'Multi 2–4'
           WHEN 'condo'     THEN 'Condo'
         END AS new_pt
    FROM applications
   WHERE pilot_appraisal_form_property_key(property_type) IS NOT NULL
), repaired AS (
  UPDATE applications a
     SET property_type = t.new_pt, updated_at = now()
    FROM targets t
   WHERE a.id = t.id AND t.new_pt IS NOT NULL
  RETURNING a.id, t.old_pt, t.new_pt
)
INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
SELECT 'system', NULL, 'property_type_form_code_repaired', 'application', id,
       jsonb_build_object(
         'from', old_pt, 'to', new_pt,
         'why', 'an appraisal form number was stored as the property type (db/322)')
  FROM repaired;

-- ---- 7. Heal the registrations stuck on a COSMETIC reason ------------------
-- Supersedes the narrower db/288 heal, which could only clear a Term-ONLY reason
-- (it required "NOT LIKE '%;%'"), so the owner's combined
-- "Property type: FNM1025 → Multi 2–4; Term: 12 → 12 Months" was never cleared
-- and the file kept demanding a pointless re-register. Clears ONLY when EVERY
-- itemized change is provably a no-op; any reason naming a real change is
-- untouched. Statuses and sign-offs are deliberately NOT auto-restored — a human
-- verifies and signs off again (or a super-admin waives via the exceptions box).
UPDATE product_registrations
   SET stale = false, stale_reason = NULL
 WHERE is_current AND stale
   AND stale_reason LIKE 'Pricing inputs changed — %'
   AND pilot_reason_is_cosmetic(
         substring(stale_reason from '^Pricing inputs changed — (.*)\. Re-register the product and issue a new term sheet\.$'));

-- Rewrite the misleading [auto] notes those same flips left on conditions, so
-- staff aren't told to re-register over a re-spelling or a bad-data repair.
UPDATE checklist_items
   SET notes = '[auto] This was reset earlier by a formatting-only echo (e.g. “12” vs “12 Months”, or “Multi 2-4” vs “Multi 2–4”) or by a correction of an appraisal form number that had been stored as the property type — no pricing input actually changed. Verify and sign off again; no re-register is needed for that echo.',
       updated_at = now()
 WHERE tool_key = 'product_pricing'
   AND notes LIKE '[auto] Re-register needed — %'
   AND pilot_reason_is_cosmetic(
         substring(notes from '^\[auto\] Re-register needed — (.*)\. Re-register the product in Products & Pricing'));

UPDATE checklist_items ci
   SET notes = '[auto] This was reset earlier by a formatting-only echo (e.g. “12” vs “12 Months”, or “Multi 2-4” vs “Multi 2–4”) or by a correction of an appraisal form number that had been stored as the property type — the deal economics did NOT actually change. If the signed term sheet still matches the registered terms, verify and sign off again.',
       updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id AND t.code = 'rtl_cond_signedts'
   AND ci.notes LIKE '[auto] The deal economics changed — the signed term sheet no longer matches (%'
   AND pilot_reason_is_cosmetic(
         substring(ci.notes from 'no longer matches \((.*)\)\. Generate the new term sheet'));
