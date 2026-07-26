-- 246 — CFPB Section 1071 coverage tracking (R2.10, owner-directed 2026-07-22).
-- Renumbered from an earlier number (post-merge collision with a sitewire migration
-- that landed on main first via PR #546; per CLAUDE.md, renumber the newer file to
-- the next free number). Every DDL statement below is idempotent (IF NOT EXISTS /
-- ON CONFLICT), so any environment that already ran it under the previous filename
-- treats the reapply-under-new-name as a no-op; new environments apply once at 246.
--
-- The 2026 Final Rule requires small-business lending data collection by
-- January 1, 2028. It does NOT carve out business-purpose commercial-real-
-- estate loans, so DSCR / Bridge / Fix-and-Flip / Ground-Up loans to LLC
-- investor entities can be COVERED — but the population is narrower under
-- the final rule:
--   * borrower gross annual revenue must be $1M or less (down from $5M);
--   * the reporting institution threshold rose from 100 to 1,000 covered
--     originations in each of the two prior calendar years — a mid-sized
--     PILOT-class originator may fall entirely outside the reporting
--     obligation;
--   * in correspondent / table-funded / white-label structures, only the
--     "last institution with authority to set material terms" (pricing,
--     amount approved, repayment duration) counts and reports — for PILOT
--     acting as a correspondent for a warehouse or capital partner, the
--     capital partner may be the reporting institution, not PILOT.
--
-- This migration adds two things:
--   * a couple of applications-level columns capturing the borrower's gross
--     revenue and PILOT's "authority to set material terms" flag per loan;
--   * a `section_1071_coverage` table with a per-application classification
--     row so we can audit + report which loans PILOT should collect on.
--
-- Idempotent (safe to re-run every boot).

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS borrower_gross_annual_revenue_cents  bigint,
  ADD COLUMN IF NOT EXISTS pilot_has_material_terms_authority   boolean;

CREATE TABLE IF NOT EXISTS section_1071_coverage (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id           uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- Coverage classification:
  --   covered_report_pilot    — PILOT is the "last institution with authority to
  --                              set material terms" AND borrower is a small
  --                              business (gross revenue ≤ $1M) AND loan is a
  --                              covered credit transaction (not MCA / not
  --                              agricultural / not under $1,000).
  --   covered_report_partner  — the loan is covered but PILOT is NOT the reporting
  --                              institution (correspondent / table-funded structure
  --                              where the capital partner has material-terms authority).
  --   not_covered_borrower    — borrower is NOT a small business (revenue > $1M
  --                              or missing revenue capture).
  --   not_covered_product     — loan is a carve-out (MCA / agricultural / <$1,000).
  --   not_covered_institution — PILOT is below the 1,000-originations institutional
  --                              threshold and thus not a covered financial institution.
  --   pending                 — insufficient data to classify (missing revenue capture,
  --                              missing material-terms flag). Default until captured.
  classification           text NOT NULL DEFAULT 'pending'
                           CHECK (classification IN ('covered_report_pilot','covered_report_partner',
                                                     'not_covered_borrower','not_covered_product',
                                                     'not_covered_institution','pending')),
  reason                   text,                     -- plain-language rationale
  -- The inputs the classifier read at the time of classification (for the audit trail).
  inputs_snapshot          jsonb NOT NULL DEFAULT '{}'::jsonb,
  classified_at            timestamptz NOT NULL DEFAULT now(),
  classifier_version       text NOT NULL DEFAULT 'v1',
  -- One live classification per application; the current row is
  -- superseded (superseded_at set) when the classifier re-runs and produces
  -- a different verdict — the old row stays for the audit trail.
  superseded_at            timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_section_1071_current
  ON section_1071_coverage (application_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_section_1071_covered
  ON section_1071_coverage (classification)
  WHERE superseded_at IS NULL AND classification IN ('covered_report_pilot','covered_report_partner');
