-- Public (token) dispute + durable media serving for the draw-findings email flow
-- (Draw Management, owner-directed 2026-07-20). The findings-delivery email now carries the
-- full per-line detail, durable inspection photos, the branded report, and BOTH an Accept and a
-- push-back (dispute) action — all reachable from the email with no portal login, via the
-- per-finding reply_token capability.
--
-- `disputed_via` mirrors the existing `accepted_via` so the audit trail records whether the
-- borrower pushed back from the email link ('email') or from inside the portal ('portal').
-- Idempotent.
ALTER TABLE draw_findings ADD COLUMN IF NOT EXISTS disputed_via text;

-- The public accept page + branded report + per-line photo gallery all join the durable
-- inspection media to the draw line it belongs to (sitewire_request_id). Index that lookup so
-- the borrower-safe gallery does not table-scan draw_media.
CREATE INDEX IF NOT EXISTS idx_draw_media_request ON draw_media (sitewire_request_id);
