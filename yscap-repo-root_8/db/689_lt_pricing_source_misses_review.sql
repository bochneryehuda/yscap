-- ============================================================================
-- db/689 — lt pricing source misses review
--
-- WHAT THIS CHANGES, AND WHY. The General Pricing Engine now takes five
-- investors from LoanNEX instead of Lender Price. When LoanNEX is asked, answers,
-- and simply does not carry one of them, the owner directed (2026-09-03) that the
-- investor is left off the board SILENTLY — *"leave it out silently and send the
-- notification to the super admin email"* — because once an investor is switched
-- over, the Lender Price copy of its pricing is second-hand and showing it would
-- be quoting a sheet we have stopped trusting for that investor.
--
-- Silently for the OFFICER. Not silently for us: *"a manual review section
-- recording the scenario, which investor LoanNEX missed, and whether Lender Price
-- had it, so the cause can be dug into."* This is that record. One row per
-- (investor, day), counted rather than repeated, so a bad afternoon is one line
-- with a count and not two thousand.
--
-- WHY A TABLE AND NOT A SETTING. The three investor maps beside it are small,
-- deliberate configurations a person edits. This is a LOG — it grows with
-- traffic, it is read by date, and it is dug into. A settings row would be the
-- wrong shape and would fight the per-key size limits the moment a busy day
-- landed.
--
-- BACKFILL: none, and none is possible. Nothing has recorded a miss before this
-- file exists, so the review section is empty until the next search that has one
-- to report. The very first row is the first real miss, which is what makes it
-- worth reading.
--
-- PRODUCT SEPARATION. `lt_*` only, no reference to any RTL table, no RTL trigger.
--
-- IDEMPOTENT. `migrate-boot` replays EVERY file in db/ on EVERY boot, in
-- filename order. That is not a safety net, it is the contract: a statement
-- that throws on its second run breaks every future deploy, and migrate-boot
-- logs the failure and CONTINUES, so it breaks quietly.
-- ============================================================================

/*
 * ONE ROW PER INVESTOR PER DAY. `seen_day` is the calendar day the miss was
 * recorded on, and the unique index over (investor_key, seen_day) is what makes a
 * repeat an UPDATE of the count rather than another row. A single busy search
 * asks the sheets once per DSCR band, so without it one officer pressing Search
 * once would file seven identical rows.
 */
CREATE TABLE IF NOT EXISTS lt_pricing_source_misses (
  id             bigserial PRIMARY KEY,
  investor_key   text        NOT NULL,
  investor_label text,
  -- The sheet that was asked and did not carry them. A column rather than an
  -- assumption, so a third rate sheet added later files its own misses here.
  source         text        NOT NULL DEFAULT 'loannex',
  seen_day       date        NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  -- How many searches hit it that day. The reason this is a count and not a row
  -- each: the question a reviewer asks is "is this every search or was it one
  -- odd scenario", and a count answers it at a glance.
  hits           integer     NOT NULL DEFAULT 1,
  /*
   * DID THE OTHER SHEET HAVE THEM? The owner's own question, and the one that
   * separates "LoanNEX is having a bad day" from "this investor genuinely has no
   * product for this loan". NULL means we could not tell.
   */
  other_source_had boolean,
  /*
   * THE SCENARIO, AS THE SEARCH RAN IT. Enough to reproduce the miss and no more:
   * the loan's shape, never a borrower, never a name, never a document. The
   * writer decides what goes in here; the column simply holds it.
   */
  scenario       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- The most recent search's own note, so a reviewer can see whether the sheet
  -- answered at all and what it said about itself.
  note           text,
  reviewed_at    timestamptz,
  reviewed_by    uuid,
  review_note    text
);

CREATE UNIQUE INDEX IF NOT EXISTS lt_pricing_source_misses_day_uk
  ON lt_pricing_source_misses (investor_key, source, seen_day);

-- The review section reads newest first, and the alert asks "have we already told
-- them about this investor today".
CREATE INDEX IF NOT EXISTS lt_pricing_source_misses_recent_idx
  ON lt_pricing_source_misses (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS lt_pricing_source_misses_open_idx
  ON lt_pricing_source_misses (reviewed_at) WHERE reviewed_at IS NULL;

/*
 * WHETHER THE SUPER ADMIN HAS BEEN TOLD, on this row. Kept ON THE ROW rather than
 * in a separate log so "did anybody hear about this?" is answerable from the one
 * place a reviewer is already looking — and so the claim is made with an
 * IS NULL-guarded UPDATE, which is what stops two searches finishing at once from
 * both sending the same email.
 */
ALTER TABLE lt_pricing_source_misses ADD COLUMN IF NOT EXISTS alerted_at timestamptz;


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
