-- ============================================================================
-- db/648 — a long-term table carries NO trigger, and the two the VOR work added
--          are removed.
--
-- WHAT THIS CHANGES, AND WHY. `scripts/test-lt-loan-schema-db.js` asserts,
-- against the database itself, that there is not ONE non-internal trigger on any
-- `lt_*` table:
--
--     SELECT count(*) FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
--      WHERE NOT tg.tgisinternal AND c.relname LIKE 'lt\_%'
--
-- db/645 added two `updated_at` touch triggers with the VOR tables, and they
-- were the only two in the whole long-term schema — so that check went red.
--
-- THE RULE IS THE SEPARATION LAW, NOT A STYLE PREFERENCE. "No RTL trigger may
-- fire on an LT table (and the reverse)" is one of the ten product-separation
-- rules, and a blanket ZERO is what makes it CHECKABLE: a count is either zero
-- or it is not, and nobody has to judge whether a particular trigger reaches
-- across. The moment the long-term schema carries triggers of its own, that
-- check has to start reading trigger BODIES to tell a safe one from a crossing —
-- which is exactly the kind of judgement a guard cannot make reliably. Cheap and
-- absolute beats clever and nearly right.
--
-- IT IS ALSO THE CONVENTION THE REST OF THE LONG-TERM SCHEMA ALREADY FOLLOWS.
-- db/643's condition-centre tables carry `updated_at` and no trigger; every
-- writer sets it. The VOR tables were the outlier, and the six statements that
-- write them now set `updated_at = now()` themselves (`src/longterm/vor/desk.js`).
--
-- THE COLUMNS AND THEIR DEFAULTS ARE UNTOUCHED — `updated_at timestamptz NOT
-- NULL DEFAULT now()` still stamps every INSERT, so only the UPDATE path moved,
-- and nothing already recorded changes.
--
-- ORDERING. db/645 re-runs on EVERY boot and re-creates both triggers
-- (`CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS` / `CREATE TRIGGER`),
-- so this file must be numbered ABOVE it to be the last word each boot. That is
-- the same mechanism db/374 uses over db/177, and db/475 over db/398.
--
-- IDEMPOTENT: `DROP ... IF EXISTS` is a no-op from the second boot onward.
-- ============================================================================

DROP TRIGGER IF EXISTS trg_lt_vor_forms_touch ON lt_vor_forms;
DROP TRIGGER IF EXISTS trg_lt_vor_envelopes_touch ON lt_vor_envelopes;

-- The function goes with them: left behind it is dead code that reads, to the
-- next person, like something still in use.
DROP FUNCTION IF EXISTS lt_vor_touch_updated_at();
