-- ============================================================================
-- db/641 — report schedules and totals
--
-- THE REPORTING DATABASE, LAYER 2 (owner-directed 2026-08-29: "Build the next
-- layer — totals, or-logic, more fields, scheduled reports"). This migration
-- carries only the SCHEDULE persistence: a saved report can now be emailed on
-- a cadence, so `report_definitions` gains
--
--   schedule      jsonb — {enabled, cadence: daily|weekly|monthly, dow, dom,
--                          hour (New York), recipients: [staff emails]},
--                          validated in src/lib/report-scheduler.js (one
--                          definition; the row stores what the validator
--                          accepted, never a raw client body)
--   last_sent_at  timestamptz — the send-once-per-period CLAIM: the scheduler
--                          claims a due report with a guarded UPDATE
--                          (last_sent_at IS NULL OR < the period start), so
--                          two web instances can never email it twice; a
--                          FAILED send restores the prior value so the next
--                          sweep retries (a claim that never reached the
--                          provider is released — the closing-chain rule).
--
-- Totals / or-logic / the wider field dictionary live in src/lib/reporting.js
-- (the grammar is code, never rows). BACKFILL: none — schedule NULL means
-- "not scheduled", the truth for every existing saved report.
-- ============================================================================

ALTER TABLE report_definitions ADD COLUMN IF NOT EXISTS schedule jsonb;
ALTER TABLE report_definitions ADD COLUMN IF NOT EXISTS last_sent_at timestamptz;

-- The sweep asks "which reports carry a schedule at all" on every pass.
CREATE INDEX IF NOT EXISTS report_definitions_scheduled_idx
  ON report_definitions ((1)) WHERE schedule IS NOT NULL;
