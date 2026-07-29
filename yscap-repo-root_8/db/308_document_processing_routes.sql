-- Pipeline V2 (owner-directed 2026-07-26) — per-document processing-route ledger.
--
-- Stage 2 of the six-stage restructure: the ONE DocumentProcessingRouter picks which
-- vendor (provider + service) reads each document, optionally runs a second "challenger"
-- reader, and records EXACTLY what it did here — one immutable row per routing decision:
-- which provider/model handled it, WHY (the plan's reasons), the challenger, and the
-- measured latency / cost / confidence. This is the audit trail behind "why did PILOT
-- send this bank statement to Azure and not Google, and what did it cost?".
--
-- This migration is ADDITIVE and INERT: nothing writes these rows until the router is wired
-- into the worker's packet-control stage (Phase 1g) behind UW_PIPELINE_V2_SHADOW. Everyone
-- stays on Pipeline V1. Idempotent — safe to re-run on every boot.
--
-- Reuses the existing V1 routing brain (src/lib/ai/routing-matrix.js planRoute) to CHOOSE
-- the route; this table only RECORDS the choice + outcome. No frozen number is touched.

CREATE TABLE IF NOT EXISTS document_processing_routes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Links (all NULLABLE so a route can be recorded for a shadow/ad-hoc run that isn't yet
  -- tied to a durable job or a stored document). ON DELETE CASCADE so a deleted document /
  -- job never strands its route rows.
  job_id                uuid REFERENCES document_pipeline_jobs(id) ON DELETE CASCADE,
  document_id           uuid REFERENCES documents(id) ON DELETE CASCADE,
  loan_id               uuid REFERENCES applications(id) ON DELETE CASCADE,

  pipeline_version      text NOT NULL DEFAULT 'v2',
  document_family       text,                 -- classifier family that drove the plan (bank_statement, insurance, …)

  -- The chosen PRIMARY reader.
  provider              text NOT NULL,        -- vendor family: azure | google | mistral | native_pdf | appraisal_xml
  service               text,                 -- which service of that vendor (document_intelligence, document_ai, ocr, …)
  model_version         text,                 -- the model / api-version / classifier id used
  reason                text,                 -- WHY this route (the plan's joined reasons — human-readable)

  -- The optional CHALLENGER (a different reader run to reconcile the numbers). NULL = none.
  challenger_provider   text,
  challenger_service    text,
  challenger_confidence numeric,              -- the challenger's document-level confidence, if any

  -- Outcome of the primary read.
  confidence            numeric,              -- primary reader's document-level confidence (NULL = unknown/failed)
  latency_ms            integer NOT NULL DEFAULT 0,
  cost_cents            integer NOT NULL DEFAULT 0,
  materiality           text,                 -- the plan's materiality (high|medium|low)
  special_handling      jsonb NOT NULL DEFAULT '[]'::jsonb,  -- the plan's specialHandling flags
  outcome               text NOT NULL DEFAULT 'planned',     -- planned | completed | failed
  warnings              jsonb NOT NULL DEFAULT '[]'::jsonb,  -- any warnings the reader returned

  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_doc_route_document ON document_processing_routes (document_id);
CREATE INDEX IF NOT EXISTS ix_doc_route_job      ON document_processing_routes (job_id);
CREATE INDEX IF NOT EXISTS ix_doc_route_loan     ON document_processing_routes (loan_id);
CREATE INDEX IF NOT EXISTS ix_doc_route_family   ON document_processing_routes (document_family);
CREATE INDEX IF NOT EXISTS ix_doc_route_created  ON document_processing_routes (created_at);
