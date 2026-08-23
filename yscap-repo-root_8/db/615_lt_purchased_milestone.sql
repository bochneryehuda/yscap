-- ============================================================================
-- db/615 — LONG-TERM: the two columns behind the PURCHASED step.
--
-- WHAT THIS CHANGES, AND WHY. The owner's own workflow carries a step Encompass
-- does not (owner-directed 2026-08-23: *"the purchase is a new milestone, and yes,
-- you can build this up"*). Encompass has nineteen milestones and none of them is
-- "the investor bought this loan" — its late steps (Investor Delivery → Purchasing
-- Conditions → Final Docs) are about the WORK around a sale, not the sale.
--
-- The fact itself is already in Encompass and has never been mirrored: field 2031,
-- `loan.rateLock.sellSideInvestorStatus`, a READ-ONLY dropdown whose values are
-- Unassigned / Assigned - Bulk / Assigned - Flow / Shipped / Purchased / Rejected.
-- Measured over the 772-loan census (2026-08-14) it is filled on 100% of loans at
-- Investor Delivery, Purchasing Conditions and Final Docs, and reads "Purchased" on
-- 187 of the 188 loans that carry it. Field 2370 (Purchase Advice Date) carries the
-- day, on 175 of the 490 long-term loans — the same population as the status.
--
-- WHY TWO COLUMNS AND NOT A BOOLEAN. `purchased_status` is Encompass's own word,
-- stored verbatim, and whether that word means "bought" is decided in one place
-- (`src/longterm/milestone-purchased.js`) from a setting. A stored boolean would be
-- a second answer to the same question, free to drift from the word beside it — and
-- "not purchased" covers four different states (unassigned, assigned, shipped,
-- rejected) that a boolean cannot tell apart and a screen genuinely needs to.
--
-- WHY NOT A ROW IN `lt_encompass_milestones`. That table is the TENANT'S Encompass
-- catalog, and `sync/milestone-catalog.js` archives anything Encompass stops
-- listing — which would archive our step on its first pass, every pass. The step is
-- declared in settings and spliced into the ladder when a screen is built, so there
-- is nothing for the catalog sync to fight over.
--
-- WHY NOT A ROW IN `lt_milestone_events`. Every row there is dated `observed_at`,
-- meaning the day PILOT NOTICED — that is the promise its whole header is built on.
-- The purchase has a REAL date from Encompass, so writing it into that table would
-- either lose the date or break the promise.
--
-- IDEMPOTENT: two guarded column adds and one guarded index. Re-runs on every boot
-- and changes nothing on the second pass.
--
-- BACKFILL: NONE, and deliberately. Both columns are filled by the ordinary loan
-- sync, which re-reads a loan whenever Encompass's own modification stamp is newer
-- than ours — so the whole book fills itself on the next drain without a single
-- extra Encompass call, and a loan we cannot read keeps NULL, which reads correctly
-- as "we do not know" rather than as "not sold".
--
-- PRODUCT SEPARATION: `lt_*` only. No RTL table is read or written, no trigger and
-- no function is defined, and nothing here implies a write to Encompass.
-- ============================================================================

ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS purchased_status TEXT;
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS purchased_at     DATE;

COMMENT ON COLUMN lt_loans.purchased_status IS
  'Encompass field 2031 (sell-side investor status), verbatim. Whether it means PURCHASED is decided by milestones.purchasedStatusValues, never stored.';
COMMENT ON COLUMN lt_loans.purchased_at IS
  'Encompass field 2370 (purchase advice date) — the day the investor bought the loan. NULL means unknown, never "not sold".';

-- Answers "which of these loans have been sold" without scanning the book. Partial,
-- because the question is only ever asked of the rows that carry a status at all.
CREATE INDEX IF NOT EXISTS lt_loans_purchased_status_idx
  ON lt_loans (purchased_status)
  WHERE purchased_status IS NOT NULL;


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself.
