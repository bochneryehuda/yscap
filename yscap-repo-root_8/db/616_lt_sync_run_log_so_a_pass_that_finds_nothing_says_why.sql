-- ============================================================================
-- db/616 — LONG-TERM: the record of what each sync pass actually did.
--
-- WHAT THIS CHANGES, AND WHY. The owner, twice: *"I still don't see any files
-- populating on the long-term side"* and then *"Nothing came yet into the
-- long-term pipeline. Why is it not pulling?"* — and NOBODY COULD ANSWER,
-- including the person who built it.
--
-- Here is the reason nobody could. `GET /api/lt/sync` builds its whole answer out
-- of `lt_loans`: how many rows, how many were read, how many carry
-- `encompass_sync_error`. That is a fine report on loans we HAVE. It says nothing
-- at all about a pass that never got a loan in the first place — a refused login,
-- an Encompass outage, a pipeline search that answered with an empty list, the
-- feature switched off. In every one of those the pass writes its verdict to the
-- PROCESS LOG (`[lt-sync] pass in 3s — loans: failed (…)`) and the screen shows
-- zero loans, zero failing, and no explanation whatsoever.
--
-- So an empty book has always had two completely different meanings — "Encompass
-- has nothing for us" and "we could not reach Encompass" — rendered identically,
-- with the distinguishing fact discarded. THE CLASS: a report built only from the
-- rows a job PRODUCED can never explain a job that produced none. Record the RUN,
-- not just its output.
--
-- WHAT IS RECORDED: one row per pass, per kind, carrying when it ran, what set it
-- off, whether it succeeded, the plain-language reason when it did not, and the
-- counts the screen already knows how to show. `detail` holds the pass's own
-- shape verbatim so a question nobody thought to ask today is still answerable
-- from what was captured.
--
-- WHY A LOG AND NOT A SINGLE CURRENT-STATE ROW. "It is failing right now" and "it
-- has been failing since Tuesday" are different facts, and the second is the one
-- that tells somebody whether an outage explains an empty book. A single row
-- overwritten every twenty minutes throws that away. The log is PRUNED by the
-- writer (newest N per kind), so it is bounded without a scheduled job.
--
-- BACKFILL: NONE, and deliberately. There is no honest way to write history for
-- passes that ran before anything recorded them, and inventing rows would put
-- fabricated evidence on the one screen built to be trusted about this. The log
-- starts empty and says so — "no pass has been recorded yet" is itself a true and
-- useful answer on the first deploy.
--
-- PRODUCT SEPARATION: `lt_*` only. No RTL table is read or written, no trigger
-- and no function is defined, and nothing here implies a write to Encompass.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lt_sync_runs (
    id           UUID        NOT NULL,
    -- Which pass: 'loans' | 'conditions' | 'milestone_catalog' | 'pilot_roles'.
    -- Deliberately NOT a CHECK constraint or an enum: a pass added later must be
    -- able to record itself without a migration, and the cost of an unrecognised
    -- kind is a row the screen groups under its own name — never a lost write on
    -- the one table whose job is to explain a failure.
    kind         TEXT        NOT NULL,
    -- 'worker' (the timer) or 'manual' (somebody pressed the button). The
    -- difference matters: "the button did nothing" and "the timer has not run"
    -- send you to two different places.
    trigger      TEXT        NOT NULL DEFAULT 'worker',
    started_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz,
    -- NULL while a pass is still running. A row that never gains a finish is
    -- itself the record of a pass that died mid-flight, which no summary count
    -- could ever show.
    ok           BOOLEAN,
    -- WHY, in the words a person reads. Filled on a refusal or a failure, and
    -- left NULL on a clean pass — a reason on a successful run would train
    -- people to ignore the column.
    reason       TEXT,
    discovered   INTEGER,
    read_count   INTEGER,
    failed       INTEGER,
    skipped      INTEGER,
    remaining    INTEGER,
    passes       INTEGER,
    detail       JSONB,

    CONSTRAINT lt_sync_runs_pkey PRIMARY KEY (id)
);

COMMENT ON TABLE lt_sync_runs IS
  'One row per long-term sync pass: what set it off, whether it worked, and WHY it did not. Exists because a report built from lt_loans cannot explain a pass that produced no loans.';
COMMENT ON COLUMN lt_sync_runs.reason IS
  'Plain-language reason a pass refused or failed. NULL on a clean pass.';
COMMENT ON COLUMN lt_sync_runs.skipped IS
  'Loans deliberately not mirrored — today, files the product rule proved are short-term.';

-- The only question ever asked of this table: "what did the last pass of this
-- kind do?" — so the index answers exactly that.
CREATE INDEX IF NOT EXISTS lt_sync_runs_kind_started_idx
  ON lt_sync_runs (kind, started_at DESC);


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself.
