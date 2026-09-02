-- ============================================================================
-- db/676 — the landlord memory remembers that a person said no
--
-- WHAT THIS FIXES. `lt_borrower_landlords` (db/662) remembers the landlord a
-- borrower had at the home they rent, and `routes/orders.js` fills that
-- landlord in on EVERY read of the file contacts (`landlordMemory.applyForLoan`
-- is fill-only, so it was safe to call on every read). Taking that landlord OFF
-- the file — DELETE /vendors/:linkId — removed the link and nothing else, so
-- the very next read of the screen filled the same card straight back in. A
-- person could never make the removal stick, and the only visible symptom was
-- a landlord who kept reappearing.
--
-- WHY A STAMP AND NOT A DELETE. The module's own rule is "a later answer
-- replaces an earlier one at the same address" — the memory is a RECORD of
-- what was known, and a person unlinking a landlord is one more answer about
-- that home, not a reason to forget the earlier ones existed. So the row stays
-- and carries `declined_at`: `suggestForLoan` ignores a declined row, and
-- putting a landlord back on the file (`rememberForLoan`) clears the stamp,
-- because a person who links a card has answered again. Deleting the rows
-- for `last_loan_id = this loan` would also have missed the case that
-- actually happened: the memory was written by an EARLIER loan and applied to
-- this one, so its `last_loan_id` was never this loan at all.
--
-- BACKFILL: none. Every existing memory stands as it was; NULL means "nobody
-- has declined this", which is the truth for all of them.
--
-- PRODUCT SEPARATION: `lt_*` only.
-- ============================================================================

ALTER TABLE lt_borrower_landlords ADD COLUMN IF NOT EXISTS declined_at timestamptz;

COMMENT ON COLUMN lt_borrower_landlords.declined_at IS
  'When a person took this landlord off a file for this home (DELETE /api/lt/orders/loans/:id/vendors/:linkId). A declined memory is never filled in again; linking a landlord for the same home clears it. NULL = nobody has declined it.';
