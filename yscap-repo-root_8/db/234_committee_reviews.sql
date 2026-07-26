-- 229 — Committee review column on document_findings (Sovereign 3/4).
--
-- Owner-directed 2026-07-21: MATERIAL findings can be reviewed by a
-- multi-model reasoning committee (src/lib/ai/committee.js). The committee's
-- opinion — action (confirm|dismiss|modify|hold), adjudicated severity,
-- reasoning, per-specialist verdicts, dissents — is persisted here so the
-- reviewer can read the panel's composition without re-running the LLM
-- calls. Also lets a downstream audit re-compute confidence per finding.
--
-- One column on document_findings + a per-finding-committee lookup table
-- (kept separate to allow multiple review rounds without overwriting the
-- prior opinion). Idempotent (safe to re-run every boot).

ALTER TABLE document_findings
  ADD COLUMN IF NOT EXISTS committee_action text,
  ADD COLUMN IF NOT EXISTS committee_severity text,
  ADD COLUMN IF NOT EXISTS committee_confidence numeric,
  ADD COLUMN IF NOT EXISTS committee_reviewed_at timestamptz;

CREATE TABLE IF NOT EXISTS finding_committee_reviews (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id           uuid REFERENCES applications(id) ON DELETE CASCADE,
  finding_id               uuid REFERENCES document_findings(id) ON DELETE CASCADE,
  committee_version        text NOT NULL,
  action                   text NOT NULL
                           CHECK (action IN ('confirm','dismiss','modify','hold')),
  original_severity        text,
  adjudicated_severity     text,
  confidence               numeric,
  reasoning                text,
  votes_json               jsonb NOT NULL DEFAULT '[]'::jsonb,   -- per-specialist verdicts
  dissents_json            jsonb NOT NULL DEFAULT '[]'::jsonb,
  abstained_json           jsonb NOT NULL DEFAULT '[]'::jsonb,
  failed_json              jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_by             uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fcr_finding ON finding_committee_reviews(finding_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fcr_app     ON finding_committee_reviews(application_id, created_at DESC);
