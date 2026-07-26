-- 249 — Labeling console for Azure Custom classifier + neural extractors
-- (owner-directed 2026-07-22, R3.3).
--
-- Stores every past document a super-admin tagged for training. Rows point to
-- an Azure Blob URL (bytes live in the pilot-doc-ai-labels container in East
-- US); the row itself carries the doc-type + optional page range + which model
-- project the label targets (classifier vs a per-type extractor).
--
-- Idempotent (safe to re-run every boot).

CREATE TABLE IF NOT EXISTS label_examples (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        uuid REFERENCES applications(id) ON DELETE SET NULL,
  document_id           uuid REFERENCES documents(id) ON DELETE SET NULL,
  -- The canonical PILOT doc type (matches src/lib/ai/azure-custom.js DOC_TYPES)
  --   bank_statement / insurance / operating_agreement / drivers_license /
  --   settlement / purchase_contract
  doc_type              text NOT NULL,
  -- Which Custom project this label trains: 'classifier' (the splitter) or
  -- 'extractor' (the per-type neural model). One physical example CAN be
  -- registered against both — one row per (label, project).
  target_project        text NOT NULL CHECK (target_project IN ('classifier','extractor')),
  -- Optional pages-within-PDF for a multi-doc package labeled by its parts.
  -- '1-3' style; NULL means the entire document is the labeled example.
  pages                 text,
  -- The Azure Blob URL the model will read from during training. Never a
  -- signed URL — the storage account/container are already configured; only
  -- the object key varies per row.
  blob_url              text NOT NULL,
  blob_size_bytes       bigint,
  original_filename     text,
  uploaded_by_staff_id  uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  uploaded_at           timestamptz NOT NULL DEFAULT now(),
  -- Training run stamps: which trained_model_id ingested this row, and when.
  -- NULL = not yet part of a training run.
  trained_at            timestamptz,
  trained_model_id      text
);
CREATE INDEX IF NOT EXISTS idx_label_examples_by_type
  ON label_examples (target_project, doc_type);
CREATE INDEX IF NOT EXISTS idx_label_examples_untrained
  ON label_examples (target_project, doc_type)
  WHERE trained_at IS NULL;

CREATE TABLE IF NOT EXISTS label_training_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_project        text NOT NULL CHECK (target_project IN ('classifier','extractor')),
  doc_type              text,                                 -- NULL for the classifier (all types)
  model_id              text NOT NULL,                        -- Azure Custom project id
  requested_by_staff_id uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  requested_at          timestamptz NOT NULL DEFAULT now(),
  status                text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','running','succeeded','failed')),
  status_reason         text,
  example_count         integer NOT NULL DEFAULT 0,
  finished_at           timestamptz
);
CREATE INDEX IF NOT EXISTS idx_label_training_runs_by_project
  ON label_training_runs (target_project, doc_type, requested_at DESC);
