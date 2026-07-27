-- ============================================================================
-- 334 — AI FINDINGS ARE ADVISORY ONLY: retire the database-level blocks.
--
-- OWNER-DIRECTED 2026-07-27, in their own words: "the entire AI findings section
-- should be advisory only, strictly advisory only … it should not hold you back
-- from CTC … should not hold you back from clearing your condition … should not
-- hold you back from sending out the terms package … till we don't feel more
-- comfortable with it we're not going to enforce it."
--
-- The application layer is switched by `AI_FINDINGS_ENFORCE` (see
-- src/lib/underwriting/advisory-policy.js). A trigger cannot read an env var, so
-- the three DATABASE-level blocks are retired here instead:
--
--   1. db/154 trg_appraisal_review_guard      — REFUSED marking
--      `appraisal_review_cleared` satisfied while a fatal appraisal finding was
--      open. That is exactly "it holds up signing off a condition".
--   2. db/202 trg_underwriting_review_guard   — the same refusal for
--      `underwriting_review_cleared` and the document findings.
--   3. db/155 trg_reopen_appraisal_review_on_fatal — UN-SIGNED an already-cleared
--      appraisal review whenever a new fatal finding landed. Left in place it
--      would simply relocate the block: the human signs off, the next re-read (or
--      the un-funded re-read sweep, db/332) raises a fatal, and the condition
--      silently reopens behind them — which is a large part of why the owner sees
--      cleared work coming back.
--
-- WHAT IS **NOT** RETIRED. Every guard that protects a NON-AI rule stays exactly
-- as it is — the SOW budget guard (db/069/192), the economics reopen triggers
-- (db/071/072), the condition-voice guard, the free-text semantic-compare
-- triggers. This migration touches ONLY the three AI-findings blocks.
--
-- The functions are kept (as documented no-ops) rather than dropped, so nothing
-- that references them breaks and so re-arming is simply re-running db/154,
-- db/155 and db/202 in a later migration alongside `AI_FINDINGS_ENFORCE=1`.
--
-- Idempotent — safe to re-run on every boot. Because migrations replay in
-- filename order on every boot, 154/155/202 run first and this file always wins.
-- ============================================================================

-- (1) Appraisal-review sign-off guard → advisory no-op.
CREATE OR REPLACE FUNCTION appraisal_review_guard() RETURNS trigger AS $$
BEGIN
  -- ADVISORY ONLY (db/334). PILOT's appraisal findings no longer refuse a human's
  -- sign-off. Restore db/154's body to re-arm.
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_appraisal_review_guard ON checklist_items;

-- (2) Document-underwriting-review sign-off guard → advisory no-op.
CREATE OR REPLACE FUNCTION underwriting_review_guard() RETURNS trigger AS $$
BEGIN
  -- ADVISORY ONLY (db/334). Restore db/202's body to re-arm.
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_underwriting_review_guard ON checklist_items;

-- (3) A new fatal finding no longer un-signs an already-cleared appraisal review.
CREATE OR REPLACE FUNCTION reopen_appraisal_review_on_fatal() RETURNS trigger AS $$
BEGIN
  -- ADVISORY ONLY (db/334). A finding raised after the review was cleared is shown
  -- on the appraisal desk; it does not silently take the sign-off away. Restore
  -- db/155's body to re-arm.
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_reopen_appraisal_review_on_fatal ON appraisal_findings;

-- ---------------------------------------------------------------------------
-- PREVIOUS AND FUTURE (the standing rule). Files that are sitting RIGHT NOW with
-- their appraisal review un-signed by trigger (3) — the `[auto]` note is the
-- trigger's own signature — are handed back to the human layer: the note is
-- cleared so the condition reads as ordinary outstanding work instead of "PILOT
-- took your sign-off away".
--
-- Deliberately does NOT re-satisfy or re-sign anything: a human sign-off is a
-- human's to give. This only removes the machine's note so the reviewer can sign
-- it off normally. Idempotent (it matches only the exact auto-note).
-- ---------------------------------------------------------------------------
UPDATE checklist_items ci
   SET notes = NULL, updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id
   AND t.code = 'appraisal_review_cleared'
   AND ci.signed_off_at IS NULL
   AND ci.notes = '[auto] A new blocking appraisal finding was raised — review the appraisal findings and clear them before this can be signed off again.';
