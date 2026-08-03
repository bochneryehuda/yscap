-- 421_dashboard_foundations.sql — the four foundations the Dashboards build needs,
-- and the only part of it that gets WORSE the longer it waits (owner-directed 2026-08-03:
-- "go ahead build it all").
--
-- Three of these four are time-sensitive because they capture history that cannot be
-- reconstructed later. They ship first, ahead of any screen, for that reason alone.
--
--   1. applications.original_maturity_date  — the maturity a loan was WRITTEN with.
--      RTL loans are interest-only with a balloon, so maturity IS the credit event and
--      the EXTENSION RATE is the earliest honest signal that projects are running late.
--      The instant an extension overwrites `maturity_date`, that metric is destroyed with
--      no way back. There is NO extension feature in the system today (verified: the only
--      writer of maturity_date is the term-options derivation at staff.js), so every
--      current maturity_date IS the original — this backfill is EXACT, not an estimate.
--      Fill-only from here on: a future extension writes maturity_date and leaves this alone.
--
--   2. leads.first_contact_at — when a human first reached out to a lead. Speed-to-lead is
--      the single highest-leverage number in the plan (contact odds fall ~100x between a
--      5-minute and a 30-minute response) and it is one column. Nothing computes it today.
--
--   3. application_status_history.source — WHERE a stage move came from. The history table
--      is written ONLY by the two portal doors (staff.js); a status changed in ClickUp
--      updates applications.status and writes NO history row, so every time-in-stage number
--      silently undercounts the ClickUp-driven book. src/lib/stage-history.js + the ingest
--      hook close that; this column is what lets a dashboard say honestly which moves it can
--      see. NULL on every pre-existing row and deliberately NOT backfilled — we do not know
--      where those came from, and guessing would be worse than admitting the gap.
--
--   4. The covering indexes. `applications` carries 13 indexes and NOT ONE is on a date, so
--      "how many funded in January" is a sequential scan of the whole table today. That is
--      survivable for one hardcoded dashboard and is not survivable once every staff member
--      can author their own filters.
--
-- RTL only. Idempotent — replays on every boot. No LT table, no LT column, no cross-product
-- reference (scripts/check-product-separation.js).

-- ---------------------------------------------------------------------------
-- 1. The maturity a loan was written with
-- ---------------------------------------------------------------------------
ALTER TABLE applications ADD COLUMN IF NOT EXISTS original_maturity_date date;

-- EXACT, not approximate: no extension path exists yet, so the current maturity is
-- the original one. Fill-only (`IS NULL`) so a later real extension never re-stamps it.
UPDATE applications
   SET original_maturity_date = maturity_date
 WHERE original_maturity_date IS NULL
   AND maturity_date IS NOT NULL;

COMMENT ON COLUMN applications.original_maturity_date IS
  'The maturity date the loan was originally written with. Set once, never rewritten by an extension — extension rate = loans whose maturity_date now differs from this.';

-- ---------------------------------------------------------------------------
-- 2. Speed to lead
-- ---------------------------------------------------------------------------
ALTER TABLE leads ADD COLUMN IF NOT EXISTS first_contact_at timestamptz;

COMMENT ON COLUMN leads.first_contact_at IS
  'When a human first reached out to this lead. Set once (fill-only). Drives speed-to-lead; NULL means never contacted, which is itself the finding.';

CREATE INDEX IF NOT EXISTS idx_leads_first_contact ON leads (first_contact_at);
-- Never-contacted leads, newest first — the working list behind the KPI.
CREATE INDEX IF NOT EXISTS idx_leads_uncontacted ON leads (created_at DESC)
  WHERE first_contact_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Where a stage move came from
-- ---------------------------------------------------------------------------
ALTER TABLE application_status_history ADD COLUMN IF NOT EXISTS source text;

COMMENT ON COLUMN application_status_history.source IS
  'Which door moved the file: portal | clickup | system. NULL = recorded before db/421 (a portal move; deliberately not backfilled).';

-- Time-in-stage reads this table by (to_status, created_at) across files.
CREATE INDEX IF NOT EXISTS idx_status_history_to_status
  ON application_status_history (to_status, created_at);

-- ---------------------------------------------------------------------------
-- 4. The covering indexes every time-series KPI needs
--    All partial on `deleted_at IS NULL` — every dashboard query carries that
--    predicate (soft-deleted files must never inflate a figure), so the partial
--    index is both smaller and always applicable.
-- ---------------------------------------------------------------------------

-- Funded volume by month/quarter/year. The compound one serves the dominant shape:
-- status='funded' AND actual_closing >= <date>.
CREATE INDEX IF NOT EXISTS idx_apps_status_actual_closing
  ON applications (status, actual_closing) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_apps_actual_closing
  ON applications (actual_closing) WHERE deleted_at IS NULL AND actual_closing IS NOT NULL;

-- Intake, aging, and cohort pull-through.
CREATE INDEX IF NOT EXISTS idx_apps_created_at
  ON applications (created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_apps_submitted_at
  ON applications (submitted_at) WHERE deleted_at IS NULL AND submitted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_apps_status_changed_at
  ON applications (status_changed_at) WHERE deleted_at IS NULL;

-- "Stalled" — active files not touched in N days.
CREATE INDEX IF NOT EXISTS idx_apps_updated_at
  ON applications (updated_at) WHERE deleted_at IS NULL;

-- The maturity wall, and past-maturity files.
CREATE INDEX IF NOT EXISTS idx_apps_maturity_date
  ON applications (maturity_date) WHERE deleted_at IS NULL AND maturity_date IS NOT NULL;

-- Per-officer scoping is on nearly every card a loan officer sees.
CREATE INDEX IF NOT EXISTS idx_apps_officer_status
  ON applications (loan_officer_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_apps_processor_status
  ON applications (processor_id, status) WHERE deleted_at IS NULL;

-- Breakdown dimensions.
CREATE INDEX IF NOT EXISTS idx_apps_program ON applications (program) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_apps_loan_type ON applications (loan_type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_apps_lender ON applications (lender) WHERE deleted_at IS NULL;

-- Geography. The state lives inside the property_address jsonb and "NY" / "New York"
-- must group as one place, so the index is on the SAME normalizer the grouping uses
-- (pilot_state_norm, db/326 — verified IMMUTABLE, which is what makes it indexable).
CREATE INDEX IF NOT EXISTS idx_apps_state_norm
  ON applications (pilot_state_norm(property_address->>'state')) WHERE deleted_at IS NULL;
