-- 390_liquidity_closing_buffer.sql — the 1% closing-cost buffer waiver flag
-- (owner-directed 2026-07-31, explicit written authorization for the liquidity
-- change: "For the liquidity requirement, add a buffer for extra closing costs
-- … about 1% of the loan amount … we should not run short. It's something that
-- we can waive on certain scenarios — on the manual side we can waive it.")
--
-- The buffer itself is computed in src/lib/pricing.js (server) and
-- web/v2/tools/termsheet.js (studio display): 1% of the total loan amount,
-- added to the liquidity requirement (cash to close + reserves + out-of-pocket
-- rehab + buffer). This column is ONLY the per-file waiver: false (default) =
-- the buffer applies; true = an admin waived it for this file. Set through
-- POST /api/staff/applications/:id/liquidity-buffer (manage_pricing, audited).
-- NULL never occurs (NOT NULL DEFAULT false) so the engines read a concrete
-- boolean. Idempotent.

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS liquidity_buffer_waived boolean NOT NULL DEFAULT false;
