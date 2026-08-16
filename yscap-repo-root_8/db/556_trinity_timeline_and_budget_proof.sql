-- 556_trinity_timeline_and_budget_proof.sql
-- Idempotent. Two things the 2026-08-16 deep verification proved we need, both about
-- KNOWING rather than assuming: a progress timeline Trinity cannot give us, and a
-- per-order proof that their system really did take our construction budget.
--
-- Still the GENERAL PHYSICAL PROGRAM only — a physical-inspection draw on a file whose
-- note buyer is NOT Blue Lake. Nothing here touches the Sitewire virtual pipeline or the
-- TrustPoint/Blue Lake pipeline, and nothing here delivers anything to a borrower.

-- ---------------------------------------------------------------------------
-- 1. THE PROGRESS TIMELINE — because Trinity has no history endpoint
-- ---------------------------------------------------------------------------
-- Owner-directed: *"our system keeps track of the progress with the status, scheduled,
-- inspected, and report back."*
--
-- VERIFIED 2026-08-16: Trinity exposes only the CURRENT status on the order
-- (`status`, `subStatus`, `percentComplete`, `modifiedAt`). `GET /orders/{id}/history`,
-- `/events`, `/statuses` and `/status` ALL answer 404 — there is no history to ask for.
-- db/552 stored the current status and a single `status_changed_at`, so each new status
-- OVERWROTE the last and the order's own progress was unanswerable the moment it moved
-- twice ("when did an inspector accept it?" had no answer once the report landed).
--
-- So the timeline is OURS: every transition the poller sees is appended here, and this
-- table is the only place the sequence exists. It is APPEND-ONLY — never update a row,
-- never delete one; a corrected reading is a NEW row.
CREATE TABLE IF NOT EXISTS trinity_order_events (
  id                        bigserial PRIMARY KEY,
  trinity_inspection_order_id bigint NOT NULL REFERENCES trinity_inspection_orders(id) ON DELETE CASCADE,
  application_id            uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- our own five-state ladder at the moment of the change (NULL = a Trinity status that
  -- says nothing about progress, e.g. "Change Date to Inspect")
  state                     text,
  -- Trinity's own words, kept verbatim so the desk can show exactly what they show
  trinity_status_id         int,
  trinity_status            text,
  trinity_substatus         text,
  -- what moved: 'status' (their status changed), 'ordered', 'scheduled', 'report',
  -- 'cancelled', 'delivered' (a human sent it to the borrower), 'note' (ours)
  kind                      text NOT NULL DEFAULT 'status',
  detail                    text,
  percent_complete          numeric(9,4),
  -- who/what recorded it: 'poller' | 'webhook' | 'staff' | 'order'
  source                    text NOT NULL DEFAULT 'poller',
  staff_id                  uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  occurred_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_toe_order ON trinity_order_events (trinity_inspection_order_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_toe_app ON trinity_order_events (application_id, occurred_at DESC);

-- A status is recorded ONCE. The poller re-reads the same order every few minutes, so
-- without this the timeline would gain an identical row on every tick and become
-- unreadable. A genuine re-entry into a status (a revision re-opening an order) carries
-- a different substatus or arrives after a different one, so the pair is the right key —
-- and a partial index keeps a hand-written 'note' row (which has no status) out of it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_toe_status_once
  ON trinity_order_events (trinity_inspection_order_id, trinity_status_id, COALESCE(trinity_substatus, ''))
  WHERE kind = 'status';

-- ---------------------------------------------------------------------------
-- 2. THE BUDGET PROOF — did their system really take our construction budget?
-- ---------------------------------------------------------------------------
-- Owner-directed: *"their system really understands our construction budget … really
-- understands how much was drawn already from each and every item … how we force them
-- to be linked together."*
--
-- Sending a budget is not the same as knowing it arrived. The order is placed, Trinity
-- answers 200, and until now nothing ever ASKED whether the budget they stored is the
-- budget we sent. So after every order we read their budget straight back and reconcile
-- it line by line against what we sent — the construction budget, the amount requested,
-- the money already drawn, and above all whether OUR key came back on every line.
--
-- `budget_verified_at` = we asked and it agreed. `budget_mismatch` = we asked and it did
-- NOT, in plain words for the desk. Both NULL = not asked yet.
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS budget_verified_at  timestamptz;
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS budget_mismatch     text;
-- What Trinity's own totals said at verification time — the number an inspector sees.
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS remote_budget_cents bigint;
ALTER TABLE trinity_inspection_orders ADD COLUMN IF NOT EXISTS remote_drawn_cents  bigint;

-- DELIBERATELY ABSENT: a photo-send counter. Loose inspection photographs are NOT sent
-- to Trinity (owner-directed 2026-08-16) — the previous inspection REPORT is attached
-- instead and already embeds them, with the findings that explain them. See the long
-- note in src/trinity/order.js for the measurements behind that decision.

-- Trinity's own line id, recorded on our crosswalk row so a support conversation can
-- name the exact line on their side. db/552 already has the column; this back-fills the
-- index that makes "which of our lines is their line 13286139?" answerable at all.
CREATE INDEX IF NOT EXISTS idx_tol_trinity_line ON trinity_order_lines (trinity_line_id)
  WHERE trinity_line_id IS NOT NULL;

COMMENT ON TABLE trinity_order_events IS
  'Append-only progress timeline for a Trinity inspection. Trinity has NO history endpoint (verified 2026-08-16: /history, /events, /statuses, /status all 404), so this table is the only record of the sequence.';
COMMENT ON COLUMN trinity_inspection_orders.budget_mismatch IS
  'Plain-language description of how Trinity''s stored budget differs from the one we sent. NULL with budget_verified_at set means it agreed to the cent.';
