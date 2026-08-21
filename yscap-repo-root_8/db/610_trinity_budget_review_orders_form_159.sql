-- ============================================================================
-- db/610 — Trinity budget review orders (form 159)
--
-- WHAT THIS IS FOR. Owner-directed 2026-08-21: "Add a Trinity workflow during
-- the file. This is something else from the Draw Center, which is a 159 Budget
-- Review … It's a separate workflow other than the drawer. It's within the file
-- only for ground-ups and maybe case by case for heavy rehabs."
--
-- A BUDGET REVIEW IS NOT A DRAW, AND THAT IS WHY IT IS ITS OWN TABLE. A draw is
-- a request to release money against work already done; this is an independent
-- read of the PLAN before the loan closes — the plans, the permits, the
-- contractor's numbers and the schedule. `trinity_inspection_orders` is
-- draw-shaped by construction (`portal_draw_request_id`, `sitewire_draw_id`,
-- and a status ladder that ends in 'entered', meaning entered as a draw), and a
-- review has none of those. Widening that table would have made every draw
-- query carry a "…and not a review" clause forever, and the one that forgot it
-- would be the one that broke.
--
-- ONE LIVE REVIEW PER FILE. `customer_key` is Trinity's EXACTLY-ONCE key — they
-- refuse a second order carrying one (409, which the order path adopts rather
-- than re-posting) — so it is unique here too, and the partial index below is
-- what makes "has this file already got one in flight?" a question the database
-- answers rather than a race between two clicks.
--
-- IDEMPOTENT: CREATE TABLE / CREATE INDEX IF NOT EXISTS throughout.
--
-- NO BACKFILL: nothing to migrate. No budget review has ever been ordered.
--
-- PRODUCT SEPARATION: RTL only. It references `applications`, which IS the RTL
-- product's table; the Long-Term side has no construction budget and does not
-- appear here.
-- ============================================================================

CREATE TABLE IF NOT EXISTS trinity_budget_reviews (
  id                  bigserial PRIMARY KEY,
  application_id      uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,

  -- Trinity's exactly-once key, ours to mint. `tbr-<application>` — one live
  -- review per file, which is what the product is: a read of the plan, not a
  -- repeating event like a draw.
  customer_key        text UNIQUE,

  -- 'requested' the desk asked for it, nothing sent yet · 'ordered' Trinity has
  -- it · 'report_received' their answer is back and filed · 'cancelled' the desk
  -- stood it down. Deliberately SHORTER than the draw ladder: there is no
  -- 'entered', because a review is never entered as a draw.
  status              text NOT NULL DEFAULT 'requested'
                        CHECK (status IN ('requested','ordered','report_received','cancelled')),

  trinity_order_id    bigint,
  trinity_project_id  bigint,

  -- The appraisal PDF that went WITH the order (the owner asked for it by name),
  -- and the appraisal whose figures rode on the property block. Recorded so
  -- "what did Trinity actually see?" is answerable later, when the file has
  -- moved on and a newer appraisal has superseded this one.
  appraisal_id        uuid,
  appraisal_document_id uuid,

  -- The report Trinity sends back, once it is filed onto the file.
  report_document_id  uuid,

  -- Why an order could not be placed, in the desk's own words — the gate's
  -- blockers, or Trinity's refusal. Cleared on a successful order.
  blocked_reason      text,

  -- The lease that makes "place the order" safe to press twice: one driver
  -- proceeds, a crashed run frees after ten minutes. Same shape as the draw
  -- order path, for the same reason.
  order_claimed_at    timestamptz,

  requested_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  ordered_at          timestamptz,
  ordered_by          uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tbrv_app ON trinity_budget_reviews (application_id, created_at DESC);

-- ONE LIVE REVIEW PER FILE, enforced by the database rather than by whoever
-- remembers to check. A cancelled one does not count — standing an order down
-- and ordering again is a real thing to do.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tbrv_live_per_file
  ON trinity_budget_reviews (application_id)
  WHERE status <> 'cancelled';

-- The poller reads open orders oldest-first, exactly as the draw poller does.
CREATE INDEX IF NOT EXISTS idx_tbrv_open
  ON trinity_budget_reviews (created_at)
  WHERE status = 'ordered';
