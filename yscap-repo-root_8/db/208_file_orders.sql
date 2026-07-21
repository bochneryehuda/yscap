-- 208_file_orders.sql — the ORDERS desk (owner-directed 2026-07-20).
--
-- A loan file needs TITLE and INSURANCE ordered from outside vendors. Until now
-- that happened by hand outside the portal. This adds a first-class, per-file
-- Orders section: one row per (file, order type), tracking whether it has been
-- ordered, whom it went to, when, and how many follow-ups were sent — so the two
-- orders are tracked SEPARATELY and neither can be double-sent by a stray click.
--
-- The email side rides the existing Email Center (email_messages, scoped by
-- msg_type 'title_%' / 'insurance_%') and the per-file reply-to inbox — a UNIQUE
-- reply address per order (title+<id>@ / insurance+<id>@) lets a vendor's reply
-- and any returned documents land back on the right order. Documents the vendor
-- sends back are captured as ordinary `documents` rows tagged by doc_kind
-- ('title_order_return' / 'insurance_order_return') and start UNASSIGNED
-- (slot_label NULL) for the team to classify (binder / invoice / commitment / …).
--
-- The order requires the file's LOAN NUMBER (it prints in the mortgage clause)
-- and a vendor CONTACT (the title company / insurance agent) before it can send —
-- the same "fill the loan number before you order the term sheet" gate, enforced
-- in the route. Idempotent.

CREATE TABLE IF NOT EXISTS file_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- Which order this row tracks. One active row per (file, type).
  order_type        text NOT NULL CHECK (order_type IN ('title','insurance')),
  -- not_ordered → ordered → documents_in → completed (or cancelled).
  status            text NOT NULL DEFAULT 'not_ordered'
                    CHECK (status IN ('not_ordered','ordered','documents_in','completed','cancelled')),
  -- The vendor the order went to (a service_contacts row — title_company /
  -- insurance_agent), snapshotted by name/email so the history reads even if the
  -- contact is later edited or removed.
  vendor_contact_id uuid REFERENCES service_contacts(id) ON DELETE SET NULL,
  vendor_email      text,
  vendor_name       text,
  -- The subject line + conversation key of the order email thread (so the Email
  -- Center groups the order, its follow-ups and the vendor's replies together).
  subject           text,
  thread_key        text,
  ordered_at        timestamptz,
  ordered_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  last_followup_at  timestamptz,
  followup_count    int NOT NULL DEFAULT 0,
  send_count        int NOT NULL DEFAULT 0,   -- how many times the ORDER itself was sent (force re-sends)
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, order_type)
);

CREATE INDEX IF NOT EXISTS idx_file_orders_app ON file_orders (application_id);

-- Returned-document classification: a vendor's reply attachment is stored as an
-- ordinary documents row (so it shows in the Documents list / TPR like any other
-- file), tagged by doc_kind so the Orders desk can list "documents that came back
-- on this order". slot_label carries the human classification (Binder / Invoice /
-- Title commitment / CPL / …) and starts NULL = unassigned. review_status drives
-- accept/reject exactly like every other document. No new columns needed — this
-- comment records the convention so future readers know where returned docs live.
