-- Pipeline V2 (owner-directed 2026-07-26) — durable document-processing jobs.
--
-- Stage 1 of the six-stage restructure: when a document is uploaded the web app
-- only validates + stores the file, hashes it, records immutable metadata, and
-- ENQUEUES a durable job — it never runs OCR / packet split / LLM extraction in
-- the HTTP request. A separate Render Background Worker drains these tables.
--
-- This migration is ADDITIVE and INERT: nothing reads or writes these tables until
-- the worker + enqueue path ship behind UW_WORKER_ENABLED / UW_PIPELINE_V2_ENABLED.
-- Everyone stays on Pipeline V1. Idempotent — safe to re-run on every boot.
--
-- Reuses the repo's proven Postgres queue/lease pattern (see src/lib/sp-mirror-queue.js:
-- FOR UPDATE SKIP LOCKED atomic claim + lease_expires_at + a crash-recovery reaper),
-- so a crashed/redeployed worker never strands a job — its lease expires and another
-- worker re-claims it (safe restart after deployment).

-- ── The job (one per document per pipeline version) ──────────────────────────
CREATE TABLE IF NOT EXISTS document_pipeline_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         uuid REFERENCES documents(id) ON DELETE CASCADE,
  loan_id             uuid REFERENCES applications(id) ON DELETE CASCADE,
  pipeline_version    text NOT NULL DEFAULT 'v2',
  document_family     text,                     -- bank_statement / insurance / ... (routing + family flag)
  status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','processing','waiting_provider','manual_review',
                                          'completed','failed_retryable','failed_terminal','cancelled')),
  idempotency_key     text,                     -- caller-supplied dedupe key (optional; see unique index)
  attempts            integer NOT NULL DEFAULT 0,
  max_attempts        integer NOT NULL DEFAULT 5,
  run_after           timestamptz NOT NULL DEFAULT now(),   -- backoff / scheduled retry gate
  lease_owner         text,                     -- worker instance id holding the lease
  lease_expires_at    timestamptz,              -- crash recovery: expired lease → re-claimable
  heartbeat_at        timestamptz,              -- worker liveness while processing
  cancel_requested    boolean NOT NULL DEFAULT false,
  dead_letter         boolean NOT NULL DEFAULT false,
  provider_cost_cents integer NOT NULL DEFAULT 0,
  latency_ms          integer,
  model_version       text,
  last_error          text,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  result              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Idempotent enqueue: at most one job per (document, pipeline version), and at most
-- one per explicit idempotency key. A re-upload/retry adopts the existing row instead
-- of spawning a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_job_doc_ver
  ON document_pipeline_jobs (document_id, pipeline_version)
  WHERE document_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_job_idem
  ON document_pipeline_jobs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Claim scan: ready-to-run jobs (queued or scheduled-retryable), oldest first.
CREATE INDEX IF NOT EXISTS ix_pipeline_job_ready
  ON document_pipeline_jobs (run_after)
  WHERE status IN ('queued','failed_retryable') AND dead_letter = false AND cancel_requested = false;
-- Lease reaper scan: processing jobs whose lease has expired.
CREATE INDEX IF NOT EXISTS ix_pipeline_job_lease
  ON document_pipeline_jobs (lease_expires_at)
  WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS ix_pipeline_job_loan ON document_pipeline_jobs (loan_id);

-- ── Per-job stage manifest (Stage 6 the run-manifest reads/extends this) ──────
CREATE TABLE IF NOT EXISTS document_pipeline_stages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     uuid NOT NULL REFERENCES document_pipeline_jobs(id) ON DELETE CASCADE,
  stage_key  text NOT NULL,     -- intake / packet_control / ocr_layout / classification / extraction / grounding / ...
  status     text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','running','completed','not_applicable',
                                 'manual_required','failed_retryable','failed_terminal')),
  started_at timestamptz,
  ended_at   timestamptz,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_stage ON document_pipeline_stages (job_id, stage_key);

-- ── Append-only attempt ledger (idempotency/retry/cost/latency audit) ─────────
CREATE TABLE IF NOT EXISTS document_pipeline_attempts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     uuid NOT NULL REFERENCES document_pipeline_jobs(id) ON DELETE CASCADE,
  attempt_no integer NOT NULL,
  outcome    text,             -- succeeded / retryable / terminal / cancelled / lease_lost
  error      text,
  provider   text,
  latency_ms integer,
  cost_cents integer,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_pipeline_attempt_job ON document_pipeline_attempts (job_id, attempt_no);

-- ── Artifacts produced by the job (raw provider results, evidence candidates, route records) ──
CREATE TABLE IF NOT EXISTS document_pipeline_artifacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES document_pipeline_jobs(id) ON DELETE CASCADE,
  kind        text NOT NULL,   -- provider_result / ocr_result / evidence_candidates / route_record / ...
  storage_ref text,            -- large payloads go to storage; small stay in meta
  sha256      text,
  bytes       integer,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_pipeline_artifact_job ON document_pipeline_artifacts (job_id, kind);
