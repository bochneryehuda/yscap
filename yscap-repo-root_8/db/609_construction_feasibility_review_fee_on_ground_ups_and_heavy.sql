-- ============================================================================
-- db/609 — construction feasibility review fee on ground ups and heavy rehabs
--
-- WHAT THIS CHANGES, AND WHY. Owner-directed 2026-08-21, in the owner's own
-- words — which is the written authorization the frozen-pricing HARD RULE
-- requires before any guideline or fee number may move:
--
--   "On the Term Sheets for Ground Up Construction Projects, add a $1,250
--    ground up construction feasibility review fee and general project review …
--    For heavy rehab projects, add the same type of fee … but it should be only
--    a $750 extra fee for this. Implement that into the term sheet generator,
--    into the products and pricing, into the closing cost calculation, and
--    everywhere else where it's considered. Also add this fee type into the
--    manual section in the products and pricing so we can, any time, add it to
--    any other project manually as well."
--
-- On a construction loan the lender does not take the borrower's budget on
-- trust: a third-party construction firm reads the plans, the permits, the
-- contractor's numbers and the schedule and answers whether the project can be
-- built for that money in that time. It is a real third-party cost with an
-- invoice behind it — never a lender margin — so it is quoted as its own named
-- closing-cost line, exactly as the admin-managed extra fees (the NY
-- settlement-agent fee) already are.
--
-- TWO PLACES, TWO DIFFERENT JOBS:
--   · company_pricing_settings.feasibility_fees — the COMPANY defaults, shaped
--     { "groundUp": 1250, "heavyRehab": 750 }, edited in the Pricing Admin
--     Center. jsonb rather than two numeric columns because the shape belongs to
--     ONE rule (src/lib/feasibility-fee.js) and a future third depth would
--     otherwise need another migration and another column on every read.
--   · applications.file_feasibility_fee — the per-file MANUAL amount the owner
--     asked for ("add it to any other project manually as well"). NULL means
--     "use the company default for this deal's kind"; a typed 0 means the fee is
--     deliberately WAIVED on this file, which is why the column is nullable
--     numeric and not a DEFAULT 0.
--
-- NO SIZING NUMBER MOVES. The fee is a cost, not an input: the loan amount, the
-- note rate, every LTV/LTC/ARV cap and the whole sizing waterfall are untouched.
-- It cascades into cash-to-close and the liquidity the borrower must show, which
-- is what a real borrower closing cost does.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS, and the seed writes only where the
-- column is still NULL, so an admin's own later value is never overwritten.
--
-- NO BACKFILL OF FILES, DELIBERATELY. `file_feasibility_fee` stays NULL on every
-- existing file: NULL reads as "use the company default", so a live ground-up
-- picks the fee up on its next quote without anybody stamping a number onto a
-- deal that was priced before this existed. A file whose terms are already out
-- for signature is protected by the ordinary term-sheet freeze, not by this.
--
-- PRODUCT SEPARATION: RTL only. `applications` and `company_pricing_settings`
-- ARE the RTL product's tables; the Long-Term side has its own `lt_*` tables and
-- does not appear here.
-- ============================================================================

ALTER TABLE company_pricing_settings
  ADD COLUMN IF NOT EXISTS feasibility_fees jsonb;

-- The owner's numbers, onto the CURRENT settings row only, and only while nobody
-- has set their own. `pricing-settings.shape()` falls back to the same pair when
-- the column is NULL, so this seed is a convenience for the admin screen rather
-- than something the pricing path depends on.
UPDATE company_pricing_settings
   SET feasibility_fees = '{"groundUp": 1250, "heavyRehab": 750}'::jsonb
 WHERE feasibility_fees IS NULL;

-- The per-file manual amount. NULL = the company default for this deal's kind;
-- 0 = deliberately waived on this file.
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS file_feasibility_fee numeric;

-- WHY THE ECONOMICS-REOPEN TRIGGER IS *NOT* WIDENED FOR THIS COLUMN, and it is a
-- deliberate decision rather than an oversight. db/071/072's
-- `reopen_conditions_on_budget_change()` reopens Products & Pricing when a
-- pricing INPUT moves on a registered file — but `file_feasibility_fee` can only
-- ever be written by the REGISTER path itself (the studio's manual box is read
-- when somebody presses Register, exactly like `file_markup_*_pct`), so by
-- construction the registration is always fresh at the moment the value lands.
-- There is nothing stale for the trigger to catch.
--
-- The first cut of this file DID widen it, by reading the live function's own
-- source with `pg_get_functiondef` and splicing a clause into it. That was
-- clever and wrong: this function has been re-created by SIXTEEN different
-- migrations (071, 072, 074, 096, 126, 145, 190, 280, 288, 322, 326, 373, 382,
-- 383, 466, 486), so the text it is anchored on has drifted more than once and
-- would drift again — and a splice that silently misses its anchor leaves the
-- column unwatched while the migration reports success. The rule this repo
-- already learned twice (`pilot_term_norm`, `pilot_property_type_norm`) is that a
-- second copy of a rule drifts from the first; a function that rewrites another
-- function's source is that trap with an extra step.
--
-- If a door is ever added that changes this fee WITHOUT re-registering, widen the
-- trigger the way every other migration here does — by re-stating the function in
-- a new numbered file — and add that door to the single-writer test in
-- `scripts/test-feasibility-fee-pure.js`, which is what would catch it.
