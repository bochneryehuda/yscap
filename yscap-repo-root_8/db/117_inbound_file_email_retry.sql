-- 117_inbound_file_email_retry.sql — #68 audit round 2: retry-safe inbound processing.
--
-- The round-2 audit fleet confirmed the original claim-first idempotency design
-- silently and PERMANENTLY dropped a reply on any transient failure (Resend
-- retrieval blip, SMTP failure, crash mid-forward): the claim row blocked every
-- redelivery and the route's unconditional 200 told Resend never to retry.
--
-- New model (lib/file-inbox.js):
--   - Terminal outcomes (forwarded / unknown_app / archived_app / no_recipients /
--     auto_reply / rate_limited / chat_posted) stay claimed forever — a webhook
--     redelivery is a no-op, exactly as before.
--   - RETRYABLE failures (retrieval_failed / forward_failed / lookup_failed /
--     legacy 'error') and claims stuck at 'received' (crash mid-processing) can be
--     RECLAIMED by a redelivery, up to attempt_count 8; the route answers 503 for
--     them so Resend's bounded retry schedule redelivers.
--   - app_results tracks per-application forward completion, so an email addressed
--     to several file+ addresses never double-forwards to a team that already got
--     it when a later attempt retries the rest.
--
-- Idempotent; safe to re-run on every boot.

ALTER TABLE inbound_file_emails ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;
ALTER TABLE inbound_file_emails ADD COLUMN IF NOT EXISTS last_error    text;
ALTER TABLE inbound_file_emails ADD COLUMN IF NOT EXISTS app_results   jsonb;
ALTER TABLE inbound_file_emails ADD COLUMN IF NOT EXISTS processed_at  timestamptz;
-- claimed_at is reset by EVERY claim/reclaim (created_at is the original insert
-- time and never moves) — the stuck-claim window keys off claimed_at so two
-- concurrent redeliveries of an old row can never both win the reclaim.
ALTER TABLE inbound_file_emails ADD COLUMN IF NOT EXISTS claimed_at    timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_inbound_file_emails_status
  ON inbound_file_emails (status, received_at DESC);
