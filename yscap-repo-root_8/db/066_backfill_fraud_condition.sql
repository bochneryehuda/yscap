-- 066 — Backfill the Fraud / background internal condition (rtl_cond_fraud) onto
-- every active file that has a checklist but is missing it.
--
-- The two-slot fraud/background condition (background report always required;
-- criminal report required only for the Gold Standard program) was added as a
-- template in 056 and is generated for NEW files, but existing files that predate
-- it never received the instance — so it was "missing on some files." This puts
-- it on every active file that has a checklist (i.e. a materialized RTL file) and
-- doesn't already carry it. Mirrors the 051 condition backfill. Slots come from
-- the template at read time (checklist_items has no slots column), so nothing
-- else is needed. Idempotent (NOT EXISTS guard).
INSERT INTO checklist_items
  (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
   phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id)
SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
       COALESCE(t.role_scope,'any'), t.phase, t.hint, t.borrower_hint,
       COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
       COALESCE(t.sort_order,405), t.tool_key, t.clickup_field_id,
       COALESCE(t.tpr_exclude,true), 'system',
       COALESCE(t.is_required,true), a.id
  FROM applications a
 CROSS JOIN checklist_templates t
 WHERE t.code = 'rtl_cond_fraud'
   AND t.is_active = true
   AND a.deleted_at IS NULL
   AND a.status IN ('new','in_review','processing','underwriting','approved','clear_to_close')
   AND EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.application_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = a.id
                      AND ci.template_id = t.id);
