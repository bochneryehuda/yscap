-- 247_encompass_loan_snapshot.sql — Discovery + snapshot table for the bulk
-- Encompass pull (owner-directed 2026-07-22, PILOT ↔ Encompass Phase 2.5 —
-- READ-ONLY). Complements applications.encompass_extra:
--
--   * A file the bulk pull finds AND matches to a PILOT application → gets
--     stashed in applications.encompass_extra (existing path, unchanged).
--   * A loan that lives in Encompass but has NO matching PILOT application
--     (e.g. an older loan started only in Encompass, or a loan whose loan#
--     doesn't match any PILOT ys_loan_number) → gets stashed here so nothing
--     is lost. Staff can browse them via a "Encompass-only loans" view and
--     decide whether to onboard them into PILOT.
--
-- Never touched by anything that writes to Encompass — this table is 100%
-- PILOT-side. Idempotent.
--
-- Columns:
--   encompass_loan_guid   text PRIMARY KEY — the immutable Encompass side key
--   loan_number           text            — the reported LoanNumber (natural key)
--   loan_folder           text            — Encompass loan folder ("Active", etc.)
--   borrower_last_name    text            — pipeline-search projection (for search)
--   loan_amount           numeric(14,2)   — pipeline-search projection
--   last_modified         timestamptz     — Encompass's LastModified
--   raw                   jsonb           — the full raw loan JSON (PII-scrubbed)
--   application_id        uuid            — set if/when a matching PILOT app is found
--                                           (SET NULL on the app being deleted)
--   pulled_at             timestamptz
--   last_error            text            — last per-loan pull failure, if any

CREATE TABLE IF NOT EXISTS encompass_loan_snapshot (
  encompass_loan_guid  text PRIMARY KEY,
  loan_number          text,
  loan_folder          text,
  borrower_last_name   text,
  loan_amount          numeric(14, 2),
  last_modified        timestamptz,
  raw                  jsonb,
  application_id       uuid REFERENCES applications(id) ON DELETE SET NULL,
  pulled_at            timestamptz NOT NULL DEFAULT now(),
  last_error           text
);
CREATE INDEX IF NOT EXISTS idx_encompass_loan_snapshot_number ON encompass_loan_snapshot(loan_number);
CREATE INDEX IF NOT EXISTS idx_encompass_loan_snapshot_app ON encompass_loan_snapshot(application_id) WHERE application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_encompass_loan_snapshot_stale ON encompass_loan_snapshot(pulled_at NULLS FIRST);

-- The bulk-pull job's own progress table — a single row per run so an admin
-- can see "we're 342 / 1147 through the current sync" without re-scanning
-- encompass_loan_snapshot.
CREATE TABLE IF NOT EXISTS encompass_bulk_pull_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  started_by   uuid REFERENCES staff_users(id),
  total_loans  integer,      -- reported by the initial pipeline count
  pulled       integer NOT NULL DEFAULT 0,
  matched      integer NOT NULL DEFAULT 0,   -- landed into applications.encompass_extra
  unmatched    integer NOT NULL DEFAULT 0,   -- landed into encompass_loan_snapshot only
  failed       integer NOT NULL DEFAULT 0,
  last_error   text,
  status       text NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'completed', 'failed', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_encompass_bulk_pull_runs_status ON encompass_bulk_pull_runs(status);
