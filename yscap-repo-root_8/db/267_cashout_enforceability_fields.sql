-- 266 — Cash-out / refinance enforceability fields (R6.7, owner-directed 2026-07-22).
--
-- The earlier automated audits found cash-out treatment could not always be
-- enforced without payoff, net-proceeds, and verified-hard-cost inputs. The
-- whole-loan structure underwriter (R6.6) needs these to enforce: a rate-&-term
-- that behaves economically as cash-out, cash-out missing a payoff, cash-out
-- above verified hard costs, and cash-out above the escalation threshold.
--
-- `payoff_amount` already exists (db/032). This adds the remaining fields.
-- Additive + idempotent; all NULL on existing rows (a missing value must read as
-- unknown, never as zero — the whole-loan context wraps them as such).

ALTER TABLE applications
  -- Total existing debt against the property (may exceed the single payoff when
  -- there are junior liens).
  ADD COLUMN IF NOT EXISTS existing_debt              numeric(14,2),
  -- Cash-out proceeds: what the borrower estimated vs what was verified.
  ADD COLUMN IF NOT EXISTS estimated_cash_out         numeric(14,2),
  ADD COLUMN IF NOT EXISTS verified_cash_out          numeric(14,2),
  -- Verified hard costs already spent on the project (bounds legitimate cash-out
  -- reimbursement).
  ADD COLUMN IF NOT EXISTS verified_hard_costs        numeric(14,2),
  -- Costs the borrower has already paid out of pocket (reimbursable basis).
  ADD COLUMN IF NOT EXISTS costs_already_paid         numeric(14,2),
  -- Whether closing costs are financed from the loan proceeds.
  ADD COLUMN IF NOT EXISTS closing_cost_from_proceeds boolean,
  -- The ECONOMIC refinance classification, independent of how it was labeled:
  -- 'rate_term' | 'cash_out' | NULL. The structure underwriter sets a finding
  -- when the label disagrees with the economics (a rate-&-term that nets the
  -- borrower cash is really a cash-out).
  ADD COLUMN IF NOT EXISTS refinance_economic_type    text;

COMMENT ON COLUMN applications.refinance_economic_type IS
  'Economic refi classification (rate_term|cash_out) derived by the structure underwriter; a mismatch with the stated purpose raises a finding.';
