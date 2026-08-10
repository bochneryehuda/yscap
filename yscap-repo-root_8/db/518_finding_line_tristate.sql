-- ============================================================================
-- 518_finding_line_tristate.sql — a finding line the inspector NEVER ANSWERED
-- is not a line the inspector DENIED (owner doctrine 2026-08-10, the amount
-- rules: "an explicit $0 IS an answer" — which requires that a missing answer
-- be storable as something other than 0).
--
-- draw_finding_lines.approved_cents was NOT NULL DEFAULT 0, so the delivered
-- findings snapshot had no way to say "not reviewed yet": every unanswered
-- line was stored as an approved $0, and the accept page / branded report
-- printed "Approved $0" on work nobody had looked at — which a borrower reads
-- as DENIED. The live request mirror (sitewire_draw_requests.approved_cents)
-- has been nullable from day one, and the money ladder (approval.js) already
-- skips NULLs when deciding has_inspector_amounts — this migration lets the
-- SNAPSHOT carry the same honesty. not_approved_cents goes with it (requested
-- minus an unknown answer is unknown, never the whole request).
--
-- GO-FORWARD ONLY, deliberately: an existing 0 cannot be told apart from a
-- genuine denied-$0 after the fact, so no backfill guesses — historical rows
-- keep their 0 and re-deliveries re-persist from Sitewire's current truth.
--
-- Idempotent (DROP NOT NULL on an already-nullable column is a no-op).
-- ============================================================================

ALTER TABLE draw_finding_lines
  ALTER COLUMN approved_cents DROP NOT NULL,
  ALTER COLUMN approved_cents DROP DEFAULT,
  ALTER COLUMN not_approved_cents DROP NOT NULL,
  ALTER COLUMN not_approved_cents DROP DEFAULT;
