-- =====================================================================
-- 144_appraisal_condition_slots.sql
--   The internal appraisal-documents condition (rtl_cond_appraisaldocs) gets TWO
--   named upload slots: the appraisal DATA file (XML) and the appraisal REPORT (PDF).
--   Dropping the XML into its slot auto-imports the appraisal (builds the property
--   report + PILOT findings) — no need to use the separate import button. Both slots
--   are required before the condition can be signed off (enforced in signOffGate).
--   The slots live on the TEMPLATE, which every existing and future item reads, so no
--   per-item backfill is needed. Idempotent.
-- =====================================================================
UPDATE checklist_templates
   SET slots = '[{"key":"xml","label":"Appraisal data file (XML)"},{"key":"pdf","label":"Appraisal report (PDF)"}]'::jsonb,
       hint  = 'Upload BOTH the appraisal DATA file (XML) and the appraisal REPORT (PDF). '
            || 'Dropping the XML here imports the appraisal automatically and builds the '
            || 'property report and the PILOT findings. Both files are required before this '
            || 'condition can be signed off.'
 WHERE code = 'rtl_cond_appraisaldocs';
