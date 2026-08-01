-- STAFF SAVED SCENARIOS for the Investor Suite tools (owner-directed 2026-07-30).
--
-- The owner's words: "they can save themselves scenarios, they can save themselves
-- stuff that they do, tools that they use in the investor suite so they can reopen
-- it at any time … Give a name for the scenario and then we should have a scenario
-- with all the scenarios that they price and they can pick up from every any
-- scenario … it comes up in the save like the name of the tool and the name that he
-- gave. And you can anytime reopen the tool from where he left off."
--
-- A scenario is a STAFFER'S PRIVATE SCRATCHPAD. It is deliberately NOT attached to
-- an application: it exists so somebody can price a deal that is not a file yet.
-- Nothing here can register, price a real file, or touch any enforcement path —
-- it stores a tool's own form state and hands it back.
--
-- state_kind records WHICH accessor produced the blob, because the tools do not all
-- serialize the same way:
--   'suite' — YS.collectState() / YS.applyState() in web/v2/suite.js, which every
--             tool page loads (every id'd input, checkbox, radio, plus repeatable
--             rows via window.YS_getRows/YS_setRows).
--   'own'   — the tool's OWN richer accessor, for the two whose data is structured
--             rather than a flat set of inputs: Rehab Budget (window.RB.getState/
--             setState — line items, contingency, GC fee) and Track Record
--             (window.TR). The generic collector would silently drop those rows.
-- Storing the kind means a reopen can never feed a suite-shaped blob into a tool
-- that wants its own shape, or the reverse — it would restore a blank tool and look
-- like data loss.
--
-- Idempotent and additive; no backfill (there is nothing to migrate).

CREATE TABLE IF NOT EXISTS staff_tool_scenarios (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id   uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  tool_slug       text NOT NULL,
  name            text NOT NULL,
  state           jsonb NOT NULL,
  state_kind      text NOT NULL DEFAULT 'suite',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE staff_tool_scenarios DROP CONSTRAINT IF EXISTS staff_tool_scenarios_state_kind_check;
ALTER TABLE staff_tool_scenarios
  ADD CONSTRAINT staff_tool_scenarios_state_kind_check CHECK (state_kind IN ('suite', 'own'));

-- A staffer's own list for one tool, newest first — the only read pattern.
CREATE INDEX IF NOT EXISTS idx_staff_tool_scen_owner
  ON staff_tool_scenarios (staff_user_id, tool_slug, updated_at DESC);

-- One name per staffer per tool, so "save" over an existing name UPDATES rather than
-- growing a pile of identically-named rows the staffer cannot tell apart. Two
-- different staffers may each use the same name, and the same name may be reused on
-- a different tool.
CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_tool_scen_name
  ON staff_tool_scenarios (staff_user_id, tool_slug, lower(btrim(name)));

-- updated_at maintained by trigger, not by hand — a forgotten SET drifts the list
-- order, which is the one thing this table is ordered by.
CREATE OR REPLACE FUNCTION staff_tool_scenarios_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_staff_tool_scen_touch ON staff_tool_scenarios;
CREATE TRIGGER trg_staff_tool_scen_touch
  BEFORE UPDATE ON staff_tool_scenarios
  FOR EACH ROW EXECUTE FUNCTION staff_tool_scenarios_touch_updated_at();
