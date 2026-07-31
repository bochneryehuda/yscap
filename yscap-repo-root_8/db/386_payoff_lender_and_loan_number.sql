-- 386 — WHO we are paying off, and WHICH loan (owner-directed 2026-07-31).
--
-- The owner: "within the loan application we should also be able to enter who is
-- the lender that we need to pay off, which loan does it need to pay off, the
-- lender and the loan number of the loan that needs to be paid off — it should be
-- part of the real structure, also on the term sheet, also on the structure
-- screen, everywhere, by refinancing transaction."
--
-- `payoff_amount` already exists (db/032) and the cash-out family came with
-- db/267 (`existing_debt`, `estimated_cash_out`, `verified_cash_out`,
-- `refinance_economic_type`). What was missing is the IDENTITY of the debt being
-- retired: a dollar amount alone does not tell the closing attorney, the title
-- company or the settlement agent who to request a payoff letter FROM, or which
-- account it applies to. That is the difference between a term sheet that can be
-- closed off and one that generates a phone call.
--
-- Both are free TEXT on purpose:
--   · a payoff lender is whoever holds the note — a bank, a private lender, a
--     seller carrying paper, an estate — so an enum would be wrong on day one;
--   · a loan number is a lender's own reference and is routinely alphanumeric
--     with dashes/slashes, and sometimes longer than any number type would hold.
-- Neither is ever used in arithmetic, so there is nothing to normalize here.
--
-- Additive + idempotent. NULL on every existing row, which reads as "not stated"
-- — never as "there is no lender" (the same missing-vs-zero discipline db/267
-- documents for the cash-out figures).

ALTER TABLE applications
  -- Who holds the loan being paid off, as the borrower/officer writes it.
  ADD COLUMN IF NOT EXISTS payoff_lender      text,
  -- That lender's own reference for the loan being retired.
  ADD COLUMN IF NOT EXISTS payoff_loan_number text;

COMMENT ON COLUMN applications.payoff_lender IS
  'Refinance only: who holds the loan being paid off (free text — bank, private lender, seller). Display/record; never used in pricing math.';
COMMENT ON COLUMN applications.payoff_loan_number IS
  'Refinance only: the payoff lender''s own loan/account number for the debt being retired. Free text — often alphanumeric.';
