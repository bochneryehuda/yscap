-- ============================================================================
-- 499 — THE DERIVED EXIT DATE, THE HOLD PERIOD, AND THE SELLER NAME.
--
-- ── counts_from / hold_days ARE GENERATED, NOT TRIGGER-MAINTAINED ───────────
-- The blueprint asked for the exit date "materialized". The obvious way is a
-- trigger, and it is the wrong way HERE for a reason this repo keeps re-learning:
-- a second copy of a rule drifts from the first. `src/lib/tpr-export.js` carried
-- its OWN exit-date order and a 30.44-day "month", so the investor package and
-- the count that prices the deal disagreed about which day a hold exited — the
-- same class as `pilot_term_norm` / `pilot_property_type_norm`.
--
-- A GENERATED ALWAYS ... STORED column cannot drift AT RUNTIME: there is no
-- write path that can set it to something else, no trigger ordering to reason
-- about, and no backfill to remember. What it can still do is drift IN SOURCE
-- from `experience.EXIT_DATE_SQL`, so the expression below is copied from that
-- constant and `scripts/test-track-record-derived-db.js` pins the two together by
-- EVALUATING both over a battery of rows — not by comparing their text, which
-- would break on whitespace and prove nothing about behaviour.
--
-- THE EXPRESSION IS THE OWNER-AUTHORIZED ONE (2026-08-09): a flip exits on its
-- sale, a hold on lease-up or refi, and a ground-up falls back to whichever
-- completion it has when the base rule left it none. Written as a COALESCE OVER
-- the old rule, so it can only ever ADD an exit date — see experience.js.
--
-- COST, stated plainly: adding a STORED generated column REWRITES the table and
-- takes an ACCESS EXCLUSIVE lock for the duration. `track_records` is a
-- thousands-of-rows table, so this is seconds, not minutes — but it is not free,
-- and it is why both columns are added in ONE statement rather than two.
--
-- NEITHER COLUMN IS MATERIAL to db/493's verify guard, and neither may ever be
-- added to it. Both are pure functions of columns that are ALREADY material, so
-- watching them would fire the guard twice for one edit; and a derived value
-- moving because its inputs moved is a re-derivation, not a restatement — the
-- same reasoning db/485 records for `address_key`.
--
-- ── hold_days IS DISPLAYED AND NEVER GATED ──────────────────────────────────
-- Owner-directed 2026-08-09: "I don't care about such a short hold period."
-- Real presentable flips were found at 11 days, 13 days and 2 days. The number
-- is shown to a reviewer as context and MUST NOT become a threshold anywhere.
--
-- ── seller_name: A FIELD THAT WAS BEING COLLECTED AND THROWN AWAY ───────────
-- The track-record tool's spreadsheet importer has always mapped "Seller" and
-- "Seller name" onto a `seller` field (web/(v2/)tools/track-record.js), and
-- `blankProp` carries it — but there was no column, the portal bridge sends it
-- as `seller: ""` on every load, and the server never accepted it. So a borrower
-- who pasted a spreadsheet with a Seller column had that data parsed into the
-- tool and silently dropped, and it came back blank next time they opened it.
--
-- It is worth a column beyond simply not losing what people typed: the seller's
-- name is how a RELATED-PARTY exit is spotted — a "sale" to the borrower's own
-- other entity produces perfect public records and is not an arm's-length exit.
-- That is the `related_party_exit` finding in the blueprint, and it cannot be
-- computed without this.
--
-- NOT material to the verify guard: the seller's name does not change which
-- property this is or what the deal was, and making it material would un-verify
-- a line for filling in a blank.
--
-- Idempotent, additive. Reads nothing, writes nothing, deletes nothing.
-- ============================================================================

-- One statement: a STORED generated column rewrites the table, and two separate
-- ALTERs would rewrite it twice.
ALTER TABLE track_records
  ADD COLUMN IF NOT EXISTS counts_from date
    GENERATED ALWAYS AS (
      COALESCE(
        (CASE WHEN lower(coalesce(deal_type,'')) LIKE '%flip%' THEN sale_date
              ELSE COALESCE(rent_date, refi_date) END),
        CASE WHEN (lower(coalesce(deal_type,'')) LIKE '%ground%'
                OR lower(coalesce(deal_type,'')) LIKE '%construction%')
             THEN COALESCE(sale_date, rent_date, refi_date) END)
    ) STORED,
  ADD COLUMN IF NOT EXISTS hold_days int
    GENERATED ALWAYS AS (
      (COALESCE(
        (CASE WHEN lower(coalesce(deal_type,'')) LIKE '%flip%' THEN sale_date
              ELSE COALESCE(rent_date, refi_date) END),
        CASE WHEN (lower(coalesce(deal_type,'')) LIKE '%ground%'
                OR lower(coalesce(deal_type,'')) LIKE '%construction%')
             THEN COALESCE(sale_date, rent_date, refi_date) END)
       - purchase_date)
    ) STORED,
  ADD COLUMN IF NOT EXISTS seller_name text;

-- The workspace's own sort ("newest exits first") and the 36-month window's own
-- filter. Partial: a line with no exit has nothing to order by.
CREATE INDEX IF NOT EXISTS idx_track_records_counts_from
  ON track_records(borrower_id, counts_from DESC)
  WHERE counts_from IS NOT NULL;

COMMENT ON COLUMN track_records.counts_from IS
  'GENERATED. The derived exit date — the SAME expression as experience.EXIT_DATE_SQL, copied from '
  'that constant and pinned to it by test-track-record-derived-db.js, which EVALUATES both rather '
  'than comparing their text. Generated rather than trigger-maintained so no write path can set it '
  'to something else. NEVER add it to the verify guard: it is a pure function of columns that are '
  'already material, so watching it would fire the guard twice for one edit.';

COMMENT ON COLUMN track_records.hold_days IS
  'GENERATED. Exit date minus purchase date. DISPLAYED AND NEVER GATED (owner-directed 2026-08-09: '
  '"I don''t care about such a short hold period" — real presentable flips exist at 2, 11 and 13 '
  'days). Do not make this a threshold anywhere.';

COMMENT ON COLUMN track_records.seller_name IS
  'Who they bought it FROM. The tool''s spreadsheet importer has always parsed a Seller column and '
  'then dropped it for want of a column. Beyond not losing it: a "sale" to the borrower''s own other '
  'entity is not an arm''s-length exit, and the related_party_exit finding cannot be computed '
  'without this. Not material to the verify guard — filling in a blank must not un-verify a line.';
