-- ============================================================================
-- LONG-TERM (LT) — db/557 — PPE shadow FINDINGS ledger.
--
-- A shadow disagreement (§10.4 of docs/longterm/PPE-MEGA-PLAN.md) persisted so a
-- fixed/dismissed finding NEVER re-opens itself on the next run (the RTL finding-
-- ledger discipline). The pure LOGIC lives in src/longterm/ppe/finding.js; this is
-- its durable home, and src/longterm/ppe/finding-store.js is the bridge.
--
-- IDENTITY: a finding is keyed by (scope, finding_key) — finding_key is the stable
-- identity finding.js computes from investor/program/scenario/kind/coupon. A run's
-- reconcile UPSERTs on that key: a recurrence bumps last_seen_at + recurrence and
-- keeps the human's status; a settled row (fixed/verified/wontfix) is carried
-- forward, never reopened (a fixed one that reappears is flagged regressed).
--
-- SEPARATION: lt_ppe_* only; no RTL table read or written; no trigger or function
-- defined; the one FK references db/554's own lt_ppe_program. approved/decided
-- actors are plain UUIDs (no FK). MULTI-TENANT + SELLABLE: every row carries scope
-- (default 'company'); nothing here is specific to us.
--
-- SOURCE OF TRUTH FOR THE SHAPE: src/longterm/prisma/schema.prisma (LtPpeFinding)
-- + docs/schema/beyond-prisma.json. Model, migration and snapshot land together.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lt_ppe_finding (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope           TEXT NOT NULL DEFAULT 'company',
    finding_key     TEXT NOT NULL,
    investor        TEXT,                              -- the investor label finding.js keyed on
    program         TEXT,                              -- the program label finding.js keyed on
    program_id      UUID REFERENCES lt_ppe_program(id) ON DELETE SET NULL,  -- anchor when resolvable
    scenario        TEXT,                              -- the scenario label the disagreement came from
    scenario_facts  JSONB,                             -- the flat facts bag (when captured)
    kind            TEXT NOT NULL,                     -- price_mismatch | eligibility_mismatch | rung_missing_* | rate_mismatch | engine_error
    diff            JSONB NOT NULL DEFAULT '{}'::jsonb,-- the structured disagreement (axis, deltas)
    our_payload     JSONB,                             -- sanitized request/quote we sent (no creds)
    their_payload   JSONB,                             -- sanitized Lender Price payload (no creds)
    status          TEXT NOT NULL DEFAULT 'open',      -- open | triaged | fixed | verified | wontfix
    regressed       BOOLEAN NOT NULL DEFAULT false,    -- a settled finding that reappeared
    recurrence      INTEGER NOT NULL DEFAULT 1,        -- how many runs have seen it
    first_seen_at   timestamptz,
    last_seen_at    timestamptz,
    decided_by      UUID,                              -- who triaged/fixed/dismissed it
    decided_at      timestamptz,
    decision_reason TEXT,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_ppe_finding_scope_key_uk UNIQUE (scope, finding_key),
    CONSTRAINT lt_ppe_finding_status_chk CHECK (status IN ('open','triaged','fixed','verified','wontfix'))
);
CREATE INDEX IF NOT EXISTS lt_ppe_finding_status_idx ON lt_ppe_finding (scope, status);
