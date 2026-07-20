-- Bidirectional Phase 2 — drift detection between PILOT and Sitewire (owner-directed 2026-07-20).
--
-- Read-after-write catches "did MY write land," but nothing ever re-checked that PILOT's managed
-- budget still equals what a human might edit directly in Sitewire, and a Sitewire-side change to an
-- already-RELEASED draw's approved amount (money already wired) went undetected. This throttle lets
-- the reconcile poll re-verify the managed budget at most hourly per file (not every 5-min pass), so
-- the extra getBudget read stays cheap. The two-sided drift REVIEW reuses the db/110 columns
-- (portal_value = PILOT, clickup_value = Sitewire's value). Idempotent.
ALTER TABLE sitewire_property_links ADD COLUMN IF NOT EXISTS last_budget_verified_at timestamptz;
