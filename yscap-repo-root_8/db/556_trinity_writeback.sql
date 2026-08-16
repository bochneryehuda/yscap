-- 556_trinity_writeback.sql
-- Idempotent. The record of what the physical inspector's figures did to the SITEWIRE
-- draw the borrower actually submitted — the second of the Trinity program's two doors.
--
-- Still the GENERAL PHYSICAL PROGRAM only: a physical-inspection draw on a file whose
-- note buyer is NOT Blue Lake. Nothing here touches the Sitewire VIRTUAL pipeline (its
-- autopilot is untouched and stays untouched) or the TrustPoint/Blue Lake pipeline.
--
-- ---------------------------------------------------------------------------
-- WHY THERE ARE TWO DOORS AND WHY ONLY ONE OF THEM USED TO END ANYWHERE
-- ---------------------------------------------------------------------------
-- A physical draw reaches Trinity two ways. A PORTAL draw request carries its own
-- decision record, so `portal-draws.approveTrinityRequest` records the approved amounts
-- and tells the borrower. A draw the borrower submitted IN SITEWIRE has no portal
-- request — the draw lives in Sitewire — so until 2026-08-16 a Trinity order placed
-- against one produced a completed inspection whose figures had nowhere to land and a
-- Deliver button that refused.
--
-- Owner-directed 2026-08-16, choosing between three designs: *"Write Trinity's numbers
-- into the Sitewire draw"* — and, immediately after: *"we still need to follow the
-- workflow of getting borrower approval that he agrees with the findings and he doesn't
-- want to push back. Follow everything like it was in the beginning."* So the write-back
-- fills in `approved_cents` on the draw's own request lines — the SAME field a virtual
-- Sitewire inspector fills — and the borrower's accept/dispute page, the branded report,
-- the wire deadline and the release are byte-for-byte the ones that already exist. The
-- only thing that changed is who did the inspecting.
--
-- IT NEVER APPROVES, RELEASES OR TRANSITIONS THE DRAW. There is no autopilot on the
-- physical route (owner-directed): a human presses Deliver, and a human approves and
-- releases on the draw desk exactly as today.

-- ---------------------------------------------------------------------------
-- 1. THE FINGERPRINT — one write per RESULT, not one per poll
-- ---------------------------------------------------------------------------
-- The poller re-reads a completed order on every tick. Without a durable record of what
-- was already written, each tick would re-PATCH identical figures into Sitewire and
-- journal a write a minute, forever — noise that would bury a real write and burn the
-- volume circuit breaker the guarded Sitewire client relies on.
--
-- The fingerprint is the FIGURES THEMSELVES (job item id : approved cents, sorted), not
-- a timestamp or a boolean, and that is the point: a REVISION — Trinity re-completing an
-- order with corrected numbers — genuinely differs, so it is written again. An inspector
-- correcting a report must reach the borrower; a poller re-reading an unchanged one must
-- not.
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS writeback_fingerprint text;
-- When the figures last landed on the Sitewire draw AND were verified by re-reading it.
-- Deliberately stamped only after the read-after-write check passes: a 200 is not proof,
-- and this is money a coordinator is about to approve. A verification we could not
-- perform leaves BOTH columns untouched so the next poll drives it again, rather than
-- recording a success nobody confirmed.
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS writeback_at          timestamptz;

COMMENT ON COLUMN trinity_inspection_orders.writeback_fingerprint IS
  'Sorted "<sitewire_job_item_id>:<approved_cents>" of the figures last written onto the Sitewire draw. Equal fingerprint = the poller re-read the same result and the write is skipped; a different one = Trinity revised the report and it is written again.';
COMMENT ON COLUMN trinity_inspection_orders.writeback_at IS
  'When Trinity''s figures were written onto the Sitewire draw AND read back verified. NULL with a completed order means the write-back has not landed yet (or could not be verified) — never that it was skipped.';

-- ---------------------------------------------------------------------------
-- 2. THE TIMELINE LEARNS TWO MORE WORDS
-- ---------------------------------------------------------------------------
-- db/555 built the append-only progress timeline because Trinity has no history
-- endpoint. Its `kind` column is documented prose, not a CHECK, so nothing has to be
-- widened — but the two new kinds are recorded here so the vocabulary lives in one
-- place: 'writeback' (the inspector's figures landed on the Sitewire draw) and
-- 'delivered' (a human sent the findings to the borrower), which together are the whole
-- answer to "how did this inspection reach the borrower, and when?".
COMMENT ON COLUMN trinity_order_events.kind IS
  'What moved: ''status'' (Trinity''s own status changed), ''ordered'', ''scheduled'', ''report'', ''cancelled'', ''writeback'' (the inspector''s figures were written onto the Sitewire draw), ''delivered'' (a human sent the findings to the borrower), ''note'' (ours).';

-- DELIBERATELY ABSENT: any column recording an automatic delivery. There is none, and
-- adding one would invite the autopilot the owner ruled out for the physical route.
