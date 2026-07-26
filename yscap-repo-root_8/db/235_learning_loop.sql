-- 230 — Self-training loop foundation (Sovereign 4/4).
--
-- Owner-directed 2026-07-21: every underwriter correction becomes a LABELED
-- EXAMPLE PILOT can learn from. Two capture surfaces:
--   * finding_corrections — one row per finding decision (dismiss = false
--     positive candidate, grant_exception = real-but-tolerable, post_condition
--     = real + needs follow-up, clear = auto-clearable).
--   * fact_corrections — one row per human confirm_by_human on a canonical
--     fact (an explicit "the reconciler picked wrong; the truth is X").
-- The corrections feed a periodic proposal engine (src/lib/underwriting/
-- learning.js) that suggests rule / prompt / normalization changes; every
-- proposal lands in a REVIEW queue — nothing auto-promotes to production.
--
-- Idempotent (safe to re-run every boot).

CREATE TABLE IF NOT EXISTS finding_corrections (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id           uuid REFERENCES applications(id) ON DELETE CASCADE,
  finding_id               uuid REFERENCES document_findings(id) ON DELETE CASCADE,
  finding_code             text,       -- snapshot: code the correction was for
  finding_severity         text,       -- snapshot: severity at time of decision
  original_doc_value       text,       -- snapshot: what the document said
  original_file_value      text,       -- snapshot: what the file said
  decision                 text NOT NULL
                           CHECK (decision IN ('confirmed_real','false_positive',
                                               'severity_too_high','severity_too_low',
                                               'needs_condition','granted_exception',
                                               'declined','cleared')),
  action_taken             text,       -- the resolve action verb (grant_exception, dismiss, ...)
  corrected_by             uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  reviewer_note            text,
  committee_action         text,       -- what the committee said, if it ran
  committee_agreed         boolean,    -- did the committee's action match the human's decision?
  captured_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fc_code ON finding_corrections(finding_code, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_fc_app  ON finding_corrections(application_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_fc_committee ON finding_corrections(committee_agreed) WHERE committee_agreed IS NOT NULL;

CREATE TABLE IF NOT EXISTS fact_corrections (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id           uuid REFERENCES applications(id) ON DELETE CASCADE,
  fact_key                 text NOT NULL,
  observed_value           text,       -- what reconciliation would have picked
  corrected_value          text,       -- what the human said the truth is
  corrected_by             uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  reason                   text,
  captured_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_factcorr_key ON fact_corrections(fact_key, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_factcorr_app ON fact_corrections(application_id, captured_at DESC);

-- ---- CANDIDATE IMPROVEMENTS — what the proposal engine suggests ----------
CREATE TABLE IF NOT EXISTS training_proposals (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposed_at              timestamptz NOT NULL DEFAULT now(),
  proposal_type            text NOT NULL
                           CHECK (proposal_type IN ('suppress_finding','downgrade_severity',
                                                    'upgrade_severity','tune_threshold',
                                                    'normalizer_alias','prompt_tweak',
                                                    'add_specialist_lens','committee_prompt_tweak')),
  scope                    jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { finding_code, doc_type, fact_key, ... }
  supporting_correction_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  supporting_sample_size   integer NOT NULL DEFAULT 0,
  proposed_change          jsonb NOT NULL,                        -- the specific change (before/after)
  rationale                text NOT NULL,
  status                   text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','approved','rejected','shadow_testing','promoted')),
  reviewed_by              uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  reviewed_at              timestamptz,
  review_note              text
);
CREATE INDEX IF NOT EXISTS idx_tp_status ON training_proposals(status, proposed_at DESC);
