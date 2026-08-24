-- ============================================================================
-- db/626 — LT: a ClickUp status is pushed when a MILESTONE FIRES, never reconciled
--
-- WHAT THIS CHANGES, AND WHY (owner-directed 2026-08-24, correcting #39).
--
-- #39 shipped the rule "Encompass always wins, even after manual changes", and
-- push.js implemented it literally: the card's status was RE-ASSERTED on every
-- full push. `pushPass` selects any linked loan whose mirror moved
-- (`encompass_synced_at > clickup_pushed_at`) or that has never been pushed, and
-- the sync re-reads loans on a rotation — so over time EVERY card's status was
-- dragged back to whatever the ladder implied, and switching the writer on for
-- the first time would force the whole never-pushed book in one sweep.
--
-- The owner's correction, in their words: *"Only when Encompass is changing a
-- milestone should ClickUp be changing milestones, not go back to all the
-- ClickUp tasks and update everything according to how Encompass is."* ClickUp
-- is allowed to be AHEAD — a team that sets CTC before Encompass gets there is
-- not a drift to repair, and Encompass must not push it back. A disagreement is
-- SURFACED for a person (lt_clickup_review_queue, field_key '__status'), never
-- corrected.
--
-- So a status write now needs a NEW milestone event to justify it, and this
-- column is the watermark that says which events have already been answered.
-- `lt_milestone_events` already draws the distinction this needs:
-- 'observed_entered' is a real move, 'observed_baseline' is a first sighting and
-- must never push anything.
--
-- BACKFILL — DELIBERATE, AND IT IS THE POINT OF THE FILE. Every already-linked
-- loan is baselined to now(), so its HISTORICAL milestone events can never fire
-- a push. Without this the first pass after the fix would read the whole book's
-- back history as "new" and reproduce exactly the sweep being removed. This is
-- the `applications.status_notified_external` watermark pattern (2026-07-20):
-- silently baseline what is already there, announce only what happens next.
-- NULL therefore means "never baselined" and the code baselines it on sight,
-- which covers a loan linked after this file runs.
--
-- Nothing about FIELD pushes changes. Nothing is deleted. No existing column,
-- constraint or index is altered.
--
-- IDEMPOTENT: an ADD COLUMN IF NOT EXISTS plus one UPDATE guarded on the column
-- still being NULL for an already-linked loan, so the second and every later
-- boot match zero rows.
--
-- PRODUCT SEPARATION: `lt_*` only. Touches no RTL table.
-- ============================================================================

-- ── 1. The watermark ────────────────────────────────────────────────────────
-- The observed_at of the newest milestone event whose status has already been
-- ANSWERED — by pushing it, or by raising it for a person when pushing it would
-- have moved the card backwards. Both consume the event: it has been handled.
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS clickup_status_event_at timestamptz;

COMMENT ON COLUMN lt_loans.clickup_status_event_at IS
  'Watermark for the ClickUp status push (db/626). The observed_at of the newest lt_milestone_events row already answered. A status is pushed ONLY for an observed_entered event newer than this — never to reconcile a card that merely disagrees. NULL = never baselined; the writer baselines it and pushes nothing.';

-- ── 2. Baseline the book that is already linked ─────────────────────────────
-- now(), not the newest event's observed_at: the watermark's job is "nothing
-- before this moment may fire", and now() states that without depending on
-- whether this loan happens to have any event rows yet.
UPDATE lt_loans
   SET clickup_status_event_at = now()
 WHERE clickup_status_event_at IS NULL
   AND clickup_task_id IS NOT NULL;

-- ── 3. The drain's index ────────────────────────────────────────────────────
-- The writer asks "is there an observed_entered event for this loan newer than
-- its watermark?" per loan it is about to push.
CREATE INDEX IF NOT EXISTS lt_milestone_events_loan_entered_idx
  ON lt_milestone_events (loan_id, observed_at DESC)
  WHERE event_type = 'observed_entered';


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
