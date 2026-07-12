-- ============================================================================
-- 080_clickup_inbox_processing_started.sql
--
-- Claim-time stamp for the ClickUp webhook inbox. The stale-'processing' reclaim
-- in src/sync/clickup-sync.js (processInboxOnce) must measure a row's age from
-- when it was CLAIMED, not from when it was received. Keyed on received_at, the
-- reclaim could re-grab a row that is still being ingested during a >15-minute
-- backlog/burst, causing a CONCURRENT double-ingest of the same task — and
-- because upsertLlc / upsertTrackRecord are check-then-insert with no unique
-- constraint, that produces duplicate LLC / track-record rows. The claim now
-- stamps processing_started_at=now(), and the reclaim compares against it (with a
-- received_at fallback for any row already stuck in 'processing' before this
-- column existed). Additive + idempotent: safe to re-run on every boot.
-- ============================================================================

ALTER TABLE clickup_webhook_inbox ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;
