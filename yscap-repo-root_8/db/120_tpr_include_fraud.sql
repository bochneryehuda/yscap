-- 120_tpr_include_fraud.sql — the FRAUD report ships in the TPR export.
--
-- Owner-directed 2026-07-16: the TPR export includes EVERY document on the
-- file. The fraud report was excluded twice — (1) its docs never reach
-- 'accepted' (staff-condition uploads stay 'pending'; the query-side
-- accepted-only filter is removed in src/lib/tpr-export.js in the same
-- change), and (2) the rtl_cond_fraud template was seeded tpr_exclude=true
-- (db/056), with db/066 defaulting existing items the same way. This clears
-- the seeded flag for FRAUD only. ISKA (rtl_cond_iska) and the investor
-- structure printout (rtl_cond_investorstruct) KEEP their owner-directed
-- tpr_exclude — that flag remains the mechanism for deliberate exclusions.
-- Idempotent; covers previous AND future files (template + existing items).
UPDATE checklist_templates SET tpr_exclude=false
 WHERE code='rtl_cond_fraud' AND tpr_exclude IS TRUE;

UPDATE checklist_items ci SET tpr_exclude=false
  FROM checklist_templates t
 WHERE t.id=ci.template_id AND t.code='rtl_cond_fraud' AND ci.tpr_exclude IS TRUE;
