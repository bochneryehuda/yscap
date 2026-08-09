-- ============================================================================
-- 492 — Class Valuation callbacks: a delivery we cannot interpret must not hold
--       up the ones behind it.
--
-- db/490 gave the inbox `processed_at` and `process_error` and nothing else, which
-- made a failure PERMANENTLY RETRYABLE and permanently FIRST: the drain selects
-- `WHERE processed_at IS NULL ORDER BY received_at ASC LIMIT n`, so one delivery
-- that throws sits at the head of every batch forever. The receiver's own drain runs
-- at limit 25 — so 25 poison rows and no live event is ever processed by anything but
-- the five-minute poller, and 100 of them stops the poller too. That is a whole-inbox
-- outage caused by a single malformed payload, and it was reproduced against the real
-- receiver (a `data` array containing a null element) before this was written.
--
-- Three columns, one job each:
--   attempts        — how many times we have tried. Without a count there is no way
--                     to tell "new" from "hopeless".
--   next_attempt_at — when it may be tried again. This is what takes a failing row
--                     OUT of the front of the queue instead of leaving it there; the
--                     drain now orders by it, so a retry waits its turn behind live
--                     traffic rather than blocking it.
--   dead_at         — given up on. The row is KEPT and stays queryable (the delivery
--                     is evidence, and the whole point of the receiver is that a
--                     delivery is never lost); it simply stops being retried.
--
-- Deliberately NOT a separate dead-letter table: moving the row would break
-- `class_order_row`/`application_id` and the dedupe index that stops a redelivery
-- being stored twice. A flag on the row keeps both.
-- ============================================================================

ALTER TABLE class_callback_events ADD COLUMN IF NOT EXISTS attempts        integer NOT NULL DEFAULT 0;
ALTER TABLE class_callback_events ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
ALTER TABLE class_callback_events ADD COLUMN IF NOT EXISTS dead_at         timestamptz;

-- The drain's index. `next_attempt_at NULLS FIRST` because a row that has never been
-- tried has no scheduled time and must go first — a new delivery is never made to
-- wait behind a failing one.
DROP INDEX IF EXISTS idx_class_cb_unprocessed;
CREATE INDEX IF NOT EXISTS idx_class_cb_claimable
  ON class_callback_events (next_attempt_at NULLS FIRST, received_at)
  WHERE processed_at IS NULL AND dead_at IS NULL;

-- Everything already in the inbox is simply un-tried, which is what the defaults say.

-- ---------------------------------------------------------------------------
-- ...and the version is never SILENTLY assumed either.
--
-- db/490 declared `api_version text NOT NULL DEFAULT 'v1'`, which quietly contradicts
-- the rule the same file's header states: "when it is genuinely unknown … the handler
-- records the event and DECLINES to make a version-specific call rather than guessing
-- one." With a NOT NULL default, an insert that omits the column is stamped 2.6 and is
-- indistinguishable from one that really was placed on 2.6 — so `versionOf`'s
-- `known:false` branch became unreachable for any stored row, and the refusal it
-- guards could never happen. That matters for the case the code explicitly
-- anticipates: an order placed by hand in the Class portal and back-filled here.
--
-- Unknown must be representable. The CHECK still refuses anything that is neither
-- 'v1' nor 'v2' (a CHECK passes on NULL, which is the wanted behaviour), and every
-- order PILOT places still writes the column explicitly.
ALTER TABLE class_orders ALTER COLUMN api_version DROP DEFAULT;
ALTER TABLE class_orders ALTER COLUMN api_version DROP NOT NULL;
