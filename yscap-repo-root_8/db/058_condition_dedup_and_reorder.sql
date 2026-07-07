-- 058_condition_dedup_and_reorder.sql
-- Owner-directed round 2 on the RTL conditions:
--  (#63) De-duplicate the liquidity condition. The "Verify assets for $X
--        liquidity requirement" row that product registration used to insert
--        into the `conditions` table is retired (see product-registration.js):
--        the single source of truth is now the dynamic checklist condition
--        rtl_p3_assets (src/lib/liquidity.js), which shows in the regular
--        conditions-to-close, carries the cash-to-close breakdown, and reopens
--        ONLY when the required liquidity goes up. Waive any open duplicates on
--        existing files, and relabel rtl_p3_assets so it reads as the combined
--        "verify assets & bank statements / required liquidity" condition (with
--        a real borrower-facing label).
--  (#71) Internal checklist: "Appraisal payment confirmed" sits right after
--        "Appraisal ordered", and "Appraisal ordered through NAN" drops the
--        channel name → just "Appraisal ordered".
-- Idempotent: safe to re-run on every boot.

-- (#63) retire the duplicate underwriting "Verify assets" conditions on files.
UPDATE conditions
   SET status='waived',
       waive_reason=COALESCE(waive_reason, 'Consolidated into the single dynamic liquidity condition (bank statements / required liquidity)'),
       cleared_at=COALESCE(cleared_at, now()),
       updated_at=now()
 WHERE linked_entity_type='product_registration'
   AND title LIKE 'Verify assets%'
   AND status IN ('open','borrower_responded');

-- (#63) rtl_p3_assets is the single liquidity condition — clearer wording + a
-- borrower-facing label (it was NULL, so the borrower saw a generic fallback).
UPDATE checklist_templates
   SET label='Assets & bank statements verified — meet the required liquidity',
       borrower_label='Bank statements — verify your assets meet the required liquidity',
       updated_at=now()
 WHERE code='rtl_p3_assets'
   AND (label IS DISTINCT FROM 'Assets & bank statements verified — meet the required liquidity'
     OR borrower_label IS DISTINCT FROM 'Bank statements — verify your assets meet the required liquidity');
UPDATE checklist_items ci
   SET label=t.label, borrower_label=t.borrower_label, updated_at=now()
  FROM checklist_templates t
 WHERE t.id=ci.template_id AND t.code='rtl_p3_assets'
   AND (ci.label IS DISTINCT FROM t.label OR ci.borrower_label IS DISTINCT FROM t.borrower_label);

-- (#71) "Appraisal ordered through NAN" → "Appraisal ordered".
UPDATE checklist_templates SET label='Appraisal ordered', updated_at=now()
 WHERE code='rtl_p3_appr' AND label IS DISTINCT FROM 'Appraisal ordered';
UPDATE checklist_items ci SET label='Appraisal ordered', updated_at=now()
  FROM checklist_templates t
 WHERE t.id=ci.template_id AND t.code='rtl_p3_appr' AND ci.label IS DISTINCT FROM 'Appraisal ordered';

-- (#71) "Appraisal payment confirmed" immediately after "Appraisal ordered".
-- rtl_p3_appr sits at sort_order 5 (db/056); put payment at 6.
UPDATE checklist_templates SET sort_order=6, updated_at=now()
 WHERE code='rtl_p3_apprpay' AND sort_order IS DISTINCT FROM 6;
UPDATE checklist_items ci SET sort_order=6, updated_at=now()
  FROM checklist_templates t
 WHERE t.id=ci.template_id AND t.code='rtl_p3_apprpay' AND ci.sort_order IS DISTINCT FROM 6;
