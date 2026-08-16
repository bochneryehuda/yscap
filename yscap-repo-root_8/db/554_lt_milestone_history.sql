-- ============================================================================
-- 554_lt_milestone_history.sql — WHEN a long-term loan reached each milestone.
--
-- The workspace's stepper was designed (LOS-MASTER-PLAN §4.2) to show "each node
-- a completion date or a not-yet-reached mark, so a stalled file reads as stalled
-- without a word of text". It could not: `workspace.milestoneStepper` reads
-- `m.completed_at` off the row it is handed, and the row it is handed comes from
-- `lt_encompass_milestones` — the tenant's global CATALOG, one row per milestone
-- NAME, with no per-loan column and no completion date on it at all. So
-- `completedAt` was null on every step of every loan, silently, forever. This
-- migration gives that field something real to read.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY WE WATCH RATHER THAN ASK.
--
-- Encompass keeps its own milestone log and we cannot read it: client `z1xx73r`
-- lacks the `encompass_admin` scope, so the milestone-log endpoints answer 403
-- (LOS-MASTER-PLAN §11 item 6 — an open ICE entitlement question, not a coding
-- one). What PILOT CAN do is notice that a loan's milestone is not what it was
-- the last time it read it. That is exactly the substitute `lt_lock_events`
-- already uses for lock history on this side, and it carries the same obligation:
-- every event type is named `observed_*` so it can never be mistaken for
-- Encompass's own record of who moved the file and when.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE ONE THING THIS MUST NOT DO IS INVENT A DATE.
--
-- The first time PILOT reads a loan it has no idea when that loan reached the
-- milestone it is sitting on — it may have been there ten minutes or ten months.
-- Stamping "reached today" would make every loan in the book look freshly moved
-- on the day the sync first ran, and would make the stalled-file signal (days at
-- this milestone vs the catalog's expected_days) confidently wrong on exactly the
-- files it exists to surface. So the first sighting is recorded as a BASELINE,
-- a distinct event type, and `milestone_since_is_baseline` marks the loan's
-- timestamp as "when we started watching" rather than "when it moved". Every
-- consumer must treat a baseline as UNKNOWN, never as a date.
--
-- This is the same discipline as `applications.status_notified_external` on the
-- RTL side: silently baseline what was already true, and only report what you
-- actually witnessed.
--
-- SEPARATION. Both objects are lt_*; no RTL table is read or written; no trigger
-- and no function is defined here; no migration statement touches both products.
--
-- ENCOMPASS STAYS ONE-WAY. Every column here is filled by READING Encompass and
-- comparing it to what we already stored. Nothing here implies a write.
--
-- Idempotent — safe to re-run on every boot.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- lt_milestone_events — append-only. One row per transition PILOT witnessed,
-- plus one baseline row per loan the first time it is seen.
--
-- Deliberately NOT unique on (loan_id, to_milestone): a file legitimately moves
-- backwards and then forwards again (a milestone can be rolled back exactly as a
-- lock can), and each of those is a real, separate observation. The history is
-- the record of what happened, not a set of the milestones ever touched.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lt_milestone_events (
    id                  UUID NOT NULL,
    loan_id             UUID NOT NULL,
    -- 'observed_entered'  — we saw it change from one milestone to another.
    -- 'observed_baseline' — first sighting; where it already was. NOT a date it
    --                       reached anything, and no consumer may render it as one.
    event_type          TEXT NOT NULL,
    from_milestone      TEXT,
    to_milestone        TEXT,
    from_stage          TEXT,
    to_stage            TEXT,
    -- When PILOT observed it. Never Encompass's own completion timestamp — we
    -- cannot read that one, and a column that mixed the two would be unusable.
    observed_at         timestamptz NOT NULL DEFAULT now(),
    -- The loan's Encompass modification stamp at the moment of the observation,
    -- so a later build that DOES get the milestone log can reconcile against it.
    encompass_synced_at timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_milestone_events_pkey PRIMARY KEY (id),
    CONSTRAINT lt_milestone_events_type_check
      CHECK (event_type IN ('observed_entered', 'observed_baseline'))
);

CREATE INDEX IF NOT EXISTS lt_milestone_events_loan_idx
  ON lt_milestone_events (loan_id, observed_at DESC);

-- ---------------------------------------------------------------------------
-- lt_loans — the current milestone's clock.
--
-- Denormalised from the events above so the PIPELINE can sort on "longest at its
-- milestone" without a per-row subquery, exactly as db/553 denormalised the lock
-- expiry so the pipeline could sort on what expires soonest.
-- ---------------------------------------------------------------------------
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS milestone_since            timestamptz;
-- TRUE while `milestone_since` is only "when we started watching". It is set on
-- the first sighting and cleared the moment we witness a real transition. A
-- consumer that ignores this column will report a stale figure as a fresh one.
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS milestone_since_is_baseline BOOLEAN NOT NULL DEFAULT true;

-- Back-fill is deliberately ABSENT. Every loan already in lt_loans has been
-- sitting at its milestone for an unknown length of time, and the only honest
-- value for it is "we do not know" — which is what a NULL `milestone_since` plus
-- the default baseline flag already say. The next sync of each loan records its
-- baseline for real, with the timestamp it was actually observed.
