-- ============================================================================
-- db/611 — the LOAN SOLD stage, and the PAYOFF DEMAND stamp
--
-- TWO owner-directed 2026-08-21 additions, in one file because they are two
-- columns of the same kind: a post-funding EVENT with a DATE, which the file's
-- new Critical dates section reads and which a workflow keys on.
--
-- ── 1. SOLD ─────────────────────────────────────────────────────────────────
-- *"We need to enhance our system with the status Loan Sold: only for loans that
-- are not table funded. Loans that are table funded should not have such a
-- status … The files that are being sold should have a status of 'Sold', and
-- that status should automatically change when the PA date is filled. You can
-- backfill this on the table."*
--
-- WHY THIS IS A COLUMN AND NOT A NEW `applications.status` VALUE, stated here so
-- nobody "finishes the job" later without reading it. `status` is the file's
-- SERVICING state and 139 places in this codebase read it — 27 SQL predicates
-- and 17 JavaScript comparisons test `funded` specifically, among them the
-- purchase-advice sweep itself, draw eligibility, the investor delivery, the
-- data tapes and the funded-date sync. A loan that is SOLD is still funded and
-- still serviced by us — every draw continues, the delivery continues — so
-- moving the stored status off `funded` would silently switch all of that off,
-- and the failure would be invisible until somebody noticed a draw that never
-- appeared. So the STAGE is recorded here and DISPLAYED as the file's status
-- wherever a status is shown (`lib/sold-status.js` is the one definition), while
-- the stored status stays `funded` and every servicing query keeps working.
--
--   sold_at      the date the loan was sold — the PURCHASE ADVICE DATE from
--                Encompass, which is the fact the owner named. Never a
--                timestamp of when PILOT noticed: the date belongs to the loan.
--   sold_source  what established it, so a value is always traceable:
--                'encompass_pa' (the advice date), 'desk' (our purchasing
--                desk's own record), 'manual' (a human said so).
--
-- TABLE-FUNDED LOANS DELIBERATELY NEVER GET ONE. They were sold at the closing
-- table, receive no purchase advice, and the owner asked for exactly that
-- exclusion. The rule for WHICH loans those are is not restated here — it is
-- `src/lib/funding-channel.js` + `release-party.soldStatus`, and the backfill
-- runs in JavaScript through that one definition rather than as SQL that would
-- become a second, drifting copy of it.
--
-- ── 2. PAYOFF DEMAND ────────────────────────────────────────────────────────
-- *"we should add a workflow which would be 'Pay Off Demand Requested'. This is
-- whenever a borrower requests a payoff letter, then the draw center needs to be
-- locked up … Our system should have a stamp when the payoff was requested, and
-- that should be added to the critical dates section also with the date.
-- Potentially, maybe we're going to add over there also a day that we can put in
-- for the actual payoff date, but that's not necessary yet."*
--
--   payoff_demand_requested_at   WHEN the borrower asked for the payoff letter.
--                                This is the stamp the draw block keys on.
--   payoff_demand_requested_by   which staff member recorded it.
--   payoff_demand_note           why / who asked, in their own words.
--   payoff_date                  the ACTUAL payoff date — the owner's "not
--                                necessary yet … we'll keep it just as an open
--                                thing". Added now because adding a column later
--                                to a table this size is the disruptive half;
--                                nothing reads it yet and nothing writes it.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS throughout,
-- and the CHECK is dropped before it is re-added.
--
-- NO SQL BACKFILL. `sold_at` is filled by `lib/sold-status.backfillSoldOnce`, in
-- JavaScript, through the ONE table-funded definition; a WHERE clause here would
-- be a second copy of that rule, free to drift the day a note buyer changes how
-- it funds. See db/601 for the same decision and the same reason.
--
-- PRODUCT SEPARATION: RTL only. `applications` IS the RTL product's table.
-- ============================================================================

ALTER TABLE applications ADD COLUMN IF NOT EXISTS sold_at     date;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS sold_source text;

ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_sold_source_chk;
ALTER TABLE applications ADD CONSTRAINT applications_sold_source_chk
  CHECK (sold_source IS NULL OR sold_source IN ('encompass_pa','desk','manual'));

-- The pipeline asks "which funded loans are sold?" and the backfill drains on
-- "which funded loans have never been judged", so both want this.
CREATE INDEX IF NOT EXISTS idx_applications_sold_at
  ON applications (sold_at)
  WHERE deleted_at IS NULL AND sold_at IS NOT NULL;

ALTER TABLE applications ADD COLUMN IF NOT EXISTS payoff_demand_requested_at timestamptz;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS payoff_demand_requested_by uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS payoff_demand_note         text;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS payoff_date                date;

-- The draw desk asks "is there a payoff demand on this file?" on every draw
-- action, so the answer is indexed rather than scanned.
CREATE INDEX IF NOT EXISTS idx_applications_payoff_demand
  ON applications (payoff_demand_requested_at)
  WHERE deleted_at IS NULL AND payoff_demand_requested_at IS NOT NULL;
