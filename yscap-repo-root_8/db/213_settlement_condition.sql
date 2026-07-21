-- 213 — Settlement statement INTERNAL condition (rtl_cond_settlement).
--
-- Owner-directed: make the settlement statement auto-track (and auto-read) like
-- the other documents. Until now `settlement` was a required document in the
-- completeness matrix but had NO checklist condition, so a settlement statement
-- had nowhere to be filed and never got read automatically (the underwriting
-- auto-reader keys off the condition a document is filed under). This adds the
-- condition, so a settlement statement filed under it reads AS a settlement
-- statement and the condition shows covered.
--
-- Mirrors the flood-certificate internal condition (db/177): audience='staff'
-- (the title/settlement agent's document, uploaded by the team — never a
-- borrower slot), item_kind='document', processor scope, phase 5 (closing).
-- Excluded from the pre-close TPR/clean-file export (tpr_exclude=true) because a
-- settlement statement only exists AT closing — it must not gate an earlier
-- export — but it is a required file document.
--
-- "Previous AND future": the template is generated for NEW files by
-- generateChecklist (auto_apply IS NULL, applies_loan_type='rtl'); the backfill
-- below puts an instance on EVERY existing non-deleted, non-terminal file that
-- already has a checklist and doesn't carry it yet. Idempotent (NOT EXISTS
-- guards) — safe to re-run on every boot.

-- (1) Template — insert unconditionally, guarded so re-runs are no-ops.
INSERT INTO checklist_templates
  (code, label, scope, audience, item_kind, applies_loan_type, role_scope, phase, sort_order, category, hint, tpr_exclude, is_required)
SELECT 'rtl_cond_settlement', 'Settlement statement', 'application', 'staff', 'document', 'rtl', 'processor', '5', 515, 'prior_to_closing',
       'Upload the final settlement statement (ALTA / HUD-1 / Closing Disclosure) — the closing sources & uses. It is reviewed at closing; PILOT reads it and checks the price, loan amount, and parties against the file.',
       true, true
 WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code='rtl_cond_settlement');

-- (2) Backfill onto every existing file that has a checklist and lacks it.
INSERT INTO checklist_items
  (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
   phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id)
SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
       COALESCE(t.role_scope,'processor'), t.phase, t.hint, t.borrower_hint,
       COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
       COALESCE(t.sort_order,515), t.tool_key, t.clickup_field_id,
       COALESCE(t.tpr_exclude,true), 'system',
       COALESCE(t.is_required,true), a.id
  FROM applications a
 CROSS JOIN checklist_templates t
 WHERE t.code = 'rtl_cond_settlement'
   AND t.is_active = true
   AND a.deleted_at IS NULL
   AND a.status NOT IN ('withdrawn','cancelled')
   AND EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.application_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = a.id
                      AND ci.template_id = t.id);
