-- =====================================================================
-- 420_order_returns_reach_their_condition.sql
--
-- PREVIOUS AND FUTURE for the Orders-desk fix (owner-reported 2026-08-03:
-- "we just got back insurance documents and it was not automatically attached
-- to the insurance condition").
--
-- The going-forward halves live in code:
--   · src/lib/order-slots.js  — the slots an order's documents may be assigned
--     to are DERIVED from the condition template's OWN named slots, so choosing
--     "Insurance binder" on the Orders desk is the same act as dropping the file
--     into that slot on the condition.
--   · src/lib/order-inbox.js  — the condition is CREATED when the file does not
--     have it, so a returned document is never orphaned.
--   · the file screen renders a slotted condition's UNSLOTTED documents instead
--     of drawing only its named slots.
--
-- This file repairs what those three already let through. Three statements, each
-- idempotent, each scoped to documents the ORDERS DESK itself filed:
--
--   (A) LEGACY SLOT LABELS. The desk used to write 'Binder' / 'Invoice'; the
--       insurance condition's slots are named 'Insurance binder' / 'Insurance
--       invoice' and the file screen matches a document to a slot by an EXACT
--       label compare. So every document a human classified was filed correctly
--       and then rendered nowhere. The labels are read out of the template
--       (never hard-coded here) and matched by MEANING — the same lower-case
--       substring test the sign-off gate uses — so this stays correct if an
--       admin renames a slot, and a label that already matches is not rewritten.
--
--   (B) ORPHANED RETURNS. A returned document whose condition did not exist on
--       the file was saved with checklist_item_id NULL: visible on the Orders
--       desk, invisible on the condition it was ordered for. Where the condition
--       EXISTS the document is simply pointed at it.
--
--   (C) THE MISSING CONDITION. Where it does not exist, it is created from its
--       own template — but ONLY for a file that actually has an orphaned return
--       to re-home, so this can never sprinkle title/insurance conditions across
--       files that never ordered either. Then (B) is re-run to attach them.
--
-- Nothing is deleted, no review status is touched, no sign-off is changed, and a
-- document a human has already put in a slot is left exactly where they put it.
-- =====================================================================

-- (A) legacy 'Binder' / 'Invoice' → whatever the condition calls those slots.
WITH slot AS (
  SELECT
    (SELECT s->>'label' FROM jsonb_array_elements(t.slots) s
      WHERE lower(s->>'label') LIKE '%binder%' LIMIT 1)  AS binder_label,
    (SELECT s->>'label' FROM jsonb_array_elements(t.slots) s
      WHERE lower(s->>'label') LIKE '%invoice%' LIMIT 1) AS invoice_label
    FROM checklist_templates t
   WHERE t.code = 'rtl_cond_insurance'
     AND jsonb_typeof(t.slots) = 'array'
   LIMIT 1
)
UPDATE documents d
   SET slot_label = slot.binder_label
  FROM slot
 WHERE d.doc_kind = 'insurance_order_return'
   AND slot.binder_label IS NOT NULL
   AND lower(coalesce(d.slot_label, '')) LIKE '%binder%'
   AND d.slot_label IS DISTINCT FROM slot.binder_label;

WITH slot AS (
  SELECT
    (SELECT s->>'label' FROM jsonb_array_elements(t.slots) s
      WHERE lower(s->>'label') LIKE '%invoice%' LIMIT 1) AS invoice_label
    FROM checklist_templates t
   WHERE t.code = 'rtl_cond_insurance'
     AND jsonb_typeof(t.slots) = 'array'
   LIMIT 1
)
UPDATE documents d
   SET slot_label = slot.invoice_label
  FROM slot
 WHERE d.doc_kind = 'insurance_order_return'
   AND slot.invoice_label IS NOT NULL
   AND lower(coalesce(d.slot_label, '')) LIKE '%invoice%'
   AND d.slot_label IS DISTINCT FROM slot.invoice_label;

-- (C) create the condition ONLY where an orphaned return proves the file needs
--     one. Same guarded shape as closing.js/vesting.js — application+template
--     NOT EXISTS — so re-running on every boot adds nothing.
INSERT INTO checklist_items
  (template_id, scope, application_id, label, borrower_label, audience, item_kind,
   role_scope, phase, category, hint, borrower_hint, is_gate, is_milestone,
   sort_order, tool_key, field_key, clickup_field_id, tpr_exclude,
   is_required, status, origin_kind, created_by_kind)
SELECT DISTINCT ON (a.id, t.id)
       t.id, 'application', a.id, t.label, t.borrower_label, t.audience, t.item_kind,
       COALESCE(t.role_scope, 'any'), t.phase, t.category, t.hint, t.borrower_hint,
       COALESCE(t.is_gate, false), COALESCE(t.is_milestone, false),
       COALESCE(t.sort_order, 100), t.tool_key, t.field_key, t.clickup_field_id,
       COALESCE(t.tpr_exclude, false),
       COALESCE(t.is_required, true), 'outstanding', 'auto', 'system'
  FROM documents d
  JOIN applications a ON a.id = d.application_id AND a.deleted_at IS NULL
  JOIN checklist_templates t
    ON t.is_active = true
   AND t.code = CASE d.doc_kind WHEN 'title_order_return'     THEN 'rtl_cond_title'
                                WHEN 'insurance_order_return' THEN 'rtl_cond_insurance' END
 WHERE d.doc_kind IN ('title_order_return', 'insurance_order_return')
   AND d.checklist_item_id IS NULL
   AND d.is_current = true
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = a.id AND ci.template_id = t.id);

-- (B) point every orphaned return at its condition. Runs after (C) so the rows
--     it just created are picked up in the same pass. The oldest instance wins,
--     matching order-inbox's own lookup, so a file that somehow carries two
--     copies files consistently rather than splitting its documents across them.
UPDATE documents d
   SET checklist_item_id = ci.id
  FROM checklist_items ci
  JOIN checklist_templates t ON t.id = ci.template_id
 WHERE d.checklist_item_id IS NULL
   AND d.is_current = true
   AND d.doc_kind IN ('title_order_return', 'insurance_order_return')
   AND ci.application_id = d.application_id
   AND t.code = CASE d.doc_kind WHEN 'title_order_return'     THEN 'rtl_cond_title'
                                WHEN 'insurance_order_return' THEN 'rtl_cond_insurance' END
   AND ci.id = (SELECT ci2.id FROM checklist_items ci2
                 WHERE ci2.application_id = d.application_id AND ci2.template_id = t.id
                 ORDER BY ci2.created_at ASC, ci2.id ASC LIMIT 1);
