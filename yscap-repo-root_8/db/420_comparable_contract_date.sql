-- 420 — THE DATE THE PRICE WAS AGREED, not just the date it settled
--
-- UAD writes a comparable's date of sale as "s06/25;c03/25" — SETTLED June 2025,
-- under CONTRACT March 2025. The parser read the first and threw the second
-- away, on every comparable of every report we have ever imported.
--
-- The contract date is the more useful of the two for market work: it is when
-- buyer and seller actually agreed the price. A settlement can follow that by
-- months, so a market that moved in between is misread by anyone who only has
-- the closing date — which is exactly why appraisers time-adjust from the
-- contract date, not the settlement.
--
-- PREVIOUS AND FUTURE, stated plainly: this is GOING-FORWARD by data. The value
-- can only come from re-reading the report's XML, and the warehouse ingest reads
-- the stored `appraisal_comparables` rows rather than the original file — so a
-- comparable imported before this migration keeps a NULL contract date, which
-- honestly means "we did not read it at the time", never "there wasn't one".
-- Anything that consumes it must treat NULL as unknown and fall back to the
-- settled date, never assume the two are the same.

ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS contract_date date;

COMMENT ON COLUMN appraisal_comparables.contract_date IS
  'UAD "c MM/YY" — when the sale went under contract, as distinct from sale_date '
  '(when it settled). NULL means the report was imported before we read it, or the '
  'grid stated no contract date; it never means the settled date can be used instead.';
