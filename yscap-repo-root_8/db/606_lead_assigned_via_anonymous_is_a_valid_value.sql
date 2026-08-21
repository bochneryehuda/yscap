-- ============================================================================
-- db/606 — 'anonymous' is a valid assigned_via value
--
-- WHAT THIS CHANGES, AND WHY. This is db/521's bug, one value later, and it has
-- been live since 2026-08-07.
--
-- That day's work taught the public lead door to record a term-sheet export that
-- names NOBODY as `assigned_via='anonymous'` — the row's own statement of why it
-- sits outside every officer's queue. The CHECK was never widened to allow the
-- value, so EVERY nameless export has been failing on the INSERT with 23514 and
-- answering the visitor's page a 500: no lead row written, no sales-desk email
-- sent, nothing recorded anywhere. The whole "an anonymous export is still real
-- marketing signal, park it out of the queue" feature has therefore never once
-- worked, and nobody saw it because the failure is a 500 on a public page nobody
-- watches.
--
-- Found 2026-08-21 by the item-24 test walking the owner's own story through the
-- real endpoint. `scripts/test-lead-session-db.js` now asserts that every value
-- the route can write is one this column accepts, so a THIRD occurrence of this
-- class fails the build instead of shipping.
--
-- IDEMPOTENT: drop-then-re-add, the shape db/468 / db/484 / db/521 already use.
--
-- RE-ASSERTING THE CHECK. Every value the earlier files added is named here, not
-- only the new one: db/468 (lo_link, round_robin, manual), db/484 (staff_portal)
-- and db/521 (session) all replay on every boot, so a narrower re-assert would
-- roll this one back the moment a row uses 'anonymous'. This file is numbered
-- last, so it is the final word each boot.
--
-- BACKFILL: none, and none is possible — the rows this would have created were
-- never written. Existing rows keep whatever assigned_via they have.
--
-- PRODUCT SEPARATION: `leads` is an RTL table; nothing here touches lt_*.
-- ============================================================================

ALTER TABLE leads DROP CONSTRAINT IF EXISTS chk_leads_assigned_via;
ALTER TABLE leads ADD CONSTRAINT chk_leads_assigned_via
  CHECK (assigned_via IS NULL OR assigned_via IN
    ('lo_link', 'round_robin', 'manual', 'staff_portal', 'session', 'anonymous'));
