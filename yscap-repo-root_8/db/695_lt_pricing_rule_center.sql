-- ============================================================================
-- db/695 — lt pricing rule center
--
-- WHAT THIS CHANGES, AND WHY.
--
-- Owner-directed 2026-09-04: *"we want to add a rule center connected to the
-- general pricing engine. Separate section, not part of the general settings, a
-- separate center for pricing engine rules, where I can manually start adding
-- rules… it should actually be wired in so it should not populate and it should
-- add holdbacks… This should be the superpower. This should overwrite anything.
-- Even though a pricing engine comes up eligible, this should be able to make it
-- as ineligible."*
--
-- The problem it fixes is not a bug in our code. It is that the rate sheets do
-- not know our business. The owner's own examples: LoanNEX is missing state
-- disqualifiers for prepayment penalties (it offers a prepay in New Jersey on an
-- individual borrower, which no investor of ours allows); there are states we are
-- not licensed to lend in and a sheet will happily quote them; and certain
-- programs we refuse for certain states whatever the vendor says. Today every one
-- of those reaches an officer as a live, quotable price. This is the table that
-- lets a person write those rules down once and have every board obey them.
--
-- WHY A TABLE AND NOT A SETTING. The investor maps beside it are small, fixed
-- configurations — one row per investor, four fields. This is an ORDERED,
-- OPEN-ENDED, AUDITED set of documents: an unbounded number of rules, each with a
-- condition tree of unbounded depth, each individually enabled, ordered against
-- the others, and each carrying a history of who changed it. A settings key would
-- fight the per-key size limits on the day somebody wrote the fortieth rule, and
-- it has nowhere to put the history at all.
--
-- WHY TWO TABLES. A rule is a DOCUMENT (what it says now) and its changes are a
-- LOG (what it said before, and who moved it). The owner asked for audit logs;
-- a log that lives in a jsonb array on the row it describes is a log that is
-- rewritten by the very save it is meant to witness.
--
-- BACKFILL: none, and none is possible or wanted. Owner-directed, in as many
-- words: *"I don't want you to pre-fill the rule — I want to put in the rules
-- myself and test that it actually works."* The centre ships EMPTY. With no rules
-- the overlay is a no-op and every board is byte-for-byte what it is today, which
-- is also what makes this safe to deploy before anybody has written one.
--
-- PRODUCT SEPARATION. `lt_*` only, no reference to any RTL table, no RTL trigger.
--
-- IDEMPOTENT. `migrate-boot` replays EVERY file in db/ on EVERY boot, in
-- filename order. That is not a safety net, it is the contract: a statement
-- that throws on its second run breaks every future deploy, and migrate-boot
-- logs the failure and CONTINUES, so it breaks quietly.
-- ============================================================================

/*
 * ONE RULE.
 *
 * `when` is the condition tree and `then` is the list of things to do when it
 * matches. Both are jsonb because both are open-ended by design — the owner asked
 * for *"unlimited conditions for the rules"* — and both are validated by
 * `pricing/rules/logic.js` and `pricing/rules/actions.js` BEFORE anything is
 * written, so nothing unreadable can reach a board through this door.
 *
 * ⛔ THE COLUMN IS NOT THE VALIDATOR, AND THAT IS DELIBERATE. A CHECK constraint
 * over a rule tree would be a second copy of the grammar, in SQL, unable to
 * explain itself to the person who typed it. The refusal a person reads names the
 * field and says what is wrong with it; the column's job is to hold the answer.
 * What the column DOES enforce is the handful of facts no rule may be without.
 */
CREATE TABLE IF NOT EXISTS lt_pricing_rule (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- WHAT THE PERSON CALLED IT. Owner-directed: *"we can name every rule with a
  -- name."* It is required, and it is what every audit line, every board
  -- explanation and every ineligible reason is attributed to — a rule nobody can
  -- name is a rule nobody can find when a board looks wrong.
  name         text        NOT NULL,
  -- Free text the author leaves for the next reader. Never shown to a client.
  note         text,
  /*
   * WHICH ENGINE THIS RULE GOVERNS. `general` is the General Pricing Engine,
   * `combined` the Combined one, and `all` is both — the owner's *"overlays on
   * top of all the engines that we have"*. A column rather than an assumption, so
   * a rule written for one board is not silently applied to the other.
   */
  engine       text        NOT NULL DEFAULT 'all',
  -- Off by default is NOT the rule here: a person writing a rule in this centre
  -- is writing it to be used, and the screen makes the switch the last thing they
  -- touch. What matters is that the switch EXISTS, so a rule can be taken out of
  -- force without being deleted and losing its history.
  enabled      boolean     NOT NULL DEFAULT true,
  /*
   * THE ORDER RULES RUN IN. Lower first. It matters because the actions are not
   * all commutative — an ineligibility ends the row, and a holdback added before
   * a floor is applied is a different number from one added after — so the order
   * has to be a decision somebody made rather than whatever the database happened
   * to return. Ties break on `created_at`, then `id`, so two rules at the same
   * priority still run in a fixed, reproducible order.
   */
  priority     integer     NOT NULL DEFAULT 100,
  -- THE CONDITION TREE. `{}` is refused by the validator, not by the column:
  -- "this rule matches everything" is a thing a person might genuinely mean and
  -- the refusal for it belongs where it can be explained.
  "when"       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- WHAT TO DO. An array of actions, applied in the order written.
  "then"       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  /*
   * WHY A ROW IT BLOCKS IS BLOCKED, in the words a person will read on the board.
   * Owner-directed: *"anytime we select that to come up ineligible the message
   * should give why it's ineligible."* It lives on the ACTION, not here — an
   * action-level reason is what lets one rule refuse for two different reasons —
   * and this column is the rule's own fallback for an action that carries none.
   */
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid,
  -- A DELETED RULE IS KEPT. A rule that priced a loan last week is the
  -- explanation for that loan's price; deleting the row deletes the explanation.
  -- The screen's delete sets this, the reader skips it, and the audit still
  -- points at something.
  archived_at  timestamptz,
  archived_by  uuid
);

-- Every board read is "the rules in force, in order". This is that query.
CREATE INDEX IF NOT EXISTS lt_pricing_rule_live_idx
  ON lt_pricing_rule (priority, created_at, id) WHERE archived_at IS NULL AND enabled;
-- The centre itself lists everything, archived rules last.
CREATE INDEX IF NOT EXISTS lt_pricing_rule_listing_idx
  ON lt_pricing_rule (archived_at, priority, created_at);

/*
 * WHICH ENGINES A RULE MAY NAME. Re-asserted the two-step way (drop, then add)
 * because this file replays on every boot.
 *
 * ⛔ IT IS A CLOSED LIST ON PURPOSE. `engine` decides which boards obey the rule,
 * so a typo — 'genral' — would produce a rule that is on, valid, listed, and
 * silently governs nothing. That is the worst outcome available here: a licensing
 * block that looks armed and is not.
 */
ALTER TABLE lt_pricing_rule DROP CONSTRAINT IF EXISTS lt_pricing_rule_engine_chk;
ALTER TABLE lt_pricing_rule ADD CONSTRAINT lt_pricing_rule_engine_chk
  CHECK (engine IN ('all', 'general', 'combined'));

-- A rule with no name cannot be attributed on a board, in the audit, or in an
-- ineligible reason — which is every place it is ever mentioned.
ALTER TABLE lt_pricing_rule DROP CONSTRAINT IF EXISTS lt_pricing_rule_name_chk;
ALTER TABLE lt_pricing_rule ADD CONSTRAINT lt_pricing_rule_name_chk
  CHECK (length(btrim(name)) BETWEEN 1 AND 160);

/*
 * WHAT HAPPENED TO A RULE, AND WHO DID IT.
 *
 * Owner-directed: *"do research for audit logs."* Every create, edit, enable,
 * disable, re-order and archive lands here with the rule's WHOLE state before and
 * after, so "why did this loan price that way in March" is answerable from the
 * row rather than from somebody's memory.
 *
 * ⛔ NO FOREIGN KEY TO `lt_pricing_rule`, and that is not an oversight. The audit
 * outlives the rule: if a rule is ever hard-deleted (a mistake, a cleanup, a
 * restore), the history of what it did must not be deleted with it. The rule's
 * id and its name at the time are both stored, so a line is readable with no
 * rule to join to.
 */
CREATE TABLE IF NOT EXISTS lt_pricing_rule_event (
  id         bigserial PRIMARY KEY,
  rule_id    uuid,
  -- The rule's name AS IT WAS. Renaming a rule must not rewrite its history.
  rule_name  text,
  action     text        NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  by_staff   uuid,
  -- The whole rule, before and after. `before` is null on a create and `after` is
  -- null on nothing — an archive still has an after — so the pair reads as a diff
  -- without the reader having to reconstruct one.
  before     jsonb,
  after      jsonb,
  -- What the person said they were doing, where the screen asks.
  note       text
);

CREATE INDEX IF NOT EXISTS lt_pricing_rule_event_rule_idx
  ON lt_pricing_rule_event (rule_id, at DESC);
CREATE INDEX IF NOT EXISTS lt_pricing_rule_event_recent_idx
  ON lt_pricing_rule_event (at DESC);

-- The closed list of things that can happen to a rule. Same reasoning as
-- `engine` above: an unrecognised action is a line nobody can filter for.
ALTER TABLE lt_pricing_rule_event DROP CONSTRAINT IF EXISTS lt_pricing_rule_event_action_chk;
ALTER TABLE lt_pricing_rule_event ADD CONSTRAINT lt_pricing_rule_event_action_chk
  CHECK (action IN ('created', 'updated', 'enabled', 'disabled', 'reordered', 'archived', 'restored'));


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
