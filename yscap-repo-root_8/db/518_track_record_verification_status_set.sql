-- ============================================================================
-- 518 — RICH PER-LINE VERIFICATION STATUSES; ONLY "FULLY VERIFIED" COUNTS.
--
-- The owner (2026-08-10, with screenshots): a track-record line should carry a
-- real review OUTCOME, not just "pending / verified". The set they named:
--
--     pending review · fully verified · not verified · rejected
--     · unable to verify — waiting on documents
--     · unable to verify — records don't match
--     (plus "delete", which is the existing delete action, not a stored status)
--
-- and ONLY "fully verified" counts toward experience.
--
-- ── WHAT MOVES, AND WHAT DELIBERATELY DOES NOT ──────────────────────────────
--
-- The counting authority is `is_verified` (a boolean), and the ONLY writer that
-- sets it true is POST /track-records/:id/verify (src/routes/staff.js). That
-- route now sets it true for the 'verified' status ALONE — 'limited' no longer
-- counts for a NEW review (see the route). So the experience gate follows the
-- new rule automatically: every count reads `is_verified`, and `is_verified` now
-- means "fully verified".
--
-- This migration only widens what `verification_status` may HOLD. db/493 added
-- `track_records_verification_status_check` constraining the column to the four
-- values the app had always meant (pending | docs | verified | limited). The new
-- review outcomes need four more:
--     not_verified · unable_docs · unable_mismatch · rejected
-- 'docs' and 'limited' are KEPT valid — 'docs' is still the explicit
-- document-request status (the D16 workflow in the verify route), and 'limited'
-- is the legacy "public records only" value the back book still carries.
--
-- ── GOING FORWARD ONLY, DELIBERATELY ────────────────────────────────────────
-- No back-book sweep. Existing 'verified'/'limited' rows keep their is_verified
-- and keep counting; a sweep would drop every affected borrower's tier at once
-- and reopen the experience condition on live files (the db/485 hazard). Only
-- NEW reviews use the stricter "only fully verified counts" rule. This migration
-- adds no UPDATE — it only widens the CHECK.
--
-- ── WHY IT REPLACES db/493's CONSTRAINT IN PLACE (same name) ────────────────
-- Every numbered migration re-runs on every boot. db/493's block re-adds
-- `track_records_verification_status_check` whenever it is ABSENT, so if db/518
-- dropped it and used a different name, db/493 would re-create the NARROW
-- constraint (and re-scan to VALIDATE it) on every boot, then db/518 would drop
-- it again — pure churn. Instead db/518 REPLACES the same-named constraint with
-- the widened set, guarded on the constraint's own definition (does it already
-- allow 'rejected'?). db/493's existence guard is then satisfied and never
-- re-adds anything. NOT VALID + a separate VALIDATE avoids a blocking scan; the
-- widened set is a strict SUPERSET of db/493's, so a clean back book validates.
--
-- KNOWN, HARMLESS ARTIFACT: db/493's OWN second DO-block counts rows against its
-- hard-coded four-value list and RAISES a NOTICE once any new-value row exists
-- ("… carry an unknown verification_status; leaving … NOT VALID"). That NOTICE
-- is now stale — the authority is db/518's widened constraint, which IS valid
-- and DOES allow the new values — and it cannot be silenced without editing
-- db/493 (forbidden). It is a log line only; nothing is left invalid.
--
-- Idempotent: definition-guarded replace + guarded VALIDATE.
-- ============================================================================

-- Replace the narrow constraint with the widened set — but ONLY when the current
-- one does not already allow the new values (so a re-boot is a no-op, no scan).
DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint WHERE conname = 'track_records_verification_status_check';
  IF def IS NULL OR position('rejected' IN def) = 0 THEN
    ALTER TABLE track_records DROP CONSTRAINT IF EXISTS track_records_verification_status_check;
    ALTER TABLE track_records
      ADD CONSTRAINT track_records_verification_status_check
      CHECK (verification_status IN (
        'pending', 'docs', 'verified', 'limited',
        'not_verified', 'unable_docs', 'unable_mismatch', 'rejected'
      )) NOT VALID;
  END IF;
END $$;

-- Validate once (a no-op once already validated). The new set is a superset of
-- db/493's, so a back book that passed the old constraint passes this one — but
-- a row hand-written to a value outside BOTH sets would block validation, so
-- guard it exactly as db/493 did.
DO $$
DECLARE bad bigint;
BEGIN
  SELECT count(*) INTO bad FROM track_records
   WHERE verification_status NOT IN (
     'pending', 'docs', 'verified', 'limited',
     'not_verified', 'unable_docs', 'unable_mismatch', 'rejected'
   );
  IF bad = 0 THEN
    ALTER TABLE track_records VALIDATE CONSTRAINT track_records_verification_status_check;
  ELSE
    RAISE NOTICE 'db/518: % track_records row(s) carry an unknown verification_status; '
                 'leaving track_records_verification_status_check NOT VALID. '
                 'Fix the rows, then run: ALTER TABLE track_records VALIDATE CONSTRAINT '
                 'track_records_verification_status_check;', bad;
  END IF;
END $$;

COMMENT ON COLUMN track_records.verification_status IS
  'pending | docs | verified | limited | not_verified | unable_docs | unable_mismatch | rejected. '
  'Only ''verified'' (Fully verified) COUNTS toward experience for a NEW review; the legacy '
  '''limited''/''verified'' back book keeps its is_verified going forward (db/518, no sweep). '
  'The authority on whether a line counts is is_verified, which only POST /track-records/:id/verify sets. '
  '''rejected'' is hidden by default in the portal, with a filter to show it.';
