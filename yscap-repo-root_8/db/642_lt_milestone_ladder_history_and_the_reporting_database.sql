-- ============================================================================
-- db/642 — lt: the milestone ladder's HISTORY, and the reporting database
--
-- WHAT THIS CHANGES, AND WHY (owner-directed 2026-08-30):
--
--   "I want to start first to set up for myself as the admin a reporting
--    database where I can start building up my matrix. So, the first thing that
--    every status doesn't need to be displayed but it needs to have in the
--    system not only a time stamp of the DATE, but also needs to have a time
--    stamp of the ACTUAL TIME when the file is assigned to processor. When the
--    file was changed to submitted and every other status like that. So I can …
--    have a full reporting center where I can see for every file how long it
--    took between which and which step and WHO THE PROCESSOR WAS in that file,
--    and then reporting per processor."
--
--   "…one thing we need to track with the processor is FROM the submittal
--    status is done UNTIL the CTC is done. That's the processor's job. And the
--    loan setup guy, we need to track from the assign processor — which means
--    LO setup done, LO prep completed — till the submittal is done. Set up a
--    full reporting database on this so I can start scoring how many files each
--    processor has and her efficiency."
--
-- WHAT WE ALREADY HAD, AND EXACTLY WHAT WAS MISSING. db/623 mirrors each loan's
-- ladder into `lt_loan_milestones` — one row per (loan, milestone) with `done`,
-- one Encompass date, and the assigned associate. It is a MIRROR: every sync
-- overwrites it, and rows for steps the ladder no longer carries are deleted.
-- So it answers "where is this loan now and who is on this step" and it cannot
-- answer either question the owner just asked:
--
--   · WHEN did this step finish, to the minute? Encompass's ladder gives ONE
--     `startDate` per step, and on this tenant it is a DATE. A date cannot
--     measure a hand-off that happens twice in one afternoon, and the owner
--     asked for the time by name.
--   · WHO was on the step WHEN IT FINISHED? The mirror holds who is on it NOW.
--     Reassign a processor in Encompass next month and every past duration
--     silently re-attributes itself to the new person — which is precisely the
--     number this is being built to score.
--
-- So this migration adds the two things a mirror structurally cannot hold:
--
--   1. lt_ladder_events — APPEND-ONLY. One row per change PILOT witnessed to a
--      loan's ladder: a step completing, a completed step re-opening, and the
--      assigned associate changing. This is the record; nothing overwrites it.
--   2. Four columns on lt_loan_milestones that are NOT part of the mirror and
--      are never overwritten by a later sync: when we first observed the step
--      done, whether that observation was only a BASELINE, and a SNAPSHOT of
--      who held the step at that moment.
--
-- WHY WE WATCH RATHER THAN ASK — unchanged from db/554, and it still binds.
-- Encompass keeps its own milestone log and we cannot read it: this client
-- lacks the `encompass_admin` scope and the milestone-log endpoints answer 403.
-- What PILOT can do is notice that the ladder is not what it was last time. So
-- every event type here is named `observed_*`, exactly as db/554 and the lock
-- events are, and NO consumer may present one as Encompass's own record of who
-- moved the file. The Encompass-stated date rides along beside it, verbatim, so
-- a future build that DOES get the log can reconcile the two.
--
-- THE ONE THING THIS MUST NOT DO IS INVENT A DURATION. The first time PILOT
-- reads a loan, most of its ladder is already done and PILOT has no idea when
-- any of it happened. Stamping "completed today" would give every loan in the
-- book a same-day hand-off on the day the sync first ran, and would make the
-- processor scorecard — the entire point of this — confidently wrong on exactly
-- the files it exists to measure. So a first sighting is written with
-- `observed_is_baseline = true`, and a span that rests on a baseline at either
-- end is reported as UNKNOWN, never as a number. That is the same discipline as
-- db/554's `milestone_since_is_baseline`.
--
-- 3. lt_report_definitions — the saved reports themselves. Same shape as the
--    RTL reporting database's own store (db/640/641) because the owner asked
--    for the same thing on this side, but it is Long-Term's OWN table: it
--    references lt_loans' world, not `applications`, and nothing joins the two.
--
-- BACKFILL: NONE, deliberately, and the reason is the paragraph above. The
-- columns start NULL and `observed_done_at` fills as the ladder sync witnesses
-- each step. A backfill could only have written "we noticed on the day this
-- migration ran", which is a baseline wearing a real date's clothes. The first
-- ladder pass after this lands writes every already-done step as a BASELINE, so
-- the book is honest from the first hour and gets truthful from the first real
-- hand-off. Historic durations are therefore not available and the reporting
-- centre says so on the face of it rather than printing zeroes.
--
-- PRODUCT SEPARATION. Every object here is lt_*; no RTL table is read, written
-- or referenced; no trigger and no function is defined.
--
-- ENCOMPASS STAYS ONE-WAY. Every column is filled by READING Encompass and
-- comparing it to what we already stored. Nothing here implies a write.
--
-- Idempotent — safe to re-run on every boot.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. lt_ladder_events — append-only. What PILOT saw change on a loan's ladder.
--
-- Deliberately NOT unique on (loan_id, milestone_name, event_type): a step
-- legitimately completes, re-opens and completes again, and each of those is a
-- real, separate observation. The history is the record of what happened, not a
-- set of the milestones ever touched — the same reasoning as lt_milestone_events.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lt_ladder_events (
    id                  uuid NOT NULL DEFAULT gen_random_uuid(),
    loan_id             uuid NOT NULL,
    milestone_name      text NOT NULL,
    -- Where the step sits in the loan's own workflow when we saw this.
    position            int,
    -- 'observed_completed' — done went false/absent -> true.
    -- 'observed_reopened'  — done went true -> false. It happens, and a report
    --                        that silently kept the first completion would show
    --                        a file clearing a step it is standing in front of.
    -- 'observed_assigned'  — the associate on the step changed (including the
    --                        first time one appears). This is "when the file is
    --                        assigned to processor", which the owner asked for
    --                        by name and which is NOT the same moment as LO Prep
    --                        completing on every file.
    -- 'observed_baseline'  — the step was ALREADY done the first time PILOT read
    --                        this loan. NOT a completion date, and no consumer
    --                        may render it as one.
    event_type          text NOT NULL,
    -- Encompass's own stated date for the step, verbatim as we read it. On this
    -- tenant the ladder carries a DATE, which is exactly why `observed_at`
    -- exists beside it.
    encompass_date      timestamptz,
    -- Who was on the step before and after. Both sides are recorded so a
    -- hand-off reads as a hand-off rather than as two unrelated facts.
    from_associate_id   text,
    from_associate_name text,
    to_associate_id     text,
    to_associate_name   text,
    to_associate_role   text,
    to_associate_email  text,
    -- When PILOT observed it. This is OUR clock and it has the time the owner
    -- asked for. It is never Encompass's own completion timestamp — we cannot
    -- read that one, and a column that mixed the two would be unusable.
    observed_at         timestamptz NOT NULL DEFAULT now(),
    -- The loan's Encompass modification stamp at the moment of the observation,
    -- so a later build that DOES get the milestone log can reconcile against it.
    encompass_synced_at timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_ladder_events_pkey PRIMARY KEY (id)
);

ALTER TABLE lt_ladder_events DROP CONSTRAINT IF EXISTS lt_ladder_events_type_check;
ALTER TABLE lt_ladder_events
  ADD CONSTRAINT lt_ladder_events_type_check
  CHECK (event_type IN ('observed_completed', 'observed_reopened',
                        'observed_assigned', 'observed_baseline'));

-- The foreign key is added separately and guarded, so this file still applies
-- on a database where lt_loans has not been created yet (filename order puts
-- db/553 first, but a partial restore must not wedge the boot runner).
DO $$
BEGIN
  IF to_regclass('public.lt_loans') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_ladder_events_loan_fkey')
  THEN
    ALTER TABLE lt_ladder_events
      ADD CONSTRAINT lt_ladder_events_loan_fkey
      FOREIGN KEY (loan_id) REFERENCES lt_loans(id) ON DELETE CASCADE;
  END IF;
END $$;

-- One loan's history, newest first — the file screen's own timeline.
CREATE INDEX IF NOT EXISTS lt_ladder_events_loan_seen_idx
    ON lt_ladder_events (loan_id, observed_at DESC);
-- "Every completion of Submittal in August" — the reporting centre's own scan.
CREATE INDEX IF NOT EXISTS lt_ladder_events_milestone_seen_idx
    ON lt_ladder_events (milestone_name, observed_at DESC);
-- "Everything this person was ever handed" — the per-processor scorecard.
CREATE INDEX IF NOT EXISTS lt_ladder_events_to_associate_idx
    ON lt_ladder_events (to_associate_id, observed_at DESC)
    WHERE to_associate_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. The four columns lt_loan_milestones could not hold.
--
-- These are NOT part of the Encompass mirror and the ladder writer must never
-- overwrite them the way it overwrites `done`, `start_date` and the associate
-- columns: the whole point is that they record the moment the step FINISHED and
-- who held it THEN. `observed_done_at` is fill-once (cleared only by an observed
-- re-open, so a genuine second completion is stamped afresh).
-- ---------------------------------------------------------------------------
ALTER TABLE lt_loan_milestones ADD COLUMN IF NOT EXISTS observed_done_at timestamptz;
ALTER TABLE lt_loan_milestones ADD COLUMN IF NOT EXISTS observed_is_baseline boolean NOT NULL DEFAULT false;
-- WHO COMPLETED IT, snapshotted. `associate_name` beside it is the mirror and
-- follows Encompass; this one does not move once written, which is what keeps a
-- reassignment from re-attributing every past duration.
ALTER TABLE lt_loan_milestones ADD COLUMN IF NOT EXISTS done_associate_id text;
ALTER TABLE lt_loan_milestones ADD COLUMN IF NOT EXISTS done_associate_name text;

-- The scorecard scans "every loan whose <milestone> completed in this window".
CREATE INDEX IF NOT EXISTS lt_loan_milestones_done_at_idx
    ON lt_loan_milestones (milestone_name, observed_done_at)
    WHERE observed_done_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. lt_report_definitions — saved reports, Long-Term's own.
--
-- `definition` holds the whole report (columns, filters, sort, row cap, the
-- span the report measures) as jsonb, validated in code against the field
-- catalog before it is ever run. Nothing in here is SQL: a saved report names
-- catalog KEYS, and the compiler refuses a key it does not carry, which is what
-- keeps an admin-authored report from becoming an admin-authored query.
--
-- `owner_staff_id` is TEXT, not a foreign key to staff_users. `staff_users` is
-- the shared identity table and Long-Term is authorized to READ it (the ledger
-- entry of 2026-08-03) — but a REFERENCE is a different permission from a read,
-- and this table does not need one: a report outliving the person who saved it
-- is correct behaviour, and the screen resolves the name at read time.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lt_report_definitions (
    id             uuid NOT NULL DEFAULT gen_random_uuid(),
    name           text NOT NULL,
    description    text,
    -- 'private' — only the person who saved it. 'shared' — every long-term
    -- admin. There is no "public": a long-term report can carry the investor's
    -- name, and CLAUDE.md rule 10 makes that internal on every surface.
    visibility     text NOT NULL DEFAULT 'private',
    owner_staff_id text,
    definition     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_report_definitions_pkey PRIMARY KEY (id)
);

ALTER TABLE lt_report_definitions DROP CONSTRAINT IF EXISTS lt_report_definitions_visibility_check;
ALTER TABLE lt_report_definitions
  ADD CONSTRAINT lt_report_definitions_visibility_check
  CHECK (visibility IN ('private', 'shared'));

CREATE INDEX IF NOT EXISTS lt_report_definitions_owner_idx
    ON lt_report_definitions (owner_staff_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS lt_report_definitions_shared_idx
    ON lt_report_definitions (updated_at DESC) WHERE visibility = 'shared';


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
