-- 259 — Guideline overlays + exceptions + decision snapshots
--       (R5.33, owner-directed 2026-07-22 — the knowledge-graph overlay layer).
--
-- Builds on db/258 (investors + guideline_documents/versions/rules). Adds the
-- three pieces that make knowledge-driven underwriting reproducible + auditable:
--
--   internal_overlays          YS's own rules that sit above/below investor
--                              rules with EXPLICIT precedence (never guessed).
--   guideline_exceptions       a file-specific approved exception to a rule,
--                              with approving authority + expiration +
--                              compensating factors + the source rule.
--   underwriting_context_snapshots
--                              an IMMUTABLE snapshot of the exact investor /
--                              program / rule versions used for a decision, so a
--                              decision can be replayed under the rules that
--                              applied at the time (a later guideline update
--                              never silently changes a past decision).
--
-- Precedence is DATA, not model intuition (R5.35 evaluator enforces the order):
--   law/compliance > state > investor hard rule > approved investor exception >
--   YS internal overlay > program base > guidance > historical (advisory).
--
-- Additive + idempotent. No pricing engine is touched.

-- ---------------------------------------------------------------------------
-- internal_overlays — YS policies layered over investor/base rules.
-- Same shape as guideline_rules + an explicit precedence tier.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS internal_overlays (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key          text NOT NULL,
  -- Scope of applicability (program / investor / state / property / transaction).
  scope             jsonb NOT NULL DEFAULT '{}'::jsonb,
  expression        jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome           jsonb NOT NULL DEFAULT '{}'::jsonb,
  materiality       text NOT NULL DEFAULT 'material',   -- info/warning/material/hard_stop
  -- Where this overlay sits in the precedence order. Lower tier = higher
  -- authority. Named tiers documented above; stored numeric for ordering:
  --   10 law_compliance, 20 state, 30 investor_hard, 40 investor_exception,
  --   50 internal_overlay, 60 program_base, 70 guidance, 80 historical
  precedence_tier   int NOT NULL DEFAULT 50,
  active            boolean NOT NULL DEFAULT true,
  effective_from    date,
  effective_to      date,
  created_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  notes             text,
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_internal_overlays_key ON internal_overlays (rule_key) WHERE active = true;

-- ---------------------------------------------------------------------------
-- guideline_exceptions — a file-specific approved exception to a rule.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guideline_exceptions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  rule_key          text NOT NULL,
  guideline_rule_id uuid REFERENCES guideline_rules(id) ON DELETE SET NULL,
  overlay_id        uuid REFERENCES internal_overlays(id) ON DELETE SET NULL,
  -- The approved deviation (e.g. {"max_ltv": 0.80} when the rule caps at 0.75).
  approved_value    jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason            text,
  compensating_factors text,
  approved_by       uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  approved_at       timestamptz,
  expires_at        timestamptz,
  -- pending / approved / denied / expired
  status            text NOT NULL DEFAULT 'pending',
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_guideline_exceptions_app ON guideline_exceptions (application_id);
CREATE INDEX IF NOT EXISTS idx_guideline_exceptions_open
  ON guideline_exceptions (application_id, rule_key) WHERE status IN ('pending','approved');

-- ---------------------------------------------------------------------------
-- underwriting_context_snapshots — immutable rule-version bundle per decision.
-- Written when a decision certificate / CTC / registration is produced, so the
-- decision can be reproduced under the exact rules that applied at the time.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS underwriting_context_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- What produced this snapshot: 'certificate' | 'registration' | 'ctc' | 'manual'
  produced_for      text,
  investor_id       uuid REFERENCES investors(id) ON DELETE SET NULL,
  program           text,
  -- The frozen bundle: [{guideline_version_id, version, rule_keys:[…]}, …] +
  -- overlay ids + exception ids + the analyzer_version bundle (db/256/R5.5).
  snapshot          jsonb NOT NULL DEFAULT '{}'::jsonb,
  as_of             date,
  created_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_uw_context_snapshots_app ON underwriting_context_snapshots (application_id, created_at);
