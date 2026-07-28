-- 363_trustpoint_service_order_baseline.sql
-- Idempotent, and deliberately ONE-SHOT.
--
-- THE DEPLOY THAT FIXES THE DUPLICATE INSPECTION NOTICES WOULD HAVE SENT ONE MORE ROUND.
--
-- The owner reported (2026-07-27) THREE "inspection completed" notices on YSCAP258134727 for
-- TWO real inspections. One of the two causes was that the dedupe was a non-atomic read of
-- `status`, so a completed → revised → completed inspection announced twice. The fix claims
-- the `trustpoint_service_orders.status_synced` watermark atomically:
--
--     UPDATE … SET status_synced='COMPLETED'
--      WHERE tp_service_order_id=$1 AND status_synced IS DISTINCT FROM 'COMPLETED'
--
-- That column has existed since db/297 but was READ AND NEVER WRITTEN, so EVERY service-order
-- row in the database carries `status_synced IS NULL`. On the first poll after this deploy,
-- every inspection that was already COMPLETED — the entire back book — would satisfy
-- `IS DISTINCT FROM 'COMPLETED'`, win the claim, and be announced as if it had just finished.
-- The fix for the duplicate notices would itself have produced a duplicate notice per historic
-- inspection, on every file, at once. `baseline` does not save us: it is only true while a
-- project is being hydrated for the FIRST time, and these projects were linked days ago.
--
-- So the watermark is BASELINED here: every inspection that is already complete is stamped as
-- announced. That is the same go-forward doctrine as `applications.status_notified_external`
-- (db/187) — PILOT never announces history it was not watching.
--
-- ONE-SHOT, not "idempotent and re-running", because those are different things here. A
-- statement that stamps every COMPLETED row on every boot would silently swallow a real
-- announcement: an inspection that completes seconds before a restart is upserted COMPLETED,
-- has not been claimed yet, and would be marked announced by the next boot before the poll
-- ever reached it. Stamping the backlog ONCE, at the cutover, leaves every future completion
-- free to announce exactly once.

DO $$
DECLARE
  done boolean;
  n    int := 0;
BEGIN
  SELECT COALESCE((value->>'done')::boolean, false) INTO done
    FROM sync_runtime_state WHERE key = 'trustpoint_service_order_baseline';
  IF COALESCE(done, false) THEN
    RETURN;
  END IF;

  UPDATE trustpoint_service_orders
     SET status_synced = 'COMPLETED', updated_at = now()
   WHERE status = 'COMPLETED'
     AND status_synced IS DISTINCT FROM 'COMPLETED';
  GET DIAGNOSTICS n = ROW_COUNT;

  INSERT INTO sync_runtime_state (key, value, updated_at)
  VALUES ('trustpoint_service_order_baseline',
          jsonb_build_object('done', true, 'rows', n, 'at', now()),
          now())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = now();

  RAISE NOTICE '363: baselined % already-completed inspection(s) — they will not be re-announced', n;
END $$;
