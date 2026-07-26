-- 262 — Safe-learning evaluation harness (R5.42, owner-directed 2026-07-22).
--
-- Review gap P0-C: a promoted learned rule can change/suppress a finding in
-- production with no replay + shadow + approval gate. R5.4 already blocked a
-- learned rule from ever removing a FATAL finding; this adds the DATA MODEL for
-- the full gate the review specifies:
--
--   evaluation_cases    immutable labeled fixtures (input snapshot + expected
--                       outputs + risk tier + investor/program/state/doc tags)
--   evaluation_runs     a baseline-vs-candidate replay run over the fixtures
--   evaluation_results  per-case/per-component expected-vs-actual + regression
--                       severity + error taxonomy
--   artifact_versions   independently-versioned pipeline artifacts (splitter /
--                       schema / prompt / rule / normalizer / intent / …)
--   shadow_decisions    a candidate's decision alongside production + the later
--                       human outcome (would-have-acted comparison)
--   release_decisions   the approval + canary scope + rollback target of a
--                       promotion
--
-- NON-NEGOTIABLE (owner + review): no learned change reaches production without
-- an evaluation run, approval, and a rollback target. These tables make that
-- enforceable. Additive + idempotent; the replay runner + gates land in R5.45/
-- R5.46/R5.47/R5.48.

CREATE TABLE IF NOT EXISTS evaluation_cases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Immutable input snapshot (redacted document facts / a file state) + the
  -- expected outputs (boundaries / fields / conflicts / root cause / conditions).
  input_snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,
  expected          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- high / medium / low — weight toward fatal + false-clear risk.
  risk_tier         text NOT NULL DEFAULT 'medium',
  -- Slice tags for slice-level metrics.
  investor          text,
  program           text,
  state             text,
  doc_type          text,
  -- Where the label came from (a confirmed root cause, an underwriter
  -- correction, a QA miss) + who labeled it.
  label_source      text,
  labeled_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  -- A confirmed root-cause case that became this fixture (R5.65).
  root_cause_case_id uuid,
  active            boolean NOT NULL DEFAULT true,
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_evaluation_cases_tier ON evaluation_cases (risk_tier) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_evaluation_cases_slice ON evaluation_cases (investor, program, state);

CREATE TABLE IF NOT EXISTS artifact_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- splitter / classifier / schema / prompt / rule / normalizer /
  -- source_hierarchy / condition_intent / guideline / root_cause / model
  artifact_type     text NOT NULL,
  version           text NOT NULL,
  checksum          text,
  parent_version    text,
  -- draft / candidate / active / rolled_back
  status            text NOT NULL DEFAULT 'draft',
  release_notes     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_versions_type_ver ON artifact_versions (artifact_type, version);

CREATE TABLE IF NOT EXISTS evaluation_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  baseline_bundle   jsonb NOT NULL DEFAULT '{}'::jsonb,   -- artifact versions of the champion
  candidate_bundle  jsonb NOT NULL DEFAULT '{}'::jsonb,   -- artifact versions being tested
  dataset_version   text,
  -- pending / running / passed / failed
  status            text NOT NULL DEFAULT 'pending',
  aggregate         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- metric summary
  started_at        timestamptz,
  finished_at       timestamptz,
  created_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evaluation_results (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_run_id uuid NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
  evaluation_case_id uuid NOT NULL REFERENCES evaluation_cases(id) ON DELETE CASCADE,
  component         text,                        -- packet / extraction / conflict / root_cause / condition
  expected          jsonb,
  actual            jsonb,
  -- pass / regression / improvement
  outcome           text NOT NULL DEFAULT 'pass',
  -- one primary error-taxonomy cause when it regressed (R5.43)
  error_category    text,
  -- none / minor / major / dangerous  (dangerous = false clear / missed fatal)
  regression_severity text NOT NULL DEFAULT 'none',
  evidence          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_evaluation_results_run ON evaluation_results (evaluation_run_id, outcome);
CREATE INDEX IF NOT EXISTS idx_evaluation_results_severity
  ON evaluation_results (evaluation_run_id) WHERE regression_severity IN ('major','dangerous');

CREATE TABLE IF NOT EXISTS shadow_decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid REFERENCES applications(id) ON DELETE CASCADE,
  candidate_bundle  jsonb NOT NULL DEFAULT '{}'::jsonb,
  production_decision jsonb,
  candidate_decision  jsonb,
  -- same / different  (difference_category names how)
  difference_category text,
  candidate_would_have_acted boolean,
  -- filled later when the human outcome is known (for a would-have-been-right check)
  human_outcome     jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shadow_decisions_app ON shadow_decisions (application_id, created_at);

CREATE TABLE IF NOT EXISTS release_decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_run_id uuid REFERENCES evaluation_runs(id) ON DELETE SET NULL,
  artifact_type     text,
  candidate_version text,
  rollback_version  text,                        -- the artifact to revert to
  metrics           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- proposed / approved / denied / rolled_back
  status            text NOT NULL DEFAULT 'proposed',
  canary_scope      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- e.g. {"investor":"…"} | {"pct":5}
  approved_by       uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  effective_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_release_decisions_status ON release_decisions (status, created_at);
