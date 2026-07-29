-- Pipeline V2 (owner-directed 2026-07-26) — Stage 5: Evidence + Canonical Truth candidates.
--
-- The new evidence-first pipeline does not "extract a field and trust it". For each fact it
-- needs (the account holder on a bank statement, the coverage amount on an insurance binder,
-- the statement period, …) it records an EVIDENCE CANDIDATE: the value one reader produced,
-- WHICH reader produced it, how confident it was, WHO/WHAT corroborated it, and — the point of
-- the whole stage — a VERIFICATION STATUS that says how much we actually trust it:
--
--   verified          — a second independent reader (or a direct source) agrees; trustworthy
--   partially_verified— agrees in part / only one high-confidence source; usable, not proven
--   unverified        — read once, nothing corroborates it yet (the default)
--   contradicted      — a second reader disagrees; do NOT trust until a human resolves it
--   superseded        — a newer candidate for the same fact replaced this one (points at it)
--   manual_verified   — a human confirmed it by hand (the strongest status)
--
-- This is the "canonical truth" ledger the spec calls for: the audit trail behind every value
-- the pipeline believes, and WHY it believes it. It records evidence + a trust status ONLY —
-- it is NOT an underwriting decision and never gates or clears a condition.
--
-- ADDITIVE + INERT: nothing writes these rows yet. A later phase records candidates from the
-- packet-control reader behind UW_PIPELINE_V2_SHADOW (shadow only); everyone stays on V1.
-- Idempotent — safe to re-run on every boot. Touches no frozen number and no borrower surface.

CREATE TABLE IF NOT EXISTS document_pipeline_evidence (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Links (all NULLABLE so a candidate can be recorded for a shadow/ad-hoc run not yet tied to
  -- a durable job or a stored document). ON DELETE CASCADE so a deleted document / job / loan
  -- never strands its evidence rows.
  job_id                uuid REFERENCES document_pipeline_jobs(id) ON DELETE CASCADE,
  document_id           uuid REFERENCES documents(id) ON DELETE CASCADE,
  loan_id               uuid REFERENCES applications(id) ON DELETE CASCADE,

  pipeline_version      text NOT NULL DEFAULT 'v2',
  document_family       text,                 -- classifier family the fact came from (bank_statement, insurance, …)

  -- The FACT this candidate is evidence FOR.
  field_key             text NOT NULL,        -- canonical fact name (account_holder, coverage_amount, period_end, …)
  field_label           text,                 -- human-friendly label for staff display

  -- The extracted VALUE (both a normalized string and structured detail).
  value_text            text,                 -- normalized string form of the value (NULL = no value found)
  value_json            jsonb NOT NULL DEFAULT '{}'::jsonb,  -- structured value + any extra detail

  -- WHO produced it + how sure they were.
  provider              text,                 -- reader that produced this value (azure | google | mistral | native_pdf | …)
  service               text,                 -- which service of that reader
  confidence            numeric,              -- the reader's confidence for this value (NULL = unknown)

  -- The verdict.
  status                text NOT NULL DEFAULT 'unverified'
    CHECK (status IN ('verified','partially_verified','unverified','contradicted','superseded','manual_verified')),
  reason                text,                 -- plain-language why this status (e.g. "Azure and Google agree")
  corroborations        jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{provider, service, value, confidence, agrees}]

  -- Supersession: a newer candidate for the SAME fact replaces this one.
  superseded_by         uuid REFERENCES document_pipeline_evidence(id) ON DELETE SET NULL,
  superseded_at         timestamptz,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_doc_evidence_job      ON document_pipeline_evidence (job_id);
CREATE INDEX IF NOT EXISTS ix_doc_evidence_document ON document_pipeline_evidence (document_id);
CREATE INDEX IF NOT EXISTS ix_doc_evidence_loan     ON document_pipeline_evidence (loan_id);
CREATE INDEX IF NOT EXISTS ix_doc_evidence_field    ON document_pipeline_evidence (field_key);
CREATE INDEX IF NOT EXISTS ix_doc_evidence_status   ON document_pipeline_evidence (status);
CREATE INDEX IF NOT EXISTS ix_doc_evidence_created  ON document_pipeline_evidence (created_at);
