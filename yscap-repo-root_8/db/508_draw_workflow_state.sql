-- ============================================================================
-- 508_draw_workflow_state.sql — the three decisions a draw makes that were never
-- written down (owner-directed 2026-08-09).
--
-- All three are gaps found by reading the code, and all three are the same shape:
-- the system KNOWS the answer at the moment it happens and then throws it away.
--
--   1. WHERE A DRAW HAS BEEN. `src/sitewire/approval.js` derives the stage fresh
--      on every read from three other tables and stores nothing, so there is no
--      timeline, no "days in this stage", and no way to report on how long draws
--      actually take. `draw_stage_events` is the missing history.
--
--   2. THAT A HUMAN LOOKED AT THE INSPECTION. Findings go to the borrower the
--      moment a coordinator presses Deliver; nothing records that anybody read the
--      inspector's report first. (The unbuilt "increment D" in
--      docs/DRAW-WORKFLOW-STATUS-RESEARCH.md.)
--
--   3. WHAT THE INVESTOR SAID. `draw_investor_deliveries` records that we SENT a
--      draw and never what came back — so "with the investor" is a dead end that
--      only a reminder ever escapes.
--
-- Idempotent. Every column is nullable with no default: a draw that predates this
-- migration honestly has no history rather than a fabricated one.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Stage history — append-only, forward-only, never invented.
--
-- NO unique key on (draw, stage) ON PURPOSE. A draw legitimately re-enters a
-- stage: amend and reopen take an approved draw back for another round, and the
-- owner-directed amend flow expects exactly that. A unique key would either throw
-- on the second pass or silently overwrite the first visit, and "how long did this
-- draw sit in review the SECOND time" is precisely the question this table exists
-- to answer. The writer instead skips a row whose stage equals the latest one
-- already recorded, so an ordinary re-read never appends.
--
-- The stage vocabulary is `approval.STAGE_ORDER` and is deliberately NOT a CHECK
-- constraint here: that list is owned by the pure module and has grown before. A
-- database constraint would mean a new stage needs a migration to be recordable,
-- and the failure mode would be losing the history of the very stage that was just
-- added.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS draw_stage_events (
  id                bigserial PRIMARY KEY,
  application_id    uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  sitewire_draw_id  bigint,
  portal_request_id bigint,
  stage             text NOT NULL,
  -- Free-text, plain language, for the readable activity strip ("Inspector
  -- approved $6,250 on 4 lines"). Optional — the stage alone is the record.
  detail            text,
  -- WHO caused it, when we know. A stage reached because the platform mirrored a
  -- change has no actor, and NULL says so honestly.
  actor_staff_id    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  -- Where the move came from: 'pilot' (somebody clicked), 'sitewire'/'trustpoint'
  -- (mirrored), 'borrower' (they accepted/disputed), 'system' (a sweep).
  source            text NOT NULL DEFAULT 'pilot',
  entered_at        timestamptz NOT NULL DEFAULT now()
);

-- "What stage is this draw in, and since when" — the read behind days-in-stage,
-- the timeline and the stuck-draws report.
CREATE INDEX IF NOT EXISTS idx_draw_stage_draw
  ON draw_stage_events (sitewire_draw_id, entered_at DESC)
  WHERE sitewire_draw_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_draw_stage_portal
  ON draw_stage_events (portal_request_id, entered_at DESC)
  WHERE portal_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_draw_stage_app ON draw_stage_events (application_id, entered_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Somebody read the inspection before the borrower did.
--
-- NOT a gate in this migration — it records the fact and drives the readiness
-- checklist. Nothing that exists today starts refusing because of it.
-- ---------------------------------------------------------------------------
ALTER TABLE draw_findings ADD COLUMN IF NOT EXISTS reviewed_at  timestamptz;
ALTER TABLE draw_findings ADD COLUMN IF NOT EXISTS reviewed_by  uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE draw_findings ADD COLUMN IF NOT EXISTS review_note  text;

-- ---------------------------------------------------------------------------
-- 3. What the investor answered.
--
-- 'questioned' is a real, separate outcome and not a soft decline: an investor
-- asking for one more photo is the common case, and collapsing it into 'declined'
-- would make the draw look dead on every screen and stop the coordinator chasing
-- the one thing that would unblock it.
-- ---------------------------------------------------------------------------
ALTER TABLE draw_investor_deliveries ADD COLUMN IF NOT EXISTS answer               text;
ALTER TABLE draw_investor_deliveries ADD COLUMN IF NOT EXISTS answered_at          timestamptz;
ALTER TABLE draw_investor_deliveries ADD COLUMN IF NOT EXISTS answered_by          uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE draw_investor_deliveries ADD COLUMN IF NOT EXISTS answer_note          text;
ALTER TABLE draw_investor_deliveries ADD COLUMN IF NOT EXISTS expected_funding_date date;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'chk_did_answer' AND conrelid = 'draw_investor_deliveries'::regclass) THEN
    ALTER TABLE draw_investor_deliveries ADD CONSTRAINT chk_did_answer
      CHECK (answer IS NULL OR answer IN ('approved','questioned','declined'));
  END IF;
END $$;

-- The "with the investor, still waiting" desk reads the latest send per draw and
-- whether it has been answered.
CREATE INDEX IF NOT EXISTS idx_did_unanswered
  ON draw_investor_deliveries (application_id, sitewire_draw_id, sent_at DESC)
  WHERE answer IS NULL;
