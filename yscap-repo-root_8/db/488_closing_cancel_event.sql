-- 488 — A CANCELLATION IS A FIRST-CLASS MESSAGE ON THE CLOSING CHAIN (owner-directed 2026-08-07)
--
-- The owner: *"You need to add a button by the closing prep after the order: Cancel Closing Prep,
--  which should send them a cancellation email to disregard this file, and then it should stop
--  sending them the updates: the signed term sheets, the updated closing date. There should be a
--  cancellation button. Once you click that cancellation button, the entire closing prep is
--  cancelled."*
--
-- The SILENCING half already worked: `closing-prep.attorneyEngaged` treats a `cancelled` attorney
-- order as an explicit stand-down, so `mayAnnounce` refuses every automatic update from that
-- moment on. What was missing is that nobody TOLD the attorney — the route's own comment said
-- "Emails nobody" — so outside counsel was left holding a file we had quietly stopped working,
-- with a term sheet they might still draft from.
--
-- `cancel` joins the event-kind list so the stand-down is recorded as what it is, rather than as a
-- generic 'manual' message. That matters on a chain we do not own: the message log is the only
-- record of what outside counsel was told, and "we sent them something by hand" is a materially
-- different answer to "we told them to stand down" when somebody asks months later why a closing
-- did not happen.
--
-- Widening a CHECK is idempotent by drop-and-recreate; the constraint name is the one Postgres
-- generated for the inline CHECK in db/359 (`closing_thread_messages_event_kind_check`).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'closing_thread_messages') THEN
    ALTER TABLE closing_thread_messages
      DROP CONSTRAINT IF EXISTS closing_thread_messages_event_kind_check;
    ALTER TABLE closing_thread_messages
      ADD CONSTRAINT closing_thread_messages_event_kind_check
      CHECK (event_kind IN ('order','followup','executed_term_sheet',
                            'closing_date','clear_to_close','manual','cancel'));
  END IF;
END $$;
