-- ============================================================================
-- db/681 — the New York settlement agent is asked for three things
--
-- WHAT THIS CHANGES, AND WHY. Asked item by item what the New York settlement
-- agent should actually be asked for, the owner answered on 2026-09-02:
-- *"Errors & Omissions insurance and also the preliminary settlement statement,
-- not for engagement letter, but yes for wire instructions."*
--
-- So the list is exactly three: wire instructions, the E&O, and the preliminary
-- settlement statement. Two things follow.
--
--   1. THE ENGAGEMENT LETTER COMES OFF. It was never asked for — it predates the
--      New York work (it was in `lt_ny_settlement_docs` from the day the
--      condition was seeded) and was carried forward unexamined, which is how a
--      required slot nobody wants ends up holding a file open. Same shape as
--      db/680's CPL removal and for the same reason: a required slot that the
--      owner does not want filled leaves the condition outstanding forever.
--
--   2. THE STATEMENT SLOT IS RE-LABELLED to "Preliminary settlement statement",
--      which is what the order letter has always ASKED for. The slot said
--      "Settlement statement" while the ask said "Preliminary settlement
--      statement" — the same document under two names, on one screen. The KEY
--      is untouched (`settlement_statement`), so nothing that files into it
--      moves: the filename matcher keys on the regex, never on the label.
--
-- WHAT IS NOT TOUCHED. The E&O and the wire instructions, which the owner
-- confirmed. `lt_title_docs` is untouched — it is a different condition, and in
-- New York it is deliberately asked for less, not for more.
--
-- HOW IT CHANGES THE ROWS. By KEY, one element at a time, leaving every other
-- element exactly as it stands — db/680's method and its reasons: a row
-- somebody has edited keeps their edit while still losing the slot the owner
-- does not want, and it is idempotent by construction (once no element has key
-- `engagement`, and the statement already carries its new label, both guards
-- match nothing).
--
-- ORDERING. db/677 (which seeds the pre-correction shape), db/680 (the CPL) and
-- this file all replay on every boot in filename order, so this one runs LAST
-- and is the final word. They converge on the first boot from any state a
-- database can be in and are all no-ops on the second — asserted, not assumed,
-- by S4b in scripts/test-lt-order-guards-db.js, which replays all three.
-- Neither earlier file is edited: migrations are never edited once written.
--
-- BACKFILL: the `checklist_items` copies as well as the templates — the engine
-- copies a template's slots onto each item when it attaches the condition, so a
-- template fixed alone would fix future files and leave every open one asking
-- for a document nobody wants. NO DOCUMENT MOVES: db/677 has never been
-- deployed (it is new on this branch, unmerged), so no file has ever had a
-- document filed into the engagement slot, and the statement slot keeps its key.
--
-- PRODUCT SEPARATION: writes `checklist_templates` and `checklist_items` — the
-- shared Condition Center tables, authorized for Long-Term writes in
-- docs/LONG-TERM-AUTHORIZED-COPIES.md — and only the row whose code is
-- `lt_ny_settlement_docs` and whose scope is `lt_loan`. No RTL row is reachable.
-- ============================================================================

-- ── 1. THE ENGAGEMENT LETTER IS NOT ASKED FOR ───────────────────────────────
UPDATE checklist_templates
   SET slots = (
         SELECT COALESCE(jsonb_agg(s ORDER BY ord), '[]'::jsonb)
           FROM jsonb_array_elements(slots) WITH ORDINALITY AS e(s, ord)
          WHERE s->>'key' IS DISTINCT FROM 'engagement'
       ),
       updated_at = now()
 WHERE code = 'lt_ny_settlement_docs'
   AND scope = 'lt_loan'
   AND jsonb_typeof(slots) = 'array'
   AND slots @> '[{"key":"engagement"}]'::jsonb;

UPDATE checklist_items ci
   SET slots = (
         SELECT COALESCE(jsonb_agg(s ORDER BY ord), '[]'::jsonb)
           FROM jsonb_array_elements(ci.slots) WITH ORDINALITY AS e(s, ord)
          WHERE s->>'key' IS DISTINCT FROM 'engagement'
       ),
       updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id
   AND t.code = 'lt_ny_settlement_docs'
   AND jsonb_typeof(ci.slots) = 'array'
   AND ci.slots @> '[{"key":"engagement"}]'::jsonb;

-- ── 2. THE STATEMENT IS CALLED WHAT THE LETTER ASKS FOR ─────────────────────
UPDATE checklist_templates
   SET slots = (
         SELECT COALESCE(jsonb_agg(
                  CASE WHEN s->>'key' = 'settlement_statement'
                       THEN s || '{"label":"Preliminary settlement statement"}'::jsonb
                       ELSE s END ORDER BY ord), '[]'::jsonb)
           FROM jsonb_array_elements(slots) WITH ORDINALITY AS e(s, ord)
       ),
       updated_at = now()
 WHERE code = 'lt_ny_settlement_docs'
   AND scope = 'lt_loan'
   AND jsonb_typeof(slots) = 'array'
   AND slots @> '[{"key":"settlement_statement","label":"Settlement statement"}]'::jsonb;

UPDATE checklist_items ci
   SET slots = (
         SELECT COALESCE(jsonb_agg(
                  CASE WHEN s->>'key' = 'settlement_statement'
                       THEN s || '{"label":"Preliminary settlement statement"}'::jsonb
                       ELSE s END ORDER BY ord), '[]'::jsonb)
           FROM jsonb_array_elements(ci.slots) WITH ORDINALITY AS e(s, ord)
       ),
       updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id
   AND t.code = 'lt_ny_settlement_docs'
   AND jsonb_typeof(ci.slots) = 'array'
   AND ci.slots @> '[{"key":"settlement_statement","label":"Settlement statement"}]'::jsonb;
