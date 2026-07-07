-- 050_clickup_checklist_map.sql — seed checklist_templates.clickup_field_id for
-- the RTL document conditions that have a clean ClickUp dropdown counterpart, then
-- backfill existing checklist_items. This is the mapping the PULL-ONLY checklist
-- sync (src/clickup/checklist.js + ingest.applyChecklistStatuses) keys on.
--
-- Only 5 of the 8 ClickUp CHECKLIST fields have a clean portal template counterpart:
--   contract  -> rtl_p1_contract   (Executed purchase contract)
--   assignment-> rtl_p5_assign     (Assignment letter)
--   rehabBudget-> rtl_p1_budget    (Construction / rehab budget)
--   reo       -> rtl_p3_reo        (REO / experience sheet)
--   assets    -> rtl_p3_assets     (Bank statements / liquidity)
-- title / insurance / signedTermSheet are intentionally NOT mapped (no single
-- clean 1:1 portal template) and stay unseeded.
--
-- Idempotent: the UPDATEs only touch rows whose value would actually change.

UPDATE checklist_templates SET clickup_field_id = v.fid
  FROM (VALUES
    ('rtl_p1_contract','85866d28-7135-490d-be71-471a34669629'),
    ('rtl_p5_assign',  'a22694cb-7fcf-49d0-83b5-163cd07b26b0'),
    ('rtl_p1_budget',  'b1cdb8b1-5f74-40bb-8d57-76ec0b0d629f'),
    ('rtl_p3_reo',     'fa211bd9-d464-44cb-a54c-8485f2d9ec8d'),
    ('rtl_p3_assets',  '1b813089-5605-4da9-b77b-49a7e105965b')
  ) AS v(code,fid)
 WHERE checklist_templates.code = v.code
   AND checklist_templates.clickup_field_id IS DISTINCT FROM v.fid;

UPDATE checklist_items ci SET clickup_field_id = t.clickup_field_id
  FROM checklist_templates t
 WHERE ci.template_id = t.id AND t.clickup_field_id IS NOT NULL AND ci.clickup_field_id IS NULL;
