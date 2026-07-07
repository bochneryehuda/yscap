-- =====================================================================
-- 051_clickup_conditions_and_tpr_exclude.sql
--   (a) Add tpr_exclude (checklist_templates + checklist_items) so an item can
--       be structurally excluded from the TPR / clean-file export, and a
--       template-level `slots` jsonb so a document condition can declare named
--       upload slots (e.g. insurance binder + invoice).
--   (b) Seed 4 new RTL document conditions that pair 1:1 with ClickUp checklist
--       dropdowns: Insurance (binder + invoice), Title documents, Signed term
--       sheet, and ISKA (never exported).
--   (c) Backfill those 4 onto every EXISTING open RTL file that already has a
--       checklist — mirrors db/036's carry-over, plus clickup_field_id +
--       tpr_exclude.
-- Idempotent: safe to re-run on every boot.
-- =====================================================================

-- (1a) columns ---------------------------------------------------------
ALTER TABLE checklist_templates
  ADD COLUMN IF NOT EXISTS tpr_exclude boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS slots       jsonb;
ALTER TABLE checklist_items
  ADD COLUMN IF NOT EXISTS tpr_exclude boolean NOT NULL DEFAULT false;

-- (1b) the 4 templates — insert only when the code is not present yet.
INSERT INTO checklist_templates
  (code, label, scope, audience, item_kind, applies_loan_type, role_scope, phase,
   sort_order, category, hint, borrower_label, borrower_hint, clickup_field_id,
   tpr_exclude, slots, is_active)
SELECT 'rtl_cond_insurance','Insurance (binder + invoice)','application','staff','document','rtl','processor','3',
       435,'prior_to_closing','Two PDFs: the insurance binder and the insurance invoice',NULL,NULL,
       '2cfc1e61-6be7-484f-929e-c2de9c7a2e40',
       false,'[{"key":"binder","label":"Insurance binder"},{"key":"invoice","label":"Insurance invoice"}]'::jsonb,true
 WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code='rtl_cond_insurance');

INSERT INTO checklist_templates
  (code, label, scope, audience, item_kind, applies_loan_type, role_scope, phase,
   sort_order, category, hint, borrower_label, borrower_hint, clickup_field_id,
   tpr_exclude, slots, is_active)
SELECT 'rtl_cond_title','Title documents','application','staff','document','rtl','processor','3',
       436,'prior_to_closing','All title documents (commitment, prelim, CPL, etc.)',NULL,NULL,
       '96799e30-0f72-47e5-9136-5d59203d27b7',
       false,NULL,true
 WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code='rtl_cond_title');

INSERT INTO checklist_templates
  (code, label, scope, audience, item_kind, applies_loan_type, role_scope, phase,
   sort_order, category, hint, borrower_label, borrower_hint, clickup_field_id,
   tpr_exclude, slots, is_active)
SELECT 'rtl_cond_signedts','Signed term sheet','application','both','document','rtl','loan_officer','1',
       505,'prior_to_docs','Borrower-signed term sheet','Signed term sheet',
       'Sign your term sheet and upload the signed copy here.',
       'd60eef93-d13a-404b-9523-72826e2e37b0',
       false,NULL,true
 WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code='rtl_cond_signedts');

INSERT INTO checklist_templates
  (code, label, scope, audience, item_kind, applies_loan_type, role_scope, phase,
   sort_order, category, hint, borrower_label, borrower_hint, clickup_field_id,
   tpr_exclude, slots, is_active)
SELECT 'rtl_cond_iska','ISKA','application','both','document','rtl','processor','5',
       507,'prior_to_closing','ISKA document — never included in the TPR / clean-file export','ISKA',
       'Upload your ISKA document here.',
       'd6c23813-8041-4e8e-916e-89b9ee21e4cc',
       TRUE,NULL,true
 WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code='rtl_cond_iska');

-- (1b follow-ups) converge clickup_field_id / tpr_exclude / slots on re-run
-- (db/050 pattern — only touch rows whose value would actually change).
UPDATE checklist_templates SET clickup_field_id = v.fid
  FROM (VALUES
    ('rtl_cond_insurance','2cfc1e61-6be7-484f-929e-c2de9c7a2e40'),
    ('rtl_cond_title',    '96799e30-0f72-47e5-9136-5d59203d27b7'),
    ('rtl_cond_signedts', 'd60eef93-d13a-404b-9523-72826e2e37b0'),
    ('rtl_cond_iska',     'd6c23813-8041-4e8e-916e-89b9ee21e4cc')
  ) AS v(code,fid)
 WHERE checklist_templates.code = v.code
   AND checklist_templates.clickup_field_id IS DISTINCT FROM v.fid;

UPDATE checklist_templates SET tpr_exclude = v.te
  FROM (VALUES
    ('rtl_cond_insurance', false),
    ('rtl_cond_title',     false),
    ('rtl_cond_signedts',  false),
    ('rtl_cond_iska',      true)
  ) AS v(code,te)
 WHERE checklist_templates.code = v.code
   AND checklist_templates.tpr_exclude IS DISTINCT FROM v.te;

UPDATE checklist_templates
   SET slots = '[{"key":"binder","label":"Insurance binder"},{"key":"invoice","label":"Insurance invoice"}]'::jsonb
 WHERE code = 'rtl_cond_insurance'
   AND slots IS DISTINCT FROM '[{"key":"binder","label":"Insurance binder"},{"key":"invoice","label":"Insurance invoice"}]'::jsonb;

-- (1c) backfill onto existing OPEN RTL files — mirrors db/036's carry-over
-- (plus clickup_field_id + tpr_exclude). Only files that already have a
-- checklist and don't already carry the template.
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
 WHERE t.code IN ('rtl_cond_insurance','rtl_cond_title','rtl_cond_signedts','rtl_cond_iska')
   AND t.is_active = true
   AND a.deleted_at IS NULL
   AND a.status IN ('new','in_review','processing','underwriting','approved','clear_to_close')
   AND EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.application_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = a.id
                      AND ci.template_id = t.id);
