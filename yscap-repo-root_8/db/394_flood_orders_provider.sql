-- ============================================================================
-- 394 — Flood-orders ledger becomes MULTI-PROVIDER (owner-directed 2026-07-30).
--
-- The owner asked to build a SECOND, cheaper flood provider — Xactus "Flood
-- ReportX" (MISMO 2.4) — and point the "Order flood certificate" button at it,
-- while PARKING the Encompass flood provider (kept, reversible via
-- FLOOD_ORDER_PROVIDER). Both providers share this ONE ledger (historically named
-- encompass_flood_orders after its first provider) so the button state and the
-- `in_flood_zone` signal (which reads the newest COMPLETED row here) work for
-- either provider with no second table.
--
--   • add `provider` — 'encompass' (existing + backfilled default) | 'xactus'
--   • drop the NOT NULL on `encompass_loan_guid` — Xactus orders on the property
--     address, not an Encompass loan GUID, so that column is NULL for a Xactus row.
--
-- Idempotent (safe to re-run on every boot).
-- ============================================================================

ALTER TABLE encompass_flood_orders
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'encompass';

-- A Xactus row has no Encompass loan GUID.
ALTER TABLE encompass_flood_orders
  ALTER COLUMN encompass_loan_guid DROP NOT NULL;

-- Poll workers drain their OWN provider's pending rows (the Encompass poll worker
-- now filters COALESCE(provider,'encompass')='encompass'; the Xactus one filters
-- provider='xactus'). This partial index keeps that scan cheap.
CREATE INDEX IF NOT EXISTS idx_flood_orders_provider_pending
  ON encompass_flood_orders(provider, status) WHERE status = 'ordered';
