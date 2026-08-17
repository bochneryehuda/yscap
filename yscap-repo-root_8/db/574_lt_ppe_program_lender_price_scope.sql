-- ============================================================================
-- db/574 — lt ppe program lender price scope
--
-- WHAT THIS CHANGES, AND WHY. The live shadow comparison (§2.8) now reads Lender
-- Price's answer properly, but it has nothing to compare it AGAINST unless it is
-- told which of Lender Price's programs the comparison is about. Lender Price
-- answers ONE request with EVERY program it sells — 17 on the live Deephaven
-- capture, across several investors and product lines — while our engine prices
-- exactly ONE. Comparing our single ladder against a merge of all of them is not
-- a weaker comparison, it is a meaningless one, so the façade ABSTAINS with that
-- reason rather than manufacturing differences. Measured live 2026-08-17.
--
-- Our own `program` cannot supply the answer: it is a rate-sheet version of OUR
-- authoring, not Lender Price's program NAME, and inferring one from the other
-- would be a guess about somebody else's product catalogue. So the scope is
-- STATED, per program, here.
--
-- WHY A PATTERN AND NOT JUST A NAME. Lender Price splits ONE Deephaven DSCR rate
-- sheet into THREE programs by DSCR band — `DSCR < 1.00 - 30 Yr Fixed`,
-- `DSCR  1.00-1.24   -  30 Yr Fixed`, `DSCR  >= 1.25  - 30 Yr Fixed` — and prices
-- whichever band it selects while DECLINING the other two. Our sheet models that
-- family as one program with the band as an additive adjustment, so no single
-- exact name can name the thing we must scope to. `lp_program_like` is that
-- family pattern; `lp_program` remains for the ordinary one-name case.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS only. Every column is NULLABLE with no
-- default.
--
-- BACKFILL: NONE, deliberately. Every existing program keeps a NULL scope, which
-- the façade reads as "not scoped" and abstains on — byte-identical to the
-- behaviour shipping today. A scope is a statement about an outside vendor's
-- product catalogue and there is nothing here to derive one from; guessing one
-- would silently point a comparison at the wrong program, which is worse than
-- comparing nothing. Each program gets its scope when a human states it.
--
-- PRODUCT SEPARATION: Long-Term only (`lt_ppe_program`). Touches no RTL table.
-- ============================================================================

ALTER TABLE lt_ppe_program ADD COLUMN IF NOT EXISTS lp_investor     TEXT;
ALTER TABLE lt_ppe_program ADD COLUMN IF NOT EXISTS lp_lender       TEXT;
ALTER TABLE lt_ppe_program ADD COLUMN IF NOT EXISTS lp_program      TEXT;
ALTER TABLE lt_ppe_program ADD COLUMN IF NOT EXISTS lp_product      TEXT;
-- The FAMILY pattern (a regular expression, matched case-insensitively). Bounded
-- and grammar-checked in JavaScript before it is ever written here — see
-- src/longterm/ppe/lp-scope.js `safePattern`. A CHECK constraint cannot express
-- "this pattern will not backtrack catastrophically", so the column carries only
-- the length bound the validator also enforces; the real gate is the write door.
ALTER TABLE lt_ppe_program ADD COLUMN IF NOT EXISTS lp_program_like TEXT;
-- Who stated the scope and when. A scope points our comparison at one vendor
-- program out of seventeen; when a comparison later turns out to have been
-- pointed at the wrong one, "who said so, and when" is the only way to find out
-- whether the scope or the sheet was wrong.
ALTER TABLE lt_ppe_program ADD COLUMN IF NOT EXISTS lp_scope_set_by UUID;
ALTER TABLE lt_ppe_program ADD COLUMN IF NOT EXISTS lp_scope_set_at timestamptz;

ALTER TABLE lt_ppe_program DROP CONSTRAINT IF EXISTS lt_ppe_program_lp_scope_len_chk;
ALTER TABLE lt_ppe_program ADD  CONSTRAINT lt_ppe_program_lp_scope_len_chk CHECK (
      (lp_investor     IS NULL OR length(lp_investor)     <= 200)
  AND (lp_lender       IS NULL OR length(lp_lender)       <= 200)
  AND (lp_program      IS NULL OR length(lp_program)      <= 200)
  AND (lp_product      IS NULL OR length(lp_product)      <= 200)
  AND (lp_program_like IS NULL OR length(lp_program_like) <= 200)
);
