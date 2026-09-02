-- ============================================================================
-- db/668 — file order events allow message_sent kind
--
-- WHAT THIS CHANGES, AND WHY. A staffer's typed reply on a title / insurance
-- order thread (the Email Center reply box) used to be recorded as a CHASE —
-- `followed_up`, with followup_count bumped — because the reply door built the
-- email through the follow-up template (owner-reported 2026-09-01: "even if they
-- manually reply, it fills out like it's a follow-up email"). The reply is now the
-- person's own words and is no longer a follow-up, so the order's history needs a
-- kind for "somebody wrote to the vendor" that is NOT a chase: `message_sent`.
-- db/457 fixed the vocabulary with an inline CHECK; this widens it by one value.
--
-- IDEMPOTENT: drop-then-add, replayed on every boot. The constraint name is the one
-- Postgres gave the inline CHECK in db/457 (<table>_<column>_check). EVERY value the
-- earlier file named is re-asserted here, so the two files agree whichever runs last.
--
-- BACKFILL: none. Replies recorded before this change stand as `followed_up` — the
-- history says what the system believed at the time; rewriting it would hide that.
--
-- PRODUCT SEPARATION: RTL only (file_order_events is an RTL table).
-- ============================================================================

ALTER TABLE file_order_events DROP CONSTRAINT IF EXISTS file_order_events_kind_check;
ALTER TABLE file_order_events ADD CONSTRAINT file_order_events_kind_check CHECK (kind IN (
  'placed', 'resent', 'followed_up', 'replied', 'documents_in',
  'assigned', 'due_changed', 'note', 'completed', 'cancelled', 'reopened',
  'message_sent'));
