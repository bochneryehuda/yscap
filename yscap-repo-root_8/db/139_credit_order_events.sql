-- ============================================================================
-- 139 — Append-only credit order event log (owner-directed 2026-07-19)
--
-- credit_reports is one row PER INTENT, overwritten in place — you can't
-- reconstruct the timeline of a billable call from it. This is the black-box
-- recorder: one immutable row per phase/attempt of an external credit call
-- (journal → post → parse → persist / error / in_doubt / dedup / breaker), with
-- latency, http status, and the correlation id. Append-only: a BEFORE UPDATE OR
-- DELETE trigger blocks any mutation. Never stores PII or the raw XML/secret.
-- ============================================================================
CREATE TABLE IF NOT EXISTS credit_order_events (
  id             bigserial PRIMARY KEY,
  report_id      uuid,
  application_id uuid,
  correlation_id text,
  actor_id       uuid,
  provider_id    integer,
  phase          text NOT NULL,        -- journal | post | parse | persist | error | in_doubt | dedup | breaker | spend_limit
  action         text,                 -- Reissue | Submit | ...
  outcome        text,                 -- ok | timeout | network | auth | http | parse | imported | review | error | ...
  http_status    integer,
  latency_ms     integer,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_order_events_report ON credit_order_events(report_id);
CREATE INDEX IF NOT EXISTS idx_credit_order_events_corr ON credit_order_events(correlation_id);
CREATE INDEX IF NOT EXISTS idx_credit_order_events_time ON credit_order_events(created_at);

CREATE OR REPLACE FUNCTION credit_order_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_order_events is append-only (no % allowed)', TG_OP USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_credit_order_events_append_only ON credit_order_events;
CREATE TRIGGER trg_credit_order_events_append_only
  BEFORE UPDATE OR DELETE ON credit_order_events
  FOR EACH ROW EXECUTE FUNCTION credit_order_events_append_only();
