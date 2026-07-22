-- 265 — Immutable whole-loan underwriting runs (R6.13, owner-directed 2026-07-22).
--
-- The Whole-Loan Underwriting Context produces, on each material event, ONE
-- immutable run: a frozen snapshot of every source version, the deterministic
-- program engine result, the independent calculation ledger, the deduplicated
-- findings, and the final decision (status + term-sheet/CTC/funding eligibility).
-- Storing it immutably makes underwriting REPRODUCIBLE — the same versioned
-- inputs + engine produce the same decision, and funding can be blocked if the
-- run that approved it is stale.
--
-- The run NEVER mutates pricing or document values (it reads + records). Additive
-- + idempotent.

CREATE TABLE IF NOT EXISTS underwriting_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  as_of             timestamptz NOT NULL DEFAULT now(),
  -- product_registered | product_approved | document_analyzed | appraisal_imported |
  -- appraisal_replaced | contract_amended | condition_resolved | economics_changed |
  -- fico_changed | clickup_inbound | encompass_inbound | sharepoint_integrity | manual_run
  trigger           text NOT NULL DEFAULT 'manual_run',
  -- A hash of the frozen source-version bundle — two runs with the same hash
  -- underwrote identical inputs (reproducibility).
  source_hash       text,
  -- The frozen source-version bundle {applicationUpdatedAt, registrationId,
  -- registrationCreatedAt, registrationStale, appraisalId, appraisalImportedAt,
  -- termSheetDocumentId, clickupTaskId, encompassLoanId, sharepointReconciliationAt,
  -- analyzerVersion, …}.
  source_versions   jsonb NOT NULL DEFAULT '{}'::jsonb,
  program_key       text,                        -- standard | gold | manual
  -- The whole-loan status (uw-status.js): ELIGIBLE | MANUAL_PENDING |
  -- MANUAL_APPROVED | INELIGIBLE | NOT_READY | DATA_CONFLICT | STALE
  status            text,
  term_sheet_eligible boolean NOT NULL DEFAULT false,
  ctc_eligible      boolean NOT NULL DEFAULT false,
  funding_eligible  boolean NOT NULL DEFAULT false,
  -- Whether this run has been superseded by a newer run (only the newest run
  -- governs; funding checks the current run's freshness).
  superseded_at     timestamptz,
  created_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_uw_runs_app ON underwriting_runs (application_id, created_at DESC);
-- At most one CURRENT (non-superseded) run per file.
CREATE UNIQUE INDEX IF NOT EXISTS idx_uw_runs_current
  ON underwriting_runs (application_id) WHERE superseded_at IS NULL;

-- The immutable source snapshot the run was built from (the whole-loan context).
CREATE TABLE IF NOT EXISTS underwriting_run_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES underwriting_runs(id) ON DELETE CASCADE,
  context           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- the full whole-loan context (provenance-tagged)
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_uw_run_snapshots_run ON underwriting_run_snapshots (run_id);

-- The independent calculation ledger (one row per computed ratio/amount).
CREATE TABLE IF NOT EXISTS underwriting_run_calculations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES underwriting_runs(id) ON DELETE CASCADE,
  metric            text NOT NULL,               -- acq_ltv | as_is_ltv | ltc | arv_ltv | cash_to_close | …
  formula           text,
  numerator         numeric,
  denominator       numeric,
  result            numeric,
  cap               numeric,
  passed            boolean,
  binding           boolean NOT NULL DEFAULT false,
  sources           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- the provenance of each input
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_uw_run_calcs_run ON underwriting_run_calculations (run_id);

-- The deduplicated finding registry for the run.
CREATE TABLE IF NOT EXISTS underwriting_run_findings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES underwriting_runs(id) ON DELETE CASCADE,
  code              text,
  severity          text,                        -- fatal | warning | info
  category          text,
  title             text,
  explanation       text,
  governing_rule    text,
  expected_value    text,
  actual_value      text,
  source            text,
  source_version    text,
  blocks_term_sheet boolean NOT NULL DEFAULT false,
  blocks_ctc        boolean NOT NULL DEFAULT false,
  blocks_funding    boolean NOT NULL DEFAULT false,
  permitted_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_uw_run_findings_run ON underwriting_run_findings (run_id, severity);

-- The final decision record (one per run).
CREATE TABLE IF NOT EXISTS underwriting_run_decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES underwriting_runs(id) ON DELETE CASCADE,
  status            text NOT NULL,
  decision_reasons  jsonb NOT NULL DEFAULT '[]'::jsonb,
  conditions_to_add jsonb NOT NULL DEFAULT '[]'::jsonb,
  conditions_eligible_to_clear jsonb NOT NULL DEFAULT '[]'::jsonb,
  exceptions        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_uw_run_decisions_run ON underwriting_run_decisions (run_id);
