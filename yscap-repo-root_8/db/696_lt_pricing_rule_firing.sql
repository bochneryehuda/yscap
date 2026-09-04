-- ============================================================================
-- db/696 — lt pricing rule FIRING LEDGER
--
-- WHAT THIS CHANGES, AND WHY.
--
-- Owner-directed 2026-09-04: *"The idea was to open audit engines to make sure
-- that every rule is actually firing."*
--
-- db/695 gave the rule centre an audit log of what happened TO a rule — who
-- wrote it, who edited it, who switched it off. That answers "who changed this".
-- It cannot answer the question the owner is actually asking, which is *"is this
-- rule doing anything?"* A rule can be saved, valid, enabled, correctly ordered,
-- and still never once touch a board — because its conditions never match, or
-- because it names a fact the board does not carry, or because a higher-priority
-- rule refuses every row before it gets there. Today all four of those look
-- EXACTLY like a rule that is working perfectly: the centre lists it, the switch
-- says on, and nothing anywhere says it has never fired.
--
-- That is the dangerous case, and it is dangerous in one direction only. A rule
-- that fires when it should not is visible — a price moves, an officer asks. A
-- LICENSING BLOCK THAT NEVER FIRES IS INVISIBLE, and the way you find out is
-- that you quoted a state you are not licensed in. This table is what makes that
-- case loud.
--
-- WHAT IS RECORDED. One row per rule per engine per day, holding counts: how
-- many boards the rule was in force on, how many it actually matched, how many
-- quotes it moved the price of, how many it refused, how many whole investors it
-- blocked, and how many times it could not be read at all. Plus the first and
-- last moment it did anything.
--
-- WHY COUNTS AND NOT ONE ROW PER FIRING. A board prices many quotes and boards
-- are priced all day; a row per firing would be an unbounded write amplification
-- on the hot pricing path, to answer a question that is about RATES, not
-- individual events. Rolled up by day, a shop with forty rules writes at most
-- forty rows a day per engine, and "has this ever fired, and when did it last"
-- is still exactly answerable. The per-loan detail already exists and is already
-- kept: the board's own explanation names every rule that touched it.
--
-- ⛔ THIS TABLE MUST NEVER COST A BOARD ITS PRICE. Writing to it is
-- fire-and-forget, off the request path, and every failure is swallowed —
-- `pricing/rules/ledger.js` holds that contract, and its tests hold it to it. An
-- audit trail that can take down pricing is worse than no audit trail, because
-- it fails on the busiest day.
--
-- BACKFILL: none, and none is possible. Nothing has been recorded until this
-- table exists, so every rule starts as "never fired" and earns its first row by
-- firing. The screen says exactly that rather than implying an old rule is dead.
--
-- PRODUCT SEPARATION. `lt_*` only, no reference to any RTL table, no RTL trigger.
--
-- IDEMPOTENT. `migrate-boot` replays EVERY file in db/ on EVERY boot, in
-- filename order. A statement that throws on its second run breaks every future
-- deploy, and migrate-boot logs the failure and CONTINUES, so it breaks quietly.
-- ============================================================================

/*
 * ONE RULE'S DAY ON ONE ENGINE.
 *
 * ⛔ NO FOREIGN KEY TO `lt_pricing_rule`, for the same reason db/695's event log
 * has none: the record of what a rule DID must outlive the rule itself. A rule
 * archived in March is the explanation for a March price, and a cascade would
 * delete the evidence along with the row.
 */
CREATE TABLE IF NOT EXISTS lt_pricing_rule_firing (
  rule_id          uuid        NOT NULL,
  -- The rule's name AS IT WAS on the day. Renaming a rule must not rewrite the
  -- history of what it did, and a row must stay readable with no rule to join to.
  rule_name        text,
  -- THE DAY, in UTC. The roll-up grain. `date` not `timestamptz` on purpose —
  -- this column is the bucket, and the two timestamps below carry the moments.
  day              date        NOT NULL,
  -- 'general' or 'combined' — the board that ran it. Kept apart rather than
  -- summed because "this rule has never fired on the combined board" is a real
  -- and different finding from "this rule has never fired".
  engine           text        NOT NULL,

  /*
   * IN FORCE, BUT NOT NECESSARILY MATCHING. The number of boards where this rule
   * was enabled and governed the engine — i.e. it was ASKED. This is the
   * denominator, and without it "matched 0 times" is unreadable: a rule that was
   * asked 4,000 times and never matched is a broken rule, and one that was asked
   * zero times is a rule on a board nobody has priced yet.
   */
  boards_seen      bigint      NOT NULL DEFAULT 0,
  -- Boards where it reached at least one quote. The numerator.
  boards_matched   bigint      NOT NULL DEFAULT 0,
  -- Quotes it reached, summed across boards.
  quotes_reached   bigint      NOT NULL DEFAULT 0,
  -- Quotes whose price it actually MOVED, counted off the finished board rather
  -- than off intent — a quote a higher-priority rule then refused is not on the
  -- board, and reporting it as adjusted claims a price the officer cannot see.
  quotes_adjusted  bigint      NOT NULL DEFAULT 0,
  -- Quotes it marked ineligible.
  quotes_refused   bigint      NOT NULL DEFAULT 0,
  -- Whole investor rows it took off the board.
  rows_blocked     bigint      NOT NULL DEFAULT 0,
  /*
   * TIMES IT COULD NOT BE READ. A rule whose actions or conditions do not parse
   * is reported by the overlay and never applied. That is the correct behaviour
   * and it is also SILENT — the rule sits in the centre looking armed. A non-zero
   * count here is the screen's cue to say so in red.
   */
  unreadable       bigint      NOT NULL DEFAULT 0,

  -- The first and last moment this rule did anything at all on this day.
  first_at         timestamptz,
  last_at          timestamptz,

  PRIMARY KEY (rule_id, day, engine)
);

/*
 * WHICH ENGINES MAY APPEAR. Same reasoning as db/695's `engine` check: a typo
 * would produce a bucket nothing ever reads, so the rule would look like it had
 * never fired while it was firing all day into a misspelt row.
 *
 * ⛔ NOTE THE DIFFERENCE FROM db/695. There, `engine` is what a rule GOVERNS and
 * 'all' is legal. Here it is which board actually RAN it, and 'all' is not a
 * board — a rule governing 'all' that fires on both writes two rows.
 */
ALTER TABLE lt_pricing_rule_firing DROP CONSTRAINT IF EXISTS lt_pricing_rule_firing_engine_chk;
ALTER TABLE lt_pricing_rule_firing ADD CONSTRAINT lt_pricing_rule_firing_engine_chk
  CHECK (engine IN ('general', 'combined'));

-- THE CENTRE'S OWN QUESTION: "show me every rule, newest activity first".
CREATE INDEX IF NOT EXISTS lt_pricing_rule_firing_rule_idx
  ON lt_pricing_rule_firing (rule_id, day DESC);
-- "What has been happening lately", across all rules.
CREATE INDEX IF NOT EXISTS lt_pricing_rule_firing_day_idx
  ON lt_pricing_rule_firing (day DESC);


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
