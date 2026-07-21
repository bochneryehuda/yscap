-- 214 — Integration health state (for the API Health down-alert monitor).
--
-- The monitor (src/lib/integrations/monitor.js) probes every integration on a
-- schedule and emails the admins when one that WAS reachable goes DOWN (and again
-- when it recovers). This table holds the last-known state per integration so the
-- monitor only alerts on a real DOWN/RECOVER transition — never on every tick, and
-- never on intentional states (not connected / switched off / awaiting keys).
--
-- Keyed by the integration's stable registry key. Idempotent create.
CREATE TABLE IF NOT EXISTS integration_health_state (
  key            text PRIMARY KEY,
  state          text NOT NULL,
  detail         text,
  down_since     timestamptz,
  notified_down  boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
