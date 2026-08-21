-- ============================================================================
-- db/607 — a hand-placed Trinity order on a file that is NOT Trinity's says WHY
--
-- WHAT THIS CHANGES, AND WHY (owner-directed 2026-08-21, item 25). The Draw
-- Coordinator can now order a Trinity physical inspection on ANY file, including
-- one whose draws belong to somebody else — a Blue Lake / TrustPoint file before
-- it is sold, or a file set up for virtual inspections where "one time he doesn't
-- have access and he wants to order a physical".
--
-- That is a human overruling the file's own configured setup, and it costs money
-- and sends a person to somebody's property. The routing rule itself does NOT
-- move (src/trinity/eligibility.js `isTrinityFile` still decides everything
-- automatic, so a virtual file's inspections stay Sitewire's and a Blue Lake
-- file's stay TrustPoint's) — what these columns record is the deliberate act
-- beside it: WHO overruled it, WHEN, and in their own words WHY.
--
-- Without the reason on the row, an inspection nobody expected turns up on a
-- file and the only record is an invoice.
--
-- IDEMPOTENT: three ADD COLUMN IF NOT EXISTS.
--
-- BACKFILL: none, and none is right. Every existing order was placed on a file
-- that WAS Trinity's — NULL here means "no override was needed", which is the
-- truth for all of them and for every ordinary order from now on.
--
-- PRODUCT SEPARATION: `trinity_inspection_orders` is an RTL table; nothing here
-- touches lt_*.
-- ============================================================================

ALTER TABLE trinity_inspection_orders
  ADD COLUMN IF NOT EXISTS manual_override_reason text;
ALTER TABLE trinity_inspection_orders
  ADD COLUMN IF NOT EXISTS manual_override_by uuid REFERENCES staff_users(id);
ALTER TABLE trinity_inspection_orders
  ADD COLUMN IF NOT EXISTS manual_override_at timestamptz;

-- Answering "which inspections did we order against a file's own setup?" is a
-- real question for the desk and for anybody reading the invoices; the partial
-- index keeps it cheap and stays tiny (these are rare by design).
CREATE INDEX IF NOT EXISTS trinity_orders_override_idx
  ON trinity_inspection_orders (manual_override_at DESC)
  WHERE manual_override_reason IS NOT NULL;
