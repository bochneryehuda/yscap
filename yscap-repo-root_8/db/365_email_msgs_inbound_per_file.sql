-- ONE INBOUND MESSAGE CAN BELONG TO TWO FILES — the Email Center must be able to
-- record it on both (2026-07-28, closing-chain audit).
--
-- `uq_email_msgs_inbound` made an inbound message unique GLOBALLY by inbound_id, on
-- the reasonable assumption that a message belongs to exactly one loan file. The
-- closing chain broke that assumption: the `closing+<token>@` address is designed to
-- be broadcast to title, the settlement agent, the realtor and outside counsel, and a
-- reply-all can legitimately carry TWO of our closing addresses. `file-inbox` already
-- notices that and records chain activity on BOTH files — but the Email Center row
-- could only be written for the first, so the second file's team saw its closing
-- counter tick up with no message to read. A phantom bump is worse than nothing: it
-- says something arrived and gives no way to see what.
--
-- The true identity of an Email Center row is "this inbound message, AS RECORDED ON
-- THIS FILE", so that is what the index now says.
--
-- COALESCE, not a bare column: in a unique index two NULLs are DISTINCT, so a bare
-- application_id would let an unmatched message (no file) insert a fresh row on every
-- webhook redelivery — turning a one-row-per-message guarantee into no guarantee at
-- all for exactly the messages nobody is watching.
--
-- Widening cannot collide with existing data: the old index made inbound_id unique
-- on its own, so every existing row is already unique under the wider key.

ALTER TABLE email_messages DROP CONSTRAINT IF EXISTS uq_email_msgs_inbound;
DROP INDEX IF EXISTS uq_email_msgs_inbound;

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_msgs_inbound_app
  ON email_messages (inbound_id, COALESCE(application_id::text, ''))
  WHERE inbound_id IS NOT NULL;
