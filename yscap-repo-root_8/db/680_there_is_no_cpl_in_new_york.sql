-- ============================================================================
-- db/680 — there is no CPL in New York
--
-- WHAT THIS CHANGES, AND WHY. db/677 gave `lt_ny_settlement_docs` a required
-- `cpl` slot and made the New York settlement-agent letter ask for a closing
-- protection letter. That was WRONG, and the owner said so on 2026-09-02:
-- *"In NY, there is no CPL. We only ask them for their Errors and Omissions
-- Assurance."*
--
-- WHERE THE WRONG RULE CAME FROM, so it cannot come back. It was not invented:
-- docs/longterm/OWNER-ORDER-DRAFTS.md, "New York rule", said the CPL MOVED off
-- the title ask and onto the settlement agent's. It does not move — there is
-- none to move. That draft is corrected at the source in the same commit; a
-- migration alone would leave the next reader restoring the slot from the doc.
--
-- WHY IT MATTERS RATHER THAN BEING TIDINESS. The slot is `required`, so on
-- every New York file the settlement-agent documents condition sits outstanding
-- forever waiting for a document that does not exist in that state, and the
-- letter asks an agent for something they cannot send. It is the same failure
-- `lt_title_docs` already guards with `notWhenField: 'is_new_york'` on its own
-- CPL slot — a slot nobody can ever fill.
--
-- WHAT IT DOES NOT TOUCH. The E&O stays: that one genuinely comes from the
-- settlement agent rather than from title, which is the half of the New York
-- rule that was right. `lt_title_docs` is untouched — its CPL slot is already
-- switched off in New York and is correct everywhere else.
--
-- HOW IT REMOVES THE SLOT. By KEY, keeping every other element of the array
-- exactly as it stands, rather than by re-writing the whole array to a literal.
-- Two reasons: a row somebody has edited (a re-labelled slot, one they added)
-- keeps their edit and still loses the CPL, which is what the owner's rule
-- requires of every row; and it is idempotent by construction — once no element
-- has key `cpl` the guard matches nothing and the statement is a no-op.
--
-- ORDERING. Every migration replays on every boot in filename order, so db/677
-- runs FIRST and re-adds the slot on a database still holding its exact
-- pre-db/677 value; this file, numbered after it, takes it back off in the same
-- boot. The two converge on the first boot and are both no-ops on the second.
-- db/677 is deliberately NOT edited: migrations are never edited once written.
--
-- BACKFILL: the `checklist_items` copies as well as the templates — the engine
-- copies a template's slots onto each item when it attaches the condition, so
-- a template fixed alone would fix future files and leave every open one asking
-- for the CPL. NO DOCUMENT MOVES: db/677 has never been deployed (it is new on
-- this branch, unmerged), so no file has ever had a document filed into this
-- slot and there is nothing to re-home.
--
-- PRODUCT SEPARATION: writes `checklist_templates` and `checklist_items` — the
-- shared Condition Center tables, authorized for Long-Term writes in
-- docs/LONG-TERM-AUTHORIZED-COPIES.md — and only the row whose code is
-- `lt_ny_settlement_docs` and whose scope is `lt_loan`. No RTL row is reachable.
-- ============================================================================

-- ── 1. THE TEMPLATE STOPS ASKING FOR A CLOSING PROTECTION LETTER ────────────
UPDATE checklist_templates
   SET slots = (
         SELECT COALESCE(jsonb_agg(s ORDER BY ord), '[]'::jsonb)
           FROM jsonb_array_elements(slots) WITH ORDINALITY AS e(s, ord)
          WHERE s->>'key' IS DISTINCT FROM 'cpl'
       ),
       updated_at = now()
 WHERE code = 'lt_ny_settlement_docs'
   AND scope = 'lt_loan'
   AND jsonb_typeof(slots) = 'array'
   AND slots @> '[{"key":"cpl"}]'::jsonb;

-- ── 2. AND SO DO THE FILES ALREADY CARRYING THE CONDITION ───────────────────
UPDATE checklist_items ci
   SET slots = (
         SELECT COALESCE(jsonb_agg(s ORDER BY ord), '[]'::jsonb)
           FROM jsonb_array_elements(ci.slots) WITH ORDINALITY AS e(s, ord)
          WHERE s->>'key' IS DISTINCT FROM 'cpl'
       ),
       updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id
   AND t.code = 'lt_ny_settlement_docs'
   AND jsonb_typeof(ci.slots) = 'array'
   AND ci.slots @> '[{"key":"cpl"}]'::jsonb;
