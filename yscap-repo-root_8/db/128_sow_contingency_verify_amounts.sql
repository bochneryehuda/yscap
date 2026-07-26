-- 128 — SOW budget guard: verify the 5% Gold contingency by the REAL amounts,
--       never a self-declared pct-mode flag (audit #57, owner-directed 2026-07-17).
--
-- The db/069 guard accepted `state.cont.mode = 'pct' AND value >= 5` on its own,
-- WITHOUT checking that the submitted subtotal/contingency dollars actually carry
-- the 5%. A hand-crafted payload (never produced by the tool) could claim pct-mode
-- 5% with $0 real contingency and pass. This re-creates sow_budget_guard() so that
-- when a construction subtotal is present the dollar amounts are AUTHORITATIVE
-- (deriving the contingency from pct × subtotal when no explicit amount is given),
-- and the pct-mode claim is honored ONLY for a legacy payload with no usable
-- subtotal. Every other budget check is byte-identical to 069. The 5% RULE itself
-- is unchanged — the contingency still lives inside the frozen budget.

CREATE OR REPLACE FUNCTION sow_budget_guard() RETURNS trigger AS $$
DECLARE
  tmpl_code   text;
  is_budget   boolean;
  app_budget  numeric;
  reg_budget  numeric;
  req         numeric;
  sow_total   numeric;
  fp_target   numeric;
  prog        text;
  g_sub       numeric;
  g_cont      numeric;
  g_mode      text;
  g_val       numeric;
BEGIN
  IF NEW.status IS DISTINCT FROM 'satisfied' THEN
    RETURN NEW;
  END IF;

  SELECT code INTO tmpl_code FROM checklist_templates WHERE id = NEW.template_id;
  is_budget := (COALESCE(tmpl_code, '') = 'rtl_p1_budget')
            OR (COALESCE(NEW.tool_key, '') = 'rehab_budget');
  IF NOT is_budget THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status IS NOT DISTINCT FROM 'satisfied'
     AND OLD.tool_payload IS NOT DISTINCT FROM NEW.tool_payload THEN
    RETURN NEW;
  END IF;

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
  IF fp_target IS NOT NULL AND fp_target <> 0
     AND round(fp_target * 100) <> round(req * 100) THEN
    RAISE EXCEPTION 'SOW budget guard: the first-page construction budget % does not equal the required rehab budget % (must match to the cent).', fp_target, req
      USING ERRCODE = 'check_violation';
  END IF;

  -- Gold 5% contingency — verified by REAL amounts (audit #57). The contingency is
  -- the explicit amount, else pct-mode value × subtotal. When a subtotal is present
  -- the dollars are authoritative; a bare pct-mode claim is honored ONLY when there
  -- is no usable subtotal to check against.
  SELECT program INTO prog FROM product_registrations
    WHERE application_id = NEW.application_id AND is_current LIMIT 1;
  IF prog ~* 'gold' THEN
    g_sub  := NULLIF(regexp_replace(COALESCE(NEW.tool_payload->>'subtotal', ''), '[^0-9.]', '', 'g'), '')::numeric;
    g_cont := NULLIF(regexp_replace(COALESCE(NEW.tool_payload->>'contingency', ''), '[^0-9.]', '', 'g'), '')::numeric;
    g_mode := NEW.tool_payload#>>'{state,cont,mode}';
    g_val  := NULLIF(regexp_replace(COALESCE(NEW.tool_payload#>>'{state,cont,value}', ''), '[^0-9.]', '', 'g'), '')::numeric;
    IF g_cont IS NULL AND g_mode = 'pct' AND g_val IS NOT NULL AND g_sub IS NOT NULL THEN
      g_cont := g_sub * g_val / 100.0;
    END IF;
    IF NOT (
         (g_sub IS NOT NULL AND g_sub > 0 AND g_cont IS NOT NULL AND g_cont + 0.5 >= 0.05 * g_sub)
         OR ((g_sub IS NULL OR g_sub <= 0) AND g_mode = 'pct' AND g_val IS NOT NULL AND g_val >= 5)
       ) THEN
      RAISE EXCEPTION 'SOW budget guard: the Gold Standard Program requires at least a 5%% construction contingency on the Scope of Work.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
