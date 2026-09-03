-- ============================================================================
-- db/691 — a bridge WITHOUT construction carries no budget / scope-of-work conditions
--
-- WHAT THIS CHANGES, AND WHY. Owner-directed 2026-09-03, RTL: *"when somebody
-- is putting in a bridge loan without construction, the condition still pops up
-- for him to put in a construction budget scope of work. That condition should
-- be removed from what's populating on a bridge loan. It's still populated on
-- fix and hold, fix and flip, and ground up."*
--
-- The three conditions are legacy (`auto_apply IS NULL`) templates that
-- `generateChecklist` attaches to EVERY rtl file: `rtl_p1_budget` (the budget),
-- `rtl_p3_sow1` (the scope of work from the borrower) and `rtl_p3_sow2` (the SOW
-- to the appraiser). A bridge that builds nothing was asked for all three.
--
-- THE SAME SHAPE AS db/178 (the ground-up "Plans & permits" condition): ONE
-- predicate, `pilot_bridge_without_construction()`, whose JS twin is
-- `src/lib/conditions/bridge-construction.js` (`generateChecklist` uses it at
-- creation; `scripts/test-bridge-construction-db.js` proves the two agree); a
-- trigger on `applications` that takes the three OFF a file that becomes such a
-- bridge and puts them BACK on one that stops being one — on every change to
-- the four columns that decide it; and a backfill for the existing book.
--
-- ONLY AN UNTOUCHED CONDITION IS TAKEN OFF. A budget somebody has already
-- uploaded, signed off or waived is a person's work, and a program edit must
-- not make it vanish — those rows stay (a document row's
-- `checklist_item_id` is ON DELETE SET NULL, but "unlinked" is still "gone" to
-- the person who filed it). "Untouched" = outstanding/requested, no sign-off,
-- no waiver, no document.
--
-- WHAT "WITHOUT CONSTRUCTION" MEANS, in the frozen engine's own order (see the
-- JS twin): not ground-up, not a long-term strategy, not fix & hold, a program
-- that says "bridge", NOT one that says "with construction", and no rehab
-- budget typed on the file. `rehab_type` is deliberately not read as evidence
-- of construction (the 2026-08-26 feasibility-fee lesson: a bridge routinely
-- still says "Heavy" because the studio hides that control rather than
-- clearing it).
--
-- IDEMPOTENT. CREATE OR REPLACE FUNCTION; DROP TRIGGER IF EXISTS + CREATE; the
-- backfill deletes only what qualifies and finds nothing on the second run.
--
-- BACKFILL: yes — the untouched three are removed from every existing bridge
-- file without construction, by the same predicate the trigger uses.
--
-- PRODUCT SEPARATION. `applications`, `checklist_items`, `checklist_templates`
-- — RTL's rows on the shared Condition Center table. No `lt_*` is read or
-- written.
-- ============================================================================

CREATE OR REPLACE FUNCTION pilot_bridge_without_construction(
  p_program text, p_loan_type text, p_rehab_type text, p_rehab_budget numeric
) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN t ~ 'ground' OR (t ~ 'construction' AND t ~ 'new') THEN false            -- ground-up first (the engine's order)
    WHEN t ~ '(dscr|rental|stabilized|long[-[:space:]]?term|30[-[:space:]]?year)' THEN false  -- not a short-term strategy
    WHEN t ~ '(hold|brrrr)' THEN false                                           -- fix & hold builds
    WHEN t !~ 'bridge' THEN false                                                -- not a bridge at all
    WHEN t ~ 'with[[:space:]]+construction' THEN false                           -- a bridge that says it builds
    WHEN COALESCE(p_rehab_budget, 0) > 0 THEN false                              -- a budget somebody typed
    ELSE true
  END
  FROM (SELECT lower(COALESCE(p_program, '') || ' ' || COALESCE(p_loan_type, '') || ' ' || COALESCE(p_rehab_type, '')) AS t) x;
$$;

CREATE OR REPLACE FUNCTION ensure_construction_conditions() RETURNS trigger AS $$
DECLARE
  bridge boolean;
  attrs_changed boolean;
BEGIN
  -- Only files that already have a materialized checklist; generateChecklist
  -- applies the same rule when it first builds one.
  IF NOT EXISTS (SELECT 1 FROM checklist_items WHERE application_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  bridge := pilot_bridge_without_construction(NEW.program, NEW.loan_type, NEW.rehab_type, NEW.rehab_budget);

  attrs_changed := (TG_OP = 'INSERT')
    OR (OLD.program      IS DISTINCT FROM NEW.program)
    OR (OLD.loan_type    IS DISTINCT FROM NEW.loan_type)
    OR (OLD.rehab_type   IS DISTINCT FROM NEW.rehab_type)
    OR (OLD.rehab_budget IS DISTINCT FROM NEW.rehab_budget);

  IF NOT attrs_changed THEN
    RETURN NEW;
  END IF;

  IF bridge THEN
    -- Take the three off — but only an UNTOUCHED one. A person's work stays.
    DELETE FROM checklist_items ci
      USING checklist_templates t
     WHERE ci.application_id = NEW.id AND ci.template_id = t.id
       AND t.code IN ('rtl_p1_budget', 'rtl_p3_sow1', 'rtl_p3_sow2')
       AND ci.status IN ('outstanding', 'requested')
       AND ci.signed_off_at IS NULL AND ci.waived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.checklist_item_id = ci.id);
  ELSE
    -- The file builds something (or stopped being a bridge): put back whichever
    -- of the three it does not carry, exactly as generateChecklist would.
    INSERT INTO checklist_items
      (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
       phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
       clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id)
    SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
           COALESCE(t.role_scope, 'any'), t.phase, t.hint, t.borrower_hint,
           COALESCE(t.is_gate, false), COALESCE(t.is_milestone, false),
           COALESCE(t.sort_order, 500), t.tool_key, t.clickup_field_id,
           COALESCE(t.tpr_exclude, false), 'system',
           COALESCE(t.is_required, true), NEW.id
      FROM checklist_templates t
     WHERE t.code IN ('rtl_p1_budget', 'rtl_p3_sow1', 'rtl_p3_sow2')
       AND t.is_active = true AND t.auto_apply IS NULL
       AND t.scope = 'application'
       AND (t.applies_loan_type IS NULL OR t.applies_loan_type = 'rtl')
       AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                        WHERE ci.application_id = NEW.id AND ci.template_id = t.id);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ensure_construction_conditions ON applications;
CREATE TRIGGER trg_ensure_construction_conditions
  AFTER INSERT OR UPDATE OF program, loan_type, rehab_type, rehab_budget ON applications
  FOR EACH ROW EXECUTE FUNCTION ensure_construction_conditions();

-- Backfill: the untouched three come off every existing bridge that builds nothing.
DELETE FROM checklist_items ci
  USING checklist_templates t, applications a
 WHERE ci.template_id = t.id
   AND t.code IN ('rtl_p1_budget', 'rtl_p3_sow1', 'rtl_p3_sow2')
   AND ci.application_id = a.id
   AND pilot_bridge_without_construction(a.program, a.loan_type, a.rehab_type, a.rehab_budget)
   AND ci.status IN ('outstanding', 'requested')
   AND ci.signed_off_at IS NULL AND ci.waived_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.checklist_item_id = ci.id);
