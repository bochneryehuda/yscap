-- 406 — index the two lookups the file's AUDIT LOG makes (owner-directed
-- 2026-08-02: "File activity … should be much more audit-log oriented … every
-- notification, every log, everything that happens in that file should be
-- logged in that activity").
--
-- src/lib/activity.js `auditEvents` no longer reads a hand-maintained whitelist
-- of ~40 action codes off `audit_log`. It reads EVERY row that belongs to the
-- file, which includes the ~246 call sites that record the file id inside the
-- detail blob rather than in `entity_id` (`detail->>'applicationId'`). That
-- expression has no index, so the query would sequentially scan an append-only
-- table that is never pruned (see db/329's note) — on a large tenant that turns
-- one tab of the file screen into a table scan.
--
-- Both indexes are ADDITIVE and idempotent; nothing else in the app reads them.

-- (1) The detail-blob lookup, PARTIAL so it only carries the rows that actually
--     record an applicationId — a fraction of the table, and the only rows the
--     expression can ever match.
CREATE INDEX IF NOT EXISTS idx_audit_detail_application
  ON audit_log ((detail->>'applicationId'), created_at DESC)
  WHERE detail ? 'applicationId';

-- (2) The entity lookups (`entity_type='document'`/`'checklist_item'`/… IN (…))
--     already have `idx_audit_entity ON (entity_type, entity_id)` from
--     schema.sql, but the feed sorts by time within them; adding created_at
--     lets Postgres answer the ORDER BY … LIMIT from the index instead of
--     sorting every matching row.
CREATE INDEX IF NOT EXISTS idx_audit_entity_created
  ON audit_log (entity_type, entity_id, created_at DESC);

-- The request-level layer (`request_audit_log`, opt-in in the UI) filters on
-- entity_id alone; db/252 indexes (entity_type, entity_id, at DESC) which the
-- planner can only use with a leading entity_type. The file feed knows the id
-- but not which entity_type the middleware inferred, so index the id on its own.
CREATE INDEX IF NOT EXISTS idx_req_audit_entity_id_at
  ON request_audit_log (entity_id, at DESC)
  WHERE entity_id IS NOT NULL;
