-- ============================================================================
-- 382 - The deal program is NEVER blank — it defaults to Fix & Flip
--       (owner-directed 2026-07-30; reported card FILLE-2015 / 423 Rutland Rd).
--
-- A file's deal-type program (applications.program: Fix & Flip / Fix & Hold /
-- Bridge / Ground-Up) is a HUMAN choice, and the borrower application offers a
-- "Not sure yet" option. Both a blank program and "Not sure yet" map to an EMPTY
-- ClickUp *Program box (crosswalk 'Not sure yet' -> null, on purpose) — so a file
-- the borrower left on "Not sure yet" (or never set) reached ClickUp with no
-- Program even after it was priced and registered as a renovation loan. Nothing
-- ever forced it to be resolved, so it sailed all the way through blank, and the
-- ClickUp workload automation then mis-classified it as "Long Term".
--
-- The owner's rule: "by default everything is a Fix & Flip — if you don't know
-- from the application whether it's a Fix & Flip or a Fix & Hold, just put it in
-- as a Fix & Flip. Once you know it's a Fix & Hold or a Ground-Up you can change
-- it any time and it syncs bidirectionally like everything else."
--
-- So the program defaults to 'Fix & Flip w/ Construction' whenever it is blank or
-- "Not sure yet", on EVERY write path (a BEFORE trigger is the one chokepoint
-- that catches the borrower application, the staff new-file form, the public
-- intake, AND the ClickUp materialize path at once), and previous files are
-- back-filled. The existing bidirectional ClickUp sync (mapper FIELD_MAP
-- program, dir:'both') then carries a later change to Fix & Hold / Ground-Up in
-- either direction, unchanged.
--
-- FROZEN-PRICING SAFE: the frozen engine already prices a blank / "Not sure yet"
-- program AS a Fix & Flip — src/lib/pricing.js engineStrategy() maps '', 'not
-- sure …' AND 'Fix & Flip w/ Construction' all to the SAME strategy 'Fix &
-- Flip'. So setting the label to 'Fix & Flip w/ Construction' changes NO pricing
-- number. To keep the P&P re-price trigger from firing on this label-only
-- change, the trigger below compares the program BY MEANING via
-- pilot_program_norm() — the SQL twin of engineStrategy() — so 'Not sure yet' and
-- 'Fix & Flip w/ Construction' are equal and never reopen Products & Pricing,
-- while a real Fix & Flip -> Fix & Hold change still does. This mirrors the
-- term (db/288) / property_type (db/322) / state (db/326) semantic-compare
-- pattern already in this same trigger.
-- ============================================================================

-- The program MEANING key — the SQL twin of src/lib/pricing.js engineStrategy().
-- Keep the branch ORDER identical to engineStrategy() (blank/not-sure -> flip
-- first, then bridge, ground, hold, flip, else the value itself), so PILOT never
-- disagrees with the engine about whether two program labels are the same deal.
CREATE OR REPLACE FUNCTION pilot_program_norm(p text) RETURNS text AS $$
DECLARE x text := lower(btrim(coalesce(p, '')));
BEGIN
  IF x = '' OR position('not sure' in x) > 0 THEN RETURN 'flip'; END IF;
  IF position('bridge' in x) > 0 OR position('stabil' in x) > 0 THEN RETURN 'bridge'; END IF;
  IF position('ground' in x) > 0 THEN RETURN 'ground'; END IF;
  IF position('hold' in x) > 0 OR position('brrrr' in x) > 0 THEN RETURN 'hold'; END IF;
  IF position('flip' in x) > 0 THEN RETURN 'flip'; END IF;
  RETURN x;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Default a blank / "Not sure yet" program to Fix & Flip on EVERY write path.
-- BEFORE INSERT catches file creation from the borrower app, the staff new-file
-- form, the public intake and the ClickUp materialize path; BEFORE UPDATE OF
-- program heals a value edited (or COALESCE-touched by the inbound sync) to blank.
CREATE OR REPLACE FUNCTION default_deal_program() RETURNS trigger AS $$
BEGIN
  IF NEW.program IS NULL OR btrim(NEW.program) = '' OR lower(btrim(NEW.program)) = 'not sure yet' THEN
    NEW.program := 'Fix & Flip w/ Construction';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_default_deal_program ON applications;
CREATE TRIGGER trg_default_deal_program
  BEFORE INSERT OR UPDATE OF program ON applications
  FOR EACH ROW
  EXECUTE FUNCTION default_deal_program();

-- Re-create the P&P / Scope-of-Work / term-sheet / Iska re-price trigger
-- function. This is db/373's authoritative version verbatim EXCEPT the two
-- `program` comparisons, which now go through pilot_program_norm() so the
-- Fix-&-Flip default above (a label-only, pricing-neutral change) never reopens
-- Products & Pricing or itemizes a phantom "Program: Not sure yet → Fix & Flip"
-- line. A genuine deal-type change (Fix & Flip -> Fix & Hold / Bridge / Ground-Up)
-- changes the engine strategy, so it still reopens exactly as before. Every other
-- line is identical to db/373 — do not drop the SoW-scope, semantic term/type/
-- state compares, stale-registration marking, or the term-sheet / Iska reopens.
CREATE OR REPLACE FUNCTION reopen_conditions_on_budget_change() RETURNS trigger AS $$
DECLARE
  budget_changed  boolean;
  scope_changed   boolean;
  pricing_changed boolean;
  ptype_changed   boolean;
  prog_changed    boolean;
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
    -- Itemized only on a SEMANTIC program change (db/381) — never on the
    -- Fix-&-Flip default.
    IF prog_changed THEN
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

-- Previous files: default every blank / "Not sure yet" program to Fix & Flip so
-- no existing file keeps an empty ClickUp *Program. Reprice-neutral by the
-- meaning-aware trigger above, so no Products & Pricing condition is reopened.
-- Idempotent: after the first run there is no blank/"Not sure yet" program left
-- to match. (The go-forward ClickUp card fill is done by the boot one-shot
-- backfillDefaultProgramPushOnce() in src/sync/clickup-sync.js.)
INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
  SELECT 'system', NULL, 'deal_program_defaulted', 'application', id,
         jsonb_build_object('from', program, 'to', 'Fix & Flip w/ Construction',
           'why', 'blank / "Not sure yet" deal program defaulted to Fix & Flip so the ClickUp Program is never empty (owner-directed 2026-07-30)')
    FROM applications
   WHERE deleted_at IS NULL
     AND (program IS NULL OR btrim(program) = '' OR lower(btrim(program)) = 'not sure yet');

UPDATE applications
   SET program = 'Fix & Flip w/ Construction'
 WHERE deleted_at IS NULL
   AND (program IS NULL OR btrim(program) = '' OR lower(btrim(program)) = 'not sure yet');
