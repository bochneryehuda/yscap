-- 550_email_attachment_audit.sql — EVERY EMAIL RECORDS WHAT IT COULD NOT CARRY
-- (owner-directed 2026-08-14, after an investor delivery went out with the inspection
-- report silently missing: "everything should be left locked, so we should always be
-- able to audit the audit log. Every single thing here should leave logs in the future.").
--
-- THE GAP. `email_messages.attachments` (db/185) has always recorded what an email
-- DID carry. Nothing anywhere recorded what it did NOT. The draw investor delivery
-- stored its own `skipped` list on `draw_investor_deliveries`, one surface out of
-- many, read by one card — and every OTHER email in the system (borrower findings
-- delivery, the attorney closing-prep package, the order desk, the term sheet) threw
-- the reason away entirely, inside a swallowing catch. So when a capital partner got
-- a draw email with two of the four documents on it, there was no answer anywhere in
-- the logs to "which two, and why" — the Render log is silent and expires, and the
-- one durable copy did not exist.
--
-- THE SHAPE. Both columns sit on `email_messages` deliberately, NOT on a new table:
-- that row is written at the ONE provider chokepoint every send in this codebase
-- flows through (src/lib/email/index.js sendMail), so recording it here covers every
-- email that exists today and every one added later, with no per-caller wiring to
-- forget. A caller that knows nothing about attachments writes NULL and is unchanged.
--
--   omitted        — [{what, filename, reason, code, bytes, remedy}] : the documents
--                    that SHOULD have ridden along and did not, each with a machine
--                    -readable `code` (too_large / unreadable / not_on_file /
--                    not_accepted / build_failed / …) so this is queryable, not prose.
--   attach_summary — {attached_n, omitted_n, bytes, budget, compressed_n, saved_bytes,
--                     links_n, consent:{by,at,note}} : the one-line story of the send,
--                    including WHO knowingly approved sending it short.
--
-- Idempotent.

ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS omitted jsonb;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS attach_summary jsonb;

-- The question this exists to answer, asked directly: "show me every email that went
-- out short, newest first". PARTIAL so it stays tiny — the overwhelming majority of
-- emails carry no attachments at all and never enter this index.
CREATE INDEX IF NOT EXISTS idx_email_msgs_omitted
  ON email_messages (occurred_at DESC)
  WHERE omitted IS NOT NULL AND jsonb_array_length(omitted) > 0;

-- Per-file, for the file's own Email Center tab.
CREATE INDEX IF NOT EXISTS idx_email_msgs_omitted_app
  ON email_messages (application_id, occurred_at DESC)
  WHERE application_id IS NOT NULL AND omitted IS NOT NULL AND jsonb_array_length(omitted) > 0;
