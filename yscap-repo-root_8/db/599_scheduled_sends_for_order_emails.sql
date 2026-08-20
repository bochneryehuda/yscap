-- ============================================================================
-- db/599 — scheduled sends for order emails
--
-- WHAT THIS CHANGES, AND WHY (owner-directed 2026-08-20). The Orders desk could
-- only send an order NOW. The owner: "If somebody wants to work in the middle of
-- the night but he wants it to go out in the morning, we need to add a
-- scheduling option by the order. For ordering title, but scheduled for this and
-- this time … just add an additional option with the small icon, like a time to
-- schedule the email instead of ordering it immediately."
--
-- A staffer working at 2am picks a time; the order goes out then. It covers the
-- four outbound order emails the owner named — title, insurance, closing prep
-- and investor delivery.
--
-- WHAT THIS TABLE IS, AND WHAT IT IS NOT. It holds the INTENT to send, never a
-- rendered email: no recipients, no subject, no attachments, no body. That is
-- deliberate and it is the whole safety argument. A message frozen at 2am and
-- posted at 8am is a message nothing re-checked — the file may have been
-- declined, the vendor contact replaced, the address re-verified, the loan
-- number filled in. So the row stores only WHICH send, on WHICH file, WITH WHAT
-- options, and at the due moment the dispatcher re-enters the ordinary send path
-- from the top: every blocker, every freeze, every exactly-once claim, and every
-- gate added to that path in future. See src/lib/scheduled-sends.js.
--
-- ONE PENDING SEND PER THING. `scheduled_sends_one_pending_uk` is partial on the
-- live states, so re-scheduling replaces rather than stacking two sends of one
-- order. A finished row (sent/failed/cancelled) is history and never blocks a
-- new one.
--
-- IDEMPOTENT — CREATE TABLE / CREATE INDEX IF NOT EXISTS, DROP-then-ADD on the
-- two CHECKs.
--
-- BACKFILL: NONE, and none is possible — nothing was scheduled before this
-- existed. Every existing order is unaffected: an order placed the ordinary way
-- never touches this table.
--
-- PRODUCT SEPARATION: RTL. `applications` is the RTL table and every order type
-- here is an RTL order; nothing references `lt_*`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS scheduled_sends (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- WHICH send. The dispatcher maps this to a handler; an unknown kind is
  -- refused at the door AND by this constraint, so a typo can never sit in the
  -- queue waiting to run something nobody meant.
  kind            text NOT NULL,
  -- The thing within the file, when there is one — the draw number for an
  -- investor delivery. '' (never NULL) for a send that is one-per-file, so the
  -- unique index below has a value to compare.
  target_key      text NOT NULL DEFAULT '',
  send_at         timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'scheduled',
  -- The options the person chose, exactly as the send path would have received
  -- them (cc the borrower, the extra addresses, the note). Never a rendered
  -- email. Redacted of nothing because nothing here is PII beyond addresses the
  -- file already holds.
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- WHOSE send. Re-resolved from staff_users at the due moment — a scheduled
  -- send inherits the scheduler's authority as it is THEN, never as it was.
  created_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Claim bookkeeping. `attempts` counts starts, so a row that keeps dying is
  -- visible rather than retrying for ever.
  attempts        int NOT NULL DEFAULT 0,
  claimed_at      timestamptz,
  sent_at         timestamptz,
  -- Why it did not go. Shown to the person who scheduled it, in their words.
  last_error      text,
  last_error_code text,
  cancelled_at    timestamptz,
  cancelled_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL
);

ALTER TABLE scheduled_sends DROP CONSTRAINT IF EXISTS scheduled_sends_kind_chk;
ALTER TABLE scheduled_sends ADD CONSTRAINT scheduled_sends_kind_chk
  CHECK (kind IN ('title_order','insurance_order','closing_prep','investor_delivery'));

ALTER TABLE scheduled_sends DROP CONSTRAINT IF EXISTS scheduled_sends_status_chk;
ALTER TABLE scheduled_sends ADD CONSTRAINT scheduled_sends_status_chk
  CHECK (status IN ('scheduled','sending','sent','failed','cancelled'));

-- ONE pending send per (file, kind, target). Partial, so history never blocks.
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_sends_one_pending_uk
  ON scheduled_sends (application_id, kind, target_key)
  WHERE status IN ('scheduled','sending');

-- The dispatcher's own query: the oldest thing that is due.
CREATE INDEX IF NOT EXISTS scheduled_sends_due_idx
  ON scheduled_sends (send_at)
  WHERE status = 'scheduled';

-- The desk's query: what is queued on this file.
CREATE INDEX IF NOT EXISTS scheduled_sends_app_idx
  ON scheduled_sends (application_id, status);

-- "What did I schedule?" — the queue screen, newest first.
CREATE INDEX IF NOT EXISTS scheduled_sends_creator_idx
  ON scheduled_sends (created_by, created_at DESC);
