-- 059_appraisal_docs_internal_condition.sql
-- (#74) Add an INTERNAL condition for uploading the appraisal documents — it
-- lives in the "Internal conditions" section (audience=staff, item_kind=document),
-- NOT the phase-by-phase internal checklist. Idempotent insert; it propagates to
-- existing open RTL files via the boot backfill (bumped to v3 in server.js) and
-- to new files through generateChecklist.

INSERT INTO checklist_templates
  (code, label, scope, audience, item_kind, applies_loan_type, role_scope, phase, sort_order, category, hint, is_required)
SELECT 'rtl_cond_appraisaldocs', 'Appraisal documents received', 'application', 'staff', 'document', 'rtl', 'processor', '3', 435, 'prior_to_docs',
       'Upload the appraisal documents (the appraisal report and any related exhibits) for the file.', true
 WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code='rtl_cond_appraisaldocs');
