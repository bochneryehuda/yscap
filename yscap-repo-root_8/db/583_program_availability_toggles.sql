-- ============================================================================
-- db/583 — program availability toggles (owner-directed 2026-08-18)
--
-- The owner: "in the admin section where we control the RTL pricing, we should
-- have the option to turn on and turn off certain programs. For example, right
-- now we're discontinuing the gold program … the super admin in the manual
-- section should be able to say, hey, for this particular transaction, we're
-- turning on the gold program for stuff that's already in process … On the term
-- sheet generated products and pricing, that entire box of the gold program
-- should disappear … leave it in a setting where we can, any time, turn off and
-- turn on any program."
--
-- RTL ONLY. Two NULL-by-default jsonb columns; the rules that read them live in
-- ONE place, src/lib/program-availability.js. NO frozen pricing engine, formula
-- or number is touched — this gates which programs may be OFFERED/registered,
-- never how any program prices.
--
-- (A) COMPANY-WIDE per-program switches — the Pricing Admin Center. Shaped
--     { "gold": { "active": false, "note": "…" } } — only programs an admin has
--     turned OFF are stored (with the plain-language discontinued note shown
--     wherever the program resurfaces by exception). NULL / absent = every
--     program offered, exactly as before this feature existed.
ALTER TABLE company_pricing_settings
  ADD COLUMN IF NOT EXISTS program_availability jsonb;

-- (B) PER-FILE exceptions — the super-admin "turn it back on for THIS deal"
--     switch for files already in process when a program is discontinued.
--     Shaped { "gold": { "by": "<staff uuid>", "byName": "…", "at": "<iso>",
--     "reason": "…" } }. Written ONLY by the super-admin-gated, audited
--     POST /api/staff/applications/:id/program-exception. NULL = no exceptions.
--
--     DELIBERATELY NOT watched by the economics-reopen trigger: granting or
--     revoking an exception changes no priced number — it changes whether a
--     register door will ACCEPT that program, which the door itself enforces.
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS program_exceptions jsonb;

-- BACKFILL: none, deliberately. Both columns are NULL on every existing row,
-- which the one reader (src/lib/program-availability.js) defines as "every
-- program offered / no exceptions" — byte-identical behavior for previous AND
-- future files until an admin flips a switch in the Pricing Admin Center.

-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
