-- ============================================================================
-- db/696 — the minimum origination fee ($2,500), per company and per file
--
-- WHAT THIS CHANGES, AND WHY. Owner-directed 2026-09-04: every RTL program —
-- Standard, Gold, Silver, Speed and Manual — now charges a MINIMUM origination
-- fee, because on a small loan no percentage reaches a sensible number ("if the
-- loan amount is 100,000 it's going to be more than the origination set by
-- percentage because no matter the percentage it's not going to get to 2500 and
-- 2500 is the minimum"). At today's 1.25% the minimum is reached at a $200,000
-- loan, so it binds below that and on nothing above it.
--
-- Two columns, and BOTH ARE NULLABLE WITH NO DEFAULT ON PURPOSE — that is the
-- whole design, not an omission:
--
--   company_pricing_settings.min_orig_fee   NULL = use the system default (2500)
--   applications.file_min_orig_fee          NULL = use the company default
--
-- The owner's words are "pre-filled … should not be pre-set". A DEFAULT here
-- would be the opposite: it would stamp 2500 onto every row at insert, and a
-- stamped value is an EXPLICIT per-file override that outlives every later
-- change to the company number. That is the 2026-08-20 defect (a restated
-- default frozen onto a file, re-priced from a stale copy forever and routed to
-- an admin for approval on every registration) reproduced in the database
-- rather than in the studio. `src/lib/min-origination.js resolveMinFee` owns
-- the three-step chain; these columns only ever hold a DELIBERATE answer.
--
-- AND THE OWNER ASKED FOR EXACTLY THAT PROPERTY BY NAME (2026-09-04): "any
-- file, even if it's already in the system, by the next registration, it should
-- follow the rules of the new registration if it gets re-registered again.
-- Shouldn't be locked in where the fee was already locked in." A NULL that
-- stays NULL is what makes a re-registered file pick up today's company minimum
-- instead of the one in force the day it first registered.
--
-- THE ECONOMICS-REOPEN TRIGGER IS DELIBERATELY NOT WIDENED, for the reason
-- db/609 and db/632 both record: `file_min_orig_fee` can only ever be written
-- as part of a REGISTRATION, so there is never a stale registration for the
-- trigger to catch — a change to it always re-prices the file in the same
-- breath. Section F of the pure test enforces that single-writer claim, so a
-- second door added later cannot quietly invalidate it.
--
-- NO BACKFILL, AND THAT IS THE OWNER'S OWN CALL ("no mass registration right
-- now. Updating everything"). Both columns stay NULL on every existing row, so
-- no loan already on the book has its cash-to-close or its liquidity
-- requirement moved by this deploy — which would reopen Products & Pricing
-- (db/071/072) and un-sign live term sheets across the whole open book at once.
-- A live file picks the minimum up on its NEXT registration, which is exactly
-- what was asked for, and a file already out for signature is protected by the
-- existing term-sheet freeze either way.
--
-- IDEMPOTENT: two `ADD COLUMN IF NOT EXISTS` and two CHECKs dropped before they
-- are re-added. Nothing here reads or writes a row.
--
-- PRODUCT SEPARATION: RTL only. `applications` and `company_pricing_settings`
-- are RTL tables; nothing here is named `lt_*` and nothing reaches into
-- Long-Term.
-- ============================================================================

-- ── the company-wide minimum, set in the Pricing Admin Center ───────────────
-- "also in the admin section where we pre-set everything for the entire program
--  where we can increase and decrease the minimum accordingly."
ALTER TABLE company_pricing_settings
  ADD COLUMN IF NOT EXISTS min_orig_fee numeric(12,2);

COMMENT ON COLUMN company_pricing_settings.min_orig_fee IS
  'Minimum origination fee in dollars, company-wide, across every RTL program. NULL = use the system default ($2,500) — never a stamped copy of it. An explicit 0 is a deliberate company-wide waiver and is honoured. src/lib/min-origination.js is the one definition.';

-- A minimum of a few thousand dollars is the shape of this number; 250000 is a
-- decimal slip that would make every small loan unquotable, silently. The
-- ceiling is asserted here as well as in the JS so a value typed straight into
-- the database cannot do what the admin route refuses.
ALTER TABLE company_pricing_settings DROP CONSTRAINT IF EXISTS company_pricing_settings_min_orig_fee_chk;
ALTER TABLE company_pricing_settings ADD CONSTRAINT company_pricing_settings_min_orig_fee_chk
  CHECK (min_orig_fee IS NULL OR (min_orig_fee >= 0 AND min_orig_fee <= 25000));

-- ── the per-file minimum: an approved exception, and nothing else ───────────
-- "You need to add to the general exception pad an exception for the minimum."
-- Written ONLY by a registration, and only when an admin has deliberately set
-- one; a blank box writes NULL over any stale value, which is what stops a file
-- being locked in at yesterday's number.
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS file_min_orig_fee numeric(12,2);

COMMENT ON COLUMN applications.file_min_orig_fee IS
  'Per-file minimum origination fee in dollars — an APPROVED EXCEPTION, never a copy of the company default. NULL = follow the company minimum (the normal state for every file). 0 = the minimum was waived for this file by an approved exception. Written only by the register path; a blank admin box clears it, so a re-registered file follows today''s rules rather than the ones in force when it first registered.';

ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_file_min_orig_fee_chk;
ALTER TABLE applications ADD CONSTRAINT applications_file_min_orig_fee_chk
  CHECK (file_min_orig_fee IS NULL OR (file_min_orig_fee >= 0 AND file_min_orig_fee <= 25000));
