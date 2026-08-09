-- ============================================================================
-- 493 — THE STAGING AREA. Nothing imported ever lands on the real track record.
--
-- Owner-directed 2026-08-09, and this is the whole reason the table exists:
-- "a lot of times maybe it can mess up different borrowers with the same name."
-- So a property found in public records is NOT a track-record line. It is a
-- CANDIDATE, sitting in its own table, until a person says otherwise — staff
-- click one button per property to promote it; a borrower confirms each one at
-- a time with its deal type.
--
-- ── TWO GATES, NOT ONE ──────────────────────────────────────────────────────
-- A staged row is structurally invisible to every count, tier, export and gate,
-- because it is in a DIFFERENT TABLE — not because a flag says to skip it. A
-- flag is a thing every future query must remember; a separate table is a thing
-- they cannot reach by accident. Then, when it IS promoted, the row it creates
-- in `track_records` is forced to `pending` by db/485's guard. Import, then
-- verify: two independent gates, and neither one is a boolean somebody can
-- forget to check.
--
-- ── SHAPE BORROWED FROM sync_review_queue (db/108) ──────────────────────────
-- Its partial-unique-open index is what makes a producer safe to RE-RUN: search
-- the same borrower twice and the second pass cannot duplicate a row that is
-- still staged, but a row somebody DECLINED stays declined and does not come
-- back. That is the property this needs, and it is the same one db/418's
-- track-record findings use. `source` is included from the start because db/328
-- had to add it to sync_review_queue later, once a second producer appeared.
--
-- ── NOTHING IS SILENTLY DROPPED ─────────────────────────────────────────────
-- `track_record_searches.skips` records every property the search FOUND and did
-- not stage, with the reason. A search that quietly returns 3 of 11 results
-- reads exactly like a borrower who only did 3 deals. This is also the
-- per-lookup audit trail that does not exist today — there is currently no
-- record anywhere of which public-record lookups PILOT has performed.
--
-- ── COST ────────────────────────────────────────────────────────────────────
-- `api_calls` is recorded per search because the vendor bills per call and the
-- owner has a hard monthly ceiling. It is a count of calls made, never a licence
-- to make them: the skip-trace prohibition (no contact enrichment, ever) is
-- enforced in code, not here.
--
-- Idempotent, additive, and reads nothing. `searches` is created BEFORE
-- `candidates` because candidates references it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS track_record_searches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  borrower_id  uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
  run_by       uuid REFERENCES staff_users(id),        -- NULL = the borrower ran it
  run_at       timestamptz NOT NULL DEFAULT now(),
  query        jsonb,          -- {names:[], entities:[], states:[]} — what we asked
  found_count  int,
  staged_count int,
  skipped_count int,
  -- [{address, why}] — EVERY result that was found and not staged, with its
  -- reason. A silent cap reads as "this borrower has done fewer deals".
  skips        jsonb,
  api_calls    int,
  error        text
);

CREATE INDEX IF NOT EXISTS idx_trs_borrower ON track_record_searches(borrower_id, run_at DESC);

COMMENT ON TABLE track_record_searches IS
  'db/493. One row per public-records lookup: what was asked, what came back, what was staged, '
  'and WHY everything else was not. Also the per-lookup audit trail and the per-lookup API-call '
  'count, which no other table records today.';

CREATE TABLE IF NOT EXISTS track_record_candidates (
  id                bigserial PRIMARY KEY,
  borrower_id       uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
  search_id         uuid REFERENCES track_record_searches(id) ON DELETE SET NULL,
  source            text NOT NULL DEFAULT 'elementix',

  -- The vendor record VERBATIM. Never edited, never normalized in place — the
  -- parsed columns below are derived FROM it, so a parsing bug can be corrected
  -- by re-deriving rather than by re-fetching (and re-paying).
  raw               jsonb NOT NULL,

  property_address  jsonb,
  deal_type         text,
  purchase_price    numeric(14,2),
  purchase_date     date,
  sale_price        numeric(14,2),
  sale_date         date,
  entity_name       text,
  entity_state      text,
  -- Resolved at STAGE time, not at import time, so a reviewer sees which entity
  -- this would attach to before they press the button.
  proposed_llc_id   uuid REFERENCES llcs(id) ON DELETE SET NULL,

  -- The re-run key. Same property from the same source = same key, so a second
  -- search cannot stage it twice.
  dedupe_key        text NOT NULL,

  -- Does this already exist on the real record? Answered at stage time so the
  -- reviewer is choosing between "add" and "this is the line you already have",
  -- rather than discovering the duplicate afterwards.
  match_track_record_id uuid REFERENCES track_records(id) ON DELETE SET NULL,
  match_confidence  text CHECK (match_confidence IN ('exact','near','none')),
  match_why         jsonb,

  status            text NOT NULL DEFAULT 'staged'
                    CHECK (status IN ('staged','imported','merged','declined','snoozed')),
  resolution_note   text,
  internal_notes    text,        -- staff-only, never borrower-facing
  imported_track_record_id uuid REFERENCES track_records(id) ON DELETE SET NULL,
  snoozed_until     timestamptz,
  decided_by        uuid REFERENCES staff_users(id),
  decided_at        timestamptz,
  claimed_by        uuid REFERENCES staff_users(id),
  claimed_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- THE RE-RUN GUARD. Partial on 'staged' deliberately: running the search again
-- cannot duplicate an open candidate, but a DECLINED one stays declined and is
-- never resurrected — the db/108 / db/418 property.
CREATE UNIQUE INDEX IF NOT EXISTS uq_trc_staged
  ON track_record_candidates(borrower_id, dedupe_key) WHERE status = 'staged';

-- The review queue itself.
CREATE INDEX IF NOT EXISTS idx_trc_open
  ON track_record_candidates(borrower_id, created_at) WHERE status = 'staged';

-- "Have we already decided about this property?" — read BEFORE staging, so a
-- re-run does not re-ask a question somebody has answered.
CREATE INDEX IF NOT EXISTS idx_trc_decided
  ON track_record_candidates(borrower_id, dedupe_key, status);

COMMENT ON TABLE track_record_candidates IS
  'db/493. The staging area for properties found in public records. A staged row is invisible to '
  'every count, tier, export and gate because it is in a DIFFERENT TABLE — not because a flag says '
  'to skip it. Promotion creates a track_records row, which db/485 then forces to pending: two '
  'independent gates. Owner-directed — imports never land on the real record, because "a lot of '
  'times maybe it can mess up different borrowers with the same name".';

COMMENT ON COLUMN track_record_candidates.raw IS
  'The vendor record verbatim. The parsed columns are derived FROM this, so a parsing bug is fixed '
  'by re-deriving rather than by re-fetching — which matters because the vendor bills per call.';

COMMENT ON COLUMN track_record_candidates.status IS
  'staged = waiting for a person. imported = promoted to a real line. merged = folded into an '
  'existing line. declined = a person said no, and the partial unique index means it never '
  'comes back. snoozed = ask again later.';
