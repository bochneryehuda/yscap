-- ============================================================================
-- db/629 — lt encompass nudge record
--
-- WHAT THIS CHANGES, AND WHY (owner-directed 2026-08-25). The owner asked to
-- see, on every long-term file, "the pull, the refresh, the last pull, last
-- refresh, last webhooks, and stuff like that". Four of those five are already
-- recorded on `lt_loans` (`encompass_synced_at`, `encompass_last_modified`,
-- `conditions_synced_at`, `encompass_sync_error`). THE WEBHOOK IS NOT RECORDED
-- ANYWHERE AT ALL.
--
-- `routes/encompass-hook.js` answers a nudge by clearing `encompass_synced_at`
-- and writing a line to the console. That is enough to make the loan re-read —
-- and it means the fact that Encompass told us anything survives only in a log
-- nobody can open from a loan file. So "is the webhook actually firing?" — the
-- owner's own question, twice — has no answer on any screen, and a webhook that
-- silently stopped would look exactly like one that never fires.
--
-- These three columns are that missing record: WHEN Encompass last asked us to
-- look at this loan, HOW the ping identified it, and HOW MANY times in total.
-- The count is what tells a quiet webhook from a broken one: "last nudged three
-- weeks ago, 41 times in total" and "never nudged" are different problems.
--
-- `encompass_nudged_via` is the SHAPE of the ping, not a status:
--   'guid'         — the payload named the loan by its Encompass GUID
--   'loan_number'  — the payload named it by YSCAP loan number
--   'sweep'        — a bare ping with no loan in it; PILOT asked Encompass which
--                    loans had changed and this was one of them (the tenant's
--                    own advanced code sends this shape)
--   'manual'       — a person pressed "Read this file from Encompass now"
--
-- IDEMPOTENT. Three `ADD COLUMN IF NOT EXISTS` and one `CREATE INDEX IF NOT
-- EXISTS`; every statement is a no-op from the second boot.
--
-- BACKFILL: NONE, deliberately. There is no history to recover — nothing has
-- ever written this fact down, so every existing row honestly reads "never
-- nudged" and fills in the first time a webhook arrives. Inventing a stamp from
-- `updated_at` would be a guess presented as a measurement, and the whole point
-- of these columns is to answer whether the webhook is firing.
--
-- PRODUCT SEPARATION. `lt_loans` is Long-Term's own table; nothing here reaches
-- into RTL.
-- ============================================================================

ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS encompass_nudged_at   timestamptz;
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS encompass_nudged_via  text;
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS encompass_nudge_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN lt_loans.encompass_nudged_at IS
  'When Encompass last asked PILOT to re-read this loan (a webhook, or a person pressing read-now). NULL means never — which is a real answer about the webhook, not missing data.';
COMMENT ON COLUMN lt_loans.encompass_nudged_via IS
  'How that last nudge identified the loan: guid | loan_number | sweep | manual. The SHAPE of the ping, never a status.';
COMMENT ON COLUMN lt_loans.encompass_nudge_count IS
  'How many nudges this loan has had in total. A recent stamp with a count of 1 and an old stamp with a count of 41 are different stories about the same webhook.';

-- The Encompass section on a file reads one row by id, so it needs no index.
-- This one answers the question a person asks when the webhook looks dead:
-- "has ANYTHING been nudged lately?" — newest first, over the few rows that
-- have ever been nudged at all.
CREATE INDEX IF NOT EXISTS lt_loans_encompass_nudged_at_idx
  ON lt_loans (encompass_nudged_at DESC)
  WHERE encompass_nudged_at IS NOT NULL;

-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself.
