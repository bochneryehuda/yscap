-- ============================================================================
-- db/584 — discontinue the Gold Standard program company-wide (one-shot seed)
--
-- WHAT THIS CHANGES, AND WHY. The owner (2026-08-18, in their own words):
-- "right now we're discontinuing the gold program … That switch for the gold
-- program needs to be turned on" and, on go-live, "the Gold program should
-- also be discontinued from now" — the marketing site included. db/583 built
-- the switch but shipped it in the everything-offered state; this file FLIPS
-- Gold to discontinued on the current company pricing settings, ONCE, so the
-- deploy itself removes the Gold box from every quote surface (portal studio,
-- public term-sheet generator, homepage showcase) and every register door
-- refuses new Gold deals — while in-process files keep their terms and a
-- super admin can except a specific file from the file's Products & Pricing
-- panel exactly as db/583 built.
--
-- ONE-SHOT BY HISTORY, NEVER A RE-ASSERT. Migrations replay on EVERY boot, and
-- an admin may later turn Gold back ON in the Pricing Admin Center — which
-- stores program_availability as NULL again (only explicit-OFF rows are ever
-- stored, so "everything on" and "never configured" are the same value on the
-- CURRENT row). A guard on the current row alone would therefore re-discontinue
-- Gold on the next deploy, forever fighting the admin. The NOT EXISTS below
-- keys on the WHOLE version history instead: this seed fires only while no
-- settings version has EVER carried a program_availability value — and the
-- seed itself writes one, so after the first firing (or after any admin has
-- touched the program switches) it can never fire again. The admin's choice
-- always wins from then on.
--
-- No note is seeded: readers fall back to program-availability.js's
-- defaultDiscontinuedNote wording ("The Gold Standard program has been
-- discontinued and is not being offered on new deals right now."), which the
-- admin can replace per program in the Pricing Admin Center.
--
-- BACKFILL: this IS the backfill — one UPDATE of the current settings row.
-- Nothing on applications moves (no file's terms, registration or conditions
-- are touched; the db/071/072 reopen triggers watch applications, not
-- company_pricing_settings). On a BRAND-NEW database the seed fires too:
-- db/099 seeds the initial current settings row earlier in the same boot, so
-- even a fresh install starts with Gold discontinued — which is the owner's
-- "discontinued from now", and one Admin Center switch away from re-enabled.
--
-- PRODUCT SEPARATION. company_pricing_settings is RTL's pricing table; nothing
-- lt_* is referenced.
-- ============================================================================

UPDATE company_pricing_settings
   SET program_availability = '{"gold":{"active":false}}'::jsonb
 WHERE is_current
   AND program_availability IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM company_pricing_settings WHERE program_availability IS NOT NULL
       );
