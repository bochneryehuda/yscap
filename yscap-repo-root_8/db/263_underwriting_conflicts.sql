-- 263 — underwriting_conflicts (R5.21, owner-directed 2026-07-22).
--
-- The review's conflict taxonomy: every cross-document DIFFERENCE is classified
-- before it can become a condition. Only a `true_conflict` or a
-- `material_rule_breach` may support a condition recommendation; an
-- `expected_change` / `formatting_equivalent` / `superseded_source` /
-- `timing_difference` / `role_difference` is NOT a problem; a
-- `possible_extraction_error` routes to document review; `incomplete_evidence`
-- routes to a narrow evidence request. This table persists each classified
-- conflict with the observations + evidence it compared, so a finding is never
-- raised from an unclassified difference.
--
-- Deterministic cases are pre-classified by conflict-taxonomy.js; the ambiguous
-- remainder is marked 'needs_adjudication' for the contextual adjudicator
-- (Prompt C). Additive + idempotent.

CREATE TABLE IF NOT EXISTS underwriting_conflicts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  field_key         text,                        -- what was compared (price / seller / address / …)
  -- The two claims compared (observation ids when available).
  observation_a_id  uuid REFERENCES fact_observations(id) ON DELETE SET NULL,
  observation_b_id  uuid REFERENCES fact_observations(id) ON DELETE SET NULL,
  value_a           text,
  value_b           text,
  -- The taxonomy category (see conflict-taxonomy.js CATEGORIES).
  category          text NOT NULL DEFAULT 'needs_adjudication',
  materiality       text,                        -- info / warning / material / hard_stop (when known)
  -- pending / adjudicated / dismissed / actioned
  status            text NOT NULL DEFAULT 'pending',
  -- Whether this conflict may support a condition (only true_conflict /
  -- material_rule_breach). Recorded so a finding is never raised from a
  -- non-actionable difference.
  condition_eligible boolean NOT NULL DEFAULT false,
  reason            text,
  guideline_rule_id uuid,                        -- when a material_rule_breach cites a rule
  adjudicated_by    text,                        -- 'deterministic' | 'adjudicator' | staff uuid
  evidence          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- span ids on each side
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_uw_conflicts_app ON underwriting_conflicts (application_id, status);
CREATE INDEX IF NOT EXISTS idx_uw_conflicts_eligible
  ON underwriting_conflicts (application_id) WHERE condition_eligible = true;
