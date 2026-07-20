-- 172 — Keep the ground-up "Plans & permits" condition (rtl_p1_plans) in lockstep
-- with whether the file is actually a ground-up build (proactive follow-up to the
-- assignment-condition lifecycle fix in db/161 — the identical class, and this one
-- is borrower-facing: rtl_p1_plans has audience='both').
--
-- rtl_p1_plans is a legacy (auto_apply IS NULL) placeholder that generateChecklist
-- attaches only when the file is ground-up, and db/095's boot reconcile re-adds
-- only for ground-up files. But NOTHING removed it when a file STOPPED being
-- ground-up (staff editing program/loan_type/rehab_type off construction, or a
-- ClickUp flip). So the borrower kept being asked for "Plans & permits" on a file
-- that is no longer a construction loan. It also had the reverse latency the
-- assignment condition used to have: flipping a live file ONTO ground-up via a
-- staff edit didn't add the condition until the next boot.
--
-- This adds a trigger that mirrors db/161: add rtl_p1_plans when the file is
-- ground-up and remove it when it isn't, on every change to the three attributes
-- that derive "ground-up". The ground-up test is the exact SQL equivalent of the
-- JS derivation in borrower.js generateChecklist:
--   /ground/i.test([program, loan_type, rehab_type].join(' '))
-- Deleting the item is safe: documents.checklist_item_id is ON DELETE SET NULL, so
-- any attached plans document is unlinked, not destroyed. Idempotent.

CREATE OR REPLACE FUNCTION ensure_plans_condition() RETURNS trigger AS $$
DECLARE
  ground_up boolean;
  attrs_changed boolean;
BEGIN
  -- Only touch files that already have a materialized checklist.
  IF NOT EXISTS (SELECT 1 FROM checklist_items WHERE application_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  ground_up := (
    COALESCE(NEW.program, '') || ' ' || COALESCE(NEW.loan_type, '') || ' ' || COALESCE(NEW.rehab_type, '')
  ) ~* 'ground';

  attrs_changed := (TG_OP = 'INSERT')
    OR (OLD.program    IS DISTINCT FROM NEW.program)
    OR (OLD.loan_type  IS DISTINCT FROM NEW.loan_type)
    OR (OLD.rehab_type IS DISTINCT FROM NEW.rehab_type);

  IF ground_up AND attrs_changed THEN
    -- Create the placeholder if the ground-up file doesn't already carry it.
    INSERT INTO checklist_items
      (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
       phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
       clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id)
    SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
           COALESCE(t.role_scope,'any'), t.phase, t.hint, t.borrower_hint,
           COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
           COALESCE(t.sort_order, 500), t.tool_key, t.clickup_field_id,
           COALESCE(t.tpr_exclude,false), 'system',
           COALESCE(t.is_required,true), NEW.id
      FROM checklist_templates t
     WHERE t.code = 'rtl_p1_plans' AND t.is_active = true
       AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                        WHERE ci.application_id = NEW.id AND ci.template_id = t.id);
  ELSIF (NOT ground_up) AND attrs_changed THEN
    -- The file is NOT (or is no longer) a ground-up build: remove the now-irrelevant
    -- placeholder so it only ever appears on construction files.
    DELETE FROM checklist_items ci
      USING checklist_templates t
     WHERE ci.application_id = NEW.id AND ci.template_id = t.id
       AND t.code = 'rtl_p1_plans';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ensure_plans_condition ON applications;
CREATE TRIGGER trg_ensure_plans_condition
  AFTER INSERT OR UPDATE OF program, loan_type, rehab_type ON applications
  FOR EACH ROW EXECUTE FUNCTION ensure_plans_condition();

-- Backfill: remove the plans placeholder from existing NON-ground-up files that
-- wrongly carry it (attached before ground-up ever flipped off, with no removal
-- path). Uses the same derivation as the trigger.
DELETE FROM checklist_items ci
  USING checklist_templates t, applications a
 WHERE ci.template_id = t.id AND t.code = 'rtl_p1_plans'
   AND ci.application_id = a.id
   AND NOT (
     (COALESCE(a.program, '') || ' ' || COALESCE(a.loan_type, '') || ' ' || COALESCE(a.rehab_type, '')) ~* 'ground'
   );
