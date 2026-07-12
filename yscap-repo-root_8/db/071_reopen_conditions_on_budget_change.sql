-- ============================================================================
-- 071 - Budget change reopens the P&P registration + Scope-of-Work conditions
--       (owner-directed 2026-07-12)
--
-- The authoritative construction budget is applications.rehab_budget. It can
-- change from ANY side — the borrower or staff editing the application, the
-- ClickUp inbound sync (constructionBudget ↔ rehab_budget), or a product
-- re-register. Whenever it actually changes, two conditions must resurface, even
-- if they were already signed off:
--   · product_pricing — the registered structure was priced off the old budget,
--     so the product must be re-registered / re-structured.
--   · rehab_budget (Scope of Work) — the SOW must be rewritten to match the new
--     budget exactly (and, for Gold, keep its 5% contingency).
--
-- A DB trigger is the only way to catch EVERY write path centrally (all sides).
-- It fires AFTER UPDATE OF rehab_budget and only when the value truly changes;
-- it reopens ONLY conditions that were previously cleared, so it never churns an
-- already-open condition. Forward-looking behavior — no backfill (there is no
-- historical "change" to react to).
-- ============================================================================

CREATE OR REPLACE FUNCTION reopen_conditions_on_budget_change() RETURNS trigger AS $$
BEGIN
  IF NEW.rehab_budget IS DISTINCT FROM OLD.rehab_budget THEN
    -- Product & Pricing: a registered product priced off the old budget is now
    -- stale — reopen for re-registration (only when it had been cleared).
    UPDATE checklist_items
       SET status = 'received', signed_off_at = NULL, signed_off_by = NULL,
           reviewed_at = NULL, reviewed_by = NULL,
           notes = CASE WHEN notes IS NULL OR notes LIKE '[auto]%'
                        THEN '[auto] The construction budget changed — re-register the product in Products & Pricing so the structure matches the new budget.'
                        ELSE notes END,
           updated_at = now()
     WHERE application_id = NEW.id
       AND tool_key = 'product_pricing'
       AND (status = 'satisfied' OR signed_off_at IS NOT NULL);

    -- Scope of Work: must be rewritten to total the new budget exactly — reopen
    -- (only when it had been cleared) so it can't stay signed off against a stale
    -- budget. The SOW exact-match + Gold-contingency gates enforce the rest.
    UPDATE checklist_items
       SET status = 'issue', signed_off_at = NULL, signed_off_by = NULL,
           reviewed_at = NULL, reviewed_by = NULL,
           notes = CASE WHEN notes IS NULL OR notes LIKE '[auto]%'
                        THEN '[auto] The construction budget changed — update the Scope of Work so it totals the new budget exactly before this condition can be signed off.'
                        ELSE notes END,
           updated_at = now()
     WHERE application_id = NEW.id
       AND tool_key = 'rehab_budget'
       AND (status IN ('satisfied', 'received') OR signed_off_at IS NOT NULL);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reopen_on_budget_change ON applications;
CREATE TRIGGER trg_reopen_on_budget_change
  AFTER UPDATE OF rehab_budget ON applications
  FOR EACH ROW
  EXECUTE FUNCTION reopen_conditions_on_budget_change();
