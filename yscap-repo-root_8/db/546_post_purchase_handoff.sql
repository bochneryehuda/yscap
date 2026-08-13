-- ============================================================================
-- 546_post_purchase_handoff.sql — THE HAND-OFF FROM "ENCOMPASS SAYS IT SOLD" TO
-- "PILOT'S PURCHASE IS FINISHED" (owner-directed 2026-08-13).
--
-- The owner: *"when the system realizes that Encompass has a purchase advice
-- date filled out, it should email the post-purchase people on the file — which
-- right now should be, for every file by default, Malky Katz and Chaya Gruber.
-- Going forward you should make it so that we can set different post-purchasing
-- … 'Hey, PILOT sees that this file was sold. Please come into PILOT, upload the
-- purchase advice, put in the purchase advice date and mark purchase completed.'
-- … but once one of the two is done, the draw coordinator should be able to
-- continue as usual — it's sold, fine. PILOT should still have outstanding tasks
-- for the post-purchaser to take care of."*
--
-- TWO SMALL THINGS, and deliberately no more.
--
--   1. `post_purchase_notify` — WHO gets that email. A company-wide list rather
--      than a hardcoded pair, so it is changed on a screen instead of in a
--      deploy. SEEDED BY NAME against the real staff roster, never by a
--      hardcoded id: an id copied from one database is meaningless in another,
--      and a wrong one would silently email nobody. A name that does not match
--      an active staff member simply seeds nothing and the screen shows an empty
--      list — visibly empty, which is the honest failure.
--
--   2. `applications.purchase_advice_notified_at` — the stamp that makes that
--      email happen ONCE. The advice date is re-read by three separate paths
--      (the poll worker, the draw desk's own refresh, the manual button); every
--      one of them lands through `release-party.syncPurchaseAdviceDate`, so the
--      stamp lives with the fact rather than with any one of them.
--
-- WHAT THIS DOES NOT DO: it does not gate the DRAW side on the purchasing
-- paperwork. The owner is explicit — once either side knows the loan is sold the
-- draw coordinator carries on, and the purchasing to-do stays outstanding until
-- the post-purchase team finishes it in PILOT. Those two facts are read
-- independently and neither waits for the other.
--
-- Additive and idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS post_purchase_notify (
  staff_id   uuid PRIMARY KEY REFERENCES staff_users(id) ON DELETE CASCADE,
  added_at   timestamptz NOT NULL DEFAULT now(),
  added_by   uuid REFERENCES staff_users(id) ON DELETE SET NULL
);

ALTER TABLE applications ADD COLUMN IF NOT EXISTS purchase_advice_notified_at timestamptz;

-- The two people the owner named, matched against the roster we actually have.
-- Case- and spacing-tolerant on the full name; ACTIVE, INTERNAL staff only (an
-- external/broker account must never receive an internal hand-off). Re-running
-- adds nobody twice, and it never re-adds somebody an admin has removed on
-- purpose — the ON CONFLICT covers a re-run, and a deliberate removal is
-- protected by only seeding into an EMPTY list.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM post_purchase_notify) THEN
    INSERT INTO post_purchase_notify (staff_id)
    SELECT id FROM staff_users
     WHERE is_active = true AND COALESCE(is_external, false) = false
       AND regexp_replace(lower(COALESCE(full_name, '')), '\s+', ' ', 'g') IN ('malky katz', 'chaya gruber')
    ON CONFLICT (staff_id) DO NOTHING;
  END IF;
END $$;
