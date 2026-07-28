-- DID THIS MESSAGE REALLY COME FROM WHO IT SAYS? (2026-07-28, closing-chain audit.)
--
-- The inbound webhook verifies RESEND's Svix signature — proof the DELIVERY is
-- genuinely from our provider — and nothing anywhere verified the SENDER. On the
-- `file+` and `chat+` families that is a modest risk. On `closing+<token>@` it is
-- not: that address exists to be BROADCAST to title, the settlement agent, the
-- realtor and outside counsel, so its value circulates well outside our control, and
-- anything arriving on it is filed straight into the loan file as closing
-- correspondence. A spoofed From carrying a wiring-instructions PDF would sit there
-- looking exactly like the real thing.
--
-- So we record the verdict the receiving MTA already computed (Authentication-Results
-- / Received-SPF), as {spf, dkim, dmarc, verdict} with verdict pass|fail|unknown.
--
-- DELIBERATELY NOT A GATE. Legitimate mail forwarded through a mailing list, an
-- assistant's rule or a firm's own relay fails SPF every day, so refusing on `fail`
-- would lose real closing documents — the expensive direction. It is surfaced to the
-- person about to open the attachment instead.
--
-- NULL means the row predates this column or the provider exposed no headers. That is
-- the same thing as 'unknown' and must never be displayed as a pass.

ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS sender_auth jsonb;

-- Finding the unauthenticated inbound mail is the only query this column serves, so
-- the index carries exactly that predicate.
CREATE INDEX IF NOT EXISTS idx_email_msgs_sender_auth_fail
  ON email_messages (application_id, occurred_at DESC)
  WHERE direction = 'inbound' AND sender_auth->>'verdict' = 'fail';
