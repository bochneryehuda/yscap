-- 304 — Persist a note-buyer condition's DISPOSITION signals (ISG-W17 / #281; owner-directed
--       2026-07-24). Root fix for a latent round-trip gap.
--
-- The disposition classifier (desk.js dispositionOf) and the desk's disposition-aware routing
-- (concern / file_data / appraisal branches) read three per-condition fields off the loaded row:
--   • disposition   — an EXPLICIT disposition that overrides the conservative inference
--   • concern_field — the signal name a 'concern'/'appraisal' condition surfaces on
--                     (e.g. non_arms_length_concern, appraisal_rural, appraisal_transferred)
--   • data_field    — the signal name a 'file_data' condition reads (e.g. borrower_email)
--
-- These lived ONLY in the checked-in spec modules (corrfirst-fnf-spec.js / bluelake-rtl-spec.js);
-- they were NEVER persisted, and the desk loads its conditions from the DB (`SELECT nbc.*`). So
-- `c.concern_field` / `c.data_field` / `c.disposition` were always undefined at runtime:
--   - the non-arms-length CONCERN (cond 3333) could never surface (its concern signal was unread),
--   - the appraisal-transfer condition (cond 3349) fell through to a DOCUMENT gap and PILOT wrongly
--     requested a transfer letter even when it cannot see the appraisal,
--   - the borrower-email FILE_DATA check read a null data_field.
-- The pure tests set these directly on in-memory fixtures, so the round-trip gap went uncaught.
--
-- Fix: make them real columns so `SELECT nbc.*` carries them through; the boot re-seed
-- (ON CONFLICT DO UPDATE) backfills every existing row — previous AND future files. Idempotent,
-- additive, advisory-only (touches no frozen number).

ALTER TABLE note_buyer_conditions ADD COLUMN IF NOT EXISTS disposition   text;
ALTER TABLE note_buyer_conditions ADD COLUMN IF NOT EXISTS concern_field text;
ALTER TABLE note_buyer_conditions ADD COLUMN IF NOT EXISTS data_field    text;
