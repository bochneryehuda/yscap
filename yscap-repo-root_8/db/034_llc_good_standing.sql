-- =====================================================================
-- 034_llc_good_standing.sql
-- Industry-alignment pass on the LLC section:
--   (a) checklist_templates.is_required — an optional requirement can now be
--       tracked as a slot without gating verification. insertFromTemplate()
--       copies it onto generated items.
--   (b) Certificate of Good Standing — the 4th LLC document slot. Most
--       note buyers require it once the entity is over a year old, dated
--       within 60-90 days of closing, so it is collected on the profile but
--       does NOT block "verified": recency is enforced by staff at
--       underwriting (the staff panel flags entity age and stale
--       certificates).
--   (c) Backfill the new slot onto every existing LLC.
-- Idempotent: safe to re-run on every boot.
-- =====================================================================

-- (a) optional requirements.
ALTER TABLE checklist_templates
  ADD COLUMN IF NOT EXISTS is_required boolean NOT NULL DEFAULT true;

-- (b) the Certificate of Good Standing slot.
INSERT INTO checklist_templates
  (code, label, borrower_label, scope, audience, item_kind, role_scope,
   sort_order, hint, borrower_hint, is_required)
SELECT 'rtl_llc_goodstanding',
       'LLC Certificate of Good Standing (state)',
       'Certificate of Good Standing',
       'llc', 'both', 'document', 'loan_officer', 40,
       'Required by most programs once the entity is over a year old; must be dated within 60-90 days of closing',
       'A current Certificate of Good Standing from your formation state — most loans need one dated within 90 days of closing',
       false
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code = 'rtl_llc_goodstanding');

-- (c) every existing LLC gets the new slot.
INSERT INTO checklist_items
  (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
   phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, created_by_kind, is_required, llc_id)
SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
       COALESCE(t.role_scope,'any'), t.phase, t.hint, t.borrower_hint,
       COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
       COALESCE(t.sort_order,100), t.tool_key, t.clickup_field_id, 'system',
       COALESCE(t.is_required,true), l.id
  FROM llcs l
 CROSS JOIN checklist_templates t
 WHERE t.scope = 'llc' AND t.is_active = true
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.llc_id = l.id AND ci.template_id = t.id);

-- keep item requiredness in step with the template for llc slots.
UPDATE checklist_items ci
   SET is_required = t.is_required, updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id AND t.scope = 'llc'
   AND ci.is_required IS DISTINCT FROM t.is_required;
