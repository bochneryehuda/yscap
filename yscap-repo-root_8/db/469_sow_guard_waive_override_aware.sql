-- ============================================================================
-- 469 — SOW budget guard: honor a deliberate WAIVE / super-admin OVERRIDE
-- (owner-directed 2026-08-04).
--
-- WHY. The db/069/db/192/db/282 guard refuses to flip the rehab-budget /
-- Scope-of-Work condition to `status='satisfied'` unless the SOW balances to the
-- cent. That is exactly right for an ordinary SIGN-OFF — it stops the file
-- claiming the SOW is balanced when it isn't. But it ALSO fired on a deliberate
-- WAIVE and on the super-admin OVERRIDE (db/344), which by definition clear a
-- condition WITHOUT meeting its requirement. So "the super admin should always be
-- able to override anything" and "waive any condition" (owner-directed 2026-08-04)
-- silently failed on this one condition: the trigger RAISEd check_violation, the
-- transaction rolled back, and the route returned an opaque 500 with the condition
-- left un-waived. The new condition_waiver approval hit the same wall.
--
-- THE FIX. A write that carries the WAIVE or OVERRIDE stamps
-- (checklist_items.waived_by / override_by) is a deliberate human decision to
-- clear the condition without meeting it, so the balance guard steps aside for it.
-- An ordinary sign-off carries NEITHER stamp, so the balance check still applies
-- to it in full — the belt-and-suspenders against a bogus "balanced" claim is
-- untouched. Nothing else in the function changes: the sign-aware money parse, the
-- to-the-cent match, and the 5% contingency rule are byte-identical to db/282
-- (this file re-asserts the whole body because CREATE OR REPLACE needs it, and it
-- is numbered ABOVE db/282 so it wins each boot — keep the parse logic below in
-- step with db/282 if that ever changes).
--
-- Idempotent (CREATE OR REPLACE); safe to re-run on every boot.
-- ============================================================================

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

  -- A deliberate WAIVE or super-admin OVERRIDE clears the condition WITHOUT meeting
  -- its requirement (owner-directed 2026-08-04). The balance guard exists to stop an
  -- ordinary SIGN-OFF from claiming the SOW is balanced when it isn't — it must not
  -- block an explicit decision to waive/override it. Detected by the stamps the
  -- write carries; an ordinary sign-off has NEITHER, so it is still fully gated.
  IF NEW.waived_by IS NOT NULL OR NEW.override_by IS NOT NULL THEN
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

-- Re-assert the trigger idempotently (db/069 created it; unchanged shape).
DROP TRIGGER IF EXISTS trg_sow_budget_guard ON checklist_items;
CREATE TRIGGER trg_sow_budget_guard
  BEFORE INSERT OR UPDATE ON checklist_items
  FOR EACH ROW
  EXECUTE FUNCTION sow_budget_guard();
