-- =====================================================================
-- 036_conditions_backfill_audit.sql
--   (a) Backfill the two automatic borrower conditions added in 032
--       ("Products & pricing" and "Credit card for the appraisal") onto
--       every EXISTING open file — 032 only added the templates, so files
--       created before it never received the items.
--   (b) Where the underlying data already exists (a current product
--       registration / a saved appraisal card), the backfilled item starts
--       in 'received' instead of asking the borrower again.
-- Idempotent: safe to re-run on every boot.
-- =====================================================================

-- (a) every open file with a checklist gets the two automatic conditions.
INSERT INTO checklist_items
  (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
   phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, created_by_kind, is_required, application_id)
SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
       COALESCE(t.role_scope,'any'), t.phase, t.hint, t.borrower_hint,
       COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
       COALESCE(t.sort_order,100), t.tool_key, t.clickup_field_id, 'system',
       COALESCE(t.is_required,true), a.id
  FROM applications a
 CROSS JOIN checklist_templates t
 WHERE t.code IN ('rtl_p1_product','rtl_p1_apprcard') AND t.is_active = true
   AND a.deleted_at IS NULL
   AND a.status NOT IN ('funded','declined','withdrawn')
   AND EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.application_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = a.id
                      AND (ci.template_id = t.id OR ci.tool_key = t.tool_key));

-- (b) already satisfied by existing data -> start the item in review.
UPDATE checklist_items ci SET status='received', updated_at=now()
 WHERE ci.tool_key='product_pricing' AND ci.status IN ('outstanding','requested')
   AND EXISTS (SELECT 1 FROM product_registrations pr
                WHERE pr.application_id = ci.application_id AND pr.is_current);

UPDATE checklist_items ci SET status='received', updated_at=now()
 WHERE ci.tool_key='appraisal_card' AND ci.status IN ('outstanding','requested')
   AND EXISTS (SELECT 1 FROM application_payment_cards pc
                WHERE pc.application_id = ci.application_id);
