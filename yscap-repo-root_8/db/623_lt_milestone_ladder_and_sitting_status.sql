-- ============================================================================
-- db/623 — lt: the milestone LADDER per loan, and the SITTING status
--
-- Owner-reported 2026-08-23 (363 Birch Dr / YSCAP258134741): the file showed
-- "Funding" although the Funding milestone had COMPLETED. "The wording is
-- changing from funding to funded … it's sitting in the NEXT status, waiting
-- for that status to be completed." Proven live against the tenant:
--
--   · GET /loans/{guid}/milestones returns the loan's OWN ladder — every
--     milestone with `doneIndicator`, its date, and WHO is assigned to that
--     step. The file STANDS at the LAST milestone whose doneIndicator is TRUE
--     (Birch: Funding done=true → standing = "Funding", displayed in its
--     completed wording "Funded").
--
--     CORRECTED IN PLACE, while this file is still unmerged and therefore
--     still editable: the first cut of this header said the file sits in the
--     FIRST milestone whose doneIndicator is false, which on Birch answered
--     "Investor Delivery" — a step nobody had worked. The owner reversed that
--     on 2026-08-24 ("the name of the status in our system should always be
--     the last milestone that is completed"), and Encompass's own vocabulary
--     agrees: MS.STATUS reads "Funded" on that loan. Left as written it would
--     have become a permanent contradiction in the schema record, since a
--     landed migration is never edited.
--   · Virtual field MS.STATUS is the tenant's own status WORDING, stamped at
--     the last milestone transition ("Funded" on Birch) — the field their
--     existing Encompass automation fires webhooks on. MS.STATUSDATE is the
--     stamp's timestamp ("08/23/2026 04:07:53 PM" — US format, no timezone,
--     so it is mirrored VERBATIM as text, never parsed into a guess).
--   · `Log.MS.CurrentMilestone` — what the mirror displayed until now — LAGS:
--     it stays on the last WORKED milestone until somebody starts the next
--     one, which is exactly the wrong reading the owner caught.
--
-- So `lt_loans.milestone_name` becomes the SITTING milestone (the sync writes
-- it from the ladder), `stage_key` and the whole pipeline heal with it, and the
-- ladder itself is mirrored per loan:
--
--   lt_loan_milestones — one row per (loan, milestone): position, done, the
--   milestone's date (REAL for a completed step, the EXPECTED/planned date for
--   a future one — Encompass keeps one date per step and its meaning flips
--   when the step finishes), and the assigned associate (name, Encompass login,
--   role, email, phone) — the per-milestone PERSONA record: WHY each person is
--   on the file ("assigned only to the Closer and Funder milestone").
--
--   lt_loans.ms_status / ms_status_date — the tenant's own wording + stamp,
--   for display and for verifying webhook firings against what we mirrored.
--   lt_loans.ladder_synced_at — when the ladder was last read; the drain key
--   for the backfill pass that walks the already-mirrored book once.
--
-- BACKFILL: none in SQL. The ladder comes from a per-loan Encompass call, so a
-- worker pass (milestone-ladder.js backfillLadders) drains the book a few loans
-- per tick, keyed on ladder_synced_at IS NULL. Until a loan's ladder lands, its
-- row reads exactly as before this file.
--
-- PRODUCT SEPARATION: `lt_*` only.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lt_loan_milestones (
  loan_id            uuid NOT NULL REFERENCES lt_loans(id) ON DELETE CASCADE,
  milestone_name     text NOT NULL,
  position           int  NOT NULL DEFAULT 0,
  done               boolean NOT NULL DEFAULT false,
  -- One date per step, Encompass's own: the actual start for a step that has
  -- been worked, the PLANNED date for one that has not. `done` says which.
  start_date         timestamptz,
  -- The assigned associate on THIS step — the persona ground truth.
  associate_id       text,
  associate_name     text,
  associate_role     text,
  associate_email    text,
  associate_phone    text,
  role_required      text,
  encompass_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (loan_id, milestone_name)
);

CREATE INDEX IF NOT EXISTS lt_loan_milestones_loan_pos_idx
    ON lt_loan_milestones (loan_id, position);

-- The tenant's own status wording + stamp (MS.STATUS / MS.STATUSDATE), verbatim.
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS ms_status text;
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS ms_status_date text;
-- When this loan's ladder was last mirrored — the backfill's self-draining key.
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS ladder_synced_at timestamptz;

-- The backfill selects "never laddered" repeatedly while it drains the book.
CREATE INDEX IF NOT EXISTS lt_loans_ladder_unsynced_idx
    ON lt_loans (created_at) WHERE ladder_synced_at IS NULL;
