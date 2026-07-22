-- 252_request_audit_log.sql — Automatic, comprehensive request-level audit
-- log (owner-directed 2026-07-22). Every single HTTP request the server
-- answers is written here — every /auth call, every /api call, every action
-- a borrower or staffer takes through the portal, every automation call,
-- every webhook, every failed attempt.
--
-- This is DIFFERENT from the existing `audit_log` table (which is the
-- GLBA/PII business-action trail — "user X viewed SSN of Y"). `audit_log`
-- only captures actions a developer explicitly logs. `request_audit_log`
-- captures EVERYTHING, automatically, with no per-handler code changes:
-- one row per HTTP request, with timestamp, actor, method, path, status,
-- and duration. Together they answer "what happened, when, and why."
--
-- Writes are buffered + async in the app (`src/lib/request-audit.js`), so
-- this table can grow large fast — the indexes below are chosen so the
-- browse endpoint (`GET /api/admin/request-audit`) is fast on the queries
-- it actually runs (by-time, by-actor, by-status, by-path).
--
-- Retention is a policy decision (not enforced here yet) — an admin cleanup
-- can `DELETE FROM request_audit_log WHERE at < now() - interval 'N days'`.

CREATE TABLE IF NOT EXISTS request_audit_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  request_id    text,                   -- correlates with X-Request-Id + logs
  actor_kind    text NOT NULL           -- 'staff' | 'borrower' | 'anon' | 'system'
                CHECK (actor_kind IN ('staff','borrower','anon','system')),
  actor_id      uuid,                   -- resolved from Bearer JWT when present
  actor_email   text,                   -- convenience for the log viewer
  actor_role    text,
  method        text NOT NULL,          -- GET / POST / PATCH / …
  path          text NOT NULL,          -- the actual URL path (no query string — that's in `query`)
  route         text,                   -- the matched Express route pattern (e.g. /applications/:id) when known
  query         jsonb,                  -- redacted query params (tokens/passwords stripped)
  status        integer,                -- HTTP status the server returned
  duration_ms   integer,                -- wall-clock time to answer
  ip            inet,
  user_agent    text,
  referer       text,
  entity_type   text,                   -- inferred from the route (e.g. 'application'/'borrower')
  entity_id     uuid,                   -- inferred from the FIRST :uuid path segment when present
  body_summary  jsonb,                  -- redacted top-level body keys (never the values for sensitive fields)
  error         text,                   -- error/reason on 4xx/5xx (from res.locals.auditError or the response body's `error` field)
  bytes_out     integer                 -- response Content-Length when known
);

-- The log viewer's headline query is "the newest rows first" — a single
-- descending index on `at` makes that O(log n) and answers the default
-- browse page in milliseconds even with tens of millions of rows.
CREATE INDEX IF NOT EXISTS idx_req_audit_at         ON request_audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_req_audit_actor      ON request_audit_log (actor_kind, actor_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_req_audit_entity     ON request_audit_log (entity_type, entity_id, at DESC)
  WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_req_audit_status     ON request_audit_log (status, at DESC);
CREATE INDEX IF NOT EXISTS idx_req_audit_path       ON request_audit_log (path, at DESC);
CREATE INDEX IF NOT EXISTS idx_req_audit_request_id ON request_audit_log (request_id) WHERE request_id IS NOT NULL;
