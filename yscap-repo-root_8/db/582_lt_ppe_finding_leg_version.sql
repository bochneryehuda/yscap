-- ============================================================================
-- LONG-TERM (LT) — db/582 — which engine wiring MEASURED a findings-ledger row.
--
-- WHY (§2.126). db/561 stores a shadow disagreement, and the ledger makes three
-- confident statements about a stored row on every later run:
--
--   • it recurred                    (recurrence++, the human's status kept)
--   • it is gone, so close it        (status `verified`, "no longer reproduced")
--   • it came back, so the fix broke (regressed = true — and the go-live gate
--                                     REFUSES to promote the investor on it)
--
-- Every one of those is a claim that this run and the stored row measured the
-- SAME thing. Nothing on the row said what measured it, so when the "ours" leg
-- was corrected (§2.122, §2.124) the ledger went on carrying, closing and
-- accusing rows produced by the old wiring exactly like rows produced by the new
-- one. A run using the corrected leg never looked for the old leg's disagreement
-- at all, so closing it `verified — no longer reproduced` writes a clean verdict
-- on a question that was never asked, and flagging it `regressed` accuses a fix
-- that was never made of coming undone.
--
-- WHAT THE COLUMN IS. The value of `agreement-provenance.LEG_VERSION` at the
-- moment the row was written — the same stamp db/565's run reports already
-- carry, so a finding and the run that produced it can be read together.
--
-- ⛔ NULL IS THE SIGNAL, NOT A GAP TO BACKFILL. A stamp cannot go back in time.
-- Every row that exists today was written before this column did, and there is
-- no way to tell from here which leg measured it — so it is left NULL and read
-- as "cannot be read; a human has to look". Filling it with today's value would
-- turn an unknown into a false claim, which is the whole defect. Same shape as
-- §2.120's pre-widening capture and §2.122a's unstamped runs: recognised, never
-- rescued.
--
-- THE REMEDY IS ONE ACTION. A human deciding the finding again (triage / fix /
-- verify / dismiss) writes today's stamp beside the decision, so nothing is
-- blocked with no way out — the same shape that makes the `regressed` gate safe.
--
-- SEPARATION: lt_ppe_* only; no RTL table touched; no trigger or function.
-- IDEMPOTENT: re-runnable on every boot (ADD COLUMN IF NOT EXISTS).
--
-- SOURCE OF TRUTH FOR THE SHAPE: src/longterm/prisma/schema.prisma
-- (LtPpeFinding.legVersion). Model and migration land together.
-- ---------------------------------------------------------------------------

ALTER TABLE lt_ppe_finding
    ADD COLUMN IF NOT EXISTS leg_version TEXT;   -- agreement-provenance.LEG_VERSION at write time; NULL = pre-stamp, unreadable

COMMENT ON COLUMN lt_ppe_finding.leg_version IS
    'The engine-wiring stamp (agreement-provenance.LEG_VERSION) that measured this finding. NULL means the row predates the stamp and cannot be read - it is never backfilled.';
