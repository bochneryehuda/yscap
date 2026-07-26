-- 181 — Track completion-FINALIZATION failures so a signed-but-unfinalized
-- envelope becomes VISIBLE instead of stalling silently.
--
-- The webhook stores the signed PDFs BEFORE stamping an envelope 'completed', so a
-- transient download/store failure correctly keeps the envelope out of 'completed'
-- and the inbox/poller re-drive it to self-heal. But a PERSISTENT failure (a signed
-- doc DocuSign returns 404/403, or storage hard-fails) would re-throw forever: the
-- borrower has signed, yet the deal sits 'sent'/'delivered' with no signed copies,
-- no cleared condition, and NOBODY alerted. These columns let reconcile count the
-- finalization attempts and, once it's clearly not self-healing, alert the file's
-- team exactly once (completion_alerted_at guard). Idempotent.
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS completion_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS completion_alerted_at timestamptz;
