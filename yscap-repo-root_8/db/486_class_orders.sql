-- ============================================================================
-- 486 — Class Valuation appraisal ordering: the placed order, and their callbacks.
--
-- Class is the SECOND appraisal vendor (AppraisalScope / NAN is the first, db/480).
-- Unlike the AMC, Class PUSHES: we register a callback URL once, and they POST an
-- event to it whenever something happens to an order. So this adds two things —
-- a record of every order we place, and an inbox for everything they tell us.
--
-- WHY THE ORDER ROW IS NOT OPTIONAL, AND IS THE WHOLE POINT OF THIS MIGRATION:
-- Class supports TWO form versions (UAD 2.6 on `POST /orders`, UAD 3.6 on
-- `POST /v2/orders`), we order on either, and **their callback payload does not say
-- which one an order was placed on**. It carries only `orderId` and our
-- `referenceNumber`. Every follow-up read has to be made on the MATCHING version —
-- `GET /orders/{id}` and `GET /v2/orders/{id}` return different field names for the
-- same facts — so the version has to be remembered HERE, at the moment we place the
-- order, or it is unrecoverable afterwards. `api_version` is therefore written on
-- every order and read back by the callback handler; when it is genuinely unknown
-- (an order placed before this table existed) the handler records the event and
-- declines to make a version-specific call rather than guessing one.
--
-- Additive and idempotent; applies on boot and changes no existing behavior. The
-- feature stays off behind CLASS_ENABLED / CLASS_OUTBOUND_ENABLED. RTL only.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- One row per order placed with Class.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS class_orders (
  id                  bigserial PRIMARY KEY,
  application_id      uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- The appraisal condition this order fulfils, so a completed order can nudge it.
  checklist_item_id   uuid REFERENCES checklist_items(id) ON DELETE SET NULL,

  -- ---- identifiers ----
  -- Theirs. `long` in their docs; stored as text so a format change on their side
  -- can never make an existing row unreadable.
  class_order_id      text,
  transaction_id      text,
  -- Ours. This is what comes back on every callback as `referenceNumber`, and it is
  -- the only join key when their order id has not reached us yet.
  reference_number    text,

  -- ---- WHICH FORM VERSION THIS ORDER IS ON — see the header ----
  -- 'v1' = UAD 2.6 (POST /orders) · 'v2' = UAD 3.6 (POST /v2/orders)
  api_version         text NOT NULL DEFAULT 'v1' CHECK (api_version IN ('v1','v2')),
  uad                 text NOT NULL DEFAULT '2.6' CHECK (uad IN ('2.6','3.6')),
  -- The exact path this order was posted to, recorded rather than re-derived, so a
  -- follow-up can never be sent somewhere the order does not live.
  order_path          text,

  -- ---- what was ordered ----
  product_id          text,
  product_title       text,
  -- The body we sent, masked of nothing because it contains no credential — it is
  -- the file's own data. Kept so "what exactly did we ask for?" is answerable years
  -- later, including which field names this version used.
  request_body        jsonb,
  dryrun              boolean NOT NULL DEFAULT false,

  -- ---- lifecycle. Their StatusChanged values are Active / OnHold / Resume /
  -- Completed / Cancelled; ours adds the states that exist before they answer. ----
  status              text NOT NULL DEFAULT 'placing',
  status_reason       text,
  invision_url        text,
  due_date            timestamptz,
  appointment_date    timestamptz,
  inspected_at        timestamptz,
  assigned_vendor     jsonb,
  client_fee_cents    bigint,
  paid_at             timestamptz,

  last_event_at       timestamptz,
  last_error          text,
  placed_by           uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  placed_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_class_orders_app ON class_orders (application_id, created_at DESC);
-- The two ways a callback finds its order. Their id is unique once we have it; a
-- PARTIAL unique index so the many rows that do not have one yet never collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_class_orders_class_id
  ON class_orders (class_order_id) WHERE class_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_class_orders_reference ON class_orders (reference_number)
  WHERE reference_number IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The callback inbox. EVERY delivery is stored before anything is interpreted, so
-- an event we do not handle yet is still on the record and can be replayed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS class_callback_events (
  id                bigserial PRIMARY KEY,
  -- Resolved where possible; a delivery for an order we have never heard of is kept
  -- with a NULL link rather than dropped — that is evidence, not noise.
  class_order_row   bigint REFERENCES class_orders(id) ON DELETE SET NULL,
  application_id    uuid REFERENCES applications(id) ON DELETE SET NULL,

  event_name        text NOT NULL,
  class_order_id    text,
  reference_number  text,
  payload           jsonb,
  -- Dedupe key. Their retries repeat a delivery verbatim; a byte-identical event on
  -- a LATER day is legitimate, so the day is inside the hash (the trustpoint rule).
  payload_hash      text NOT NULL,

  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  process_error     text
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_class_cb_dedupe ON class_callback_events (event_name, payload_hash);
CREATE INDEX IF NOT EXISTS idx_class_cb_unprocessed ON class_callback_events (received_at)
  WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_class_cb_order ON class_callback_events (class_order_row, received_at DESC);

-- ---------------------------------------------------------------------------
-- What Class has told us is attached to an order. Their NewAttachments event names
-- the document but carries no id and no bytes, so this is a WORK LIST: the file is
-- fetched separately, and `document_id` is filled once it is on the loan file.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS class_attachments (
  id                bigserial PRIMARY KEY,
  class_order_row   bigint NOT NULL REFERENCES class_orders(id) ON DELETE CASCADE,
  application_id    uuid REFERENCES applications(id) ON DELETE SET NULL,
  name              text,
  content_type      text,
  class_attachment_id text,
  document_id       uuid REFERENCES documents(id) ON DELETE SET NULL,
  announced_at      timestamptz NOT NULL DEFAULT now(),
  fetched_at        timestamptz,
  fetch_error       text
);

CREATE INDEX IF NOT EXISTS idx_class_attach_order ON class_attachments (class_order_row, announced_at DESC);
-- One row per (order, name) — their retries re-announce the same document, and a
-- second announcement of the same name is the same file, not a second one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_class_attach_name
  ON class_attachments (class_order_row, name) WHERE name IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The callback registrations we have made with Class, so the admin screen can say
-- what is live without asking them (and can tell "never registered" from
-- "registered and quiet", which are very different problems).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS class_callback_registrations (
  id              bigserial PRIMARY KEY,
  event_name      text NOT NULL,
  callback_url    text NOT NULL,
  class_id        text,
  -- NEVER the password. Presence only, exactly as the API-Health page treats a
  -- credential: this table records THAT we authenticated, never HOW.
  auth_mode       text NOT NULL DEFAULT 'BasicAuth',
  registered_at   timestamptz NOT NULL DEFAULT now(),
  registered_by   uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  removed_at      timestamptz,
  last_error      text
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_class_cb_reg ON class_callback_registrations (event_name, callback_url)
  WHERE removed_at IS NULL;

-- updated_at maintenance, so no write path has to remember it.
CREATE OR REPLACE FUNCTION class_orders_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_class_orders_touch ON class_orders;
CREATE TRIGGER trg_class_orders_touch
  BEFORE UPDATE ON class_orders
  FOR EACH ROW EXECUTE FUNCTION class_orders_touch_updated_at();
