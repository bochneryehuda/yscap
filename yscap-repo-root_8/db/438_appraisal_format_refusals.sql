-- 438 — COUNT THE APPRAISALS WE CANNOT READ, BECAUSE THE FORMAT CHANGES ON 2 NOV 2026
--
-- PILOT reads UAD 2.6 (MISMO 2.6) appraisals. **UAD 3.6 / MISMO 3.x becomes
-- MANDATORY for Fannie Mae and Freddie Mac appraisals on 2 November 2026**, and
-- we read none of them. From that date the appraisal desk stops working on new
-- reports: no comparables, no as-is value, no ARV, no findings, nothing into the
-- research warehouse — and every one of those is a step some condition or gate
-- depends on.
--
-- The parser already RECOGNISES the format and refuses it with an honest,
-- actionable message. What nothing did was REMEMBER. `importAppraisalTx` returned
-- `{ok:false, error}` and threw the `format` block away, so a refusal was a
-- sentence shown to one officer and then gone. Nobody could answer "how many did
-- we turn away last month?", which is the only question that says whether the
-- exposure is theoretical or already here.
--
-- Measured across the 152 real appraisals in hand today: ZERO are UAD 3.6. The
-- three refusals are all Encompass **iLAD** loan-application exports — somebody
-- attached the wrong document — which is a different problem with a different
-- answer, and the two must never be counted together or the number that matters
-- is buried in the number that does not. Hence `kind`.
--
-- So today's honest reading is "no exposure yet". This table is what turns that
-- into a number that can be watched instead of assumed, from now until the
-- mandate — the first UAD 3.6 file to arrive is the signal that the reader has
-- to be built, and it should not have to be noticed by accident.
--
-- NOT an error log. One row per refused IMPORT ATTEMPT, deliberately including
-- repeats: an officer re-trying the same file three times is itself the signal
-- that the message is not landing.

CREATE TABLE IF NOT EXISTS appraisal_format_refusals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid REFERENCES applications(id) ON DELETE SET NULL,
  document_id     uuid REFERENCES documents(id) ON DELETE SET NULL,
  -- 'uad_3_6'      — a real appraisal in the format we cannot read yet. THE ONE
  --                  THAT MATTERS: this count going above zero is the deadline
  --                  arriving early.
  -- 'not_appraisal'— an iLAD / other export with no comparable grid. The wrong
  --                  document was attached; no reader would fix it.
  -- 'unreadable'   — anything else the parser refused.
  kind            text NOT NULL,
  model           text,
  reference_model text,
  filename        text,
  size_bytes      integer,
  reason          text,
  refused_by      uuid REFERENCES borrowers(id) ON DELETE SET NULL,
  refused_at      timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appraisal_format_refusals_kind_ck') THEN
    ALTER TABLE appraisal_format_refusals
      ADD CONSTRAINT appraisal_format_refusals_kind_ck
      CHECK (kind IN ('uad_3_6', 'not_appraisal', 'unreadable'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_appr_format_refusals_at
  ON appraisal_format_refusals (refused_at DESC);
CREATE INDEX IF NOT EXISTS ix_appr_format_refusals_kind
  ON appraisal_format_refusals (kind, refused_at DESC);

COMMENT ON TABLE appraisal_format_refusals IS
  'Every appraisal XML the parser refused, so the UAD 3.6 exposure can be counted '
  'instead of assumed. UAD 3.6 / MISMO 3.x is MANDATORY for Fannie/Freddie '
  'appraisals from 2 November 2026 and PILOT reads UAD 2.6 — a `uad_3_6` count '
  'above zero means real appraisals are already arriving in a format the desk '
  'cannot read. Kept apart from `not_appraisal` (the wrong document was attached), '
  'which is a different problem with a different answer.';
