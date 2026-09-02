-- ============================================================================
-- db/669 — "Prior to submittal completed": the loan officer's hand-off stamp
--
-- WHAT THIS CHANGES, AND WHY. Owner-directed 2026-09-02: *"After the bunch of
-- prior to submittal conditions there should be an option of a button that a
-- loan officer can click — Prior to submittal completed … it should come up
-- over there outstanding what else he needs to do … Everything that he clicks
-- Done goes down this list, and then he can click Complete Prior to
-- Submittal … There is a new field added to each ClickUp task — Prior to
-- submittal conditions — a dropdown where you can click on Complete. Any loan
-- officer that finishes all the stuff that he needs to finish is able to
-- click on the Prior to Submittal Completed. That ClickUp field gets filled to
-- Complete, and that moves it up on the list for faster submissions."*
--
-- WHAT WAS OBSERVED. There was no per-file "this gate is finished" fact
-- anywhere — only derived counts per bucket — so nothing could be told to
-- ClickUp, and nothing could say WHO handed the file over and WHEN.
--
-- THE FOUR COLUMNS, all on the loan:
--
--   submittal_completed_at / _by     the stamp: when the officer declared the
--                                    prior-to-submittal work finished, and who.
--                                    Written ONLY through the readiness door
--                                    (`conditions-center/submittal.js`), which
--                                    refuses while anything is outstanding —
--                                    the button is not a claim, it is a check.
--   submittal_clickup_pushed_at      when the card's "Prior to submittal
--                                    conditions" dropdown was set to Completed
--                                    (or found already set). NULL with a stamp
--                                    above = still owed to ClickUp: the sync
--                                    worker retries it on every tick, so a card
--                                    linked AFTER the click still gets it.
--   submittal_clickup_error          the last reason the push did not land, in
--                                    words a person can act on. Cleared when it
--                                    lands.
--
-- `_by` is a `staff_users` id without a foreign key, like `clickup_review_queue.
-- resolved_by` (db/625): the roster is the shared identity zone Long-Term only
-- READS, and a stamp must outlive a deactivated account.
--
-- BACKFILL: none, deliberately. NULL means "not declared complete", which is
-- true of every file today; no file is completed by a migration.
--
-- PRODUCT SEPARATION. Four columns on `lt_loans` — a Long-Term table — read and
-- written only by Long-Term code. Nothing RTL is touched.
-- ============================================================================

ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS submittal_completed_at timestamptz;
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS submittal_completed_by uuid;
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS submittal_clickup_pushed_at timestamptz;
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS submittal_clickup_error text;

COMMENT ON COLUMN lt_loans.submittal_completed_at IS
  'When the loan officer declared the prior-to-submittal conditions complete (conditions-center/submittal.js refuses while anything is outstanding). NULL = not declared.';
COMMENT ON COLUMN lt_loans.submittal_completed_by IS
  'staff_users id of the officer who declared it — no FK on purpose (identity is read-only to Long-Term; the stamp outlives the account).';
COMMENT ON COLUMN lt_loans.submittal_clickup_pushed_at IS
  'When the linked ClickUp card''s "Prior to submittal conditions" dropdown was set to Completed. NULL with a completed_at = still owed; the sync worker retries.';
COMMENT ON COLUMN lt_loans.submittal_clickup_error IS
  'Why the last ClickUp push of the completion did not land, in plain words. Cleared when it lands.';

-- The worker's retry asks "completed but not yet told to ClickUp" every tick.
CREATE INDEX IF NOT EXISTS lt_loans_submittal_owed_idx
  ON lt_loans (submittal_completed_at)
  WHERE submittal_completed_at IS NOT NULL AND submittal_clickup_pushed_at IS NULL;


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
