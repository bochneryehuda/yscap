-- ============================================================================
-- db/633 — the New York CEMA question and its $1,000 fee
--
-- WHAT THIS CHANGES, AND WHY. Owner-directed 2026-08-26, in the owner's own
-- words — the written authorization the frozen-pricing HARD RULE requires:
--
--   "if it's a New York refinance, which means either refinance, cash-out, or
--    rate and term, then at the final registration before clicking Register
--    Product, you should ask a question if it's a New York CEMA. If it's a New
--    York CEMA … then you should populate an extra $1,000 for the CEMA fee.
--    This should also be adjustable in the manual section … It should be turned
--    off by default … It should be pre-filled as $1,000, but it's always turned
--    off."
--
-- WHAT A CEMA IS. A Consolidation, Extension and Modification Agreement is a New
-- York instrument: on a refinance the existing lender ASSIGNS its mortgage and
-- the two are consolidated, instead of the old one being satisfied and a new one
-- recorded. It carries extra legal and coordination work with the current
-- lender, and this fee covers that.
--
-- OFF BY DEFAULT, AND THAT IS THE SHAPE OF IT. `ny_cema` is `NOT NULL DEFAULT
-- false`, and `src/lib/lender-fees.cemaFeeFor` returns nothing unless the answer
-- is an explicit TRUE — so no file is charged this by accident and every quote
-- that exists today prices byte-for-byte as it does now. The fee is offered only
-- on a NEW YORK REFINANCE, judged through `deal-basis.sizesOnAsIsValue`, the ONE
-- definition the frozen engine itself sizes on.
--
-- WHAT THIS DELIBERATELY DOES NOT DO, stated here rather than left to be
-- discovered: a real CEMA also REDUCES the New York mortgage recording tax,
-- because the tax is levied on the new money rather than on the whole loan —
-- that is the reason borrowers ask for one. The owner asked for the FEE and said
-- nothing about the tax, and the tax tables are a frozen rule module, so nothing
-- here touches them. The consequence is that a CEMA file is quoted the FULL
-- mortgage tax, which OVERSTATES cash to close — the conservative direction, and
-- the one that cannot leave a borrower short. Raised with the owner rather than
-- guessed at.
--
-- TWO COLUMNS, TWO DIFFERENT JOBS:
--   · applications.ny_cema — the ANSWER to the registration question. NOT NULL
--     DEFAULT false, because "nobody has said this is a CEMA" and "somebody said
--     no" price identically and there is nothing to tell apart.
--   · applications.file_cema_fee — the per-file AMOUNT ("this should also be
--     adjustable in the manual section"). NULL = the company pre-fill ($1,000,
--     in company_pricing_settings.lender_fees.cemaNy, added by db/632); a typed
--     0 means the fee is deliberately WAIVED on this file, which is why it is
--     nullable numeric and not a DEFAULT 0.
--
-- NO SIZING NUMBER MOVES: the loan amount, the note rate, every cap and the
-- whole sizing waterfall are computed above this fee and never read it. It
-- cascades into cash-to-close and the liquidity the borrower must show, which is
-- what a real borrower closing cost does.
--
-- NO BACKFILL. Every existing file answers "no" (the column default) and carries
-- no per-file amount, so nothing about any live quote changes until somebody
-- answers the question on a New York refinance.
--
-- THE ECONOMICS-REOPEN TRIGGER IS DELIBERATELY NOT WIDENED, for db/609's and
-- db/632's reason: both columns can only ever be written as part of a
-- REGISTRATION (the staff register route), so there is never a stale
-- registration for the trigger to catch. Section J of
-- scripts/test-lender-fees-pure.js enforces that single-writer claim.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS, and the settings seed writes only where
-- the key is still absent, so an admin's own later value is never overwritten.
--
-- PRODUCT SEPARATION: RTL only. `applications` and `company_pricing_settings`
-- ARE the RTL product's tables; the Long-Term side has its own `lt_*` tables and
-- does not appear here.
-- ============================================================================

-- The ANSWER. false = not a CEMA (or nobody has said it is) — the two price the
-- same, so there is nothing to tell apart and the column is NOT NULL.
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS ny_cema boolean NOT NULL DEFAULT false;

-- The per-file AMOUNT. NULL = the company pre-fill; 0 = deliberately waived.
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS file_cema_fee numeric;

-- The company pre-fill joins the fee set db/632 created. Written only where the
-- key is still absent, so an admin who has already set their own is untouched.
UPDATE company_pricing_settings
   SET lender_fees = jsonb_set(COALESCE(lender_fees, '{}'::jsonb), '{cemaNy}', '1000'::jsonb)
 WHERE lender_fees IS NULL
    OR jsonb_typeof(lender_fees) <> 'object'
    OR NOT (lender_fees ? 'cemaNy');
