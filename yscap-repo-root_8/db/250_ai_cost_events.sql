-- 250 — AI cost telemetry (R2.11, owner-directed 2026-07-22).
--
-- Every AI call (Azure OpenAI, committee, cure analysis, custom extract, etc.)
-- records one row here with tokens_in / tokens_out and a cost estimate in cents.
-- The per-file rollup lets staff see "how much AI has been spent on this file"
-- and lets a future cap gate further AI calls once a per-file dollar ceiling
-- is exceeded (default: no cap — env AI_PER_FILE_CAP_USD).
--
-- Idempotent (safe to re-run every boot).

CREATE TABLE IF NOT EXISTS ai_cost_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        uuid REFERENCES applications(id) ON DELETE SET NULL,
  document_id           uuid REFERENCES documents(id) ON DELETE SET NULL,
  op_name               text NOT NULL,          -- e.g. 'complete', 'reviewer:credit', 'classify'
  provider              text NOT NULL,          -- 'azure_openai' | 'azure_docint' | 'azure_docint_custom' | ...
  model                 text,                    -- deployment name or model id
  tokens_in             integer NOT NULL DEFAULT 0,
  tokens_out            integer NOT NULL DEFAULT 0,
  tokens_total          integer NOT NULL DEFAULT 0,
  cost_cents            integer NOT NULL DEFAULT 0,     -- integer cents, best-effort estimate
  duration_ms           integer,
  ok                    boolean NOT NULL DEFAULT true,
  reason                text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_cost_events_by_file
  ON ai_cost_events (application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_cost_events_by_day
  ON ai_cost_events (date_trunc('day', created_at));
