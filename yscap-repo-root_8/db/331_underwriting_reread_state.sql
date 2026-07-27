-- ============================================================================
-- 331_underwriting_reread_state.sql — per-file "which reader generation last
-- re-read this file" stamp, for the un-funded re-read sweep.
--
-- WHY (owner decision 2026-07-27, docs/FINDINGS-CLEANUP-SPEC.md): a fix to the
-- document READER does not retroactively re-read a file that was already
-- analysed, so every extraction-level fix (liquidity, credit, appraisal fields,
-- OFAC/fraud deep reads) lands INVISIBLE on existing files until something
-- re-runs. The owner kept re-reporting problems that were fixed days earlier
-- because the screen was showing an OLD read.
--
-- This table is the sweep's idempotency + resumability record, one row per file:
-- the sweep re-reads every ALIVE, not-yet-funded file whose `generation` is
-- BELOW the current code REREAD_GENERATION, then stamps it. A file already at
-- the current generation is skipped — so re-running the sweep is a no-op, and a
-- future reader fix that needs another portfolio re-read is a one-line code bump
-- of REREAD_GENERATION (every file falls below it again, exactly once).
--
-- It records ONLY re-read bookkeeping. It never clears a condition, moves a
-- status, or notifies anyone — those are the sweep's hard non-goals.
-- Additive + idempotent, safe to re-run on every boot like every migration.
-- ============================================================================

CREATE TABLE IF NOT EXISTS underwriting_reread_state (
  application_id uuid PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  generation     integer     NOT NULL DEFAULT 0,   -- the REREAD_GENERATION this file was last re-read at
  docs_read      integer     NOT NULL DEFAULT 0,   -- documents re-read on the last pass (display only)
  last_error     text,                             -- plain-language why a pass could not finish (e.g. cost cap)
  last_read_at   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- The sweep's selection is "alive + un-funded + generation < N", so index the
-- generation for the anti-join.
CREATE INDEX IF NOT EXISTS idx_uw_reread_gen ON underwriting_reread_state (generation);
