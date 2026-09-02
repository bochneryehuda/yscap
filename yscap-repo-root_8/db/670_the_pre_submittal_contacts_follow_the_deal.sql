-- ============================================================================
-- db/670 — the pre-submittal file-contacts condition follows the deal
--
-- WHAT THIS CHANGES, AND WHY. Owner-directed 2026-09-02, on the file-contacts
-- CONDITION (not the File contacts desk): *"prior to submittal, we only have
-- hazard insurance and title insurance. This file is actually his primary,
-- and we don't have the slot over there for landlord contact information …
-- if he's a renter, it should also populate landlord contact … If it's a
-- condo, populate the condo. If it's a New York file, populate the settlement
-- agent according to the conditions."*
--
-- db/667 cut the condition to the two every file needs. This keeps those two
-- and adds the THREE THAT FOLLOW THE DEAL, each carrying the rule field that
-- turns it on (`whenField`): the landlord where the borrower rents where they
-- live (FR0115), the HOA management company on a condominium (field 1041),
-- the settlement agent on a New York file (field 14). The read side
-- (`conditions-center/read.js contactTypesFor`) answers each row
-- `applies: true / false / null` from the file's own live facts: a row a deal
-- does not need is kept and greyed with the reason, never dropped; a fact PILOT
-- cannot read yet is "we cannot tell yet", never a confident no. `required`
-- means required WHEN IT APPLIES — the sign-off gate and the screen read
-- `applies !== false && required`. So a homeowner's New Jersey purchase of a
-- single-family home still asks for exactly the two.
--
-- THE STAND-ALONE HOA CONDITION IS RETIRED. `lt_hoa_contact` asked for the
-- same `hoa` vendor row this condition now asks for, so a condo file would
-- have carried the same question twice. Retired the way db/660 retired the
-- landlord and payoff-servicer conditions: `is_active = false` plus
-- `config.enabled / disabledReason`, out of the library on disk, and the
-- engine takes an UNTOUCHED instance off each file on its next pass while a
-- worked one (a note, a document, an answer) stays where it is. The vendor
-- row itself is untouched — it is on the File contacts desk and on this
-- condition either way.
--
-- WHY A MIGRATION AT ALL. `library.seed` is `ON CONFLICT (code) DO NOTHING`
-- on purpose — a buyer's own edit survives every redeploy — so editing the
-- library alone changes new databases and no existing one, silently. `config`
-- is read off the TEMPLATE (`read.js`), so one row updated here reaches every
-- file at once.
--
-- IDEMPOTENT, AND A HAND-EDITED ROW SURVIVES. The contact-types statement is
-- guarded on the exact TWO-key set db/667 shipped, compared as a set so key
-- order cannot decide it; a row already holding the five, or edited into
-- something else, matches nothing. The wording statements are guarded on the
-- exact sentences they replace. The retirement is guarded on `is_active`.
--
-- BACKFILL: none beyond this. No `checklist_items` row carries a copy of
-- `config`; a landlord, HOA or settlement-agent card already on a file keeps
-- its `lt_loan_vendors` row and now satisfies the row on this condition.
--
-- PRODUCT SEPARATION, AND WHY THIS FILE IS NOT NAMED `_lt_`. It touches
-- `checklist_templates`, the SHARED Condition Center table (db/652/653) — the
-- rows are Long-Term's (`lt_file_contacts`, `lt_hoa_contact`) and no RTL
-- template is read or written — and a `db/NNN_lt_*.sql` name may only touch
-- `lt_*` tables. The same reasoning names db/660 and db/667.
-- ============================================================================

-- ── 1. THE FIVE ROWS ON THE CONDITION ───────────────────────────────────────
-- The labels are the vendor directory's own (`orders/kinds.js VENDOR_KINDS`),
-- which is what the library derives them from — never a second spelling.
UPDATE checklist_templates
   SET config = jsonb_set(
         config,
         '{contactTypes}',
         '[{"key":"title","label":"Title company","required":true},
           {"key":"hazard_insurance","label":"Hazard insurance agent","required":true},
           {"key":"ny_settlement_agent","label":"Settlement agent","required":true,"whenField":"is_new_york"},
           {"key":"hoa","label":"HOA management company","required":true,"whenField":"is_condo"},
           {"key":"landlord","label":"Landlord","required":true,"whenField":"borrower_rents"}]'::jsonb),
       updated_at = now()
 WHERE code = 'lt_file_contacts'
   AND scope = 'lt_loan'
   -- Exactly the two db/667 shipped, as a SET.
   AND (SELECT array_agg(t->>'key' ORDER BY t->>'key')
          FROM jsonb_array_elements(config->'contactTypes') t)
       = ARRAY['hazard_insurance','title']::text[];

-- ── 2. THE WORDING SAYS WHAT IS ASKED, AND WHEN ─────────────────────────────
UPDATE checklist_templates
   SET hint = 'The title company and the hazard insurance agent on every file — and, when the deal calls '
            || 'for them, the landlord (the borrower rents where they live), the HOA management company (a '
            || 'condominium) and the settlement agent (a New York file); each of those three is greyed with '
            || 'the reason on a file that does not need it. The attorneys and the realtor live in the File '
            || 'contacts section rather than being asked for here. Picked from the shared vendor directory '
            || 'rather than typed, so the same company is the same record on every file.',
       updated_at = now()
 WHERE code = 'lt_file_contacts'
   AND scope = 'lt_loan'
   AND hint = 'The two the file cannot be submitted without: the title company and the hazard insurance '
            || 'agent. Everyone else on the closing — the attorneys, the realtor, the settlement agent, the '
            || 'HOA, the landlord — lives in the File contacts section rather than being asked for here. '
            || 'Picked from the shared vendor directory rather than typed, so the same company is the same '
            || 'record on every file.';

UPDATE checklist_templates
   SET borrower_hint = 'Your title company and your insurance agent — and your landlord, your condo’s '
                    || 'management company or your settlement agent where they apply.',
       updated_at = now()
 WHERE code = 'lt_file_contacts'
   AND scope = 'lt_loan'
   AND borrower_hint = 'Your title company and your insurance agent.';

-- ── 3. RETIRE THE STAND-ALONE HOA CONDITION ─────────────────────────────────
-- The same shape as db/660 §2: inactive, switched off in the library screen's
-- own words, and a reader is told it is RETIRED rather than pointed at a switch.
UPDATE checklist_templates
   SET is_active = false,
       config = COALESCE(config, '{}'::jsonb) || jsonb_build_object(
         'enabled', false,
         'disabledReason',
         'Retired 2026-09-02 (owner-directed). The HOA management company is asked for on the File '
         || 'contacts condition itself, where the row turns on only on a condominium — the same vendor '
         || 'row this condition used to collect, so nothing on a file is lost.'),
       updated_at = now()
 WHERE code = 'lt_hoa_contact'
   AND scope = 'lt_loan'
   AND is_active IS DISTINCT FROM false;


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
