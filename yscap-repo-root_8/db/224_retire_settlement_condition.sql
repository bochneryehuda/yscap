-- 224 — Retire the pre-close settlement statement condition (rtl_cond_settlement).
--
-- Owner-directed 2026-07-21: the settlement statement is a POST-CLOSING document only. It should
-- not appear on the pre-close condition checklist. The reader / classifier / schema in the app
-- code stay in place (so an uploaded settlement statement still reads for reference and the
-- team keeps the knowledge for when we build the post-closing module) — only the checklist
-- CONDITION and its outstanding rows go away.
--
-- Undoes db/215_settlement_condition.sql. Idempotent + safe to re-run on every boot:
--   (1) The template is DEACTIVATED (never deleted — deleting it would break historical
--       checklist_items.template_id references). New files never generate a row for it while
--       is_active=false.
--   (2) Existing empty system-generated rows are DELETED (no attached documents, no notes, no
--       satisfied sign-off) — they were auto-created by the db/215 backfill and carry no
--       borrower/team work. Rows with real content or human edits are LEFT ALONE, defensively.
--
-- "Previous AND future" per CLAUDE.md — the boot migrator applies this to every existing file
-- automatically on the next server start.

-- (1) Deactivate the template. Never DELETE (template_id may be referenced by historic items).
UPDATE checklist_templates
   SET is_active = false, updated_at = now()
 WHERE code = 'rtl_cond_settlement'
   AND is_active = true;

-- (2) Clean up empty auto-generated outstanding rows for the retired condition. Only remove a
--     row when it is UNTOUCHED (no attached documents, no notes, still 'outstanding',
--     created_by_kind='system'). Anything else is left in place so nothing a human owns is
--     silently discarded.
DELETE FROM checklist_items ci
 WHERE ci.template_id IN (SELECT id FROM checklist_templates WHERE code = 'rtl_cond_settlement')
   AND ci.status = 'outstanding'
   AND (ci.notes IS NULL OR ci.notes = '')
   AND (ci.created_by_kind IS NULL OR ci.created_by_kind = 'system')
   AND NOT EXISTS (
     SELECT 1 FROM documents d
      WHERE d.checklist_item_id = ci.id
   );
