-- 225_sitewire_enqueue_repush_dedupe.sql — Serialize sitewire_enqueue_repush per application so a
-- pair of concurrent user edits can't both insert a duplicate queued push_file row (audit finding
-- 2026-07-21). The original function did:
--   UPDATE ... WHERE status='queued'; IF NOT FOUND THEN INSERT ...
-- With two concurrent transactions on the same application, both UPDATEs hit zero rows (nothing is
-- queued yet), both fall through, and both INSERT — the file is pushed twice back-to-back,
-- consuming 2× the volume-breaker budget and doubling Sitewire traffic on every edit spurt.
--
-- Fix: take a per-application transaction-scoped ADVISORY LOCK before the UPDATE — the second
-- transaction blocks until the first commits, then its UPDATE sees the queued row from the first
-- and short-circuits. `pg_advisory_xact_lock` releases automatically at commit/rollback, so no
-- unlock bookkeeping is needed. Uses hashtextextended (64-bit) to eliminate 32-bit collision risk.
--
-- Idempotent (safe to re-run every boot). CREATE OR REPLACE FUNCTION redefines in place — no data.

CREATE OR REPLACE FUNCTION sitewire_enqueue_repush(p_app uuid) RETURNS void AS $$
BEGIN
  -- Serialize the read-modify-write on this (app, target, direction, op) key so a race between two
  -- concurrent app-edit transactions can't double-enqueue. The key is namespaced so it can't
  -- collide with other advisory locks in the app (sw-birth: / sw-budget: / sw-retrel: / etc.).
  PERFORM pg_advisory_xact_lock(hashtextextended('sw-enqueue-repush:' || p_app::text, 0));
  UPDATE sync_queue SET updated_at = now()
    WHERE target = 'sitewire' AND direction = 'push' AND entity_type = 'application'
      AND entity_id = p_app AND op = 'push_file' AND status = 'queued';
  IF NOT FOUND THEN
    INSERT INTO sync_queue (entity_type, entity_id, target, direction, op, status, payload, run_after)
    VALUES ('application', p_app, 'sitewire', 'push', 'push_file', 'queued', '{}'::jsonb, now());
  END IF;
END;
$$ LANGUAGE plpgsql;
