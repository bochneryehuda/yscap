-- 261 — Root-cause persistence: cases + impacts + remediation options
--       (R5.23, owner-directed 2026-07-22 — the Root Cause Engine data model).
--
-- root-cause.js (R5.24) clusters findings into a root-cause hypothesis and
-- dependency-graph.js (R5.22) supplies the causal edges. This migration makes a
-- confirmed root cause DURABLE + human-reviewable, so "one corrected document
-- clears four conflicts" becomes a tracked case a human confirms — and, once
-- confirmed, an evaluation fixture (R5.65).
--
--   root_cause_cases      one hypothesized/confirmed cause on a file
--   root_cause_impacts    links a case to the findings/conditions/facts it explains
--   remediation_options   the ranked fixes (which one clears the most downstream)
--
-- NON-AUTONOMOUS: a case is a hypothesis for a human. Confirming it clears
-- nothing on its own — each condition's own clearance check still runs.
--
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS root_cause_cases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- proposed / human_confirmed / rejected / resolved
  status            text NOT NULL DEFAULT 'proposed',
  root_cause_type   text,                        -- entity_name / address / price / identity / amendment / …
  -- The earliest invalid/stale source, when known (from the dependency graph).
  root_observation_id uuid REFERENCES fact_observations(id) ON DELETE SET NULL,
  root_document_id  uuid REFERENCES documents(id) ON DELETE SET NULL,
  explanation       text,                        -- plain-language cause
  recommended_fix   text,                        -- the single most likely remediation
  confidence        numeric,
  confirmed_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  confirmed_at      timestamptz,
  -- When confirmed + resolved, this case becomes a regression fixture (R5.65).
  evaluation_case_id uuid,
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_root_cause_cases_app ON root_cause_cases (application_id, status);

CREATE TABLE IF NOT EXISTS root_cause_impacts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  root_cause_case_id uuid NOT NULL REFERENCES root_cause_cases(id) ON DELETE CASCADE,
  -- What this cause explains: finding / condition / fact / conflict
  impact_kind       text NOT NULL,
  impact_id         uuid NOT NULL,               -- the id of the finding/condition/fact/conflict
  -- direct (would clear on fix) / indirect (needs re-check after fix)
  impact_type       text NOT NULL DEFAULT 'direct',
  strength          numeric,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_root_cause_impacts_unique
  ON root_cause_impacts (root_cause_case_id, impact_kind, impact_id);

CREATE TABLE IF NOT EXISTS remediation_options (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  root_cause_case_id uuid NOT NULL REFERENCES root_cause_cases(id) ON DELETE CASCADE,
  action            text NOT NULL,               -- what to do
  document_needed   text,                        -- the document/request that resolves it
  expected_cleared_count int,                    -- how many downstream findings a success clears
  residual_risks    text,
  rank              int NOT NULL DEFAULT 1,       -- 1 = the recommended fix
  rationale         text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_remediation_options_case ON remediation_options (root_cause_case_id, rank);
