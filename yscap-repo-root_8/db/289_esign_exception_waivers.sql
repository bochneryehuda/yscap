-- 289 — Per-requirement waivers on the send-before-clear-to-close exception
-- (owner-directed 2026-07-24).
--
-- The owner's rule: a stuck system flag (e.g. the false "Term: 12 → 12 Months"
-- re-register loop fixed in db/288) must NEVER leave the team with no way to send
-- a term-sheet package. So the esign_before_ctc exception grows up:
--   · Staff may REQUEST it whenever the package can't send (floor met or not);
--     the request snapshots the full requirements picture (done + outstanding)
--     so the reviewing super-admin sees exactly what state prompted it.
--   · The SUPER-ADMIN approves per-requirement: they tick exactly which
--     outstanding blockers are waived ("this one doesn't need to be signed off —
--     but you still need to re-register"). Everything not ticked keeps blocking.
--   · The decision also snapshots the LIVE outstanding picture at decision time;
--     the send-gate honors a waived code only while that blocker still means
--     what the super-admin saw (same reason text) — if the picture changes after
--     the approval, the changed blocker blocks again (fail closed).
--
-- Three additive jsonb columns on loan_exceptions (all NULL for guaranty-waiver
-- rows and for legacy esign rows — a NULL waived_codes keeps the legacy meaning
-- "waives the clear-to-close readiness tier only, floor enforced"):
--   gate_snapshot — { at, checks:[{code,label,ok,reason,tier}], outstanding:[…] }
--                   written at REQUEST time (what the requester was looking at).
--   waived_codes  — ["rtl_p3_apprreview", …] the codes the super-admin waived,
--                   written at APPROVAL time. Enforcement lives in
--                   src/lib/esign/gate-disposition.js.
--   decided_gate  — { at, outstanding:[{code,label,reason,tier}] } the LIVE
--                   picture at decision time; pins each waiver to the exact
--                   blocker state that was approved.
--
-- Additive + idempotent.

ALTER TABLE loan_exceptions ADD COLUMN IF NOT EXISTS gate_snapshot jsonb;
ALTER TABLE loan_exceptions ADD COLUMN IF NOT EXISTS waived_codes  jsonb;
ALTER TABLE loan_exceptions ADD COLUMN IF NOT EXISTS decided_gate  jsonb;
