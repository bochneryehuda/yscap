-- ============================================================================
-- 395 — Clear the stuck Xactus-flood TEST MODE override (owner-directed 2026-08-02).
--
-- The "Order flood certificate" button kept returning "Dry run — the order was
-- built and logged but nothing was sent to Xactus" even after the code default was
-- set to LIVE. Root cause: the API-Health "TEST MODE" toggle wrote a runtime
-- override row into integration_flags (key='XACTUS_FLOOD_DRYRUN'), and that stored
-- row WINS over the env/code default on every boot — so test mode was pinned ON and
-- could not be turned off.
--
-- The code no longer reads that runtime flag at all (src/xactus/flood.js dryrun() is
-- hard-false — test mode was removed) and the toggle was removed from the API-Health
-- page. This migration deletes the now-orphaned override row so no stale row lingers.
--
-- Idempotent (deleting a non-existent row is a no-op; safe to re-run every boot).
-- ============================================================================

DELETE FROM integration_flags WHERE key = 'XACTUS_FLOOD_DRYRUN';
