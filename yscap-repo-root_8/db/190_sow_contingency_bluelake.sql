-- ============================================================================
-- 190 — 5% SOW contingency also required for a BLUE LAKE note buyer
--       (owner-directed 2026-07-20).
--
-- "Make sure the Scope of Work construction budget condition is not clearing —
--  if the note buyer is Blue Lake, it should not clear till there's a 5%
--  contingency on the budget."
--
-- Until now the 5% construction-contingency requirement applied only to files
-- registered under the Gold Standard Program (db/069 trigger + db/070 backfill +
-- the app-layer gate). This extends it to files whose NOTE BUYER (applications.
-- lender) is Blue Lake, regardless of program:
--
--   (A) CREATE OR REPLACE the db/069 belt-and-suspenders trigger function so it
--       requires the 5% contingency when the file is Gold OR its note buyer
--       normalizes to 'bluelake'. The exception message is made program/partner-
--       AGNOSTIC (a note buyer name must never surface). Everything else in the
--       guard (exact-budget matching) is preserved verbatim.
--
--   (B) Reopen the rehab-budget / Scope-of-Work condition on ACTIVE Blue Lake
--       files whose SOW lacks the 5% — mirroring the Gold backfill in db/070(B) —
--       stamped with the SAME generic [auto] note that src/lib/rehab-budget.js
--       enforceSowContingency stamps/clears, so it round-trips (and clears if the
--       note buyer later changes away from Blue Lake).
--
-- The app layer enforces the same rule (rehab-budget.sowContingencyRequired +
-- signOffGate + the register/edit/ClickUp-pull enforcement); this trigger is the
-- structural backstop for previous AND future files.
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

  -- 5% construction contingency requirement (owner-directed 2026-07-12; extended
  -- 2026-07-20): the SOW must carry a contingency of at least 5% of the
  -- construction subtotal when the file is registered Gold OR its note buyer is
  -- Blue Lake. A pct-mode contingency of >= 5 satisfies by definition; otherwise
  -- the contingency amount must be >= 5% of the subtotal (½-dollar tolerance for
  -- float noise). The tool submits `subtotal` + `contingency` amounts; a payload
  -- that carries neither those nor a pct-mode >=5 cannot prove the reserve, so it
  -- fails closed.
  SELECT program INTO prog FROM product_registrations
    WHERE application_id = NEW.application_id AND is_current LIMIT 1;
  SELECT lower(regexp_replace(COALESCE(lender, ''), '[^a-zA-Z0-9]', '', 'g'))
    INTO lender_norm FROM applications WHERE id = NEW.application_id;
  IF prog ~* 'gold' OR lender_norm = 'bluelake' THEN
    g_sub  := NULLIF(regexp_replace(COALESCE(NEW.tool_payload->>'subtotal', ''), '[^0-9.]', '', 'g'), '')::numeric;
    g_cont := NULLIF(regexp_replace(COALESCE(NEW.tool_payload->>'contingency', ''), '[^0-9.]', '', 'g'), '')::numeric;
    g_mode := NEW.tool_payload#>>'{state,cont,mode}';
    g_val  := NULLIF(regexp_replace(COALESCE(NEW.tool_payload#>>'{state,cont,value}', ''), '[^0-9.]', '', 'g'), '')::numeric;
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

-- ---------------------------------------------------------------------------
-- (B) Reopen the rehab-budget condition on ACTIVE Blue Lake note-buyer files
--     whose SOW lacks the 5% contingency. Mirrors db/070(B) but keyed on the
--     note buyer instead of the program. Idempotent: only touches currently-
--     cleared conditions (satisfied/received); a second run finds them 'issue'
--     and skips. The [auto] note text is EXACTLY '[auto] ' || SOW_CONTINGENCY_MSG
--     from src/lib/rehab-budget.js so enforceSowContingency round-trips it.
UPDATE checklist_items ci
   SET status = 'issue', signed_off_at = NULL, signed_off_by = NULL,
       reviewed_at = NULL, reviewed_by = NULL,
       notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%'
                    THEN '[auto] This loan requires at least a 5% contingency on the construction Scope of Work budget. Add a contingency of 5% or more (the builder auto-fills 5%) before this condition can be signed off. Your work is saved — reopen the Scope of Work any time to add it.'
                    ELSE ci.notes END,
       updated_at = now()
  FROM applications a
 WHERE ci.application_id = a.id
   AND a.deleted_at IS NULL
   AND a.status NOT IN ('funded', 'cancelled', 'closed', 'declined', 'withdrawn')
   AND ci.tool_key = 'rehab_budget'
   AND ci.status IN ('satisfied', 'received')
   AND lower(regexp_replace(COALESCE(a.lender, ''), '[^a-zA-Z0-9]', '', 'g')) = 'bluelake'
   AND NOT (
     -- pct-mode contingency of >= 5 satisfies by definition …
     ( (ci.tool_payload#>>'{state,cont,mode}') = 'pct'
       AND NULLIF(regexp_replace(COALESCE(ci.tool_payload#>>'{state,cont,value}',''), '[^0-9.]', '', 'g'), '')::numeric >= 5 )
     -- … or the contingency amount is >= 5% of the construction subtotal.
     OR ( NULLIF(regexp_replace(COALESCE(ci.tool_payload->>'subtotal',''), '[^0-9.]', '', 'g'), '') IS NOT NULL
          AND NULLIF(regexp_replace(ci.tool_payload->>'subtotal', '[^0-9.]', '', 'g'), '')::numeric > 0
          AND NULLIF(regexp_replace(COALESCE(ci.tool_payload->>'contingency',''), '[^0-9.]', '', 'g'), '') IS NOT NULL
          AND NULLIF(regexp_replace(ci.tool_payload->>'contingency', '[^0-9.]', '', 'g'), '')::numeric + 0.5
              >= 0.05 * NULLIF(regexp_replace(ci.tool_payload->>'subtotal', '[^0-9.]', '', 'g'), '')::numeric ) );
