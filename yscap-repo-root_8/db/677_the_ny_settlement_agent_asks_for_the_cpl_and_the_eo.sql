-- ============================================================================
-- db/677 — on a New York file the settlement agent is asked for the CPL and
--          the E&O, and title is no longer asked for the wiring instructions
--
-- WHAT THIS FIXES. The owner's own New York rule (docs/longterm/OWNER-ORDER-
-- DRAFTS.md, "New York rule") moves the CPL, the preliminary settlement
-- statement and the settlement agent's errors-and-omissions insurance off the
-- title order and onto the settlement-agent order. The shared title letter
-- already cut all of those (and the wiring instructions) from a New York title
-- ask (`lib/order-email.js` NY_TITLE_CUT), and `lt_title_docs` already dropped
-- its CPL and preliminary-statement slots on New York — but the settlement-agent
-- side never picked them up: `lt_ny_settlement_docs` had slots only for the
-- engagement letter, the wire instructions and the settlement statement, and the
-- settlement-agent letter asked for exactly those three. So on a New York file
-- NOBODY was asked for the CPL or the E&O and there was no slot for either; and
-- `lt_title_docs.wire_instructions` stayed required on New York although the
-- New York title letter no longer asks title for it.
--
-- WHAT MOVES. `conditions-center/library.js` is the source of truth and now
-- says: `lt_ny_settlement_docs` gains `cpl` and `eo` (both required), and
-- `lt_title_docs.wire_instructions` carries `notWhenField: 'is_new_york'`,
-- like its CPL and preliminary-statement slots. The library's `seed()` fills
-- the table and NEVER overwrites a row (a template somebody edited must survive
-- a redeploy), so a slot added in code reaches an existing database only
-- through a migration — this one — and only where the row is still EXACTLY
-- what the seed wrote (the db/661 pattern). A row somebody has edited matches
-- nothing here and is left alone, on purpose.
--
-- Per-ITEM copies move too: the engine copies a template's slots onto each
-- `checklist_items` row when it attaches the condition, and `read.js` shows the
-- item's own copy, so a template updated alone would fix future files and not
-- the ones already open.
--
-- BACKFILL: the item rows above, guarded the same way. No document moves; a
-- CPL already filed on `lt_title_docs` stays where it is.
--
-- PRODUCT SEPARATION: writes `checklist_templates` and `checklist_items`,
-- both authorized for Long-Term writes in docs/LONG-TERM-AUTHORIZED-COPIES.md,
-- and only rows whose `scope = 'lt_loan'` / whose code is `lt_*`.
-- ============================================================================

-- ── 1. THE SETTLEMENT AGENT IS ASKED FOR THE CPL AND THE E&O ────────────────
UPDATE checklist_templates
   SET slots = '[{"key":"engagement","label":"Engagement letter","required":true},{"key":"wire_instructions","label":"Wire instructions","required":true},{"key":"cpl","label":"Closing protection letter","required":true},{"key":"eo","label":"Settlement agent E&O insurance","required":true},{"key":"settlement_statement","label":"Settlement statement","required":true}]'::jsonb,
       updated_at = now()
 WHERE code = 'lt_ny_settlement_docs'
   AND scope = 'lt_loan'
   AND slots = '[{"key":"engagement","label":"Engagement letter","required":true},{"key":"wire_instructions","label":"Wire instructions","required":true},{"key":"settlement_statement","label":"Settlement statement","required":true}]'::jsonb;

UPDATE checklist_items ci
   SET slots = '[{"key":"engagement","label":"Engagement letter","required":true},{"key":"wire_instructions","label":"Wire instructions","required":true},{"key":"cpl","label":"Closing protection letter","required":true},{"key":"eo","label":"Settlement agent E&O insurance","required":true},{"key":"settlement_statement","label":"Settlement statement","required":true}]'::jsonb,
       updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id AND t.code = 'lt_ny_settlement_docs'
   AND ci.slots = '[{"key":"engagement","label":"Engagement letter","required":true},{"key":"wire_instructions","label":"Wire instructions","required":true},{"key":"settlement_statement","label":"Settlement statement","required":true}]'::jsonb;

-- ── 2. TITLE IS NOT ASKED FOR THE WIRING INSTRUCTIONS IN NEW YORK ───────────
UPDATE checklist_templates
   SET slots = '[{"key":"commitment","label":"Title commitment","required":true},{"key":"cpl","label":"Closing protection letter","required":true,"notWhenField":"is_new_york"},{"key":"prelim_settlement","label":"Preliminary settlement statement","required":true,"notWhenField":"is_new_york"},{"key":"wire_instructions","label":"Wire instructions","required":true,"notWhenField":"is_new_york"},{"key":"invoice","label":"Title invoice","required":false}]'::jsonb,
       hint = 'The title package. New York asks for less of it — there is no closing protection letter, no preliminary settlement statement and no wiring instructions there, because the settlement agent handles all three — so a New York file is not left holding slots nobody can ever fill.',
       updated_at = now()
 WHERE code = 'lt_title_docs'
   AND scope = 'lt_loan'
   AND slots = '[{"key":"commitment","label":"Title commitment","required":true},{"key":"cpl","label":"Closing protection letter","required":true,"notWhenField":"is_new_york"},{"key":"prelim_settlement","label":"Preliminary settlement statement","required":true,"notWhenField":"is_new_york"},{"key":"wire_instructions","label":"Wire instructions","required":true},{"key":"invoice","label":"Title invoice","required":false}]'::jsonb;

UPDATE checklist_items ci
   SET slots = '[{"key":"commitment","label":"Title commitment","required":true},{"key":"cpl","label":"Closing protection letter","required":true,"notWhenField":"is_new_york"},{"key":"prelim_settlement","label":"Preliminary settlement statement","required":true,"notWhenField":"is_new_york"},{"key":"wire_instructions","label":"Wire instructions","required":true,"notWhenField":"is_new_york"},{"key":"invoice","label":"Title invoice","required":false}]'::jsonb,
       updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id AND t.code = 'lt_title_docs'
   AND ci.slots = '[{"key":"commitment","label":"Title commitment","required":true},{"key":"cpl","label":"Closing protection letter","required":true,"notWhenField":"is_new_york"},{"key":"prelim_settlement","label":"Preliminary settlement statement","required":true,"notWhenField":"is_new_york"},{"key":"wire_instructions","label":"Wire instructions","required":true},{"key":"invoice","label":"Title invoice","required":false}]'::jsonb;
