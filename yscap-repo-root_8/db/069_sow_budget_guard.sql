-- ============================================================================
-- 069 - Scope-of-Work budget guard (belt-and-suspenders, owner-directed 2026-07-10)
--
-- The rehab-budget / Scope-of-Work condition may ONLY be marked completed
-- ('satisfied') when the numbers agree to the CENT:
--     first-page construction budget  (tool_payload.state.target, if set)
--   = last-page line-item grand total (tool_payload.total)
--   = the file's rehab budget         (applications.rehab_budget)
--   = the registered product's budget (product_registrations.inputs.rehabBudget)
--
-- The application layer already enforces this at sign-off (src/routes/staff.js
-- `signOffGate`). This migration adds a DATABASE-LEVEL backstop so the condition
-- can never be flipped to 'satisfied' with mismatched numbers by ANY path — a
-- future endpoint, a bulk update, a direct SQL write. Defense in depth: if the
-- app gate is ever bypassed, Postgres refuses the write.
--
-- Applies to PREVIOUS and FUTURE files alike: the trigger fires on every future
-- write to any budget condition regardless of file age. Existing rows at rest
-- are untouched; a narrow, safe backfill at the bottom only reopens budget
-- conditions that were marked 'satisfied' WITHOUT a real sign-off and whose
-- current SOW total does not match (an anomaly — real completions are signed).
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
  -- tolerantly from the saved payload ("$75,000" / "75000" / 75000 all → 75000).
  sow_total := NULLIF(regexp_replace(COALESCE(NEW.tool_payload->>'total', ''), '[^0-9.]', '', 'g'), '')::numeric;
  fp_target := NULLIF(regexp_replace(COALESCE(NEW.tool_payload#>>'{state,target}', ''), '[^0-9.]', '', 'g'), '')::numeric;

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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sow_budget_guard ON checklist_items;
CREATE TRIGGER trg_sow_budget_guard
  BEFORE INSERT OR UPDATE ON checklist_items
  FOR EACH ROW
  EXECUTE FUNCTION sow_budget_guard();

-- ---------------------------------------------------------------------------
-- Safe, idempotent backfill (previous files). Reopen ONLY budget conditions
-- that are 'satisfied' but were never actually signed off (signed_off_at IS
-- NULL) and whose current SOW line-item total does not match the file budget.
-- Legitimate completions always carry a sign-off, so this only cleans up
-- anomalous rows; it never disturbs a real, signed-off completion. We do NOT
-- retroactively reopen SIGNED-OFF conditions on funded/closed files — those went
-- through the exact-match gate at sign-off time and reopening them would corrupt
-- a completed loan's audit trail. Going forward the trigger + `signOffGate`
-- enforce the match for previous and future files alike.
UPDATE checklist_items ci
   SET status = 'issue', updated_at = now()
  FROM applications a
 WHERE ci.application_id = a.id
   AND a.deleted_at IS NULL
   AND ci.status = 'satisfied'
   AND ci.signed_off_at IS NULL
   AND ( (SELECT code FROM checklist_templates t WHERE t.id = ci.template_id) = 'rtl_p1_budget'
         OR ci.tool_key = 'rehab_budget' )
   AND ci.tool_payload IS NOT NULL
   AND NULLIF(regexp_replace(COALESCE(ci.tool_payload->>'total',''), '[^0-9.]', '', 'g'), '') IS NOT NULL
   AND round( NULLIF(regexp_replace(ci.tool_payload->>'total', '[^0-9.]', '', 'g'), '')::numeric * 100 )
       <> round( COALESCE(
             NULLIF( (SELECT (inputs->>'rehabBudget')::numeric FROM product_registrations
                        WHERE application_id = a.id AND is_current
                          AND inputs ? 'rehabBudget'
                          AND (inputs->>'rehabBudget') ~ '^[0-9]+(\.[0-9]+)?$' LIMIT 1), 0),
             NULLIF(a.rehab_budget, 0) ) * 100 );
