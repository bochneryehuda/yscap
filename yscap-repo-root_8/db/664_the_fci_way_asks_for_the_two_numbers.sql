-- ============================================================================
-- db/664 — the FCI way asks for the two numbers, so the wording stops promising
--          a waiver
--
-- WHAT THIS CHANGES, AND WHY. Owner-directed 2026-08-31:
--
--   *"Servicer of the loan being paid off — this is now a separate condition. We
--   don't need this to be a separate condition. We need the file to understand by
--   themself on the condition of mortgage statement for subject property. So if
--   you're putting in that it's FCI then the servicer automatically selects it to
--   be FCI and our processor needs to go into FCI and look for the FCI loan
--   number and put it in and outstanding balance."*
--
-- The FCI way used to ask for NOTHING — it was written as a waiver, on the
-- reasoning that we service the loan so we already hold everything a statement
-- would say. We do, and that is exactly why the two numbers are OBTAINABLE
-- rather than unnecessary: the loan-setup person still has to key a loan number
-- and an outstanding balance into Encompass, and neither of them is on this file.
-- `answers.js` now asks for both and answers the SERVICER itself.
--
-- THE WORDING WAS THE HALF LEFT BEHIND, AND IT SAID THE OPPOSITE. The condition
-- still read *"or a waiver … where we already hold everything a statement would
-- say"*, so somebody choosing that way was told nothing more was needed and was
-- then shown two boxes. Wording that contradicts the screen is worse than no
-- wording: it is read as the rule, and the screen is read as a bug.
--
-- WHY A MIGRATION AND NOT JUST THE LIBRARY. `library.seed` is
-- `ON CONFLICT (code) DO NOTHING`, so an edit in the library reaches a NEW
-- database and no existing one; and the hint is COPIED ONTO EACH CONDITION at
-- creation (`checklist_items.hint`, which is what the screen actually shows), so
-- the template alone would leave every live file reading the old promise. Both
-- are updated here. Editing one without the other is the drift this pair exists
-- to prevent, and section F of `scripts/test-lt-mortgage-statement-read-db.js`
-- compares the library against the seeded template so neither can move alone.
--
-- GENERATED, NOT TYPED. Both strings below were emitted FROM the library — the
-- new text from the working tree, the guard text from the committed version — so
-- this migration cannot disagree with the code it is carrying.
--
-- IDEMPOTENT AND EDIT-SAFE. Each statement is guarded on the EXACT previous hint,
-- so a replay matches nothing and a row somebody has since re-worded by hand is
-- left alone — the same promise `DO NOTHING` makes.
--
-- BACKFILL: the item update IS the backfill. Nothing else changes — no condition
-- is added, removed, re-scoped, re-required or re-slotted, no answer is touched,
-- and no document moves.
--
-- PRODUCT SEPARATION. `checklist_templates` and `checklist_items` are the SHARED
-- Condition Center tables (db/652/653); only the row whose template code is
-- `lt_subject_mortgage_statement` is touched. The file is not named `_lt_`
-- because the rule is about the TABLE, not about which product's row it carries.
-- ============================================================================

UPDATE checklist_templates
   SET hint = 'A current statement on the loan being paid off. Three ways to satisfy it: upload the statement — PILOT reads the servicer, the loan number and the outstanding principal balance off it and fills them in for somebody to check; type those three in yourself — all three, none of them optional; or say it refinances one of our own short-term loans serviced by FCI, which answers the servicer itself and still needs the FCI loan number and the outstanding balance looked up in FCI.',
       updated_at = now()
 WHERE code = 'lt_subject_mortgage_statement'
   AND hint = 'A current statement on the loan being paid off. Three ways to satisfy it: the statement itself; the payoff figures typed in — outstanding balance, servicer AND loan number, all three, none of them optional; or a waiver where the loan being refinanced is one of our own short-term loans serviced by FCI, where we already hold everything a statement would say.';

UPDATE checklist_items ci
   SET hint = 'A current statement on the loan being paid off. Three ways to satisfy it: upload the statement — PILOT reads the servicer, the loan number and the outstanding principal balance off it and fills them in for somebody to check; type those three in yourself — all three, none of them optional; or say it refinances one of our own short-term loans serviced by FCI, which answers the servicer itself and still needs the FCI loan number and the outstanding balance looked up in FCI.',
       updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id
   AND t.code = 'lt_subject_mortgage_statement'
   AND ci.hint = 'A current statement on the loan being paid off. Three ways to satisfy it: the statement itself; the payoff figures typed in — outstanding balance, servicer AND loan number, all three, none of them optional; or a waiver where the loan being refinanced is one of our own short-term loans serviced by FCI, where we already hold everything a statement would say.';
