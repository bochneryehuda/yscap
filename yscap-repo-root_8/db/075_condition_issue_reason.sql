-- ============================================================================
-- 075 - Condition-level issue/push-back reason + raised-issue conditions
--       (owner-directed 2026-07-12 — LOS-grade condition management)
--
-- Two additions to checklist_items (the live condition model):
--
-- 1. `issue_reason` — a BORROWER-VISIBLE reason attached to a condition when a
--    staffer rejects / pushes it back / reopens it, OR when a staffer raises an
--    issue/request against a track-record line item or a vesting LLC. Until now a
--    condition flipped to `issue` (or reopened) carried no explanation the
--    borrower could see — the only borrower-facing reason came from a rejected
--    DOCUMENT (documents.rejection_reason). `notes` is internal-only and must
--    never reach the borrower, so a dedicated borrower-safe field is required.
--
-- 2. `raised_entity` (jsonb) — bookkeeping for a condition CREATED by "raise an
--    issue against this entity": {kind:'track_record'|'llc', id, name}. Lets the
--    staff UI group/trace a raised condition back to the line item / LLC it came
--    from without a hard FK (the row is application-scoped via application_id;
--    chk_one_owner forbids a second owner column). The idempotency marker lives
--    in field_key ('issue:tr:<id>' / 'issue:llc:<id>').
--
-- Purely additive, nullable columns. No status-enum change (the raised condition
-- uses the existing 'outstanding'/'received'/'satisfied'/'issue' values).
-- ============================================================================

ALTER TABLE checklist_items
  ADD COLUMN IF NOT EXISTS issue_reason  text,
  ADD COLUMN IF NOT EXISTS raised_entity jsonb;
