-- ============================================================================
-- db/661 — the housing history and the payoff say what feeds them
--
-- WHAT THIS CHANGES, AND WHY. Owner-directed 2026-08-31, two items:
--
--   *"Housing history verified — if he is renting, then the housing history
--   verified condition is tied directly to the verification of rent order and
--   gets the documents from there. You can either upload it manually as well, but
--   it's tied directly and populated by himself. If he is owning, then that
--   housing history verified should have a note that it is a verification of
--   mortgage of primary residence. If he is living rent-free, then the housing
--   history verified should be the rent-free letter."*
--
--   *"The payoff received should be tied directly to the payoff order, and you
--   should also be able to upload manually."*
--
-- THE WIRING WAS ALREADY THERE AND IS STATED HERE RATHER THAN REBUILT.
-- `orders/kinds.js` already names `lt_housing_history` as the verification-of-
-- rent order's `docCondition` and `lt_payoff_received` as the payoff order's, and
-- each `slotMap` already names the slot a returned document lands in — so both
-- "tied directly" halves work today. What was missing is that NOTHING ON THE
-- SCREEN SAID SO: a slot that fills itself in looked exactly like one waiting to
-- be uploaded, so the person working the file chased a document that was on its
-- way. And the owner asked, in those words, for the owning branch to say PRIMARY
-- RESIDENCE — the file also carries a verification of mortgage for the SUBJECT
-- property on a refinance, and two slots both called "verification of mortgage"
-- with nothing telling them apart is how the wrong one gets uploaded.
--
-- WHY A MIGRATION. `library.seed` is `ON CONFLICT (code) DO NOTHING`, so wording
-- edited in the library reaches a NEW database and no existing one. And the slot
-- list and the hint are COPIED ONTO EACH CONDITION at creation
-- (`checklist_items.slots` / `.hint`, which is what the screen and the sign-off
-- gate read), so the template alone would leave every live file showing the old
-- words. Both are updated here.
--
-- GENERATED, NOT TYPED. The statements below were emitted from the library
-- itself — the new text from the working tree, the guard text from the committed
-- version — so the migration cannot disagree with the code it is carrying.
--
-- IDEMPOTENT AND EDIT-SAFE. Each statement is guarded on the EXACT previous hint
-- and slot list, so a replay matches nothing and a row somebody has since edited
-- is left alone, which is the same promise `DO NOTHING` makes.
--
-- BACKFILL: the item update IS the backfill. Nothing else changes — no condition
-- is added, removed, re-scoped or re-required, and no document moves.
--
-- PRODUCT SEPARATION. `checklist_templates` and `checklist_items` are the SHARED
-- Condition Center tables (db/652/653); only rows whose template code is `lt_*`
-- are touched. Not named `_lt_` for that reason — the rule is about the table.
-- ============================================================================

-- ── lt_housing_history ──────────────────────────────────────────
UPDATE checklist_templates
   SET hint = 'One of three, decided by what the borrower said about where they live (FR0115): the rent verification back from the landlord if they rent, a verification of mortgage on the home they live in if they own it, or a letter if they live somewhere rent free. They are alternatives, not a list — asking for all three would be asking for two things that cannot exist. The rent one fills itself in from the verification of rent order; any of the three can also be uploaded here.',
       slots = '[{"key":"vor","label":"Verification of rent (completed)","required":false,"whenField":"borrower_rents","hint":"Comes back on the verification of rent order and files itself here. It can also be uploaded."},{"key":"vom_primary","label":"Verification of mortgage — primary residence","required":false,"whenField":"borrower_owns_home","hint":"The home the borrower LIVES in, not the subject property — the subject property has its own verification of mortgage on this file."},{"key":"rent_free_letter","label":"Living rent free letter","required":false,"whenField":"borrower_lives_rent_free","hint":"Written by whoever they live with, confirming the borrower pays no rent."}]'::jsonb,
       updated_at = now()
 WHERE code = 'lt_housing_history'
   AND hint = 'One of three, decided by what the borrower said about where they live (FR0115): the rent verification back from the landlord if they rent, a mortgage verification on their own home if they own it, or a letter if they live somewhere rent free. They are alternatives, not a list — asking for all three would be asking for two things that cannot exist.'
   AND slots = '[{"key":"vor","label":"Verification of rent (completed)","required":false,"whenField":"borrower_rents"},{"key":"vom_primary","label":"Verification of mortgage — their own home","required":false,"whenField":"borrower_owns_home"},{"key":"rent_free_letter","label":"Living rent free letter","required":false,"whenField":"borrower_lives_rent_free"}]'::jsonb;

UPDATE checklist_items ci
   SET hint = 'One of three, decided by what the borrower said about where they live (FR0115): the rent verification back from the landlord if they rent, a verification of mortgage on the home they live in if they own it, or a letter if they live somewhere rent free. They are alternatives, not a list — asking for all three would be asking for two things that cannot exist. The rent one fills itself in from the verification of rent order; any of the three can also be uploaded here.',
       slots = '[{"key":"vor","label":"Verification of rent (completed)","required":false,"whenField":"borrower_rents","hint":"Comes back on the verification of rent order and files itself here. It can also be uploaded."},{"key":"vom_primary","label":"Verification of mortgage — primary residence","required":false,"whenField":"borrower_owns_home","hint":"The home the borrower LIVES in, not the subject property — the subject property has its own verification of mortgage on this file."},{"key":"rent_free_letter","label":"Living rent free letter","required":false,"whenField":"borrower_lives_rent_free","hint":"Written by whoever they live with, confirming the borrower pays no rent."}]'::jsonb,
       updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id AND t.code = 'lt_housing_history'
   AND ci.hint = 'One of three, decided by what the borrower said about where they live (FR0115): the rent verification back from the landlord if they rent, a mortgage verification on their own home if they own it, or a letter if they live somewhere rent free. They are alternatives, not a list — asking for all three would be asking for two things that cannot exist.'
   AND ci.slots = '[{"key":"vor","label":"Verification of rent (completed)","required":false,"whenField":"borrower_rents"},{"key":"vom_primary","label":"Verification of mortgage — their own home","required":false,"whenField":"borrower_owns_home"},{"key":"rent_free_letter","label":"Living rent free letter","required":false,"whenField":"borrower_lives_rent_free"}]'::jsonb;

-- ── lt_payoff_received ──────────────────────────────────────────
UPDATE checklist_templates
   SET hint = 'The statement back from the servicer, still good on the closing date. It files itself in from the payoff order, and can also be uploaded here.',
       slots = '[{"key":"payoff","label":"Payoff statement","required":true,"hint":"Comes back on the payoff order and files itself here. It can also be uploaded."}]'::jsonb,
       updated_at = now()
 WHERE code = 'lt_payoff_received'
   AND hint = 'The statement back from the servicer, still good on the closing date.'
   AND slots = '[{"key":"payoff","label":"Payoff statement","required":true}]'::jsonb;

UPDATE checklist_items ci
   SET hint = 'The statement back from the servicer, still good on the closing date. It files itself in from the payoff order, and can also be uploaded here.',
       slots = '[{"key":"payoff","label":"Payoff statement","required":true,"hint":"Comes back on the payoff order and files itself here. It can also be uploaded."}]'::jsonb,
       updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id AND t.code = 'lt_payoff_received'
   AND ci.hint = 'The statement back from the servicer, still good on the closing date.'
   AND ci.slots = '[{"key":"payoff","label":"Payoff statement","required":true}]'::jsonb;
