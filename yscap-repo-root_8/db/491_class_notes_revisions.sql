-- ============================================================================
-- 491 — Class Valuation: the conversation, and the asks.
--
-- db/490 records the ORDER and receives their callbacks. This adds the two-way
-- working relationship on top of it, which is what an appraisal desk actually spends
-- its time on:
--
--   * NOTES — messages back and forth with Class about a live order. Their API calls
--     them notes and stamps each one with a DIRECTION (ToClient = they wrote it,
--     FromClient = we did), which is exactly a thread. Ours arrive by us posting;
--     theirs arrive either on the NewNotes callback or on a read of their list.
--   * REVISIONS — a formal "please fix this on the report" against a CLOSED list of
--     reason codes, and the same mechanism carries a RECONSIDERATION OF VALUE (Class
--     has no separate ROV endpoint; an ROV is a revision whose reason is one of the
--     value-related ones). Also the GSE-data revision, which is a different thing on
--     a different endpoint and is kept apart rather than blurred into the same row.
--
-- A WORD ON VERSIONS, because it is the opposite of what db/490 needed. Ordering and
-- reading an order ARE version-specific (`/orders` vs `/v2/orders`). Notes,
-- revisions, cancellations and attachments are NOT — the guide documents exactly one
-- path for each, shared by both UAD versions. So nothing in these tables carries a
-- version: the order it hangs off already records one, and duplicating it here would
-- invite the two to disagree.
--
-- Additive and idempotent. RTL only.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The thread. One row per note in either direction.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS class_notes (
  id                bigserial PRIMARY KEY,
  class_order_row   bigint NOT NULL REFERENCES class_orders(id) ON DELETE CASCADE,
  application_id    uuid REFERENCES applications(id) ON DELETE SET NULL,

  -- Their id for the note. NULL for one of ours that has not been accepted yet.
  class_note_id     text,
  -- Their vocabulary, kept verbatim rather than translated: 'ToClient' = Class wrote
  -- it, 'FromClient' = we did. Translating it into "inbound/outbound" here would mean
  -- every future reader has to check which end "in" meant.
  direction         text NOT NULL CHECK (direction IN ('ToClient','FromClient')),
  content           text,

  -- Ours only: who typed it, and whether it actually reached Class.
  author_staff_id   uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  sent_at           timestamptz,
  send_error        text,

  -- Theirs only: when Class says it was created.
  vendor_created_at timestamptz,
  -- Read receipts, so the desk can show what is new without a second table.
  read_at           timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_class_notes_order ON class_notes (class_order_row, created_at DESC);
-- Their id is the identity of a note once we have one. PARTIAL, so the many rows of
-- ours that have not been accepted yet never collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_class_notes_vendor_id
  ON class_notes (class_note_id) WHERE class_note_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_class_notes_unread
  ON class_notes (class_order_row) WHERE direction = 'ToClient' AND read_at IS NULL;

-- ---------------------------------------------------------------------------
-- The asks. A revision, a reconsideration of value, or a GSE-data revision.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS class_revisions (
  id                bigserial PRIMARY KEY,
  class_order_row   bigint NOT NULL REFERENCES class_orders(id) ON DELETE CASCADE,
  application_id    uuid REFERENCES applications(id) ON DELETE SET NULL,

  -- 'revision'  — an ordinary correction request
  -- 'rov'       — a reconsideration of value. THE SAME ENDPOINT as a revision; the
  --               distinction is which reason codes were used, and it is recorded
  --               because "did we dispute the value on this file?" is a question the
  --               reason codes alone answer badly.
  -- 'gse'       — a GSE data revision (a different endpoint entirely)
  -- 'cancel'    — a cancellation request (same reason vocabulary)
  kind              text NOT NULL DEFAULT 'revision' CHECK (kind IN ('revision','rov','gse','cancel')),

  -- What we sent, exactly. Their reasons are a closed list and the free-text sits
  -- beside each code, so the whole array is kept rather than a flattened summary.
  reasons           jsonb,
  -- ROV only: the comparable sales we put forward, so the ask is answerable later.
  supporting        jsonb,
  note              text,

  status            text NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested','sent','accepted','declined','completed','error')),
  transaction_id    text,
  vendor_response   jsonb,
  last_error        text,

  requested_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz,
  resolved_at       timestamptz
);

CREATE INDEX IF NOT EXISTS idx_class_rev_order ON class_revisions (class_order_row, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_class_rev_open ON class_revisions (class_order_row)
  WHERE status IN ('requested','sent');
