-- 298_portal_draws_trinity.sql
-- Idempotent. Physical-draw workflow phase 4 (blueprint §2 Path B/C, §5B):
-- the PILOT-portal draw composer + the Trinity inspection-order desk.
--
-- A PORTAL draw request is the file's canonical draw for a cycle that started on OUR
-- website (staff line-item composer, or the borrower's). It cannot exist in Sitewire
-- as a live draw (no create API) — on a TrustPoint file it is hand-entered there (the
-- coordinator task), and once FULLY APPROVED it is closed out into Sitewire as a
-- HISTORICAL draw (owner-confirmed rule: historical draws ONLY for portal-originated
-- draws, ONLY after approval). On a non-Blue-Lake physical file the inspection is
-- ordered from Trinity (manual task now; the order record is API-adapter-ready — D8).

CREATE TABLE IF NOT EXISTS portal_draw_requests (
  id                    bigserial PRIMARY KEY,
  application_id        uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  source                text NOT NULL CHECK (source IN ('staff','borrower')),
  status                text NOT NULL DEFAULT 'submitted'
                         CHECK (status IN ('submitted','entered','approved','closed_out','cancelled')),
  platform              text NOT NULL CHECK (platform IN ('trustpoint','trinity')),
  lines                 jsonb NOT NULL,     -- [{sitewire_job_item_id, sow_line_key, name, requested_cents}]
  total_requested_cents bigint NOT NULL CHECK (total_requested_cents > 0),
  note                  text,
  created_by_staff      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_by_borrower   uuid REFERENCES borrowers(id) ON DELETE SET NULL,
  tp_draw_id            text,               -- the TrustPoint draw this became (mirror tie)
  sitewire_draw_id      bigint,             -- the historical close-out draw in Sitewire
  approved_cents        bigint,
  cancelled_reason      text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
-- one OPEN portal request per file (submitted/entered/approved); closed/cancelled free the slot
CREATE UNIQUE INDEX IF NOT EXISTS uq_pdr_open ON portal_draw_requests (application_id)
  WHERE status IN ('submitted','entered','approved');
CREATE INDEX IF NOT EXISTS idx_pdr_app ON portal_draw_requests (application_id, created_at DESC);

-- Trinity inspection orders (Path C — general physical program). Status lifecycle is
-- built so the future Trinity ordering API replaces ONLY the requested→ordered step.
CREATE TABLE IF NOT EXISTS trinity_inspection_orders (
  id                    bigserial PRIMARY KEY,
  application_id        uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  portal_draw_request_id bigint REFERENCES portal_draw_requests(id) ON DELETE SET NULL,
  sitewire_draw_id      bigint,             -- when the draw came in through Sitewire instead
  status                text NOT NULL DEFAULT 'requested'
                         CHECK (status IN ('requested','ordered','report_received','entered','cancelled')),
  ordered_at            timestamptz,
  ordered_by            uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  report_document_id    uuid,
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tio_app ON trinity_inspection_orders (application_id, created_at DESC);

-- Widen the Workflow submission-type allow-list with the Trinity order hand-off
-- (same replace pattern as db/295 — the stably-named constraint is re-created once).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_workflow_submission_type')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_workflow_submission_type'
          AND pg_get_constraintdef(oid) LIKE '%trinity_inspection_order%') THEN
    ALTER TABLE workflow_items DROP CONSTRAINT chk_workflow_submission_type;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_workflow_submission_type') THEN
    ALTER TABLE workflow_items ADD CONSTRAINT chk_workflow_submission_type CHECK (submission_type IN (
      'loan_setup','processing','condition_clearing','clear_to_close',
      'closing','draw_setup','post_closing','exception','escalation',
      'trustpoint_import','trinity_inspection_order'));
  END IF;
END $$;

-- ---- phase-2 audit hardening additions ----
-- baselined_at: NULL = the linked project's silent history baseline has not completed —
-- the sweep retries it, and live reactions treat the project's draws as baseline until
-- it is set (audit #9: a failed baseline must never turn history into borrower emails).
ALTER TABLE trustpoint_project_links ADD COLUMN IF NOT EXISTS baselined_at timestamptz;
-- attempts: bounded webhook-event retry (TrustPoint never redelivers; a transient
-- processing failure releases the claim and retries up to 3x — audit #11).
ALTER TABLE trustpoint_webhook_events ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0;
-- truthful milestone match labels (audit #14): 'name' = normalized-name equality,
-- 'amount' = unique-amount fallback ('name_amount' kept for pre-fix rows).
DO $$
BEGIN
  -- drop the db/293 auto-named CHECK whenever present (idempotent: gone after the first
  -- run); the stably-named replacement below carries the widened list.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trustpoint_milestone_links_matched_by_check') THEN
    ALTER TABLE trustpoint_milestone_links DROP CONSTRAINT trustpoint_milestone_links_matched_by_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_tpml_matched_by') THEN
    ALTER TABLE trustpoint_milestone_links ADD CONSTRAINT chk_tpml_matched_by
      CHECK (matched_by IS NULL OR matched_by IN ('name_amount','name','amount','manual'));
  END IF;
END $$;
