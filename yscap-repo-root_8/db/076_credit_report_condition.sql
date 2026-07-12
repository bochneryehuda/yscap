-- 076 — Credit report INTERNAL condition (rtl_cond_credit).
--
-- Owner-directed 2026-07-12: add a credit report as an INTERNAL condition (a
-- staff upload slot — NOT on the borrower checklist) so the team uploads the
-- pulled credit report onto the file. Mirrors the fraud/background internal
-- condition (056/066): audience='staff', item_kind='document', processor scope.
-- Unlike fraud (which is internal-only and tpr_exclude=true), the credit report
-- IS part of the clean-file / DPR export, so tpr_exclude=false.
--
-- "Backdated and added to every single file in the past like always": the
-- template is generated for NEW files, and the backfill below puts an instance
-- on EVERY existing non-deleted file that already has a checklist and doesn't
-- carry it yet. Idempotent (NOT EXISTS guards).

-- (1) Template — insert unconditionally, guarded so re-runs are no-ops.
INSERT INTO checklist_templates (code, label, scope, audience, item_kind, applies_loan_type, role_scope, phase, sort_order, category, hint, tpr_exclude, is_required)
SELECT 'rtl_cond_credit', 'Credit report', 'application', 'staff', 'document', 'rtl', 'processor', '3', 404, 'prior_to_docs',
       'Upload the borrower''s credit report (internal). Required before the file can be signed off.',
       false, true
 WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code='rtl_cond_credit');

-- (2) Backfill onto every existing file that has a checklist and lacks it.
INSERT INTO checklist_items
  (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
   phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id)
SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
       COALESCE(t.role_scope,'processor'), t.phase, t.hint, t.borrower_hint,
       COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
       COALESCE(t.sort_order,404), t.tool_key, t.clickup_field_id,
       COALESCE(t.tpr_exclude,false), 'system',
       COALESCE(t.is_required,true), a.id
  FROM applications a
 CROSS JOIN checklist_templates t
 WHERE t.code = 'rtl_cond_credit'
   AND t.is_active = true
   AND a.deleted_at IS NULL
   AND a.status NOT IN ('withdrawn','cancelled')
   AND EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.application_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = a.id
                      AND ci.template_id = t.id);
