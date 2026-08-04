-- ============================================================================
-- 465 — Manual conditions can be DELETED, with a request/approval hand-off
--       (owner-directed 2026-08-04): "conditions that were manually added … if he
--       was the one manually adding the condition, then he should be able to
--       manually delete the condition. If somebody else manually added it, then he
--       can request from that person to delete, and that person should get a prompt
--       to delete it."
--
-- Only MANUALLY-added conditions (origin_kind in manual_custom / manual_library /
-- exception) are ever deletable — auto/rules/system conditions are owned by the
-- engine and must never be hand-deleted. Enforced in the DELETE route.
--
-- These columns record a pending deletion REQUEST from someone who is NOT the
-- creator, so the creator sees a prompt on the condition and can delete it (or the
-- requester can withdraw). Idempotent.
-- ============================================================================

ALTER TABLE checklist_items
  ADD COLUMN IF NOT EXISTS delete_requested_by uuid,
  ADD COLUMN IF NOT EXISTS delete_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS delete_request_reason text;
