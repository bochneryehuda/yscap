-- ============================================================================
-- 425 — AN ORDER BECOMES A TRACKED THING (owner-directed 2026-08-03: raise the
-- grade of the whole order workflow — "more professional more aggressive nicer
-- easier to use").
--
-- db/211 recorded who an order went to and when. It had no due date, no owner, no
-- turnaround, no notes and no history — so PILOT could not answer the three
-- questions the desk exists for: which orders are late, who is chasing this one,
-- and which title company actually delivers. Vendor turnaround is the operational
-- problem lenders name most often, and we were not measuring it at all.
--
-- WHAT IS DELIBERATELY *NOT* HERE: a stored due date for every order. The date is
-- DERIVED from `ordered_at` + the SLA (src/lib/order-sla.js effectiveDueOn), which
-- means every order already on disk gets one the moment this ships — nothing to
-- back-fill, nothing that can drift out of step with the SLA, and no second copy
-- to keep honest. `due_on` below is ONLY a human's explicit override (a vendor who
-- told us Thursday), and it wins over the derivation.
--
-- Idempotent.
-- ============================================================================

ALTER TABLE file_orders
  -- A human's explicit due date. NULL = derive it (the normal case).
  ADD COLUMN IF NOT EXISTS due_on           date,
  -- Override the per-type SLA for THIS order, in business days. NULL = the type
  -- default (title 3, insurance 2, attorney 5 — order-sla.SLA_BUSINESS_DAYS).
  ADD COLUMN IF NOT EXISTS sla_days         int,
  -- WHO IS CHASING THIS. Defaults to the file's processor when the order is
  -- placed, but ANY staff member may be assigned (owner-directed: "and also any
  -- staff members"). ON DELETE SET NULL, never CASCADE — losing a staff row must
  -- never delete the order it was attached to.
  ADD COLUMN IF NOT EXISTS assigned_to      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_at      timestamptz,
  ADD COLUMN IF NOT EXISTS assigned_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  -- The first time the vendor answered at all — the responsiveness half of a
  -- scorecard, and a different fact from when the documents finally landed.
  ADD COLUMN IF NOT EXISTS first_response_at timestamptz,
  -- When the order was FINISHED. 'completed' has been in the status vocabulary
  -- since db/211 and nothing ever wrote it for title or insurance, so every order
  -- ever placed still sat on the desk looking outstanding.
  ADD COLUMN IF NOT EXISTS completed_at     timestamptz,
  -- A free note about THIS order ("they said Thursday", "wrong parcel, re-sent").
  ADD COLUMN IF NOT EXISTS notes            text;

-- The desk's own query is "every open order, oldest first", across files.
CREATE INDEX IF NOT EXISTS idx_file_orders_open
  ON file_orders (status, ordered_at)
  WHERE status IN ('ordered', 'documents_in');
CREATE INDEX IF NOT EXISTS idx_file_orders_assigned
  ON file_orders (assigned_to)
  WHERE assigned_to IS NOT NULL;

-- ---------------------------------------------------------------------------
-- ONE ROW PER STATE CHANGE. Without this the order's own history was
-- unanswerable: who placed it, who chased it, who reassigned it, when it was
-- cancelled and by whom. The file's audit_log carries the same events (and
-- activity.auditEvents surfaces them in the file feed for free), but this is the
-- ORDER's record — it survives independently of how the audit trail is queried,
-- and it is what the desk renders as a timeline.
--
-- `actor_id` is NULL for something the system did (a vendor's reply flipping the
-- order to documents_in, the retire sweep completing it) — which is exactly the
-- distinction a human reading the timeline needs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS file_order_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES file_orders(id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  order_type     text NOT NULL,
  -- What happened. Kept as free text with a CHECK rather than an enum so a new
  -- kind is one migration, not a type rewrite.
  kind           text NOT NULL CHECK (kind IN (
    'placed', 'resent', 'followed_up', 'replied', 'documents_in',
    'assigned', 'due_changed', 'note', 'completed', 'cancelled', 'reopened')),
  actor_id       uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_file_order_events_order
  ON file_order_events (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_order_events_app
  ON file_order_events (application_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- PREVIOUS AND FUTURE. Every order already on disk gets the history it can be
-- proven to have, from the columns it already holds — never a guess:
--   · `ordered_at` proves it was placed (by `ordered_by`, if we know).
--   · `status='documents_in'` proves the vendor answered; `updated_at` is the
--     closest honest timestamp we have for when, so `first_response_at` is
--     seeded from it rather than left blank on the whole back book.
-- Follow-ups are NOT reconstructed: `followup_count` says how many there were but
-- nothing records WHEN, and inventing timestamps for a timeline a human reads as
-- fact is worse than a timeline that starts where the record does.
-- Idempotent via NOT EXISTS on the (order, kind) pair.
-- ---------------------------------------------------------------------------
INSERT INTO file_order_events (order_id, application_id, order_type, kind, actor_id, detail, created_at)
SELECT o.id, o.application_id, o.order_type, 'placed', o.ordered_by,
       jsonb_build_object('backfilled', true, 'vendor', o.vendor_name), o.ordered_at
  FROM file_orders o
 WHERE o.ordered_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM file_order_events e WHERE e.order_id = o.id AND e.kind = 'placed');

UPDATE file_orders
   SET first_response_at = updated_at
 WHERE status = 'documents_in'
   AND first_response_at IS NULL
   AND updated_at IS NOT NULL;

-- An order on a file that is already FUNDED is finished, whatever the row says —
-- the desk was showing every deal we have ever closed as outstanding work.
-- Scoped to funded only: a declined or withdrawn file's order is 'cancelled'
-- territory, and cancelled means an explicit human stand-down that closes the
-- follow-up and reply doors, so it must never be applied by a migration.
UPDATE file_orders o
   SET status = 'completed', completed_at = COALESCE(o.completed_at, now()), updated_at = now()
  FROM applications a
 WHERE a.id = o.application_id
   AND a.status = 'funded'
   AND o.status IN ('ordered', 'documents_in');

INSERT INTO file_order_events (order_id, application_id, order_type, kind, actor_id, detail)
SELECT o.id, o.application_id, o.order_type, 'completed', NULL,
       jsonb_build_object('backfilled', true, 'reason', 'the loan funded')
  FROM file_orders o
 WHERE o.status = 'completed'
   AND NOT EXISTS (SELECT 1 FROM file_order_events e WHERE e.order_id = o.id AND e.kind = 'completed');
