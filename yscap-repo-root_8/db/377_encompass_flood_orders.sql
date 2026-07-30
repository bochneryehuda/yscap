-- ============================================================================
-- 377 — Encompass FLOOD-DETERMINATION ordering (owner-directed 2026-07-30).
--
-- THE FIRST AND ONLY WRITE PATH INTO ENCOMPASS. The owner authorized, in their
-- own words, ordering a Life-of-Loan flood determination from ICE Mortgage
-- Technology's OWN flood service through the Encompass API — and NOTHING else
-- ("only be able to order flood right now and not anything extra"). Everything
-- else in the Encompass integration stays structurally READ-ONLY / frozen; this
-- ordering lives in its OWN guarded module (src/encompass/flood-order.js), never
-- through src/lib/integrations/encompass.js (which is untouched and still refuses
-- every write). Off by default: ENCOMPASS_FLOOD_ENABLED + a separate
-- ENCOMPASS_FLOOD_OUTBOUND_ENABLED write gate + ENCOMPASS_FLOOD_DRYRUN.
--
-- Flow: staff click "Order flood certificate" on the flood condition
-- (rtl_cond_flood) → PILOT places the order against the file's Encompass loan
-- (found by the file's ys_loan_number, the way every other Encompass link works)
-- → a poll worker completes it → the certificate PDF is filed onto the flood
-- condition and the determination (in a flood zone / not) is recorded here. A
-- proven flood zone then drives `in_flood_zone`, which auto-attaches the
-- flood-insurance condition.
--
-- One row per order attempt. The newest COMPLETED row per file is the
-- authoritative determination.
-- ============================================================================

CREATE TABLE IF NOT EXISTS encompass_flood_orders (
  id                 bigserial PRIMARY KEY,
  application_id     uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- The flood condition the certificate PDF attaches to (rtl_cond_flood item).
  checklist_item_id  uuid REFERENCES checklist_items(id) ON DELETE SET NULL,
  -- The Encompass loan the order was placed against (the join key, resolved from
  -- the file's ys_loan_number → applications.encompass_loan_guid).
  encompass_loan_guid text NOT NULL,
  product            text NOT NULL DEFAULT 'life_of_loan',   -- Life-of-Loan determination
  -- The Encompass service-order / partner-transaction id we poll on.
  order_id           text,
  -- ordered  = placed, waiting for ICE to fulfill
  -- completed= certificate came back, PDF filed, determination recorded
  -- error    = the order failed (last_error explains); a human can re-order
  -- dryrun   = ENCOMPASS_FLOOD_DRYRUN was on; nothing was actually sent
  status             text NOT NULL DEFAULT 'ordered',
  sfha               boolean,          -- true = in a Special Flood Hazard Area (a flood zone)
  flood_zone         text,             -- the FEMA zone the determination returned (A / AE / V / X …)
  determination      jsonb,            -- the parsed determination detail (community, panel, map date …)
  document_id        uuid REFERENCES documents(id) ON DELETE SET NULL,  -- the filed certificate PDF
  raw                jsonb,            -- last raw status response (audit / debugging)
  last_error         text,
  ordered_by         uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  ordered_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Newest-order-per-file lookups (the condition button + the poll worker).
CREATE INDEX IF NOT EXISTS idx_flood_orders_app
  ON encompass_flood_orders(application_id, ordered_at DESC);

-- The poll worker drains rows still 'ordered'.
CREATE INDEX IF NOT EXISTS idx_flood_orders_pending
  ON encompass_flood_orders(status) WHERE status = 'ordered';

-- At most ONE outstanding order per file — the button refuses a second while one
-- is in flight, and this is the belt-and-suspenders backstop against a double-click.
CREATE UNIQUE INDEX IF NOT EXISTS uq_flood_order_pending
  ON encompass_flood_orders(application_id) WHERE status = 'ordered';
