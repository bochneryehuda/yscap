-- ============================================================================
-- db/639 — flood insurance order
--
-- WHAT THIS CHANGES, AND WHY (owner-directed 2026-08-28): when a property is in
-- a flood zone, flood insurance must actually be ORDERED — and until now PILOT
-- could only add the flood-insurance condition (db/378) and wait. The owner:
-- "if the flood condition is added, there should be an order section … you have
-- the option by the order center to flip 'hey this property is in a flood
-- zone'; if you flip that switch then it's adding a flood condition on the file
-- and you can order flood insurance."
--
-- Two pieces:
--   1. applications.flood_zone_override — the MANUAL flip. The engine already
--      derives `in_flood_zone` from the appraisal's FEMA fields and completed
--      flood-determination orders; this records a HUMAN's assertion that the
--      property is in a flood zone when neither source has said so yet (a flood
--      cert in hand, a FEMA map lookup). TRUE = asserted; NULL = derived only.
--      There is deliberately NO false value: a human may add the fact, never
--      silence FEMA evidence — reversing a proven zone stays the engine's job
--      when the determination itself is corrected. (The owner asked for this
--      flip by name, which is what allows a column on applications.)
--   2. The file_orders order_type CHECK widens to carry 'flood_insurance' —
--      re-asserting every prior value (db/359 attorney, db/564 appraisal,
--      db/638 settlement) under the same constraint name, the superseded-
--      constraint discipline the boot runner recognizes.
--
-- BACKFILL: none — the override starts NULL everywhere (derived behavior
-- unchanged), and no flood-insurance order exists until one is placed.
--
-- PRODUCT SEPARATION: RTL only. Nothing here touches lt_*.
-- ============================================================================

ALTER TABLE applications ADD COLUMN IF NOT EXISTS flood_zone_override boolean;

ALTER TABLE file_orders DROP CONSTRAINT IF EXISTS file_orders_order_type_check;
ALTER TABLE file_orders
  ADD CONSTRAINT file_orders_order_type_check
  CHECK (order_type IN ('title','insurance','attorney','appraisal','settlement','flood_insurance'));

-- Same guarded shape as db/564/db/638 for the events table: replace a constraint
-- ONLY when it is nothing but an order_type IN-list, re-added under the fixed
-- name so the boot runner's superseded-constraint pre-scan sees this file as the
-- name's latest definer.
DO $$
DECLARE cname text;
BEGIN
  IF to_regclass('public.file_order_events') IS NULL THEN RETURN; END IF;
  SELECT con.conname INTO cname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
   WHERE rel.relname = 'file_order_events'
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) ILIKE '%order_type%'
     AND pg_get_constraintdef(con.oid) NOT ILIKE '%kind%'
     AND pg_get_constraintdef(con.oid) NOT ILIKE '%status%'
     AND pg_get_constraintdef(con.oid) NOT ILIKE '%application_id%'
   LIMIT 1;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE file_order_events DROP CONSTRAINT %I', cname);
  END IF;
  EXECUTE 'ALTER TABLE file_order_events ADD CONSTRAINT file_order_events_order_type_check '
       || 'CHECK (order_type IN (''title'',''insurance'',''attorney'',''appraisal'',''settlement'',''flood_insurance''))';
END $$;

-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself.
