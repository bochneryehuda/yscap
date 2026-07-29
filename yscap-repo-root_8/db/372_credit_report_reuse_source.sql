-- ============================================================================
-- 372 — CREDIT REPORT: a report can be REUSED from the borrower's profile
--       (owner-directed 2026-07-29: "a credit report is saved to the borrower's
--       profile and auto-imported across their files within 120 days — no need
--       to re-issue it every time").
--
-- credit_reports.borrower_id already ties every report to the person, so a
-- report pulled on one file is already the borrower's. What was missing was a
-- way to bring it onto a NEW file without a fresh Xactus inquiry: reuseFromProfile
-- copies the freshest completed report (<120 days by report_date) onto the new
-- file's credit condition, re-filing the same stored PDF/XML and carrying the
-- ORIGINAL report_date forward (so the 120-day freshness clock is not reset).
--
-- That new row's `source` is neither a live 'api' pull nor a manual 'upload' —
-- it is a 'reuse'. Widen the CHECK to admit it. Idempotent + self-maintaining:
-- re-asserts the constraint every boot (must stay in lock-step with any other
-- migration that re-asserts the same CHECK — this one runs later, so it wins).
-- ============================================================================

ALTER TABLE credit_reports DROP CONSTRAINT IF EXISTS credit_reports_source_check;
ALTER TABLE credit_reports
  ADD CONSTRAINT credit_reports_source_check
  CHECK (source IN ('api','upload','reuse'));
