-- 297_trustpoint_core.sql
-- Idempotent. Physical-draw workflow phase 2 (owner-directed 2026-07-24; blueprint
-- docs/TRUSTPOINT-PHYSICAL-DRAW-WORKFLOW-BLUEPRINT.md §4): the TrustPoint MIRROR.
-- TrustPoint (the note buyer's draw administrator — Blue Lake physical files) creates
-- projects on ITS side; PILOT discovers them, links them to files (loan number, else
-- unique address; never guessed — ambiguity waits for a human), and mirrors draws /
-- service orders / milestones via webhooks + watermark polls. READ-ONLY toward
-- TrustPoint except webhook registration (journaled).

-- ---- project links: TrustPoint project ↔ PILOT file. application_id NULL = a ----
-- ---- DISCOVERED-BUT-UNLINKED project awaiting the linking desk / auto-matcher. ----
CREATE TABLE IF NOT EXISTS trustpoint_project_links (
  id                    bigserial PRIMARY KEY,
  tp_project_id         text NOT NULL UNIQUE,
  application_id        uuid UNIQUE REFERENCES applications(id) ON DELETE SET NULL,
  matched_by            text CHECK (matched_by IN ('loan_number','address','manual')),
  match_detail          text,
  confirmed_by          uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  candidate_application_id uuid REFERENCES applications(id) ON DELETE SET NULL,  -- suggestion-only, never auto-bound
  candidate_reason      text,
  loan_external_id      text,           -- loan.external_id at discovery (echoes as webhook loan_id)
  project_name          text,
  address_text          text,
  tp_status             text,           -- CREATED/ACTIVE/PAUSED/INACTIVE_*/DISCARDED (mirrored)
  discarded             boolean NOT NULL DEFAULT false,
  raw                   jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tpl_unlinked ON trustpoint_project_links (application_id) WHERE application_id IS NULL;

-- ---- milestone crosswalk (D4): the coordinator copies PILOT's budget into TrustPoint, ----
-- ---- so TP milestones ARE our SOW lines — matched by normalized name + amount, human- ----
-- ---- confirmed for stragglers. sitewire_job_item_id ties to the operative per-line    ----
-- ---- ledger (the exploded Sitewire crosswalk PILOT already keeps).                    ----
CREATE TABLE IF NOT EXISTS trustpoint_milestone_links (
  id                    bigserial PRIMARY KEY,
  application_id        uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  tp_project_id         text NOT NULL,
  tp_milestone_id       text NOT NULL UNIQUE,
  name                  text,
  amount_cents          bigint,
  sitewire_job_item_id  bigint,
  sow_line_key          text,
  matched_by            text CHECK (matched_by IN ('name_amount','name','manual')),
  confirmed_by          uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tpml_app ON trustpoint_milestone_links (application_id);

-- ---- the draw mirror (aggregate-level — TrustPoint's API exposes NO per-line draw data) ----
CREATE TABLE IF NOT EXISTS trustpoint_draws (
  id                    bigserial PRIMARY KEY,
  application_id        uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  tp_project_id         text NOT NULL,
  tp_draw_id            text NOT NULL UNIQUE,
  number                integer,
  name                  text,
  status                text,          -- DRAFT/IN_REVIEW/APPROVED/COMPLETED
  draw_type             text,          -- DRAW_REQUEST/CHANGE_REQUEST
  requested_cents       bigint,
  approved_cents        bigint,
  disbursed_cents       bigint,
  to_disburse_cents     bigint,        -- approved − fees (webhook amount_to_disburse)
  holdback_cents        bigint,        -- construction_holdback share
  borrower_equity_cents bigint,
  fees                  jsonb,
  retainage             jsonb,         -- the 4 read-only retainage fields (TrustPoint is retainage SOR — D7)
  contingency           jsonb,
  inspector_allowance_rate       numeric,
  inspector_recommendation_rate  numeric,
  lender_allowance_rate          numeric,
  coordinator_name      text,
  submitted_at          timestamptz,
  approved_at           timestamptz,
  completed_at          timestamptz,
  disbursed_at          timestamptz,
  tp_created_at         timestamptz,
  estimated_reimbursement_date date,
  status_synced         text,          -- reaction watermark (mirrors sitewire_draws.status_synced)
  sitewire_draw_id      bigint,        -- the Sitewire intake draw this mirrors (write-back target, phase 3)
  portal_draw_request_id bigint,       -- the portal composer intake (phase 4)
  report_document_id    uuid,          -- archived TrustPoint report PDF (documents row, staff-only)
  raw                   jsonb,
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tpd_app ON trustpoint_draws (application_id);
CREATE INDEX IF NOT EXISTS idx_tpd_project ON trustpoint_draws (tp_project_id);

-- ---- service orders (inspections + feasibility / permit verification / etc.) ----
CREATE TABLE IF NOT EXISTS trustpoint_service_orders (
  tp_service_order_id   text PRIMARY KEY,
  application_id        uuid REFERENCES applications(id) ON DELETE CASCADE,
  tp_project_id         text NOT NULL,
  tp_draw_id            text,
  service_type          text,
  status                text,
  service_number        text,
  ordered_at            timestamptz,
  scheduled_at          timestamptz,
  completed_at          timestamptz,
  cancelled_at          timestamptz,
  inspector_allowance_rate numeric,
  status_synced         text,
  raw                   jsonb,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tpso_app ON trustpoint_service_orders (application_id);

-- ---- append-only inbound audit (the analog of sitewire_pull_field_change) ----
CREATE TABLE IF NOT EXISTS trustpoint_pull_field_change (
  id              bigserial PRIMARY KEY,
  application_id  uuid,
  tp_draw_id      text,
  entity          text NOT NULL,
  entity_id       text,
  field           text NOT NULL,
  old_value       text,
  new_value       text,
  reacted         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tppfc_app ON trustpoint_pull_field_change (application_id, created_at DESC);

-- ---- outbound write journal (webhook registration is the only phase-2 write) ----
CREATE TABLE IF NOT EXISTS trustpoint_write_log (
  id              bigserial PRIMARY KEY,
  application_id  uuid,
  endpoint        text NOT NULL,
  method          text NOT NULL,
  body            jsonb,
  response        jsonb,
  ok              boolean,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---- webhook receiver INBOX: 2xx-in-30s = INSERT + return; a drainer processes. ----
-- ---- Delivery ids are a fresh uuid per retry, so dedupe is (event, payload hash). ----
CREATE TABLE IF NOT EXISTS trustpoint_webhook_events (
  id              bigserial PRIMARY KEY,
  event           text NOT NULL,
  tp_project_id   text,
  tp_draw_id      text,
  tp_service_order_id text,
  loan_id         text,
  payload         jsonb NOT NULL,
  payload_hash    text NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  process_error   text,
  UNIQUE (event, payload_hash)
);
CREATE INDEX IF NOT EXISTS idx_tpwe_pending ON trustpoint_webhook_events (received_at) WHERE processed_at IS NULL;

-- ---- tiny key/value state (poll watermarks etc.) ----
CREATE TABLE IF NOT EXISTS trustpoint_state (
  key         text PRIMARY KEY,
  value       text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
