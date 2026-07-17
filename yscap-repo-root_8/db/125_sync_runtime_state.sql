-- ============================================================================
-- 125_sync_runtime_state.sql — durable key/value state for the sync worker.
--
-- WO-4 (F-M7 / F-H4): the reconcile "bookmark" (watermark) lived only in
-- process memory, so every deploy (13 in one day) reset it and re-scanned the
-- last 24h of ClickUp tasks — a portfolio-wide re-ingest storm on every restart.
-- Persisting it here lets a restart RESUME from where the last successful pass
-- ended instead of starting over. Small, additive, idempotent — safe to re-run
-- on every boot like every migration.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sync_runtime_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
