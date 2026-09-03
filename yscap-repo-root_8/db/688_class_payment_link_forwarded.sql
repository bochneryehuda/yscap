-- ============================================================================
-- db/688 — Class Valuation: the forwarded payment link, and an upload attempt count
--
-- WHAT THIS CHANGES, AND WHY. Two things the Class Valuation desk learned on
-- 2026-09-03.
--
-- (1) The owner does not accept invoicing: every Class order is paid up front by
--     the borrower through Class's payment link, and the link has to reach the
--     borrower, the loan officer AND the processor. Class emails the link to ONE
--     address and never shows PILOT the link itself, so the order now names the
--     FILE'S OWN MAILBOX (file+<id>@<CHAT_REPLY_DOMAIN>) as the recipient; when
--     Class's email lands there, PILOT forwards it to all three in one message.
--     `payment_link_forwarded_at` / `payment_link_forwarded_to` record that forward
--     (who it went to, when) so the order card can say so and the forward never
--     runs twice for one delivery.
--
-- (2) The pre-merge audit found that a FAILED outbound upload (the scope of work or
--     contract that could not be sent) was read as "already sent" by the next pass,
--     so a document went up exactly once or never. The retry is now bounded by a
--     per-row attempt count: `upload_attempts` counts failures, a success resets it,
--     and after the cap the picker says so instead of pretending it was sent.
--
-- BACKFILL: none. Every existing outbound row has no attempts recorded (0) and no
-- order has ever been forwarded a link, which is the truth.
--
-- PRODUCT SEPARATION: RTL only (class_* tables).
-- ============================================================================

ALTER TABLE class_orders ADD COLUMN IF NOT EXISTS payment_link_forwarded_at timestamptz;
ALTER TABLE class_orders ADD COLUMN IF NOT EXISTS payment_link_forwarded_to jsonb;
ALTER TABLE class_attachments ADD COLUMN IF NOT EXISTS upload_attempts integer NOT NULL DEFAULT 0;
