-- ============================================================================
-- db/660 — the landlord and the payoff servicer stop being their own conditions
--
-- WHAT THIS CHANGES, AND WHY. Owner-directed 2026-08-31, twice:
--
--   *"I see now that the landlord contact details condition doesn't have a real
--   availability to pull in a contact. Only internal notes. You can technically
--   remove that condition. Landlord contact details: you can just add landlord
--   contact information directly to the file contact condition and the
--   FileContacts section. You should also be able to fill it directly on the
--   verification of rent condition and the entire verification of rent sent as
--   well."*
--
--   *"Servicer of the loan being paid off — this is now a separate condition. We
--   don't need this to be a separate condition."*
--
-- Both are CONTACTS, and a contact now has a home: the File contacts desk, where
-- the landlord row appears only when the borrower rents and the payoff row only
-- on a refinance (db/659). A condition is a row somebody has to clear before the
-- file moves, which is a heavier thing than "who do we write to", and neither of
-- these was ever the reason a file was held.
--
-- WHY A MIGRATION. `library.seed` is `ON CONFLICT (code) DO NOTHING`, so removing
-- the two entries from the library stops a NEW database ever getting them and
-- leaves every existing one holding both — on every renting borrower and every
-- refinance in the book. This is the half the code change cannot do.
--
-- RETIRED, NOT DELETED. `checklist_items.template_id` points at these rows on
-- every file that carries one, so deleting the template would either cascade
-- those conditions away or be refused. `is_active = false` takes them out of the
-- library the engine reads, and the engine then RETRACTS what it created and
-- nobody has touched, file by file, on each file's next evaluation. That is the
-- owner's own answer to what should happen to the ones already out there — *"take
-- them off, but keep any work already done"* — and it is the engine's existing
-- rule rather than a second one written here: a row with a note, a document, or a
-- typed answer on it is left exactly where it is, for a human.
--
-- THE TENANCY FACTS ARE CARRIED FIRST, and the order is load-bearing. The
-- monthly rent and the date the tenancy started were typed onto the landlord
-- condition and are what the verification-of-rent form is built from; they now
-- live on `lt_vor_sent` (`config.fields`). This file runs at boot, BEFORE any
-- evaluation, so the copy happens while the row is still there to copy from.
--
-- IDEMPOTENT. The carry writes only where the destination has no value of its
-- own; the retirement is guarded on the state it is changing. Both are no-ops
-- from the second boot.
--
-- BACKFILL: the carry above IS the backfill, and it is deliberately CONSERVATIVE
-- — an answer already on the verification-of-rent condition is never overwritten
-- by an older one from a condition being retired.
--
-- PRODUCT SEPARATION. Touches `checklist_templates` and `checklist_items`, the
-- SHARED Condition Center tables (db/652/653), and only rows whose template code
-- is `lt_*`. No RTL template or condition is read or written. Not named `_lt_`
-- for that reason — the rule is about the table, not whose row it is.
-- ============================================================================

-- ── 1. CARRY THE WORK ACROSS ────────────────────────────────────────────────
-- The rent and the tenancy start date move from the landlord condition to the
-- verification-of-rent condition on the same loan. Only the two keys that moved,
-- and only where the destination does not already hold that key — a value
-- somebody typed on the form itself is the newer one and wins.
UPDATE checklist_items vor
   SET tool_payload = COALESCE(vor.tool_payload, '{}'::jsonb)
                    || jsonb_strip_nulls(jsonb_build_object(
                         'monthly_rent',
                         CASE WHEN COALESCE(vor.tool_payload, '{}'::jsonb) ? 'monthly_rent'
                              THEN NULL ELSE src.payload -> 'monthly_rent' END,
                         'rented_since',
                         CASE WHEN COALESCE(vor.tool_payload, '{}'::jsonb) ? 'rented_since'
                              THEN NULL ELSE src.payload -> 'rented_since' END)),
       updated_at = now()
  FROM (SELECT ci.lt_loan_id, ci.tool_payload AS payload
          FROM checklist_items ci
          JOIN checklist_templates t ON t.id = ci.template_id
         WHERE t.code = 'lt_landlord_contact'
           AND ci.lt_loan_id IS NOT NULL
           AND ci.tool_payload IS NOT NULL
           AND (ci.tool_payload ? 'monthly_rent' OR ci.tool_payload ? 'rented_since')) src
 WHERE vor.lt_loan_id = src.lt_loan_id
   AND vor.template_id = (SELECT id FROM checklist_templates WHERE code = 'lt_vor_sent')
   -- Only when there is genuinely something to add, so a replay writes nothing.
   AND NOT (COALESCE(vor.tool_payload, '{}'::jsonb) ? 'monthly_rent'
            AND COALESCE(vor.tool_payload, '{}'::jsonb) ? 'rented_since');

-- ── 2. RETIRE THE TWO TEMPLATES ─────────────────────────────────────────────
-- `is_active = false` is exactly the state the library screen already calls "not
-- in the library", so nothing new has to learn what this means. `config.enabled`
-- and `config.disabledReason` are how this library records a switched-off row,
-- and a person reading a retired one is told it is retired rather than being
-- pointed at a switch to turn it back on.
UPDATE checklist_templates
   SET is_active = false,
       config = COALESCE(config, '{}'::jsonb) || jsonb_build_object(
         'enabled', false,
         'disabledReason',
         'Retired 2026-08-31 (owner-directed). The landlord is a contact like any other and lives on the '
         || 'File contacts desk, where the row appears only when the borrower rents; the rent and the date '
         || 'the tenancy started are filled in on the verification of rent itself.'),
       updated_at = now()
 WHERE code = 'lt_landlord_contact'
   AND is_active IS DISTINCT FROM false;

UPDATE checklist_templates
   SET is_active = false,
       config = COALESCE(config, '{}'::jsonb) || jsonb_build_object(
         'enabled', false,
         'disabledReason',
         'Retired 2026-08-31 (owner-directed). Who services the loan being paid off is a contact like any '
         || 'other and lives on the File contacts desk, where the row appears only on a refinance.'),
       updated_at = now()
 WHERE code = 'lt_payoff_contact'
   AND is_active IS DISTINCT FROM false;
