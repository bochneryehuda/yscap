-- ============================================================================
-- 557 — THE APPRAISAL IS AN ORDER ON THE ORDERS DESK (owner-directed 2026-08-05,
--       re-confirmed 2026-08-16: "add appraisal to the Orders desk").
--
-- The desk has tracked title, insurance and closing-prep since db/211 / db/359.
-- An appraisal is the fourth thing a file waits on an outside company for, and it
-- was the only one with no row here — so it was missing from the cross-file Orders
-- queue, had no due date, no owner, no lateness clock, no notes and no history,
-- and nobody could see from the desk that a file's appraisal had been ordered at
-- all.
--
-- WHAT THE ROW IS, AND WHAT IT IS NOT.
--
--   It IS the desk's record of the appraisal: its clock, its owner, its notes, its
--   history, its place in the cross-file queue — exactly what the ATTORNEY row is
--   for closing prep (db/359), and for the same reason.
--
--   It is NOT a second way to order an appraisal, and nothing may ever make it
--   one. An appraisal is placed through one of three vendor APIs (AppraisalScope /
--   NAN, Class Valuation, Richer Values), each with its own credentials, its own
--   message shape and its own lifecycle. There is exactly ONE place that talks to
--   them — the appraisal order section — and this row is a PROJECTION of whatever
--   that placed, written by `src/lib/appraisal-order-mirror.js` and by nothing
--   else. A second writer here would be a second source of truth for whether a
--   file's appraisal is ordered, which is the failure this desk exists to prevent.
--
-- THE CONSTRAINT IS WIDENED IN PLACE, UNDER ITS OWN NAME. db/211 creates the table
-- with two values and db/359 drops and re-adds the constraint with three on EVERY
-- boot, so this file — numbered after both — drops and re-adds it with four. Under
-- the SAME name, deliberately: a new name would leave db/359's re-add free to put
-- the narrow list back on the next boot, and an 'appraisal' row would then fail
-- the check on a database that already holds one (the db/527 lesson).
--
-- Additive and idempotent. No existing row changes; no behaviour changes until the
-- projection writes its first row.
-- ============================================================================

ALTER TABLE file_orders DROP CONSTRAINT IF EXISTS file_orders_order_type_check;
ALTER TABLE file_orders
  ADD CONSTRAINT file_orders_order_type_check
  CHECK (order_type IN ('title','insurance','attorney','appraisal'));

-- The history table carries the same vocabulary, and its own check would refuse
-- every appraisal event the moment the desk recorded one. Guarded the same way:
-- whatever the constraint is called today, it is replaced by one that admits the
-- fourth type. Named conditionally because db/457 created it and later migrations
-- may not have.
-- THE MATCH IS DELIBERATELY NARROW. It replaces a constraint ONLY when that
-- constraint is nothing but an order_type IN-list — it must mention `order_type`
-- and must NOT mention any other column, or a future composite check (one that
-- happened to reference order_type alongside real logic) would be silently
-- replaced by this bare list and its other half destroyed. Today the table has no
-- order_type constraint at all, so this is a guarded no-op that keeps working if
-- one is ever added.
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
    EXECUTE format(
      'ALTER TABLE file_order_events ADD CONSTRAINT %I CHECK (order_type IN (''title'',''insurance'',''attorney'',''appraisal''))',
      cname);
  END IF;
END $$;

-- The desk reads one row per (file, type) and the projection upserts on that key,
-- which db/211's UNIQUE (application_id, order_type) already provides. Nothing
-- further is needed here: every tracked column (due_on, sla_days, assigned_to,
-- first_response_at, completed_at, notes) came with db/457 and is type-agnostic.
