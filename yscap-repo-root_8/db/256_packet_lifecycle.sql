-- 256 — Packet lifecycle: document_packages / document_pages / logical_documents
--       (R5.6, owner-directed 2026-07-22 — the "Packet Intelligence" workstream).
--
-- The single biggest remaining underwriting gap (owner + external review): the
-- system reads documents well but does not yet understand the *package*. A
-- borrower uploads ONE combined PDF that is really 17 logical documents
-- (contract + amendments + IDs + LLC docs + bank statements + insurance + title
-- + appraisal). Before underwriting, the system should split / stack / classify
-- / dedupe / detect blank+missing+rotated pages — on RELIABLE page boundaries.
--
-- R5.1 already added lightweight provenance on `documents` (source_document_id,
-- page_range, page_bounded) + physical page slicing. This migration adds the
-- FULL lifecycle model the review specifies, layered ON TOP of `documents`
-- (never replacing it):
--
--   document_packages       — one uploaded combined package (the source doc).
--   document_pages          — one physical page of a package (render + hashes
--                             + quality + duplicate link).
--   logical_documents       — a page-bounded logical document within a package,
--                             optionally materialized into a `documents` row.
--   logical_document_pages  — which pages compose a logical document.
--   document_relationships  — supersedes / amends / duplicates / continues /
--                             attachment_to / replaces, between logical docs.
--   document_lifecycle_events — append-only audit of every split / merge /
--                             reclassify / version / confirm action.
--
-- NON-NEGOTIABLE (owner SharePoint + data-safety rules): the original upload is
-- preserved forever; pages are never silently reordered or removed; low-
-- confidence segmentation asks a human, never guesses. This schema records
-- provenance so those guarantees are enforceable in code.
--
-- Every table is additive + idempotent (safe to re-run on every boot). No
-- existing table is modified. All population happens in later R5.7–R5.12 work.

-- ---------------------------------------------------------------------------
-- document_packages — the immutable combined upload.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_packages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- The `documents` row this package was ingested from (the original upload).
  source_document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  source_sha256     text,                       -- checksum of the original bytes
  page_count        int,
  -- pending → rendered → segmented → materialized  (the lifecycle position)
  ingest_status     text NOT NULL DEFAULT 'pending',
  -- ok / has_blank / has_duplicates / has_rotated / has_unreadable / mixed
  quality_status    text,
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_document_packages_app ON document_packages (application_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_packages_source
  ON document_packages (source_document_id)
  WHERE source_document_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- document_pages — one physical page of a package.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_pages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id        uuid NOT NULL REFERENCES document_packages(id) ON DELETE CASCADE,
  page_number       int NOT NULL,               -- 1-indexed within the package
  render_storage_ref text,                       -- storage key for the rendered page image (optional)
  text_sha256       text,                       -- hash of the page's extracted text (duplicate detection)
  visual_phash      text,                       -- perceptual hash of the render (near-duplicate detection)
  width             numeric,
  height            numeric,
  unit              text,                        -- 'inch' | 'pixel' | 'point'
  rotation          int,                         -- 0/90/180/270 detected orientation
  blank_score       numeric,                     -- 0..1, higher = more likely blank/separator
  quality_score     numeric,                     -- 0..1, higher = cleaner scan
  duplicate_of_page_id uuid REFERENCES document_pages(id) ON DELETE SET NULL,
  ocr_status        text,                        -- pending / ok / unreadable / skipped
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_pages_pkg_num
  ON document_pages (package_id, page_number);
CREATE INDEX IF NOT EXISTS idx_document_pages_texthash
  ON document_pages (text_sha256) WHERE text_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_document_pages_phash
  ON document_pages (visual_phash) WHERE visual_phash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- logical_documents — a page-bounded logical document within a package.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logical_documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id            uuid NOT NULL REFERENCES document_packages(id) ON DELETE CASCADE,
  application_id        uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- The materialized child `documents` row (once a human confirms + it is filed).
  document_id           uuid REFERENCES documents(id) ON DELETE SET NULL,
  document_type         text,
  document_subtype      text,
  classification_confidence numeric,
  -- accepted / needs_review / rejected
  classification_status text NOT NULL DEFAULT 'needs_review',
  derived_storage_ref   text,                    -- physically sliced bytes (page-bounded)
  derived_sha256        text,
  family_key            text,                    -- groups a title/insurance/contract/statement family
  -- draft / current / superseded / duplicate / amendment / unknown
  version_status        text NOT NULL DEFAULT 'unknown',
  effective_date        date,
  -- splitter / human / single_upload
  created_from          text NOT NULL DEFAULT 'splitter',
  confirmed_by          uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  confirmed_at          timestamptz,
  meta                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_logical_documents_pkg ON logical_documents (package_id);
CREATE INDEX IF NOT EXISTS idx_logical_documents_app ON logical_documents (application_id);
CREATE INDEX IF NOT EXISTS idx_logical_documents_family
  ON logical_documents (application_id, family_key) WHERE family_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_logical_documents_doc
  ON logical_documents (document_id) WHERE document_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- logical_document_pages — which pages compose a logical document.
-- A page belongs to at most one logical document unless a human explicitly
-- marks it shared (meta.shared=true); the partial unique index enforces the
-- default single-membership.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logical_document_pages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  logical_document_id   uuid NOT NULL REFERENCES logical_documents(id) ON DELETE CASCADE,
  page_id               uuid NOT NULL REFERENCES document_pages(id) ON DELETE CASCADE,
  sequence_number       int NOT NULL,            -- order within the logical document
  classifier_label      text,
  classifier_confidence numeric,
  continuation_confidence numeric,               -- how sure this is a continuation page
  shared                boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ldp_doc_seq
  ON logical_document_pages (logical_document_id, sequence_number);
-- A physical page maps to ONE logical document unless explicitly shared.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ldp_page_unique
  ON logical_document_pages (page_id) WHERE shared = false;
CREATE INDEX IF NOT EXISTS idx_ldp_page ON logical_document_pages (page_id);

-- ---------------------------------------------------------------------------
-- document_relationships — versioning / precedence between logical documents.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_relationships (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_logical_document_id uuid NOT NULL REFERENCES logical_documents(id) ON DELETE CASCADE,
  to_logical_document_id   uuid NOT NULL REFERENCES logical_documents(id) ON DELETE CASCADE,
  -- supersedes / amends / duplicates / continues / attachment_to / replaces
  relationship_type     text NOT NULL,
  confidence            numeric,
  basis                 jsonb NOT NULL DEFAULT '{}'::jsonb,   -- why (dates / issuers / signatures / evidence ids)
  confirmed_by          uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_docrel_unique
  ON document_relationships (from_logical_document_id, to_logical_document_id, relationship_type);
CREATE INDEX IF NOT EXISTS idx_docrel_app ON document_relationships (application_id);

-- ---------------------------------------------------------------------------
-- document_lifecycle_events — append-only audit of every packet action.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_lifecycle_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  package_id            uuid REFERENCES document_packages(id) ON DELETE CASCADE,
  logical_document_id   uuid REFERENCES logical_documents(id) ON DELETE SET NULL,
  -- ingest / render / quality / segment / reclassify / split / merge /
  -- version / supersede / replace / human_confirm
  event_type            text NOT NULL,
  actor_kind            text,                    -- staff / system
  actor_id              uuid,
  detail                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_doclifecycle_app ON document_lifecycle_events (application_id, created_at);
CREATE INDEX IF NOT EXISTS idx_doclifecycle_pkg ON document_lifecycle_events (package_id, created_at);
