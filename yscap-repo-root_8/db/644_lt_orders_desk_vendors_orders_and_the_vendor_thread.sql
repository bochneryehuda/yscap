-- ============================================================================
-- db/644 — LONG-TERM: the orders desk. The vendors a loan uses, the orders we
--          place with them, and the email thread each order lives on.
--
-- WHAT THIS CHANGES, AND WHY.
--
-- The owner asked for the long-term side to order the things a DSCR file needs —
-- title, insurance, flood insurance, a New York settlement agent, a condo
-- questionnaire, a payoff, a rent verification — from the SAME Gmail-style box the
-- short-term desk uses, with a unique reply address per order so the vendor's
-- answer and the documents they send back land on the order that asked for them.
--
-- The LETTER is genuinely shared (`src/lib/order-email.js`, authorized in
-- docs/LONG-TERM-AUTHORIZED-COPIES.md). The DATA is not, and cannot be: the
-- short-term desk's `file_orders` / `file_order_events` hang off `applications`,
-- and rule 4 forbids a long-term table referencing an RTL one. So this is the
-- long-term side's own three tables, and no lt_* row here points at anything but
-- another lt_* row — with one deliberate exception, below.
--
-- ── THE ONE THING THAT IS SHARED, AND WHY IT IS NOT A FOREIGN KEY ────────────
--
-- The VENDOR DIRECTORY is `service_contacts`, and the owner was explicit that the
-- long-term side must USE it rather than copy it: *"You need to make sure you're
-- not copying the information. You're just using the information from the
-- short-term side"* — one title company, one card, edited in one place. That
-- crossing is authorized (`sql-read` / `sql-write service_contacts`).
--
-- `lt_loan_vendors.service_contact_id` therefore holds a `service_contacts` id and
-- carries NO FOREIGN KEY, deliberately. Every available behaviour is worse:
--   · CASCADE would let a deletion on the short-term vendors screen silently
--     unlink a live long-term order's title company;
--   · RESTRICT would let a long-term loan BLOCK a short-term admin from tidying
--     their own directory — the long-term side reaching into RTL's workflow, which
--     is exactly what rule 5 forbids;
--   · SET NULL leaves an order pointing at nobody with nothing saying so.
-- A plain id + a LEFT JOIN gives the honest outcome instead: the vendor reads as
-- "no longer in the directory", the desk's own `contact` blocker refuses the order
-- and says why, and a person picks another card. Nothing about RTL changes.
--
-- ── ONE ORDER PER KIND PER LOAN ─────────────────────────────────────────────
--
-- `lt_file_orders` is UNIQUE on (loan_id, kind). The row is the SLOT — it exists
-- from the first time anybody looks at that kind on that loan and moves through
-- its statuses in place — so a follow-up, a reply and a returned document all have
-- one place to attach to, and two people pressing Order at the same moment cannot
-- produce two title orders. The short-term desk learned this the hard way in
-- db/401: a read-then-insert loses under ordinary traffic and the unique index is
-- the guarantee, not the read.
--
-- ── AN INBOUND MESSAGE IS RECORDED ONCE ─────────────────────────────────────
--
-- `lt_order_events.inbound_id` is UNIQUE where present. A mail provider redelivers
-- freely (Resend retries a webhook up to eight times, with backoff), and without
-- this a vendor's one reply files its documents once per retry. The index is the
-- guarantee; the handler's own check is the courtesy.
--
-- NO BACKFILL, and nothing to back-fill: there are no long-term orders today. Every
-- existing loan simply has an empty desk until somebody places one.
--
-- IDEMPOTENT. `migrate-boot` replays EVERY file in db/ on EVERY boot, in filename
-- order. Every statement here is IF NOT EXISTS or a drop-then-add.
-- ============================================================================

-- ── THE TWO KIND VOCABULARIES ARE MIRRORS, NOT SOURCES ──────────────────────
--
-- `src/longterm/orders/kinds.js` is the ONE definition of what can be ordered and
-- which contact fulfils it; the CHECK constraints below are a mirror of it, there
-- to catch a typo rather than to be the product's list (the owner asked for the
-- whole desk to be configurable, so adding a kind must not be a migration). They
-- can drift, and a drift is silent — a kind the registry offers that the CHECK
-- refuses fails at the moment somebody presses Order — so
-- `scripts/test-lt-orders-pure.js` reads BOTH out of the source and fails the
-- build the day they disagree.
--
-- ---------------------------------------------------------------------------
-- 1. THE VENDORS A LOAN USES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lt_loan_vendors (
    id                 uuid NOT NULL DEFAULT gen_random_uuid(),
    loan_id            uuid NOT NULL,

    -- What this contact is FOR on this loan. Free text with a CHECK rather than an
    -- enum: the owner named seven kinds and said the whole desk must be
    -- configurable, so adding one must not be a migration. The CHECK is here to
    -- catch a typo, not to be the product's list.
    kind               text NOT NULL,

    -- A `service_contacts` id. NO foreign key — see the header.
    service_contact_id uuid NOT NULL,

    -- The card the order is addressed TO. Everyone else on the same kind rides the
    -- Cc, which is how the short-term desk already loops a second title contact in.
    is_primary         boolean NOT NULL DEFAULT true,

    added_by           uuid,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_loan_vendors_pkey PRIMARY KEY (id),
    CONSTRAINT lt_loan_vendors_loan_fk FOREIGN KEY (loan_id)
        REFERENCES lt_loans (id) ON DELETE CASCADE
);

ALTER TABLE lt_loan_vendors DROP CONSTRAINT IF EXISTS lt_loan_vendors_kind_chk;
ALTER TABLE lt_loan_vendors ADD CONSTRAINT lt_loan_vendors_kind_chk
    CHECK (kind IN ('title', 'hazard_insurance', 'flood_insurance', 'ny_settlement_agent',
                    'buyers_attorney', 'realtor', 'our_attorney', 'hoa',
                    'appraisal', 'landlord', 'payoff', 'other'));

-- The same company is on a loan once for a given job.
CREATE UNIQUE INDEX IF NOT EXISTS lt_loan_vendors_one_per_kind_uk
    ON lt_loan_vendors (loan_id, kind, service_contact_id);

-- Exactly one card is the one an order is addressed to.
CREATE UNIQUE INDEX IF NOT EXISTS lt_loan_vendors_one_primary_uk
    ON lt_loan_vendors (loan_id, kind) WHERE is_primary;

CREATE INDEX IF NOT EXISTS lt_loan_vendors_contact_idx
    ON lt_loan_vendors (service_contact_id);

-- ---------------------------------------------------------------------------
-- 2. THE ORDER ITSELF
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lt_file_orders (
    id                 uuid NOT NULL DEFAULT gen_random_uuid(),
    loan_id            uuid NOT NULL,
    kind               text NOT NULL,

    -- 'not_ordered' is the resting state of a slot nobody has used yet, so a row
    -- can exist (holding a draft, a vendor choice, a Cc preference) without
    -- claiming anything was sent. 'ordered' is only ever written by a send that
    -- the provider ACCEPTED — see src/longterm/orders/send.js.
    status             text NOT NULL DEFAULT 'not_ordered',

    -- Which vendor card it actually went to, recorded at send time. Kept even if
    -- the loan's vendor choice changes afterwards: the question a year later is
    -- "who did we ask?", not "who is on the file now".
    vendor_contact_id  uuid,

    -- The thread. The SUBJECT is the load-bearing half of threading (a provider may
    -- rewrite our Message-ID; the subject is what mail clients fall back to), the
    -- two message ids carry the RFC headers.
    subject            text,
    root_message_id    text,
    last_message_id    text,
    reply_to           text,

    -- The per-order Cc choices, so a follow-up stays on the footing of the order it
    -- follows rather than re-resolving a setting that has since changed.
    cc_borrower        boolean,
    cc_helper          boolean,

    ordered_by         uuid,
    ordered_at         timestamptz,
    last_followup_at   timestamptz,
    cancelled_at       timestamptz,
    cancelled_by       uuid,
    cancel_reason      text,

    -- Where a returned document is filed: the condition this order answers.
    condition_id       uuid,

    notes              text,
    meta               jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_file_orders_pkey PRIMARY KEY (id),
    CONSTRAINT lt_file_orders_loan_fk FOREIGN KEY (loan_id)
        REFERENCES lt_loans (id) ON DELETE CASCADE,
    -- A condition can be retired from a file; the order is still a record of what
    -- we asked a vendor for, so it survives with the link cleared.
    CONSTRAINT lt_file_orders_condition_fk FOREIGN KEY (condition_id)
        REFERENCES lt_file_conditions (id) ON DELETE SET NULL
);

ALTER TABLE lt_file_orders DROP CONSTRAINT IF EXISTS lt_file_orders_status_chk;
ALTER TABLE lt_file_orders ADD CONSTRAINT lt_file_orders_status_chk
    CHECK (status IN ('not_ordered', 'ordered', 'documents_in', 'completed', 'cancelled'));

ALTER TABLE lt_file_orders DROP CONSTRAINT IF EXISTS lt_file_orders_kind_chk;
ALTER TABLE lt_file_orders ADD CONSTRAINT lt_file_orders_kind_chk
    CHECK (kind IN ('title', 'insurance', 'flood_insurance', 'ny_settlement_agent',
                    'appraisal', 'payoff', 'condo_questionnaire', 'vor'));

-- ONE order per kind per loan — the guarantee, not the read (db/401's lesson).
CREATE UNIQUE INDEX IF NOT EXISTS lt_file_orders_one_per_kind_uk
    ON lt_file_orders (loan_id, kind);

CREATE INDEX IF NOT EXISTS lt_file_orders_loan_idx
    ON lt_file_orders (loan_id, kind);
CREATE INDEX IF NOT EXISTS lt_file_orders_condition_idx
    ON lt_file_orders (condition_id) WHERE condition_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. THE THREAD — every message out and every message back
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lt_order_events (
    id             uuid NOT NULL DEFAULT gen_random_uuid(),
    order_id       uuid NOT NULL,
    -- Denormalised so a screen can scope by loan without joining, and so the
    -- inbound handler can refuse a message whose order belongs to another loan.
    loan_id        uuid NOT NULL,

    direction      text NOT NULL,
    -- What KIND of message: the order, a follow-up, a reply we typed, a vendor's
    -- answer. Free text with a CHECK for the same reason `kind` is.
    msg_type       text NOT NULL DEFAULT 'message',

    subject        text,
    from_email     text,
    to_emails      text[] NOT NULL DEFAULT '{}',
    cc_emails      text[] NOT NULL DEFAULT '{}',
    body_text      text,
    body_html      text,

    message_id     text,
    in_reply_to    text,

    -- The provider's own id for an inbound delivery. UNIQUE where present, because
    -- a webhook redelivery must not file the same documents twice.
    inbound_id     text,

    -- Did this message really come from who it says? Never a gate — a legitimate
    -- reply relayed through a list fails SPF routinely and losing a real closing
    -- document is the expensive direction — but it is SHOWN, above the fold, before
    -- anybody opens an attachment.
    sender_auth    jsonb,

    -- What came with it: filenames, sizes and where each one was filed. The BYTES
    -- go to storage and the row to lt_condition_files; this is the receipt.
    attachments    jsonb NOT NULL DEFAULT '[]'::jsonb,

    -- Never silently dropped: what could not be filed, and why.
    skipped        jsonb NOT NULL DEFAULT '[]'::jsonb,

    status         text,
    staff_id       uuid,
    occurred_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_order_events_pkey PRIMARY KEY (id),
    CONSTRAINT lt_order_events_order_fk FOREIGN KEY (order_id)
        REFERENCES lt_file_orders (id) ON DELETE CASCADE,
    CONSTRAINT lt_order_events_loan_fk FOREIGN KEY (loan_id)
        REFERENCES lt_loans (id) ON DELETE CASCADE
);

ALTER TABLE lt_order_events DROP CONSTRAINT IF EXISTS lt_order_events_direction_chk;
ALTER TABLE lt_order_events ADD CONSTRAINT lt_order_events_direction_chk
    CHECK (direction IN ('outbound', 'inbound'));

ALTER TABLE lt_order_events DROP CONSTRAINT IF EXISTS lt_order_events_msg_type_chk;
ALTER TABLE lt_order_events ADD CONSTRAINT lt_order_events_msg_type_chk
    CHECK (msg_type IN ('order', 'followup', 'reply', 'return', 'message', 'auto_reply'));

CREATE UNIQUE INDEX IF NOT EXISTS lt_order_events_inbound_uk
    ON lt_order_events (inbound_id) WHERE inbound_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS lt_order_events_order_idx
    ON lt_order_events (order_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS lt_order_events_loan_idx
    ON lt_order_events (loan_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- 4. THE VENDOR RETURN NEEDS A THIRD DOOR ON A CONDITION'S DOCUMENTS
--
-- `lt_condition_files.uploaded_by_kind` was deliberately left as free text with a
-- comment saying a vendor door was coming; nothing has to change for it to file
-- one. What DOES need recording is WHICH order a document arrived on, so the
-- condition can say "this came back from the title company on the order we placed
-- on the 4th" rather than "somebody uploaded this".
-- ---------------------------------------------------------------------------
ALTER TABLE lt_condition_files ADD COLUMN IF NOT EXISTS order_id uuid;
ALTER TABLE lt_condition_files ADD COLUMN IF NOT EXISTS order_event_id uuid;

CREATE INDEX IF NOT EXISTS lt_condition_files_order_idx
    ON lt_condition_files (order_id) WHERE order_id IS NOT NULL;
