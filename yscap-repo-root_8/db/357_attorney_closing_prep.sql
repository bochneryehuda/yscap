-- ============================================================================
-- 357 — ATTORNEY CLOSING PREP ORDER + the per-closing EMAIL CHAIN
-- (owner-directed 2026-07-28).
--
-- Two linked things.
--
-- (1) A THIRD order type on the existing Orders desk (db/211): `attorney`.
--     "Order attorney closing prep" sits beside Title and Insurance and reuses
--     the whole desk — one row per (file, order type), the same statuses, the
--     same follow-up counters, the same returned-document flow. Nothing about
--     title/insurance changes; the CHECK is simply widened.
--
-- (2) A CLOSING EMAIL CHAIN per file — the real reason this exists.
--     The order emails the closing attorney with the initial term sheet and
--     every supporting document, from a UNIQUE, RANDOM reply address:
--         closing+<token>@<CHAT_REPLY_DOMAIN>
--     The token is opaque and per-file (NOT the application id) because the
--     address is printed IN the email body and typed by an outside attorney —
--     it must be short, and it must not leak an internal identifier.
--
--     The point of the token is what happens NEXT. A closing attorney does not
--     reply to our email; they open a BRAND-NEW chain with the title company,
--     the settlement agent, the realtor and our team, and work the closing
--     there. We ask them to keep the unique address on that chain, so:
--       · every email on it lands on THIS file,
--       · it joins the file's ONE closing thread no matter what subject they
--         chose (the thread key is stored here, not derived from the subject),
--       · and every attachment files into the file's CLOSING CORRESPONDENCE
--         package (doc_kind 'closing_correspondence') — deliberately NOT the
--         post-closing "closing package" item, which is the final executed set.
--
--     `closing_thread_messages` is the chain itself: one row per message WE put
--     on it, carrying (a) the RFC Message-ID we stamped so later sends can
--     reference it (In-Reply-To / References — real client-side threading, not
--     just a matching subject), and (b) a dedupe_key so the AUTOMATIC follow-ups
--     (the executed term sheet, a new expected closing date, clear-to-close)
--     can never double-send. The unique index on (thread_id, dedupe_key) IS the
--     idempotency guarantee — a caller that re-fires simply loses the insert.
--
-- Idempotent, and safe on a database that has never had an attorney order.
-- ============================================================================

-- ---------------------------------------------------------------- (1) the order
-- Widen the order-type CHECK. Dropping first makes this re-runnable; the new
-- constraint is a strict superset, so no existing row can fail it.
ALTER TABLE file_orders DROP CONSTRAINT IF EXISTS file_orders_order_type_check;
ALTER TABLE file_orders
  ADD CONSTRAINT file_orders_order_type_check
  CHECK (order_type IN ('title','insurance','attorney'));

-- ------------------------------------------------- (2) the closing email chain
-- ONE chain per file (UNIQUE application_id): the attorney order opens it, and
-- every later closing email — ours and theirs — rides it.
CREATE TABLE IF NOT EXISTS closing_threads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
  -- The random local-part token: closing+<token>@<domain>. Opaque, lowercase,
  -- unique across every file. Never derived from the application id.
  token             text NOT NULL UNIQUE,
  -- The email_messages.thread_key every message on this chain is filed under.
  -- Stored (not recomputed from a subject) precisely because the attorney will
  -- pick their own subject — that is the whole feature.
  thread_key        text NOT NULL,
  -- The canonical subject of the chain, so our own follow-ups can reuse it and
  -- stay threaded in Gmail/Outlook even where a Message-ID is rewritten.
  subject           text,
  -- The Message-ID of the FIRST message we sent (the References root) and of the
  -- most recent one (the In-Reply-To target for the next send).
  root_message_id   text,
  last_message_id   text,
  opened_at         timestamptz,
  opened_by         uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  -- Stats, so the desk can say "4 emails on the closing chain, 3 documents in"
  -- without scanning email_messages.
  inbound_count     int NOT NULL DEFAULT 0,
  outbound_count    int NOT NULL DEFAULT 0,
  docs_count        int NOT NULL DEFAULT 0,
  last_activity_at  timestamptz,
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_closing_threads_app ON closing_threads (application_id);

-- Every message WE put on the chain. `dedupe_key` is what makes the automatic
-- follow-ups safe to fire from anywhere (an e-sign webhook can be redelivered, a
-- status route can be double-clicked, a boot sweep can re-run).
CREATE TABLE IF NOT EXISTS closing_thread_messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id         uuid NOT NULL REFERENCES closing_threads(id) ON DELETE CASCADE,
  application_id    uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  seq               int  NOT NULL DEFAULT 1,
  -- What kind of message this was. 'order' is the closing-prep request itself;
  -- the rest are the automatic updates that must ride the SAME chain.
  event_kind        text NOT NULL
                    CHECK (event_kind IN ('order','followup','executed_term_sheet',
                                          'closing_date','clear_to_close','manual')),
  -- Stable per-event identity, e.g. 'executed_term_sheet:<envelopeId>' or
  -- 'closing_date:2026-08-14'. NULL for messages a human deliberately re-sends.
  dedupe_key        text,
  message_id        text,          -- the RFC Message-ID we stamped on this send
  in_reply_to       text,
  subject           text,
  to_emails         jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc_emails         jsonb NOT NULL DEFAULT '[]'::jsonb,
  attachments       jsonb NOT NULL DEFAULT '[]'::jsonb,
  status            text NOT NULL DEFAULT 'sent',
  error             text,
  sent_by           uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  sent_at           timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_closing_thread_msgs_thread
  ON closing_thread_messages (thread_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_closing_thread_msgs_app
  ON closing_thread_messages (application_id);

-- THE idempotency guarantee for every automatic follow-up. Partial, so a manual
-- re-send (dedupe_key NULL) is always allowed.
CREATE UNIQUE INDEX IF NOT EXISTS closing_thread_msgs_dedupe_uk
  ON closing_thread_messages (thread_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
