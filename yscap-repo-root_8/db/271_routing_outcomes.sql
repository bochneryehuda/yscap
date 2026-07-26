-- P0 — Routing accuracy telemetry (owner-directed 2026-07-22, "Gap 1: measurement").
-- Persists ONE row per document-aware OCR read so the scoreboard can answer:
-- which OCR engine performs best by document family, how often two reads
-- disagree, how often a page needs a re-read, and (once humans correct values)
-- which engine's reads get corrected most. Advisory/observability only — nothing
-- reads this table to make an underwriting decision; it feeds the aggregator
-- (src/lib/ai/routing-telemetry.js) and the AI-stack accuracy tile.
--
-- Idempotent: safe to re-run on every boot.

CREATE TABLE IF NOT EXISTS routing_outcomes (
  id               BIGSERIAL PRIMARY KEY,
  application_id   UUID        REFERENCES applications(id) ON DELETE CASCADE,
  document_id      UUID,
  doc_family       TEXT,                       -- the classifier family this read was routed for
  winner_engine    TEXT,                       -- the engine whose text was used (label, e.g. azure-docint)
  engine_sequence  TEXT[]      NOT NULL DEFAULT '{}',  -- every engine tried, in order
  primary_source   TEXT,                       -- native_pdf / appraisal_xml / <engine> — the plan's primary
  materiality      TEXT,                       -- low / medium / high (from the routing matrix)
  numeric_critical BOOLEAN     NOT NULL DEFAULT FALSE,
  disagreement     BOOLEAN     NOT NULL DEFAULT FALSE,  -- the mandatory-challenger reads disagreed on numbers
  weak_page_count  INTEGER     NOT NULL DEFAULT 0,
  reread_page_count INTEGER    NOT NULL DEFAULT 0,
  reread_engine    TEXT,                       -- the engine that re-read the weak pages, if any
  human_corrected  BOOLEAN     NOT NULL DEFAULT FALSE,  -- a human later changed a value from this read (ground truth)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_routing_outcomes_family    ON routing_outcomes (doc_family);
CREATE INDEX IF NOT EXISTS idx_routing_outcomes_engine    ON routing_outcomes (winner_engine);
CREATE INDEX IF NOT EXISTS idx_routing_outcomes_app       ON routing_outcomes (application_id);
CREATE INDEX IF NOT EXISTS idx_routing_outcomes_created   ON routing_outcomes (created_at);
