-- 536 — AMC (NAN) order cancellation metadata.
--
-- The NAN mirror of the Class desk's cancel: staff can ask the AMC to cancel a placed
-- order, with a plain reason. Asking is not agreeing — the order only moves to
-- 'cancelled' when the vendor's own status callback returns Cancellation (1051)
-- (mapStatusToLifecycle already handles it); in between it reads 'cancel_requested'
-- and keeps polling. These columns record WHO asked, WHEN, and WHY on the order row so
-- the desk can show it. `amc_orders.status` is plain text (no CHECK), so the new
-- 'cancel_requested' status needs no constraint change.

ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS cancel_reason        text;
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS cancel_requested_at  timestamptz;
ALTER TABLE amc_orders ADD COLUMN IF NOT EXISTS cancel_requested_by  uuid REFERENCES staff_users(id) ON DELETE SET NULL;

-- 'cancel_requested' is a still-live state — the poll worker keeps checking for the
-- vendor's Cancellation (1051) confirmation — so it belongs in the partial poll index
-- (db/480 idx_amc_orders_open) that mirrors OPEN_STATUSES in src/amc/sync.js. Recreate
-- the index with the widened predicate (a partial index's WHERE can't be altered in
-- place, so drop + recreate; both idempotent).
DROP INDEX IF EXISTS idx_amc_orders_open;
CREATE INDEX IF NOT EXISTS idx_amc_orders_open
  ON amc_orders(status)
  WHERE status IN ('ordered','in_process','assigned','inspected','in_review','product_available','on_hold','cancel_requested');
