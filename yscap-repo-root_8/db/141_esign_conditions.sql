-- =====================================================================
-- 141_esign_conditions.sql — the two NEW conditions the term-sheet package's
-- signed copies clear (the signed term sheet + the Heter Iska already exist as
-- rtl_cond_signedts / rtl_cond_iska in db/051).
--
--   * rtl_cond_signed_app  — the signed loan-application export lands here.
--   * rtl_cond_disclosures — the signed business-purpose disclosure lands here.
--
-- Both are INCLUDED in the TPR export + SharePoint mirror (tpr_exclude=false),
-- per docs/DOCUSIGN-DOCUMENT-BUILD-SPEC Addendum A.9 — only the Heter Iska is
-- excluded (guarded in code + rtl_cond_iska.tpr_exclude=true).
--
-- Staff-audience document conditions: the borrower signs the whole package once
-- (one "Sign now"); these track the individual signed copies internally. On
-- envelope completion the webhook files each signed PDF here and moves the item
-- to 'received' (a processor still signs off — the conservative default).
--
-- Mirrors db/051's idempotent seed + open-file backfill. Safe to re-run.
-- =====================================================================

INSERT INTO checklist_templates
  (code, label, scope, audience, item_kind, applies_loan_type, role_scope, phase,
   sort_order, category, hint, borrower_label, borrower_hint, tpr_exclude, is_active)
SELECT 'rtl_cond_signed_app','Signed application','application','staff','document','rtl','processor','1',
       506,'prior_to_docs','The borrower-signed loan application (filed automatically when the term-sheet package is fully signed).',NULL,NULL,
       false,true
 WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code='rtl_cond_signed_app');

INSERT INTO checklist_templates
  (code, label, scope, audience, item_kind, applies_loan_type, role_scope, phase,
   sort_order, category, hint, borrower_label, borrower_hint, tpr_exclude, is_active)
SELECT 'rtl_cond_disclosures','Signed business-purpose disclosure','application','staff','document','rtl','processor','1',
       508,'prior_to_docs','The borrower-signed business-purpose disclosure & certification (filed automatically when the term-sheet package is fully signed).',NULL,NULL,
       false,true
 WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code='rtl_cond_disclosures');

-- Converge tpr_exclude on re-run (only touch a row whose value would change).
UPDATE checklist_templates SET tpr_exclude = false
 WHERE code IN ('rtl_cond_signed_app','rtl_cond_disclosures')
   AND tpr_exclude IS DISTINCT FROM false;

-- Backfill onto existing OPEN RTL files that already have a checklist and don't
-- already carry the template (identical to db/051's carry-over).
INSERT INTO checklist_items
  (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
   phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id)
SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
       COALESCE(t.role_scope,'any'), t.phase, t.hint, t.borrower_hint,
       COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
       COALESCE(t.sort_order,100), t.tool_key, t.clickup_field_id,
       COALESCE(t.tpr_exclude,false), 'system',
       COALESCE(t.is_required,true), a.id
  FROM applications a
 CROSS JOIN checklist_templates t
 WHERE t.code IN ('rtl_cond_signed_app','rtl_cond_disclosures')
   AND t.is_active = true
   AND a.deleted_at IS NULL
   AND a.status IN ('new','in_review','processing','underwriting','approved','clear_to_close')
   AND EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.application_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = a.id
                      AND ci.template_id = t.id);
