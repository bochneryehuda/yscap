-- 288 — Compare the loan TERM by MEANING, not by spelling (owner-reported 2026-07-24).
--
-- THE BUG: applications.term is TEXT and different doors write the SAME term in
-- different spellings — the ClickUp dropdown stores "12 Months", while the
-- product-registration write-back stored the bare parsed number "12". The reopen
-- trigger (live body: db/280) compared the RAW text (NEW.term IS DISTINCT FROM
-- OLD.term), so a ClickUp echo / details-form save of the very same term flagged
-- the current registration STALE with the absurd reason "Pricing inputs changed —
-- Term: 12 → 12 Months" and demanded a re-register. Re-registering wrote "12"
-- again, the next echo wrote "12 Months" again — an endless re-register loop on a
-- term that never changed.
--
-- THE ROOT FIX (this file + src/lib/term-text.js):
--   1. pilot_term_norm(text) — ONE semantic key for a term text ("12" ≡ "12
--      Months" ≡ "12-month"; "30 year" → 360; word-only values compare as words).
--      The JS twin is termKey() in src/lib/term-text.js — KEEP THEM IN SYNC.
--   2. The reopen trigger now compares pilot_term_norm(OLD.term) vs
--      pilot_term_norm(NEW.term): a formatting-only rewrite can NEVER flag the
--      registration stale again, from ANY writer (portal, ClickUp, future code).
--      A REAL term change (12 → 18 months) still trips it exactly as before.
--   3. One-shot heal of files stuck TODAY: clear the stale flag where the
--      recorded reason is a Term-ONLY change whose two sides mean the same term,
--      and rewrite the matching misleading "[auto] Re-register needed" /
--      "no longer matches" notes. Condition statuses / sign-offs are NOT
--      auto-restored — a human verifies and signs off (or a super-admin waives).
--   (The app layer also stops CAUSING the flip: the registration write-back now
--    preserves the file's existing term text when it already means the registered
--    month count — src/lib/product-registration.js.)
--
-- Additive + idempotent: CREATE OR REPLACE for both functions; the heal UPDATEs
-- match only the broken pattern and rewrite it, so a second boot finds 0 rows.

-- ---- 1. The semantic term key --------------------------------------------
-- '12' / '12 Months' / '12-month' / '12mo' → '12'    (leading number = months)
-- '30 year' / '30 Years' / '2 yrs'         → '360'/'24' (years ×12, so a year
--                                             term never collides with months)
-- 'Interest only' / 'Other'                → lower-cased words
-- NULL / '' / '   '                        → NULL
CREATE OR REPLACE FUNCTION pilot_term_norm(v text) RETURNS text AS $$
  SELECT CASE
    WHEN v IS NULL OR btrim(v) = '' THEN NULL
    WHEN btrim(v) ~* '^\d+(\.\d+)?\s*(years?|yrs?|y)\M' THEN
      (round((substring(btrim(v) from '^(\d+(\.\d+)?)'))::numeric * 12))::text
    -- ::numeric::text strips leading zeros ('012' → '12') so the key matches the
    -- JS twin (termKey uses parseInt) even on a hand-typed zero-padded spelling.
    WHEN btrim(v) ~ '^\d' THEN (substring(btrim(v) from '^(\d+)'))::numeric::text
    ELSE lower(btrim(v))
  END;
$$ LANGUAGE sql IMMUTABLE;

-- ---- 2. Re-emit the reopen trigger (db/280 body) with the semantic compare ----
-- Behaviour is otherwise IDENTICAL to db/280 (same watched columns, same reopen
-- effects, same Heter Iska branch) — ONLY the two term comparisons change from
-- raw text to pilot_term_norm().
CREATE OR REPLACE FUNCTION reopen_conditions_on_budget_change() RETURNS trigger AS $$
DECLARE
  budget_changed  boolean;
  scope_changed   boolean;
  pricing_changed boolean;
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

  pricing_changed := scope_changed
    OR NEW.loan_amount               IS DISTINCT FROM OLD.loan_amount
    OR NEW.purchase_price            IS DISTINCT FROM OLD.purchase_price
    OR NEW.as_is_value               IS DISTINCT FROM OLD.as_is_value
    OR NEW.arv                       IS DISTINCT FROM OLD.arv
    OR NEW.loan_type                 IS DISTINCT FROM OLD.loan_type
    OR NEW.program                   IS DISTINCT FROM OLD.program
    OR NEW.property_type             IS DISTINCT FROM OLD.property_type
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
    IF NEW.property_type IS DISTINCT FROM OLD.property_type THEN
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

-- ---- 3. One-shot heal of files stuck on the cosmetic flip ------------------
-- Clear the stale flag ONLY where the recorded reason itself proves the change
-- was a Term-ONLY re-spelling: the reason names exactly one change ("Term: a →
-- b", no ';' separator) and both sides normalize to the same semantic term. A
-- reason listing any REAL change (or a real term change) never matches.
-- KNOWN LIMIT (audit 2026-07-24): the db/190–280 itemizer never itemized a few
-- watched columns (rehab_type, sqft, property state, co-borrower, markups,
-- requested experience) — a single UPDATE combining a cosmetic term echo with
-- one of THOSE real changes also produced a Term-only reason, which this heal
-- clears. Safe because the same event reopened the Products & Pricing +
-- signed-term-sheet conditions and this heal deliberately restores NO statuses/
-- sign-offs — a human still re-verifies before the gate passes, and any next
-- real change re-flags under the (now semantic) trigger.
UPDATE product_registrations
   SET stale = false, stale_reason = NULL
 WHERE is_current AND stale
   AND stale_reason LIKE 'Pricing inputs changed — Term: %'
   AND stale_reason NOT LIKE '%;%'
   AND pilot_term_norm(substring(stale_reason from '^Pricing inputs changed — Term: (.*) → ')) IS NOT NULL
   AND pilot_term_norm(substring(stale_reason from '^Pricing inputs changed — Term: (.*) → '))
       IS NOT DISTINCT FROM
       pilot_term_norm(substring(stale_reason from ' → (.*)\. Re-register the product and issue a new term sheet\.$'));

-- Rewrite the misleading [auto] notes those same flips left on conditions, so
-- staff aren't told to re-register over a re-spelling. Statuses and sign-offs are
-- deliberately NOT auto-restored — a human verifies and signs off again (or a
-- super-admin waives via the exceptions box).
UPDATE checklist_items
   SET notes = '[auto] A formatting-only term echo (e.g. “12” vs “12 Months”) reset this earlier — no pricing input actually changed. Verify and sign off again; no re-register is needed for that echo.',
       updated_at = now()
 WHERE tool_key = 'product_pricing'
   AND notes LIKE '[auto] Re-register needed — Term: %'
   AND notes NOT LIKE '%;%'
   AND pilot_term_norm(substring(notes from '^\[auto\] Re-register needed — Term: (.*) → ')) IS NOT NULL
   AND pilot_term_norm(substring(notes from '^\[auto\] Re-register needed — Term: (.*) → '))
       IS NOT DISTINCT FROM
       pilot_term_norm(substring(notes from ' → (.*)\. Re-register the product in Products & Pricing'));

UPDATE checklist_items ci
   SET notes = '[auto] A formatting-only term echo (e.g. “12” vs “12 Months”) reset this earlier — the deal economics did NOT actually change. If the signed term sheet still matches the registered terms, verify and sign off again.',
       updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id AND t.code = 'rtl_cond_signedts'
   AND ci.notes LIKE '[auto] The deal economics changed — the signed term sheet no longer matches (Term: %'
   AND ci.notes NOT LIKE '%;%'
   AND pilot_term_norm(substring(ci.notes from 'no longer matches \(Term: (.*) → ')) IS NOT NULL
   AND pilot_term_norm(substring(ci.notes from 'no longer matches \(Term: (.*) → '))
       IS NOT DISTINCT FROM
       pilot_term_norm(substring(ci.notes from ' → (.*)\)\. Generate the new term sheet'));
