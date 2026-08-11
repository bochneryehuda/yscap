-- 521 — 'session' is a valid assigned_via value (owner-reported 2026-08-11).
--
-- db/487 taught the lead door to REUSE the officer a prospect's browser session
-- already had (writing assigned_via='session'), and db/468/484 defined the
-- chk_leads_assigned_via CHECK as lo_link | round_robin | manual | staff_portal —
-- WITHOUT 'session'. So every session-reuse INSERT violated the CHECK (23514) and
-- 500'd the whole submission: the session-stickiness has never actually worked,
-- and the over-assignment it was meant to stop kept happening (a repeat export
-- fell through to a fresh round-robin onto a different officer).
--
-- The 2026-08-11 fix broadens that reuse (email / phone / session / IP+name) and
-- also writes 'session' when it sticks to an existing officer, so the value must
-- be allowed. Widened exactly like db/484 (drop + re-add). Additive, idempotent,
-- go-forward — existing rows keep whatever assigned_via they have.
ALTER TABLE leads DROP CONSTRAINT IF EXISTS chk_leads_assigned_via;
ALTER TABLE leads ADD CONSTRAINT chk_leads_assigned_via
  CHECK (assigned_via IS NULL OR assigned_via IN ('lo_link', 'round_robin', 'manual', 'staff_portal', 'session'));
