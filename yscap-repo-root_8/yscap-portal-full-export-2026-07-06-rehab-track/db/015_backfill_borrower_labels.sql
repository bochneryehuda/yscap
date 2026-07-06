-- 015_backfill_borrower_labels.sql — carry borrower-facing wording onto items.
--
-- insertFromTemplate() dropped borrower_label/borrower_hint when generating
-- checklist items, so every already-created file falls back (COALESCE) to the
-- INTERNAL staff label/hint on the borrower portal. Copy the borrower wording
-- from each item's template where the item is missing it. Idempotent — only
-- fills NULLs, so re-running on boot is a no-op once populated.

UPDATE checklist_items ci
   SET borrower_label = t.borrower_label
  FROM checklist_templates t
 WHERE ci.template_id = t.id
   AND ci.borrower_label IS NULL
   AND t.borrower_label IS NOT NULL;

UPDATE checklist_items ci
   SET borrower_hint = t.borrower_hint
  FROM checklist_templates t
 WHERE ci.template_id = t.id
   AND ci.borrower_hint IS NULL
   AND t.borrower_hint IS NOT NULL;
