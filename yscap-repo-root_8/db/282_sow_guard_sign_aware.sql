-- ============================================================================
-- 282 — SOW budget guard: SIGN-AWARE money parsing (audit follow-up 2026-07-23).
--
-- The db/069/db/192 guard parsed payload money with
--   regexp_replace(v, '[^0-9.]', '', 'g')
-- which STRIPS a minus sign — so a sign-flipped line-item total (-80000 on an
-- 80000 budget) or a negative contingency read as positive and could satisfy
-- the trigger layer. The JS layer (src/lib/rehab-budget.js toNum, fixed the
-- same day) already rejects these before any DB write, so this only restores
-- parity for a DIRECT SQL write. Frozen behavior is untouched: for every
-- non-negative input the parse below extracts the exact same digits as before;
-- only values that are actually negative (leading '-', '$-', or accounting
-- parens) now stay negative and therefore fail the existing to-the-cent /
-- 5%-contingency checks. No threshold, tolerance, or budget number changes.
--
-- Idempotent (CREATE OR REPLACE); safe to re-run on every boot.
-- ============================================================================

-- Sign-preserving tolerant money parse ("$75,000.50" → 75000.50, "-5,000" /
-- "$-5,000" / "(5,000)" → -5000, blank/unparseable → NULL).
CREATE OR REPLACE FUNCTION sow_money(v text) RETURNS numeric AS $$
DECLARE
  raw    text := COALESCE(v, '');
  digits text;
  n      numeric;
BEGIN
  digits := NULLIF(regexp_replace(raw, '[^0-9.]', '', 'g'), '');
  IF digits IS NULL THEN RETURN NULL; END IF;
  n := digits::numeric;
  IF (raw ~ '^\s*\(.*\)\s*$') OR (raw ~ '^[^0-9]*-') THEN
    RETURN -n;
  END IF;
  RETURN n;
EXCEPTION WHEN others THEN
  RETURN NULL;  -- e.g. '1.2.3' — unusable, treated as absent (guard fails closed on total)
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION sow_budget_guard() RETURNS trigger AS $$
DECLARE
  tmpl_code   text;
  is_budget   boolean;
  app_budget  numeric;
  reg_budget  numeric;
  req         numeric;
  sow_total   numeric;
  fp_target   numeric;
  prog        text;      -- registered program (gold/standard) for the contingency rule
  lender_norm text;      -- normalized note buyer (bluelake) for the contingency rule
  g_sub       numeric;   -- construction subtotal on the SOW
  g_cont      numeric;   -- contingency amount on the SOW
  g_mode      text;      -- contingency input mode (pct/amount)
  g_val       numeric;   -- contingency input value
BEGIN
  -- Only ever gate the COMPLETION state of a condition.
  IF NEW.status IS DISTINCT FROM 'satisfied' THEN
    RETURN NEW;
  END IF;

  -- Only gate the rehab-budget / Scope-of-Work condition. COALESCE is essential:
  -- most conditions have a NULL tool_key, and `false OR NULL` is NULL in SQL, so
  -- `IF NOT is_budget` would NOT fire and the guard would wrongly block EVERY
  -- non-budget condition from being satisfied. Coercing to '' keeps is_budget a
  -- true boolean.
  SELECT code INTO tmpl_code FROM checklist_templates WHERE id = NEW.template_id;
  is_budget := (COALESCE(tmpl_code, '') = 'rtl_p1_budget')
            OR (COALESCE(NEW.tool_key, '') = 'rehab_budget');
  IF NOT is_budget THEN
    RETURN NEW;
  END IF;

  -- Only re-check on a genuine (re)completion: becoming satisfied, or re-saving
  -- the SOW payload while satisfied. Never block an unrelated touch (notes,
  -- assignee, review stamp) on a row that is ALREADY satisfied with an unchanged
  -- payload — that would turn the guard into a landmine on every later edit.
  IF TG_OP = 'UPDATE'
     AND OLD.status IS NOT DISTINCT FROM 'satisfied'
     AND OLD.tool_payload IS NOT DISTINCT FROM NEW.tool_payload THEN
    RETURN NEW;
  END IF;

  -- llc-scoped or file-less items never reach here as budget conditions, but be
  -- defensive: nothing to match against without a file.
  IF NEW.application_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT rehab_budget INTO app_budget FROM applications WHERE id = NEW.application_id;
  SELECT (inputs->>'rehabBudget')::numeric INTO reg_budget
    FROM product_registrations
   WHERE application_id = NEW.application_id AND is_current
     AND inputs ? 'rehabBudget'
     AND (inputs->>'rehabBudget') ~ '^[0-9]+(\.[0-9]+)?$'
   LIMIT 1;

  req := COALESCE(NULLIF(reg_budget, 0), NULLIF(app_budget, 0));
  IF req IS NULL OR req = 0 THEN
    RAISE EXCEPTION 'SOW budget guard: the rehab-budget condition cannot be completed — the file has no rehab budget to match against.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Line-item grand total (last page) and first-page construction budget, parsed
  -- tolerantly AND sign-aware ("$75,000" / "75000" / 75000 all → 75000; a
  -- negative or parenthesized value stays negative and can never match).
  sow_total := sow_money(NEW.tool_payload->>'total');
  fp_target := sow_money(NEW.tool_payload#>>'{state,target}');

  IF sow_total IS NULL THEN
    RAISE EXCEPTION 'SOW budget guard: no Scope of Work total on the condition — it cannot be completed.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF round(sow_total * 100) <> round(req * 100) THEN
    RAISE EXCEPTION 'SOW budget guard: line-item total % does not equal the required rehab budget % (must match to the cent).', sow_total, req
      USING ERRCODE = 'check_violation';
  END IF;
  IF reg_budget IS NOT NULL AND app_budget IS NOT NULL
     AND round(reg_budget * 100) <> round(app_budget * 100) THEN
    RAISE EXCEPTION 'SOW budget guard: the file budget % and the registered product budget % disagree.', app_budget, reg_budget
      USING ERRCODE = 'check_violation';
  END IF;
  -- First-page construction budget is optional in the tool; gate only when set.
  IF fp_target IS NOT NULL AND fp_target <> 0
     AND round(fp_target * 100) <> round(req * 100) THEN
    RAISE EXCEPTION 'SOW budget guard: the first-page construction budget % does not equal the required rehab budget % (must match to the cent).', fp_target, req
      USING ERRCODE = 'check_violation';
  END IF;

  -- 5% construction contingency requirement (owner-directed 2026-07-12; extended
  -- 2026-07-20): the SOW must carry a contingency of at least 5% of the
  -- construction subtotal when the file is registered Gold OR its note buyer is
  -- Blue Lake. A pct-mode contingency of >= 5 satisfies by definition; otherwise
  -- the contingency amount must be >= 5% of the subtotal (½-dollar tolerance for
  -- float noise). The tool submits `subtotal` + `contingency` amounts; a payload
  -- that carries neither those nor a pct-mode >=5 cannot prove the reserve, so it
  -- fails closed. Sign-aware parsing: a NEGATIVE contingency/subtotal/pct can
  -- never satisfy (matches the JS layer).
  SELECT program INTO prog FROM product_registrations
    WHERE application_id = NEW.application_id AND is_current LIMIT 1;
  SELECT lower(regexp_replace(COALESCE(lender, ''), '[^a-zA-Z0-9]', '', 'g'))
    INTO lender_norm FROM applications WHERE id = NEW.application_id;
  IF prog ~* 'gold' OR lender_norm = 'bluelake' THEN
    g_sub  := sow_money(NEW.tool_payload->>'subtotal');
    g_cont := sow_money(NEW.tool_payload->>'contingency');
    g_mode := NEW.tool_payload#>>'{state,cont,mode}';
    g_val  := sow_money(NEW.tool_payload#>>'{state,cont,value}');
    IF NOT ( (g_mode = 'pct' AND g_val IS NOT NULL AND g_val >= 5)
             OR (g_sub IS NOT NULL AND g_sub > 0 AND g_cont IS NOT NULL AND g_cont + 0.5 >= 0.05 * g_sub) ) THEN
      RAISE EXCEPTION 'SOW budget guard: this loan requires at least a 5%% construction contingency on the Scope of Work.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger definition itself is unchanged (db/069 created it); re-assert idempotently.
DROP TRIGGER IF EXISTS trg_sow_budget_guard ON checklist_items;
CREATE TRIGGER trg_sow_budget_guard
  BEFORE INSERT OR UPDATE ON checklist_items
  FOR EACH ROW
  EXECUTE FUNCTION sow_budget_guard();
