-- 231 — Decision Certificates + CTC Surveillance (Sovereign, blueprint sec. 18/19).
--
-- Owner-directed 2026-07-21: at each material milestone (initial review,
-- conditional approval, resubmission review, clear-to-close, pre-funding,
-- purchase review, post-closing QC), PILOT produces a signed IMMUTABLE
-- SNAPSHOT of the decision-relevant state — canonical facts, open + resolved
-- findings, the guideline / rule / prompt / normalizer versions in effect,
-- exceptions granted, human approvals. The snapshot is hashed so a later
-- audit can prove the file's state at the time of the decision.
--
-- After a certificate is issued, continuous surveillance watches for MATERIAL
-- changes (a canonical fact status flipped, a new fact_event on the file, a
-- document superseded, a finding reopened). Any such change marks the
-- certificate `validation_required` — the CTC or purchase decision must be
-- re-verified before the file can advance.
--
-- Idempotent (safe to re-run every boot).

CREATE TABLE IF NOT EXISTS decision_certificates (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id           uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  milestone                text NOT NULL
                           CHECK (milestone IN ('initial_review','conditional_approval',
                                                'resubmission','clear_to_close',
                                                'pre_funding','purchase_review',
                                                'post_closing_qc')),
  issued_at                timestamptz NOT NULL DEFAULT now(),
  issued_by                uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  -- Snapshot of the decision-relevant state at issue time. Structure:
  --   { facts: [{fact_key, value_normalized, status}],
  --     open_findings: [{code, severity, doc_value, file_value}],
  --     resolved_findings: [{code, severity, action, resolved_at, resolved_by}],
  --     exceptions: [{code, granted_by, granted_at}],
  --     versions: { guidelines, rules, prompts, normalizer, ocr_engine, ai_model, committee } }
  digest_json              jsonb NOT NULL,
  -- SHA-256 of the canonicalized digest_json. A later audit can re-compute
  -- from the persisted rows and confirm the certificate's promise.
  digest_sha256            text NOT NULL,
  -- Surveillance state:
  --   valid                 — no material change since issue
  --   validation_required   — a fact / finding / document changed; the milestone
  --                           decision must be re-verified before advance
  --   suspended             — a super-admin paused the certificate pending review
  --   revoked               — the certificate is no longer trustworthy
  --   superseded            — a newer certificate for the same milestone was issued
  surveillance_state       text NOT NULL DEFAULT 'valid'
                           CHECK (surveillance_state IN ('valid','validation_required',
                                                         'suspended','revoked','superseded')),
  surveillance_reason      text,
  surveillance_checked_at  timestamptz,
  superseded_at            timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dc_app_milestone ON decision_certificates(application_id, milestone, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_dc_surv         ON decision_certificates(surveillance_state) WHERE surveillance_state = 'validation_required';
CREATE INDEX IF NOT EXISTS idx_dc_valid        ON decision_certificates(application_id) WHERE surveillance_state = 'valid';
