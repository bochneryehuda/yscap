-- ============================================================================
-- db/580 — investor delivery thread key
--
-- WHAT THIS CHANGES, AND WHY (owner-directed 2026-08-18: "when sending out an
-- email to an investor, it should have a unique reply-to, and then [we] should
-- be able to open up the inbox in the investor delivery to see the investor's
-- response"). The draw investor-delivery email used to carry Reply-To
-- draws@yscapgroup.com — a shared human mailbox PILOT never reads — so the
-- investor's answer existed only as a hand-picked dropdown value. The email
-- now replies to the file's unique file+<id>@ address, and `thread_key` is the
-- join between a delivery row and the email_messages conversation it started
-- (the same subject-derived key email-log.captureOutbound/captureInbound
-- already compute), so the desk's delivery card can show the investor's actual
-- replies.
--
-- BACKFILL: none. A pre-existing delivery's replies went to the shared mailbox
-- and were never captured, so there is no thread to point an old row at —
-- inventing a subject-derived key for them would claim a conversation record
-- that does not exist. Old rows simply show no thread, exactly the truth.
-- ============================================================================

ALTER TABLE draw_investor_deliveries ADD COLUMN IF NOT EXISTS thread_key text;

-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself.
