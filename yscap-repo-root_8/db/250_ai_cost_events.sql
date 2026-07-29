-- 250 — AI cost telemetry (R2.11, owner-directed 2026-07-22).
--
-- Every AI call (Azure OpenAI, committee, cure analysis, custom extract, etc.)
-- records one row here with tokens_in / tokens_out and a cost estimate in cents.
-- The per-file rollup lets staff see "how much AI has been spent on this file"
-- and lets a future cap gate further AI calls once a per-file dollar ceiling
-- is exceeded (default: no cap — env AI_PER_FILE_CAP_USD).
--
-- Idempotent (safe to re-run every boot).
--
-- EDITED IN PLACE 2026-07-23 (the ONE sanctioned case): the original by-day
-- index used date_trunc('day', created_at), which Postgres REJECTS in an index
-- expression (date_trunc on timestamptz is STABLE, not IMMUTABLE) — so this
-- whole file failed atomically on EVERY database that ever ran it. migrate-boot
-- logs "FAILED — continuing", meaning the ai_cost_events TABLE was never
-- created in production and the cost telemetry silently recorded nothing.
-- Because the file was provably never applied anywhere (Postgres itself
-- refuses it) and therefore appears in no schema_migrations ledger, fixing it
-- in place is safe and is what finally creates the table on the next boot.
-- The "never edit old migrations" rule protects APPLIED files — not one that
-- cannot apply. The by-day index is replaced with a plain created_at btree
-- (no query uses the date_trunc expression; range scans + MAX(created_at)
-- are what the telemetry reads).

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
  ON ai_cost_events (created_at);
