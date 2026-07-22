-- 230_draw_finding_line_retired.sql — Soft-retire draw_finding_lines that vanish from a
-- fresh Sitewire read on re-deliver (audit finding A-2, 2026-07-21).
--
-- Prior behavior: persistDrawFindings' MERGE path was hardened to UPDATE-by-key + INSERT-if-new
-- so borrower dispute evidence is preserved. But a line whose key isn't in the new detail
-- (Sitewire removed / merged the request) was intentionally left in place — and the PARENT
-- draw_findings.total_requested_cents / total_approved_cents were still updated to the new
-- totals from Sitewire. The result: per-line sums no longer matched the parent, and the
-- borrower could keep seeing / disputing a PHANTOM line that no longer exists in Sitewire.
--
-- Adding `retired_at` (nullable timestamptz) lets the merge SOFT-RETIRE lines that vanish while
-- the parent finding is still 'delivered' (a fresh re-deliver of undecided results). Retired
-- lines stay on the record (audit history is preserved — a coordinator can still see what was
-- delivered), but per-line reads filter them out so per-line sums line up with the parent total
-- and the borrower never sees / disputes a line Sitewire no longer knows about. A line whose
-- prior dispute_status ∈ (approved / rejected) is NOT retired — that evidence stays live even if
-- Sitewire's read is missing it, since the coordinator's decision is authoritative.
--
-- Idempotent (safe to re-run every boot). No backfill: pre-migration rows keep retired_at NULL,
-- which reads correctly as "not retired".

ALTER TABLE draw_finding_lines ADD COLUMN IF NOT EXISTS retired_at timestamptz;

-- Discoverability aid for reads that filter out retired lines. Partial index keeps it cheap.
CREATE INDEX IF NOT EXISTS idx_finding_lines_live ON draw_finding_lines (finding_id) WHERE retired_at IS NULL;
