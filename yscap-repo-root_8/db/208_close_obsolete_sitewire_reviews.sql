-- ============================================================================
-- 208 — Auto-close the OBSOLETE Sitewire push reviews + re-drive the affected
--       files (owner-reported 2026-07-20, Moshe Spitzer / 109 Chapel St).
--
-- Three push errors were stuck in the sync review queue. ALL THREE root causes are
-- already fixed IN CODE (so new files never hit them); this migration clears the
-- rows already sitting in the queue and re-queues a fresh push so the fixed code
-- re-drives each file. Idempotent: on re-run the UPDATEs match nothing (already
-- resolved) and the re-drive window (resolved in the last minute) is empty, so it
-- is a one-time backfill. Mirrors db/160 / db/164 / db/195.
--
--  · Error 2 — "could not assign borrower … (Sitewire 304)": a Sitewire 304 is
--    "Not Modified" = the borrower is ALREADY assigned = success, not a failure.
--    The client now treats 304 as a no-op (src/sitewire/client.js). Close the row.
--  · Error 3 — "sitewire_type_unmapped … construction_type … 'Purchase/'": the
--    construction type is now always resolved to a sane default (rehab/remodel) at
--    push and the construction-type advisory is no longer emitted at all
--    (src/sitewire/transforms.js + orchestrator.js). The still-valid DEVELOPMENT
--    (property) type advisory is NOT matched here and stays open.
--  · Error 1 — "line name '…Photos' appears twice — cannot bind id": a $0 MEDIA
--    anchor (a photo requirement, not money) duplicated on the live budget now
--    BINDS to one un-drawn copy instead of parking (src/sitewire/mapper.js
--    resolveCreatesAgainstLive). Closing the row + re-driving self-heals; a genuine
--    MONEY-line or all-drawn collision legitimately re-parks on the re-drive.
-- ============================================================================

-- Error 2 — Sitewire 304 borrower-assign (already assigned; a success no-op).
UPDATE sync_review_queue
   SET status = 'resolved', auto_resolved = true, resolved_at = now(),
       resolution_note = 'Auto-closed — the borrower was already added to the Sitewire property (a "no change needed" reply, not a failure). Fixed at the source so it will not recur.'
 WHERE status = 'open' AND field_key = 'sitewire'
   AND split_part(reason, ':', 1) = 'sitewire_borrower_assign_failed'
   AND reason LIKE '%Sitewire 304%';

-- Error 3 — obsolete construction_type advisory (now always defaulted in code).
UPDATE sync_review_queue
   SET status = 'resolved', auto_resolved = true, resolved_at = now(),
       resolution_note = 'Auto-closed — the construction type is now always set automatically (defaults to rehab/remodel). Fixed at the source.'
 WHERE status = 'open' AND field_key = 'sitewire'
   AND split_part(reason, ':', 1) = 'sitewire_type_unmapped'
   AND reason LIKE '%construction_type%';

-- Error 1 — duplicate $0 media anchor (now binds to one copy on re-drive). Scoped to MANAGED files
-- (a live PILOT-created property) for symmetry with the re-drive below — a non-managed file routes
-- errors to setup_status, not the queue, so it should have no such row anyway.
UPDATE sync_review_queue q
   SET status = 'resolved', auto_resolved = true, resolved_at = now(),
       resolution_note = 'Auto-closed — the duplicate photo-requirement line now binds to one copy automatically. Re-pushing the file resolves it; a genuine budget-line duplicate would re-flag.'
 WHERE q.status = 'open' AND q.field_key = 'sitewire'
   AND split_part(q.reason, ':', 1) = 'sitewire_bind_ambiguous'
   AND EXISTS (SELECT 1 FROM sitewire_property_links pl
                WHERE pl.application_id = q.application_id AND pl.matched_by = 'created'
                  AND pl.sitewire_property_id IS NOT NULL);

-- Re-drive every file whose obsolete rows we just closed, so the FIXED push binds /
-- verifies (and any genuine remaining ambiguity re-parks). Only files with a live,
-- PILOT-created ("only-ours") Sitewire property are re-driven; skip any that already
-- have a queued push. `run_after=now()` so the worker picks it up on the next drain.
INSERT INTO sync_queue (entity_type, entity_id, target, direction, op, status, payload, run_after)
SELECT DISTINCT 'application', q.application_id, 'sitewire', 'push', 'push_file', 'queued', '{}'::jsonb, now()
  FROM sync_review_queue q
  JOIN sitewire_property_links pl
    ON pl.application_id = q.application_id AND pl.matched_by = 'created' AND pl.sitewire_property_id IS NOT NULL
 WHERE q.field_key = 'sitewire' AND q.status = 'resolved' AND q.auto_resolved = true
   AND q.resolved_at > now() - interval '1 minute'
   AND NOT EXISTS (
     SELECT 1 FROM sync_queue s
      WHERE s.entity_type = 'application' AND s.entity_id = q.application_id
        AND s.target = 'sitewire' AND s.direction = 'push' AND s.op = 'push_file' AND s.status = 'queued');
