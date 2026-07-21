-- ============================================================================
-- 209 — THE WORKFLOW (submission hand-offs + personal work queues)
--       (owner-directed 2026-07-21).
--
-- Until now a file moved along by its STATUS LABEL only (a Processing /
-- Underwriting / Funded dropdown that also mirrors to the ClickUp card). That is
-- just a label, not a workflow: nobody had a personal "here is what I work on
-- next, in order" list, a loan officer could not formally HAND a file off to the
-- next person, and there was no record of what each person finished, did, or
-- sent back.
--
-- This builds a real workflow. From inside a file a loan officer clicks a plain
-- Submit button ("Submit for Processing", "Submit for Clear-to-Close",
-- "Submit for Closing"…). That one click (a) drops the file onto the right
-- downstream person's personal WORKFLOW queue and (b) sets the file's status
-- (and ClickUp card) AUTOMATICALLY — the workflow DRIVES the status, not the
-- other way around. Regular staff stop touching the status dropdown; only a
-- super_admin keeps a manual status override.
--
-- Three tables:
--   · workflow_items    — the live hand-off (one open row per file+type; the
--                         "up next" queue keys off to_staff_id).
--   · workflow_events   — append-only history ("what I finished / did / sent
--                         back", with who / when / why per hand-off).
--   · closing_workflow  — the per-file closing sub-lifecycle
--                         (estimated → ready_for_docs → wire_sent →
--                          fully_closed → fully_reconciled); fully_closed links
--                          the file to `funded`.
--
-- Plus the CLOSER role and the assigned-closer / assigned-underwriter pointers
-- (mirroring applications.processor_id) so a re-submit routes to the same person.
--
-- Idempotent — safe to re-run on every boot.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (1) Add the CLOSER persona to the staff role set. Re-assert the FULL list
--     (mirrors db/131 which added draw_coordinator) so the constraint is exact.
-- ----------------------------------------------------------------------------
ALTER TABLE staff_users DROP CONSTRAINT IF EXISTS staff_users_role_check;
ALTER TABLE staff_users ADD  CONSTRAINT staff_users_role_check
  CHECK (role IN ('super_admin','admin','underwriter','loan_officer','loan_coordinator','draw_coordinator','processor','closer','software_setup'));

-- ----------------------------------------------------------------------------
-- (2) Assigned-CLOSER / assigned-UNDERWRITER pointers on the file, mirroring
--     applications.processor_id. When a workflow submit resolves a picked closer
--     / underwriter (because none was assigned yet), the pointer is set so the
--     NEXT submission of that kind routes straight to the same person ("if a
--     closer is already assigned it goes to that closer"). Nullable; a null slot
--     means "the submitter picks".
-- ----------------------------------------------------------------------------
ALTER TABLE applications ADD COLUMN IF NOT EXISTS closer_id      uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS underwriter_id uuid REFERENCES staff_users(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------
-- (3) workflow_items — the LIVE hand-off row (current state). At most one OPEN /
--     IN-PROGRESS row per (application, submission_type): a re-submit supersedes
--     the prior live one (handled in code + enforced by the partial unique index).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  submission_type   text NOT NULL CHECK (submission_type IN (
                      'loan_setup','processing','condition_clearing','clear_to_close',
                      'closing','draw_setup','post_closing','exception','escalation')),
  from_staff_id     uuid REFERENCES staff_users(id) ON DELETE SET NULL,   -- who submitted it
  to_staff_id       uuid REFERENCES staff_users(id) ON DELETE SET NULL,   -- the resolved recipient
  to_role           text,                                                 -- the destination role (for display / filtering)
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','returned','cancelled')),
  outcome_label     text,          -- set on return ("Finished processing","Added conditions"…)
  note              text,          -- submit note and/or the latest return note
  priority          smallint NOT NULL DEFAULT 0,   -- higher = more urgent; default order is still received_at
  est_closing_date  date,          -- closing submissions only
  received_at       timestamptz NOT NULL DEFAULT now(),   -- "assigned/received" time shown + sorted on
  picked_up_at      timestamptz,
  returned_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wf_to_staff ON workflow_items(to_staff_id, status, received_at);
CREATE INDEX IF NOT EXISTS idx_wf_to_role  ON workflow_items(to_role, status, received_at);
CREATE INDEX IF NOT EXISTS idx_wf_app      ON workflow_items(application_id, status);
-- One LIVE hand-off of a given type per file — a re-submit supersedes the prior.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wf_live
  ON workflow_items(application_id, submission_type)
  WHERE status IN ('open','in_progress');

-- ----------------------------------------------------------------------------
-- (4) workflow_events — APPEND-ONLY history. Every state change writes BOTH the
--     mutated workflow_items row (the live queue) AND an immutable event row (the
--     "completed / sent back" history + per-file timeline).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_item_id  uuid NOT NULL REFERENCES workflow_items(id) ON DELETE CASCADE,
  application_id    uuid NOT NULL,   -- denormalized so a file-timeline query needs no join back
  event_type        text NOT NULL CHECK (event_type IN ('submitted','picked_up','returned','reassigned','cancelled','note')),
  actor_staff_id    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  from_staff_id     uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  to_staff_id       uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  submission_type   text,
  outcome_label     text,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wfe_item  ON workflow_events(workflow_item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wfe_actor ON workflow_events(actor_staff_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wfe_app   ON workflow_events(application_id, created_at);

-- ----------------------------------------------------------------------------
-- (5) closing_workflow — the per-file closing sub-lifecycle (a singleton row per
--     application). One linear stage machine. "fully_closed" is the stage that
--     flips the file to `funded` (done in code via the shared status door).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS closing_workflow (
  application_id      uuid PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  workflow_item_id    uuid REFERENCES workflow_items(id) ON DELETE SET NULL,
  stage               text NOT NULL DEFAULT 'estimated'
                        CHECK (stage IN ('estimated','ready_for_docs','wire_sent','fully_closed','fully_reconciled')),
  est_closing_date    date,
  ready_for_docs_at   timestamptz,
  wire_sent_at        timestamptz,
  fully_closed_at     timestamptz,
  fully_reconciled_at timestamptz,
  updated_by          uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
