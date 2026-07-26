-- 224_sitewire_draws_first_seen.sql — Distinguish LEGACY sitewire_draws rows (created before the
-- status_synced watermark was introduced) from rows PILOT saw for the first time AFTER the
-- watermark was live. Fixes the null-status baseline loop (audit finding 2026-07-21):
--
--   Before: reactToInboundDraw's legacy branch triggered on `prev.status_synced IS NULL`, but a
--   first-seen draw with `status=null` also had status_synced set to null by the atomic claim.
--   Every subsequent poll then took the legacy branch and silently baselined the FIRST real
--   status transition ('pending' / 'approved') — so the "ready for your review" notification for
--   a new draw was never sent, because it was mis-classified as a pre-migration legacy row.
--
-- `first_seen_at` is a durable marker that PILOT knew about this draw AT the time it was seen.
-- Any row with `first_seen_at IS NULL` is genuinely legacy (pre-migration). Any row with
-- `first_seen_at` set — even if `status_synced` is NULL because Sitewire returned a null status
-- on first sight — is a row PILOT is actively watching, so a later status transition is real and
-- notifiable. Defaults to `now()` so future INSERTs are auto-stamped without a code change.
--
-- Idempotent (safe to re-run every boot).

ALTER TABLE sitewire_draws ADD COLUMN IF NOT EXISTS first_seen_at timestamptz DEFAULT now();

-- Do NOT backfill first_seen_at on existing rows: leaving it NULL is exactly how the code below
-- identifies them as legacy pre-watermark rows (silent baseline on their first real transition).
