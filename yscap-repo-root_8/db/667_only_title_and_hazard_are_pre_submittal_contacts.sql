-- ============================================================================
-- db/667 — the pre-submittal contacts condition asks for TWO, not seven
--
-- WHAT THIS CHANGES, AND WHY. Owner-directed 2026-08-31: *"Our attorney,
-- Realtor, Buyer's Attorney — those open slots should be only in the file
-- contacts and not … a condition before submittal. The only stuff that should be
-- a condition before submittal is the title company and the hazard insurance
-- agent."*
--
-- The `lt_file_contacts` condition asked for seven contact types. Five of them
-- are people who may never be appointed on a given deal — an attorney, a
-- realtor — and a CONDITION is a row somebody has to clear before the file
-- moves, which is not what an optional contact is. They did not go anywhere:
-- they are the File contacts desk (`conditions-center/library.js
-- FILE_CONTACT_TYPES`), where an open slot belongs, and two of them are still
-- asked for in their own right when the deal calls for it by their own
-- rule-driven order conditions (`lt_order_flood_insurance`,
-- `lt_order_ny_settlement_agent`). Nothing that was genuinely required has
-- become optional.
--
-- WHY A MIGRATION AT ALL, WHEN THE LIBRARY ALREADY SAYS TWO. `library.seed` is
-- `ON CONFLICT (code) DO NOTHING` on purpose — a buyer's own edit to a row
-- survives every redeploy — so it FILLS the library and never rewrites it.
-- Editing the library alone would therefore change new databases and no existing
-- one, silently: every live file would keep asking for seven and nobody would
-- see a failure. This is the only thing that reaches them. `config` is read off
-- the TEMPLATE rather than copied onto each item (`conditions-center/read.js`),
-- so one row updated here reaches every file at once.
--
-- IDEMPOTENT. Guarded on the SEVEN-key list this is replacing, so the second
-- replay matches nothing and does nothing.
--
-- A HAND-EDITED ROW SURVIVES. The guard is the exact set of keys the seed
-- shipped; a row somebody has since changed does not match it and is left alone,
-- which is the same promise `DO NOTHING` makes.
--
-- BACKFILL: none needed beyond this. No `checklist_items` row carries a copy of
-- `config` to correct, and nothing is deleted — a contact card already on a file
-- keeps its row in `lt_loan_vendors` and now shows on the File contacts desk.
--
-- PRODUCT SEPARATION, AND WHY THIS FILE IS NOT NAMED `_lt_`. It touches ONE row
-- of `checklist_templates`, which db/652/653 made the SHARED Condition Center
-- table — the row is a Long-Term one (`lt_file_contacts`) and no RTL template is
-- read or written. A file named `db/NNN_lt_*.sql` may only touch `lt_*` TABLES,
-- and this touches a shared one, so `check-product-separation.js` refuses that
-- name and is right to: the rule is about the table, not about whose row it is.
-- The same reasoning names db/646 and db/655.
-- ============================================================================

UPDATE checklist_templates
   SET config = jsonb_set(
         config,
         '{contactTypes}',
         '[{"key":"title","label":"Title company","required":true},
           {"key":"hazard_insurance","label":"Hazard insurance agent","required":true}]'::jsonb),
       updated_at = now()
 WHERE code = 'lt_file_contacts'
   -- The exact seven the seed shipped, compared as a SET so key order cannot
   -- decide it. A row that is already the two, or that somebody has edited into
   -- something else, matches nothing here.
   AND (SELECT array_agg(t->>'key' ORDER BY t->>'key')
          FROM jsonb_array_elements(config->'contactTypes') t)
       = ARRAY['buyers_attorney','flood_insurance','hazard_insurance','ny_settlement_agent',
               'our_attorney','realtor','title']::text[];

-- The wording says what the condition now asks for, and where everyone else
-- lives. Guarded on the exact previous sentences, so an edited hint survives.
UPDATE checklist_templates
   SET hint = 'The two the file cannot be submitted without: the title company and the hazard insurance '
            || 'agent. Everyone else on the closing — the attorneys, the realtor, the settlement agent, the '
            || 'HOA, the landlord — lives in the File contacts section rather than being asked for here. '
            || 'Picked from the shared vendor directory rather than typed, so the same company is the same '
            || 'record on every file.',
       updated_at = now()
 WHERE code = 'lt_file_contacts'
   AND hint = 'Who is on this closing: title, hazard insurance, flood insurance, the buyer’s attorney, '
            || 'the realtor, our attorney, and — in New York — the settlement agent. Picked from the shared '
            || 'vendor directory rather than typed, so the same company is the same record on every file.';

UPDATE checklist_templates
   SET borrower_hint = 'Your title company and your insurance agent.',
       updated_at = now()
 WHERE code = 'lt_file_contacts'
   AND borrower_hint = 'Your title company, your insurance agent, your attorney and your realtor.';
