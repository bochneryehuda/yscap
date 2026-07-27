-- 340_finding_triage.sql
-- FINDINGS TRIAGE (owner-directed 2026-07-27, the "what else" AI list).
--
-- The finding-review gate judges each finding in isolation and the risk score is fixed weights;
-- neither tells a human "look at THESE first." This is the AI triage layer: it reads ALL the
-- still-showing findings for a file at once, against the whole loan file, and produces a prioritized
-- worklist — which findings are the real story (primary), which are secondary, and which are
-- low-signal noise — with a one-line reason each. The stored ranking is READ ONLY for DISPLAY
-- ordering + a "priority" annotation; it never changes a finding's severity-of-record, the gate, or
-- any number. Keyed per (file, finding claim) with a set-hash so it re-runs only when the set of
-- findings actually changes. Advisory. Idempotent.
CREATE TABLE IF NOT EXISTS finding_triage (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id uuid REFERENCES applications(id) ON DELETE CASCADE,
    claim_key     text NOT NULL,          -- finding-claims.claimOf — the finding this ranking is about
    bucket        text NOT NULL,          -- 'primary' | 'secondary' | 'noise'
    rank          integer,                -- 1 = look here first (within the file)
    why           text,                   -- one-line plain-language reason
    set_hash      text,                   -- fingerprint of the whole finding SET this ranking was made against
    model         text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_finding_triage ON finding_triage(application_id, claim_key);
CREATE INDEX IF NOT EXISTS idx_finding_triage_app ON finding_triage(application_id);

COMMENT ON TABLE finding_triage IS
  'AI priority ranking of a file''s findings (primary/secondary/noise + why), for DISPLAY ordering only. Never changes severity/gate/number. Keyed per (application_id, claim_key); re-run when set_hash changes.';
