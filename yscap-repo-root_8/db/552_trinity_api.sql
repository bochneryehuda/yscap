-- 552_trinity_api.sql
-- Idempotent. The Trinity ORDERING API (blueprint D8: "the planned Trinity ordering API
-- later replaces the manual 'ordered' step with an adapter call and nothing else changes").
--
-- This is the GENERAL PHYSICAL PROGRAM only — a physical-inspection draw on a file whose
-- note buyer is NOT Blue Lake. It touches NOTHING owned by the Sitewire virtual pipeline
-- or the TrustPoint/Blue Lake pipeline: no column of theirs is altered, no trigger of
-- theirs is redefined. db/299 created `trinity_inspection_orders` with a five-state
-- lifecycle for the manual desk; this file widens that ONE table with the API's own
-- identifiers and adds the tables the adapter needs beside it.
--
-- Deliberately NOT an autopilot: nothing here delivers anything to a borrower. The
-- report lands, our figures fill in, and a human presses Deliver (owner-directed
-- 2026-08-14 — the Sitewire virtual autopilot stays exactly as it is and is for
-- virtual inspections ONLY).

-- ---------------------------------------------------------------------------
-- 1. The order record gains the API's identifiers + the real progress ladder
-- ---------------------------------------------------------------------------
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS trinity_order_id    bigint;
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS trinity_project_id  bigint;
-- Our exactly-once key. Trinity answers 409 "An order already exist with this
-- CustomerKey" (verified live), so a lost response can never create a second order:
-- the retry resolves the existing one by this key instead of posting again.
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS customer_key        text;
-- Trinity's own words, kept verbatim beside our five states so the desk can show
-- exactly what Trinity shows ("Searching for Inspector", "Waiting On Documents").
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS trinity_status_id   int;
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS trinity_status      text;
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS trinity_substatus   text;
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS status_changed_at   timestamptz;
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS scheduled_at        timestamptz;
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS completed_at        timestamptz;
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS polled_at           timestamptz;
-- A cancel is a REQUEST, not an act (verified: PUT .../cancel returns 200 and the order
-- stays in its current status). So we record that we asked and wait for status 14.
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;
-- What the inspector approved, once the completed budget has been read + reconciled.
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS approved_cents      bigint;
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS results_read_at     timestamptz;
-- `report_document_id` already exists from db/299 — the report PDF is filed on the loan
-- as an ordinary staff document and this points at it.
-- The desk's one-time "the report is in, review and deliver" cue. It is a CLAIM (an
-- IS NULL-guarded update), so two pollers racing can never send it twice — and it is a
-- cue to the DESK, never to a borrower.
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS notified_ready_at   timestamptz;
-- Why an automatic step stood down, in plain words, for the desk to show.
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS blocked_reason      text;
-- Single-flight lease for the order-placement chain (same shape as the portal-draw
-- close-out claim in src/lib/portal-draws.js): overlapping drivers lose and skip, a
-- crashed run self-releases after 10 minutes.
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS order_claimed_at    timestamptz;
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS documents_sent_at   timestamptz;

-- The widened status ladder. db/299 shipped CHECK (requested/ordered/report_received/
-- entered/cancelled) as an auto-named constraint; replace it ONCE with a stably-named
-- one carrying the two progress states the owner asked for by name ("inspector ordered,
-- inspector scheduled"). Guarded both ways so a boot replay is a no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trinity_inspection_orders_status_check') THEN
    ALTER TABLE trinity_inspection_orders DROP CONSTRAINT trinity_inspection_orders_status_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_trinity_order_status') THEN
    ALTER TABLE trinity_inspection_orders ADD CONSTRAINT chk_trinity_order_status
      CHECK (status IN ('requested','ordered','scheduled','inspected','report_received','entered','cancelled'));
  END IF;
END $$;

-- One Trinity order is one row, forever (the API's id is globally unique).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tio_trinity_order ON trinity_inspection_orders (trinity_order_id)
  WHERE trinity_order_id IS NOT NULL;
-- The exactly-once key is unique on our side too, so two drivers cannot mint two rows
-- that would each try to claim the same Trinity order.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tio_customer_key ON trinity_inspection_orders (customer_key)
  WHERE customer_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tio_open ON trinity_inspection_orders (status, polled_at NULLS FIRST)
  WHERE status IN ('requested','ordered','scheduled','inspected');

-- ---------------------------------------------------------------------------
-- 2. The per-line crosswalk — our budget line <-> Trinity's line item
-- ---------------------------------------------------------------------------
-- This is what makes "what did the inspector approve on OUR line" answerable. The
-- crosswalk key is Trinity's `customerKey`, which we set to our own job-item id, so the
-- tie survives even if descriptions are edited on their side. (Their budget read-back
-- returns `number: 0`, verified — identity must come from id/customerKey, never number.)
CREATE TABLE IF NOT EXISTS trinity_order_lines (
  id                        bigserial PRIMARY KEY,
  trinity_inspection_order_id bigint NOT NULL REFERENCES trinity_inspection_orders(id) ON DELETE CASCADE,
  application_id            uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  sitewire_job_item_id      bigint,              -- our per-unit ledger line (the crosswalk)
  sow_line_key              text,
  name                      text NOT NULL,
  trinity_line_id           bigint,              -- Trinity's own line id
  customer_key              text,                -- what we sent as customerKey
  budgeted_cents            bigint NOT NULL DEFAULT 0,
  requested_cents           bigint NOT NULL DEFAULT 0,
  -- the historical picture we SENT (so a later reader can see exactly what the
  -- inspector was shown, not just what we would compute today)
  previous_drawn_cents      bigint NOT NULL DEFAULT 0,
  previous_pct              numeric(9,4),
  -- what came BACK
  completed_pct             numeric(9,4),
  approved_cents            bigint,
  inspector_remarks         text,                -- Trinity/vendor per-line note ("why not approved")
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tol_order ON trinity_order_lines (trinity_inspection_order_id);
CREATE INDEX IF NOT EXISTS idx_tol_app ON trinity_order_lines (application_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tol_order_key ON trinity_order_lines (trinity_inspection_order_id, customer_key)
  WHERE customer_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Two-way messaging with the Trinity team
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trinity_order_comments (
  id                        bigserial PRIMARY KEY,
  trinity_inspection_order_id bigint NOT NULL REFERENCES trinity_inspection_orders(id) ON DELETE CASCADE,
  application_id            uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  trinity_comment_id        bigint,
  direction                 text NOT NULL CHECK (direction IN ('out','in')),
  content                   text NOT NULL,
  important                 boolean NOT NULL DEFAULT false,
  visible_to_vendor         boolean NOT NULL DEFAULT true,
  author_name               text,
  sent_by_staff             uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  trinity_created_at        timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_toc_trinity_id ON trinity_order_comments (trinity_comment_id)
  WHERE trinity_comment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_toc_order ON trinity_order_comments (trinity_inspection_order_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Photos + documents pulled back from Trinity
-- ---------------------------------------------------------------------------
-- Trinity's file URLs are PRE-SIGNED and EXPIRE (~50 minutes, verified). Everything we
-- pull is archived into PILOT's own storage immediately; `source_key` is the durable
-- identity so a re-poll never stores a second copy of the same photo.
CREATE TABLE IF NOT EXISTS trinity_order_media (
  id                        bigserial PRIMARY KEY,
  trinity_inspection_order_id bigint NOT NULL REFERENCES trinity_inspection_orders(id) ON DELETE CASCADE,
  application_id            uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  kind                      text NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo','document','report')),
  trinity_id                bigint,
  source_key                text NOT NULL,
  file_name                 text,
  content_type              text,
  bytes                     bigint,
  labels                    text[],
  storage_ref               text,
  storage_provider          text,
  sha256                    text,
  archived_at               timestamptz,
  skip_reason               text,
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tom_source ON trinity_order_media (trinity_inspection_order_id, source_key);
CREATE INDEX IF NOT EXISTS idx_tom_order ON trinity_order_media (trinity_inspection_order_id, kind);

-- ---------------------------------------------------------------------------
-- 5. The webhook inbox
-- ---------------------------------------------------------------------------
-- Trinity webhooks carry NO signature and NO shared secret (their docs: "notifications
-- and only provide the IDs, event type, and a short description"). So a delivery is
-- never TRUSTED — it is a nudge to go and LOOK. The receiver stores it, and processing
-- hydrates every fact with an authenticated GET. Polls remain the correctness machinery.
CREATE TABLE IF NOT EXISTS trinity_webhook_events (
  id             bigserial PRIMARY KEY,
  event          text NOT NULL,
  trinity_order_id   bigint,
  trinity_project_id bigint,
  payload        jsonb NOT NULL,
  payload_hash   text NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,
  claimed_at     timestamptz,
  attempts       int NOT NULL DEFAULT 0,
  error          text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_twe_dedupe ON trinity_webhook_events (event, payload_hash);
CREATE INDEX IF NOT EXISTS idx_twe_unprocessed ON trinity_webhook_events (received_at)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 6. Poller/adapter state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trinity_state (
  key        text PRIMARY KEY,
  value      text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 7. Back-fill: give the rows db/299 already created their exactly-once key
-- ---------------------------------------------------------------------------
-- Previous AND future. An existing manual order keyed to a portal draw request gets the
-- same customer_key the adapter would mint, so if it is later ordered through the API it
-- reuses its own identity rather than minting a second one.
UPDATE trinity_inspection_orders
   SET customer_key = 'pdr-' || portal_draw_request_id
 WHERE customer_key IS NULL AND portal_draw_request_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM trinity_inspection_orders o2
      WHERE o2.customer_key = 'pdr-' || trinity_inspection_orders.portal_draw_request_id);
