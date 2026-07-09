-- 060_fix_phantom_borrower_conditions.sql
-- (#78) Kill the phantom "An item your loan team needs" condition.
--
-- The borrower portal shows COALESCE(borrower_label,'An item your loan team
-- needs'), so any borrower-visible checklist_items row with a NULL borrower_label
-- reads as that meaningless placeholder. Two causes are fixed here (the code
-- paths that CREATE such rows are fixed in the same change):
--
--  1) Three legacy RTL templates (executed contract, borrower photo ID, expected
--     ARV) are audience='both' but were seeded WITHOUT a borrower_label, so their
--     items always showed the placeholder. Backfill the label as the borrower
--     wording — all three are borrower-safe, borrower-actionable requests.
--
--  2) A misconfigured auto-apply Condition Studio template (borrower/both audience,
--     no borrower_label) minted a genuine phantom on files via the rule engine's
--     sweeps (which re-fire on borrower edits, product/rehab saves, status changes,
--     etc.) — a condition nobody knowingly added. Retire those orphans by making
--     them STAFF-only: the condition still exists for the team, and the borrower
--     stops seeing a placeholder they can't act on. Going forward the rule engine
--     applies such templates staff-only (engine.js) and the studio defaults the
--     borrower wording from the label (admin-conditions.js), so no new phantoms.
--
-- All statements are idempotent (guarded by NULL/empty and audience predicates).

-- 1) Backfill the three borrower-safe RTL templates + their existing items.
UPDATE checklist_templates
   SET borrower_label = label
 WHERE code IN ('rtl_p1_contract', 'rtl_p1_id', 'rtl_p1_arv')
   AND (borrower_label IS NULL OR btrim(borrower_label) = '');

UPDATE checklist_items ci
   SET borrower_label = ci.label, updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id
   AND t.code IN ('rtl_p1_contract', 'rtl_p1_id', 'rtl_p1_arv')
   AND ci.audience IN ('borrower', 'both')
   AND (ci.borrower_label IS NULL OR btrim(ci.borrower_label) = '');

-- 2) Retire rule-engine phantoms: borrower-visible, no borrower wording, plain
--    label-rendered (no tool / e-sign / info field), auto-created by a rule.
--    Make them staff-only so the borrower never sees the placeholder again.
UPDATE checklist_items
   SET audience = 'staff', updated_at = now()
 WHERE audience IN ('borrower', 'both')
   AND (borrower_label IS NULL OR btrim(borrower_label) = '')
   AND tool_key IS NULL
   AND COALESCE(esign_doc, '') = ''
   AND field_key IS NULL
   AND item_kind IN ('document', 'condition', 'task')
   AND origin_kind = 'auto';
