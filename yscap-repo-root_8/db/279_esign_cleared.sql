-- "Clear a DocuSign package" bookkeeping (owner-directed 2026-07-22).
--
-- Clearing a package voids it (status='voided') AND does more — it supersedes the
-- signed document and reopens the package's conditions so a fresh one can be sent.
-- These columns distinguish a deliberate CLEAR from an ordinary void, for the
-- history + the UI ("Cleared" vs "Voided"), and record who/why.
--
-- Additive + idempotent.
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS cleared_at   timestamptz;
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS cleared_by   uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS clear_reason text;
