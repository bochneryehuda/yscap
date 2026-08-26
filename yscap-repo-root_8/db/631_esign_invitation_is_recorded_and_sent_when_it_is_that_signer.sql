-- 631 — THE BORROWER NEVER RECEIVED THE SIGNING INVITATION (owner-reported 2026-08-25:
--       "borrowers are not getting email notification to sign term sheet … this is the
--        final term sheet that I'm talking about. He needs to sign it").
--
-- WHAT HAPPENED. Two changes that are each correct met in the wrong place:
--
--   · orchestrate.js:924 inserts EVERY recipient with status 'created'. It always has.
--   · The 2026-08-21 DocuSign restructure added a turn guard to notify-signers.js —
--     "only email once it is actually their turn" — which skips any recipient whose
--     status is not sent/delivered. Correct for the admin counter-signer on routing
--     order 2, who cannot sign until everyone before them has.
--
-- But notifyReadyToSign runs IMMEDIATELY after the send (orchestrate.js:1309), and
-- nothing writes recipient status at send time: applyRecipients is called from exactly
-- one place, the webhook. So at that moment EVERY recipient — the borrower on routing
-- order 1 included — is still 'created', and every one of them is skipped.
--
-- The webhook's recovery (webhook.js:159) re-invites only `!borrower_id AND role IN
-- ('loan_officer','admin')`. A BORROWER is excluded, so nothing ever recovers them.
--
-- And the same 2026-08-21 change removed `embeddedRecipientStartURL: 'SIGN_AT_DOCUSIGN'`,
-- which is what had been making DocuSign send its own (broken-for-a-captive-recipient)
-- email. Correct on its own — but it means PILOT's email is now the ONLY invitation
-- there is. Borrower gets nothing at all.
--
-- REPRODUCED against a real Postgres before anything was changed, through the real
-- notifyReadyToSign with the mailer stubbed:
--   recipient at 'created' (what the send path writes) -> {sent:0, skipped:1}, NO email
--   the same row at 'sent'                             -> {sent:1}, email goes out
--
-- WHY A COLUMN. The turn can be decided from routing order alone, but "did we invite
-- this person, and when" cannot — and that is the question the owner actually asked
-- ("audit all the logs from the last few final terms"). There was no record anywhere:
-- the borrower's signing email is the one catalog.send call that passes no
-- applicationId, so it is not in the Email Center either. invited_at is that record,
-- and it doubles as the send-once guard that makes it safe to let BOTH the send path
-- and the webhook invite (either may legitimately be first).
--
-- DELIBERATELY NOT storing the email body: that message carries a magic link which
-- signs the holder in AS THE BORROWER and drops them into the ceremony. A timestamp
-- answers the audit question without putting a bearer credential in a staff-readable
-- log. Do NOT "improve" this by passing applicationId on the esignReadyToSign send.
--
-- Additive + idempotent. NO BACKFILL OF THE COLUMN: a NULL invited_at reads as "never
-- invited", which is the truth for every envelope sent before this, and stamping a value
-- would claim we had told people we had not.
--
-- The packages ALREADY OUT are recovered in JavaScript instead, by
-- src/lib/esign/invite-recovery.js at boot — because "who is still owed an invitation"
-- means whose TURN it is, and re-stating that rule in SQL is how the sweep and the send
-- path would come to disagree about it. It re-drives notifyReadyToSign, which owns every
-- rule, and is scoped to envelopes created inside the window the defect was live in.

ALTER TABLE esign_recipients ADD COLUMN IF NOT EXISTS invited_at timestamptz;

-- What we last said to them, for the audit trail on a re-nudge (a corrected email
-- address re-invites exactly one recipient).
ALTER TABLE esign_recipients ADD COLUMN IF NOT EXISTS invite_count integer NOT NULL DEFAULT 0;

-- The open question every time this is investigated is "who is still waiting on us",
-- so index the rows that have NOT been invited on a live envelope.
CREATE INDEX IF NOT EXISTS esign_recipients_uninvited_idx
  ON esign_recipients (envelope_row_id)
  WHERE invited_at IS NULL AND signed_at IS NULL AND declined_at IS NULL;
