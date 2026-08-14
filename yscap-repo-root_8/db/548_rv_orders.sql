-- ============================================================================
-- 548 — Richer Value "Hybrid Appraisal" ordering: the placed order, their
--       webhook inbox, the status timeline, the write journal, and the
--       reference cache.
--
-- Richer Value is the THIRD appraisal vendor (AppraisalScope / NAN is the first,
-- db/480; Class Valuation the second, db/490). It is a different KIND of product:
-- an EVALUATION (their "Reno ARV" report — an As-Is value together with an After
-- Repair Value), not a URAR appraisal, so it is cheaper and it does NOT produce a
-- MISMO XML data file. That single fact drives three things in this migration and
-- must never be "tidied away":
--
--   1. THERE IS NO XML, EVER. The appraisal-documents condition
--      (rtl_cond_appraisaldocs) requires an XML slot + a PDF slot + a successful
--      MISMO import. A Hybrid order can satisfy the PDF half and can NEVER satisfy
--      the other two, so ordering one records the file's "no appraisal XML" waiver
--      (db/370) automatically, under its own reason. `xml_waiver_applied` on the
--      order row is the record that WE did that, so removing the order can tell
--      its own waiver from one a human recorded by hand.
--
--   2. THE VALUES COME BACK AS DATA, NOT AS A DOCUMENT. Their completed report is
--      readable through the API — an estimated As-Is value and a renovation-strategy
--      grid whose "ARV" row carries the after-repair figure. The waiver's own rule
--      is that the As-Is and the ARV must be on the file BY HAND (with no XML there
--      is nothing to read them from) — so `results` / `as_is_value` / `arv` record
--      what the vendor said, and `values_applied_at` records the moment those
--      figures were written onto the loan file through the shared As-Is desk.
--
--   3. AN INTAKE IS NOT YET AN ORDER. Their intake endpoint returns an
--      `intake_token`; the ORDER (and its `order_token`) is only created once the
--      intake is paid — for an invoiced client that is one further call. Both
--      tokens live here because the follow-up reads take DIFFERENT ones: the
--      status / history / results reads want BOTH, while dismiss / reactivate /
--      update take the intake alone.
--
-- Additive and idempotent; applies on boot and changes no existing behavior. The
-- feature stays off behind RV_ENABLED / RV_OUTBOUND_ENABLED. RTL only.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- One row per order placed with Richer Value.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rv_orders (
  id                  bigserial PRIMARY KEY,
  application_id      uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- The appraisal condition this order fulfils, so a completed order can nudge it
  -- and the returned PDF can be filed into its own slot.
  checklist_item_id   uuid REFERENCES checklist_items(id) ON DELETE SET NULL,

  -- ---- identifiers ----
  -- Theirs. `intake_token` is minted by the submit call; `order_token` only
  -- exists once the intake has been paid. Stored as text so a format change on
  -- their side can never make an existing row unreadable.
  intake_token        text,
  order_token         text,
  -- Which of THEIR companies the order was placed for. Recorded rather than
  -- re-derived, so a follow-up can never be made against a different company
  -- than the order was placed under.
  company_token       text,
  -- Ours. Their `client_loan_number`, echoed back on their screens.
  client_loan_number  text,

  -- ---- what was ordered ----
  -- Their slugs, verbatim (reno-arv / interior-w-exterior / standard …). Kept as
  -- text and NOT constrained: their catalogue is served by an API and a new slug
  -- must never be able to fail a write.
  report_type         text NOT NULL,
  inspection_type     text,
  turnaround_time     text,
  gla_include              boolean NOT NULL DEFAULT false,
  licensing_required       boolean NOT NULL DEFAULT false,
  include_flood_certification boolean NOT NULL DEFAULT false,
  property_upload_type text NOT NULL DEFAULT 'single'
                       CHECK (property_upload_type IN ('single','batch')),
  -- The exact multipart fields we sent, masked of nothing because they contain no
  -- credential — it is the file's own data. Kept so "what exactly did we ask for?"
  -- is answerable years later.
  request_body        jsonb,
  dryrun              boolean NOT NULL DEFAULT false,

  -- ---- money ----
  -- Their pricing snapshot at the moment of the order, and the total in CENTS
  -- (integer money, the house rule) so a report fee can be reconciled later.
  price               jsonb,
  total_price_cents   bigint,
  -- 'ADD_TO_INVOICE' | 'USE_EXISTING_SOURCE' | 'BORROWER_LINK' | NULL (unpaid).
  payment_method      text,
  paid_at             timestamptz,
  payment_link        text,
  intake_form_link    text,

  -- ---- lifecycle ----
  -- Ours, normalized: the states that exist before and after they answer.
  --   draft → placing → intake (submitted, unpaid) → ordered → in_process →
  --   assigned → inspected → in_review → product_available → completed,
  --   plus on_hold / cancel_requested / cancelled / rejected / error / dryrun.
  status              text NOT NULL DEFAULT 'placing',
  status_reason       text,
  -- Their own words for the report and the inspection, kept beside ours so the
  -- desk can show what the vendor actually said on hover.
  vendor_status       text,
  vendor_inspection_status text,
  inspection_scheduled_date date,
  due_date            date,

  -- ---- what came back ----
  -- The whole `retrieve-response` payload for this order, verbatim.
  results             jsonb,
  -- The two figures the whole product exists to produce, parsed out of `results`
  -- by src/richervalues/results.js. Recorded here whether or not they were applied
  -- to the loan file, so "what did the vendor say?" and "what is on the file?" stay
  -- separately answerable.
  as_is_value         numeric(14,2),
  arv                 numeric(14,2),
  -- Which renovation strategy the ARV was taken from ('best' / 'min' / 'partial' /
  -- 'full'), so an ARV is never a number with no provenance.
  arv_basis           text,
  values_applied_at   timestamptz,
  values_applied_by   uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  -- Their finished report, once filed onto the loan file.
  pdf_document_id     uuid REFERENCES documents(id) ON DELETE SET NULL,

  -- ---- the automatic XML waiver (see the header) ----
  -- TRUE when placing THIS order is what recorded the file's "no appraisal XML"
  -- waiver. A waiver a human recorded by hand is never stamped here, so removing
  -- an order can only ever withdraw a waiver the order itself created.
  xml_waiver_applied  boolean NOT NULL DEFAULT false,

  last_event_at       timestamptz,
  last_polled_at      timestamptz,
  last_error          text,
  cancel_reason       text,
  cancelled_at        timestamptz,
  cancelled_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  placed_by           uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  placed_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rv_orders_app ON rv_orders (application_id, created_at DESC);
-- The two ways a webhook finds its order. Both are unique once we have them; a
-- PARTIAL unique index so the many rows that do not have one yet never collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rv_orders_intake
  ON rv_orders (intake_token) WHERE intake_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_rv_orders_order
  ON rv_orders (order_token) WHERE order_token IS NOT NULL;
-- The poller's work list: everything still moving, oldest poll first.
CREATE INDEX IF NOT EXISTS idx_rv_orders_open ON rv_orders (last_polled_at NULLS FIRST)
  WHERE status NOT IN ('completed','cancelled','rejected','draft','dryrun');

-- ---------------------------------------------------------------------------
-- The webhook inbox. EVERY delivery is stored before anything is interpreted, so
-- an event we do not handle yet is still on the record and can be replayed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rv_order_events (
  id                bigserial PRIMARY KEY,
  -- Resolved where possible; a delivery for an order we have never heard of is
  -- kept with a NULL link rather than dropped — that is evidence, not noise.
  rv_order_row      bigint REFERENCES rv_orders(id) ON DELETE SET NULL,
  application_id    uuid REFERENCES applications(id) ON DELETE SET NULL,

  -- Their payload shape: order_type (eval|avm|inspection) + data.action_type
  -- (report|inspection) + data.action.
  order_type        text,
  action_type       text,
  action            text,
  intake_token      text,
  order_token       text,
  event_at          timestamptz,
  payload           jsonb,
  -- Dedupe key. Their retries repeat a delivery verbatim; a byte-identical event
  -- on a LATER day is legitimate, so the day is inside the hash (the trustpoint
  -- rule, followed by the Class inbox too).
  payload_hash      text NOT NULL,

  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  process_error     text,
  attempts          integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz,
  dead_at           timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rv_events_dedupe ON rv_order_events (payload_hash);
CREATE INDEX IF NOT EXISTS idx_rv_events_unprocessed ON rv_order_events (received_at)
  WHERE processed_at IS NULL AND dead_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rv_events_order ON rv_order_events (rv_order_row, received_at DESC);

-- ---------------------------------------------------------------------------
-- The status timeline, built from their /order/history read. One row per DISTINCT
-- status so a poll that sees the same history ten times records it once.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rv_status_events (
  id                bigserial PRIMARY KEY,
  rv_order_row      bigint NOT NULL REFERENCES rv_orders(id) ON DELETE CASCADE,
  application_id    uuid REFERENCES applications(id) ON DELETE SET NULL,
  -- 'report' | 'inspection' — their own two tracks.
  event_type        text,
  status            text,
  comment           text,
  occurred_at       timestamptz,
  dedupe_key        text NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rv_status_dedupe ON rv_status_events (rv_order_row, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_rv_status_order ON rv_status_events (rv_order_row, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- The vendor WRITE journal — the amc_write_log equivalent. Every call that
-- CHANGES something at Richer Value (submit, pay, update, cancel, hold, reopen,
-- upload) with the masked request, the response, and who did it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rv_write_log (
  id                bigserial PRIMARY KEY,
  rv_order_row      bigint REFERENCES rv_orders(id) ON DELETE SET NULL,
  application_id    uuid REFERENCES applications(id) ON DELETE SET NULL,
  action            text NOT NULL,
  method            text,
  path              text,
  request           jsonb,
  response          jsonb,
  ok                boolean,
  error             text,
  staff_id          uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rv_write_log_order ON rv_write_log (rv_order_row, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rv_write_log_app ON rv_write_log (application_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Their reference catalogue (report types, inspection types, turnaround times,
-- loan officers), cached so a preview never blocks on a live call and the screen
-- can render with the vendor unreachable. Best-effort by construction: a stale
-- cache is a usable screen, an empty one is a screen that says so.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rv_reference_cache (
  cache_key         text PRIMARY KEY,
  payload           jsonb NOT NULL,
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  last_error        text
);

-- updated_at maintenance, so no write path has to remember it.
CREATE OR REPLACE FUNCTION rv_orders_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_rv_orders_touch ON rv_orders;
CREATE TRIGGER trg_rv_orders_touch
  BEFORE UPDATE ON rv_orders
  FOR EACH ROW EXECUTE FUNCTION rv_orders_touch_updated_at();
