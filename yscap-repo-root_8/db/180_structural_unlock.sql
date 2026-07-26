-- 180 — Super-admin structural UNLOCK for locked (clear-to-close / funded) files.
-- (Renumbered from a colliding 177 to the next free number; idempotent, so
-- re-applying under the new filename is a no-op where the columns already exist.)
--
-- #84 (file-lock.js) freezes a file's loan STRUCTURE — registered product/pricing,
-- loan amount, rehab budget, vesting entity, and the core economics — once it
-- reaches clear-to-close or funds. Owner-directed 2026-07-20: that freeze applies
-- to EVERYONE, super_admin included — a funded loan's numbers must not change under
-- anyone. The ONE escape hatch is a deliberate super_admin UNLOCK: a super_admin
-- may open a specific locked file, correct a genuine mistake, then re-lock it.
--
-- These columns record an ACTIVE unlock (who opened it, when, and why). While
-- structural_unlocked_at is set, structuralLockReason() lets a super_admin write to
-- that file; everyone else — and every write path that calls the freeze with no
-- actor (borrower edit paths) — stays frozen. Re-locking clears the columns. (The
-- ClickUp inbound sync writes economics directly and is a separate follow-up.)
-- Every lock/unlock is
-- audited by the route. Idempotent.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS structural_unlocked_at timestamptz;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS structural_unlocked_by uuid;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS structural_unlock_reason text;
