-- 257 — Evidence ledger: evidence_spans + fact/finding/condition evidence links
--       (R5.13 + R5.14, owner-directed 2026-07-22 — the "Evidence Graph" workstream).
--
-- Owner + external review, top priority: "every single fact should know which
-- document it came from, which page, which paragraph, OCR confidence, AI
-- confidence, which model extracted it." Today the reader has page structure
-- (db/231 added page_number to findings; fact_observations has page_number),
-- but polygons / field locations / durable evidence identifiers are not
-- persisted, so provenance is page-level, not audit-grade field-level.
--
-- This migration adds the durable evidence ledger:
--
--   evidence_spans               one cited region: doc + page + polygon + quote
--                                + normalized value + OCR/extractor engine,
--                                version, confidence + source checksum + status.
--   fact_evidence_links          a fact_observation ↔ span (direct /
--                                corroborating / contradicting / derived_input).
--   finding_evidence_links       a document_finding OR ai_suggestion ↔ span
--                                (supports / conflicts / context).
--   condition_requirement_evidence  a cure/clearance requirement ↔ span
--                                (satisfies / fails / cannot_address).
--
-- PRINCIPLE (enforced in code by R5.18): no material fact, conflict, condition
-- decision, or root cause should exist without one or more durable evidence
-- references; any model output citing a span id we don't have is rejected.
--
-- All additive + idempotent. Spans survive reanalysis (keyed by source_sha256 +
-- analyzer version); a superseded source flips status to 'superseded' (R5.19),
-- never deleted (one-way evidence, mirrors the no-delete SharePoint policy).

-- ---------------------------------------------------------------------------
-- evidence_spans — the atomic unit of provenance.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evidence_spans (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  document_id       uuid REFERENCES documents(id) ON DELETE SET NULL,
  -- packet lifecycle (db/256) — the physical page + logical doc, when known.
  page_id           uuid REFERENCES document_pages(id) ON DELETE SET NULL,
  logical_document_id uuid REFERENCES logical_documents(id) ON DELETE SET NULL,
  page_number       int,                        -- 1-indexed, for docs not yet in the packet model
  -- line / word / table_cell / selection_mark / signature / image_region /
  -- api_response / guideline_citation
  span_type         text NOT NULL DEFAULT 'line',
  quote             text,                        -- the exact text as read
  normalized_value  text,                        -- canonical form (comparable across sources)
  polygon           jsonb,                       -- [{x,y}, …] normalized 0..1 bounding polygon
  ocr_engine        text,
  ocr_model_version text,
  ocr_confidence    numeric,
  extractor_engine  text,
  extractor_version text,
  extractor_confidence numeric,
  source_sha256     text,                        -- checksum of the source bytes (reanalysis identity)
  analyzer_version  text,                        -- artifact bundle that produced this span (db/256/R5.5)
  -- active / superseded / invalid
  status            text NOT NULL DEFAULT 'active',
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_evidence_spans_app ON evidence_spans (application_id);
CREATE INDEX IF NOT EXISTS idx_evidence_spans_doc ON evidence_spans (document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_evidence_spans_page ON evidence_spans (page_id) WHERE page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_evidence_spans_active
  ON evidence_spans (application_id, status) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- fact_evidence_links — a canonical-fact observation cites spans.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fact_evidence_links (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_observation_id   uuid NOT NULL REFERENCES fact_observations(id) ON DELETE CASCADE,
  evidence_span_id      uuid NOT NULL REFERENCES evidence_spans(id) ON DELETE CASCADE,
  -- direct / corroborating / contradicting / derived_input
  support_type          text NOT NULL DEFAULT 'direct',
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_evidence_unique
  ON fact_evidence_links (fact_observation_id, evidence_span_id, support_type);
CREATE INDEX IF NOT EXISTS idx_fact_evidence_span ON fact_evidence_links (evidence_span_id);

-- ---------------------------------------------------------------------------
-- finding_evidence_links — a finding OR an AI suggestion cites spans.
-- Exactly one of (finding_id, ai_suggestion_id) is set; a CHECK enforces it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS finding_evidence_links (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id            uuid REFERENCES document_findings(id) ON DELETE CASCADE,
  ai_suggestion_id      uuid REFERENCES ai_suggestions(id) ON DELETE CASCADE,
  evidence_span_id      uuid NOT NULL REFERENCES evidence_spans(id) ON DELETE CASCADE,
  -- supports / conflicts / context
  role                  text NOT NULL DEFAULT 'supports',
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finding_evidence_one_target CHECK (
    (finding_id IS NOT NULL AND ai_suggestion_id IS NULL) OR
    (finding_id IS NULL AND ai_suggestion_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_finding_evidence_f_unique
  ON finding_evidence_links (finding_id, evidence_span_id, role) WHERE finding_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_finding_evidence_s_unique
  ON finding_evidence_links (ai_suggestion_id, evidence_span_id, role) WHERE ai_suggestion_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_finding_evidence_span ON finding_evidence_links (evidence_span_id);

-- ---------------------------------------------------------------------------
-- condition_requirement_evidence — a cure/clearance requirement cites spans.
-- clearance_proof_id references the append-only cure proof (db/200 family);
-- requirement_id is the string key of the requirement within that proof.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS condition_requirement_evidence (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clearance_proof_id    uuid,                    -- FK added conditionally below (table may lag)
  requirement_id        text NOT NULL,
  evidence_span_id      uuid NOT NULL REFERENCES evidence_spans(id) ON DELETE CASCADE,
  -- satisfies / fails / cannot_address
  evaluation_role       text NOT NULL DEFAULT 'satisfies',
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cond_req_evidence_span ON condition_requirement_evidence (evidence_span_id);
CREATE INDEX IF NOT EXISTS idx_cond_req_evidence_proof ON condition_requirement_evidence (clearance_proof_id) WHERE clearance_proof_id IS NOT NULL;

-- Wire the FK to condition_clearance_proofs only if that table exists on this
-- deploy (it ships with the condition-intelligence work). Guarded so this
-- migration never fails on a DB where that table hasn't landed yet.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'condition_clearance_proofs')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'condition_requirement_evidence_proof_fk')
  THEN
    ALTER TABLE condition_requirement_evidence
      ADD CONSTRAINT condition_requirement_evidence_proof_fk
      FOREIGN KEY (clearance_proof_id) REFERENCES condition_clearance_proofs(id) ON DELETE CASCADE;
  END IF;
END $$;
